/**
 * Phase 6 PR2 — Inventory analytics live smoke.
 *
 * Proves against real Postgres (server 1 via server 2) that the four
 * inventory reports shipped in PR2 compute correctly against live
 * tables. Seeds a disposable shop + 3 products (4 variants) + a
 * deliberate mix of recent + stale orders, runs each query, asserts
 * the expected variants appear in the expected ranks.
 *
 * Coverage:
 *   1. Schema sanity — product_variants.inventory_quantity exists + is numeric
 *   2. getTopSellers — ranks by SUM(quantity) desc within the period
 *   3. getTopSellers — excludes orders outside the period
 *   4. getLowStock — returns variants with qty ≤ threshold, ordered asc
 *   5. getLowStock — excludes variants above threshold
 *   6. getDeadStock — returns variants with qty > 0 + last sale < cutoff
 *   7. getDeadStock — variants that never sold (no ls row) included
 *   8. getSellThroughLeaders — minSold filter excludes low-volume variants
 *   9. getSellThroughLeaders — sell_through ratio computed correctly
 *  10. periodToRange — 7d/30d/90d day math against a known now
 *
 * Run on server 2 (LAN host whitelisted in pg_hba.conf on 192.168.1.13):
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase6-pr2.ts
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { createDb } from '../packages/db/src/index.js'
import {
  getTopSellers,
  getDeadStock,
  getLowStock,
  getSellThroughLeaders,
  periodToRange,
  computeSellThrough,
} from '../packages/core/src/modules/analytics/inventory-analytics.js'

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_ID = randomUUID()
const CUSTOMER_ID = randomUUID()
const CUSTOMER_EMAIL = `smoke-p6-pr2+${SUFFIX}@example.test`

// Four variants we'll seed across 3 products.
//   hot      → 30 units sold in-range, low inventory (8)  → top seller
//   warm     → 10 units sold in-range, high inventory (100) → low sell-through
//   cold     →  0 units sold in-range, ever (→ dead)        → stuck 90d
//   trickle  →  1 unit sold in-range, inventory 2           → low-stock below threshold
const PROD_HOT = randomUUID()
const PROD_WARM = randomUUID()
const PROD_COLD = randomUUID()
const PROD_TRICKLE = randomUUID()
const VAR_HOT = randomUUID()
const VAR_WARM = randomUUID()
const VAR_COLD = randomUUID()
const VAR_TRICKLE = randomUUID()

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

function isoNDaysAgo(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString()
}

async function main() {
  log(`\n=== Phase 6 PR2 smoke — shop_id=${SHOP_ID} ===\n`)

  // ---------- Section 0: schema sanity ----------
  log('[0] schema sanity — variant + line item columns exist')
  const varCols = await sql<{ column_name: string; data_type: string }>`
    SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'product_variants'
      ORDER BY ordinal_position
  `.execute(db)
  const varColNames = varCols.rows.map((r) => r.column_name)
  for (const c of ['id', 'product_id', 'title', 'inventory_quantity', 'sku']) {
    assert(varColNames.includes(c), `product_variants has column "${c}"`)
  }

  const oliCols = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns
      WHERE table_name = 'order_line_items'
  `.execute(db)
  const oliColNames = oliCols.rows.map((r) => r.column_name)
  for (const c of ['order_id', 'variant_id', 'quantity', 'price']) {
    assert(oliColNames.includes(c), `order_line_items has column "${c}"`)
  }

  // ---------- Section 1: seed shop + customer + products + variants ----------
  log('\n[1] Seeding shop + products + variants + orders + line items')

  await db
    .insertInto('shops')
    .values({
      id: SHOP_ID,
      slug: `smoke-p6-pr2-${SUFFIX}`,
      name: 'Phase 6 PR2 smoke shop',
      email: `shop-${SUFFIX}@example.test`,
      status: 'active',
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

  // Products
  await db
    .insertInto('products')
    .values([
      {
        id: PROD_HOT,
        shop_id: SHOP_ID,
        title: 'Hot Seller',
        slug: `hot-${SUFFIX}`,
        status: 'active',
      },
      {
        id: PROD_WARM,
        shop_id: SHOP_ID,
        title: 'Warm Seller',
        slug: `warm-${SUFFIX}`,
        status: 'active',
      },
      {
        id: PROD_COLD,
        shop_id: SHOP_ID,
        title: 'Cold Stock',
        slug: `cold-${SUFFIX}`,
        status: 'active',
      },
      {
        id: PROD_TRICKLE,
        shop_id: SHOP_ID,
        title: 'Trickle Seller',
        slug: `trickle-${SUFFIX}`,
        status: 'active',
      },
    ] as any)
    .execute()

  // Variants — each in its own product so grouping is unambiguous
  await db
    .insertInto('product_variants')
    .values([
      {
        id: VAR_HOT,
        product_id: PROD_HOT,
        title: 'Default',
        price: '20.00',
        sku: `HOT-${SUFFIX}`,
        inventory_quantity: 8, // low-ish but above default threshold 5
      },
      {
        id: VAR_WARM,
        product_id: PROD_WARM,
        title: 'Default',
        price: '15.00',
        sku: `WARM-${SUFFIX}`,
        inventory_quantity: 100, // high — drives sell-through DOWN
      },
      {
        id: VAR_COLD,
        product_id: PROD_COLD,
        title: 'Default',
        price: '50.00',
        sku: `COLD-${SUFFIX}`,
        inventory_quantity: 25, // never sold → dead stock
      },
      {
        id: VAR_TRICKLE,
        product_id: PROD_TRICKLE,
        title: 'Default',
        price: '10.00',
        sku: `TRICKLE-${SUFFIX}`,
        inventory_quantity: 2, // ≤ threshold 5 → low-stock list
      },
    ] as any)
    .execute()

  // Orders — inside the last-30d range (use 5 + 15 days ago), plus one
  // "old" order for VAR_WARM to keep it out of dead-stock (it's sold
  // in range anyway), and a 150-days-ago order for nothing (just drift
  // coverage).
  const nowIso = new Date().toISOString()
  const recent1 = isoNDaysAgo(5)
  const recent2 = isoNDaysAgo(15)
  const oldSale = isoNDaysAgo(150) // older than 90d cutoff

  async function mkOrder(
    when: string,
    variantId: string,
    productId: string,
    qty: number,
    price: string,
  ): Promise<string> {
    const orderId = randomUUID()
    await db
      .insertInto('orders')
      .values({
        id: orderId,
        shop_id: SHOP_ID,
        customer_id: CUSTOMER_ID,
        order_number: Math.floor(Math.random() * 1_000_000),
        email: CUSTOMER_EMAIL,
        financial_status: 'paid',
        fulfillment_status: 'unfulfilled',
        currency: 'USD',
        subtotal_price: (Number(price) * qty).toFixed(2),
        total_tax: '0.00',
        total_discounts: '0.00',
        total_price: (Number(price) * qty).toFixed(2),
        total_shipping: '0.00',
        created_at: when,
        updated_at: when,
      } as any)
      .execute()

    await db
      .insertInto('order_line_items')
      .values({
        order_id: orderId,
        product_id: productId,
        variant_id: variantId,
        title: 'line',
        sku: null,
        quantity: qty,
        price: price,
        total_discount: '0.00',
      } as any)
      .execute()

    return orderId
  }

  // HOT: 2 orders in range totalling 30 units
  await mkOrder(recent1, VAR_HOT, PROD_HOT, 18, '20.00')
  await mkOrder(recent2, VAR_HOT, PROD_HOT, 12, '20.00')
  // WARM: 1 order in range, 10 units
  await mkOrder(recent1, VAR_WARM, PROD_WARM, 10, '15.00')
  // TRICKLE: 1 order in range, 1 unit (below minSold default 5)
  await mkOrder(recent2, VAR_TRICKLE, PROD_TRICKLE, 1, '10.00')
  // Historical drift order — outside 30d, not attributable to any of our variants
  // (we seed it without a variant_id to prove "out of range" filtering).
  const oldOrderId = randomUUID()
  await db
    .insertInto('orders')
    .values({
      id: oldOrderId,
      shop_id: SHOP_ID,
      customer_id: CUSTOMER_ID,
      order_number: Math.floor(Math.random() * 1_000_000),
      email: CUSTOMER_EMAIL,
      financial_status: 'paid',
      fulfillment_status: 'unfulfilled',
      currency: 'USD',
      subtotal_price: '0.00',
      total_tax: '0.00',
      total_discounts: '0.00',
      total_price: '0.00',
      total_shipping: '0.00',
      created_at: oldSale,
      updated_at: oldSale,
    } as any)
    .execute()

  // ---------- Section 2: getTopSellers math ----------
  log('\n[2] getTopSellers ranks by units_sold desc within range')
  const range30d = periodToRange('30d')
  const top = await getTopSellers(db as any, SHOP_ID, range30d, 10)
  const topIds = top.map((r) => r.variant_id)
  assert(topIds[0] === VAR_HOT, `rank #1 = VAR_HOT (got ${topIds[0]})`)
  assert(topIds[1] === VAR_WARM, `rank #2 = VAR_WARM (got ${topIds[1]})`)
  assert(
    topIds.includes(VAR_TRICKLE),
    'VAR_TRICKLE present (1 unit — below no filter in top sellers)',
  )
  assert(
    !topIds.includes(VAR_COLD),
    'VAR_COLD absent (no line items → no sales → no row)',
  )
  const hotRow = top.find((r) => r.variant_id === VAR_HOT)!
  assert(hotRow.units_sold === 30, `VAR_HOT units_sold=30 (got ${hotRow.units_sold})`)
  assert(
    Number(hotRow.revenue) === 600,
    `VAR_HOT revenue=$600 (18*20 + 12*20) (got ${hotRow.revenue})`,
  )
  assert(hotRow.orders_count === 2, `VAR_HOT orders_count=2 (got ${hotRow.orders_count})`)

  // ---------- Section 3: getTopSellers excludes out-of-range ----------
  log('\n[3] getTopSellers excludes orders before range.since')
  const tightRange = {
    since: isoNDaysAgo(6), // only catches recent1 (5d ago), misses recent2 (15d ago)
    until: nowIso,
  }
  const topTight = await getTopSellers(db as any, SHOP_ID, tightRange, 10)
  const hotTight = topTight.find((r) => r.variant_id === VAR_HOT)
  assert(!!hotTight, 'VAR_HOT still present in 6d window')
  assert(
    !!(hotTight && hotTight.units_sold === 18),
    `VAR_HOT units_sold=18 in 6d window (got ${hotTight?.units_sold})`,
  )

  // ---------- Section 4: getLowStock returns variants ≤ threshold ----------
  log('\n[4] getLowStock returns inventory_quantity ≤ 5, ordered asc')
  const low = await getLowStock(db as any, SHOP_ID, { threshold: 5, limit: 20 })
  const lowIds = low.map((r) => r.variant_id)
  assert(lowIds.includes(VAR_TRICKLE), `VAR_TRICKLE present (qty=2 ≤ 5)`)
  assert(!lowIds.includes(VAR_HOT), 'VAR_HOT absent (qty=8 > 5)')
  assert(!lowIds.includes(VAR_WARM), 'VAR_WARM absent (qty=100 > 5)')
  assert(!lowIds.includes(VAR_COLD), 'VAR_COLD absent (qty=25 > 5)')
  const trickleLow = low.find((r) => r.variant_id === VAR_TRICKLE)!
  assert(
    trickleLow.inventory_quantity === 2,
    `VAR_TRICKLE inventory_quantity=2 (got ${trickleLow.inventory_quantity})`,
  )

  // ---------- Section 5: getLowStock threshold tightening ----------
  log('\n[5] getLowStock threshold=10 admits VAR_HOT (qty=8)')
  const low10 = await getLowStock(db as any, SHOP_ID, { threshold: 10, limit: 20 })
  const low10Ids = low10.map((r) => r.variant_id)
  assert(low10Ids.includes(VAR_HOT), 'VAR_HOT present at threshold=10 (qty=8)')
  assert(low10Ids.includes(VAR_TRICKLE), 'VAR_TRICKLE still present')
  assert(!low10Ids.includes(VAR_WARM), 'VAR_WARM still absent (qty=100)')

  // ---------- Section 6: getDeadStock — never-sold variant shows up ----------
  log('\n[6] getDeadStock — VAR_COLD (never sold) + qty>0 appears')
  const dead = await getDeadStock(db as any, SHOP_ID, {
    daysCutoff: 90,
    limit: 50,
  })
  const deadIds = dead.map((r) => r.variant_id)
  assert(deadIds.includes(VAR_COLD), 'VAR_COLD present (never sold, qty=25)')
  assert(!deadIds.includes(VAR_HOT), 'VAR_HOT absent (sold 5d ago)')
  assert(!deadIds.includes(VAR_WARM), 'VAR_WARM absent (sold 5d ago)')
  assert(!deadIds.includes(VAR_TRICKLE), 'VAR_TRICKLE absent (sold 15d ago)')
  const coldRow = dead.find((r) => r.variant_id === VAR_COLD)!
  assert(
    coldRow.last_sold_at === null,
    `VAR_COLD last_sold_at=null (got ${coldRow.last_sold_at})`,
  )
  assert(
    coldRow.days_since_last_sale === null,
    `VAR_COLD days_since_last_sale=null (never sold)`,
  )
  assert(
    coldRow.inventory_quantity === 25,
    `VAR_COLD inventory=25 (got ${coldRow.inventory_quantity})`,
  )

  // ---------- Section 7: getDeadStock — include staled-sale variant ----------
  log('\n[7] getDeadStock — variant sold >90d ago shows up')
  // Seed a new variant with only an old sale (>90d ago).
  const VAR_STALE = randomUUID()
  const PROD_STALE = randomUUID()
  await db
    .insertInto('products')
    .values({
      id: PROD_STALE,
      shop_id: SHOP_ID,
      title: 'Stale Seller',
      slug: `stale-${SUFFIX}`,
      status: 'active',
    } as any)
    .execute()
  await db
    .insertInto('product_variants')
    .values({
      id: VAR_STALE,
      product_id: PROD_STALE,
      title: 'Default',
      price: '30.00',
      sku: `STALE-${SUFFIX}`,
      inventory_quantity: 7,
    } as any)
    .execute()
  const staleOrderId = await mkOrder(isoNDaysAgo(120), VAR_STALE, PROD_STALE, 1, '30.00')

  const dead2 = await getDeadStock(db as any, SHOP_ID, {
    daysCutoff: 90,
    limit: 50,
  })
  const dead2Ids = dead2.map((r) => r.variant_id)
  assert(dead2Ids.includes(VAR_STALE), 'VAR_STALE (sold 120d ago) appears in dead stock')
  const staleRow = dead2.find((r) => r.variant_id === VAR_STALE)!
  assert(
    staleRow.days_since_last_sale !== null && staleRow.days_since_last_sale >= 119,
    `VAR_STALE days_since_last_sale ≥ 119 (got ${staleRow.days_since_last_sale})`,
  )

  // Tightening cutoff to 30 days pulls TRICKLE (sold 15d ago) into the list?
  // No — 15 < 30 means it should STILL be excluded. Set to 10d to include it.
  const dead10d = await getDeadStock(db as any, SHOP_ID, {
    daysCutoff: 10,
    limit: 50,
  })
  const dead10Ids = dead10d.map((r) => r.variant_id)
  assert(
    dead10Ids.includes(VAR_TRICKLE),
    'VAR_TRICKLE (sold 15d ago) present at cutoff=10d',
  )
  assert(
    !dead10Ids.includes(VAR_HOT),
    'VAR_HOT (sold 5d ago) absent at cutoff=10d',
  )

  // ---------- Section 8: getSellThroughLeaders — minSold filter ----------
  log('\n[8] getSellThroughLeaders minSold=5 excludes VAR_TRICKLE (1 unit)')
  const leaders = await getSellThroughLeaders(db as any, SHOP_ID, range30d, {
    minSold: 5,
    limit: 10,
  })
  const leaderIds = leaders.map((r) => r.variant_id)
  assert(leaderIds.includes(VAR_HOT), 'VAR_HOT (30 units sold) present')
  assert(leaderIds.includes(VAR_WARM), 'VAR_WARM (10 units sold) present')
  assert(!leaderIds.includes(VAR_TRICKLE), 'VAR_TRICKLE (1 unit) excluded by minSold=5')
  assert(!leaderIds.includes(VAR_COLD), 'VAR_COLD (0 units) excluded')

  // ---------- Section 9: getSellThroughLeaders — ratio math ----------
  log('\n[9] getSellThroughLeaders ratio math matches computeSellThrough')
  // VAR_HOT: 30 sold, 8 on hand → 30 / 38 ≈ 0.7894
  // VAR_WARM: 10 sold, 100 on hand → 10 / 110 ≈ 0.0909
  const hotLead = leaders.find((r) => r.variant_id === VAR_HOT)!
  const warmLead = leaders.find((r) => r.variant_id === VAR_WARM)!
  const expectedHot = computeSellThrough(30, 8)
  const expectedWarm = computeSellThrough(10, 100)
  assert(
    Math.abs(hotLead.sell_through - expectedHot) < 1e-9,
    `VAR_HOT sell_through ≈ ${expectedHot.toFixed(4)} (got ${hotLead.sell_through.toFixed(4)})`,
  )
  assert(
    Math.abs(warmLead.sell_through - expectedWarm) < 1e-9,
    `VAR_WARM sell_through ≈ ${expectedWarm.toFixed(4)} (got ${warmLead.sell_through.toFixed(4)})`,
  )
  // Order: VAR_HOT has higher ratio, so comes first
  assert(leaderIds[0] === VAR_HOT, `rank #1 = VAR_HOT (highest sell_through)`)

  // ---------- Section 10: periodToRange ISO math ----------
  log('\n[10] periodToRange math on a known "now"')
  const knownNow = new Date('2026-04-21T12:00:00Z')
  const r30 = periodToRange('30d', knownNow)
  assert(r30.days === 30, `30d.days = 30 (got ${r30.days})`)
  assert(
    r30.since === '2026-03-22T12:00:00.000Z',
    `30d.since = 2026-03-22T12:00:00.000Z (got ${r30.since})`,
  )
  assert(
    r30.until === knownNow.toISOString(),
    `30d.until = now iso (got ${r30.until})`,
  )
  const r7 = periodToRange('7d', knownNow)
  assert(r7.days === 7, `7d.days = 7`)
  assert(r7.label === 'Last 7 days', `7d.label = "Last 7 days"`)
  const rBogus = periodToRange('foo', knownNow)
  assert(rBogus.days === 30, `bogus period defaults to 30d (got ${rBogus.days})`)

  // Clean up the extra rows we added for Section 7
  await db
    .deleteFrom('order_line_items')
    .where('order_id', '=', staleOrderId)
    .execute()
  await db.deleteFrom('orders').where('id', '=', staleOrderId).execute()
  await db.deleteFrom('product_variants').where('id', '=', VAR_STALE).execute()
  await db.deleteFrom('products').where('id', '=', PROD_STALE).execute()
}

async function cleanup() {
  log('\n[cleanup] disposing seeded rows')
  try {
    await db
      .deleteFrom('order_line_items')
      .where('variant_id', 'in', [VAR_HOT, VAR_WARM, VAR_COLD, VAR_TRICKLE])
      .execute()
    await db.deleteFrom('orders').where('shop_id', '=', SHOP_ID).execute()
    await db
      .deleteFrom('product_variants')
      .where('id', 'in', [VAR_HOT, VAR_WARM, VAR_COLD, VAR_TRICKLE])
      .execute()
    await db
      .deleteFrom('products')
      .where('id', 'in', [PROD_HOT, PROD_WARM, PROD_COLD, PROD_TRICKLE])
      .execute()
    await db.deleteFrom('customers').where('shop_id', '=', SHOP_ID).execute()
    await db.deleteFrom('shops').where('id', '=', SHOP_ID).execute()
    log('  cleanup done')
  } catch (err: any) {
    log(`  cleanup FAILED: ${err.message}`)
  }
}

main()
  .then(async () => {
    await cleanup()
    await db.destroy()
    log('\n' + '='.repeat(60))
    if (failed === 0) {
      log('PHASE 6 PR2 SMOKE: ALL CHECKS PASSED')
      process.exit(0)
    } else {
      log(`PHASE 6 PR2 SMOKE: ${failed} CHECK(S) FAILED`)
      process.exit(1)
    }
  })
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error('FATAL:', err)
    await cleanup()
    await db.destroy()
    process.exit(1)
  })
