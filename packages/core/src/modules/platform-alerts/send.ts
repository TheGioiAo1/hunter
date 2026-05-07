/**
 * Gbox Platform — Platform alert send pipeline (Phase 14 PR6)
 *
 * `sendPlatformAlert(db, input)` is the one entry point for every
 * god-admin-audience email. It wires three things together:
 *
 *   1. Kill-switch check   — PLATFORM_ALERTS_ENABLED=0 short-circuits
 *      before any DB work. Returns `{ sent: false, reason: 'disabled_by_env' }`.
 *
 *   2. Recipient lookup    — `platform_alert_recipients` row says
 *      where the email goes + whether the alert is currently silenced.
 *      Missing row → `no_recipient_configured`; enabled=false →
 *      `disabled_by_recipient_row`. Neither blocks siblings: a single
 *      disabled alert doesn't affect the other 8.
 *
 *   3. Dedup reserve       — INSERT into `platform_alert_deliveries`
 *      ON CONFLICT (alert_type, dedup_key) DO NOTHING. If the insert
 *      is rejected (row exists), we stop — no duplicate email. This
 *      is the mechanism that turns "every 5xx logs an incident alert"
 *      into "one email per error hash per 60s" (dedup_key carries the
 *      cooldown window in its shape; see types.ts).
 *
 *   4. Template send       — `sendTemplatedEmail({ shopId: null, … })`
 *      does the rest (template render, Iron Rule 5 pass because shopId
 *      is null, SMTP dispatch, delivery-log row). The resulting
 *      `deliveryId` (email_deliveries.id) is backfilled onto the
 *      `platform_alert_deliveries` row so retry tooling + the admin
 *      "last sent" column have a single-join view.
 *
 * IRON RULE 5 — This function ALWAYS passes `shopId: null`. That's
 * what makes Iron Rule 5 pass in `sendTemplatedEmail()` (only
 * platform-scoped sends may use `audience='god_admin'` templates).
 * Callers MUST NOT construct direct `sendTemplatedEmail()` calls for
 * platform alerts — use this wrapper so the dedup + recipient lookup
 * never get skipped.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { sendTemplatedEmail } from '../email/send.js'
import { getRecipient } from './recipients.js'
import {
  isPlatformAlertsEnabled,
  type PlatformAlertType,
  type SendPlatformAlertInput,
  type SendPlatformAlertResult,
} from './types.js'

// ---------------------------------------------------------------------------
// PR7 BUG-E3 hardening — rate-limit + audit for recipientOverride
// ---------------------------------------------------------------------------

/**
 * Per-actor sliding window bucket. Key = actorUserId, value = array of
 * ISO timestamps of recent override uses. On each override we prune
 * stamps older than `OVERRIDE_WINDOW_MS` and reject if remaining count
 * hit `OVERRIDE_LIMIT_PER_ACTOR`.
 *
 * Why in-memory (not Redis)? Override use is rare (god-admin only,
 * manual button presses) and the consequence of the rate-limit
 * failing open on a pod restart is one extra possible override —
 * still caught by the audit log. A Redis hop per override would be
 * disproportionate.
 *
 * Process-local state: OK because god-admin traffic sticks to one
 * pod via session affinity on the CF edge. Even without affinity
 * the worst case is 10*N overrides/min across N pods, which is
 * well under the point where Gmail rate-limits our sender.
 */
const OVERRIDE_WINDOW_MS = 60 * 1000
const OVERRIDE_LIMIT_PER_ACTOR = 10
const overrideBuckets = new Map<string, number[]>()

/**
 * True if the actor has slots left in their 10/min window. Consumes a
 * slot on true (prunes stale stamps + pushes now). Exported for tests
 * so smoke can clear the bucket between assertions.
 */
export function __checkAndRecordOverride(
  actorUserId: string,
  now: number = Date.now(),
): boolean {
  const cutoff = now - OVERRIDE_WINDOW_MS
  const existing = overrideBuckets.get(actorUserId) ?? []
  const recent = existing.filter((t) => t > cutoff)
  if (recent.length >= OVERRIDE_LIMIT_PER_ACTOR) {
    // Re-store the pruned array so memory doesn't grow unbounded under
    // sustained-over-limit pressure.
    overrideBuckets.set(actorUserId, recent)
    return false
  }
  recent.push(now)
  overrideBuckets.set(actorUserId, recent)
  return true
}

