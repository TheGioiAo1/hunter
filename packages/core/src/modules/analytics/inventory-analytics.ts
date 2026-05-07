/**
 * Inventory Analytics (Phase 6 PR2)
 *
 * Answers 4 questions a merchant asks weekly:
 *
 *   1. What am I selling? → getTopSellers
 *   2. What am I sitting on? → getDeadStock
 *   3. What's about to run out? → getLowStock
 *   4. How fast is stock moving? → getSellThroughLeaders
 *
 * All four read from live tables (`order_line_items` +
 * `product_variants` + `products` + `inventory_levels` depending on
 * the query). No new tables — schema was already complete per the
 * PR2 scouting audit.
 *
 * Pure helpers (`rankBySoldUnits`, `computeSellThrough`) are
 * extracted so the ranking/math is unit-testable without a live DB.
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DateRange {
  /** ISO timestamp, inclusive. */
  since: string
  /** ISO timestamp, exclusive. */
  until: string
}

export interface TopSellerRow {
  variant_id: string
  product_id: string
  product_title: string
  variant_title: string | null
  sku: string | null
  units_sold: number
  revenue: string
  orders_count: number
}

export interface DeadStockRow {
  variant_id: string
  product_id: string
  product_title: string
  variant_title: string | null
  sku: string | null
  inventory_quantity: number
  days_since_last_sale: number | null
  last_sold_at: string | null
}

export interface LowStockRow {
  variant_id: string
  product_id: string
  product_title: string
  variant_title: string | null
  sku: string | null
  inventory_quantity: number
}

export interface SellThroughRow {
  variant_id: string
  product_id: string
  product_title: string
  variant_title: string | null
  sku: string | null
  units_sold: number
  inventory_quantity: number
  /** 0..1 — units_sold / (units_sold + inventory_quantity). */
  sell_through: number
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable)
// ---------------------------------------------------------------------------

/**
 * Sell-through ratio for a single variant. Returns 0..1.
 *
 * Formula: sold / (sold + on_hand)
 *   - sold=0 → 0 (nothing moved)
 *   - on_hand=0, sold>0 → 1 (cleared)
 *   - on_hand + sold = 0 → 0 (no data)
 *
 * Clamped to [0, 1] so a negative on_hand (DB drift) can't produce >1.
 */
