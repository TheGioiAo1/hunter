/**
 * Gbox Platform — support retention cleanup cron (Phase 12.5 PR5).
 *
 * Fires quarterly (registered as `support_retention_cleanup`). Soft-
 * archives tickets whose `closed_at` is older than the retention cutoff
 * (default 1 year — Q4.24). Records every run in
 * `support_retention_runs` so ops can reconstruct what happened on any
 * given quarter.
 *
 * MVP SCOPE (PR5):
 *   - mode='archive' is the default: sets `archived_at`, `archive_location`,
 *     `archive_manifest` on eligible rows. Rows become invisible to the
 *     default queries (every query in the support module filters
 *     `WHERE archived_at IS NULL`).
 *   - mode='dry_run' counts candidates WITHOUT touching the tickets —
 *     useful to preview the next real run from /god-admin.
 *   - mode='delete' and mode='archive_and_delete' are intentionally NOT
 *     wired yet. A future PR will build the S3/Glacier uploader then
 *     flip the default. Soft-archive first, measure actual usage, only
 *     then hard-delete.
 *
 * Archive location tag (`local_soft`) marks that the data still sits in
 * Postgres — when we wire S3 upload later, this becomes the S3 URI.
 *
 * IDEMPOTENCY: each run writes its own support_retention_runs row
 * (append-only). The archived_at WHERE clause on candidate selection
 * means a prior run's archived rows are automatically skipped by the
 * next one (they no longer satisfy `archived_at IS NULL`).
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000

export type RetentionMode = 'dry_run' | 'archive' | 'delete' | 'archive_and_delete'

export interface RetentionRunResult {
  runId: string
  mode: RetentionMode
  cutoffAt: string
  candidatesFound: number
  ticketsArchived: number
  ticketsDeleted: number
  durationMs: number
  error: string | null
}

export interface RunRetentionOpts {
  /** Override the now() (tests). */
  now?: Date
  /** Override retention window (ms); default = 1 year. */
  retentionMs?: number
  /** Override mode (default 'archive'). */
  mode?: RetentionMode
  /** Cap the candidates processed per tick. */
  batchLimit?: number
  /** Archive location tag (defaults to 'local_soft' until S3 lands). */
  archiveLocation?: string
  /** Who triggered this run. Cron leaves as null; /god-admin passes UUID. */
  triggeredBy?: string | null
}

/**
 * One retention sweep. Opens a run row BEFORE doing work (so a crash
 * mid-way leaves a half-populated row the operator can investigate),
 * archives up to `batchLimit` candidates, then stamps finish + totals.
 */
export async function runRetentionCleanup(
  db: Kysely<Database>,
  opts: RunRetentionOpts = {},
): Promise<RetentionRunResult> {
  const now = opts.now ?? new Date()
  const retentionMs = opts.retentionMs ?? ONE_YEAR_MS
  const mode = opts.mode ?? 'archive'
  const batchLimit = opts.batchLimit ?? 500
  const archiveLocation = opts.archiveLocation ?? 'local_soft'
  const triggeredBy = opts.triggeredBy ?? null

  const cutoffAt = new Date(now.getTime() - retentionMs).toISOString()
  const startedAt = now.toISOString()

  // 1. Open the run row.
  const runRow = await db
    .insertInto('support_retention_runs')
    .values({
      run_started_at: startedAt,
      cutoff_at: cutoffAt,
      mode,
      archive_location: mode === 'dry_run' ? null : archiveLocation,
      triggered_by: triggeredBy,
    } as any)
    .returning(['id'])
    .executeTakeFirstOrThrow()

  const runId = String(runRow.id)

  const result: RetentionRunResult = {
    runId,
    mode,
    cutoffAt,
    candidatesFound: 0,
    ticketsArchived: 0,
    ticketsDeleted: 0,
    durationMs: 0,
    error: null,
  }

  try {
    // 2. Select candidates. A ticket is a candidate when it is closed,
    //    the closed_at is older than the cutoff, and it's not already
    //    archived.
    const candidates = await db
      .selectFrom('support_tickets')
      .select(['id', 'shop_id', 'closed_at', 'subject', 'category'])
      .where('closed_at', 'is not', null)
      .where('closed_at', '<', cutoffAt)
      .where('archived_at', 'is', null)
      .orderBy('closed_at', 'asc')
      .limit(batchLimit)
      .execute()

    result.candidatesFound = candidates.length

    if (mode === 'dry_run' || candidates.length === 0) {
      await finaliseRun(db, runId, now, result)
      result.durationMs = Date.now() - now.getTime()
      return result
    }

    // 3. Archive each candidate in sequence. We don't bulk-update
    //    because we want per-row manifest entries and we don't expect
    //    more than a few hundred rows per quarter (shopping.tiki.vn
    //    scale; small ticket volume).
    for (const cand of candidates) {
      try {
        const manifest = {
          archivedAt: now.toISOString(),
          cutoffAt,
          runId,
          shopId: cand.shop_id,
          category: cand.category,
          subjectHash: hashSubject(cand.subject),
        }

        await db
          .updateTable('support_tickets')
          .set({
            archived_at: now.toISOString(),
            archive_location: archiveLocation,
            archive_manifest: JSON.stringify(manifest) as unknown as any,
          })
          .where('id', '=', cand.id)
          .where('archived_at', 'is', null)
          .execute()

        result.ticketsArchived++
      } catch (err) {
        // Don't bail the whole run on one bad row — log + keep going.
        // The run row will still get finalised below.
        console.warn(
          `[support-retention] failed to archive ticket ${cand.id}:`,
          err instanceof Error ? err.message : err,
        )
      }
    }

    await finaliseRun(db, runId, now, result)
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    await finaliseRun(db, runId, now, result)
  }

  result.durationMs = Date.now() - now.getTime()
  return result
}

// ── helpers ─────────────────────────────────────────────────────────────

async function finaliseRun(
  db: Kysely<Database>,
  runId: string,
  now: Date,
  result: RetentionRunResult,
): Promise<void> {
  try {
    await db
      .updateTable('support_retention_runs')
      .set({
        run_finished_at: now.toISOString(),
        candidates_found: result.candidatesFound,
        tickets_archived: result.ticketsArchived,
        tickets_deleted: result.ticketsDeleted,
        error_message: result.error,
      })
      .where('id', '=', runId as any)
      .execute()
  } catch (err) {
    // Non-fatal: operator can read the partial row if finalise fails.
    console.warn(
      `[support-retention] failed to finalise run ${runId}:`,
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * 8-hex-char stable fingerprint of the subject — enough to recognise
 * re-hydrated tickets without leaking raw text into the manifest. (MVP
 * uses DJB2 — no external dep. If we need collision resistance later,
 * swap for crypto.createHash('sha256').)
 */
function hashSubject(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
