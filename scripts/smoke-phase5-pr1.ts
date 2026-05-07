/**
 * Phase 5 PR1 — Discounts live smoke.
 *
 * Proves against real Postgres (server 1) that:
 *
 *   1. Migration 058 landed — `orders.discount_code`, `orders.discount_id`,
 *      and the partial index `idx_orders_discount_customer` exist.
 *   2. The extracted `validateDiscountForCart` rejects every failure
 *      kind with the matching DU `kind` string.
 *   3. `wasDiscountRedeemedByCustomer` correctly returns true/false
 *      against real orders rows seeded with `discount_id`.
 *   4. End-to-end: a once-per-customer discount that has already been
 *      redeemed by an email bubbles up as `once_per_customer_reached`
 *      for the SAME email on a second attempt.
 *   5. `applyDiscount` writes discount into the Redis session + updates
 *      totals (percentage math pinned).
 *   6. `completeCheckout` stamps discount_code + discount_id + customer_id
 *      onto the final order row.
 *
 * Uses disposable shop + customer (fresh uuid) so nothing touches real
 * data. Rolls back on partial failure via try/finally cleanup.
 *
 * Run on server 2 (LAN host whitelisted in pg_hba.conf on 192.168.1.13):
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *   REDIS_URL=redis://:GboxRedis2026@192.168.1.13:6379/0 \
 *     npx tsx scripts/smoke-phase5-pr1.ts
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { createDb } from '../packages/db/src/index.js'
import {
  validateDiscountForCart,
  wasDiscountRedeemedByCustomer,
  applyDiscount,
  removeDiscount,
  type DiscountRow,
} from '../packages/core/src/modules/discounts/service.js'
import {
  createCheckout,
  updateCheckoutEmail,
  updateCheckoutShipping,
  completeCheckout,
} from '../packages/core/src/modules/checkout/service.js'

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_ID = randomUUID()
const CUSTOMER_ID = randomUUID()
const OTHER_SHOP_ID = randomUUID()
const CUSTOMER_EMAIL = `smoke-pr1+${SUFFIX}@example.test`
const OTHER_EMAIL = `other+${SUFFIX}@example.test`

function log(s: string) {
  // eslint-disable-next-line no-console
  console.log(s)
}

let failed = 0
function assert(cond: boolean, msg: string) {
  if (cond) log(`  OK   ${msg}`)
  else {
    failed++
    log(`  FAIL ${msg}`)
  }
}

/**
 * Fully specify all discount columns — default values would bypass the
 * paths we want to smoke-test.
 */
function discountValues(partial: Partial<DiscountRow> & { shop_id: string }): any {
  return {
    id: partial.id ?? randomUUID(),
    shop_id: partial.shop_id,
    title: 'Smoke test discount',
    code: partial.code ?? `SMOKE${SUFFIX}`,
    type: partial.type ?? 'percentage',
    value: partial.value ?? '10.00',
    value_type: partial.value_type ?? 'percentage',
    applies_to: 'all',
    minimum_requirement_type: partial.minimum_requirement_type ?? 'none',
    minimum_requirement_value: partial.minimum_requirement_value ?? null,
    usage_limit: partial.usage_limit ?? null,
    once_per_customer: partial.once_per_customer ?? false,
    usage_count: partial.usage_count ?? 0,
    starts_at: partial.starts_at ?? new Date(Date.now() - 86_400_000).toISOString(),
    ends_at: partial.ends_at ?? null,
    status: partial.status ?? 'active',
  }
}

