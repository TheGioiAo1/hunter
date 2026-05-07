/**
 * Unit tests for scripts/ops/backfill-daily-metrics.ts (Phase 6 PR1).
 *
 * Only the pure date-range helper is tested here; the DB-bound main()
 * is covered by the live smoke.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildDateRange } from './backfill-daily-metrics.js'

describe('buildDateRange', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function pinToday(isoUtc: string) {
    // Pin "now" to isoUtc midnight UTC so `yesterdayUtc()` is deterministic.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(`${isoUtc}T12:00:00Z`))
  }

  it('--days=1 yields a single day (yesterday UTC)', () => {
    pinToday('2026-04-21')
    const r = buildDateRange({ days: 1, since: null, until: null })
    expect(r).toEqual(['2026-04-20'])
  })

  it('--days=7 yields the last 7 days through yesterday UTC', () => {
    pinToday('2026-04-21')
    const r = buildDateRange({ days: 7, since: null, until: null })
    expect(r).toHaveLength(7)
    expect(r[0]).toBe('2026-04-14')
    expect(r[r.length - 1]).toBe('2026-04-20')
  })

  it('explicit --since + --until inclusive', () => {
    const r = buildDateRange({ days: null, since: '2026-01-01', until: '2026-01-03' })
    expect(r).toEqual(['2026-01-01', '2026-01-02', '2026-01-03'])
  })

  it('--since with default until = yesterday UTC', () => {
    pinToday('2026-04-21')
    const r = buildDateRange({ days: null, since: '2026-04-18', until: null })
    expect(r).toEqual(['2026-04-18', '2026-04-19', '2026-04-20'])
  })

  it('defaults to last 7 days when nothing specified', () => {
    pinToday('2026-04-21')
    const r = buildDateRange({ days: null, since: null, until: null })
    expect(r).toHaveLength(7)
    expect(r[0]).toBe('2026-04-14')
    expect(r[6]).toBe('2026-04-20')
  })

  it('handles a single-day range (since == until)', () => {
    const r = buildDateRange({ days: null, since: '2026-01-15', until: '2026-01-15' })
    expect(r).toEqual(['2026-01-15'])
  })

  it('spans month boundaries correctly', () => {
    const r = buildDateRange({ days: null, since: '2026-01-30', until: '2026-02-02' })
    expect(r).toEqual(['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02'])
  })

  it('spans year boundaries correctly', () => {
    const r = buildDateRange({ days: null, since: '2025-12-30', until: '2026-01-02' })
    expect(r).toEqual(['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02'])
  })

  it('handles leap year Feb 29 (2028 is a leap year)', () => {
    const r = buildDateRange({ days: null, since: '2028-02-28', until: '2028-03-01' })
    expect(r).toEqual(['2028-02-28', '2028-02-29', '2028-03-01'])
  })
})
