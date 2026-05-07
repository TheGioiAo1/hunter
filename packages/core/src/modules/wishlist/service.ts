/**
 * Gbox Platform — Wishlist Service
 *
 * Customer wishlist management. This is a competitive advantage over Shopify
 * which does not natively support wishlists.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Pagination {
  limit?: number
  offset?: number
}

export interface WishlistItemWithProduct {
  id: string
  customer_id: string
  product_id: string
  shop_id: string
  created_at: string
  product: {
    id: string
    title: string
    slug: string
    body_html: string | null
    vendor: string | null
    product_type: string | null
    status: string
    published_at: string | null
    created_at: string
  } | null
}

export interface PopularWishlistProduct {
  product_id: string
  wishlist_count: number
  title: string
  slug: string
  vendor: string | null
  product_type: string | null
  status: string
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Add a product to a customer's wishlist. If the item already exists, return
 * the existing row (idempotent).
 */
export async function addToWishlist(
  db: Kysely<Database>,
  customerId: string,
  productId: string,
) {
  // Check if already in wishlist
  const existing = await db
    .selectFrom('wishlist_items')
    .selectAll()
    .where('customer_id', '=', customerId)
    .where('product_id', '=', productId)
    .executeTakeFirst()

  if (existing) return existing

  // Resolve shop_id from the customer record
  const customer = await db
    .selectFrom('customers')
    .select('shop_id')
    .where('id', '=', customerId)
    .executeTakeFirstOrThrow()

  const item = await db
    .insertInto('wishlist_items')
    .values({
      customer_id: customerId,
      product_id: productId,
      shop_id: customer.shop_id,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return item
}

/**
 * Remove a product from a customer's wishlist.
 */
export async function removeFromWishlist(
  db: Kysely<Database>,
  customerId: string,
  productId: string,
): Promise<void> {
  await db
    .deleteFrom('wishlist_items')
    .where('customer_id', '=', customerId)
    .where('product_id', '=', productId)
    .execute()
}

/**
 * Get a customer's wishlist with product details and pagination.
 */
export async function getWishlist(
  db: Kysely<Database>,
  customerId: string,
  pagination: Pagination = {},
) {
  const { limit = 50, offset = 0 } = pagination

  const [rows, countRow] = await Promise.all([
    db
      .selectFrom('wishlist_items')
      .innerJoin('products', 'products.id', 'wishlist_items.product_id')
      .select([
        'wishlist_items.id',
        'wishlist_items.customer_id',
        'wishlist_items.product_id',
        'wishlist_items.shop_id',
        'wishlist_items.created_at',
        'products.title as product_title',
        'products.slug as product_slug',
        'products.body_html as product_body_html',
        'products.vendor as product_vendor',
        'products.product_type as product_product_type',
        'products.status as product_status',
        'products.published_at as product_published_at',
        'products.created_at as product_created_at',
      ])
      .where('wishlist_items.customer_id', '=', customerId)
      .orderBy('wishlist_items.created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute(),

    db
      .selectFrom('wishlist_items')
      .select(db.fn.countAll<number>().as('count'))
      .where('customer_id', '=', customerId)
      .executeTakeFirstOrThrow(),
  ])

  const items: WishlistItemWithProduct[] = rows.map((row) => ({
    id: row.id,
    customer_id: row.customer_id,
    product_id: row.product_id,
    shop_id: row.shop_id,
    created_at: row.created_at,
    product: {
      id: row.product_id,
      title: row.product_title,
      slug: row.product_slug,
      body_html: row.product_body_html,
      vendor: row.product_vendor,
      product_type: row.product_product_type,
      status: row.product_status,
      published_at: row.product_published_at,
      created_at: row.product_created_at,
    },
  }))

  return { items, total: Number(countRow.count) }
}

/**
 * Check whether a product is in a customer's wishlist.
 */
export async function isInWishlist(
  db: Kysely<Database>,
  customerId: string,
  productId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('wishlist_items')
    .select('id')
    .where('customer_id', '=', customerId)
    .where('product_id', '=', productId)
    .executeTakeFirst()

  return !!row
}

/**
 * Get the number of items in a customer's wishlist.
 */
export async function getWishlistCount(
  db: Kysely<Database>,
  customerId: string,
): Promise<number> {
  const row = await db
    .selectFrom('wishlist_items')
    .select(db.fn.countAll<number>().as('count'))
    .where('customer_id', '=', customerId)
    .executeTakeFirstOrThrow()

  return Number(row.count)
}

/**
 * Clear all items from a customer's wishlist.
 */
export async function clearWishlist(
  db: Kysely<Database>,
  customerId: string,
): Promise<void> {
  await db
    .deleteFrom('wishlist_items')
    .where('customer_id', '=', customerId)
    .execute()
}

/**
 * Get the most popular products by wishlist count across a shop.
 */
export async function getPopularWishlistProducts(
  db: Kysely<Database>,
  shopId: string,
  limit = 10,
): Promise<PopularWishlistProduct[]> {
  const rows = await db
    .selectFrom('wishlist_items')
    .innerJoin('products', 'products.id', 'wishlist_items.product_id')
    .select([
      'wishlist_items.product_id',
      db.fn.countAll<number>().as('wishlist_count'),
      'products.title',
      'products.slug',
      'products.vendor',
      'products.product_type',
      'products.status',
    ])
    .where('wishlist_items.shop_id', '=', shopId)
    .groupBy([
      'wishlist_items.product_id',
      'products.title',
      'products.slug',
      'products.vendor',
      'products.product_type',
      'products.status',
    ])
    .orderBy('wishlist_count', 'desc')
    .limit(limit)
    .execute()

  return rows.map((r) => ({
    product_id: r.product_id,
    wishlist_count: Number(r.wishlist_count),
    title: r.title,
    slug: r.slug,
    vendor: r.vendor,
    product_type: r.product_type,
    status: r.status,
  }))
}
