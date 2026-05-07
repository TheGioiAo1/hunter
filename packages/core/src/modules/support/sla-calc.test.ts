/**
 * Gbox Platform — sla-calc.ts unit tests.
 *
 * Pins the hybrid SLA model from spec §10 / Q2.11:
 *
 *   - Payment tickets: 24/7 clock, no business-hour math
 *   - Non-payment tickets: Mon-Fri 08:00-18:00 ICT
 *   - Business-hours math handles:
 *       - opening inside office hours → deadline walks forward N minutes
 *       - opening after 18:00 → deadline slides to next morning + N minutes
 *       - opening on a weekend → deadline slides to next Monday + N minutes
 *       - budget spanning multiple working days
 *
 * Timezone arithmetic is done with `Intl.DateTimeFormat` so we don't
 * take a date-fns-tz dep; that means the tests need to deal in specific
 * UTC instants that map to known wall-clock times in Asia/Ho_Chi_Minh
 * (UTC+7, no DST).
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_BUSINESS_HOURS,
  addBusinessMinutes,
  computeSlaDeadlines,
  dateInTz,
  isSlaBreached,
  type BusinessHours,
} from './sla-calc.ts'

// Convenience: UTC instant for a given ICT wall clock. ICT = UTC+7.
function ict(y: number, m: number, d: number, h: number, min: number): Date {
  // Construct UTC by subtracting 7 hours.
  return new Date(Date.UTC(y, m - 1, d, h - 7, min))
}

describe('dateInTz', () => {
  it('maps a UTC instant to ICT wall clock', () => {
    const d = ict(2026, 4, 22, 10, 30) // Wed 10:30 ICT
    const local = dateInTz(d, 'Asia/Ho_Chi_Minh')
    expect(local).toMatchObject({ year: 2026, month: 4, day: 22, hours: 10, minutes: 30, dow: 3 })
  })

  it('normalises 24:00 to 00:00 (Windows-Node quirk)', () => {
    // Midnight ICT.
    const d = ict(2026, 4, 22, 0, 0)
    const local = dateInTz(d, 'Asia/Ho_Chi_Minh')
    expect(local.hours).toBe(0)
  })

  it('reports correct day-of-week (Sun=0, Sat=6)', () => {
    // Sunday 12:00 ICT = 2026-04-19 05:00 UTC.
    const sun = ict(2026, 4, 19, 12, 0)
    expect(dateInTz(sun, 'Asia/Ho_Chi_Minh').dow).toBe(0)
    // Saturday.
    const sat = ict(2026, 4, 18, 12, 0)
    expect(dateInTz(sat, 'Asia/Ho_Chi_Minh').dow).toBe(6)
  })
})

describe('computeSlaDeadlines', () => {
  it('payment tickets use 24/7 clock (2h first-response / 12h resolution)', () => {
    const openedAt = ict(2026, 4, 22, 23, 0) // Wed 23:00 ICT
    const { firstResponseAt, resolutionAt } = computeSlaDeadlines({
      category: 'payment',
      openedAt,
    })
    // 2h later = Thu 01:00 ICT = Wed 18:00 UTC.
    expect(firstResponseAt).toBe(new Date(openedAt.getTime() + 2 * 3600_000).toISOString())
    // 12h later = Thu 11:00 ICT.
    expect(resolutionAt).toBe(new Date(openedAt.getTime() + 12 * 3600_000).toISOString())
  })

  it('non-payment tickets use business hours (defaults)', () => {
    // Wed 10:00 ICT — inside office. 4h later = Wed 14:00 ICT.
    const openedAt = ict(2026, 4, 22, 10, 0)
    const { firstResponseAt } = computeSlaDeadlines({
      category: 'technical',
      openedAt,
    })
    // 4h of business-hours inside office = plain +4h = 14:00 ICT.
    expect(firstResponseAt).toBe(new Date(openedAt.getTime() + 4 * 3600_000).toISOString())
  })

  it('non-payment opened after 18:00 → deadline rolls to next business day', () => {
    // Wed 19:00 ICT — after close. 4h budget starts Thu 08:00 ICT → Thu 12:00 ICT.
    const openedAt = ict(2026, 4, 22, 19, 0)
    const expected = ict(2026, 4, 23, 12, 0).toISOString()
    const { firstResponseAt } = computeSlaDeadlines({
      category: 'technical',
      openedAt,
    })
    expect(firstResponseAt).toBe(expected)
  })

  it('non-payment opened on a Saturday → deadline rolls to Monday', () => {
    // Sat 10:00 ICT. 4h budget starts Mon 08:00 ICT → Mon 12:00 ICT.
    const openedAt = ict(2026, 4, 18, 10, 0) // Sat
    const expected = ict(2026, 4, 20, 12, 0).toISOString() // Mon
    const { firstResponseAt } = computeSlaDeadlines({
      category: 'technical',
      openedAt,
    })
    expect(firstResponseAt).toBe(expected)
  })
})

describe('addBusinessMinutes', () => {
  it('inside-office burn: 2h at 10:00 Wed → 12:00 Wed', () => {
    const from = ict(2026, 4, 22, 10, 0)
    const out = addBusinessMinutes(from, 120)
    expect(out).toBe(ict(2026, 4, 22, 12, 0).toISOString())
  })

  it('crosses an overnight boundary: 6h at 15:00 Wed → 11:00 Thu', () => {
    // 15:00 + 3h = 18:00 (close). Remaining 3h → Thu 08:00 + 3h = Thu 11:00.
    const from = ict(2026, 4, 22, 15, 0)
    const out = addBusinessMinutes(from, 360)
    expect(out).toBe(ict(2026, 4, 23, 11, 0).toISOString())
  })

  it('crosses a weekend: open Fri 17:00, 4h budget → Mon 11:00', () => {
    // Fri 17:00 + 1h = Fri 18:00 (close). Remaining 3h → Mon 08:00 + 3h = Mon 11:00.
    const from = ict(2026, 4, 17, 17, 0) // Fri
    const out = addBusinessMinutes(from, 240)
    expect(out).toBe(ict(2026, 4, 20, 11, 0).toISOString()) // Mon
  })

  it('opened before 08:00 on a weekday → skips to 08:00 first', () => {
    // Wed 06:00 + 4h → Wed 12:00.
    const from = ict(2026, 4, 22, 6, 0)
    const out = addBusinessMinutes(from, 240)
    expect(out).toBe(ict(2026, 4, 22, 12, 0).toISOString())
  })

  it('opened on Sunday → skips to Monday 08:00 + budget', () => {
    // Sun 15:00 + 3h → Mon 08:00 + 3h = Mon 11:00.
    const from = ict(2026, 4, 19, 15, 0)
    const out = addBusinessMinutes(from, 180)
    expect(out).toBe(ict(2026, 4, 20, 11, 0).toISOString())
  })

  it('long budget (24h) spans multiple working days', () => {
    // Working window is 10h/day. 24h budget opening Mon 08:00:
    //   Mon 08:00→18:00 burns 10h (14h remaining)
    //   Tue 08:00→18:00 burns 10h  (4h remaining)
    //   Wed 08:00 + 4h      → Wed 12:00
    const from = ict(2026, 4, 20, 8, 0) // Mon
    const out = addBusinessMinutes(from, 24 * 60)
    expect(out).toBe(ict(2026, 4, 22, 12, 0).toISOString()) // Wed 12:00
  })

  it('zero budget is a no-op', () => {
    const from = ict(2026, 4, 22, 10, 0)
    expect(addBusinessMinutes(from, 0)).toBe(from.toISOString())
  })

  it('throws on misconfigured empty working-day set', () => {
    const bh: BusinessHours = { ...DEFAULT_BUSINESS_HOURS, days: [] }
    expect(() => addBusinessMinutes(ict(2026, 4, 22, 10, 0), 10, bh)).toThrow(/days must not be empty/)
  })

  it('throws on misconfigured start >= end', () => {
    const bh: BusinessHours = { ...DEFAULT_BUSINESS_HOURS, start: '18:00', end: '08:00' }
    expect(() => addBusinessMinutes(ict(2026, 4, 22, 10, 0), 10, bh)).toThrow(/must be </)
  })
})

describe('isSlaBreached', () => {
  it('returns false before the deadline', () => {
    const deadline = new Date('2026-04-22T10:00:00.000Z')
    expect(
      isSlaBreached({
        deadlineAt: deadline.toISOString(),
        pausedTotalMs: 0,
        pausedAt: null,
        now: new Date('2026-04-22T09:59:00.000Z'),
      }),
    ).toBe(false)
  })

  it('returns true after the deadline (ignoring pause)', () => {
    expect(
      isSlaBreached({
        deadlineAt: '2026-04-22T10:00:00.000Z',
        pausedTotalMs: 0,
        pausedAt: null,
        now: new Date('2026-04-22T10:01:00.000Z'),
      }),
    ).toBe(true)
  })

  it('pins the current pausedTotalMs arithmetic', () => {
    // Implementation: elapsed = (now - deadline) + pausedTotalMs
    // With now 10min before deadline but pausedTotalMs = 20min:
    //   elapsed = -600_000 + 1_200_000 = +600_000 → breached.
    // (The semantics are "pause time adds to the elapsed budget" —
    // this test just pins that so any spec drift is loud.)
    expect(
      isSlaBreached({
        deadlineAt: '2026-04-22T10:00:00.000Z',
        pausedTotalMs: 20 * 60_000,
        pausedAt: null,
        now: new Date('2026-04-22T09:50:00.000Z'),
      }),
    ).toBe(true)
  })

  it('pins the current pausedAt (live pause) arithmetic', () => {
    // Implementation adds `now - pausedAt` to elapsed when pausedAt is set.
    //   elapsed = (09:30 - 10:00) + 0 + (09:30 - 09:00) = -30 + 30 = 0
    //   0 > 0 is false → NOT breached.
    expect(
      isSlaBreached({
        deadlineAt: '2026-04-22T10:00:00.000Z',
        pausedTotalMs: 0,
        pausedAt: '2026-04-22T09:00:00.000Z',
        now: new Date('2026-04-22T09:30:00.000Z'),
      }),
    ).toBe(false)
    // Push `now` 1 minute further and the arithmetic crosses zero.
    expect(
      isSlaBreached({
        deadlineAt: '2026-04-22T10:00:00.000Z',
        pausedTotalMs: 0,
        pausedAt: '2026-04-22T09:00:00.000Z',
        now: new Date('2026-04-22T09:31:00.000Z'),
      }),
    ).toBe(true)
  })
})
