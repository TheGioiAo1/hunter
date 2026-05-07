/**
 * Analytics — Measurement Queries (M4 — Dashboards v2)
 *
 * Purpose-built query helpers for the four new analytics dashboards:
 *
 *   - getTrafficSources    /analytics/traffic
 *   - getConversionFunnel  /analytics/funnel       (M4.2 — supersedes service.getConversionFunnel)
 *   - getUtmAttribution    /analytics/attribution
 *   - getCohortRetention   /analytics/cohort
 *
 * Every query accepts `storeIds: string[]` so the caller can scope to
 * one shop or aggregate across a portfolio (the Analytics Dashboard's
 * "All stores" toggle). Tenancy is always enforced via
 * `WHERE shop_id IN (storeIds)` — the caller is responsible for
 * validating which shops the user can legitimately see.
 *
 * Date range: `{ sinceIso, untilIso }` as ISO-8601 strings. `sinceIso`
 * is inclusive, `untilIso` is exclusive — matches the convention in
 * `apps/store-admin/src/pages/analytics.ts` overviewPeriod().
 *
 * Attribution model note:
 *   - `orders.utm_source` is stamped from the `gbox_utm` first-touch
 *     cookie at checkout completion, so it is effectively FIRST-TOUCH
 *     attribution (the UTM seen on the merchant's first visit that
 *     seeded the 30-day cookie).
 *   - `page_views.utm_source` is stamped per-visit, so aggregating
 *     page_views gives us the LAST-TOUCH traffic signal (which source
 *     actually drove the visit that preceded the conversion — though
 *     we can't hard-link a page_view session to an order without a
 *     customer_id on page_views, so we surface this as session traffic
 *     by source rather than last-touch revenue).
 */

import type { Kysely } from 'kysely'
import { sql, type SqlBool } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnalyticsRange {
  /** ISO-8601 timestamp, inclusive. */
  readonly sinceIso: string
  /** ISO-8601 timestamp, exclusive. */
  readonly untilIso: string
}

export interface TrafficSourceRow {
  readonly source: string   // e.g. "google" | "(direct)" | "facebook"
  readonly medium: string   // e.g. "cpc" | "organic" | "(none)"
  readonly sessions: number
  readonly pageviews: number
  readonly orders: number
  readonly revenue: number
  readonly conversionRate: number  // orders / sessions, 0..1
}

export interface FunnelRow {
  readonly stage: 'visitors' | 'add_to_cart' | 'checkout_start' | 'purchase'
  readonly label: string
  readonly count: number
  readonly pctOfPrior: number   // 0..1, 1 for the first stage
  readonly pctOfTop: number     // 0..1, 1 for the first stage
}

export interface AttributionRow {
  readonly source: string
  readonly medium: string
  readonly campaign: string | null
  readonly orders: number
  readonly revenue: number
  readonly avgOrderValue: number
  /** First-touch because orders.utm_* is stamped from the 30-day cookie. */
  readonly model: 'first_touch'
}

export interface CohortCell {
  readonly cohortMonth: string    // 'YYYY-MM-01'
  readonly monthOffset: number    // 0 = cohort month itself, 1 = one month later, etc.
  readonly customers: number      // distinct customers still purchasing
}

export interface CohortReport {
  readonly cohorts: readonly {
    readonly month: string              // 'YYYY-MM-01'
    readonly size: number               // customers who first purchased this month
    readonly retention: readonly {
      readonly offset: number
      readonly customers: number
      readonly rate: number             // customers / cohort size
    }[]
  }[]
  readonly maxOffset: number
}

// ---------------------------------------------------------------------------
// M4.1 — Traffic Sources
// ---------------------------------------------------------------------------

/**
 * Traffic sources report: how many sessions / orders / revenue came
 * from each `utm_source` + `utm_medium` combination.
 *
 * Join strategy: we compute sessions from `page_views` and orders
 * from `orders` separately, then merge by `(source, medium)` key in
 * JS. A SQL-level join would multiply out incorrectly because the
 * orders table has no session_id.
 */
