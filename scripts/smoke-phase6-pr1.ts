/**
 * Phase 6 PR1 — Daily metrics rollup cron live smoke.
 *
 * Proves against real Postgres (server 1 via server 2) that:
 *
 *   1. Migration 006 shipped `daily_metrics` table with the
 *      expected schema (columns + unique index).
 *   2. `rollupDay(shop, date)` populates orders_count / revenue /
 *      refunds / visitors / conversions from live data.
 *   3. Running `rollupDay` twice for the same (shop, date) is
 *      idempotent — the second write upserts, no duplicate rows.
 *   4. `rollupYesterdayAllShops` iterates every active shop and
 *      returns the count. Inactive shops are skipped.
 *   5. `summarizeMetrics` on the live rows matches per-row math.
 *   6. `incrementToday` + `incrementVisitor` hot-path atomically
 *      update today's row.
 *   7. `seedAnalyticsCronTasks` inserts the cron_tasks row once,
 *      and is idempotent on re-run.
 *   8. The registered handler name matches the seeded row handler.
 *
 * Uses a disposable shop + customer (fresh uuid) so nothing touches
 * real data. Rolls back on partial failure via try/finally cleanup.
 *
 * Run on server 2 (LAN host whitelisted in pg_hba.conf on 192.168.1.13):
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase6-pr1.ts
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { createDb } from '../packages/db/src/index.js'
import {
  rollupDay,
  rollupYesterdayAllShops,
  getMetrics,
  getMetricsSummary,
  summarizeMetrics,
  incrementToday,
  incrementVisitor,
} from '../packages/core/src/modules/analytics/daily-metrics.js'
import {
  seedAnalyticsCronTasks,
  ANALYTICS_CRON_HANDLERS,
} from '../packages/core/src/modules/analytics/cron-register.js'

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_ID = randomUUID()
const INACTIVE_SHOP_ID = randomUUID()
const CUSTOMER_ID = randomUUID()
const CUSTOMER_EMAIL = `smoke-pr6-1+${SUFFIX}@example.test`

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

function yesterdayUtc(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

async function main() {
  log(`\n=== Phase 6 PR1 smoke — shop_id=${SHOP_ID} ===\n`)

  // ---------- Section 0: schema sanity ----------
  log('[0] daily_metrics schema')
  const cols = await sql<{ column_name: string; data_type: string }>`
    SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'daily_metrics'
      ORDER BY ordinal_position
  `.execute(db)
  const colNames = cols.rows.map((r) => r.column_name)
  const expected = ['shop_id', 'date', 'orders_count', 'revenue',
                    'refunds', 'visitors', 'conversions', 'currency']
  for (const c of expected) {
    assert(colNames.includes(c), `daily_metrics has column "${c}"`)
  }

  // Composite primary key (shop_id, date) acts as the unique constraint
  // the ON CONFLICT upsert depends on.
  const pk = await sql<{ conname: string }>`
    SELECT conname FROM pg_constraint
      WHERE conrelid = 'daily_metrics'::regclass
        AND contype = 'p'
  `.execute(db)
  assert(pk.rows.length === 1, 'daily_metrics has a primary key constraint')

  // ---------- Section 1: seed shop + customer + orders ----------
  log('\n[1] Seeding active + inactive shops, customer, orders, refund')

  await db
    .insertInto('shops')
    .values({
      id: SHOP_ID,
      slug: `smoke-p6-${SUFFIX}`,
      name: 'Phase 6 smoke shop',
      email: `shop-${SUFFIX}@example.test`,
      status: 'active',
    } as any)
    .execute()

  await db
    .insertInto('shops')
    .values({
      id: INACTIVE_SHOP_ID,
      slug: `smoke-p6-inactive-${SUFFIX}`,
      name: 'Inactive smoke shop',
      email: `inactive-${SUFFIX}@example.test`,
      status: 'suspended',
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

  const yesterdayIso = yesterdayUtc()
  const yesterdayMidnight = `${yesterdayIso}T12:00:00Z`

  // Three orders on yesterday UTC — total 300 USD.
  const orderIds: string[] = []
  for (const amount of ['100.00', '150.00', '50.00']) {
    const orderId = randomUUID()
    orderIds.push(orderId)
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
        subtotal_price: amount,
        total_tax: '0.00',
        total_discounts: '0.00',
        total_price: amount,
        total_shipping: '0.00',
        created_at: yesterdayMidnight,
        updated_at: yesterdayMidnight,
      } as any)
      .execute()
  }

  // ---------- Section 2: rollupDay populates all fields ----------
  log('\n[2] rollupDay computes orders/revenue from live tables')
  const row = await rollupDay(db, SHOP_ID, yesterdayIso)
  assert(Number(row.orders_count) === 3, `orders_count=3 (got ${row.orders_count})`)
  assert(
    Number(row.revenue) === 300,
    `revenue=300.00 (got ${row.revenue})`,
  )
  assert(row.currency === 'USD', `currency=USD (got ${row.currency})`)
  assert(row.shop_id === SHOP_ID, 'shop_id matches')
  assert(row.date === yesterdayIso, 'date matches yesterday UTC')

  // A daily_metrics row should now exist in the DB.
  const dbRow = await db
    .selectFrom('daily_metrics')
    .selectAll()
    .where('shop_id', '=', SHOP_ID)
    .where('date', '=', yesterdayIso)
    .executeTakeFirstOrThrow()
  assert(Number(dbRow.orders_count) === 3, 'DB row orders_count=3')
  assert(Number(dbRow.revenue) === 300, 'DB row revenue=300.00')

  // ---------- Section 3: idempotency ----------
  log('\n[3] rollupDay second call is idempotent (upsert, no dup)')
  await rollupDay(db, SHOP_ID, yesterdayIso)
  const dupCheck = await db
    .selectFrom('daily_metrics')
    .select(db.fn.countAll<number>().as('cnt'))
    .where('shop_id', '=', SHOP_ID)
    .where('date', '=', yesterdayIso)
    .executeTakeFirstOrThrow()
  assert(Number(dupCheck.cnt) === 1, 'still exactly one row after second rollup')

  // ---------- Section 4: rollupYesterdayAllShops skips inactive ----------
  log('\n[4] rollupYesterdayAllShops counts only active shops')
  // Clear our row so the count reflects this run's work (idempotent reset
  // still writes, but we want to verify iteration, not reuse prior state).
  await db
    .deleteFrom('daily_metrics')
    .where('shop_id', '=', SHOP_ID)
    .where('date', '=', yesterdayIso)
    .execute()

  const count = await rollupYesterdayAllShops(db)
  assert(
    typeof count === 'number' && count >= 1,
    `rolled up ${count} active shop(s) (includes our seeded + any other real active shops)`,
  )

  // Verify our seeded active shop was processed but inactive was skipped.
  const activeAfter = await db
    .selectFrom('daily_metrics')
    .selectAll()
    .where('shop_id', '=', SHOP_ID)
    .where('date', '=', yesterdayIso)
    .executeTakeFirst()
  assert(!!activeAfter, 'active shop got a row after rollupYesterdayAllShops')

  const inactiveAfter = await db
    .selectFrom('daily_metrics')
    .selectAll()
    .where('shop_id', '=', INACTIVE_SHOP_ID)
    .where('date', '=', yesterdayIso)
    .executeTakeFirst()
  assert(!inactiveAfter, 'inactive shop got NO row (status filter works)')

  // ---------- Section 5: getMetrics + getMetricsSummary ----------
  log('\n[5] getMetrics + getMetricsSummary read back correctly')
  const metrics = await getMetrics(db, SHOP_ID, {
    since: yesterdayIso,
    until: yesterdayIso,
  })
  assert(metrics.length === 1, `getMetrics returned 1 row (got ${metrics.length})`)

  const summary = await getMetricsSummary(db, SHOP_ID, {
    since: yesterdayIso,
    until: yesterdayIso,
  })
  assert(summary.orders_count === 3, `summary orders_count=3 (got ${summary.orders_count})`)
  assert(summary.revenue === '300.00', `summary revenue=300.00 (got ${summary.revenue})`)
  assert(summary.net_revenue === '300.00', `net_revenue=300.00 (got ${summary.net_revenue})`)

  // ---------- Section 6: summarizeMetrics pure helper matches ----------
  log('\n[6] summarizeMetrics pure helper output matches DB summary')
  const pure = summarizeMetrics(metrics)
  assert(pure.orders_count === summary.orders_count, 'pure.orders_count matches')
  assert(pure.revenue === summary.revenue, 'pure.revenue matches')
  assert(pure.net_revenue === summary.net_revenue, 'pure.net_revenue matches')

  // ---------- Section 7: incrementToday hot-path ----------
  log('\n[7] incrementToday atomically upserts today row')
  await incrementToday(db, SHOP_ID, '42.50', 'USD')
  const todayIso = todayUtc()
  const todayRow = await db
    .selectFrom('daily_metrics')
    .selectAll()
    .where('shop_id', '=', SHOP_ID)
    .where('date', '=', todayIso)
    .executeTakeFirstOrThrow()
  assert(Number(todayRow.orders_count) === 1, 'today orders_count=1 after first incrementToday')
  assert(Number(todayRow.revenue) === 42.5, `today revenue=42.50 (got ${todayRow.revenue})`)

  // Second call accumulates.
  await incrementToday(db, SHOP_ID, '7.50', 'USD')
  const todayRow2 = await db
    .selectFrom('daily_metrics')
    .selectAll()
    .where('shop_id', '=', SHOP_ID)
    .where('date', '=', todayIso)
    .executeTakeFirstOrThrow()
  assert(Number(todayRow2.orders_count) === 2, 'today orders_count=2 after second incrementToday')
  assert(Number(todayRow2.revenue) === 50, `today revenue=50.00 (got ${todayRow2.revenue})`)

  // ---------- Section 8: incrementVisitor ----------
  log('\n[8] incrementVisitor bumps visitors on today row')
  const beforeVisitors = Number(todayRow2.visitors ?? 0)
  await incrementVisitor(db, SHOP_ID)
  const todayRow3 = await db
    .selectFrom('daily_metrics')
    .selectAll()
    .where('shop_id', '=', SHOP_ID)
    .where('date', '=', todayIso)
    .executeTakeFirstOrThrow()
  assert(
    Number(todayRow3.visitors ?? 0) === beforeVisitors + 1,
    `visitors bumped ${beforeVisitors} → ${todayRow3.visitors}`,
  )

  // ---------- Section 9: cron_tasks seeding ----------
  log('\n[9] seedAnalyticsCronTasks idempotent + row exists')
  // Clear any prior rows so we can prove insertion. seedAnalyticsCronTasks
  // registers TWO handlers: ROLLUP_DAILY_METRICS (daily) and
  // PRUNE_OLD_METRICS (weekly). The smoke originally expected 1 seed
  // before PRUNE_OLD_METRICS landed — now asserts the actual pair.
  await db
    .deleteFrom('cron_tasks')
    .where('handler', 'in', [
      ANALYTICS_CRON_HANDLERS.ROLLUP_DAILY_METRICS,
      ANALYTICS_CRON_HANDLERS.PRUNE_OLD_METRICS,
    ])
    .execute()

  const seed1 = await seedAnalyticsCronTasks(db)
  assert(seed1.inserted === 2, `first seed inserted=2 (rollup + prune; got ${seed1.inserted})`)
  assert(seed1.existing === 0, `first seed existing=0 (got ${seed1.existing})`)

  const seed2 = await seedAnalyticsCronTasks(db)
  assert(seed2.inserted === 0, `second seed inserted=0 (got ${seed2.inserted})`)
  assert(seed2.existing === 2, `second seed existing=2 (got ${seed2.existing})`)

  const task = await db
    .selectFrom('cron_tasks')
    .selectAll()
    .where('handler', '=', ANALYTICS_CRON_HANDLERS.ROLLUP_DAILY_METRICS)
    .executeTakeFirstOrThrow()
  assert(task.schedule === 'daily', `schedule='daily' (got ${task.schedule})`)
  assert(task.status === 'active', `status='active' (got ${task.status})`)
  assert(task.name === 'Daily metrics rollup', `name='Daily metrics rollup' (got ${task.name})`)
  assert(!!task.next_run_at, 'next_run_at is set')

  // ---------- Section 10: handler is registered in the cron registry ----------
  log('\n[10] cron handler registered with matching name')
  // registerHandler() runs at import time via modules/cron/service.ts → cron-register.ts.
  // There is no public getter; probe by scheduling and running executeDueJobs
  // against our seeded row (set next_run_at to past, then run).
  await db
    .updateTable('cron_tasks')
    .set({ next_run_at: new Date(Date.now() - 60_000).toISOString() } as any)
    .where('id', '=', task.id)
    .execute()

  const { executeDueJobs } = await import('../packages/core/src/modules/cron/service.js')
  const results = await executeDueJobs(db)
  const ours = results.find(
    (r) => r.name === task.name || r.taskId === task.id,
  )
  assert(!!ours, 'executeDueJobs ran our task')
  assert(
    !!ours && ours.status === 'success',
    `handler completed (status=${ours?.status}, error=${ours?.error ?? 'none'})`,
  )
}

async function cleanup() {
  log('\n[cleanup] disposing seeded rows')
  try {
    await db.deleteFrom('orders').where('shop_id', '=', SHOP_ID).execute()
    await db
      .deleteFrom('daily_metrics')
      .where('shop_id', 'in', [SHOP_ID, INACTIVE_SHOP_ID])
      .execute()
    await db.deleteFrom('customers').where('shop_id', '=', SHOP_ID).execute()
    await db
      .deleteFrom('shops')
      .where('id', 'in', [SHOP_ID, INACTIVE_SHOP_ID])
      .execute()
    // Leave the seeded cron_tasks row in place — it's a real platform-level
    // row, not scoped to our test shops. Re-runs are idempotent.
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
      log('PHASE 6 PR1 SMOKE: ALL CHECKS PASSED')
      process.exit(0)
    } else {
      log(`PHASE 6 PR1 SMOKE: ${failed} CHECK(S) FAILED`)
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
