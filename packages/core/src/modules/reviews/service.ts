/**
 * Gbox Platform — Product Reviews Service
 *
 * Storefront product reviews: create, moderate, list, and aggregate stats.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { countProfanityHits } from './profanity.js'
import { getShopReviewSettings } from './settings.js'
import {
  sendReviewApproved,
  sendReviewReplied,
  type ReviewNotificationData,
  type ReviewReplyNotificationData,
} from '../email/service.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// 'spam' added in Phase 8 PR4 (migration 065). Reviews with
// computeSpamScore() >= SPAM_SCORE_THRESHOLD are auto-routed to 'spam'
// so they never appear in the pending moderation queue. Merchants can
// still filter the reviews page to status='spam' to manually recover
// false positives.
export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'spam'

export interface CreateReviewInput {
  customerId?: string | null
  authorName: string
  authorEmail: string
  rating: number // 1-5
  title?: string | null
  body: string
  status?: ReviewStatus
  /** Set by submitPublicReview; on the admin path we always leave this 0. */
  spamScore?: number
  /** Set by submitPublicReview when the shop's profanity filter is enabled. */
  profanityHits?: number
}

export interface ReviewStats {
  average: number
  count: number
  distribution: Record<1 | 2 | 3 | 4 | 5, number>
}

export interface Pagination {
  limit?: number
  offset?: number
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateRating(rating: number): void {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error('Rating must be an integer between 1 and 5')
  }
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Create a product review.
 */
export async function createReview(
  db: Kysely<Database>,
  shopId: string,
  productId: string,
  data: CreateReviewInput,
) {
  validateRating(data.rating)

  const review = await db
    .insertInto('product_reviews')
    .values({
      shop_id: shopId,
      product_id: productId,
      customer_id: data.customerId ?? null,
      author_name: data.authorName,
      author_email: data.authorEmail,
      rating: data.rating,
      title: data.title ?? null,
      body: data.body,
      status: data.status ?? 'pending',
      spam_score: data.spamScore ?? 0,
      profanity_hits: data.profanityHits ?? 0,
    } as any)
    .returningAll()
    .executeTakeFirstOrThrow()

  return review
}

/**
 * Get a single review by ID.
 */
export async function getReview(
  db: Kysely<Database>,
  reviewId: string,
) {
  const review = await db
    .selectFrom('product_reviews')
    .selectAll()
    .where('id', '=', reviewId)
    .executeTakeFirst()

  return review ?? null
}

/**
 * Update a review's moderation status.
 */
export async function updateReviewStatus(
  db: Kysely<Database>,
  reviewId: string,
  status: ReviewStatus,
) {
  const review = await db
    .updateTable('product_reviews')
    .set({ status, updated_at: new Date().toISOString() } as any)
    .where('id', '=', reviewId)
    .returningAll()
    .executeTakeFirstOrThrow()

  return review
}

/**
 * Delete a review permanently.
 */
export async function deleteReview(
  db: Kysely<Database>,
  reviewId: string,
): Promise<void> {
  await db
    .deleteFrom('product_reviews')
    .where('id', '=', reviewId)
    .execute()
}

/**
 * Get reviews for a product with optional status filter and pagination.
 * Also returns average rating.
 */
export async function getProductReviews(
  db: Kysely<Database>,
  productId: string,
  status?: ReviewStatus,
  pagination: Pagination = {},
) {
  const { limit = 20, offset = 0 } = pagination

  let query = db
    .selectFrom('product_reviews')
    .selectAll()
    .where('product_id', '=', productId)

  let countQuery = db
    .selectFrom('product_reviews')
    .select([
      db.fn.countAll<number>().as('count'),
      db.fn.avg<number>('rating').as('avg_rating'),
    ])
    .where('product_id', '=', productId)

  if (status) {
    query = query.where('status', '=', status)
    countQuery = countQuery.where('status', '=', status)
  }

  const [reviews, statsRow] = await Promise.all([
    query
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute(),
    countQuery.executeTakeFirstOrThrow(),
  ])

  return {
    reviews,
    total: Number(statsRow.count),
    avgRating: statsRow.avg_rating ? Number(Number(statsRow.avg_rating).toFixed(1)) : 0,
  }
}

/**
 * Get all reviews for a shop with optional status filter and pagination.
 */
export async function getShopReviews(
  db: Kysely<Database>,
  shopId: string,
  status?: ReviewStatus,
  pagination: Pagination = {},
) {
  const { limit = 50, offset = 0 } = pagination

  let query = db
    .selectFrom('product_reviews')
    .selectAll()
    .where('shop_id', '=', shopId)

  let countQuery = db
    .selectFrom('product_reviews')
    .select(db.fn.countAll<number>().as('count'))
    .where('shop_id', '=', shopId)

  if (status) {
    query = query.where('status', '=', status)
    countQuery = countQuery.where('status', '=', status)
  }

  const [reviews, countRow] = await Promise.all([
    query
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute(),
    countQuery.executeTakeFirstOrThrow(),
  ])

  return { reviews, total: Number(countRow.count) }
}

/**
 * Get aggregated review statistics for a product: average, count,
 * and 1-5 star distribution.
 */
export async function getReviewStats(
  db: Kysely<Database>,
  productId: string,
): Promise<ReviewStats> {
  // Overall stats
  const overall = await db
    .selectFrom('product_reviews')
    .select([
      db.fn.countAll<number>().as('count'),
      db.fn.avg<number>('rating').as('avg_rating'),
    ])
    .where('product_id', '=', productId)
    .where('status', '=', 'approved')
    .executeTakeFirstOrThrow()

  // Distribution by rating
  const distRows = await db
    .selectFrom('product_reviews')
    .select([
      'rating',
      db.fn.countAll<number>().as('count'),
    ])
    .where('product_id', '=', productId)
    .where('status', '=', 'approved')
    .groupBy('rating')
    .execute()

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<1 | 2 | 3 | 4 | 5, number>
  for (const row of distRows) {
    const r = row.rating as 1 | 2 | 3 | 4 | 5
    distribution[r] = Number(row.count)
  }

  return {
    average: overall.avg_rating ? Number(Number(overall.avg_rating).toFixed(1)) : 0,
    count: Number(overall.count),
    distribution,
  }
}

// ---------------------------------------------------------------------------
// Phase 8 PR4 — spam heuristic, public submission, merchant reply, bulk ops
// ---------------------------------------------------------------------------

/**
 * Reviews whose `computeSpamScore` lands >= this value are auto-routed
 * to status='spam' instead of 'pending' — they never hit the merchant's
 * moderation queue. Merchants can still filter to `status=spam` to
 * recover false positives.
 *
 * 80 is calibrated so a single light signal (e.g. one URL) can't flip
 * a review; the reviewer has to combine multiple red flags to clear
 * it. See `computeSpamScore` for the scoring table.
 */
export const SPAM_SCORE_THRESHOLD = 80

/**
 * Pure function: score review text 0..100 for spam-ness. Higher is
 * spammier. Completely stateless — takes the body/email/rating, returns
 * a number. No DB calls, no network — safe to run inside any request
 * handler without async overhead.
 *
 * Signals (cumulative, capped at 100):
 *
 *   URL count (multiple links is the strongest spam signal):
 *     - 0 URLs  →  +0
 *     - 1 URL   →  +25
 *     - 2 URLs  →  +55
 *     - 3+ URLs →  +80
 *
 *   ALL-CAPS ratio (>= 50% caps and body >= 20 chars):
 *     - +15
 *
 *   Body too short (< 10 non-space chars):
 *     - +20
 *
 *   Spam keyword present (casino / viagra / crypto-sell / buy-now-
 *   discount / click-here patterns):
 *     - +20 per match, capped at +40
 *
 *   Email domain in a known junk list (test.com / mailinator):
 *     - +10
 *
 *   Rating is 1 and body is <= 20 chars (drive-by one-star troll):
 *     - +10
 *
 * The thresholds reject ~90% of the real junk we've seen in production
 * without flagging legitimate short positive reviews ("Love it!" at 5
 * stars scores 20 — nowhere near the spam cutoff).
 */
export function computeSpamScore(
  body: string,
  authorEmail: string,
  rating: number,
): number {
  let score = 0
  const safeBody = typeof body === 'string' ? body : ''

  // URL count — look for http:// https:// and bare www. domains.
  const urlMatches = safeBody.match(
    /(?:https?:\/\/|www\.)[^\s<>"'`]{3,}/gi,
  )
  const urlCount = urlMatches ? urlMatches.length : 0
  if (urlCount === 1) score += 25
  else if (urlCount === 2) score += 55
  else if (urlCount >= 3) score += 80

  // ALL-CAPS ratio only meaningful once body is long enough to matter.
  const letters = safeBody.replace(/[^A-Za-z]/g, '')
  if (letters.length >= 20) {
    const capLetters = safeBody.replace(/[^A-Z]/g, '').length
    if (capLetters / letters.length >= 0.5) score += 15
  }

  // Body too short.
  const nonSpace = safeBody.replace(/\s+/g, '')
  if (nonSpace.length < 10) score += 20

  // Spam keywords.
  const SPAM_WORDS = /\b(casino|viagra|crypto|buy\s+now|click\s+here|free\s+bitcoin|discount\s+code|promo\s+code)\b/gi
  const wordHits = safeBody.match(SPAM_WORDS)
  if (wordHits) score += Math.min(40, wordHits.length * 20)

  // Junk email domain.
  const junkDomain = /@(test|mailinator|example)\.(com|net|org)$/i
  if (typeof authorEmail === 'string' && junkDomain.test(authorEmail)) {
    score += 10
  }

  // Drive-by one-star troll: rating=1 + extremely short body.
  if (rating === 1 && nonSpace.length <= 20) score += 10

  return Math.max(0, Math.min(100, score))
}

/**
 * Submit a review from the storefront. Wraps `createReview` with:
 *
 *   1. Spam scoring via `computeSpamScore`.
 *   2. Profanity scoring via the shop's effective lexicon
 *      (`shop_review_settings.profanity_extra_terms` + built-in EN+VI).
 *   3. Auto-routing:
 *        score >= SPAM_SCORE_THRESHOLD           → status='spam'
 *        profanity_hits > 0 && filter enabled    → status='pending'
 *        otherwise                               → 'pending'
 *      (Profanity-hitting reviews are never auto-approved; they wait
 *      for manual moderation instead of going straight to 'spam'.)
 *   4. Persisting both scores on the row so the admin list can sort
 *      / filter + render a flag badge.
 *
 * Returns the created review row — the caller (storefront handler)
 * typically only exposes `{ id, status }` back to the customer so they
 * know whether to expect moderation.
 */
export async function submitPublicReview(
  db: Kysely<Database>,
  shopId: string,
  productId: string,
  input: Omit<CreateReviewInput, 'status' | 'spamScore' | 'profanityHits'>,
) {
  const score = computeSpamScore(input.body, input.authorEmail, input.rating)

  // Profanity scoring — tolerant of DB hiccups: if the settings query
  // fails, we still accept the review rather than 500ing the submit.
  let profanityHits = 0
  try {
    const settings = await getShopReviewSettings(db, shopId)
    if (settings.profanityFilterEnabled) {
      const body = input.body ?? ''
      const title = input.title ?? ''
      profanityHits =
        countProfanityHits(body, settings.profanityExtraTerms) +
        countProfanityHits(title, settings.profanityExtraTerms)
    }
  } catch {
    profanityHits = 0
  }

  const status: ReviewStatus =
    score >= SPAM_SCORE_THRESHOLD ? 'spam' : 'pending'

  return createReview(db, shopId, productId, {
    ...input,
    status,
    spamScore: score,
    profanityHits,
  })
}

/**
 * Merchant replies to a review. Sets `reply_body`, `reply_author`,
 * `replied_at`. Pass `replyBody=null` to clear an existing reply.
 * Returns the updated row.
 */
export async function setReviewReply(
  db: Kysely<Database>,
  reviewId: string,
  replyBody: string | null,
  replyAuthor: string | null,
) {
  const trimmed = replyBody == null ? null : String(replyBody).trim()
  const author = trimmed == null ? null : (replyAuthor ?? null)
  const at = trimmed == null ? null : new Date().toISOString()

  const review = await db
    .updateTable('product_reviews')
    .set({
      reply_body: trimmed,
      reply_author: author,
      replied_at: at,
      updated_at: new Date().toISOString(),
    } as any)
    .where('id', '=', reviewId)
    .returningAll()
    .executeTakeFirstOrThrow()

  return review
}

/**
 * Bulk moderation: update the status of many reviews at once.
 * Shop-scoped to defend against a merchant passing IDs they don't own
 * (the WHERE filters by shop_id as well as the id set). Returns the
 * number of rows actually updated.
 *
 * Empty id array is a no-op (returns 0) — the service doesn't throw so
 * callers can safely pass whatever the form sent up, including empty.
 */
export async function bulkUpdateReviewStatus(
  db: Kysely<Database>,
  shopId: string,
  reviewIds: string[],
  status: ReviewStatus,
): Promise<number> {
  if (!Array.isArray(reviewIds) || reviewIds.length === 0) return 0

  const result = await db
    .updateTable('product_reviews')
    .set({ status, updated_at: new Date().toISOString() } as any)
    .where('shop_id', '=', shopId)
    .where('id', 'in', reviewIds)
    .executeTakeFirst()

  // Kysely returns numUpdatedRows as bigint on some drivers; coerce.
  return Number((result as any)?.numUpdatedRows ?? 0)
}

/**
 * Merchant reply struct returned to the storefront alongside a review.
 * Broken out so the storefront doesn't need to know about every column
 * on product_reviews.
 */
export interface ReviewReply {
  body: string
  author: string | null
  repliedAt: string
}

/**
 * Pick the reply fields off a review row and return a narrow struct,
 * or null if the review hasn't been replied to. Keeps the public-facing
 * shape small + intentional.
 */
export function extractReply(row: {
  reply_body?: string | null
  reply_author?: string | null
  replied_at?: string | null
}): ReviewReply | null {
  if (!row || !row.reply_body || !row.replied_at) return null
  return {
    body: row.reply_body,
    author: row.reply_author ?? null,
    repliedAt: row.replied_at,
  }
}

// ---------------------------------------------------------------------------
// Phase 10 PR3 — notification-aware wrappers
// ---------------------------------------------------------------------------

/**
 * Optional extras for the approval/reply notification emails. The admin
 * handler passes in the product's slug / shop display name so we don't
 * have to re-query them here. Any missing field degrades gracefully to
 * a sensible placeholder.
 */
export interface ReviewNotificationContext {
  productTitle?: string
  productUrl?: string
  shopName?: string
  replyAuthor?: string | null
  /** If false, suppresses notification regardless of shop setting. */
  notify?: boolean
}

async function resolveNotificationPayload(
  db: Kysely<Database>,
  review: {
    shop_id: string
    product_id: string
    rating: number
    title: string | null
    body: string
    author_name: string
    author_email: string
  },
  ctx: ReviewNotificationContext,
): Promise<ReviewNotificationData | null> {
  if (!review.author_email) return null

  let productTitle = ctx.productTitle
  let productUrl = ctx.productUrl
  if (!productTitle || !productUrl) {
    const product = await db
      .selectFrom('products')
      .select(['title', 'slug'])
      .where('id', '=', review.product_id)
      .executeTakeFirst()
    if (product) {
      productTitle = productTitle ?? product.title ?? 'your recent purchase'
      productUrl =
        productUrl ??
        `${process.env.STOREFRONT_URL ?? ''}/products/${product.slug ?? ''}`
    }
  }

  let shopName = ctx.shopName
  if (!shopName) {
    const shop = await db
      .selectFrom('shops')
      .select(['name'])
      .where('id', '=', review.shop_id)
      .executeTakeFirst()
    shopName = shop?.name ?? 'the shop'
  }

  return {
    rating: Number(review.rating) || 0,
    title: review.title ?? null,
    body: review.body ?? '',
    authorName: review.author_name,
    authorEmail: review.author_email,
    productTitle: productTitle ?? 'your recent purchase',
    productUrl: productUrl ?? '#',
    shopName: shopName ?? 'the shop',
  }
}

/**
 * Approve (or re-approve) a review + fire the "your review is live"
 * email to the reviewer — only if the shop has
 * `notify_customer_on_approve` on AND `ctx.notify !== false`. The email
 * failure is swallowed so the moderation action still succeeds from the
 * admin's point of view.
 */
export async function approveReview(
  db: Kysely<Database>,
  reviewId: string,
  ctx: ReviewNotificationContext = {},
) {
  const review = await updateReviewStatus(db, reviewId, 'approved')

  if (ctx.notify === false) return review
  try {
    const settings = await getShopReviewSettings(db, review.shop_id)
    if (!settings.notifyCustomerOnApprove) return review
    const payload = await resolveNotificationPayload(db, review as any, ctx)
    if (!payload) return review
    // PR2 commit 11: reviewId powers idempotency in sendReviewApproved —
    // re-approval / unapprove-then-approve cycles don't spam the reviewer.
    await sendReviewApproved(db, review.shop_id, { ...payload, reviewId })
  } catch {
    // Iron rule 5: notification failures never surface to the merchant.
  }
  return review
}

/**
 * Post a merchant reply + fire the "{{shop}} replied to your review"
 * email. Uses the shop's `notify_customer_on_reply` toggle. Passing
 * `replyBody=null` clears the reply and skips the email.
 */
export async function replyToReview(
  db: Kysely<Database>,
  reviewId: string,
  replyBody: string | null,
  replyAuthor: string | null,
  ctx: ReviewNotificationContext = {},
) {
  const review = await setReviewReply(db, reviewId, replyBody, replyAuthor)

  if (!replyBody || ctx.notify === false) return review
  try {
    const settings = await getShopReviewSettings(db, review.shop_id)
    if (!settings.notifyCustomerOnReply) return review
    const payload = await resolveNotificationPayload(db, review as any, ctx)
    if (!payload) return review
    // PR2 commit 11 added `reviewId` to ReviewNotificationData for
    // idempotency — commit 12 uses it in sendReviewReplied, this line
    // keeps the type-spread compiling in the interim.
    const full: ReviewReplyNotificationData = {
      ...payload,
      reviewId,
      replyBody,
      replyAuthor: replyAuthor ?? ctx.replyAuthor ?? null,
    }
    await sendReviewReplied(db, review.shop_id, full)
  } catch {
    // Iron rule 5.
  }
  return review
}
