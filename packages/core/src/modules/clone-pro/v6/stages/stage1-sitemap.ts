export interface DiscoveredUrl {
  sourceUrl: string
  discoveredVia: 'sitemap' | 'sitemap_index' | 'bfs' | 'robots'
  depth: number
}

export interface DiscoverInput {
  sourceUrl: string
  maxBfsPages: number
  maxBfsDepth: number
  fetch?: typeof globalThis.fetch
}

export interface DiscoverResult {
  urls: DiscoveredUrl[]
  sitemapFound: boolean
}

const SITEMAP_PATHS = ['/sitemap.xml', '/sitemap_index.xml']

/**
 * Cloudflare-fronted Shopify sites (and many others) reject the
 * default Node `fetch` user-agent with 429 / bot challenge. Browser
 * UA gets through. We pin a Chrome UA on every Stage 1 fetch so the
 * sitemap walker actually reaches its target.
 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

function withBrowserUA(fetchImpl: typeof globalThis.fetch): typeof globalThis.fetch {
  return (async (input: any, init: any = {}) => {
    const headers = new Headers(init.headers ?? {})
    if (!headers.has('user-agent')) headers.set('user-agent', BROWSER_UA)
    if (!headers.has('accept')) headers.set('accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8')
    if (!headers.has('accept-language')) headers.set('accept-language', 'en-US,en;q=0.9')
    if (!headers.has('cache-control')) headers.set('cache-control', 'no-cache')

    // Retry-with-backoff for Cloudflare 429 / 503 bot challenges. CF often
    // returns 429 with a JS challenge on first hit, then 200 on retry once
    // the IP has "cooled off" briefly.
    const MAX_ATTEMPTS = 3
    const BACKOFFS_MS = [800, 2400]
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const res = await fetchImpl(input, { ...init, headers })
      if (res.status !== 429 && res.status !== 503) return res
      if (attempt === MAX_ATTEMPTS - 1) return res
      await new Promise((r) => setTimeout(r, BACKOFFS_MS[attempt] ?? 2400))
    }
    // unreachable; satisfies TS
    return fetchImpl(input, { ...init, headers })
  }) as typeof globalThis.fetch
}

export async function discoverUrls(input: DiscoverInput): Promise<DiscoverResult> {
  const rawFetch = input.fetch ?? globalThis.fetch
  const fetchImpl = withBrowserUA(rawFetch)
  const origin = new URL(input.sourceUrl).origin

  for (const path of SITEMAP_PATHS) {
    const res = await fetchImpl(`${origin}${path}`)
    if (res.ok) {
      const xml = await res.text()
      const urls = await parseSitemap(xml, origin, fetchImpl)
      if (urls.length > 0) return { urls, sitemapFound: true }
    }
  }

  try {
    const robotsRes = await fetchImpl(`${origin}/robots.txt`)
    if (robotsRes.ok) {
      const text = await robotsRes.text()
      const sitemapDirective = /^Sitemap:\s*(\S+)/im.exec(text)
      if (sitemapDirective) {
        const sitemapRes = await fetchImpl(sitemapDirective[1])
        if (sitemapRes.ok) {
          const xml = await sitemapRes.text()
          const urls = await parseSitemap(xml, origin, fetchImpl)
          if (urls.length > 0) {
            return { urls: urls.map((u) => ({ ...u, discoveredVia: 'robots' as const })), sitemapFound: true }
          }
        }
      }
    }
  } catch { /* fall through */ }

  const bfsUrls = await bfsCrawl({
    origin,
    sourceUrl: input.sourceUrl,
    maxPages: input.maxBfsPages,
    maxDepth: input.maxBfsDepth,
    fetch: fetchImpl,
  })
  return { urls: bfsUrls, sitemapFound: false }
}

async function parseSitemap(
  xml: string,
  origin: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<DiscoveredUrl[]> {
  const isSitemapIndex = /<sitemapindex/i.test(xml)
  const locs = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g)).map((m) => decodeXmlEntities(m[1].trim()))
  if (isSitemapIndex) {
    const out: DiscoveredUrl[] = []
    for (const childUrl of locs) {
      try {
        const res = await fetchImpl(childUrl)
        if (res.ok) {
          const childXml = await res.text()
          const childLocs = Array.from(childXml.matchAll(/<loc>([^<]+)<\/loc>/g)).map((m) => decodeXmlEntities(m[1].trim()))
          for (const u of childLocs) {
            if (u.startsWith(origin)) {
              out.push({ sourceUrl: u, discoveredVia: 'sitemap_index', depth: 0 })
            }
          }
        }
      } catch { /* skip child */ }
    }
    return dedupe(out)
  }
  return dedupe(
    locs
      .filter((u) => u.startsWith(origin))
      .map((u) => ({ sourceUrl: u, discoveredVia: 'sitemap' as const, depth: 0 })),
  )
}

interface BfsInput {
  origin: string
  sourceUrl: string
  maxPages: number
  maxDepth: number
  fetch: typeof globalThis.fetch
}

async function bfsCrawl(input: BfsInput): Promise<DiscoveredUrl[]> {
  const visited = new Set<string>()
  const queue: { url: string; depth: number }[] = [{ url: input.sourceUrl, depth: 0 }]
  const out: DiscoveredUrl[] = []

  while (queue.length > 0 && out.length < input.maxPages) {
    const { url, depth } = queue.shift()!
    if (visited.has(url)) continue
    visited.add(url)
    if (!url.startsWith(input.origin)) continue
    out.push({ sourceUrl: url, discoveredVia: 'bfs', depth })
    if (depth >= input.maxDepth) continue
    try {
      const res = await input.fetch(url)
      if (!res.ok) continue
      const html = await res.text()
      const hrefs = Array.from(html.matchAll(/href=["']([^"']+)["']/g)).map((m) => m[1])
      for (const href of hrefs) {
        const abs = absolutize(href, input.origin)
        if (abs && abs.startsWith(input.origin) && !visited.has(abs)) {
          queue.push({ url: abs, depth: depth + 1 })
        }
      }
    } catch { /* skip */ }
  }
  return out
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
}

function absolutize(href: string, origin: string): string | null {
  try { return new URL(href, origin).toString().split('#')[0] } catch { return null }
}

function dedupe(items: DiscoveredUrl[]): DiscoveredUrl[] {
  const seen = new Set<string>()
  return items.filter((i) => {
    if (seen.has(i.sourceUrl)) return false
    seen.add(i.sourceUrl)
    return true
  })
}
