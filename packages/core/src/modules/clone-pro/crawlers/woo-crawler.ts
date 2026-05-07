/**
 * Clone Pro — WooCommerce Product Crawler
 *
 * Crawls products from WooCommerce stores via:
 * 1. WooCommerce Store API (v1) — always public, no auth needed
 * 2. WooCommerce REST API (v3) — sometimes public
 * 3. Fallback: HTML page scraping with JSON-LD extraction
 *
 * All HTTP requests use safeFetch for SSRF protection.
 */

import * as cheerio from 'cheerio'
import { safeFetch } from '../../clone-shopify/safe-fetch.js'
import type { CloneProductDTO, CloneImageDTO, CloneVariantDTO } from '../../clone-shopify/types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PER_PAGE = 100
const FETCH_TIMEOUT = 15_000
const FETCH_MAX_BYTES = 5 * 1024 * 1024 // 5 MB

// ---------------------------------------------------------------------------
// Main Crawler
// ---------------------------------------------------------------------------

/**
 * Crawl products from a WooCommerce store.
 * Tries Store API → REST API → HTML scraping.
 *
 * @param baseUrl - The store's base URL
 * @param maxProducts - Maximum products to crawl (default: 2000)
 * @returns Array of CloneProductDTO
 */
export async function crawlWooProducts(
  baseUrl: string,
  maxProducts = 2000,
): Promise<CloneProductDTO[]> {
  const cleanUrl = baseUrl.replace(/\/+$/, '')

  // 1. Try WooCommerce Store API (always public, no auth)
  let products = await tryStoreApi(cleanUrl, maxProducts)
  if (products.length > 0) return products

  // 2. Try WooCommerce REST API v3 (sometimes public)
  products = await tryRestApi(cleanUrl, maxProducts)
  if (products.length > 0) return products

  // 3. Fallback: HTML scraping
  return tryHtmlScraping(cleanUrl, maxProducts)
}

// ---------------------------------------------------------------------------
// Strategy 1: WooCommerce Store API (v1)
// ---------------------------------------------------------------------------

async function tryStoreApi(baseUrl: string, maxProducts: number): Promise<CloneProductDTO[]> {
  const products: CloneProductDTO[] = []

  try {
    let page = 1
    while (products.length < maxProducts) {
      const url = `${baseUrl}/wp-json/wc/store/v1/products?page=${page}&per_page=${MAX_PER_PAGE}`
      const resp = await safeFetch(url, {
        timeoutMs: FETCH_TIMEOUT,
        maxBytes: FETCH_MAX_BYTES,
      })

      if (resp.statusCode !== 200) break

      const items = JSON.parse(resp.body.toString('utf-8'))
      if (!Array.isArray(items) || items.length === 0) break

      for (const item of items) {
        if (products.length >= maxProducts) break
        products.push(storeApiToDTO(item))
      }

      if (items.length < MAX_PER_PAGE) break
      page++
    }
  } catch {
    // Store API not available
  }

  return products
}

function storeApiToDTO(item: any): CloneProductDTO {
  const images: CloneImageDTO[] = (item.images || []).map((img: any) => ({
    sourceUrl: img.src || img.thumbnail || '',
    altText: img.alt || null,
    width: null,
    height: null,
  }))

  const prices = item.prices || {}
  const price = prices.price
    ? (parseInt(prices.price, 10) / Math.pow(10, prices.decimals || 2)).toFixed(2)
    : '0'
  const regularPrice = prices.regular_price
    ? (parseInt(prices.regular_price, 10) / Math.pow(10, prices.decimals || 2)).toFixed(2)
    : null

  const variants: CloneVariantDTO[] = [{
    sourceVariantId: String(item.id || '0'),
    sku: item.sku || null,
    title: 'Default',
    price,
    compareAtPrice: regularPrice !== price ? regularPrice : null,
    optionValues: [],
    available: item.is_purchasable !== false && item.is_in_stock !== false,
  }]

  return {
    sourceProductId: String(item.id || ''),
    handle: item.slug || '',
    title: item.name || '',
    descriptionHtml: item.description || item.short_description || '',
    vendor: null,
    productType: (item.categories || [])[0]?.name || null,
    tags: (item.tags || []).map((t: any) => t.name || ''),
    images,
    variants,
  }
}

