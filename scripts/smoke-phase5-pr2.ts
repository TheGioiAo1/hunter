/**
 * Phase 5 PR2 — Discount product/collection scope live smoke.
 *
 * Proves against real Postgres + Redis on server 1 that:
 *
 *   1. `resolveDiscountScope` + `eligibleSubtotal` correctly filter line
 *      items by `applies_to='specific_products'` using `target_selection`.
 *   2. `specific_collections` scope expands via `collection_products` and
 *      matches line items whose product is in any targeted collection.
 *   3. `validateDiscountForCart` returns `kind='no_eligible_items'` when
 *      the scope matches zero cart lines.
 *   4. `applyDiscount` stamps `eligible_product_ids` onto the Redis
 *      session AND computes discount against the eligible subtotal
 *      (not the full cart).
 *   5. `completeCheckout` still writes discount_code + discount_id to
 *      `orders` — the PR1 behavior hasn't regressed under scoped
 *      discounts.
 *
 * Run on server 2:
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *   REDIS_URL=redis://:GboxRedis2026@192.168.1.13:6379/0 \
 *     npx tsx scripts/smoke-phase5-pr2.ts
 */

import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  validateDiscountForCart,
  resolveDiscountScope,
  eligibleSubtotal,
  applyDiscount,
  removeDiscount,
  type DiscountRow,
} from '../packages/core/src/modules/discounts/service.js'
import {
  createCheckout,
  completeCheckout,
  updateCheckoutEmail,
  updateCheckoutShipping,
} from '../packages/core/src/modules/checkout/service.js'

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_ID = randomUUID()

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

function discountValues(partial: Partial<DiscountRow> & { shop_id: string }): any {
  // target_selection is jsonb — pg driver needs a JSON-encoded string,
  // not a raw JS array (which becomes a Postgres array literal `{uuid}`).
  const ts = partial.target_selection
  const targetSelection = ts === undefined || ts === null ? null : JSON.stringify(ts)
  return {
    id: partial.id ?? randomUUID(),
    shop_id: partial.shop_id,
    title: 'PR2 scope smoke',
    code: partial.code ?? `SMK2-${SUFFIX}`,
    type: partial.type ?? 'percentage',
    value: partial.value ?? '10.00',
    value_type: partial.value_type ?? 'percentage',
    applies_to: partial.applies_to ?? 'all',
    target_selection: targetSelection,
    minimum_requirement_type: 'none',
    minimum_requirement_value: null,
    usage_limit: null,
    once_per_customer: false,
    usage_count: 0,
    starts_at: new Date(Date.now() - 86_400_000).toISOString(),
    ends_at: null,
    status: 'active',
  }
}

