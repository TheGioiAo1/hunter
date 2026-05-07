/**
 * God Admin — Email Center (Phase 14 PR1)
 *
 * GET  /god-admin/email                → Templates tab (default)
 * GET  /god-admin/email?tab=deliveries → Deliveries tab (last 24h)
 * GET  /god-admin/email?tab=preferences→ Opt-in/out aggregates
 * GET  /god-admin/email?tab=tests      → Live send-a-test form
 * POST /god-admin/email/send-test      → Fire a test email (god-admin only)
 *
 * WHAT THIS PAGE IS FOR
 * ---------------------
 *   Thai / the platform team need one place to see every email Gbox
 *   sends, across every shop + platform scope. Iron Rule 5 says seller
 *   surfaces can only see their own shop's templates; this is the
 *   god-admin equivalent — it sees _all_ 95 catalog entries including
 *   the 9 god_admin-audience ones (`new_merchant_signup`,
 *   `platform_incident_alert`, etc.) that sellers must never see.
 *
 * This page reads from:
 *   - `EMAIL_TEMPLATE_CATALOG` (authoritative in-code catalog)
 *   - `email_template_registry` (seeded mirror, holds overrides)
 *   - `email_deliveries` (append-only send log)
 *   - `email_preferences` (opt-out state)
 *
 * NO SELLER-FACING STRINGS
 * ------------------------
 *   The word "god admin" is fine here — this page is _only_ rendered
 *   inside /god-admin/* which seller tokens can never reach (see
 *   createGodAuthMiddleware). Iron Rule 5 applies to seller surfaces
 *   only. If you ever copy chunks of this file into store-admin, you
 *   must strip every mention.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import type { EmailDeliveryStatus } from '../../../../packages/db/src/schema/tables.js'
import { godLayout } from '../layouts/god-layout.js'
import { createCsrfStore } from '@gbox/core/modules/auth/csrf-express.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import {
  EMAIL_TEMPLATE_CATALOG,
  getAllTemplates,
  getTemplate,
  getImplementedTemplates,
  getPendingTemplates,
  type TemplateSpec,
} from '@gbox/core/modules/email/registry.js'
import {
  getDeliveryStatusCounts,
} from '@gbox/core/modules/email/delivery-log.js'
import {
  sendTemplatedEmail,
} from '@gbox/core/modules/email/send.js'
import {
  resolveTransport,
  readEmailEnv,
  hasGmailSmtpCredentials,
} from '@gbox/core/modules/email/transport.js'

// ---------------------------------------------------------------------------
// CSRF store (cookie scoped to this page only — keeps its token space
// separate from plan-requests and other god-admin flows).
// ---------------------------------------------------------------------------

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_god_email' })

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

function shortDateTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function categoryBadge(c: string): string {
  const map: Record<string, string> = {
    transactional: 'badge-blue',
    marketing: 'badge-yellow',
    lifecycle: 'badge-green',
    reviews: 'badge-blue',
    ops: 'badge-gray',
    platform: 'badge-red',
    legal: 'badge-gray',
  }
  return `<span class="badge ${map[c] || 'badge-gray'}">${esc(c)}</span>`
}

function audienceBadge(a: string): string {
  const map: Record<string, string> = {
    customer: 'badge-green',
    merchant: 'badge-blue',
    god_admin: 'badge-red',
  }
  return `<span class="badge ${map[a] || 'badge-gray'}">${esc(a.replace('_', ' '))}</span>`
}

function priorityBadge(p: number): string {
  // P1 = highest
  if (p === 1) return '<span class="badge badge-red">P1</span>'
  if (p === 2) return '<span class="badge badge-yellow">P2</span>'
  if (p === 3) return '<span class="badge badge-blue">P3</span>'
  return '<span class="badge badge-gray">P4</span>'
}

function implementedBadge(b: boolean): string {
  return b
    ? '<span class="badge badge-green">Live</span>'
    : '<span class="badge badge-gray">Scaffold</span>'
}

function statusBadge(s: EmailDeliveryStatus): string {
  const map: Record<EmailDeliveryStatus, string> = {
    sent: 'badge-green',
    queued: 'badge-yellow',
    bounced: 'badge-red',
    failed: 'badge-red',
    skipped_pref: 'badge-gray',
    skipped_suppressed: 'badge-gray',
    skipped_invalid: 'badge-gray',
  }
  return `<span class="badge ${map[s] || 'badge-gray'}">${esc(s.replace('_', ' '))}</span>`
}

/** 4-tab switcher fixed to the top of every view. */
function tabBar(active: string): string {
  const tabs = [
    { key: 'templates',   label: 'Templates',    count: 95 },
    { key: 'deliveries',  label: 'Deliveries',   count: null },
    { key: 'preferences', label: 'Preferences',  count: null },
    { key: 'tests',       label: 'Send Test',    count: null },
  ]
  return `
    <div class="email-tabs">
      ${tabs.map(t => {
        const isActive = t.key === active
        const countHtml = t.count != null ? `<span class="tab-count">${t.count}</span>` : ''
        return `<a href="/god-admin/email?tab=${t.key}" class="email-tab${isActive ? ' email-tab-active' : ''}">${esc(t.label)}${countHtml}</a>`
      }).join('')}
    </div>
  `
}