/** Test helper — clears the rate-limit state. */
export function __resetOverrideBucketsForTests(): void {
  overrideBuckets.clear()
}

/**
 * RFC5322 sanity check. Not a full parser — just enough to reject
 * payload-injection attempts like `a@b\nBcc: spam@evil` or
 * `a@b\r\nData: ...`. The real transport does additional validation;
 * this layer is about blocking the override from being an oracle.
 *
 * - Exactly one `@`
 * - Local + domain both at least 1 char
 * - No CR / LF / control chars
 * - No whitespace (including trailing)
 * - Max length 254 (RFC5321 §4.5.3.1.1)
 */
export function __isValidOverrideEmail(addr: string): boolean {
  if (typeof addr !== 'string') return false
  const trimmed = addr.trim()
  if (trimmed !== addr) return false // no leading/trailing whitespace
  if (trimmed.length === 0 || trimmed.length > 254) return false
  // Reject control chars + whitespace anywhere (spaces, tabs, CR, LF).
  if (/[\s\x00-\x1f\x7f]/.test(trimmed)) return false
  const at = trimmed.indexOf('@')
  if (at < 1 || at !== trimmed.lastIndexOf('@')) return false
  const local = trimmed.slice(0, at)
  const domain = trimmed.slice(at + 1)
  if (local.length === 0 || domain.length === 0) return false
  if (!domain.includes('.')) return false // at least one dot for a TLD
  return true
}

/**
 * Fire-and-forget audit log write. Failure must not block the send
 * path; ops can rebuild forensics from email_deliveries in the worst
 * case, but the audit row is the canonical "who pressed override"
 * trail so we log loudly to stderr if the write fails.
 */