async function main() {
  log(`\n=== Phase 5 PR2 scope smoke — shop_id=${SHOP_ID} ===\n`)

  // ---------- Section 1: seed shop + 3 products + 2 collections ----------
  log('[1] Seeding shop, 3 products, 2 collections')

  await db
    .insertInto('shops')
    .values({
      id: SHOP_ID,
      slug: `smoke-pr2-${SUFFIX}`,
      name: 'PR2 scope smoke shop',
      email: `shop-pr2-${SUFFIX}@example.test`,
    } as any)
    .execute()

  // 3 products, each with 1 variant.
  const productA = randomUUID()
  const productB = randomUUID()
  const productC = randomUUID()
  const variantA = randomUUID()
  const variantB = randomUUID()
  const variantC = randomUUID()

  for (const [pid, title] of [
    [productA, 'Widget A'],
    [productB, 'Widget B'],
    [productC, 'Widget C'],
  ] as const) {
    await db
      .insertInto('products')
      .values({
        id: pid,
        shop_id: SHOP_ID,
        title,
        slug: `${title.toLowerCase().replace(/ /g, '-')}-${SUFFIX}`,
        status: 'active',
      } as any)
      .execute()
  }

  for (const [vid, pid, price] of [
    [variantA, productA, '100.00'],
    [variantB, productB, '50.00'],
    [variantC, productC, '25.00'],
  ] as const) {
    await db
      .insertInto('product_variants')
      .values({
        id: vid,
        product_id: pid,
        title: 'Default',
        price,
        sku: `SMK2-${vid.slice(0, 6)}`,
        inventory_quantity: 100,
        inventory_policy: 'deny',
        requires_shipping: true,
        taxable: false,
        weight: 0.1,
      } as any)
      .execute()
  }

  // 2 collections: sale=[A, B], clearance=[C]
  const colSale = randomUUID()
  const colClearance = randomUUID()
  for (const [cid, slug, title] of [
    [colSale, `sale-${SUFFIX}`, 'Sale'],
    [colClearance, `clearance-${SUFFIX}`, 'Clearance'],
  ] as const) {
    await db
      .insertInto('collections')
      .values({
        id: cid,
        shop_id: SHOP_ID,
        slug,
        title,
      } as any)
      .execute()
  }
  for (const [cid, pid] of [
    [colSale, productA],
    [colSale, productB],
    [colClearance, productC],
  ] as const) {
    await db
      .insertInto('collection_products')
      .values({ collection_id: cid, product_id: pid } as any)
      .execute()
  }
  log(`  seeded 3 products + 2 collections (sale=[A,B], clearance=[C])`)

  // ---------- Section 2: seed scoped discounts ----------
  log('\n[2] Seeding scoped discounts')

  const dAll = discountValues({
    shop_id: SHOP_ID,
    code: `SMK2-ALL-${SUFFIX}`,
    applies_to: 'all',
  })
  const dProdA = discountValues({
    shop_id: SHOP_ID,
    code: `SMK2-PRODA-${SUFFIX}`,
    applies_to: 'specific_products',
    target_selection: [productA],
  })
  const dProdMulti = discountValues({
    shop_id: SHOP_ID,
    code: `SMK2-PRODAB-${SUFFIX}`,
    applies_to: 'specific_products',
    target_selection: [productA, productB],
  })
  const dColSale = discountValues({
    shop_id: SHOP_ID,
    code: `SMK2-COLSALE-${SUFFIX}`,
    applies_to: 'specific_collections',
    target_selection: [colSale],
  })
  const dColClearance = discountValues({
    shop_id: SHOP_ID,
    code: `SMK2-COLCLR-${SUFFIX}`,
    applies_to: 'specific_collections',
    target_selection: [colClearance],
  })
  const dProdMissing = discountValues({
    shop_id: SHOP_ID,
    code: `SMK2-PRODMISS-${SUFFIX}`,
    applies_to: 'specific_products',
    target_selection: ['00000000-0000-0000-0000-000000000000'],
  })
  const dFixedScoped = discountValues({
    shop_id: SHOP_ID,
    code: `SMK2-FIXED-${SUFFIX}`,
    type: 'fixed_amount',
    value_type: 'fixed',
    value: '999.00',
    applies_to: 'specific_products',
    target_selection: [productB], // eligible subtotal will be 50
  })

  await db
    .insertInto('discounts')
    .values([
      dAll,
      dProdA,
      dProdMulti,
      dColSale,
      dColClearance,
      dProdMissing,
      dFixedScoped,
    ] as any)
    .execute()
  log('  seeded 7 discount rows (1 all + 3 products + 2 collections + 1 fixed scoped)')

  // ---------- Section 3: resolveDiscountScope direct ----------
  log('\n[3] resolveDiscountScope direct lookup')

  {
    const s = await resolveDiscountScope(db, dAll as any)
    assert(s.kind === 'all', `applies_to=all → {kind: 'all'}`)
  }
  {
    const s = await resolveDiscountScope(db, dProdA as any)
    const ok = s.kind === 'products' && s.ids.has(productA) && s.ids.size === 1
    assert(ok, `specific_products → Set{productA} only`)
  }
  {
    const s = await resolveDiscountScope(db, dColSale as any)
    const ok =
      s.kind === 'products' &&
      s.ids.has(productA) &&
      s.ids.has(productB) &&
      !s.ids.has(productC) &&
      s.ids.size === 2
    assert(ok, `specific_collections [sale] expands to {A, B}`)
  }
  {
    const s = await resolveDiscountScope(db, dColClearance as any)
    const ok =
      s.kind === 'products' &&
      s.ids.has(productC) &&
      !s.ids.has(productA) &&
      s.ids.size === 1
    assert(ok, `specific_collections [clearance] expands to {C}`)
  }

  // ---------- Section 4: eligibleSubtotal pure math ----------
  log('\n[4] eligibleSubtotal filter math')

  const sampleLines = [
    { product_id: productA, price: '100.00', quantity: 2 }, // 200
    { product_id: productB, price: '50.00', quantity: 1 }, //  50
    { product_id: productC, price: '25.00', quantity: 4 }, // 100
  ]
  assert(eligibleSubtotal({ kind: 'all' }, sampleLines) === 350, 'scope=all sums to 350')
  assert(
    eligibleSubtotal({ kind: 'products', ids: new Set([productA, productC]) }, sampleLines) === 300,
    'scope=[A,C] sums to 300',
  )
  assert(
    eligibleSubtotal({ kind: 'products', ids: new Set([productB]) }, sampleLines) === 50,
    'scope=[B] sums to 50',
  )
  assert(
    eligibleSubtotal({ kind: 'products', ids: new Set(['nope']) }, sampleLines) === 0,
    'scope matching nothing sums to 0',
  )

  // ---------- Section 5: validateDiscountForCart + scope rejections ----------
  log('\n[5] validateDiscountForCart scope enforcement')

  const cartLines = [
    { product_id: productB, price: '50.00', quantity: 1 },
    { product_id: productC, price: '25.00', quantity: 2 },
  ]

  {
    const r = await validateDiscountForCart(db, dProdA as any, {
      subtotal: '100.00',
      itemCount: 3,
      lineItems: cartLines, // cart has B + C, scope = [A]
    })
    assert(!r.ok && r.kind === 'no_eligible_items', 'scope=[A], cart has B+C → no_eligible_items')
  }
  {
    const r = await validateDiscountForCart(db, dProdMulti as any, {
      subtotal: '100.00',
      itemCount: 3,
      lineItems: cartLines, // cart has B + C, scope = [A, B]; B matches
    })
    assert(r.ok, 'scope=[A,B], cart has B+C → accepted (B matches)')
  }
  {
    const r = await validateDiscountForCart(db, dColSale as any, {
      subtotal: '100.00',
      itemCount: 3,
      lineItems: cartLines, // cart has B + C, sale = [A, B]
    })
    assert(r.ok, 'scope=sale=[A,B], cart has B+C → accepted (B in sale)')
  }
  {
    const r = await validateDiscountForCart(db, dColClearance as any, {
      subtotal: '50.00',
      itemCount: 1,
      lineItems: [{ product_id: productB, price: '50.00', quantity: 1 }],
    })
    assert(
      !r.ok && r.kind === 'no_eligible_items',
      'scope=clearance=[C], cart has only B → no_eligible_items',
    )
  }
  {
    // Back-compat: no lineItems → scope check skipped → accepted
    const r = await validateDiscountForCart(db, dProdMissing as any, {
      subtotal: '100.00',
      itemCount: 1,
    })
    assert(r.ok, 'no lineItems → scope check skipped (back-compat)')
  }

  // ---------- Section 6: applyDiscount + eligible_product_ids stamp ----------
  log('\n[6] applyDiscount stamps eligible_product_ids + computes scoped totals')

  const mixedCheckout = await createCheckout(
    db,
    SHOP_ID,
    [
      { variant_id: variantA, quantity: 2 }, // 2 * 100 = 200
      { variant_id: variantB, quantity: 1 }, // 1 * 50  = 50
      { variant_id: variantC, quantity: 4 }, // 4 * 25  = 100
    ],
    { email: `pr2-${SUFFIX}@example.test`, customerId: null },
  )
  assert(mixedCheckout.subtotal_price === '350.00', `mixed cart subtotal 350.00 (got ${mixedCheckout.subtotal_price})`)

  // Scope = [productA] only → eligible 200, 10% = 20.00
  const scopedA = await applyDiscount(db, mixedCheckout.id, dProdA.code!)
  assert(
    scopedA.discount?.eligible_product_ids?.length === 1 &&
      scopedA.discount?.eligible_product_ids?.[0] === productA,
    'eligible_product_ids stamped [productA]',
  )
  assert(
    scopedA.total_discounts === '20.00',
    `10% of 200 (eligible) → 20.00 (got ${scopedA.total_discounts})`,
  )
  assert(
    scopedA.total_price === '330.00',
    `350 - 20 → 330.00 (got ${scopedA.total_price})`,
  )

  // Scope = collection [sale={A,B}] → eligible 250, 10% = 25.00
  const scopedSale = await applyDiscount(db, mixedCheckout.id, dColSale.code!)
  assert(
    (scopedSale.discount?.eligible_product_ids ?? []).sort().join(',') ===
      [productA, productB].sort().join(','),
    'eligible_product_ids stamped [A, B] from collection expansion',
  )
  assert(
    scopedSale.total_discounts === '25.00',
    `10% of 250 (sale eligible) → 25.00 (got ${scopedSale.total_discounts})`,
  )

  // Scope = all → eligible 350, 10% = 35.00, stamp null
  const scopedAll = await applyDiscount(db, mixedCheckout.id, dAll.code!)
  assert(scopedAll.discount?.eligible_product_ids === null, 'applies_to=all stamps null')
  assert(
    scopedAll.total_discounts === '35.00',
    `10% of 350 (all) → 35.00 (got ${scopedAll.total_discounts})`,
  )

  // Scope = fixed 999 on [productB] → clamp to 50
  const scopedFixed = await applyDiscount(db, mixedCheckout.id, dFixedScoped.code!)
  assert(
    scopedFixed.total_discounts === '50.00',
    `fixed 999 clamped to eligible 50 → 50.00 (got ${scopedFixed.total_discounts})`,
  )
  assert(
    scopedFixed.total_price === '300.00',
    `350 - 50 → 300.00 (got ${scopedFixed.total_price})`,
  )

  // Scope matching nothing → throws
  try {
    await applyDiscount(db, mixedCheckout.id, dProdMissing.code!)
    assert(false, 'scope matching nothing should throw')
  } catch (err: any) {
    assert(
      /qualify|eligible/i.test(err.message),
      `no_eligible_items surfaces as: ${err.message}`,
    )
  }

  // ---------- Section 7: completeCheckout still stamps discount ----------
  log('\n[7] completeCheckout stamps scoped discount onto orders row')

  const stampCheckout = await createCheckout(
    db,
    SHOP_ID,
    [
      { variant_id: variantA, quantity: 1 }, // 100
      { variant_id: variantB, quantity: 1 }, // 50
    ],
    { email: `pr2-stamp-${SUFFIX}@example.test`, customerId: null },
  )
  await updateCheckoutEmail(stampCheckout.id, `pr2-stamp-${SUFFIX}@example.test`)
  await updateCheckoutShipping(stampCheckout.id, {
    first_name: 'Scope',
    last_name: 'Tester',
    address1: '1 Scope Way',
    city: 'Scopeville',
    country: 'US',
    country_code: 'US',
    zip: '94016',
  } as any)
  // Apply scoped product A discount: eligible = 100, 10% = 10
  await applyDiscount(db, stampCheckout.id, dProdA.code!)

  const finalized = await completeCheckout(db, stampCheckout.id, {
    gateway: 'manual',
    status: 'success',
  } as any)
  const orderId = (finalized as any).order_id

  const orderRow = await db
    .selectFrom('orders')
    .select(['discount_code', 'discount_id', 'total_discounts', 'total_price'])
    .where('id', '=', orderId)
    .executeTakeFirst()

  assert(orderRow?.discount_code === dProdA.code, 'orders.discount_code persisted')
  assert(orderRow?.discount_id === dProdA.id, 'orders.discount_id persisted')
  assert(orderRow?.total_discounts === '10.00', 'orders.total_discounts = 10.00 (10% of eligible 100)')
  assert(orderRow?.total_price === '140.00', 'orders.total_price = 140.00 (100 + 50 - 10)')

  // ---------- Section 8: removeDiscount reverts totals ----------
  log('\n[8] removeDiscount round-trip on scoped checkout')

  // Fresh checkout, apply, remove, verify totals reset
  const ck2 = await createCheckout(
    db,
    SHOP_ID,
    [{ variant_id: variantA, quantity: 1 }],
    { email: `pr2-rm-${SUFFIX}@example.test`, customerId: null },
  )
  await applyDiscount(db, ck2.id, dProdA.code!)
  const removed = await removeDiscount(ck2.id)
  assert(removed.discount === null, 'removeDiscount clears discount')
  assert(removed.total_discounts === '0.00', 'total_discounts reset to 0.00')
  assert(removed.total_price === '100.00', 'total_price back to subtotal')

  return { orderId }
}

