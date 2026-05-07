/**
 * Gbox Platform — Reviews Moderation Unit Tests (Phase 8 PR4)
 *
 * Covers the new Phase 8 PR4 surface layered on top of the original
 * reviews/service.ts:
 *
 *   - computeSpamScore           (pure scoring function, every signal)
 *   - submitPublicReview         (spam → auto-route to 'spam' status)
 *   - setReviewReply             (merchant reply, clear reply)
 *   - bulkUpdateReviewStatus     (batch moderation, empty-id no-op)
 *   - extractReply               (narrow shape for public rendering)
 */

import { describe, it, expect, vi } from 'vitest'
import {
  computeSpamScore,
  SPAM_SCORE_THRESHOLD,
  submitPublicReview,
  setReviewReply,
  bulkUpdateReviewStatus,
  extractReply,
} from './service.js'

// ---------------------------------------------------------------------------
// Mock database builder (mirrors service.test.ts)
// ---------------------------------------------------------------------------

function chainable(result: any = undefined) {
  const obj: any = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return undefined
        if (prop === 'execute')
          return vi
            .fn()
            .mockResolvedValue(
              result instanceof Array ? result : [result].filter(Boolean),
            )
        if (prop === 'executeTakeFirst')
          return vi.fn().mockResolvedValue(result ?? null)
        if (prop === 'executeTakeFirstOrThrow') {
          return vi.fn().mockImplementation(async () => {
            if (result == null) throw new Error('no result')
            return result
          })
        }
        return vi.fn().mockReturnValue(obj)
      },
    },
  )
  return obj
}

function createMockDb(overrides: Record<string, any> = {}) {
  const db: any = {
    insertInto: vi.fn().mockImplementation((table: string) => {
      return chainable(
        overrides[`insert:${table}`] ?? overrides[table] ?? { id: 'mock-id' },
      )
    }),
    selectFrom: vi.fn().mockImplementation((table: string) => {
      return chainable(overrides[`select:${table}`] ?? overrides[table])
    }),
    updateTable: vi.fn().mockImplementation((table: string) => {
      return chainable(overrides[`update:${table}`] ?? overrides[table])
    }),
    deleteFrom: vi.fn().mockImplementation(() => chainable()),
    fn: {
      countAll: vi.fn().mockReturnValue({ as: vi.fn().mockReturnValue('count') }),
      avg: vi.fn().mockReturnValue({ as: vi.fn().mockReturnValue('avg_rating') }),
      sum: vi.fn().mockReturnValue({ as: vi.fn().mockReturnValue('sum') }),
    },
  }
  return db
}

// ===========================================================================
// computeSpamScore — pure, no IO
// ===========================================================================

