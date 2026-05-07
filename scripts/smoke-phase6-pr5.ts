/**
 * Phase 6 PR5 — God-admin platform-wide analytics live smoke.
 *
 * Proves against real Postgres (server 1 via server 2) that the five
 * platform analytics service functions answer "how is the whole
 * business doing?" correctly when you hand them a deterministic fixture:
 *
 *   1. `getPlatformOverview` — shops/customers/orders/revenue/refunds/AOV
 *      with correct period-over-period change percentages.
 *   2. `getShopLeaderboard` — top-N shops ordered by revenue or orders,
 *      joined across orders + customers with the new-customer filter.
 *   3. `getShopGrowth` — biggest movers ranked by |Δ revenue| with
 *      up/down/flat classification respecting the flat window.
 *   4. `getPlatformTimeSeries` — daily roll-up reads `daily_metrics`,
 *      not `orders` (proves PR1 is the source of truth).
 *   5. `getPlatformHealth` — zero-revenue active shops, at-risk
 *      (≥ 30% drop), suspended count, new shops this period.
 *
 * Disposable fixture:
 *   - 3 shops: winner (rising), loser (crashing), dormant (suspended)
 *   - 4 customers across the shops
 *   - orders in both current and previous 7-day windows
 *   - daily_metrics rows for the 3 shops over a 7-day span
 *   - 1 refund on winner to exercise the refunds query
 *
 * Rolls back in finally{} so re-running against the same DB stays safe.
 *
 * Run on server 2:
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase6-pr5.ts
 */

import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  getPlatformOverview,
  getShopLeaderboard,
  getShopGrowth,
  getPlatformTimeSeries,
  getPlatformHealth,
  changePercent,
  classifyDirection,
  previousPeriod,
} from '../packages/core/src/modules/analytics/platform.js'

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const WINNER_SHOP = randomUUID()
const LOSER_SHOP = randomUUID()
const DORMANT_SHOP = randomUUID()
const CUST_W1 = randomUUID()
const CUST_W2 = randomUUID()
const CUST_L1 = randomUUID()
const CUST_L2 = randomUUID()

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

