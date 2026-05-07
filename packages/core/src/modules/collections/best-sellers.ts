/**
 * Gbox Platform — Best-selling product ranker (Phase C3a)
 *
 * Replaces the Phase C4 fallback ("best-selling degrades to manual")
 * with a real ranker that scores products by units sold over a rolling
 * window.
 *
 * Scoring
 * -------
 *   rank_key = SUM(order_line_items.quantity)
 *
 * Window
 * ------
 *   orders.created_at >= NOW() - INTERVAL '<windowDays> days'
 *   Defaults to 30 days. Shopify uses 28 days; we round up to keep the
 *   ranker more stable for small stores where a single day's sales can
 *   flip the order.
 *
 * Order-status filter (revenue quality)
 * -------------------------------------
 *   orders.cancelled_at IS NULL
 *   orders.financial_status NOT IN ('refunded','partially_refunded','voided')
 *
 *   We deliberately *include* pending / paid / partially_paid because
 *   refunds take days to settle and we'd rather show a product as
 *   top-selling today and demote it later when the refund lands than
 *   hide it entirely. `cancelled_at` is the harder gate — a cancelled
 *   order never contributes.
 *
 * Deterministic tiebreak
 * ----------------------
 *   When two products have the same sold count (or both are zero),
 *   fall back to `cp.position ASC`. This gives merchants who set a
 *   manual drag order an implicit "featured pin" for slow-sellers and
 *   makes pagination stable between requests.
 *
 * Fallback contract
 * -----------------
 *   This helper THROWS on query failure. The caller (db-datasource.ts)
 *   is responsible for catching and falling back to manual order, same
 *   pattern as the price-sort branch. Keeping the throw here means the
 *   helper is pure — tests can exercise both the success path and the
 *   error path without the fallback logic entangling.
 *
 * Scope
 * -----
 *   Active products only (`products.status = 'active'`). Matches the
 *   filter already applied by every other sort branch in
 *   `loadCollectionProducts`, so pagination totals stay consistent.
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export interface BestSellerRankOptions {
  /** Shop the collection belongs to — scopes the orders aggregation. */
  shopId: string
  /** Collection whose products we want to rank. */
  collectionId: string
  /** Rolling window in days. Default: 30. */
  windowDays?: number
  /** Page size. */
  limit: number
  /** Page offset (0-based row index). */
  offset: number
}

export interface BestSellerPage {
  /**
   * Product ids in rank order (best-seller first). The caller will
   * re-hydrate product rows from this list and preserve the order
   * by mapping through a `Map<id,row>`.
   */
  productIds: string[]
}

/**
 * Rank products in a collection by units sold over a rolling window.
 *
 * Implementation uses a correlated subquery inside the SELECT list
 * (same pattern as the Phase C4 price-sort branch). Postgres optimises
 * this well for collections of up to a few thousand products; beyond
 * that we'd switch to a materialised view, but that's out of scope
 * for C3.
 */
export async function rankCollectionBestSellers(
  db: Kysely<any>,
  opts: BestSellerRankOptions,
): Promise<BestSellerPage> {
  const windowDays = opts.windowDays ?? 30

  // Use `any` on the builder so Kysely's joined-table typing (which
  // doesn't know `collection_products` / `order_line_items`) doesn't
  // explode. The shape is enforced by the SQL at runtime.
  const dbAny = db as any

  const rows = await dbAny
    .selectFrom('collection_products as cp')
    .innerJoin('products as p', 'p.id', 'cp.product_id')
    .select([
      'p.id as id',
      sql<number>`COALESCE((
        SELECT SUM(oli.quantity)
        FROM order_line_items oli
        INNER JOIN orders o ON o.id = oli.order_id
        WHERE oli.product_id = p.id
          AND o.shop_id = ${opts.shopId}
          AND o.cancelled_at IS NULL
          AND (
            o.financial_status IS NULL
            OR o.financial_status NOT IN ('refunded','partially_refunded','voided')
          )
          AND o.created_at >= NOW() - (${sql.raw(String(Math.max(1, Math.floor(windowDays))))} * INTERVAL '1 day')
      ), 0)`.as('sold'),
    ])
    .where('cp.collection_id', '=', opts.collectionId)
    .where('p.status', '=', 'active')
    .orderBy('sold', 'desc')
    .orderBy('cp.position', 'asc')
    .limit(opts.limit)
    .offset(opts.offset)
    .execute()

  return { productIds: (rows as any[]).map((r) => r.id) }
}
