/**
 * Integration test — slug-less checkout endpoints (Step 2.7 of Decision #2).
 *
 * Covers the three new endpoints added in Step 2.5 + 2.6 that apps/checkout
 * calls from the /c/:checkoutId URL (no slug in path):
 *
 *   GET  /api/checkout/:id           → read checkout + owning shop
 *   GET  /api/checkout/:id/order     → read finalized order for thank-you
 *   POST /api/checkout/:id/paypal/create   (error path only — real PayPal
 *        call requires merchant onboarding the test shop doesn't have)
 *
 * Unlike the handoff test, we exercise the HTTP layer directly via
 * fetch() against a running gbox-api on 127.0.0.1:4321. This ensures we
 * catch regressions in the Express middleware chain (cors, rate-limit,
 * idempotent, etc.) in addition to the route handler itself.
 *
 * The test is gated on API_BASE_URL so it can be skipped locally when
 * no live API is running. On server 2 (where `pm2 start gbox-api`
 * already runs the API) just execute:
 *
 *   API_BASE_URL=http://127.0.0.1:4321 \
 *     DATABASE_URL=$DATABASE_URL REDIS_URL=$REDIS_URL \
 *     npx tsx tests/checkout-slugless-endpoints.test.ts
 *
 * What this test does NOT exercise:
 *   - Real PayPal token exchange (gbox-demo is not onboarded on sandbox)
 *   - apps/checkout page rendering (covered by scripts/smoke-thankyou.ts)
 *   - Redis TTL expiry (can't wait an hour in a test)
 */

import { createDb } from '../packages/db/src/index.js'
import {
  createCheckout,
  updateCheckoutEmail,
  updateCheckoutShipping,
  selectShippingRate,
  completeCheckout,
  cancelCheckout,
  getCheckout,
} from '../packages/core/src/modules/checkout/service.js'
import { closeRedis } from '../packages/core/src/modules/cache/redis.js'

function assert(cond: any, msg: string): asserts cond {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg)
}

const API = process.env.API_BASE_URL ?? 'http://127.0.0.1:4321'

