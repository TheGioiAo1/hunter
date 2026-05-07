/**
 * Gbox Platform — Platform alert recipients (Phase 14 PR6)
 *
 * Thin DB-access layer for `platform_alert_recipients`. One row per
 * `alert_type` (PRIMARY KEY), seeded by migration 089. The god-admin
 * UI (`apps/god-admin/src/pages/platform-alerts.ts`) edits these rows.
 *
 * At runtime `sendPlatformAlert()` calls `getRecipient()` to learn
 * where to deliver a given alert. NULL return = "no row for that
 * alert_type" — callers short-circuit with
 * `reason: 'no_recipient_configured'`. `enabled=false` rows still
 * resolve (so the UI can render them) but the send path treats them
 * as a soft disable (`reason: 'disabled_by_recipient_row'`).
 *
 * Env fallback: we deliberately do NOT fall back to
 * `PLATFORM_ALERTS_DEFAULT_RECIPIENT` at runtime. That env var is the
 * *seed* default only — once migration 089 has run, the DB row is
 * authoritative. This keeps a single source of truth (a god-admin
 * editing the row gets the update reflected everywhere, including
 * "Send test alert") and avoids surprise env-vs-DB drift.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { PLATFORM_ALERT_TYPES, type PlatformAlertType } from './types.js'

export interface PlatformAlertRecipient {
  alertType: PlatformAlertType
  recipientEmail: string
  recipientName: string | null
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Return the recipient row for a given alert type, or null if none
 * exists. Migration 089 seeds all 9 types at apply time, so a NULL
 * return in production means someone ran the DELETE manually — worth
 * a log line, handled by the caller.
 */
export async function getRecipient(
  db: Kysely<Database>,
  alertType: PlatformAlertType,
): Promise<PlatformAlertRecipient | null> {
  const row = await db
    .selectFrom('platform_alert_recipients')
    .selectAll()
    .where('alert_type', '=', alertType)
    .executeTakeFirst()
  if (!row) return null
  return rowToDomain(row)
}

/**
 * Admin UI helper — list all 9 rows ordered by `alert_type` so the
 * god-admin page renders a stable order.
 */
export async function listRecipients(
  db: Kysely<Database>,
): Promise<PlatformAlertRecipient[]> {
  const rows = await db
    .selectFrom('platform_alert_recipients')
    .selectAll()
    .orderBy('alert_type', 'asc')
    .execute()
  return rows.map(rowToDomain)
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * God-admin UI edit path. `alertType` is fixed (PRIMARY KEY); only
 * email / name / enabled can be changed. Returns the updated row or
 * null if the alert_type wasn't present (caller should never see this
 * in prod since migration 089 seeds all 9).
 *
 * NOTE: the CHECK constraint on `alert_type` means passing a key
 * outside PLATFORM_ALERT_TYPES here is a caller bug — we guard with
 * the type system + an explicit runtime check so invalid UI input
 * fails fast instead of producing a confusing DB error.
 */
export async function updateRecipient(
  db: Kysely<Database>,
  input: {
    alertType: PlatformAlertType
    recipientEmail: string
    recipientName?: string | null
    enabled?: boolean
  },
): Promise<PlatformAlertRecipient | null> {
  if (!(PLATFORM_ALERT_TYPES as readonly string[]).includes(input.alertType)) {
    throw new Error(`Invalid alert_type: ${input.alertType}`)
  }
  if (!input.recipientEmail.trim()) {
    throw new Error('recipient_email cannot be empty')
  }

  // Build the SET clause dynamically so callers can omit name / enabled
  // to leave them untouched.
  const updates: Record<string, unknown> = {
    recipient_email: input.recipientEmail.trim(),
    updated_at: new Date().toISOString(),
  }
  if (input.recipientName !== undefined) {
    updates.recipient_name = input.recipientName?.trim() || null
  }
  if (input.enabled !== undefined) {
    updates.enabled = input.enabled
  }

  const row = await db
    .updateTable('platform_alert_recipients')
    .set(updates as never)
    .where('alert_type', '=', input.alertType)
    .returningAll()
    .executeTakeFirst()
  if (!row) return null
  return rowToDomain(row)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function rowToDomain(row: {
  alert_type: string
  recipient_email: string
  recipient_name: string | null
  enabled: boolean
  created_at: unknown
  updated_at: unknown
}): PlatformAlertRecipient {
  return {
    alertType: row.alert_type as PlatformAlertType,
    recipientEmail: row.recipient_email,
    recipientName: row.recipient_name,
    enabled: row.enabled,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  }
}

function toDate(v: unknown): Date {
  if (v instanceof Date) return v
  if (typeof v === 'string') return new Date(v)
  return new Date(0) // pg-node should never give us anything else
}
