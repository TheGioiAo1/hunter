/**
 * Unit tests for inventory-analytics.ts (Phase 6 PR2).
 *
 * Pure helpers only — DB-bound queries are covered by smoke-phase6-pr2.ts.
 */

import { describe, it, expect } from 'vitest'
import {
  computeSellThrough,
  rankBySoldUnits,
  daysSince,
  periodToRange,
} from './inventory-analytics.js'

describe('computeSellThrough', () => {
  it('returns 0 when nothing sold', () => {
    expect(computeSellThrough(0, 100)).toBe(0)
  })

  it('returns 1 when stock has been fully cleared', () => {
    expect(computeSellThrough(50, 0)).toBe(1)
  })

  it('computes the sold / (sold + on_hand) ratio', () => {
    expect(computeSellThrough(25, 75)).toBe(0.25)
    expect(computeSellThrough(40, 60)).toBe(0.4)
    expect(computeSellThrough(90, 10)).toBe(0.9)
  })

  it('returns 0 when both sold and on_hand are 0 (no data)', () => {
    expect(computeSellThrough(0, 0)).toBe(0)
  })

  it('clamps negative on_hand to 0 (treats as "fully sold")', () => {
    // DB drift — inventory went negative somehow. Treat as cleared.
    expect(computeSellThrough(10, -5)).toBe(1)
  })
})

describe('rankBySoldUnits', () => {
  it('sorts by units_sold desc', () => {
    const r = rankBySoldUnits(
      [
        { variant_id: 'a', units_sold: 5, revenue: '50' },
        { variant_id: 'b', units_sold: 20, revenue: '200' },
        { variant_id: 'c', units_sold: 10, revenue: '100' },
      ],
      10,
    )
    expect(r.map((x) => x.variant_id)).toEqual(['b', 'c', 'a'])
  })

  it('breaks units_sold ties by revenue desc', () => {
    const r = rankBySoldUnits(
      [
        { variant_id: 'a', units_sold: 10, revenue: '100' },
        { variant_id: 'b', units_sold: 10, revenue: '500' },
        { variant_id: 'c', units_sold: 10, revenue: '250' },
      ],
      10,
    )
    expect(r.map((x) => x.variant_id)).toEqual(['b', 'c', 'a'])
  })

  it('breaks units+revenue ties by variant_id asc (deterministic)', () => {
    const r = rankBySoldUnits(
      [
        { variant_id: 'z', units_sold: 5, revenue: '100' },
        { variant_id: 'a', units_sold: 5, revenue: '100' },
        { variant_id: 'm', units_sold: 5, revenue: '100' },
      ],
      10,
    )
    expect(r.map((x) => x.variant_id)).toEqual(['a', 'm', 'z'])
  })

  it('slices to the limit', () => {
    const r = rankBySoldUnits(
      Array.from({ length: 20 }, (_, i) => ({
        variant_id: `v-${i}`,
        units_sold: 20 - i,
        revenue: '10',
      })),
      5,
    )
    expect(r).toHaveLength(5)
    expect(r[0].variant_id).toBe('v-0')
    expect(r[4].variant_id).toBe('v-4')
  })

  it('treats missing revenue as 0 during tie-breaking', () => {
    const r = rankBySoldUnits(
      [
        { variant_id: 'a', units_sold: 10 }, // no revenue
        { variant_id: 'b', units_sold: 10, revenue: '0' },
        { variant_id: 'c', units_sold: 10, revenue: '50' },
      ],
      10,
    )
    expect(r[0].variant_id).toBe('c')
  })

  it('does not mutate input array', () => {
    const src = [
      { variant_id: 'a', units_sold: 5 },
      { variant_id: 'b', units_sold: 10 },
    ]
    const srcCopy = [...src]
    rankBySoldUnits(src, 10)
    expect(src).toEqual(srcCopy)
  })

  it('limit=0 yields empty array', () => {
    expect(rankBySoldUnits([{ variant_id: 'a', units_sold: 5 }], 0)).toEqual([])
  })
})

describe('daysSince', () => {
  it('returns null when lastSoldIso is null', () => {
    expect(daysSince(null, new Date())).toBeNull()
  })

  it('returns null when lastSoldIso is unparseable', () => {
    expect(daysSince('not-a-date', new Date())).toBeNull()
  })

  it('returns 0 when last sold is today', () => {
    const now = new Date('2026-04-21T12:00:00Z')
    expect(daysSince('2026-04-21T09:00:00Z', now)).toBe(0)
  })

  it('returns 1 for 24-hour gap', () => {
    const now = new Date('2026-04-21T12:00:00Z')
    expect(daysSince('2026-04-20T12:00:00Z', now)).toBe(1)
  })

  it('returns 90 for 90-day gap (classic dead-stock threshold)', () => {
    const now = new Date('2026-04-21T00:00:00Z')
    expect(daysSince('2026-01-21T00:00:00Z', now)).toBe(90)
  })

  it('returns 0 for future timestamps (clock drift — no negatives)', () => {
    const now = new Date('2026-04-21T12:00:00Z')
    expect(daysSince('2026-04-22T12:00:00Z', now)).toBe(0)
  })
})

describe('periodToRange', () => {
  const NOW = new Date('2026-04-21T12:00:00Z')

  it('default 30d', () => {
    const r = periodToRange('30d', NOW)
    expect(r.days).toBe(30)
    expect(r.label).toBe('Last 30 days')
    expect(r.until).toBe(NOW.toISOString())
    expect(r.since).toBe(new Date(NOW.getTime() - 30 * 86_400_000).toISOString())
  })

  it('7d', () => {
    const r = periodToRange('7d', NOW)
    expect(r.days).toBe(7)
    expect(r.label).toBe('Last 7 days')
  })

  it('90d', () => {
    const r = periodToRange('90d', NOW)
    expect(r.days).toBe(90)
    expect(r.label).toBe('Last 90 days')
  })

  it('unknown periods default to 30d', () => {
    const r = periodToRange('bogus', NOW)
    expect(r.days).toBe(30)
    expect(r.label).toBe('Last 30 days')
  })

  it('empty string defaults to 30d', () => {
    const r = periodToRange('', NOW)
    expect(r.days).toBe(30)
  })
})
