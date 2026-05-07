/**
 * Clone Pro — Universal Website Crawler
 *
 * Crawls ANY website (not just Shopify) and extracts structure,
 * content, and products. Uses platform-specific crawlers when
 * a known platform is detected, falls back to generic HTML parsing.
 *
 * Architecture:
 *   detectPlatform() → pick crawler strategy → crawl → normalize
 *
 * Crawl strategies:
 *   - Shopify:     /products.json API + /sitemap.xml
 *   - WooCommerce: /wp-json/wc/v3/ API (if public) + sitemap
 *   - Generic:     HTML scraping + sitemap.xml + link following
 */

import { safeFetch, type SafeFetchOptions } from '../clone-shopify/safe-fetch.js'
import { crawlShopifyProducts, type CloneProductDTO } from '../clone-shopify/index.js'
import { walkSitemap, type CloneSitemapNode } from '../clone-shopify/index.js'
import { detectPlatform } from './platform-detector.js'
import type {
  DetectedPlatform,
  CrawledPage,
  CrawledNavigation,
  NavigationItem,
  CrawledCollection,
  CloneProConfig,
} from './types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CrawlResult {
  readonly platform: DetectedPlatform
  readonly platformConfidence: number
  readonly homepage: CrawledPage
  readonly pages: readonly CrawledPage[]
  readonly products: readonly CloneProductDTO[]
  readonly collections: readonly CrawledCollection[]
  readonly navigation: CrawledNavigation
  readonly sitemap: readonly CloneSitemapNode[]
  readonly errors: readonly CrawlError[]
}

export interface CrawlError {
  readonly url: string
  readonly stage: string
  readonly message: string
}

export interface CrawlProgress {
  readonly stage: string
  readonly current: number
  readonly total: number
  readonly message: string
}

// ---------------------------------------------------------------------------
// Main Crawler
// ---------------------------------------------------------------------------

/**
 * Crawl a website and extract everything needed for cloning.
 * Automatically detects the platform and uses the best strategy.
 */
export async function crawlWebsite(
  config: CloneProConfig,
  onProgress?: (progress: CrawlProgress) => void,
): Promise<CrawlResult> {
  const errors: CrawlError[] = []
  const maxPages = config.maxPages ?? 50
  const maxProducts = config.maxProducts ?? 2000

  // ── Step 1: Fetch homepage + detect platform ───────────────────
  onProgress?.({ stage: 'detect', current: 0, total: 1, message: 'Detecting platform...' })

  const detection = await detectPlatform(config.sourceUrl)
  const homepage = await fetchPage(config.sourceUrl, 'home')

  onProgress?.({ stage: 'detect', current: 1, total: 1, message: `Detected: ${detection.platform} (${detection.confidence}%)` })

  // ── Step 2: Crawl sitemap ──────────────────────────────────────
  let sitemap: CloneSitemapNode[] = []
  if (config.scope.navigation || config.scope.pages) {
    onProgress?.({ stage: 'sitemap', current: 0, total: 1, message: 'Crawling sitemap...' })
    try {
      const nodes = await walkSitemap(config.sourceUrl, { maxNodes: maxPages })
      sitemap = [...nodes]
    } catch (err: any) {
      errors.push({ url: config.sourceUrl + '/sitemap.xml', stage: 'sitemap', message: err.message })
    }
    onProgress?.({ stage: 'sitemap', current: 1, total: 1, message: `Found ${sitemap.length} URLs in sitemap` })
  }

  // ── Step 3: Crawl products ─────────────────────────────────────
  let products: CloneProductDTO[] = []
  if (config.scope.products) {
    onProgress?.({ stage: 'products', current: 0, total: 1, message: 'Crawling products...' })
    try {
      products = await crawlProductsByPlatform(
        config.sourceUrl,
        detection.platform,
        maxProducts,
      )
    } catch (err: any) {
      errors.push({ url: config.sourceUrl, stage: 'products', message: err.message })
    }
    onProgress?.({ stage: 'products', current: 1, total: 1, message: `Found ${products.length} products` })
  }

  // ── Step 4: Crawl collections ──────────────────────────────────
  let collections: CrawledCollection[] = []
  if (config.scope.collections) {
    onProgress?.({ stage: 'collections', current: 0, total: 1, message: 'Crawling collections...' })
    try {
      collections = await crawlCollections(config.sourceUrl, detection.platform)
    } catch (err: any) {
      errors.push({ url: config.sourceUrl, stage: 'collections', message: err.message })
    }
    onProgress?.({ stage: 'collections', current: 1, total: 1, message: `Found ${collections.length} collections` })
  }

  // ── Step 5: Extract navigation ─────────────────────────────────
  let navigation: CrawledNavigation = { items: [] }
  if (config.scope.navigation) {
    onProgress?.({ stage: 'navigation', current: 0, total: 1, message: 'Extracting navigation...' })
    navigation = extractNavigation(homepage.html)
    onProgress?.({ stage: 'navigation', current: 1, total: 1, message: `Found ${navigation.items.length} nav items` })
  }

  // ── Step 6: Crawl additional pages ─────────────────────────────
  const pages: CrawledPage[] = [homepage]
  if (config.scope.pages) {
    const pageUrls = sitemap
      .filter(n => n.kind === 'page')
      .slice(0, maxPages)
      .map(n => n.url)

    onProgress?.({ stage: 'pages', current: 0, total: pageUrls.length, message: 'Crawling pages...' })

    for (let i = 0; i < pageUrls.length; i++) {
      try {
        const page = await fetchPage(pageUrls[i], 'page')
        pages.push(page)
      } catch (err: any) {
        errors.push({ url: pageUrls[i], stage: 'pages', message: err.message })
      }
      onProgress?.({ stage: 'pages', current: i + 1, total: pageUrls.length, message: `Crawled ${i + 1}/${pageUrls.length} pages` })
    }
  }

  return {
    platform: detection.platform,
    platformConfidence: detection.confidence,
    homepage,
    pages,
    products,
    collections,
    navigation,
    sitemap,
    errors,
  }
}

