/**
 * Unit tests for daily-metrics.ts (Phase 6 PR1).
 *
 * The DB-bound functions (`rollupDay`, `rollupYesterdayAllShops`,
 * `getMetrics`, `incrementToday`, `incrementVisitor`) are covered by
 * the live smoke test under scripts/smoke-phase6-pr1.ts.
 *
 * This file only exercises the pure helpers — `summarizeMetrics` which
 * is the math the dashboard uses to turn a `daily_metrics` window into
 * a one-row summary card.
 */

import { describe, it, expect } from 'vitest'
import {
  summarizeMetrics,
  findMissingDates,
  computePruneCutoff,
  isoDay,
  type DailyMetric,
} from './daily-metrics.js'

function row(partial: Partial<DailyMetric>): DailyMetric {
  return {
    shop_id: 'test-shop',
    date: '2026-01-01',
    orders_count: 0,
    revenue: '0',
    refunds: '0',
    visitors: 0,
    conversions: 0,
    currency: 'USD',
    updated_at: '2026-01-01T00:00:00Z',
    ...partial,
  } as unknown as DailyMetric
}

describe('summarizeMetrics', () => {
  it('returns zeros on an empty array, defaults to USD', () => {
    const s = summarizeMetrics([])
    expect(s.orders_count).toBe(0)
    expect(s.revenue).toBe('0.00')
    expect(s.refunds).toBe('0.00')
    expect(s.net_revenue).toBe('0.00')
    expect(s.currency).toBe('USD')
  })

  it('sums order count across rows', () => {
    const s = summarizeMetrics([
      row({ orders_count: 3 }),
      row({ orders_count: 7 }),
      row({ orders_count: 0 }),
    ])
    expect(s.orders_count).toBe(10)
  })

  it('sums revenue with 2-decimal output (stored as string)', () => {
    const s = summarizeMetrics([
      row({ revenue: '100.50' }),
      row({ revenue: '49.99' }),
      row({ revenue: '0.01' }),
    ])
    expect(s.revenue).toBe('150.50')
  })

  it('subtracts refunds from revenue for net_revenue', () => {
    const s = summarizeMetrics([
      row({ revenue: '1000.00', refunds: '150.00' }),
      row({ revenue: '500.00', refunds: '25.50' }),
    ])
    expect(s.revenue).toBe('1500.00')
    expect(s.refunds).toBe('175.50')
    expect(s.net_revenue).toBe('1324.50')
  })

  it('net_revenue can be negative if refunds > revenue (edge case)', () => {
    const s = summarizeMetrics([
      row({ revenue: '10.00', refunds: '50.00' }),
    ])
    expect(s.net_revenue).toBe('-40.00')
  })

  it('picks currency from the first row', () => {
    const s = summarizeMetrics([
      row({ currency: 'VND' }),
      row({ currency: 'USD' }),
    ])
    expect(s.currency).toBe('VND')
  })

  it('falls back to USD when currency is null/empty', () => {
    const s = summarizeMetrics([
      row({ currency: null as any }),
    ])
    expect(s.currency).toBe('USD')
  })

  it('tolerates null/undefined numeric fields', () => {
    const s = summarizeMetrics([
      row({ orders_count: null as any, revenue: null as any, refunds: null as any }),
      row({ orders_count: 2, revenue: '10.00' }),
    ])
    expect(s.orders_count).toBe(2)
    expect(s.revenue).toBe('10.00')
    expect(s.refunds).toBe('0.00')
    expect(s.net_revenue).toBe('10.00')
  })

  it('rounds floating-point artefacts to 2dp (0.1 + 0.2 problem)', () => {
    const s = summarizeMetrics([
      row({ revenue: '0.1' }),
      row({ revenue: '0.2' }),
    ])
    // Without .toFixed(2) this would be '0.30000000000000004'.
    expect(s.revenue).toBe('0.30')
  })
})

// ---------------------------------------------------------------------------
// Phase 6 PR4 — consistency helpers
// ---------------------------------------------------------------------------

describe('isoDay (pg Date normalization)', () => {
  it('returns YYYY-MM-DD for a string input', () => {
    expect(isoDay('2026-04-15')).toBe('2026-04-15')
  })

  it('returns YYYY-MM-DD for a Date input (pg driver default)', () => {
    // This is what node-postgres hands back for a `date` column.
    const d = new Date('2026-04-15T00:00:00Z')
    expect(isoDay(d)).toBe('2026-04-15')
  })

  it('returns YYYY-MM-DD for an ISO timestamp string', () => {
    expect(isoDay('2026-04-15T12:34:56.789Z')).toBe('2026-04-15')
  })

  it('returns null for bogus Date', () => {
    expect(isoDay(new Date('bogus'))).toBeNull()
  })

  it('returns null for non-ISO strings (e.g. Date.toString() output)', () => {
    expect(isoDay('Wed Apr 15 2026 00:00:00 GMT+0000')).toBeNull()
    expect(isoDay('')).toBeNull()
    expect(isoDay('2026/04/15')).toBeNull()
  })

  it('returns null for null/undefined/number/boolean', () => {
    expect(isoDay(null)).toBeNull()
    expect(isoDay(undefined)).toBeNull()
    expect(isoDay(42)).toBeNull()
    expect(isoDay(true)).toBeNull()
    expect(isoDay({})).toBeNull()
  })
})