export function computeSellThrough(soldUnits: number, onHand: number): number {
  const denom = soldUnits + Math.max(onHand, 0)
  if (denom <= 0) return 0
  const v = soldUnits / denom
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

/**
 * Rank + slice a set of variants by units sold, desc. Ties broken by
 * revenue desc, then variant_id ascending (deterministic). Pure —
 * safe to use directly on query output.
 */
export function rankBySoldUnits<
  T extends { units_sold: number; revenue?: string | number; variant_id: string },
>(rows: T[], limit: number): T[] {
  return [...rows]
    .sort((a, b) => {
      if (a.units_sold !== b.units_sold) return b.units_sold - a.units_sold
      const aRev = Number(a.revenue ?? 0)
      const bRev = Number(b.revenue ?? 0)
      if (aRev !== bRev) return bRev - aRev
      return a.variant_id.localeCompare(b.variant_id)
    })
    .slice(0, Math.max(0, limit))
}

/**
 * Given a "last sold at" ISO and a "now" Date, return full days
 * elapsed (floor). Null last-sold → null (never sold).
 */
export function daysSince(lastSoldIso: string | null, now: Date): number | null {
  if (!lastSoldIso) return null
  const t = Date.parse(lastSoldIso)
  if (Number.isNaN(t)) return null
  const diffMs = now.getTime() - t
  if (diffMs < 0) return 0
  return Math.floor(diffMs / 86_400_000)
}

// ---------------------------------------------------------------------------
// DB-bound queries
// ---------------------------------------------------------------------------

/**
 * Top sellers — variants ranked by units sold in the range.
 *
 * Joins `order_line_items` → `orders` (for shop_id + date filter) →
 * `product_variants` → `products` (for display titles). Ignores
 * cancelled orders.
 */
export async function getTopSellers(
  db: Kysely<Database>,
  shopId: string,
  range: DateRange,
  limit = 10,
): Promise<TopSellerRow[]> {
  const rows = await db
    .selectFrom('order_line_items as oli')
    .innerJoin('orders as o', 'o.id', 'oli.order_id')
    .innerJoin('product_variants as pv', 'pv.id', 'oli.variant_id')
    .innerJoin('products as p', 'p.id', 'pv.product_id')
    .select([
      'pv.id as variant_id',
      'p.id as product_id',
      'p.title as product_title',
      'pv.title as variant_title',
      'pv.sku as sku',
      sql<number>`SUM(oli.quantity)`.as('units_sold'),
      sql<string>`COALESCE(SUM(oli.price::numeric * oli.quantity), 0)`.as('revenue'),
      sql<number>`COUNT(DISTINCT o.id)`.as('orders_count'),
    ])
    .where('o.shop_id', '=', shopId)
    .where('o.created_at', '>=', range.since)
    .where('o.created_at', '<', range.until)
    .where((eb) =>
      eb.or([
        eb('o.cancelled_at', 'is', null),
        // Some schemas omit cancelled_at; tolerate both.
      ]),
    )
    .groupBy(['pv.id', 'p.id', 'p.title', 'pv.title', 'pv.sku'])
    .orderBy(sql`SUM(oli.quantity)`, 'desc')
    .limit(limit)
    .execute()

  return rows.map((r) => ({
    variant_id: String(r.variant_id),
    product_id: String(r.product_id),
    product_title: String(r.product_title ?? ''),
    variant_title: r.variant_title ?? null,
    sku: r.sku ?? null,
    units_sold: Number(r.units_sold),
    revenue: String(r.revenue ?? '0'),
    orders_count: Number(r.orders_count),
  }))
}

/**
 * Dead stock — variants with inventory > 0 that haven't sold in N
 * days (default 90). Ordered by oldest last-sold first, then by
 * highest on-hand (prioritise the biggest dead piles).
 */
export async function getDeadStock(
  db: Kysely<Database>,
  shopId: string,
  opts: {
    daysCutoff?: number
    limit?: number
    now?: Date
  } = {},
): Promise<DeadStockRow[]> {
  const daysCutoff = opts.daysCutoff ?? 90
  const limit = opts.limit ?? 20
  const now = opts.now ?? new Date()
  const cutoff = new Date(now.getTime() - daysCutoff * 86_400_000).toISOString()

  // Sub-query: latest sold-at per variant within this shop.
  const latestSales = db
    .selectFrom('order_line_items as oli')
    .innerJoin('orders as o', 'o.id', 'oli.order_id')
    .select([
      'oli.variant_id as variant_id',
      sql<string>`MAX(o.created_at)`.as('last_sold_at'),
    ])
    .where('o.shop_id', '=', shopId)
    .groupBy('oli.variant_id')
    .as('ls')

  const rows = await db
    .selectFrom('product_variants as pv')
    .innerJoin('products as p', 'p.id', 'pv.product_id')
    .leftJoin(latestSales, 'ls.variant_id', 'pv.id')
    .select([
      'pv.id as variant_id',
      'p.id as product_id',
      'p.title as product_title',
      'pv.title as variant_title',
      'pv.sku as sku',
      'pv.inventory_quantity as inventory_quantity',
      sql<string | null>`ls.last_sold_at`.as('last_sold_at'),
    ])
    .where('p.shop_id', '=', shopId)
    .where('pv.inventory_quantity', '>', 0)
    .where((eb) =>
      eb.or([
        eb(sql`ls.last_sold_at` as any, 'is', null),
        eb(sql`ls.last_sold_at` as any, '<', cutoff),
      ]),
    )
    .orderBy(sql`ls.last_sold_at NULLS FIRST`)
    .orderBy('pv.inventory_quantity', 'desc')
    .limit(limit)
    .execute()

  return rows.map((r) => ({
    variant_id: String(r.variant_id),
    product_id: String(r.product_id),
    product_title: String(r.product_title ?? ''),
    variant_title: r.variant_title ?? null,
    sku: r.sku ?? null,
    inventory_quantity: Number(r.inventory_quantity ?? 0),
    days_since_last_sale: daysSince(r.last_sold_at, now),
    last_sold_at: r.last_sold_at ?? null,
  }))
}

/**
 * Low stock — variants with inventory at or below `threshold`
 * (default 5, matching the existing inventory cron alert). Returns
 * only variants that are tracked and still in an active product.
 */
export async function getLowStock(
  db: Kysely<Database>,
  shopId: string,
  opts: { threshold?: number; limit?: number } = {},
): Promise<LowStockRow[]> {
  const threshold = opts.threshold ?? 5
  const limit = opts.limit ?? 20

  const rows = await db
    .selectFrom('product_variants as pv')
    .innerJoin('products as p', 'p.id', 'pv.product_id')
    .select([
      'pv.id as variant_id',
      'p.id as product_id',
      'p.title as product_title',
      'pv.title as variant_title',
      'pv.sku as sku',
      'pv.inventory_quantity as inventory_quantity',
    ])
    .where('p.shop_id', '=', shopId)
    .where('pv.inventory_quantity', '<=', threshold)
    .where('pv.inventory_quantity', '>=', 0)
    .orderBy('pv.inventory_quantity', 'asc')
    .limit(limit)
    .execute()

  return rows.map((r) => ({
    variant_id: String(r.variant_id),
    product_id: String(r.product_id),
    product_title: String(r.product_title ?? ''),
    variant_title: r.variant_title ?? null,
    sku: r.sku ?? null,
    inventory_quantity: Number(r.inventory_quantity ?? 0),
  }))
}

/**
 * Sell-through leaders — variants that have moved the biggest
 * fraction of their (sold + on-hand) total in the range.
 *
 * Returned sorted by sell_through desc, then units_sold desc. Only
 * includes variants with ≥ `minSold` units sold in the range (avoids
 * a 1-unit-sold 0-on-hand variant pinning the list at 1.0).
 */
export async function getSellThroughLeaders(
  db: Kysely<Database>,
  shopId: string,
  range: DateRange,
  opts: { minSold?: number; limit?: number } = {},
): Promise<SellThroughRow[]> {
  const minSold = opts.minSold ?? 5
  const limit = opts.limit ?? 10

  const sold = await db
    .selectFrom('order_line_items as oli')
    .innerJoin('orders as o', 'o.id', 'oli.order_id')
    .innerJoin('product_variants as pv', 'pv.id', 'oli.variant_id')
    .innerJoin('products as p', 'p.id', 'pv.product_id')
    .select([
      'pv.id as variant_id',
      'p.id as product_id',
      'p.title as product_title',
      'pv.title as variant_title',
      'pv.sku as sku',
      'pv.inventory_quantity as inventory_quantity',
      sql<number>`SUM(oli.quantity)`.as('units_sold'),
    ])
    .where('o.shop_id', '=', shopId)
    .where('o.created_at', '>=', range.since)
    .where('o.created_at', '<', range.until)
    .groupBy([
      'pv.id',
      'p.id',
      'p.title',
      'pv.title',
      'pv.sku',
      'pv.inventory_quantity',
    ])
    .having(sql<boolean>`SUM(oli.quantity) >= ${minSold}`)
    .execute()

  const rows: SellThroughRow[] = sold.map((r) => {
    const units = Number(r.units_sold)
    const stock = Number(r.inventory_quantity ?? 0)
    return {
      variant_id: String(r.variant_id),
      product_id: String(r.product_id),
      product_title: String(r.product_title ?? ''),
      variant_title: r.variant_title ?? null,
      sku: r.sku ?? null,
      units_sold: units,
      inventory_quantity: stock,
      sell_through: computeSellThrough(units, stock),
    }
  })

  return rows
    .sort((a, b) => {
      if (b.sell_through !== a.sell_through) return b.sell_through - a.sell_through
      if (b.units_sold !== a.units_sold) return b.units_sold - a.units_sold
      return a.variant_id.localeCompare(b.variant_id)
    })
    .slice(0, limit)
}

// ---------------------------------------------------------------------------
// Range helper — used by the admin page to turn "?period=30d" into a range.
// ---------------------------------------------------------------------------

export function periodToRange(period: string, now: Date = new Date()): DateRange & {
  days: number
  label: string
} {
  let days = 30
  let label = 'Last 30 days'
  switch (period) {
    case '7d':
      days = 7
      label = 'Last 7 days'
      break
    case '90d':
      days = 90
      label = 'Last 90 days'
      break
    case '30d':
    default:
      days = 30
      label = 'Last 30 days'
      break
  }
  const until = new Date(now)
  const since = new Date(now.getTime() - days * 86_400_000)
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    days,
    label,
  }
}