// ---------------------------------------------------------------------------
// Platform-Specific Product Crawlers
// ---------------------------------------------------------------------------

async function crawlProductsByPlatform(
  sourceUrl: string,
  platform: DetectedPlatform,
  maxProducts: number,
): Promise<CloneProductDTO[]> {
  switch (platform) {
    case 'shopify':
      return [...await crawlShopifyProducts(sourceUrl, { maxProducts })]

    case 'woocommerce':
      return crawlWooProducts(sourceUrl, maxProducts)

    default:
      // Generic: try Shopify API first (many stores expose it),
      // then fall back to HTML scraping
      try {
        const products = [...await crawlShopifyProducts(sourceUrl, { maxProducts })]
        if (products.length > 0) return products
      } catch { /* fall through */ }

      return crawlGenericProducts(sourceUrl, maxProducts)
  }
}

/**
 * WooCommerce product crawler — tries the REST API first,
 * falls back to HTML parsing.
 */
async function crawlWooProducts(
  sourceUrl: string,
  maxProducts: number,
): Promise<CloneProductDTO[]> {
  const products: CloneProductDTO[] = []

  // Try WooCommerce REST API (public endpoints)
  try {
    let page = 1
    const perPage = 100

    while (products.length < maxProducts) {
      const apiUrl = `${sourceUrl.replace(/\/$/, '')}/wp-json/wc/store/v1/products?page=${page}&per_page=${perPage}`
      const resp = await safeFetch(apiUrl, { maxBytes: 5 * 1024 * 1024, timeoutMs: 15000 })

      if (resp.statusCode !== 200) break

      const items = JSON.parse(resp.body.toString('utf-8'))
      if (!Array.isArray(items) || items.length === 0) break

      for (const item of items) {
        if (products.length >= maxProducts) break
        products.push(wooProductToDTO(item))
      }

      if (items.length < perPage) break
      page++
    }
  } catch {
    // API not available — could try HTML parsing in the future
  }

  return products
}

function wooProductToDTO(item: any): CloneProductDTO {
  return {
    sourceProductId: String(item.id ?? ''),
    handle: item.slug ?? '',
    title: item.name ?? '',
    descriptionHtml: item.description ?? '',
    vendor: '',
    productType: item.type ?? null,
    tags: [],
    images: (item.images ?? []).map((img: any) => ({
      sourceUrl: img.src ?? '',
      altText: img.alt ?? null,
      width: null,
      height: null,
    })),
    variants: (item.variations ?? [{ id: item.id, price: item.price }]).map((v: any) => ({
      sourceVariantId: String(v.id ?? ''),
      sku: v.sku ?? null,
      title: v.name ?? 'Default',
      price: String(v.price ?? '0'),
      compareAtPrice: v.regular_price !== v.price ? String(v.regular_price ?? '') : null,
      optionValues: [],
      available: true,
    })),
  }
}