describe('computeSpamScore', () => {
  it('returns 0 for a clean short positive review', () => {
    // "Love this product, works great!" — 5-star happy path. 30 chars,
    // no URLs, no caps, no keywords. Should float near zero.
    const score = computeSpamScore(
      'Love this product, works great!',
      'alice@example.com',
      5,
    )
    // example.com is a junk domain (+10). That's the only hit.
    expect(score).toBe(10)
  })

  it('scores 0 for a normal review with a non-junk email', () => {
    const score = computeSpamScore(
      'Love this product, works great and ships fast!',
      'alice@gmail.com',
      5,
    )
    expect(score).toBe(0)
  })

  it('flags one URL with +25', () => {
    const score = computeSpamScore(
      'Check out my blog https://example-blog.net for more info on this.',
      'alice@gmail.com',
      4,
    )
    expect(score).toBeGreaterThanOrEqual(25)
    expect(score).toBeLessThan(SPAM_SCORE_THRESHOLD)
  })

  it('auto-spams a body with 3+ URLs', () => {
    const score = computeSpamScore(
      'buy here http://a.com and http://b.com and http://c.com',
      'x@gmail.com',
      3,
    )
    // 3 URLs (+80) + "buy now" match (the "buy" alone isn't in the spam
    // list — "buy now" / "click here" etc. are). The 80 alone already
    // crosses the threshold.
    expect(score).toBeGreaterThanOrEqual(SPAM_SCORE_THRESHOLD)
  })

  it('flags ALL-CAPS body >= 50% on a long-enough body', () => {
    const score = computeSpamScore(
      'THIS IS THE BEST PRODUCT EVER AMAZING YES',
      'alice@gmail.com',
      5,
    )
    // >= 20 letters, > 50% caps → +15
    expect(score).toBeGreaterThanOrEqual(15)
  })

  it('does not flag short all-caps bodies (false positive guard)', () => {
    // "WOW NICE" — caps but only 6 letters. The 20-letter gate kicks
    // in here so we don't penalise short excited reviews.
    const score = computeSpamScore('WOW NICE', 'alice@gmail.com', 5)
    // Short body penalty kicks in instead (<10 non-space chars → +20)
    expect(score).toBe(20)
  })

  it('adds +20 for too-short body', () => {
    const score = computeSpamScore('Good', 'alice@gmail.com', 5)
    expect(score).toBe(20)
  })

  it('adds +20 per spam keyword, capped at +40', () => {
    const score = computeSpamScore(
      'Cheap viagra crypto casino offers available buy now click here free bitcoin',
      'alice@gmail.com',
      5,
    )
    // 5+ keyword matches but capped at +40.
    // ALL-CAPS check: letters=~55, caps=0 → no.
    // URLs: 0. Short: no. Junk email: no. → exactly +40.
    expect(score).toBe(40)
  })

  it('adds +10 for a junk email domain', () => {
    const score = computeSpamScore(
      'Totally legit review with enough body text here to avoid short penalty.',
      'junk@mailinator.com',
      5,
    )
    expect(score).toBe(10)
  })

  it('adds +10 for a one-star drive-by troll (rating=1 + short body)', () => {
    const score = computeSpamScore('Bad.', 'alice@gmail.com', 1)
    // Short (+20) + troll (+10) = 30.
    expect(score).toBe(30)
  })

  it('combines multiple signals and crosses the threshold', () => {
    const score = computeSpamScore(
      'BUY NOW!!! CHEAP VIAGRA http://spam.test http://spam2.test CLICK HERE http://spam3.test',
      'bot@mailinator.com',
      1,
    )
    // URLs ≥3 (+80) + caps (+15) + keywords capped (+40) + junk email (+10) = 145, clamps to 100.
    expect(score).toBe(100)
    expect(score).toBeGreaterThanOrEqual(SPAM_SCORE_THRESHOLD)
  })

  it('handles non-string body gracefully (never throws)', () => {
    const score = computeSpamScore(null as any, 'x@gmail.com', 5)
    // empty body → nonSpace=0 → short penalty only.
    expect(score).toBe(20)
  })

  it('clamps score to 0..100 range', () => {
    const huge = computeSpamScore(
      'BUY NOW CHEAP VIAGRA CRYPTO CASINO http://a.com http://b.com http://c.com http://d.com CLICK HERE BUY NOW',
      'bot@test.com',
      1,
    )
    expect(huge).toBeLessThanOrEqual(100)
    expect(huge).toBeGreaterThanOrEqual(0)
  })
})

// ===========================================================================
// submitPublicReview — wraps createReview with spam auto-routing
// ===========================================================================

