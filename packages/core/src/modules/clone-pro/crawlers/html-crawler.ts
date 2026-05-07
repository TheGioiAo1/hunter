/**
 * Clone Pro — Generic HTML Product Crawler
 *
 * Crawls products from any website by scraping individual product pages.
 * Extraction priority:
 *   1. JSON-LD (Schema.org Product) — most structured, highest quality
 *   2. Open Graph meta tags — good fallback
 *   3. Microdata (itemtype="http://schema.org/Product")
 *   4. DOM heuristics — last resort (h1 = title, .price = price, etc.)
 *
 * Used when no platform-specific API is available.
 */

import * as cheerio from 'cheerio'
import { safeFetch } from '../../clone-shopify/safe-fetch.js'
import type { CloneProductDTO, CloneImageDTO, CloneVariantDTO } from '../../clone-shopify/types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT = 15_000
const FETCH_MAX_BYTES = 5 * 1024 * 1024

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Crawl products from a list of product page URLs.
 * Each URL is fetched and parsed using multiple extraction strategies.
 *
 * @param productUrls - Array of product page URLs to scrape
 * @param baseUrl - The website's base URL
 * @param options.concurrency - Max concurrent requests (default: 3)
 * @returns Array of CloneProductDTO
 */
export async function crawlHTMLProducts(
  productUrls: string[],
  baseUrl: string,
  options?: { concurrency?: number },
): Promise<CloneProductDTO[]> {
  const concurrency = options?.concurrency ?? 3
  const results: CloneProductDTO[] = []
  const queue = [...productUrls]

  const worker = async () => {
    while (queue.length > 0) {
      const url = queue.shift()
      if (!url) break
      try {
        const product = await scrapeProductPage(url, baseUrl)
        if (product) results.push(product)
      } catch (err) {
        console.warn(`[html-crawler] Failed to crawl ${url}:`, (err as Error).message)
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => worker())
  await Promise.all(workers)

  return results
}

// ---------------------------------------------------------------------------
// Single product page scraper
// ---------------------------------------------------------------------------

async function scrapeProductPage(
  url: string,
  baseUrl: string,
): Promise<CloneProductDTO | null> {
  const resp = await safeFetch(url, {
    timeoutMs: FETCH_TIMEOUT,
    maxBytes: FETCH_MAX_BYTES,
  })

  if (resp.statusCode !== 200) return null

  const html = resp.body.toString('utf-8')
  const $ = cheerio.load(html)

  // Strategy 1: JSON-LD
  const jsonLd = extractFromJsonLd($, url)
  if (jsonLd) return jsonLd

  // Strategy 2: Open Graph
  const og = extractFromOpenGraph($, url, baseUrl)
  if (og) return og

  // Strategy 3: Microdata
  const microdata = extractFromMicrodata($, url, baseUrl)
  if (microdata) return microdata

  // Strategy 4: DOM heuristics
  return extractFromDom($, url, baseUrl)
}

// ---------------------------------------------------------------------------
// Strategy 1: JSON-LD extraction
// ---------------------------------------------------------------------------

function extractFromJsonLd(
  $: cheerio.CheerioAPI,
  url: string,
): CloneProductDTO | null {
  const scripts = $('script[type="application/ld+json"]')
  for (let i = 0; i < scripts.length; i++) {
    try {
      const text = $(scripts[i]).html()
      if (!text) continue
      const data = JSON.parse(text)

      const product = findProduct(data)
      if (!product) continue

      return jsonLdToDTO(product, url)
    } catch { /* skip */ }
  }
  return null
}

function findProduct(data: any): any {
  if (!data) return null
  if (data['@type'] === 'Product') return data
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findProduct(item)
      if (found) return found
    }
  }
  if (data['@graph'] && Array.isArray(data['@graph'])) {
    return findProduct(data['@graph'])
  }
  return null
}

