/**
 * Phase 5 PR5 — BOGO + customer-segment eligibility + discount analytics.
 *
 * Proves against live Postgres + Redis on server 1 that:
 *
 *   1. Migration 061 is live: `discounts.bogo_config` +
 *      `eligible_segment_ids` jsonb columns round-trip through insert →
 *      select → normalize without shape loss.
 *   2. BOGO validator rejects a cart that's too small with the exact
 *      `bogo_cycle_not_met` kind (the reason the admin UI renders the
 *      "Add 1 more item" helper).
 *   3. BOGO `applyDiscount` computes the cheapest-first unit allocation:
 *      two distinct prices in the cart → only the cheapest units are
 *      discounted per cycle, matching Shopify default BOGO behavior.
 *   4. Customer-segment eligibility:
 *        - guest checkout → reject (`customer_not_eligible`)
 *        - non-VIP customer → reject
 *        - VIP customer (tagged in customer_segments rules) → accept
 *      The rule evaluation goes through the real `customer-segments`
 *      module — no mocks, no shortcuts — so this pins end-to-end wiring.
 *   5. `evaluateAutomaticDiscount` compares a BOGO and a percentage
 *      auto-discount using their allocator outputs and picks the
 *      bigger absolute amount.
 *   6. Analytics aggregate (`getDiscountAnalytics` +
 *      `getDiscountAnalyticsBatch`) counts redemptions, sums amounts,
 *      captures first/last redemption timestamps — AND excludes
 *      cancelled orders so a refunded redemption doesn't inflate the
 *      merchant's promo dashboard.
 *
 * Run on server 2:
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *   REDIS_URL=redis://:GboxRedis2026@192.168.1.13:6379/0 \
 *     npx tsx scripts/smoke-phase5-pr5.ts
 */

import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  applyDiscount,
  evaluateAutomaticDiscount,
  validateDiscountForCart,
  normalizeBogoConfig,
  normalizeEligibleSegments,
  getDiscountAnalytics,
  getDiscountAnalyticsBatch,
  type DiscountRow,
} from '../packages/core/src/modules/discounts/service.js'
import { createCheckout } from '../packages/core/src/modules/checkout/service.js'

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

/**
 * Build a `discounts` insert row — jsonb columns need JSON.stringify
 * on the way in (pg auto-parses on the way out).
 */
function discountValues(
  partial: Partial<DiscountRow> & {
    shop_id: string
    method?: string
    bogo_config?: unknown
    eligible_segment_ids?: unknown
  },
): any {
  const ts = partial.target_selection
  const targetSelection =
    ts === undefined || ts === null ? null : JSON.stringify(ts)
  const bogo =
    partial.bogo_config === undefined || partial.bogo_config === null
      ? null
      : JSON.stringify(partial.bogo_config)
  const segs =
    partial.eligible_segment_ids === undefined ||
    partial.eligible_segment_ids === null
      ? null
      : JSON.stringify(partial.eligible_segment_ids)
  return {
    id: partial.id ?? randomUUID(),
    shop_id: partial.shop_id,
    title: partial.code ?? 'PR5 smoke',
    code: partial.code === undefined ? `SMK5-${SUFFIX}` : partial.code,
    type: partial.type ?? 'percentage',
    value: partial.value ?? '0.00',
    value_type: partial.value_type ?? 'percentage',
    applies_to: partial.applies_to ?? 'all',
    target_selection: targetSelection,
    minimum_requirement_type: partial.minimum_requirement_type ?? 'none',
    minimum_requirement_value: partial.minimum_requirement_value ?? null,
    usage_limit: partial.usage_limit ?? null,
    once_per_customer: partial.once_per_customer ?? false,
    usage_count: partial.usage_count ?? 0,
    starts_at:
      partial.starts_at ?? new Date(Date.now() - 86_400_000).toISOString(),
    ends_at: partial.ends_at ?? null,
    status: partial.status ?? 'active',
    method: partial.method ?? 'code',
    tiers: null,
    bogo_config: bogo,
    eligible_segment_ids: segs,
  }
}

