/**
 * God Admin — Platform Alerts (Phase 14 PR6)
 *
 *   GET  /god-admin/platform-alerts         → list 9 recipient rows + recent deliveries
 *   POST /god-admin/platform-alerts/update  → edit recipient email / name / enabled toggle
 *   POST /god-admin/platform-alerts/test    → fire a test alert (bypasses dedup)
 *   POST /god-admin/platform-alerts/policy  → emit a one-off platform_policy_violation
 *                                              for a given shop (ops-review workflow)
 *
 * WHY THIS PAGE EXISTS
 * --------------------
 *   The 9 god-admin-audience email templates (platform_*) fire
 *   automatically (cron / event bus / error handler) but none of them
 *   had a live UI before PR6. This page gives Thai / the on-call team:
 *
 *     1. One-click visibility into WHICH alerts are wired up + where
 *        they're being routed. A dead recipient column = an alert that
 *        would silently black-hole.
 *     2. An enable/disable toggle per alert so a noisy integration can
 *        be paused without redeploying the kill-switch env var (that
 *        switch still exists as a nuclear option — see
 *        isPlatformAlertsEnabled()).
 *     3. A "Send test" button that fires the exact same code path real
 *        alerts use, with a `:test:<uuid>` suffix appended to dedup_key
 *        so the UNIQUE index never rejects it. Useful for verifying a
 *        recipient change actually lands in the right inbox.
 *     4. A "Fire policy violation" action — the one alert_type that
 *        doesn't have an automatic trigger. When a god-admin decides a
 *        shop is violating platform ToS, pressing this button records
 *        the review in platform_alert_deliveries + emails the on-call
 *        @gbox.co address. (Enforcement — suspending the shop — stays
 *        on the stores page; this is just notification.)
 *
 * IRON RULE 5 (redundant belt-and-braces)
 * ---------------------------------------
 *   Every action on this page funnels through `sendPlatformAlert()`,
 *   which hardcodes `shopId: null` in its internal sendTemplatedEmail
 *   call. That's what makes the iron-rule-5 gate at send.ts:201 pass
 *   (audience='god_admin' + shopId==null is the approved shape).
 *   DO NOT add a code path that constructs a direct
 *   `sendTemplatedEmail({ templateKey: 'platform_*', shopId: <uuid> })`
 *   — the gate rejects it on purpose.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'
import { createCsrfStore } from '@gbox/core/modules/auth/csrf-express.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import {
  PLATFORM_ALERT_TYPES,
  listRecipients,
  updateRecipient,
  isPlatformAlertsEnabled,
  sendPlatformAlert,
  emitPlatformPolicyViolation,
  type PlatformAlertType,
  type PlatformAlertRecipient,
} from '@gbox/core/modules/platform-alerts/index.js'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// CSRF store — scoped cookie keeps us out of other pages' token space.
// ---------------------------------------------------------------------------

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_god_platform_alerts' })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: unknown): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function shortDateTime(d: Date | null): string {
  if (!d) return '—'
  return d.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

/**
 * Friendly titles for the 9 alert types. Kept as a hardcoded map (not
 * derived from registry subjects) because the registry subjects contain
 * `{{variable}}` placeholders that look broken when rendered standalone.
 */
const ALERT_LABELS: Record<PlatformAlertType, { title: string; description: string }> = {
  new_merchant_signup: {
    title: 'New merchant signup',
    description: 'Fires once per shop when a brand-new merchant completes signup.',
  },
  platform_incident_alert: {
    title: 'Platform incident',
    description: 'Unhandled server error or critical 5xx. 60s hash-cooldown dedup.',
  },
  platform_daily_digest: {
    title: 'Daily platform digest',
    description: 'GMV, new merchants, churn. Runs once per day UTC via cron.',
  },
  platform_churn_alert: {
    title: 'Shop churn',
    description: 'Shop suspended or deleted. 1 alert per shop per month.',
  },
  platform_fraud_review: {
    title: 'Fraud review',
    description: 'Rising cluster of high-risk orders. 1/shop/day from fraud-review cron.',
  },
  platform_policy_violation: {
    title: 'Policy violation',
    description: 'Manual ops-review action; triggered from the button below.',
  },
  platform_billing_failure: {
    title: 'Platform billing failure',
    description: 'Deferred — wires once Phase 12 Stripe Connect ships.',
  },
  platform_integration_down: {
    title: 'Integration down',
    description: 'Third-party API error-rate spike (5-minute slot dedup).',
  },
  platform_weekly_roundup: {
    title: 'Weekly roundup',
    description: 'Top-10 shops + GMV; Monday morning via cron.',
  },
}

