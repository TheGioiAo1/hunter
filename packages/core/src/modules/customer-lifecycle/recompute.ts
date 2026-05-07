/**
 * Customer lifecycle recompute service — Phase 4 PR3.
 *
 * Two entry points:
 *
 *   - recomputeOneCustomerLifecycle(db, customerId)
 *       Cheap single-row reclassification, meant to be called inline
 *       from write paths (createOrder, order-refund, customer-merge).
 *       Reads the current row, runs the classifier, writes back if the
 *       stage changed. No-op when the stage is already correct.
 *
 *   - recomputeAllLifecycleStages(db, opts?)
 *       Daily cron walker. Paginates through every customer (keyset on
 *       `id ASC`, 500 per page) and flips stale stages. Also lazily
 *       backfills `last_order_at` for any customer where it's still
 *       NULL but `orders_count > 0` — that shouldn't happen after PR3
 *       but the migration ships without a backfill, so the first cron
 *       run effectively finishes the migration on the live data.
 *
 * Keyset pagination, not OFFSET — on a 1M-row shop OFFSET 500_000 is
 * a full-table scan. `id ASC` + `WHERE id > lastId` is index-backed
 * (customers.id is the PK). We stop when a page returns fewer rows
 * than the batch size.
 */

import type { Kysely, Transaction } from 'kysely'
import { sql } from 'kysely'
import { classifyLifecycle, type LifecycleStage } from './classifier.js'

// 500 is a balance point: small enough to keep the pg write lock
// churning, large enough that the keyset loop doesn't dominate.
const DEFAULT_BATCH_SIZE = 500

/**
 * Recompute a single customer's stage and persist if it changed.
 * Returns the stage we *ended on* (or null if the customer doesn't
 * exist). Callers who just care about "did we change anything" can
 * compare against the passed-in prior value.
 *
 * Accepts Kysely or a Transaction so order-service can reuse it
 * mid-transaction after bumping orders_count.
 */
export async function recomputeOneCustomerLifecycle(
  db: Kysely<any> | Transaction<any>,
  customerId: string,
  opts?: { now?: Date },
): Promise<LifecycleStage | null> {
  const row = await db
    .selectFrom('customers')
    .select(['orders_count', 'last_order_at', 'lifecycle_stage'])
    .where('id', '=', customerId)
    .executeTakeFirst()

  if (!row) return null

  const nextStage = classifyLifecycle(
    {
      orders_count: Number(row.orders_count ?? 0),
      last_order_at: row.last_order_at ?? null,
    },
    opts?.now,
  )

  if (nextStage === row.lifecycle_stage) return nextStage

  await db
    .updateTable('customers')
    .set({ lifecycle_stage: nextStage } as any)
    .where('id', '=', customerId)
    .execute()

  return nextStage
}

/**
 * Daily cron body. Idempotent + safely re-runnable — every decision
 * comes from the current row state plus the injected `now`, so
 * running twice on the same day produces no net change after the
 * first pass.
 *
 * Returns counts for the cron's success log so we can tell whether
 * the job found real work or just spun.
 */
export async function recomputeAllLifecycleStages(
  db: Kysely<any>,
  opts?: { now?: Date; batchSize?: number; skipBackfill?: boolean },
): Promise<{ scanned: number; updated: number; backfilledLastOrderAt: number }> {
  const now = opts?.now ?? new Date()
  const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE

  // Step 1 — backfill any customer with orders but a null last_order_at.
  // We only do this once per-customer because after the UPDATE the row
  // no longer matches the WHERE clause. Doing it as one SQL pass is
  // orders-of-magnitude faster than per-row in JS.
  //
  // The `skipBackfill` flag lets unit tests bypass this raw-SQL step —
  // we assert the keyset-pagination loop instead. Live smoke on server
  // 2 exercises the real UPDATE.
  let backfilledLastOrderAt = 0
  if (!opts?.skipBackfill) {
    const backfillResult = await sql`
      UPDATE customers c
      SET last_order_at = sub.max_created_at
      FROM (
        SELECT customer_id, MAX(created_at) AS max_created_at
        FROM orders
        WHERE customer_id IS NOT NULL
        GROUP BY customer_id
      ) sub
      WHERE c.id = sub.customer_id
        AND c.last_order_at IS NULL
    `.execute(db)

    backfilledLastOrderAt = Number(
      (backfillResult as any)?.numAffectedRows ?? 0,
    )
  }

  // Step 2 — walk every customer in id-order and reclassify stale ones.
  let scanned = 0
  let updated = 0
  let lastId: string | null = null

  while (true) {
    let query = db
      .selectFrom('customers')
      .select(['id', 'orders_count', 'last_order_at', 'lifecycle_stage'])
      .orderBy('id', 'asc')
      .limit(batchSize)

    if (lastId !== null) {
      query = query.where('id', '>', lastId)
    }

    const rows = await query.execute()
    if (rows.length === 0) break

    for (const row of rows) {
      scanned++
      const nextStage = classifyLifecycle(
        {
          orders_count: Number(row.orders_count ?? 0),
          last_order_at: row.last_order_at ?? null,
        },
        now,
      )
      if (nextStage !== row.lifecycle_stage) {
        await db
          .updateTable('customers')
          .set({ lifecycle_stage: nextStage } as any)
          .where('id', '=', row.id)
          .execute()
        updated++
      }
    }

    lastId = String(rows[rows.length - 1].id)
    if (rows.length < batchSize) break
  }

  return { scanned, updated, backfilledLastOrderAt }
}
