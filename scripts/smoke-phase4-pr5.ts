/**
 * Phase 4 PR5 — Customer bulk-action + quick-filter live smoke.
 *
 * Proves two things against the real Postgres on server 2:
 *
 *   1. `applyBulkAction` drives Postgres text[] ops the way the unit
 *      tests pin at the source level — union adds, diff removes, no
 *      duplicates, no check-constraint violations on `status`.
 *
 *   2. The quick-filter CRUD persists through migration 057 with
 *      shop-scoped position bookkeeping, upsert-on-name, and clean
 *      normalisation of `filter_json`.
 *
 * Uses a disposable shop (fresh uuid) so nothing touches real data.
 * Rolls back even on partial failure via try/finally cleanup.
 *
 * Run on server 2:
 *   DATABASE_URL=postgresql://gbox:PASS@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase4-pr5.ts
 */

import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  applyBulkAction,
  type BulkAction,
} from '../packages/core/src/modules/customers/bulk/index.js'
import {
  listQuickFilters,
  getQuickFilter,
  saveQuickFilter,
  deleteQuickFilter,
  reorderQuickFilters,
  normalizeQuickFilterQuery,
  queryToParams,
  paramsToQuery,
} from '../packages/core/src/modules/customers/quick-filters/index.js'

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SHOP_ID = randomUUID()
const SHOP_SLUG_SUFFIX = Date.now()

function log(s: string) {
  // eslint-disable-next-line no-console
  console.log(s)
}

