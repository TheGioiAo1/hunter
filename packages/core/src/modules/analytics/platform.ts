/**
 * Platform analytics (Phase 6 PR5) — god-admin only.
 *
 * The per-shop reports (inventory-analytics, customer-behavior) answer
 * "what happened inside shop X?". This module answers the god-admin
 * question: "what is the platform doing, across every shop, right now?"
 *
 * All functions are scoped to NO shop — they aggregate across every row
 * in `shops`, `orders`, `customers`, `daily_metrics`. Callers MUST gate
 * the calling route on the `god_admin` role (level 0); nothing in this
 * file does that gating itself.
 *
 * Where possible we read from `daily_metrics` (the PR1 rollup) instead
 * of scanning `orders` — one row per shop per day is cheap, orders is
 * not. The time-series endpoint is the main beneficiary; the single-
 * period aggregates are OK to compute against `orders` for accuracy
 * (refund amounts don't sit in `daily_metrics.refunds` granularly
 * enough to drive operator decisions).
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { isoDay } from './daily-metrics.js'

// Reused from inventory-analytics — we want one canonical DateRange
// across every Phase 6 service.
export { periodToRange, type DateRange } from './inventory-analytics.js'
import type { DateRange } from './inventory-analytics.js'

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface PlatformOverview {
  shops: {
    total: number
    active: number
    suspended: number
    new_this_period: number
  }
  customers: {
    total: number
    new_this_period: number
  }
  orders: {
    total: number
    this_period: number
    previous_period: number
    change_percent: number
  }
  revenue: {
    total: string
    this_period: string
    previous_period: string
    change_percent: number
  }
  refunds: {
    this_period: string
  }
  average_order_value: {
    this_period: string
    previous_period: string
    change_percent: number
  }
  /** ISO currency of the first row found — platform-wide reports assume
   * a dominant currency per deployment. Multi-currency summation is
   * deliberately left out — adding them together would mislead. */
  currency: string
}

export interface ShopLeaderboardRow {
  shop_id: string
  shop_slug: string
  shop_name: string
  shop_status: string
  orders_count: number
  revenue: string
  customers_count: number
  new_customers: number
  avg_order_value: string
  currency: string
}

export interface ShopGrowthRow {
  shop_id: string
  shop_slug: string
  shop_name: string
  current_revenue: string
  previous_revenue: string
  change_percent: number
  direction: 'up' | 'down' | 'flat'
}

export interface TimeSeriesPoint {
  date: string
  orders_count: number
  revenue: string
  refunds: string
  shops_active: number
}

export interface HealthSignal {
  shop_id: string
  shop_slug: string
  shop_name: string
  shop_status: string
  days_since_last_order: number | null
  revenue_this_period: string
}

export interface PlatformHealth {
  zero_revenue_shops: HealthSignal[]
  suspended_shops: number
  at_risk_shops: ShopGrowthRow[]
  new_shops_this_period: number
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable)
// ---------------------------------------------------------------------------

/** Safe change-percent; returns 100 for "0 → non-zero", 0 for "0 → 0". */
export function changePercent(current: number, previous: number): number {
  if (!isFinite(current) || !isFinite(previous)) return 0
  if (previous === 0) return current > 0 ? 100 : current < 0 ? -100 : 0
  return Math.round(((current - previous) / previous) * 10_000) / 100
}

/** Classify a growth delta — ±5% window is "flat" to avoid noise. */
export function classifyDirection(
  changePct: number,
  flatWindow = 5,
): 'up' | 'down' | 'flat' {
  if (Math.abs(changePct) < flatWindow) return 'flat'
  return changePct > 0 ? 'up' : 'down'
}

/** Given a `DateRange`, produce the inclusive previous-period range of
 * equal span. Used for period-over-period delta math. */
export function previousPeriod(range: DateRange): DateRange {
  const since = new Date(range.since)
  const until = new Date(range.until)
  const span = until.getTime() - since.getTime()
  return {
    since: new Date(since.getTime() - span).toISOString(),
    until: range.since,
  }
}

// ---------------------------------------------------------------------------
// Platform overview
// ---------------------------------------------------------------------------

