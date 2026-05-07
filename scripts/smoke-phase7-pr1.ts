/**
 * Phase 7 PR1 — Pages & Blog SEO + bulk ops live smoke.
 *
 * Exercises the new content-service surface against real Postgres:
 *
 *   1.  createPage with seo_title / seo_description persists both columns.
 *   2.  createPage with blank SEO normalises to NULL (blankToNull).
 *   3.  updatePage overwrites SEO fields (blank → NULL round-trip).
 *   4.  bulkUpdatePages publish / unpublish flips flags + stamps updated_at.
 *   5.  bulkUpdatePages delete removes N rows (numDeletedRows accurate).
 *   6.  bulkUpdatePages is shop-scoped: cannot touch rows owned by
 *       another shop even when their ids are passed in.
 *   7.  bulkUpdatePages returns {affected: 0} for empty ids array.
 *   8.  createBlogPost with tags applies normaliseTags (dedup + trim).
 *   9.  updateBlogPost tags-only patch re-normalises without touching
 *       other columns.
 *  10.  bulkUpdateBlogPosts publish stamps published_at on first publish
 *       only (idempotent on already-published rows).
 *  11.  bulkUpdateBlogPosts unpublish nulls published_at so a subsequent
 *       publish produces a fresh stamp (Shopify behaviour).
 *  12.  bulkUpdateBlogPosts delete removes rows & is shop-scoped.
 *
 * Rolls back all seeded rows in finally{} so re-running is safe.
 *
 * Run on server 2:
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase7-pr1.ts
 */

