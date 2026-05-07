/**
 * Smoke test — PayPal Partner cancellation flow.
 *
 * Scope:
 *   1. cancelCheckout()  — checkout/service.ts (Redis-backed session teardown)
 *   2. cancelPayPalPartnerOrder() — gateway.ts (mocked PayPal HTTP)
 *
 * Why these two together: the production cancel route (POST
 * /api/store/:slug/payments/paypal-partner/cancel) calls them in sequence
 * and the contract between them is the source of subtle bugs:
 *   - what if PayPal says COMPLETED?  → must NOT remove the local checkout
 *   - what if the local checkout is missing? → must still 200, not 500
 *   - what if the local checkout is already completed? → must 409, not silently void
 *
 * Run:
 *   DATABASE_URL=postgres://... npx tsx tests/paypal-partner-cancel.test.ts
 */

import { createDb } from '../packages/db/src/index.js'
import {
  createCheckout,
  cancelCheckout,
  getCheckout,
  completeCheckout,
} from '../packages/core/src/modules/checkout/service.js'
import { cancelPayPalPartnerOrder } from '../packages/core/src/modules/payments/paypal-partner/gateway.js'

function assert(cond: any, msg: string): asserts cond {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg)
}

// Mock fetch so the gateway helper never touches the real PayPal API.
// We swap globalThis.fetch around `cancelPayPalPartnerOrder` calls.
function withMockedFetch<T>(
  responder: (url: string) => { status: number; body: unknown },
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    const { status, body } = responder(url)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

async function main() {
  const db = createDb()
  const suffix = Math.random().toString(36).slice(2, 10)
  const slug = `cancelflow-${suffix}`
  let shopId: string | undefined
  let productId: string | undefined
  let variantId: string | undefined
  // Stash + restore PayPal env so the gateway helper resolves config
  // even when the test runner has nothing exported.
  const savedEnv = {
    PAYPAL_PARTNER_CLIENT_ID: process.env.PAYPAL_PARTNER_CLIENT_ID,
    PAYPAL_PARTNER_SECRET: process.env.PAYPAL_PARTNER_SECRET,
    PAYPAL_PARTNER_ID: process.env.PAYPAL_PARTNER_ID,
    PAYPAL_PARTNER_BN_CODE: process.env.PAYPAL_PARTNER_BN_CODE,
    PAYPAL_PARTNER_API_BASE: process.env.PAYPAL_PARTNER_API_BASE,
  }
  process.env.PAYPAL_PARTNER_CLIENT_ID = 'client_test_cancel'
  process.env.PAYPAL_PARTNER_SECRET = 'secret_test_cancel'
  process.env.PAYPAL_PARTNER_ID = 'partner_test_cancel'
  process.env.PAYPAL_PARTNER_BN_CODE = 'Gbox_Ecom'
  process.env.PAYPAL_PARTNER_API_BASE = 'https://api.sandbox.paypal.com'

  try {
    // ---- Seed shop + product + variant ----
    const shop = await db
      .insertInto('shops')
      .values({
        name: `Cancel Flow Test ${suffix}`,
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
        title: 'Test Cancel Product',
        slug: `test-cancel-${suffix}`,
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
        price: '10.00',
        inventory_quantity: 100,
        requires_shipping: true,
        taxable: true,
      } as any)
      .returning('id')
      .executeTakeFirstOrThrow()
    variantId = variant.id!

    // ================================================================
    // Case 1 — cancelCheckout() on a fresh checkout: returns snapshot,
    //          subsequent getCheckout returns null.
    // ================================================================
    const checkout1 = await createCheckout(db, shopId, [
      { variant_id: variantId, quantity: 1 },
    ])
    assert(checkout1.id, 'checkout1 created')
    assert(checkout1.completed_at === null, 'checkout1 not completed')

    const cancelled1 = await cancelCheckout(checkout1.id, 'unit_test_reason')
    assert(cancelled1 !== null, 'cancelled1 returned a snapshot')
    assert(cancelled1!.id === checkout1.id, 'snapshot id matches')
    assert(
      (cancelled1 as any).cancel_reason === 'unit_test_reason',
      'cancel_reason stamped on snapshot',
    )

    const after1 = await getCheckout(checkout1.id)
    assert(after1 === null, 'checkout removed from store after cancel')
    console.log('PASS 1/5 — cancelCheckout removes a fresh checkout')

    // ================================================================
    // Case 2 — cancelCheckout() on a missing id is idempotent (returns null).
    // ================================================================
    const cancelledMissing = await cancelCheckout(
      'chk_does_not_exist_xyz',
      'idempotent_check',
    )
    assert(cancelledMissing === null, 'missing checkout returns null, not throw')
    console.log('PASS 2/5 — cancelCheckout is idempotent for missing checkouts')

    // ================================================================
    // Case 3 — cancelCheckout() refuses a completed checkout.
    // ================================================================
    const checkout3 = await createCheckout(db, shopId, [
      { variant_id: variantId, quantity: 1 },
    ])
    // Bring it to a state where completeCheckout() will succeed: email +
    // shipping address. Skip shipping rate selection by using a no-shipping
    // SKU? — variant requires shipping, so we DO need an address.
    // Easiest: import the helpers we already have.
    const { updateCheckoutEmail, updateCheckoutShipping } = await import(
      '../packages/core/src/modules/checkout/service.js'
    )
    await updateCheckoutEmail(checkout3.id, 'cancelflow@test.local')
    await updateCheckoutShipping(checkout3.id, {
      first_name: 'Cancel',
      last_name: 'Flow',
      address1: '123 Test St',
      city: 'Testville',
      province: 'CA',
      country: 'United States',
      country_code: 'US',
      zip: '94000',
      phone: '+15555555555',
    } as any)

    const completed3 = await completeCheckout(db, checkout3.id, {
      gateway: 'manual',
      gateway_transaction_id: 'manual_test_txn',
    })
    assert(completed3.completed_at !== null, 'checkout3 marked complete')
    assert(completed3.order_id, 'checkout3 has order_id')

    let threw = false
    try {
      await cancelCheckout(checkout3.id, 'should_fail')
    } catch (err: any) {
      threw = true
      assert(
        /Cannot cancel a completed checkout/.test(err.message),
        `wrong error message: ${err.message}`,
      )
    }
    assert(threw, 'cancelCheckout must throw on completed checkout')
    console.log('PASS 3/5 — cancelCheckout refuses a completed checkout')

    // Clean up the order side effects so the test cleanup at the end
    // can drop the variant + product without FK violations.
    await db
      .deleteFrom('order_line_items')
      .where('order_id', '=', completed3.order_id!)
      .execute()
    await db
      .deleteFrom('orders')
      .where('id', '=', completed3.order_id!)
      .execute()

    // ================================================================
    // Case 4 — cancelPayPalPartnerOrder() with PayPal returning
    //          status=CREATED → cancellable=true, alreadyCaptured=false.
    // ================================================================
    await withMockedFetch(
      (url) => {
        if (url.includes('/v1/oauth2/token')) {
          return {
            status: 200,
            body: { access_token: 'fake', expires_in: 3600 },
          }
        }
        if (url.includes('/v2/checkout/orders/')) {
          return { status: 200, body: { id: 'PP-ORDER-1', status: 'CREATED' } }
        }
        return { status: 404, body: {} }
      },
      async () => {
        const result = await cancelPayPalPartnerOrder('PP-ORDER-1')
        assert(result.cancellable === true, 'CREATED order cancellable')
        assert(
          result.alreadyCaptured === false,
          'CREATED order not yet captured',
        )
        assert(
          result.paypalStatus === 'CREATED',
          `status mismatch: ${result.paypalStatus}`,
        )
      },
    )
    console.log('PASS 4/5 — cancelPayPalPartnerOrder handles CREATED order')

    // ================================================================
    // Case 5 — cancelPayPalPartnerOrder() with PayPal returning
    //          status=COMPLETED → cancellable=false, alreadyCaptured=true.
    //          The route should turn this into a 409 conflict.
    // ================================================================
    await withMockedFetch(
      (url) => {
        if (url.includes('/v1/oauth2/token')) {
          return {
            status: 200,
            body: { access_token: 'fake', expires_in: 3600 },
          }
        }
        if (url.includes('/v2/checkout/orders/')) {
          return {
            status: 200,
            body: { id: 'PP-ORDER-2', status: 'COMPLETED' },
          }
        }
        return { status: 404, body: {} }
      },
      async () => {
        const result = await cancelPayPalPartnerOrder('PP-ORDER-2')
        assert(
          result.alreadyCaptured === true,
          'COMPLETED order alreadyCaptured=true',
        )
        assert(result.cancellable === false, 'COMPLETED order NOT cancellable')
        assert(
          result.paypalStatus === 'COMPLETED',
          `status mismatch: ${result.paypalStatus}`,
        )
      },
    )
    console.log(
      'PASS 5/5 — cancelPayPalPartnerOrder refuses to cancel a captured order',
    )

    console.log('\nALL PASSED — cancellation flow safe for buyer-abandons-PayPal')
  } finally {
    if (variantId) {
      await db
        .deleteFrom('product_variants')
        .where('id', '=', variantId)
        .execute()
        .catch(() => {})
    }
    if (productId) {
      await db
        .deleteFrom('products')
        .where('id', '=', productId)
        .execute()
        .catch(() => {})
    }
    if (shopId) {
      await db
        .deleteFrom('shop_settings')
        .where('shop_id', '=', shopId)
        .execute()
        .catch(() => {})
      await db
        .deleteFrom('shops')
        .where('id', '=', shopId)
        .execute()
        .catch(() => {})
    }
    // Restore env
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete (process.env as any)[k]
      else (process.env as any)[k] = v
    }
    await db.destroy()
  }
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  console.error(err.stack)
  process.exit(1)
})
