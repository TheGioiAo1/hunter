/**
 * Phase 7 PR2 — Navigation nested menus + reorder + resource picker smoke.
 *
 * Exercises the navigation service module against real Postgres:
 *
 *   1.  buildTree nests parent → child → grandchild (3 levels).
 *   2.  listMenuItemsTree assembles DB rows into a tree in one call.
 *   3.  listMenuItemsTree is shop-scoped (foreign shop returns empty).
 *   4.  reorderMenuItems repositions siblings under the same parent.
 *   5.  reorderMenuItems re-parents (top-level → child of sibling).
 *   6.  reorderMenuItems rejects cycle (child → its own parent).
 *   7.  reorderMenuItems rejects depth > MAX_MENU_DEPTH.
 *   8.  reorderMenuItems counts skipped_over_depth separately from updated.
 *   9.  reorderMenuItems silently drops ids from a foreign menu/shop.
 *  10.  searchResources fan-out finds products + collections + pages + blog.
 *  11.  searchResources respects types filter (single-table narrow).
 *  12.  searchResources respects shop scope (other shop's rows invisible).
 *  13.  searchResources ILIKE case-insensitive match.
 *  14.  searchResources empty q returns recent rows.
 *  15.  resolveResourceUrl → product returns /products/<slug>.
 *  16.  resolveResourceUrl → collection returns /collections/<slug>.
 *  17.  resolveResourceUrl → page returns /pages/<slug>.
 *  18.  resolveResourceUrl → blog_post returns /blog/<slug>.
 *  19.  resolveResourceUrl → missing row returns null.
 *  20.  resolveResourceUrl is shop-scoped.
 *  21.  buildTree truncates at MAX_MENU_DEPTH (L3+ collapsed).
 *
 * Rolls back all seeded rows in finally{} so re-running is safe.
 *
 * Run on server 2:
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase7-pr2.ts
 */

import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  listMenuItemsTree,
  reorderMenuItems,
  searchResources,
  resolveResourceUrl,
  MAX_MENU_DEPTH,
  buildTree,
} from '../packages/core/src/modules/navigation/service.js'

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_A = randomUUID()
const SHOP_B = randomUUID()

// Menu ids (we pre-generate so we can cross-ref before insert returns).
const MENU_A_MAIN = randomUUID()
const MENU_A_FOOTER = randomUUID()
const MENU_B_MAIN = randomUUID()

// Item ids under MENU_A_MAIN — we build a 3-level tree by hand.
const ROOT1 = randomUUID()
const ROOT2 = randomUUID()
const ROOT3 = randomUUID()
const CHILD_A = randomUUID()
const CHILD_B = randomUUID()
const GRAND_A = randomUUID()

// Item under MENU_A_FOOTER (cross-menu check).
const FOOTER_ITEM = randomUUID()
// Item under MENU_B_MAIN (cross-shop check).
const SHOP_B_ITEM = randomUUID()

// Resource ids for picker tests.
const PROD_A = randomUUID()
const PROD_B = randomUUID()
const COLL_A = randomUUID()
const PAGE_A = randomUUID()
const BLOG_A = randomUUID()
const PROD_FOREIGN = randomUUID() // belongs to SHOP_B

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

