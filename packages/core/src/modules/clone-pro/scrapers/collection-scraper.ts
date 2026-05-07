/**
 * Clone Pro — Collection/Category Scraper
 *
 * Scrapes collection/category pages from e-commerce websites.
 * Extracts title, description, image, and product URLs from each collection.
 *
 * Works with any platform by detecting common patterns:
 * - Shopify collection pages
 * - WooCommerce product categories
 * - Generic e-commerce category layouts
 */

import * as cheerio from 'cheerio'
import { safeFetch } from '../../clone-shopify/safe-fetch.js'
import type { CloneSitemapNode } from '../../clone-shopify/types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScrapedCollection {
  readonly url: string
  readonly title: string
  readonly slug: string
  readonly description: string | null
  readonly image_url: string | null
  readonly product_urls: string[]
}

// ---------------------------------------------------------------------------
// Slug extraction
// ---------------------------------------------------------------------------

function extractSlug(url: string): string {
  const path = new URL(url).pathname
  const segments = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  // Usually last segment: /collections/summer-sale → summer-sale
  return segments[segments.length - 1] || 'collection'
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function resolveUrl(href: string, baseUrl: string): string {
  try {
    if (!href || href === '#' || href.startsWith('javascript:') || href.startsWith('mailto:')) {
      return ''
    }
    return new URL(href, baseUrl).href
  } catch {
    return ''
  }
}

function isSameDomain(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).hostname === new URL(baseUrl).hostname
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Product link detection selectors
// ---------------------------------------------------------------------------

const PRODUCT_LINK_SELECTORS = [
  // Shopify
  '.product-card a[href*="/products/"]',
  '.product-item a[href*="/products/"]',
  'a[href*="/products/"]',
  // WooCommerce
  '.product a[href*="/product/"]',
  '.woocommerce-loop-product__link',
  'a.woocommerce-LoopProduct-link',
  // Generic
  '.product a',
  '.product-card a',
  '.product-item a',
  '.product-grid a',
  '.product-list a',
  '[data-product] a',
  '.card-product a',
  '.grid-product a',
]

// ---------------------------------------------------------------------------
// Collection image detection
// ---------------------------------------------------------------------------

const COLLECTION_IMAGE_SELECTORS = [
  '.collection-image img',
  '.collection-hero img',
  '.category-image img',
  '.collection-banner img',
  '.category-banner img',
  '.page-header img',
  '.hero img',
  '.banner img',
  'meta[property="og:image"]',
]

// ---------------------------------------------------------------------------
// Scrape a single collection page
// ---------------------------------------------------------------------------

async function scrapeCollectionPage(
  url: string,
  baseUrl: string,
): Promise<ScrapedCollection | null> {
  try {
    const resp = await safeFetch(url, {
      timeoutMs: 15_000,
      maxBytes: 5 * 1024 * 1024,
    })

    const html = resp.body.toString('utf-8')
    const $ = cheerio.load(html)

    // --- Title ---
    const title =
      $('h1').first().text().trim() ||
      $('title').text().trim().split(/[|–—-]/).shift()?.trim() ||
      'Untitled Collection'

    // --- Description ---
    const description =
      $('meta[name="description"]').attr('content')?.trim() ||
      $('meta[property="og:description"]').attr('content')?.trim() ||
      $('.collection-description').first().text().trim() ||
      $('.category-description').first().text().trim() ||
      null

    // --- Image ---
    let image_url: string | null = null
    for (const selector of COLLECTION_IMAGE_SELECTORS) {
      if (selector.includes('meta[')) {
        const content = $(selector).attr('content')?.trim()
        if (content) {
          image_url = resolveUrl(content, baseUrl)
          break
        }
      } else {
        const $img = $(selector).first()
        if ($img.length > 0) {
          const src = $img.attr('src') || $img.attr('data-src') || $img.attr('data-lazy-src')
          if (src) {
            image_url = resolveUrl(src, baseUrl)
            break
          }
        }
      }
    }

    // --- Product URLs ---
    const productUrls: string[] = []
    const seenUrls = new Set<string>()

    for (const selector of PRODUCT_LINK_SELECTORS) {
      $(selector).each((_, el) => {
        const href = resolveUrl($(el).attr('href') || '', baseUrl)
        if (!href || seenUrls.has(href)) return
        if (!isSameDomain(href, baseUrl)) return

        // Must look like a product URL
        const path = new URL(href).pathname.toLowerCase()
        if (
          path.includes('/product') ||
          path.includes('/shop/') ||
          // Generic: avoid collection/page/blog URLs in product list
          (!path.includes('/collection') &&
           !path.includes('/categor') &&
           !path.includes('/page/') &&
           !path.includes('/blog/') &&
           !path.includes('/cart') &&
           !path.includes('/account'))
        ) {
          seenUrls.add(href)
          productUrls.push(href)
        }
      })

      // If we found product links with this selector, stop
      if (productUrls.length > 0) break
    }

    return {
      url,
      title,
      slug: extractSlug(url),
      description,
      image_url,
      product_urls: productUrls,
    }
  } catch (err) {
    console.warn(`[collection-scraper] Failed to scrape ${url}:`, (err as Error).message)
    return null
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrape collections from sitemap nodes.
 * Filters to only 'collection' kind nodes, fetches each page.
 *
 * @param sitemapNodes - All sitemap nodes from walkSitemap()
 * @param baseUrl - The website's base URL
 * @param options.concurrency - Max concurrent requests (default: 3)
 * @returns Array of scraped collections
 */
export async function scrapeCollections(
  sitemapNodes: readonly CloneSitemapNode[],
  baseUrl: string,
  options?: { concurrency?: number },
): Promise<ScrapedCollection[]> {
  const collectionNodes = sitemapNodes.filter((n) => n.kind === 'collection')
  if (collectionNodes.length === 0) return []

  const concurrency = options?.concurrency ?? 3
  const results: ScrapedCollection[] = []
  const queue = [...collectionNodes]

  const worker = async () => {
    while (queue.length > 0) {
      const node = queue.shift()
      if (!node) break
      const collection = await scrapeCollectionPage(node.url, baseUrl)
      if (collection) {
        results.push(collection)
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker())
  await Promise.all(workers)

  return results
}

/**
 * Scrape collections from a list of URLs directly (when sitemap is not available).
 */
export async function scrapeCollectionUrls(
  urls: string[],
  baseUrl: string,
  options?: { concurrency?: number },
): Promise<ScrapedCollection[]> {
  const concurrency = options?.concurrency ?? 3
  const results: ScrapedCollection[] = []
  const queue = [...urls]

  const worker = async () => {
    while (queue.length > 0) {
      const url = queue.shift()
      if (!url) break
      const collection = await scrapeCollectionPage(url, baseUrl)
      if (collection) {
        results.push(collection)
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker())
  await Promise.all(workers)

  return results
}