function statusBadge(enabled: boolean): string {
  return enabled
    ? '<span class="badge badge-green">Enabled</span>'
    : '<span class="badge badge-gray">Disabled</span>'
}

// ---------------------------------------------------------------------------
// Flash cookie — survives the post-redirect cycle (10s TTL)
// ---------------------------------------------------------------------------

type Flash = { ok?: string; err?: string }

function readFlashCookie(req: Request): Flash {
  const raw = req.cookies?.['gbox_god_platform_alerts_flash']
  if (!raw || typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
    if (parsed && typeof parsed === 'object') return parsed as Flash
  } catch {
    // ignore
  }
  return {}
}

function writeFlashCookie(res: Response, flash: Flash): void {
  const value = Buffer.from(JSON.stringify(flash), 'utf8').toString('base64')
  res.cookie('gbox_god_platform_alerts_flash', value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 10_000,
    path: '/god-admin/platform-alerts',
  })
}

function clearFlashCookie(res: Response): void {
  res.clearCookie('gbox_god_platform_alerts_flash', { path: '/god-admin/platform-alerts' })
}

// ---------------------------------------------------------------------------
// Data loaders
// ---------------------------------------------------------------------------

interface AlertRow {
  alertType: PlatformAlertType
  recipient: PlatformAlertRecipient | null
  lastDeliveryAt: Date | null
  totalDeliveries: number
  label: { title: string; description: string }
}

async function loadAlertRows(db: Kysely<Database>): Promise<AlertRow[]> {
  // `as any` at cross-module entry — the platform-alerts module bundles
  // its own Kysely instance (packages/db pins its own kysely), which
  // gives TS a nominal mismatch despite identical structural types.
  // Same workaround that email.ts:postSendTestEmail uses.
  const recipients = await listRecipients(db as any)
  const recipientByType = new Map(recipients.map((r) => [r.alertType, r] as const))

  // One COUNT + MAX per alert_type. Could be a single GROUP BY query if
  // this grows; 9 rows × 1 round-trip is fine for now.
  const rows: AlertRow[] = []
  for (const type of PLATFORM_ALERT_TYPES) {
    const stats = await db
      .selectFrom('platform_alert_deliveries')
      .select([
        sql<string>`COUNT(*)`.as('total'),
        sql<unknown>`MAX(created_at)`.as('last_at'),
      ])
      .where('alert_type', '=', type)
      .executeTakeFirst()

    const total = Number(stats?.total ?? 0)
    const lastAtRaw: unknown = stats?.last_at ?? null
    const lastAt =
      lastAtRaw instanceof Date
        ? lastAtRaw
        : typeof lastAtRaw === 'string'
          ? new Date(lastAtRaw)
          : null

    rows.push({
      alertType: type,
      recipient: recipientByType.get(type) ?? null,
      lastDeliveryAt: lastAt,
      totalDeliveries: total,
      label: ALERT_LABELS[type],
    })
  }
  return rows
}

interface RecentDelivery {
  id: number
  alertType: string
  dedupKey: string
  createdAt: Date | null
  emailDeliveryId: number | null
  emailStatus: string | null
  emailTo: string | null
}

