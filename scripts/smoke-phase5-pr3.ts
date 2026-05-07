/**
 * Phase 5 PR3 — Automatic (codeless) discounts + scheduled window live smoke.
 *
 * Proves against real Postgres + Redis on server 1 that:
 *
 *   1. Migration 059 is live: `discounts.method` column + partial unique
 *      index on (shop_id, code) WHERE method='code'. Inserting two
 *      method='automatic' rows with `code=NULL` does NOT trip the
 *      uniqueness index. Inserting two method='code' rows with the same
 *      code DOES.
 *   2. `findActiveAutomaticDiscounts` returns only method='automatic'
 *      rows within their starts_at/ends_at window, skipping
 *      force-expired (`status='expired'`) rows.
 *   3. `evaluateAutomaticDiscount` auto-applies the best-matching
 *      automatic to a checkout, stamps `is_automatic=true`, and
 *      leaves a code-based discount untouched.
 *   4. When the cart no longer qualifies (min purchase not met after a
 *      line removal), `evaluateAutomaticDiscount` clears the stale
 *      automatic and zeroes `total_discounts`.
 *   5. Scheduled-window behaviour: a discount with starts_at in the
 *      future is still rejected (`not_started`). A discount whose
 *      stored status is 'scheduled' but whose starts_at has passed is
 *      now accepted (phase 5 PR3 drops the stored-status short-circuit).
 *   6. `applyDiscount(code path)` refuses method='automatic' rows with
 *      the "applied automatically" message, regardless of whether a
 *      code is also set on the row.
 *
 * Run on server 2:
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *   REDIS_URL=redis://:GboxRedis2026@192.168.1.13:6379/0 \
 *     npx tsx scripts/smoke-phase5-pr3.ts
 */

import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  validateDiscountForCart,
  findActiveAutomaticDiscounts,
  evaluateAutomaticDiscount,
  applyDiscount,
  type DiscountRow,
} from '../packages/core/src/modules/discounts/service.js'
import {
  createCheckout,
  updateCheckoutEmail,
} from '../packages/core/src/modules/checkout/service.js'
import { cacheGet } from '../packages/core/src/modules/cache/redis.js'
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

function discountValues(
  partial: Partial<DiscountRow> & { shop_id: string; method?: string },
): any {
  const ts = partial.target_selection
  const targetSelection =
    ts === undefined || ts === null ? null : JSON.stringify(ts)
  return {
    id: partial.id ?? randomUUID(),
    shop_id: partial.shop_id,
    title: 'PR3 automatic smoke',
    code: partial.code === undefined ? `SMK3-${SUFFIX}` : partial.code,
    type: partial.type ?? 'percentage',
    value: partial.value ?? '10.00',
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
  }
}

async function loadCheckout(id: string): Promise<CheckoutSession | null> {
  return (await cacheGet<CheckoutSession>(`checkout:${id}`)) ?? null
}

