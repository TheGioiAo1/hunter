/**
 * Gbox Platform — Typed platform-alert emitters (Phase 14 PR6)
 *
 * One helper per alert_type. Each wraps `sendPlatformAlert()` with a
 * typed variable bag + caller-idiomatic dedup-key shape. Call sites
 * (logger uncaught handler, create-store flow, cron digests, etc.) use
 * these instead of reconstructing `dedupKey` string templates — that's
 * how we keep the key format stable across every emitter.
 *
 * Naming convention: `emit<AlertTypeCamelCase>()` returns a
 * `SendPlatformAlertResult` so the caller can branch on `sent`.
 *
 * DEDUP-KEY CONVENTIONS
 * ---------------------
 * Must match the docblock in migration 089 + the spec in
 * `docs/email-system/phase-14-pr6-scope.md` §3a.
 */

import { createHash } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { sendPlatformAlert } from './send.js'
import type { SendPlatformAlertResult } from './types.js'

// ---------------------------------------------------------------------------
// Shared key helpers
// ---------------------------------------------------------------------------

/** Date YYYY-MM-DD in UTC — used by fraud / policy / digest dedup. */
function utcDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10)
}

/** Year-month YYYYMM (UTC) — churn alerts are 1-per-shop-per-month. */
function utcYearMonth(d: Date = new Date()): string {
  return d.toISOString().slice(0, 7).replace('-', '')
}