async function loadRecentDeliveries(
  db: Kysely<Database>,
  limit: number,
): Promise<RecentDelivery[]> {
  // LEFT JOIN email_deliveries so test-sends that hit the transport
  // surface their status. Platform_alert_deliveries is the source of
  // truth for WHICH alerts fired; email_deliveries is the source of
  // truth for WHAT the transport did.
  const rows = await db
    .selectFrom('platform_alert_deliveries as pad')
    .leftJoin('email_deliveries as ed', 'ed.id', 'pad.email_delivery_id')
    .select([
      'pad.id as id',
      'pad.alert_type as alert_type',
      'pad.dedup_key as dedup_key',
      'pad.created_at as created_at',
      'pad.email_delivery_id as email_delivery_id',
      'ed.status as email_status',
      'ed.recipient_email as email_to',
    ])
    .orderBy('pad.created_at', 'desc')
    .limit(Math.max(1, Math.min(100, limit)))
    .execute()

  return rows.map((r) => {
    const createdRaw = r.created_at as unknown
    const createdAt =
      createdRaw instanceof Date
        ? createdRaw
        : typeof createdRaw === 'string'
          ? new Date(createdRaw)
          : null
    return {
      id: Number(r.id),
      alertType: String(r.alert_type),
      dedupKey: String(r.dedup_key),
      createdAt,
      emailDeliveryId: r.email_delivery_id == null ? null : Number(r.email_delivery_id),
      emailStatus: r.email_status == null ? null : String(r.email_status),
      emailTo: r.email_to == null ? null : String(r.email_to),
    }
  })
}

// ---------------------------------------------------------------------------
// Page render
// ---------------------------------------------------------------------------

function renderRecipientsSection(
  rows: AlertRow[],
  csrfToken: string,
  alertsEnabled: boolean,
): string {
  const banner = alertsEnabled
    ? ''
    : `<div class="card" style="border-color:var(--red); margin-bottom:16px;">
         <p style="margin:0; color:var(--red); font-weight:600;">
           Kill-switch ON — PLATFORM_ALERTS_ENABLED=0 is set in env. No platform alerts will
           fire until this is cleared, regardless of per-alert toggles below.
         </p>
       </div>`

  const items = rows
    .map((row) => {
      const rec = row.recipient
      const currentEmail = rec?.recipientEmail ?? ''
      const currentName = rec?.recipientName ?? ''
      const enabled = rec?.enabled ?? true
      return `
        <div class="alert-card">
          <div class="alert-card-header">
            <div>
              <div class="alert-card-title">${esc(row.label.title)}</div>
              <div class="alert-card-type"><code>${esc(row.alertType)}</code></div>
            </div>
            <div class="alert-card-meta">
              ${statusBadge(enabled)}
              <span class="alert-count" title="Total deliveries">${row.totalDeliveries}</span>
            </div>
          </div>
          <div class="alert-card-desc">${esc(row.label.description)}</div>
          <div class="alert-card-last">
            <span class="muted">Last fired:</span>
            <span>${esc(shortDateTime(row.lastDeliveryAt))}</span>
          </div>

          <form method="post" action="/god-admin/platform-alerts/update" class="alert-card-form">
            ${csrfHiddenField(csrfToken)}
            <input type="hidden" name="alert_type" value="${esc(row.alertType)}">
            <div class="form-row">
              <label>
                <span>Recipient email</span>
                <input type="email" name="recipient_email" required value="${esc(currentEmail)}">
              </label>
              <label>
                <span>Display name (optional)</span>
                <input type="text" name="recipient_name" value="${esc(currentName)}">
              </label>
            </div>
            <div class="form-row form-row-inline">
              <label class="checkbox">
                <input type="checkbox" name="enabled" value="1"${enabled ? ' checked' : ''}>
                <span>Enabled</span>
              </label>
              <div class="form-actions">
                <button type="submit" class="btn btn-primary">Save</button>
                <button
                  type="submit"
                  class="btn"
                  formaction="/god-admin/platform-alerts/test"
                  formnovalidate>
                  Send test
                </button>
              </div>
            </div>
          </form>
        </div>`
    })
    .join('')

  return `
    <div class="page-header">
      <h1>Platform Alerts</h1>
      <div class="page-header-sub">
        Routing + dedup + delivery log for the 9 god-admin-audience email templates.
      </div>
    </div>
    ${banner}
    <div class="alerts-grid">
      ${items}
    </div>
  `
}

