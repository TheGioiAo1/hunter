/**
 * Gbox Platform — Audit Logging Module (Mongo edition)
 *
 * Records auth-related events in `Gbox-Users.audit_logs`.
 * Fire-and-forget — failures are logged to stderr so they never break
 * the auth flow.
 *
 * Legacy `db: Kysely<...>` first param accepted for source-compat;
 * ignored — handler fetches the Mongo `Gbox-Users` DB directly.
 */

import { nanoid } from 'nanoid'
import { getMongoDb } from '../db/mongo.js'
import type { AuditLogDoc } from '../db/types.js'

export type AuditAction =
  | 'signup_started'
  | 'signup_otp_sent'
  | 'signup_otp_verified'
  | 'signup_completed'
  | 'login_success'
  | 'login_failed'
  | 'login_locked'
  | 'logout'
  | 'password_reset_requested'
  | 'password_reset_completed'
  | 'password_changed'
  | 'session_revoked'
  | 'all_sessions_revoked'
  | 'otp_sent'
  | 'otp_failed'
  | 'otp_expired'
  | 'otp_locked'
  | 'support_deleted_pending_signup'
  | 'support_manual_activation'
  | 'support_reissued_signup_otp'
  | 'support_signup_reminder_sent'

export interface AuditDetails {
  userId?: string
  shopId?: string
  ip?: string
  userAgent?: string
  email?: string
  extra?: Record<string, unknown>
}

export async function logAuditEvent(
  _db: unknown,
  action: AuditAction,
  details: AuditDetails,
): Promise<void> {
  try {
    const db = await getMongoDb('USERS')
    const doc: AuditLogDoc = {
      _id: nanoid(),
      user_id: details.userId ?? null,
      shop_id: details.shopId ?? null,
      action,
      resource_type: 'auth',
      resource_id: details.userId ?? null,
      details: JSON.stringify({
        email: details.email,
        user_agent: details.userAgent,
        ...details.extra,
      }),
      ip_address: details.ip ?? null,
      created_at: new Date().toISOString(),
    }
    await db.collection<AuditLogDoc>('audit_logs').insertOne(doc)
  } catch (err) {
    console.error(
      `[Audit] Failed to log "${action}":`,
      err instanceof Error ? err.message : err,
    )
  }
}