// ---------------------------------------------------------------------------
// Strategy 2: WooCommerce REST API (v3)
// ---------------------------------------------------------------------------

async function tryRestApi(baseUrl: string, maxProducts: number): Promise<CloneProductDTO[]> {
  const products: CloneProductDTO[] = []

  try {
    let page = 1
    while (products.length < maxProducts) {
      const url = `${baseUrl}/wp-json/wc/v3/products?page=${page}&per_page=${MAX_PER_PAGE}`
      const resp = await safeFetch(url, {
        timeoutMs: FETCH_TIMEOUT,
        maxBytes: FETCH_MAX_BYTES,
      })

      if (resp.statusCode !== 200) break

      const items = JSON.parse(resp.body.toString('utf-8'))
      if (!Array.isArray(items) || items.length === 0) break

      for (const item of items) {
        if (products.length >= maxProducts) break
        products.push(restApiToDTO(item))
      }

      if (items.length < MAX_PER_PAGE) break
      page++
    }
  } catch {
    // REST API not available or requires auth
  }

  return products
}

function restApiToDTO(item: any): CloneProductDTO {
  const images: CloneImageDTO[] = (item.images || []).map((img: any) => ({
    sourceUrl: img.src || '',
    altText: img.alt || null,
    width: null,
    height: null,
  }))

  const variants: CloneVariantDTO[] = [{
    sourceVariantId: String(item.id || '0'),
    sku: item.sku || null,
    title: 'Default',
    price: item.price || '0',
    compareAtPrice: item.regular_price && item.regular_price !== item.price
      ? item.regular_price
      : null,
    optionValues: [],
    available: item.purchasable !== false && item.in_stock !== false,
  }]

  // Add attribute-based variants if available
  if (Array.isArray(item.variations) && item.variations.length > 0) {
    // Note: variation details need separate API calls, which we skip for now
    // The main product serves as a single-variant fallback
  }

  return {
    sourceProductId: String(item.id || ''),
    handle: item.slug || '',
    title: item.name || '',
    descriptionHtml: item.description || '',
    vendor: null,
    productType: (item.categories || [])[0]?.name || null,
    tags: (item.tags || []).map((t: any) => t.name || ''),
    images,
    variants,
  }
}

// ---------------------------------------------------------------------------
// Strategy 3: HTML Scraping (fallback)
// ---------------------------------------------------------------------------

async function tryHtmlScraping(baseUrl: string, maxProducts: number): Promise<CloneProductDTO[]> {
  const products: CloneProductDTO[] = []

  try {
    // Try /shop page first (default WooCommerce shop page)
    const shopUrl = `${baseUrl}/shop`
    const resp = await safeFetch(shopUrl, {
      timeoutMs: FETCH_TIMEOUT,
      maxBytes: FETCH_MAX_BYTES,
    })

    if (resp.statusCode !== 200) return products

    const html = resp.body.toString('utf-8')
    const $ = cheerio.load(html)

    // Find product links
    const productUrls: string[] = []
    const seen = new Set<string>()

    $('a[href*="/product/"]').each((_, el) => {
      const href = $(el).attr('href')
      if (!href) return
      try {
        const resolved = new URL(href, baseUrl).href
        if (!seen.has(resolved)) {
          seen.add(resolved)
          productUrls.push(resolved)
        }
      } catch { /* skip */ }
    })

    // Fetch each product page and extract JSON-LD
    for (const url of productUrls.slice(0, maxProducts)) {
      try {
        const pageResp = await safeFetch(url, {
          timeoutMs: FETCH_TIMEOUT,
          maxBytes: FETCH_MAX_BYTES,
        })
        if (pageResp.statusCode !== 200) continue

        const pageHtml = pageResp.body.toString('utf-8')
        const product = extractProductFromHtml(pageHtml, url, baseUrl)
        if (product) {
          products.push(product)
        }
      } catch {
        // Skip failed pages
      }
    }
  } catch {
    // Shop page not available
  }

  return products
}

