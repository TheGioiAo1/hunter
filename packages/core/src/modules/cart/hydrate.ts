/**
 * Gbox Platform — Cart hydration (Stage 3B.3)
 *
 * Takes a Redis-stored `Cart` (variant IDs + quantities only) and
 * turns it into the `CartDrop` shape the theme engine hands to
 * Liquid templates. This is the one place we pull the live price,
 * title, image and handle out of Postgres — the cart store itself
 * deliberately never caches them because prices change and product
 * metadata is cheap to read in a single `IN (...)` query.
 *
 * Shape we hand back matches the Shopify `cart.items[]` loosely
 * enough that an unmodified Dawn theme renders the cart drawer
 * without template tweaks:
 *
 *   {
 *     token, item_count, total_price, items: [{
 *       variant_id, product_id, handle, title, variant_title,
 *       quantity, price, line_price, image, url, properties
 *     }]
 *   }
 *
 * Design guard-rails:
 *
 *   • **Shop-scoped.** We pass `shopId` through to the query so a
 *     cart that somehow ended up pointing at a variant from another
 *     merchant (rare — cart-routes refuses cross-shop adds, but a
 *     bad actor could post a variant id directly) never sees the
 *     other shop's prices.
 *
 *   • **Missing variants silently dropped.** If a merchant deletes
 *     a product while a cart is in flight, we don't want the cart
 *     page to 500 — we quietly drop the line and keep the rest. The
 *     user will notice "wait, where did X go" and that is a much
 *     softer failure than a blank page.
 *
 *   • **No writes.** Hydration is pure read. We do NOT mutate the
 *     cart to reflect dropped lines, because the buyer may re-add
 *     the same variant later or switch shops. Cleanup happens on
 *     the next explicit cart-routes mutation.
 *
 *   • **No tax / shipping.** Those are checkout concerns and
 *     depend on an address we don't have yet. The cart's
 *     `total_price` here is a merchandise subtotal only.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { CartDrop } from '../themes/engine/storefront/datasource.js'
import type { Cart } from './service.js'

/**
 * Hydrate a `Cart` into a `CartDrop` by reading live product /
 * variant metadata from Postgres. `cart === null` is supported and
 * yields an empty drop with no `token` field — this is the "anon
 * visitor, no cart cookie yet" code path.
 */
export async function hydrateCart(
  db: Kysely<Database>,
  cart: Cart | null,
  shopId: string,
): Promise<CartDrop> {
  if (!cart || cart.lines.length === 0) {
    const empty: CartDrop = {
      item_count: 0,
      total_price: 0,
      items: [],
    }
    if (cart) empty.token = cart.token
    return empty
  }

  const variantIds = cart.lines.map((l) => l.variant_id)

  // Single round-trip: join products so we get the handle/title
  // in one go, and filter to the caller's shop id so a rogue
  // variant from another merchant never bleeds in.
  const rows = await db
    .selectFrom('product_variants')
    .innerJoin('products', 'products.id', 'product_variants.product_id')
    .select([
      'product_variants.id as variant_id',
      'product_variants.product_id as product_id',
      'product_variants.title as variant_title',
      'product_variants.price as price',
      'product_variants.image_url as image_url',
      'products.title as product_title',
      // `products.slug` is the merchant-facing handle in the current
      // schema; the theme engine reads it back out under the `handle`
      // drop key. Keep the alias local to this module.
      'products.slug as product_handle',
      'products.shop_id as shop_id',
    ])
    .where('product_variants.id', 'in', variantIds)
    .where('products.shop_id', '=', shopId)
    .execute()

  // Index by variant id so the loop below is O(lines).
  const rowMap = new Map<string, (typeof rows)[number]>()
  for (const r of rows) {
    rowMap.set(r.variant_id as unknown as string, r)
  }

  const items: Array<Record<string, unknown>> = []
  let itemCount = 0
  let totalPrice = 0

  for (const line of cart.lines) {
    const row = rowMap.get(line.variant_id)
    if (!row) continue // Variant deleted / wrong shop → silently drop.

    const price = parseFloat(String(row.price ?? '0')) || 0
    const linePrice = price * line.quantity
    itemCount += line.quantity
    totalPrice += linePrice

    const item: Record<string, unknown> = {
      variant_id: row.variant_id,
      product_id: row.product_id,
      handle: row.product_handle,
      title: row.product_title,
      variant_title: row.variant_title,
      quantity: line.quantity,
      price,
      line_price: linePrice,
      image: row.image_url,
      url: `/products/${row.product_handle}`,
    }
    if (line.properties) {
      item.properties = { ...line.properties }
    }
    items.push(item)
  }

  // Round to the nearest cent. JavaScript floats on a sum of
  // decimal strings can drift by 1e-14 — rounding here keeps the
  // number a merchant would print money with predictable.
  const roundedTotal = Math.round(totalPrice * 100) / 100

  return {
    token: cart.token,
    item_count: itemCount,
    total_price: roundedTotal,
    items,
  }
}