async function main() {
  log(`\n=== Phase 5 PR5 BOGO + segments + analytics smoke — shop_id=${SHOP_ID} ===\n`)

  // ---------- Section 1: seed shop + 2 products ----------
  log('[1] Seeding shop + 2 products ($100 + $20)')

  await db
    .insertInto('shops')
    .values({
      id: SHOP_ID,
      slug: `smoke-pr5-${SUFFIX}`,
      name: 'PR5 Smoke Shop',
      email: `smoke-pr5-${SUFFIX}@test.local`,
      currency: 'USD',
      domain: `smoke-pr5-${SUFFIX}.test`,
      timezone: 'UTC',
    } as any)
    .execute()

  const productBig = randomUUID()
  const variantBig = randomUUID()
  await db
    .insertInto('products')
    .values({
      id: productBig,
      shop_id: SHOP_ID,
      title: 'Big Widget',
      slug: `big-widget-${SUFFIX}`,
      status: 'active',
    } as any)
    .execute()
  await db
    .insertInto('product_variants')
    .values({
      id: variantBig,
      product_id: productBig,
      title: 'Default',
      price: '100.00',
      sku: `SMK5-B-${variantBig.slice(0, 6)}`,
      inventory_quantity: 100,
      inventory_policy: 'deny',
      requires_shipping: true,
      taxable: false,
      weight: 0.1,
    } as any)
    .execute()

  const productSmall = randomUUID()
  const variantSmall = randomUUID()
  await db
    .insertInto('products')
    .values({
      id: productSmall,
      shop_id: SHOP_ID,
      title: 'Small Widget',
      slug: `small-widget-${SUFFIX}`,
      status: 'active',
    } as any)
    .execute()
  await db
    .insertInto('product_variants')
    .values({
      id: variantSmall,
      product_id: productSmall,
      title: 'Default',
      price: '20.00',
      sku: `SMK5-S-${variantSmall.slice(0, 6)}`,
      inventory_quantity: 100,
      inventory_policy: 'deny',
      requires_shipping: true,
      taxable: false,
      weight: 0.1,
    } as any)
    .execute()
  log('  seeded 2 products (big=$100, small=$20)')

  // ---------- Section 2: migration 061 — columns round-trip ----------
  log('\n[2] Migration 061 — bogo_config + eligible_segment_ids round-trip')

  const probeDiscount = discountValues({
    shop_id: SHOP_ID,
    code: `PROBE-${SUFFIX}`,
    type: 'bogo',
    value: '0',
    bogo_config: {
      buy_quantity: 2,
      get_quantity: 1,
      get_discount_percentage: 100,
    },
    eligible_segment_ids: ['seg_a', 'seg_b'],
  })
  await db.insertInto('discounts').values(probeDiscount).execute()

  const roundTripped = await db
    .selectFrom('discounts')
    .selectAll()
    .where('id', '=', probeDiscount.id)
    .executeTakeFirstOrThrow()

  log(`  raw bogo_config: ${typeof (roundTripped as any).bogo_config} — ${JSON.stringify((roundTripped as any).bogo_config)?.slice(0, 80)}`)
  log(`  raw eligible_segment_ids: ${typeof (roundTripped as any).eligible_segment_ids} — ${JSON.stringify((roundTripped as any).eligible_segment_ids)?.slice(0, 80)}`)

  const parsedBogo = normalizeBogoConfig((roundTripped as any).bogo_config)
  const parsedSegs = normalizeEligibleSegments(
    (roundTripped as any).eligible_segment_ids,
  )
  assert(
    parsedBogo?.buy_quantity === 2 &&
      parsedBogo?.get_quantity === 1 &&
      parsedBogo?.get_discount_percentage === 100,
    `bogo_config round-trips: ${JSON.stringify(parsedBogo)}`,
  )
  assert(
    Array.isArray(parsedSegs) && parsedSegs.length === 2,
    `eligible_segment_ids round-trips as length-2 array (got ${JSON.stringify(parsedSegs)})`,
  )
  assert(
    (roundTripped as any).type === 'bogo',
    `type='bogo' accepted by the updated CHECK constraint`,
  )

  // ---------- Section 3: BOGO rejects too-small cart ----------
  log('\n[3] BOGO validator: cart below cycleSize → bogo_cycle_not_met')

  // Separate open BOGO discount (no segment restriction) — using the
  // probe discount from section 2 would trip the segment check (step 6)
  // before ever reaching the BOGO cycle check (step 8). We want to
  // isolate the BOGO math here.
  const openBogo = discountValues({
    shop_id: SHOP_ID,
    code: `BOGO-${SUFFIX}`,
    type: 'bogo',
    value: '0',
    bogo_config: {
      buy_quantity: 2,
      get_quantity: 1,
      get_discount_percentage: 100, // free
    },
    eligible_segment_ids: null,
  })
  await db.insertInto('discounts').values(openBogo).execute()
  const openBogoRow = await db
    .selectFrom('discounts')
    .selectAll()
    .where('id', '=', openBogo.id)
    .executeTakeFirstOrThrow()

  const tooSmallCk = await createCheckout(
    db,
    SHOP_ID,
    [{ variant_id: variantBig, quantity: 2 }], // 2 units, need 3
    `pr5bogo-small-${SUFFIX}@smoke.test`,
  )
  const bogoSmall = await validateDiscountForCart(db, openBogoRow as any, {
    subtotal: tooSmallCk.subtotal_price,
    itemCount: 2,
    lineItems: tooSmallCk.line_items.map((li) => ({
      product_id: li.product_id,
      price: li.price,
      quantity: li.quantity,
    })),
  })
  assert(!bogoSmall.ok, 'BOGO validator rejected a 2-unit cart')
  if (!bogoSmall.ok) {
    assert(
      bogoSmall.kind === 'bogo_cycle_not_met',
      `kind='bogo_cycle_not_met' (got '${bogoSmall.kind}')`,
    )
    assert(
      /Add 1 more item/i.test(bogoSmall.message),
      `message = "Add 1 more item..." (got "${bogoSmall.message}")`,
    )
  }

  // ---------- Section 4: BOGO applyDiscount cheapest-first ----------
  log('\n[4] BOGO applyDiscount — cheapest-first allocation')

  // Cart: 2× big ($100) + 2× small ($20) = 4 units @ total $240.
  // Cycle size = 3. One cycle: cheapest unit ($20) discounted 100% → $20.
  // After one cycle: 1 unit remaining (short of next cycle).
  // Expected total_discounts = 20.00.
  const mixCk = await createCheckout(
    db,
    SHOP_ID,
    [
      { variant_id: variantBig, quantity: 2 },
      { variant_id: variantSmall, quantity: 2 },
    ],
    `pr5bogo-mix-${SUFFIX}@smoke.test`,
  )
  assert(
    mixCk.subtotal_price === '240.00',
    `mix cart subtotal = 240.00 (got ${mixCk.subtotal_price})`,
  )
  const applied = await applyDiscount(db, mixCk.id, `BOGO-${SUFFIX}`)
  assert(
    applied.discount?.type === 'bogo',
    `discount.type = 'bogo' (got '${applied.discount?.type}')`,
  )
  assert(
    applied.total_discounts === '20.00',
    `cheapest-first: 1 cycle × $20 cheapest unit = 20.00 (got ${applied.total_discounts})`,
  )
  assert(
    applied.total_price === '220.00',
    `total after BOGO = 220.00 (got ${applied.total_price})`,
  )
  // Stamped bogo_config survives the round-trip.
  assert(
    (applied.discount as any)?.bogo_config?.buy_quantity === 2,
    `bogo_config stamped on checkout (buy_quantity=${(applied.discount as any)?.bogo_config?.buy_quantity})`,
  )

  // ---------- Section 5: BOGO applyDiscount with 6 eligible units = 2 cycles ----------
  log('\n[5] BOGO — 6 cheap units yields 2 cycles')

  const bigCycleCk = await createCheckout(
    db,
    SHOP_ID,
    [{ variant_id: variantSmall, quantity: 6 }], // 6 × $20 = $120
    `pr5bogo-6cycles-${SUFFIX}@smoke.test`,
  )
  const bigCycleApplied = await applyDiscount(
    db,
    bigCycleCk.id,
    `BOGO-${SUFFIX}`,
  )
  // 6 units ÷ 3 per cycle = 2 cycles × $20 each = $40.
  assert(
    bigCycleApplied.total_discounts === '40.00',
    `2 cycles × $20 cheapest unit = 40.00 (got ${bigCycleApplied.total_discounts})`,
  )
  assert(
    bigCycleApplied.total_price === '80.00',
    `total after 2-cycle BOGO = 80.00 (got ${bigCycleApplied.total_price})`,
  )

  // ---------- Section 6: seed 2 customers + 1 VIP segment ----------
  log('\n[6] Seeding customers + VIP segment')

  const custVip = randomUUID()
  const custRegular = randomUUID()
  await db
    .insertInto('customers')
    .values([
      {
        id: custVip,
        shop_id: SHOP_ID,
        email: `vip-${SUFFIX}@smoke.test`,
        first_name: 'VIP',
        last_name: 'Buyer',
        tags: ['vip'] as any,
      },
      {
        id: custRegular,
        shop_id: SHOP_ID,
        email: `regular-${SUFFIX}@smoke.test`,
        first_name: 'Regular',
        last_name: 'Buyer',
        tags: ['plain'] as any,
      },
    ] as any)
    .execute()

  const segVip = randomUUID()
  const vipRules = {
    combinator: 'and' as const,
    rules: [{ field: 'tags', op: 'contains', value: 'vip' }],
  }
  await db
    .insertInto('customer_segments')
    .values({
      id: segVip,
      shop_id: SHOP_ID,
      name: 'VIP customers',
      rules_json: JSON.stringify(vipRules) as any,
    } as any)
    .execute()
  log(`  seeded VIP segment (id=${segVip.slice(0, 8)}…)`)

  // ---------- Section 7: segment-gated discount — guest rejected ----------
  log('\n[7] Segment-gated validator — guest is rejected')

  const segDiscount = discountValues({
    shop_id: SHOP_ID,
    code: `VIP-${SUFFIX}`,
    value: '20',
    value_type: 'percentage',
    eligible_segment_ids: [segVip],
  })
  await db.insertInto('discounts').values(segDiscount).execute()

  const segFresh = await db
    .selectFrom('discounts')
    .selectAll()
    .where('id', '=', segDiscount.id)
    .executeTakeFirstOrThrow()

  const guestResult = await validateDiscountForCart(db, segFresh as any, {
    subtotal: '100.00',
    itemCount: 1,
    customerId: null,
    email: 'guest@smoke.test',
  })
  assert(!guestResult.ok, 'guest is rejected from segment-gated discount')
  if (!guestResult.ok) {
    assert(
      guestResult.kind === 'customer_not_eligible',
      `kind='customer_not_eligible' (got '${guestResult.kind}')`,
    )
    assert(
      /sign in|account/i.test(guestResult.message),
      `message mentions sign-in / account (got "${guestResult.message}")`,
    )
  }

  // ---------- Section 8: non-VIP customer rejected ----------
  log('\n[8] Segment-gated validator — non-VIP is rejected')

  const regularResult = await validateDiscountForCart(db, segFresh as any, {
    subtotal: '100.00',
    itemCount: 1,
    customerId: custRegular,
  })
  assert(!regularResult.ok, 'regular customer rejected')
  if (!regularResult.ok) {
    assert(
      regularResult.kind === 'customer_not_eligible',
      `kind='customer_not_eligible' (got '${regularResult.kind}')`,
    )
  }

  // ---------- Section 9: VIP customer accepted ----------
  log('\n[9] Segment-gated validator — VIP is accepted')

  const vipResult = await validateDiscountForCart(db, segFresh as any, {
    subtotal: '100.00',
    itemCount: 1,
    customerId: custVip,
  })
  assert(vipResult.ok, `VIP customer accepted (ok=${vipResult.ok})`)

  // ---------- Section 10: VIP end-to-end applyDiscount ----------
  log('\n[10] VIP applyDiscount end-to-end')

  const vipCk = await createCheckout(
    db,
    SHOP_ID,
    [{ variant_id: variantBig, quantity: 1 }],
    { email: `vip-${SUFFIX}@smoke.test`, customerId: custVip },
  )
  const vipApplied = await applyDiscount(db, vipCk.id, `VIP-${SUFFIX}`)
  assert(
    vipApplied.discount?.code === `VIP-${SUFFIX}`,
    `discount stamped on VIP checkout (code=${vipApplied.discount?.code})`,
  )
  assert(
    vipApplied.total_discounts === '20.00',
    `20% of $100 = 20.00 (got ${vipApplied.total_discounts})`,
  )

  // ---------- Section 11: automatic — BOGO vs percentage comparison ----------
  log('\n[11] evaluateAutomaticDiscount — BOGO vs flat percentage')

  // Auto A: flat 10%. On 3× $100 cart = $30.
  await db
    .insertInto('discounts')
    .values(
      discountValues({
        shop_id: SHOP_ID,
        code: null,
        method: 'automatic',
        value: '10',
      }),
    )
    .execute()
  // Auto B: BOGO 2+1 100% off. On 3× $100 cart = $100 free unit. ← winner.
  await db
    .insertInto('discounts')
    .values(
      discountValues({
        shop_id: SHOP_ID,
        code: null,
        method: 'automatic',
        type: 'bogo',
        value: '0',
        bogo_config: {
          buy_quantity: 2,
          get_quantity: 1,
          get_discount_percentage: 100,
        },
      }),
    )
    .execute()

  const autoCk = await createCheckout(
    db,
    SHOP_ID,
    [{ variant_id: variantBig, quantity: 3 }],
    `pr5auto-${SUFFIX}@smoke.test`,
  )
  const autoApplied = await evaluateAutomaticDiscount(db, autoCk.id)
  assert(
    autoApplied.discount?.is_automatic === true,
    `auto-discount applied (is_automatic=${autoApplied.discount?.is_automatic})`,
  )
  assert(
    autoApplied.total_discounts === '100.00',
    `BOGO wins: 1 cycle × $100 cheapest = 100.00 (got ${autoApplied.total_discounts})`,
  )
  assert(
    autoApplied.discount?.type === 'bogo',
    `winner is BOGO (got type='${autoApplied.discount?.type}')`,
  )

  // ---------- Section 12: analytics — seed orders + aggregate ----------
  log('\n[12] Analytics — aggregate single discount redemptions')

  // Seed three completed orders against the VIP discount, one cancelled.
  const analyticsDiscountId = segDiscount.id
  const nowIso = new Date().toISOString()
  const earlier = new Date(Date.now() - 2 * 86_400_000).toISOString()
  const later = new Date(Date.now() - 86_400_000).toISOString()

  // Insert via raw minimal shape. total_discounts tracks the money saved.
  const orderIds = [randomUUID(), randomUUID(), randomUUID()]
  await db
    .insertInto('orders')
    .values([
      {
        id: orderIds[0],
        shop_id: SHOP_ID,
        customer_id: custVip,
        email: `vip-${SUFFIX}@smoke.test`,
        subtotal_price: '100.00',
        total_discounts: '20.00',
        total_price: '80.00',
        financial_status: 'paid',
        discount_code: `VIP-${SUFFIX}`,
        discount_id: analyticsDiscountId,
        created_at: earlier as any,
      },
      {
        id: orderIds[1],
        shop_id: SHOP_ID,
        customer_id: custVip,
        email: `vip-${SUFFIX}@smoke.test`,
        subtotal_price: '150.00',
        total_discounts: '30.00',
        total_price: '120.00',
        financial_status: 'paid',
        discount_code: `VIP-${SUFFIX}`,
        discount_id: analyticsDiscountId,
        created_at: later as any,
      },
      // This one is cancelled — must NOT count in the aggregate.
      {
        id: orderIds[2],
        shop_id: SHOP_ID,
        customer_id: custVip,
        email: `vip-${SUFFIX}@smoke.test`,
        subtotal_price: '999.00',
        total_discounts: '999.00', // deliberately big — it would skew sum
        total_price: '0.00',
        financial_status: 'paid',
        discount_code: `VIP-${SUFFIX}`,
        discount_id: analyticsDiscountId,
        cancelled_at: nowIso as any,
        created_at: nowIso as any,
      },
    ] as any)
    .execute()

  const analytics = await getDiscountAnalytics(
    db,
    SHOP_ID,
    analyticsDiscountId,
  )
  assert(
    analytics.redemption_count === 2,
    `redemption_count = 2 (cancelled excluded) — got ${analytics.redemption_count}`,
  )
  assert(
    parseFloat(analytics.total_discount_amount) === 50,
    `total_discount_amount = 50 (20 + 30, cancelled excluded) — got ${analytics.total_discount_amount}`,
  )
  assert(
    analytics.first_redeemed_at !== null && analytics.last_redeemed_at !== null,
    `first + last timestamps populated (first=${analytics.first_redeemed_at?.slice(0, 10)} last=${analytics.last_redeemed_at?.slice(0, 10)})`,
  )
  assert(
    new Date(analytics.first_redeemed_at!).getTime() <
      new Date(analytics.last_redeemed_at!).getTime(),
    'first_redeemed_at < last_redeemed_at',
  )

  // ---------- Section 13: analytics batch ----------
  log('\n[13] Analytics batch — mixed redeemed / non-redeemed ids')

  const neverRedeemedId = roundTripped.id // PROBE discount, no orders attached
  const batch = await getDiscountAnalyticsBatch(db, SHOP_ID, [
    analyticsDiscountId,
    neverRedeemedId,
  ])
  assert(
    batch.length === 2,
    `batch returns one entry per requested id (got ${batch.length})`,
  )
  const byId = new Map(batch.map((b) => [b.discount_id, b]))
  assert(
    byId.get(analyticsDiscountId)?.redemption_count === 2,
    `batch aggregate for VIP discount = 2 redemptions (got ${byId.get(analyticsDiscountId)?.redemption_count})`,
  )
  assert(
    byId.get(neverRedeemedId)?.redemption_count === 0,
    `batch zero for never-redeemed discount (got ${byId.get(neverRedeemedId)?.redemption_count})`,
  )
  assert(
    byId.get(neverRedeemedId)?.total_discount_amount === '0',
    `batch zero amount formatted as '0' (got '${byId.get(neverRedeemedId)?.total_discount_amount}')`,
  )

  // ---------- cleanup ----------
  log('\n[cleanup] disposing seeded rows')
  try {
    await db.deleteFrom('orders').where('shop_id', '=', SHOP_ID).execute()
    await db
      .deleteFrom('customer_segments')
      .where('shop_id', '=', SHOP_ID)
      .execute()
    await db.deleteFrom('customers').where('shop_id', '=', SHOP_ID).execute()
    await db.deleteFrom('discounts').where('shop_id', '=', SHOP_ID).execute()
    await db
      .deleteFrom('product_variants')
      .where('product_id', 'in', [productBig, productSmall])
      .execute()
    await db.deleteFrom('products').where('shop_id', '=', SHOP_ID).execute()
    await db.deleteFrom('shops').where('id', '=', SHOP_ID).execute()
    log('  cleanup done')
  } catch (err) {
    log(`  cleanup error (ignoring): ${(err as Error).message}`)
  }

  log('')
  log('='.repeat(60))
  if (failed > 0) {
    log(`PHASE 5 PR5 SMOKE: ${failed} FAIL(S)`)
    await db.destroy()
    process.exit(1)
  } else {
    log('PHASE 5 PR5 SMOKE: ALL CHECKS PASSED')
    await db.destroy()
    process.exit(0)
  }
}

main().catch(async (err) => {
  console.error('FATAL:', err)
  try {
    log('\n[cleanup] disposing seeded rows')
    await db
      .deleteFrom('orders')
      .where('shop_id', '=', SHOP_ID)
      .execute()
      .catch(() => {})
    await db
      .deleteFrom('customer_segments')
      .where('shop_id', '=', SHOP_ID)
      .execute()
      .catch(() => {})
    await db
      .deleteFrom('customers')
      .where('shop_id', '=', SHOP_ID)
      .execute()
      .catch(() => {})
    await db
      .deleteFrom('discounts')
      .where('shop_id', '=', SHOP_ID)
      .execute()
      .catch(() => {})
    await db
      .deleteFrom('products')
      .where('shop_id', '=', SHOP_ID)
      .execute()
      .catch(() => {})
    await db
      .deleteFrom('shops')
      .where('id', '=', SHOP_ID)
      .execute()
      .catch(() => {})
    log('  cleanup done')
  } finally {
    await db.destroy()
  }
  process.exit(1)
})
