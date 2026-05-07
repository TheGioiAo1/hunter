/**
 * Phase 5 PR4 — Tiered percentage discounts live smoke.
 *
 * Proves against real Postgres + Redis on server 1 that:
 *
 *   1. Migration 060 is live: `discounts.tiers` jsonb column exists and
 *      a 3-tier row round-trips through `applyDiscount` without shape
 *      corruption.
 *   2. `applyDiscount` (code path) walks a tier list correctly:
 *        - cart below the lowest threshold → no discount (0.00)
 *        - cart at tier 1 → tier-1 percentage
 *        - cart at tier 2 → tier-2 percentage
 *        - cart well above tier 3 → tier-3 percentage (top tier)
 *   3. Tiers stamp onto the CheckoutSession so subsequent recalcs (line
 *      edits, email changes) read the already-parsed tier list rather
 *      than re-parsing jsonb.
 *   4. `evaluateAutomaticDiscount` compares candidates using their tier
 *      values, not flat `value`, so a tiered 20% auto beats a flat 10%
 *      auto on a cart big enough to unlock the top tier.
 *   5. Tiered discount survives shrink → regrow without the wrong tier
 *      sticking (subtotal drops from tier 3 to tier 1, tier 1 applies;
 *      subtotal climbs back, tier 3 re-applies).
 *   6. `normalizeTiers` handles the real jsonb round-trip: pg returns
 *      either a parsed array or a text string depending on driver
 *      config. Pin the observed shape.
 *
 * Run on server 2:
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *   REDIS_URL=redis://:GboxRedis2026@192.168.1.13:6379/0 \
 *     npx tsx scripts/smoke-phase5-pr4.ts
 */

import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  applyDiscount,
  evaluateAutomaticDiscount,
  normalizeTiers,
  pickTier,
  type DiscountRow,
} from '../packages/core/src/modules/discounts/service.js'
import {
  createCheckout,
  updateCheckoutShipping,
} from '../packages/core/src/modules/checkout/service.js'
import { cacheGet, cacheSet } from '../packages/core/src/modules/cache/redis.js'
import type { CheckoutSession } from '../packages/core/src/modules/checkout/service.js'

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

/** Serialize a discount insert. jsonb fields need JSON.stringify; pg */
/** parses top-level arrays back on read but admin-side insertions still */
/** need the string form. */
function discountValues(
  partial: Partial<DiscountRow> & {
    shop_id: string
    method?: string
    tiers?: unknown
  },
): any {
  const ts = partial.target_selection
  const targetSelection =
    ts === undefined || ts === null ? null : JSON.stringify(ts)
  const tiers =
    partial.tiers === undefined || partial.tiers === null
      ? null
      : JSON.stringify(partial.tiers)
  return {
    id: partial.id ?? randomUUID(),
    shop_id: partial.shop_id,
    title: 'PR4 tiered smoke',
    code: partial.code === undefined ? `SMK4-${SUFFIX}` : partial.code,
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
    tiers,
  }
}

async function loadCheckout(id: string): Promise<CheckoutSession | null> {
  return (await cacheGet<CheckoutSession>(`checkout:${id}`)) ?? null
}

