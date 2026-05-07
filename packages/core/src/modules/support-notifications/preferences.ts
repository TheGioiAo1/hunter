/**
 * Gbox Platform — support-notifications preferences (Phase 12.5 PR5).
 *
 * Read-through wrapper for the `support_notification_preferences` table
 * (migration 077). Central invariant: the sender ALWAYS calls
 * `getNotificationPreferences(db, userId, notificationType)` before
 * dispatching, and pivots on the returned channel array to decide
 * email / in_app / browser_push delivery.
 *
 * Default prefs (when no row exists) come from `DEFAULT_PREFERENCES`
 * below — all channels ON for agents (spec §10.5), silent-by-default
 * for sellers is enforced one layer up in the seller widget (we can't
 * tell seller from agent from here — caller tags the prefs by user
 * kind if needed).
 *
 * Quiet hours:
 *   - `quiet_hours_start`/`end` are HH:MM:SS in the user's `quiet_hours_tz`.
 *   - If `now` falls inside the window, email + push are suppressed but
 *     in-app still lands (so the user can see the mention the moment
 *     they return). SLA breach notifications ignore quiet hours (they
 *     are always dispatched — Q2.10).
 */

import type { Kysely } from 'kysely'
import type {
  Database,
  SupportNotificationType,
} from '@gbox/db/schema/tables.js'

/**
 * One row shape returned after applying defaults. Every field is
 * non-null so callers don't have to re-check.
 */
export interface ResolvedPreferences {
  userId: string
  inAppEnabled: boolean
  emailEnabled: boolean
  browserPushEnabled: boolean
  newMessageChannels: string[]
  mentionChannels: string[]
  slaBreachChannels: string[]
  csatPromptChannels: string[]
  quietHoursStart: string | null
  quietHoursEnd: string | null
  quietHoursTz: string
  browserPushSubscription: Record<string, unknown> | null
}

export const DEFAULT_PREFERENCES: Omit<ResolvedPreferences, 'userId'> = {
  inAppEnabled: true,
  emailEnabled: true,
  browserPushEnabled: false,
  newMessageChannels: ['in_app', 'email'],
  mentionChannels: ['in_app', 'email'],
  slaBreachChannels: ['in_app', 'email'],
  csatPromptChannels: ['in_app', 'email'],
  quietHoursStart: null,
  quietHoursEnd: null,
  quietHoursTz: 'Asia/Ho_Chi_Minh',
  browserPushSubscription: null,
}

/**
 * Read + default prefs for a user. Safe on unknown users (returns
 * defaults with the given userId).
 */
export async function getNotificationPreferences(
  db: Kysely<Database>,
  userId: string,
): Promise<ResolvedPreferences> {
  const row = await db
    .selectFrom('support_notification_preferences')
    .selectAll()
    .where('user_id', '=', userId)
    .executeTakeFirst()

  if (!row) {
    return { ...DEFAULT_PREFERENCES, userId }
  }

  return {
    userId: row.user_id,
    inAppEnabled: row.in_app_enabled,
    emailEnabled: row.email_enabled,
    browserPushEnabled: row.browser_push_enabled,
    newMessageChannels: row.new_message_channels,
    mentionChannels: row.mention_channels,
    slaBreachChannels: row.sla_breach_channels,
    csatPromptChannels: row.csat_prompt_channels,
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
    quietHoursTz: row.quiet_hours_tz,
    browserPushSubscription:
      (row.browser_push_subscription as Record<string, unknown> | null) ?? null,
  }
}

/**
 * Pick the channels to deliver on for a given notification type.
 * Applies the master enabled-flags + quiet-hours suppression rules.
 *
 * Returns an array (possibly empty if user has gone fully silent and
 * quiet-hours is active). Caller dispatches one send per channel.
 *
 * @param now  — current instant, so quiet-hours can be evaluated
 *              against the user's tz.
 */
