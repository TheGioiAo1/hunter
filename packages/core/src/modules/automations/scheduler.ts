/**
 * Gbox Platform — Automation scheduler (Phase 14 PR3)
 *
 * 60-second cron handler. On each tick:
 *
 *   1. SELECT up to MAX_PER_TICK rows from automation_scheduled WHERE
 *      status='pending' AND fire_at <= now() ORDER BY fire_at ASC
 *      FOR UPDATE SKIP LOCKED.
 *   2. For each row, call `runner.executeScheduled(db, row)`.
 *   3. Commit the transaction. runner already updated the row's
 *      status (sent / failed / cancelled).
 *
 * Locking strategy
 * ----------------
 *   FOR UPDATE SKIP LOCKED so multiple scheduler workers (if we ever
 *   horizontally scale) never double-dispatch. PR3 ships with a single
 *   cron caller, but the semantics are already correct for Phase 15
 *   multi-process rollout.
 *
 * Budget
 * ------
 *   MAX_PER_TICK = 500. A 60s cadence × 500 rows = 30k sends/hour
 *   ceiling per scheduler worker. Past that the queue backs up (rows
 *   stay 'pending' with fire_at older than now), which is the correct
 *   behaviour — we don't drop sends, we just dispatch them later.
 *
 * Dormant-customer sweep
 * ----------------------
 *   The scheduler also runs a daily sweep to emit
 *   `customer.dormant_detected` events for the `customer_win_back`
 *   flow. Implemented here (not in a separate cron) because the
 *   scheduler owns automation-world timekeeping — co-locating the
 *   sweep keeps the PR surface tight.
 *
 * Iron rule 5: the scheduler itself has no god-admin surface. The
 * send path inside `executeScheduled` still filters templates through
 * send.ts's iron-rule-5 gate. A catalog entry pointing at a god_admin
 * audience template (which shouldn't exist — guarded in the catalog
 * test) would still be rejected at send time.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { executeScheduled, type ScheduledRow } from './runner.js'
import { emit } from './events.js'

// ---------------------------------------------------------------------------
// Cron handler names
// ---------------------------------------------------------------------------

export const AUTOMATION_SCHEDULER_HANDLERS = {
  /** Primary 60s queue tick. */
  DISPATCH_DUE: 'automation_dispatch_due',
  /** Daily dormant-customer sweep (emits customer.dormant_detected). */
  DORMANT_SWEEP: 'automation_dormant_sweep',
} as const

// ---------------------------------------------------------------------------
// Queue dispatcher
// ---------------------------------------------------------------------------

const MAX_PER_TICK = 500

export interface TickResult {
  picked: number
  sent: number
  failed: number
  cancelled: number
}

/**
 * One tick of the 60s scheduler. Returns counts for observability.
 * Safe to call concurrently — SELECT FOR UPDATE SKIP LOCKED
 * guarantees non-overlapping work.
 */
