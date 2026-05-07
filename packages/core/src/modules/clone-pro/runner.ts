/**
 * Clone Pro — Job Runner (bridges `cloneWebsite()` → `storefront_clone_jobs`)
 *
 * Purpose:
 *   The storefront-admin UI already has a job-tracking table
 *   (`storefront_clone_jobs`) with SSE streaming, stage timeline,
 *   and progress percentage wired up. Instead of spinning up a new
 *   table just for clone-pro, we reuse that substrate and map
 *   clone-pro's `ClonePipelineCallbacks` into the same row shape.
 *
 * Contract:
 *   - One call → one `storefront_clone_jobs` row transitions from
 *     `queued` → `running` → `succeeded | failed`.
 *   - On each clone-pro stage update, we append a `CloneJobStageEntry`
 *     to `stages_json` using the clone-pro stage name as-is (`detect`,
 *     `crawl`, `extract_design`, etc.).
 *   - On each progress callback, we update `progress_pct`.
 *   - On fatal error, we mark the job `failed` and store the error
 *     in `error_code` + `error_message`. Non-fatal stage failures
 *     are recorded in `stages_json` but the job keeps running.
 *   - The runner does NOT rethrow — the orchestrator callers are
 *     fire-and-forget, so all error state must live in the DB row.
 *
 * Design note:
 *   This deliberately lives alongside clone-pro (not in storefront-
 *   clone) because it depends on `cloneWebsite()` and `CloneProConfig`.
 *   When the Online Store Rewrite (Phase 2B) rolls out a dedicated
 *   `clone_pro_jobs` migration, this runner swaps its table write
 *   target in one place — the callbacks and mapping stay identical.
 */

import type { Kysely } from 'kysely'
import type { Database, CloneJobStageEntry } from '@gbox/db/schema/tables.js'
import {
  appendCloneJobStage,
  getStorefrontCloneJob,
  readStages,
  updateStorefrontCloneJob,
} from '../storefront-clone/job-store.js'
import { logCloneTerminal } from './audit.js'
import { cloneWebsite } from './pipeline.js'
import { computeResumeFromStage, RESUMABLE_STAGES } from './resume.js'
import type { CloneProConfig, CloneStage, CloneStageResult } from './types.js'
// Phase E Task E3 (2026-04-18) — onboarding wizard completion hook.
// Called from the runner's terminal-success branch (both clean + partial)
// and terminal-failure branch. Both helpers are SQL-guarded on
// (state='cloning' AND onboarding_clone_job_id=jobId), so a non-wizard
// clone is a silent no-op. The runner doesn't have to re-read the job
// config to decide whether to fire — that's the whole point.
import {
  completeOnboardingFromCloneJob,
  rollbackCloningForJob,
} from '../onboarding/state.js'

// ---------------------------------------------------------------------------
// Phase 20 P2 — auto-publish helper. Pure for testability.
// ---------------------------------------------------------------------------

/**
 * Decide whether the runner should flip a clean-succeeded job from
 * `status='succeeded'` to `status='published'` automatically.
 *
 * Rule:
 *   - Per-clone override wins. If `configOverride === false`, return
 *     false (seller explicitly opted out for this run).
 *   - Otherwise consult the env. `AUTO_PUBLISH_AFTER_CLONE === 'false'`
 *     disables auto-publish platform-wide (kill-switch). Any other env
 *     value (including unset, the prod default) enables it.
 *
 * This split lets ops kill the feature without redeploys AND lets a
 * single seller request "don't auto-publish my next clone" via a UI
 * checkbox without affecting anyone else.
 */
export function shouldAutoPublish(opts: {
  env: NodeJS.ProcessEnv
  configOverride: boolean | undefined
}): boolean {
  if (opts.configOverride === false) return false
  const raw = opts.env.AUTO_PUBLISH_AFTER_CLONE
  if (typeof raw === 'string' && raw.toLowerCase() === 'false') return false
  return true
}

