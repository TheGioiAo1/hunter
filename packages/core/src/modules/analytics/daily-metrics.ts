/**
 * Analytics — Pre-aggregated daily metrics (Phase 4.3.5)
 *
 * Dashboard used to run this on every page load:
 *
 *   SELECT SUM(total_price), COUNT(*) FROM orders
 *   WHERE shop_id = ? AND created_at >= now() - '30d'
 *
 * That is a full scan across the entire orders table for every merchant
 * for every dashboard load. At 5 merchants it's fine. At 500 merchants
 * × 6 tabs per merchant × 1 refresh/min it is an outage waiting to
 * happen.
 *
 * This module writes to / reads from `daily_metrics(shop_id, date,
 * orders_count, revenue, refunds, visitors, conversions, currency)`.
 *
 * Roll-up schedule:
 *   - Cron at 00:05 UTC nightly: fully aggregate the previous UTC day.
 *   - Optional hot-path: `incrementToday(shop_id, amount)` — called
 *     from checkout complete to keep "today" roughly accurate without
 *     waiting 24h.
 *
 * Consumers read with `getMetrics(shop_id, {since, until})`.
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database, DailyMetricTable } from '@gbox/db/schema/tables.js'
import { countDailyVisitors } from './page-views.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Selectable<T> = {
  [K in keyof T]: T[K] extends import('kysely').ColumnType<infer S, any, any>
    ? S
    : T[K]
}

export type DailyMetric = Selectable<DailyMetricTable>

export interface MetricsRange {
  /** ISO date (YYYY-MM-DD), inclusive. */
  since: string
  /** ISO date (YYYY-MM-DD), inclusive. */
  until: string
}

// ---------------------------------------------------------------------------
// Nightly roll-up
// ---------------------------------------------------------------------------

/**
 * Aggregate a single UTC day for a single shop from the live tables.
 * Idempotent — safe to re-run if the cron fires twice.
 */
export async function rollupDay(
  db: Kysely<Database>,
  shopId: string,
  isoDate: string,
): Promise<DailyMetric> {
  // Orders placed on this date.
  const orderAgg = await db
    .selectFrom('orders')
    .select([
      db.fn.countAll<number>().as('orders_count'),
      sql<string>`COALESCE(SUM(total_price::numeric), 0)`.as('revenue'),
      sql<string>`MAX(currency)`.as('currency'),
    ])
    .where('shop_id', '=', shopId)
    .where(sql<string>`DATE(created_at AT TIME ZONE 'UTC')`, '=', isoDate)
    .executeTakeFirstOrThrow()

  // Refunds issued on this date — the refund amount lives on the line
  // items (`subtotal + total_tax`) because the `refunds` header row
  // has no amount column.
  const refundAgg = await db
    .selectFrom('refunds')
    .innerJoin('orders', 'orders.id', 'refunds.order_id')
    .leftJoin(
      'refund_line_items',
      'refund_line_items.refund_id',
      'refunds.id',
    )
    .select([
      sql<string>`COALESCE(SUM(refund_line_items.subtotal::numeric + refund_line_items.total_tax::numeric), 0)`.as(
        'refunds',
      ),
    ])
    .where('orders.shop_id', '=', shopId)
    .where(
      sql<string>`DATE(refunds.created_at AT TIME ZONE 'UTC')`,
      '=',
      isoDate,
    )
    .executeTakeFirstOrThrow()
    .catch(() => ({ refunds: '0' }))

  // Visitors = distinct sessions from page_views table (migration 032).
  // Falls back to 0 if the table doesn't exist yet (pre-migration).
  let visitors = 0
  try {
    visitors = await countDailyVisitors(db, shopId, isoDate)
  } catch {
    // page_views table may not exist yet — graceful fallback.
  }

  // Conversions = completed checkout sessions for this shop on this date.
  // Each completed checkout is a conversion; the count matches orders_count
  // for well-behaved flows, but may differ when orders come from imports
  // or manual entry.
  let conversions = 0
  try {
    const convAgg = await db
      .selectFrom('checkout_sessions')
      .select(db.fn.countAll<number>().as('cnt'))
      .where('shop_id', '=', shopId)
      .where('state', '=', 'completed')
      .where(sql<string>`DATE(updated_at AT TIME ZONE 'UTC')`, '=', isoDate)
      .executeTakeFirst()
    conversions = Number(convAgg?.cnt ?? 0)
  } catch {
    // Graceful fallback.
  }

  const row = {
    shop_id: shopId,
    date: isoDate,
    orders_count: Number(orderAgg.orders_count) || 0,
    revenue: String(orderAgg.revenue ?? '0'),
    refunds: String(refundAgg.refunds ?? '0'),
    visitors,
    conversions,
    currency: orderAgg.currency || 'USD',
  }

  await db
    .insertInto('daily_metrics')
    .values(row as any)
    .onConflict((oc) =>
      oc.columns(['shop_id', 'date']).doUpdateSet({
        orders_count: row.orders_count,
        revenue: row.revenue,
        refunds: row.refunds,
        visitors: row.visitors,
        conversions: row.conversions,
        currency: row.currency,
        updated_at: new Date().toISOString(),
      } as any),
    )
    .execute()

  return row as unknown as DailyMetric
}

