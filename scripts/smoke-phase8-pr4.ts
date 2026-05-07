/**
 * Phase 8 PR4 — Reviews moderation + notifications categorisation live-DB smoke.
 *
 * Unit coverage lives in:
 *   - packages/core/src/modules/reviews/moderation.test.ts          (26 cases)
 *   - packages/core/src/modules/notifications/categorization.test.ts (15 cases)
 *   - apps/storefront/src/middleware/reviews-routes.test.ts          (24 cases)
 *   - apps/store-admin/src/pages/reviews.handlers.test.ts            (12 cases)
 *
 * This script verifies the live Postgres path — migration 065 shape,
 * cross-shop tenancy on reviews + notifications, the spam heuristic
 * running through the insert path, setReviewReply persistence, bulk
 * status update shop-scope, category stamping + groupByCategory over a
 * real row set, and getNotifications with category filter.
 *
 * Run from server 2 (local Windows box can't reach the 192.168.1.13 PG):
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase8-pr4.ts
 *
 * Cleans up every seeded row in finally{} so the script is re-runnable.
 *
 * Coverage (assertions numbered below):
 *   [1]  Migration 065 — product_reviews.reply_body exists
 *   [2]  Migration 065 — product_reviews.reply_author exists
 *   [3]  Migration 065 — product_reviews.replied_at exists
 *   [4]  Migration 065 — product_reviews.spam_score exists (int default 0)
 *   [5]  Migration 065 — notifications.category exists
 *   [6]  Migration 065 — notifications.link exists
 *   [7]  Migration 065 — idx_notifications_shop_read_created exists
 *   [8]  computeSpamScore — clean body scores low
 *   [9]  computeSpamScore — 3+ URLs pushes above threshold
 *   [10] computeSpamScore — all-caps rant bumps score by 15
 *   [11] computeSpamScore — clamps to 100
 *   [12] submitPublicReview — clean review → status=pending, row visible via getReview
 *   [13] submitPublicReview — spammy review → status=spam, spam_score>=80
 *   [14] setReviewReply — persists body/author/replied_at
 *   [15] setReviewReply — clearing sets all three back to null
 *   [16] bulkUpdateReviewStatus — marks 3 rows as 'rejected'
 *   [17] bulkUpdateReviewStatus — ids from a different shop are untouched (shop-scope)
 *   [18] createNotification — stamps explicit category + link
 *   [19] createNotification — infers category when caller omits one
 *   [20] groupByCategory — buckets live rows by category
 *   [21] getNotifications — category filter returns only rows in that bucket
 *   [22] getNotifications — legacy NULL-category rows still match via type fallback
 *   [23] Iron rule 5 surface audit — no 'god admin' strings in reviews / notifications
 */

import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  computeSpamScore,
  submitPublicReview,
  setReviewReply,
  bulkUpdateReviewStatus,
  getReview,
} from '../packages/core/src/modules/reviews/service.js'
import {
  createNotification,
  getNotifications,
  groupByCategory,
  inferCategory,
} from '../packages/core/src/modules/notifications/service.js'

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_A = randomUUID()
const SHOP_B = randomUUID()
const PRODUCT_A = randomUUID()
const PRODUCT_B = randomUUID()

function log(s: string) {
  // eslint-disable-next-line no-console
  console.log(s)
}

let failed = 0
let total = 0
function assert(cond: boolean, msg: string) {
  total++
  if (cond) log(`  OK   ${msg}`)
  else {
    failed++
    log(`  FAIL ${msg}`)
  }
}

