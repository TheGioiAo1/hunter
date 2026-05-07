/**
 * Gbox Platform — Reviews Service Unit Tests
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createReview,
  getReview,
  updateReviewStatus,
  deleteReview,
  getProductReviews,
  getShopReviews,
  getReviewStats,
  submitPublicReview,
  computeSpamScore,
} from './service.js'

// ---------------------------------------------------------------------------
// Mock database builder (same pattern as orders/service.test.ts)
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Reviews Service', () => {
  const shopId = 'shop-001'
  const productId = 'prod-001'

  describe('createReview', () => {
    it('creates a review with valid data', async () => {
      const mockReview = {
        id: 'rev-001',
        shop_id: shopId,
        product_id: productId,
        rating: 5,
        title: 'Great product',
        body: 'Love it!',
        author_name: 'John',
        author_email: 'john@test.com',
        status: 'pending',
      }
      const db = createMockDb({ 'insert:product_reviews': mockReview })

      const result = await createReview(db, shopId, productId, {
        authorName: 'John',
        authorEmail: 'john@test.com',
        rating: 5,
        title: 'Great product',
        body: 'Love it!',
      })

      expect(result).toEqual(mockReview)
      expect(db.insertInto).toHaveBeenCalledWith('product_reviews')
    })

    it('throws on invalid rating (0)', async () => {
      const db = createMockDb()
      await expect(
        createReview(db, shopId, productId, {
          authorName: 'John',
          authorEmail: 'john@test.com',
          rating: 0,
          body: 'test',
        }),
      ).rejects.toThrow('Rating must be an integer between 1 and 5')
    })

    it('throws on invalid rating (6)', async () => {
      const db = createMockDb()
      await expect(
        createReview(db, shopId, productId, {
          authorName: 'John',
          authorEmail: 'john@test.com',
          rating: 6,
          body: 'test',
        }),
      ).rejects.toThrow('Rating must be an integer between 1 and 5')
    })

    it('throws on non-integer rating', async () => {
      const db = createMockDb()
      await expect(
        createReview(db, shopId, productId, {
          authorName: 'John',
          authorEmail: 'john@test.com',
          rating: 3.5,
          body: 'test',
        }),
      ).rejects.toThrow('Rating must be an integer between 1 and 5')
    })

    it('defaults status to pending', async () => {
      const mockReview = { id: 'rev-002', status: 'pending' }
      const db = createMockDb({ 'insert:product_reviews': mockReview })

      const result = await createReview(db, shopId, productId, {
        authorName: 'Jane',
        authorEmail: 'jane@test.com',
        rating: 4,
        body: 'Nice',
      })

      expect(result.status).toBe('pending')
    })
  })

  describe('getReview', () => {
    it('returns a review by ID', async () => {
      const mockReview = { id: 'rev-001', rating: 5 }
      const db = createMockDb({ 'select:product_reviews': mockReview })

      const result = await getReview(db, 'rev-001')
      expect(result).toEqual(mockReview)
    })

    it('returns null when not found', async () => {
      const db = createMockDb({ 'select:product_reviews': null })
      const result = await getReview(db, 'nonexistent')
      expect(result).toBeNull()
    })
  })

  describe('updateReviewStatus', () => {
    it('updates status to approved', async () => {
      const updated = { id: 'rev-001', status: 'approved' }
      const db = createMockDb({ 'update:product_reviews': updated })

      const result = await updateReviewStatus(db, 'rev-001', 'approved')
      expect(result.status).toBe('approved')
    })

    it('updates status to rejected', async () => {
      const updated = { id: 'rev-001', status: 'rejected' }
      const db = createMockDb({ 'update:product_reviews': updated })

      const result = await updateReviewStatus(db, 'rev-001', 'rejected')
      expect(result.status).toBe('rejected')
    })
  })

  describe('deleteReview', () => {
    it('deletes without throwing', async () => {
      const db = createMockDb()
      await expect(deleteReview(db, 'rev-001')).resolves.toBeUndefined()
      expect(db.deleteFrom).toHaveBeenCalledWith('product_reviews')
    })
  })

  describe('getProductReviews', () => {
    it('returns reviews with total and average', async () => {
      const reviews = [
        { id: 'r1', rating: 5 },
        { id: 'r2', rating: 4 },
      ]
      const stats = { count: 2, avg_rating: 4.5 }

      // Need a special mock that returns different things for chained calls
      const db = createMockDb({
        'select:product_reviews': reviews.length > 0 ? reviews : stats,
      })

      // The function uses Promise.all with two queries
      // With our simple mock, both will get the same data
      // This test validates the function doesn't throw
      const result = await getProductReviews(db, productId)
      expect(result).toBeDefined()
      expect(result).toHaveProperty('reviews')
      expect(result).toHaveProperty('total')
      expect(result).toHaveProperty('avgRating')
    })

    it('accepts status filter', async () => {
      const db = createMockDb({
        'select:product_reviews': { count: 0, avg_rating: null },
      })

      const result = await getProductReviews(db, productId, 'approved')
      expect(result).toBeDefined()
    })

    it('accepts pagination', async () => {
      const db = createMockDb({
        'select:product_reviews': { count: 0, avg_rating: null },
      })

      const result = await getProductReviews(db, productId, undefined, {
        limit: 10,
        offset: 20,
      })
      expect(result).toBeDefined()
    })
  })

  describe('getShopReviews', () => {
    it('returns shop-scoped reviews', async () => {
      const db = createMockDb({
        'select:product_reviews': { count: 5 },
      })

      const result = await getShopReviews(db, shopId)
      expect(result).toBeDefined()
      expect(result).toHaveProperty('reviews')
      expect(result).toHaveProperty('total')
    })

    it('filters by status', async () => {
      const db = createMockDb({
        'select:product_reviews': { count: 2 },
      })

      const result = await getShopReviews(db, shopId, 'pending')
      expect(result).toBeDefined()
    })
  })

  describe('submitPublicReview (Phase 10 PR3 profanity integration)', () => {
    it('stamps profanity_hits when settings enable the filter', async () => {
      let insertedValues: any = null
      const mockReview = { id: 'rev-prof-1', status: 'pending', profanity_hits: 2 }
      const mockSettingsRow = {
        shop_id: shopId,
        profanity_filter_enabled: true,
        profanity_extra_terms: [],
        notify_customer_on_approve: true,
        notify_customer_on_reply: true,
      }
      const db: any = {
        selectFrom: vi.fn((t: string) => {
          if (t === 'shop_review_settings') {
            return chainable(mockSettingsRow)
          }
          return chainable(null)
        }),
        insertInto: vi.fn(() => {
          const proxy: any = new Proxy(
            {},
            {
              get(_t, prop) {
                if (prop === 'then') return undefined
                if (prop === 'executeTakeFirstOrThrow')
                  return vi.fn().mockResolvedValue(mockReview)
                if (prop === 'values') {
                  return (v: any) => {
                    insertedValues = v
                    return proxy
                  }
                }
                return vi.fn().mockReturnValue(proxy)
              },
            },
          )
          return proxy
        }),
        updateTable: vi.fn(() => chainable({})),
        deleteFrom: vi.fn(() => chainable()),
        fn: {
          countAll: vi.fn(() => ({ as: vi.fn(() => 'count') })),
          avg: vi.fn(() => ({ as: vi.fn(() => 'avg_rating') })),
          sum: vi.fn(() => ({ as: vi.fn(() => 'sum') })),
        },
      }

      const review = await submitPublicReview(db, shopId, productId, {
        authorName: 'x',
        authorEmail: 'x@test.com',
        rating: 5,
        body: 'fuck this shit',
      })

      expect(review).toEqual(mockReview)
      expect(insertedValues).not.toBeNull()
      expect(insertedValues.profanity_hits).toBeGreaterThanOrEqual(2)
      // High profanity alone shouldn't push us to 'spam' — body lacks
      // the spam-score signals (URLs / short body / spam keywords).
      expect(insertedValues.status).toBe('pending')
    })

    it('still accepts review when settings lookup fails', async () => {
      let insertedValues: any = null
      const mockReview = { id: 'rev-prof-2', status: 'pending', profanity_hits: 0 }
      const db: any = {
        selectFrom: vi.fn(() => {
          // settings lookup throws — the wrapper should catch it.
          return {
            selectAll: () => {
              throw new Error('db offline')
            },
            select: () => {
              throw new Error('db offline')
            },
          }
        }),
        insertInto: vi.fn(() => {
          const proxy: any = new Proxy(
            {},
            {
              get(_t, prop) {
                if (prop === 'then') return undefined
                if (prop === 'executeTakeFirstOrThrow')
                  return vi.fn().mockResolvedValue(mockReview)
                if (prop === 'values') {
                  return (v: any) => {
                    insertedValues = v
                    return proxy
                  }
                }
                return vi.fn().mockReturnValue(proxy)
              },
            },
          )
          return proxy
        }),
        updateTable: vi.fn(() => chainable({})),
        deleteFrom: vi.fn(() => chainable()),
        fn: {
          countAll: vi.fn(() => ({ as: vi.fn(() => 'count') })),
          avg: vi.fn(() => ({ as: vi.fn(() => 'avg_rating') })),
          sum: vi.fn(() => ({ as: vi.fn(() => 'sum') })),
        },
      }

      await submitPublicReview(db, shopId, productId, {
        authorName: 'x',
        authorEmail: 'x@test.com',
        rating: 5,
        body: 'hello there',
      })

      expect(insertedValues).not.toBeNull()
      expect(insertedValues.profanity_hits).toBe(0)
    })

    it('computeSpamScore — clean < spammy', () => {
      const clean = computeSpamScore(
        'Clean body text here with no red flags',
        'a@b.com',
        5,
      )
      const spammy = computeSpamScore(
        'http://spam.tld http://spam2.tld buy now casino click here free bitcoin',
        'a@test.com',
        5,
      )
      expect(clean).toBeLessThan(spammy)
      expect(spammy).toBeGreaterThanOrEqual(80)
    })
  })

  describe('getReviewStats', () => {
    it('returns stats with distribution', async () => {
      const overall = { count: 10, avg_rating: 4.2 }
      const distRows = [
        { rating: 5, count: 5 },
        { rating: 4, count: 3 },
        { rating: 3, count: 2 },
      ]

      const db = createMockDb({
        'select:product_reviews': overall,
      })

      const result = await getReviewStats(db, productId)
      expect(result).toBeDefined()
      expect(result).toHaveProperty('average')
      expect(result).toHaveProperty('count')
      expect(result).toHaveProperty('distribution')
      expect(result.distribution).toHaveProperty(1)
      expect(result.distribution).toHaveProperty(5)
    })
  })
})