/**
 * Roll up yesterday for every active shop. Intended to be called from a
 * cron at 00:05 UTC.
 */
export async function rollupYesterdayAllShops(
  db: Kysely<Database>,
): Promise<number> {
  const yesterday = new Date()
  yesterday.setUTCDate(yesterday.getUTCDate() - 1)
  const iso = yesterday.toISOString().slice(0, 10)

  const shops = await db
    .selectFrom('shops')
    .select('id')
    .where('status', '=', 'active')
    .execute()

  let count = 0
  for (const shop of shops) {
    try {
      await rollupDay(db, shop.id, iso)
      count++
    } catch (err) {
      console.error(
        `[daily-metrics] rollup failed for shop ${shop.id}:`,
        (err as Error).message,
      )
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// Consistency — backfill gaps and prune old rows (Phase 6 PR4)
// ---------------------------------------------------------------------------

/**
 * Normalize a value that may be an ISO date string, an ISO timestamp, or
 * a JS `Date` (which is what pg returns for a `date` column) down to a
 * canonical YYYY-MM-DD. Returns `null` if the value can't be interpreted.
 *
 * Exported because the PG driver config for `daily_metrics.date` varies
 * between deployments (some set `pg-types` to return strings; default
 * behavior returns a Date object). Every read-path helper that groups
 * by date has to be robust to both.
 */
export function isoDay(value: unknown): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    return value.toISOString().slice(0, 10)
  }
  if (typeof value === 'string' && value.length >= 10) {
    const head = value.slice(0, 10)
    // Cheap YYYY-MM-DD format check — guards against Date.toString() output
    // like "Wed Apr 15 2026..." slipping through when pg returns a Date
    // that was coerced to string somewhere upstream.
    if (/^\d{4}-\d{2}-\d{2}$/.test(head)) return head
  }
  return null
}

/**
 * Pure: given a set of already-rolled-up dates and an inclusive
 * [since, until] window, return the dates that are missing. Exposed
 * for unit testing — the DB layer just wraps this.
 *
 * `existing` accepts strings and `Date` objects (pg driver default) —
 * anything that normalizes via `isoDay()`. Invalid entries are silently
 * ignored. Result is in ascending order.
 */
export function findMissingDates(
  existing: Iterable<string | Date | unknown>,
  since: string,
  until: string,
): string[] {
  if (since > until) return []
  const have = new Set<string>()
  for (const d of existing) {
    const iso = isoDay(d)
    if (iso !== null) have.add(iso)
  }
  const out: string[] = []
  const cursor = new Date(since + 'T00:00:00Z')
  const end = new Date(until + 'T00:00:00Z')
  while (cursor.getTime() <= end.getTime()) {
    const iso = cursor.toISOString().slice(0, 10)
    if (!have.has(iso)) out.push(iso)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}

/**
 * Backfill the rows that are missing between [since, until] for a single
 * shop. Unlike the CLI script, this is a library function the cron and
 * the platform-wide health checker both use. Existing rows are NOT
 * re-aggregated — that's what full `rollupDay` is for. This keeps
 * backfill cheap so it can run on a tighter cadence.
 *
 * Returns the list of dates that were rolled up (for logging) plus the
 * count of dates that already existed (skipped).
 */
export async function backfillMissingDays(
  db: Kysely<Database>,
  shopId: string,
  since: string,
  until: string,
): Promise<{ filled: string[]; existed: number }> {
  if (since > until) return { filled: [], existed: 0 }

  const rows = await db
    .selectFrom('daily_metrics')
    .select('date')
    .where('shop_id', '=', shopId)
    .where('date', '>=', since)
    .where('date', '<=', until)
    .execute()

  // pass raw `r.date` values — `findMissingDates` normalizes them
  // whether the pg driver returned Date objects or strings.
  const missing = findMissingDates(
    rows.map((r) => r.date as unknown),
    since,
    until,
  )

  const filled: string[] = []
  for (const iso of missing) {
    try {
      await rollupDay(db, shopId, iso)
      filled.push(iso)
    } catch (err) {
      console.error(
        `[daily-metrics] backfill failed for shop ${shopId} date ${iso}:`,
        (err as Error).message,
      )
    }
  }

  // existed = span - missing (filled + failed both count as "not already there")
  const spanDays = daysBetween(since, until)
  const existed = spanDays - missing.length
  return { filled, existed }
}

/** Days between ISO dates, inclusive. Undefined if `since > until`. */
function daysBetween(sinceIso: string, untilIso: string): number {
  if (sinceIso > untilIso) return 0
  const start = Date.UTC(
    Number(sinceIso.slice(0, 4)),
    Number(sinceIso.slice(5, 7)) - 1,
    Number(sinceIso.slice(8, 10)),
  )
  const end = Date.UTC(
    Number(untilIso.slice(0, 4)),
    Number(untilIso.slice(5, 7)) - 1,
    Number(untilIso.slice(8, 10)),
  )
  return Math.round((end - start) / 86_400_000) + 1
}

/**
 * Pure: compute the cut-off ISO date given a retention window and "now".
 * Rows whose `date` is *strictly older* than this cut-off are eligible
 * for deletion. Factored out so the cron handler and tests share one
 * source of truth on date math.
 */
export function computePruneCutoff(retainDays: number, now: Date = new Date()): string {
  const safe = Math.max(1, Math.floor(retainDays))
  const cutoff = new Date(now.getTime())
  cutoff.setUTCHours(0, 0, 0, 0)
  cutoff.setUTCDate(cutoff.getUTCDate() - safe)
  return cutoff.toISOString().slice(0, 10)
}

export interface PruneResult {
  deleted: number
  cutoff: string
}

/**
 * Delete daily_metrics rows older than `retainDays`. Default 400 days
 * (~13 months — enough to drive YoY comparison dashboards without
 * letting the table grow unbounded).
 *
 * Scoped or global: pass `shopId` to limit to one shop; omit to prune
 * across every shop. The cron calls the global form.
 */
export async function pruneOldMetrics(
  db: Kysely<Database>,
  opts: { retainDays?: number; shopId?: string; now?: Date } = {},
): Promise<PruneResult> {
  const retainDays = opts.retainDays ?? 400
  const cutoff = computePruneCutoff(retainDays, opts.now ?? new Date())

  let query = db.deleteFrom('daily_metrics').where('date', '<', cutoff)
  if (opts.shopId) query = query.where('shop_id', '=', opts.shopId)

  const res = await query.executeTakeFirst()
  return {
    deleted: Number(res.numDeletedRows ?? 0),
    cutoff,
  }
}

// ---------------------------------------------------------------------------
// Read path (dashboard)
// ---------------------------------------------------------------------------

export async function getMetrics(
  db: Kysely<Database>,
  shopId: string,
  range: MetricsRange,
): Promise<DailyMetric[]> {
  const rows = await db
    .selectFrom('daily_metrics')
    .selectAll()
    .where('shop_id', '=', shopId)
    .where('date', '>=', range.since)
    .where('date', '<=', range.until)
    .orderBy('date', 'asc')
    .execute()

  return rows as DailyMetric[]
}

export interface MetricsSummary {
  orders_count: number
  revenue: string
  refunds: string
  net_revenue: string
  currency: string
}

/**
 * Pure aggregation — sum an array of daily_metrics rows into a single
 * summary. Extracted from `getMetricsSummary` so it can be unit-tested
 * without a live database (PR1). Safe on an empty array (returns zeros
 * + 'USD' default).
 */
export function summarizeMetrics(rows: DailyMetric[]): MetricsSummary {
  const orders_count = rows.reduce((acc, r) => acc + Number(r.orders_count || 0), 0)
  const revenue = rows
    .reduce((acc, r) => acc + Number(r.revenue || 0), 0)
    .toFixed(2)
  const refunds = rows
    .reduce((acc, r) => acc + Number(r.refunds || 0), 0)
    .toFixed(2)
  const net_revenue = (Number(revenue) - Number(refunds)).toFixed(2)
  const currency = rows[0]?.currency || 'USD'

  return { orders_count, revenue, refunds, net_revenue, currency }
}

/**
 * Convenience — totals over a range. Used by dashboard cards like
 * "Revenue (last 30 days)".
 */
export async function getMetricsSummary(
  db: Kysely<Database>,
  shopId: string,
  range: MetricsRange,
): Promise<MetricsSummary> {
  const rows = await getMetrics(db, shopId, range)
  return summarizeMetrics(rows)
}

// ---------------------------------------------------------------------------
// Hot path — keep "today" roughly accurate without waiting for the cron
// ---------------------------------------------------------------------------

/**
 * Increment today's row for a shop. Called from order complete.
 * Uses ON CONFLICT to keep things atomic.
 */
export async function incrementToday(
  db: Kysely<Database>,
  shopId: string,
  amount: string,
  currency: string,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)

  await db
    .insertInto('daily_metrics')
    .values({
      shop_id: shopId,
      date: today,
      orders_count: 1,
      revenue: amount,
      refunds: '0',
      visitors: 0,
      conversions: 1,
      currency,
    } as any)
    .onConflict((oc) =>
      oc.columns(['shop_id', 'date']).doUpdateSet({
        orders_count: sql`daily_metrics.orders_count + 1`,
        revenue: sql`daily_metrics.revenue + ${amount}::numeric`,
        conversions: sql`daily_metrics.conversions + 1`,
        updated_at: new Date().toISOString(),
      } as any),
    )
    .execute()
}

/**
 * Bump today's visitor count. Called from the page-view recorder
 * when a genuinely new session is first seen for this shop today.
 * Fire-and-forget — errors are silently swallowed.
 */
export async function incrementVisitor(
  db: Kysely<Database>,
  shopId: string,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)

  await db
    .insertInto('daily_metrics')
    .values({
      shop_id: shopId,
      date: today,
      orders_count: 0,
      revenue: '0',
      refunds: '0',
      visitors: 1,
      conversions: 0,
      currency: 'USD',
    } as any)
    .onConflict((oc) =>
      oc.columns(['shop_id', 'date']).doUpdateSet({
        visitors: sql`daily_metrics.visitors + 1`,
        updated_at: new Date().toISOString(),
      } as any),
    )
    .execute()
}