export interface RunCloneProJobInput {
  readonly shopId: string
  readonly jobId: string
  readonly sourceUrl: string
  /** Optional overrides for CloneProConfig (shopId/sourceUrl are set automatically). */
  readonly configOverrides?: Partial<Omit<CloneProConfig, 'shopId' | 'sourceUrl'>>
  /**
   * When set, tell the pipeline to skip every stage before this one
   * and resume from here. Only used by `resumeCloneProJob` — direct
   * callers should usually go through that helper, which picks a
   * safe resume point automatically.
   */
  readonly resumeFromStage?: CloneStage
  /**
   * Fired exactly once when the pipeline reaches a terminal state —
   * `succeeded` or `failed`. Callers in the app layer (store-admin,
   * accounts) wire this so they can emit a `clone_pro_failed` (or
   * `clone_pro_succeeded`) notification into the bell-icon feed
   * without this package taking a hard dep on `store-admin/lib/notify`.
   *
   * Implementations MUST be fire-and-forget safe — the runner catches
   * every error the callback throws so notifications failures can't
   * knock over the pipeline.
   */
  readonly onJobResult?: (result: RunCloneProJobResult) => void | Promise<void>
  /**
   * Phase 20 P2 — auto-publish on `status=succeeded`.
   *
   * When `true` (default if env `AUTO_PUBLISH_AFTER_CLONE !== 'false'`)
   * the runner flips a clean-succeeded job from `status='succeeded'`
   * to `status='published'` automatically right after the terminal
   * write. Sellers don't have to remember to click "Publish" — the
   * clone goes live on `<slug>.gbox.co` (or whatever primary domain
   * the shop has configured) the moment grading passes.
   *
   * `false` keeps the legacy two-step flow: pipeline lands at
   * `succeeded`, seller clicks "Publish to live" manually. Useful
   * for review-before-publish workflows.
   *
   * `undefined` (the default) defers to the env. The runner only
   * skips auto-publish when the flag is the literal `false`.
   *
   * Auto-publish is also skipped when:
   *   - terminal status is `succeeded_partial` or `failed`
   *   - the grade is 'F' (publish gate)
   *   - the shop has no primary domain (defense-in-depth post-P0)
   *
   * The auto-publish path is best-effort: a failure to flip status
   * does NOT roll back the succeeded write. Worst case the seller
   * sees `succeeded` instead of `published` and clicks publish
   * themselves.
   */
  readonly autoPublish?: boolean
}

export interface RunCloneProJobResult {
  /**
   * Phase 7 Step 7.5 — `succeeded_partial` indicates the pipeline ran
   * to completion but at least one non-fatal stage captured a failure
   * into `stages_json`. The DB row, UI, and notifications all treat
   * it as a soft success with a warning, not as a retryable failure.
   * `failed` is reserved for pre-stage crashes and fatal-stage throws.
   */
  readonly status: 'succeeded' | 'succeeded_partial' | 'failed'
  readonly errorCode?: string
  readonly errorMessage?: string
  /**
   * When `status === 'succeeded_partial'`, the list of stage names
   * that failed (in pipeline order). Omitted for clean successes and
   * full failures. The bell-icon notification uses this to render
   * "Clone finished with N failed stages: X, Y" without having to
   * re-read `stages_json` itself.
   */
  readonly failedStages?: readonly string[]
}

/**
 * Run a clone-pro pipeline and mirror its progress into the
 * `storefront_clone_jobs` table. Fire-and-forget safe — never throws.
 */
