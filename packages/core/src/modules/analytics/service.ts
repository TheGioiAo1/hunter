/**
 * Gbox Platform — Analytics Service
 *
 * Dashboard stats, revenue tracking, top products, store performance,
 * and conversion funnel aggregation.
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface PeriodStat {
  current: number
  previous: number
  changePercent: number
}

export interface DashboardStats {
  revenue: PeriodStat
  orders: PeriodStat
  customers: PeriodStat
  avgOrderValue: PeriodStat
  trends: {
    period: 'today' | '7d' | '30d'
  }
}

export interface RevenueDataPoint {
  date: string
  revenue: number
  orders: number
}

export interface TopProduct {
  productId: string
  title: string
  unitsSold: number
  revenue: number
}

export interface StorePerformance {
  shopId: string
  shopName: string
  orders: number
  revenue: number
  customers: number
}

export interface ConversionFunnel {
  visitors: number
  addToCart: number
  checkouts: number
  purchases: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function calcChangePercent(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0
  return Math.round(((current - previous) / previous) * 10000) / 100
}

function daysAgoIso(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Get dashboard stats for a shop, comparing current period to the previous
 * period of equal length. Default period: 30 days.
 */
export async function getDashboardStats(
  db: Kysely<Database>,
  shopId: string,
  period: 'today' | '7d' | '30d' = '30d',
): Promise<DashboardStats> {
  const periodDays = period === 'today' ? 1 : period === '7d' ? 7 : 30
  const currentStart = daysAgoIso(periodDays)
  const previousStart = daysAgoIso(periodDays * 2)

  // Revenue + order counts for current period
  const currentOrders = await db
    .selectFrom('orders')
    .select([
      db.fn.countAll<number>().as('order_count'),
      sql<number>`coalesce(sum(cast(total_price as double precision)), 0)`.as('revenue'),
    ])
    .where('shop_id', '=', shopId)
    .where('created_at', '>=', currentStart)
    .where('financial_status', '!=', 'voided')
    .executeTakeFirstOrThrow()

  // Revenue + order counts for previous period
  const previousOrders = await db
    .selectFrom('orders')
    .select([
      db.fn.countAll<number>().as('order_count'),
      sql<number>`coalesce(sum(cast(total_price as double precision)), 0)`.as('revenue'),
    ])
    .where('shop_id', '=', shopId)
    .where('created_at', '>=', previousStart)
    .where('created_at', '<', currentStart)
    .where('financial_status', '!=', 'voided')
    .executeTakeFirstOrThrow()

  // New customers for current period
  const currentCustomers = await db
    .selectFrom('customers')
    .select(db.fn.countAll<number>().as('count'))
    .where('shop_id', '=', shopId)
    .where('created_at', '>=', currentStart)
    .executeTakeFirstOrThrow()

  // New customers for previous period
  const previousCustomers = await db
    .selectFrom('customers')
    .select(db.fn.countAll<number>().as('count'))
    .where('shop_id', '=', shopId)
    .where('created_at', '>=', previousStart)
    .where('created_at', '<', currentStart)
    .executeTakeFirstOrThrow()

  const curRev = Number(currentOrders.revenue)
  const prevRev = Number(previousOrders.revenue)
  const curOrd = Number(currentOrders.order_count)
  const prevOrd = Number(previousOrders.order_count)
  const curCust = Number(currentCustomers.count)
  const prevCust = Number(previousCustomers.count)

  const curAvg = curOrd > 0 ? curRev / curOrd : 0
  const prevAvg = prevOrd > 0 ? prevRev / prevOrd : 0

  return {
    revenue: {
      current: curRev,
      previous: prevRev,
      changePercent: calcChangePercent(curRev, prevRev),
    },
    orders: {
      current: curOrd,
      previous: prevOrd,
      changePercent: calcChangePercent(curOrd, prevOrd),
    },
    customers: {
      current: curCust,
      previous: prevCust,
      changePercent: calcChangePercent(curCust, prevCust),
    },
    avgOrderValue: {
      current: Math.round(curAvg * 100) / 100,
      previous: Math.round(prevAvg * 100) / 100,
      changePercent: calcChangePercent(curAvg, prevAvg),
    },
    trends: { period },
  }
}

/**
 * Get revenue grouped over time for charting.
 */
