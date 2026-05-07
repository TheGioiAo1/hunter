/**
 * Gbox Platform — SEO Scan Service (Phase 8 PR3)
 *
 * Fetches a list of storefront URLs and analyses the returned HTML for
 * the everyday issues that cost shops organic traffic: missing title,
 * missing meta description, missing H1, duplicate titles across pages,
 * missing canonical link, images without alt text, 4xx/5xx pages.
 *
 * Design:
 *
 *   1. **Dep-injected fetcher.** Production binds it to `fetch()` with a
 *      5s timeout + a descriptive User-Agent. Tests pass in a stub with
 *      deterministic responses. We never import `node:fetch` or
 *      `undici` directly — the scanner stays usable in browsers, edge
 *      runtimes, or the admin CLI.
 *
 *   2. **Regex parsing, not a DOM.** The scanner looks at five tags
 *      (title, meta description, h1, canonical link, img). Pulling in
 *      cheerio/linkedom for that is overkill and couples the admin
 *      tool to a much bigger dep graph. The regexes are documented
 *      inline; they're intentionally permissive (case-insensitive,
 *      `[\s\S]` so multi-line content matches, bounded quantifiers
 *      to cap worst-case ReDoS exposure).
 *
 *   3. **Per-URL serial fetch with a cap.** 50 URLs max per scan —
 *      enough to give the merchant a representative sample, not so
 *      many that a manual "Scan now" click hammers their own storefront.
 *      Sequencing (rather than concurrent) is intentional: we don't
 *      want to DDoS the shop behind a rate-limited nginx.
 *
 *   4. **Never throws per page.** A fetch error / parse error becomes
 *      an `error`-severity issue on that URL; the scan keeps going.
 *      The caller always gets back a full `SeoScanReport`.
 *
 *   5. **Score heuristic.** Starts at 100. `error`-severity issues cost
 *      8 each, `warning` 3, `info` 1. Floors at 0. Caller renders it
 *      as a Shopify-style "SEO score" badge on the admin page.
 */

import type { SeoScanIssue, SeoScanReport } from './seo-settings.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FetchResult {
  status: number
  body: string | null
}

export type SeoFetcher = (url: string) => Promise<FetchResult>

export interface ScanPageInput {
  url: string
  status: number
  body: string | null
}

export interface ScanOptions {
  /** Absolute URLs to fetch. Caller resolves these against the shop's base URL. */
  urls: string[]
  /** Injected HTTP client. Production binds to global fetch. */
  fetcher: SeoFetcher
  /** Hard cap on URLs scanned (default 50). Protects the merchant's origin. */
  maxUrls?: number
}

// ---------------------------------------------------------------------------
// HTML parsers (regex-based, bounded)
// ---------------------------------------------------------------------------

/**
 * First `<title>…</title>` in the document. Returns the trimmed inner
 * text or null when absent. The `{0,500}` cap on the inner match is a
 * belt-and-braces against a pathological input with no closing tag.
 */
export function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]{0,500}?)<\/title>/i.exec(html)
  if (!m) return null
  const inner = m[1] ?? ''
  const trimmed = inner.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * Content of the first `<meta name="description" content="…">`.
 * Allows the attributes to appear in either order.
 */