export async function getTrafficSources(
  db: Kysely<Database>,
  storeIds: readonly string[],
  range: AnalyticsRange,
  limit = 50,
): Promise<TrafficSourceRow[]> {
  if (storeIds.length === 0) return []

  const [sessionRows, orderRows] = await Promise.all([
    db
      .selectFrom('page_views')
      .select([
        sql<string>`COALESCE(utm_source, '(direct)')`.as('source'),
        sql<string>`COALESCE(utm_medium, '(none)')`.as('medium'),
        sql<number>`COUNT(DISTINCT session_id)`.as('sessions'),
        sql<number>`COUNT(*)`.as('pageviews'),
      ])
      .where('shop_id', 'in', storeIds as string[])
      .where('created_at', '>=', range.sinceIso)
      .where('created_at', '<', range.untilIso)
      .groupBy(sql`COALESCE(utm_source, '(direct)'), COALESCE(utm_medium, '(none)')`)
      .execute(),

    db
      .selectFrom('orders')
      .select([
        sql<string>`COALESCE(utm_source, '(direct)')`.as('source'),
        sql<string>`COALESCE(utm_medium, '(none)')`.as('medium'),
        sql<number>`COUNT(*)`.as('orders'),
        sql<string>`COALESCE(SUM(total_price::numeric), 0)`.as('revenue'),
      ])
      .where('shop_id', 'in', storeIds as string[])
      .where('created_at', '>=', range.sinceIso)
      .where('created_at', '<', range.untilIso)
      .where('financial_status', '!=', 'voided')
      .groupBy(sql`COALESCE(utm_source, '(direct)'), COALESCE(utm_medium, '(none)')`)
      .execute(),
  ])

  return mergeTrafficSources(
    sessionRows.map(r => ({
      source: String(r.source),
      medium: String(r.medium),
      sessions: Number(r.sessions),
      pageviews: Number(r.pageviews),
    })),
    orderRows.map(r => ({
      source: String(r.source),
      medium: String(r.medium),
      orders: Number(r.orders),
      revenue: Number(r.revenue),
    })),
    limit,
  )
}

/**
 * Pure merge+sort logic for `getTrafficSources`. Exported for unit
 * testing — keeps the DB layer thin.
 */
export function mergeTrafficSources(
  sessionRows: readonly { source: string; medium: string; sessions: number; pageviews: number }[],
  orderRows: readonly { source: string; medium: string; orders: number; revenue: number }[],
  limit: number,
): TrafficSourceRow[] {
  const key = (s: string, m: string) => `${s}|${m}`
  const merged = new Map<string, TrafficSourceRow>()

  for (const r of sessionRows) {
    merged.set(key(r.source, r.medium), {
      source: r.source,
      medium: r.medium,
      sessions: r.sessions,
      pageviews: r.pageviews,
      orders: 0,
      revenue: 0,
      conversionRate: 0,
    })
  }

  for (const r of orderRows) {
    const k = key(r.source, r.medium)
    const existing = merged.get(k)
    if (existing) {
      merged.set(k, {
        ...existing,
        orders: r.orders,
        revenue: r.revenue,
        conversionRate: existing.sessions > 0 ? r.orders / existing.sessions : 0,
      })
    } else {
      // Orders with a UTM value never seen in page_views (e.g. imported
      // orders or historical rows) — still surface so revenue is
      // fully accounted for.
      merged.set(k, {
        source: r.source,
        medium: r.medium,
        sessions: 0,
        pageviews: 0,
        orders: r.orders,
        revenue: r.revenue,
        conversionRate: 0,
      })
    }
  }

  const rows = Array.from(merged.values())
  rows.sort((a, b) => {
    if (b.sessions !== a.sessions) return b.sessions - a.sessions
    return b.revenue - a.revenue
  })
  return rows.slice(0, limit)
}

// ---------------------------------------------------------------------------
// M4.2 — Conversion Funnel v2
// ---------------------------------------------------------------------------

/**
 * 4-stage conversion funnel: visitors → add_to_cart → checkout_start
 * → purchase. Visitors come from `page_views` (distinct session_id),
 * the middle two stages come from the generic `events` table, and
 * purchases come from `orders` (so the funnel always matches the real
 * revenue number on the other dashboards).
 */
