/**
 * Phase 6 PR3 — Customer behavior live smoke.
 *
 * Proves against real Postgres (server 1 via server 2) that the four
 * customer-behavior queries return correctly shaped, correctly-filtered
 * data against live tables.
 *
 * Coverage:
 *   1. schema sanity — customers.lifecycle_stage + last_order_at exist
 *   2. getTopSpenders — ranks by total_spent desc, respects minOrders
 *   3. getTopSpenders — segment filter narrows the result set
 *   4. getAtRiskCustomers — >60d cutoff + excludes churned by default
 *   5. getAtRiskCustomers — includeChurned=true brings churned back
 *   6. getNewVsReturning — partitions orders by prior-buy history
 *   7. getNewVsReturning — returning_rate math matches counts
 *   8. getLifecycleBreakdown — counts sum to total, all stages present
 *   9. getLifecycleBreakdown — segment filter narrows counts
 *
 * Run on server 2:
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase6-pr3.ts
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { createDb } from '../packages/db/src/index.js'
import {
  getTopSpenders,
  getAtRiskCustomers,
  getNewVsReturning,
  getLifecycleBreakdown,
  periodToRange,
  computeReturningRate,
} from '../packages/core/src/modules/analytics/customer-behavior.js'
import { createSegment } from '../packages/core/src/modules/customer-segments/service.js'

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_ID = randomUUID()

// Customers we'll seed with specific profiles.
const CUST_WHALE = randomUUID()    // big spender, recent → top
const CUST_LOYAL = randomUUID()    // medium spender, recent → returning
const CUST_ATRISK = randomUUID()   // last order 80d ago → at risk
const CUST_CHURNED = randomUUID()  // last order 200d ago, stage=churned
const CUST_NEW = randomUUID()      // ordered for first time in range
const CUST_SEG_VIP = randomUUID()  // tagged 'vip' for segment filter

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
  log(`\n=== Phase 6 PR3 smoke — shop_id=${SHOP_ID} ===\n`)

  // ---------- Section 0: schema sanity ----------
  log('[0] schema sanity — customers has lifecycle_stage + last_order_at')
  const cols = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns
      WHERE table_name = 'customers'
  `.execute(db)
  const colNames = cols.rows.map((r) => r.column_name)
  for (const c of ['id', 'shop_id', 'email', 'orders_count', 'total_spent',
                    'last_order_at', 'lifecycle_stage', 'tags']) {
    assert(colNames.includes(c), `customers has column "${c}"`)
  }

  // ---------- Section 1: seed shop + customers + orders ----------
  log('\n[1] Seeding shop + 6 customers with distinct profiles')

  await db
    .insertInto('shops')
    .values({
      id: SHOP_ID,
      slug: `smoke-p6-pr3-${SUFFIX}`,
      name: 'Phase 6 PR3 smoke shop',
      email: `shop-${SUFFIX}@example.test`,
      status: 'active',
    } as any)
    .execute()

  await db
    .insertInto('customers')
    .values([
      {
        id: CUST_WHALE,
        shop_id: SHOP_ID,
        email: `whale-${SUFFIX}@example.test`,
        first_name: 'Whale',
        last_name: 'Buyer',
        orders_count: 12,
        total_spent: '9500.00',
        last_order_at: isoNDaysAgo(3),
        lifecycle_stage: 'returning',
        status: 'active',
        tags: ['vip'],
      },
      {
        id: CUST_LOYAL,
        shop_id: SHOP_ID,
        email: `loyal-${SUFFIX}@example.test`,
        first_name: 'Loyal',
        last_name: 'Buyer',
        orders_count: 6,
        total_spent: '800.00',
        last_order_at: isoNDaysAgo(10),
        lifecycle_stage: 'returning',
        status: 'active',
      },
      {
        id: CUST_ATRISK,
        shop_id: SHOP_ID,
        email: `atrisk-${SUFFIX}@example.test`,
        first_name: 'AtRisk',
        last_name: 'Buyer',
        orders_count: 3,
        total_spent: '300.00',
        last_order_at: isoNDaysAgo(80),
        lifecycle_stage: 'at_risk',
        status: 'active',
      },
      {
        id: CUST_CHURNED,
        shop_id: SHOP_ID,
        email: `churned-${SUFFIX}@example.test`,
        first_name: 'Churned',
        last_name: 'Buyer',
        orders_count: 2,
        total_spent: '150.00',
        last_order_at: isoNDaysAgo(200),
        lifecycle_stage: 'churned',
        status: 'active',
      },
      {
        id: CUST_NEW,
        shop_id: SHOP_ID,
        email: `new-${SUFFIX}@example.test`,
        first_name: 'New',
        last_name: 'Buyer',
        orders_count: 1,
        total_spent: '50.00',
        last_order_at: isoNDaysAgo(5),
        lifecycle_stage: 'new',
        status: 'active',
      },
      {
        id: CUST_SEG_VIP,
        shop_id: SHOP_ID,
        email: `vip-${SUFFIX}@example.test`,
        first_name: 'VIP',
        last_name: 'Buyer',
        orders_count: 8,
        total_spent: '2000.00',
        last_order_at: isoNDaysAgo(8),
        lifecycle_stage: 'returning',
        status: 'active',
        tags: ['vip'],
      },
    ] as any)
    .execute()

  // Orders
  //   - WHALE: 1 order 100d ago (prior), 2 orders in range → returning
  //   - LOYAL: 2 orders 90d ago (prior), 1 order in range → returning
  //   - NEW: only 1 order in range, no prior → new
  //   - AT_RISK: 3 orders 80-90d ago, no orders in range → not counted
  //   - CHURNED: 2 orders 200d+ ago, no in range → not counted
  //   - SEG_VIP: 1 order 100d ago (prior), 1 order in range → returning
  async function mkOrder(customerId: string, when: string, amount: string) {
    const orderId = randomUUID()
    await db
      .insertInto('orders')
      .values({
        id: orderId,
        shop_id: SHOP_ID,
        customer_id: customerId,
        order_number: Math.floor(Math.random() * 1_000_000),
        email: `shop-${SUFFIX}@example.test`,
        financial_status: 'paid',
        fulfillment_status: 'unfulfilled',
        currency: 'USD',
        subtotal_price: amount,
        total_tax: '0.00',
        total_discounts: '0.00',
        total_price: amount,
        total_shipping: '0.00',
        created_at: when,
        updated_at: when,
      } as any)
      .execute()
    return orderId
  }

  // WHALE — 1 prior + 2 in range
  await mkOrder(CUST_WHALE, isoNDaysAgo(100), '500.00')
  await mkOrder(CUST_WHALE, isoNDaysAgo(5), '1500.00')
  await mkOrder(CUST_WHALE, isoNDaysAgo(3), '2000.00')
  // LOYAL — 2 prior + 1 in range
  await mkOrder(CUST_LOYAL, isoNDaysAgo(100), '100.00')
  await mkOrder(CUST_LOYAL, isoNDaysAgo(90), '100.00')
  await mkOrder(CUST_LOYAL, isoNDaysAgo(10), '100.00')
  // NEW — 1 in range only
  await mkOrder(CUST_NEW, isoNDaysAgo(5), '50.00')
  // AT_RISK — 3 orders outside range
  await mkOrder(CUST_ATRISK, isoNDaysAgo(80), '100.00')
  await mkOrder(CUST_ATRISK, isoNDaysAgo(85), '100.00')
  await mkOrder(CUST_ATRISK, isoNDaysAgo(90), '100.00')
  // CHURNED — 2 orders way out of range
  await mkOrder(CUST_CHURNED, isoNDaysAgo(200), '75.00')
  await mkOrder(CUST_CHURNED, isoNDaysAgo(210), '75.00')
  // SEG_VIP — 1 prior + 1 in range
  await mkOrder(CUST_SEG_VIP, isoNDaysAgo(100), '1000.00')
  await mkOrder(CUST_SEG_VIP, isoNDaysAgo(8), '1000.00')

  // ---------- Section 2: getTopSpenders ranks correctly ----------
  log('\n[2] getTopSpenders ranks by total_spent desc')
  const spenders = await getTopSpenders(db as any, SHOP_ID, {
    limit: 10,
    minOrders: 1,
  })
  const spenderEmails = spenders.map((r) => r.email)
  assert(
    spenders.length >= 6,
    `got ${spenders.length} top spenders (≥ 6 seeded)`,
  )
  // WHALE has total_spent = 9500, should be #1
  assert(
    spenders[0]?.customer_id === CUST_WHALE,
    `rank #1 = WHALE (got email ${spenders[0]?.email})`,
  )
  assert(
    Number(spenders[0]?.total_spent) === 9500,
    `WHALE total_spent=9500 (got ${spenders[0]?.total_spent})`,
  )
  // VIP (2000) should rank above LOYAL (800)
  const vipIdx = spenders.findIndex((r) => r.customer_id === CUST_SEG_VIP)
  const loyalIdx = spenders.findIndex((r) => r.customer_id === CUST_LOYAL)
  assert(vipIdx >= 0 && loyalIdx >= 0, 'VIP and LOYAL both present')
  assert(vipIdx < loyalIdx, `VIP (2000) ranks above LOYAL (800) — ${vipIdx} < ${loyalIdx}`)

  // minOrders filter
  log('\n[2b] getTopSpenders minOrders=5 excludes NEW (1 order)')
  const loyals = await getTopSpenders(db as any, SHOP_ID, {
    limit: 10,
    minOrders: 5,
  })
  const loyalIds = loyals.map((r) => r.customer_id)
  assert(loyalIds.includes(CUST_WHALE), 'WHALE (12 orders) present')
  assert(loyalIds.includes(CUST_LOYAL), 'LOYAL (6 orders) present')
  assert(loyalIds.includes(CUST_SEG_VIP), 'SEG_VIP (8 orders) present')
  assert(!loyalIds.includes(CUST_NEW), 'NEW (1 order) excluded by minOrders=5')
  assert(!loyalIds.includes(CUST_ATRISK), 'ATRISK (3 orders) excluded by minOrders=5')

  // ---------- Section 3: getTopSpenders with segment filter ----------
  log('\n[3] getTopSpenders segmentId narrows to tag=vip')
  const vipSegment = await createSegment(db as any, {
    shop_id: SHOP_ID,
    name: `VIP-${SUFFIX}`,
    rules: {
      combinator: 'and',
      rules: [{ field: 'tags', op: 'contains', value: 'vip' }],
    },
  })

  const vipSpenders = await getTopSpenders(db as any, SHOP_ID, {
    limit: 10,
    minOrders: 1,
    segmentId: vipSegment.id,
  })
  const vipIds = vipSpenders.map((r) => r.customer_id)
  assert(vipIds.length === 2, `segment returns 2 customers (got ${vipIds.length})`)
  assert(vipIds.includes(CUST_WHALE), 'WHALE (tag=vip) in segment')
  assert(vipIds.includes(CUST_SEG_VIP), 'SEG_VIP (tag=vip) in segment')
  assert(!vipIds.includes(CUST_LOYAL), 'LOYAL (no vip tag) excluded by segment')

  // ---------- Section 4: getAtRiskCustomers with default 60d cutoff ----------
  log('\n[4] getAtRiskCustomers — >60d, excludes churned by default')
  const atRisk = await getAtRiskCustomers(db as any, SHOP_ID, {
    daysCutoff: 60,
    limit: 50,
  })
  const atRiskIds = atRisk.map((r) => r.customer_id)
  assert(atRiskIds.includes(CUST_ATRISK), 'ATRISK (80d) present')
  assert(!atRiskIds.includes(CUST_CHURNED), 'CHURNED excluded by default')
  assert(!atRiskIds.includes(CUST_WHALE), 'WHALE (3d) absent — still active')
  assert(!atRiskIds.includes(CUST_LOYAL), 'LOYAL (10d) absent — still active')
  assert(!atRiskIds.includes(CUST_NEW), 'NEW (5d) absent — still active')
  const atRiskRow = atRisk.find((r) => r.customer_id === CUST_ATRISK)!
  assert(
    atRiskRow.days_since_last_order !== null &&
      atRiskRow.days_since_last_order >= 79,
    `ATRISK days_since_last_order ≥ 79 (got ${atRiskRow.days_since_last_order})`,
  )

  // ---------- Section 5: getAtRiskCustomers includeChurned ----------
  log('\n[5] getAtRiskCustomers includeChurned=true includes churned')
  const atRiskAll = await getAtRiskCustomers(db as any, SHOP_ID, {
    daysCutoff: 60,
    limit: 50,
    includeChurned: true,
  })
  const atRiskAllIds = atRiskAll.map((r) => r.customer_id)
  assert(atRiskAllIds.includes(CUST_ATRISK), 'ATRISK still present')
  assert(atRiskAllIds.includes(CUST_CHURNED), 'CHURNED now included')

  // ---------- Section 6: getNewVsReturning partitions correctly ----------
  log('\n[6] getNewVsReturning partitions orders by prior history')
  const range30d = periodToRange('30d')
  const nvr = await getNewVsReturning(db as any, SHOP_ID, range30d)

  // In range we placed:
  //   WHALE x2 (prior exists → returning, returning)
  //   LOYAL x1 (prior exists → returning)
  //   NEW x1 (no prior → new)
  //   SEG_VIP x1 (prior exists → returning)
  // Expected: new=1, returning=4, total=5
  assert(
    nvr.new_customer_orders === 1,
    `new_customer_orders=1 (got ${nvr.new_customer_orders})`,
  )
  assert(
    nvr.returning_customer_orders === 4,
    `returning_customer_orders=4 (got ${nvr.returning_customer_orders})`,
  )
  assert(nvr.total_orders === 5, `total_orders=5 (got ${nvr.total_orders})`)

  // ---------- Section 7: returning_rate math ----------
  log('\n[7] returning_rate math — 4 / 5 = 0.8')
  const expectedRate = computeReturningRate(1, 4)
  assert(
    Math.abs(nvr.returning_rate - expectedRate) < 1e-9,
    `returning_rate matches computeReturningRate(1, 4) = ${expectedRate.toFixed(3)} (got ${nvr.returning_rate.toFixed(3)})`,
  )
  assert(Math.abs(nvr.returning_rate - 0.8) < 1e-9, `returning_rate=0.8 exactly`)

  // ---------- Section 8: getLifecycleBreakdown counts stages ----------
  log('\n[8] getLifecycleBreakdown — sums to total, stages present')
  const life = await getLifecycleBreakdown(db as any, SHOP_ID)
  const sum = Object.values(life.counts).reduce((a, b) => a + b, 0)
  assert(sum === life.total, `counts sum (${sum}) === total (${life.total})`)
  assert(life.total === 6, `total seeded = 6 (got ${life.total})`)
  assert(
    (life.counts.returning ?? 0) === 3,
    `returning=3 — WHALE+LOYAL+SEG_VIP (got ${life.counts.returning})`,
  )
  assert((life.counts.at_risk ?? 0) === 1, `at_risk=1 (got ${life.counts.at_risk})`)
  assert((life.counts.churned ?? 0) === 1, `churned=1 (got ${life.counts.churned})`)
  assert((life.counts.new ?? 0) === 1, `new=1 (got ${life.counts.new})`)

  // ---------- Section 9: getLifecycleBreakdown with segment ----------
  log('\n[9] getLifecycleBreakdown segmentId narrows counts')
  const lifeVip = await getLifecycleBreakdown(db as any, SHOP_ID, {
    segmentId: vipSegment.id,
  })
  assert(lifeVip.total === 2, `segment scope total=2 (got ${lifeVip.total})`)
  assert(
    (lifeVip.counts.returning ?? 0) === 2,
    `both VIPs are "returning" (got ${lifeVip.counts.returning})`,
  )

  // Clean up segment
  await db
    .deleteFrom('customer_segments')
    .where('id', '=', vipSegment.id)
    .execute()
}

async function cleanup() {
  log('\n[cleanup] disposing seeded rows')
  try {
    await db.deleteFrom('orders').where('shop_id', '=', SHOP_ID).execute()
    await db
      .deleteFrom('customer_segments')
      .where('shop_id', '=', SHOP_ID)
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
      log('PHASE 6 PR3 SMOKE: ALL CHECKS PASSED')
      process.exit(0)
    } else {
      log(`PHASE 6 PR3 SMOKE: ${failed} CHECK(S) FAILED`)
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