export async function getPlatformOverview(
  db: Kysely<Database>,
  range: DateRange,
): Promise<PlatformOverview> {
  const prev = previousPeriod(range)

  const [
    shopStatus,
    newShopsRow,
    customerTotalRow,
    newCustomersRow,
    ordersCurrent,
    ordersPrevious,
    ordersAllTime,
    refundsCurrent,
    currencyRow,
  ] = await Promise.all([
    db
      .selectFrom('shops')
      .select([
        sql<number>`count(*) filter (where status = 'active')`.as('active'),
        sql<number>`count(*) filter (where status = 'suspended')`.as('suspended'),
        sql<number>`count(*)`.as('total'),
      ])
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('shops')
      .select(db.fn.countAll<number>().as('cnt'))
      .where('created_at', '>=', range.since)
      .where('created_at', '<', range.until)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('customers')
      .select(db.fn.countAll<number>().as('cnt'))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('customers')
      .select(db.fn.countAll<number>().as('cnt'))
      .where('created_at', '>=', range.since)
      .where('created_at', '<', range.until)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('orders')
      .select([
        db.fn.countAll<number>().as('cnt'),
        sql<string>`COALESCE(SUM(total_price::numeric), 0)`.as('revenue'),
      ])
      .where('created_at', '>=', range.since)
      .where('created_at', '<', range.until)
      .where('financial_status', '!=', 'voided')
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('orders')
      .select([
        db.fn.countAll<number>().as('cnt'),
        sql<string>`COALESCE(SUM(total_price::numeric), 0)`.as('revenue'),
      ])
      .where('created_at', '>=', prev.since)
      .where('created_at', '<', prev.until)
      .where('financial_status', '!=', 'voided')
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('orders')
      .select([
        db.fn.countAll<number>().as('cnt'),
        sql<string>`COALESCE(SUM(total_price::numeric), 0)`.as('revenue'),
      ])
      .where('financial_status', '!=', 'voided')
      .executeTakeFirstOrThrow(),
    db
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
      .where('refunds.created_at', '>=', range.since)
      .where('refunds.created_at', '<', range.until)
      .executeTakeFirstOrThrow()
      .catch(() => ({ refunds: '0' })),
    db
      .selectFrom('orders')
      .select('currency')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst(),
  ])

  const curOrders = Number(ordersCurrent.cnt) || 0
  const prevOrders = Number(ordersPrevious.cnt) || 0
  const curRev = Number(ordersCurrent.revenue) || 0
  const prevRev = Number(ordersPrevious.revenue) || 0
  const curAov = curOrders > 0 ? curRev / curOrders : 0
  const prevAov = prevOrders > 0 ? prevRev / prevOrders : 0

  return {
    shops: {
      total: Number(shopStatus.total) || 0,
      active: Number(shopStatus.active) || 0,
      suspended: Number(shopStatus.suspended) || 0,
      new_this_period: Number(newShopsRow.cnt) || 0,
    },
    customers: {
      total: Number(customerTotalRow.cnt) || 0,
      new_this_period: Number(newCustomersRow.cnt) || 0,
    },
    orders: {
      total: Number(ordersAllTime.cnt) || 0,
      this_period: curOrders,
      previous_period: prevOrders,
      change_percent: changePercent(curOrders, prevOrders),
    },
    revenue: {
      total: String(ordersAllTime.revenue || '0'),
      this_period: curRev.toFixed(2),
      previous_period: prevRev.toFixed(2),
      change_percent: changePercent(curRev, prevRev),
    },
    refunds: {
      this_period: String(refundsCurrent.refunds || '0'),
    },
    average_order_value: {
      this_period: curAov.toFixed(2),
      previous_period: prevAov.toFixed(2),
      change_percent: changePercent(curAov, prevAov),
    },
    currency: currencyRow?.currency || 'USD',
  }
}

// ---------------------------------------------------------------------------
// Shop leaderboard
// ---------------------------------------------------------------------------

