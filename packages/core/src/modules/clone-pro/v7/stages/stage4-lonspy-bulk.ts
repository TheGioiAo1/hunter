/**
 * Clone Pro v7 — Stage 4: Lonspy bulk crawl.
 *
 * Sprint 2 Task 2.4. Replaces v6 Stage 4 (AI Sonnet bucket scrapers,
 * which can't extract Hydrogen 2.0 products without JSON-LD) with the
 * Lonspy XPath bulk extractor (battle-tested across 22 platform configs).
 *
 * Pipeline:
 *   1. Call `crawlSite(sourceUrl, { products_limit, concurrency: 5 })`.
 *   2. Persist `clone_crawl_runs` audit row (platform / config_used /
 *      rows_harvested / rows_failed / quality_score / duration_ms).
 *   3. Quality gate: if `qualityScore < 0.95` throw
 *      `QualityBelowThresholdError`. The audit row is persisted FIRST
 *      so god-admin can see what happened even on failure.
 *   4. Map `Row[]` → v6 `ProductDTO[]` via `dto-mapper.rowToProductDto`.
 *   5. Map `CollectionSummary[]` → `CollectionDTO[]`.
 *   6. Return DTOs to the orchestrator for Stage 5 (asset graph build).
 *
 * Iron Rule 5: pure module. No HTTP/DB writes outside the injected
 * `db` Kysely. The crawler injection (`crawl`) makes the whole module
 * unit-testable without network. Errors throw native; the orchestrator
 * pipes them through `safeMessage()` at the seller-facing boundary.
 */

import type { Kysely } from 'kysely'
import type { CrawlResult, Row } from '../../v7-crawler/types.js'
import type { ProductDTO, CollectionDTO, PageDTO } from '../../v6/scrapers/types.js'
import {
  rowToProductDto,
  collectionFromHandle,
  isProductRowComplete,
} from '../dto-mapper.js'

// Lazy import of the real crawler — keeps the test suite from pulling
// in `got` / `p-retry` / `playwright` (heavy + native deps not needed
// for unit tests; the prod deps factory wires the real crawler).
type CrawlFn = (
  url: string,
  opts: { products_limit: number | null; concurrency: number },
) => Promise<CrawlResult>

async function loadDefaultCrawler(): Promise<CrawlFn> {
  const mod = await import('../../v7-crawler/orchestrator.js')
  return mod.crawlSite as CrawlFn
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const QUALITY_GATE_THRESHOLD = 0.95
export const DEFAULT_CONCURRENCY = 5 // Q2 safe mode

export class QualityBelowThresholdError extends Error {
  readonly score: number
  readonly threshold: number
  constructor(score: number, threshold: number) {
    super(
      `Stage 4 quality gate failed: ${score.toFixed(2)} < ${threshold.toFixed(2)}`,
    )
    this.name = 'QualityBelowThresholdError'
    this.score = score
    this.threshold = threshold
  }
}

export interface RunStage4Input {
  jobId: string
  sourceUrl: string
  productsLimit: number | null
  db: Kysely<any>
  /**
   * Optional crawler injection — defaults to `crawlSite` from the
   * v7-crawler module. Tests pass a stub.
   */
  crawl?: (
    url: string,
    opts: { products_limit: number | null; concurrency: number },
  ) => Promise<CrawlResult>
}

export interface RunStage4Result {
  products: ProductDTO[]
  collections: CollectionDTO[]
  pages: PageDTO[]
  warnings: string[]
  qualityScore: number
  rowsHarvested: number
  rowsFailed: number
}

// ---------------------------------------------------------------------------
// Stage 4 entry point
// ---------------------------------------------------------------------------

export async function runStage4LonspyBulk(
  input: RunStage4Input,
): Promise<RunStage4Result> {
  const startedAt = Date.now()
  const crawl = input.crawl ?? (await loadDefaultCrawler())

  const result = await crawl(input.sourceUrl, {
    products_limit: input.productsLimit,
    concurrency: DEFAULT_CONCURRENCY,
  })
  const durationMs = Date.now() - startedAt

  const rowsHarvested = result.products.length
  const completeRows = result.products.filter(isProductRowComplete).length
  const rowsFailed = rowsHarvested - completeRows

  // Quality is fraction of complete rows. 0/0 → 0 (force fail) so an empty
  // crawl always trips the gate; we don't want to publish an empty store.
  const qualityScore = rowsHarvested > 0 ? completeRows / rowsHarvested : 0

  // Persist audit row FIRST so god-admin can see the run even if the
  // gate throws. Wrap in try/catch so a DB hiccup never masks the
  // upstream error.
  try {
    await input.db
      .insertInto('clone_crawl_runs')
      .values({
        job_id: input.jobId,
        platform: result.platform,
        config_used: result.config_used,
        rows_harvested: rowsHarvested,
        rows_failed: rowsFailed,
        quality_score: qualityScore.toFixed(2),
        duration_ms: durationMs,
      })
      .execute()
  } catch (err) {
    // Log to worker logs only (Iron Rule 5 — never seller-visible).
    // eslint-disable-next-line no-console
    console.warn(
      '[clone-pro-v7][stage4] failed to persist clone_crawl_runs row:',
      (err as Error).message,
    )
  }

  if (qualityScore < QUALITY_GATE_THRESHOLD) {
    throw new QualityBelowThresholdError(qualityScore, QUALITY_GATE_THRESHOLD)
  }

  // Map Row → ProductDTO. `rowToProductDto` returns null for unmappable
  // rows; filter those out (they were already counted as failed).
  const productDtos: ProductDTO[] = result.products
    .map(rowToProductDto)
    .filter((d): d is ProductDTO => d != null)

  // Map CollectionSummary → CollectionDTO.
  const collectionDtos: CollectionDTO[] = result.collections.map((c) =>
    collectionFromHandle({
      handle: c.handle,
      title: c.title,
      productHandles: c.product_handles,
      // The crawler doesn't always emit a sourceUrl; build one from
      // the source_url + handle when missing.
      sourceUrl: buildCollectionUrl(result.source_url, c.handle),
    }),
  )

  // Sprint 2 doesn't ship page crawl yet — pages stay empty.
  const pageDtos: PageDTO[] = result.pages.map((p) => ({
    sourceHandle: p.handle,
    sourceUrl: '',
    title: p.title,
    bodyHtml: p.body_html,
    isPolicy: false,
    seo: { title: null, description: null },
  }))

  return {
    products: productDtos,
    collections: collectionDtos,
    pages: pageDtos,
    warnings: result.warnings,
    qualityScore,
    rowsHarvested,
    rowsFailed,
  }
}

function buildCollectionUrl(sourceUrl: string, handle: string): string {
  try {
    const u = new URL(sourceUrl)
    return `${u.origin}/collections/${handle}`
  } catch {
    return `https://${handle}`
  }
}

// Re-export Row type so callers consuming this module can also import
// the source-of-truth Row shape without reaching into v7-crawler.
export type { Row }