/** ISO week YYYY-WW. Weekly roundup hard 1-per-week dedup. */
function utcIsoWeek(d: Date = new Date()): string {
  // Thursday of current week determines ISO year (week always contains Thu).
  const target = new Date(d.getTime())
  target.setUTCHours(0, 0, 0, 0)
  target.setUTCDate(target.getUTCDate() + 3 - ((target.getUTCDay() + 6) % 7))
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  const weekNum =
    1 +
    Math.round(
      ((target.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    )
  return `${target.getUTCFullYear()}-${String(weekNum).padStart(2, '0')}`
}

/** 5-minute slot YYYYMMDDHHMM — integration-down fires at most once per 5m. */
function utcFiveMinuteSlot(d: Date = new Date()): string {
  const iso = d.toISOString() // e.g. 2026-04-22T14:07:05.123Z
  const rounded = Math.floor(d.getUTCMinutes() / 5) * 5
  return (
    iso.slice(0, 4) + // year
    iso.slice(5, 7) + // month
    iso.slice(8, 10) + // day
    iso.slice(11, 13) + // hour
    String(rounded).padStart(2, '0') // 00/05/10/…/55
  )
}

/** 60s hash of incident payload — coalesces burst of identical 5xx. */
function incidentHash(msg: string, env: string): string {
  return createHash('sha256').update(`${msg}\n${env}`).digest('hex').slice(0, 32)
}

// ---------------------------------------------------------------------------
// 1. new_merchant_signup — 1 per shop ever
// ---------------------------------------------------------------------------

export async function emitNewMerchantSignup(
  db: Kysely<Database>,
  input: {
    shopId: string
    shopName: string
    ownerEmail: string
    country: string
    shopUrl: string
  },
): Promise<SendPlatformAlertResult> {
  return sendPlatformAlert(db, {
    alertType: 'new_merchant_signup',
    dedupKey: `shop:${input.shopId}`,
    variables: {
      shop_name: input.shopName,
      owner_email: input.ownerEmail,
      country: input.country,
      shop_url: input.shopUrl,
    },
    payload: { shop_id: input.shopId },
  })
}

// ---------------------------------------------------------------------------
// 2. platform_incident_alert — hash(err.msg + env), 60s implicit cooldown
// ---------------------------------------------------------------------------

export async function emitPlatformIncident(
  db: Kysely<Database>,
  input: {
    severity: 'low' | 'medium' | 'high' | 'critical'
    title: string
    errorMessage: string
    env: string // 'production' | 'staging' | ...
    runbookUrl?: string
    /** Optional override — lets callers supply a shorter dedup window. */
    dedupKey?: string
  },
): Promise<SendPlatformAlertResult> {
  const dedupKey =
    input.dedupKey ?? `${input.env}:${incidentHash(input.errorMessage, input.env)}`
  return sendPlatformAlert(db, {
    alertType: 'platform_incident_alert',
    dedupKey,
    variables: {
      severity: input.severity,
      title: input.title,
      runbook_url: input.runbookUrl ?? '',
    },
    payload: {
      error_message: input.errorMessage,
      env: input.env,
    },
  })
}

// ---------------------------------------------------------------------------
// 3. platform_daily_digest — date:YYYY-MM-DD, hard 1/day
// ---------------------------------------------------------------------------

export async function emitPlatformDailyDigest(
  db: Kysely<Database>,
  input: {
    date?: string // defaults to today UTC
    gmvTotal: string // pre-formatted: '$12,345.67'
    newShops: number
    churnedShops: number
  },
): Promise<SendPlatformAlertResult> {
  const date = input.date ?? utcDate()
  return sendPlatformAlert(db, {
    alertType: 'platform_daily_digest',
    dedupKey: `date:${date}`,
    variables: {
      date,
      gmv_total: input.gmvTotal,
      new_shops: String(input.newShops),
      churned_shops: String(input.churnedShops),
    },
    payload: {
      new_shops_count: input.newShops,
      churned_shops_count: input.churnedShops,
    },
  })
}

// ---------------------------------------------------------------------------
// 4. platform_churn_alert — shop:<uuid>:<yyyymm>, 1/shop/month
// ---------------------------------------------------------------------------

export async function emitPlatformChurnAlert(
  db: Kysely<Database>,
  input: {
    shopId: string
    shopName: string
    closureReason: string
  },
): Promise<SendPlatformAlertResult> {
  return sendPlatformAlert(db, {
    alertType: 'platform_churn_alert',
    dedupKey: `shop:${input.shopId}:${utcYearMonth()}`,
    variables: {
      shop_name: input.shopName,
      closure_reason: input.closureReason,
    },
    payload: { shop_id: input.shopId },
  })
}

// ---------------------------------------------------------------------------
// 5. platform_fraud_review — shop:<uuid>:YYYY-MM-DD, 1/shop/day
// ---------------------------------------------------------------------------

export async function emitPlatformFraudReview(
  db: Kysely<Database>,
  input: {
    shopId: string
    shopName: string
    heuristic: string
    evidenceUrl: string
  },
): Promise<SendPlatformAlertResult> {
  return sendPlatformAlert(db, {
    alertType: 'platform_fraud_review',
    dedupKey: `shop:${input.shopId}:${utcDate()}`,
    variables: {
      shop_name: input.shopName,
      heuristic: input.heuristic,
      evidence_url: input.evidenceUrl,
    },
    payload: { shop_id: input.shopId, heuristic: input.heuristic },
  })
}

// ---------------------------------------------------------------------------
// 6. platform_policy_violation — shop:<uuid>:YYYY-MM-DD, 1/shop/day
// ---------------------------------------------------------------------------

export async function emitPlatformPolicyViolation(
  db: Kysely<Database>,
  input: {
    shopId: string
    shopName: string
    reason: string
  },
): Promise<SendPlatformAlertResult> {
  return sendPlatformAlert(db, {
    alertType: 'platform_policy_violation',
    dedupKey: `shop:${input.shopId}:${utcDate()}`,
    variables: {
      shop_name: input.shopName,
      reason: input.reason,
    },
    payload: { shop_id: input.shopId },
  })
}

// ---------------------------------------------------------------------------
// 7. platform_billing_failure — shop:<uuid>:<invoice_id>, 1/invoice
// ---------------------------------------------------------------------------

export async function emitPlatformBillingFailure(
  db: Kysely<Database>,
  input: {
    shopId: string
    shopName: string
    invoiceId: string
    amount: string // pre-formatted: '$49.00'
    failureReason: string
  },
): Promise<SendPlatformAlertResult> {
  return sendPlatformAlert(db, {
    alertType: 'platform_billing_failure',
    dedupKey: `shop:${input.shopId}:${input.invoiceId}`,
    variables: {
      shop_name: input.shopName,
      amount: input.amount,
      failure_reason: input.failureReason,
    },
    payload: {
      shop_id: input.shopId,
      invoice_id: input.invoiceId,
    },
  })
}

// ---------------------------------------------------------------------------
// 8. platform_integration_down — integration:YYYYMMDDHHMM (5m slot)
// ---------------------------------------------------------------------------

export async function emitPlatformIntegrationDown(
  db: Kysely<Database>,
  input: {
    integrationName: string // 'stripe' | 'shippo' | 'usps' | ...
    errorRate: string // pre-formatted '12%'
    statusPage?: string
  },
): Promise<SendPlatformAlertResult> {
  return sendPlatformAlert(db, {
    alertType: 'platform_integration_down',
    dedupKey: `${input.integrationName}:${utcFiveMinuteSlot()}`,
    variables: {
      integration_name: input.integrationName,
      error_rate: input.errorRate,
      status_page: input.statusPage ?? '',
    },
    payload: {
      integration: input.integrationName,
      error_rate: input.errorRate,
    },
  })
}

// ---------------------------------------------------------------------------
// 9. platform_weekly_roundup — week:YYYY-WW, hard 1/week
// ---------------------------------------------------------------------------

export async function emitPlatformWeeklyRoundup(
  db: Kysely<Database>,
  input: {
    weekStart: string // caller-supplied (e.g. 'Apr 20, 2026')
    gmvTotal: string
    topShopsHtml: string // pre-rendered HTML block — caller escapes
    /** Optional override for the dedup slot (testing only). */
    isoWeek?: string
  },
): Promise<SendPlatformAlertResult> {
  const isoWeek = input.isoWeek ?? utcIsoWeek()
  return sendPlatformAlert(db, {
    alertType: 'platform_weekly_roundup',
    dedupKey: `week:${isoWeek}`,
    variables: {
      week_start: input.weekStart,
      gmv_total: input.gmvTotal,
      top_shops_html: input.topShopsHtml,
    },
    payload: { iso_week: isoWeek },
  })
}

// ---------------------------------------------------------------------------
// Re-export dedup key builders for tests + god-admin preview UI.
// ---------------------------------------------------------------------------

export const __internalDedupHelpers = {
  utcDate,
  utcYearMonth,
  utcIsoWeek,
  utcFiveMinuteSlot,
  incidentHash,
}