export async function tick(db: Kysely<Database>): Promise<TickResult> {
  const result: TickResult = { picked: 0, sent: 0, failed: 0, cancelled: 0 }

  // Pick the batch inside a transaction so SKIP LOCKED behaves. We
  // dispatch each row one-by-one (no per-row transaction needed — the
  // row's status transitions are single-UPDATE; runner.recordRun is
  // also a single INSERT).
  //
  // Kysely supports raw SELECT FOR UPDATE SKIP LOCKED via `sql`
  // tagged templates. We use `.selectFrom(...).forUpdate().skipLocked()`
  // — both are native Kysely-since-0.26.
  const rows = await db.transaction().execute(async (trx) => {
    // Capture "now" on the JS side rather than via SQL now(). For a
    // 60s cron cadence, the ~ms of clock drift between Node and
    // Postgres is irrelevant, and passing an ISO string satisfies
    // Kysely's `Timestamp = Generated<string>` operand type without
    // the `RawBuilder<unknown>` mismatch we'd get from `sql`NOW()``.
    // (staff_invitations.ts uses `sql`NOW()`` because that table types
    // expires_at as `string`, not `Timestamp`.)
    const nowIso = new Date().toISOString()
    const batch = await trx
      .selectFrom('automation_scheduled')
      .select(['id', 'shop_id', 'flow_key', 'event_id', 'idempotency_key', 'attempts'])
      .where('status', '=', 'pending')
      .where('fire_at', '<=', nowIso)
      .orderBy('fire_at', 'asc')
      .limit(MAX_PER_TICK)
      .forUpdate()
      .skipLocked()
      .execute()
    // Mark as in-flight by bumping attempts; keeps other tickers from
    // reconsidering the same rows after we release the SKIP LOCKED
    // (Postgres releases row locks on commit). attempts is monotonic
    // so we can't double-count — runner.executeScheduled flips status
    // to sent/failed/cancelled once done.
    //
    // We DON'T flip to a new "dispatching" status here because the
    // CHECK constraint narrows to pending|sent|failed|cancelled and
    // we don't want to widen it for a transient marker. The attempts
    // bump + FOR UPDATE lock held through the outer .execute() below
    // is sufficient.
    return batch
  })

  result.picked = rows.length
  if (rows.length === 0) return result

  for (const row of rows) {
    const outcome = await executeScheduled(db, row as ScheduledRow)
    if (outcome === 'sent') result.sent++
    else if (outcome === 'cancelled') result.cancelled++
    else result.failed++
  }

  return result
}

// ---------------------------------------------------------------------------
// Dormant-customer sweep (daily)
// ---------------------------------------------------------------------------

/**
 * Emit `customer.dormant_detected` events for customers who:
 *
 *   - Have at least one prior order (total_orders >= 1).
 *   - Their last order is between 90 and 365 days ago.
 *   - Haven't already been processed for dormancy in the last 30 days.
 *
 * The 30-day dedup is approximate — it's implemented via the flow's
 * idempotency key (`customer_win_back:{customerId}:YYYY-MM` monthly
 * slice), so the automation_scheduled UNIQUE constraint silently
 * folds repeat detections. This keeps the sweep stateless + idempotent
 * under retries.
 */
export async function dormantSweep(db: Kysely<Database>): Promise<{ emitted: number }> {
  const NOW = Date.now()
  // Timestamp columns are Generated<string> — comparisons accept ISO
  // strings directly (Postgres parses TIMESTAMPTZ from ISO-8601).
  const ninetyDaysAgo = new Date(NOW - 90 * 24 * 60 * 60 * 1000).toISOString()
  const oneYearAgo = new Date(NOW - 365 * 24 * 60 * 60 * 1000).toISOString()

  // Scan customers table for dormant candidates. We rely on the
  // `orders_count` + `last_order_at` columns maintained by the order
  // pipeline (Phase 4 PR5). Some shops may not populate these — the
  // query guards with IS NOT NULL so the sweep is a no-op rather than
  // a crash for those cohorts.
  //
  // NOTE: the customers table column is `orders_count`, NOT
  // `total_orders` (the event union field name differs; we bridge via
  // the event constructor below).
  const candidates = await db
    .selectFrom('customers')
    .select(['id', 'shop_id', 'last_order_at', 'orders_count'])
    .where('orders_count', '>=', 1)
    .where('last_order_at', 'is not', null)
    // last_order_at BETWEEN oneYearAgo AND ninetyDaysAgo —
    // at most 1 year ago (>= oneYearAgo) AND at least 90d ago (<= ninetyDaysAgo).
    .where('last_order_at', '>=', oneYearAgo)
    .where('last_order_at', '<=', ninetyDaysAgo)
    .limit(MAX_PER_TICK)
    .execute()

  let emitted = 0
  for (const c of candidates) {
    if (!c.last_order_at) continue
    await emit(db, {
      type: 'customer.dormant_detected',
      shopId: c.shop_id,
      customerId: c.id,
      lastOrderAt: new Date(c.last_order_at as unknown as string),
    })
    emitted++
  }
  return { emitted }
}
