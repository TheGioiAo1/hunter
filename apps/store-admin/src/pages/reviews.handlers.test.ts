/**
 * Store Admin — Reviews page handlers (Phase 8 PR4e, updated Phase 10 PR3).
 *
 * Covers the thin Express handlers that wrap the reviews service:
 *
 *   - postReply(req, res, db)      — /reviews/:id/reply
 *   - postBulkAction(req, res, db) — /reviews/bulk
 *
 * The service layer (replyToReview, bulkUpdateReviewStatus) already has
 * its own coverage in packages/core/src/modules/reviews/moderation.test.ts,
 * so the tests here focus on the parts the handler owns:
 *
 *   - form-body coercion (clear flag, review_ids[] vs solo)
 *   - shop-scope guard on the reply path (prevents a merchant from
 *     editing a review that belongs to a different tenant)
 *   - action routing (approve/reject/spam/delete → right service call)
 *   - redirect URLs honour success/error query parameters
 *   - iron-rule-5: no god-admin mentions leak into redirect copy
 *
 * Phase 10 PR3 — the admin reply handler now calls `replyToReview`
 * instead of `setReviewReply` so the `notify_customer_on_reply` setting
 * + email template can kick in. The signature is 5-arg:
 *   (db, reviewId, replyBody, replyAuthor, { shopName }?)
 * so the old 4-arg assertion on `setReviewReply` needed a refresh.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { postReply, postBulkAction } from './reviews.js'

// ---------------------------------------------------------------------------
// Mock the service module so we can assert exactly which calls happened
// ---------------------------------------------------------------------------

vi.mock('@gbox/core/modules/reviews/service.js', () => ({
  replyToReview: vi.fn(async () => ({ id: 'r-1' })),
  setReviewReply: vi.fn(async () => ({ id: 'r-1' })),
  bulkUpdateReviewStatus: vi.fn(async () => 3),
  getReview: vi.fn(async () => ({ id: 'r-1', shop_id: 'shop-1' })),
  deleteReview: vi.fn(async () => undefined),
  updateReviewStatus: vi.fn(async () => ({ id: 'r-1' })),
  approveReview: vi.fn(async () => ({ id: 'r-1' })),
  getShopReviews: vi.fn(async () => ({ reviews: [], total: 0 })),
}))
vi.mock('../lib/notify.js', () => ({
  notify: vi.fn(),
  byActor: vi.fn(() => 'by Thai'),
}))

import {
  replyToReview,
  bulkUpdateReviewStatus,
  getReview,
  deleteReview,
} from '@gbox/core/modules/reviews/service.js'

function makeReq(opts: {
  shopId?: string
  slug?: string
  body?: any
  params?: any
}) {
  return {
    store: { id: opts.shopId ?? 'shop-1', slug: opts.slug ?? 'acme', name: 'Acme' },
    storeUser: { id: 'user-1', name: 'Thai', email: 'thai@gbox.co' },
    params: opts.params ?? {},
    body: opts.body ?? {},
  } as any
}

function makeRes() {
  const res: any = { _redirect: null }
  res.redirect = vi.fn((url: string) => {
    res._redirect = url
    return res
  })
  return res
}

/**
 * Fake DB shaped like a Kysely instance — handlers detect DB mode via
 * `typeof db.selectFrom === 'function'`, so a stub function is enough to
 * route into the DB code path. Without this the handler would fall into
 * the API mode (createApiContext + remote BE) which the mocks don't cover.
 */
