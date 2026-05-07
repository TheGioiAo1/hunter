/**
 * Clone Pro v5 — worker-side adapter
 *
 * Bridges the pure `runCloneProV5` orchestrator to the worker's job-row
 * state machine:
 *
 *   queued → running → (succeeded | failed)
 *
 * On success, the adapter persists:
 *   - grade letter + score into `storefront_clone_jobs.grade` / `.score`
 *   - preview_url + design_md into the existing columns
 *   - full pipeline result into `result_json` (existing JSONB column)
 *   - `finished_at = NOW()` so the UI stops showing the spinner
 *
 * On failure the adapter persists error_message + error_code and bubbles
 * `{ status: 'failed' }` back to the worker so its retry/notify branch
 * fires (we reuse the Phase 7 logic — the worker doesn't care which
 * pipeline version ran).
 *
 * The real pipeline wiring (scrapers, persisters, withSerializable) is
 * constructed lazily to keep this module importable without Kysely at
 * test time. The `_runPipeline` / `_updateStorefrontCloneJob` seams let
 * unit tests inject deterministic fakes.
 *
 * Iron Rule 5: errors coming out of this module feed the admin job row.
 * The seller-facing scrub happens at the UI layer — the raw message is
 * preserved here for admin-side diagnostics and support.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { PipelineResult, PipelineDeps } from './pipeline.js'
import { runCloneProV5 } from './pipeline.js'

export interface WiredRunInput {
  readonly shopId: string
  readonly jobId: string
  readonly sourceUrl: string
  readonly scope?: {
    readonly products?: boolean
    readonly collections?: boolean
    readonly pages?: boolean
    readonly menu?: boolean
    readonly theme?: boolean
  }
  /**
   * Test seam — override the full pipeline runner. Production callers
   * should NOT pass this; the adapter's default wiring assembles the
   * real scrapers + persisters + `withSerializable`.
   */
  readonly _runPipeline?: () => Promise<PipelineResult>
  /**
   * Test seam — override the job-row writer. Signature mirrors
   * `updateStorefrontCloneJob(db, jobId, patch)`. The full module
   * doesn't re-import the real helper here (leaves wiring to Task 21b
   * integration + the worker itself).
   */
  readonly _updateStorefrontCloneJob?: (
    db: Kysely<Database>,
    jobId: string,
    patch: Record<string, unknown>,
  ) => Promise<unknown>
  /**
   * Deps for the real pipeline when `_runPipeline` is not provided.
   * Worker wiring supplies real scrapers + persisters + verify here;
   * leaving them out means the pure runner is expected to be injected
   * via the test seam.
   */
  readonly _deps?: PipelineDeps
}

export interface WiredRunResult {
  readonly status: 'succeeded' | 'failed'
  readonly grade?: 'A' | 'B' | 'C' | 'D' | 'F'
  readonly score?: number
  readonly previewUrl?: string
  readonly errorMessage?: string
}

export async function runCloneProV5Wired(
  db: Kysely<Database>,
  input: WiredRunInput,
): Promise<WiredRunResult> {
  const updater =
    input._updateStorefrontCloneJob ??
    (async () => {
      // Default is a no-op. Worker wiring below (Task 21 step 2) uses
      // the real `updateStorefrontCloneJob` from storefront-clone/job-store.
      // The no-op guard keeps this module importable in unit tests
      // without pulling the whole job-store + its pg dep graph.
    })

  // 1) Mark running so the UI stepper lights up immediately.
  try {
    await updater(db, input.jobId, {
      status: 'running',
      startedAt: new Date().toISOString(),
      progressPct: 0,
      currentPhase: 1,
      substep: 'Detecting platform…',
    })
  } catch (err) {
    // If we can't even record running state, bail without touching the
    // pipeline — the worker will see status=failed and retry.
    return {
      status: 'failed',
      errorMessage: `failed to mark running: ${(err as Error).message}`,
    }
  }

  // 2) Run the pipeline (real or test-injected).
  let result: PipelineResult
  try {
    if (input._runPipeline) {
      result = await input._runPipeline()
    } else if (input._deps) {
      result = await runCloneProV5(
        {
          jobId: input.jobId,
          shopId: input.shopId,
          sourceUrl: input.sourceUrl,
          sourceHost: safeHost(input.sourceUrl),
          scope: {
            products: input.scope?.products ?? true,
            collections: input.scope?.collections ?? true,
            pages: input.scope?.pages ?? true,
            menu: input.scope?.menu ?? true,
            theme: input.scope?.theme ?? true,
          },
        },
        input._deps,
      )
    } else {
      throw new Error(
        'wired-runner: no pipeline runner provided (_runPipeline or _deps required)',
      )
    }
  } catch (err) {
    const message = (err as Error).message ?? 'pipeline failed'
    try {
      await updater(db, input.jobId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        errorCode: 'v5_pipeline_error',
        errorMessage: message,
      })
    } catch {
      // Non-fatal: caller still gets the failed result.
    }
    return { status: 'failed', errorMessage: message }
  }

  // 3) Persist terminal success — grade, score, preview, design_md, +
  // the full stats blob into result_json so the admin UI can render
  // everything without a second round trip.
  //
  // `storefront_clone_jobs.score` is a Postgres `smallint` (migration
  // 038), so we round to an integer for the column write. The 2-decimal
  // precision is preserved in `resultJson.grade.score` for admin UI
  // drill-down. This dual-representation keeps the list-view column
  // cheap to sort/filter on while still surfacing the full-precision
  // score in the per-job detail view.
  try {
    await updater(db, input.jobId, {
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
      progressPct: 100,
      grade: result.grade.letter,
      score: Math.round(result.grade.score),
      previewUrl: result.previewUrl,
      designMd: result.designMd,
      resultJson: {
        platform: result.platform,
        grade: result.grade,
        preview_url: result.previewUrl,
        design_md: result.designMd,
        stats: result.stats,
      },
    })
  } catch (err) {
    // The pipeline succeeded but we couldn't persist the success row.
    // Surface as failed so the worker retries — a successful re-run is
    // idempotent (every persister uses ON CONFLICT upserts).
    return {
      status: 'failed',
      errorMessage: `failed to persist success: ${(err as Error).message}`,
    }
  }

  return {
    status: 'succeeded',
    grade: result.grade.letter,
    score: result.grade.score,
    previewUrl: result.previewUrl,
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