/** Shared CSS injected into every tab. */
function emailCss(): string {
  return `
    <style>
      .email-tabs {
        display: flex; gap: 4px; margin-bottom: 20px;
        border-bottom: 1px solid var(--god-border);
      }
      .email-tab {
        padding: 10px 16px; font-size: 13px; font-weight: 600;
        color: var(--god-text-muted); text-decoration: none;
        border-bottom: 2px solid transparent;
        transition: color 0.15s, border-color 0.15s;
        display: inline-flex; align-items: center; gap: 8px;
      }
      .email-tab:hover { color: var(--god-text); }
      .email-tab-active {
        color: var(--god-accent);
        border-bottom-color: var(--god-accent);
      }
      .tab-count {
        background: var(--god-bg-hover); color: var(--god-text-muted);
        font-size: 11px; padding: 1px 7px; border-radius: 10px;
      }
      .email-tab-active .tab-count {
        background: var(--god-accent-bg); color: var(--god-accent);
      }

      .counter-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
        gap: 12px; margin-bottom: 20px;
      }
      .counter-card {
        background: var(--god-bg-elevated); border: 1px solid var(--god-border);
        border-radius: 10px; padding: 14px 18px;
      }
      .counter-label {
        font-size: 11px; font-weight: 600; color: var(--god-text-muted);
        text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;
      }
      .counter-value { font-size: 22px; font-weight: 700; color: var(--god-text); }
      .counter-sent .counter-value { color: var(--green); }
      .counter-failed .counter-value { color: var(--red); }
      .counter-skipped .counter-value { color: var(--god-text-muted); }

      .template-row-main {
        display: flex; align-items: center; gap: 10px;
      }
      .template-key {
        font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
        font-size: 12px; color: var(--god-text);
      }
      .template-subject {
        font-size: 12px; color: var(--god-text-muted);
        max-width: 340px; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap;
      }
      .template-badges {
        display: flex; flex-wrap: wrap; gap: 4px;
      }

      .filter-bar {
        display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap;
        align-items: center;
      }
      .filter-bar input[type=search] {
        padding: 7px 12px; border: 1.5px solid var(--god-border-light);
        border-radius: 8px; font-size: 13px; background: var(--god-bg);
        color: var(--god-text); min-width: 260px; outline: none;
      }
      .filter-bar select {
        padding: 7px 10px; border: 1.5px solid var(--god-border-light);
        border-radius: 8px; font-size: 13px; background: var(--god-bg);
        color: var(--god-text-secondary); outline: none; cursor: pointer;
      }

      .env-box {
        background: var(--god-bg-elevated); border: 1px solid var(--god-border);
        border-radius: 10px; padding: 16px 20px; margin-bottom: 20px;
      }
      .env-row {
        display: flex; justify-content: space-between; gap: 10px;
        padding: 6px 0; font-size: 13px;
        border-bottom: 1px solid var(--god-border);
      }
      .env-row:last-child { border-bottom: none; }
      .env-key { color: var(--god-text-muted); font-family: 'SF Mono', monospace; font-size: 12px; }
      .env-val { color: var(--god-text); font-weight: 500; font-family: 'SF Mono', monospace; font-size: 12px; }
      .env-val-missing { color: var(--red); }
      .env-val-ok { color: var(--green); }

      .test-form {
        background: var(--god-bg-elevated); border: 1px solid var(--god-border);
        border-radius: 10px; padding: 24px; max-width: 640px;
      }
      .form-field { margin-bottom: 16px; }
      .form-field label {
        display: block; font-size: 12px; font-weight: 600;
        color: var(--god-text-secondary); margin-bottom: 6px;
        text-transform: uppercase; letter-spacing: 0.5px;
      }
      .form-field input, .form-field select, .form-field textarea {
        width: 100%; padding: 9px 12px; border: 1.5px solid var(--god-border-light);
        border-radius: 8px; font-size: 14px; font-family: inherit;
        background: var(--god-bg); color: var(--god-text); outline: none;
      }
      .form-field input:focus, .form-field select:focus, .form-field textarea:focus {
        border-color: var(--god-accent);
      }
      .form-field textarea { min-height: 90px; resize: vertical; }
      .form-field .hint {
        font-size: 11px; color: var(--god-text-muted); margin-top: 4px;
      }

      .result-ok { background: var(--green-bg); border: 1px solid var(--green); padding: 12px 16px; border-radius: 8px; color: var(--green); margin-bottom: 20px; }
      .result-err { background: var(--red-bg); border: 1px solid var(--red); padding: 12px 16px; border-radius: 8px; color: var(--red); margin-bottom: 20px; }
      .result-dim { background: var(--god-bg-hover); border: 1px solid var(--god-border-light); padding: 12px 16px; border-radius: 8px; color: var(--god-text-secondary); margin-bottom: 20px; }

      .empty-cell { color: var(--god-text-muted); }
    </style>
  `
}