export async function getShopLeaderboard(
  db: Kysely<Database>,
  range: DateRange,
  opts: {
    limit?: number
    orderBy?: 'revenue' | 'orders'
  } = {},
): Promise<ShopLeaderboardRow[]> {
  const limit = opts.limit ?? 10
  const orderBy = opts.orderBy === 'orders' ? 'orders_count' : 'revenue'

  const rows = await sql<{
    shop_id: string
    shop_slug: string
    shop_name: string
    shop_status: string
    orders_count: string
    revenue: string
    customers_count: string
    new_customers: string
    currency: string
  }>`
    SELECT
      s.id            as shop_id,
      s.slug          as shop_slug,
      s.name          as shop_name,
      s.status        as shop_status,
      COALESCE(o.orders_count, 0)     as orders_count,
      COALESCE(o.revenue, 0)          as revenue,
      COALESCE(c.customers_count, 0)  as customers_count,
      COALESCE(nc.new_customers, 0)   as new_customers,
      COALESCE(o.currency, 'USD')     as currency
    FROM shops s
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)                               as orders_count,
        COALESCE(SUM(total_price::numeric), 0) as revenue,
        MAX(currency)                          as currency
      FROM orders
      WHERE shop_id = s.id
        AND created_at >= ${range.since}
        AND created_at <  ${range.until}
        AND financial_status <> 'voided'
    ) o ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*) as customers_count
      FROM customers WHERE shop_id = s.id
    ) c ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*) as new_customers
      FROM customers
      WHERE shop_id = s.id
        AND created_at >= ${range.since}
        AND created_at <  ${range.until}
    ) nc ON TRUE
    ORDER BY ${sql.raw(orderBy === 'orders_count' ? 'orders_count' : 'revenue')} DESC, s.name ASC
    LIMIT ${limit}
  `.execute(db)

  return rows.rows.map((r) => {
    const orders = Number(r.orders_count) || 0
    const revenue = Number(r.revenue) || 0
    const aov = orders > 0 ? revenue / orders : 0
    return {
      shop_id: r.shop_id,
      shop_slug: r.shop_slug,
      shop_name: r.shop_name,
      shop_status: r.shop_status,
      orders_count: orders,
      revenue: revenue.toFixed(2),
      customers_count: Number(r.customers_count) || 0,
      new_customers: Number(r.new_customers) || 0,
      avg_order_value: aov.toFixed(2),
      currency: r.currency || 'USD',
    }
  })
}

// ---------------------------------------------------------------------------
// Shop growth — biggest up/down movers
// ---------------------------------------------------------------------------

export async function getShopGrowth(
  db: Kysely<Database>,
  range: DateRange,
  opts: { limit?: number; flatWindow?: number } = {},
): Promise<ShopGrowthRow[]> {
  const limit = opts.limit ?? 10
  const flatWindow = opts.flatWindow ?? 5
  const prev = previousPeriod(range)

  const rows = await sql<{
    shop_id: string
    shop_slug: string
    shop_name: string
    current_revenue: string
    previous_revenue: string
  }>`
    SELECT
      s.id   as shop_id,
      s.slug as shop_slug,
      s.name as shop_name,
      COALESCE(cur.revenue, 0)  as current_revenue,
      COALESCE(prev.revenue, 0) as previous_revenue
    FROM shops s
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(total_price::numeric), 0) as revenue
      FROM orders
      WHERE shop_id = s.id
        AND created_at >= ${range.since}
        AND created_at <  ${range.until}
        AND financial_status <> 'voided'
    ) cur ON TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(total_price::numeric), 0) as revenue
      FROM orders
      WHERE shop_id = s.id
        AND created_at >= ${prev.since}
        AND created_at <  ${prev.until}
        AND financial_status <> 'voided'
    ) prev ON TRUE
    WHERE s.status = 'active'
  `.execute(db)

  const enriched = rows.rows.map((r) => {
    const cur = Number(r.current_revenue) || 0
    const prevRev = Number(r.previous_revenue) || 0
    const pct = changePercent(cur, prevRev)
    return {
      shop_id: r.shop_id,
      shop_slug: r.shop_slug,
      shop_name: r.shop_name,
      current_revenue: cur.toFixed(2),
      previous_revenue: prevRev.toFixed(2),
      change_percent: pct,
      direction: classifyDirection(pct, flatWindow),
    } as ShopGrowthRow
  })

  // Return the biggest movers in both directions, up to `limit` total
  // rows. Shops with no activity either side stay out.
  return enriched
    .filter((r) => Number(r.current_revenue) > 0 || Number(r.previous_revenue) > 0)
    .sort((a, b) => Math.abs(b.change_percent) - Math.abs(a.change_percent))
    .slice(0, limit)
}

// ---------------------------------------------------------------------------
// Platform time-series — daily rollup across every shop
// ---------------------------------------------------------------------------