function makeDb() {
  return { selectFrom: () => ({}) } as any
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ===========================================================================
// postReply
// ===========================================================================

describe('postReply', () => {
  it('calls replyToReview with the form body text + shop context', async () => {
    const req = makeReq({
      params: { reviewId: 'r-1' },
      body: { reply_body: 'Thanks for the feedback!' },
    })
    const res = makeRes()
    const db = makeDb()
    await postReply(req, res, db)
    expect(replyToReview).toHaveBeenCalledWith(
      db,
      'r-1',
      'Thanks for the feedback!',
      'Thai',
      { shopName: 'Acme' },
    )
    expect(res._redirect).toContain('success=reply_posted')
  })

  it('clears the reply when clear=1', async () => {
    const req = makeReq({
      params: { reviewId: 'r-1' },
      body: { reply_body: 'will be ignored', clear: '1' },
    })
    const res = makeRes()
    await postReply(req, res, makeDb())
    expect(replyToReview).toHaveBeenCalledWith(
      expect.anything(),
      'r-1',
      null,
      null,
      { shopName: 'Acme' },
    )
    expect(res._redirect).toContain('success=reply_cleared')
  })

  it('rejects cross-tenant IDs (review belongs to a different shop)', async () => {
    ;(getReview as any).mockResolvedValueOnce({ id: 'r-1', shop_id: 'shop-other' })
    const req = makeReq({
      params: { reviewId: 'r-1' },
      body: { reply_body: 'nope' },
    })
    const res = makeRes()
    await postReply(req, res, makeDb())
    expect(replyToReview).not.toHaveBeenCalled()
    expect(res._redirect).toContain('error=')
    // Iron rule 5 — never mention god-admin in seller UI copy.
    expect(res._redirect?.toLowerCase()).not.toContain('god')
  })

  it('redirects with a 404-ish error when the review is missing', async () => {
    ;(getReview as any).mockResolvedValueOnce(null)
    const req = makeReq({ params: { reviewId: 'r-missing' }, body: {} })
    const res = makeRes()
    await postReply(req, res, makeDb())
    expect(replyToReview).not.toHaveBeenCalled()
    expect(res._redirect).toContain('error=')
  })
})

// ===========================================================================
// postBulkAction
// ===========================================================================

describe('postBulkAction', () => {
  it('routes action=approve → bulkUpdateReviewStatus("approved")', async () => {
    const req = makeReq({
      body: { action: 'approve', review_ids: ['r-1', 'r-2', 'r-3'] },
    })
    const res = makeRes()
    await postBulkAction(req, res, makeDb())
    expect(bulkUpdateReviewStatus).toHaveBeenCalledWith(
      expect.anything(),
      'shop-1',
      ['r-1', 'r-2', 'r-3'],
      'approved',
    )
    expect(res._redirect).toContain('success=')
  })

  it('routes action=reject → bulkUpdateReviewStatus("rejected")', async () => {
    const req = makeReq({ body: { action: 'reject', review_ids: ['r-1'] } })
    const res = makeRes()
    await postBulkAction(req, res, makeDb())
    expect(bulkUpdateReviewStatus).toHaveBeenCalledWith(
      expect.anything(),
      'shop-1',
      ['r-1'],
      'rejected',
    )
  })

  it('routes action=spam → bulkUpdateReviewStatus("spam")', async () => {
    const req = makeReq({ body: { action: 'spam', review_ids: ['r-1'] } })
    const res = makeRes()
    await postBulkAction(req, res, makeDb())
    expect(bulkUpdateReviewStatus).toHaveBeenCalledWith(
      expect.anything(),
      'shop-1',
      ['r-1'],
      'spam',
    )
  })

  it('routes action=delete → deleteReview per row, shop-scoped', async () => {
    ;(getReview as any)
      .mockResolvedValueOnce({ id: 'r-1', shop_id: 'shop-1' })
      .mockResolvedValueOnce({ id: 'r-2', shop_id: 'shop-other' }) // skip
      .mockResolvedValueOnce({ id: 'r-3', shop_id: 'shop-1' })
    const req = makeReq({ body: { action: 'delete', review_ids: ['r-1', 'r-2', 'r-3'] } })
    const res = makeRes()
    await postBulkAction(req, res, makeDb())
    expect(deleteReview).toHaveBeenCalledTimes(2) // r-2 skipped
    expect(deleteReview).toHaveBeenCalledWith(expect.anything(), 'r-1')
    expect(deleteReview).toHaveBeenCalledWith(expect.anything(), 'r-3')
  })

  it('coerces a single review_ids string into a 1-element array', async () => {
    const req = makeReq({ body: { action: 'approve', review_ids: 'r-solo' } })
    const res = makeRes()
    await postBulkAction(req, res, makeDb())
    expect(bulkUpdateReviewStatus).toHaveBeenCalledWith(
      expect.anything(),
      'shop-1',
      ['r-solo'],
      'approved',
    )
  })

  it('no-ops with an error redirect when review_ids is missing', async () => {
    const req = makeReq({ body: { action: 'approve' } })
    const res = makeRes()
    await postBulkAction(req, res, makeDb())
    expect(bulkUpdateReviewStatus).not.toHaveBeenCalled()
    expect(res._redirect).toContain('error=')
  })

  it('rejects an unknown action without touching the DB', async () => {
    const req = makeReq({ body: { action: 'nuke_from_orbit', review_ids: ['r-1'] } })
    const res = makeRes()
    await postBulkAction(req, res, makeDb())
    expect(bulkUpdateReviewStatus).not.toHaveBeenCalled()
    expect(deleteReview).not.toHaveBeenCalled()
    expect(res._redirect).toContain('error=')
  })

  it('iron-rule-5: error copy never names god-admin', async () => {
    const req = makeReq({ body: {} })
    const res = makeRes()
    await postBulkAction(req, res, makeDb())
    expect(res._redirect?.toLowerCase()).not.toContain('god')
  })
})
