/**
 * Shopify `/products.json` storefront API harvester.
 *
 * Sprint 1 reality: many production Shopify shops (incl. bibliobloom) ship a
 * minimal SSR HTML shell and inject the product grid via JavaScript apps
 * (Boost AI, Searchanise, etc). HTTP-only XPath crawl returns 0 cards on
 * those sites. Shopify's documented public API
 * `/products.json?limit=250&page=N` returns up to 250 products per page with
 * full title, body_html, images, variants, tags — exactly the fields v7's
 * `Row` shape needs. Use this as a fast-path for shopify-classic /
 * shopify-hydrogen platforms; fall back to XPath for non-Shopify or when
 * the endpoint is disabled.
 *
 * This module is platform-specific and lives outside the generic
 * Lonspy XPath pipeline — not a port of CrawlHelper.cs but a pragmatic
 * complement that hits the same `Row` shape.
 *
 * Iron Rule 5: pure functions; orchestrator wraps errors via safeMessage.
 */
import { httpFetchHtml } from './http-fetch.js'
import type { Row } from './types.js'

interface ShopifyImage {
  src: string
}
interface ShopifyVariant {
  id: number | string
  title: string
  price: string | number | null
  compare_at_price: string | number | null
  sku: string | null
}
export interface ShopifyProduct {
  id: number | string
  title: string
  handle: string
  body_html: string | null
  vendor: string | null
  product_type: string | null
  tags: string[] | string | null
  images: ShopifyImage[] | null
  variants: ShopifyVariant[] | null
  options?: { name: string; position: number; values: string[] }[]
}

export interface FetchShopifyOptions {
  /** Cap the number of products returned. Default no limit (paginates until empty). */
  limit?: number | null
  /** Per-page batch size (default 250 — Shopify max). */
  perPage?: number
  /** Inject for tests. */
  fetch?: (url: string) => Promise<string>
  /** Hard cap on pages walked (safety, default 50 pages × 250 = 12_500 products). */
  maxPages?: number
}

export function baseOriginOf(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return url
  }
}

/**
 * Convert a single Shopify product (from `/products.json`) into a v7 Row.
 * Tags come back as either a comma-joined string or an array depending on
 * the Shopify version; both forms supported.
 */
export function shopifyProductToRow(p: ShopifyProduct, baseOrigin: string): Row {
  const link = `${baseOrigin}/products/${p.handle}`
  const images = Array.isArray(p.images) ? p.images.map((i) => i.src).filter(Boolean) : []
  const variants = Array.isArray(p.variants) ? p.variants : []
  const firstVariant = variants[0]
  const price = firstVariant ? toFiniteFloat(firstVariant.price) : null
  const oldPrice = firstVariant ? toFiniteFloat(firstVariant.compare_at_price) : null
  const variantTitles = variants
    .map((v) => v.title)
    .filter((t): t is string => typeof t === 'string' && t.length > 0 && t !== 'Default Title')
  const tags = Array.isArray(p.tags)
    ? p.tags
    : typeof p.tags === 'string'
      ? p.tags.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
      : null

  return {
    Title: p.title || null,
    ImageUrls: images,
    Description: p.body_html || null,
    Price: price,
    OldPrice: oldPrice,
    Spin: variantTitles.length > 0 ? variantTitles : null,
    Link: link,
    ImageUrlType: 'ONLINE',
    tags: tags && tags.length > 0 ? tags : null,
    short_description: null,
    seo_description: null,
  }
}

/**
 * Fetch products via `/products.json` with pagination. Returns Row[].
 * Stops on: limit reached, empty response, or maxPages cap.
 */
export async function fetchShopifyProductsJson(
  url: string,
  opts: FetchShopifyOptions = {},
): Promise<Row[]> {
  const fetchFn = opts.fetch ?? httpFetchHtml
  const origin = baseOriginOf(url)
  const perPage = Math.min(opts.perPage ?? 250, 250)
  const hardLimit = opts.limit ?? Infinity
  const maxPages = opts.maxPages ?? 50
  const rows: Row[] = []
  let page = 1
  while (rows.length < hardLimit && page <= maxPages) {
    const apiUrl = `${origin}/products.json?limit=${perPage}&page=${page}`
    let body: string
    try {
      body = await fetchFn(apiUrl)
    } catch {
      break
    }
    let parsed: { products?: ShopifyProduct[] } | null = null
    try {
      parsed = JSON.parse(body) as { products?: ShopifyProduct[] }
    } catch {
      break
    }
    const products = parsed?.products ?? []
    if (products.length === 0) break
    for (const p of products) {
      rows.push(shopifyProductToRow(p, origin))
      if (rows.length >= hardLimit) break
    }
    if (rows.length >= hardLimit) break
    if (products.length < perPage) break // last page
    page += 1
  }
  return rows
}

function toFiniteFloat(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}
