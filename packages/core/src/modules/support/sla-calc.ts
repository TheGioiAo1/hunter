/**
 * SLA deadline computation.
 *
 * Q2.11 locked a hybrid SLA model:
 *
 *   - Payment tickets: first-response 2h, resolution 12h, 24/7 clock.
 *   - All other categories: first-response 4h, resolution 24h, but
 *     only business-hours count (Mon-Fri 08:00-18:00 ICT by default).
 *
 * The business-hours window is held in the agent profile (or the
 * support settings blob) as `{ tz, days[], start, end }`. This module
 * does not know or care which agent claims the ticket — at creation
 * time we use the platform default (`Asia/Ho_Chi_Minh`), and when an
 * agent claims it the SLA deadline does NOT change. (Agents can still
 * be over-budget on their own queue, but the headline SLA the seller
 * sees is anchored at open-time.)
 *
 * All timestamps are ISO-8601 strings in UTC. Tests cover:
 *   - open during business hours → deadline walks forward N hours
 *   - open after 18:00 → deadline slides to next morning + N hours
 *   - open on Saturday → deadline slides to Monday + N hours
 *   - crossing a weekend → correct total business-hours budget
 */

import type { SupportCategory } from './types.ts'
import { DEFAULT_SLA_CONFIG, type SlaConfig } from './types.ts'

export interface BusinessHours {
  /** IANA tz, e.g. 'Asia/Ho_Chi_Minh'. */
  tz: string
  /** 0=Sun, 1=Mon, ..., 6=Sat. Locked set of working days. */
  days: number[]
  /** 'HH:MM' 24h. */
  start: string
  /** 'HH:MM' 24h (exclusive). */
  end: string
}

export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  tz: 'Asia/Ho_Chi_Minh',
  days: [1, 2, 3, 4, 5],
  start: '08:00',
  end: '18:00',
}

/**
 * Compute the SLA deadlines for a brand-new ticket. Returns two
 * ISO-8601 strings (UTC) that can be persisted directly into
 * `support_tickets.sla_first_response_at` / `sla_resolution_at`.
 */
export function computeSlaDeadlines(args: {
  category: SupportCategory
  openedAt: Date
  config?: SlaConfig
  businessHours?: BusinessHours
}): { firstResponseAt: string; resolutionAt: string } {
  const cfg = args.config ?? DEFAULT_SLA_CONFIG
  const bh = args.businessHours ?? DEFAULT_BUSINESS_HOURS

  const isPayment = args.category === 'payment'
  const useBusinessHours = !isPayment && cfg.businessHoursApplyToNonPayment

  const firstResponseMinutes = isPayment
    ? cfg.paymentFirstResponseMinutes
    : cfg.otherFirstResponseMinutes
  const resolutionMinutes = isPayment
    ? cfg.paymentResolutionMinutes
    : cfg.otherResolutionMinutes

  if (!useBusinessHours) {
    return {
      firstResponseAt: addMinutes(args.openedAt, firstResponseMinutes),
      resolutionAt: addMinutes(args.openedAt, resolutionMinutes),
    }
  }

  return {
    firstResponseAt: addBusinessMinutes(args.openedAt, firstResponseMinutes, bh),
    resolutionAt: addBusinessMinutes(args.openedAt, resolutionMinutes, bh),
  }
}

/**
 * Returns true when the SLA has been breached given the current time
 * and the stored deadline. Used by the SLA cron + the agent UI.
 */
export function isSlaBreached(args: {
  deadlineAt: string
  pausedTotalMs: number
  pausedAt: string | null
  now?: Date
}): boolean {
  const now = args.now ?? new Date()
  const deadline = new Date(args.deadlineAt).getTime()
  let elapsed = now.getTime() - deadline
  // Adjust for paused time: if paused, accrue the live pause window too.
  if (args.pausedAt) {
    const liveMs = now.getTime() - new Date(args.pausedAt).getTime()
    elapsed += args.pausedTotalMs + liveMs
  } else {
    elapsed += args.pausedTotalMs
  }
  return elapsed > 0
}

// ── helpers ──────────────────────────────────────────────────────────

function addMinutes(from: Date, minutes: number): string {
  return new Date(from.getTime() + minutes * 60_000).toISOString()
}

/**
 * Add `remainingMinutes` of business-hours budget to `from`, skipping
 * non-working time. Returns an ISO-8601 UTC string.
 *
 * Algorithm is interval-driven, not minute-by-minute, so performance
 * is constant regardless of whether the budget is 4h or 400h.
 */
