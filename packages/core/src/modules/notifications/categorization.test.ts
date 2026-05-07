/**
 * Gbox Platform — Notifications Categorization Tests (Phase 8 PR4)
 *
 * Covers the Phase 8 PR4 additions to the DB-backed notifications
 * service:
 *
 *   - inferCategory(type)              — pure mapping from type → bucket
 *   - groupByCategory(rows)            — list → bucketed object
 *   - createNotification (with cat+link) — write path stamps category
 *
 * The original memory-store + service tests remain unchanged.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  inferCategory,
  groupByCategory,
  createNotification,
  type NotificationCategory,
} from './service.js'

// ---------------------------------------------------------------------------
// Mock DB (same chainable pattern as reviews tests)
// ---------------------------------------------------------------------------

function chainable(result: any = undefined) {
  const obj: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return undefined
        if (prop === 'execute')
          return vi.fn().mockResolvedValue(result instanceof Array ? result : [result].filter(Boolean))
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

// ===========================================================================
// inferCategory
// ===========================================================================

describe('inferCategory', () => {
  it('maps order types → orders', () => {
    expect(inferCategory('order_placed')).toBe('orders')
    expect(inferCategory('order_fulfilled')).toBe('orders')
    expect(inferCategory('orders_exported')).toBe('orders')
    expect(inferCategory('orders_imported')).toBe('orders')
    expect(inferCategory('tracking_imported')).toBe('orders')
  })

  it('maps low_stock → inventory', () => {
    expect(inferCategory('low_stock')).toBe('inventory')
  })

  it('maps new_customer → customers', () => {
    expect(inferCategory('new_customer')).toBe('customers')
  })

  it('maps payment/refund → billing', () => {
    expect(inferCategory('payment_received')).toBe('billing')
    expect(inferCategory('refund_issued')).toBe('billing')
  })

  it('maps review_* types → reviews', () => {
    expect(inferCategory('review_submitted')).toBe('reviews')
    expect(inferCategory('review_approved')).toBe('reviews')
    expect(inferCategory('review_rejected')).toBe('reviews')
    expect(inferCategory('review_deleted')).toBe('reviews')
    expect(inferCategory('review_replied')).toBe('reviews')
    expect(inferCategory('review_spam_flagged')).toBe('reviews')
  })

  it('maps app_installed → system', () => {
    expect(inferCategory('app_installed')).toBe('system')
  })

  it('falls back to "other" for unknown types', () => {
    expect(inferCategory('something_weird')).toBe('other')
    expect(inferCategory('')).toBe('other')
  })
})

// ===========================================================================
// groupByCategory
// ===========================================================================

describe('groupByCategory', () => {
  it('returns an empty bucket map for []', () => {
    const buckets = groupByCategory([])
    const keys: NotificationCategory[] = [
      'orders', 'inventory', 'customers', 'billing',
      'reviews', 'marketing', 'system', 'other',
    ]
    for (const k of keys) {
      expect(buckets[k]).toEqual([])
    }
  })

  it('sorts rows into the right buckets by explicit category', () => {
    const rows = [
      { type: 'order_placed', category: 'orders', id: 1 },
      { type: 'low_stock', category: 'inventory', id: 2 },
      { type: 'review_submitted', category: 'reviews', id: 3 },
    ]
    const b = groupByCategory(rows)
    expect(b.orders.map((r: any) => r.id)).toEqual([1])
    expect(b.inventory.map((r: any) => r.id)).toEqual([2])
    expect(b.reviews.map((r: any) => r.id)).toEqual([3])
  })

  it('falls back to inferCategory for rows without a category', () => {
    const rows = [
      { type: 'order_placed', category: null, id: 'a' },
      { type: 'review_submitted', id: 'b' }, // category absent entirely
    ]
    const b = groupByCategory(rows as any)
    expect(b.orders.map((r: any) => r.id)).toEqual(['a'])
    expect(b.reviews.map((r: any) => r.id)).toEqual(['b'])
  })

  it('preserves the input order within each bucket', () => {
    const rows = [
      { type: 'order_placed', category: 'orders', id: 1 },
      { type: 'order_placed', category: 'orders', id: 2 },
      { type: 'order_placed', category: 'orders', id: 3 },
    ]
    const b = groupByCategory(rows)
    expect(b.orders.map((r: any) => r.id)).toEqual([1, 2, 3])
  })

  it('sinks rows with a bogus category into "other"', () => {
    const rows = [{ type: 'order_placed', category: 'completely_made_up', id: 'x' }]
    const b = groupByCategory(rows as any)
    expect(b.other.map((r: any) => r.id)).toEqual(['x'])
  })
})

// ===========================================================================
// createNotification — stamps category + link
// ===========================================================================

describe('createNotification (Phase 8 PR4)', () => {
  it('stamps the explicit category passed by the caller', async () => {
    const valuesSpy = vi.fn().mockReturnThis()
    const chain: any = {
      values: valuesSpy,
      returningAll: () => ({
        executeTakeFirstOrThrow: async () => ({
          id: 'n-1',
          category: 'reviews',
          link: '/admin/store/s/products/reviews/r-1',
        }),
      }),
    }
    valuesSpy.mockImplementation(() => chain)
    const db: any = {
      insertInto: vi.fn().mockImplementation(() => chain),
    }

    const out = await createNotification(db, 'shop-1', 'user-1', {
      type: 'review_submitted',
      title: 'New review',
      category: 'reviews',
      link: '/admin/store/s/products/reviews/r-1',
    })

    expect(out).toBeDefined()
    const inserted = valuesSpy.mock.calls[0][0]
    expect(inserted.category).toBe('reviews')
    expect(inserted.link).toBe('/admin/store/s/products/reviews/r-1')
  })

  it('infers the category when the caller does not pass one', async () => {
    const valuesSpy = vi.fn().mockReturnThis()
    const chain: any = {
      values: valuesSpy,
      returningAll: () => ({
        executeTakeFirstOrThrow: async () => ({ id: 'n-2' }),
      }),
    }
    valuesSpy.mockImplementation(() => chain)
    const db: any = {
      insertInto: vi.fn().mockImplementation(() => chain),
    }

    await createNotification(db, 'shop-1', null, {
      type: 'order_placed',
      title: 'New order',
    })

    const inserted = valuesSpy.mock.calls[0][0]
    expect(inserted.category).toBe('orders') // inferred, not null
    expect(inserted.link).toBeNull()
  })

  it('defaults link to null when not provided', async () => {
    const valuesSpy = vi.fn().mockReturnThis()
    const chain: any = {
      values: valuesSpy,
      returningAll: () => ({
        executeTakeFirstOrThrow: async () => ({ id: 'n-3' }),
      }),
    }
    valuesSpy.mockImplementation(() => chain)
    const db: any = {
      insertInto: vi.fn().mockImplementation(() => chain),
    }

    await createNotification(db, 'shop-1', null, {
      type: 'low_stock',
      title: 'Stock low',
    })

    const inserted = valuesSpy.mock.calls[0][0]
    expect(inserted.link).toBeNull()
  })
})