async function main() {
  log(`\n=== Phase 5 PR3 automatic smoke — shop_id=${SHOP_ID} ===\n`)

  // ---------- Section 1: seed shop + 2 products ----------
  log('[1] Seeding shop, 2 products (A=$100, B=$50)')

  await db
    .insertInto('shops')
    .values({
      id: SHOP_ID,
      slug: `smoke-pr3-${SUFFIX}`,
      name: 'PR3 Smoke Shop',
      email: `smoke-pr3-${SUFFIX}@test.local`,
      currency: 'USD',
      domain: `smoke-pr3-${SUFFIX}.test`,
      timezone: 'UTC',
    } as any)
    .execute()

  const productA = randomUUID()
  const productB = randomUUID()
  const variantA = randomUUID()
  const variantB = randomUUID()

  for (const [pid, title] of [
    [productA, 'Widget A'],
    [productB, 'Widget B'],
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
  ] as const) {
    await db
      .insertInto('product_variants')
      .values({
        id: vid,
        product_id: pid,
        title: 'Default',
        price,
        sku: `SMK3-${vid.slice(0, 6)}`,
        inventory_quantity: 100,
        inventory_policy: 'deny',
        requires_shipping: true,
        taxable: false,
        weight: 0.1,
      } as any)
      .execute()
  }
  log(`  seeded 2 products (A=$100, B=$50)`)

  // ---------- Section 2: migration 059 column + unique index ----------
  log('\n[2] Migration 059 — two auto discounts with NULL code allowed')

  const autoA = discountValues({
    shop_id: SHOP_ID,
    code: null,
    method: 'automatic',
    value: '10.00',
  })
  const autoB = discountValues({
    shop_id: SHOP_ID,
    code: null,
    method: 'automatic',
    value: '15.00',
  })
  await db.insertInto('discounts').values([autoA, autoB]).execute()
  assert(true, 'two automatic rows with code=NULL inserted (partial unique allows)')

  // Try to violate the partial unique: two code-based rows sharing a
  // code. Must fail.
  const sharedCode = `DUP-${SUFFIX}`
  const codeA = discountValues({ shop_id: SHOP_ID, code: sharedCode })
  await db.insertInto('discounts').values(codeA).execute()
  let dupError: Error | null = null
  try {
    await db
      .insertInto('discounts')
      .values(discountValues({ shop_id: SHOP_ID, code: sharedCode }))
      .execute()
  } catch (err) {
    dupError = err as Error
  }
  assert(
    dupError !== null && /duplicate|unique/i.test(dupError?.message ?? ''),
    'duplicate code rejected by partial unique index',
  )

  // ---------- Section 3: findActiveAutomaticDiscounts ----------
  log('\n[3] findActiveAutomaticDiscounts filtering')

  // One force-expired automatic — must NOT appear.
  await db
    .insertInto('discounts')
    .values(
      discountValues({
        shop_id: SHOP_ID,
        code: null,
        method: 'automatic',
        status: 'expired',
        value: '50.00',
      }),
    )
    .execute()
  // One future-dated automatic — must NOT appear.
  await db
    .insertInto('discounts')
    .values(
      discountValues({
        shop_id: SHOP_ID,
        code: null,
        method: 'automatic',
        starts_at: new Date(Date.now() + 86_400_000).toISOString(),
        value: '20.00',
      }),
    )
    .execute()

  const activeAutos = await findActiveAutomaticDiscounts(db, SHOP_ID)
  assert(
    activeAutos.length === 2 &&
      activeAutos.every((d) => d.method === 'automatic'),
    `finder returns 2 active automatics (got ${activeAutos.length})`,
  )
  assert(
    !activeAutos.some((d) => d.status === 'expired'),
    'finder excludes force-expired automatics',
  )
  assert(
    !activeAutos.some((d) => new Date(d.starts_at) > new Date()),
    'finder excludes future-dated automatics',
  )

  // ---------- Section 4: evaluateAutomaticDiscount applies best match ----------
  log('\n[4] evaluateAutomaticDiscount picks best automatic')

  const email = `pr3-${SUFFIX}@smoke.test`
  const checkout = await createCheckout(
    db,
    SHOP_ID,
    [{ variant_id: variantA, quantity: 2 }, { variant_id: variantB, quantity: 1 }],
    email,
  )
  // Cart: 2×$100 + 1×$50 = $250 subtotal
  assert(checkout.subtotal_price === '250.00', `cart subtotal = 250.00 (got ${checkout.subtotal_price})`)

  const evaluated = await evaluateAutomaticDiscount(db, checkout.id)
  // autoA = 10% of 250 = 25; autoB = 15% of 250 = 37.50 ← winner
  assert(
    evaluated.discount !== null && evaluated.discount.is_automatic === true,
    'automatic discount applied (is_automatic=true)',
  )
  assert(
    evaluated.discount?.code === null,
    'applied automatic has code=null (no buyer-entered code)',
  )
  assert(
    evaluated.total_discounts === '37.50',
    `best automatic (15% of 250) applied: 37.50 (got ${evaluated.total_discounts})`,
  )
  assert(
    evaluated.total_price === '212.50',
    `total after auto = 212.50 (got ${evaluated.total_price})`,
  )

  // ---------- Section 5: code-based discount survives evaluation ----------
  log('\n[5] evaluateAutomaticDiscount leaves code-based discounts alone')

  const codeDiscount = discountValues({
    shop_id: SHOP_ID,
    code: `CODE-${SUFFIX}`,
    method: 'code',
    value: '5.00',
  })
  await db.insertInto('discounts').values(codeDiscount).execute()

  // Apply code manually
  const afterCode = await applyDiscount(db, checkout.id, `CODE-${SUFFIX}`)
  assert(
    afterCode.discount?.code === `CODE-${SUFFIX}` &&
      afterCode.discount?.is_automatic === false,
    'code applied with is_automatic=false',
  )
  // 5% of 250 = 12.50
  assert(
    afterCode.total_discounts === '12.50',
    `code discount 5% of 250 = 12.50 (got ${afterCode.total_discounts})`,
  )

  // Now re-run automatic evaluator — code MUST win
  const afterEval = await evaluateAutomaticDiscount(db, checkout.id)
  assert(
    afterEval.discount?.code === `CODE-${SUFFIX}`,
    'automatic evaluator preserved code-based discount',
  )
  assert(
    afterEval.discount?.is_automatic === false,
    'code-based is_automatic still false after eval',
  )

  // ---------- Section 6: stale automatic clears when cart no longer qualifies ----------
  log('\n[6] evaluateAutomaticDiscount clears stale auto when cart drops below minimum')

  // Seed a NEW shop + cart for this section to isolate
  const shop2 = randomUUID()
  await db
    .insertInto('shops')
    .values({
      id: shop2,
      slug: `smoke-pr3b-${SUFFIX}`,
      name: 'PR3 Smoke B',
      email: `smoke-pr3b-${SUFFIX}@test.local`,
      currency: 'USD',
      domain: `smoke-pr3b-${SUFFIX}.test`,
      timezone: 'UTC',
    } as any)
    .execute()
  const prodS = randomUUID()
  const varS = randomUUID()
  await db
    .insertInto('products')
    .values({
      id: prodS,
      shop_id: shop2,
      title: 'MinTest Widget',
      slug: `min-widget-${SUFFIX}`,
      status: 'active',
    } as any)
    .execute()
  await db
    .insertInto('product_variants')
    .values({
      id: varS,
      product_id: prodS,
      title: 'Default',
      price: '200.00',
      sku: `MIN-${SUFFIX}`,
      inventory_quantity: 100,
      inventory_policy: 'deny',
      requires_shipping: true,
      taxable: false,
      weight: 0.1,
    } as any)
    .execute()
  await db
    .insertInto('discounts')
    .values(
      discountValues({
        shop_id: shop2,
        code: null,
        method: 'automatic',
        value: '20.00',
        minimum_requirement_type: 'purchase_amount',
        minimum_requirement_value: '300.00',
      }),
    )
    .execute()

  // Cart over minimum — 2 x $200 = $400, auto applies
  const bigCart = await createCheckout(
    db,
    shop2,
    [{ variant_id: varS, quantity: 2 }],
    email,
  )
  const withAuto = await evaluateAutomaticDiscount(db, bigCart.id)
  assert(
    withAuto.discount?.is_automatic === true,
    'auto applied when cart is $400 (over $300 min)',
  )
  assert(
    withAuto.total_discounts === '80.00',
    `20% of $400 = $80 (got ${withAuto.total_discounts})`,
  )

  // Shrink cart below minimum by mutating Redis session directly
  const big = (await loadCheckout(bigCart.id))!
  big.line_items = big.line_items.map((li) => ({ ...li, quantity: 1 }))
  big.subtotal_price = '200.00'
  // Update cache (simulates what checkout mutations would do)
  const { cacheSet } = await import('../packages/core/src/modules/cache/redis.js')
  await cacheSet(`checkout:${big.id}`, big, 3600)

  const afterShrink = await evaluateAutomaticDiscount(db, bigCart.id)
  assert(
    afterShrink.discount === null,
    'stale automatic cleared when cart drops below minimum',
  )
  assert(
    afterShrink.total_discounts === '0.00',
    `total_discounts reset to 0.00 (got ${afterShrink.total_discounts})`,
  )

  // ---------- Section 7: applyDiscount refuses method='automatic' ----------
  log('\n[7] applyDiscount rejects method=automatic via code entry')

  // Insert an automatic discount that also has a code stamped
  await db
    .insertInto('discounts')
    .values(
      discountValues({
        shop_id: SHOP_ID,
        code: `AUTOCODE-${SUFFIX}`,
        method: 'automatic',
        value: '25.00',
      }),
    )
    .execute()

  const ck2 = await createCheckout(
    db,
    SHOP_ID,
    [{ variant_id: variantA, quantity: 1 }],
    `pr3autoreject-${SUFFIX}@smoke.test`,
  )
  let autoRejectErr: Error | null = null
  try {
    await applyDiscount(db, ck2.id, `AUTOCODE-${SUFFIX}`)
  } catch (err) {
    autoRejectErr = err as Error
  }
  assert(
    autoRejectErr !== null &&
      /applied automatically/i.test(autoRejectErr?.message ?? ''),
    `applyDiscount refused automatic: "${autoRejectErr?.message ?? 'none'}"`,
  )

  // ---------- Section 8: scheduled-status-without-cron edge case ----------
  log('\n[8] scheduled discount whose starts_at has passed is still active')

  const staleSchedulCode = `STALESCHED-${SUFFIX}`
  await db
    .insertInto('discounts')
    .values(
      discountValues({
        shop_id: SHOP_ID,
        code: staleSchedulCode,
        method: 'code',
        status: 'scheduled', // stale — cron never flipped it
        starts_at: new Date(Date.now() - 3600_000).toISOString(),
        value: '10.00',
      }),
    )
    .execute()

  const ck3 = await createCheckout(
    db,
    SHOP_ID,
    [{ variant_id: variantA, quantity: 1 }],
    `pr3sched-${SUFFIX}@smoke.test`,
  )
  // Should apply — starts_at is in the past even though stored status is 'scheduled'
  const afterStaleSched = await applyDiscount(db, ck3.id, staleSchedulCode)
  assert(
    afterStaleSched.discount?.code === staleSchedulCode,
    'stale-scheduled discount applied when starts_at in the past',
  )
  assert(
    afterStaleSched.total_discounts === '10.00',
    `10% of 100 = 10.00 applied (got ${afterStaleSched.total_discounts})`,
  )

  // And a still-future scheduled discount must stay blocked
  const futureCode = `FUTURE-${SUFFIX}`
  await db
    .insertInto('discounts')
    .values(
      discountValues({
        shop_id: SHOP_ID,
        code: futureCode,
        method: 'code',
        status: 'scheduled',
        starts_at: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    )
    .execute()

  const ck4 = await createCheckout(
    db,
    SHOP_ID,
    [{ variant_id: variantA, quantity: 1 }],
    `pr3future-${SUFFIX}@smoke.test`,
  )
  let futureErr: Error | null = null
  try {
    await applyDiscount(db, ck4.id, futureCode)
  } catch (err) {
    futureErr = err as Error
  }
  assert(
    futureErr !== null && /has not started/i.test(futureErr?.message ?? ''),
    `future scheduled rejected: "${futureErr?.message}"`,
  )

  // ---------- cleanup ----------
  log('\n[cleanup] disposing seeded rows')
  try {
    await db.deleteFrom('discounts').where('shop_id', '=', SHOP_ID).execute()
    await db.deleteFrom('discounts').where('shop_id', '=', shop2).execute()
    await db.deleteFrom('product_variants').where('product_id', 'in', [productA, productB, prodS]).execute()
    await db.deleteFrom('products').where('shop_id', '=', SHOP_ID).execute()
    await db.deleteFrom('products').where('shop_id', '=', shop2).execute()
    await db.deleteFrom('shops').where('id', '=', SHOP_ID).execute()
    await db.deleteFrom('shops').where('id', '=', shop2).execute()
    log('  cleanup done')
  } catch (err) {
    log(`  cleanup error (ignoring): ${(err as Error).message}`)
  }

  log('')
  log('='.repeat(60))
  if (failed > 0) {
    log(`PHASE 5 PR3 SMOKE: ${failed} FAIL(S)`)
    await db.destroy()
    process.exit(1)
  } else {
    log('PHASE 5 PR3 SMOKE: ALL CHECKS PASSED')
    await db.destroy()
    process.exit(0)
  }
}

main().catch(async (err) => {
  console.error('FATAL:', err)
  try {
    log('\n[cleanup] disposing seeded rows')
    await db.deleteFrom('discounts').where('shop_id', '=', SHOP_ID).execute().catch(() => {})
    await db.deleteFrom('product_variants').where('product_id', 'in', []).execute().catch(() => {})
    await db.deleteFrom('products').where('shop_id', '=', SHOP_ID).execute().catch(() => {})
    await db.deleteFrom('shops').where('id', '=', SHOP_ID).execute().catch(() => {})
    log('  cleanup done')
  } finally {
    await db.destroy()
  }
  process.exit(1)
})
