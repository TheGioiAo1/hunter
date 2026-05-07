/**
 * Gbox Storefront — Public Reviews API Tests (Phase 8 PR4)
 *
 * Exercises the factory-wired router against fake deps, covering:
 *
 *   - parsePublicReviewBody           (every validation branch)
 *   - isUuid                           (shape check)
 *   - RateLimiter                      (via submitLimiter / listLimiter)
 *   - GET /api/storefront/products/:id/reviews (happy + 400 + 429 + 500)
 *   - POST /api/storefront/products/:id/reviews (happy + 400 + 429 + 500)
 *   - Iron rule 5: error copy never names internal paths
 *   - Spam-status redaction: 'spam' never leaks to the client
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  buildReviewsRoutes,
  parsePublicReviewBody,
  isUuid,
  submitLimiter,
  listLimiter,
} from './reviews-routes.js'

const VALID_ID = '11111111-2222-3333-4444-555555555555'
const SHOP_ID = '99999999-8888-7777-6666-555555555555'

function mkApp(deps: Parameters<typeof buildReviewsRoutes>[0], shopId = SHOP_ID) {
  const app = express()
  app.use((req, _res, next) => {
    ;(req as any).gboxShopId = shopId
    next()
  })
  app.use(buildReviewsRoutes(deps))
  return app
}

beforeEach(() => {
  submitLimiter.reset()
  listLimiter.reset()
})

// ===========================================================================
// parsePublicReviewBody
// ===========================================================================

describe('parsePublicReviewBody', () => {
  it('accepts a minimal valid body', () => {
    const r = parsePublicReviewBody({
      rating: 5,
      body: 'Really good product.',
      author_name: 'Alice',
      author_email: 'alice@example.com',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.input.rating).toBe(5)
      expect(r.input.authorName).toBe('Alice')
      expect(r.input.authorEmail).toBe('alice@example.com')
      expect(r.input.title).toBeNull()
    }
  })

  it('accepts camelCase field names', () => {
    const r = parsePublicReviewBody({
      rating: 4,
      body: 'Nice one',
      authorName: 'Bob',
      authorEmail: 'bob@example.com',
    })
    expect(r.ok).toBe(true)
  })

  it('rejects non-integer rating', () => {
    const r = parsePublicReviewBody({
      rating: 3.5,
      body: 'Hmm',
      authorName: 'A',
      authorEmail: 'a@b.com',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('invalid_rating')
  })

  it('rejects rating outside 1..5', () => {
    expect(parsePublicReviewBody({ rating: 0, body: 'xxx', author_name: 'n', author_email: 'a@b.co' }).ok).toBe(false)
    expect(parsePublicReviewBody({ rating: 6, body: 'xxx', author_name: 'n', author_email: 'a@b.co' }).ok).toBe(false)
  })

  it('rejects too-short body', () => {
    const r = parsePublicReviewBody({
      rating: 5,
      body: 'ok',
      author_name: 'A',
      author_email: 'a@b.com',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('invalid_body_length')
  })

  it('rejects too-long body', () => {
    const longBody = 'x'.repeat(6000)
    const r = parsePublicReviewBody({
      rating: 5,
      body: longBody,
      author_name: 'A',
      author_email: 'a@b.com',
    })
    expect(r.ok).toBe(false)
  })

  it('rejects invalid email', () => {
    const r = parsePublicReviewBody({
      rating: 5,
      body: 'abc def',
      author_name: 'A',
      author_email: 'not-an-email',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('invalid_author_email')
  })

  it('rejects empty author_name', () => {
    const r = parsePublicReviewBody({
      rating: 5,
      body: 'abc def',
      author_name: '   ',
      author_email: 'a@b.com',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('invalid_author_name')
  })

  it('rejects non-object body', () => {
    expect(parsePublicReviewBody('hello').ok).toBe(false)
    expect(parsePublicReviewBody(null).ok).toBe(false)
    expect(parsePublicReviewBody(42).ok).toBe(false)
  })

  it('accepts optional title', () => {
    const r = parsePublicReviewBody({
      rating: 5,
      body: 'abc def',
      author_name: 'A',
      author_email: 'a@b.com',
      title: 'Nice!',
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.input.title).toBe('Nice!')
  })

  it('collapses empty title to null', () => {
    const r = parsePublicReviewBody({
      rating: 5,
      body: 'abc def',
      author_name: 'A',
      author_email: 'a@b.com',
      title: '   ',
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.input.title).toBeNull()
  })
})

// ===========================================================================
// isUuid
// ===========================================================================

describe('isUuid', () => {
  it('accepts a canonical UUID', () => {
    expect(isUuid('11111111-2222-3333-4444-555555555555')).toBe(true)
  })

  it('rejects obvious non-UUIDs', () => {
    expect(isUuid('not-a-uuid')).toBe(false)
    expect(isUuid('123')).toBe(false)
    expect(isUuid('')).toBe(false)
    expect(isUuid(42 as any)).toBe(false)
    expect(isUuid(null as any)).toBe(false)
  })
})

// ===========================================================================
// GET /api/storefront/products/:id/reviews
// ===========================================================================

describe('GET /api/storefront/products/:id/reviews', () => {
  it('returns 404 when no shop id on the request', async () => {
    const deps = { listProductReviews: vi.fn(), submit: vi.fn() }
    const app = express()
    app.use(buildReviewsRoutes(deps as any))
    const r = await request(app).get(`/api/storefront/products/${VALID_ID}/reviews`)
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ ok: false, error: 'not_found' })
  })

  it('returns 400 on non-UUID product id', async () => {
    const deps = { listProductReviews: vi.fn(), submit: vi.fn() }
    const app = mkApp(deps as any)
    const r = await request(app).get('/api/storefront/products/not-a-uuid/reviews')
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('invalid_product_id')
  })

  it('returns the review list and maps the narrow shape', async () => {
    const reviews = [
      {
        id: 'r1',
        rating: 5,
        title: 'Great',
        body: 'Love it',
        author_name: 'Alice',
        author_email: 'alice@x.com', // should NOT leak into the response
        status: 'approved',
        created_at: '2026-04-21T10:00:00.000Z',
        reply_body: 'Thanks!',
        reply_author: 'Merchant',
        replied_at: '2026-04-21T11:00:00.000Z',
      },
    ]
    const deps = {
      listProductReviews: vi.fn().mockResolvedValue({
        reviews,
        total: 1,
        avgRating: 5,
      }),
      submit: vi.fn(),
    }
    const app = mkApp(deps as any)
    const r = await request(app).get(
      `/api/storefront/products/${VALID_ID}/reviews`,
    )
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.reviews).toHaveLength(1)
    // author_email MUST NOT leak
    expect(r.body.reviews[0]).not.toHaveProperty('authorEmail')
    expect(r.body.reviews[0]).not.toHaveProperty('author_email')
    // reply shape
    expect(r.body.reviews[0].reply).toEqual({
      body: 'Thanks!',
      author: 'Merchant',
      repliedAt: '2026-04-21T11:00:00.000Z',
    })
  })

  it('returns 429 once the GET rate limit is exceeded', async () => {
    const deps = {
      listProductReviews: vi.fn().mockResolvedValue({
        reviews: [],
        total: 0,
        avgRating: 0,
      }),
      submit: vi.fn(),
    }
    const app = mkApp(deps as any)

    // 60 allowed + 1 blocked (per-ip per-product).
    for (let i = 0; i < 60; i++) {
      const r = await request(app)
        .get(`/api/storefront/products/${VALID_ID}/reviews`)
        .set('X-Forwarded-For', '1.2.3.4')
      expect(r.status).toBe(200)
    }
    const blocked = await request(app)
      .get(`/api/storefront/products/${VALID_ID}/reviews`)
      .set('X-Forwarded-For', '1.2.3.4')
    expect(blocked.status).toBe(429)
  })

  it('on service throw returns neutral 500 (iron rule 5)', async () => {
    const deps = {
      listProductReviews: vi.fn().mockRejectedValue(new Error('boom')),
      submit: vi.fn(),
    }
    const app = mkApp(deps as any)
    const r = await request(app)
      .get(`/api/storefront/products/${VALID_ID}/reviews`)
      .set('X-Forwarded-For', '2.2.2.2')
    expect(r.status).toBe(500)
    // No internal references
    const body = JSON.stringify(r.body)
    expect(body).not.toMatch(/boom/i)
    expect(body).not.toMatch(/stack/i)
    expect(body).not.toMatch(/god[\s_-]?admin/i)
  })
})

// ===========================================================================
// POST /api/storefront/products/:id/reviews
// ===========================================================================

describe('POST /api/storefront/products/:id/reviews', () => {
  it('accepts a valid submission and returns 202', async () => {
    const submit = vi.fn().mockResolvedValue({ id: 'rev-123', status: 'pending' })
    const deps = { listProductReviews: vi.fn(), submit }
    const app = mkApp(deps as any)

    const r = await request(app)
      .post(`/api/storefront/products/${VALID_ID}/reviews`)
      .set('X-Forwarded-For', '3.3.3.1')
      .send({
        rating: 5,
        body: 'Really nice',
        author_name: 'Alice',
        author_email: 'alice@example.com',
      })

    expect(r.status).toBe(202)
    expect(r.body).toEqual({ ok: true, id: 'rev-123', status: 'pending' })
    expect(submit).toHaveBeenCalledWith(
      SHOP_ID,
      VALID_ID,
      expect.objectContaining({ rating: 5, authorEmail: 'alice@example.com' }),
    )
  })

  it('redacts spam status to "pending" (no spam feedback to bot)', async () => {
    const submit = vi.fn().mockResolvedValue({ id: 'rev-spam', status: 'spam' })
    const deps = { listProductReviews: vi.fn(), submit }
    const app = mkApp(deps as any)

    const r = await request(app)
      .post(`/api/storefront/products/${VALID_ID}/reviews`)
      .set('X-Forwarded-For', '3.3.3.2')
      .send({
        rating: 1,
        body: 'BUY VIAGRA http://a.com http://b.com http://c.com',
        author_name: 'Bot',
        author_email: 'bot@mailinator.com',
      })
    expect(r.status).toBe(202)
    expect(r.body.status).toBe('pending') // never 'spam' to the client
  })

  it('returns 400 on validation failure', async () => {
    const deps = {
      listProductReviews: vi.fn(),
      submit: vi.fn(),
    }
    const app = mkApp(deps as any)
    const r = await request(app)
      .post(`/api/storefront/products/${VALID_ID}/reviews`)
      .set('X-Forwarded-For', '3.3.3.3')
      .send({
        rating: 0,
        body: 'bad',
        author_name: 'X',
        author_email: 'not-email',
      })
    expect(r.status).toBe(400)
    expect(deps.submit).not.toHaveBeenCalled()
  })

  it('returns 429 once the POST rate limit is exceeded', async () => {
    const submit = vi.fn().mockResolvedValue({ id: 'r', status: 'pending' })
    const deps = { listProductReviews: vi.fn(), submit }
    const app = mkApp(deps as any)

    for (let i = 0; i < 5; i++) {
      const ok = await request(app)
        .post(`/api/storefront/products/${VALID_ID}/reviews`)
        .set('X-Forwarded-For', '4.4.4.4')
        .send({
          rating: 5,
          body: 'ok body here',
          author_name: 'A',
          author_email: 'a@b.com',
        })
      expect(ok.status).toBe(202)
    }
    const blocked = await request(app)
      .post(`/api/storefront/products/${VALID_ID}/reviews`)
      .set('X-Forwarded-For', '4.4.4.4')
      .send({
        rating: 5,
        body: 'ok body here',
        author_name: 'A',
        author_email: 'a@b.com',
      })
    expect(blocked.status).toBe(429)
  })

  it('service throw surfaces neutral 500 (iron rule 5)', async () => {
    const deps = {
      listProductReviews: vi.fn(),
      submit: vi.fn().mockRejectedValue(new Error('database unreachable')),
    }
    const app = mkApp(deps as any)
    const r = await request(app)
      .post(`/api/storefront/products/${VALID_ID}/reviews`)
      .set('X-Forwarded-For', '5.5.5.5')
      .send({
        rating: 5,
        body: 'normal body',
        author_name: 'A',
        author_email: 'a@b.com',
      })
    expect(r.status).toBe(500)
    const payload = JSON.stringify(r.body)
    expect(payload).not.toMatch(/database/i)
    expect(payload).not.toMatch(/god[\s_-]?admin/i)
  })

  it('returns 404 on missing shop context', async () => {
    const deps = { listProductReviews: vi.fn(), submit: vi.fn() }
    const app = express()
    app.use(express.json())
    app.use(buildReviewsRoutes(deps as any))
    const r = await request(app)
      .post(`/api/storefront/products/${VALID_ID}/reviews`)
      .send({
        rating: 5,
        body: 'ok body',
        author_name: 'A',
        author_email: 'a@b.com',
      })
    expect(r.status).toBe(404)
  })
})