import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  createPage,
  updatePage,
  bulkUpdatePages,
  createBlogPost,
  updateBlogPost,
  bulkUpdateBlogPosts,
  normaliseTags,
} from '../packages/core/src/modules/content/service.js'

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_A = randomUUID()
const SHOP_B = randomUUID()

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
  log(`\n=== Phase 7 PR1 smoke — suffix=${SUFFIX} ===\n`)

  // ---------- Section 0: seed two shops (A = main, B = tenant boundary) ----------
  log('[0] Seeding shops A + B')
  await db
    .insertInto('shops')
    .values([
      {
        id: SHOP_A,
        slug: `smoke-p7-1-a-${SUFFIX}`,
        name: 'PR1 Shop A',
        email: `a-${SUFFIX}@example.test`,
        status: 'active',
      },
      {
        id: SHOP_B,
        slug: `smoke-p7-1-b-${SUFFIX}`,
        name: 'PR1 Shop B',
        email: `b-${SUFFIX}@example.test`,
        status: 'active',
      },
    ] as any)
    .execute()

  // ---------- Section 1: pages — SEO create / blank / update ----------
  log('\n[1] Pages — SEO create / blank / update')

  const p1 = await createPage(db as any, SHOP_A, {
    title: 'About Us',
    slug: `about-${SUFFIX}`,
    body_html: '<p>Hello.</p>',
    seo_title: 'About | PR1 Shop A',
    seo_description: 'Meet the team',
    published: true,
  })
  assert(!!p1.id, 'createPage returns a row with id')
  const p1Row: any = await db
    .selectFrom('pages')
    .selectAll()
    .where('id', '=', p1.id)
    .executeTakeFirst()
  assert(p1Row.seo_title === 'About | PR1 Shop A', 'seo_title persisted')
  assert(p1Row.seo_description === 'Meet the team', 'seo_description persisted')

  const p2 = await createPage(db as any, SHOP_A, {
    title: 'Contact',
    slug: `contact-${SUFFIX}`,
    seo_title: '   ',
    seo_description: '',
    published: false,
  })
  const p2Row: any = await db
    .selectFrom('pages')
    .selectAll()
    .where('id', '=', p2.id)
    .executeTakeFirst()
  assert(p2Row.seo_title === null, 'blank seo_title → NULL')
  assert(p2Row.seo_description === null, 'empty seo_description → NULL')

  // Update round-trip: set then clear
  await updatePage(db as any, SHOP_A, p2.id, {
    seo_title: 'Contact Us',
    seo_description: 'Reach the team',
  })
  const p2Set: any = await db
    .selectFrom('pages')
    .selectAll()
    .where('id', '=', p2.id)
    .executeTakeFirst()
  assert(p2Set.seo_title === 'Contact Us', 'updatePage writes seo_title')
  assert(p2Set.seo_description === 'Reach the team', 'updatePage writes seo_description')

  await updatePage(db as any, SHOP_A, p2.id, {
    seo_title: '',
    seo_description: '   ',
  })
  const p2Clear: any = await db
    .selectFrom('pages')
    .selectAll()
    .where('id', '=', p2.id)
    .executeTakeFirst()
  assert(p2Clear.seo_title === null, 'updatePage clears seo_title back to NULL')
  assert(p2Clear.seo_description === null, 'updatePage clears seo_description back to NULL')

  // ---------- Section 2: pages — bulk publish / unpublish / delete ----------
  log('\n[2] Pages — bulk publish / unpublish / delete + shop scoping')

  // Seed 3 more on shop A (drafts)
  const bulkPageIds: string[] = []
  for (let i = 0; i < 3; i++) {
    const p = await createPage(db as any, SHOP_A, {
      title: `Bulk page ${i}`,
      slug: `bulk-${i}-${SUFFIX}`,
      published: false,
    })
    bulkPageIds.push(p.id)
  }

  // Seed 1 on shop B to prove scoping
  const pOther = await createPage(db as any, SHOP_B, {
    title: 'Other shop page',
    slug: `other-${SUFFIX}`,
    published: false,
  })

  // Publish all 3 in shop A + try to sneak pOther.id through
  const pubResult = await bulkUpdatePages(
    db as any,
    SHOP_A,
    [...bulkPageIds, pOther.id],
    'publish',
  )
  assert(pubResult.affected === 3, `bulk publish affected=3 (got ${pubResult.affected})`)

  const pubRows: any[] = await db
    .selectFrom('pages')
    .selectAll()
    .where('id', 'in', bulkPageIds)
    .execute()
  const allPublished = pubRows.every((r) => r.published === true)
  assert(allPublished, 'all 3 shop-A pages now published=true')

  const otherRow: any = await db
    .selectFrom('pages')
    .selectAll()
    .where('id', '=', pOther.id)
    .executeTakeFirst()
  assert(
    otherRow.published === false,
    'shop-B page NOT flipped (shop_id scoping held)',
  )

  // Unpublish
  const unpubResult = await bulkUpdatePages(db as any, SHOP_A, bulkPageIds, 'unpublish')
  assert(unpubResult.affected === 3, `bulk unpublish affected=3 (got ${unpubResult.affected})`)
  const unpubRows: any[] = await db
    .selectFrom('pages')
    .selectAll()
    .where('id', 'in', bulkPageIds)
    .execute()
  assert(
    unpubRows.every((r) => r.published === false),
    'all 3 pages now unpublished',
  )

  // Empty ids → {affected: 0}
  const emptyResult = await bulkUpdatePages(db as any, SHOP_A, [], 'publish')
  assert(emptyResult.affected === 0, 'empty ids → affected=0 (no-op)')

  // Delete 2 of the 3, leave 1 for cleanup audit
  const delIds = bulkPageIds.slice(0, 2)
  const delResult = await bulkUpdatePages(db as any, SHOP_A, delIds, 'delete')
  assert(delResult.affected === 2, `bulk delete affected=2 (got ${delResult.affected})`)
  const remaining = await db
    .selectFrom('pages')
    .select('id')
    .where('id', 'in', bulkPageIds)
    .execute()
  assert(remaining.length === 1, 'only 1 bulk page survives (other 2 deleted)')

  // ---------- Section 3: blog posts — tag normalisation ----------
  log('\n[3] Blog — normaliseTags on create + update')

  // normaliseTags pure-fn sanity (already covered by vitest, but re-assert)
  assert(JSON.stringify(normaliseTags(['  Sale  ', 'sale', 'NEW'])) === '["Sale","NEW"]',
    'normaliseTags dedupes + trims (pure)')
  assert(normaliseTags([]) === null, 'normaliseTags empty → null (pure)')

  const b1 = await createBlogPost(db as any, SHOP_A, {
    title: 'Hello world',
    slug: `hello-${SUFFIX}`,
    body_html: '<p>Hi.</p>',
    tags: ['  Sale  ', 'sale', 'NEW', 'new', ''],
    published: false,
  })
  const b1Row: any = await db
    .selectFrom('blog_posts')
    .selectAll()
    .where('id', '=', b1.id)
    .executeTakeFirst()
  assert(
    JSON.stringify(b1Row.tags) === JSON.stringify(['Sale', 'NEW']),
    `createBlogPost tags normalised (got ${JSON.stringify(b1Row.tags)})`,
  )

  // Update tags → other columns untouched
  const origTitle = b1Row.title
  await updateBlogPost(db as any, SHOP_A, b1.id, {
    tags: ['hot', 'HOT', ' fresh '],
  })
  const b1Up: any = await db
    .selectFrom('blog_posts')
    .selectAll()
    .where('id', '=', b1.id)
    .executeTakeFirst()
  assert(
    JSON.stringify(b1Up.tags) === JSON.stringify(['hot', 'fresh']),
    `update tags-only re-normalised (got ${JSON.stringify(b1Up.tags)})`,
  )
  assert(b1Up.title === origTitle, 'updateBlogPost tags-only did not clobber title')

  // SEO on blog
  const b1Seo = await updateBlogPost(db as any, SHOP_A, b1.id, {
    seo_title: 'Hello world | Shop A',
    seo_description: 'A warm greeting.',
  })
  assert((b1Seo as any).seo_title === 'Hello world | Shop A', 'blog seo_title persists')
  assert((b1Seo as any).seo_description === 'A warm greeting.', 'blog seo_description persists')

  // Blank → NULL round-trip
  await updateBlogPost(db as any, SHOP_A, b1.id, {
    seo_title: '   ',
    seo_description: '',
  })
  const b1Cleared: any = await db
    .selectFrom('blog_posts')
    .selectAll()
    .where('id', '=', b1.id)
    .executeTakeFirst()
  assert(b1Cleared.seo_title === null, 'blog seo_title blank → NULL')
  assert(b1Cleared.seo_description === null, 'blog seo_description blank → NULL')

  // ---------- Section 4: blog bulk — publish / republish / unpublish ----------
  log('\n[4] Blog — bulk publish stamps published_at; unpublish nulls it; republish re-stamps')

  const bulkBlogIds: string[] = []
  for (let i = 0; i < 3; i++) {
    const b = await createBlogPost(db as any, SHOP_A, {
      title: `Bulk post ${i}`,
      slug: `bulk-post-${i}-${SUFFIX}`,
      body_html: '<p>body</p>',
      published: false,
    })
    bulkBlogIds.push(b.id)
  }

  // One already-published row on shop A: stamp published_at, then verify
  // bulk publish doesn't touch it.
  const alreadyPub = await createBlogPost(db as any, SHOP_A, {
    title: 'Already published',
    slug: `already-${SUFFIX}`,
    body_html: '<p>body</p>',
    published: true,
  })
  const stampOrig = new Date(Date.now() - 10 * 86400_000).toISOString()
  await db
    .updateTable('blog_posts')
    .set({ published_at: stampOrig } as any)
    .where('id', '=', alreadyPub.id)
    .execute()

  // Shop B post — must not be touched
  const bOther = await createBlogPost(db as any, SHOP_B, {
    title: 'Other shop post',
    slug: `other-post-${SUFFIX}`,
    body_html: '<p>body</p>',
    published: false,
  })

  const blogPub = await bulkUpdateBlogPosts(
    db as any,
    SHOP_A,
    [...bulkBlogIds, alreadyPub.id, bOther.id],
    'publish',
  )
  assert(
    blogPub.affected === 4,
    `bulk blog publish affected=4 (3 new + 1 already-pub, got ${blogPub.affected})`,
  )

  const blogPubRows: any[] = await db
    .selectFrom('blog_posts')
    .selectAll()
    .where('id', 'in', bulkBlogIds)
    .execute()
  assert(
    blogPubRows.every((r) => r.published === true && r.published_at !== null),
    'all 3 bulk posts published=true + published_at stamped',
  )

  const alreadyPubRow: any = await db
    .selectFrom('blog_posts')
    .selectAll()
    .where('id', '=', alreadyPub.id)
    .executeTakeFirst()
  // Normalise both sides to ms since Postgres returns a Date.
  const origMs = new Date(stampOrig).getTime()
  const newMs = new Date(alreadyPubRow.published_at).getTime()
  assert(
    origMs === newMs,
    `already-published row kept its original published_at (orig=${origMs} new=${newMs})`,
  )

  const bOtherRow: any = await db
    .selectFrom('blog_posts')
    .selectAll()
    .where('id', '=', bOther.id)
    .executeTakeFirst()
  assert(bOtherRow.published === false, 'shop-B blog post NOT flipped (scoping held)')

  // Unpublish flips flag + nulls published_at
  const blogUnpub = await bulkUpdateBlogPosts(db as any, SHOP_A, bulkBlogIds, 'unpublish')
  assert(blogUnpub.affected === 3, `bulk blog unpublish affected=3 (got ${blogUnpub.affected})`)
  const unpubBlogRows: any[] = await db
    .selectFrom('blog_posts')
    .selectAll()
    .where('id', 'in', bulkBlogIds)
    .execute()
  assert(
    unpubBlogRows.every((r) => r.published === false && r.published_at === null),
    'all 3 unpublished blog posts: flag=false, published_at=null',
  )

  // Republish produces fresh stamps (differ from the original stamp)
  const beforeRepub = Date.now()
  await bulkUpdateBlogPosts(db as any, SHOP_A, bulkBlogIds, 'publish')
  const afterRepub = Date.now()
  const repubRows: any[] = await db
    .selectFrom('blog_posts')
    .select('published_at')
    .where('id', 'in', bulkBlogIds)
    .execute()
  const allFresh = repubRows.every((r) => {
    const ms = new Date(r.published_at).getTime()
    return ms >= beforeRepub - 2000 && ms <= afterRepub + 2000
  })
  assert(allFresh, 'republished posts got a fresh published_at stamp')

  // Delete 2 blog posts
  const blogDelIds = bulkBlogIds.slice(0, 2)
  const blogDelResult = await bulkUpdateBlogPosts(db as any, SHOP_A, blogDelIds, 'delete')
  assert(
    blogDelResult.affected === 2,
    `bulk blog delete affected=2 (got ${blogDelResult.affected})`,
  )
  const remainingBlog = await db
    .selectFrom('blog_posts')
    .select('id')
    .where('id', 'in', bulkBlogIds)
    .execute()
  assert(remainingBlog.length === 1, 'only 1 bulk post survives (other 2 deleted)')
}

async function cleanup() {
  log('\n[cleanup] disposing seeded rows')
  try {
    await db
      .deleteFrom('blog_posts')
      .where('shop_id', 'in', [SHOP_A, SHOP_B])
      .execute()
    await db
      .deleteFrom('pages')
      .where('shop_id', 'in', [SHOP_A, SHOP_B])
      .execute()
    await db
      .deleteFrom('shops')
      .where('id', 'in', [SHOP_A, SHOP_B])
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
      log('PHASE 7 PR1 SMOKE: ALL CHECKS PASSED')
      process.exit(0)
    } else {
      log(`PHASE 7 PR1 SMOKE: ${failed} CHECK(S) FAILED`)
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