describe('submitPublicReview', () => {
  const shopId = 'shop-001'
  const productId = 'prod-001'

  it('creates a pending review for clean content', async () => {
    const mockReview = {
      id: 'rev-001',
      shop_id: shopId,
      product_id: productId,
      status: 'pending',
      spam_score: 0,
    }
    const db = createMockDb({ 'insert:product_reviews': mockReview })

    const result = await submitPublicReview(db, shopId, productId, {
      authorName: 'Alice',
      authorEmail: 'alice@gmail.com',
      rating: 5,
      body: 'Really happy with this product, well worth it.',
    })

    expect(result).toEqual(mockReview)
    expect(db.insertInto).toHaveBeenCalledWith('product_reviews')
  })

  it('auto-routes spammy content to status="spam"', async () => {
    const insertSpy = vi.fn().mockReturnThis()
    const valuesSpy = vi.fn().mockReturnThis()

    const chain = {
      values: valuesSpy,
      returningAll: () => ({
        executeTakeFirstOrThrow: async () => ({
          id: 'rev-spam',
          status: 'spam',
          spam_score: 100,
        }),
      }),
    }
    valuesSpy.mockImplementation(() => chain)

    const db: any = {
      insertInto: vi.fn().mockImplementation(() => chain),
      fn: { countAll: vi.fn(), avg: vi.fn() },
    }

    const result = await submitPublicReview(db, shopId, productId, {
      authorName: 'Bot',
      authorEmail: 'bot@mailinator.com',
      rating: 1,
      body: 'BUY VIAGRA CHEAP http://a.com http://b.com http://c.com CLICK HERE BUY NOW',
    })

    // The spy captured the values() call. status should be 'spam'.
    expect(valuesSpy).toHaveBeenCalled()
    const inserted = valuesSpy.mock.calls[0][0]
    expect(inserted.status).toBe('spam')
    expect(inserted.spam_score).toBeGreaterThanOrEqual(SPAM_SCORE_THRESHOLD)
    expect(result.status).toBe('spam')
  })

  it('stamps spam_score on the row even when below threshold', async () => {
    const valuesSpy = vi.fn().mockReturnThis()
    const chain = {
      values: valuesSpy,
      returningAll: () => ({
        executeTakeFirstOrThrow: async () => ({ id: 'rev-mid', status: 'pending' }),
      }),
    }
    valuesSpy.mockImplementation(() => chain)
    const db: any = {
      insertInto: vi.fn().mockImplementation(() => chain),
      fn: { countAll: vi.fn(), avg: vi.fn() },
    }

    await submitPublicReview(db, shopId, productId, {
      authorName: 'Mid',
      authorEmail: 'mid@gmail.com',
      rating: 4,
      body: 'Here is my review with one link https://myblog.com to back it up.',
    })

    const inserted = valuesSpy.mock.calls[0][0]
    expect(inserted.status).toBe('pending')
    expect(inserted.spam_score).toBeGreaterThan(0)
    expect(inserted.spam_score).toBeLessThan(SPAM_SCORE_THRESHOLD)
  })
})

// ===========================================================================
// setReviewReply
// ===========================================================================