export function extractMetaDescription(html: string): string | null {
  const patterns = [
    /<meta[^>]+name=["']description["'][^>]*content=["']([\s\S]{0,1000}?)["'][^>]*>/i,
    /<meta[^>]+content=["']([\s\S]{0,1000}?)["'][^>]*name=["']description["'][^>]*>/i,
  ]
  for (const re of patterns) {
    const m = re.exec(html)
    if (m) {
      const trimmed = (m[1] ?? '').trim()
      if (trimmed.length > 0) return trimmed
    }
  }
  return null
}

/**
 * Count of `<h1>` elements. Used to flag missing or duplicate H1s.
 */
export function countH1(html: string): number {
  // Non-greedy, so the regex doesn't merge two distinct H1 blocks.
  const matches = html.match(/<h1[\s>][^]*?<\/h1>/gi)
  return matches ? matches.length : 0
}

/**
 * Extract the canonical URL (the first `<link rel="canonical">`).
 * Returns null when absent.
 */
export function extractCanonical(html: string): string | null {
  const patterns = [
    /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i,
    /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["'][^>]*>/i,
  ]
  for (const re of patterns) {
    const m = re.exec(html)
    if (m) {
      const v = (m[1] ?? '').trim()
      if (v.length > 0) return v
    }
  }
  return null
}

/**
 * Count `<img>` tags that are missing an `alt=` attribute OR have
 * an empty alt (`alt=""`). The latter is a valid pattern for
 * decorative images, so callers probably want to treat it as info-
 * severity — we fold them into the same bucket here and let the
 * caller decide.
 */
export function countImagesWithoutAlt(html: string): number {
  const imgs = html.match(/<img\b[^>]*>/gi) ?? []
  let missing = 0
  for (const tag of imgs) {
    if (!/\balt\s*=/i.test(tag)) {
      missing++
      continue
    }
    // Empty alt="" is technically valid but flag it as a nudge.
    if (/\balt\s*=\s*["']\s*["']/i.test(tag)) {
      missing++
    }
  }
  return missing
}

// ---------------------------------------------------------------------------
// Analyse
// ---------------------------------------------------------------------------

const TITLE_MIN = 10
const TITLE_MAX = 70
const META_DESC_MIN = 50
const META_DESC_MAX = 160

/**
 * Pure analyser over a fetched page set. Exported separately from
 * `scanShop()` so the admin page can reuse it on canned HTML for
 * an inline "Preview scan" button.
 */
export function analyseScan(pages: ScanPageInput[]): SeoScanReport {
  const issues: SeoScanIssue[] = []
  const titleBuckets = new Map<string, string[]>()

  for (const page of pages) {
    if (page.body === null || page.status === 0) {
      issues.push({
        url: page.url,
        severity: 'error',
        code: 'fetch_failed',
        message: 'The page could not be fetched. Check that the storefront is reachable.',
      })
      continue
    }

    if (page.status >= 500) {
      issues.push({
        url: page.url,
        severity: 'error',
        code: 'http_5xx',
        message: `Server returned ${page.status}.`,
      })
      continue
    }

    if (page.status >= 400) {
      issues.push({
        url: page.url,
        severity: 'error',
        code: 'http_4xx',
        message: `Page returned ${page.status}. Search engines will drop it from the index.`,
      })
      continue
    }

    const html = page.body
    const title = extractTitle(html)
    const metaDesc = extractMetaDescription(html)
    const h1Count = countH1(html)
    const canonical = extractCanonical(html)
    const altMissing = countImagesWithoutAlt(html)

    // Title
    if (!title) {
      issues.push({
        url: page.url,
        severity: 'error',
        code: 'missing_title',
        message: 'Page has no <title> tag.',
      })
    } else {
      if (title.length < TITLE_MIN) {
        issues.push({
          url: page.url,
          severity: 'warning',
          code: 'short_title',
          message: `Title is only ${title.length} characters (recommended ≥ ${TITLE_MIN}).`,
        })
      } else if (title.length > TITLE_MAX) {
        issues.push({
          url: page.url,
          severity: 'warning',
          code: 'long_title',
          message: `Title is ${title.length} characters (recommended ≤ ${TITLE_MAX}).`,
        })
      }
      const list = titleBuckets.get(title) ?? []
      list.push(page.url)
      titleBuckets.set(title, list)
    }

    // Meta description
    if (!metaDesc) {
      issues.push({
        url: page.url,
        severity: 'warning',
        code: 'missing_meta_description',
        message: 'Page has no meta description.',
      })
    } else if (metaDesc.length < META_DESC_MIN) {
      issues.push({
        url: page.url,
        severity: 'info',
        code: 'short_meta_description',
        message: `Meta description is only ${metaDesc.length} characters (recommended ≥ ${META_DESC_MIN}).`,
      })
    } else if (metaDesc.length > META_DESC_MAX) {
      issues.push({
        url: page.url,
        severity: 'info',
        code: 'long_meta_description',
        message: `Meta description is ${metaDesc.length} characters (recommended ≤ ${META_DESC_MAX}).`,
      })
    }

    // H1
    if (h1Count === 0) {
      issues.push({
        url: page.url,
        severity: 'warning',
        code: 'missing_h1',
        message: 'Page has no <h1> heading.',
      })
    } else if (h1Count > 1) {
      issues.push({
        url: page.url,
        severity: 'info',
        code: 'multiple_h1',
        message: `Page has ${h1Count} <h1> tags (recommended 1).`,
      })
    }

    // Canonical
    if (!canonical) {
      issues.push({
        url: page.url,
        severity: 'warning',
        code: 'missing_canonical',
        message: 'Page has no canonical link tag.',
      })
    }

    // Image alt text
    if (altMissing > 0) {
      issues.push({
        url: page.url,
        severity: 'info',
        code: 'missing_image_alt',
        message: `${altMissing} image${altMissing === 1 ? '' : 's'} without alt text.`,
      })
    }
  }

  // Duplicate titles across pages — flag every offender.
  for (const [title, urls] of titleBuckets) {
    if (urls.length < 2) continue
    for (const url of urls) {
      issues.push({
        url,
        severity: 'warning',
        code: 'duplicate_title',
        message: `Title "${title}" also appears on ${urls.length - 1} other page${
          urls.length - 1 === 1 ? '' : 's'
        }.`,
      })
    }
  }

  const score = computeScore(issues)

  return {
    pages_scanned: pages.length,
    score,
    issues,
  }
}

function computeScore(issues: SeoScanIssue[]): number {
  let score = 100
  for (const i of issues) {
    if (i.severity === 'error') score -= 8
    else if (i.severity === 'warning') score -= 3
    else score -= 1
  }
  return Math.max(0, Math.min(100, score))
}

// ---------------------------------------------------------------------------
// scanShop (IO boundary)
// ---------------------------------------------------------------------------

/**
 * Fetch every URL in `opts.urls` (capped at `maxUrls`) serially, then
 * hand the result to `analyseScan()`. Never throws; fetch failures
 * surface as `fetch_failed` issues in the returned report.
 */
export async function scanShop(opts: ScanOptions): Promise<SeoScanReport> {
  const cap = opts.maxUrls ?? 50
  const urls = opts.urls.slice(0, cap)
  const pages: ScanPageInput[] = []

  for (const url of urls) {
    try {
      const r = await opts.fetcher(url)
      pages.push({ url, status: r.status, body: r.body })
    } catch {
      // Fetcher rejected — normalise to a failed page.
      pages.push({ url, status: 0, body: null })
    }
  }

  return analyseScan(pages)
}

/**
 * Convenience production fetcher. Uses global `fetch` with a 5s abort
 * timeout and a Gbox-branded user agent (so storefront logs show the
 * scan traffic as ours, not as anonymous scrapers).
 *
 * Returns a body of `null` when the response is not `text/html`; the
 * scanner treats that as a fetch failure which matches merchant
 * expectations (the SEO report is for HTML pages).
 */
export async function defaultSeoFetcher(url: string): Promise<FetchResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5_000)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Gbox-SEO-Scan/1.0 (+https://gbox.co)',
        accept: 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    })
    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('text/html')) {
      return { status: res.status, body: null }
    }
    const body = await res.text()
    return { status: res.status, body }
  } catch {
    return { status: 0, body: null }
  } finally {
    clearTimeout(timer)
  }
}
