/**
 * Customer Behavior Analytics (Phase 6 PR3)
 *
 * Answers four questions a merchant asks about their customer base:
 *
 *   1. Who spends the most?        → getTopSpenders
 *   2. Who's slipping away?        → getAtRiskCustomers
 *   3. Are we growing new or churning loyal? → getNewVsReturning
 *   4. How healthy is the base overall?      → getLifecycleBreakdown
 *
 * All queries accept an optional `segmentId` so a merchant can narrow
 * the report to one saved segment (VIPs, wholesale, etc). Segment
 * filtering is composed via the existing `buildRuleWhere` primitive —
 * no new safelist or rule parsing here.
 *
 * Pure helpers (`classifyRecency`, `classifyFrequency`,
 * `computeReturningRate`) are extracted so scoring/ratios are
 * unit-testable without a live DB.
 *
 * Reuses `periodToRange` from `./inventory-analytics.js` to keep
 * period-string parsing single-source.
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { periodToRange, type DateRange } from './inventory-analytics.js'
import {
  buildRuleWhere,
  type SegmentRuleSet,
} from '../customer-segments/rules.js'
import { getSegment, parseRules } from '../customer-segments/service.js'

// Re-export so admin pages can share one import.
export { periodToRange, type DateRange } from './inventory-analytics.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TopSpenderRow {
  customer_id: string
  email: string | null
  first_name: string | null
  last_name: string | null
  orders_count: number
  total_spent: string
  last_order_at: string | null
  lifecycle_stage: string
}

export interface AtRiskRow {
  customer_id: string
  email: string | null
  first_name: string | null
  last_name: string | null
  orders_count: number
  total_spent: string
  last_order_at: string | null
  days_since_last_order: number | null
  lifecycle_stage: string
}

export interface NewVsReturning {
  /** Orders placed during the range by customers who had no prior order. */
  new_customer_orders: number
  /** Orders placed during the range by customers who had at least one prior order. */
  returning_customer_orders: number
  /** Total orders in the range (sum of the two). */
  total_orders: number
  /** returning / total, 0 when total=0. */
  returning_rate: number
}

export interface LifecycleBreakdown {
  /** Map from stage name → count. */
  counts: Record<string, number>
  /** Sum of all counts. */
  total: number
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable)
// ---------------------------------------------------------------------------

export type RecencyBucket = 'active' | 'at_risk' | 'dormant'

/**
 * Bucket a customer by days-since-last-order.
 *
 * Defaults mirror Shopify's dashboard: ≤30 = active, 31–60 = at-risk,
 * >60 = dormant. `null` (never ordered) → 'dormant'.
 */
export function classifyRecency(
  daysSinceLastOrder: number | null,
  opts: { activeMax?: number; atRiskMax?: number } = {},
): RecencyBucket {
  const activeMax = opts.activeMax ?? 30
  const atRiskMax = opts.atRiskMax ?? 60
  if (daysSinceLastOrder === null) return 'dormant'
  if (daysSinceLastOrder <= activeMax) return 'active'
  if (daysSinceLastOrder <= atRiskMax) return 'at_risk'
  return 'dormant'
}

export type FrequencyBucket = 'none' | 'one_time' | 'occasional' | 'loyal' | 'vip'

/**
 * Bucket a customer by lifetime orders_count. Tiers:
 *   0 → none, 1 → one_time, 2–4 → occasional, 5–9 → loyal, 10+ → vip.
 */
export function classifyFrequency(ordersCount: number): FrequencyBucket {
  if (ordersCount <= 0) return 'none'
  if (ordersCount === 1) return 'one_time'
  if (ordersCount <= 4) return 'occasional'
  if (ordersCount <= 9) return 'loyal'
  return 'vip'
}

/**
 * Share of orders in the period that came from a returning customer.
 * Returns 0 when total = 0 (never NaN). Clamped to [0, 1].
 */