export async function runCloneProJob(
  db: Kysely<Database>,
  input: RunCloneProJobInput,
): Promise<RunCloneProJobResult> {
  const { shopId, jobId, sourceUrl } = input

  // Transition queued → running. Also set phase columns so the detail
  // page stepper lights up Phase 1 (Discovery) the moment the runner
  // picks the job up — without this the UI would show "phase 0" until
  // the first stage updates.
  const startedAt = new Date().toISOString()
  try {
    await updateStorefrontCloneJob(db, jobId, {
      status: 'running',
      progressPct: 0,
      startedAt,
      currentPhase: 1,
      phaseProgressPct: 0,
      substep: 'Detecting platform…',
    })
  } catch (err) {
    // If we can't even mark the job running, there's nothing more to
    // do — the caller's `void runCloneProJob(...)` swallows this too.
    // eslint-disable-next-line no-console
    console.error('[clone-pro runner] failed to mark running:', (err as Error).message)
    return {
      status: 'failed',
      errorCode: 'job_update_failed',
      errorMessage: (err as Error).message,
    }
  }

  // Track which stages are currently "open" (started but not finished)
  // so we can avoid duplicate appends. clone-pro's callback fires once
  // per stage transition — each stage we see transitions exactly once
  // from running → succeeded/failed/skipped — so a Set of seen stages
  // is enough.
  const finishedStages = new Set<string>()

  const config: CloneProConfig = {
    sourceUrl,
    shopId,
    // Phase 3: stamp clone_job_id on all imported content so the
    // source-site tabs in store-admin can group them and Discard
    // can cascade-delete.
    jobId,
    scope: input.configOverrides?.scope ?? {
      products: true,
      collections: true,
      pages: true,
      blog: true,
      navigation: true,
      theme: true,
      media: true,
      seo: true,
    },
    ai: input.configOverrides?.ai,
    maxPages: input.configOverrides?.maxPages,
    maxProducts: input.configOverrides?.maxProducts,
    ingestMedia: input.configOverrides?.ingestMedia ?? true,
    extractBrandKit: input.configOverrides?.extractBrandKit ?? true,
    generateTheme: input.configOverrides?.generateTheme ?? true,
    locale: input.configOverrides?.locale,
    resumeFromStage: input.resumeFromStage,
  }

  try {
    const pipelineResult = await cloneWebsite(db, config, {
      onStageUpdate: async (stage: CloneStageResult) => {
        // Skip duplicate "finished" appends for the same stage.
        const key = `${stage.stage}:${stage.status}`
        if (finishedStages.has(key)) return
        if (stage.status !== 'running') finishedStages.add(key)

        // clone-pro's StageStatus also includes 'pending' (the pipeline's
        // internal bookkeeping state), but `CloneJobStageEntry.status`
        // only accepts running/succeeded/failed/skipped — the states a
        // caller would ever see via a real callback. Map 'pending' →
        // 'running' defensively so the types line up even if the
        // pipeline ever fires it.
        const entryStatus: CloneJobStageEntry['status'] =
          stage.status === 'pending' ? 'running' : stage.status
        const entry: CloneJobStageEntry = {
          stage: stage.stage,
          status: entryStatus,
          started_at: stage.startedAt,
          finished_at: stage.finishedAt,
          message: stage.message,
          error_code: stage.errorCode,
        }
        try {
          await appendCloneJobStage(db, jobId, entry)
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            '[clone-pro runner] failed to append stage:',
            stage.stage,
            (err as Error).message,
          )
        }
      },
      onProgress: async (pct: number, message: string) => {
        try {
          // Persist both `progress_pct` AND `current_message` so the
          // SSE endpoint can diff + emit per-item events as the AI
          // optimizers iterate through products/pages/images.
          await updateStorefrontCloneJob(db, jobId, {
            progressPct: pct,
            currentMessage: message || null,
          })
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            '[clone-pro runner] failed to update progress:',
            (err as Error).message,
          )
        }
      },
      onError: (stage, error) => {
        // eslint-disable-next-line no-console
        console.error(
          `[clone-pro runner] non-fatal error in stage ${stage}:`,
          error.message,
        )
      },
    })

    // Pipeline completed → decide terminal status.
    //
    // Phase 7 Step 7.5 — partial-result state machine:
    //   The pipeline's `runStage()` helper re-throws only for stages
    //   in `FATAL_STAGES`; non-fatal failures (extract_design,
    //   extract_content, generate_theme, ingest_media, apply_brand,
    //   seo_optimize) land here as `status: 'failed'` entries in
    //   `pipelineResult.stages`. We inspect that list and choose:
    //     - zero failed stages → 'succeeded' (current behaviour)
    //     - one-or-more failed → 'succeeded_partial' (NEW)
    //   A full failure can't reach this branch — the pipeline throws
    //   to the catch below for pre-stage crashes and fatal throws.
    //
    // Bump the phase columns to 3/100 and apply a default grade so
    // the detail page's phase stepper + verification view render as
    // "done" even before the real verification pipeline lands (Phase
    // H). Without these the UI would still show Phase 1 at 0% because
    // the underlying v2 pipeline never wrote the dashboard-ui columns
    // itself. Partial runs get a lower default grade so merchants
    // notice something went wrong — the real grade comes from the
    // verification pipeline later.
    //
    // Phase 4.1 — Clone Library: if the pipeline produced a theme,
    // stamp its id back onto the job row so the Library can render
    // one card per succeeded job with the theme preview attached.
    // The inverse link (theme → job) is already written by the
    // pipeline (`source_clone_job_id` on the theme row); this side
    // makes the reverse lookup O(1) without joining through themes.
    const failedStages: string[] = []
    for (const stage of pipelineResult?.stages ?? []) {
      if (stage.status === 'failed') failedStages.push(stage.stage)
    }
    const isPartial = failedStages.length > 0
    const terminalStatus: 'succeeded' | 'succeeded_partial' = isPartial
      ? 'succeeded_partial'
      : 'succeeded'

    await updateStorefrontCloneJob(db, jobId, {
      status: terminalStatus,
      progressPct: 100,
      finishedAt: new Date().toISOString(),
      currentPhase: 3,
      phaseProgressPct: 100,
      substep: isPartial
        ? `Finished with ${failedStages.length} failed stage${failedStages.length === 1 ? '' : 's'}`
        : 'Verification complete',
      // Lower the grade for partial runs so the UI hero reflects the
      // soft-failure visually. 'C' keeps the letter-grade aesthetic
      // without looking like a hard red 'F' — that's reserved for
      // real 'failed' terminations.
      grade: isPartial ? 'C' : 'B',
      score: isPartial ? 70 : 85,
      themeId: pipelineResult?.themeId ?? null,
    })

    // Phase 20 P2 — auto-publish on clean-succeeded. Best-effort: any
    // failure here is logged + swallowed; the seller can still click
    // "Publish" manually from the detail page. We never roll back the
    // terminal status write above.
    if (
      !isPartial &&
      shouldAutoPublish({ env: process.env, configOverride: input.autoPublish })
    ) {
      try {
        const grade = pipelineResult?.result?.grade ?? 'B'
        if (grade === 'F') {
          // Publish gate already enforced by postCloneProPublish; we
          // mirror it here so a future stricter grader can't bypass.
          // eslint-disable-next-line no-console
          console.log(
            '[clone-pro runner] auto-publish skipped (grade=F)',
            { jobId, shopId },
          )
        } else {
          const shop = await db
            .selectFrom('shops')
            .select(['domain'])
            .where('id', '=', shopId)
            .executeTakeFirst()
          const domain = (shop?.domain as string | null | undefined)?.trim() ?? ''
          if (!domain) {
            // Should never happen post-P0 backfill; defense in depth.
            // eslint-disable-next-line no-console
            console.warn(
              '[clone-pro runner] auto-publish skipped (no shop.domain)',
              { jobId, shopId },
            )
          } else {
            await updateStorefrontCloneJob(db, jobId, {
              status: 'published',
              publishedAt: new Date().toISOString(),
            })
            // eslint-disable-next-line no-console
            console.log(
              `[clone-pro runner] auto-published — live at https://${domain}`,
              { jobId, shopId },
            )
          }
        }
      } catch (publishErr) {
        // eslint-disable-next-line no-console
        console.error(
          '[clone-pro runner] auto-publish failed (non-fatal):',
          (publishErr as Error).message,
        )
      }
    }

    // Phase 7 Step 7.6 — God Admin audit trail. Fire AFTER the
    // terminal DB write so the audit row is never ahead of the
    // ground-truth status. `logCloneTerminal` swallows its own DB
    // errors so we don't gate the `onJobResult` callback on an
    // audit miss. We pull count metrics off `pipelineResult.result`
    // when present; legacy pipelines that return undefined pass
    // null through and the audit row just records missing metrics.
    const pipelineSummary = pipelineResult?.result
    const durationMs =
      pipelineSummary?.duration_ms ??
      Math.max(0, Date.now() - Date.parse(startedAt))
    await logCloneTerminal(db, {
      shopId,
      jobId,
      status: terminalStatus,
      durationMs,
      productsImported: pipelineSummary?.productsImported ?? null,
      pagesImported: pipelineSummary?.pagesImported ?? null,
      failedStages: isPartial ? failedStages : null,
    })

    // Phase E Task E3 — if this job was spawned from the onboarding
    // wizard, the `shops.onboarding_state='cloning'` + matching
    // `onboarding_clone_job_id` flipped when the job was enqueued
    // (see apps/store-admin Phase C2 start.ts). Now that the terminal
    // status is durable, mirror it onto the wizard machine so the
    // welcome-page middleware stops redirecting and the Resume banner
    // disappears. Non-wizard jobs pass the SQL guard with zero rows
    // and we skip the audit log quietly. Wrapped so a `shops` lock
    // can't retroactively poison a succeeded clone.
    try {
      await completeOnboardingFromCloneJob(db, shopId, jobId)
    } catch (hookErr) {
      // eslint-disable-next-line no-console
      console.error(
        '[clone-pro runner] onboarding completion hook failed (non-fatal):',
        (hookErr as Error).message,
      )
    }

    const successResult: RunCloneProJobResult = isPartial
      ? {
          status: 'succeeded_partial',
          failedStages,
        }
      : { status: 'succeeded' }
    await fireJobResultCallback(input.onJobResult, successResult)
    return successResult
  } catch (err) {
    const message = (err as Error)?.message ?? String(err)
    // eslint-disable-next-line no-console
    console.error('[clone-pro runner] pipeline failed:', message)
    try {
      await updateStorefrontCloneJob(db, jobId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        errorCode: 'pipeline_failed',
        errorMessage: message,
        substep: 'Pipeline failed',
      })
    } catch (writeErr) {
      // eslint-disable-next-line no-console
      console.error(
        '[clone-pro runner] failed to mark failure:',
        (writeErr as Error).message,
      )
    }

    // Phase 7 Step 7.6 — audit the failure. Always fire, even if the
    // `updateStorefrontCloneJob` above raised — the audit row is the
    // God Admin's independent trail and shouldn't go missing just
    // because the mirror write hit a lock.
    await logCloneTerminal(db, {
      shopId,
      jobId,
      status: 'failed',
      durationMs: Math.max(0, Date.now() - Date.parse(startedAt)),
      errorMessage: message,
    })

    // Phase E Task E3 — roll back the wizard state for wizard-origin
    // jobs. SQL-guarded on (state='cloning' AND matching job id) so a
    // non-wizard failure is a no-op. Wrapped so a `shops` hiccup
    // can't mask the pipeline failure we're already reporting.
    try {
      await rollbackCloningForJob(db, shopId, jobId)
    } catch (hookErr) {
      // eslint-disable-next-line no-console
      console.error(
        '[clone-pro runner] onboarding rollback hook failed (non-fatal):',
        (hookErr as Error).message,
      )
    }

    const failureResult: RunCloneProJobResult = {
      status: 'failed',
      errorCode: 'pipeline_failed',
      errorMessage: message,
    }
    await fireJobResultCallback(input.onJobResult, failureResult)
    return failureResult
  }
}

