/**
 * Clone Pro — Resume helpers
 *
 * Clone jobs are long-running (10-30 min for a full clone). When a job
 * fails mid-flight — network blip, AI provider outage, Worker CPU
 * limit — we want the user to be able to pick up where they left off
 * instead of re-running the whole thing.
 *
 * Not every stage is safe to resume individually though. Early stages
 * (crawl → extract_design → extract_content → generate_theme →
 * import_data → ingest_media) read in-memory state from the previous
 * stage and would have to recompute it all to resume standalone. Late
 * stages (apply_brand, seo_optimize, finalize) only read from the DB
 * and `config.sourceUrl`, so they can run in isolation.
 *
 * V1 resume therefore only allows "jumping forward" to one of the
 * `RESUMABLE_STAGES`. If a job failed before that point, the whole
 * thing must be re-run from the top — the previous work on
 * products/pages/images is still idempotent (insert-or-update), so
 * re-running is safe.
 *
 * V2 (future): persist intermediate blobs (crawlResult, scrapedPages,
 * etc.) to the DB or blob store so that any stage can be resumed.
 */

import type { CloneJobStageEntry } from '@gbox/db/schema/tables.js'
import type { CloneStage } from './types.js'

// Re-exported so consumers (store-admin clone-pro detail page) can import
// the type without reaching into @gbox/db's internal schema path.
export type { CloneJobStageEntry }

// ---------------------------------------------------------------------------
// Canonical stage order
// ---------------------------------------------------------------------------

/**
 * The pipeline runs these stages in this order. Index into this array
 * gives us a cheap "before/after" check (stage A runs before stage B
 * iff INDEX[A] < INDEX[B]).
 */
export const CLONE_STAGES_ORDER: readonly CloneStage[] = [
  'detect',
  'crawl',
  'extract_design',
  'extract_content',
  'generate_theme',
  'import_data',
  'ingest_media',
  'apply_brand',
  'seo_optimize',
  'finalize',
]

const STAGE_INDEX: ReadonlyMap<CloneStage, number> = new Map(
  CLONE_STAGES_ORDER.map((s, i) => [s, i]),
)

/**
 * Stages that can be resumed in isolation — i.e. they read only from
 * the DB + config, not from in-memory state left behind by earlier
 * stages. Keep this set deliberately small; expanding it requires
 * persisting more intermediate state.
 */
export const RESUMABLE_STAGES: ReadonlySet<CloneStage> = new Set<CloneStage>([
  'apply_brand',
  'seo_optimize',
  'finalize',
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True iff the pipeline can legally be resumed starting at `stage`.
 * Throwing callers should use `assertResumable` instead.
 */
export function isResumableStage(stage: CloneStage): boolean {
  return RESUMABLE_STAGES.has(stage)
}

/**
 * Order-comparing predicate: does `a` come strictly before `b` in the
 * pipeline? Unknown stages return false.
 */
export function stageIsBefore(a: CloneStage, b: CloneStage): boolean {
  const ai = STAGE_INDEX.get(a)
  const bi = STAGE_INDEX.get(b)
  if (ai === undefined || bi === undefined) return false
  return ai < bi
}

/**
 * Given the `stages_json` array from a failed / cancelled job, pick
 * the stage we'd recommend resuming from. The rules:
 *
 *   1. Find the last stage that was 'succeeded' or 'skipped'.
 *   2. The candidate resume point is the stage immediately after it.
 *   3. If that candidate is in RESUMABLE_STAGES, return it.
 *   4. Otherwise return null — meaning "a clean re-run is required".
 *
 * Passing an empty array or a job that never got past the first few
 * stages always returns null.
 */
export function computeResumeFromStage(
  stages: readonly CloneJobStageEntry[],
): CloneStage | null {
  if (stages.length === 0) return null

  // Find the highest-indexed stage that finished OK (succeeded or skipped).
  let lastGoodIndex = -1
  for (const entry of stages) {
    if (entry.status !== 'succeeded' && entry.status !== 'skipped') continue
    const idx = STAGE_INDEX.get(entry.stage as CloneStage)
    if (idx === undefined) continue
    if (idx > lastGoodIndex) lastGoodIndex = idx
  }

  if (lastGoodIndex < 0) return null

  const nextIndex = lastGoodIndex + 1
  if (nextIndex >= CLONE_STAGES_ORDER.length) {
    // Everything already finished — nothing left to resume.
    return null
  }

  const candidate = CLONE_STAGES_ORDER[nextIndex]!
  return RESUMABLE_STAGES.has(candidate) ? candidate : null
}
