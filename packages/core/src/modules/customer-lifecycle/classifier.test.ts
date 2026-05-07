/**
 * Classifier unit tests — Phase 4 PR3.
 *
 * Pure function, so every case is deterministic given a fixed `now`.
 * We pin `now` to a single wall-clock instant and move `last_order_at`
 * around that instant. Thresholds come from the same shared constants
 * the production code uses, so if someone widens the at-risk window
 * from 60 → 45 these tests flip correctly without a code change.
 */

import { describe, it, expect } from 'vitest'
import {
  classifyLifecycle,
  isLifecycleStage,
  LIFECYCLE_AT_RISK_DAYS,
  LIFECYCLE_CHURNED_DAYS,
  LIFECYCLE_STAGES,
} from './classifier.js'

const NOW = new Date('2026-04-20T12:00:00.000Z')

function daysAgo(days: number): Date {
  const d = new Date(NOW)
  d.setUTCDate(d.getUTCDate() - days)
  return d
}

describe('classifyLifecycle', () => {
  describe('new', () => {
    it('returns new for a customer with zero orders', () => {
      expect(
        classifyLifecycle({ orders_count: 0, last_order_at: null }, NOW),
      ).toBe('new')
    })

    it('returns new when orders_count is positive but last_order_at is null (corrupt fail-safe)', () => {
      expect(
        classifyLifecycle({ orders_count: 3, last_order_at: null }, NOW),
      ).toBe('new')
    })

    it('returns new for a single recent order (first-time buyer)', () => {
      expect(
        classifyLifecycle(
          { orders_count: 1, last_order_at: daysAgo(5) },
          NOW,
        ),
      ).toBe('new')
    })

    it('treats an invalid date string as null → new', () => {
      expect(
        classifyLifecycle(
          { orders_count: 2, last_order_at: 'not-a-date' },
          NOW,
        ),
      ).toBe('new')
    })
  })

  describe('returning', () => {
    it('returns returning with 2 orders within the at-risk window', () => {
      expect(
        classifyLifecycle(
          { orders_count: 2, last_order_at: daysAgo(10) },
          NOW,
        ),
      ).toBe('returning')
    })

    it('returns returning with many orders and recent activity', () => {
      expect(
        classifyLifecycle(
          { orders_count: 47, last_order_at: daysAgo(LIFECYCLE_AT_RISK_DAYS - 1) },
          NOW,
        ),
      ).toBe('returning')
    })

    it('accepts ISO string for last_order_at', () => {
      const iso = daysAgo(3).toISOString()
      expect(
        classifyLifecycle({ orders_count: 2, last_order_at: iso }, NOW),
      ).toBe('returning')
    })
  })

  describe('at_risk', () => {
    it('flips to at_risk exactly at the threshold day', () => {
      expect(
        classifyLifecycle(
          { orders_count: 3, last_order_at: daysAgo(LIFECYCLE_AT_RISK_DAYS) },
          NOW,
        ),
      ).toBe('at_risk')
    })

    it('stays at_risk just below the churned threshold', () => {
      expect(
        classifyLifecycle(
          { orders_count: 3, last_order_at: daysAgo(LIFECYCLE_CHURNED_DAYS - 1) },
          NOW,
        ),
      ).toBe('at_risk')
    })

    it('flags a single-order at-risk customer too (1 order, 90 days ago)', () => {
      expect(
        classifyLifecycle(
          { orders_count: 1, last_order_at: daysAgo(90) },
          NOW,
        ),
      ).toBe('at_risk')
    })
  })

  describe('churned', () => {
    it('flips to churned exactly at the churned threshold day', () => {
      expect(
        classifyLifecycle(
          { orders_count: 5, last_order_at: daysAgo(LIFECYCLE_CHURNED_DAYS) },
          NOW,
        ),
      ).toBe('churned')
    })

    it('stays churned well past threshold', () => {
      expect(
        classifyLifecycle(
          { orders_count: 10, last_order_at: daysAgo(500) },
          NOW,
        ),
      ).toBe('churned')
    })

    it('churned wins over returning even with many orders', () => {
      // The most loyal repeat customer who hasn't bought in a year is
      // churned — the point of the stage is recency-dominated
      // classification regardless of historical value.
      expect(
        classifyLifecycle(
          { orders_count: 100, last_order_at: daysAgo(365) },
          NOW,
        ),
      ).toBe('churned')
    })
  })

  describe('defaults', () => {
    it('uses Date.now() when now is omitted', () => {
      // We can't pin the real clock but we can assert it runs + returns
      // a valid value for reasonable input. last_order_at slightly in
      // the past → should be one of the active stages.
      const stage = classifyLifecycle({
        orders_count: 3,
        last_order_at: new Date(Date.now() - 1_000),
      })
      expect(['new', 'returning', 'at_risk', 'churned']).toContain(stage)
    })
  })
})

describe('isLifecycleStage', () => {
  it('accepts every stage emitted by the classifier', () => {
    for (const stage of LIFECYCLE_STAGES) {
      expect(isLifecycleStage(stage)).toBe(true)
    }
  })

  it('rejects related-but-wrong strings', () => {
    // marketing/segments.ts values that are NOT persisted in
    // customers.lifecycle_stage — we don't want the segment builder
    // to accidentally accept "vip" as a lifecycle stage.
    expect(isLifecycleStage('vip')).toBe(false)
    expect(isLifecycleStage('prospect')).toBe(false)
    expect(isLifecycleStage('inactive')).toBe(false)
    expect(isLifecycleStage('')).toBe(false)
    expect(isLifecycleStage(null)).toBe(false)
    expect(isLifecycleStage(undefined)).toBe(false)
    expect(isLifecycleStage(5)).toBe(false)
  })
})