export function pickChannels(
  prefs: ResolvedPreferences,
  notificationType: SupportNotificationType,
  now: Date = new Date(),
): Array<'email' | 'in_app' | 'browser_push'> {
  const requested = channelsForType(prefs, notificationType)
  const filtered: Array<'email' | 'in_app' | 'browser_push'> = []
  const inQuiet = isInQuietHours(prefs, now)

  for (const ch of requested) {
    if (ch === 'in_app') {
      if (prefs.inAppEnabled) filtered.push('in_app')
      continue
    }
    if (ch === 'email') {
      // SLA breach ignores quiet hours; other types suppress email in quiet.
      if (!prefs.emailEnabled) continue
      if (
        inQuiet &&
        notificationType !== 'sla_first_response_breach' &&
        notificationType !== 'sla_resolution_breach'
      ) {
        continue
      }
      filtered.push('email')
      continue
    }
    if (ch === 'browser_push') {
      if (!prefs.browserPushEnabled) continue
      if (!prefs.browserPushSubscription) continue
      if (
        inQuiet &&
        notificationType !== 'sla_first_response_breach' &&
        notificationType !== 'sla_resolution_breach'
      ) {
        continue
      }
      filtered.push('browser_push')
      continue
    }
  }

  return filtered
}

export function channelsForType(
  prefs: ResolvedPreferences,
  notificationType: SupportNotificationType,
): Array<'email' | 'in_app' | 'browser_push'> {
  // Map notification types onto the 4 channel-preference columns. SLA
  // breaches and auto-close use the sla_breach channel set (it's the
  // "operational" bucket). Assigned / new message / mention each get
  // their own column.
  switch (notificationType) {
    case 'sla_first_response_breach':
    case 'sla_resolution_breach':
    case 'auto_close_warning':
    case 'auto_close':
      return prefs.slaBreachChannels as Array<'email' | 'in_app' | 'browser_push'>
    case 'new_message_to_agent':
    case 'new_message_to_seller':
    case 'ticket_assigned':
      return prefs.newMessageChannels as Array<'email' | 'in_app' | 'browser_push'>
    case 'mention':
      return prefs.mentionChannels as Array<'email' | 'in_app' | 'browser_push'>
    case 'csat_prompt':
      return prefs.csatPromptChannels as Array<'email' | 'in_app' | 'browser_push'>
    default:
      return ['in_app']
  }
}

/**
 * Evaluate quiet-hours. Inclusive on start, exclusive on end. Handles
 * a window that spans midnight (e.g. 22:00 → 07:00).
 */
export function isInQuietHours(
  prefs: ResolvedPreferences,
  now: Date,
): boolean {
  if (!prefs.quietHoursStart || !prefs.quietHoursEnd) return false
  const local = dateInTz(now, prefs.quietHoursTz)
  const cur = local.hours * 60 + local.minutes
  const start = parseHms(prefs.quietHoursStart)
  const end = parseHms(prefs.quietHoursEnd)
  if (start < end) {
    return cur >= start && cur < end
  }
  // Spans midnight (e.g. 22:00 → 07:00).
  return cur >= start || cur < end
}

// ── helpers ─────────────────────────────────────────────────────────────

function parseHms(hms: string): number {
  // Accepts 'HH:MM' or 'HH:MM:SS'. Returns minutes-of-day.
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(hms)
  if (!match) return 0
  const h = Number.parseInt(match[1]!, 10)
  const m = Number.parseInt(match[2]!, 10)
  return h * 60 + m
}

/**
 * Local wall-clock view of a UTC instant in a given IANA tz. Uses
 * Intl.DateTimeFormat (no external tz lib needed).
 */
function dateInTz(
  d: Date,
  tz: string,
): { hours: number; minutes: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = formatter.formatToParts(d)
  const pick = (t: string) => parts.find((p) => p.type === t)?.value ?? '0'
  let hours = Number.parseInt(pick('hour'), 10)
  if (hours === 24) hours = 0
  const minutes = Number.parseInt(pick('minute'), 10)
  return { hours, minutes }
}
