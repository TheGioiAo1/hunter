/**
 * Orchestrator — single entry point for Sprint 1 v7 crawler.
 *
 * Pipeline:
 *   1. fetch home/collection page → detect platform
 *   2. load XPath config for platform
 *   3. listing-crawler → harvest product URLs (paginate)
 *   4. detail-crawler → fetch each product page and extract Row[]
 *   5. assemble CrawlResult { products, warnings, ... }
 *
 * Sprint 2 will add sitemap discovery, collections + pages crawl, and
 * AI fallback for `unknown` platforms. Sprint 1 stays minimal — caller
 * passes a collection URL directly.
 *
 * Iron Rule 5: this module throws raw `Error` only. The caller (CLI / API
 * route) is responsible for piping diagnostic to logs and `safeMessage`
 * to the seller-facing response.
 */
import { httpFetchHtml } from './http-fetch.js'
import { detectPlatform } from './platform-detector.js'
import { loadConfig } from './config-loader.js'
import { crawlListing } from './listing-crawler.js'
import { crawlDetails } from './detail-crawler.js'
import { fetchShopifyProductsJson } from './shopify-products-json.js'
import type { CrawlResult, Row } from './types.js'

export interface CrawlSiteOptions {
  /** Cap on products to crawl. `null`/undefined → no cap. Sprint 1 default 200. */
  products_limit?: number | null
  /** Detail concurrency (default 5 — Q2 safe mode). */
  concurrency?: number
  /** Inject for tests. Falls back to httpFetchHtml. */
  fetch?: (url: string) => Promise<string>
  /**
   * Force the XPath-only path even on Shopify platforms.
   * Default: orchestrator prefers `/products.json` API for Shopify.
   */
  forceXpath?: boolean
}

export async function crawlSite(
  url: string,
  opts: CrawlSiteOptions = {},
): Promise<CrawlResult> {
  const fetchFn = opts.fetch ?? httpFetchHtml
  const concurrency = opts.concurrency ?? 5

  // 1. Initial HTML for platform detection.
  const homeHtml = await fetchFn(url)
  const platform = detectPlatform(homeHtml, url)
  if (platform === 'unknown') {
    throw new Error('unknown platform — Sprint 2 AI fallback required')
  }

  const warnings: string[] = []

  // 2. Shopify fast-path: many production Shopify shops render product
  //    grids via JS apps (Boost AI, Searchanise, etc.) — XPath returns
  //    zero. Use the documented public `/products.json` endpoint instead.
  let products: Row[] = []
  let configUsed = `${platform}.json`
  let collectionHandle: string | null = null

  if (!opts.forceXpath && (platform === 'shopify-classic' || platform === 'shopify-hydrogen')) {
    products = await fetchShopifyProductsJson(url, {
      limit: opts.products_limit ?? null,
      fetch: fetchFn,
    })
    configUsed = 'shopify-products-json'
    if (products.length === 0) {
      warnings.push('Shopify /products.json returned 0 products — falling back to XPath')
    }
  }

  // 3. XPath path (default + fallback when /products.json yields nothing).
  if (products.length === 0) {
    const config = loadConfig(platform)
    const listing = await crawlListing(url, config, {
      fetch: fetchFn,
      limit: opts.products_limit ?? null,
      maxPages: 100,
    })
    const detail = await crawlDetails(listing.product_urls, config, {
      fetch: fetchFn,
      concurrency,
    })
    products = detail.rows
    if (detail.failed_urls.length > 0) {
      warnings.push(`${detail.failed_urls.length} product page(s) failed to crawl`)
    }
    if (listing.product_urls.length === 0) {
      warnings.push('listing crawl returned 0 products — check XPath config')
    }
    collectionHandle = listing.collection_handle
  } else {
    collectionHandle = collectionHandleFromUrl(url)
  }

  return {
    source_url: url,
    platform,
    config_used: configUsed,
    products,
    collections: collectionHandle
      ? [
          {
            handle: collectionHandle,
            title: collectionHandle,
            product_handles: products
              .map((r) => productHandleFromUrl(r.Link))
              .filter((h): h is string => h !== null),
          },
        ]
      : [],
    pages: [], // Sprint 2
    warnings,
  }
}

function collectionHandleFromUrl(url: string): string | null {
  try {
    const m = /\/collections\/([^/?#]+)/.exec(new URL(url).pathname)
    return m ? m[1] : null
  } catch {
    return null
  }
}

function productHandleFromUrl(url: string | null): string | null {
  if (!url) return null
  try {
    const m = /\/products\/([^/?#]+)/.exec(new URL(url).pathname)
    return m ? m[1] : null
  } catch {
    return null
  }
}