async function main() {
  log(`\n=== Phase 5 PR4 tiered-percentage smoke — shop_id=${SHOP_ID} ===\n`)

  // ---------- Section 1: seed shop + 1 product at $100 ----------
  log('[1] Seeding shop + 1 product at $100')

  await db
    .insertInto('shops')
    .values({
      id: SHOP_ID,
      slug: `smoke-pr4-${SUFFIX}`,
      name: 'PR4 Smoke Shop',
      email: `smoke-pr4-${SUFFIX}@test.local`,
      currency: 'USD',
      domain: `smoke-pr4-${SUFFIX}.test`,
      timezone: 'UTC',
    } as any)
    .execute()

  const productA = randomUUID()
  const variantA = randomUUID()
  await db
    .insertInto('products')
    .values({
      id: productA,
      shop_id: SHOP_ID,
      title: 'Tier Widget',
      slug: `tier-widget-${SUFFIX}`,
      status: 'active',
    } as any)
    .execute()
  await db
    .insertInto('product_variants')
    .values({
      id: variantA,
      product_id: productA,
      title: 'Default',
      price: '100.00',
      sku: `SMK4-${variantA.slice(0, 6)}`,
      inventory_quantity: 100,
      inventory_policy: 'deny',
      requires_shipping: true,
      taxable: false,
      weight: 0.1,
    } as any)
    .execute()
  log('  seeded 1 product (A=$100)')

  // ---------- Section 2: migration 060 — tiers round-trips ----------
  log('\n[2] Migration 060 — tiers jsonb round-trips through applyDiscount')

  const tierDiscount = discountValues({
    shop_id: SHOP_ID,
    code: `TIER-${SUFFIX}`,
    value_type: 'percentage',
    value: '0.00', // tiers override the flat value
    tiers: [
      { threshold: 100, percentage: 10 },
      { threshold: 200, percentage: 15 },
      { threshold: 300, percentage: 20 },
    ],
  })
  await db.insertInto('discounts').values(tierDiscount).execute()

  // Read back as validator / applyDiscount will see it
  const roundTripped = await db
    .selectFrom('discounts')
    .selectAll()
    .where('id', '=', tierDiscount.id)
    .executeTakeFirstOrThrow()

  log(
    `  raw tiers column: ${typeof roundTripped.tiers} — ${JSON.stringify(roundTripped.tiers)?.slice(0, 120)}`,
  )
  const parsed = normalizeTiers(roundTripped.tiers)
  assert(
    parsed.length === 3,
    `normalizeTiers returned 3 entries (got ${parsed.length})`,
  )
  assert(
    parsed[0].threshold === 100 && parsed[0].percentage === 10,
    `tier[0] = {100,10} (got ${JSON.stringify(parsed[0])})`,
  )
  assert(
    parsed[2].threshold === 300 && parsed[2].percentage === 20,
    `tier[2] = {300,20} (got ${JSON.stringify(parsed[2])})`,
  )

  // ---------- Section 3: applyDiscount — cart below lowest threshold ----------
  log('\n[3] Cart below lowest threshold → no discount')

  const ckLow = await createCheckout(
    db,
    SHOP_ID,
    [{ variant_id: variantA, quantity: 1 }], // $100 — at tier-1 threshold
    `pr4low-${SUFFIX}@smoke.test`,
  )
  // $100 cart should land exactly on tier-1 (threshold=100, 10%)
  const lowResult = await applyDiscount(db, ckLow.id, `TIER-${SUFFIX}`)
  assert(
    lowResult.discount?.code === `TIER-${SUFFIX}`,
    `discount applied (code=${lowResult.discount?.code})`,
  )
  assert(
    lowResult.total_discounts === '10.00',
    `cart=$100 → tier 1 (10% of 100) = 10.00 (got ${lowResult.total_discounts})`,
  )
  assert(
    lowResult.total_price === '90.00',
    `total after discount = 90.00 (got ${lowResult.total_price})`,
  )
  // The stamped tiers should be present on the checkout
  assert(
    Array.isArray(lowResult.discount?.tiers) &&
      (lowResult.discount!.tiers as any).length === 3,
    `tiers stamped on checkout.discount (len=${(lowResult.discount?.tiers as any)?.length ?? 'none'})`,
  )

  // ---------- Section 4: cart truly below lowest threshold ----------
  log('\n[4] Cart genuinely below lowest threshold → 0 discount')

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
      price: '50.00',
      sku: `SMK4S-${variantSmall.slice(0, 6)}`,
      inventory_quantity: 100,
      inventory_policy: 'deny',
      requires_shipping: true,
      taxable: false,
      weight: 0.1,
    } as any)
    .execute()

  const ckTiny = await createCheckout(
    db,
    SHOP_ID,
    [{ variant_id: variantSmall, quantity: 1 }], // $50 — below tier 1
    `pr4tiny-${SUFFIX}@smoke.test`,
  )
  const tinyResult = await applyDiscount(db, ckTiny.id, `TIER-${SUFFIX}`)
  assert(
    tinyResult.discount?.code === `TIER-${SUFFIX}`,
    `tiny cart: discount still stamped (no min requirement) code=${tinyResult.discount?.code}`,
  )
  assert(
    tinyResult.total_discounts === '0.00',
    `cart=$50 → no tier qualifies → 0.00 (got ${tinyResult.total_discounts})`,
  )
  assert(
    tinyResult.total_price === '50.00',
    `total = full cart $50 (got ${tinyResult.total_price})`,
  )

  // ---------- Section 5: cart at tier 2 threshold ----------
  log('\n[5] Cart at tier 2 — 15% of 250')

  const ckMid = await createCheckout(
    db,
    SHOP_ID,
    // $100 × 2 + $50 × 1 = $250 — lands on tier 2 (threshold=200, 15%)
    [
      { variant_id: variantA, quantity: 2 },
      { variant_id: variantSmall, quantity: 1 },
    ],
    `pr4mid-${SUFFIX}@smoke.test`,
  )
  assert(
    ckMid.subtotal_price === '250.00',
    `cart subtotal = 250.00 (got ${ckMid.subtotal_price})`,
  )
  const midResult = await applyDiscount(db, ckMid.id, `TIER-${SUFFIX}`)
  assert(
    midResult.total_discounts === '37.50',
    `cart=$250 → tier 2 (15% of 250) = 37.50 (got ${midResult.total_discounts})`,
  )
  assert(
    midResult.total_price === '212.50',
    `total after tier-2 = 212.50 (got ${midResult.total_price})`,
  )

  // ---------- Section 6: cart well above tier 3 threshold ----------
  log('\n[6] Cart above tier 3 — top tier wins')

  const ckTop = await createCheckout(
    db,
    SHOP_ID,
    [{ variant_id: variantA, quantity: 4 }], // $400 — above tier 3 (300)
    `pr4top-${SUFFIX}@smoke.test`,
  )
  assert(
    ckTop.subtotal_price === '400.00',
    `cart subtotal = 400.00 (got ${ckTop.subtotal_price})`,
  )
  const topResult = await applyDiscount(db, ckTop.id, `TIER-${SUFFIX}`)
  assert(
    topResult.total_discounts === '80.00',
    `cart=$400 → tier 3 (20% of 400) = 80.00 (got ${topResult.total_discounts})`,
  )
  assert(
    topResult.total_price === '320.00',
    `total after tier-3 = 320.00 (got ${topResult.total_price})`,
  )

  // ---------- Section 7: recalc after shrink → regrow picks right tier ----------
  log('\n[7] Shrink cart below top tier → tier re-picked from stamped list')

  // Start from ckTop ($400 → tier 3). Mutate line-item quantity in the
  // cached CheckoutSession, then fire a real user-triggered recalc via
  // `updateCheckoutEmail` — this is the exact code path that runs when
  // a buyer updates anything on the checkout page. Tiers must drive
  // the new percentage without any round-trip to the discounts table
  // (stamping is the whole point of PR4's recalc design).

  const big = (await loadCheckout(ckTop.id))!
  // Shrink from 4x to 1x → subtotal $100 → tier 1 (10%)
  big.line_items = big.line_items.map((li) => ({ ...li, quantity: 1 }))
  await cacheSet(`checkout:${big.id}`, big, 3600)
  // Trigger a real recalc via shipping-address update — this is the
  // code path that runs when a buyer enters their shipping address,
  // and it invokes checkout/service.ts::recalculateTotals which reads
  // stamped tiers.
  const shrunk = await updateCheckoutShipping(big.id, {
    first_name: 'Shrink',
    last_name: 'Test',
    address_line_1: '1 Shrink St',
    city: 'Hanoi',
    country: 'VN',
    country_code: 'VN',
    zip: '10000',
  } as any)
  assert(
    shrunk.subtotal_price === '100.00',
    `post-shrink subtotal = 100.00 (got ${shrunk.subtotal_price})`,
  )
  assert(
    shrunk.total_discounts === '10.00',
    `post-shrink: $100 → tier 1 (10% of 100) = 10.00 (got ${shrunk.total_discounts})`,
  )
  // Tiers should still be stamped on the discount — this is the whole point
  assert(
    Array.isArray(shrunk.discount?.tiers) &&
      (shrunk.discount!.tiers as any).length === 3,
    `tiers still stamped after shrink (len=${(shrunk.discount?.tiers as any)?.length ?? 'none'})`,
  )

  // Regrow to 3x → subtotal $300 → tier 3 (20%)
  shrunk.line_items = shrunk.line_items.map((li) => ({ ...li, quantity: 3 }))
  await cacheSet(`checkout:${shrunk.id}`, shrunk, 3600)
  const regrown = await updateCheckoutShipping(shrunk.id, {
    first_name: 'Regrow',
    last_name: 'Test',
    address_line_1: '2 Regrow Ave',
    city: 'Hanoi',
    country: 'VN',
    country_code: 'VN',
    zip: '10000',
  } as any)
  assert(
    regrown.subtotal_price === '300.00',
    `post-regrow subtotal = 300.00 (got ${regrown.subtotal_price})`,
  )
  assert(
    regrown.total_discounts === '60.00',
    `post-regrow: $300 → tier 3 (20% of 300) = 60.00 (got ${regrown.total_discounts})`,
  )
  assert(
    regrown.total_price === '240.00',
    `total after regrow = 240.00 (got ${regrown.total_price})`,
  )

  // ---------- Section 8: automatic — tiered beats flat on right cart ----------
  log('\n[8] evaluateAutomaticDiscount picks tiered over flat on big cart')

  // Flat automatic: 10% — always 10%, no threshold
  await db
    .insertInto('discounts')
    .values(
      discountValues({
        shop_id: SHOP_ID,
        code: null,
        method: 'automatic',
        value_type: 'percentage',
        value: '10.00',
        tiers: null, // explicit flat
      }),
    )
    .execute()
  // Tiered automatic: 20% at threshold=300
  await db
    .insertInto('discounts')
    .values(
      discountValues({
        shop_id: SHOP_ID,
        code: null,
        method: 'automatic',
        value_type: 'percentage',
        value: '0.00',
        tiers: [
          { threshold: 100, percentage: 5 },
          { threshold: 300, percentage: 20 },
        ],
      }),
    )
    .execute()

  // Big cart: $400 → flat 10% = $40 vs tiered 20% = $80. Tiered wins.
  const ckAutoBig = await createCheckout(
    db,
    SHOP_ID,
    [{ variant_id: variantA, quantity: 4 }],
    `pr4autobig-${SUFFIX}@smoke.test`,
  )
  const autoBig = await evaluateAutomaticDiscount(db, ckAutoBig.id)
  assert(
    autoBig.discount?.is_automatic === true,
    'automatic applied on big cart',
  )
  assert(
    autoBig.total_discounts === '80.00',
    `tiered automatic (20% of 400) = 80.00 beats flat (40.00) — got ${autoBig.total_discounts}`,
  )

  // Small cart: $50 → flat 10% = $5 vs tiered (no qualifying tier on $50) = $0. Flat wins.
  const ckAutoSmall = await createCheckout(
    db,
    SHOP_ID,
    [{ variant_id: variantSmall, quantity: 1 }],
    `pr4autosmall-${SUFFIX}@smoke.test`,
  )
  const autoSmall = await evaluateAutomaticDiscount(db, ckAutoSmall.id)
  assert(
    autoSmall.discount?.is_automatic === true,
    'automatic applied on small cart',
  )
  assert(
    autoSmall.total_discounts === '5.00',
    `flat automatic (10% of 50) = 5.00 beats tiered-with-no-match (0) — got ${autoSmall.total_discounts}`,
  )

  // ---------- Section 9: pickTier unit pinning (sanity) ----------
  log('\n[9] pickTier sanity check against stamped tiers')

  const stampedTiers = parsed // from section 2
  assert(pickTier(stampedTiers, 50) === null, 'subtotal=50 → no tier (null)')
  assert(pickTier(stampedTiers, 100)?.threshold === 100, 'subtotal=100 → tier at 100')
  assert(pickTier(stampedTiers, 199)?.threshold === 100, 'subtotal=199 → still tier at 100')
  assert(pickTier(stampedTiers, 200)?.threshold === 200, 'subtotal=200 → tier at 200')
  assert(pickTier(stampedTiers, 299)?.threshold === 200, 'subtotal=299 → still tier at 200')
  assert(pickTier(stampedTiers, 300)?.threshold === 300, 'subtotal=300 → tier at 300')
  assert(pickTier(stampedTiers, 9999)?.threshold === 300, 'subtotal=9999 → caps at tier 300')

  // ---------- cleanup ----------
  log('\n[cleanup] disposing seeded rows')
  try {
    await db.deleteFrom('discounts').where('shop_id', '=', SHOP_ID).execute()
    await db
      .deleteFrom('product_variants')
      .where('product_id', 'in', [productA, productSmall])
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
    log(`PHASE 5 PR4 SMOKE: ${failed} FAIL(S)`)
    await db.destroy()
    process.exit(1)
  } else {
    log('PHASE 5 PR4 SMOKE: ALL CHECKS PASSED')
    await db.destroy()
    process.exit(0)
  }
}

main().catch(async (err) => {
  console.error('FATAL:', err)
  try {
    log('\n[cleanup] disposing seeded rows')
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