async function main() {
  log(`\n=== Phase 5 PR1 smoke — shop_id=${SHOP_ID} customer_id=${CUSTOMER_ID} ===\n`)

  // ---------- Section 0: migration sanity ----------
  log('[0] Migration 058 sanity')
  const cols = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns
      WHERE table_name = 'orders'
        AND column_name IN ('discount_code', 'discount_id')
  `.execute(db)
  const colNames = cols.rows.map((r) => r.column_name).sort()
  assert(
    colNames.includes('discount_code') && colNames.includes('discount_id'),
    `orders has discount_code + discount_id columns (${colNames.join(', ')})`,
  )

  const idx = await sql<{ indexname: string }>`
    SELECT indexname FROM pg_indexes
      WHERE tablename = 'orders' AND indexname = 'idx_orders_discount_customer'
  `.execute(db)
  assert(idx.rows.length === 1, 'idx_orders_discount_customer partial index exists')

  // ---------- Section 1: seed shop + customer + product + variant ----------
  log('\n[1] Seeding shop, customer, product, variant')

  await db
    .insertInto('shops')
    .values({
      id: SHOP_ID,
      slug: `smoke-pr1-${SUFFIX}`,
      name: 'PR1 smoke shop',
      email: `shop-${SUFFIX}@example.test`,
    } as any)
    .execute()

  await db
    .insertInto('shops')
    .values({
      id: OTHER_SHOP_ID,
      slug: `smoke-pr1-other-${SUFFIX}`,
      name: 'PR1 other shop',
      email: `other-shop-${SUFFIX}@example.test`,
    } as any)
    .execute()

  await db
    .insertInto('customers')
    .values({
      id: CUSTOMER_ID,
      shop_id: SHOP_ID,
      email: CUSTOMER_EMAIL,
      status: 'active',
      accepts_marketing: false,
    } as any)
    .execute()

  const productId = randomUUID()
  await db
    .insertInto('products')
    .values({
      id: productId,
      shop_id: SHOP_ID,
      title: 'Smoke Product',
      slug: `smoke-product-${SUFFIX}`,
      status: 'active',
    } as any)
    .execute()

  const variantId = randomUUID()
  await db
    .insertInto('product_variants')
    .values({
      id: variantId,
      product_id: productId,
      title: 'Default',
      price: '25.00',
      sku: `SMK-${SUFFIX}`,
      inventory_quantity: 100,
      inventory_policy: 'deny',
      requires_shipping: true,
      taxable: false,
      weight: 0.1,
    } as any)
    .execute()

  log('  seeded shop + customer + product + variant')

  // ---------- Section 2: seed discounts ----------
  log('\n[2] Seeding discounts (one per failure kind)')

  const discActive = discountValues({
    shop_id: SHOP_ID,
    code: `SMK-ACTIVE-${SUFFIX}`,
    value: '10.00',
    value_type: 'percentage',
  })
  const discInactive = discountValues({
    shop_id: SHOP_ID,
    code: `SMK-INACTIVE-${SUFFIX}`,
    status: 'expired',
  })
  const discNotStarted = discountValues({
    shop_id: SHOP_ID,
    code: `SMK-FUTURE-${SUFFIX}`,
    starts_at: new Date(Date.now() + 86_400_000).toISOString(),
  })
  const discExpired = discountValues({
    shop_id: SHOP_ID,
    code: `SMK-EXPIRED-${SUFFIX}`,
    starts_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    ends_at: new Date(Date.now() - 86_400_000).toISOString(),
  })
  const discUsageCap = discountValues({
    shop_id: SHOP_ID,
    code: `SMK-CAPPED-${SUFFIX}`,
    usage_limit: 1,
    usage_count: 1,
  })
  const discMinPurchase = discountValues({
    shop_id: SHOP_ID,
    code: `SMK-MIN100-${SUFFIX}`,
    minimum_requirement_type: 'purchase_amount',
    minimum_requirement_value: '100.00',
  })
  const discMinItems = discountValues({
    shop_id: SHOP_ID,
    code: `SMK-MIN3-${SUFFIX}`,
    minimum_requirement_type: 'item_count',
    minimum_requirement_value: '3',
  })
  const discOncePerCust = discountValues({
    shop_id: SHOP_ID,
    code: `SMK-ONCE-${SUFFIX}`,
    once_per_customer: true,
  })
  const discFixed = discountValues({
    shop_id: SHOP_ID,
    code: `SMK-FIXED5-${SUFFIX}`,
    type: 'fixed_amount',
    value_type: 'fixed',
    value: '5.00',
  })
  const discFreeShip = discountValues({
    shop_id: SHOP_ID,
    code: `SMK-FREESHIP-${SUFFIX}`,
    type: 'free_shipping',
    value_type: 'fixed',
    value: '0.00',
  })
  // Cross-shop defence: an identical code on a DIFFERENT shop must NOT
  // be applicable to this shop's checkouts.
  const discOtherShop = discountValues({
    shop_id: OTHER_SHOP_ID,
    code: `SMK-ACTIVE-${SUFFIX}`, // SAME code as discActive, different shop
  })

  const allDiscounts = [
    discActive,
    discInactive,
    discNotStarted,
    discExpired,
    discUsageCap,
    discMinPurchase,
    discMinItems,
    discOncePerCust,
    discFixed,
    discFreeShip,
    discOtherShop,
  ]
  await db.insertInto('discounts').values(allDiscounts as any).execute()
  log(`  seeded ${allDiscounts.length} discount rows`)

  // ---------- Section 3: validateDiscountForCart — all 8 failure kinds ----------
  log('\n[3] validateDiscountForCart rejects every failure kind')

  const baselineCart = {
    subtotal: '50.00',
    itemCount: 2,
    customerId: CUSTOMER_ID,
    email: CUSTOMER_EMAIL,
  }

  {
    const r = await validateDiscountForCart(db, discInactive as DiscountRow, baselineCart)
    assert(!r.ok && r.kind === 'inactive', 'inactive → kind=inactive')
  }
  {
    const r = await validateDiscountForCart(db, discNotStarted as DiscountRow, baselineCart)
    assert(!r.ok && r.kind === 'not_started', 'future starts_at → kind=not_started')
  }
  {
    const r = await validateDiscountForCart(db, discExpired as DiscountRow, baselineCart)
    assert(!r.ok && r.kind === 'expired', 'past ends_at → kind=expired')
  }
  {
    const r = await validateDiscountForCart(db, discUsageCap as DiscountRow, baselineCart)
    assert(!r.ok && r.kind === 'usage_cap_reached', 'usage_count == usage_limit → kind=usage_cap_reached')
  }
  {
    const r = await validateDiscountForCart(db, discMinPurchase as DiscountRow, {
      ...baselineCart,
      subtotal: '50.00',
    })
    assert(!r.ok && r.kind === 'min_purchase_not_met', 'subtotal < min_purchase → kind=min_purchase_not_met')
  }
  {
    const r = await validateDiscountForCart(db, discMinItems as DiscountRow, {
      ...baselineCart,
      itemCount: 1,
    })
    assert(!r.ok && r.kind === 'min_items_not_met', 'itemCount < min_items → kind=min_items_not_met')
  }

  // ---------- Section 4: validateDiscountForCart — success paths ----------
  log('\n[4] validateDiscountForCart accepts valid discounts')

  {
    const r = await validateDiscountForCart(db, discActive as DiscountRow, baselineCart)
    assert(r.ok, 'active percentage discount accepted')
  }
  {
    const r = await validateDiscountForCart(db, discFixed as DiscountRow, baselineCart)
    assert(r.ok, 'fixed_amount discount accepted')
  }
  {
    const r = await validateDiscountForCart(db, discFreeShip as DiscountRow, baselineCart)
    assert(r.ok, 'free_shipping discount accepted')
  }
  {
    const r = await validateDiscountForCart(db, discMinPurchase as DiscountRow, {
      ...baselineCart,
      subtotal: '150.00',
    })
    assert(r.ok, 'min_purchase met → accepted')
  }

  // ---------- Section 5: wasDiscountRedeemedByCustomer ----------
  log('\n[5] wasDiscountRedeemedByCustomer direct lookup')

  // Fully anonymous (no id + no email) → always false
  {
    const hit = await wasDiscountRedeemedByCustomer(db, SHOP_ID, discOncePerCust.id, {
      customerId: null,
      email: null,
    })
    assert(hit === false, 'anonymous (no id, no email) → false')
  }

  // No past orders yet → false
  {
    const hit = await wasDiscountRedeemedByCustomer(db, SHOP_ID, discOncePerCust.id, {
      customerId: CUSTOMER_ID,
      email: CUSTOMER_EMAIL,
    })
    assert(hit === false, 'customer with no prior orders → false')
  }

  // Seed a past order with discount_id stamped
  const pastOrderId = randomUUID()
  await db
    .insertInto('orders')
    .values({
      id: pastOrderId,
      shop_id: SHOP_ID,
      customer_id: CUSTOMER_ID,
      email: CUSTOMER_EMAIL,
      financial_status: 'paid',
      fulfillment_status: 'unfulfilled',
      currency: 'USD',
      subtotal_price: '50.00',
      total_discounts: '5.00',
      total_shipping: '0.00',
      total_tax: '0.00',
      total_price: '45.00',
      discount_code: discOncePerCust.code,
      discount_id: discOncePerCust.id,
    } as any)
    .execute()

  // Now by customer_id → true
  {
    const hit = await wasDiscountRedeemedByCustomer(db, SHOP_ID, discOncePerCust.id, {
      customerId: CUSTOMER_ID,
      email: OTHER_EMAIL, // deliberately mismatched email
    })
    assert(hit === true, 'match by customer_id (email differs) → true')
  }

  // By email alone → true (guest fallback)
  {
    const hit = await wasDiscountRedeemedByCustomer(db, SHOP_ID, discOncePerCust.id, {
      customerId: null,
      email: CUSTOMER_EMAIL,
    })
    assert(hit === true, 'match by email (no customer_id) → true')
  }

  // Cross-shop: same discount_id but different shop → false
  {
    const hit = await wasDiscountRedeemedByCustomer(db, OTHER_SHOP_ID, discOncePerCust.id, {
      customerId: CUSTOMER_ID,
      email: CUSTOMER_EMAIL,
    })
    assert(hit === false, 'same discount_id but queried under other shop → false (shop scoping)')
  }

  // ---------- Section 6: validateDiscountForCart ∪ once_per_customer ----------
  log('\n[6] validateDiscountForCart bubbles once_per_customer_reached')

  {
    const r = await validateDiscountForCart(db, discOncePerCust as DiscountRow, {
      subtotal: '50.00',
      itemCount: 1,
      customerId: CUSTOMER_ID,
      email: CUSTOMER_EMAIL,
    })
    assert(
      !r.ok && r.kind === 'once_per_customer_reached',
      'repeat buyer → kind=once_per_customer_reached',
    )
  }

  // Brand-new identity (different email, no customer_id) → should pass
  {
    const r = await validateDiscountForCart(db, discOncePerCust as DiscountRow, {
      subtotal: '50.00',
      itemCount: 1,
      customerId: null,
      email: `fresh+${SUFFIX}@example.test`,
    })
    assert(r.ok, 'fresh buyer on once_per_customer discount → accepted')
  }

  // ---------- Section 7: applyDiscount + removeDiscount runtime path ----------
  log('\n[7] applyDiscount mutates live checkout + recalcs totals')

  // Create a new checkout, apply active discount, verify totals math.
  const checkout = await createCheckout(
    db,
    SHOP_ID,
    [{ variant_id: variantId, quantity: 2 }], // 2 * 25.00 = 50.00
    { email: `applydisc+${SUFFIX}@example.test`, customerId: null },
  )
  assert(checkout.subtotal_price === '50.00', 'baseline subtotal 50.00')

  const applied = await applyDiscount(db, checkout.id, discActive.code!)
  assert(applied.discount?.code === discActive.code, 'applied.discount.code matches')
  assert(applied.total_discounts === '5.00', `10% of 50.00 → total_discounts 5.00 (got ${applied.total_discounts})`)
  assert(applied.total_price === '45.00', `50 - 5 → total_price 45.00 (got ${applied.total_price})`)

  // Apply a fixed discount larger than subtotal — must clamp to subtotal
  const big = discountValues({
    shop_id: SHOP_ID,
    code: `SMK-BIGFIXED-${SUFFIX}`,
    type: 'fixed_amount',
    value_type: 'fixed',
    value: '999.00',
  })
  await db.insertInto('discounts').values(big as any).execute()
  const bigApplied = await applyDiscount(db, checkout.id, big.code!)
  assert(bigApplied.total_discounts === '50.00', `fixed 999 clamped to subtotal 50 (got ${bigApplied.total_discounts})`)
  assert(bigApplied.total_price === '0.00', 'fixed-amount clamp → total_price 0.00')

  // Remove discount
  const removed = await removeDiscount(checkout.id)
  assert(removed.discount === null, 'removeDiscount clears discount')
  assert(removed.total_discounts === '0.00', 'total_discounts reset to 0.00')
  assert(removed.total_price === '50.00', 'total_price back to subtotal')

  // Attempt bogus code → throws
  try {
    await applyDiscount(db, checkout.id, 'BOGUS-NOT-FOUND')
    assert(false, 'bogus code should throw')
  } catch (err: any) {
    assert(
      /not found/i.test(err.message),
      `bogus code rejected with "Discount code not found" (got: ${err.message})`,
    )
  }

  // Attempt cross-shop code → rejected (code exists on OTHER_SHOP but
  // not on this shop under the same SELECT)
  try {
    // discOtherShop has the SAME .code as discActive, but belongs to
    // OTHER_SHOP_ID. Since we just removed the discount above we can
    // re-apply discActive.code and it should RESOLVE to discActive
    // (same shop). That's expected behavior. To prove cross-shop
    // isolation, create a fresh other-shop code that doesn't collide
    // with any this-shop code.
    const otherOnly = discountValues({
      shop_id: OTHER_SHOP_ID,
      code: `SMK-OTHERONLY-${SUFFIX}`,
    })
    await db.insertInto('discounts').values(otherOnly as any).execute()
    await applyDiscount(db, checkout.id, otherOnly.code!)
    assert(false, 'code from OTHER shop should NOT apply to this checkout')
  } catch (err: any) {
    assert(
      /not found/i.test(err.message),
      `cross-shop code rejected (got: ${err.message})`,
    )
  }

  // ---------- Section 8: completeCheckout stamps discount onto orders row ----------
  log('\n[8] completeCheckout stamps discount_code + discount_id + customer_id')

  const stampCheckout = await createCheckout(
    db,
    SHOP_ID,
    [{ variant_id: variantId, quantity: 1 }],
    { email: CUSTOMER_EMAIL, customerId: CUSTOMER_ID },
  )
  await updateCheckoutEmail(stampCheckout.id, CUSTOMER_EMAIL)
  await updateCheckoutShipping(stampCheckout.id, {
    first_name: 'Smoke',
    last_name: 'Tester',
    address1: '1 Test Way',
    city: 'Testville',
    country: 'US',
    country_code: 'US',
    zip: '94016',
  } as any)
  await applyDiscount(db, stampCheckout.id, discActive.code!)

  const finalized = await completeCheckout(db, stampCheckout.id, {
    gateway: 'mock',
    status: 'success',
  } as any)
  assert(!!finalized.completed_at, 'completeCheckout returns with completed_at set')

  const orderId = (finalized as any).order_id
  assert(!!orderId, `finalized checkout carries order_id (${orderId})`)

  const orderRow = await db
    .selectFrom('orders')
    .select(['id', 'customer_id', 'discount_code', 'discount_id', 'total_discounts', 'total_price'])
    .where('id', '=', orderId)
    .executeTakeFirst()

  assert(!!orderRow, 'orders row exists for finalized checkout')
  assert(orderRow?.customer_id === CUSTOMER_ID, `orders.customer_id = CUSTOMER_ID (got ${orderRow?.customer_id})`)
  assert(orderRow?.discount_code === discActive.code, `orders.discount_code = ${discActive.code}`)
  assert(orderRow?.discount_id === discActive.id, `orders.discount_id = ${discActive.id}`)
  assert(orderRow?.total_discounts === '2.50', `10% of 25 → 2.50 (got ${orderRow?.total_discounts})`)
  assert(orderRow?.total_price === '22.50', `25 - 2.50 → 22.50 (got ${orderRow?.total_price})`)

  // Cleanup of the finalized order so the shop delete cascades cleanly
  // later: we deliberately DO NOT delete it here — the shop cascade in
  // finally will handle it.
  return { orderId, pastOrderId }
}

async function cleanup() {
  log('\n[cleanup] disposing seeded rows')
  try {
    // Orders delete first (FK discount_id → discounts SET NULL, but the
    // shop cascade would drop them anyway; explicit is clearer).
    await db.deleteFrom('orders').where('shop_id', '=', SHOP_ID).execute()
    await db.deleteFrom('orders').where('shop_id', '=', OTHER_SHOP_ID).execute()
    await db.deleteFrom('discounts').where('shop_id', '=', SHOP_ID).execute()
    await db.deleteFrom('discounts').where('shop_id', '=', OTHER_SHOP_ID).execute()
    await db.deleteFrom('customers').where('shop_id', '=', SHOP_ID).execute()
    await db.deleteFrom('product_variants').where('id', 'in',
      db.selectFrom('products').select('id').where('shop_id', '=', SHOP_ID)
    ).execute()
    await db.deleteFrom('products').where('shop_id', '=', SHOP_ID).execute()
    await db.deleteFrom('shops').where('id', 'in', [SHOP_ID, OTHER_SHOP_ID]).execute()
    log('  cleanup done')
  } catch (err: any) {
    log(`  cleanup FAILED: ${err.message}`)
  }
}

main()
  .then(async () => {
    await cleanup()
    log('\n' + '='.repeat(60))
    if (failed === 0) {
      log('PHASE 5 PR1 SMOKE: ALL CHECKS PASSED')
      process.exit(0)
    } else {
      log(`PHASE 5 PR1 SMOKE: ${failed} CHECK(S) FAILED`)
      process.exit(1)
    }
  })
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error('FATAL:', err)
    await cleanup()
    process.exit(1)
  })