async function main() {
  log(`\n=== Phase 7 PR2 smoke — suffix=${SUFFIX} ===\n`)

  // ---------- Section 0: seed shops + menus + items + resources ----------
  log('[0] Seeding shops A + B with menus, items, resources')
  await (db as any)
    .insertInto('shops')
    .values([
      {
        id: SHOP_A,
        slug: `smoke-p7-2-a-${SUFFIX}`,
        name: 'PR2 Shop A',
        email: `a-${SUFFIX}@example.test`,
        status: 'active',
      },
      {
        id: SHOP_B,
        slug: `smoke-p7-2-b-${SUFFIX}`,
        name: 'PR2 Shop B',
        email: `b-${SUFFIX}@example.test`,
        status: 'active',
      },
    ])
    .execute()

  await (db as any)
    .insertInto('menus')
    .values([
      {
        id: MENU_A_MAIN,
        shop_id: SHOP_A,
        title: 'Main',
        slug: 'main-menu',
      },
      {
        id: MENU_A_FOOTER,
        shop_id: SHOP_A,
        title: 'Footer',
        slug: 'footer',
      },
      {
        id: MENU_B_MAIN,
        shop_id: SHOP_B,
        title: 'Main B',
        slug: 'main-menu',
      },
    ])
    .execute()

  // Tree shape under MENU_A_MAIN:
  //   ROOT1 (pos 0)
  //     CHILD_A (pos 0)
  //       GRAND_A (pos 0)
  //     CHILD_B (pos 1)
  //   ROOT2 (pos 1)
  //   ROOT3 (pos 2)
  await db
    .insertInto('menu_items')
    .values([
      { id: ROOT1, menu_id: MENU_A_MAIN, parent_id: null, title: 'Root 1', url: '/r1', position: 0 },
      { id: ROOT2, menu_id: MENU_A_MAIN, parent_id: null, title: 'Root 2', url: '/r2', position: 1 },
      { id: ROOT3, menu_id: MENU_A_MAIN, parent_id: null, title: 'Root 3', url: '/r3', position: 2 },
      { id: CHILD_A, menu_id: MENU_A_MAIN, parent_id: ROOT1, title: 'Child A', url: '/ca', position: 0 },
      { id: CHILD_B, menu_id: MENU_A_MAIN, parent_id: ROOT1, title: 'Child B', url: '/cb', position: 1 },
      { id: GRAND_A, menu_id: MENU_A_MAIN, parent_id: CHILD_A, title: 'Grand A', url: '/ga', position: 0 },
      { id: FOOTER_ITEM, menu_id: MENU_A_FOOTER, parent_id: null, title: 'Footer 1', url: '/f1', position: 0 },
      { id: SHOP_B_ITEM, menu_id: MENU_B_MAIN, parent_id: null, title: 'B Main 1', url: '/b1', position: 0 },
    ] as any)
    .execute()

  // Resources for picker tests. Shop A gets two products, a collection,
  // a page, a blog post. Shop B gets one product that should NEVER leak.
  await db
    .insertInto('products')
    .values([
      {
        id: PROD_A,
        shop_id: SHOP_A,
        title: `Lens Aurora ${SUFFIX}`,
        slug: `lens-aurora-${SUFFIX}`,
        status: 'active',
      },
      {
        id: PROD_B,
        shop_id: SHOP_A,
        title: `Camera Nebula ${SUFFIX}`,
        slug: `camera-nebula-${SUFFIX}`,
        status: 'active',
      },
      {
        id: PROD_FOREIGN,
        shop_id: SHOP_B,
        title: `SHOULD NOT LEAK ${SUFFIX}`,
        slug: `foreign-${SUFFIX}`,
        status: 'active',
      },
    ] as any)
    .execute()

  await db
    .insertInto('collections')
    .values([
      {
        id: COLL_A,
        shop_id: SHOP_A,
        title: `Aurora Collection ${SUFFIX}`,
        slug: `aurora-collection-${SUFFIX}`,
      },
    ] as any)
    .execute()

  await db
    .insertInto('pages')
    .values([
      {
        id: PAGE_A,
        shop_id: SHOP_A,
        title: `About Aurora ${SUFFIX}`,
        slug: `about-aurora-${SUFFIX}`,
        body_html: '<p>page body</p>',
        published: true,
      },
    ] as any)
    .execute()

  await db
    .insertInto('blog_posts')
    .values([
      {
        id: BLOG_A,
        shop_id: SHOP_A,
        title: `Aurora Blog ${SUFFIX}`,
        slug: `aurora-blog-${SUFFIX}`,
        body_html: '<p>body</p>',
        published: true,
        published_at: new Date().toISOString(),
      },
    ] as any)
    .execute()

  log('  seeded.\n')

  // ---------- Section 1: buildTree + listMenuItemsTree ----------
  log('[1] buildTree + listMenuItemsTree')
  const tree = await listMenuItemsTree(db as any, SHOP_A, MENU_A_MAIN)
  assert(tree.length === 3, 'tree has 3 roots')
  assert(tree[0].id === ROOT1 && tree[1].id === ROOT2 && tree[2].id === ROOT3, 'roots sorted by position')
  assert(tree[0].children.length === 2, 'Root 1 has 2 children')
  assert(tree[0].children[0].id === CHILD_A, 'Child A is first')
  assert(tree[0].children[0].children.length === 1, 'Child A has 1 grandchild')
  assert(tree[0].children[0].children[0].id === GRAND_A, 'Grand A is the grandchild')
  assert(tree[0].depth === 0 && tree[0].children[0].depth === 1 && tree[0].children[0].children[0].depth === 2, 'depths are 0/1/2')

  // Cross-shop: asking for MENU_A_MAIN as SHOP_B should yield [].
  const foreignTree = await listMenuItemsTree(db as any, SHOP_B, MENU_A_MAIN)
  assert(foreignTree.length === 0, 'cross-shop listMenuItemsTree returns empty')

  // ---------- Section 2: reorderMenuItems sibling swap ----------
  log('\n[2] reorderMenuItems — sibling swap')
  const swap = await reorderMenuItems(db as any, SHOP_A, MENU_A_MAIN, [
    { id: ROOT1, parent_id: null, position: 2 },
    { id: ROOT2, parent_id: null, position: 0 },
    { id: ROOT3, parent_id: null, position: 1 },
  ])
  assert(swap.updated === 3, 'sibling swap updated 3 rows')
  assert(swap.skipped_over_depth === 0, 'sibling swap skipped 0')
  const afterSwap = await listMenuItemsTree(db as any, SHOP_A, MENU_A_MAIN)
  assert(afterSwap.map((n) => n.id).join(',') === [ROOT2, ROOT3, ROOT1].join(','), 'roots now ordered R2 → R3 → R1')

  // ---------- Section 3: reorderMenuItems re-parent ----------
  log('\n[3] reorderMenuItems — re-parent (Root 2 → child of Root 3)')
  const reparent = await reorderMenuItems(db as any, SHOP_A, MENU_A_MAIN, [
    { id: ROOT2, parent_id: ROOT3, position: 0 },
  ])
  assert(reparent.updated === 1, 'reparent updated 1')
  assert(reparent.skipped_over_depth === 0, 'reparent skipped_over_depth = 0')
  const afterReparent = await listMenuItemsTree(db as any, SHOP_A, MENU_A_MAIN)
  const newRoots = afterReparent.map((n) => n.id)
  assert(newRoots.includes(ROOT3) && !newRoots.includes(ROOT2), 'R2 is no longer a root')
  const r3 = afterReparent.find((n) => n.id === ROOT3)
  assert(!!r3 && r3.children.some((c) => c.id === ROOT2), 'R2 now appears under R3')

  // ---------- Section 4: reorderMenuItems — cycle rejection ----------
  log('\n[4] reorderMenuItems — cycle rejection')
  // Try to make ROOT1 a child of CHILD_A (which is under ROOT1). Must reject.
  const cycleAttempt = await reorderMenuItems(db as any, SHOP_A, MENU_A_MAIN, [
    { id: ROOT1, parent_id: CHILD_A, position: 0 },
  ])
  assert(cycleAttempt.updated === 0, 'cycle attempt updated 0 rows')
  // Verify DB untouched.
  const afterCycle = await listMenuItemsTree(db as any, SHOP_A, MENU_A_MAIN)
  const r1StillRoot = afterCycle.find((n) => n.id === ROOT1)
  assert(!!r1StillRoot, 'ROOT1 still a root after cycle reject')

  // ---------- Section 5: reorderMenuItems — depth rejection ----------
  log('\n[5] reorderMenuItems — depth rejection')
  // Move ROOT3 (which now hosts ROOT2) to be a child of CHILD_A.
  // That would put ROOT3 at depth 2 and ROOT2 at depth 3 (past MAX=3).
  // Actually MAX_MENU_DEPTH=3 means max depth VALUE is 3 (depths 0,1,2,3
  // exist; >= MAX is rejected). Let's re-examine: GRAND_A is at depth 2
  // already. If we move ROOT3 under GRAND_A, ROOT3 lands at depth 3
  // which equals MAX → rejected.
  const depthAttempt = await reorderMenuItems(db as any, SHOP_A, MENU_A_MAIN, [
    { id: ROOT3, parent_id: GRAND_A, position: 0 },
  ])
  assert(depthAttempt.updated === 0, 'depth-violating reparent updated 0')
  assert(depthAttempt.skipped_over_depth === 1, 'depth skipped_over_depth counted 1')

  // ---------- Section 6: reorderMenuItems — foreign ids silently dropped ----------
  log('\n[6] reorderMenuItems — foreign ids dropped')
  // FOOTER_ITEM belongs to MENU_A_FOOTER, not MENU_A_MAIN.
  // SHOP_B_ITEM belongs to MENU_B_MAIN under SHOP_B.
  const foreign = await reorderMenuItems(db as any, SHOP_A, MENU_A_MAIN, [
    { id: FOOTER_ITEM, parent_id: null, position: 99 },
    { id: SHOP_B_ITEM, parent_id: null, position: 100 },
  ])
  assert(foreign.updated === 0, 'foreign-ids reorder updated 0')
  assert(foreign.skipped_over_depth === 0, 'foreign-ids skipped_over_depth 0')

  // FOOTER_ITEM should still be at position 0 under MENU_A_FOOTER.
  const footerItems = await db
    .selectFrom('menu_items')
    .select(['id', 'position', 'menu_id'])
    .where('id', '=', FOOTER_ITEM)
    .executeTakeFirst()
  assert(Number((footerItems as any)?.position) === 0, 'FOOTER_ITEM position untouched')

  // ---------- Section 7: searchResources — fan-out ----------
  log('\n[7] searchResources — fan out across 4 types')
  const all = await searchResources(db as any, SHOP_A, `Aurora`, { limit: 15 })
  const byType = {
    product: all.filter((h) => h.type === 'product'),
    collection: all.filter((h) => h.type === 'collection'),
    page: all.filter((h) => h.type === 'page'),
    blog_post: all.filter((h) => h.type === 'blog_post'),
  }
  assert(byType.product.some((h) => h.id === PROD_A), 'fan-out found product PROD_A')
  assert(byType.collection.some((h) => h.id === COLL_A), 'fan-out found collection COLL_A')
  assert(byType.page.some((h) => h.id === PAGE_A), 'fan-out found page PAGE_A')
  assert(byType.blog_post.some((h) => h.id === BLOG_A), 'fan-out found blog_post BLOG_A')
  // Foreign product must NOT leak into shop A.
  assert(!all.some((h) => h.id === PROD_FOREIGN), 'foreign product NOT in shop A results')

  // ---------- Section 8: searchResources — types filter ----------
  log('\n[8] searchResources — types filter')
  const onlyProducts = await searchResources(db as any, SHOP_A, 'Aurora', { types: ['product'], limit: 15 })
  assert(onlyProducts.every((h) => h.type === 'product'), 'types filter: all hits are products')
  assert(onlyProducts.some((h) => h.id === PROD_A), 'types filter: still finds PROD_A')

  // ---------- Section 9: searchResources — case-insensitive ----------
  log('\n[9] searchResources — ILIKE case-insensitive')
  const lower = await searchResources(db as any, SHOP_A, 'aurora', { limit: 15 })
  const upper = await searchResources(db as any, SHOP_A, 'AURORA', { limit: 15 })
  assert(lower.length === upper.length && lower.length > 0, 'lower/upper case return same hits')

  // ---------- Section 10: searchResources — shop scoped ----------
  log('\n[10] searchResources — shop scope')
  const onShopB = await searchResources(db as any, SHOP_B, 'Aurora', { limit: 15 })
  assert(!onShopB.some((h) => h.id === PROD_A), 'shop B cannot see shop A product PROD_A')
  const shopBForeign = await searchResources(db as any, SHOP_B, 'SHOULD NOT LEAK', { limit: 15 })
  assert(shopBForeign.some((h) => h.id === PROD_FOREIGN), 'shop B can see its own PROD_FOREIGN')

  // ---------- Section 11: searchResources — empty q returns recent rows ----------
  log('\n[11] searchResources — empty q returns recent rows')
  const emptyQ = await searchResources(db as any, SHOP_A, '', { limit: 15 })
  assert(emptyQ.length > 0, 'empty q returns something')
  assert(emptyQ.some((h) => h.id === PROD_A) || emptyQ.some((h) => h.id === COLL_A), 'empty q includes shop A rows')

  // ---------- Section 12: resolveResourceUrl ----------
  log('\n[12] resolveResourceUrl')
  const prodUrl = await resolveResourceUrl(db as any, SHOP_A, 'product', PROD_A)
  assert(prodUrl === `/products/lens-aurora-${SUFFIX}`, 'product URL is /products/<slug>')
  const collUrl = await resolveResourceUrl(db as any, SHOP_A, 'collection', COLL_A)
  assert(collUrl === `/collections/aurora-collection-${SUFFIX}`, 'collection URL is /collections/<slug>')
  const pageUrl = await resolveResourceUrl(db as any, SHOP_A, 'page', PAGE_A)
  assert(pageUrl === `/pages/about-aurora-${SUFFIX}`, 'page URL is /pages/<slug>')
  const blogUrl = await resolveResourceUrl(db as any, SHOP_A, 'blog_post', BLOG_A)
  assert(blogUrl === `/blog/aurora-blog-${SUFFIX}`, 'blog URL is /blog/<slug>')

  // Missing row → null.
  const missingUrl = await resolveResourceUrl(db as any, SHOP_A, 'product', randomUUID())
  assert(missingUrl === null, 'missing product returns null')

  // Shop-scoped — SHOP_A should not resolve SHOP_B's product.
  const scopedUrl = await resolveResourceUrl(db as any, SHOP_A, 'product', PROD_FOREIGN)
  assert(scopedUrl === null, 'cross-shop resolve returns null')

  // ---------- Section 13: buildTree truncation guard ----------
  log('\n[13] buildTree truncates at MAX_MENU_DEPTH')
  // 5-level chain; MAX=3 means we keep levels 0/1/2 only.
  const fakeRows = [
    { id: 'L0', menu_id: 'm', parent_id: null, title: 'L0', url: null, resource_type: null, resource_id: null, position: 0 },
    { id: 'L1', menu_id: 'm', parent_id: 'L0', title: 'L1', url: null, resource_type: null, resource_id: null, position: 0 },
    { id: 'L2', menu_id: 'm', parent_id: 'L1', title: 'L2', url: null, resource_type: null, resource_id: null, position: 0 },
    { id: 'L3', menu_id: 'm', parent_id: 'L2', title: 'L3', url: null, resource_type: null, resource_id: null, position: 0 },
    { id: 'L4', menu_id: 'm', parent_id: 'L3', title: 'L4', url: null, resource_type: null, resource_id: null, position: 0 },
  ]
  const truncated = buildTree(fakeRows)
  assert(truncated.length === 1, 'truncated tree has 1 root')
  assert(truncated[0].children[0].children[0].depth === MAX_MENU_DEPTH - 1, 'deepest rendered depth is MAX-1')
  assert(truncated[0].children[0].children[0].children.length === 0, 'L3+ descendants are dropped')

  log('\n=== DONE ===')
  log(`Failures: ${failed}`)
}