async function logOverrideAudit(
  db: Kysely<Database>,
  entry: {
    actorUserId: string
    actorIp: string | null
    alertType: string
    recipientOverride: string
    dedupKey: string
    outcome: 'sent' | 'blocked'
    blockReason?: string
  },
): Promise<void> {
  try {
    await (db as any)
      .insertInto('audit_logs')
      .values({
        shop_id: null, // platform-level — override is god-admin only
        user_id: entry.actorUserId,
        action: 'platform_alert_override',
        resource_type: 'platform_alert',
        resource_id: null,
        details: JSON.stringify({
          alertType: entry.alertType,
          recipientOverride: entry.recipientOverride,
          dedupKey: entry.dedupKey,
          outcome: entry.outcome,
          ...(entry.blockReason ? { blockReason: entry.blockReason } : {}),
        }),
        ip_address: entry.actorIp,
      })
      .execute()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      '[platform-alerts] audit_logs write failed for override:',
      err instanceof Error ? err.message : String(err),
    )
  }
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function sendPlatformAlert(
  db: Kysely<Database>,
  input: SendPlatformAlertInput,
): Promise<SendPlatformAlertResult> {
  // ---- 1. Kill-switch ------------------------------------------------
  if (!isPlatformAlertsEnabled()) {
    return { sent: false, reason: 'disabled_by_env' }
  }

  // ---- 2. Recipient lookup ------------------------------------------
  //
  // PR7 (BUG-E3) — override path is now guarded:
  //   a. Must carry actorUserId. Anonymous override is refused.
  //   b. Override email must pass RFC5322 sanity (no CRLF injection).
  //   c. Per-actor 10/min sliding window. Exceeding returns
  //      'override_rate_limited' + audit log entry with outcome='blocked'.
  //   d. Every accepted override writes an audit_logs row so ops can
  //      trace compromise patterns (same user sending to N addresses,
  //      etc.).
  let recipient: {
    alertType: string
    recipientEmail: string
    recipientName: string | null
    enabled: boolean
  } | null

  if (input.recipientOverride) {
    const overrideAddr = input.recipientOverride
    const actorUserId = input.actorUserId ?? null
    const actorIp = input.actorIp ?? null

    if (!actorUserId) {
      // No audit row — we don't know who to attribute to. This is a
      // programmer error (caller forgot to pass actorUserId); fail
      // loud via return so the callsite test catches it.
      return { sent: false, reason: 'override_missing_actor' }
    }

    if (!__isValidOverrideEmail(overrideAddr)) {
      await logOverrideAudit(db, {
        actorUserId,
        actorIp,
        alertType: input.alertType,
        recipientOverride: overrideAddr,
        dedupKey: input.dedupKey,
        outcome: 'blocked',
        blockReason: 'invalid_email',
      })
      return { sent: false, reason: 'override_invalid_email' }
    }

    if (!__checkAndRecordOverride(actorUserId)) {
      await logOverrideAudit(db, {
        actorUserId,
        actorIp,
        alertType: input.alertType,
        recipientOverride: overrideAddr,
        dedupKey: input.dedupKey,
        outcome: 'blocked',
        blockReason: 'rate_limited',
      })
      return { sent: false, reason: 'override_rate_limited' }
    }

    // Audit the accepted-override BEFORE the send so we have a
    // record even if the email itself later fails. The outcome
    // field says 'sent' here (intent) — if the send fails the
    // follow-up email_deliveries row tells ops the transport outcome.
    await logOverrideAudit(db, {
      actorUserId,
      actorIp,
      alertType: input.alertType,
      recipientOverride: overrideAddr,
      dedupKey: input.dedupKey,
      outcome: 'sent',
    })

    recipient = {
      alertType: input.alertType,
      recipientEmail: overrideAddr,
      recipientName: null,
      enabled: true,
    }
  } else {
    recipient = await getRecipient(db, input.alertType)
  }

  if (!recipient) {
    return { sent: false, reason: 'no_recipient_configured' }
  }
  if (!recipient.enabled) {
    return { sent: false, reason: 'disabled_by_recipient_row' }
  }

  // ---- 3. Dedup reserve ---------------------------------------------
  //
  // Pre-check with a SELECT before the INSERT: we want the `deduped`
  // signal even when `returning` yields nothing on CONFLICT. In a
  // single-query world we'd rely on `returning('id')` post-ON-CONFLICT;
  // Kysely's `onConflict().doNothing()` + `returning()` gives empty
  // rows on conflict, so we use a try-INSERT-then-lookup dance. The
  // UNIQUE index does the heavy lifting; the SELECT is just for the
  // row id we need to backfill email_delivery_id onto.
  let reservedRowId: number | null = null
  try {
    const inserted = await db
      .insertInto('platform_alert_deliveries')
      .values({
        alert_type: input.alertType,
        dedup_key: input.dedupKey,
        email_delivery_id: null,
        payload: (input.payload ?? {}) as never,
      })
      .onConflict((oc) => oc.columns(['alert_type', 'dedup_key']).doNothing())
      .returning(['id'])
      .executeTakeFirst()
    if (inserted) {
      reservedRowId = Number(inserted.id)
    }
  } catch (err) {
    // A non-conflict DB error (e.g. constraint violation on payload shape)
    // is a real bug — surface it, don't swallow as deduped.
    return {
      sent: false,
      reason: 'template_send_failed',
      error: err instanceof Error ? err.message : String(err),
    }
  }

  if (reservedRowId == null) {
    // ON CONFLICT DO NOTHING triggered — row already exists.
    return { sent: false, reason: 'deduped' }
  }

  // ---- 4. Template send ---------------------------------------------
  //
  // The template key is the alert_type (by convention — migration 089
  // CHECK values match registry keys 1:1). shopId is null so Iron Rule 5
  // validates: only platform-scoped sends may use god_admin templates.
  const emailResult = await sendTemplatedEmail(db, {
    templateKey: input.alertType as PlatformAlertType,
    to: recipient.recipientEmail,
    shopId: null,
    variables: input.variables,
    // We use the dedup key as idempotency too — sendTemplatedEmail's
    // idempotent path is stronger protection against retry races.
    idempotencyKey: `platform-alert:${input.alertType}:${input.dedupKey}`,
  })

  if (!emailResult.ok) {
    // Template send failed — leave reserved row in place with
    // email_delivery_id=NULL so retry tooling can find + retry it.
    return {
      sent: false,
      reason: 'template_send_failed',
      error: emailResult.reason,
    }
  }

  // ---- 5. Backfill email_delivery_id --------------------------------
  await db
    .updateTable('platform_alert_deliveries')
    .set({ email_delivery_id: emailResult.deliveryId })
    .where('id', '=', reservedRowId)
    .execute()
    .catch(() => {
      // Non-fatal: the email went out, we just couldn't link the row.
      // Worth a log line in ops, but not worth failing the send.
    })

  return {
    sent: true,
    deliveryRowId: reservedRowId,
    emailDeliveryId: emailResult.deliveryId,
  }
}