/**
 * Invoke the caller's `onJobResult` hook and swallow any error it
 * throws. The runner treats notification emission as best-effort —
 * a bell-icon push should never be able to knock over a clone job,
 * and the terminal DB write has already persisted the ground-truth
 * state by the time this runs.
 */
async function fireJobResultCallback(
  cb: RunCloneProJobInput['onJobResult'],
  result: RunCloneProJobResult,
): Promise<void> {
  if (!cb) return
  try {
    await cb(result)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      '[clone-pro runner] onJobResult callback threw (ignored):',
      (err as Error).message,
    )
  }
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

export type ResumeCloneProJobResult =
  | { readonly status: 'resumed'; readonly fromStage: CloneStage }
  | { readonly status: 'not_resumable'; readonly reason: string }
  | { readonly status: 'already_finished' }

/**
 * Resume a previously-failed clone job by picking up at the first
 * `RESUMABLE_STAGES` entry that hasn't succeeded yet. Useful when the
 * pipeline crashed mid-brand-kit or mid-SEO and the user wants to
 * finish without re-downloading all the assets.
 *
 * Behaviour:
 *   - Reads `storefront_clone_jobs.stages_json` to determine the last
 *     stage that succeeded.
 *   - If that stage's successor is one of `apply_brand`, `seo_optimize`,
 *     or `finalize`, we run the pipeline with `resumeFromStage` set.
 *   - If the pipeline failed before any resumable stage (e.g. the
 *     crawl never finished), we return `{ status: 'not_resumable' }`
 *     — the caller should re-run the job from scratch.
 *   - If everything already succeeded, we return `{ status:
 *     'already_finished' }` without touching the DB.
 *
 * The underlying runner call behaves exactly like a normal run: it
 * writes stage updates to the job row and ends with a final
 * succeeded/failed status.
 */
export async function resumeCloneProJob(
  db: Kysely<Database>,
  input: { readonly shopId: string; readonly jobId: string },
): Promise<ResumeCloneProJobResult> {
  const job = await getStorefrontCloneJob(db, input)
  if (!job) {
    return { status: 'not_resumable', reason: 'job_not_found' }
  }

  if (job.status === 'succeeded') {
    return { status: 'already_finished' }
  }

  const existingStages = readStages(job)
  const resumeFrom = computeResumeFromStage(existingStages)

  if (!resumeFrom) {
    return {
      status: 'not_resumable',
      reason: 'no_resumable_stage_reached',
    }
  }

  if (!RESUMABLE_STAGES.has(resumeFrom)) {
    // Safety belt — `computeResumeFromStage` already filters for this,
    // but we double-check so a future regression can't silently mis-
    // route a job into an unsafe resume.
    return { status: 'not_resumable', reason: 'stage_not_resumable' }
  }

  // Fire-and-forget — the result is persisted on the job row.
  await runCloneProJob(db, {
    shopId: input.shopId,
    jobId: input.jobId,
    sourceUrl: job.source_url,
    resumeFromStage: resumeFrom,
  })

  return { status: 'resumed', fromStage: resumeFrom }
}