function renderPolicySection(csrfToken: string): string {
  return `
    <div class="card" style="margin-top:24px;">
      <h2 style="margin-top:0;">Fire policy violation</h2>
      <p class="muted">
        Records a manual policy-review event for a shop. Emails the on-call
        @gbox.co recipient for <code>platform_policy_violation</code> and
        writes one row to <code>platform_alert_deliveries</code> with dedup
        key <code>shop:&lt;uuid&gt;:YYYY-MM-DD</code> (1 per shop per day).
      </p>
      <form method="post" action="/god-admin/platform-alerts/policy" class="alert-card-form">
        ${csrfHiddenField(csrfToken)}
        <div class="form-row">
          <label>
            <span>Shop ID (UUID)</span>
            <input type="text" name="shop_id" required placeholder="00000000-0000-0000-0000-000000000000">
          </label>
          <label>
            <span>Shop name (label)</span>
            <input type="text" name="shop_name" required placeholder="Acme Merch">
          </label>
        </div>
        <div class="form-field">
          <label>
            <span>Reason</span>
            <textarea name="reason" required rows="3" placeholder="e.g. counterfeit listings, misleading claims…"></textarea>
          </label>
        </div>
        <button type="submit" class="btn btn-primary">Fire policy violation</button>
      </form>
    </div>
  `
}