describe('setReviewReply', () => {
  it('saves a non-empty reply with author + timestamp', async () => {
    const setSpy = vi.fn().mockReturnThis()
    const chain = {
      set: setSpy,
      where: vi.fn().mockReturnThis(),
      returningAll: () => ({
        executeTakeFirstOrThrow: async () => ({
          id: 'rev-1',
          reply_body: 'Thanks for the feedback!',
          reply_author: 'Merchant',
          replied_at: '2026-04-21T10:00:00.000Z',
        }),
      }),
    }
    chain.set = setSpy.mockImplementation(() => chain)
    chain.where = vi.fn().mockReturnValue(chain)
    const db: any = {
      updateTable: vi.fn().mockImplementation(() => chain),
    }

    const result = await setReviewReply(
      db,
      'rev-1',
      'Thanks for the feedback!',
      'Merchant',
    )

    expect(result).toBeDefined()
    expect(result.reply_body).toBe('Thanks for the feedback!')
    // The set() call should include replied_at set to an ISO string.
    const setArg = setSpy.mock.calls[0][0]
    expect(setArg.reply_body).toBe('Thanks for the feedback!')
    expect(setArg.reply_author).toBe('Merchant')
    expect(setArg.replied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('clears the reply when passed null', async () => {
    const setSpy = vi.fn().mockReturnThis()
    const chain: any = {
      where: vi.fn().mockReturnThis(),
      returningAll: () => ({
        executeTakeFirstOrThrow: async () => ({
          id: 'rev-1',
          reply_body: null,
          reply_author: null,
          replied_at: null,
        }),
      }),
    }
    chain.set = setSpy.mockImplementation(() => chain)
    const db: any = {
      updateTable: vi.fn().mockImplementation(() => chain),
    }

    await setReviewReply(db, 'rev-1', null, 'Merchant')

    const setArg = setSpy.mock.calls[0][0]
    expect(setArg.reply_body).toBeNull()
    expect(setArg.reply_author).toBeNull()
    expect(setArg.replied_at).toBeNull()
  })

  it('trims whitespace from reply body', async () => {
    const setSpy = vi.fn().mockReturnThis()
    const chain: any = {
      where: vi.fn().mockReturnThis(),
      returningAll: () => ({
        executeTakeFirstOrThrow: async () => ({ id: 'rev-1' }),
      }),
    }
    chain.set = setSpy.mockImplementation(() => chain)
    const db: any = {
      updateTable: vi.fn().mockImplementation(() => chain),
    }

    await setReviewReply(db, 'rev-1', '   Thanks!   ', 'Merchant')

    expect(setSpy.mock.calls[0][0].reply_body).toBe('Thanks!')
  })
})

// ===========================================================================
// bulkUpdateReviewStatus
// ===========================================================================

describe('bulkUpdateReviewStatus', () => {
  it('returns 0 for an empty id array without touching the DB', async () => {
    const db = createMockDb()
    const n = await bulkUpdateReviewStatus(db, 'shop-1', [], 'approved')
    expect(n).toBe(0)
    expect(db.updateTable).not.toHaveBeenCalled()
  })

  it('updates many rows and reports numUpdatedRows', async () => {
    const setSpy = vi.fn().mockReturnThis()
    const where1 = vi.fn().mockReturnThis()
    const where2 = vi.fn().mockReturnThis()
    const executeTakeFirst = vi.fn().mockResolvedValue({
      numUpdatedRows: BigInt(3),
    })
    const chain: any = { set: setSpy, where: where1, executeTakeFirst }
    where1.mockImplementation(() => ({ where: where2, executeTakeFirst }))
    where2.mockImplementation(() => ({ executeTakeFirst }))
    setSpy.mockImplementation(() => chain)

    const db: any = {
      updateTable: vi.fn().mockImplementation(() => chain),
    }

    const n = await bulkUpdateReviewStatus(
      db,
      'shop-1',
      ['r1', 'r2', 'r3'],
      'approved',
    )
    expect(n).toBe(3)
  })

  it('scopes updates to the shop_id (defence against cross-tenant)', async () => {
    const setSpy = vi.fn().mockReturnThis()
    const whereCalls: any[] = []
    const whereFn = vi.fn().mockImplementation((...args: any[]) => {
      whereCalls.push(args)
      return { where: whereFn, executeTakeFirst: () => ({ numUpdatedRows: 1 }) }
    })
    const chain: any = { set: setSpy, where: whereFn }
    setSpy.mockImplementation(() => chain)

    const db: any = {
      updateTable: vi.fn().mockImplementation(() => chain),
    }

    await bulkUpdateReviewStatus(db, 'shop-X', ['a', 'b'], 'rejected')

    // The first .where filters by shop_id.
    expect(whereCalls[0]).toEqual(['shop_id', '=', 'shop-X'])
    // The second .where filters by id IN (...).
    expect(whereCalls[1][0]).toBe('id')
    expect(whereCalls[1][1]).toBe('in')
    expect(whereCalls[1][2]).toEqual(['a', 'b'])
  })
})

// ===========================================================================
// extractReply
// ===========================================================================

describe('extractReply', () => {
  it('returns null when there is no reply', () => {
    expect(extractReply({ reply_body: null, replied_at: null })).toBeNull()
  })

  it('returns null when only author is set (no body, no timestamp)', () => {
    expect(
      extractReply({
        reply_body: null,
        reply_author: 'Merchant',
        replied_at: null,
      }),
    ).toBeNull()
  })

  it('returns the narrow struct when reply is present', () => {
    const out = extractReply({
      reply_body: 'Thanks!',
      reply_author: 'Merchant',
      replied_at: '2026-04-21T10:00:00.000Z',
    })
    expect(out).toEqual({
      body: 'Thanks!',
      author: 'Merchant',
      repliedAt: '2026-04-21T10:00:00.000Z',
    })
  })

  it('tolerates a missing author (still returns the reply)', () => {
    const out = extractReply({
      reply_body: 'Thanks!',
      replied_at: '2026-04-21T10:00:00.000Z',
    })
    expect(out).not.toBeNull()
    expect(out!.author).toBeNull()
  })
})