async function main() {
  log(`\n=== Phase 8 PR4 smoke — suffix=${SUFFIX} ===\n`)

  // -------------------------------------------------------------------------
  // [0] Seed shops + products
  // -------------------------------------------------------------------------
  log('[0] Seeding two shops (A, B) + one product per shop (FK target)')
  await (db as any)
    .insertInto('shops')
    .values([
      {
        id: SHOP_A,
        slug: `smoke-p8-4a-${SUFFIX}`,
        name: 'PR4 Shop A',
        email: `p8-4a-${SUFFIX}@example.test`,
        status: 'active',
        plan: 'free',
      },
      {
        id: SHOP_B,
        slug: `smoke-p8-4b-${SUFFIX}`,
        name: 'PR4 Shop B',
        email: `p8-4b-${SUFFIX}@example.test`,
        status: 'active',
        plan: 'free',
      },
    ])
    .execute()

  // product_reviews.product_id has a NOT NULL FK to products(id), so
  // every review needs a real product. We seed one per shop.
  await (db as any)
    .insertInto('products')
    .values([
      {
        id: PRODUCT_A,
        shop_id: SHOP_A,
        title: 'PR4 Smoke Product A',
        slug: `smoke-p8-4a-${SUFFIX}`,
        status: 'active',
      },
      {
        id: PRODUCT_B,
        shop_id: SHOP_B,
        title: 'PR4 Smoke Product B',
        slug: `smoke-p8-4b-${SUFFIX}`,
        status: 'active',
      },
    ])
    .execute()

  // -------------------------------------------------------------------------
  // [1..4] Migration 065 product_reviews shape
  // -------------------------------------------------------------------------
  log('\n[1..4] Migration 065 shape — product_reviews columns')
  const prvCols = await (db as any)
    .selectFrom('information_schema.columns' as any)
    .where('table_name', '=', 'product_reviews')
    .select(['column_name', 'data_type'])
    .execute()
  const colMap = new Map<string, string>(
    (prvCols as any[]).map((c) => [c.column_name as string, c.data_type as string]),
  )
  assert(colMap.has('reply_body'), '[1] product_reviews.reply_body exists')
  assert(colMap.has('reply_author'), '[2] product_reviews.reply_author exists')
  assert(colMap.has('replied_at'), '[3] product_reviews.replied_at exists')
  assert(colMap.has('spam_score'), `[4] product_reviews.spam_score exists (got ${colMap.get('spam_score')})`)

  // -------------------------------------------------------------------------
  // [5..6] Migration 065 notifications shape
  // -------------------------------------------------------------------------
  log('\n[5..6] Migration 065 shape — notifications columns')
  const notifCols = await (db as any)
    .selectFrom('information_schema.columns' as any)
    .where('table_name', '=', 'notifications')
    .select(['column_name', 'data_type'])
    .execute()
  const notifColMap = new Map<string, string>(
    (notifCols as any[]).map((c) => [c.column_name as string, c.data_type as string]),
  )
  assert(notifColMap.has('category'), '[5] notifications.category exists')
  assert(notifColMap.has('link'), '[6] notifications.link exists')

  // -------------------------------------------------------------------------
  // [7] Migration 065 index
  // -------------------------------------------------------------------------
  log('\n[7] Migration 065 index — idx_notifications_shop_read_created')
  const idx = await (db as any)
    .selectFrom('pg_indexes' as any)
    .where('tablename', '=', 'notifications')
    .where('indexname', '=', 'idx_notifications_shop_read_created')
    .select(['indexname'])
    .executeTakeFirst()
  assert(!!idx, '[7] idx_notifications_shop_read_created exists')

  // -------------------------------------------------------------------------
  // [8..11] computeSpamScore — pure heuristic
  // -------------------------------------------------------------------------
  log('\n[8..11] computeSpamScore')
  const cleanScore = computeSpamScore(
    'This product is really great. I love the quality and would buy again.',
    'reviewer@gmail.com',
    5,
  )
  assert(cleanScore < 20, `[8] clean body scores low (got ${cleanScore})`)

  const linkyScore = computeSpamScore(
    'Check http://a.com and http://b.com and http://c.com for free stuff',
    'x@gmail.com',
    5,
  )
  assert(linkyScore >= 80, `[9] three URLs pushes score above threshold (got ${linkyScore})`)

  const capsScore = computeSpamScore(
    'THIS IS THE WORST PRODUCT EVER PLEASE DO NOT BUY IT YOU WILL REGRET IT HORRIBLY',
    'x@gmail.com',
    1,
  )
  assert(capsScore >= 15, `[10] all-caps rant adds >=15 to score (got ${capsScore})`)

  const extremeScore = computeSpamScore(
    'BUY CHEAP VIAGRA http://spam1.com http://spam2.com http://spam3.com WINNER CLICK HERE FREE MONEY',
    'spam@fake-domain-aaa.xyz',
    5,
  )
  assert(extremeScore === 100, `[11] score clamps at 100 (got ${extremeScore})`)

  // -------------------------------------------------------------------------
  // [12..13] submitPublicReview end-to-end
  // -------------------------------------------------------------------------
  log('\n[12..13] submitPublicReview end-to-end')
  const cleanRow = await submitPublicReview(db as any, SHOP_A, PRODUCT_A, {
    rating: 5,
    title: 'Loved it',
    body: 'The quality is great. I would buy again. Shipping was fast.',
    authorName: 'Jane',
    authorEmail: 'jane@gmail.com',
  })
  assert(
    !!cleanRow && cleanRow.status === 'pending' && Number((cleanRow as any).spam_score ?? 0) < 80,
    `[12] clean review persisted as pending, spam_score=${(cleanRow as any)?.spam_score}`,
  )
  const cleanReviewId = (cleanRow as any).id

  const spamRow = await submitPublicReview(db as any, SHOP_A, PRODUCT_A, {
    rating: 5,
    title: 'WINNER',
    body: 'BUY CHEAP VIAGRA http://s1.com http://s2.com http://s3.com FREE MONEY CLICK HERE NOW',
    authorName: 'Spambot',
    authorEmail: 'bot@sus-domain-xyz.biz',
  })
  assert(
    !!spamRow && spamRow.status === 'spam' && Number((spamRow as any).spam_score ?? 0) >= 80,
    `[13] spammy review auto-classified as spam, spam_score=${(spamRow as any)?.spam_score}`,
  )

  // -------------------------------------------------------------------------
  // [14..15] setReviewReply
  // -------------------------------------------------------------------------
  log('\n[14..15] setReviewReply')
  await setReviewReply(db as any, cleanReviewId, 'Thanks Jane! Glad you loved it.', 'Thai')
  const replied = await getReview(db as any, cleanReviewId)
  assert(
    replied?.reply_body === 'Thanks Jane! Glad you loved it.' &&
      replied?.reply_author === 'Thai' &&
      !!replied?.replied_at,
    '[14] setReviewReply persists body+author+timestamp',
  )

  await setReviewReply(db as any, cleanReviewId, null, null)
  const cleared = await getReview(db as any, cleanReviewId)
  assert(
    cleared?.reply_body === null &&
      cleared?.reply_author === null &&
      cleared?.replied_at === null,
    '[15] setReviewReply(null,null) clears all three columns',
  )

  // -------------------------------------------------------------------------
  // [16..17] bulkUpdateReviewStatus shop-scope
  // -------------------------------------------------------------------------
  log('\n[16..17] bulkUpdateReviewStatus shop-scope')
  const bulkIds = [randomUUID(), randomUUID(), randomUUID()]
  for (const id of bulkIds) {
    await (db as any)
      .insertInto('product_reviews')
      .values({
        id,
        shop_id: SHOP_A,
        product_id: PRODUCT_A,
        rating: 3,
        title: 'meh',
        body: 'average product overall nothing to complain about really',
        author_name: 'Sam',
        author_email: 'sam@gmail.com',
        status: 'pending',
      })
      .execute()
  }
  // Also seed one row in Shop B to verify shop-scope.
  const otherShopReviewId = randomUUID()
  await (db as any)
    .insertInto('product_reviews')
    .values({
      id: otherShopReviewId,
      shop_id: SHOP_B,
      product_id: PRODUCT_B,
      rating: 3,
      title: 'other shop',
      body: 'average product overall nothing to complain about really',
      author_name: 'Pat',
      author_email: 'pat@gmail.com',
      status: 'pending',
    })
    .execute()

  // Try to bulk-update ALL ids (including the Shop B one) while scoped to Shop A.
  const allIds = [...bulkIds, otherShopReviewId]
  const updated = await bulkUpdateReviewStatus(db as any, SHOP_A, allIds, 'rejected')
  assert(updated === 3, `[16] bulkUpdateReviewStatus updates 3 rows (got ${updated})`)

  const otherStillPending = await getReview(db as any, otherShopReviewId)
  assert(
    otherStillPending?.status === 'pending',
    `[17] cross-shop id untouched (shop-scope) — got status=${otherStillPending?.status}`,
  )

  // -------------------------------------------------------------------------
  // [18..19] createNotification stamps category + link
  // -------------------------------------------------------------------------
  log('\n[18..19] createNotification stamps category + link')
  const nExplicit = await createNotification(db as any, SHOP_A, null, {
    type: 'review_submitted',
    title: 'New review to moderate',
    category: 'reviews',
    link: `/admin/store/smoke-p8-4a-${SUFFIX}/products/reviews`,
  })
  assert(
    (nExplicit as any).category === 'reviews' &&
      typeof (nExplicit as any).link === 'string' &&
      (nExplicit as any).link.startsWith('/admin/store/'),
    '[18] explicit category + link stamped on insert',
  )

  const nInferred = await createNotification(db as any, SHOP_A, null, {
    type: 'order_placed',
    title: 'New order',
  })
  assert(
    (nInferred as any).category === 'orders',
    `[19] category inferred from type=order_placed (got ${(nInferred as any).category})`,
  )

  // -------------------------------------------------------------------------
  // [20] groupByCategory over live rows
  // -------------------------------------------------------------------------
  log('\n[20] groupByCategory over live rows')
  {
    // Seed a few more rows across different categories.
    await createNotification(db as any, SHOP_A, null, { type: 'low_stock', title: 'Low stock SKU-1' })
    await createNotification(db as any, SHOP_A, null, { type: 'payment_received', title: 'Paid #1001' })
    await createNotification(db as any, SHOP_A, null, { type: 'review_approved', title: 'Approved review' })
    const rows = await getNotifications(db as any, SHOP_A, null, false)
    const buckets = groupByCategory(rows)
    assert(
      buckets.reviews.length >= 2 && buckets.orders.length >= 1 && buckets.billing.length >= 1 && buckets.inventory.length >= 1,
      `[20] buckets populated: reviews=${buckets.reviews.length}, orders=${buckets.orders.length}, billing=${buckets.billing.length}, inventory=${buckets.inventory.length}`,
    )
  }

  // -------------------------------------------------------------------------
  // [21] getNotifications — category filter
  // -------------------------------------------------------------------------
  log('\n[21] getNotifications — category filter')
  {
    const reviewsOnly = await getNotifications(db as any, SHOP_A, null, false, 'reviews')
    const allReviewsCategory = reviewsOnly.every(
      (n: any) => (n.category ?? inferCategory(n.type)) === 'reviews',
    )
    assert(
      reviewsOnly.length >= 2 && allReviewsCategory,
      `[21] category=reviews returns only reviews rows (got ${reviewsOnly.length} rows, all-reviews=${allReviewsCategory})`,
    )
  }

  // -------------------------------------------------------------------------
  // [22] Legacy NULL-category rows still match via type fallback
  // -------------------------------------------------------------------------
  log('\n[22] Legacy NULL-category rows match via type fallback')
  {
    // Insert a legacy row (NULL category) directly via raw insert.
    const legacyId = randomUUID()
    await (db as any)
      .insertInto('notifications')
      .values({
        id: legacyId,
        shop_id: SHOP_A,
        user_id: null,
        type: 'review_rejected',
        title: 'Legacy rejected review',
        message: null,
        read: false,
        resource_type: null,
        resource_id: null,
        category: null, // explicit NULL to simulate pre-065 row
        link: null,
      })
      .execute()

    const reviewsFilter = await getNotifications(db as any, SHOP_A, null, false, 'reviews')
    const found = reviewsFilter.some((n: any) => n.id === legacyId)
    assert(found, '[22] legacy NULL-category row still returned by category=reviews filter')
  }

  // -------------------------------------------------------------------------
  // [23] Iron rule 5 — no god-admin strings leak
  // -------------------------------------------------------------------------
  log('\n[23] Iron rule 5 surface audit')
  {
    const forbidden = /god[_\s-]?admin/i
    // Dump every row we touched and scan their text fields.
    const notifRows = await getNotifications(db as any, SHOP_A, null, false)
    const reviewRows = await (db as any)
      .selectFrom('product_reviews')
      .selectAll()
      .where('shop_id', '=', SHOP_A)
      .execute()
    const joined = [
      ...(notifRows as any[]).map((n) => `${n.title} ${n.message ?? ''} ${n.link ?? ''}`),
      ...(reviewRows as any[]).map(
        (r) => `${r.title ?? ''} ${r.body ?? ''} ${r.reply_body ?? ''}`,
      ),
    ].join(' ')
    assert(!forbidden.test(joined), '[23] no god-admin strings in reviews / notifications surface')
  }

  log(`\n=== Phase 8 PR4 smoke — ${total - failed}/${total} passed ===`)
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('SMOKE CRASHED', err)
    failed = Math.max(failed, 1)
  })
  .finally(async () => {
    log('\n[cleanup] deleting seeded rows')
    try {
      // Reviews cascade via product_id / shop_id; delete in order so
      // FK constraints don't bite.
      await (db as any).deleteFrom('notifications').where('shop_id', 'in', [SHOP_A, SHOP_B]).execute()
      await (db as any).deleteFrom('product_reviews').where('shop_id', 'in', [SHOP_A, SHOP_B]).execute()
      await (db as any).deleteFrom('products').where('id', 'in', [PRODUCT_A, PRODUCT_B]).execute()
      await (db as any).deleteFrom('shops').where('id', 'in', [SHOP_A, SHOP_B]).execute()
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('cleanup failed', err)
    }
    await (db as any).destroy()
    process.exit(failed === 0 ? 0 : 1)
  })
