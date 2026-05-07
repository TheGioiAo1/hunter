/**
 * Gbox Platform — Integration health checker (Phase 14 PR6)
 *
 * Lightweight helper integration wrappers call AFTER a failed API call
 * to decide whether a `platform_integration_down` alert should fire.
 *
 * Cheap-on-success contract
 * -------------------------
 * Wrappers pass us the integration identifier + the recent call
 * window. We run a single COUNT query over the last 5 minutes of the
 * `legacy_gbox_push_log` table (or a future per-integration log) and
 * only emit when:
 *
 *   - total recent calls >= `minCalls` (default 10) AND
 *   - error rate > `errorRateThreshold` (default 10%)
 *
 * The emitter itself dedups on a 5-minute UTC slot
 * (`integration:<name>:YYYYMMDDHHMM`) so a sustained outage still only
 * fires one email per 5m — repeated calls from the wrapper are a safe
 * no-op.
 *
 * Iron rule 5 posture
 * -------------------
 * The emit path uses `sendPlatformAlert({ alertType:
 * 'platform_integration_down' })` → `audience='god_admin'`. The shop_id
 * on platform_alert_deliveries stays NULL (it's a platform-level event,
 * not merchant-scoped), so `send.ts:201`'s iron-rule-5 gate passes.
 * Merchants NEVER see the alert or the integration name in a UI string.
 *
 * Wrappers should call `onIntegrationCallError()` only on FAILURE
 * (4xx/5xx/timeout). Calling on success is wasted work — we'd just
 * look at the same window + emit nothing.
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Tunables (match spec doc §3c env var defaults)
// ---------------------------------------------------------------------------

/** Must observe at least this many calls in the window before we alert. */
const DEFAULT_MIN_CALLS = 10

/** Error rate (0-1) that trips the alert. Default 10%. */
const DEFAULT_ERROR_RATE_THRESHOLD = 0.1

/** Lookback window in minutes. */
const DEFAULT_WINDOW_MINUTES = 5

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IntegrationHealthInput {
  /** Stable integration identifier — used as the dedup key prefix. */
  integrationName: string
  /**
   * Which log table to read. PR6 ships with `legacy_gbox_push_log`
   * (the only integration log we have today). Future integrations
   * (paypal, stripe, shippo, …) will add their own rows here as they
   * come online.
   */
  logSource?: 'legacy_gbox_push_log'
  /** Override the rate threshold for this specific integration. */
  errorRateThreshold?: number
  /** Override the minimum sample size for this specific integration. */
  minCalls?: number
  /** Override the lookback window. */
  windowMinutes?: number
  /**
   * Public-facing status page URL (Statuspage, BetterUptime, etc.).
   * Rendered in the alert email so on-call can drill into the provider
   * side without digging into our logs.
   */
  statusPageUrl?: string
}

export interface IntegrationHealthResult {
  /** Whether an alert was actually sent/deduped vs. suppressed cheaply. */
  alerted: boolean
  totalCalls: number
  errorCalls: number
  errorRate: number
  /** Reason when alerted=false. */
  suppressedReason?:
    | 'below_min_calls'
    | 'below_threshold'
    | 'alerts_disabled'
    | 'deduped'
    | 'send_failed'
}

// ---------------------------------------------------------------------------
// Core helper
// ---------------------------------------------------------------------------

/**
 * Check recent integration call health + conditionally emit a
 * `platform_integration_down` alert. Safe to call on every failure —
 * emitter dedups on a 5-minute slot.
 *
 * Returns the observed numbers so the caller can log them alongside
 * its own error line (handy when diagnosing "why didn't I get an
 * alert?").
 */
export async function onIntegrationCallError(
  db: Kysely<Database>,
  input: IntegrationHealthInput,
): Promise<IntegrationHealthResult> {
  const threshold = input.errorRateThreshold ?? DEFAULT_ERROR_RATE_THRESHOLD
  const minCalls = input.minCalls ?? DEFAULT_MIN_CALLS
  const windowMinutes = input.windowMinutes ?? DEFAULT_WINDOW_MINUTES
  const logSource = input.logSource ?? 'legacy_gbox_push_log'

  // ISO timestamp N minutes ago.
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString()

  // Count total + error rows in the window. Using COUNT FILTER (WHERE …)
  // is a single round-trip vs. two queries.
  const row = await db
    .selectFrom(logSource)
    .select([
      sql<string>`COUNT(*)`.as('total'),
      sql<string>`COUNT(*) FILTER (WHERE success = false)`.as('errors'),
    ])
    .where('created_at', '>=', since)
    .executeTakeFirst()

  const totalCalls = Number(row?.total ?? 0)
  const errorCalls = Number(row?.errors ?? 0)
  const errorRate = totalCalls > 0 ? errorCalls / totalCalls : 0

  const base: IntegrationHealthResult = {
    alerted: false,
    totalCalls,
    errorCalls,
    errorRate,
  }

  // Not enough signal — don't alert on flaky endpoints that did 3
  // calls in the last 5 minutes and 2 of them failed (66% looks
  // scary but isn't).
  if (totalCalls < minCalls) {
    return { ...base, suppressedReason: 'below_min_calls' }
  }

  if (errorRate <= threshold) {
    return { ...base, suppressedReason: 'below_threshold' }
  }

  // Alert-worthy — delegate to the platform-alerts emitter. It
  // handles the kill-switch + recipient lookup + dedup + email send.
  try {
    const { emitPlatformIntegrationDown } = await import(
      '../platform-alerts/emitters.js'
    )
    const res = await emitPlatformIntegrationDown(db, {
      integrationName: input.integrationName,
      errorRate: formatPercent(errorRate),
      statusPage: input.statusPageUrl ?? '',
    })
    if (res.sent) return { ...base, alerted: true }
    if (res.reason === 'deduped') return { ...base, suppressedReason: 'deduped' }
    if (res.reason === 'disabled_by_env') {
      return { ...base, suppressedReason: 'alerts_disabled' }
    }
    return { ...base, suppressedReason: 'send_failed' }
  } catch {
    // Never let an alert-pipeline error bubble into an integration
    // wrapper. If alerts are busted we still want the actual
    // integration call to see its own error, not ours.
    return { ...base, suppressedReason: 'send_failed' }
  }
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

/**
 * Format 0.127 → '13%'. Rounds to nearest integer percent; the
 * template surface is a god-admin inbox, not a dashboard, so decimal
 * precision adds noise without value.
 */
export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio < 0) return '0%'
  return `${Math.round(ratio * 100)}%`
}