function renderDeliveriesSection(rows: RecentDelivery[]): string {
  if (rows.length === 0) {
    return `
      <div class="card" style="margin-top:24px;">
        <h2 style="margin-top:0;">Recent deliveries</h2>
        <p class="muted">No alerts fired yet.</p>
      </div>
    `
  }

  const tableRows = rows
    .map(
      (r) => `
        <tr>
          <td>${esc(shortDateTime(r.createdAt))}</td>
          <td><code>${esc(r.alertType)}</code></td>
          <td><code class="muted">${esc(r.dedupKey)}</code></td>
          <td>${esc(r.emailTo ?? '—')}</td>
          <td>${esc(r.emailStatus ?? '—')}</td>
          <td>${r.emailDeliveryId == null ? '—' : `#${r.emailDeliveryId}`}</td>
        </tr>`,
    )
    .join('')

  return `
    <div class="card" style="margin-top:24px;">
      <h2 style="margin-top:0;">Recent deliveries</h2>
      <table class="data-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Alert type</th>
            <th>Dedup key</th>
            <th>To</th>
            <th>Status</th>
            <th>Email #</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </div>
  `
}

function renderFlash(flash: Flash): string {
  if (flash.ok) {
    return `<div class="flash flash-ok">${esc(flash.ok)}</div>`
  }
  if (flash.err) {
    return `<div class="flash flash-err">${esc(flash.err)}</div>`
  }
  return ''
}

// ---------------------------------------------------------------------------
// GET /god-admin/platform-alerts
// ---------------------------------------------------------------------------

export async function getPlatformAlerts(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const user = req.godAdmin!.user
  try {
    const csrfToken = await csrfStore.issue(res, process.env.NODE_ENV === 'production')
    const flash = readFlashCookie(req)
    if (Object.keys(flash).length > 0) clearFlashCookie(res)

    const rows = await loadAlertRows(db)
    const deliveries = await loadRecentDeliveries(db, 50)
    // `isPlatformAlertsEnabled()` returns TRUE when alerts can fire;
    // the banner should show in the inverted case.
    const alertsEnabled = isPlatformAlertsEnabled()

    const content = `
      <style>
        .page-header-sub {
          color: var(--god-text-secondary);
          font-size: 13px;
          margin-top: 4px;
        }
        .alerts-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
          gap: 16px;
        }
        .alert-card {
          background: var(--god-bg-elevated);
          border: 1px solid var(--god-border);
          border-radius: 12px;
          padding: 16px 18px;
        }
        .alert-card-header {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: flex-start;
          margin-bottom: 6px;
        }
        .alert-card-title {
          font-weight: 600;
          font-size: 15px;
          color: var(--god-text);
        }
        .alert-card-type {
          margin-top: 2px;
          font-size: 12px;
        }
        .alert-card-type code {
          background: var(--god-bg-hover);
          padding: 1px 6px;
          border-radius: 4px;
          color: var(--god-text-secondary);
        }
        .alert-card-meta {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .alert-count {
          background: var(--god-bg-hover);
          color: var(--god-text);
          font-size: 12px;
          font-weight: 600;
          padding: 2px 8px;
          border-radius: 10px;
          min-width: 24px;
          text-align: center;
        }
        .alert-card-desc {
          color: var(--god-text-secondary);
          font-size: 13px;
          line-height: 1.5;
          margin-bottom: 10px;
        }
        .alert-card-last {
          display: flex;
          gap: 8px;
          font-size: 12px;
          margin-bottom: 14px;
        }
        .alert-card-form .form-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
          margin-bottom: 10px;
        }
        .alert-card-form .form-row-inline {
          grid-template-columns: auto 1fr;
          align-items: center;
        }
        .alert-card-form .form-actions {
          justify-self: end;
          display: flex;
          gap: 8px;
        }
        .alert-card-form label {
          display: flex;
          flex-direction: column;
          gap: 4px;
          font-size: 12px;
          color: var(--god-text-secondary);
        }
        .alert-card-form input[type=email],
        .alert-card-form input[type=text],
        .alert-card-form textarea {
          background: var(--god-bg);
          border: 1px solid var(--god-border);
          border-radius: 6px;
          padding: 6px 10px;
          color: var(--god-text);
          font-size: 13px;
          font-family: inherit;
        }
        .alert-card-form .checkbox {
          flex-direction: row;
          align-items: center;
          gap: 6px;
        }
        .muted {
          color: var(--god-text-secondary);
        }
        .flash {
          margin-bottom: 16px;
          padding: 10px 14px;
          border-radius: 8px;
          font-size: 13px;
        }
        .flash-ok {
          background: color-mix(in srgb, var(--green) 20%, transparent);
          color: var(--green);
          border: 1px solid var(--green);
        }
        .flash-err {
          background: color-mix(in srgb, var(--red) 20%, transparent);
          color: var(--red);
          border: 1px solid var(--red);
        }
        .data-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }
        .data-table th,
        .data-table td {
          padding: 8px 10px;
          border-bottom: 1px solid var(--god-border);
          text-align: left;
        }
        .data-table th {
          color: var(--god-text-secondary);
          font-weight: 600;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.4px;
        }
      </style>
      ${renderFlash(flash)}
      ${renderRecipientsSection(rows, csrfToken, alertsEnabled)}
      ${renderPolicySection(csrfToken)}
      ${renderDeliveriesSection(deliveries)}
    `

    res.send(
      godLayout({
        title: 'Platform Alerts',
        userEmail: user.email,
        activePath: '/god-admin/platform-alerts',
        content,
      }),
    )
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[God Admin] platform-alerts error:', err)
    res.status(500).send(
      godLayout({
        title: 'Platform Alerts',
        userEmail: user.email,
        activePath: '/god-admin/platform-alerts',
        content: `<div class="card"><p style="color:var(--red)">Error loading platform alerts: ${esc(
          String(err),
        )}</p></div>`,
      }),
    )
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/platform-alerts/update — edit recipient row
// ---------------------------------------------------------------------------

function isPlatformAlertType(s: string): s is PlatformAlertType {
  return (PLATFORM_ALERT_TYPES as readonly string[]).includes(s)
}

export async function postUpdateRecipient(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const valid = await csrfStore.verify(req)
  if (!valid) {
    writeFlashCookie(res, { err: 'CSRF check failed. Reload the page and try again.' })
    res.redirect('/god-admin/platform-alerts')
    return
  }

  const alertType = String(req.body?.alert_type ?? '').trim()
  const recipientEmail = String(req.body?.recipient_email ?? '').trim()
  const recipientName = String(req.body?.recipient_name ?? '').trim()
  // HTML checkboxes only submit when checked — a missing field = off.
  const enabled = req.body?.enabled === '1' || req.body?.enabled === 'on'

  if (!isPlatformAlertType(alertType)) {
    writeFlashCookie(res, { err: `Unknown alert_type: ${alertType}` })
    res.redirect('/god-admin/platform-alerts')
    return
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
    writeFlashCookie(res, { err: `"${recipientEmail}" is not a valid email address.` })
    res.redirect('/god-admin/platform-alerts')
    return
  }

  try {
    // `as any` — see loadAlertRows() for the Kysely dedup note.
    const updated = await updateRecipient(db as any, {
      alertType,
      recipientEmail,
      recipientName: recipientName || null,
      enabled,
    })
    if (!updated) {
      writeFlashCookie(res, { err: `No row found for alert_type=${alertType}. Did migration 089 run?` })
    } else {
      writeFlashCookie(res, {
        ok: `Saved ${alertType} → ${updated.recipientEmail} (${enabled ? 'enabled' : 'disabled'}).`,
      })
    }
  } catch (err) {
    writeFlashCookie(res, {
      err: `Save failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
  res.redirect('/god-admin/platform-alerts')
}

