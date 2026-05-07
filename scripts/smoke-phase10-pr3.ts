/**
 * Phase 10 PR3 — Reviews Polish (photos + votes + profanity + notifications).
 *
 * Runs against a live Postgres with migration 071 already applied.
 * From server 2 (local Windows can't reach the test DB on 192.168.1.13):
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase10-pr3.ts
 *
 * Coverage (assertions numbered below):
 *   Migration 071 shape
 *     [1]  product_reviews.helpful_count exists (int, default 0)
 *     [2]  product_reviews.unhelpful_count exists
 *     [3]  product_reviews.photos_count exists (smallint)
 *     [4]  product_reviews.profanity_hits exists (smallint)
 *     [5]  review_photos table exists
 *     [6]  review_votes table exists
 *     [7]  shop_review_settings table exists
 *     [8]  uq_review_votes_review_iphash UNIQUE index exists
 *     [9]  review_votes_value_check CHECK constraint exists
 *
 *   Photos service
 *     [10] addReviewPhoto persists + bumps photos_count
 *     [11] listReviewPhotos orders by position, created_at
 *     [12] deleteReviewPhoto decrements + returns storageKey
 *     [13] addReviewPhoto caps at MAX_PHOTOS_PER_REVIEW (throws on 9th)
 *
 *   Votes service
 *     [14] submitReviewVote inserts + bumps helpful_count
 *     [15] submitReviewVote flips the vote (helpful → unhelpful)
 *     [16] submitReviewVote no-op when re-submitting same value
 *     [17] UNIQUE (review_id, ip_hash) enforced by DB
 *     [18] removeReviewVote deletes + decrements
 *     [19] getReviewVotes returns current counts
 *
 *   Settings service
 *     [20] getShopReviewSettings returns defaults when no row
 *     [21] upsertShopReviewSettings inserts
 *     [22] upsertShopReviewSettings updates + preserves un-patched fields
 *     [23] resolveVoteSalt deterministic + per-shop
 *
 *   Profanity integration with submitPublicReview
 *     [24] clean review stamps profanity_hits = 0
 *     [25] profane review stamps profanity_hits > 0 + status='pending'
 *     [26] profanity filter disabled → profanity_hits = 0 even with profanity
 *     [27] Vietnamese profanity caught via NFD
 *     [28] extra terms from settings applied
 *
 *   Iron rule 5 audit
 *     [29] safeReviewSettingsMessage never leaks "god admin"
 *     [30] safeReviewSettingsMessage falls back to "Please contact Gbox support."
 *     [31] review-settings page src contains no "god admin" string
 *     [32] profanity module has no outbound network / DB imports
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createDb } from '../packages/db/src/index.js'
import {
  addReviewPhoto,
  listReviewPhotos,
  deleteReviewPhoto,
  MAX_PHOTOS_PER_REVIEW,
  ReviewPhotoLimitError,
} from '../packages/core/src/modules/reviews/photos.js'
import {
  submitReviewVote,
  getReviewVotes,
  removeReviewVote,
  hashVoterFingerprint,
} from '../packages/core/src/modules/reviews/votes.js'
import {
  getShopReviewSettings,
  upsertShopReviewSettings,
  resolveVoteSalt,
} from '../packages/core/src/modules/reviews/settings.js'
import { submitPublicReview } from '../packages/core/src/modules/reviews/service.js'
// Iron rule 5 helper imported from the dep-free lib (same pattern as PR2)
// so the smoke import graph doesn't drag in the full admin server tree.
import { safeReviewSettingsMessage } from '../apps/store-admin/src/lib/review-settings-flash.js'

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_A = randomUUID()
const SHOP_B = randomUUID()
const PRODUCT_A = randomUUID()
const REVIEW_A = randomUUID()
const REVIEW_B = randomUUID()

let total = 0
let failed = 0
function log(s: string) {
  // eslint-disable-next-line no-console
  console.log(s)
}
function assert(cond: boolean, msg: string) {
  total++
  if (cond) log(`  OK   ${msg}`)
  else {
    failed++
    log(`  FAIL ${msg}`)
  }
}

async function main() {
  log(`\n=== Phase 10 PR3 smoke — suffix=${SUFFIX} ===\n`)

  // -------------------------------------------------------------------------
  // Seed: two shops + product + review rows we can attach photos/votes to.
  // -------------------------------------------------------------------------
  log('[0] Seeding shops + product + reviews')
  await (db as any)
    .insertInto('shops')
    .values([
      {
        id: SHOP_A,
        slug: `smoke-p10-3-a-${SUFFIX}`,
        name: 'PR3 Shop A',
        email: `p10-3-a-${SUFFIX}@example.test`,
        status: 'active',
        plan: 'free',
      },
      {
        id: SHOP_B,
        slug: `smoke-p10-3-b-${SUFFIX}`,
        name: 'PR3 Shop B',
        email: `p10-3-b-${SUFFIX}@example.test`,
        status: 'active',
        plan: 'free',
      },
    ])
    .execute()

  await (db as any)
    .insertInto('products')
    .values({
      id: PRODUCT_A,
      shop_id: SHOP_A,
      title: 'PR3 Demo Product',
      slug: `pr3-demo-${SUFFIX}`,
      status: 'active',
    })
    .execute()

  await (db as any)
    .insertInto('product_reviews')
    .values([
      {
        id: REVIEW_A,
        shop_id: SHOP_A,
        product_id: PRODUCT_A,
        author_name: 'Alice',
        author_email: 'alice@example.test',
        rating: 5,
        body: 'seed review',
        status: 'approved',
      },
      {
        id: REVIEW_B,
        shop_id: SHOP_A,
        product_id: PRODUCT_A,
        author_name: 'Bob',
        author_email: 'bob@example.test',
        rating: 4,
        body: 'seed review 2',
        status: 'approved',
      },
    ])
    .execute()

  try {
    // ---------------------------------------------------------------------
    // [1..9] Migration 071 shape
    // ---------------------------------------------------------------------
    log('\n[1..9] Migration 071 shape')

    const prCols = await (db as any)
      .selectFrom('information_schema.columns' as any)
      .where('table_name', '=', 'product_reviews')
      .select(['column_name', 'column_default', 'data_type', 'is_nullable'])
      .execute()
    const byPr = new Map<string, any>(prCols.map((c: any) => [c.column_name, c]))
    assert(byPr.has('helpful_count'), '[1] product_reviews.helpful_count')
    assert(byPr.has('unhelpful_count'), '[2] product_reviews.unhelpful_count')
    assert(
      byPr.has('photos_count') && byPr.get('photos_count').data_type === 'smallint',
      '[3] product_reviews.photos_count smallint',
    )
    assert(
      byPr.has('profanity_hits') && byPr.get('profanity_hits').data_type === 'smallint',
      '[4] product_reviews.profanity_hits smallint',
    )

    async function tableExists(name: string): Promise<boolean> {
      const rows = await (db as any)
        .selectFrom('information_schema.tables' as any)
        .where('table_name', '=', name)
        .select(['table_name'])
        .execute()
      return rows.length > 0
    }
    assert(await tableExists('review_photos'), '[5] review_photos table exists')
    assert(await tableExists('review_votes'), '[6] review_votes table exists')
    assert(
      await tableExists('shop_review_settings'),
      '[7] shop_review_settings table exists',
    )

    async function indexExists(name: string): Promise<boolean> {
      const rows = await (db as any)
        .selectFrom('pg_indexes' as any)
        .where('indexname', '=', name)
        .select(['indexname'])
        .execute()
      return rows.length > 0
    }
    assert(
      await indexExists('uq_review_votes_review_iphash'),
      '[8] UNIQUE uq_review_votes_review_iphash',
    )

    const checkExists = await (db as any)
      .selectFrom('information_schema.check_constraints' as any)
      .where('constraint_name', '=', 'review_votes_value_check')
      .select(['constraint_name'])
      .execute()
    assert(checkExists.length > 0, '[9] review_votes_value_check constraint')

    // ---------------------------------------------------------------------
    // [10..13] Photos service
    // ---------------------------------------------------------------------
    log('\n[10..13] Photos service')

    const photo1 = await addReviewPhoto(db as any, REVIEW_A, SHOP_A, {
      url: 'https://cdn.example/p1.jpg',
      storageKey: 'k1',
    })
    const afterOne = await (db as any)
      .selectFrom('product_reviews')
      .select(['photos_count'])
      .where('id', '=', REVIEW_A)
      .executeTakeFirst()
    assert(
      !!photo1.id && Number(afterOne.photos_count) === 1,
      '[10] addReviewPhoto bumps photos_count to 1',
    )

    await addReviewPhoto(db as any, REVIEW_A, SHOP_A, {
      url: 'https://cdn.example/p2.jpg',
      position: 0,
    })
    await addReviewPhoto(db as any, REVIEW_A, SHOP_A, {
      url: 'https://cdn.example/p3.jpg',
      position: 2,
    })

    const listed = await listReviewPhotos(db as any, REVIEW_A)
    assert(
      listed.length === 3 &&
        Number(listed[0].position) <= Number(listed[1].position) &&
        Number(listed[1].position) <= Number(listed[2].position),
      '[11] listReviewPhotos ordered by position ASC',
    )

    const delRes = await deleteReviewPhoto(db as any, photo1.id)
    const afterDel = await (db as any)
      .selectFrom('product_reviews')
      .select(['photos_count'])
      .where('id', '=', REVIEW_A)
      .executeTakeFirst()
    assert(
      !!delRes && delRes.storageKey === 'k1' && Number(afterDel.photos_count) === 2,
      '[12] deleteReviewPhoto returns storageKey + decrements counter',
    )

    // Fill to MAX then attempt one more → throws ReviewPhotoLimitError.
    for (let i = 0; i < MAX_PHOTOS_PER_REVIEW - 2; i++) {
      await addReviewPhoto(db as any, REVIEW_A, SHOP_A, {
        url: `https://cdn.example/cap-${i}.jpg`,
      })
    }
    let capThrown = false
    try {
      await addReviewPhoto(db as any, REVIEW_A, SHOP_A, {
        url: 'https://cdn.example/over.jpg',
      })
    } catch (err) {
      capThrown = err instanceof ReviewPhotoLimitError
    }
    assert(capThrown, '[13] addReviewPhoto throws at MAX_PHOTOS_PER_REVIEW')

    // ---------------------------------------------------------------------
    // [14..19] Votes service
    // ---------------------------------------------------------------------
    log('\n[14..19] Votes service')

    const salt = resolveVoteSalt(SHOP_A)
    const ip1 = hashVoterFingerprint('10.0.0.1', 'mozilla/1.0', salt)
    const ip2 = hashVoterFingerprint('10.0.0.2', 'mozilla/1.0', salt)

    const v1 = await submitReviewVote(db as any, REVIEW_B, SHOP_A, {
      ipHash: ip1,
      value: 1,
    })
    const counts1 = await getReviewVotes(db as any, REVIEW_B)
    assert(
      v1.changed && v1.newValue === 1 && counts1.helpful === 1 && counts1.unhelpful === 0,
      '[14] submitReviewVote inserts + bumps helpful_count',
    )

    const v2 = await submitReviewVote(db as any, REVIEW_B, SHOP_A, {
      ipHash: ip1,
      value: -1,
    })
    const counts2 = await getReviewVotes(db as any, REVIEW_B)
    assert(
      v2.changed &&
        v2.previousValue === 1 &&
        v2.newValue === -1 &&
        counts2.helpful === 0 &&
        counts2.unhelpful === 1,
      '[15] submitReviewVote flips counters on vote flip',
    )

    const v3 = await submitReviewVote(db as any, REVIEW_B, SHOP_A, {
      ipHash: ip1,
      value: -1,
    })
    const counts3 = await getReviewVotes(db as any, REVIEW_B)
    assert(
      !v3.changed && counts3.unhelpful === 1,
      '[16] submitReviewVote no-op on identical re-vote',
    )

    // Second voter fresh vote.
    await submitReviewVote(db as any, REVIEW_B, SHOP_A, {
      ipHash: ip2,
      value: 1,
    })
    let duplicateRejected = false
    try {
      await (db as any)
        .insertInto('review_votes')
        .values({
          id: randomUUID(),
          review_id: REVIEW_B,
          shop_id: SHOP_A,
          ip_hash: ip1, // already exists
          value: 1,
        })
        .execute()
    } catch {
      duplicateRejected = true
    }
    assert(
      duplicateRejected,
      '[17] UNIQUE(review_id, ip_hash) rejects duplicate insert',
    )

    const r1 = await removeReviewVote(db as any, REVIEW_B, ip1)
    const countsAfterRemove = await getReviewVotes(db as any, REVIEW_B)
    assert(
      r1.removed && countsAfterRemove.unhelpful === 0,
      '[18] removeReviewVote decrements counter',
    )

    const finalCounts = await getReviewVotes(db as any, REVIEW_B)
    assert(
      finalCounts.helpful === 1,
      '[19] getReviewVotes returns surviving counts',
    )

    // ---------------------------------------------------------------------
    // [20..23] Settings service
    // ---------------------------------------------------------------------
    log('\n[20..23] Settings service')

    const freshShopId = randomUUID()
    await (db as any)
      .insertInto('shops')
      .values({
        id: freshShopId,
        slug: `smoke-p10-3-c-${SUFFIX}`,
        name: 'PR3 Shop C',
        email: `p10-3-c-${SUFFIX}@example.test`,
        status: 'active',
        plan: 'free',
      })
      .execute()

    const defaults = await getShopReviewSettings(db as any, freshShopId)
    assert(
      defaults.profanityFilterEnabled === true &&
        defaults.profanityExtraTerms.length === 0 &&
        defaults.notifyCustomerOnApprove === true &&
        defaults.notifyCustomerOnReply === true,
      '[20] getShopReviewSettings returns defaults when no row',
    )

    const inserted = await upsertShopReviewSettings(db as any, freshShopId, {
      profanityFilterEnabled: false,
      profanityExtraTerms: ['spammy-word'],
    })
    assert(
      inserted.profanityFilterEnabled === false &&
        inserted.profanityExtraTerms.includes('spammy-word'),
      '[21] upsertShopReviewSettings inserts + persists patch',
    )

    const updated = await upsertShopReviewSettings(db as any, freshShopId, {
      notifyCustomerOnApprove: false,
    })
    assert(
      updated.notifyCustomerOnApprove === false &&
        updated.profanityFilterEnabled === false &&
        updated.profanityExtraTerms.includes('spammy-word'),
      '[22] upsertShopReviewSettings preserves un-patched fields',
    )

    assert(
      resolveVoteSalt(SHOP_A) === resolveVoteSalt(SHOP_A) &&
        resolveVoteSalt(SHOP_A) !== resolveVoteSalt(SHOP_B) &&
        /^[a-f0-9]{64}$/.test(resolveVoteSalt(SHOP_A)),
      '[23] resolveVoteSalt deterministic + per-shop + 64-char hex',
    )

    // Clean up the throwaway shop.
    await (db as any).deleteFrom('shop_review_settings').where('shop_id', '=', freshShopId).execute()
    await (db as any).deleteFrom('shops').where('id', '=', freshShopId).execute()

    // ---------------------------------------------------------------------
    // [24..28] Profanity integration with submitPublicReview
    // ---------------------------------------------------------------------
    log('\n[24..28] Profanity integration')

    // Ensure SHOP_A has default settings (filter on, no extras).
    await upsertShopReviewSettings(db as any, SHOP_A, {
      profanityFilterEnabled: true,
      profanityExtraTerms: [],
    })

    const clean = await submitPublicReview(db as any, SHOP_A, PRODUCT_A, {
      authorName: 'Nice',
      authorEmail: 'nice@example.test',
      rating: 5,
      body: 'Lovely product, shipped fast.',
    })
    assert(
      Number((clean as any).profanity_hits ?? 0) === 0,
      '[24] clean submission → profanity_hits = 0',
    )

    const dirty = await submitPublicReview(db as any, SHOP_A, PRODUCT_A, {
      authorName: 'Rude',
      authorEmail: 'rude@example.test',
      rating: 1,
      body: 'This is total bullshit and the seller is a scam',
    })
    assert(
      Number((dirty as any).profanity_hits ?? 0) >= 2 && (dirty as any).status === 'pending',
      '[25] profane submission → profanity_hits > 0 + status pending',
    )

    // Disable the filter, same body → hits = 0.
    await upsertShopReviewSettings(db as any, SHOP_A, {
      profanityFilterEnabled: false,
    })
    const disabled = await submitPublicReview(db as any, SHOP_A, PRODUCT_A, {
      authorName: 'Rude2',
      authorEmail: 'rude2@example.test',
      rating: 1,
      body: 'This is total bullshit and the seller is a scam',
    })
    assert(
      Number((disabled as any).profanity_hits ?? 0) === 0,
      '[26] filter disabled → profanity_hits stays 0',
    )

    // Re-enable filter, submit Vietnamese with diacritics.
    await upsertShopReviewSettings(db as any, SHOP_A, {
      profanityFilterEnabled: true,
    })
    const vi = await submitPublicReview(db as any, SHOP_A, PRODUCT_A, {
      authorName: 'Khach',
      authorEmail: 'khach@example.test',
      rating: 1,
      body: 'đụ má sản phẩm này, vcl',
    })
    assert(
      Number((vi as any).profanity_hits ?? 0) >= 1,
      '[27] Vietnamese profanity caught with diacritics',
    )

    // Extra term from settings.
    await upsertShopReviewSettings(db as any, SHOP_A, {
      profanityExtraTerms: ['yolobrand'],
    })
    const extra = await submitPublicReview(db as any, SHOP_A, PRODUCT_A, {
      authorName: 'Extra',
      authorEmail: 'extra@example.test',
      rating: 2,
      body: 'YoloBrand is terrible, would not recommend',
    })
    assert(
      Number((extra as any).profanity_hits ?? 0) >= 1,
      '[28] extra_terms from settings matched',
    )

    // ---------------------------------------------------------------------
    // [29..32] Iron rule 5 audit
    // ---------------------------------------------------------------------
    log('\n[29..32] Iron rule 5 audit')

    const m1 = safeReviewSettingsMessage(new Error('Some internal god admin stack trace'))
    assert(!m1.toLowerCase().includes('god'), '[29] safe message never leaks "god admin"')
    assert(
      m1 === 'Please contact Gbox support.',
      '[30] safe message falls back to Gbox support copy',
    )

    const __filename = fileURLToPath(import.meta.url)
    const __dirname = dirname(__filename)
    const settingsSrc = readFileSync(
      join(__dirname, '..', 'apps', 'store-admin', 'src', 'pages', 'review-settings.ts'),
      'utf8',
    )
    assert(
      !/god[-_ ]?admin/i.test(settingsSrc),
      '[31] review-settings.ts src free of "god admin"',
    )

    const profanitySrc = readFileSync(
      join(__dirname, '..', 'packages', 'core', 'src', 'modules', 'reviews', 'profanity.ts'),
      'utf8',
    )
    assert(
      !/fetch\(|http:|https:|kysely|Kysely|createDb|sendMail|nodemailer/.test(profanitySrc),
      '[32] profanity.ts is pure (no network/DB/mail imports)',
    )

    log(`\n===============================`)
    log(`   ${total - failed}/${total} assertions passed`)
    log(`===============================\n`)
  } finally {
    // ---------------------------------------------------------------------
    // Cleanup — cascade from shops. product_reviews + review_photos
    // + review_votes + shop_review_settings all cascade via FK.
    // ---------------------------------------------------------------------
    log('[cleanup] Dropping seeded shops (cascades everything)')
    await (db as any)
      .deleteFrom('shops')
      .where('id', 'in', [SHOP_A, SHOP_B])
      .execute()
  }

  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('FATAL', err)
  process.exit(1)
})
