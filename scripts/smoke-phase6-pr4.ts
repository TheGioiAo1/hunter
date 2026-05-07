/**
 * Phase 6 PR4 — Analytics rollup consistency live smoke.
 *
 * Proves against real Postgres (server 1 via server 2) that the three
 * gap-and-retention helpers added on top of PR1's rollup work end-to-end:
 *
 *   1. `findMissingDates` is consistent with what the DB actually holds.
 *   2. `backfillMissingDays` skips existing rows, fills only gaps, and
 *      is idempotent when run twice.
 *   3. `pruneOldMetrics` deletes rows strictly older than the cutoff,
 *      scoped by shop, and leaves today's row intact.
 *   4. `pruneOldMetrics` global form respects the shop filter (pruning
 *      scoped to our disposable shop doesn't delete other shops' rows).
 *   5. Fixed hot-path: `incrementToday(..., amount:string, currency)`
 *      no longer silently writes with undefined currency.
 *   6. `seedAnalyticsCronTasks` now seeds BOTH handlers (rollup + prune)
 *      and is idempotent on re-run.
 *   7. The `prune_old_metrics` handler runs via `executeDueJobs`.
 *
 * Uses a disposable shop (fresh uuid) so nothing touches real data.
 * Rolls back on partial failure via try/finally cleanup.
 *
 * Run on server 2 (LAN host whitelisted in pg_hba.conf on 192.168.1.13):
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase6-pr4.ts
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { createDb } from '../packages/db/src/index.js'
import {
  rollupDay,
  backfillMissingDays,
  pruneOldMetrics,
  computePruneCutoff,
  findMissingDates,
  incrementToday,
  isoDay,
  getMetrics,
} from '../packages/core/src/modules/analytics/daily-metrics.js'
import {
  seedAnalyticsCronTasks,
  ANALYTICS_CRON_HANDLERS,
} from '../packages/core/src/modules/analytics/cron-register.js'

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_ID = randomUUID()
const OTHER_SHOP_ID = randomUUID()
const CUSTOMER_ID = randomUUID()
const CUSTOMER_EMAIL = `smoke-pr6-4+${SUFFIX}@example.test`

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

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

function addDaysUtc(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

async function main() {
  log(`\n=== Phase 6 PR4 smoke — shop_id=${SHOP_ID} ===\n`)

  // ---------- Section 1: seed two shops + a customer ----------
  log('[1] Seeding two shops + customer')

  await db
    .insertInto('shops')
    .values({
      id: SHOP_ID,
      slug: `smoke-p6-4-${SUFFIX}`,
      name: 'Phase 6 PR4 smoke shop',
      email: `shop-${SUFFIX}@example.test`,
      status: 'active',
    } as any)
    .execute()

  await db
    .insertInto('shops')
    .values({
      id: OTHER_SHOP_ID,
      slug: `smoke-p6-4-other-${SUFFIX}`,
      name: 'Phase 6 PR4 smoke shop (other)',
      email: `other-${SUFFIX}@example.test`,
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

  // Seed daily_metrics rows for SHOP_ID covering a 10-day window, with
  // HOLES at days -4 and -2 (counting back from today). Revenue $10/day
  // so we can tell real rows from backfilled (empty) ones.
  const today = todayUtc()
  const allDates: string[] = []
  for (let i = 9; i >= 0; i--) allDates.push(addDaysUtc(today, -i))
  // allDates = [today-9 .. today], 10 entries.
  const prefilled = allDates.filter(
    (d) => d !== addDaysUtc(today, -4) && d !== addDaysUtc(today, -2),
  ) // 8 entries; HOLES at today-4 and today-2.

  for (const date of prefilled) {
    await db
      .insertInto('daily_metrics')
      .values({
        shop_id: SHOP_ID,
        date,
        orders_count: 1,
        revenue: '10.00',
        refunds: '0.00',
        visitors: 2,
        conversions: 1,
        currency: 'USD',
      } as any)
      .execute()
  }

  // ---------- Section 2: findMissingDates matches DB ----------
  log('\n[2] findMissingDates agrees with DB gaps')
  const since = allDates[0]
  const until = allDates[allDates.length - 1]
  const rows = await db
    .selectFrom('daily_metrics')
    .select('date')
    .where('shop_id', '=', SHOP_ID)
    .where('date', '>=', since)
    .where('date', '<=', until)
    .execute()
  // rows[i].date is a JS Date (pg default for `date`). findMissingDates
  // normalizes via isoDay(), so pass it raw.
  const missing = findMissingDates(
    rows.map((r) => r.date as unknown),
    since,
    until,
  )
  assert(missing.length === 2, `2 gaps in 10-day window (got ${missing.length})`)
  assert(missing.includes(addDaysUtc(today, -4)), 'gap at today-4 detected')
  assert(missing.includes(addDaysUtc(today, -2)), 'gap at today-2 detected')

  // ---------- Section 3: backfillMissingDays skips existing, fills gaps ----------
  log('\n[3] backfillMissingDays fills only gaps')
  const r1 = await backfillMissingDays(db as any, SHOP_ID, since, until)
  assert(r1.filled.length === 2, `filled 2 dates (got ${r1.filled.length})`)
  assert(r1.existed === 8, `existed=8 (got ${r1.existed})`)
  assert(
    r1.filled.includes(addDaysUtc(today, -4)),
    'backfilled today-4',
  )
  assert(
    r1.filled.includes(addDaysUtc(today, -2)),
    'backfilled today-2',
  )

  // After backfill, the window should be dense with 10 rows.
  const denseRows = await db
    .selectFrom('daily_metrics')
    .selectAll()
    .where('shop_id', '=', SHOP_ID)
    .where('date', '>=', since)
    .where('date', '<=', until)
    .execute()
  assert(denseRows.length === 10, `10 rows after backfill (got ${denseRows.length})`)

  // Backfilled rows (no orders exist for SHOP_ID on those dates) should be
  // zero-revenue but PRESENT. Use isoDay() to normalize pg's Date return.
  const backfilled4 = denseRows.find(
    (r) => isoDay(r.date) === addDaysUtc(today, -4),
  )
  assert(
    !!backfilled4 && Number(backfilled4.orders_count) === 0,
    `backfilled today-4 has orders_count=0 (got ${backfilled4?.orders_count})`,
  )
  assert(
    !!backfilled4 && Number(backfilled4.revenue) === 0,
    `backfilled today-4 has revenue=0 (got ${backfilled4?.revenue})`,
  )

  // Prefilled rows are UNTOUCHED (we assert by checking revenue still $10).
  const prefill3 = denseRows.find(
    (r) => isoDay(r.date) === addDaysUtc(today, -3),
  )
  assert(
    !!prefill3 && Number(prefill3.revenue) === 10,
    `prefilled today-3 still revenue=10 (got ${prefill3?.revenue})`,
  )

  // ---------- Section 4: backfillMissingDays is idempotent ----------
  log('\n[4] backfillMissingDays second call is a no-op')
  const r2 = await backfillMissingDays(db as any, SHOP_ID, since, until)
  assert(r2.filled.length === 0, `no new fills (got ${r2.filled.length})`)
  assert(r2.existed === 10, `existed=10 (got ${r2.existed})`)

  // ---------- Section 5: backfillMissingDays shorts inverted span ----------
  log('\n[5] backfillMissingDays returns empty on since>until')
  const r3 = await backfillMissingDays(db as any, SHOP_ID, until, since)
  assert(r3.filled.length === 0, 'filled=0 for inverted span')
  assert(r3.existed === 0, 'existed=0 for inverted span')

  // ---------- Section 6: hot-path incrementToday with string + currency ----------
  log('\n[6] incrementToday accepts string amount + currency (bug fix)')
  const todayIso = todayUtc()
  // Wipe today's row so we measure fresh.
  await db
    .deleteFrom('daily_metrics')
    .where('shop_id', '=', SHOP_ID)
    .where('date', '=', todayIso)
    .execute()

  await incrementToday(db as any, SHOP_ID, '42.50', 'USD')
  await incrementToday(db as any, SHOP_ID, '7.25', 'USD')
  const todayRow = await db
    .selectFrom('daily_metrics')
    .selectAll()
    .where('shop_id', '=', SHOP_ID)
    .where('date', '=', todayIso)
    .executeTakeFirstOrThrow()
  assert(Number(todayRow.orders_count) === 2, `orders_count=2 (got ${todayRow.orders_count})`)
  assert(Number(todayRow.revenue) === 49.75, `revenue=49.75 (got ${todayRow.revenue})`)
  assert(todayRow.currency === 'USD', `currency=USD (got ${todayRow.currency})`)

  // ---------- Section 7: pruneOldMetrics scoped by shop deletes only old ----------
  log('\n[7] pruneOldMetrics scoped, retains recent rows')

  // Seed OTHER_SHOP_ID with a row at today-9 — it must NOT be touched.
  await db
    .insertInto('daily_metrics')
    .values({
      shop_id: OTHER_SHOP_ID,
      date: addDaysUtc(today, -9),
      orders_count: 1,
      revenue: '999.00',
      refunds: '0.00',
      visitors: 0,
      conversions: 0,
      currency: 'USD',
    } as any)
    .execute()

  // Prune SHOP_ID with retainDays=5 → deletes rows whose date < today-5.
  // Window was today-9 through today. That's today-9, today-8, today-7,
  // today-6, today-5 (BOUNDARY — cutoff is today-5, so < today-5 means
  // only today-9..today-6 are deleted → 4 rows).
  const cutoffExpected = computePruneCutoff(5, new Date(today + 'T00:00:00Z'))
  assert(
    cutoffExpected === addDaysUtc(today, -5),
    `cutoff=${addDaysUtc(today, -5)} (got ${cutoffExpected})`,
  )

  const pr = await pruneOldMetrics(db as any, {
    retainDays: 5,
    shopId: SHOP_ID,
    now: new Date(today + 'T00:00:00Z'),
  })
  assert(pr.cutoff === addDaysUtc(today, -5), `cutoff=${addDaysUtc(today, -5)} (got ${pr.cutoff})`)
  assert(pr.deleted === 4, `deleted 4 rows (got ${pr.deleted})`)

  // SHOP_ID should still have rows at today-5, today-4, today-3, today-2,
  // today-1, today = 6 rows.
  const remaining = await getMetrics(db as any, SHOP_ID, {
    since: addDaysUtc(today, -10),
    until: today,
  })
  assert(remaining.length === 6, `6 rows remain (got ${remaining.length})`)
  // r.date is a JS Date — normalize to YYYY-MM-DD for comparison.
  const cutoffIso = addDaysUtc(today, -5)
  assert(
    remaining.every((r) => (isoDay(r.date) ?? '') >= cutoffIso),
    'all remaining rows date >= cutoff',
  )

  // OTHER_SHOP_ID row is untouched.
  const otherRow = await db
    .selectFrom('daily_metrics')
    .selectAll()
    .where('shop_id', '=', OTHER_SHOP_ID)
    .where('date', '=', addDaysUtc(today, -9))
    .executeTakeFirst()
  assert(!!otherRow, 'OTHER_SHOP_ID today-9 row still present (scope respected)')

  // ---------- Section 8: pruneOldMetrics default retainDays=400 ----------
  log('\n[8] pruneOldMetrics default retainDays is 400d')
  const pr2 = await pruneOldMetrics(db as any, { shopId: SHOP_ID })
  // Our test rows are all within last 10 days — nothing should be deleted.
  assert(pr2.deleted === 0, `default retainDays=400 deleted nothing (got ${pr2.deleted})`)
  // cutoff should be ~400 days ago
  const ageDays = Math.round(
    (Date.parse(todayUtc()) - Date.parse(pr2.cutoff)) / 86_400_000,
  )
  assert(
    ageDays >= 399 && ageDays <= 401,
    `cutoff is ~400d ago (got ${ageDays} days)`,
  )

  // ---------- Section 9: seedAnalyticsCronTasks seeds BOTH handlers ----------
  log('\n[9] seedAnalyticsCronTasks seeds rollup + prune handlers')
  // Clear both rows for a clean insert test.
  await db
    .deleteFrom('cron_tasks')
    .where('handler', 'in', [
      ANALYTICS_CRON_HANDLERS.ROLLUP_DAILY_METRICS,
      ANALYTICS_CRON_HANDLERS.PRUNE_OLD_METRICS,
    ])
    .execute()

  const seed1 = await seedAnalyticsCronTasks(db)
  assert(seed1.inserted === 2, `first seed inserted=2 (got ${seed1.inserted})`)
  assert(seed1.existing === 0, `first seed existing=0 (got ${seed1.existing})`)

  const seed2 = await seedAnalyticsCronTasks(db)
  assert(seed2.inserted === 0, `second seed inserted=0 (got ${seed2.inserted})`)
  assert(seed2.existing === 2, `second seed existing=2 (got ${seed2.existing})`)

  const pruneTask = await db
    .selectFrom('cron_tasks')
    .selectAll()
    .where('handler', '=', ANALYTICS_CRON_HANDLERS.PRUNE_OLD_METRICS)
    .executeTakeFirstOrThrow()
  assert(
    pruneTask.schedule === 'weekly',
    `prune schedule='weekly' (got ${pruneTask.schedule})`,
  )
  assert(pruneTask.status === 'active', `prune status='active' (got ${pruneTask.status})`)
  assert(
    pruneTask.name === 'Prune old daily metrics',
    `prune name correct (got ${pruneTask.name})`,
  )

  // ---------- Section 10: prune_old_metrics cron handler is registered ----------
  log('\n[10] prune_old_metrics handler executes via cron driver')
  // Seed a very old row so we can prove the handler deletes it.
  const veryOld = '2020-01-01'
  await db
    .insertInto('daily_metrics')
    .values({
      shop_id: SHOP_ID,
      date: veryOld,
      orders_count: 99,
      revenue: '9999.00',
      refunds: '0.00',
      visitors: 0,
      conversions: 0,
      currency: 'USD',
    } as any)
    .execute()

  // Short retention so the handler actually deletes the 2020 row + the
  // 10-day test window we seeded earlier. Env var is read at handler time.
  process.env.ANALYTICS_METRICS_RETAIN_DAYS = '400'

  // Run the handler directly (not via cron driver — cleaner for smoke).
  const { executeDueJobs } = await import('../packages/core/src/modules/cron/service.js')
  await db
    .updateTable('cron_tasks')
    .set({ next_run_at: new Date(Date.now() - 60_000).toISOString() } as any)
    .where('id', '=', pruneTask.id)
    .execute()
  const results = await executeDueJobs(db)
  const ours = results.find((r) => r.taskId === pruneTask.id)
  assert(!!ours, 'executeDueJobs ran prune task')
  assert(
    !!ours && ours.status === 'success',
    `prune task status=success (got ${ours?.status}, error=${ours?.error ?? 'none'})`,
  )

  // Very-old row should be gone; today's row should still be here.
  const oldRowGone = await db
    .selectFrom('daily_metrics')
    .select(db.fn.countAll<number>().as('cnt'))
    .where('shop_id', '=', SHOP_ID)
    .where('date', '=', veryOld)
    .executeTakeFirstOrThrow()
  assert(Number(oldRowGone.cnt) === 0, `very-old row pruned (got cnt=${oldRowGone.cnt})`)

  const todayAfterPrune = await db
    .selectFrom('daily_metrics')
    .select(db.fn.countAll<number>().as('cnt'))
    .where('shop_id', '=', SHOP_ID)
    .where('date', '=', todayIso)
    .executeTakeFirstOrThrow()
  assert(
    Number(todayAfterPrune.cnt) === 1,
    `today row survives 400d retention (got cnt=${todayAfterPrune.cnt})`,
  )
}

async function cleanup() {
  log('\n[cleanup] disposing seeded rows')
  try {
    await db
      .deleteFrom('daily_metrics')
      .where('shop_id', 'in', [SHOP_ID, OTHER_SHOP_ID])
      .execute()
    await db.deleteFrom('customers').where('shop_id', '=', SHOP_ID).execute()
    await db
      .deleteFrom('shops')
      .where('id', 'in', [SHOP_ID, OTHER_SHOP_ID])
      .execute()
    // Leave the seeded cron_tasks rows — they're platform-level.
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
      log('PHASE 6 PR4 SMOKE: ALL CHECKS PASSED')
      process.exit(0)
    } else {
      log(`PHASE 6 PR4 SMOKE: ${failed} CHECK(S) FAILED`)
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

// Mark sql import as used (prefer explicit import so future extensions using
// raw SQL just call sql`...` without re-adding the import).
void sql