// ---------------------------------------------------------------------------
// POST /god-admin/platform-alerts/test — fire a test alert (bypass dedup)
// ---------------------------------------------------------------------------
//
// Sidesteps the UNIQUE index by appending `:test:<uuid>` to dedup_key so
// the INSERT never conflicts. Variables are canned placeholders chosen
// per alert type so the rendered email looks sensible (vs. empty
// `{{shop_name}}` placeholders).

function testVariablesFor(alertType: PlatformAlertType): Record<string, unknown> {
  const common = {
    shop_name: 'Test Shop (god-admin)',
    owner_email: 'test@example.com',
    country: 'US',
    shop_url: 'https://test.gbox.co',
  }
  switch (alertType) {
    case 'new_merchant_signup':
      return common
    case 'platform_incident_alert':
      return {
        severity: 'medium',
        title: 'Test incident — ignore',
        runbook_url: 'https://runbook.gbox.co/incidents/test',
      }
    case 'platform_daily_digest':
      return {
        date: new Date().toISOString().slice(0, 10),
        gmv_total: '$12,345.67',
        new_shops: '3',
        churned_shops: '1',
      }
    case 'platform_churn_alert':
      return { shop_name: common.shop_name, closure_reason: 'Test — ignore' }
    case 'platform_fraud_review':
      return {
        shop_name: common.shop_name,
        heuristic: 'Test heuristic — ignore',
        evidence_url: 'https://god.gbox.co/test',
      }
    case 'platform_policy_violation':
      return { shop_name: common.shop_name, reason: 'Test reason — ignore' }
    case 'platform_billing_failure':
      return {
        shop_name: common.shop_name,
        amount: '$49.00',
        failure_reason: 'Test — ignore',
      }
    case 'platform_integration_down':
      return {
        integration_name: 'test-integration',
        error_rate: '42%',
        status_page: 'https://status.gbox.co/test',
      }
    case 'platform_weekly_roundup':
      return {
        week_start: new Date().toDateString(),
        gmv_total: '$98,765.43',
        top_shops_html:
          '<ol><li>Test Shop A — $12,345</li><li>Test Shop B — $6,789</li></ol>',
      }
  }
}

