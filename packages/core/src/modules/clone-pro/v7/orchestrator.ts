/**
 * Clone Pro v7 — Pipeline Orchestrator.
 *
 * Sprint 2 Task 2.6. The v7 orchestrator is the v6 pipeline with one
 * targeted substitution: Stage 4 swaps the AI Sonnet bucket scrapers
 * (which can't reliably extract Hydrogen 2.0 catalogues) for the Lonspy
 * XPath bulk crawler. Stages 1-3 + 5-12 stay byte-for-byte v6 so we
 * inherit the verification + grade + auto-publish + finalize logic
 * verbatim (DRY/YAGNI).
 *
 *   Stage 1  — sitemap discovery     (v6 discoverUrls)
 *   Stage 2  — URL classification    (v6 classifyUrls)
 *   Stage 3  — headless render       (v6 renderUrls)
 *   Stage 4  — Lonspy bulk crawl     ⭐ v7-only (replaces v6 Stage 4)
 *   Stage 5  — asset graph           (v6 buildAssetGraph)
 *   Stage 6  — download assets       (v6 downloadAssets)
 *   Stage 7  — persisters            (v6 runPersisters)
 *   Stage 8  — path rewriter + grep  (v6 applyRewriter + verifyNoLeaks)
 *   Stage 9  — verification          (v6 runVerification)
 *   Stage 10 — grade composite       (v6 computeGrade)
 *   Stage 11 — auto-publish          (v6 autoPublish)
 *   Stage 12 — finalize              (v6 finalize)
 *
 * Iron Rule 5: stage names + raw error details stay server-side. The
 * orchestrator never composes seller-facing strings; that's the worker's
 * job (which scrubs through `safeMessage` at the response boundary).
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { Classification } from '../v6/types.js'
import type {
  ProductDTO,
  CollectionDTO,
  PageDTO,
} from '../v6/scrapers/types.js'
import type { RunStage4Result } from './stages/stage4-lonspy-bulk.js'
import type { CloneProCostTracker } from './cost-budget.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunV7Input {
  jobId: string
  shopId: string
  sourceUrl: string
  /** null = full crawl (still capped by god-admin platform max). */
  productsLimit: number | null
  deps: V7Deps
}

export interface V7Deps {
  db: Kysely<Database>
  /**
   * Optional per-job AI cost tracker. Threaded into Stage 14 +
   * Stage 16 by the worker (not the orchestrator — those stages run
   * outside the 12-stage v6-cloned pipeline). When the tracker is
   * present, those stages call `tracker.assertWithinBudget(...)`
   * before each Anthropic call and `tracker.addClaude(...)` after.
   * The orchestrator persists `tracker.getSpentUsd()` into
   * `clone_crawl_runs.cost_usd` at finalize time.
   */
  tracker?: CloneProCostTracker
  // ── Stage 1-3 (v6 unchanged) ──────────────────────────────────────
  discoverUrls: (input: {
    sourceUrl: string
  }) => Promise<{
    urls: { sourceUrl: string; discoveredVia: string; depth: number }[]
    sitemapFound: boolean
  }>
  classifyUrls: (input: {
    urls: string[]
    jobId: string
    shopId: string
  }) => Promise<Record<string, Classification | null>>
  renderUrls: (input: {
    urls: { id: string; sourceUrl: string }[]
  }) => Promise<{
    queueId: string
    sourceUrl: string
    html: string
    screenshotSha1: string | null
    assetUrls: string[]
    viewportWidth: number
    viewportHeight: number
    error?: string
  }[]>
  // ── Stage 4 (v7-only) ─────────────────────────────────────────────
  runStage4Lonspy: (input: {
    jobId: string
    sourceUrl: string
    productsLimit: number | null
  }) => Promise<RunStage4Result>
  // ── Stage 5-12 (v6 unchanged) ─────────────────────────────────────
  buildAssetGraph: (input: { pages: any[] }) => any[]
  downloadAssets: (input: {
    assets: any[]
    shopId: string
    jobId: string
  }) => Promise<{ downloaded: number; skipped: number; failed: number; aborted: boolean }>
  runPersisters: (input: {
    shopId: string
    jobId: string
    dtos: any
  }) => Promise<{
    bucketFailures: string[]
    products: any
    collections: any
    pages: any
    blogPosts: any
    menus: any
    themeTokens: any
    themeFiles: any
    urlRedirects: any
    genericMedia: any
  }>
  applyRewriter: (input: {
    shopId: string
    jobId: string
    sourceHost: string
  }) => Promise<{ rowsRewritten: number }>
  verifyNoLeaks: (input: {
    shopId: string
    sourceHost: string
  }) => Promise<{ ok: boolean; totalLeaks: number; leaks: any[] }>
  runVerification: (input: {
    jobId: string
    shopId: string
  }) => Promise<{
    pixelDiffPct: number
    cardinality: { ok: boolean; overallPct: number; productsPct: number }
    reachability: { totalAssets: number; ok: number; notFound: number }
  }>
  computeGrade: (input: any) => { letter: 'A' | 'B' | 'C' | 'D' | 'F'; score: number; perCheck: any }
  autoPublish: (input: {
    jobId: string
    shopId: string
    gradeLetter: 'A' | 'B' | 'C' | 'D' | 'F'
  }) => Promise<{ published: boolean; reason?: string }>
  finalize: (input: {
    jobId: string
    shopId: string
    grade: any
    verifyResult: any
    publishResult: any
  }) => Promise<void>
  emitProgress: (jobId: string, pct: number, stage: string) => Promise<void>
  emitStage: (
    jobId: string,
    stage: string,
    status: 'running' | 'succeeded' | 'failed',
    detail?: string,
  ) => Promise<void>
}

