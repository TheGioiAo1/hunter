/**
 * Gbox Platform — Staff alert service.
 *
 * Phase 9 / PR4. Persistent, per-shop, per-user alert feed. Different
 * from:
 *   - `toast`              — transient single-cookie
 *   - `notifications/*`    — Phase 2 in-memory store for generic UI
 *   - customer notifications (emails sent to buyers)
 *
 * Backed by `staff_alerts` + `staff_alert_preferences`. Dispatch
 * semantics: `dispatchAlert({shop_id, event_type, ...})` fans out to
 * every active staff member who has `via_inapp=true` for that event
 * (and queues an email via the caller's email hook if `via_email`).
 * A `target_user_id` short-circuits the fan-out and alerts only that
 * one user.
 *
 * Event catalog lives here so the preferences page in
 * store-admin can render the toggles from a single source.
 */

import type { Kysely } from 'kysely'

// ---------------------------------------------------------------------------
// Event catalog
// ---------------------------------------------------------------------------

export interface AlertEventDef {
  key: string
  label: string
  description: string
  /** Default severity when dispatchAlert doesn't override. */
  defaultSeverity: AlertSeverity
  /** Default delivery channels when no preference row exists. */
  defaultVia: { email: boolean; inapp: boolean }
}

export const ALERT_EVENT_CATALOG: readonly AlertEventDef[] = Object.freeze([
  {
    key: 'order.placed',
    label: 'New order placed',
    description: 'A buyer completed checkout.',
    defaultSeverity: 'info',
    defaultVia: { email: false, inapp: true },
  },
  {
    key: 'order.refund_requested',
    label: 'Refund requested',
    description: 'A buyer asked for a refund.',
    defaultSeverity: 'warning',
    defaultVia: { email: true, inapp: true },
  },
  {
    key: 'order.payment_failed',
    label: 'Payment failed',
    description: 'A charge or capture failed at the gateway.',
    defaultSeverity: 'warning',
    defaultVia: { email: true, inapp: true },
  },
  {
    key: 'order.fraud_flagged',
    label: 'Order flagged as risky',
    description: 'Risk engine scored the order above the action threshold.',
    defaultSeverity: 'warning',
    defaultVia: { email: true, inapp: true },
  },
  {
    key: 'inventory.low_stock',
    label: 'Low stock',
    description: 'A variant crossed the low-stock threshold.',
    defaultSeverity: 'warning',
    defaultVia: { email: false, inapp: true },
  },
  {
    key: 'inventory.out_of_stock',
    label: 'Out of stock',
    description: 'A variant hit zero inventory.',
    defaultSeverity: 'warning',
    defaultVia: { email: true, inapp: true },
  },
  {
    key: 'staff.new_device_login',
    label: 'Sign-in from a new device',
    description: 'Your account signed in from a device we haven\'t seen before.',
    defaultSeverity: 'warning',
    defaultVia: { email: true, inapp: true },
  },
  {
    key: 'staff.2fa_disabled',
    label: 'Two-factor authentication disabled',
    description: 'Someone disabled 2FA on your account.',
    defaultSeverity: 'critical',
    defaultVia: { email: true, inapp: true },
  },
  {
    key: 'staff.invitation_accepted',
    label: 'Invitation accepted',
    description: 'A staff invitation you sent was accepted.',
    defaultSeverity: 'info',
    defaultVia: { email: false, inapp: true },
  },
  {
    key: 'shipping.carrier_error',
    label: 'Shipping carrier error',
    description: 'A live carrier rate lookup failed.',
    defaultSeverity: 'warning',
    defaultVia: { email: false, inapp: true },
  },
  {
    key: 'tax.registration_missing',
    label: 'Tax registration missing',
    description: 'An order shipped to a jurisdiction without a registration.',
    defaultSeverity: 'warning',
    defaultVia: { email: false, inapp: true },
  },
  {
    key: 'app.installed',
    label: 'App installed',
    description: 'A third-party app was added to your store.',
    defaultSeverity: 'info',
    defaultVia: { email: false, inapp: true },
  },
] as const)

export const ALERT_EVENT_KEYS: readonly string[] = Object.freeze(
  ALERT_EVENT_CATALOG.map((e) => e.key),
)

export function isValidAlertEventKey(k: unknown): k is string {
  return typeof k === 'string' && (ALERT_EVENT_KEYS as readonly string[]).includes(k)
}

