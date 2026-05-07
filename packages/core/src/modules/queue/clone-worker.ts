/**
 * Gbox Platform — Clone Pro BullMQ Worker
 *
 * Processes website clone jobs as background tasks.
 * Picks up jobs from the 'website-clone' queue and runs the
 * Clone Pro pipeline with full stage tracking.
 *
 * Configuration:
 *   - Concurrency: 2 (limit server load during cloning)
 *   - Retry: 2 attempts with exponential backoff
 *   - Timeout: 15 minutes per job
 *   - Rate limit: max 2 concurrent jobs per shop (Phase 7.2)
 *
 * Env overrides (Phase 7.2):
 *   - CLONE_SHOP_CONCURRENCY       — per-shop concurrent cap (default 2)
 *   - CLONE_SHOP_CONCURRENCY_DELAY_MS — re-check delay when over cap
 *                                     (default 30_000)
 * Setting CLONE_SHOP_CONCURRENCY=999 effectively disables the cap —
 * that's the rollback escape hatch documented in the Phase 7 spec.
 */

import { Worker, DelayedError, type Job } from 'bullmq'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { getQueueConnection } from './connection.js'
import { runCloneProJob } from '../clone-pro/runner.js'
import type { CloneScope } from '../clone-pro/types.js'
// Phase 19 PR1 — Clone Pro v5. v5 ships BEHIND `CLONE_PRO_VERSION=v5`
// so operations can flip the new pipeline on per-env without touching
// code. Default (flag absent) keeps v4 untouched for safe rollback.
import { runCloneProV5Wired } from '../clone-pro/v5/wired-runner.js'
import { buildV5Deps } from '../clone-pro/v5/build-deps.js'
import { updateStorefrontCloneJob } from '../storefront-clone/job-store.js'
// Phase 21 PR1 — Clone Pro v6. v6 ships BEHIND `CLONE_PRO_VERSION=v6`.
// Rollback: unset the flag (or set to v5/v4) to revert without a deploy.
import { runCloneProV6, buildV6Deps } from '../clone-pro/v6/index.js'
// Phase 22 (Clone Pro v7) Sprint 2 Task 2.8 — v7 ships BEHIND
// `CLONE_PRO_VERSION=v7`. v7 swaps Stage 4 (AI Sonnet bucket scrapers
// → Lonspy XPath bulk crawler) and forwards seller-chosen
// products_limit + crawl_strategy through to the orchestrator.
// Rollback: set the flag to v6 (or unset) to revert without a deploy.
//
// Sprint 5 worker E2E plumbing (Tasks 1-4): after `runCloneProV7`
// returns successfully, the worker runs the theme builder chain:
// Stage 13 (screenshot capture) → Stage 14 (design tokens) → Stage 15
// (theme generate) → Stage 16 (visual verify with retry). It threads a
// single `CloneProCostTracker` through Stage 14 + 16 to enforce the
// per-job AI budget cap, and resolves a `ThemeZipS3KeyResolver` so
// Stage 11 (which already ran inside the orchestrator) can re-deploy
// the theme on a follow-up call. Final cost_usd is persisted to
// clone_crawl_runs (migration 105). All theme-chain failures are
// logged + surfaced as warnings — they DO NOT fail the catalog publish.
import {
  runCloneProV7,
  buildV7Deps,
  ThemeZipS3KeyResolver,
  CloneProCostTracker,
} from '../clone-pro/v7/index.js'
import { captureScreenshots } from '../clone-pro/v7/stages/stage13-screenshot.js'
import { extractDesignTokens } from '../clone-pro/v7/stages/stage14-design-extract.js'
import { generateTheme } from '../clone-pro/v7/stages/stage15-theme-generate.js'
import { visualVerifyWithRetry } from '../clone-pro/v7/stages/stage16-visual-verify.js'
import { defaultDeployTheme } from '../clone-pro/v7/theme-deploy/default-deploy-theme.js'

// ---------------------------------------------------------------------------
// Phase 7.2 — per-shop concurrency cap
// ---------------------------------------------------------------------------

