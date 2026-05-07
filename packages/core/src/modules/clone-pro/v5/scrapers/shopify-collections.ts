/**
 * Clone Pro v5 — Shopify collections scraper
 *
 * Lists collections via /collections.json, then for each collection
 * paginates /collections/<handle>/products.json to extract product handles.
 * Filters out empty collections (R3 anti-mix guardrail).
 *
 * Fail-tolerance: a single broken collection (HTTP 5xx, 404, JSON parse
 * error) must NOT nuke the whole pipeline. Real storefronts (e.g.
 * allbirds.com's legacy `bogo15-collection-q3-2023`) return 502 on
 * specific collections while the rest of the catalog is fine. We retry
 * once with 1s backoff on 5xx, then fall back to an empty handle list
 * (which the R3 filter drops). Warnings surface via `opts.onWarn`; the
 * caller can plumb them to `GradeResult.warnings` for seller visibility.
 */

import type { ScrapedCollection, ScrapedImage } from '../types.js'

export interface ScrapeCollectionsOpts {
  readonly fetch?: typeof globalThis.fetch
  readonly pageSize?: number
  readonly maxPages?: number
  /** Called once per collection we had to skip (5xx/4xx/parse error). */
  readonly onWarn?: (msg: string) => void
  /** Retry delay for 5xx in ms (default 1000). Exposed for tests. */
  readonly retryDelayMs?: number
}

interface RawCollection {
  id: number
  handle: string
  title: string
  body_html: string | null
  image: { src: string; alt: string | null; position: number } | null
}

export async function scrapeShopifyCollections(
  sourceUrl: string,
  opts: ScrapeCollectionsOpts = {},
): Promise<ScrapedCollection[]> {
  const fetchFn = opts.fetch ?? globalThis.fetch
  const pageSize = opts.pageSize ?? 250
  const maxPages = opts.maxPages ?? 20
  const onWarn = opts.onWarn ?? ((m: string) => console.warn(`[clone-pro-v5] ${m}`))
  const retryDelayMs = opts.retryDelayMs ?? 1000
  const rawCollections: RawCollection[] = []

  // Phase A: list collections. We still fail-fast here — if the
  // /collections.json listing itself is broken we have no catalog to
  // walk, so there's no point continuing.
  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(`/collections.json?limit=${pageSize}&page=${page}`, sourceUrl).toString()
    const res = await fetchFn(url)
    if (!res.ok) throw new Error(`scrapeShopifyCollections: HTTP ${res.status} at page ${page}`)
    const body = (await res.json()) as { collections: RawCollection[] }
    if (!Array.isArray(body.collections) || body.collections.length === 0) break
    rawCollections.push(...body.collections)
  }

  // Phase B: per collection, fetch products (handles only). Fail-tolerant
  // per collection — one broken collection does NOT nuke the pipeline.
  const out: ScrapedCollection[] = []
  for (const c of rawCollections) {
    const handles = await fetchCollectionProductHandlesSafe(
      sourceUrl, c.handle, fetchFn, pageSize, maxPages, onWarn, retryDelayMs,
    )
    if (handles.length === 0) continue   // R3: skip empty (or skipped-on-error)
    out.push({
      source_id: String(c.id),
      handle: c.handle,
      title: c.title,
      body_html: c.body_html ?? '',
      image: c.image ? mapImage(c.image) : null,
      product_handles: handles,
    })
  }
  return out
}

/**
 * Fail-tolerant wrapper around `fetchCollectionProductHandles`. On any
 * error (HTTP non-ok, fetch throw, JSON parse fail) it emits a warning
 * and returns `[]` so the collection is dropped by the R3 filter
 * upstream instead of killing the whole pipeline.
 *
 * 5xx is retried once after `retryDelayMs` to handle transient origin
 * blips. 4xx (including 404 "collection deleted") is NOT retried — it's
 * a permanent client-side signal.
 */
async function fetchCollectionProductHandlesSafe(
  sourceUrl: string,
  handle: string,
  fetchFn: typeof globalThis.fetch,
  pageSize: number,
  maxPages: number,
  onWarn: (m: string) => void,
  retryDelayMs: number,
): Promise<string[]> {
  try {
    return await fetchCollectionProductHandles(sourceUrl, handle, fetchFn, pageSize, maxPages)
  } catch (err) {
    const msg = (err as Error).message
    const is5xx = /HTTP 5\d\d/.test(msg)
    if (!is5xx) {
      onWarn(`Skipped collection "${handle}": ${msg}`)
      return []
    }
    // 5xx: one retry with backoff, then skip.
    await sleep(retryDelayMs)
    try {
      return await fetchCollectionProductHandles(sourceUrl, handle, fetchFn, pageSize, maxPages)
    } catch (retryErr) {
      onWarn(`Skipped collection "${handle}" after retry: ${(retryErr as Error).message}`)
      return []
    }
  }
}

async function fetchCollectionProductHandles(
  sourceUrl: string,
  handle: string,
  fetchFn: typeof globalThis.fetch,
  pageSize: number,
  maxPages: number,
): Promise<string[]> {
  const out: string[] = []
  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(
      `/collections/${handle}/products.json?limit=${pageSize}&page=${page}`,
      sourceUrl,
    ).toString()
    const res = await fetchFn(url)
    if (!res.ok) throw new Error(`fetchCollectionProductHandles(${handle}): HTTP ${res.status}`)
    const body = (await res.json()) as { products: Array<{ handle: string }> }
    if (!Array.isArray(body.products) || body.products.length === 0) break
    out.push(...body.products.map((p) => p.handle))
  }
  return out
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function mapImage(raw: { src: string; alt: string | null; position: number }): ScrapedImage {
  return { src: raw.src, alt: raw.alt, position: raw.position }
}
