/**
 * Clone Pro v4 — Three-Phase Pipeline Orchestrator
 *
 * Replaces the v3 10-stage linear pipeline with a 3-phase approach:
 *   Phase 1: Discovery — deep crawl, site map, template detection, asset inventory
 *   Phase 2: Execution — download assets, scrape→templatize, import data (TODO)
 *   Phase 3: Verification — route check, asset check, CSS match score (TODO)
 *
 * Key architectural change: instead of generating templates from design tokens,
 * v4 SCRAPES a sample page for each page type and converts it to a Liquid
 * template that preserves the original CSS classes. This ensures the downloaded
 * CSS applies correctly to every page — achieving true 1:1 visual fidelity.
 *
 * @module clone-pro/pipeline-v4
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { detectPlatform } from './platform-detector.js'
import type { CloneProConfig } from './types.js'

// Phase 1: Discovery
import {
  deepCrawl,
  buildSiteMap,
  printSiteMap,
  detectTemplates,
  scanAssets,
  printAssetInventory,
  generateDiscoveryReport,
  type DiscoveredPage,
  type SiteMap,
  type TemplateDetectionResult,
  type AssetInventory,
  type DiscoveryReport,
  type CrawlEvent,
} from './discovery/index.js'

// Phase 2: Execution
import { runExecution as runExecutionOrchestrator, type ExecutionResult } from './execution-v4.js'

// Phase 3: Verification
import { runVerification as runVerificationOrchestrator } from './verification/index.js'
import type { VerificationReport } from './verification/index.js'

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/** Phase identifiers for the v4 pipeline */
export type CloneV4Phase = 'discovery' | 'execution' | 'verification'

/** Status of a pipeline phase */
export type PhaseStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'awaiting_confirmation'

/** Callbacks for streaming progress updates to the UI */
export interface CloneV4Callbacks {
  /** Called when a phase starts, progresses, or completes */
  onPhaseUpdate?: (phase: CloneV4Phase, status: PhaseStatus, message: string) => void
  /** Called with overall progress (0–100) */
  onProgress?: (pct: number, message: string) => void
  /** Called for each page discovered during crawl */
  onPageDiscovered?: (page: DiscoveredPage) => void
  /** Called with the discovery report — caller should present to user */
  onDiscoveryReport?: (report: DiscoveryReport) => void
  /** Called when an error occurs (non-fatal) */
  onError?: (phase: CloneV4Phase, error: Error) => void
}

/** Result of running Phase 1 (Discovery) */
export interface DiscoveryResult {
  readonly platform: { platform: string; confidence: number }
  readonly pages: readonly DiscoveredPage[]
  readonly siteMap: SiteMap
  readonly templates: TemplateDetectionResult
  readonly assets: AssetInventory
  readonly report: DiscoveryReport
  readonly durationMs: number
}

/** Full result of the v4 pipeline (all 3 phases) */
export interface CloneV4Result {
  readonly discovery: DiscoveryResult
  readonly execution?: ExecutionResult
  readonly verification?: VerificationReport
  readonly totalDurationMs: number
}

// Re-export ExecutionResult + VerificationReport so callers importing from
// pipeline-v4 can type them.
export type { ExecutionResult } from './execution-v4.js'
export type { VerificationReport } from './verification/index.js'

// ---------------------------------------------------------------------------
// Phase 1: Discovery
// ---------------------------------------------------------------------------

/**
 * Run Phase 1 (Discovery) — deep crawl the source site, build site map,
 * detect templates, scan assets, and generate a report.
 *
 * This phase is safe to run without side effects — it only reads the source
 * site and produces a report. No database writes, no file downloads.
 *
 * @param config  Clone configuration (sourceUrl required)
 * @param cb      Optional callbacks for progress streaming
 * @returns       Discovery result with site map, templates, assets, and report
 */
