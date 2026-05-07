/**
 * Detail crawler — fetch product detail pages in parallel and convert
 * each HTML response into a `Row` (Lonspy data shape).
 *
 * Concurrency capped via p-limit (Q2: safe-mode 5 default).
 * Failures are collected, not rethrown — orchestrator surfaces them as
 * warnings so a single dead product doesn't kill a 1000-product crawl.
 *
 * Iron Rule 5: errors stay in `failed_urls` array; orchestrator wraps them
 * in safeMessage before any seller-facing surface.
 */
import pLimit from 'p-limit'
import { httpFetchHtml } from './http-fetch.js'
import { extractValue, extractValues, applyReplaces } from './xpath-engine.js'
import type { Config, Row, Element } from './types.js'

export interface CrawlDetailsResult {
  rows: Row[]
  failed_urls: string[]
}

export interface CrawlDetailsOptions {
  concurrency?: number
  fetch?: (url: string) => Promise<string>
  /** Skip the inter-request delay during tests. */
  skipDelay?: boolean
}

export async function crawlDetails(
  productUrls: string[],
  config: Config,
  opts: CrawlDetailsOptions = {},
): Promise<CrawlDetailsResult> {
  if (productUrls.length === 0) return { rows: [], failed_urls: [] }
  const fetchFn = opts.fetch ?? httpFetchHtml
  const limit = pLimit(opts.concurrency ?? 5)
  const failed: string[] = []
  const settled = await Promise.all(
    productUrls.map((url) =>
      limit(async (): Promise<Row | null> => {
        try {
          if (!opts.skipDelay && config.delay > 0) {
            await new Promise((r) => setTimeout(r, config.delay))
          }
          const html = await fetchFn(url)
          return extractRowFromDetail(html, url, config)
        } catch {
          failed.push(url)
          return null
        }
      }),
    ),
  )
  const rows = settled.filter((r): r is Row => r !== null)
  return { rows, failed_urls: failed }
}

/**
 * Pure extraction — convert one detail-page HTML into a `Row`.
 * Exported separately for unit tests + reuse from orchestrator.
 */
export function extractRowFromDetail(html: string, url: string, cfg: Config): Row {
  const els = cfg.item.elements
  const titleEl = byName(els, 'Title')
  const priceEl = byName(els, 'Price')
  const oldPriceEl = byName(els, 'OldPrice')
  const descEl = byName(els, 'Description')
  const variantsEl = byName(els, 'Variants')
  const galleryEl = cfg.item.images_in_detail ?? null

  const title = pullText(html, titleEl)
  const description = pullText(html, descEl)
  const price = parseMaybeFloat(pullText(html, priceEl))
  const oldPrice = parseMaybeFloat(pullText(html, oldPriceEl))
  const galleryImages = galleryEl ? pullValues(html, galleryEl) : []
  const variants = variantsEl ? pullValues(html, variantsEl) : []

  return {
    Title: title || null,
    ImageUrls: galleryImages,
    Description: description || null,
    Price: price,
    OldPrice: oldPrice,
    Spin: variants.length > 0 ? variants : null,
    Link: url,
    ImageUrlType: 'ONLINE',
    tags: null,
    short_description: null,
    seo_description: null,
  }
}

function byName(els: Element[], name: string): Element | undefined {
  return els.find((e) => e.name === name)
}

function pullText(html: string, el: Element | undefined): string {
  if (!el) return ''
  const raw = extractValue(html, el.xpath, el.attr)
  const trimmed = raw.trim()
  return applyReplaces(trimmed, el.replaces).trim()
}

function pullValues(html: string, el: Element): string[] {
  const raw = extractValues(html, el.xpath, el.attr ?? null)
  return raw
    .map((v) => applyReplaces(v.trim(), el.replaces).trim())
    .filter((v) => v.length > 0)
}

function parseMaybeFloat(s: string): number | null {
  if (!s) return null
  const cleaned = s.replace(/[^\d.,-]/g, '').replace(/,/g, '')
  if (!cleaned) return null
  const n = Number.parseFloat(cleaned)
  return Number.isFinite(n) ? n : null
}
