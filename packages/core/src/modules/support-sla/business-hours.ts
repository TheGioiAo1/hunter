/**
 * Gbox Platform — support-sla business hours (Phase 12.5 PR5).
 *
 * Thin wrapper around the core `dateInTz()` helper in the older
 * `support/sla-calc.ts` module. The SLA engine needs to know whether
 * a given instant is inside the support team's working hours — the
 * cron uses this to decide "is this breach happening during the agent's
 * shift (fire now) or outside hours (escalate on-call)?"
 *
 * Two exported helpers:
 *   - `isInsideBusinessHours(date, bh)` → boolean
 *   - `nextBusinessHoursStart(from, bh)` → Date
 *
 * Both are pure and work off the same `BusinessHours` shape the older
 * module defines. We re-export `DEFAULT_BUSINESS_HOURS` here so cron
 * callers don't need to reach into `support/` directly — the PR5
 * modules stand on their own boundary.
 *
 * The payment-ticket case bypasses business hours entirely (24/7) —
 * callers gate `isInsideBusinessHours` at the engine layer, not here.
 *
 * No DB access, no side-effects. Pure time math.
 */

import { dateInTz, DEFAULT_BUSINESS_HOURS, type BusinessHours } from '../support/sla-calc.ts'

export { DEFAULT_BUSINESS_HOURS }
export type { BusinessHours }

/**
 * Returns true iff the given instant falls inside the configured
 * business-hours window (working day + inside [start, end) wall clock).
 *
 * Treats the `end` time as exclusive — 18:00 sharp is already outside
 * hours — matching the SLA calc's `addBusinessMinutes` convention.
 */
export function isInsideBusinessHours(
  d: Date,
  bh: BusinessHours = DEFAULT_BUSINESS_HOURS,
): boolean {
  const local = dateInTz(d, bh.tz)
  if (!bh.days.includes(local.dow)) return false
  const startMinutes = parseHm(bh.start)
  const endMinutes = parseHm(bh.end)
  const minutesOfDay = local.hours * 60 + local.minutes
  return minutesOfDay >= startMinutes && minutesOfDay < endMinutes
}

/**
 * Return the next Date at which business hours START. If the given
 * instant is already inside the window, returns the same instant
 * rounded to the minute. If it's on a working day but before opening,
 * returns today's start. If after closing or on a weekend, walks
 * forward day-by-day until it lands on the next working day's start.
 *
 * Used by the escalation logic: if a breach lands outside business
 * hours, cron defers the "notify the on-call lead" action until the
 * next window opens (unless the ticket is payment = 24/7).
 */
export function nextBusinessHoursStart(
  from: Date,
  bh: BusinessHours = DEFAULT_BUSINESS_HOURS,
): Date {
  const startMinutes = parseHm(bh.start)
  if (isInsideBusinessHours(from, bh)) {
    return from
  }

  let cursor = new Date(from.getTime())
  // Defensive: don't loop forever if config is garbage.
  for (let i = 0; i < 8; i++) {
    const local = dateInTz(cursor, bh.tz)
    const minutesOfDay = local.hours * 60 + local.minutes
    if (bh.days.includes(local.dow) && minutesOfDay < startMinutes) {
      // Today's window hasn't opened yet — pin to start.
      return new Date(cursor.getTime() + (startMinutes - minutesOfDay) * 60_000)
    }
    // Either weekend, or after-hours on a working day → jump 24h.
    cursor = new Date(cursor.getTime() + 24 * 3600 * 1000)
    // Normalise to the new day's start.
    const nextLocal = dateInTz(cursor, bh.tz)
    if (bh.days.includes(nextLocal.dow)) {
      const nextMinutes = nextLocal.hours * 60 + nextLocal.minutes
      return new Date(cursor.getTime() + (startMinutes - nextMinutes) * 60_000)
    }
  }
  throw new Error(
    `nextBusinessHoursStart: no working day found within 8 days starting at ${from.toISOString()}`,
  )
}

function parseHm(hm: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hm)
  if (!match) throw new Error(`invalid HH:MM value: ${hm}`)
  const h = Number.parseInt(match[1]!, 10)
  const m = Number.parseInt(match[2]!, 10)
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    throw new Error(`invalid HH:MM value: ${hm}`)
  }
  return h * 60 + m
}