async function cleanup() {
  log('\n[cleanup] Rolling back seeded rows...')
  try {
    // Order matters — menu_items FK menus FK shops.
    await db.deleteFrom('menu_items').where('menu_id', 'in', [MENU_A_MAIN, MENU_A_FOOTER, MENU_B_MAIN]).execute()
    await (db as any).deleteFrom('menus').where('id', 'in', [MENU_A_MAIN, MENU_A_FOOTER, MENU_B_MAIN]).execute()
    await db.deleteFrom('blog_posts').where('id', '=', BLOG_A).execute()
    await db.deleteFrom('pages').where('id', '=', PAGE_A).execute()
    await db.deleteFrom('collections').where('id', '=', COLL_A).execute()
    await db.deleteFrom('products').where('id', 'in', [PROD_A, PROD_B, PROD_FOREIGN]).execute()
    await (db as any).deleteFrom('shops').where('id', 'in', [SHOP_A, SHOP_B]).execute()
    log('[cleanup] Done.')
  } catch (e) {
    log(`[cleanup] FAILED: ${(e as Error).message}`)
  }
}

main()
  .then(async () => {
    await cleanup()
    await db.destroy()
    process.exit(failed === 0 ? 0 : 1)
  })
  .catch(async (err) => {
    console.error('FATAL:', err)
    try {
      await cleanup()
    } catch {}
    try {
      await db.destroy()
    } catch {}
    process.exit(2)
  })