export async function getConversionFunnel(
  db: Kysely<Database>,
  storeIds: readonly string[],
  range: AnalyticsRange,
): Promise<readonly FunnelRow[]> {
  if (storeIds.length === 0) {
    return buildFunnel(0, 0, 0, 0)
  }

  const [visitorsRow, eventsRows, ordersRow] = await Promise.all([
    db
      .selectFrom('page_views')
      .select(sql<number>`COUNT(DISTINCT session_id)`.as('cnt'))
      .where('shop_id', 'in', storeIds as string[])
      .where('created_at', '>=', range.sinceIso)
      .where('created_at', '<', range.untilIso)
      .executeTakeFirst(),

    db
      .selectFrom('events')
      .select([
        'verb',
        sql<number>`COUNT(DISTINCT subject_id)`.as('cnt'),
      ])
      .where('shop_id', 'in', storeIds as string[])
      .where('verb', 'in', ['add_to_cart', 'checkout_start'])
      .where('created_at', '>=', range.sinceIso)
      .where('created_at', '<', range.untilIso)
      .groupBy('verb')
      .execute(),

    db
      .selectFrom('orders')
      .select(sql<number>`COUNT(*)`.as('cnt'))
      .where('shop_id', 'in', storeIds as string[])
      .where('created_at', '>=', range.sinceIso)
      .where('created_at', '<', range.untilIso)
      .where('financial_status', '!=', 'voided')
      .executeTakeFirst(),
  ])

  const verbCounts = new Map<string, number>()
  for (const r of eventsRows) {
    verbCounts.set(r.verb, Number(r.cnt))
  }

  return buildFunnel(
    Number(visitorsRow?.cnt ?? 0),
    verbCounts.get('add_to_cart') ?? 0,
    verbCounts.get('checkout_start') ?? 0,
    Number(ordersRow?.cnt ?? 0),
  )
}

/**
 * Pure funnel builder. Exported for unit testing.
 * @internal
 */