export async function runDiscovery(
  config: CloneProConfig,
  cb?: CloneV4Callbacks,
): Promise<DiscoveryResult> {
  const startTime = Date.now()
  cb?.onPhaseUpdate?.('discovery', 'running', 'Starting discovery...')
  cb?.onProgress?.(0, 'Detecting platform...')

  // ── Step 1.1: Platform Detection ────────────────────────────────
  const platform = await detectPlatform(config.sourceUrl)
  cb?.onProgress?.(5, `Detected: ${platform.platform} (${platform.confidence}%)`)

  // ── Step 1.2: Deep Crawl ────────────────────────────────────────
  cb?.onProgress?.(8, 'Deep crawling site...')
  const pages: DiscoveredPage[] = []
  const crawlErrors: Array<{ url: string; error: string }> = []

  const crawlOptions = {
    maxPages: config.maxPages ?? 500,
    maxDepth: 10,
    concurrency: 3,
    delayMs: 200,
    stripQueryParams: false,
  }

  for await (const event of deepCrawl(config.sourceUrl, crawlOptions)) {
    switch (event.type) {
      case 'page':
        pages.push(event.page)
        cb?.onPageDiscovered?.(event.page)
        break
      case 'progress': {
        const crawlPct = 8 + Math.round((event.crawled / Math.max(event.total, 1)) * 40)
        cb?.onProgress?.(Math.min(crawlPct, 48), `Crawled ${event.crawled}/${event.total} pages...`)
        break
      }
      case 'error':
        crawlErrors.push({ url: event.url, error: event.error })
        cb?.onError?.('discovery', new Error(`Crawl error: ${event.url} — ${event.error}`))
        break
    }
  }

  cb?.onProgress?.(50, `Crawl complete: ${pages.length} pages discovered`)

  // ── Step 1.3: Build Site Map ────────────────────────────────────
  cb?.onProgress?.(55, 'Building site map...')
  const siteMap = buildSiteMap(pages, config.sourceUrl)

  // Log the tree for debugging
  const treeText = printSiteMap(siteMap)
  cb?.onProgress?.(60, `Site map built: ${siteMap.totalPages} pages in tree`)

  // ── Step 1.4: Detect Templates ──────────────────────────────────
  cb?.onProgress?.(65, 'Detecting template types...')
  const templates = detectTemplates(pages)
  cb?.onProgress?.(75, `Found ${templates.totalTemplateTypes} template types`)

  // ── Step 1.5: Scan Assets ───────────────────────────────────────
  cb?.onProgress?.(78, 'Scanning assets...')
  const assets = scanAssets(pages, config.sourceUrl)

  const assetText = printAssetInventory(assets)
  cb?.onProgress?.(88, `Found ${assets.summary.totalAssets} assets`)

  // ── Step 1.6: Generate Report ───────────────────────────────────
  cb?.onProgress?.(92, 'Generating discovery report...')
  const durationMs = Date.now() - startTime
  const report = generateDiscoveryReport({
    platform,
    siteMap,
    templates,
    assets,
    crawlDurationMs: durationMs,
    sourceUrl: config.sourceUrl,
  })

  cb?.onProgress?.(100, 'Discovery complete!')
  cb?.onPhaseUpdate?.('discovery', 'succeeded', report.textReport)
  cb?.onDiscoveryReport?.(report)

  return {
    platform,
    pages,
    siteMap,
    templates,
    assets,
    report,
    durationMs,
  }
}

// ---------------------------------------------------------------------------
// Full Pipeline (All 3 Phases)
// ---------------------------------------------------------------------------

/**
 * Run the full Clone Pro v4 pipeline.
 *
 * Phase 1 (Discovery) runs first. After it completes, the caller should
 * present the report to the user and wait for confirmation before calling
 * Phase 2 (Execution).
 *
 * For now, only Phase 1 is implemented. Phase 2 and 3 will be added
 * incrementally.
 *
 * @param db      Database connection (needed for Phase 2+)
 * @param config  Clone configuration
 * @param cb      Optional callbacks
 */
export async function cloneWebsiteV4(
  db: Kysely<Database>,
  config: CloneProConfig,
  cb?: CloneV4Callbacks,
): Promise<CloneV4Result> {
  const totalStart = Date.now()

  // ── Phase 1: Discovery ──────────────────────────────────────────
  const discovery = await runDiscovery(config, cb)

  // After discovery, the pipeline pauses for user confirmation.
  // Phase 2 and 3 will be called separately after user confirms.
  cb?.onPhaseUpdate?.('discovery', 'awaiting_confirmation',
    'Discovery complete. Awaiting user confirmation to proceed with cloning.')

  return {
    discovery,
    totalDurationMs: Date.now() - totalStart,
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Execution (placeholder — to be implemented next)
// ---------------------------------------------------------------------------

/**
 * Run Phase 2 (Execution) — download assets, scrape→templatize, import data.
 * Requires a completed Phase 1 discovery result.
 *
 * Delegates to `execution-v4.ts` — this wrapper exists so the three phases
 * stay visible as top-level exports on `pipeline-v4.ts` for a tidy API
 * surface. When the orchestrator grows sub-step-level callbacks, they'll
 * flow through the same `CloneV4Callbacks` contract.
 *
 * @param db        Database connection
 * @param config    Clone configuration
 * @param discovery Phase 1 result
 * @param cb        Optional callbacks
 */
export async function runExecution(
  db: Kysely<Database>,
  config: CloneProConfig,
  discovery: DiscoveryResult,
  cb?: CloneV4Callbacks,
): Promise<ExecutionResult> {
  return runExecutionOrchestrator(db, config, discovery, cb)
}

// ---------------------------------------------------------------------------
// Phase 3: Verification (placeholder — to be implemented next)
// ---------------------------------------------------------------------------

/**
 * Run Phase 3 (Verification) — check routes, assets, content, CSS match,
 * and external dependencies. Requires completed Phase 1 + 2 results.
 *
 * Delegates to `verification/orchestrator.ts`. This wrapper exists so the
 * three phases stay as top-level exports on `pipeline-v4.ts` for a tidy
 * API surface.
 *
 * @param db         Database connection
 * @param config     Clone configuration
 * @param discovery  Phase 1 result
 * @param execution  Phase 2 result
 * @param cb         Optional callbacks
 */
export async function runVerification(
  db: Kysely<Database>,
  config: CloneProConfig,
  discovery: DiscoveryResult,
  execution: ExecutionResult,
  cb?: CloneV4Callbacks,
): Promise<VerificationReport> {
  cb?.onPhaseUpdate?.('verification', 'running', 'Starting verification...')
  const report = await runVerificationOrchestrator({
    db,
    shopId: config.shopId,
    sourceUrl: config.sourceUrl,
    discovery,
    execution,
    onProgress: (pct, msg) => cb?.onProgress?.(pct, msg),
  })
  cb?.onPhaseUpdate?.(
    'verification',
    report.passed ? 'succeeded' : 'failed',
    report.textReport,
  )
  return report
}
