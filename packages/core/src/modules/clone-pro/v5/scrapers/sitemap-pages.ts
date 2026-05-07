/**
 * Clone Pro v5 — sitemap pages scraper
 *
 * 1. Fetch /sitemap.xml
 * 2. Filter URLs that start with /pages/ (R3 anti-mix — rejects product/collection/blog/cart URLs)
 * 3. Fetch each allowed URL, extract <title> + <main> body
 */

import * as cheerio from 'cheerio'
import type { ScrapedPage } from '../types.js'

export interface ScrapePagesOpts {
  readonly fetch?: typeof globalThis.fetch
}

const ALLOWED_PREFIXES = ['/pages/']
const BLOCKED_PREFIXES = ['/products/', '/collections/', '/blogs/', '/cart', '/checkout', '/account']

export async function scrapeSitemapPages(
  sourceUrl: string,
  opts: ScrapePagesOpts = {},
): Promise<ScrapedPage[]> {
  const fetchFn = opts.fetch ?? globalThis.fetch
  const sitemapUrl = new URL('/sitemap.xml', sourceUrl).toString()
  const smRes = await fetchFn(sitemapUrl)
  if (!smRes.ok) return []

  const xml = await smRes.text()
  const urls = extractUrls(xml).filter((u) => isAllowedPageUrl(u))

  const out: ScrapedPage[] = []
  for (const url of urls) {
    try {
      const res = await fetchFn(url)
      if (!res.ok) continue
      const html = await res.text()
      const parsed = parsePageHtml(html, url)
      if (parsed) out.push(parsed)
    } catch {
      // swallow — one bad page doesn't abort the sitemap walk
      continue
    }
  }
  return out
}

function extractUrls(xml: string): string[] {
  const re = /<loc>([^<]+)<\/loc>/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim())
  return out
}

function isAllowedPageUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const path = u.pathname
    if (BLOCKED_PREFIXES.some((p) => path.startsWith(p))) return false
    return ALLOWED_PREFIXES.some((p) => path.startsWith(p))
  } catch {
    return false
  }
}

function parsePageHtml(html: string, url: string): ScrapedPage | null {
  const $ = cheerio.load(html)
  const title = $('title').text().trim() || $('h1').first().text().trim()
  if (!title) return null
  const main = $('main').html() || $('article').html() || $('body').html() || ''
  const slug = slugFromUrl(url)
  return { url, slug, title, body_html: main.trim() }
}

function slugFromUrl(url: string): string {
  const u = new URL(url)
  const parts = u.pathname.split('/').filter(Boolean)
  // /pages/about → 'about'
  return parts[parts.length - 1] || 'index'
}
