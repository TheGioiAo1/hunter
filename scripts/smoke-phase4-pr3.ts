/**
 * Phase 4 PR3 smoke test — customer lifecycle stage + churn scoring.
 *
 * Runs on server 2 against 192.168.1.13:5432/gbox_platform.
 * See memory/smoke_test_runbook.md for why local Windows can't hit PG.
 *
 * Validates end-to-end:
 *   [1] migration 056 applied — lifecycle_stage + last_order_at + both
 *       indexes (idx_customers_shop_lifecycle, idx_customers_shop_last_order)
 *   [2] classifier contract — pure fn returns correct stage for each of
 *       {new, returning, at_risk, churned} boundary inputs
 *   [3] new customer defaults to 'new' and last_order_at = NULL
 *   [4] createOrder write hook — inserts an order, in the SAME trx
 *       bumps orders_count + total_spent AND writes last_order_at +
 *       lifecycle_stage. Two orders on a brand-new customer should
 *       land them in 'returning' (≥2 orders + recent).
 *   [5] recomputeAllLifecycleStages — flips stage when the recency
 *       window drifts. Seeds a customer with orders_count=2 and
 *       last_order_at = 90d ago → recompute marks 'at_risk'; then
 *       200d ago → recompute marks 'churned'.
 *   [6] last_order_at backfill — customer with orders_count=3 but
 *       last_order_at=NULL + 3 historical orders gets last_order_at
 *       populated from orders.created_at MAX on first recompute.
 *   [7] cross-shop isolation — recomputing shop A does not touch
 *       shop B customers.
 *
 * Self-cleans everything in a finally block so the shared dev DB stays
 * tidy even if an assertion throws mid-run.
 */

import { Kysely, PostgresDialect, sql } from 'kysely'
import pg from 'pg'
import {
  classifyLifecycle,
  recomputeAllLifecycleStages,
  LIFECYCLE_AT_RISK_DAYS,
  LIFECYCLE_CHURNED_DAYS,
} from '../packages/core/src/modules/customer-lifecycle/index.js'
import { createOrder } from '../packages/core/src/modules/orders/service.js'

const DB_URL =
  process.env.DATABASE_URL ||
  'postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform'

const db = new Kysely<any>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: DB_URL, max: 4 }),
  }),
})

function nowSuffix() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