export function getAlertEventDef(key: string): AlertEventDef | null {
  return ALERT_EVENT_CATALOG.find((e) => e.key === key) ?? null
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AlertSeverity = 'info' | 'warning' | 'critical'

export interface AlertRow {
  id: string
  shop_id: string
  event_type: string
  title: string
  message: string
  link: string | null
  severity: AlertSeverity
  target_user_id: string | null
  read_at: string | null
  dismissed_at: string | null
  created_at: string
}

export interface AlertPreferenceRow {
  user_id: string
  shop_id: string
  event_type: string
  via_email: boolean
  via_inapp: boolean
  updated_at: string
}

export interface DispatchAlertInput {
  shop_id: string
  event_type: string
  title: string
  message: string
  link?: string | null
  severity?: AlertSeverity
  /** When set, only this user sees the alert (no fan-out). */
  target_user_id?: string | null
}

export interface DispatchAlertResult {
  created: AlertRow[]
  email_targets: Array<{ user_id: string; email: string }>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function alertRow(r: any): AlertRow {
  return {
    id: String(r.id),
    shop_id: String(r.shop_id),
    event_type: String(r.event_type),
    title: String(r.title),
    message: String(r.message),
    link: r.link ?? null,
    severity: r.severity as AlertSeverity,
    target_user_id: r.target_user_id ?? null,
    read_at: r.read_at ?? null,
    dismissed_at: r.dismissed_at ?? null,
    created_at: String(r.created_at),
  }
}

function prefRow(r: any): AlertPreferenceRow {
  return {
    user_id: String(r.user_id),
    shop_id: String(r.shop_id),
    event_type: String(r.event_type),
    via_email: Boolean(r.via_email),
    via_inapp: Boolean(r.via_inapp),
    updated_at: String(r.updated_at),
  }
}

/**
 * Resolve the effective preference for a user/event pair, falling
 * back to the catalog default when no preference row exists.
 */
export function resolvePreference(
  pref: { via_email: boolean; via_inapp: boolean } | null | undefined,
  eventKey: string,
): { via_email: boolean; via_inapp: boolean } {
  if (pref) return { via_email: pref.via_email, via_inapp: pref.via_inapp }
  const def = getAlertEventDef(eventKey)
  if (def) return { via_email: def.defaultVia.email, via_inapp: def.defaultVia.inapp }
  return { via_email: false, via_inapp: true }
}

// ---------------------------------------------------------------------------
// Listing + mutation
// ---------------------------------------------------------------------------

export interface ListAlertsFilter {
  shop_id: string
  user_id: string
  /** 'unread' by default; 'all' returns read + unread but not dismissed. */
  status?: 'unread' | 'all' | 'dismissed'
  limit?: number
}

export async function listAlerts(
  db: Kysely<any>,
  filter: ListAlertsFilter,
): Promise<AlertRow[]> {
  let q = (db as any)
    .selectFrom('staff_alerts')
    .selectAll()
    .where('shop_id', '=', filter.shop_id)
    .where((eb: any) => eb.or([
      eb('target_user_id', '=', filter.user_id),
      eb('target_user_id', 'is', null),
    ]))

  const status = filter.status ?? 'unread'
  if (status === 'unread') {
    q = q.where('read_at', 'is', null).where('dismissed_at', 'is', null)
  } else if (status === 'all') {
    q = q.where('dismissed_at', 'is', null)
  } else {
    q = q.where('dismissed_at', 'is not', null)
  }

  q = q.orderBy('created_at', 'desc').limit(filter.limit ?? 100)
  const rows = await q.execute()
  return rows.map(alertRow)
}

export async function countUnreadAlerts(
  db: Kysely<any>,
  shopId: string,
  userId: string,
): Promise<number> {
  const row: any = await (db as any)
    .selectFrom('staff_alerts')
    .select((eb: any) => eb.fn.countAll().as('n'))
    .where('shop_id', '=', shopId)
    .where((eb: any) => eb.or([
      eb('target_user_id', '=', userId),
      eb('target_user_id', 'is', null),
    ]))
    .where('read_at', 'is', null)
    .where('dismissed_at', 'is', null)
    .executeTakeFirst()
  return Number(row?.n ?? 0)
}

export async function markAlertRead(
  db: Kysely<any>,
  alertId: string,
  shopId: string,
  userId: string,
): Promise<void> {
  // Ensure the alert is visible to this user before marking read.
  await (db as any)
    .updateTable('staff_alerts')
    .set({ read_at: new Date() })
    .where('id', '=', alertId)
    .where('shop_id', '=', shopId)
    .where((eb: any) => eb.or([
      eb('target_user_id', '=', userId),
      eb('target_user_id', 'is', null),
    ]))
    .where('read_at', 'is', null)
    .execute()
}

export async function markAllAlertsRead(
  db: Kysely<any>,
  shopId: string,
  userId: string,
): Promise<void> {
  await (db as any)
    .updateTable('staff_alerts')
    .set({ read_at: new Date() })
    .where('shop_id', '=', shopId)
    .where((eb: any) => eb.or([
      eb('target_user_id', '=', userId),
      eb('target_user_id', 'is', null),
    ]))
    .where('read_at', 'is', null)
    .execute()
}

export async function dismissAlert(
  db: Kysely<any>,
  alertId: string,
  shopId: string,
  userId: string,
): Promise<void> {
  await (db as any)
    .updateTable('staff_alerts')
    .set({ dismissed_at: new Date(), read_at: new Date() })
    .where('id', '=', alertId)
    .where('shop_id', '=', shopId)
    .where((eb: any) => eb.or([
      eb('target_user_id', '=', userId),
      eb('target_user_id', 'is', null),
    ]))
    .execute()
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Fire an alert. If `target_user_id` is set, one row is created for
 * that user only. Otherwise we fan out to every active staff member
 * on the shop whose per-event preference has `via_inapp=true`. The
 * list of users who should also get an *email* is returned so the
 * caller can hand them to the email service.
 */
export async function dispatchAlert(
  db: Kysely<any>,
  input: DispatchAlertInput,
): Promise<DispatchAlertResult> {
  const severity = input.severity ?? getAlertEventDef(input.event_type)?.defaultSeverity ?? 'info'
  const created: AlertRow[] = []
  const email_targets: Array<{ user_id: string; email: string }> = []

  if (input.target_user_id) {
    const [row] = await (db as any)
      .insertInto('staff_alerts')
      .values({
        shop_id: input.shop_id,
        event_type: input.event_type,
        title: input.title,
        message: input.message,
        link: input.link ?? null,
        severity,
        target_user_id: input.target_user_id,
      })
      .returningAll()
      .execute()
    created.push(alertRow(row))

    const pref = await getEffectivePreference(
      db,
      input.target_user_id,
      input.shop_id,
      input.event_type,
    )
    if (pref.via_email) {
      const u = await (db as any)
        .selectFrom('users')
        .select(['id', 'email'])
        .where('id', '=', input.target_user_id)
        .executeTakeFirst()
      if (u?.email) email_targets.push({ user_id: u.id, email: u.email })
    }
    return { created, email_targets }
  }

  // Fan-out: every active staff on shop.
  const members = await (db as any)
    .selectFrom('user_shops as us')
    .innerJoin('users as u', 'u.id', 'us.user_id')
    .select(['u.id as user_id', 'u.email'])
    .where('us.shop_id', '=', input.shop_id)
    .where('us.disabled_at', 'is', null)
    .where('u.status', '=', 'active')
    .execute()

  // Upsert row per user.
  for (const m of members) {
    const pref = await getEffectivePreference(db, m.user_id, input.shop_id, input.event_type)
    if (pref.via_inapp) {
      const [row] = await (db as any)
        .insertInto('staff_alerts')
        .values({
          shop_id: input.shop_id,
          event_type: input.event_type,
          title: input.title,
          message: input.message,
          link: input.link ?? null,
          severity,
          target_user_id: m.user_id,
        })
        .returningAll()
        .execute()
      created.push(alertRow(row))
    }
    if (pref.via_email && m.email) {
      email_targets.push({ user_id: m.user_id, email: m.email })
    }
  }

  return { created, email_targets }
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export async function getEffectivePreference(
  db: Kysely<any>,
  userId: string,
  shopId: string,
  eventKey: string,
): Promise<{ via_email: boolean; via_inapp: boolean }> {
  const row = await (db as any)
    .selectFrom('staff_alert_preferences')
    .select(['via_email', 'via_inapp'])
    .where('user_id', '=', userId)
    .where('shop_id', '=', shopId)
    .where('event_type', '=', eventKey)
    .executeTakeFirst()
  return resolvePreference(row ?? null, eventKey)
}

export async function listPreferences(
  db: Kysely<any>,
  userId: string,
  shopId: string,
): Promise<AlertPreferenceRow[]> {
  const rows = await (db as any)
    .selectFrom('staff_alert_preferences')
    .selectAll()
    .where('user_id', '=', userId)
    .where('shop_id', '=', shopId)
    .execute()
  return rows.map(prefRow)
}

export interface UpdatePreferenceInput {
  user_id: string
  shop_id: string
  event_type: string
  via_email: boolean
  via_inapp: boolean
}

export async function upsertPreference(
  db: Kysely<any>,
  input: UpdatePreferenceInput,
): Promise<AlertPreferenceRow> {
  if (!isValidAlertEventKey(input.event_type)) {
    throw new Error(`Unknown alert event: ${input.event_type}`)
  }
  const [row] = await (db as any)
    .insertInto('staff_alert_preferences')
    .values({
      user_id: input.user_id,
      shop_id: input.shop_id,
      event_type: input.event_type,
      via_email: input.via_email,
      via_inapp: input.via_inapp,
    })
    .onConflict((oc: any) =>
      oc
        .columns(['user_id', 'shop_id', 'event_type'])
        .doUpdateSet({
          via_email: input.via_email,
          via_inapp: input.via_inapp,
          updated_at: new Date(),
        }),
    )
    .returningAll()
    .execute()
  return prefRow(row)
}