async function cleanup() {
  log('\n[cleanup] disposing seeded rows')
  try {
    await db.deleteFrom('orders').where('shop_id', '=', SHOP_ID).execute()
    await db.deleteFrom('discounts').where('shop_id', '=', SHOP_ID).execute()
    await db
      .deleteFrom('collection_products')
      .where(
        'collection_id',
        'in',
        db
          .selectFrom('collections')
          .select('id')
          .where('shop_id', '=', SHOP_ID),
      )
      .execute()
    await db.deleteFrom('collections').where('shop_id', '=', SHOP_ID).execute()
    await db
      .deleteFrom('product_variants')
      .where(
        'product_id',
        'in',
        db.selectFrom('products').select('id').where('shop_id', '=', SHOP_ID),
      )
      .execute()
    await db.deleteFrom('products').where('shop_id', '=', SHOP_ID).execute()
    await db.deleteFrom('shops').where('id', '=', SHOP_ID).execute()
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
      log('PHASE 5 PR2 SMOKE: ALL CHECKS PASSED')
      process.exit(0)
    } else {
      log(`PHASE 5 PR2 SMOKE: ${failed} CHECK(S) FAILED`)
      process.exit(1)
    }
  })
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error('FATAL:', err)
    await cleanup()
    process.exit(1)
  })
