/**
 * Clone Pro v5 — Shopify products scraper (phase ③ — scrape)
 *
 * Paginates /products.json?limit=N&page=P until empty page (or maxPages cap).
 * Maps raw Shopify payload → ScrapedProduct DTO.
 * Decimal prices preserved as strings (no float coercion).
 */

import type { ScrapedProduct, ScrapedVariant, ScrapedOption, ScrapedImage } from '../types.js'

export interface ScrapeOpts {
  readonly fetch?: typeof globalThis.fetch
  readonly pageSize?: number
  readonly maxPages?: number
}

interface RawShopifyProduct {
  id: number
  handle: string
  title: string
  body_html: string
  vendor: string | null
  product_type: string | null
  // Shopify's /products.json emits `tags` as EITHER:
  //   - a comma-separated string (classic storefront API), OR
  //   - an array of strings (newer storefronts, including allbirds.com)
  // `normaliseTags()` below handles both shapes defensively.
  tags: string | string[]
  images: Array<{ src: string; alt: string | null; position: number }>
  variants: Array<{
    id: number; title: string; price: string; compare_at_price: string | null
    sku: string | null; inventory_quantity: number | null
    option1: string | null; option2: string | null; option3: string | null
    weight: number | null; weight_unit: string | null
  }>
  options: Array<{ name: string; position: number; values: string[] }>
}

/**
 * Handle both Shopify tag shapes (string and string[]). Empty / null /
 * undefined all collapse to []. Trims + strips empties so downstream
 * persisters get a clean string[].
 */
function normaliseTags(raw: string | string[] | null | undefined): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean)
  return String(raw).split(',').map((t) => t.trim()).filter(Boolean)
}

export async function scrapeShopifyProducts(
  sourceUrl: string,
  opts: ScrapeOpts = {},
): Promise<ScrapedProduct[]> {
  const fetchFn = opts.fetch ?? globalThis.fetch
  const pageSize = opts.pageSize ?? 250
  const maxPages = opts.maxPages ?? 100   // hard cap: 25k products per scrape
  const out: ScrapedProduct[] = []

  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(`/products.json?limit=${pageSize}&page=${page}`, sourceUrl).toString()
    const res = await fetchFn(url, {
      headers: { 'user-agent': 'GboxCloneBot/1.0 (+https://gbox.co/bot)' },
    })
    if (!res.ok) {
      throw new Error(`scrapeShopifyProducts: HTTP ${res.status} at page ${page}`)
    }
    const body = (await res.json()) as { products: RawShopifyProduct[] }
    if (!Array.isArray(body.products) || body.products.length === 0) break

    for (const raw of body.products) {
      out.push(mapProduct(raw))
    }
  }

  return out
}

function mapProduct(raw: RawShopifyProduct): ScrapedProduct {
  const optionNames = (raw.options ?? []).map((o) => o.name)
  return {
    source_id: String(raw.id),
    handle: raw.handle,
    title: raw.title,
    body_html: raw.body_html ?? '',
    vendor: raw.vendor,
    product_type: raw.product_type,
    tags: normaliseTags(raw.tags),
    images: (raw.images ?? []).map(mapImage),
    variants: (raw.variants ?? []).map((v) => mapVariant(v, optionNames)),
    options: (raw.options ?? []).map(mapOption),
  }
}

function mapImage(raw: RawShopifyProduct['images'][number]): ScrapedImage {
  return { src: raw.src, alt: raw.alt ?? null, position: raw.position }
}

function mapVariant(raw: RawShopifyProduct['variants'][number], optionNames: string[]): ScrapedVariant {
  const option_values = [raw.option1, raw.option2, raw.option3]
    .filter((v, i) => v !== null && i < optionNames.length) as string[]
  return {
    source_id: String(raw.id),
    title: raw.title,
    price: raw.price,                       // keep decimal as string
    compare_at_price: raw.compare_at_price,
    sku: raw.sku,
    inventory_quantity: raw.inventory_quantity,
    option_values,
    weight: raw.weight,
    weight_unit: (raw.weight_unit as any) ?? null,
  }
}

function mapOption(raw: RawShopifyProduct['options'][number]): ScrapedOption {
  return { name: raw.name, position: raw.position, values: raw.values }
}