export async function postSendTestAlert(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const valid = await csrfStore.verify(req)
  if (!valid) {
    writeFlashCookie(res, { err: 'CSRF check failed. Reload the page and try again.' })
    res.redirect('/god-admin/platform-alerts')
    return
  }

  const alertType = String(req.body?.alert_type ?? '').trim()
  if (!isPlatformAlertType(alertType)) {
    writeFlashCookie(res, { err: `Unknown alert_type: ${alertType}` })
    res.redirect('/god-admin/platform-alerts')
    return
  }

  // The form "Send test" button shares the save form → we also have the
  // updated recipient value. Use it as an override so a still-unsaved
  // email works: the admin types a new address + clicks "Send test"
  // without first clicking "Save", and the test actually lands there.
  const overrideEmail = String(req.body?.recipient_email ?? '').trim()
  const recipientOverride =
    overrideEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(overrideEmail)
      ? overrideEmail
      : undefined

  // PR7 BUG-E3 — when overriding, we MUST supply actorUserId + actorIp
  // so `sendPlatformAlert` can rate-limit per actor + write the
  // audit_logs forensic trail. `godAdmin` is always populated by the
  // godAuth middleware on this route; defensively default actorUserId
  // to null so a misconfigured session returns `override_missing_actor`
  // rather than crashing the handler.
  const actorUserId = req.godAdmin?.user.id ?? null
  const actorIp =
    typeof req.ip === 'string' && req.ip.length > 0 ? req.ip : null

  const result = await sendPlatformAlert(db as any, {
    alertType,
    // `:test:<uuid>` suffix — UNIQUE index will never reject this.
    dedupKey: `test:${randomUUID()}`,
    variables: testVariablesFor(alertType),
    payload: { test: true, fired_by: req.godAdmin!.user.email },
    recipientOverride,
    actorUserId,
    actorIp,
  })

  if (result.sent) {
    writeFlashCookie(res, {
      ok: `Test ${alertType} fired (delivery_row=${result.deliveryRowId}, email_delivery=${result.emailDeliveryId ?? '—'}).`,
    })
  } else {
    // Map the PR7 override-path rejection reasons to specific seller-
    // err… ops-facing messages. Other reasons get the generic format.
    let msg: string
    switch (result.reason) {
      case 'override_rate_limited':
        msg = `Test ${alertType} blocked — override limit is 10/min per admin. Try again in a minute.`
        break
      case 'override_missing_actor':
        msg = `Test ${alertType} blocked — session missing actor id. Re-login and try again.`
        break
      case 'override_invalid_email':
        msg = `Test ${alertType} blocked — "${overrideEmail}" is not a valid recipient address.`
        break
      default:
        msg = `Test ${alertType} not sent — reason=${result.reason}${result.error ? ` · ${result.error}` : ''}`
    }
    writeFlashCookie(res, { err: msg })
  }
  res.redirect('/god-admin/platform-alerts')
}

// ---------------------------------------------------------------------------
// POST /god-admin/platform-alerts/policy — manual policy_violation emit
// ---------------------------------------------------------------------------

export async function postFirePolicyViolation(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const valid = await csrfStore.verify(req)
  if (!valid) {
    writeFlashCookie(res, { err: 'CSRF check failed. Reload the page and try again.' })
    res.redirect('/god-admin/platform-alerts')
    return
  }

  const shopId = String(req.body?.shop_id ?? '').trim()
  const shopName = String(req.body?.shop_name ?? '').trim()
  const reason = String(req.body?.reason ?? '').trim()

  // Loose UUID check — not strict (accepts any 36-char dash-shaped id).
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(shopId)) {
    writeFlashCookie(res, { err: `Shop ID "${shopId}" is not a valid UUID.` })
    res.redirect('/god-admin/platform-alerts')
    return
  }
  if (!shopName) {
    writeFlashCookie(res, { err: 'Shop name is required.' })
    res.redirect('/god-admin/platform-alerts')
    return
  }
  if (!reason) {
    writeFlashCookie(res, { err: 'Reason is required.' })
    res.redirect('/god-admin/platform-alerts')
    return
  }

  const result = await emitPlatformPolicyViolation(db as any, { shopId, shopName, reason })
  if (result.sent) {
    writeFlashCookie(res, {
      ok: `Policy violation fired for ${shopName} (delivery_row=${result.deliveryRowId}).`,
    })
  } else if (result.reason === 'deduped') {
    writeFlashCookie(res, {
      err: `Already fired for this shop today (1/shop/day dedup). Try again tomorrow.`,
    })
  } else {
    writeFlashCookie(res, {
      err: `Policy violation not sent — reason=${result.reason}${result.error ? ` · ${result.error}` : ''}`,
    })
  }
  res.redirect('/god-admin/platform-alerts')
}