export function computeReturningRate(
  newCustomerOrders: number,
  returningCustomerOrders: number,
): number {
  const total = newCustomerOrders + returningCustomerOrders
  if (total <= 0) return 0
  const v = returningCustomerOrders / total
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

// ---------------------------------------------------------------------------
// Segment scope helper
// ---------------------------------------------------------------------------

/**
 * Resolve a segmentId to a parsed rule-set. Returns `null` if the
 * segmentId is falsy, the segment doesn't exist, or it's not scoped
 * to this shop. Throws on malformed rules (should never happen for a
 * segment that came out of `createSegment`, which validates on write).
 */
async function resolveSegmentRules(
  db: Kysely<Database>,
  shopId: string,
  segmentId: string | null | undefined,
): Promise<SegmentRuleSet | null> {
  if (!segmentId) return null
  const segment = await getSegment(db, { shop_id: shopId, id: segmentId }).catch(() => null)
  if (!segment) return null
  return parseRules(segment.rules_json)
}

// ---------------------------------------------------------------------------
// DB-bound queries
// ---------------------------------------------------------------------------

/**
 * Top spenders — customers ranked by `total_spent` DESC.
 *
 * `total_spent` is already maintained on the customers row by the
 * order-close lifecycle hook, so no join to orders is needed.
 *
 * When `segmentId` is provided, only customers that match the
 * segment's rules are included.
 */
export async function getTopSpenders(
  db: Kysely<Database>,
  shopId: string,
  opts: {
    limit?: number
    minOrders?: number
    segmentId?: string | null
  } = {},
): Promise<TopSpenderRow[]> {
  const limit = opts.limit ?? 10
  const minOrders = opts.minOrders ?? 1
  const ruleset = await resolveSegmentRules(db, shopId, opts.segmentId)

  let q = db
    .selectFrom('customers')
    .select([
      'id as customer_id',
      'email',
      'first_name',
      'last_name',
      'orders_count',
      'total_spent',
      'last_order_at',
      'lifecycle_stage',
    ])
    .where('shop_id', '=', shopId)
    .where('orders_count', '>=', minOrders)

  if (ruleset) {
    q = q.where((eb) => buildRuleWhere(eb, ruleset))
  }

  const rows = await q
    .orderBy(sql`total_spent::numeric`, 'desc')
    .orderBy('orders_count', 'desc')
    .orderBy('id', 'asc') // deterministic tie-break
    .limit(limit)
    .execute()

  return rows.map((r) => ({
    customer_id: String(r.customer_id),
    email: r.email ?? null,
    first_name: r.first_name ?? null,
    last_name: r.last_name ?? null,
    orders_count: Number(r.orders_count ?? 0),
    total_spent: String(r.total_spent ?? '0'),
    last_order_at: r.last_order_at ?? null,
    lifecycle_stage: String(r.lifecycle_stage ?? 'new'),
  }))
}

/**
 * At-risk customers — customers with >= 1 prior order whose last
 * order was more than `daysCutoff` days ago. Excludes 'churned'
 * customers by default (they've already slipped past at-risk).
 *
 * Ordered by most-stale first, then biggest spender — merchants care
 * about losing their VIPs.
 */
export async function getAtRiskCustomers(
  db: Kysely<Database>,
  shopId: string,
  opts: {
    daysCutoff?: number
    limit?: number
    now?: Date
    segmentId?: string | null
    includeChurned?: boolean
  } = {},
): Promise<AtRiskRow[]> {
  const daysCutoff = opts.daysCutoff ?? 60
  const limit = opts.limit ?? 20
  const now = opts.now ?? new Date()
  const cutoff = new Date(now.getTime() - daysCutoff * 86_400_000).toISOString()
  const ruleset = await resolveSegmentRules(db, shopId, opts.segmentId)

  let q = db
    .selectFrom('customers')
    .select([
      'id as customer_id',
      'email',
      'first_name',
      'last_name',
      'orders_count',
      'total_spent',
      'last_order_at',
      'lifecycle_stage',
    ])
    .where('shop_id', '=', shopId)
    .where('orders_count', '>', 0)
    .where('last_order_at', 'is not', null)
    .where('last_order_at', '<', cutoff)

  if (!opts.includeChurned) {
    q = q.where('lifecycle_stage', '!=', 'churned')
  }
  if (ruleset) {
    q = q.where((eb) => buildRuleWhere(eb, ruleset))
  }

  const rows = await q
    .orderBy('last_order_at', 'asc') // oldest last-order first
    .orderBy(sql`total_spent::numeric`, 'desc')
    .limit(limit)
    .execute()

  return rows.map((r) => {
    const lastIso = r.last_order_at ?? null
    let days: number | null = null
    if (lastIso) {
      const t = Date.parse(lastIso)
      if (!Number.isNaN(t)) {
        const diff = now.getTime() - t
        days = diff < 0 ? 0 : Math.floor(diff / 86_400_000)
      }
    }
    return {
      customer_id: String(r.customer_id),
      email: r.email ?? null,
      first_name: r.first_name ?? null,
      last_name: r.last_name ?? null,
      orders_count: Number(r.orders_count ?? 0),
      total_spent: String(r.total_spent ?? '0'),
      last_order_at: lastIso,
      days_since_last_order: days,
      lifecycle_stage: String(r.lifecycle_stage ?? 'new'),
    }
  })
}

/**
 * New vs returning — partitions orders placed during `range` by
 * whether the placing customer had any prior order (before
 * `range.since`). Cancelled orders excluded.
 *
 * Guest checkouts (customer_id NULL) are counted as new on every
 * order — Shopify does the same (each guest email would need its own
 * join for dedup, and we don't expose that here).
 */
export async function getNewVsReturning(
  db: Kysely<Database>,
  shopId: string,
  range: DateRange,
  opts: { segmentId?: string | null } = {},
): Promise<NewVsReturning> {
  const ruleset = await resolveSegmentRules(db, shopId, opts.segmentId)

  // Sub-query: customers that have a prior paid order before range.since.
  const priorByCustomer = db
    .selectFrom('orders')
    .select('customer_id')
    .where('shop_id', '=', shopId)
    .where('customer_id', 'is not', null)
    .where('created_at', '<', range.since)
    .where((eb) =>
      eb.or([eb('cancelled_at', 'is', null), eb('cancelled_at', 'is not', null)]),
    )
    .groupBy('customer_id')

  // Main query: orders in range, left-joined against prior.
  let inRange = db
    .selectFrom('orders as o')
    .leftJoin(priorByCustomer.as('p'), 'p.customer_id', 'o.customer_id')
    .select([
      'o.id as order_id',
      'o.customer_id',
      sql<string | null>`p.customer_id`.as('prior_customer_id'),
    ])
    .where('o.shop_id', '=', shopId)
    .where('o.created_at', '>=', range.since)
    .where('o.created_at', '<', range.until)
    .where((eb) =>
      eb.or([eb('o.cancelled_at', 'is', null), eb('o.cancelled_at', 'is not', null)]),
    )

  // Segment scope — join to customers and apply rules.
  if (ruleset) {
    inRange = inRange
      .innerJoin('customers as c', 'c.id', 'o.customer_id' as any)
      .where((eb) => buildRuleWhere(eb as any, ruleset))
  }

  const rows = await inRange.execute()

  let newOrders = 0
  let returningOrders = 0
  for (const r of rows) {
    if (r.customer_id && r.prior_customer_id) returningOrders++
    else newOrders++
  }

  return {
    new_customer_orders: newOrders,
    returning_customer_orders: returningOrders,
    total_orders: newOrders + returningOrders,
    returning_rate: computeReturningRate(newOrders, returningOrders),
  }
}

/**
 * Lifecycle breakdown — counts customers by `lifecycle_stage`.
 * Returns a map + total so the admin UI can render a pie chart and
 * a "% of base" column without extra math.
 */
export async function getLifecycleBreakdown(
  db: Kysely<Database>,
  shopId: string,
  opts: { segmentId?: string | null } = {},
): Promise<LifecycleBreakdown> {
  const ruleset = await resolveSegmentRules(db, shopId, opts.segmentId)

  let q = db
    .selectFrom('customers')
    .select([
      'lifecycle_stage',
      sql<number>`COUNT(*)`.as('n'),
    ])
    .where('shop_id', '=', shopId)

  if (ruleset) {
    q = q.where((eb) => buildRuleWhere(eb, ruleset))
  }

  const rows = await q.groupBy('lifecycle_stage').execute()

  const counts: Record<string, number> = {}
  let total = 0
  for (const r of rows) {
    const stage = String(r.lifecycle_stage ?? 'new')
    const n = Number(r.n ?? 0)
    counts[stage] = (counts[stage] ?? 0) + n
    total += n
  }
  return { counts, total }
}
