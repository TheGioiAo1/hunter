/**
 * Gbox Platform — Email delivery zombie janitor (Phase 14 PR8, bug 9).
 *
 * WHAT THIS SOLVES
 * ----------------
 * `beginDelivery()` inserts a row with `status='queued'`. The handler then
 * calls the SMTP transport, and on success/failure flips the row to
 * `sent`/`failed`. A process crash between INSERT and the SMTP callback
 * leaves the row at `queued` forever — a zombie.
 *
 * Iron Rule 1 says we never lose data integrity. Pre-PR8, zombies:
 *   1. inflated the admin UI's "queued" counter forever
 *   2. caused the bug-8 idempotency fast-path to report ok:true on
 *      subsequent retries (even with the bug-8 fix, a zombie-queued row
 *      is classified as a "transport_failed zombie" — the caller sees an
 *      accurate failure, but the ORIGINAL queued row still needs reaping
 *      or the admin dashboard stays polluted)
 *   3. hid real SMTP outages: "120 queued" could mean "120 actually in
 *      flight" OR "120 orphaned from a month-ago crash"
 *
 * This janitor should run on a cron (every 5 minutes is fine). It finds
 * rows that have been in status='queued' for longer than the grace
 * period and flips them to status='failed' with a distinctive reason
 * string so ops can tell zombies apart from real SMTP failures.
 *
 * WHY NOT A DB TRANSACTION ACROSS SMTP?
 * -------------------------------------
 * A SERIALIZABLE tx spanning INSERT→SMTP→UPDATE would hold a row lock
 * across a network round-trip to Gmail (typical latency 200-800ms, tail
 * latencies into 5-30s on throttle days). That cascades into connection-
 * pool exhaustion on any concurrent traffic. The Shopify pattern — and
 * what we follow — is "write the intent, do the side effect, write the
 * result, reap what's lost" rather than "tx-wrap the side effect".
 *
 * DESIGN
 * ------
 * - Grace period default 10 minutes: well above p99 SMTP latency
 *   (Gmail's ~ 2s typical, 15s tail), below any cron's retry cadence.
 * - LIMIT per run: default 500 so a single invocation can't steal a
 *   connection slot for 30 seconds on a huge spill.
 * - Idempotent: running the janitor twice back-to-back is safe
 *   (the second run finds no matching rows).
 * - Never touches rows with other statuses — the failure reason filter
 *   is intentionally narrow so we can't accidentally flip a real 'sent'
 *   or 'failed' row.
 *
 * PURE vs I/O SPLIT
 * -----------------
 * `computeZombieCutoffIso()` is a pure function of (now, gracePeriod).
 * It's exported for unit testing without a DB harness. The DB-touching
 * `sweepZombieDeliveries()` calls it + runs the UPDATE.
 */

import { sql, type Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

/**
 * Default grace period — 10 minutes. Long enough that a slow Gmail
 * response won't be reaped mid-send; short enough that ops sees zombie
 * totals move within 15 minutes of a crash.
 */
export const DEFAULT_ZOMBIE_GRACE_MINUTES = 10

/**
 * The canonical reason string written to `failed_reason` when we reap a
 * zombie. Exposed as a constant so tests + the admin UI can match on it.
 *
 * Admin UI: when a delivery row has this exact reason we render a
 * different icon + a "process crashed" tooltip, not the generic
 * "SMTP rejected" copy.
 */
export const ZOMBIE_FAILED_REASON =
  'zombie: row stayed in queued past grace period — process likely crashed before SMTP result was recorded'

/**
 * Inputs accepted by `sweepZombieDeliveries`. Defaults are tuned for a
 * 5-minute cron with a 10-minute grace window. Tests override both.
 */
export interface SweepZombieDeliveriesInput {
  /**
   * A queued row is considered a zombie once `created_at` is older than
   * `now - gracePeriodMinutes`. Defaults to {@link DEFAULT_ZOMBIE_GRACE_MINUTES}.
   */
  gracePeriodMinutes?: number
  /**
   * Upper bound on rows reaped per invocation. Defaults to 500. The
   * admin UI's "run now" button passes a smaller value so the response
   * returns quickly.
   */
  limit?: number
  /**
   * Override the clock for tests. Must be an ISO-8601 string. In prod
   * we always use `new Date().toISOString()`.
   */
  nowIso?: string
}

/** Result returned to the cron / ops UI. */
export interface SweepZombieDeliveriesResult {
  /**
   * Number of rows flipped from queued → failed. Always zero on a
   * healthy production box; rises after a crash, falls back to zero as
   * successive sweeps clear the backlog.
   */
  swept: number
  /**
   * The exact ISO cutoff used. Included so ops can correlate this run
   * against their on-call graph ("we reaped 42 zombies older than
   * 2026-04-24T10:00:00Z").
   */
  cutoffIso: string
}

/**
 * Pure helper — returns the ISO cutoff string for the zombie filter.
 * Extracted so the time-arithmetic can be unit-tested without a DB.
 *
 * Rejects non-positive grace periods to avoid a configuration typo
 * ("0 minutes") eating every queued row in the database.
 */
export function computeZombieCutoffIso(
  nowIso: string,
  gracePeriodMinutes: number,
): string {
  if (!Number.isFinite(gracePeriodMinutes) || gracePeriodMinutes <= 0) {
    throw new Error(
      `computeZombieCutoffIso: gracePeriodMinutes must be > 0 (got ${gracePeriodMinutes})`,
    )
  }
  const now = new Date(nowIso)
  if (Number.isNaN(now.getTime())) {
    throw new Error(`computeZombieCutoffIso: invalid nowIso '${nowIso}'`)
  }
  const cutoff = new Date(now.getTime() - gracePeriodMinutes * 60 * 1000)
  return cutoff.toISOString()
}

/**
 * Flip queued rows older than the cutoff to status='failed' with a
 * distinctive reason + failed_at stamp. Always safe to run — the
 * narrow WHERE clause ensures we never touch non-queued rows.
 *
 * Returns the number of rows swept + the cutoff used, so the caller
 * (cron / admin UI) can log + surface to ops.
 */
export async function sweepZombieDeliveries(
  db: Kysely<Database>,
  input: SweepZombieDeliveriesInput = {},
): Promise<SweepZombieDeliveriesResult> {
  const gracePeriodMinutes =
    input.gracePeriodMinutes ?? DEFAULT_ZOMBIE_GRACE_MINUTES
  const limit = input.limit ?? 500
  const nowIso = input.nowIso ?? new Date().toISOString()
  const cutoffIso = computeZombieCutoffIso(nowIso, gracePeriodMinutes)

  // Kysely can't express UPDATE … WHERE id IN (SELECT … LIMIT …) as a
  // first-class builder call without dialect-specific hacks, so we drop
  // to a raw CTE. No user input lands in the fragment — all params are
  // bound through `sql` placeholders. Postgres-specific.
  const rows = await sql<{ id: number }>`
    WITH to_sweep AS (
      SELECT id
      FROM email_deliveries
      WHERE status = 'queued'
        AND created_at < ${cutoffIso}
      ORDER BY created_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE email_deliveries AS ed
    SET
      status = 'failed',
      failed_at = ${nowIso},
      failed_reason = ${ZOMBIE_FAILED_REASON}
    FROM to_sweep
    WHERE ed.id = to_sweep.id
    RETURNING ed.id
  `.execute(db)

  return {
    swept: rows.rows.length,
    cutoffIso,
  }
}