describe('findMissingDates', () => {
  it('returns every day in the span when nothing exists', () => {
    expect(findMissingDates([], '2026-04-01', '2026-04-03')).toEqual([
      '2026-04-01',
      '2026-04-02',
      '2026-04-03',
    ])
  })

  it('returns [] when every day already exists', () => {
    expect(
      findMissingDates(
        ['2026-04-01', '2026-04-02', '2026-04-03'],
        '2026-04-01',
        '2026-04-03',
      ),
    ).toEqual([])
  })

  it('returns only the gaps when some days exist', () => {
    expect(
      findMissingDates(
        ['2026-04-01', '2026-04-03'],
        '2026-04-01',
        '2026-04-05',
      ),
    ).toEqual(['2026-04-02', '2026-04-04', '2026-04-05'])
  })

  it('tolerates duplicate entries in the existing set', () => {
    expect(
      findMissingDates(
        ['2026-04-01', '2026-04-01', '2026-04-02'],
        '2026-04-01',
        '2026-04-03',
      ),
    ).toEqual(['2026-04-03'])
  })

  it('tolerates ISO timestamps (not just dates) in the existing set', () => {
    // Postgres's `date` column can return `'2026-04-01T00:00:00.000Z'` through
    // some drivers — strip to YYYY-MM-DD before comparing.
    expect(
      findMissingDates(
        ['2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z'],
        '2026-04-01',
        '2026-04-03',
      ),
    ).toEqual(['2026-04-03'])
  })

  it('returns [] when since > until (inverted span)', () => {
    expect(findMissingDates([], '2026-04-05', '2026-04-01')).toEqual([])
  })

  it('handles a single-day span (since == until)', () => {
    expect(findMissingDates([], '2026-04-01', '2026-04-01')).toEqual([
      '2026-04-01',
    ])
    expect(
      findMissingDates(['2026-04-01'], '2026-04-01', '2026-04-01'),
    ).toEqual([])
  })

  it('crosses month boundaries correctly', () => {
    expect(findMissingDates([], '2026-01-30', '2026-02-02')).toEqual([
      '2026-01-30',
      '2026-01-31',
      '2026-02-01',
      '2026-02-02',
    ])
  })

  it('accepts raw Date objects from pg driver', () => {
    // Regression test: before isoDay() the pg default Date type was
    // silently dropped, so every read-based gap detector thought the
    // table was empty and over-rolled every day.
    expect(
      findMissingDates(
        [
          new Date('2026-04-01T00:00:00Z'),
          new Date('2026-04-03T00:00:00Z'),
        ],
        '2026-04-01',
        '2026-04-03',
      ),
    ).toEqual(['2026-04-02'])
  })

  it('ignores garbage entries mixed in with valid ones', () => {
    expect(
      findMissingDates(
        ['2026-04-01', 'bogus', null as any, 42 as any, '2026-04-03'],
        '2026-04-01',
        '2026-04-03',
      ),
    ).toEqual(['2026-04-02'])
  })
})

describe('computePruneCutoff', () => {
  it('returns an ISO date retainDays before today UTC', () => {
    // 2026-05-01 UTC → retain 30d → cutoff 2026-04-01
    const cutoff = computePruneCutoff(30, new Date('2026-05-01T12:34:56Z'))
    expect(cutoff).toBe('2026-04-01')
  })

  it('floors the time-of-day so dashboards deterministically see the same cutoff', () => {
    // Last second of the day must resolve the same as first second.
    const start = computePruneCutoff(7, new Date('2026-04-21T00:00:00Z'))
    const end = computePruneCutoff(7, new Date('2026-04-21T23:59:59Z'))
    expect(start).toBe(end)
  })

  it('clamps retainDays to at least 1 (never prunes today)', () => {
    const cutoff = computePruneCutoff(0, new Date('2026-04-21T12:00:00Z'))
    expect(cutoff).toBe('2026-04-20')
  })

  it('treats negative retainDays as 1', () => {
    const cutoff = computePruneCutoff(-5, new Date('2026-04-21T12:00:00Z'))
    expect(cutoff).toBe('2026-04-20')
  })

  it('default 400 cutoff ~= 13 months ago', () => {
    const cutoff = computePruneCutoff(400, new Date('2026-04-21T00:00:00Z'))
    expect(cutoff).toBe('2025-03-17')
  })
})