export function buildFunnel(
  visitors: number,
  addToCart: number,
  checkoutStart: number,
  purchase: number,
): readonly FunnelRow[] {
  const stages: Array<{ stage: FunnelRow['stage']; label: string; count: number }> = [
    { stage: 'visitors', label: 'Visitors', count: visitors },
    { stage: 'add_to_cart', label: 'Add to cart', count: addToCart },
    { stage: 'checkout_start', label: 'Reached checkout', count: checkoutStart },
    { stage: 'purchase', label: 'Purchased', count: purchase },
  ]
  const top = stages[0]!.count
  const rows: FunnelRow[] = []
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i]!
    const prior = i === 0 ? s.count : stages[i - 1]!.count
    rows.push({
      stage: s.stage,
      label: s.label,
      count: s.count,
      pctOfPrior: prior > 0 ? s.count / prior : 0,
      pctOfTop: top > 0 ? s.count / top : 0,
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// M4.3 — UTM Attribution (first-touch)
// ---------------------------------------------------------------------------

/**
 * Revenue attributed to UTM source/medium/campaign. First-touch
 * because `orders.utm_source` is stamped from the 30-day gbox_utm
 * cookie set on the visitor's first touch — subsequent visits don't
 * overwrite it.
 */
export async function getUtmAttribution(
  db: Kysely<Database>,
  storeIds: readonly string[],
  range: AnalyticsRange,
  limit = 100,
): Promise<AttributionRow[]> {
  if (storeIds.length === 0) return []

  const rows = await db
    .selectFrom('orders')
    .select([
      sql<string>`COALESCE(utm_source, '(direct)')`.as('source'),
      sql<string>`COALESCE(utm_medium, '(none)')`.as('medium'),
      'utm_campaign',
      sql<number>`COUNT(*)`.as('orders'),
      sql<string>`COALESCE(SUM(total_price::numeric), 0)`.as('revenue'),
    ])
    .where('shop_id', 'in', storeIds as string[])
    .where('created_at', '>=', range.sinceIso)
    .where('created_at', '<', range.untilIso)
    .where('financial_status', '!=', 'voided')
    .groupBy(
      sql`COALESCE(utm_source, '(direct)'), COALESCE(utm_medium, '(none)'), utm_campaign`,
    )
    .orderBy('revenue', 'desc')
    .limit(limit)
    .execute()

  return rows.map((r) => {
    const orders = Number(r.orders)
    const revenue = Number(r.revenue)
    return {
      source: String(r.source),
      medium: String(r.medium),
      campaign: r.utm_campaign ?? null,
      orders,
      revenue,
      avgOrderValue: orders > 0 ? revenue / orders : 0,
      model: 'first_touch' as const,
    }
  })
}

// ---------------------------------------------------------------------------
// M4.4 — Cohort Retention
// ---------------------------------------------------------------------------

/**
 * Monthly retention cohorts. For each month customers placed their
 * first order, count how many returned in month+N for N=0..maxOffset.
 *
 * maxCohortMonths: how many months of cohorts to include (default 12).
 * maxOffset: how many "months later" columns to show (default 12).
 */
export async function getCohortRetention(
  db: Kysely<Database>,
  storeIds: readonly string[],
  opts: { maxCohortMonths?: number; maxOffset?: number } = {},
): Promise<CohortReport> {
  const maxCohortMonths = opts.maxCohortMonths ?? 12
  const maxOffset = opts.maxOffset ?? 12

  if (storeIds.length === 0) {
    return { cohorts: [], maxOffset }
  }

  // Step 1: find each customer's first-order month (cohort assignment).
  const cohortWindowStart = new Date()
  cohortWindowStart.setUTCMonth(
    cohortWindowStart.getUTCMonth() - (maxCohortMonths - 1),
  )
  cohortWindowStart.setUTCDate(1)
  cohortWindowStart.setUTCHours(0, 0, 0, 0)
  const cohortWindowStartIso = cohortWindowStart.toISOString()

  const firstOrders = await db
    .selectFrom('orders')
    .select([
      'customer_id',
      sql<string>`TO_CHAR(DATE_TRUNC('month', MIN(created_at)), 'YYYY-MM-DD')`.as(
        'cohort_month',
      ),
    ])
    .where('shop_id', 'in', storeIds as string[])
    .where('customer_id', 'is not', null)
    .where('financial_status', '!=', 'voided')
    .groupBy('customer_id')
    .having(
      sql<SqlBool>`DATE_TRUNC('month', MIN(created_at)) >= DATE_TRUNC('month', ${cohortWindowStartIso}::timestamptz)`,
    )
    .execute()

  if (firstOrders.length === 0) {
    return { cohorts: [], maxOffset }
  }

  const customerCohort = new Map<string, string>()
  for (const r of firstOrders) {
    if (!r.customer_id) continue
    customerCohort.set(r.customer_id, String(r.cohort_month))
  }

  // Step 2: for each (customer_id, month), count whether they placed
  // an order that month. We already know each customer's cohort, so
  // we can bucket orders in JS.
  const customerIds = Array.from(customerCohort.keys())
  const orderRows = await db
    .selectFrom('orders')
    .select([
      'customer_id',
      sql<string>`TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM-DD')`.as(
        'order_month',
      ),
    ])
    .where('shop_id', 'in', storeIds as string[])
    .where('customer_id', 'in', customerIds)
    .where('financial_status', '!=', 'voided')
    .execute()

  return buildCohortReport(
    customerCohort,
    orderRows
      .filter((r): r is { customer_id: string; order_month: string } =>
        Boolean(r.customer_id),
      )
      .map(r => ({ customer_id: r.customer_id, order_month: String(r.order_month) })),
    maxOffset,
  )
}

/**
 * Integer month offset between two 'YYYY-MM-DD' strings. Negative if
 * `order` is before `cohort`. Exported for unit testing.
 * @internal
 */
export function monthDiff(cohort: string, order: string): number {
  const [cy, cm] = cohort.split('-').map(Number) as [number, number]
  const [oy, om] = order.split('-').map(Number) as [number, number]
  return (oy - cy) * 12 + (om - cm)
}

/**
 * Pure cohort aggregator — given the raw customer→cohort-month map
 * and the raw (customer, order_month) rows, build the grid. Exported
 * for unit testing.
 * @internal
 */
export function buildCohortReport(
  customerCohort: ReadonlyMap<string, string>,
  orderRows: readonly { customer_id: string; order_month: string }[],
  maxOffset: number,
): CohortReport {
  const cohortSizes = new Map<string, number>()
  for (const month of customerCohort.values()) {
    cohortSizes.set(month, (cohortSizes.get(month) ?? 0) + 1)
  }

  const activity = new Map<string, Set<string>>()
  for (const r of orderRows) {
    const cohort = customerCohort.get(r.customer_id)
    if (!cohort) continue
    const offset = monthDiff(cohort, r.order_month)
    if (offset < 0 || offset > maxOffset) continue
    const k = `${cohort}|${offset}`
    let set = activity.get(k)
    if (!set) {
      set = new Set<string>()
      activity.set(k, set)
    }
    set.add(r.customer_id)
  }

  const cohortList = Array.from(cohortSizes.keys()).sort()
  const cohorts = cohortList.map((month) => {
    const size = cohortSizes.get(month) ?? 0
    const retention: Array<{ offset: number; customers: number; rate: number }> = []
    for (let offset = 0; offset <= maxOffset; offset++) {
      const customers = activity.get(`${month}|${offset}`)?.size ?? 0
      retention.push({
        offset,
        customers,
        rate: size > 0 ? customers / size : 0,
      })
    }
    return { month, size, retention }
  })

  return { cohorts, maxOffset }
}

// ---------------------------------------------------------------------------
// M4.5 — daily_metrics hybrid helper
// ---------------------------------------------------------------------------

/**
 * Read revenue+orders totals for a range using `daily_metrics` for any
 * day strictly before today (UTC), plus a live query on `orders` for
 * today's rows (so newly-placed orders show up without waiting for the
 * next nightly rollup).
 *
 * This is an optimization for dashboards that care about totals over
 * arbitrary ranges — scanning the raw `orders` table for 90 days
 * across dozens of shops was the bottleneck.
 */
export async function getRangeRevenueHybrid(
  db: Kysely<Database>,
  storeIds: readonly string[],
  range: AnalyticsRange,
): Promise<{ revenue: number; orders: number; source: 'live' | 'hybrid' }> {
  if (storeIds.length === 0) {
    return { revenue: 0, orders: 0, source: 'hybrid' }
  }

  const sinceDate = range.sinceIso.slice(0, 10)   // YYYY-MM-DD
  const untilDate = range.untilIso.slice(0, 10)
  const todayIso = new Date().toISOString().slice(0, 10)

  // Everything strictly before today: daily_metrics.
  const dmUntil = untilDate < todayIso ? untilDate : todayIso
  let dmRevenue = 0
  let dmOrders = 0
  if (sinceDate < dmUntil) {
    const rows = await db
      .selectFrom('daily_metrics')
      .select([
        sql<string>`COALESCE(SUM(revenue::numeric), 0)`.as('revenue'),
        sql<number>`COALESCE(SUM(orders_count), 0)`.as('orders'),
      ])
      .where('shop_id', 'in', storeIds as string[])
      .where('date', '>=', sinceDate)
      .where('date', '<', dmUntil)
      .executeTakeFirst()
    dmRevenue = Number(rows?.revenue ?? 0)
    dmOrders = Number(rows?.orders ?? 0)
  }

  // Today (and beyond, if the caller passed an until in the future):
  // live query.
  let liveRevenue = 0
  let liveOrders = 0
  if (untilDate >= todayIso) {
    const liveSince =
      sinceDate >= todayIso ? range.sinceIso : new Date(todayIso + 'T00:00:00Z').toISOString()
    const rows = await db
      .selectFrom('orders')
      .select([
        sql<string>`COALESCE(SUM(total_price::numeric), 0)`.as('revenue'),
        sql<number>`COUNT(*)`.as('orders'),
      ])
      .where('shop_id', 'in', storeIds as string[])
      .where('created_at', '>=', liveSince)
      .where('created_at', '<', range.untilIso)
      .where('financial_status', '!=', 'voided')
      .executeTakeFirst()
    liveRevenue = Number(rows?.revenue ?? 0)
    liveOrders = Number(rows?.orders ?? 0)
  }

  return {
    revenue: dmRevenue + liveRevenue,
    orders: dmOrders + liveOrders,
    source: sinceDate < dmUntil ? 'hybrid' : 'live',
  }
}
