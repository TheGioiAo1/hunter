/**
 * Gbox Platform — Support staff audit log.
 *
 * Append-only writes to `support_audit_log`. Every mutating action in
 * the supporter.gbox.co portal and every permission denial routes
 * through here. The table is PR3 migration 080.
 *
 * Two entry points:
 *
 *   - `logStaffAction(db, event)` — general-purpose writer for
 *     mutations (ticket reply, status change, invite accept, etc).
 *   - `logPermissionDenied(db, event)` — specialized for the
 *     `requireSupportPermission` middleware. Stamps `action='perm.deny'`
 *     and a scope-specific `deny_reason`.
 *
 * Neither function throws — audit failure must not take down the
 * mutating action it's paired with. Errors are logged to stderr so
 * ops can see write failures without losing the user's action.
 *
 * Catalog of `action` values (extensible — just add a new string):
 *
 *   auth.login_ok          Successful login
 *   auth.login_failed      Login attempt that didn't find the user or
 *                          failed password / 2FA
 *   auth.logout            Session terminated voluntarily
 *   perm.deny              requireSupportPermission() denied a route
 *   ticket.view            Agent opened a ticket detail page
 *   ticket.reply           Agent posted an outbound message
 *   ticket.internal_note   Agent posted an internal-only note
 *   ticket.claim           Agent took ownership
 *   ticket.assign          Agent reassigned to another agent
 *   ticket.status_change   Agent changed status
 *   ticket.priority_change Agent changed priority
 *   ticket.merge           Agent merged two tickets
 *   ticket.delete_message  Lead/god-admin deleted a message
 *   invite.send            God-admin sent a new staff invite
 *   invite.accept          Invitee accepted
 *   invite.revoke          God-admin revoked a pending invite
 *   invite.expire          Cron expired a pending invite
 *   profile.update         Staff updated their own profile
 *   ai.suggest             Agent requested an AI draft (PR4)
 *   ai.configure           God-admin updated AI config (PR4)
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { SupportPermissionScope } from './presets.ts'

export type SupportAuditAction =
  | 'auth.login_ok'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'perm.deny'
  | 'ticket.view'
  | 'ticket.reply'
  | 'ticket.internal_note'
  | 'ticket.claim'
  | 'ticket.assign'
  | 'ticket.status_change'
  | 'ticket.priority_change'
  | 'ticket.merge'
  | 'ticket.delete_message'
  | 'invite.send'
  | 'invite.accept'
  | 'invite.revoke'
  | 'invite.expire'
  | 'profile.update'
  | 'ai.suggest'
  | 'ai.configure'

export interface StaffActionEvent {
  actorUserId: string | null
  actorPreset: string | null
  action: SupportAuditAction
  targetTicketId?: string | null
  targetUserId?: string | null
  denyReason?: string | null
  requestPath?: string | null
  requestMethod?: string | null
  ipAddress?: string | null
  userAgent?: string | null
  details?: Record<string, unknown>
}

/**
 * Write a single audit row. Never throws — errors land on stderr.
 * Returns the inserted row id on success, `null` on failure.
 *
 * We deliberately log to `console.error` rather than a pino instance
 * so this module stays importable by tests without a logging adapter.
 * The app wires pino at the route handler level.
 */