/**
 * Generic product crawler — extracts product-like data from
 * structured data (JSON-LD) in the HTML.
 */
async function crawlGenericProducts(
  sourceUrl: string,
  maxProducts: number,
): Promise<CloneProductDTO[]> {
  const products: CloneProductDTO[] = []

  try {
    const resp = await safeFetch(sourceUrl, { maxBytes: 2 * 1024 * 1024, timeoutMs: 15000 })
    const jsonLdProducts = extractJsonLd(resp.body.toString('utf-8'), 'Product')

    for (const item of jsonLdProducts) {
      if (products.length >= maxProducts) break
      products.push({
        sourceProductId: item['@id'] ?? item.sku ?? String(products.length),
        handle: slugify(item.name ?? ''),
        title: item.name ?? '',
        descriptionHtml: item.description ?? '',
        vendor: item.brand?.name ?? null,
        productType: item.category ?? null,
        tags: [],
        images: (item.image ? [item.image].flat() : []).map((img: any) => ({
          sourceUrl: typeof img === 'string' ? img : img.url ?? '',
          altText: null,
          width: null,
          height: null,
        })),
        variants: [{
          sourceVariantId: item.sku ?? '0',
          sku: item.sku ?? null,
          title: 'Default',
          price: item.offers?.price ?? '0',
          compareAtPrice: null,
          optionValues: [],
          available: item.offers?.availability?.includes('InStock') ?? true,
        }],
      })
    }
  } catch { /* empty */ }

  return products
}

// ---------------------------------------------------------------------------
// Collection Crawler
// ---------------------------------------------------------------------------

async function crawlCollections(
  sourceUrl: string,
  platform: DetectedPlatform,
): Promise<CrawledCollection[]> {
  if (platform === 'shopify') {
    return crawlShopifyCollections(sourceUrl)
  }
  // Other platforms: extract from HTML/sitemap in future
  return []
}

async function crawlShopifyCollections(sourceUrl: string): Promise<CrawledCollection[]> {
  const collections: CrawledCollection[] = []
  try {
    const url = `${sourceUrl.replace(/\/$/, '')}/collections.json`
    const resp = await safeFetch(url, { maxBytes: 2 * 1024 * 1024, timeoutMs: 15000 })
    if (resp.statusCode !== 200) return []

    const data = JSON.parse(resp.body.toString('utf-8'))
    for (const c of data.collections ?? []) {
      collections.push({
        handle: c.handle ?? '',
        title: c.title ?? '',
        description: c.body_html ?? '',
        imageUrl: c.image?.src ?? null,
        productCount: c.products_count ?? 0,
      })
    }
  } catch { /* empty */ }
  return collections
}

// ---------------------------------------------------------------------------
// Navigation Extractor (from HTML)
// ---------------------------------------------------------------------------

function extractNavigation(html: string): CrawledNavigation {
  const items: NavigationItem[] = []

  // Extract nav links from <nav> elements
  const navMatch = html.match(/<nav[^>]*>([\s\S]*?)<\/nav>/i)
  if (!navMatch) return { items }

  const navHtml = navMatch[1]
  const linkRegex = /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
  let match

  while ((match = linkRegex.exec(navHtml)) !== null) {
    const href = match[1]
    const label = match[2].replace(/<[^>]+>/g, '').trim()
    if (label && href && !href.startsWith('#') && !href.startsWith('javascript:')) {
      items.push({ label, url: href, children: [] })
    }
  }

  return { items }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchPage(url: string, type: CrawledPage['type']): Promise<CrawledPage> {
  const resp = await safeFetch(url, { maxBytes: 5 * 1024 * 1024, timeoutMs: 20000 })
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(resp.headers)) {
    if (v) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v
  }
  const html = resp.body.toString('utf-8')

  return {
    url,
    title: extractTitle(html),
    type,
    html,
    statusCode: resp.statusCode,
    headers,
    crawledAt: new Date().toISOString(),
  }
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return m ? m[1].trim() : ''
}

function extractJsonLd(html: string, type: string): any[] {
  const results: any[] = []
  const regex = /<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi
  let match

  while ((match = regex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1])
      if (Array.isArray(data)) {
        results.push(...data.filter((d: any) => d['@type'] === type))
      } else if (data['@type'] === type) {
        results.push(data)
      } else if (data['@graph']) {
        results.push(...data['@graph'].filter((d: any) => d['@type'] === type))
      }
    } catch { /* skip invalid JSON-LD */ }
  }

  return results
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 100)
}
