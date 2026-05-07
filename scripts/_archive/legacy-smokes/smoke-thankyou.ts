/**
 * Smoke test for Step 2.6 — thank-you page + GET /api/checkout/:id/order
 *
 * Flow:
 *   1. Create a fresh checkout via the public API
 *   2. Set email + shipping address
 *   3. Select a shipping rate
 *   4. Call completeCheckout() DIRECTLY (bypasses PayPal because the
 *      gbox-demo shop has no PayPal onboarding in the test env)
 *   5. GET /api/checkout/:id/order and verify the response
 *   6. Render the live thank-you page via apps/checkout and verify
 *      the order number appears in the HTML
 *
 * Run from ~/gbox-platform on server 2:
 *   npx tsx scripts/smoke-thankyou.ts
 */

import { getDb } from '@gbox/db'
import { completeCheckout } from '@gbox/core/modules/checkout/service.js'

const db = getDb()

const API = process.env.API_BASE_URL ?? 'http://127.0.0.1:4321'
const CHECKOUT_APP = process.env.CHECKOUT_APP_URL ?? 'http://127.0.0.1:4327'
const SHOP_SLUG = process.env.SMOKE_SHOP_SLUG ?? 'gbox-demo'

async function jfetch<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const text = await res.text()
  let body: any
  try { body = JSON.parse(text) } catch { body = text }
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${url} → ${res.status}: ${text.slice(0, 300)}`)
  }
  return body as T
}

async function main() {
  console.log('== Step 2.6 smoke test ==')
  console.log(`API: ${API}`)
  console.log(`apps/checkout: ${CHECKOUT_APP}`)
  console.log(`Shop: ${SHOP_SLUG}`)

  // 1. Find a variant with stock.
  const variant = await db
    .selectFrom('product_variants as pv')
    .innerJoin('products as p', 'p.id', 'pv.product_id')
    .innerJoin('shops as s', 's.id', 'p.shop_id')
    .select(['pv.id as id'])
    .where('s.slug', '=', SHOP_SLUG)
    .where('pv.inventory_quantity', '>', 0)
    .limit(1)
    .executeTakeFirst()
  if (!variant) throw new Error(`No stocked variant found for shop ${SHOP_SLUG}`)
  console.log(`variant: ${variant.id}`)

  // 2. Create checkout.
  const createRes = await jfetch<{ checkout: { id: string } }>(
    `${API}/api/store/${SHOP_SLUG}/checkout`,
    {
      method: 'POST',
      body: JSON.stringify({ items: [{ variant_id: variant.id, quantity: 1 }] }),
    },
  )
  const checkoutId = createRes.checkout.id
  console.log(`checkout: ${checkoutId}`)

  // 3. Email + shipping.
  await jfetch(`${API}/api/store/${SHOP_SLUG}/checkout/${checkoutId}/email`, {
    method: 'PUT',
    body: JSON.stringify({ email: 'smoke-2.6@gbox.co' }),
  })
  await jfetch(`${API}/api/store/${SHOP_SLUG}/checkout/${checkoutId}/shipping`, {
    method: 'PUT',
    body: JSON.stringify({
      first_name: 'Smoke',
      last_name: 'Tester',
      address1: '100 Harbor Way',
      city: 'San Francisco',
      province: 'CA',
      zip: '94107',
      country: 'US',
      country_code: 'US',
    }),
  })

  // 4. Pick a rate.
  const rates = await jfetch<{ shipping_rates: Array<{ id: string; name: string; price: string; type: string }> }>(
    `${API}/api/store/${SHOP_SLUG}/checkout/${checkoutId}/shipping-rates`,
  )
  const rate = rates.shipping_rates?.[0]
  if (!rate) throw new Error('No shipping rates available')
  console.log(`rate: ${rate.id} ${rate.name} $${rate.price}`)
  await jfetch(`${API}/api/store/${SHOP_SLUG}/checkout/${checkoutId}/shipping-rate`, {
    method: 'PUT',
    body: JSON.stringify({ rate_id: rate.id, name: rate.name, price: rate.price, type: rate.type }),
  })

  // 5. Complete checkout directly (bypasses PayPal). This mirrors what
  //    the POST /api/checkout/:id/paypal/capture route does on capture
  //    COMPLETED.
  console.log('completing checkout directly...')
  const fake_capture_id = `SMOKE-${Date.now()}`
  const completed = await completeCheckout(db, checkoutId, {
    gateway: 'paypal',
    gateway_transaction_id: fake_capture_id,
  })
  if (!completed.order_id) throw new Error('completeCheckout did not produce an order_id')
  console.log(`order: ${completed.order_id}`)

  // 6. Hit the new /order endpoint.
  const orderRes = await jfetch<{ order: any; line_items: any[]; shop: any }>(
    `${API}/api/checkout/${checkoutId}/order`,
  )
  console.log(`order_number: ${orderRes.order.order_number}`)
  console.log(`financial_status: ${orderRes.order.financial_status}`)
  console.log(`total_price: ${orderRes.order.total_price}`)
  console.log(`line_items: ${orderRes.line_items.length}`)
  if (orderRes.line_items.length === 0) throw new Error('no line items returned')

  // 7. Render the live thank-you page and sanity-grep it.
  const pageRes = await fetch(`${CHECKOUT_APP}/c/${checkoutId}/thankyou`)
  const html = await pageRes.text()
  console.log(`page status: ${pageRes.status}`)
  const needles = [
    `Order <strong>#${orderRes.order.order_number}</strong>`,
    'smoke-2.6@gbox.co',
    'Smoke',
    '100 Harbor Way',
    'Total paid',
  ]
  const missing = needles.filter((n) => !html.includes(n))
  if (missing.length) {
    console.error('page missing needles:', missing)
    console.error('---first 2000 chars---')
    console.error(html.slice(0, 2000))
    process.exit(1)
  }
  console.log('all needles present in rendered HTML ✓')
  console.log('== smoke test PASSED ==')
  process.exit(0)
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err)
  process.exit(1)
})