function jsonLdToDTO(product: any, url: string): CloneProductDTO {
  const offers = product.offers
    ? (Array.isArray(product.offers) ? product.offers : [product.offers])
    : []

  const images = normalizeImages(
    product.image
      ? (Array.isArray(product.image) ? product.image : [product.image])
      : [],
  )

  const variants: CloneVariantDTO[] = offers.length > 0
    ? offers.map((o: any, idx: number) => ({
        sourceVariantId: o.sku || String(idx),
        sku: o.sku || null,
        title: o.name || 'Default',
        price: String(o.price || o.lowPrice || '0'),
        compareAtPrice: o.highPrice && o.highPrice !== o.price
          ? String(o.highPrice)
          : null,
        optionValues: [],
        available: o.availability
          ? String(o.availability).includes('InStock')
          : true,
      }))
    : [defaultVariant(product.sku)]

  return {
    sourceProductId: product.sku || product['@id'] || slugify(product.name || ''),
    handle: slugify(product.name || ''),
    title: product.name || '',
    descriptionHtml: product.description || '',
    vendor: product.brand?.name || null,
    productType: product.category || null,
    tags: [],
    images,
    variants,
  }
}

// ---------------------------------------------------------------------------
// Strategy 2: Open Graph extraction
// ---------------------------------------------------------------------------

function extractFromOpenGraph(
  $: cheerio.CheerioAPI,
  url: string,
  baseUrl: string,
): CloneProductDTO | null {
  const ogType = $('meta[property="og:type"]').attr('content')
  // Only use OG if it looks like a product page
  if (ogType && !ogType.includes('product')) return null

  const title = $('meta[property="og:title"]').attr('content')?.trim()
  if (!title) return null

  const price =
    $('meta[property="product:price:amount"]').attr('content') ||
    $('meta[property="og:price:amount"]').attr('content')

  // Must have a price to be considered a product
  if (!price) return null

  const description =
    $('meta[property="og:description"]').attr('content')?.trim() || ''

  const ogImage = $('meta[property="og:image"]').attr('content')
  const images: CloneImageDTO[] = ogImage
    ? [{ sourceUrl: resolveUrl(ogImage, baseUrl), altText: null, width: null, height: null }]
    : []

  const currency =
    $('meta[property="product:price:currency"]').attr('content') ||
    $('meta[property="og:price:currency"]').attr('content') ||
    'USD'

  return {
    sourceProductId: slugify(title),
    handle: slugify(title),
    title,
    descriptionHtml: description,
    vendor: $('meta[property="product:brand"]').attr('content') || null,
    productType: $('meta[property="product:category"]').attr('content') || null,
    tags: [],
    images,
    variants: [{
      sourceVariantId: slugify(title),
      sku: null,
      title: 'Default',
      price,
      compareAtPrice: null,
      optionValues: [],
      available: $('meta[property="product:availability"]').attr('content') !== 'oos',
    }],
  }
}

// ---------------------------------------------------------------------------
// Strategy 3: Microdata extraction
// ---------------------------------------------------------------------------

function extractFromMicrodata(
  $: cheerio.CheerioAPI,
  url: string,
  baseUrl: string,
): CloneProductDTO | null {
  const $product = $('[itemtype*="schema.org/Product"]').first()
  if ($product.length === 0) return null

  const title =
    $product.find('[itemprop="name"]').first().text().trim() ||
    $('h1').first().text().trim()

  if (!title) return null

  const description =
    $product.find('[itemprop="description"]').first().html() || ''

  const price =
    $product.find('[itemprop="price"]').first().attr('content') ||
    $product.find('[itemprop="price"]').first().text().replace(/[^0-9.]/g, '') ||
    '0'

  const sku = $product.find('[itemprop="sku"]').first().attr('content') ||
    $product.find('[itemprop="sku"]').first().text().trim() || null

  const images: CloneImageDTO[] = []
  $product.find('[itemprop="image"]').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('content') || $(el).attr('href')
    if (src) {
      images.push({
        sourceUrl: resolveUrl(src, baseUrl),
        altText: $(el).attr('alt') || null,
        width: null,
        height: null,
      })
    }
  })

  const availability = $product.find('[itemprop="availability"]').first()
  const availText = availability.attr('content') || availability.attr('href') || ''
  const available = !availText.includes('OutOfStock')

  return {
    sourceProductId: sku || slugify(title),
    handle: slugify(title),
    title,
    descriptionHtml: description,
    vendor: $product.find('[itemprop="brand"] [itemprop="name"]').first().text().trim() || null,
    productType: null,
    tags: [],
    images,
    variants: [{
      sourceVariantId: sku || slugify(title),
      sku,
      title: 'Default',
      price,
      compareAtPrice: null,
      optionValues: [],
      available,
    }],
  }
}