export async function getRevenueOverTime(
  db: Kysely<Database>,
  shopId: string,
  period: 'daily' | 'weekly' | 'monthly' = 'daily',
  days: number = 30,
): Promise<RevenueDataPoint[]> {
  const since = daysAgoIso(days)

  const truncExpr =
    period === 'monthly'
      ? sql<string>`date_trunc('month', created_at::timestamp)`
      : period === 'weekly'
        ? sql<string>`date_trunc('week', created_at::timestamp)`
        : sql<string>`date_trunc('day', created_at::timestamp)`

  const rows = await db
    .selectFrom('orders')
    .select([
      truncExpr.as('date'),
      sql<number>`coalesce(sum(cast(total_price as double precision)), 0)`.as('revenue'),
      db.fn.countAll<number>().as('orders'),
    ])
    .where('shop_id', '=', shopId)
    .where('created_at', '>=', since)
    .where('financial_status', '!=', 'voided')
    .groupBy(sql`date_trunc(${sql.raw(period === 'monthly' ? "'month'" : period === 'weekly' ? "'week'" : "'day'")}, created_at::timestamp)`)
    .orderBy('date', 'asc')
    .execute()

  return rows.map((r) => ({
    date: String(r.date),
    revenue: Number(r.revenue),
    orders: Number(r.orders),
  }))
}

/**
 * Get top-selling products by units sold.
 */
export async function getTopProducts(
  db: Kysely<Database>,
  shopId: string,
  limit: number = 10,
): Promise<TopProduct[]> {
  const rows = await db
    .selectFrom('order_line_items as li')
    .innerJoin('orders as o', 'o.id', 'li.order_id')
    .innerJoin('products as p', 'p.id', 'li.product_id')
    .select([
      'li.product_id as productId',
      'p.title',
      sql<number>`coalesce(sum(li.quantity), 0)`.as('unitsSold'),
      sql<number>`coalesce(sum(cast(li.price as double precision) * li.quantity), 0)`.as('revenue'),
    ])
    .where('o.shop_id', '=', shopId)
    .where('li.product_id', 'is not', null)
    .groupBy(['li.product_id', 'p.title'])
    .orderBy('unitsSold', 'desc')
    .limit(limit)
    .execute()

  return rows.map((r) => ({
    productId: r.productId as string,
    title: r.title,
    unitsSold: Number(r.unitsSold),
    revenue: Number(r.revenue),
  }))
}

/**
 * Cross-store performance comparison (super admin).
 */
export async function getStorePerformance(
  db: Kysely<Database>,
  shopIds: string[],
): Promise<StorePerformance[]> {
  if (shopIds.length === 0) return []

  const rows = await db
    .selectFrom('shops as s')
    .leftJoin('orders as o', 'o.shop_id', 's.id')
    .leftJoin('customers as c', 'c.shop_id', 's.id')
    .select([
      's.id as shopId',
      's.name as shopName',
      sql<number>`count(distinct o.id)`.as('orders'),
      sql<number>`coalesce(sum(cast(o.total_price as double precision)), 0)`.as('revenue'),
      sql<number>`count(distinct c.id)`.as('customers'),
    ])
    .where('s.id', 'in', shopIds)
    .groupBy(['s.id', 's.name'])
    .execute()

  return rows.map((r) => ({
    shopId: r.shopId,
    shopName: r.shopName,
    orders: Number(r.orders),
    revenue: Number(r.revenue),
    customers: Number(r.customers),
  }))
}

/**
 * Build a conversion funnel from events. Expected event verbs:
 *   page_view, add_to_cart, checkout_start, purchase
 */
export async function getConversionFunnel(
  db: Kysely<Database>,
  shopId: string,
  days: number = 30,
): Promise<ConversionFunnel> {
  const since = daysAgoIso(days)

  const stages = ['page_view', 'add_to_cart', 'checkout_start', 'purchase'] as const

  const rows = await db
    .selectFrom('events')
    .select([
      'verb',
      db.fn.countAll<number>().as('count'),
    ])
    .where('shop_id', '=', shopId)
    .where('created_at', '>=', since)
    .where('verb', 'in', [...stages])
    .groupBy('verb')
    .execute()

  const counts: Record<string, number> = {}
  for (const row of rows) {
    counts[row.verb] = Number(row.count)
  }

  return {
    visitors: counts['page_view'] ?? 0,
    addToCart: counts['add_to_cart'] ?? 0,
    checkouts: counts['checkout_start'] ?? 0,
    purchases: counts['purchase'] ?? 0,
  }
}
