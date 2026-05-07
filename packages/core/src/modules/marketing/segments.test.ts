/**
 * Gbox Platform — Customer segmentation tests (Stage 4.1)
 *
 * The segmenter is a deterministic, rule-based classifier that
 * maps a customer snapshot (order history, spend, recency) to a
 * canonical segment label. It is the foundation of every Phase 4
 * marketing piece:
 *
 *   • email-flows.ts picks which flow to enrol the customer in
 *     based on this segment.
 *   • discounts.ts issues segment-specific codes (VIP vs win-back).
 *   • popups.ts decides whether to show a "we miss you" popup.
 *
 * These tests pin every threshold and every branch so a silent
 * change to "what counts as VIP" turns red at review time.
 */

import { describe, it, expect } from 'vitest'
import {
  segmentCustomer,
  VIP_SPEND_THRESHOLD,
  VIP_ORDER_THRESHOLD,
  AT_RISK_DAYS_NO_ORDER,
  INACTIVE_DAYS_NO_ORDER,
  NEW_DAYS_SINCE_FIRST_ORDER,
  type CustomerSnapshot,
  type CustomerSegment,
} from './segments.js'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const NOW = new Date('2026-04-09T12:00:00Z')

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000)
}

function snap(overrides: Partial<CustomerSnapshot> = {}): CustomerSnapshot {
  return {
    customerId: 'cus_1',
    email: 'a@b.co',
    createdAt: daysAgo(10),
    ordersCount: 0,
    totalSpent: 0,
    currency: 'USD',
    firstOrderAt: null,
    lastOrderAt: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// prospect — no orders yet
// ---------------------------------------------------------------------------

describe('segmentCustomer — prospect branch', () => {
  it('returns "prospect" when ordersCount is 0', () => {
    const out = segmentCustomer(snap({ ordersCount: 0 }), NOW)
    expect(out.segment).toBe('prospect')
    expect(out.reasons).toContain('no orders placed')
  })
})

// ---------------------------------------------------------------------------
// new — first order within NEW_DAYS_SINCE_FIRST_ORDER
// ---------------------------------------------------------------------------

describe('segmentCustomer — new branch', () => {
  it('returns "new" when the first order is fresh and count is low', () => {
    const out = segmentCustomer(
      snap({
        ordersCount: 1,
        totalSpent: 25,
        firstOrderAt: daysAgo(5),
        lastOrderAt: daysAgo(5),
      }),
      NOW,
    )
    expect(out.segment).toBe('new')
  })

  it('stops being "new" after NEW_DAYS_SINCE_FIRST_ORDER days', () => {
    const out = segmentCustomer(
      snap({
        ordersCount: 1,
        totalSpent: 25,
        firstOrderAt: daysAgo(NEW_DAYS_SINCE_FIRST_ORDER + 1),
        lastOrderAt: daysAgo(NEW_DAYS_SINCE_FIRST_ORDER + 1),
      }),
      NOW,
    )
    expect(out.segment).not.toBe('new')
  })
})

// ---------------------------------------------------------------------------
// vip — either spend OR order count threshold crossed
// ---------------------------------------------------------------------------

describe('segmentCustomer — VIP branch', () => {
  it('returns "vip" when spend is at or above VIP_SPEND_THRESHOLD', () => {
    const out = segmentCustomer(
      snap({
        ordersCount: 2,
        totalSpent: VIP_SPEND_THRESHOLD,
        firstOrderAt: daysAgo(100),
        lastOrderAt: daysAgo(3),
      }),
      NOW,
    )
    expect(out.segment).toBe('vip')
    expect(out.reasons.join(' ')).toMatch(/spend/i)
  })

  it('returns "vip" when order count crosses VIP_ORDER_THRESHOLD', () => {
    const out = segmentCustomer(
      snap({
        ordersCount: VIP_ORDER_THRESHOLD,
        totalSpent: 50,
        firstOrderAt: daysAgo(200),
        lastOrderAt: daysAgo(5),
      }),
      NOW,
    )
    expect(out.segment).toBe('vip')
  })

  it('VIP takes precedence over at_risk', () => {
    // A big spender who hasn't ordered in 70 days is still VIP.
    const out = segmentCustomer(
      snap({
        ordersCount: VIP_ORDER_THRESHOLD + 2,
        totalSpent: VIP_SPEND_THRESHOLD + 1000,
        firstOrderAt: daysAgo(400),
        lastOrderAt: daysAgo(AT_RISK_DAYS_NO_ORDER + 10),
      }),
      NOW,
    )
    expect(out.segment).toBe('vip')
  })
})

// ---------------------------------------------------------------------------
// at_risk — no order in 60+ days (but not yet inactive)
// ---------------------------------------------------------------------------

describe('segmentCustomer — at_risk branch', () => {
  it('returns "at_risk" when last order is older than AT_RISK_DAYS_NO_ORDER', () => {
    const out = segmentCustomer(
      snap({
        ordersCount: 2,
        totalSpent: 80,
        firstOrderAt: daysAgo(120),
        lastOrderAt: daysAgo(AT_RISK_DAYS_NO_ORDER + 1),
      }),
      NOW,
    )
    expect(out.segment).toBe('at_risk')
  })

  it('does NOT return at_risk when last order is recent', () => {
    const out = segmentCustomer(
      snap({
        ordersCount: 2,
        totalSpent: 80,
        firstOrderAt: daysAgo(120),
        lastOrderAt: daysAgo(AT_RISK_DAYS_NO_ORDER - 1),
      }),
      NOW,
    )
    expect(out.segment).not.toBe('at_risk')
  })
})

// ---------------------------------------------------------------------------
// inactive — no order in 180+ days
// ---------------------------------------------------------------------------

describe('segmentCustomer — inactive branch', () => {
  it('returns "inactive" when last order is older than INACTIVE_DAYS_NO_ORDER', () => {
    const out = segmentCustomer(
      snap({
        ordersCount: 2,
        totalSpent: 80,
        firstOrderAt: daysAgo(400),
        lastOrderAt: daysAgo(INACTIVE_DAYS_NO_ORDER + 1),
      }),
      NOW,
    )
    expect(out.segment).toBe('inactive')
  })

  it('inactive takes precedence over at_risk', () => {
    const out = segmentCustomer(
      snap({
        ordersCount: 2,
        totalSpent: 80,
        firstOrderAt: daysAgo(400),
        lastOrderAt: daysAgo(INACTIVE_DAYS_NO_ORDER + 30),
      }),
      NOW,
    )
    expect(out.segment).toBe('inactive')
  })
})

// ---------------------------------------------------------------------------
// returning — default for active buyers that aren't VIP/new
// ---------------------------------------------------------------------------

describe('segmentCustomer — returning branch', () => {
  it('returns "returning" for a repeat buyer under VIP thresholds', () => {
    const out = segmentCustomer(
      snap({
        ordersCount: 3,
        totalSpent: 150,
        firstOrderAt: daysAgo(120),
        lastOrderAt: daysAgo(10),
      }),
      NOW,
    )
    expect(out.segment).toBe('returning')
  })
})

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

describe('segmentCustomer — output shape', () => {
  it('returns a complete result with segment, reasons, metrics', () => {
    const out = segmentCustomer(
      snap({
        ordersCount: 3,
        totalSpent: 150,
        firstOrderAt: daysAgo(120),
        lastOrderAt: daysAgo(10),
      }),
      NOW,
    )
    expect(typeof out.segment).toBe('string')
    expect(Array.isArray(out.reasons)).toBe(true)
    expect(typeof out.metrics.daysSinceLastOrder).toBe('number')
    expect(out.metrics.daysSinceLastOrder).toBe(10)
    expect(out.metrics.daysSinceFirstOrder).toBe(120)
    expect(out.metrics.ordersCount).toBe(3)
    expect(out.metrics.totalSpent).toBe(150)
  })

  it('handles a missing lastOrderAt gracefully', () => {
    const out = segmentCustomer(snap({ ordersCount: 0 }), NOW)
    expect(out.metrics.daysSinceLastOrder).toBeNull()
    expect(out.metrics.daysSinceFirstOrder).toBeNull()
  })

  it('every segment label in the union is reachable', () => {
    // Spot-check the TypeScript enum is in sync with the
    // branches above.
    const reached = new Set<CustomerSegment>()
    reached.add(segmentCustomer(snap({ ordersCount: 0 }), NOW).segment)
    reached.add(
      segmentCustomer(
        snap({
          ordersCount: 1,
          totalSpent: 10,
          firstOrderAt: daysAgo(1),
          lastOrderAt: daysAgo(1),
        }),
        NOW,
      ).segment,
    )
    reached.add(
      segmentCustomer(
        snap({
          ordersCount: 3,
          totalSpent: 150,
          firstOrderAt: daysAgo(120),
          lastOrderAt: daysAgo(10),
        }),
        NOW,
      ).segment,
    )
    reached.add(
      segmentCustomer(
        snap({
          ordersCount: 5,
          totalSpent: VIP_SPEND_THRESHOLD,
          firstOrderAt: daysAgo(200),
          lastOrderAt: daysAgo(5),
        }),
        NOW,
      ).segment,
    )
    reached.add(
      segmentCustomer(
        snap({
          ordersCount: 2,
          totalSpent: 80,
          firstOrderAt: daysAgo(120),
          lastOrderAt: daysAgo(AT_RISK_DAYS_NO_ORDER + 1),
        }),
        NOW,
      ).segment,
    )
    reached.add(
      segmentCustomer(
        snap({
          ordersCount: 2,
          totalSpent: 80,
          firstOrderAt: daysAgo(400),
          lastOrderAt: daysAgo(INACTIVE_DAYS_NO_ORDER + 1),
        }),
        NOW,
      ).segment,
    )
    expect(reached.size).toBe(6)
  })
})
