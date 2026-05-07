/**
 * Unit tests for platform.ts (Phase 6 PR5 — god-admin platform analytics).
 *
 * The DB-bound functions (`getPlatformOverview`, `getShopLeaderboard`,
 * `getShopGrowth`, `getPlatformTimeSeries`, `getPlatformHealth`) are
 * covered by the live smoke test under scripts/smoke-phase6-pr5.ts.
 *
 * This file exercises the pure helpers that compute period-over-period
 * deltas — the math the god-admin dashboard uses to annotate cards with
 * up/down/flat arrows.
 */

import { describe, it, expect } from 'vitest'
import {
  changePercent,
  classifyDirection,
  previousPeriod,
} from './platform.js'

describe('changePercent', () => {
  it('returns 0 when both current and previous are 0', () => {
    expect(changePercent(0, 0)).toBe(0)
  })

  it('returns 100 when previous is 0 and current > 0 (new activity)', () => {
    expect(changePercent(10, 0)).toBe(100)
    expect(changePercent(1, 0)).toBe(100)
    expect(changePercent(99999, 0)).toBe(100)
  })

  it('returns -100 when previous is 0 and current < 0 (edge)', () => {
    expect(changePercent(-5, 0)).toBe(-100)
  })

  it('computes positive change correctly', () => {
    // 100 → 150: +50%
    expect(changePercent(150, 100)).toBe(50)
  })

  it('computes negative change correctly', () => {
    // 100 → 50: -50%
    expect(changePercent(50, 100)).toBe(-50)
  })

  it('computes large positive change correctly', () => {
    // 10 → 100: +900%
    expect(changePercent(100, 10)).toBe(900)
  })

  it('rounds to 2 decimal places', () => {
    // 100 → 101: +1%
    expect(changePercent(101, 100)).toBe(1)
    // 100 → 133: +33%
    expect(changePercent(133, 100)).toBe(33)
    // 3 → 4: +33.33%
    expect(changePercent(4, 3)).toBe(33.33)
  })

  it('returns 0 when either input is NaN/Infinity', () => {
    expect(changePercent(NaN, 100)).toBe(0)
    expect(changePercent(100, NaN)).toBe(0)
    expect(changePercent(Infinity, 100)).toBe(0)
    expect(changePercent(100, Infinity)).toBe(0)
    expect(changePercent(-Infinity, 100)).toBe(0)
  })

  it('handles zero current correctly (loss of all activity)', () => {
    // 100 → 0: -100%
    expect(changePercent(0, 100)).toBe(-100)
  })

  it('handles identical values (no change)', () => {
    expect(changePercent(500, 500)).toBe(0)
    expect(changePercent(0.5, 0.5)).toBe(0)
  })
})

describe('classifyDirection', () => {
  it('returns "flat" for small changes within the default ±5% window', () => {
    expect(classifyDirection(0)).toBe('flat')
    expect(classifyDirection(3)).toBe('flat')
    expect(classifyDirection(-4.99)).toBe('flat')
    expect(classifyDirection(4.99)).toBe('flat')
  })

  it('returns "up" for positive changes ≥ 5%', () => {
    expect(classifyDirection(5)).toBe('up')
    expect(classifyDirection(10)).toBe('up')
    expect(classifyDirection(100)).toBe('up')
  })

  it('returns "down" for negative changes ≤ -5%', () => {
    expect(classifyDirection(-5)).toBe('down')
    expect(classifyDirection(-10)).toBe('down')
    expect(classifyDirection(-100)).toBe('down')
  })

  it('respects a custom flatWindow', () => {
    // ±1% window: tight
    expect(classifyDirection(0.5, 1)).toBe('flat')
    expect(classifyDirection(1, 1)).toBe('up')
    expect(classifyDirection(-1, 1)).toBe('down')

    // ±10% window: loose
    expect(classifyDirection(7, 10)).toBe('flat')
    expect(classifyDirection(10, 10)).toBe('up')
    expect(classifyDirection(-10, 10)).toBe('down')
  })

  it('treats exactly ±flatWindow as non-flat (boundary check)', () => {
    // Math.abs(5) < 5 is false → not flat → up
    expect(classifyDirection(5, 5)).toBe('up')
    expect(classifyDirection(-5, 5)).toBe('down')
  })
})

describe('previousPeriod', () => {
  it('returns a range of equal span immediately before the input range', () => {
    const range = {
      since: '2026-04-01T00:00:00.000Z',
      until: '2026-04-08T00:00:00.000Z', // 7-day span
    }
    const prev = previousPeriod(range)
    expect(prev.since).toBe('2026-03-25T00:00:00.000Z')
    expect(prev.until).toBe('2026-04-01T00:00:00.000Z')
  })

  it('works for a 30-day range', () => {
    const range = {
      since: '2026-04-01T00:00:00.000Z',
      until: '2026-05-01T00:00:00.000Z', // 30-day span
    }
    const prev = previousPeriod(range)
    expect(prev.since).toBe('2026-03-02T00:00:00.000Z')
    expect(prev.until).toBe('2026-04-01T00:00:00.000Z')
  })

  it('works for a 90-day range', () => {
    const range = {
      since: '2026-01-01T00:00:00.000Z',
      until: '2026-04-01T00:00:00.000Z', // 90-day span
    }
    const prev = previousPeriod(range)
    expect(prev.since).toBe('2025-10-03T00:00:00.000Z')
    expect(prev.until).toBe('2026-01-01T00:00:00.000Z')
  })

  it("prev.until exactly equals range.since (no gap, no overlap)", () => {
    const range = {
      since: '2026-04-15T12:34:56.789Z',
      until: '2026-04-22T12:34:56.789Z',
    }
    const prev = previousPeriod(range)
    expect(prev.until).toBe(range.since)
  })

  it('prev range has same millisecond span as input', () => {
    const range = {
      since: '2026-04-01T00:00:00.000Z',
      until: '2026-04-05T00:00:00.000Z',
    }
    const prev = previousPeriod(range)
    const rangeSpan =
      new Date(range.until).getTime() - new Date(range.since).getTime()
    const prevSpan =
      new Date(prev.until).getTime() - new Date(prev.since).getTime()
    expect(prevSpan).toBe(rangeSpan)
  })

  it('handles a 1-day range', () => {
    const range = {
      since: '2026-04-20T00:00:00.000Z',
      until: '2026-04-21T00:00:00.000Z', // 1-day span
    }
    const prev = previousPeriod(range)
    expect(prev.since).toBe('2026-04-19T00:00:00.000Z')
    expect(prev.until).toBe('2026-04-20T00:00:00.000Z')
  })

  it('handles a zero-duration range (since === until)', () => {
    const range = {
      since: '2026-04-21T00:00:00.000Z',
      until: '2026-04-21T00:00:00.000Z',
    }
    const prev = previousPeriod(range)
    expect(prev.since).toBe(range.since)
    expect(prev.until).toBe(range.since)
  })
})
