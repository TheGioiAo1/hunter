/**
 * Audit Log Retention — Phase 0 §8 Item #6
 *
 * The `audit_logs` table is append-only and every request hits it via
 * the store-auth / god-auth middleware + every auth flow. Without a
 * retention policy it grows unbounded and eventually tanks query
 * latency (the existing `idx_audit_logs_created_at` stays small, but
 * the row count still bloats pg_stat and the WAL).
 *
 * This module provides a single function — `pruneAuditLogs` — that
 * deletes rows older than `olderThanDays` in bounded batches so the
 * cleanup can't take a long lock on a busy table. It is called by:
 *
 *   - `scripts/prune-audit-logs.ts` (server cron, runs daily)
 *   - `apps/god-admin` security page's manual "prune now" button
 *     (not implemented yet — Phase 2 Admin Polish)
 *
 * # Safety
 *
 * - Uses a `created_at < $1` filter with an existing index
 *   (`idx_audit_logs_created_at`) so the plan is always an index range
 *   scan, never a seq scan.
 * - Deletes in batches of `batchSize` rows (default 1000) and sleeps
 *   briefly between batches so long-running transactions aren't
 *   starved on the shared lock.
 * - `dryRun: true` reports the count that WOULD be deleted without
 *   touching the table. Always pair with a canary run before enabling
 *   cron.
 *
 * # Defaults
 *
 * - `olderThanDays = 365` (1 year). Configurable via
 *   `AUDIT_LOG_RETENTION_DAYS` in the cron script.
 * - `batchSize = 1000`
 * - `maxBatches = 100` (safety cap = 100k rows/run)
 *
 * If a single run hits `maxBatches` it returns `truncated: true` so
 * the caller can log a warning and schedule a second pass.
 */

import { sql, type Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

export interface PruneOptions {
  /** Delete rows where `created_at < (now - olderThanDays)`. Default: 365. */
  olderThanDays?: number
  /** How many rows to delete per batch. Default: 1000. */
  batchSize?: number
  /** Safety cap on total batches per run. Default: 100. */
  maxBatches?: number
  /** Milliseconds to sleep between batches. Default: 50. */
  sleepMs?: number
  /** Report-only mode — no DELETE issued. */
  dryRun?: boolean
}

export interface PruneResult {
  /** Timestamp cutoff that was applied. */
  cutoffIso: string
  /** Rows that match the cutoff (computed before DELETE in dry-run,
   *  summed from batches otherwise). */
  matched: number
  /** Rows actually deleted. Equals 0 on dry runs. */
  deleted: number
  /** True if we hit maxBatches and more rows still match the cutoff. */
  truncated: boolean
  /** Number of batches executed. */
  batches: number
  /** Total wall-clock ms spent in the prune loop. */
  durationMs: number
}

const DEFAULTS = {
  olderThanDays: 365,
  batchSize: 1000,
  maxBatches: 100,
  sleepMs: 50,
}

/**
 * Delete audit_logs rows older than `olderThanDays` in bounded batches.
 *
 * Safe to call concurrently from multiple workers — the DELETE uses
 * `ctid IN (SELECT ... LIMIT N)` which takes row-level locks, so two
 * concurrent prunes will interleave instead of stepping on each other.
 */
export async function pruneAuditLogs(
  db: Kysely<Database>,
  opts: PruneOptions = {},
): Promise<PruneResult> {
  const olderThanDays = opts.olderThanDays ?? DEFAULTS.olderThanDays
  const batchSize = opts.batchSize ?? DEFAULTS.batchSize
  const maxBatches = opts.maxBatches ?? DEFAULTS.maxBatches
  const sleepMs = opts.sleepMs ?? DEFAULTS.sleepMs
  const dryRun = opts.dryRun === true

  if (olderThanDays < 1) {
    throw new Error(
      `pruneAuditLogs: olderThanDays must be >= 1 (got ${olderThanDays}) — ` +
        `refusing to wipe recent audit trail`,
    )
  }
  if (batchSize < 1 || batchSize > 10000) {
    throw new Error(
      `pruneAuditLogs: batchSize must be in [1, 10000] (got ${batchSize})`,
    )
  }

  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
  const cutoffIso = cutoff.toISOString()
  const start = Date.now()

  // Always measure how many rows WOULD be deleted. Useful for monitoring
  // even when we're not in dry-run mode (we report `matched` vs
  // `deleted` so a truncated run is visible in logs).
  const countRow = await db
    .selectFrom('audit_logs')
    .where('created_at', '<', cutoffIso)
    .select(sql<string>`count(*)`.as('c'))
    .executeTakeFirst()
  const matched = Number(countRow?.c ?? 0)

  if (dryRun || matched === 0) {
    return {
      cutoffIso,
      matched,
      deleted: 0,
      truncated: false,
      batches: 0,
      durationMs: Date.now() - start,
    }
  }

  // Batched DELETE using ctid so each round takes row-level locks on a
  // bounded slice. Kysely doesn't model `ctid` so we drop to sql`` —
  // this is still type-checked by the inner selectFrom.
  let deleted = 0
  let batches = 0
  let truncated = false
  for (let i = 0; i < maxBatches; i++) {
    batches++
    const res = await sql<{ count: string }>`
      WITH victims AS (
        SELECT ctid
        FROM audit_logs
        WHERE created_at < ${cutoffIso}
        LIMIT ${batchSize}
      )
      DELETE FROM audit_logs
      WHERE ctid IN (SELECT ctid FROM victims)
    `.execute(db)

    const rowsThisBatch =
      typeof res.numAffectedRows === 'bigint'
        ? Number(res.numAffectedRows)
        : Number((res as unknown as { numUpdatedOrDeletedRows?: bigint })
            .numUpdatedOrDeletedRows ?? 0)

    deleted += rowsThisBatch

    if (rowsThisBatch < batchSize) {
      // Cleared the window. Stop early.
      break
    }
    if (i + 1 >= maxBatches) {
      // Hit the safety cap with rows still matching.
      truncated = true
      break
    }
    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs))
    }
  }

  return {
    cutoffIso,
    matched,
    deleted,
    truncated,
    batches,
    durationMs: Date.now() - start,
  }
}

/**
 * Quick stats for monitoring: total row count, oldest + newest
 * created_at. Used by the prune script's pre/post summary and by
 * Phase 2 Admin Polish dashboards.
 */
export async function getAuditLogStats(
  db: Kysely<Database>,
): Promise<{ total: number; oldestIso: string | null; newestIso: string | null }> {
  const row = await db
    .selectFrom('audit_logs')
    .select([
      sql<string>`count(*)`.as('total'),
      sql<string | null>`min(created_at)`.as('oldest'),
      sql<string | null>`max(created_at)`.as('newest'),
    ])
    .executeTakeFirst()

  return {
    total: Number(row?.total ?? 0),
    oldestIso: row?.oldest ? new Date(row.oldest).toISOString() : null,
    newestIso: row?.newest ? new Date(row.newest).toISOString() : null,
  }
}
