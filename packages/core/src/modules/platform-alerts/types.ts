/**
 * Gbox Platform — Platform alerts: type surface (Phase 14 PR6)
 *
 * These 9 alert types are the full universe of god-admin-audience
 * emails. They are deliberately a closed set — matching the migration
 * 089 CHECK constraint. Adding a new alert type requires a migration
 * update (DDL) AND a registry entry (email template) AND a flow
 * catalog entry (for observability) — catalog-only additions here
 * will fail at DB insert time, which is the desired fail-closed
 * behaviour.
 *
 * The ordering here mirrors the docblock in
 * `packages/db/src/migrations/089_platform_alerts.ts` for grep-parity.
 */

export const PLATFORM_ALERT_TYPES = [
  'new_merchant_signup',
  'platform_incident_alert',
  'platform_daily_digest',
  'platform_churn_alert',
  'platform_fraud_review',
  'platform_policy_violation',
  'platform_billing_failure',
  'platform_integration_down',
  'platform_weekly_roundup',
] as const

export type PlatformAlertType = (typeof PLATFORM_ALERT_TYPES)[number]

/** Input to `sendPlatformAlert()`. Variables flow through to the template render. */
export interface SendPlatformAlertInput {
  alertType: PlatformAlertType
  /**
   * Caller-chosen dedup key. See dedup_key conventions in the migration
   * docblock — keep these stable per alert type so the UNIQUE index
   * does its job. To force-send past a dedup (e.g. a god-admin "Send
   * test alert" button), append `:test:<uuid>` — the UNIQUE index will
   * never reject it.
   */
  dedupKey: string
  /**
   * Template render variables. Merged into subject + bodyHtml + bodyText
   * by `sendTemplatedEmail()` downstream.
   */
  variables: Record<string, unknown>
  /**
   * Snapshot of rendering inputs stored on the `platform_alert_deliveries`
   * row for observability. Omit to store `{}` — separate from
   * `variables` because callers often want to log extra diagnostic
   * context (shop_id, user_id, err stack) that the template doesn't
   * consume.
   */
  payload?: Record<string, unknown>
  /**
   * Override the recipient lookup. Production callers should leave this
   * unset so the `platform_alert_recipients` row wins; set only for
   * god-admin "Send test alert" buttons that want to target a specific
   * internal mailbox.
   *
   * PR7 (BUG-E3) hardening:
   *   - Rate-limited to 10/min per `actorUserId` (in-memory bucket).
   *     Higher than the 3/min IP limit upstream of the HTTP handler
   *     because a god-admin doing a legitimate mailbox sweep may
   *     exceed the IP ceiling; the per-actor ceiling catches abuse
   *     from a compromised session.
   *   - Every override write is logged to `audit_logs` with
   *     `action='platform_alert_override'`, `resource_type='platform_alert'`,
   *     `details={ alertType, override, dedupKey }`. That feeds the
   *     `/god-admin/platform-alerts` audit tab so ops sees who targeted
   *     what mailbox.
   *   - The override is still a valid email address (RFC5322 sanity
   *     check) to prevent the override from being used as a truncation
   *     oracle that spams injection payloads.
   */
  recipientOverride?: string
  /**
   * God-admin user ID for audit trail + rate-limit. Required when
   * `recipientOverride` is set. If missing on an override path the
   * send is rejected with `reason: 'override_missing_actor'` — ops
   * must never fire an override without a known actor.
   */
  actorUserId?: string | null
  /**
   * IP of the actor (request.ip). Written to the audit row for the
   * compromise-forensics trail. Optional — audit row accepts NULL.
   */
  actorIp?: string | null
}

export type SendPlatformAlertResult =
  | {
      sent: true
      deliveryRowId: number // platform_alert_deliveries.id
      emailDeliveryId: number | null // email_deliveries.id — null on transport fail
    }
  | {
      sent: false
      reason:
        | 'disabled_by_env' // PLATFORM_ALERTS_ENABLED=0
        | 'disabled_by_recipient_row' // enabled=false in platform_alert_recipients
        | 'no_recipient_configured' // no row in platform_alert_recipients
        | 'deduped' // UNIQUE (alert_type, dedup_key) rejected the insert
        | 'template_send_failed' // sendTemplatedEmail returned ok:false
        // Phase 14 PR7 (BUG-E3) hardening reasons:
        | 'override_rate_limited' // actor exceeded 10/min override bucket
        | 'override_missing_actor' // recipientOverride without actorUserId
        | 'override_invalid_email' // recipientOverride failed RFC5322 sanity
      error?: string
    }

/**
 * Kill-switch check. Lives here (not in send.ts) so the god-admin
 * page can surface the same state in the UI banner.
 */
export function isPlatformAlertsEnabled(): boolean {
  const raw = process.env.PLATFORM_ALERTS_ENABLED
  if (raw == null) return true
  // '0' / 'false' / 'no' disable; anything else (including empty string) enables.
  const lower = raw.trim().toLowerCase()
  return lower !== '0' && lower !== 'false' && lower !== 'no'
}
