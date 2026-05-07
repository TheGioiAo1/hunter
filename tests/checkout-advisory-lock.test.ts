/**
 * Integration smoke test — completeCheckout advisory lock (Decision #7).
 *
 * Proves that two concurrent completeCheckout calls on the same variant
 * with inventory_quantity=1 result in EXACTLY one success and one
 * "Insufficient inventory" failure — never two successes (oversell).
 *
 * Per PRINCIPLES.md P22, this test hits real Postgres. It expects
 * DATABASE_URL to point at a writable test DB (server 1, gbox_test).
 *
 * Run:
 *   DATABASE_URL=postgres://... npx tsx tests/checkout-advisory-lock.test.ts
 *
 * The script seeds its own shop/product/variant, runs the race, and
 * cleans up after itself. Safe to run repeatedly.
 */

import { createDb } from '../packages/db/src/index.js'
import {
  createCheckout,
  updateCheckoutEmail,
  completeCheckout,
} from '../packages/core/src/modules/checkout/service.js'

async function main() {
  const db = createDb()
  const suffix = Math.random().toString(36).slice(2, 10)
  const shopSlug = `advlock-${suffix}`
  let shopId: string | undefined
  let productId: string | undefined
  let variantId: string | undefined

  try {
    // ---- Seed: shop, product, variant w/ inventory_quantity=1 ----
    const shop = await db
      .insertInto('shops')
      .values({
        name: `Advisory Lock Test ${suffix}`,
        slug: shopSlug,
        email: `${shopSlug}@test.local`,
        currency: 'USD',
        plan: 'basic',
        status: 'active',
      } as any)
      .returning('id')
      .executeTakeFirstOrThrow()
    shopId = shop.id

    const product = await db
      .insertInto('products')
      .values({
        shop_id: shopId,
        title: 'Lock Test Product',
        slug: `lock-test-${suffix}`,
        status: 'active',
        vendor: 'test',
        product_type: 'test',
      } as any)
      .returning('id')
      .executeTakeFirstOrThrow()
    productId = product.id

    const variant = await db
      .insertInto('product_variants')
      .values({
        product_id: productId,
        title: 'default',
        price: '10.00',
        sku: `LOCK-${suffix}`,
        inventory_quantity: 1, // <-- the whole point: only 1 unit available
        requires_shipping: false,
        taxable: false,
        weight: '0',
        weight_unit: 'kg',
      } as any)
      .returning('id')
      .executeTakeFirstOrThrow()
    variantId = variant.id

    // ---- Create two independent checkout sessions on the same variant ----
    const checkoutA = await createCheckout(db, shopId, [
      { variant_id: variantId, quantity: 1 },
    ])
    const checkoutB = await createCheckout(db, shopId, [
      { variant_id: variantId, quantity: 1 },
    ])
    await updateCheckoutEmail(checkoutA.id, 'a@test.local')
    await updateCheckoutEmail(checkoutB.id, 'b@test.local')

    // ---- Race them in parallel ----
    const results = await Promise.allSettled([
      completeCheckout(db, checkoutA.id, { gateway: 'manual' }),
      completeCheckout(db, checkoutB.id, { gateway: 'manual' }),
    ])

    const successes = results.filter((r) => r.status === 'fulfilled').length
    const failures = results.filter((r) => r.status === 'rejected') as Array<
      PromiseRejectedResult
    >

    console.log('successes:', successes, 'failures:', failures.length)
    for (const f of failures) {
      console.log('  reject:', (f.reason as Error).message)
    }

    // ---- Assert: exactly one success, one rejection mentioning inventory ----
    if (successes !== 1) {
      throw new Error(
        `OVERSELL DETECTED: expected 1 success, got ${successes}. ` +
          `Advisory lock is NOT working.`,
      )
    }
    if (failures.length !== 1) {
      throw new Error(`expected 1 failure, got ${failures.length}`)
    }
    if (!/insufficient inventory/i.test((failures[0].reason as Error).message)) {
      throw new Error(
        `wrong rejection reason: ${(failures[0].reason as Error).message}`,
      )
    }

    // ---- Verify final inventory == 0, not -1 ----
    const finalVariant = await db
      .selectFrom('product_variants')
      .select('inventory_quantity')
      .where('id', '=', variantId)
      .executeTakeFirstOrThrow()
    if (finalVariant.inventory_quantity !== 0) {
      throw new Error(
        `inventory ended at ${finalVariant.inventory_quantity}, expected 0`,
      )
    }

    console.log('PASS — advisory lock prevents oversell race')
  } finally {
    // ---- Cleanup ----
    if (shopId) {
      // FK cascade should handle most of these but be explicit
      await db.deleteFrom('order_line_items')
        .where('product_id', '=', productId ?? '')
        .execute().catch(() => {})
      await db.deleteFrom('orders').where('shop_id', '=', shopId).execute().catch(() => {})
      await db.deleteFrom('product_variants')
        .where('product_id', '=', productId ?? '')
        .execute().catch(() => {})
      await db.deleteFrom('products').where('shop_id', '=', shopId).execute().catch(() => {})
      await db.deleteFrom('shops').where('id', '=', shopId).execute().catch(() => {})
    }
    await db.destroy()
  }
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  process.exit(1)
})
