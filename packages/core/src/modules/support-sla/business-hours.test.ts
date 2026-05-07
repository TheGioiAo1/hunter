/**
 * Tests for `business-hours.ts` — pure time math, no DB.
 */

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_BUSINESS_HOURS,
  isInsideBusinessHours,
  nextBusinessHoursStart,
} from './business-hours.ts'

describe('isInsideBusinessHours', () => {
  it('returns true mid-morning Monday in ICT', () => {
    // 2026-04-20 (Mon) 10:30 ICT = 03:30 UTC
    const d = new Date('2026-04-20T03:30:00Z')
    expect(isInsideBusinessHours(d, DEFAULT_BUSINESS_HOURS)).toBe(true)
  })

  it('returns false at 07:59 ICT (before opening)', () => {
    // 2026-04-20 (Mon) 07:59 ICT = 00:59 UTC
    const d = new Date('2026-04-20T00:59:00Z')
    expect(isInsideBusinessHours(d, DEFAULT_BUSINESS_HOURS)).toBe(false)
  })

  it('returns true at 08:00 ICT (opens exactly)', () => {
    // 2026-04-20 (Mon) 08:00 ICT = 01:00 UTC
    const d = new Date('2026-04-20T01:00:00Z')
    expect(isInsideBusinessHours(d, DEFAULT_BUSINESS_HOURS)).toBe(true)
  })

  it('returns false at 18:00 ICT (closes exactly — exclusive)', () => {
    // 2026-04-20 (Mon) 18:00 ICT = 11:00 UTC
    const d = new Date('2026-04-20T11:00:00Z')
    expect(isInsideBusinessHours(d, DEFAULT_BUSINESS_HOURS)).toBe(false)
  })

  it('returns false on Saturday at 10:00 ICT', () => {
    // 2026-04-25 (Sat) 10:00 ICT = 03:00 UTC
    const d = new Date('2026-04-25T03:00:00Z')
    expect(isInsideBusinessHours(d, DEFAULT_BUSINESS_HOURS)).toBe(false)
  })

  it('returns false on Sunday at 10:00 ICT', () => {
    // 2026-04-26 (Sun) 10:00 ICT = 03:00 UTC
    const d = new Date('2026-04-26T03:00:00Z')
    expect(isInsideBusinessHours(d, DEFAULT_BUSINESS_HOURS)).toBe(false)
  })

  it('honours custom days (Sunday included)', () => {
    // 2026-04-26 (Sun) 10:00 ICT
    const d = new Date('2026-04-26T03:00:00Z')
    expect(
      isInsideBusinessHours(d, {
        ...DEFAULT_BUSINESS_HOURS,
        days: [0, 1, 2, 3, 4, 5, 6],
      }),
    ).toBe(true)
  })
})

describe('nextBusinessHoursStart', () => {
  it('returns the same instant if already inside hours', () => {
    const d = new Date('2026-04-20T03:30:00Z') // Mon 10:30 ICT
    const next = nextBusinessHoursStart(d, DEFAULT_BUSINESS_HOURS)
    expect(next.toISOString()).toBe(d.toISOString())
  })

  it('jumps to today 08:00 ICT when still before opening on a workday', () => {
    const d = new Date('2026-04-20T00:30:00Z') // Mon 07:30 ICT
    const next = nextBusinessHoursStart(d, DEFAULT_BUSINESS_HOURS)
    expect(next.toISOString()).toBe('2026-04-20T01:00:00.000Z') // Mon 08:00 ICT
  })

  it('jumps to tomorrow 08:00 ICT when after closing on Friday → Monday', () => {
    // 2026-04-24 (Fri) 19:00 ICT = 12:00 UTC
    const d = new Date('2026-04-24T12:00:00Z')
    const next = nextBusinessHoursStart(d, DEFAULT_BUSINESS_HOURS)
    // Should land on Mon 2026-04-27 08:00 ICT = 01:00 UTC
    expect(next.toISOString()).toBe('2026-04-27T01:00:00.000Z')
  })

  it('jumps from Saturday to Monday morning', () => {
    // 2026-04-25 (Sat) 10:00 ICT
    const d = new Date('2026-04-25T03:00:00Z')
    const next = nextBusinessHoursStart(d, DEFAULT_BUSINESS_HOURS)
    // Mon 2026-04-27 08:00 ICT = 01:00 UTC
    expect(next.toISOString()).toBe('2026-04-27T01:00:00.000Z')
  })

  it('jumps from Sunday to Monday morning', () => {
    // 2026-04-26 (Sun) 15:00 ICT = 08:00 UTC
    const d = new Date('2026-04-26T08:00:00Z')
    const next = nextBusinessHoursStart(d, DEFAULT_BUSINESS_HOURS)
    expect(next.toISOString()).toBe('2026-04-27T01:00:00.000Z')
  })
})