// ---------------------------------------------------------------------------
// Tab renderers
// ---------------------------------------------------------------------------

function renderTemplatesTab(
  searchQuery: string,
  filterCat: string,
  filterAud: string,
): string {
  const all = getAllTemplates()
  const q = searchQuery.trim().toLowerCase()
  const filtered = all.filter(t => {
    if (q && !t.key.toLowerCase().includes(q) && !t.subject.toLowerCase().includes(q) && !t.description.toLowerCase().includes(q)) return false
    if (filterCat && t.category !== filterCat) return false
    if (filterAud && t.audience !== filterAud) return false
    return true
  })

  const implementedCount = getImplementedTemplates().length
  const pendingCount = getPendingTemplates().length

  const catOpts = ['transactional','marketing','lifecycle','reviews','ops','platform','legal']
  const audOpts = ['customer','merchant','god_admin']

  const rows = filtered.length === 0
    ? `<tr><td colspan="4" class="empty-cell" style="text-align:center;padding:28px">No templates match that filter.</td></tr>`
    : filtered.map(t => `
        <tr>
          <td>
            <div class="template-row-main">
              <div>
                <div class="template-key">${esc(t.key)}</div>
                <div class="template-subject">${esc(t.subject)}</div>
              </div>
            </div>
          </td>
          <td class="template-badges">
            ${categoryBadge(t.category)}
            ${audienceBadge(t.audience)}
          </td>
          <td>${priorityBadge(t.priority)}</td>
          <td>${implementedBadge(t.implemented)}</td>
        </tr>
      `).join('')

  return `
    <div class="counter-grid">
      <div class="counter-card">
        <div class="counter-label">Total</div>
        <div class="counter-value">${all.length}</div>
      </div>
      <div class="counter-card counter-sent">
        <div class="counter-label">Live (PR1)</div>
        <div class="counter-value">${implementedCount}</div>
      </div>
      <div class="counter-card">
        <div class="counter-label">Scaffold</div>
        <div class="counter-value">${pendingCount}</div>
      </div>
      <div class="counter-card">
        <div class="counter-label">Showing</div>
        <div class="counter-value">${filtered.length}</div>
      </div>
    </div>

    <form class="filter-bar" method="get" action="/god-admin/email">
      <input type="hidden" name="tab" value="templates">
      <input type="search" name="q" value="${esc(searchQuery)}" placeholder="Search key / subject / description…">
      <select name="cat">
        <option value="">All categories</option>
        ${catOpts.map(c => `<option value="${c}" ${filterCat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
      </select>
      <select name="aud">
        <option value="">All audiences</option>
        ${audOpts.map(a => `<option value="${a}" ${filterAud === a ? 'selected' : ''}>${esc(a.replace('_',' '))}</option>`).join('')}
      </select>
      <button type="submit" class="btn btn-primary btn-sm">Apply</button>
      <a href="/god-admin/email?tab=templates" class="btn btn-secondary btn-sm">Reset</a>
    </form>

    <div class="card" style="padding:0">
      <table class="data-table">
        <thead>
          <tr>
            <th>Template</th>
            <th>Tags</th>
            <th>Priority</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `
}

async function renderDeliveriesTab(
  db: Kysely<Database>,
): Promise<string> {
  // Last 24h aggregates — platform-wide (shopId omitted).
  let counts: Record<EmailDeliveryStatus, number>
  let recent: Array<{
    id: number
    template_key: string
    shop_id: string | null
    recipient_email: string
    subject: string
    status: EmailDeliveryStatus
    provider: string | null
    created_at: string
    sent_at: string | null
    failed_reason: string | null
  }>

  try {
    // `db as any` sidesteps the dual-Kysely nominal-type quirk: the root
    // node_modules/kysely and packages/db/node_modules/kysely resolve to
    // different `Kysely` symbols even though they're the same runtime
    // class. Mirrors the pattern in platform-analytics.ts.
    counts = await getDeliveryStatusCounts(db as any)
    const rows = await db
      .selectFrom('email_deliveries')
      .select([
        'id', 'template_key', 'shop_id', 'recipient_email',
        'subject', 'status', 'provider', 'created_at',
        'sent_at', 'failed_reason',
      ])
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute()
    recent = rows.map(r => ({
      id: Number(r.id),
      template_key: r.template_key,
      shop_id: r.shop_id,
      recipient_email: r.recipient_email,
      subject: r.subject,
      status: r.status as EmailDeliveryStatus,
      provider: r.provider,
      created_at: r.created_at,
      sent_at: r.sent_at,
      failed_reason: r.failed_reason,
    }))
  } catch (err) {
    return `<div class="result-err">Could not load deliveries: ${esc(String(err))}</div>`
  }

  const total = Object.values(counts).reduce((s, n) => s + n, 0)

  const countersHtml = `
    <div class="counter-grid">
      <div class="counter-card">
        <div class="counter-label">24h Total</div>
        <div class="counter-value">${total}</div>
      </div>
      <div class="counter-card counter-sent">
        <div class="counter-label">Sent</div>
        <div class="counter-value">${counts.sent}</div>
      </div>
      <div class="counter-card">
        <div class="counter-label">Queued</div>
        <div class="counter-value">${counts.queued}</div>
      </div>
      <div class="counter-card counter-failed">
        <div class="counter-label">Failed</div>
        <div class="counter-value">${counts.failed}</div>
      </div>
      <div class="counter-card counter-failed">
        <div class="counter-label">Bounced</div>
        <div class="counter-value">${counts.bounced}</div>
      </div>
      <div class="counter-card counter-skipped">
        <div class="counter-label">Skip (pref)</div>
        <div class="counter-value">${counts.skipped_pref}</div>
      </div>
      <div class="counter-card counter-skipped">
        <div class="counter-label">Skip (suppress)</div>
        <div class="counter-value">${counts.skipped_suppressed}</div>
      </div>
      <div class="counter-card counter-skipped">
        <div class="counter-label">Skip (invalid)</div>
        <div class="counter-value">${counts.skipped_invalid}</div>
      </div>
    </div>
  `

  const rowsHtml = recent.length === 0
    ? `<tr><td colspan="7" class="empty-cell" style="text-align:center;padding:28px">No deliveries yet. They will appear here after the first send.</td></tr>`
    : recent.map(r => `
        <tr>
          <td class="mono">${esc(r.id)}</td>
          <td class="template-key">${esc(r.template_key)}</td>
          <td>${esc(r.recipient_email)}</td>
          <td>${esc(r.subject.slice(0, 60))}${r.subject.length > 60 ? '…' : ''}</td>
          <td>${statusBadge(r.status)}</td>
          <td class="mono">${esc(r.provider ?? '—')}</td>
          <td class="mono">${shortDateTime(r.sent_at ?? r.created_at)}</td>
        </tr>
      `).join('')

  return `
    ${countersHtml}

    <div class="card" style="padding:0">
      <table class="data-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Template</th>
            <th>Recipient</th>
            <th>Subject</th>
            <th>Status</th>
            <th>Provider</th>
            <th>Sent / Queued</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `
}

async function renderPreferencesTab(db: Kysely<Database>): Promise<string> {
  // Aggregate opt-in / opt-out counts by category + shop.
  let byCategory: Array<{ category: string; total: number; subscribed: number; unsubscribed: number }>
  let recent: Array<{
    id: number
    shop_id: string | null
    email: string
    category: string
    subscribed: boolean
    source: string
    updated_at: string
  }>

  try {
    const catRows = await sql<{
      category: string
      total: string
      subscribed: string
      unsubscribed: string
    }>`
      SELECT
        category,
        count(*) as total,
        count(*) FILTER (WHERE subscribed = true) as subscribed,
        count(*) FILTER (WHERE subscribed = false) as unsubscribed
      FROM email_preferences
      GROUP BY category
      ORDER BY count(*) DESC
    `.execute(db)

    byCategory = catRows.rows.map(r => ({
      category: r.category,
      total: Number(r.total),
      subscribed: Number(r.subscribed),
      unsubscribed: Number(r.unsubscribed),
    }))

    const rows = await db
      .selectFrom('email_preferences')
      .select(['id', 'shop_id', 'email', 'category', 'subscribed', 'source', 'updated_at'])
      .orderBy('updated_at', 'desc')
      .limit(50)
      .execute()
    recent = rows.map(r => ({
      id: Number(r.id),
      shop_id: r.shop_id,
      email: r.email,
      category: r.category,
      subscribed: Boolean(r.subscribed),
      source: r.source,
      updated_at: r.updated_at,
    }))
  } catch (err) {
    return `<div class="result-err">Could not load preferences: ${esc(String(err))}</div>`
  }

  const totalAll = byCategory.reduce((s, r) => s + r.total, 0)
  const subAll = byCategory.reduce((s, r) => s + r.subscribed, 0)
  const unsubAll = byCategory.reduce((s, r) => s + r.unsubscribed, 0)

  const countersHtml = `
    <div class="counter-grid">
      <div class="counter-card">
        <div class="counter-label">Total rows</div>
        <div class="counter-value">${totalAll}</div>
      </div>
      <div class="counter-card counter-sent">
        <div class="counter-label">Subscribed</div>
        <div class="counter-value">${subAll}</div>
      </div>
      <div class="counter-card counter-failed">
        <div class="counter-label">Unsubscribed</div>
        <div class="counter-value">${unsubAll}</div>
      </div>
      <div class="counter-card">
        <div class="counter-label">Opt-out rate</div>
        <div class="counter-value">${totalAll > 0 ? ((unsubAll / totalAll) * 100).toFixed(1) : '0'}%</div>
      </div>
    </div>
  `

  const categoryRowsHtml = byCategory.length === 0
    ? `<tr><td colspan="4" class="empty-cell" style="text-align:center;padding:28px">No preference rows recorded yet. They appear after the first marketing/lifecycle send.</td></tr>`
    : byCategory.map(r => `
        <tr>
          <td><span class="badge badge-gray">${esc(r.category)}</span></td>
          <td class="mono">${r.total}</td>
          <td class="mono" style="color:var(--green)">${r.subscribed}</td>
          <td class="mono" style="color:var(--red)">${r.unsubscribed}</td>
        </tr>
      `).join('')

  const recentRowsHtml = recent.length === 0
    ? `<tr><td colspan="5" class="empty-cell" style="text-align:center;padding:24px">No recent changes.</td></tr>`
    : recent.map(r => `
        <tr>
          <td>${esc(r.email)}</td>
          <td><span class="badge badge-gray">${esc(r.category)}</span></td>
          <td>${r.subscribed ? '<span class="badge badge-green">Subscribed</span>' : '<span class="badge badge-red">Unsubscribed</span>'}</td>
          <td class="mono">${esc(r.source)}</td>
          <td class="mono">${shortDateTime(r.updated_at)}</td>
        </tr>
      `).join('')

  return `
    ${countersHtml}

    <div class="two-col">
      <div class="card" style="padding:0">
        <div style="padding:14px 18px;border-bottom:1px solid var(--god-border);font-size:13px;font-weight:600">By category</div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Category</th>
              <th>Total</th>
              <th>Subscribed</th>
              <th>Unsubscribed</th>
            </tr>
          </thead>
          <tbody>${categoryRowsHtml}</tbody>
        </table>
      </div>
      <div class="card" style="padding:0">
        <div style="padding:14px 18px;border-bottom:1px solid var(--god-border);font-size:13px;font-weight:600">Recent changes (50)</div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Category</th>
              <th>State</th>
              <th>Source</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>${recentRowsHtml}</tbody>
        </table>
      </div>
    </div>
  `
}

function renderTestsTab(
  csrfToken: string,
  flash: { ok?: string; err?: string; info?: string },
): string {
  const env = readEmailEnv()
  const hasGmail = hasGmailSmtpCredentials()
  let resolvedName = '—'
  try {
    resolvedName = resolveTransport().name
  } catch (err) {
    resolvedName = `error: ${String(err).slice(0, 120)}`
  }

  const envRows = [
    ['EMAIL_TRANSPORT', process.env.EMAIL_TRANSPORT ?? '(auto)'],
    ['Resolved', resolvedName],
    ['SMTP_HOST', env.host ?? '(not set)'],
    ['SMTP_PORT', String(env.port)],
    ['SMTP_SECURE', String(env.secure)],
    ['SMTP_USER', env.user || '(not set)'],
    ['SMTP_PASS', env.pass ? '(set — ' + env.pass.length + ' chars)' : '(not set)'],
    ['EMAIL_FROM', env.from],
    ['EMAIL_REPLY_TO', env.replyTo ?? '(not set)'],
    ['Gmail creds ready?', hasGmail ? 'yes' : 'no'],
  ]

  const envHtml = `
    <div class="env-box">
      <div style="font-size:13px;font-weight:600;color:var(--god-text);margin-bottom:8px">Transport environment</div>
      ${envRows.map(([k, v]) => {
        const kStr = String(k)
        const vStr = String(v)
        const missing = vStr.startsWith('(not set)') || vStr.startsWith('error')
        const ok = (kStr === 'Gmail creds ready?' && vStr === 'yes') ||
                   (kStr === 'Resolved' && vStr === 'gmail_smtp')
        const cls = missing ? 'env-val-missing' : (ok ? 'env-val-ok' : '')
        return `<div class="env-row"><span class="env-key">${esc(kStr)}</span><span class="env-val ${cls}">${esc(vStr)}</span></div>`
      }).join('')}
    </div>
  `

  // Template options — all 95 keys, grouped by category for clarity.
  const grouped: Record<string, TemplateSpec[]> = {}
  for (const t of getAllTemplates()) {
    if (!grouped[t.category]) grouped[t.category] = []
    grouped[t.category].push(t)
  }
  const templateOptions = Object.entries(grouped).map(([cat, list]) => `
    <optgroup label="${esc(cat)} (${list.length})">
      ${list.map(t => `<option value="${esc(t.key)}">${esc(t.key)}${t.implemented ? '' : ' · scaffold'}</option>`).join('')}
    </optgroup>
  `).join('')

  const flashHtml = flash.ok
    ? `<div class="result-ok">${esc(flash.ok)}</div>`
    : flash.err
      ? `<div class="result-err">${esc(flash.err)}</div>`
      : flash.info
        ? `<div class="result-dim">${esc(flash.info)}</div>`
        : ''

  return `
    ${envHtml}
    ${flashHtml}

    <div class="test-form">
      <h2 style="font-size:16px;font-weight:600;margin:0 0 6px">Send a test email</h2>
      <p style="font-size:13px;color:var(--god-text-muted);margin:0 0 20px">
        Fires through <code>sendTemplatedEmail()</code> — which means this exercises the
        full delivery pipeline (template load → preference gate → delivery row →
        transport). The send uses <code>shopId=null</code> (platform scope) so it
        bypasses Iron Rule 5 for god-admin templates.
      </p>
      <form method="post" action="/god-admin/email/send-test">
        ${csrfHiddenField(csrfToken)}
        <div class="form-field">
          <label for="templateKey">Template</label>
          <select id="templateKey" name="templateKey" required>
            ${templateOptions}
          </select>
          <div class="hint">All 95 templates — scaffold entries render with placeholder HTML.</div>
        </div>
        <div class="form-field">
          <label for="to">Recipient</label>
          <input id="to" name="to" type="email" required placeholder="you@example.com" value="buithai3107@gmail.com">
          <div class="hint">Default = Thai's test inbox.</div>
        </div>
        <div class="form-field">
          <label for="variables">Variables (JSON, optional)</label>
          <textarea id="variables" name="variables" placeholder='{ "heading": "Hello", "body_html": "&lt;p&gt;test&lt;/p&gt;" }'></textarea>
          <div class="hint">Any <code>{{name}}</code> placeholders in the subject / body will pick values from here.</div>
        </div>
        <button type="submit" class="btn btn-primary">Send test</button>
      </form>
    </div>
  `
}

// ---------------------------------------------------------------------------
// GET /god-admin/email
// ---------------------------------------------------------------------------

type Flash = { ok?: string; err?: string; info?: string }

function readFlashCookie(req: Request): Flash {
  const raw = req.cookies?.['gbox_god_email_flash']
  if (!raw || typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
    if (parsed && typeof parsed === 'object') return parsed as Flash
  } catch {
    // ignore — treat as no flash
  }
  return {}
}

function writeFlashCookie(res: Response, flash: Flash): void {
  const value = Buffer.from(JSON.stringify(flash), 'utf8').toString('base64')
  res.cookie('gbox_god_email_flash', value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 10_000, // 10 s — consumed on next page load
    path: '/god-admin/email',
  })
}

function clearFlashCookie(res: Response): void {
  res.clearCookie('gbox_god_email_flash', { path: '/god-admin/email' })
}

export async function getEmail(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const user = req.godAdmin!.user
  const tab = String(req.query.tab ?? 'templates')
  const searchQuery = String(req.query.q ?? '')
  const filterCat = String(req.query.cat ?? '')
  const filterAud = String(req.query.aud ?? '')

  try {
    let body = ''
    if (tab === 'deliveries') {
      body = await renderDeliveriesTab(db)
    } else if (tab === 'preferences') {
      body = await renderPreferencesTab(db)
    } else if (tab === 'tests') {
      const csrfToken = await csrfStore.issue(res, process.env.NODE_ENV === 'production')
      const flash = readFlashCookie(req)
      if (Object.keys(flash).length > 0) clearFlashCookie(res)
      body = renderTestsTab(csrfToken, flash)
    } else {
      body = renderTemplatesTab(searchQuery, filterCat, filterAud)
    }

    const content = `
      ${emailCss()}

      <div class="page-header">
        <h1>Email Center</h1>
        <div class="action-group">
          <a href="/god-admin/email?tab=tests" class="btn btn-primary btn-sm">Send test</a>
        </div>
      </div>

      ${tabBar(tab)}
      ${body}
    `

    res.send(godLayout({
      title: 'Email Center',
      userEmail: user.email,
      activePath: '/god-admin/email',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Email page error:', err)
    res.status(500).send(godLayout({
      title: 'Email Center',
      userEmail: user.email,
      activePath: '/god-admin/email',
      content: `<div class="card"><p style="color:var(--red)">Error loading email center: ${esc(String(err))}</p></div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/email/send-test
// ---------------------------------------------------------------------------

export async function postSendTestEmail(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const valid = await csrfStore.verify(req)
  if (!valid) {
    writeFlashCookie(res, { err: 'CSRF check failed. Reload the page and try again.' })
    res.redirect('/god-admin/email?tab=tests')
    return
  }

  const templateKey = String(req.body?.templateKey ?? '').trim()
  const to = String(req.body?.to ?? '').trim()
  const variablesRaw = String(req.body?.variables ?? '').trim()

  if (!templateKey || !to) {
    writeFlashCookie(res, { err: 'Template and recipient are both required.' })
    res.redirect('/god-admin/email?tab=tests')
    return
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    writeFlashCookie(res, { err: `"${to}" doesn't look like a valid email address.` })
    res.redirect('/god-admin/email?tab=tests')
    return
  }

  // Parse optional JSON variables blob — empty is fine.
  let variables: Record<string, unknown> = {}
  if (variablesRaw) {
    try {
      const parsed = JSON.parse(variablesRaw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        variables = parsed as Record<string, unknown>
      } else {
        writeFlashCookie(res, { err: 'Variables must be a JSON object, e.g. { "name": "Thai" }.' })
        res.redirect('/god-admin/email?tab=tests')
        return
      }
    } catch (err) {
      writeFlashCookie(res, { err: `Invalid JSON in variables: ${String(err)}` })
      res.redirect('/god-admin/email?tab=tests')
      return
    }
  }

  // Catalog sanity check — fail fast before hitting the transport.
  if (!getTemplate(templateKey)) {
    writeFlashCookie(res, { err: `Unknown template key: ${templateKey}` })
    res.redirect('/god-admin/email?tab=tests')
    return
  }

  // Prefill scaffold-friendly defaults so pending templates look OK.
  const spec = EMAIL_TEMPLATE_CATALOG[templateKey]
  if (spec && !spec.implemented) {
    if (!('heading' in variables)) variables.heading = `Test: ${spec.key}`
    if (!('body_html' in variables)) {
      variables.body_html = `<p>This is a god-admin test of the <code>${esc(spec.key)}</code> template. It hit <code>sendTemplatedEmail()</code> with <code>shopId=null</code>.</p>`
    }
    if (!('body_text' in variables)) {
      variables.body_text = `This is a god-admin test of the ${spec.key} template.`
    }
    if (!('shop_name' in variables)) variables.shop_name = 'Gbox Test'
  }

  try {
    const result = await sendTemplatedEmail(db as any, {
      templateKey,
      to,
      shopId: null, // platform scope — bypasses Iron Rule 5 for god_admin templates
      variables,
    })

    if (result.ok) {
      const msg = `Sent (delivery_id=${result.deliveryId}, provider=${result.provider}, messageId=${result.messageId ?? '—'}). Check your inbox.`
      writeFlashCookie(res, { ok: msg })
    } else {
      const msg = `Send returned ok=false — reason=${result.reason}${result.error ? ` · ${result.error}` : ''} (delivery_id=${result.deliveryId ?? '—'})`
      writeFlashCookie(res, { err: msg })
    }
  } catch (err) {
    console.error('[God Admin] send-test error:', err)
    writeFlashCookie(res, { err: `Thrown: ${String(err)}` })
  }

  res.redirect('/god-admin/email?tab=tests')
}
