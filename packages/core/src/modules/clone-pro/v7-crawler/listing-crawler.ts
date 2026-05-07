/**
 * Listing crawler — paginate a collection page and harvest product URLs.
 *
 * Ports the Lonspy listing-loop logic. For each page:
 *   1. Fetch HTML (or use injected fetch fn for tests).
 *   2. Extract per-product node chunks via `extractElements(item.xpath)`.
 *   3. Inside each chunk, run the configured `Link` element to get the URL.
 *   4. Apply replaces, dedupe, absolutise relative URLs.
 *
 * Stops when:
 *   - A page returns zero products (last page reached), OR
 *   - `limit` is hit, OR
 *   - `maxPages` (safety cap) is reached.
 *
 * Iron Rule 5: errors do not surface here; orchestrator wraps via safeMessage.
 */
import { httpFetchHtml } from './http-fetch.js'
import { extractElements, extractValue, applyReplaces } from './xpath-engine.js'
import type { Config } from './types.js'

export interface ListingResult {
  product_urls: string[]
  collection_handle: string | null
  total_pages_crawled: number
}

export interface CrawlListingOptions {
  /** Hard cap on returned URLs. `null`/undefined → no limit. */
  limit?: number | null
  /** Safety cap on pages walked (default 100). */
  maxPages?: number
  /** Inject for tests to skip real HTTP. */
  fetch?: (url: string) => Promise<string>
}

export async function crawlListing(
  collectionUrl: string,
  config: Config,
  opts: CrawlListingOptions = {},
): Promise<ListingResult> {
  const fetchFn = opts.fetch ?? httpFetchHtml
  const maxPages = opts.maxPages ?? 100
  const hardLimit = opts.limit ?? Infinity

  const linkEl = config.item.elements.find((e) => e.name === 'Link')
  const seen = new Set<string>()
  const productUrls: string[] = []
  let page = 1

  while (productUrls.length < hardLimit && page <= maxPages) {
    const pageUrl = page === 1 ? collectionUrl : appendPageQuery(collectionUrl, page)
    const html = await fetchFn(pageUrl)
    const chunks = extractElements(html, config.item.xpath)
    if (chunks.length === 0) break

    if (!linkEl) {
      // No Link element configured — caller can't get URLs. Bail with empty result.
      break
    }

    for (const chunk of chunks) {
      const rawUrl = extractValue(chunk, linkEl.xpath, linkEl.attr)
      const replaced = applyReplaces(rawUrl, linkEl.replaces)
      if (!replaced) continue
      const absolute = absolutise(replaced, collectionUrl)
      if (!absolute || seen.has(absolute)) continue
      seen.add(absolute)
      productUrls.push(absolute)
      if (productUrls.length >= hardLimit) break
    }

    if (productUrls.length >= hardLimit) break
    page += 1
    if (config.delay > 0) await sleep(config.delay)
  }

  return {
    product_urls: productUrls,
    collection_handle: deriveCollectionHandle(collectionUrl),
    total_pages_crawled: page - 1 < 1 ? 1 : Math.min(page - 1, maxPages),
  }
}

function appendPageQuery(url: string, page: number): string {
  try {
    const u = new URL(url)
    u.searchParams.set('page', String(page))
    return u.toString()
  } catch {
    return `${url}${url.includes('?') ? '&' : '?'}page=${page}`
  }
}

function absolutise(href: string, base: string): string | null {
  if (!href) return null
  try {
    return new URL(href, base).toString()
  } catch {
    return null
  }
}

function deriveCollectionHandle(url: string): string | null {
  try {
    const path = new URL(url).pathname
    const m = /\/collections\/([^/?#]+)/.exec(path)
    return m ? m[1] : null
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