export async function getPlatformTimeSeries(
  db: Kysely<Database>,
  range: DateRange,
): Promise<TimeSeriesPoint[]> {
  // Prefer `daily_metrics` over `orders` — PR1 is the source of truth.
  // `shops_active` = shops with ≥1 daily_metrics row with orders > 0.
  const since = range.since.slice(0, 10)
  const until = range.until.slice(0, 10)

  const rows = await sql<{
    date: string | Date
    orders_count: string
    revenue: string
    refunds: string
    shops_active: string
  }>`
    SELECT
      date,
      SUM(orders_count)                                as orders_count,
      COALESCE(SUM(revenue::numeric), 0)               as revenue,
      COALESCE(SUM(refunds::numeric), 0)               as refunds,
      COUNT(*) FILTER (WHERE orders_count > 0)         as shops_active
    FROM daily_metrics
    WHERE date >= ${since}
      AND date <= ${until}
    GROUP BY date
    ORDER BY date ASC
  `.execute(db)

  return rows.rows.map((r) => ({
    date: isoDay(r.date) ?? String(r.date).slice(0, 10),
    orders_count: Number(r.orders_count) || 0,
    revenue: Number(r.revenue).toFixed(2),
    refunds: Number(r.refunds).toFixed(2),
    shops_active: Number(r.shops_active) || 0,
  }))
}

// ---------------------------------------------------------------------------
// Platform health signals
// ---------------------------------------------------------------------------

export async function getPlatformHealth(
  db: Kysely<Database>,
  range: DateRange,
  opts: { zeroRevLimit?: number; atRiskLimit?: number; atRiskDropPct?: number } = {},
): Promise<PlatformHealth> {
  const zeroLimit = opts.zeroRevLimit ?? 10
  const atRiskLimit = opts.atRiskLimit ?? 10
  const atRiskDropPct = opts.atRiskDropPct ?? -30

  // Zero-revenue active shops in the current period + days since last order.
  const zeroRows = await sql<{
    shop_id: string
    shop_slug: string
    shop_name: string
    shop_status: string
    last_order_at: string | Date | null
    revenue: string
  }>`
    SELECT
      s.id     as shop_id,
      s.slug   as shop_slug,
      s.name   as shop_name,
      s.status as shop_status,
      lo.last_order_at,
      COALESCE(cr.revenue, 0) as revenue
    FROM shops s
    LEFT JOIN LATERAL (
      SELECT MAX(created_at) as last_order_at
      FROM orders WHERE shop_id = s.id
        AND financial_status <> 'voided'
    ) lo ON TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(total_price::numeric), 0) as revenue
      FROM orders
      WHERE shop_id = s.id
        AND created_at >= ${range.since}
        AND created_at <  ${range.until}
        AND financial_status <> 'voided'
    ) cr ON TRUE
    WHERE s.status = 'active'
      AND COALESCE(cr.revenue, 0) = 0
    ORDER BY lo.last_order_at ASC NULLS FIRST
    LIMIT ${zeroLimit}
  `.execute(db)

  const now = Date.now()
  const zeroShops: HealthSignal[] = zeroRows.rows.map((r) => {
    const last = r.last_order_at ? new Date(r.last_order_at as any) : null
    const days =
      last && !Number.isNaN(last.getTime())
        ? Math.floor((now - last.getTime()) / 86_400_000)
        : null
    return {
      shop_id: r.shop_id,
      shop_slug: r.shop_slug,
      shop_name: r.shop_name,
      shop_status: r.shop_status,
      days_since_last_order: days,
      revenue_this_period: Number(r.revenue || 0).toFixed(2),
    }
  })

  const suspendedRow = await db
    .selectFrom('shops')
    .select(db.fn.countAll<number>().as('cnt'))
    .where('status', '=', 'suspended')
    .executeTakeFirstOrThrow()

  const newShopsRow = await db
    .selectFrom('shops')
    .select(db.fn.countAll<number>().as('cnt'))
    .where('created_at', '>=', range.since)
    .where('created_at', '<', range.until)
    .executeTakeFirstOrThrow()

  // At-risk = shops whose revenue dropped > atRiskDropPct this period
  // vs previous. Reuse getShopGrowth's output then filter.
  const growth = await getShopGrowth(db, range, { limit: 200 })
  const atRisk = growth
    .filter(
      (g) =>
        Number(g.previous_revenue) > 0 &&
        g.change_percent <= atRiskDropPct,
    )
    .slice(0, atRiskLimit)

  return {
    zero_revenue_shops: zeroShops,
    suspended_shops: Number(suspendedRow.cnt) || 0,
    at_risk_shops: atRisk,
    new_shops_this_period: Number(newShopsRow.cnt) || 0,
  }
}