/**
 * Maximum concurrent `running` clone jobs per `shop_id`. Excess jobs
 * don't fail — they're moved to BullMQ's delayed set via
 * `job.moveToDelayed` + `DelayedError` and rechecked after
 * `SHOP_CONCURRENCY_RETRY_DELAY_MS` elapses. Using the DelayedError
 * path (not a plain `throw`) means a throttled job doesn't consume
 * one of its two retry attempts.
 *
 * Default 2 matches the global worker concurrency — meaningful once
 * we later raise the global cap by splitting the worker into its own
 * PM2 process (Phase 8+). Until then per-shop=global is a no-op but
 * the code path is exercised so we won't regress when we scale.
 */
const SHOP_CONCURRENCY_LIMIT = Number(process.env.CLONE_SHOP_CONCURRENCY) || 2

/**
 * Delay before a throttled job re-enters the ready set. Short enough
 * that a freed slot gets claimed promptly; long enough that a busy
 * shop doesn't hammer the pre-check query.
 */
const SHOP_CONCURRENCY_RETRY_DELAY_MS = Number(process.env.CLONE_SHOP_CONCURRENCY_DELAY_MS) || 30_000

// ---------------------------------------------------------------------------
// Job payload type
// ---------------------------------------------------------------------------

export interface WebsiteCloneJob {
  /** Shop ID to clone into */
  shopId: string
  /** Source website URL */
  sourceUrl: string
  /** Clone scope flags */
  scope: CloneScope
  /** Optional AI provider config (encrypted API key) */
  ai?: {
    provider: 'openai' | 'anthropic' | 'google' | 'none'
    apiKey: string
    model?: string
  }
  /** Max products to import */
  maxProducts?: number
  /** Max pages to import */
  maxPages?: number
  /** Whether to download and re-host images */
  ingestMedia?: boolean
  /** Whether to extract brand kit */
  extractBrandKit?: boolean
  /** Whether to generate Liquid theme */
  generateTheme?: boolean
  /** Clone job ID for tracking in our DB */
  cloneJobId?: string
  /**
   * Phase 7 Step 7.1 — the user who kicked off the clone. The worker
   * uses this to attribute `clone_pro_failed` notifications when the
   * pipeline hits a terminal failure. Optional so legacy enqueues
   * (or anonymous admin-spawned backfills) degrade to
   * system-generated rows without a user_id.
   */
  createdByUserId?: string | null
  /**
   * Phase 22 (Clone Pro v7) Sprint 2 Task 2.7 — bulk-catalog crawl
   * params. Forwarded to the v7 orchestrator's Stage 4 (Lonspy).
   * Both fields are optional for backwards compatibility with v4/v5/v6
   * enqueues; the v7 worker branch treats `productsLimit=undefined`
   * as `null` (full crawl).
   *
   *   crawlStrategy   — 'sample' (default 200 cap) | 'full' (no cap).
   *   productsLimit   — explicit cap; null = full crawl. Defaults
   *                     applied by the API layer (POST /clone-pro/start).
   */
  crawlStrategy?: 'sample' | 'full'
  productsLimit?: number | null
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

const QUEUE_NAME = 'website-clone'
let cloneWorker: Worker | null = null

/**
 * Start the website clone worker.
 * Should be called once at server boot alongside other workers.
 *
 * @param db - Kysely database instance (shared with API)
 * @returns The BullMQ Worker instance
 */
export function startCloneWorker(db: Kysely<Database>): Worker {
  if (cloneWorker) return cloneWorker

  cloneWorker = new Worker<WebsiteCloneJob>(
    QUEUE_NAME,
    async (job: Job<WebsiteCloneJob>, token?: string) => {
      const data = job.data
      console.log(
        `[clone-worker] Starting clone job ${job.id}: ${data.sourceUrl} → shop ${data.shopId}`,
      )

      // Phase 7 Step 7.2 — per-shop concurrency cap.
      //
      // Query how many OTHER jobs are currently `running` on this
      // shop. Scoping to `discarded_at IS NULL` excludes the "Replace"
      // leftovers from Phase 6 (dupe-domain UX) — they're tombstones,
      // not live work. Excluding our own `cloneJobId` is critical:
      // without it, a retry would always see count≥1 because the row
      // is already transitioning into `running` when we re-enter.
      //
      // If we're at or over the cap, move the job to BullMQ's delayed
      // set and signal with `DelayedError`. That's the idiomatic
      // BullMQ v5 way of saying "I rescheduled this myself, don't
      // count it as a retry attempt". If we used a plain `throw`
      // instead, the 2-attempt cap on the queue would burn through
      // in three throttles and flip the job to `failed`.
      //
      // The pre-check runs BEFORE `runCloneProJob`, so throttled jobs
      // never touch the pipeline or transition the DB row. Ordering
      // also means the `cloneJobId` guard is still enforced — a bad
      // payload (no row) gets a fast `Error` instead of being parked
      // in delayed forever.
      if (data.cloneJobId) {
        const runningRows = await (db as any)
          .selectFrom('storefront_clone_jobs')
          .select('id')
          .where('shop_id', '=', data.shopId)
          .where('status', '=', 'running')
          .where('id', '!=', data.cloneJobId)
          .where('discarded_at', 'is', null)
          .execute()
        const runningCount = Array.isArray(runningRows)
          ? runningRows.length
          : 0
        if (runningCount >= SHOP_CONCURRENCY_LIMIT) {
          console.log(
            `[clone-worker] shop ${data.shopId} over concurrency cap ` +
              `(${runningCount}/${SHOP_CONCURRENCY_LIMIT}); ` +
              `re-parking job ${job.id} for ${SHOP_CONCURRENCY_RETRY_DELAY_MS}ms`,
          )
          await job.moveToDelayed(Date.now() + SHOP_CONCURRENCY_RETRY_DELAY_MS, token)
          throw new DelayedError(
            `shop ${data.shopId} at ${runningCount}/${SHOP_CONCURRENCY_LIMIT} concurrent clones`,
          )
        }
      }

      // Phase 7 Step 7.1 — the worker now defers the whole run to
      // `runCloneProJob` so we share exactly one code path with the
      // (legacy) in-process runner. The runner handles:
      //   • queued → running → succeeded/failed transitions
      //   • stages_json streaming
      //   • progress_pct + current_phase + current_message
      //   • onJobResult terminal callback (for notifications)
      //
      // The DB row MUST exist already — `POST /clone-pro/start`
      // creates it before calling `enqueueWebsiteClone()`, so by the
      // time the worker picks up the job `data.cloneJobId` is always
      // set. We refuse to start otherwise (legacy enqueues without a
      // row would leak orphan BullMQ entries).
      if (!data.cloneJobId) {
        throw new Error('clone-worker requires data.cloneJobId (populated by POST /clone-pro/start)')
      }

      // Phase 22 Sprint 2 Task 2.8 — route through v7 when the env flag
      // is set. v7 = v6 pipeline with Stage 4 swapped for the Lonspy
      // bulk crawler + Stage 13/14/15/16 theme chain (Sprint 5 worker
      // plumbing). Reads productsLimit + crawlStrategy off the BullMQ
      // payload (set by POST /clone-pro/start). Terminal contract: throw
      // on failure so BullMQ retries.
      // Rollback: set CLONE_PRO_VERSION to v6 (or unset) to revert.
      if (process.env.CLONE_PRO_VERSION === 'v7') {
        // ─── Per-job singletons ─────────────────────────────────────
        // ONE tracker per job: same instance threads through Stage 14 +
        // Stage 16 + the final cost_usd write. ONE resolver per job:
        // bridges Stage 11 (inside orchestrator, runs first) with
        // Stage 15 (worker-level, runs later) — Stage 11 sees `null`
        // initially; once Stage 15 produces a key, the worker calls
        // `resolver.resolve(key)` so the follow-up deploy succeeds.
        const tracker = new CloneProCostTracker()
        const resolver = new ThemeZipS3KeyResolver()

        const v7Deps = buildV7Deps(db, {
          tracker: tracker,
          themeZipS3KeyResolver: resolver.asResolverFn(),
          deployTheme: defaultDeployTheme,
        })
        const productsLimit =
          data.productsLimit !== undefined ? data.productsLimit : null

        // ─── Phase 1: data pipeline (12 stages incl. Stage 11 publish) ─
        let v7Result: Awaited<ReturnType<typeof runCloneProV7>>
        try {
          v7Result = await runCloneProV7({
            jobId: data.cloneJobId,
            shopId: data.shopId,
            sourceUrl: data.sourceUrl,
            productsLimit,
            deps: v7Deps,
          })
        } catch (err) {
          const msg = (err as Error).message ?? 'v7 clone pipeline failed'
          console.error(`[clone-worker] v7 job ${job.id} failed:`, msg)
          throw new Error(msg)
        }
        console.log(
          `[clone-worker] v7 job ${job.id} pipeline ok — ` +
            `stage4: ${v7Result.stage4.products} products / quality=${v7Result.stage4.qualityScore.toFixed(2)} ` +
            `grade=${v7Result.stage10.letter} (${v7Result.stage10.score})`,
        )

        // ─── Phase 2: theme builder chain (Stage 13/14/15/16) ───────
        // Catalog data is committed at this point. The theme chain is
        // best-effort: any failure surfaces as a warning; we DON'T
        // throw because that would unwind the data pipeline (which
        // succeeded). The chain is sequential — each stage feeds the
        // next; without screenshots there's nothing to extract; without
        // tokens there's nothing to render; etc.
        try {
          // Stage 13: capture source screenshots (5 pages × 2 viewports).
          // Worker injects Playwright Browser + S3 upload — those
          // dependencies aren't carried through V7Deps because they
          // belong outside core. The `_themeChainDepsForJob` helper
          // builds them lazily via env config so unit tests can stub.
          const themeDeps = _themeChainDepsForJob(data.shopId, data.cloneJobId)
          if (!themeDeps) {
            console.warn(
              `[clone-worker] v7 job ${job.id} — theme chain deps unavailable; ` +
                `skipping Stage 13/14/15/16 (data pipeline still succeeded).`,
            )
          } else {
            const captureResult = await captureScreenshots({
              jobId: data.cloneJobId,
              shopSlug: themeDeps.shopSlug,
              sourceUrl: data.sourceUrl,
              urlsToCapture: themeDeps.urlsToCapture,
              browser: themeDeps.browser,
              uploadScreenshot: themeDeps.uploadScreenshot,
            })

            if (Object.keys(captureResult.s3Keys).length === 0) {
              // Defensive guard — Stage 14/15/16 with zero source
              // screenshots wastes Anthropic budget and produces no
              // usable output. Skip the chain; catalog still ships.
              console.warn(
                `[clone-worker] v7 job ${job.id} — Stage 13 produced no screenshots; ` +
                  `skipping rest of theme chain.`,
              )
            } else {
              // Stage 14: extract design tokens via Claude vision.
              // Tracker enforces per-job AI cap.
              const extractResult = await extractDesignTokens({
                jobId: data.cloneJobId,
                shopId: data.shopId,
                screenshotS3Keys: captureResult.s3Keys,
                downloadS3: themeDeps.downloadS3,
                callVision: themeDeps.callVision,
                tracker,
              })

              if (extractResult.tokens) {
                // Stage 15: render Liquid theme + bundle theme.zip.
                const themeBundle = await generateTheme({
                  jobId: data.cloneJobId,
                  shopId: data.shopId,
                  tokens: extractResult.tokens,
                  upload: themeDeps.uploadTheme,
                  persistThemeFiles: themeDeps.persistThemeFiles,
                  deactivatePreviousActive: themeDeps.deactivatePreviousActive,
                })

                if (themeBundle.theme_zip_key) {
                  // Resolve the key so any follow-up deploy reads it.
                  // Stage 11 already ran inside the orchestrator and
                  // saw `null` — we deploy directly here to close the
                  // loop without re-running the whole publish.
                  resolver.resolve(themeBundle.theme_zip_key)
                  try {
                    await defaultDeployTheme({
                      shopId: data.shopId,
                      themeZipS3Key: themeBundle.theme_zip_key,
                    })
                  } catch (deployErr) {
                    console.warn(
                      `[clone-worker] v7 job ${job.id} — deployTheme failed:`,
                      (deployErr as Error).message,
                    )
                  }
                }

                // Stage 16: visual verify with retry (max 3). Tracker
                // gates each retry against the per-job cap.
                if (themeBundle.theme_zip_key && themeDeps.cloneUrl) {
                  await visualVerifyWithRetry({
                    jobId: data.cloneJobId,
                    shopId: data.shopId,
                    shopSlug: themeDeps.shopSlug,
                    cloneUrl: themeDeps.cloneUrl,
                    sourceScreenshotS3Keys: captureResult.s3Keys,
                    tokens: extractResult.tokens,
                    runVerify: themeDeps.runVerify,
                    runRegenerate: themeDeps.runRegenerate,
                    maxRetries: 3,
                    tracker,
                  })
                }
              }
            }
          }
        } catch (themeErr) {
          // Iron Rule 5: raw `themeErr` stays in worker logs only. The
          // job row's success state is already persisted by Stage 12;
          // we don't unwind it for a theme failure.
          console.warn(
            `[clone-worker] v7 job ${job.id} — theme chain failed (data still ok):`,
            (themeErr as Error).message,
          )
        }

        // ─── Phase 3: persist final AI cost ──────────────────────────
        // Migration 105 added `clone_crawl_runs.cost_usd numeric(8,4)`.
        // Stage 4 INSERTed the row at start; we UPDATE it here with the
        // accumulated tracker total. Wrapped in try/catch — losing this
        // audit field never fails an otherwise-successful job.
        try {
          await (db as any)
            .updateTable('clone_crawl_runs')
            .set({ cost_usd: tracker.getSpentUsd().toFixed(4) })
            .where('job_id', '=', data.cloneJobId)
            .execute()
        } catch (costErr) {
          console.warn(
            `[clone-worker] v7 job ${job.id} — cost_usd UPDATE failed:`,
            (costErr as Error).message,
          )
        }

        return { status: 'succeeded', v7: v7Result }
      }

      // Phase 21 PR1 — route through v6 when the env flag is set.
      // v6 uses a fully DI-driven orchestrator (Stage 1-3 in Sprint 1;
      // Stages 4-12 in subsequent sprints). The terminal contract is the
      // same as v4/v5: throw on failure so BullMQ retries.
      // Rollback: set CLONE_PRO_VERSION to v5, v4, or unset.
      if (process.env.CLONE_PRO_VERSION === 'v6') {
        const v6Deps = buildV6Deps(db)
        let v6Result: Awaited<ReturnType<typeof runCloneProV6>>
        try {
          v6Result = await runCloneProV6({
            jobId: data.cloneJobId,
            shopId: data.shopId,
            sourceUrl: data.sourceUrl,
            deps: v6Deps,
          })
        } catch (err) {
          const msg = (err as Error).message ?? 'v6 clone pipeline failed'
          console.error(`[clone-worker] v6 job ${job.id} failed:`, msg)
          throw new Error(msg)
        }
        console.log(
          `[clone-worker] v6 job ${job.id} succeeded — ` +
            `stage1: ${v6Result.stage1.urlsDiscovered} URLs, ` +
            `stage2: ${v6Result.stage2.classified} classified, ` +
            `stage3: ${v6Result.stage3.rendered} rendered / ${v6Result.stage3.errors} errors`,
        )
        return { status: 'succeeded', v6: v6Result }
      }

      // Phase 19 PR1 — route through v5 when the env flag is set.
      // The v5 adapter has the same terminal contract as v4
      // (`{ status: 'succeeded' | 'failed', errorMessage? }`) but takes
      // a different input shape, so the notification+retry branch
      // below works uniformly against the `result.status` property.
      // Rollback: unset CLONE_PRO_VERSION and the worker reverts to v4
      // without a deploy.
      if (process.env.CLONE_PRO_VERSION === 'v5') {
        // Build real scrapers + DB-backed persisters + route-check deps.
        // `buildV5Deps` is a cheap, stateless factory — constructed once
        // per job so any future per-job config (e.g. maxProducts cap)
        // can be threaded without cross-job leakage.
        const v5Deps = buildV5Deps(db)
        const v5 = await runCloneProV5Wired(db, {
          shopId: data.shopId,
          jobId: data.cloneJobId,
          sourceUrl: data.sourceUrl,
          scope: data.scope as any,
          _updateStorefrontCloneJob: updateStorefrontCloneJob as any,
          _deps: v5Deps,
        })
        console.log(
          `[clone-worker] v5 job ${job.id} terminal status=${v5.status}` +
            (v5.errorMessage ? ` — ${v5.errorMessage}` : '') +
            (v5.grade ? ` grade=${v5.grade} score=${v5.score}` : ''),
        )
        if (v5.status === 'failed') {
          throw new Error(v5.errorMessage ?? 'v5 clone pipeline failed')
        }
        // Worker-level success — BullMQ keeps the run under `completed`.
        return { status: 'succeeded', grade: v5.grade, score: v5.score }
      }

      const result = await runCloneProJob(db, {
        shopId: data.shopId,
        jobId: data.cloneJobId,
        sourceUrl: data.sourceUrl,
        configOverrides: {
          scope: data.scope,
          ai: data.ai as any,
          maxProducts: data.maxProducts,
          maxPages: data.maxPages,
          ingestMedia: data.ingestMedia,
          extractBrandKit: data.extractBrandKit,
          generateTheme: data.generateTheme,
        },
        onJobResult: async (r) => {
          // Inline notification INSERTs — the app-layer `notify()`
          // helper lives in apps/store-admin and can't be imported
          // here. The SSE push is skipped (the worker isn't the
          // same process as the HTTP server anyway in future splits).
          //
          // Terminal status → notification mapping:
          //   succeeded          → no notification (clone_pro_started
          //                        was already fired by the HTTP
          //                        handler; a second one would be
          //                        bell-icon spam).
          //   succeeded_partial  → clone_pro_partial (Phase 7.5 — the
          //                        job is done but the merchant needs
          //                        to know some data may be missing).
          //   failed             → clone_pro_failed (retry-eligible
          //                        until attempts run out, and the
          //                        bell-icon surfaces it once we land
          //                        on the terminal failed state).
          if (r.status === 'failed') {
            try {
              await (db as any)
                .insertInto('notifications')
                .values({
                  shop_id: data.shopId,
                  user_id: data.createdByUserId ?? null,
                  type: 'clone_pro_failed',
                  title: `Clone Pro failed: ${data.sourceUrl}`,
                  message:
                    r.errorMessage ??
                    r.errorCode ??
                    'Pipeline failed',
                  resource_type: 'storefront_clone_job',
                  resource_id: data.cloneJobId,
                })
                .execute()
            } catch (e) {
              // Non-fatal. Losing a notification is preferable to
              // losing the job row's failed status — which is already
              // persisted by the runner.
              console.error(
                `[clone-worker] notify clone_pro_failed insert error:`,
                (e as Error).message,
              )
            }
            return
          }

          if (r.status === 'succeeded_partial') {
            // `failedStages` is populated by the runner — list up to
            // three names in the message so the bell-icon preview is
            // informative without blowing up the dropdown width.
            const failed = r.failedStages ?? []
            const headline =
              failed.length === 1
                ? `Clone finished with 1 failed stage`
                : `Clone finished with ${failed.length} failed stages`
            const detail =
              failed.length === 0
                ? ''
                : `: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ', …' : ''}`
            try {
              await (db as any)
                .insertInto('notifications')
                .values({
                  shop_id: data.shopId,
                  user_id: data.createdByUserId ?? null,
                  type: 'clone_pro_partial',
                  title: `${headline}${detail}`,
                  message: `Cloned ${data.sourceUrl} with partial results`,
                  resource_type: 'storefront_clone_job',
                  resource_id: data.cloneJobId,
                })
                .execute()
            } catch (e) {
              // Same rationale as clone_pro_failed — the job row's
              // terminal state is already persisted; losing a bell-
              // icon entry is strictly better than erroring out.
              console.error(
                `[clone-worker] notify clone_pro_partial insert error:`,
                (e as Error).message,
              )
            }
            return
          }

          // Clean success path: no notification.
          return
        },
      })

      console.log(
        `[clone-worker] Job ${job.id} terminal status=${result.status}` +
          (result.errorMessage ? ` — ${result.errorMessage}` : ''),
      )

      // Re-throw on failed terminal so BullMQ can retry per the
      // queue's attempts/backoff config. The runner has already
      // persisted the DB row's failure state — BullMQ retry will
      // transition running → failed → running on re-entry.
      if (result.status === 'failed') {
        throw new Error(
          result.errorMessage ?? result.errorCode ?? 'clone pipeline failed',
        )
      }

      return result
    },
    {
      connection: getQueueConnection(),
      concurrency: 2,
      // 15 minute timeout per job
      lockDuration: 15 * 60 * 1000,
      // Stalled job detection
      stalledInterval: 60_000, // check every 60s
      maxStalledCount: 2,
    },
  )

  // Event handlers
  cloneWorker.on('completed', (job) => {
    console.log(`[clone-worker] Job ${job.id} completed successfully`)
  })

  cloneWorker.on('failed', (job, err) => {
    console.error(`[clone-worker] Job ${job?.id} failed:`, err.message)
  })

  cloneWorker.on('error', (err) => {
    // Connection errors, etc.
    if (!err.message?.includes('ECONNRESET')) {
      console.error('[clone-worker] Worker error:', err.message)
    }
  })

  console.log(`[clone-worker] Started (concurrency: 2, queue: ${QUEUE_NAME})`)
  return cloneWorker
}

/**
 * Stop the clone worker gracefully.
 * Waits for current jobs to finish (drain).
 */
export async function stopCloneWorker(): Promise<void> {
  if (!cloneWorker) return
  await cloneWorker.close()
  cloneWorker = null
  console.log('[clone-worker] Stopped')
}

// ---------------------------------------------------------------------------
// Clone job DB status updates
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sprint 5 worker E2E plumbing — theme chain deps factory
// ---------------------------------------------------------------------------

/**
 * Returns the heavyweight Stage 13/14/15/16 deps when the environment
 * supports them, or `null` when key bindings are missing (in which
 * case the worker logs + skips the theme chain — the catalog still
 * ships, just without a v7-generated theme).
 *
 * Runtime requirements (production / Server 2):
 *   - `playwright` + a Chromium binary (Stage 13 screenshot capture).
 *   - `@aws-sdk/client-s3` + `S3_BUCKET` env (Stage 13/14/15 upload/download).
 *   - `@anthropic-ai/sdk` + `ANTHROPIC_API_KEY` env (Stage 14/16 vision).
 *   - `STOREFRONT_BASE_URL` env to construct `cloneUrl` (Stage 16).
 *
 * On Windows dev / vitest CI any of these may be absent — the lazy
 * `require()` in this function catches the missing-module error and
 * returns null, leaving the unit tests source-level (the existing
 * pattern in clone-worker.test.ts).
 *
 * Iron Rule 5: every error path logs + falls through to skip; we
 * never compose seller-facing strings here.
 */
function _themeChainDepsForJob(
  shopId: string,
  jobId: string,
):
  | {
      shopSlug: string
      cloneUrl: string | null
      urlsToCapture: Array<{ label: string; url: string }>
      browser: any
      uploadScreenshot: (sourceUrl: string, key: string, png: Buffer) => Promise<string>
      downloadS3: (key: string) => Promise<Buffer>
      uploadTheme: any
      callVision: any
      persistThemeFiles: (input: any) => Promise<unknown>
      deactivatePreviousActive: (input: { shopId: string }) => Promise<number>
      runVerify: any
      runRegenerate: any
    }
  | null {
  // The lazy build is wrapped in try/catch so any missing module /
  // env / binary takes us down the "skip the chain" path rather than
  // crashing the entire job. Server 2 / production bind a real impl
  // before flipping CLONE_PRO_VERSION=v7; everywhere else we no-op.
  try {
    // Hand-coded bindings live in the deploy/env layer (`apps/api`)
    // because they pull in 30MB of Playwright + AWS SDK that core
    // can't import without bloating the worker bundle. Server 2
    // populates `globalThis.__gboxV7ThemeChainDeps` at boot.
    const factory = (globalThis as any).__gboxV7ThemeChainDeps
    if (typeof factory !== 'function') {
      return null
    }
    const deps = factory({ shopId, jobId })
    return deps ?? null
  } catch (err) {
    console.warn(
      `[clone-worker] v7 theme chain deps factory threw for shop ${shopId} job ${jobId}:`,
      (err as Error).message,
    )
    return null
  }
}

async function updateCloneJobStatus(
  db: Kysely<Database>,
  jobId: string,
  status: string,
  result?: any,
  errorMessage?: string,
): Promise<void> {
  try {
    const updates: Record<string, any> = {
      status,
      updated_at: new Date().toISOString(),
    }

    if (status === 'running') {
      updates.started_at = new Date().toISOString()
    }

    if (status === 'succeeded' || status === 'failed') {
      updates.finished_at = new Date().toISOString()
    }

    if (result) {
      updates.result_json = JSON.stringify(result)
    }

    if (errorMessage) {
      updates.error_message = errorMessage
    }

    await db
      .updateTable('clone_jobs' as any)
      .set(updates)
      .where('id', '=', jobId)
      .execute()
  } catch {
    // Non-fatal: logging only
    console.warn(`[clone-worker] Failed to update job ${jobId} status to ${status}`)
  }
}