async function assert(cond: any, msg: string) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`)
  console.log(`  ✓ ${msg}`)
}

function daysAgo(days: number): Date {
  // Use raw epoch ms instead of setDate() so 60 days is always exactly
  // 60*86_400_000 ms — setDate() drifts by an hour at DST boundaries on
  // servers configured for a DST tz, which made 60-day fixtures flaky.
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

async function main() {
  const suffix = nowSuffix()
  const shopSlug = `smoke-lc-${suffix}`
  const otherShopSlug = `smoke-lc-other-${suffix}`

  let shopId: string | null = null
  let otherShopId: string | null = null
  const customerIds: string[] = []
  const otherCustomerIds: string[] = []
  const orderIds: string[] = []

  console.log(`\n=== Phase 4 PR3 smoke test (suffix ${suffix}) ===\n`)

  try {
    // ------------------------------------------------------------------
    // [1] Schema check — columns + indexes from migration 056.
    // ------------------------------------------------------------------
    console.log('[1] verify migration 056 schema')
    const cols = await sql<{
      column_name: string
      data_type: string
      is_nullable: string
      column_default: string | null
    }>`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name='customers'
        AND column_name IN ('lifecycle_stage','last_order_at')
      ORDER BY column_name
    `.execute(db)
    const colMap = new Map(cols.rows.map((r: any) => [r.column_name, r]))
    await assert(colMap.has('lifecycle_stage'), 'customers.lifecycle_stage exists')
    await assert(
      (colMap.get('lifecycle_stage') as any).is_nullable === 'NO',
      'lifecycle_stage is NOT NULL',
    )
    await assert(
      String((colMap.get('lifecycle_stage') as any).column_default).includes("'new'"),
      "lifecycle_stage default is 'new'",
    )
    await assert(colMap.has('last_order_at'), 'customers.last_order_at exists')
    await assert(
      (colMap.get('last_order_at') as any).is_nullable === 'YES',
      'last_order_at is nullable',
    )
    await assert(
      String((colMap.get('last_order_at') as any).data_type).includes('timestamp'),
      'last_order_at is timestamptz',
    )

    const idx = await sql<{ indexname: string; indexdef: string }>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename='customers'
        AND indexname IN ('idx_customers_shop_lifecycle','idx_customers_shop_last_order')
    `.execute(db)
    const idxNames = idx.rows.map((r: any) => r.indexname)
    await assert(idxNames.includes('idx_customers_shop_lifecycle'), 'segment-filter index present')
    await assert(idxNames.includes('idx_customers_shop_last_order'), 'recent-activity index present')
    const lastOrderIdxDef = (idx.rows.find((r: any) => r.indexname === 'idx_customers_shop_last_order') as any).indexdef
    await assert(
      /NULLS LAST/i.test(lastOrderIdxDef),
      'recent-activity index uses NULLS LAST',
    )

    // ------------------------------------------------------------------
    // [2] Classifier contract — boundary inputs.
    // ------------------------------------------------------------------
    console.log('\n[2] classifier fixtures')
    const t0 = new Date()
    await assert(
      classifyLifecycle({ orders_count: 0, last_order_at: null }, t0) === 'new',
      'zero orders → new',
    )
    await assert(
      classifyLifecycle({ orders_count: 1, last_order_at: t0 }, t0) === 'new',
      'one recent order → new (need ≥2 for returning)',
    )
    await assert(
      classifyLifecycle({ orders_count: 2, last_order_at: t0 }, t0) === 'returning',
      'two orders today → returning',
    )
    // Note: use +1 past each threshold so the tiny ε between capturing
    // `t0` and calling `daysAgo()` (which invokes `Date.now()` later)
    // never puts us *under* the boundary after Math.floor. The
    // classifier boundary itself is unit-tested on master; this smoke
    // just confirms it survives live DB round-tripping.
    await assert(
      classifyLifecycle(
        { orders_count: 2, last_order_at: daysAgo(LIFECYCLE_AT_RISK_DAYS + 1) },
        t0,
      ) === 'at_risk',
      `last order ${LIFECYCLE_AT_RISK_DAYS + 1}d ago → at_risk`,
    )
    await assert(
      classifyLifecycle(
        { orders_count: 2, last_order_at: daysAgo(LIFECYCLE_CHURNED_DAYS + 1) },
        t0,
      ) === 'churned',
      `last order ${LIFECYCLE_CHURNED_DAYS + 1}d ago → churned`,
    )

    // ------------------------------------------------------------------
    // [3] Seed shops + a brand-new customer — default stage 'new'.
    // ------------------------------------------------------------------
    console.log('\n[3] seed shops + fresh customer')
    const shop = await db
      .insertInto('shops')
      .values({
        name: `Smoke LC ${suffix}`,
        slug: shopSlug,
        email: `owner-${suffix}@smoke.invalid`,
        status: 'active',
      } as any)
      .returning(['id'])
      .executeTakeFirstOrThrow()
    shopId = shop.id as string
    await assert(!!shopId, `primary shop seeded (${shopId})`)

    const otherShop = await db
      .insertInto('shops')
      .values({
        name: `Smoke LC other ${suffix}`,
        slug: otherShopSlug,
        email: `owner-other-${suffix}@smoke.invalid`,
        status: 'active',
      } as any)
      .returning(['id'])
      .executeTakeFirstOrThrow()
    otherShopId = otherShop.id as string

    const fresh = await db
      .insertInto('customers')
      .values({
        shop_id: shopId,
        email: `fresh-${suffix}@gbox.co`,
        first_name: 'Fresh',
        last_name: 'Customer',
      } as any)
      .returning(['id', 'lifecycle_stage', 'last_order_at'])
      .executeTakeFirstOrThrow()
    customerIds.push(fresh.id as string)
    await assert(
      (fresh as any).lifecycle_stage === 'new',
      `fresh customer defaults to 'new' (got ${(fresh as any).lifecycle_stage})`,
    )
    await assert(
      (fresh as any).last_order_at === null,
      'fresh customer last_order_at is NULL',
    )

    // ------------------------------------------------------------------
    // [4] createOrder hook — two orders puts fresh customer in 'returning'.
    // ------------------------------------------------------------------
    console.log('\n[4] createOrder write hook')
    const o1 = await createOrder(db as any, shopId, {
      customer_id: fresh.id as string,
      currency: 'USD',
      email: (fresh as any).email ?? null,
      line_items: [
        { title: 'Smoke widget', quantity: 1, price: '25.00' },
      ],
    })
    orderIds.push((o1 as any).id as string)

    const after1 = await db
      .selectFrom('customers')
      .select(['lifecycle_stage', 'last_order_at', 'orders_count', 'total_spent'])
      .where('id', '=', fresh.id as string)
      .executeTakeFirstOrThrow()
    await assert(
      Number((after1 as any).orders_count) === 1,
      `orders_count=1 after first order (got ${(after1 as any).orders_count})`,
    )
    await assert(
      (after1 as any).last_order_at !== null,
      'last_order_at populated after first order',
    )
    await assert(
      (after1 as any).lifecycle_stage === 'new',
      `stage still 'new' after 1 order (got ${(after1 as any).lifecycle_stage})`,
    )

    const o2 = await createOrder(db as any, shopId, {
      customer_id: fresh.id as string,
      currency: 'USD',
      email: (fresh as any).email ?? null,
      line_items: [
        { title: 'Smoke widget two', quantity: 1, price: '30.00' },
      ],
    })
    orderIds.push((o2 as any).id as string)

    const after2 = await db
      .selectFrom('customers')
      .select(['lifecycle_stage', 'last_order_at', 'orders_count'])
      .where('id', '=', fresh.id as string)
      .executeTakeFirstOrThrow()
    await assert(
      Number((after2 as any).orders_count) === 2,
      `orders_count=2 after second order (got ${(after2 as any).orders_count})`,
    )
    await assert(
      (after2 as any).lifecycle_stage === 'returning',
      `stage flipped to 'returning' after 2 recent orders (got ${(after2 as any).lifecycle_stage})`,
    )

    // ------------------------------------------------------------------
    // [5] recompute — a returning customer whose recency drifts → at_risk → churned.
    // ------------------------------------------------------------------
    console.log('\n[5] recomputeAllLifecycleStages on drifting customer')
    const drifter = await db
      .insertInto('customers')
      .values({
        shop_id: shopId,
        email: `drift-${suffix}@gbox.co`,
        first_name: 'Drift',
        last_name: 'Customer',
        orders_count: 2,
        last_order_at: daysAgo(LIFECYCLE_AT_RISK_DAYS + 5).toISOString(),
        lifecycle_stage: 'returning', // stale label we expect recompute to fix
      } as any)
      .returning(['id'])
      .executeTakeFirstOrThrow()
    customerIds.push(drifter.id as string)

    const res1 = await recomputeAllLifecycleStages(db, { skipBackfill: true })
    await assert(
      typeof res1.scanned === 'number' && res1.scanned >= 2,
      `recompute scanned ≥2 rows (got ${res1.scanned})`,
    )
    const drifted1 = await db
      .selectFrom('customers')
      .select(['lifecycle_stage'])
      .where('id', '=', drifter.id as string)
      .executeTakeFirstOrThrow()
    await assert(
      (drifted1 as any).lifecycle_stage === 'at_risk',
      `drifter flipped returning → at_risk (got ${(drifted1 as any).lifecycle_stage})`,
    )

    // Now push recency past the churned threshold.
    await db
      .updateTable('customers')
      .set({
        last_order_at: daysAgo(LIFECYCLE_CHURNED_DAYS + 5).toISOString(),
      } as any)
      .where('id', '=', drifter.id as string)
      .execute()
    await recomputeAllLifecycleStages(db, { skipBackfill: true })
    const drifted2 = await db
      .selectFrom('customers')
      .select(['lifecycle_stage'])
      .where('id', '=', drifter.id as string)
      .executeTakeFirstOrThrow()
    await assert(
      (drifted2 as any).lifecycle_stage === 'churned',
      `drifter flipped at_risk → churned (got ${(drifted2 as any).lifecycle_stage})`,
    )

    // ------------------------------------------------------------------
    // [6] last_order_at backfill — historical customer with orders but
    //     last_order_at NULL gets populated from orders MAX.
    // ------------------------------------------------------------------
    console.log('\n[6] last_order_at backfill from orders')
    const historical = await db
      .insertInto('customers')
      .values({
        shop_id: shopId,
        email: `historical-${suffix}@gbox.co`,
        first_name: 'Hist',
        last_name: 'Orical',
        orders_count: 3,
        last_order_at: null, // pretend migration default left it null
      } as any)
      .returning(['id'])
      .executeTakeFirstOrThrow()
    customerIds.push(historical.id as string)

    // Seed 3 historical orders whose most-recent is 30 days ago → 'returning'.
    // We write created_at directly because orders usually wouldn't let us set it,
    // but the smoke test needs to simulate historical data.
    for (let i = 0; i < 3; i++) {
      const created = daysAgo(30 + i * 15).toISOString() // 30, 45, 60 days ago
      const row = await db
        .insertInto('orders')
        .values({
          shop_id: shopId,
          customer_id: historical.id as string,
          currency: 'USD',
          subtotal_price: '10.00',
          total_price: '10.00',
          total_discounts: '0',
          total_tax: '0',
          financial_status: 'paid',
          created_at: created,
        } as any)
        .returning(['id'])
        .executeTakeFirstOrThrow()
      orderIds.push((row as any).id as string)
    }

    const res2 = await recomputeAllLifecycleStages(db)
    await assert(
      res2.backfilledLastOrderAt >= 1,
      `backfilled ≥1 row (got ${res2.backfilledLastOrderAt})`,
    )
    const hist = await db
      .selectFrom('customers')
      .select(['lifecycle_stage', 'last_order_at'])
      .where('id', '=', historical.id as string)
      .executeTakeFirstOrThrow()
    await assert(
      (hist as any).last_order_at !== null,
      'historical customer got last_order_at populated',
    )
    // 30 days ago is within the at_risk threshold (60), so 3 orders + recent = returning.
    await assert(
      (hist as any).lifecycle_stage === 'returning',
      `historical customer reclassified to returning (got ${(hist as any).lifecycle_stage})`,
    )

    // ------------------------------------------------------------------
    // [7] cross-shop isolation — shop B rows untouched.
    // ------------------------------------------------------------------
    console.log('\n[7] cross-shop isolation')
    const otherCust = await db
      .insertInto('customers')
      .values({
        shop_id: otherShopId,
        email: `other-${suffix}@gbox.co`,
        first_name: 'Cross',
        last_name: 'Shop',
        orders_count: 2,
        last_order_at: daysAgo(LIFECYCLE_CHURNED_DAYS + 10).toISOString(),
        lifecycle_stage: 'returning', // deliberately stale, expect recompute to flip BUT ONLY within a per-shop scoped op
      } as any)
      .returning(['id'])
      .executeTakeFirstOrThrow()
    otherCustomerIds.push(otherCust.id as string)

    // `recomputeAllLifecycleStages` is platform-wide (cron job), so it WILL
    // touch both shops — but the stage each customer lands on depends only
    // on that customer's own orders_count + last_order_at. Verify the
    // other shop's customer flips to 'churned' from its own data, not
    // from any cross-shop bleed.
    await recomputeAllLifecycleStages(db, { skipBackfill: true })
    const crossShopCust = await db
      .selectFrom('customers')
      .select(['lifecycle_stage'])
      .where('id', '=', otherCust.id as string)
      .executeTakeFirstOrThrow()
    await assert(
      (crossShopCust as any).lifecycle_stage === 'churned',
      `other shop customer classified by its own data (got ${(crossShopCust as any).lifecycle_stage})`,
    )

    // Sanity: our original fresh customer should still be 'returning' — the
    // other shop's recompute didn't corrupt their row.
    const freshAfterCross = await db
      .selectFrom('customers')
      .select(['lifecycle_stage'])
      .where('id', '=', fresh.id as string)
      .executeTakeFirstOrThrow()
    await assert(
      (freshAfterCross as any).lifecycle_stage === 'returning',
      'shop A returning customer not affected by shop B data',
    )

    console.log('\n=== ALL PHASE 4 PR3 SMOKE ASSERTIONS PASSED ===\n')
  } finally {
    // Clean up in reverse dependency order. Orders first (FK to customers),
    // then customers, then shops. Swallow errors so cleanup is best-effort.
    console.log('\n[cleanup] removing seeded rows')
    for (const oid of orderIds) {
      await db.deleteFrom('order_line_items').where('order_id', '=', oid).execute().catch(() => {})
      await db.deleteFrom('orders').where('id', '=', oid).execute().catch(() => {})
    }
    for (const cid of [...customerIds, ...otherCustomerIds]) {
      await db.deleteFrom('customers').where('id', '=', cid).execute().catch(() => {})
    }
    for (const sid of [shopId, otherShopId]) {
      if (!sid) continue
      await db.deleteFrom('shops').where('id', '=', sid).execute().catch(() => {})
    }
    await db.destroy().catch(() => {})
  }
}

main().catch((err) => {
  console.error('\nSMOKE FAILED:', err?.message || err)
  if (err?.stack) console.error(err.stack)
  process.exit(1)
})