async function jget(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API}${path}`)
  const text = await res.text()
  let body: any
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}

async function jpost(path: string, data: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  const text = await res.text()
  let body: any
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}

async function main() {
  const db = createDb()
  const suffix = Math.random().toString(36).slice(2, 10)
  const slug = `slugless-${suffix}`

  let shopId: string | undefined
  let productId: string | undefined
  let variantId: string | undefined

  try {
    // ---- Seed shop + product + variant ----
    const shop = await db
      .insertInto('shops')
      .values({
        name: `Slugless Test ${suffix}`,
        slug,
        email: `${slug}@test.local`,
        currency: 'USD',
        plan: 'basic',
        status: 'active',
      } as any)
      .returning('id')
      .executeTakeFirstOrThrow()
    shopId = shop.id!

    const product = await db
      .insertInto('products')
      .values({
        shop_id: shopId,
        title: `Slugless Product ${suffix}`,
        slug: `slugless-${suffix}`,
        status: 'active',
        vendor: 'Gbox',
        product_type: 'physical',
      } as any)
      .returning('id')
      .executeTakeFirstOrThrow()
    productId = product.id!

    const variant = await db
      .insertInto('product_variants')
      .values({
        product_id: productId,
        title: 'Default',
        price: '25.00',
        inventory_quantity: 100,
        requires_shipping: true,
        taxable: true,
      } as any)
      .returning('id')
      .executeTakeFirstOrThrow()
    variantId = variant.id!

    // ================================================================
    // Case 1 — GET /api/checkout/:id on a non-existent id → 404
    // ================================================================
    {
      const { status, body } = await jget(`/api/checkout/chk_does_not_exist_${suffix}`)
      assert(status === 404, `expected 404 got ${status}`)
      assert(body.error === 'checkout_not_found', `wrong error: ${JSON.stringify(body)}`)
    }
    console.log('PASS 1/8 — GET /api/checkout/:id 404 on unknown id')

    // ================================================================
    // Case 2 — create a real checkout, then GET /api/checkout/:id
    //          returns { checkout, shop }.
    // ================================================================
    const checkout = await createCheckout(db, shopId!, [
      { variant_id: variantId!, quantity: 2 },
    ])

    {
      const { status, body } = await jget(`/api/checkout/${checkout.id}`)
      assert(status === 200, `expected 200 got ${status}`)
      assert(body.checkout?.id === checkout.id, 'checkout id matches')
      assert(body.checkout.shop_id === shopId, 'shop_id matches')
      assert(body.shop?.slug === slug, `shop.slug matches got ${body.shop?.slug}`)
      assert(body.shop?.name?.includes(suffix), 'shop.name matches')
      assert(body.shop?.currency === 'USD', 'shop.currency matches')
      assert(Array.isArray(body.checkout.line_items) && body.checkout.line_items.length === 1, 'has 1 line item')
    }
    console.log('PASS 2/8 — GET /api/checkout/:id returns checkout + shop')

    // ================================================================
    // Case 3 — GET /api/checkout/:id/order on an unpaid checkout → 409
    // ================================================================
    {
      const { status, body } = await jget(`/api/checkout/${checkout.id}/order`)
      assert(status === 409, `expected 409 got ${status}`)
      assert(body.error === 'checkout_not_completed', `wrong error: ${JSON.stringify(body)}`)
    }
    console.log('PASS 3/8 — GET /order 409 on un-paid checkout')

    // ================================================================
    // Case 4 — GET /api/checkout/:id/order on expired (cancelled) checkout → 410
    // ================================================================
    const doomedCheckout = await createCheckout(db, shopId!, [
      { variant_id: variantId!, quantity: 1 },
    ])
    await cancelCheckout(doomedCheckout.id, 'test_410_path')
    {
      const { status, body } = await jget(`/api/checkout/${doomedCheckout.id}/order`)
      assert(status === 410, `expected 410 got ${status}`)
      assert(body.error === 'checkout_expired', `wrong error: ${JSON.stringify(body)}`)
    }
    console.log('PASS 4/8 — GET /order 410 on expired session')

    // ================================================================
    // Case 5 — POST /paypal/create on unknown checkout → 404
    // ================================================================
    {
      const { status, body } = await jpost(
        `/api/checkout/chk_bogus_${suffix}/paypal/create`,
        { payment_method: 'paypal' },
      )
      assert(status === 404, `expected 404 got ${status}`)
      assert(body.error === 'checkout_not_found', `wrong error: ${JSON.stringify(body)}`)
    }
    console.log('PASS 5/8 — POST /paypal/create 404 on unknown checkout')

    // ================================================================
    // Case 6 — POST /paypal/capture with missing paypal_order_id → 400
    // ================================================================
    {
      const { status, body } = await jpost(
        `/api/checkout/${checkout.id}/paypal/capture`,
        {},
      )
      assert(status === 400, `expected 400 got ${status}`)
      assert(body.error === 'missing_paypal_order_id', `wrong error: ${JSON.stringify(body)}`)
    }
    console.log('PASS 6/8 — POST /paypal/capture 400 on missing order id')

    // ================================================================
    // Case 7 — Complete a full checkout + GET /order returns 200 with
    //          the finalized order, line items, and shop.
    // ================================================================
    await updateCheckoutEmail(checkout.id, 'slugless-2.7@gbox.co')
    await updateCheckoutShipping(checkout.id, {
      first_name: 'Slug',
      last_name: 'Less',
      address1: '42 Test Lane',
      city: 'Testville',
      province: 'CA',
      zip: '90210',
      country: 'US',
      country_code: 'US',
    } as any)
    await selectShippingRate(checkout.id, {
      id: 'rate_flat_test',
      name: 'Test Flat',
      price: '5.00',
      type: 'flat',
    } as any)

    const completed = await completeCheckout(db, checkout.id, {
      gateway: 'test',
      gateway_transaction_id: `TEST-${suffix}`,
    })
    assert(completed.order_id, 'order_id populated after complete')

    {
      const { status, body } = await jget(`/api/checkout/${checkout.id}/order`)
      assert(status === 200, `expected 200 got ${status}: ${JSON.stringify(body)}`)
      assert(body.order?.id === completed.order_id, 'order id matches completeCheckout output')
      // Postgres bigint → JS string via node-postgres; accept either
      // as long as it parses to a positive integer.
      const orderNum = Number(body.order.order_number)
      assert(Number.isInteger(orderNum) && orderNum > 0, `order_number should be a positive int, got ${body.order.order_number}`)
      assert(body.order.email === 'slugless-2.7@gbox.co', `email should match, got ${body.order.email}`)
      assert(body.order.financial_status === 'paid', `financial_status should be paid, got ${body.order.financial_status}`)
      assert(parseFloat(body.order.total_price) > 0, `total_price should be > 0, got ${body.order.total_price}`)
      assert(Array.isArray(body.line_items) && body.line_items.length === 1, 'has exactly 1 line item')
      assert(body.line_items[0].quantity === 2, 'line item quantity matches')
      assert(body.shop?.slug === slug, 'shop slug returned')
    }
    console.log('PASS 7/8 — GET /order 200 on completed checkout with full payload')

    // ================================================================
    // Case 8 — Second GET to confirm endpoint is idempotent.
    // ================================================================
    {
      const { status, body } = await jget(`/api/checkout/${checkout.id}/order`)
      assert(status === 200, 'second read still works')
      assert(body.order.id === completed.order_id, 'order id stable')
    }
    console.log('PASS 8/8 — GET /order is idempotent on repeat reads')

    console.log('\nALL PASSED — slug-less checkout endpoints work end-to-end')
  } finally {
    // Cleanup — delete the order rows we created, then the shop.
    if (shopId) {
      // Orders reference shop_id; we need to clean them up to avoid FK
      // errors when dropping the shop.
      await db.deleteFrom('order_line_items').where('order_id', 'in',
        db.selectFrom('orders').select('id').where('shop_id', '=', shopId)
      ).execute().catch(() => {})
      await db.deleteFrom('orders').where('shop_id', '=', shopId).execute().catch(() => {})
    }
    if (variantId) {
      await db.deleteFrom('product_variants').where('id', '=', variantId).execute().catch(() => {})
    }
    if (productId) {
      await db.deleteFrom('products').where('id', '=', productId).execute().catch(() => {})
    }
    if (shopId) {
      await db.deleteFrom('shops').where('id', '=', shopId).execute().catch(() => {})
    }
    await db.destroy()
    await closeRedis().catch(() => {})
  }
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  console.error(err.stack)
  process.exit(1)
})
