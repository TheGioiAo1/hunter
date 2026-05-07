/**
 * Unit tests — emitter dedup-key helpers (Phase 14 PR6).
 *
 * Each dedup-key format is part of the platform-alerts contract — if
 * one of these helpers drifts, an emitter that was previously dedup'd
 * starts spamming the inbox. These tests lock the format.
 *
 * Full emitter behaviour (the INSERT + send path) is exercised in the
 * end-to-end smoke; here we test the pure key builders.
 */

import { describe, it, expect } from 'vitest'
import { __internalDedupHelpers } from './emitters.js'

const { utcDate, utcYearMonth, utcIsoWeek, utcFiveMinuteSlot, incidentHash } =
  __internalDedupHelpers

describe('utcDate', () => {
  it('renders YYYY-MM-DD in UTC', () => {
    const d = new Date('2026-04-22T14:37:00Z')
    expect(utcDate(d)).toBe('2026-04-22')
  })

  it('uses UTC even when local TZ straddles midnight', () => {
    // 2026-04-22 23:30 UTC → stays on the 22nd in UTC regardless of local TZ
    const d = new Date('2026-04-22T23:30:00Z')
    expect(utcDate(d)).toBe('2026-04-22')
  })
})

describe('utcYearMonth', () => {
  it('renders YYYYMM with no separator (churn dedup-key shape)', () => {
    const d = new Date('2026-04-22T10:00:00Z')
    expect(utcYearMonth(d)).toBe('202604')
  })
})

describe('utcIsoWeek', () => {
  it('returns ISO-year + ISO-week (YYYY-WW) for a mid-week date', () => {
    // Thu 2026-04-23 UTC → ISO week 17 of 2026
    const d = new Date('2026-04-23T12:00:00Z')
    expect(utcIsoWeek(d)).toMatch(/^2026-\d{2}$/)
  })

  it('zero-pads week numbers below 10', () => {
    // 2026-01-05 → week 02 of 2026
    const d = new Date('2026-01-05T12:00:00Z')
    expect(utcIsoWeek(d)).toMatch(/-0\d$/)
  })

  it('renders the same week for every day Mon-Sun of that week', () => {
    // Week containing 2026-04-22 (Wed)
    const mon = new Date('2026-04-20T00:00:00Z')
    const sun = new Date('2026-04-26T23:59:59Z')
    expect(utcIsoWeek(mon)).toBe(utcIsoWeek(sun))
  })
})

describe('utcFiveMinuteSlot', () => {
  it('floors minutes to the nearest 5-min boundary', () => {
    const d1 = new Date('2026-04-22T14:07:05Z')
    const d2 = new Date('2026-04-22T14:09:59Z')
    const d3 = new Date('2026-04-22T14:10:00Z')
    expect(utcFiveMinuteSlot(d1)).toBe('202604221405')
    expect(utcFiveMinuteSlot(d2)).toBe('202604221405')
    expect(utcFiveMinuteSlot(d3)).toBe('202604221410')
  })

  it('renders exactly 12 chars (YYYYMMDDHHMM)', () => {
    expect(utcFiveMinuteSlot(new Date('2026-01-02T03:04:05Z'))).toHaveLength(12)
  })

  it('zero-pads month / day / hour / minute', () => {
    const d = new Date('2026-01-02T03:04:05Z')
    expect(utcFiveMinuteSlot(d)).toBe('202601020300')
  })
})

describe('incidentHash', () => {
  it('returns a 32-char hex truncation of sha256(msg + env)', () => {
    expect(incidentHash('boom', 'production')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('is deterministic (same inputs → same output)', () => {
    const a = incidentHash('boom', 'production')
    const b = incidentHash('boom', 'production')
    expect(a).toBe(b)
  })

  it('differs for different env (prod vs staging same msg)', () => {
    // Each env has its own alert lane — a staging error should not
    // silence a prod alert for the same message.
    const a = incidentHash('boom', 'production')
    const b = incidentHash('boom', 'staging')
    expect(a).not.toBe(b)
  })

  it('differs for different messages', () => {
    const a = incidentHash('boom', 'production')
    const b = incidentHash('bang', 'production')
    expect(a).not.toBe(b)
  })
})
