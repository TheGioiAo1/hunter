/**
 * Gbox Platform — Staff login event log.
 *
 * Phase 9 / PR4. Append-only log of login outcomes for staff + god-admin.
 * Feeds the security page ("Recent sign-ins") and the "new device"
 * alert path. Never used for authz — existing session / 2FA rows are
 * the source of truth there.
 */

import { createHash } from 'node:crypto'
import type { Kysely } from 'kysely'

export type LoginOutcome =
  | 'success'
  | 'invalid_password'
  | 'user_not_found'
  | 'user_disabled'
  | '2fa_required'
  | '2fa_failed'
  | 'locked'
  | 'ip_blocked'
  | 'rate_limited'

export interface LoginEventRow {
  id: string
  user_id: string
  shop_id: string | null
  outcome: LoginOutcome
  ip_address: string | null
  user_agent: string | null
  device_fingerprint: string | null
  is_new_device: boolean
  created_at: string
}

export interface RecordLoginEventInput {
  user_id: string
  shop_id?: string | null
  outcome: LoginOutcome
  ip_address?: string | null
  user_agent?: string | null
}

/**
 * Compute a device fingerprint. We combine a normalised user-agent
 * (trimmed + lowercased, version-stripped browser/os tokens) with the
 * first three octets of the IP so a fingerprint survives router
 * reboots on the same subnet but changes when the staffer logs in
 * from home vs office.
 *
 * This isn't a security-grade fingerprint. It exists only to detect
 * "probably a new device" so we can surface an alert.
 */
export function deviceFingerprint(
  ip: string | null | undefined,
  ua: string | null | undefined,
): string | null {
  if (!ip && !ua) return null
  const ipBlock = (() => {
    if (!ip) return ''
    // IPv4: first 3 octets. IPv6: first 4 groups.
    if (ip.includes('.')) return ip.split('.').slice(0, 3).join('.')
    if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':')
    return ip
  })()
  const uaNorm = (ua ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[0-9.]+/g, '') // strip version numbers
    .trim()
    .slice(0, 200)
  return createHash('sha256').update(`${ipBlock}|${uaNorm}`).digest('hex')
}

/**
 * Insert a login event. Returns the stored row (including the
 * computed `is_new_device` flag). On failure the function never
 * throws — logging must not break the login flow.
 */
export async function recordLoginEvent(
  db: Kysely<any>,
  input: RecordLoginEventInput,
): Promise<LoginEventRow | null> {
  try {
    const fp = deviceFingerprint(input.ip_address, input.user_agent)

    // Compute is_new_device: only meaningful for successful logins; for
    // failures we still record the event but mark `is_new_device=false`
    // so "new device" alerts only fire on actual sign-ins.
    let isNewDevice = false
    if (fp && input.outcome === 'success') {
      const seen = await (db as any)
        .selectFrom('staff_login_events')
        .select('id')
        .where('user_id', '=', input.user_id)
        .where('device_fingerprint', '=', fp)
        .where('outcome', '=', 'success')
        .limit(1)
        .executeTakeFirst()
      isNewDevice = !seen
    }

    const [row] = await (db as any)
      .insertInto('staff_login_events')
      .values({
        user_id: input.user_id,
        shop_id: input.shop_id ?? null,
        outcome: input.outcome,
        ip_address: input.ip_address ?? null,
        user_agent: input.user_agent ?? null,
        device_fingerprint: fp,
        is_new_device: isNewDevice,
      })
      .returningAll()
      .execute()

    return {
      id: String(row.id),
      user_id: String(row.user_id),
      shop_id: row.shop_id ?? null,
      outcome: row.outcome as LoginOutcome,
      ip_address: row.ip_address ?? null,
      user_agent: row.user_agent ?? null,
      device_fingerprint: row.device_fingerprint ?? null,
      is_new_device: Boolean(row.is_new_device),
      created_at: String(row.created_at),
    }
  } catch {
    return null
  }
}

export interface ListLoginEventsFilter {
  user_id?: string
  shop_id?: string
  outcome?: LoginOutcome
  limit?: number
}

export async function listLoginEvents(
  db: Kysely<any>,
  filter: ListLoginEventsFilter,
): Promise<LoginEventRow[]> {
  let q = (db as any).selectFrom('staff_login_events').selectAll()
  if (filter.user_id) q = q.where('user_id', '=', filter.user_id)
  if (filter.shop_id) q = q.where('shop_id', '=', filter.shop_id)
  if (filter.outcome) q = q.where('outcome', '=', filter.outcome)
  q = q.orderBy('created_at', 'desc').limit(filter.limit ?? 50)
  const rows = await q.execute()
  return rows.map((r: any) => ({
    id: String(r.id),
    user_id: String(r.user_id),
    shop_id: r.shop_id ?? null,
    outcome: r.outcome as LoginOutcome,
    ip_address: r.ip_address ?? null,
    user_agent: r.user_agent ?? null,
    device_fingerprint: r.device_fingerprint ?? null,
    is_new_device: Boolean(r.is_new_device),
    created_at: String(r.created_at),
  }))
}

/**
 * Has this user ever successfully signed in from this fingerprint?
 * Used in advance (by the alerts dispatcher) so the "new device"
 * notification can fire *before* the login event is persisted.
 */
export async function hasSeenDevice(
  db: Kysely<any>,
  userId: string,
  fingerprint: string,
): Promise<boolean> {
  const row = await (db as any)
    .selectFrom('staff_login_events')
    .select('id')
    .where('user_id', '=', userId)
    .where('device_fingerprint', '=', fingerprint)
    .where('outcome', '=', 'success')
    .limit(1)
    .executeTakeFirst()
  return !!row
}
