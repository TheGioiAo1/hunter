/**
 * Gbox Platform — Audit Logging Module
 *
 * Records auth-related events in the audit_logs table.
 * Per IRON RULE #4: ALL changes logged.
 *
 * Audit logging is fire-and-forget — failures are caught and logged
 * to stderr so they never break the auth flow.
 */

import type { Kysely } from "kysely";
import type { Database } from "@gbox/db/schema/tables.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditAction =
  | "signup_started"
  | "signup_otp_sent"
  | "signup_otp_verified"
  | "signup_completed"
  | "login_success"
  | "login_failed"
  | "login_locked"
  | "logout"
  | "password_reset_requested"
  | "password_reset_completed"
  | "password_changed"
  | "session_revoked"
  | "all_sessions_revoked"
  | "otp_sent"
  | "otp_failed"
  | "otp_expired"
  | "otp_locked"
  // Phase 14 PR8 — support-tooling actions written by the runbooks at
  // docs/ops/stuck-signup-recovery.md (Options A/B/C). Kysely already
  // accepts arbitrary strings into audit_logs.action (column type is
  // plain `string`, no CHECK), but typing them here lets type-safe
  // callers like `logAuditEvent()` and `scripts/support/*.ts` emit them
  // without `as AuditAction` casts and gives admin UIs a stable
  // vocabulary to filter on.
  | "support_deleted_pending_signup"
  | "support_manual_activation"
  | "support_reissued_signup_otp"
  | "support_signup_reminder_sent";

export interface AuditDetails {
  userId?: string;
  shopId?: string;
  ip?: string;
  userAgent?: string;
  email?: string;
  extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record an auth-related event in the audit_logs table.
 *
 * This function never throws — failures are logged to stderr so the
 * caller's auth flow continues uninterrupted.
 */
export async function logAuditEvent(
  db: Kysely<Database>,
  action: AuditAction,
  details: AuditDetails
): Promise<void> {
  if (!db) return // Demo mode: skip audit logging

  try {
    await db
      .insertInto("audit_logs")
      .values({
        user_id: details.userId ?? null,
        shop_id: details.shopId ?? null,
        action,
        resource_type: "auth",
        resource_id: details.userId ?? null,
        details: JSON.stringify({
          email: details.email,
          user_agent: details.userAgent,
          ...details.extra,
        }),
        ip_address: details.ip ?? null,
      })
      .execute();
  } catch (err) {
    // Never fail the auth flow because of audit logging
    console.error(
      `[Audit] Failed to log "${action}":`,
      err instanceof Error ? err.message : err
    );
  }
}