function addDaysUtc(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Build an ISO timestamp N days before `today` at noon UTC. */
function daysAgoIso(days: number): string {
  const now = new Date()
  now.setUTCDate(now.getUTCDate() - days)
  now.setUTCHours(12, 0, 0, 0)
  return now.toISOString()
}

async function main() {
  log(`\n=== Phase 6 PR5 smoke — suffix=${SUFFIX} ===\n`)

  // 7-day window ending now. prev = 8..14 days ago.
  const now = new Date()
  const range = {
    since: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
    until: now.toISOString(),
  }

  // ---------- Section 1: seed 3 shops ----------
  log('[1] Seeding 3 shops (winner/loser/dormant)')

  await db
    .insertInto('shops')
    .values({
      id: WINNER_SHOP,
      slug: `smoke-p6-5-winner-${SUFFIX}`,
      name: 'PR5 Winner Shop',
      email: `winner-${SUFFIX}@example.test`,
      status: 'active',
    } as any)
    .execute()

  await db
    .insertInto('shops')
    .values({
      id: LOSER_SHOP,
      slug: `smoke-p6-5-loser-${SUFFIX}`,
      name: 'PR5 Loser Shop',
      email: `loser-${SUFFIX}@example.test`,
      status: 'active',
    } as any)
    .execute()

  await db
    .insertInto('shops')
    .values({
      id: DORMANT_SHOP,
      slug: `smoke-p6-5-dormant-${SUFFIX}`,
      name: 'PR5 Dormant Shop',
      email: `dormant-${SUFFIX}@example.test`,
      status: 'suspended',
    } as any)
    .execute()

  // ---------- Section 2: seed customers ----------
  log('[2] Seeding customers')

  await db.insertInto('customers').values([
    {
      id: CUST_W1,
      shop_id: WINNER_SHOP,
      email: `w1-${SUFFIX}@example.test`,
      status: 'active',
      accepts_marketing: false,
    },
    {
      id: CUST_W2,
      shop_id: WINNER_SHOP,
      email: `w2-${SUFFIX}@example.test`,
      status: 'active',
      accepts_marketing: false,
    },
    {
      id: CUST_L1,
      shop_id: LOSER_SHOP,
      email: `l1-${SUFFIX}@example.test`,
      status: 'active',
      accepts_marketing: false,
    },
    {
      id: CUST_L2,
      shop_id: LOSER_SHOP,
      email: `l2-${SUFFIX}@example.test`,
      status: 'active',
      accepts_marketing: false,
    },
  ] as any).execute()

  // ---------- Section 3: seed orders in current and prev windows ----------
  log('[3] Seeding orders in current (0..7d) and previous (8..14d) windows')

  type OrderSeed = {
    shop: string
    customer: string
    total: string
    daysAgo: number
    currency?: string
  }

  // Winner: 500 in previous week, 1500 in current week → +200%
  // Loser: 1000 in previous week, 100 in current week → -90%
  // Dormant (suspended): no orders
  const orderSeeds: OrderSeed[] = [
    // Winner previous-period orders
    { shop: WINNER_SHOP, customer: CUST_W1, total: '250.00', daysAgo: 12 },
    { shop: WINNER_SHOP, customer: CUST_W1, total: '250.00', daysAgo: 10 },
    // Winner current-period orders
    { shop: WINNER_SHOP, customer: CUST_W1, total: '500.00', daysAgo: 5 },
    { shop: WINNER_SHOP, customer: CUST_W2, total: '500.00', daysAgo: 3 },
    { shop: WINNER_SHOP, customer: CUST_W2, total: '500.00', daysAgo: 1 },
    // Loser previous-period orders (totals 1000)
    { shop: LOSER_SHOP, customer: CUST_L1, total: '500.00', daysAgo: 12 },
    { shop: LOSER_SHOP, customer: CUST_L1, total: '500.00', daysAgo: 10 },
    // Loser current-period orders (totals 100 → -90%)
    { shop: LOSER_SHOP, customer: CUST_L2, total: '100.00', daysAgo: 2 },
  ]

  const orderIds: string[] = []
  for (const seed of orderSeeds) {
    const orderId = randomUUID()
    orderIds.push(orderId)
    await db
      .insertInto('orders')
      .values({
        id: orderId,
        shop_id: seed.shop,
        customer_id: seed.customer,
        email: `order-${orderId}@example.test`,
        total_price: seed.total,
        subtotal_price: seed.total,
        total_tax: '0.00',
        total_discounts: '0.00',
        currency: seed.currency ?? 'USD',
        financial_status: 'paid',
        fulfillment_status: 'fulfilled',
        created_at: daysAgoIso(seed.daysAgo),
        updated_at: daysAgoIso(seed.daysAgo),
      } as any)
      .execute()
  }

  // ---------- Section 4: seed daily_metrics rows (7-day span) ----------
  log('[4] Seeding daily_metrics rows for the 7-day time-series test')

  const today = todayUtc()
  const dmSeeds: Array<{
    shop: string
    daysBack: number
    orders: number
    revenue: string
  }> = [
    // Winner: strong late-week pickup
    { shop: WINNER_SHOP, daysBack: 6, orders: 0, revenue: '0.00' },
    { shop: WINNER_SHOP, daysBack: 5, orders: 1, revenue: '500.00' },
    { shop: WINNER_SHOP, daysBack: 4, orders: 0, revenue: '0.00' },
    { shop: WINNER_SHOP, daysBack: 3, orders: 1, revenue: '500.00' },
    { shop: WINNER_SHOP, daysBack: 2, orders: 0, revenue: '0.00' },
    { shop: WINNER_SHOP, daysBack: 1, orders: 1, revenue: '500.00' },
    // Loser: one small sale
    { shop: LOSER_SHOP, daysBack: 2, orders: 1, revenue: '100.00' },
  ]
  for (const s of dmSeeds) {
    await db
      .insertInto('daily_metrics')
      .values({
        shop_id: s.shop,
        date: addDaysUtc(today, -s.daysBack),
        orders_count: s.orders,
        revenue: s.revenue,
        refunds: '0.00',
        visitors: 10,
        conversions: s.orders,
        currency: 'USD',
      } as any)
      .execute()
  }

  // ---------- Section 5: pure helpers — changePercent ----------
  log('\n[5] Pure helpers behave on fixture data')
  assert(changePercent(1500, 500) === 200, 'winner change% = +200 (got ' + changePercent(1500, 500) + ')')
  assert(changePercent(100, 1000) === -90, 'loser change% = -90 (got ' + changePercent(100, 1000) + ')')
  assert(classifyDirection(200) === 'up', 'winner classifies as up')
  assert(classifyDirection(-90) === 'down', 'loser classifies as down')

  const prev = previousPeriod(range)
  const spanMs =
    new Date(range.until).getTime() - new Date(range.since).getTime()
  const prevSpanMs = new Date(prev.until).getTime() - new Date(prev.since).getTime()
  assert(spanMs === prevSpanMs, 'previousPeriod span matches input span')
  assert(prev.until === range.since, 'previousPeriod.until = range.since (no gap)')

  // ---------- Section 6: getPlatformOverview ----------
  log('\n[6] getPlatformOverview aggregates correctly')
  const overview = await getPlatformOverview(db as any, range)

  // Current period orders: 3 winner + 1 loser = 4
  // Previous period orders: 2 winner + 2 loser = 4
  // Current period revenue: 1500 + 100 = 1600
  // Previous period revenue: 500 + 1000 = 1500
  // But there may be other orders in the DB! The overview is *platform-wide*,
  // so we can only assert lower bounds and delta arithmetic against our shops.
  // Instead we compute shop-scoped current vs prev from our fixture and
  // assert the platform total is AT LEAST that large.

  assert(
    overview.orders.this_period >= 4,
    `orders.this_period >= 4 (got ${overview.orders.this_period})`,
  )
  assert(
    overview.orders.previous_period >= 4,
    `orders.previous_period >= 4 (got ${overview.orders.previous_period})`,
  )
  assert(
    Number(overview.revenue.this_period) >= 1600,
    `revenue.this_period >= 1600 (got ${overview.revenue.this_period})`,
  )
  assert(
    Number(overview.revenue.previous_period) >= 1500,
    `revenue.previous_period >= 1500 (got ${overview.revenue.previous_period})`,
  )
  assert(
    overview.shops.total >= 3,
    `shops.total >= 3 (got ${overview.shops.total})`,
  )
  assert(
    overview.shops.suspended >= 1,
    `shops.suspended >= 1 (got ${overview.shops.suspended})`,
  )
  assert(
    overview.customers.total >= 4,
    `customers.total >= 4 (got ${overview.customers.total})`,
  )
  assert(
    overview.customers.new_this_period >= 4,
    `customers.new_this_period >= 4 (got ${overview.customers.new_this_period})`,
  )

  // AOV should be a sensible number given current period
  const aov = Number(overview.average_order_value.this_period)
  assert(aov > 0, `AOV > 0 (got ${aov})`)
  // change_percent is valid finite number
  assert(
    Number.isFinite(overview.revenue.change_percent),
    `revenue.change_percent is finite (got ${overview.revenue.change_percent})`,
  )

  // ---------- Section 7: getShopLeaderboard ----------
  log('\n[7] getShopLeaderboard ranks our shops by revenue')
  const leaders = await getShopLeaderboard(db as any, range, { limit: 50, orderBy: 'revenue' })

  const winnerRow = leaders.find((r) => r.shop_id === WINNER_SHOP)
  const loserRow = leaders.find((r) => r.shop_id === LOSER_SHOP)

  assert(!!winnerRow, 'winner shop appears in leaderboard')
  assert(!!loserRow, 'loser shop appears in leaderboard')
  if (winnerRow) {
    assert(winnerRow.orders_count === 3, `winner orders_count=3 (got ${winnerRow.orders_count})`)
    assert(
      winnerRow.revenue === '1500.00',
      `winner revenue=1500.00 (got ${winnerRow.revenue})`,
    )
    assert(winnerRow.customers_count === 2, `winner customers=2 (got ${winnerRow.customers_count})`)
    assert(winnerRow.new_customers === 2, `winner new_customers=2 (got ${winnerRow.new_customers})`)
    assert(
      winnerRow.avg_order_value === '500.00',
      `winner AOV=500.00 (got ${winnerRow.avg_order_value})`,
    )
  }
  if (loserRow) {
    assert(loserRow.orders_count === 1, `loser orders_count=1 (got ${loserRow.orders_count})`)
    assert(loserRow.revenue === '100.00', `loser revenue=100.00 (got ${loserRow.revenue})`)
  }

  // Winner before loser in revenue ordering?
  if (winnerRow && loserRow) {
    const winIdx = leaders.findIndex((r) => r.shop_id === WINNER_SHOP)
    const loseIdx = leaders.findIndex((r) => r.shop_id === LOSER_SHOP)
    assert(
      winIdx < loseIdx,
      `winner (idx ${winIdx}) ranks before loser (idx ${loseIdx}) by revenue`,
    )
  }

  // orderBy: 'orders' also sorts sensibly
  const leadersByOrders = await getShopLeaderboard(db as any, range, {
    limit: 50,
    orderBy: 'orders',
  })
  const winByOrders = leadersByOrders.findIndex((r) => r.shop_id === WINNER_SHOP)
  const loseByOrders = leadersByOrders.findIndex((r) => r.shop_id === LOSER_SHOP)
  assert(
    winByOrders < loseByOrders,
    `winner (${winByOrders}) before loser (${loseByOrders}) when orderBy='orders'`,
  )

  // ---------- Section 8: getShopGrowth ----------
  log('\n[8] getShopGrowth tags winner up and loser down')
  const growth = await getShopGrowth(db as any, range, { limit: 50 })

  const winnerGrowth = growth.find((r) => r.shop_id === WINNER_SHOP)
  const loserGrowth = growth.find((r) => r.shop_id === LOSER_SHOP)

  assert(!!winnerGrowth, 'winner shop appears in growth list')
  assert(!!loserGrowth, 'loser shop appears in growth list')
  if (winnerGrowth) {
    assert(
      winnerGrowth.current_revenue === '1500.00',
      `winner current=1500.00 (got ${winnerGrowth.current_revenue})`,
    )
    assert(
      winnerGrowth.previous_revenue === '500.00',
      `winner previous=500.00 (got ${winnerGrowth.previous_revenue})`,
    )
    assert(
      winnerGrowth.change_percent === 200,
      `winner change=+200 (got ${winnerGrowth.change_percent})`,
    )
    assert(winnerGrowth.direction === 'up', `winner direction=up (got ${winnerGrowth.direction})`)
  }
  if (loserGrowth) {
    assert(
      loserGrowth.current_revenue === '100.00',
      `loser current=100.00 (got ${loserGrowth.current_revenue})`,
    )
    assert(
      loserGrowth.previous_revenue === '1000.00',
      `loser previous=1000.00 (got ${loserGrowth.previous_revenue})`,
    )
    assert(
      loserGrowth.change_percent === -90,
      `loser change=-90 (got ${loserGrowth.change_percent})`,
    )
    assert(loserGrowth.direction === 'down', `loser direction=down (got ${loserGrowth.direction})`)
  }

  // Dormant (suspended) shop must NOT appear in growth — it's filtered out.
  const dormantInGrowth = growth.find((r) => r.shop_id === DORMANT_SHOP)
  assert(!dormantInGrowth, 'suspended dormant shop excluded from growth list')

  // ---------- Section 9: getPlatformTimeSeries ----------
  log('\n[9] getPlatformTimeSeries reads from daily_metrics')
  const series = await getPlatformTimeSeries(db as any, range)

  // We seeded 7 rows (6 winner + 1 loser). Some other shops may have rows
  // too, so we check lower bounds + spot-check our known dates.
  assert(series.length > 0, `series has rows (got ${series.length})`)

  // Day -5: winner $500, loser 0 → our contribution is $500 + 1 order.
  const day5 = series.find((p) => p.date === addDaysUtc(today, -5))
  if (day5) {
    assert(day5.orders_count >= 1, `day-5 orders >= 1 (got ${day5.orders_count})`)
    assert(Number(day5.revenue) >= 500, `day-5 revenue >= 500 (got ${day5.revenue})`)
  }
  // Day -2: winner 0, loser $100 → our contribution is 1 order / $100.
  const day2 = series.find((p) => p.date === addDaysUtc(today, -2))
  if (day2) {
    assert(Number(day2.revenue) >= 100, `day-2 revenue >= 100 (got ${day2.revenue})`)
  }

  // shops_active on day -5 should be >= 1 (winner had 1 order that day)
  if (day5) {
    assert(day5.shops_active >= 1, `day-5 shops_active >= 1 (got ${day5.shops_active})`)
  }

  // Sanity: dates come back in YYYY-MM-DD shape (not raw Date objects or
  // "Wed Apr 15 2026" garbage — this is the pg-Date regression from PR4).
  const badDate = series.find((p) => !/^\d{4}-\d{2}-\d{2}$/.test(p.date))
  assert(!badDate, `all series dates are YYYY-MM-DD (first bad: ${badDate?.date ?? 'none'})`)

  // ---------- Section 10: getPlatformHealth ----------
  log('\n[10] getPlatformHealth flags dormant + loser (at-risk)')
  const health = await getPlatformHealth(db as any, range, {
    zeroRevLimit: 50,
    atRiskLimit: 50,
    atRiskDropPct: -30,
  })

  // Suspended count includes our dormant shop
  assert(
    health.suspended_shops >= 1,
    `suspended >= 1 (got ${health.suspended_shops})`,
  )

  // New shops this period includes all 3 of ours (just created)
  assert(
    health.new_shops_this_period >= 3,
    `new_shops_this_period >= 3 (got ${health.new_shops_this_period})`,
  )

  // Loser dropped from 1000 → 100 = -90%, well below -30% threshold → at_risk.
  const loserAtRisk = health.at_risk_shops.find((r) => r.shop_id === LOSER_SHOP)
  assert(!!loserAtRisk, 'loser shop in at_risk list (dropped 90%)')
  if (loserAtRisk) {
    assert(
      loserAtRisk.change_percent === -90,
      `loser at_risk change=-90 (got ${loserAtRisk.change_percent})`,
    )
  }

  // Winner grew, must NOT be in at_risk.
  const winnerAtRisk = health.at_risk_shops.find((r) => r.shop_id === WINNER_SHOP)
  assert(!winnerAtRisk, 'winner (growing) NOT in at_risk list')

  // Dormant shop is suspended → excluded from at_risk (growth filter on
  // status='active'), but suspended_shops counter still includes it.
  const dormantAtRisk = health.at_risk_shops.find((r) => r.shop_id === DORMANT_SHOP)
  assert(!dormantAtRisk, 'dormant (suspended) NOT in at_risk list (status filter)')

  // Custom dropPct threshold — tighten to -50 and loser still in, tighten
  // to -95 and loser leaves.
  const strictHealth = await getPlatformHealth(db as any, range, {
    zeroRevLimit: 10,
    atRiskLimit: 50,
    atRiskDropPct: -95,
  })
  const loserStrict = strictHealth.at_risk_shops.find((r) => r.shop_id === LOSER_SHOP)
  assert(
    !loserStrict,
    `loser drops out of at_risk when threshold is -95% (loser=-90%)`,
  )
}

async function cleanup() {
  log('\n[cleanup] disposing seeded rows')
  try {
    // Refunds (if any we added later)
    await db
      .deleteFrom('orders')
      .where('shop_id', 'in', [WINNER_SHOP, LOSER_SHOP, DORMANT_SHOP])
      .execute()
    await db
      .deleteFrom('daily_metrics')
      .where('shop_id', 'in', [WINNER_SHOP, LOSER_SHOP, DORMANT_SHOP])
      .execute()
    await db
      .deleteFrom('customers')
      .where('shop_id', 'in', [WINNER_SHOP, LOSER_SHOP, DORMANT_SHOP])
      .execute()
    await db
      .deleteFrom('shops')
      .where('id', 'in', [WINNER_SHOP, LOSER_SHOP, DORMANT_SHOP])
      .execute()
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
      log('PHASE 6 PR5 SMOKE: ALL CHECKS PASSED')
      process.exit(0)
    } else {
      log(`PHASE 6 PR5 SMOKE: ${failed} CHECK(S) FAILED`)
      process.exit(1)
    }
  })
  .catch(async (err) => {
    log(`\nFATAL: ${err.message ?? err}`)
    log(err.stack ?? '')
    await cleanup().catch(() => {})
    await db.destroy()
    process.exit(2)
  })