export async function logStaffAction(
  db: Kysely<Database>,
  event: StaffActionEvent,
): Promise<string | null> {
  try {
    const row = await (db as any)
      .insertInto('support_audit_log')
      .values({
        actor_user_id: event.actorUserId,
        actor_preset: event.actorPreset,
        action: event.action,
        target_ticket_id: event.targetTicketId ?? null,
        target_user_id: event.targetUserId ?? null,
        deny_reason: event.denyReason ?? null,
        request_path: truncate(event.requestPath, 500),
        request_method: event.requestMethod ?? null,
        ip_address: event.ipAddress ?? null,
        user_agent: truncate(event.userAgent, 500),
        details: event.details ?? {},
      })
      .returning('id')
      .executeTakeFirst()
    return row?.id ? String(row.id) : null
  } catch (err) {
    // Audit failure must not block the mutating action — log and drop.
    // Ops still has pino for the live stream. This is the "best effort"
    // guarantee.
    console.error('[support-staff] audit write failed', {
      action: event.action,
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Specialization of `logStaffAction` for the permission-deny path.
 * The `requireSupportPermission` middleware calls this.
 */
export async function logPermissionDenied(
  db: Kysely<Database>,
  event: {
    actorUserId: string | null
    actorPreset: string | null
    scope: SupportPermissionScope
    requestPath?: string | null
    requestMethod?: string | null
    ipAddress?: string | null
    userAgent?: string | null
  },
): Promise<string | null> {
  return logStaffAction(db, {
    actorUserId: event.actorUserId,
    actorPreset: event.actorPreset,
    action: 'perm.deny',
    denyReason: event.scope,
    requestPath: event.requestPath,
    requestMethod: event.requestMethod,
    ipAddress: event.ipAddress,
    userAgent: event.userAgent,
    details: { scope: event.scope },
  })
}

function truncate(s: string | null | undefined, max: number): string | null {
  if (!s) return null
  return s.length > max ? s.slice(0, max) : s
}

// ---------------------------------------------------------------------------
// Read helpers (god-admin "audit trail" page + timeline widgets)
// ---------------------------------------------------------------------------

export interface AuditRow {
  id: string
  actorUserId: string | null
  actorPreset: string | null
  action: string
  targetTicketId: string | null
  targetUserId: string | null
  denyReason: string | null
  requestPath: string | null
  requestMethod: string | null
  ipAddress: string | null
  userAgent: string | null
  details: Record<string, unknown>
  createdAt: string
}

function mapAuditRow(r: Record<string, unknown>): AuditRow {
  return {
    id: String(r.id),
    actorUserId: (r.actor_user_id as string | null) ?? null,
    actorPreset: (r.actor_preset as string | null) ?? null,
    action: String(r.action),
    targetTicketId: (r.target_ticket_id as string | null) ?? null,
    targetUserId: (r.target_user_id as string | null) ?? null,
    denyReason: (r.deny_reason as string | null) ?? null,
    requestPath: (r.request_path as string | null) ?? null,
    requestMethod: (r.request_method as string | null) ?? null,
    ipAddress: (r.ip_address as string | null) ?? null,
    userAgent: (r.user_agent as string | null) ?? null,
    details: (r.details as Record<string, unknown> | null) ?? {},
    createdAt: String(r.created_at),
  }
}

/**
 * List audit rows. Filters:
 *   - actorUserId: only actions by this user
 *   - targetTicketId: only rows touching this ticket
 *   - action: only this action type
 *   - since / until: ISO timestamps
 *   - limit (max 500)
 */
export async function listAuditRows(
  db: Kysely<Database>,
  params: {
    actorUserId?: string
    targetTicketId?: string
    action?: SupportAuditAction | string
    since?: string
    until?: string
    limit?: number
  } = {},
): Promise<AuditRow[]> {
  const limit = Math.max(1, Math.min(500, params.limit ?? 100))
  let q = (db as any)
    .selectFrom('support_audit_log')
    .selectAll()
    .orderBy('created_at', 'desc')
    .limit(limit)
  if (params.actorUserId) q = q.where('actor_user_id', '=', params.actorUserId)
  if (params.targetTicketId) q = q.where('target_ticket_id', '=', params.targetTicketId)
  if (params.action) q = q.where('action', '=', params.action)
  if (params.since) q = q.where('created_at', '>=', params.since)
  if (params.until) q = q.where('created_at', '<=', params.until)
  const rows = (await q.execute()) as Array<Record<string, unknown>>
  return rows.map(mapAuditRow)
}

/** Count deny rows in a window — used by the brute-force alert. */
export async function countDeniesSince(
  db: Kysely<Database>,
  since: string,
  params: { actorUserId?: string; scope?: SupportPermissionScope } = {},
): Promise<number> {
  let q = (db as any)
    .selectFrom('support_audit_log')
    .select((eb: any) => eb.fn.countAll<string>().as('c'))
    .where('action', '=', 'perm.deny')
    .where('created_at', '>=', since)
  if (params.actorUserId) q = q.where('actor_user_id', '=', params.actorUserId)
  if (params.scope) q = q.where('deny_reason', '=', params.scope)
  const row = await q.executeTakeFirst()
  return row ? Number(row.c) : 0
}