export function addBusinessMinutes(
  from: Date,
  totalMinutes: number,
  bh: BusinessHours = DEFAULT_BUSINESS_HOURS,
): string {
  if (totalMinutes <= 0) return from.toISOString()
  validateBusinessHours(bh)

  let remaining = totalMinutes
  let cursor = new Date(from.getTime())
  // Guard against infinite loops if BH config is bad (no working days).
  const MAX_ITERATIONS = 52 * 7 * 2 // ~2 years of day-scans
  let iter = 0
  while (remaining > 0 && iter < MAX_ITERATIONS) {
    iter++
    const local = dateInTz(cursor, bh.tz)
    const localDow = local.dow
    const isWorkingDay = bh.days.includes(localDow)
    if (!isWorkingDay) {
      // Jump to next day's start-of-business.
      cursor = nextDayAtBusinessStart(cursor, bh)
      continue
    }

    const startMinutes = hmToMinutes(bh.start)
    const endMinutes = hmToMinutes(bh.end)
    const localMinutesOfDay = local.hours * 60 + local.minutes

    if (localMinutesOfDay < startMinutes) {
      // Before office opens → skip to start.
      cursor = sameDayAtMinutes(cursor, bh, startMinutes)
      continue
    }
    if (localMinutesOfDay >= endMinutes) {
      // After office closes → next working day.
      cursor = nextDayAtBusinessStart(cursor, bh)
      continue
    }

    // Inside a working window: burn as much budget as fits.
    const minutesLeftToday = endMinutes - localMinutesOfDay
    const burn = Math.min(minutesLeftToday, remaining)
    cursor = new Date(cursor.getTime() + burn * 60_000)
    remaining -= burn
    if (remaining > 0) {
      // Window saturated exactly — push to next day's open.
      cursor = nextDayAtBusinessStart(cursor, bh)
    }
  }

  if (remaining > 0 && iter >= MAX_ITERATIONS) {
    // Defensive: a misconfigured BH (e.g. `days: []`) can't ever
    // burn down the budget. Caller should see the issue in logs.
    throw new Error(
      `addBusinessMinutes exceeded ${MAX_ITERATIONS} iterations (remaining=${remaining}, bh=${JSON.stringify(bh)})`,
    )
  }

  return cursor.toISOString()
}

function validateBusinessHours(bh: BusinessHours): void {
  if (bh.days.length === 0) {
    throw new Error('businessHours.days must not be empty')
  }
  for (const d of bh.days) {
    if (!Number.isInteger(d) || d < 0 || d > 6) {
      throw new Error(`businessHours.days contains invalid value ${d}`)
    }
  }
  const s = hmToMinutes(bh.start)
  const e = hmToMinutes(bh.end)
  if (s >= e) {
    throw new Error(`businessHours.start (${bh.start}) must be < end (${bh.end})`)
  }
}

function hmToMinutes(hm: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hm)
  if (!match) throw new Error(`invalid HH:MM value: ${hm}`)
  const h = Number.parseInt(match[1]!, 10)
  const m = Number.parseInt(match[2]!, 10)
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    throw new Error(`invalid HH:MM value: ${hm}`)
  }
  return h * 60 + m
}

/**
 * Compute a local-wall-clock view of a UTC instant in a given IANA tz.
 * We use `Intl.DateTimeFormat` because node's built-in doesn't expose
 * tz-aware arithmetic directly, and pulling a full tz lib for four
 * fields is overkill.
 */
export function dateInTz(
  d: Date,
  tz: string,
): { year: number; month: number; day: number; hours: number; minutes: number; dow: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  })
  const parts = formatter.formatToParts(d)
  const pick = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const year = Number.parseInt(pick('year'), 10)
  const month = Number.parseInt(pick('month'), 10)
  const day = Number.parseInt(pick('day'), 10)
  // 'hour' from Intl with hour12:false can come back as '24' at midnight on some
  // platforms (Windows node!). Normalise it to 0.
  let hoursRaw = Number.parseInt(pick('hour'), 10)
  if (hoursRaw === 24) hoursRaw = 0
  const hours = hoursRaw
  const minutes = Number.parseInt(pick('minute'), 10)
  const weekday = pick('weekday')
  const dowMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  }
  const dow = dowMap[weekday] ?? -1
  if (dow < 0) throw new Error(`unrecognised weekday: ${weekday}`)
  return { year, month, day, hours, minutes, dow }
}

/** Move cursor to the same day's wall-clock minute-of-day in bh.tz. */
function sameDayAtMinutes(from: Date, bh: BusinessHours, minutesOfDay: number): Date {
  const local = dateInTz(from, bh.tz)
  const current = local.hours * 60 + local.minutes
  const deltaMinutes = minutesOfDay - current
  return new Date(from.getTime() + deltaMinutes * 60_000)
}

/** Move cursor to next day's business-start moment (tz-aware). */
function nextDayAtBusinessStart(from: Date, bh: BusinessHours): Date {
  const startMinutes = hmToMinutes(bh.start)
  // Walk in 24-hour steps until the destination is a working day.
  let candidate = from
  for (let i = 0; i < 8; i++) {
    candidate = new Date(candidate.getTime() + 24 * 3600 * 1000)
    const local = dateInTz(candidate, bh.tz)
    if (bh.days.includes(local.dow)) {
      // Pin to business-start on that day in the target tz.
      const cand = dateInTz(candidate, bh.tz)
      const currentMinutes = cand.hours * 60 + cand.minutes
      return new Date(candidate.getTime() + (startMinutes - currentMinutes) * 60_000)
    }
  }
  throw new Error(`could not find a working day within 8 days starting at ${from.toISOString()}`)
}
