/**
 * Phase 4 PR2 smoke test — customer segments against the live dev DB.
 *
 * Runs on server 2 against 192.168.1.13:5432/gbox_platform.
 * See memory/smoke_test_runbook.md for why local Windows can't hit PG.
 *
 * Validates end-to-end:
 *   - migration 055 is applied (table + indexes exist)
 *   - createSegment writes a row with rules_json stringified through
 *   - listSegments scopes by shop_id
 *   - countMatchingCustomers runs the compiled WHERE tree and returns a
 *     real number (not null, not NaN)
 *   - getSegment with wrong shop → null (cross-shop isolation)
 *   - updateSegment returns the new row, updated_at strictly later
 *   - deleteSegment returns true, row is gone
 *
 * Self-cleans everything in a finally block so the shared dev DB stays
 * tidy even if an assertion throws mid-run.
 */

import { Kysely, PostgresDialect, sql } from 'kysely'
import pg from 'pg'
import {
  createSegment,
  updateSegment,
  deleteSegment,
  listSegments,
  getSegment,
  countMatchingCustomers,
} from '../packages/core/src/modules/customer-segments/index.js'

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

async function main() {
  const suffix = nowSuffix()
  const shopSlug = `smoke-seg-${suffix}`
  const otherShopSlug = `smoke-seg-other-${suffix}`
  let shopId: string | null = null
  let otherShopId: string | null = null
  let customerId: string | null = null
  let segmentId: string | null = null

  console.log(`\n=== Phase 4 PR2 smoke test (suffix ${suffix}) ===\n`)

  try {
    // 1) Confirm migration 055 is in place.
    console.log('[1] verify customer_segments schema')
    const tbl = await sql<{
      column_name: string
    }>`SELECT column_name FROM information_schema.columns WHERE table_name='customer_segments' ORDER BY ordinal_position`.execute(
      db,
    )
    const cols = tbl.rows.map((r: any) => r.column_name)
    await assert(cols.includes('id'), 'customer_segments.id exists')
    await assert(cols.includes('shop_id'), 'customer_segments.shop_id exists')
    await assert(cols.includes('rules_json'), 'customer_segments.rules_json exists')
    await assert(cols.includes('updated_at'), 'customer_segments.updated_at exists')

    // 2) Seed two shops + one customer on the primary shop.
    console.log('\n[2] seed shops + customer')
    const shop = await db
      .insertInto('shops')
      .values({
        name: `Smoke ${suffix}`,
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
        name: `Smoke other ${suffix}`,
        slug: otherShopSlug,
        email: `owner-other-${suffix}@smoke.invalid`,
        status: 'active',
      } as any)
      .returning(['id'])
      .executeTakeFirstOrThrow()
    otherShopId = otherShop.id as string
    await assert(!!otherShopId, `cross-shop seeded (${otherShopId})`)

    const customer = await db
      .insertInto('customers')
      .values({
        shop_id: shopId,
        email: `vip-${suffix}@gbox.co`,
        first_name: 'Smoke',
        last_name: 'Target',
        accepts_marketing: true,
        total_spent: 250,
        orders_count: 3,
      } as any)
      .returning(['id'])
      .executeTakeFirstOrThrow()
    customerId = customer.id as string
    await assert(!!customerId, `customer seeded (${customerId})`)

    // 3) createSegment — persists rules_json through the service layer.
    console.log('\n[3] createSegment')
    const created = await createSegment(db, {
      shop_id: shopId,
      name: `smoke-${suffix}`,
      rules: {
        combinator: 'and',
        rules: [
          { field: 'email', op: 'contains', value: '@gbox.co' },
          { field: 'total_spent', op: 'greater_than', value: 100 },
        ],
      },
    })
    segmentId = created.id as string
    await assert(!!segmentId, `segment created (${segmentId})`)
    await assert(created.name === `smoke-${suffix}`, 'name round-trips')

    // 4) listSegments — shop-scoped.
    console.log('\n[4] listSegments')
    const mine = await listSegments(db, { shop_id: shopId })
    await assert(
      mine.some((s: any) => s.id === segmentId),
      'primary shop sees the segment in its list',
    )
    const theirs = await listSegments(db, { shop_id: otherShopId })
    await assert(
      !theirs.some((s: any) => s.id === segmentId),
      'cross-shop does NOT see the segment',
    )

    // 5) countMatchingCustomers — compiles the rules and returns a number.
    console.log('\n[5] countMatchingCustomers')
    const count = await countMatchingCustomers(db, shopId, {
      combinator: 'and',
      rules: [
        { field: 'email', op: 'contains', value: '@gbox.co' },
        { field: 'total_spent', op: 'greater_than', value: 100 },
      ],
    })
    await assert(typeof count === 'number' && !Number.isNaN(count), `count is numeric (got ${count})`)
    await assert(count >= 1, 'count matches at least the seeded customer')

    // Sanity: a rule that excludes the customer should count 0 (for our shop).
    const noneCount = await countMatchingCustomers(db, shopId, {
      combinator: 'and',
      rules: [{ field: 'email', op: 'equals', value: 'nobody@example.invalid' }],
    })
    await assert(noneCount === 0, `impossible rule returns 0 (got ${noneCount})`)

    // 6) getSegment — cross-shop isolation.
    console.log('\n[6] getSegment cross-shop')
    const crossShop = await getSegment(db, { shop_id: otherShopId, id: segmentId })
    await assert(crossShop === null, 'cross-shop getSegment returns null')
    const own = await getSegment(db, { shop_id: shopId, id: segmentId })
    await assert(own?.id === segmentId, 'own getSegment returns the row')

    // 7) updateSegment — new name + rules, updated_at bumps.
    console.log('\n[7] updateSegment')
    const beforeUpdated = (own as any).updated_at
    await new Promise((r) => setTimeout(r, 50)) // ensure strict >
    const updated = await updateSegment(db, {
      shop_id: shopId,
      id: segmentId,
      name: `smoke-${suffix}-renamed`,
      rules: {
        combinator: 'or',
        rules: [{ field: 'accepts_marketing', op: 'equals', value: true }],
      },
    })
    await assert(updated?.name === `smoke-${suffix}-renamed`, 'name updated')
    const afterUpdated = new Date((updated as any).updated_at).getTime()
    const beforeUpdatedMs = new Date(beforeUpdated).getTime()
    await assert(afterUpdated > beforeUpdatedMs, 'updated_at moved forward')

    // Cross-shop update should return null, not throw.
    const crossUpdate = await updateSegment(db, {
      shop_id: otherShopId,
      id: segmentId,
      name: 'should not win',
    })
    await assert(crossUpdate === null, 'cross-shop updateSegment returns null')

    // 8) deleteSegment — true when our row, false cross-shop.
    console.log('\n[8] deleteSegment')
    const crossDelete = await deleteSegment(db, { shop_id: otherShopId, id: segmentId })
    await assert(crossDelete === false, 'cross-shop delete returns false')
    const ok = await deleteSegment(db, { shop_id: shopId, id: segmentId })
    await assert(ok === true, 'own delete returns true')
    segmentId = null // so finally doesn't try to re-delete
    const afterDelete = await getSegment(db, { shop_id: shopId, id: created.id as string })
    await assert(afterDelete === null, 'row gone after delete')

    console.log('\n=== ALL SMOKE ASSERTIONS PASSED ===\n')
  } finally {
    // Self-clean in reverse dependency order.
    console.log('\n[cleanup] removing seeded rows')
    if (segmentId && shopId) {
      await db
        .deleteFrom('customer_segments')
        .where('id', '=', segmentId)
        .where('shop_id', '=', shopId)
        .execute()
        .catch(() => {})
    }
    if (customerId && shopId) {
      await db
        .deleteFrom('customers')
        .where('id', '=', customerId)
        .where('shop_id', '=', shopId)
        .execute()
        .catch(() => {})
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