async function main() {
  log(`\n=== Phase 4 PR5 smoke — shop_id=${SHOP_ID} ===\n`)
  let failed = 0
  const assert = (cond: boolean, msg: string) => {
    if (cond) log(`  OK  ${msg}`)
    else {
      failed++
      log(`  FAIL ${msg}`)
    }
  }

  // Disposable shop. Same pattern as PR4 smoke — `email` is NOT NULL
  // in the live schema, so we always include one.
  await db
    .insertInto('shops')
    .values({
      id: SHOP_ID,
      slug: `smoke-pr5-${SHOP_SLUG_SUFFIX}`,
      name: 'PR5 smoke shop',
      email: `smoke-pr5-${SHOP_SLUG_SUFFIX}@example.test`,
    } as any)
    .execute()

  try {
    // ---------- Section 1: seed 4 customers ----------
    log('\n[1] Seeding customers')
    const cust1 = randomUUID()
    const cust2 = randomUUID()
    const cust3 = randomUUID()
    const cust4 = randomUUID()
    const foreign = randomUUID() // belongs to no shop — tests cross-shop skip

    for (const [id, email, lifecycle] of [
      [cust1, `ada+${SHOP_SLUG_SUFFIX}@example.test`, 'new'],
      [cust2, `grace+${SHOP_SLUG_SUFFIX}@example.test`, 'returning'],
      [cust3, `linus+${SHOP_SLUG_SUFFIX}@example.test`, 'at_risk'],
      [cust4, `bjarne+${SHOP_SLUG_SUFFIX}@example.test`, 'churned'],
    ] as const) {
      await db
        .insertInto('customers')
        .values({
          id,
          shop_id: SHOP_ID,
          email,
          status: 'active',
          accepts_marketing: false,
          lifecycle_stage: lifecycle,
          tags: ['seed'],
        } as any)
        .execute()
    }
    log('  seeded 4 customers')

    // ---------- Section 2: add_tags is idempotent and scoped ----------
    log('\n[2] add_tags union semantics')
    let result = await applyBulkAction(
      db,
      SHOP_ID,
      [cust1, cust2, foreign],
      { type: 'add_tags', tags: ['vip', 'wholesale'] } satisfies BulkAction,
    )
    assert(result.matched === 2, 'matched 2 (foreign id dropped)')
    assert(result.skipped === 1, 'skipped 1 (foreign id counted)')
    assert(result.affected === 2, 'affected 2')

    // Re-adding an already-present tag must be a no-op at the array
    // level (no duplicates).
    await applyBulkAction(db, SHOP_ID, [cust1], {
      type: 'add_tags',
      tags: ['vip'],
    })
    const cust1Row = await db
      .selectFrom('customers')
      .select(['tags'])
      .where('id', '=', cust1)
      .executeTakeFirstOrThrow()
    const tags1 = (cust1Row.tags as unknown as string[]) ?? []
    assert(
      tags1.includes('vip') && tags1.includes('wholesale') && tags1.includes('seed'),
      'cust1 tags union includes seed+vip+wholesale',
    )
    assert(
      tags1.filter((t) => t === 'vip').length === 1,
      'cust1 tags has NO duplicate vip (array_agg DISTINCT)',
    )

    // ---------- Section 3: remove_tags difference ----------
    log('\n[3] remove_tags difference semantics')
    result = await applyBulkAction(db, SHOP_ID, [cust1, cust2], {
      type: 'remove_tags',
      tags: ['wholesale', 'notpresent'],
    })
    assert(result.affected === 2, 'remove_tags affected 2')

    const cust1AfterRemove = await db
      .selectFrom('customers')
      .select(['tags'])
      .where('id', '=', cust1)
      .executeTakeFirstOrThrow()
    const tags1AfterRemove = (cust1AfterRemove.tags as unknown as string[]) ?? []
    assert(
      !tags1AfterRemove.includes('wholesale'),
      'wholesale removed from cust1',
    )
    assert(
      tags1AfterRemove.includes('vip'),
      'vip still present (only targeted tags removed)',
    )

    // ---------- Section 4: set_lifecycle write ----------
    log('\n[4] set_lifecycle writes the stage string')
    result = await applyBulkAction(db, SHOP_ID, [cust1, cust2, cust3], {
      type: 'set_lifecycle',
      stage: 'churned',
    })
    assert(result.affected === 3, 'set_lifecycle affected 3')

    const lifecycles = await db
      .selectFrom('customers')
      .select(['id', 'lifecycle_stage'])
      .where('shop_id', '=', SHOP_ID)
      .where('id', 'in', [cust1, cust2, cust3])
      .execute()
    assert(
      lifecycles.every((r: any) => r.lifecycle_stage === 'churned'),
      'all 3 customers now lifecycle_stage=churned',
    )

    // ---------- Section 5: subscribe_marketing / unsubscribe_marketing ----------
    log('\n[5] marketing toggle')
    await applyBulkAction(db, SHOP_ID, [cust1, cust2], {
      type: 'subscribe_marketing',
    })
    const subRows = await db
      .selectFrom('customers')
      .select(['id', 'accepts_marketing'])
      .where('shop_id', '=', SHOP_ID)
      .where('id', 'in', [cust1, cust2])
      .execute()
    assert(
      subRows.every((r: any) => r.accepts_marketing === true),
      'both customers accepts_marketing=true after subscribe',
    )

    await applyBulkAction(db, SHOP_ID, [cust1], { type: 'unsubscribe_marketing' })
    const unsubRow = await db
      .selectFrom('customers')
      .select(['accepts_marketing'])
      .where('id', '=', cust1)
      .executeTakeFirstOrThrow()
    assert(
      (unsubRow as any).accepts_marketing === false,
      'cust1 accepts_marketing=false after unsubscribe',
    )

    // ---------- Section 6: enable/disable writes ACTIVE not 'enabled' ----------
    log('\n[6] enable writes status=active (check-constraint safe)')
    await applyBulkAction(db, SHOP_ID, [cust3], { type: 'disable' })
    const disabledRow = await db
      .selectFrom('customers')
      .select(['status'])
      .where('id', '=', cust3)
      .executeTakeFirstOrThrow()
    assert((disabledRow as any).status === 'disabled', 'cust3 status=disabled')

    // enable should normalise to 'active' — the latent bug was writing
    // 'enabled' which violates the customers_status_check constraint.
    await applyBulkAction(db, SHOP_ID, [cust3], { type: 'enable' })
    const enabledRow = await db
      .selectFrom('customers')
      .select(['status'])
      .where('id', '=', cust3)
      .executeTakeFirstOrThrow()
    assert(
      (enabledRow as any).status === 'active',
      'cust3 status=active (NOT "enabled")',
    )

    // ---------- Section 7: cross-shop defense ----------
    log('\n[7] cross-shop ids are silently dropped')
    // Create a foreign shop + customer so we can prove the engine won't
    // touch it even when we pass its id.
    const FOREIGN_SHOP = randomUUID()
    const FOREIGN_CUST = randomUUID()
    await db
      .insertInto('shops')
      .values({
        id: FOREIGN_SHOP,
        slug: `smoke-pr5-foreign-${SHOP_SLUG_SUFFIX}`,
        name: 'Foreign',
        email: `foreign-${SHOP_SLUG_SUFFIX}@example.test`,
      } as any)
      .execute()
    await db
      .insertInto('customers')
      .values({
        id: FOREIGN_CUST,
        shop_id: FOREIGN_SHOP,
        email: `foreign-cust-${SHOP_SLUG_SUFFIX}@example.test`,
        status: 'active',
        tags: ['foreign'],
      } as any)
      .execute()

    const cross = await applyBulkAction(db, SHOP_ID, [FOREIGN_CUST], {
      type: 'disable',
    })
    assert(cross.affected === 0, 'cross-shop disable: 0 affected')
    assert(cross.skipped === 1, 'cross-shop disable: 1 skipped')

    const foreignRow = await db
      .selectFrom('customers')
      .select(['status'])
      .where('id', '=', FOREIGN_CUST)
      .executeTakeFirstOrThrow()
    assert(
      (foreignRow as any).status === 'active',
      'foreign customer still status=active (shop_id defense held)',
    )

    // Cleanup foreign fixtures now (not in the finally block so the
    // main cleanup only handles the PR-5 shop).
    await db.deleteFrom('customers').where('shop_id', '=', FOREIGN_SHOP).execute()
    await db.deleteFrom('shops').where('id', '=', FOREIGN_SHOP).execute()

    // ---------- Section 8: empty/dedupe behaviour ----------
    log('\n[8] empty + dedupe short-circuits')
    const empty = await applyBulkAction(db, SHOP_ID, [], { type: 'disable' })
    assert(
      empty.affected === 0 && empty.skipped === 0 && empty.matched === 0,
      'empty ids → {0,0,0}',
    )

    const dup = await applyBulkAction(db, SHOP_ID, [cust1, cust1, '', cust2], {
      type: 'enable',
    })
    assert(dup.matched === 2, 'dedupe: matched 2 from [cust1, cust1, "", cust2]')

    // ---------- Section 9: quick-filter create + list ----------
    log('\n[9] quick-filter create + list')
    const vip = await saveQuickFilter(db, SHOP_ID, {
      name: 'VIPs',
      query: { tag: 'vip', marketing: 'yes' },
    })
    assert(vip.name === 'VIPs', 'pill saved with normalised name')
    assert(vip.position === 0, 'first pill gets position 0')
    assert(
      vip.filter_json.tag === 'vip' && vip.filter_json.marketing === 'yes',
      'filter_json normalised',
    )

    const churned = await saveQuickFilter(db, SHOP_ID, {
      name: 'Churned',
      query: { lifecycle: 'churned' },
    })
    assert(churned.position === 1, 'second pill gets position 1')

    const atRisk = await saveQuickFilter(db, SHOP_ID, {
      name: 'At risk',
      query: { lifecycle: 'at_risk' },
    })
    assert(atRisk.position === 2, 'third pill gets position 2 (max+1)')

    const pills = await listQuickFilters(db, SHOP_ID)
    assert(pills.length === 3, 'listQuickFilters returns 3 rows')
    assert(
      pills[0]!.name === 'VIPs' &&
        pills[1]!.name === 'Churned' &&
        pills[2]!.name === 'At risk',
      'pills ordered by position asc',
    )

    // ---------- Section 10: upsert-on-name ----------
    log('\n[10] upsert by (shop_id, name) replaces the existing row')
    const vipV2 = await saveQuickFilter(db, SHOP_ID, {
      name: 'VIPs',
      query: { tag: 'vip-gold', marketing: 'yes' },
    })
    assert(vipV2.id === vip.id, 'upsert returns same id (no duplicate row)')
    assert(
      vipV2.filter_json.tag === 'vip-gold',
      'query payload updated in place',
    )

    const pillsAfterUpsert = await listQuickFilters(db, SHOP_ID)
    assert(
      pillsAfterUpsert.length === 3,
      'upsert did NOT create a second row',
    )

    // ---------- Section 11: getQuickFilter cross-shop fail-closed ----------
    log('\n[11] getQuickFilter is shop-scoped (fail-closed)')
    const otherShopRead = await getQuickFilter(db, randomUUID(), vip.id)
    assert(otherShopRead === null, 'cross-shop read returns null')
    const mineRead = await getQuickFilter(db, SHOP_ID, vip.id)
    assert(mineRead?.id === vip.id, 'same-shop read returns the row')

    // ---------- Section 12: reorderQuickFilters ----------
    log('\n[12] reorderQuickFilters renumbers 0..N-1')
    await reorderQuickFilters(db, SHOP_ID, [atRisk.id, vip.id, churned.id])
    const reordered = await listQuickFilters(db, SHOP_ID)
    assert(
      reordered[0]!.id === atRisk.id &&
        reordered[1]!.id === vip.id &&
        reordered[2]!.id === churned.id,
      'reorder applied: At risk -> VIPs -> Churned',
    )
    assert(
      reordered[0]!.position === 0 &&
        reordered[1]!.position === 1 &&
        reordered[2]!.position === 2,
      'positions renumbered contiguously',
    )

    // ---------- Section 13: deleteQuickFilter ----------
    log('\n[13] deleteQuickFilter hit vs miss')
    const removedOk = await deleteQuickFilter(db, SHOP_ID, churned.id)
    assert(removedOk === true, 'delete existing pill -> true')
    const removedMiss = await deleteQuickFilter(db, SHOP_ID, randomUUID())
    assert(removedMiss === false, 'delete unknown id -> false')
    const removedCrossShop = await deleteQuickFilter(db, randomUUID(), vip.id)
    assert(removedCrossShop === false, 'cross-shop delete -> false')

    const finalPills = await listQuickFilters(db, SHOP_ID)
    assert(finalPills.length === 2, 'two pills remain after one delete')

    // ---------- Section 14: helpers (round-trip) ----------
    log('\n[14] normalize + queryToParams/paramsToQuery round-trip')
    const input = {
      q: ' ada ',
      lifecycle: 'churned',
      marketing: 'yes',
      tag: ' vip ',
      status: 'active',
      foo: 'drop me',
    }
    const n = normalizeQuickFilterQuery(input)
    assert(n.q === 'ada', 'normalize trims q')
    assert(!('foo' in n), 'normalize drops unknown keys')
    const paramStr = queryToParams(n)
    assert(paramStr.includes('q=ada'), 'queryToParams emits q=ada')
    assert(paramStr.includes('lifecycle=churned'), 'queryToParams emits lifecycle')
    const parsed = paramsToQuery(Object.fromEntries(new URLSearchParams(paramStr)))
    assert(parsed.q === 'ada' && parsed.lifecycle === 'churned', 'round-trip ok')
  } finally {
    log('\n[cleanup] removing smoke fixtures')
    // Delete the quick filters BEFORE the shop (FK cascades anyway but
    // this keeps log lines tidy).
    await db
      .deleteFrom('customer_quick_filters')
      .where('shop_id', '=', SHOP_ID)
      .execute()
      .catch(() => {})
    await db
      .deleteFrom('customers')
      .where('shop_id', '=', SHOP_ID)
      .execute()
      .catch(() => {})
    await db.deleteFrom('shops').where('id', '=', SHOP_ID).execute().catch(() => {})
    await db.destroy()
    log(`\n=== smoke done — ${failed} assertion${failed === 1 ? '' : 's'} failed ===\n`)
    process.exit(failed === 0 ? 0 : 1)
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[smoke fatal]', err)
  process.exit(1)
})
