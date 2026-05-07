/**
 * Gbox Platform — Reviews API Routes
 *
 * REST endpoints for product reviews: public storefront access and admin moderation.
 *
 * Public:
 *   GET  /api/2026-04/products/:product_id/reviews.json
 *   POST /api/2026-04/products/:product_id/reviews.json
 *
 * Admin:
 *   GET    /api/2026-04/reviews.json
 *   PUT    /api/2026-04/reviews/:id.json
 *   DELETE /api/2026-04/reviews/:id.json
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import * as ReviewService from '@gbox/core/modules/reviews/service.js'
import {
  addReviewPhoto,
  listReviewPhotos,
  ReviewPhotoLimitError,
} from '@gbox/core/modules/reviews/photos.js'
import {
  submitReviewVote,
  getReviewVotes,
  removeReviewVote,
  hashVoterFingerprint,
  type VoteValue,
} from '@gbox/core/modules/reviews/votes.js'
import { resolveVoteSalt } from '@gbox/core/modules/reviews/settings.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(message: string, status: number): Response {
  return json({ errors: [message] }, status)
}

function parsePagination(url: URL) {
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 250)
  const page = Math.max(Number(url.searchParams.get('page') ?? 1), 1)
  return { limit, offset: (page - 1) * limit }
}

// ---------------------------------------------------------------------------
// GET /api/2026-04/products/:product_id/reviews.json  (public, approved only)
// ---------------------------------------------------------------------------

export async function listProductReviews(
  request: Request,
  db: Kysely<Database>,
  _shopId: string,
  productId: string,
): Promise<Response> {
  try {
    const url = new URL(request.url)
    const pagination = parsePagination(url)

    const result = await ReviewService.getProductReviews(
      db,
      productId,
      'approved',
      pagination,
    )

    const stats = await ReviewService.getReviewStats(db, productId)

    return json({
      reviews: result.reviews,
      total: result.total,
      avg_rating: result.avgRating,
      stats,
    })
  } catch (err) {
    return errorResponse('Failed to list reviews', 500)
  }
}

// ---------------------------------------------------------------------------
// POST /api/2026-04/products/:product_id/reviews.json  (public)
// ---------------------------------------------------------------------------

export async function createProductReview(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  productId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      review: {
        author_name?: string
        author_email?: string
        customer_id?: string | null
        rating?: number
        title?: string | null
        body?: string
      }
    }

    if (!body.review) {
      return errorResponse('Missing "review" in request body', 422)
    }

    const { review: r } = body

    if (!r.author_name || !r.author_email) {
      return errorResponse('author_name and author_email are required', 422)
    }

    if (!r.rating || r.rating < 1 || r.rating > 5) {
      return errorResponse('rating must be between 1 and 5', 422)
    }

    if (!r.body) {
      return errorResponse('body is required', 422)
    }

    // Phase 10 PR3 — go through submitPublicReview so profanity hits +
    // spam scores are stamped and the status is auto-routed.
    const review = await ReviewService.submitPublicReview(
      db,
      shopId,
      productId,
      {
        customerId: r.customer_id ?? null,
        authorName: r.author_name,
        authorEmail: r.author_email,
        rating: r.rating,
        title: r.title ?? null,
        body: r.body,
      },
    )

    return json({ review }, 201)
  } catch (err) {
    return errorResponse('Failed to create review', 500)
  }
}

// ---------------------------------------------------------------------------
// GET /api/2026-04/reviews.json  (admin — all reviews for shop)
// ---------------------------------------------------------------------------

export async function listShopReviews(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
): Promise<Response> {
  try {
    const url = new URL(request.url)
    const pagination = parsePagination(url)
    const status = url.searchParams.get('status') as ReviewService.ReviewStatus | null

    const result = await ReviewService.getShopReviews(
      db,
      shopId,
      status ?? undefined,
      pagination,
    )

    return json({ reviews: result.reviews, total: result.total })
  } catch (err) {
    return errorResponse('Failed to list reviews', 500)
  }
}

// ---------------------------------------------------------------------------
// PUT /api/2026-04/reviews/:id.json  (admin — update status)
// ---------------------------------------------------------------------------

export async function updateReview(
  request: Request,
  db: Kysely<Database>,
  _shopId: string,
  reviewId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      review: { status?: ReviewService.ReviewStatus }
    }

    if (!body.review?.status) {
      return errorResponse('Missing "review.status" in request body', 422)
    }

    const validStatuses: ReviewService.ReviewStatus[] = ['pending', 'approved', 'rejected']
    if (!validStatuses.includes(body.review.status)) {
      return errorResponse('status must be pending, approved, or rejected', 422)
    }

    const review = await ReviewService.updateReviewStatus(db, reviewId, body.review.status)
    return json({ review })
  } catch (err) {
    return errorResponse('Failed to update review', 500)
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/2026-04/reviews/:id.json  (admin)
// ---------------------------------------------------------------------------

export async function deleteReview(
  _request: Request,
  db: Kysely<Database>,
  _shopId: string,
  reviewId: string,
): Promise<Response> {
  try {
    await ReviewService.deleteReview(db, reviewId)
    return new Response(null, { status: 200 })
  } catch (err) {
    return errorResponse('Failed to delete review', 500)
  }
}

// ---------------------------------------------------------------------------
// Phase 10 PR3 — photos + votes endpoints
// ---------------------------------------------------------------------------

/**
 * Pick the client's IP out of the standard forwarding header chain.
 * Fallback to an empty string — the vote salt keeps hashes unique per
 * shop so two different shops can't collide even if the IP is absent.
 */
function extractClientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0]!.trim()
  return (
    request.headers.get('x-real-ip') ??
    request.headers.get('cf-connecting-ip') ??
    ''
  )
}

/**
 * GET /api/2026-04/reviews/:id/photos.json  (public)
 */
export async function listReviewPhotosHandler(
  _request: Request,
  db: Kysely<Database>,
  _shopId: string,
  reviewId: string,
): Promise<Response> {
  try {
    const photos = await listReviewPhotos(db, reviewId)
    return json({ photos })
  } catch {
    return errorResponse('Failed to list photos', 500)
  }
}

/**
 * POST /api/2026-04/reviews/:id/photos.json  (public — submit alongside review)
 *
 * Body: `{ photo: { url, storage_key?, width?, height? } }`. The caller
 * is expected to have uploaded the blob to storage already — we just
 * record the URL + optional metadata.
 */
export async function addReviewPhotoHandler(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  reviewId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      photo?: {
        url?: string
        storage_key?: string | null
        width?: number | null
        height?: number | null
      }
    }
    if (!body.photo?.url) {
      return errorResponse('photo.url is required', 422)
    }
    const row = await addReviewPhoto(db, reviewId, shopId, {
      url: body.photo.url,
      storageKey: body.photo.storage_key ?? null,
      width: body.photo.width ?? null,
      height: body.photo.height ?? null,
    })
    return json({ photo: row }, 201)
  } catch (err) {
    if (err instanceof ReviewPhotoLimitError) {
      return errorResponse(err.message, 409)
    }
    return errorResponse('Failed to attach photo', 500)
  }
}

/**
 * POST /api/2026-04/reviews/:id/votes.json  (public — helpful/unhelpful)
 *
 * Body: `{ vote: { value: 1 | -1, customer_id?: string } }`. Voter
 * fingerprint is hashed server-side from (IP + UA + per-shop salt); the
 * raw IP never touches the DB.
 */
export async function submitReviewVoteHandler(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  reviewId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      vote?: { value?: number; customer_id?: string | null }
    }
    const raw = body?.vote?.value
    if (raw !== 1 && raw !== -1) {
      return errorResponse('vote.value must be 1 or -1', 422)
    }
    const ip = extractClientIp(request)
    const ua = request.headers.get('user-agent') ?? ''
    const salt = resolveVoteSalt(shopId)
    const ipHash = hashVoterFingerprint(ip, ua, salt)

    const result = await submitReviewVote(db, reviewId, shopId, {
      customerId: body.vote?.customer_id ?? null,
      ipHash,
      value: raw as VoteValue,
    })
    const counts = await getReviewVotes(db, reviewId)
    return json({ vote: result, counts })
  } catch {
    return errorResponse('Failed to record vote', 500)
  }
}

/**
 * DELETE /api/2026-04/reviews/:id/votes.json  (public — withdraw vote)
 */
export async function removeReviewVoteHandler(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  reviewId: string,
): Promise<Response> {
  try {
    const ip = extractClientIp(request)
    const ua = request.headers.get('user-agent') ?? ''
    const salt = resolveVoteSalt(shopId)
    const ipHash = hashVoterFingerprint(ip, ua, salt)
    const result = await removeReviewVote(db, reviewId, ipHash)
    const counts = await getReviewVotes(db, reviewId)
    return json({ removed: result.removed, counts })
  } catch {
    return errorResponse('Failed to withdraw vote', 500)
  }
}