function extractProductFromHtml(
  html: string,
  url: string,
  baseUrl: string,
): CloneProductDTO | null {
  const $ = cheerio.load(html)

  // Try JSON-LD first
  const jsonLd = extractJsonLdProduct($)
  if (jsonLd) return jsonLd

  // Fallback: DOM heuristics
  const title = $('h1').first().text().trim() || $('title').text().trim()
  if (!title) return null

  const slug = new URL(url).pathname.split('/').filter(Boolean).pop() || ''
  const description = $('.woocommerce-product-details__short-description').html() ||
    $('[itemprop="description"]').html() ||
    ''

  const priceText = $('.price .woocommerce-Price-amount').first().text().trim()
  const price = priceText.replace(/[^0-9.]/g, '') || '0'

  const images: CloneImageDTO[] = []
  $('.woocommerce-product-gallery img, .product img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src')
    if (src) {
      try {
        images.push({
          sourceUrl: new URL(src, baseUrl).href,
          altText: $(el).attr('alt') || null,
          width: null,
          height: null,
        })
      } catch { /* skip */ }
    }
  })

  return {
    sourceProductId: slug,
    handle: slug,
    title,
    descriptionHtml: description || '',
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
// JSON-LD extraction
// ---------------------------------------------------------------------------

function extractJsonLdProduct($: cheerio.CheerioAPI): CloneProductDTO | null {
  const scripts = $('script[type="application/ld+json"]')
  for (let i = 0; i < scripts.length; i++) {
    try {
      const text = $(scripts[i]).html()
      if (!text) continue
      const data = JSON.parse(text)

      const product = findProductInJsonLd(data)
      if (!product) continue

      const offers = product.offers
        ? (Array.isArray(product.offers) ? product.offers : [product.offers])
        : []

      const images: CloneImageDTO[] = []
      const rawImages = product.image
        ? (Array.isArray(product.image) ? product.image : [product.image])
        : []
      for (const img of rawImages) {
        const url = typeof img === 'string' ? img : img?.url || img?.contentUrl
        if (url) {
          images.push({ sourceUrl: url, altText: null, width: null, height: null })
        }
      }

      return {
        sourceProductId: product.sku || product['@id'] || slugify(product.name || ''),
        handle: slugify(product.name || ''),
        title: product.name || '',
        descriptionHtml: product.description || '',
        vendor: product.brand?.name || null,
        productType: product.category || null,
        tags: [],
        images,
        variants: offers.length > 0
          ? offers.map((o: any, idx: number) => ({
              sourceVariantId: o.sku || String(idx),
              sku: o.sku || null,
              title: o.name || 'Default',
              price: String(o.price || '0'),
              compareAtPrice: null,
              optionValues: [],
              available: o.availability?.includes('InStock') !== false,
            }))
          : [{
              sourceVariantId: product.sku || '0',
              sku: product.sku || null,
              title: 'Default',
              price: '0',
              compareAtPrice: null,
              optionValues: [],
              available: true,
            }],
      }
    } catch { /* skip invalid JSON-LD */ }
  }
  return null
}

function findProductInJsonLd(data: any): any {
  if (data['@type'] === 'Product') return data
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item['@type'] === 'Product') return item
    }
  }
  if (data['@graph'] && Array.isArray(data['@graph'])) {
    for (const item of data['@graph']) {
      if (item['@type'] === 'Product') return item
    }
  }
  return null
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 100)
}