export interface RunV7Result {
  stage1: { urlsDiscovered: number; sitemapFound: boolean }
  stage2: { classified: number }
  stage3: { rendered: number; errors: number }
  stage4: {
    products: number
    collections: number
    pages: number
    qualityScore: number
    rowsHarvested: number
    rowsFailed: number
  }
  stage5: { assets: number }
  stage6: { downloaded: number; skipped: number; failed: number; aborted: boolean }
  stage7: { bucketFailures: string[]; persistInserted: number }
  stage8: { rowsRewritten: number; leaksDetected: number }
  stage9: {
    pixelDiffPct: number
    cardinality: { ok: boolean; overallPct: number; productsPct: number }
    reachability: { totalAssets: number; ok: number; notFound: number }
  }
  stage10: { letter: string; score: number }
  stage11: { published: boolean; reason?: string }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runCloneProV7(input: RunV7Input): Promise<RunV7Result> {
  const { jobId, sourceUrl, productsLimit, deps } = input

  // ── Stage 1: Sitemap discovery ──────────────────────────────────────
  await deps.emitStage(jobId, 'stage1_sitemap', 'running')
  await deps.emitProgress(jobId, 5, 'stage1_sitemap')

  const discovered = await deps.discoverUrls({ sourceUrl })

  if (discovered.urls.length === 0) {
    await deps.emitStage(jobId, 'stage1_sitemap', 'failed', 'no URLs discovered')
    throw new Error('Stage 1 — no URLs discovered from source (no sitemap, no BFS results)')
  }

  const queueRows = discovered.urls.map((u) => ({
    job_id: jobId,
    source_url: u.sourceUrl,
    discovered_via: u.discoveredVia,
    depth: u.depth,
    status: 'queued' as const,
    classification: null,
  }))

  const insertedQueue = await (deps.db as any)
    .insertInto('clone_url_queue')
    .values(queueRows)
    .returningAll()
    .execute()

  await deps.emitStage(jobId, 'stage1_sitemap', 'succeeded', `${discovered.urls.length} URLs`)
  await deps.emitProgress(jobId, 12, 'stage1_sitemap')

  // ── Stage 2: URL classification ────────────────────────────────────
  await deps.emitStage(jobId, 'stage2_classify', 'running')
  const urls = insertedQueue.map((q: any) => q.source_url as string)
  const classifications = await deps.classifyUrls({ urls, jobId, shopId: input.shopId })

  for (const row of insertedQueue) {
    const cls = classifications[(row as any).source_url] ?? 'other'
    await (deps.db as any)
      .updateTable('clone_url_queue')
      .set({ classification: cls })
      .where('id', '=', (row as any).id)
      .execute()
  }
  await deps.emitStage(jobId, 'stage2_classify', 'succeeded', `${urls.length} classified`)
  await deps.emitProgress(jobId, 22, 'stage2_classify')

  // ── Stage 3: Headless render ───────────────────────────────────────
  await deps.emitStage(jobId, 'stage3_render', 'running')
  const rendered = await deps.renderUrls({
    urls: insertedQueue.map((r: any) => ({
      id: r.id as string,
      sourceUrl: r.source_url as string,
    })),
  })

  let renderErrors = 0
  for (const r of rendered) {
    if (r.error) {
      renderErrors++
      await (deps.db as any)
        .updateTable('clone_url_queue')
        .set({ status: 'failed', error: r.error })
        .where('id', '=', r.queueId)
        .execute()
      continue
    }
    await (deps.db as any)
      .insertInto('clone_render_cache')
      .values({
        queue_id: r.queueId,
        html: r.html,
        screenshot_sha1: r.screenshotSha1,
        asset_urls_json: JSON.stringify(r.assetUrls),
        viewport_width: r.viewportWidth,
        viewport_height: r.viewportHeight,
      })
      .execute()
    await (deps.db as any)
      .updateTable('clone_url_queue')
      .set({ status: 'rendered' })
      .where('id', '=', r.queueId)
      .execute()
  }

  const renderedCount = rendered.length - renderErrors
  await deps.emitStage(
    jobId,
    'stage3_render',
    'succeeded',
    `${renderedCount} rendered, ${renderErrors} failed`,
  )
  await deps.emitProgress(jobId, 35, 'stage3_render')

  // ── Stage 4: Lonspy bulk crawl (v7-only) ───────────────────────────
  await deps.emitStage(jobId, 'stage4_lonspy_bulk', 'running')
  const stage4Result = await deps.runStage4Lonspy({
    jobId,
    sourceUrl,
    productsLimit,
  })
  await deps.emitStage(
    jobId,
    'stage4_lonspy_bulk',
    'succeeded',
    `products=${stage4Result.products.length} collections=${stage4Result.collections.length} quality=${stage4Result.qualityScore.toFixed(2)}`,
  )
  await deps.emitProgress(jobId, 60, 'stage4_lonspy_bulk')

  // ── Stage 5: Asset graph ──────────────────────────────────────────
  await deps.emitStage(jobId, 'stage5_asset_graph', 'running')
  const successfulPages = rendered.filter((p: any) => !p.error)
  const assetGraph = deps.buildAssetGraph({
    pages: successfulPages.map((p: any) => ({
      ...p,
      classification: classifications[p.sourceUrl] ?? ('other' as const),
    })),
  })
  await deps.emitStage(jobId, 'stage5_asset_graph', 'succeeded', `${assetGraph.length} assets`)
  await deps.emitProgress(jobId, 65, 'stage5_asset_graph')

  // ── Stage 6: Download assets ──────────────────────────────────────
  await deps.emitStage(jobId, 'stage6_download', 'running')
  const downloadResult = await deps.downloadAssets({
    assets: assetGraph,
    shopId: input.shopId,
    jobId,
  })
  await deps.emitStage(
    jobId,
    'stage6_download',
    'succeeded',
    `d=${downloadResult.downloaded} s=${downloadResult.skipped} f=${downloadResult.failed}`,
  )
  await deps.emitProgress(jobId, 80, 'stage6_download')

  if (downloadResult.aborted) {
    throw new Error('Stage 6 aborted — failure threshold or cap exceeded')
  }

  // ── Stage 7: Persisters ───────────────────────────────────────────
  await deps.emitStage(jobId, 'stage7_persisters', 'running')
  const persistResult = await deps.runPersisters({
    shopId: input.shopId,
    jobId,
    dtos: {
      products: stage4Result.products as ProductDTO[],
      collections: stage4Result.collections as CollectionDTO[],
      pages: stage4Result.pages as PageDTO[],
      blogPosts: [],
      menus: [],
      themeTokens: null,
      themeFiles: [],
      urlRedirects: [],
      genericMedia: [],
    },
  })
  await deps.emitStage(
    jobId,
    'stage7_persisters',
    'succeeded',
    `bucketFailures=${persistResult.bucketFailures.length}`,
  )
  await deps.emitProgress(jobId, 88, 'stage7_persisters')

  // ── Stage 8: Path rewriter + grep gate ────────────────────────────
  await deps.emitStage(jobId, 'stage8_rewriter', 'running')
  const sourceHost = new URL(sourceUrl).host
  const rewriteResult = await deps.applyRewriter({ shopId: input.shopId, jobId, sourceHost })
  const grepResult = await deps.verifyNoLeaks({ shopId: input.shopId, sourceHost })
  if (!grepResult.ok) {
    await deps.emitStage(
      jobId,
      'stage8_rewriter',
      'failed',
      `source-domain leaks: ${grepResult.totalLeaks}`,
    )
    throw new Error(
      `Stage 8 grep gate found ${grepResult.totalLeaks} source-domain leaks — aborting`,
    )
  }
  await deps.emitStage(jobId, 'stage8_rewriter', 'succeeded', '0 leaks')
  await deps.emitProgress(jobId, 92, 'stage8_rewriter')

  // ── Stage 9: Verification ─────────────────────────────────────────
  await deps.emitStage(jobId, 'stage9_verification', 'running')
  const verifyResult = await deps.runVerification({ jobId, shopId: input.shopId })
  await deps.emitStage(
    jobId,
    'stage9_verification',
    'succeeded',
    `pixel=${verifyResult.pixelDiffPct}% cardinality=${verifyResult.cardinality.overallPct}%`,
  )
  await deps.emitProgress(jobId, 96, 'stage9_verification')

  // ── Stage 10: Grade ───────────────────────────────────────────────
  const grade = deps.computeGrade({
    pixelDiffPct: verifyResult.pixelDiffPct,
    cardinalityPct: verifyResult.cardinality.overallPct,
    asset404Count: verifyResult.reachability.notFound,
    totalAssets: verifyResult.reachability.totalAssets,
    aiVisionScore: 80, // placeholder — Sprint 4 wires GPT-5-vision
  })
  await deps.emitStage(jobId, 'stage10_grade', 'succeeded', `${grade.letter} (${grade.score})`)
  await deps.emitProgress(jobId, 98, 'stage10_grade')

  // ── Stage 11: Auto-publish ────────────────────────────────────────
  const publishResult = await deps.autoPublish({
    jobId,
    shopId: input.shopId,
    gradeLetter: grade.letter,
  })
  await deps.emitStage(
    jobId,
    'stage11_publish',
    'succeeded',
    publishResult.published ? 'published' : `skipped: ${publishResult.reason}`,
  )

  // ── Stage 12: Finalize ────────────────────────────────────────────
  await deps.finalize({ jobId, shopId: input.shopId, grade, verifyResult, publishResult })
  await deps.emitProgress(jobId, 100, 'stage12_finalize')

  return {
    stage1: { urlsDiscovered: discovered.urls.length, sitemapFound: discovered.sitemapFound },
    stage2: { classified: urls.length },
    stage3: { rendered: renderedCount, errors: renderErrors },
    stage4: {
      products: stage4Result.products.length,
      collections: stage4Result.collections.length,
      pages: stage4Result.pages.length,
      qualityScore: stage4Result.qualityScore,
      rowsHarvested: stage4Result.rowsHarvested,
      rowsFailed: stage4Result.rowsFailed,
    },
    stage5: { assets: assetGraph.length },
    stage6: downloadResult,
    stage7: {
      bucketFailures: persistResult.bucketFailures,
      persistInserted:
        (persistResult.products?.inserted ?? 0) +
        (persistResult.collections?.inserted ?? 0) +
        (persistResult.pages?.inserted ?? 0) +
        (persistResult.blogPosts?.inserted ?? 0),
    },
    stage8: { rowsRewritten: rewriteResult.rowsRewritten, leaksDetected: grepResult.totalLeaks },
    stage9: verifyResult,
    stage10: { letter: grade.letter, score: grade.score },
    stage11: publishResult,
  }
}