// ---------------------------------------------------------------------------
// Strategy 4: DOM heuristics (last resort)
// ---------------------------------------------------------------------------

function extractFromDom(
  $: cheerio.CheerioAPI,
  url: string,
  baseUrl: string,
): CloneProductDTO | null {
  const title = $('h1').first().text().trim()
  if (!title) return null

  // Look for price
  const priceSelectors = [
    '.price',
    '.product-price',
    '[class*="price"]',
    '#price',
    '.amount',
    '[data-price]',
  ]

  let price = '0'
  for (const sel of priceSelectors) {
    const text = $(sel).first().text().trim()
    const match = text.match(/[\d,]+\.?\d*/)
    if (match) {
      price = match[0].replace(/,/g, '')
      break
    }
  }

  // Look for description
  const descSelectors = [
    '.product-description',
    '.description',
    '[class*="description"]',
    '#description',
    '.product-details',
  ]

  let description = ''
  for (const sel of descSelectors) {
    const $el = $(sel).first()
    if ($el.length > 0 && $el.text().trim().length > 20) {
      description = $el.html() || ''
      break
    }
  }

  // Look for product images
  const images: CloneImageDTO[] = []
  const imageSelectors = [
    '.product-images img',
    '.product-gallery img',
    '.gallery img',
    '.product-image img',
    '[class*="product"] img',
    '[data-zoom] img',
    'img[data-zoom-image]',
  ]

  const seenSrcs = new Set<string>()
  for (const sel of imageSelectors) {
    $(sel).each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-zoom-image')
      if (!src || seenSrcs.has(src)) return
      seenSrcs.add(src)
      images.push({
        sourceUrl: resolveUrl(src, baseUrl),
        altText: $(el).attr('alt') || null,
        width: null,
        height: null,
      })
    })
    if (images.length > 0) break
  }

  const slug = extractSlugFromUrl(url)

  return {
    sourceProductId: slug,
    handle: slug,
    title,
    descriptionHtml: description,
    vendor: null,
    productType: null,
    tags: [],
    images,
    variants: [{
      sourceVariantId: slug,
      sku: null,
      title: 'Default',
      price,
      compareAtPrice: null,
      optionValues: [],
      available: true,
    }],
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeImages(rawImages: any[]): CloneImageDTO[] {
  const result: CloneImageDTO[] = []
  for (const img of rawImages) {
    const url = typeof img === 'string' ? img : img?.url || img?.contentUrl || ''
    if (!url) continue
    result.push({
      sourceUrl: url,
      altText: typeof img === 'object' ? img?.name || null : null,
      width: null,
      height: null,
    })
  }
  return result
}

function defaultVariant(sku?: string): CloneVariantDTO {
  return {
    sourceVariantId: sku || '0',
    sku: sku || null,
    title: 'Default',
    price: '0',
    compareAtPrice: null,
    optionValues: [],
    available: true,
  }
}

function resolveUrl(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).href
  } catch {
    return href
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 100)
}

function extractSlugFromUrl(url: string): string {
  try {
    const segments = new URL(url).pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
    return segments[segments.length - 1] || 'product'
  } catch {
    return 'product'
  }
}
