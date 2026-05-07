/**
 * God Admin — Security Dashboard (Category H)
 *
 * GET  /god-admin/security              — Audit logs, login failures, active sessions
 * GET  /god-admin/security/logins       — Login history (H2)
 * GET  /god-admin/security/suspicious   — Suspicious activity (H3)
 * GET  /god-admin/security/tokens       — Token/session management (H4)
 * POST /god-admin/security/tokens/:userId/revoke — Revoke all sessions for user (H4)
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'
// Phase 0 Step 0.4b: CSRF on the revoke-all-sessions form — a single
// POST here can log out every merchant in the platform, so the token
// check is non-negotiable.
import { createCsrfStore } from '../../../../packages/core/src/modules/auth/csrf-express.js'
// Phase 0 §8 Item #6 — CSV export of audit logs. Shares the same
// filter surface as the HTML view so `?action=X&user=Y&export=csv`
// just downloads what the admin is already looking at.
import {
  fetchAuditLogsForExport,
  rowsToCsv,
  buildExportFilename,
} from '../../../../packages/core/src/modules/audit/index.js'
// Phase 2 Admin Polish §2.3 — background export for >10k rows.
import {
  enqueueAuditExport,
  getAuditExportMeta,
  listAuditExportsForUser,
  getAuditExportDir,
  AUDIT_EXPORT_HARD_CAP,
  type AuditExportMeta,
} from '@gbox/core/modules/audit/background-export.js'
import { createReadStream } from 'node:fs'
import { stat as fsStat } from 'node:fs/promises'
import { join as pathJoin } from 'node:path'

// ---------------------------------------------------------------------------
// Module-level CSRF store
// ---------------------------------------------------------------------------

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_god_security' })

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string | null): string {
  if (!s) return ''
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function fmtNum(val: number | string | null): string {
  return Number(val || 0).toLocaleString('en-US')
}

function fullDate(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/**
 * Parse a `YYYY-MM-DD` filter string from the toolbar into an ISO
 * timestamp for the retention/export query. `which='start'` clamps to
 * 00:00:00 UTC (inclusive), `which='end'` clamps to the next day's
 * 00:00:00 UTC (exclusive) so a date-only filter includes all events
 * on the picked day.
 *
 * Returns `undefined` when the input is empty or unparseable so the
 * caller can pass-through to a "no filter" query.
 */
function parseDateBoundary(
  raw: string,
  which: 'start' | 'end',
): string | undefined {
  if (!raw) return undefined
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return undefined
  const [, y, m, d] = match
  const base = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  if (isNaN(base.getTime())) return undefined
  if (which === 'end') {
    base.setUTCDate(base.getUTCDate() + 1)
  }
  return base.toISOString()
}

/**
 * Build the `?...&export=csv` query string that the toolbar's Export
 * CSV link points at. Centralised so we can add new filters in one
 * place without the toolbar and the download path drifting apart.
 */
function buildExportQuery(filters: {
  action: string
  user: string
  from: string
  to: string
}): string {
  const params = new URLSearchParams()
  if (filters.action) params.set('action', filters.action)
  if (filters.user) params.set('user', filters.user)
  if (filters.from) params.set('from', filters.from)
  if (filters.to) params.set('to', filters.to)
  params.set('export', 'csv')
  return params.toString()
}

function actionBadge(action: string): string {
  const lower = action.toLowerCase()
  let cls = 'badge-gray'
  if (lower.includes('login') || lower.includes('create') || lower.includes('enable') || lower.includes('reactivate')) cls = 'badge-green'
  if (lower.includes('fail') || lower.includes('disable') || lower.includes('suspend') || lower.includes('delete')) cls = 'badge-red'
  if (lower.includes('update') || lower.includes('change')) cls = 'badge-yellow'
  return `<span class="badge ${cls}">${esc(action)}</span>`
}

// ---------------------------------------------------------------------------
// GET /god-admin/security
// ---------------------------------------------------------------------------

export async function getSecurity(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user
  const actionFilter = (req.query.action as string || '').trim()
  const userFilter = (req.query.user as string || '').trim()
  const fromFilter = (req.query.from as string || '').trim()
  const toFilter = (req.query.to as string || '').trim()

  // ─── Phase 0 §8 Item #6 — CSV export short-circuit ───────────────
  //
  // The god admin security page exposes action / user / date-window
  // filters. When `?export=csv` is present we reuse the same filters
  // to pull up to 10k rows and stream them back as a download. The
  // HTML render below is completely skipped on this path so the
  // response is a clean `text/csv` with the correct Content-Disposition.
  //
  // We cap at 10k rows in `fetchAuditLogsForExport` — larger exports
  // should go through a background job (Phase 2 Admin Polish). 10k
  // rows is ~1.5 MB of CSV which every browser handles comfortably.
  if (req.query.export === 'csv') {
    try {
      const rows = await fetchAuditLogsForExport(db, {
        action: actionFilter || undefined,
        userEmail: userFilter || undefined,
        fromIso: parseDateBoundary(fromFilter, 'start'),
        toIso: parseDateBoundary(toFilter, 'end'),
        limit: 10_000,
      })
      const csv = rowsToCsv(rows)
      const filename = buildExportFilename('security')
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`,
      )
      // Audit-trail-of-the-audit-trail: a god admin pulling every row
      // in the platform deserves to leave a fingerprint. Fire-and-
      // forget so the download never blocks on an audit-write hiccup.
      db.insertInto('audit_logs')
        .values({
          user_id: user.id,
          shop_id: null,
          action: 'audit_log_exported',
          resource_type: 'security',
          resource_id: null,
          details: JSON.stringify({
            filters: {
              action: actionFilter || null,
              user: userFilter || null,
              from: fromFilter || null,
              to: toFilter || null,
            },
            rows: rows.length,
          }),
          ip_address: req.ip ?? null,
        })
        .execute()
        .catch((err) =>
          console.error('[God Admin] audit_log_exported write failed:', err),
        )

      res.send(csv)
      return
    } catch (err) {
      console.error('[God Admin] Security CSV export error:', err)
      res.status(500).send(`CSV export failed: ${String(err)}`)
      return
    }
  }

  const now = new Date()
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()

  // Issue a CSRF token for the "Queue large export" form (Phase 2.3)
  // and the adjacent revoke-sessions form further down the page.
  const csrfToken = await csrfStore.issue(res, isProduction())
  const csrfFormField = csrfStore.hiddenField(csrfToken)

  try {
    // Phase 2.3 — load this admin's recent background exports (queued,
    // running, done, failed). Rendered beneath the audit-log card.
    const pendingExports = await listAuditExportsForUser(user.id, 10).catch((err) => {
      console.error('[God Admin] listAuditExportsForUser failed:', err)
      return [] as AuditExportMeta[]
    })

    const [auditLogs, loginFailures, activeSessions, sessionsByUser] = await Promise.all([
      // Audit logs with filters. Mirrors the filter surface on the CSV
      // export path above so `?action=X&user=Y&from=...&to=...` and
      // `?...&export=csv` always disagree only on row count.
      (() => {
        let q = db.selectFrom('audit_logs as a')
          .leftJoin('users as u', 'u.id', 'a.user_id')
          .select([
            'a.id', 'a.action', 'a.resource_type', 'a.resource_id',
            'a.ip_address', 'a.created_at',
            'u.email as user_email',
          ])
          .orderBy('a.created_at', 'desc')
          .limit(50)

        if (actionFilter) {
          q = q.where('a.action', 'ilike', `%${actionFilter}%`)
        }
        if (userFilter) {
          q = q.where('u.email', 'ilike', `%${userFilter}%`)
        }
        const fromIso = parseDateBoundary(fromFilter, 'start')
        if (fromIso) {
          q = q.where('a.created_at', '>=', fromIso)
        }
        const toIso = parseDateBoundary(toFilter, 'end')
        if (toIso) {
          q = q.where('a.created_at', '<', toIso)
        }

        return q.execute()
      })(),

      // Login failures (last 24h) - check audit logs for login.failed
      db.selectFrom('audit_logs')
        .where('action', 'ilike', '%fail%')
        .where('created_at', '>=', dayAgo)
        .select(sql<string>`count(*)`.as('count'))
        .executeTakeFirst(),

      // Active sessions count
      db.selectFrom('sessions')
        .where('expires_at', '>', now.toISOString())
        .select(sql<string>`count(*)`.as('count'))
        .executeTakeFirst(),

      // Sessions grouped by user (top 10)
      db.selectFrom('sessions as s')
        .innerJoin('users as u', 'u.id', 's.user_id')
        .where('s.expires_at', '>', now.toISOString())
        .groupBy(['u.id', 'u.email'])
        .select(['u.email', sql<string>`count(s.id)`.as('session_count')])
        .orderBy(sql`count(s.id)`, 'desc')
        .limit(10)
        .execute(),
    ])

    // Stats
    const statsHtml = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Active Sessions</div>
          <div class="stat-value">${fmtNum(activeSessions?.count ?? 0)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Login Failures (24h)</div>
          <div class="stat-value" style="color:var(--red)">${fmtNum(loginFailures?.count ?? 0)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Audit Entries Shown</div>
          <div class="stat-value">${auditLogs.length}</div>
        </div>
      </div>`

    // Sessions by user
    const sessionRows = sessionsByUser.length > 0
      ? sessionsByUser.map(s => `
        <tr>
          <td>${esc(s.email)}</td>
          <td><strong>${s.session_count}</strong></td>
        </tr>`).join('')
      : '<tr><td colspan="2" style="text-align:center;color:var(--gray-400);padding:16px">No active sessions</td></tr>'

    const sessionsHtml = `
      <div class="card">
        <div class="card-title" style="margin-bottom:12px">Sessions by User (Top 10)</div>
        <table class="data-table">
          <thead><tr><th>User</th><th>Sessions</th></tr></thead>
          <tbody>${sessionRows}</tbody>
        </table>
      </div>`

    // Audit log table
    const logRows = auditLogs.length > 0
      ? auditLogs.map(a => `
        <tr>
          <td>${fullDate(a.created_at)}</td>
          <td>${actionBadge(a.action)}</td>
          <td>${esc(a.user_email) || '<em style="color:var(--gray-400)">system</em>'}</td>
          <td>${esc(a.resource_type) || '-'}</td>
          <td class="mono" style="font-size:11px">${esc(a.resource_id?.slice(0, 12) ?? '') || '-'}</td>
          <td>${esc(a.ip_address) || '-'}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" style="text-align:center;color:var(--gray-400);padding:24px">No audit log entries</td></tr>'

    const logsHtml = `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Audit Log (Recent 50)</div>
        </div>

        <div class="toolbar" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          <form method="get" action="/god-admin/security" role="search" aria-label="Filter audit log" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0">
            <input type="text" name="action" class="search-input" placeholder="Filter by action..." aria-label="Filter by action" value="${esc(actionFilter)}" style="min-width:160px">
            <input type="text" name="user" class="search-input" placeholder="Filter by user email..." aria-label="Filter by user email" value="${esc(userFilter)}" style="min-width:180px">
            <input type="date" name="from" class="search-input" value="${esc(fromFilter)}" aria-label="From date (UTC)" title="From (UTC)" style="min-width:140px">
            <input type="date" name="to" class="search-input" value="${esc(toFilter)}" aria-label="To date (UTC, inclusive)" title="To (UTC, inclusive)" style="min-width:140px">
            <button type="submit" class="btn btn-primary btn-sm">Filter</button>
            <a class="btn btn-secondary btn-sm" href="/god-admin/security?${buildExportQuery({ action: actionFilter, user: userFilter, from: fromFilter, to: toFilter })}" title="Download up to 10k matching rows as CSV">Export CSV (≤10k)</a>
          </form>
          <form method="post" action="/god-admin/security/audit-export/queue" style="display:inline-flex;margin:0">
            ${csrfFormField}
            <input type="hidden" name="action" value="${esc(actionFilter)}">
            <input type="hidden" name="user" value="${esc(userFilter)}">
            <input type="hidden" name="from" value="${esc(fromFilter)}">
            <input type="hidden" name="to" value="${esc(toFilter)}">
            <button type="submit" class="btn btn-secondary btn-sm" title="Queue a background job to export up to ${AUDIT_EXPORT_HARD_CAP.toLocaleString('en-US')} rows. Status + download link appear below.">Queue large export</button>
          </form>
        </div>

        <table class="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Action</th>
              <th>User</th>
              <th>Resource</th>
              <th>Resource ID</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>${logRows}</tbody>
        </table>
      </div>`

    const subNavHtml = `
      <div class="card" style="margin-bottom:24px">
        <div class="card-title" style="margin-bottom:12px">Security Tools</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <a href="/god-admin/security/logins" class="btn btn-secondary btn-sm">Login History</a>
          <a href="/god-admin/security/suspicious" class="btn btn-secondary btn-sm">Suspicious Activity</a>
          <a href="/god-admin/security/tokens" class="btn btn-secondary btn-sm">Token Management</a>
        </div>
      </div>`

    // -------------------------------------------------------------------
    // Phase 2.3 — background audit exports card
    // -------------------------------------------------------------------
    // Rendered only when this admin has at least one recent export
    // (queued, running, done, or failed) so the page stays clean for
    // the majority of sessions that never touch it.
    const exportStatusBadge = (status: string): string => {
      switch (status) {
        case 'queued':  return '<span class="badge badge-gray">Queued</span>'
        case 'running': return '<span class="badge badge-yellow">Running</span>'
        case 'done':    return '<span class="badge badge-green">Ready</span>'
        case 'failed':  return '<span class="badge badge-red">Failed</span>'
        default:        return `<span class="badge badge-gray">${esc(status)}</span>`
      }
    }
    const formatBytes = (n: number | null): string => {
      if (n == null) return '-'
      if (n < 1024) return `${n} B`
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
      return `${(n / (1024 * 1024)).toFixed(1)} MB`
    }
    const exportRows = pendingExports.length > 0
      ? pendingExports.map((e) => `
        <tr>
          <td>${fullDate(e.created_at)}</td>
          <td>${exportStatusBadge(e.status)}</td>
          <td>${e.row_count != null ? fmtNum(e.row_count) : '-'}</td>
          <td>${formatBytes(e.file_size_bytes)}</td>
          <td style="font-size:11px;color:var(--gray-500)">${esc(JSON.stringify(e.filters))}</td>
          <td>${
            e.status === 'done'
              ? `<a class="btn btn-primary btn-sm" href="/god-admin/security/audit-export/${esc(e.id)}/download">Download</a>`
              : e.status === 'failed'
                ? `<span style="color:var(--red);font-size:11px" title="${esc(e.error || '')}">${esc((e.error || 'error').slice(0, 40))}</span>`
                : '<em style="color:var(--gray-500);font-size:11px">waiting…</em>'
          }</td>
        </tr>`).join('')
      : ''
    const exportsCardHtml = pendingExports.length === 0 ? '' : `
      <div class="card" style="margin-bottom:24px">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div class="card-title">Your recent background exports</div>
          <div style="color:var(--gray-500);font-size:11px">
            Files older than 72h are pruned automatically.
          </div>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Queued</th>
              <th>Status</th>
              <th>Rows</th>
              <th>Size</th>
              <th>Filters</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>${exportRows}</tbody>
        </table>
      </div>`

    const content = `
      <div class="page-header">
        <h1>Security Dashboard</h1>
      </div>
      ${statsHtml}
      ${subNavHtml}
      <div class="two-col">
        <div>${sessionsHtml}</div>
        <div></div>
      </div>
      ${logsHtml}
      ${exportsCardHtml}
    `

    res.send(godLayout({
      title: 'Security',
      userEmail: user.email,
      activePath: '/god-admin/security',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Security error:', err)
    res.status(500).send(godLayout({
      title: 'Security',
      userEmail: user.email,
      activePath: '/god-admin/security',
      content: `<div class="card"><p style="color:var(--red)">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/security/logins — Login History (H2)
// ---------------------------------------------------------------------------

export async function getLoginHistory(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user
  const statusFilter = (req.query.status as string || '').trim()
  const dateFrom = (req.query.from as string || '').trim()
  const dateTo = (req.query.to as string || '').trim()
  const page = Math.max(1, parseInt(req.query.page as string || '1', 10))
  const perPage = 50
  const offset = (page - 1) * perPage

  try {
    let query = db.selectFrom('audit_logs as a')
      .leftJoin('users as u', 'u.id', 'a.user_id')
      .where('a.action', 'in', ['login_success', 'login_failed', 'login_locked'])
      .select([
        'a.id', 'a.action', 'a.ip_address', 'a.created_at', 'a.details',
        'u.email as user_email',
      ])
      .orderBy('a.created_at', 'desc')

    if (statusFilter === 'success') {
      query = query.where('a.action', '=', 'login_success')
    } else if (statusFilter === 'fail') {
      query = query.where('a.action', 'in', ['login_failed', 'login_locked'])
    }

    if (dateFrom) {
      query = query.where('a.created_at', '>=', dateFrom)
    }
    if (dateTo) {
      query = query.where('a.created_at', '<=', dateTo + 'T23:59:59.999Z')
    }

    // Count for pagination
    let countQuery = db.selectFrom('audit_logs as a')
      .where('a.action', 'in', ['login_success', 'login_failed', 'login_locked'])
      .select(sql<string>`count(*)`.as('total'))

    if (statusFilter === 'success') {
      countQuery = countQuery.where('a.action', '=', 'login_success')
    } else if (statusFilter === 'fail') {
      countQuery = countQuery.where('a.action', 'in', ['login_failed', 'login_locked'])
    }
    if (dateFrom) {
      countQuery = countQuery.where('a.created_at', '>=', dateFrom)
    }
    if (dateTo) {
      countQuery = countQuery.where('a.created_at', '<=', dateTo + 'T23:59:59.999Z')
    }

    const [logs, countResult] = await Promise.all([
      query.limit(perPage).offset(offset).execute(),
      countQuery.executeTakeFirst(),
    ])

    const total = Number(countResult?.total ?? 0)
    const totalPages = Math.ceil(total / perPage) || 1

    const tableRows = logs.length > 0
      ? logs.map(l => {
          // Parse details for user_agent and context
          let userAgent = '-'
          let context = '-'
          try {
            const d = typeof l.details === 'string' ? JSON.parse(l.details) : (l.details || {})
            userAgent = d.user_agent || '-'
            context = d.context || (l.user_email ? 'merchant' : '-')
          } catch { /* ignore */ }

          return `
          <tr>
            <td>${fullDate(l.created_at)}</td>
            <td>${esc(l.user_email) || '<em style="color:var(--god-text-muted)">unknown</em>'}</td>
            <td>${esc(l.ip_address) || '-'}</td>
            <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(userAgent)}">${esc(userAgent)}</td>
            <td>${actionBadge(l.action)}</td>
            <td>${esc(context)}</td>
          </tr>`
        }).join('')
      : '<tr><td colspan="6" style="text-align:center;color:var(--god-text-muted);padding:24px">No login events found</td></tr>'

    // Pagination controls
    const paginationHtml = totalPages > 1 ? `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;font-size:13px;color:var(--god-text-secondary)">
        <span>Page ${page} of ${totalPages} (${total} total)</span>
        <div style="display:flex;gap:8px">
          ${page > 1 ? `<a href="/god-admin/security/logins?page=${page - 1}&status=${esc(statusFilter)}&from=${esc(dateFrom)}&to=${esc(dateTo)}" class="btn btn-secondary btn-sm">Prev</a>` : ''}
          ${page < totalPages ? `<a href="/god-admin/security/logins?page=${page + 1}&status=${esc(statusFilter)}&from=${esc(dateFrom)}&to=${esc(dateTo)}" class="btn btn-secondary btn-sm">Next</a>` : ''}
        </div>
      </div>` : ''

    const content = `
      <div class="page-header">
        <h1>Login History</h1>
        <a href="/god-admin/security" class="btn btn-secondary btn-sm">Back to Security</a>
      </div>

      <div class="card">
        <form method="get" action="/god-admin/security/logins" class="toolbar">
          <select name="status" class="filter-select">
            <option value="">All</option>
            <option value="success"${statusFilter === 'success' ? ' selected' : ''}>Success</option>
            <option value="fail"${statusFilter === 'fail' ? ' selected' : ''}>Failed / Locked</option>
          </select>
          <input type="date" name="from" class="search-input" style="min-width:140px" value="${esc(dateFrom)}" placeholder="From">
          <input type="date" name="to" class="search-input" style="min-width:140px" value="${esc(dateTo)}" placeholder="To">
          <button type="submit" class="btn btn-primary btn-sm">Filter</button>
        </form>

        <table class="data-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>User</th>
              <th>IP</th>
              <th>User Agent</th>
              <th>Status</th>
              <th>Context</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
        ${paginationHtml}
      </div>`

    res.send(godLayout({
      title: 'Login History',
      userEmail: user.email,
      activePath: '/god-admin/security',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Login history error:', err)
    res.status(500).send(godLayout({
      title: 'Login History',
      userEmail: user.email,
      activePath: '/god-admin/security',
      content: `<div class="card"><p style="color:var(--red)">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/security/suspicious — Suspicious Activity (H3)
// ---------------------------------------------------------------------------

export async function getSuspicious(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user
  const now = new Date()
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString()

  try {
    // Pattern 1: IPs with >10 failed logins in last hour
    const bruteForceIps = await db.selectFrom('audit_logs')
      .where('action', 'in', ['login_failed', 'login_locked'])
      .where('created_at', '>=', oneHourAgo)
      .groupBy('ip_address')
      .having(sql`count(*)`, '>', 10)
      .select(['ip_address', sql<string>`count(*)`.as('fail_count')])
      .orderBy(sql`count(*)`, 'desc')
      .limit(20)
      .execute()

    // Pattern 2: Users with failed logins from multiple IPs (last hour)
    const multiIpUsers = await db.selectFrom('audit_logs as a')
      .leftJoin('users as u', 'u.id', 'a.user_id')
      .where('a.action', 'in', ['login_failed', 'login_locked'])
      .where('a.created_at', '>=', oneHourAgo)
      .where('a.user_id', 'is not', null)
      .groupBy(['a.user_id', 'u.email'])
      .having(sql`count(distinct a.ip_address)`, '>', 2)
      .select([
        'u.email',
        sql<string>`count(distinct a.ip_address)`.as('ip_count'),
        sql<string>`count(*)`.as('attempt_count'),
      ])
      .orderBy(sql`count(distinct a.ip_address)`, 'desc')
      .limit(20)
      .execute()

    // Pattern 3: Bulk delete operations (>10 deletes in 1 hour)
    const bulkDeletes = await db.selectFrom('audit_logs as a')
      .leftJoin('users as u', 'u.id', 'a.user_id')
      .where('a.action', 'ilike', '%delete%')
      .where('a.created_at', '>=', oneHourAgo)
      .groupBy(['a.user_id', 'u.email'])
      .having(sql`count(*)`, '>', 10)
      .select([
        'u.email',
        sql<string>`count(*)`.as('delete_count'),
      ])
      .orderBy(sql`count(*)`, 'desc')
      .limit(20)
      .execute()

    // Render alert cards
    let alertCardsHtml = ''

    if (bruteForceIps.length === 0 && multiIpUsers.length === 0 && bulkDeletes.length === 0) {
      alertCardsHtml = `
        <div class="card" style="text-align:center;padding:48px">
          <div style="font-size:48px;opacity:0.5;margin-bottom:12px">&#9989;</div>
          <p style="color:var(--god-text-secondary);font-size:15px">No suspicious activity detected in the last hour.</p>
        </div>`
    }

    // Brute force alerts
    for (const ip of bruteForceIps) {
      alertCardsHtml += `
        <div class="card" style="border-left:4px solid var(--red);margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span class="badge badge-red">HIGH SEVERITY</span>
            <span style="font-size:12px;color:var(--god-text-muted)">Brute Force</span>
          </div>
          <p style="color:var(--god-text);font-weight:600;margin-bottom:4px">IP ${esc(ip.ip_address || 'unknown')} — ${ip.fail_count} failed login attempts</p>
          <p style="color:var(--god-text-secondary);font-size:13px">This IP address has exceeded 10 failed login attempts in the last hour.</p>
          <p style="color:var(--god-text-muted);font-size:12px;margin-top:8px">Suggested: Block this IP at firewall level or investigate further.</p>
        </div>`
    }

    // Multi-IP user alerts
    for (const u of multiIpUsers) {
      alertCardsHtml += `
        <div class="card" style="border-left:4px solid var(--yellow);margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span class="badge badge-yellow">MEDIUM SEVERITY</span>
            <span style="font-size:12px;color:var(--god-text-muted)">Credential Stuffing</span>
          </div>
          <p style="color:var(--god-text);font-weight:600;margin-bottom:4px">${esc(u.email || 'unknown')} — ${u.attempt_count} attempts from ${u.ip_count} IPs</p>
          <p style="color:var(--god-text-secondary);font-size:13px">This user has failed login attempts from multiple IP addresses.</p>
          <p style="color:var(--god-text-muted);font-size:12px;margin-top:8px">Suggested: Force password reset and notify the user.</p>
        </div>`
    }

    // Bulk delete alerts
    for (const d of bulkDeletes) {
      alertCardsHtml += `
        <div class="card" style="border-left:4px solid var(--yellow);margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span class="badge badge-yellow">MEDIUM SEVERITY</span>
            <span style="font-size:12px;color:var(--god-text-muted)">Bulk Deletion</span>
          </div>
          <p style="color:var(--god-text);font-weight:600;margin-bottom:4px">${esc(d.email || 'unknown')} — ${d.delete_count} delete operations</p>
          <p style="color:var(--god-text-secondary);font-size:13px">This user performed more than 10 delete operations in the last hour.</p>
          <p style="color:var(--god-text-muted);font-size:12px;margin-top:8px">Suggested: Review deleted resources and verify intent.</p>
        </div>`
    }

    const content = `
      <div class="page-header">
        <h1>Suspicious Activity</h1>
        <a href="/god-admin/security" class="btn btn-secondary btn-sm">Back to Security</a>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Brute Force IPs</div>
          <div class="stat-value" style="color:${bruteForceIps.length > 0 ? 'var(--red)' : 'var(--green)'}">${bruteForceIps.length}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Multi-IP Login Failures</div>
          <div class="stat-value" style="color:${multiIpUsers.length > 0 ? 'var(--yellow)' : 'var(--green)'}">${multiIpUsers.length}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Bulk Delete Users</div>
          <div class="stat-value" style="color:${bulkDeletes.length > 0 ? 'var(--yellow)' : 'var(--green)'}">${bulkDeletes.length}</div>
        </div>
      </div>

      ${alertCardsHtml}`

    res.send(godLayout({
      title: 'Suspicious Activity',
      userEmail: user.email,
      activePath: '/god-admin/security',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Suspicious activity error:', err)
    res.status(500).send(godLayout({
      title: 'Suspicious Activity',
      userEmail: user.email,
      activePath: '/god-admin/security',
      content: `<div class="card"><p style="color:var(--red)">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/security/tokens — Token/Session Management (H4)
// ---------------------------------------------------------------------------

export async function getTokens(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user
  const now = new Date().toISOString()

  // One token shared across all per-user revoke-all forms on the page.
  // Submitting any row burns the token and the subsequent reload
  // re-issues a fresh one.
  const csrfToken = await csrfStore.issue(res, isProduction())
  const csrfField = csrfStore.hiddenField(csrfToken)

  try {
    // Active sessions grouped by user
    const sessionsByUser = await db.selectFrom('sessions as s')
      .innerJoin('users as u', 'u.id', 's.user_id')
      .where('s.expires_at', '>', now)
      .groupBy(['u.id', 'u.email'])
      .select([
        'u.id as user_id',
        'u.email',
        sql<string>`count(s.id)`.as('session_count'),
        sql<string>`max(s.ip_address)`.as('last_ip'),
        sql<string>`max(s.created_at)`.as('last_activity'),
        sql<string>`max(s.expires_at)`.as('latest_expiry'),
      ])
      .orderBy(sql`count(s.id)`, 'desc')
      .limit(100)
      .execute()

    const tableRows = sessionsByUser.length > 0
      ? sessionsByUser.map(s => `
        <tr>
          <td><a href="/god-admin/users/${s.user_id}">${esc(s.email)}</a></td>
          <td><strong>${s.session_count}</strong></td>
          <td>${esc(s.last_ip) || '-'}</td>
          <td>${fullDate(s.last_activity)}</td>
          <td>${fullDate(s.latest_expiry)}</td>
          <td>
            <form method="post" action="/god-admin/security/tokens/${s.user_id}/revoke" style="display:inline">
              ${csrfField}
              <button type="submit" class="btn btn-danger btn-sm" onclick="return confirm('Revoke ALL sessions for ${esc(s.email)}?')">Revoke All</button>
            </form>
          </td>
        </tr>`).join('')
      : '<tr><td colspan="6" style="text-align:center;color:var(--god-text-muted);padding:24px">No active sessions</td></tr>'

    const totalSessions = sessionsByUser.reduce((sum, s) => sum + Number(s.session_count), 0)

    const content = `
      <div class="page-header">
        <h1>Token Management</h1>
        <a href="/god-admin/security" class="btn btn-secondary btn-sm">Back to Security</a>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Total Active Sessions</div>
          <div class="stat-value">${fmtNum(totalSessions)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Users with Sessions</div>
          <div class="stat-value">${sessionsByUser.length}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom:12px">Active Sessions by User</div>
        <table class="data-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Sessions</th>
              <th>Last IP</th>
              <th>Last Activity</th>
              <th>Latest Expiry</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>`

    res.send(godLayout({
      title: 'Token Management',
      userEmail: user.email,
      activePath: '/god-admin/security',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Token management error:', err)
    res.status(500).send(godLayout({
      title: 'Token Management',
      userEmail: user.email,
      activePath: '/god-admin/security',
      content: `<div class="card"><p style="color:var(--red)">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/security/tokens/:userId/revoke — Revoke all sessions (H4)
// ---------------------------------------------------------------------------

export async function postRevokeTokens(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  // CSRF first: silent redirect on fail to avoid leaking which
  // user ids exist.
  if (!(await csrfStore.verify(req))) {
    res.redirect('/god-admin/security/tokens')
    return
  }

  const currentUser = req.godAdmin!.user
  const targetUserId = req.params.userId

  try {
    // Get target email for audit
    const target = await db.selectFrom('users')
      .where('id', '=', targetUserId)
      .select(['email'])
      .executeTakeFirst()

    // Delete all sessions for given user
    const result = await db.deleteFrom('sessions')
      .where('user_id', '=', targetUserId)
      .executeTakeFirst()

    const count = Number(result.numDeletedRows)

    // Audit log
    await db.insertInto('audit_logs').values({
      user_id: currentUser.id,
      action: 'all_sessions_revoked',
      resource_type: 'user',
      resource_id: targetUserId,
      ip_address: req.ip || null,
      details: JSON.stringify({
        target_email: target?.email,
        sessions_revoked: count,
        initiated_by: currentUser.email,
      }),
    }).execute()

    res.redirect('/god-admin/security/tokens')
  } catch (err) {
    console.error('[God Admin] Revoke tokens error:', err)
    res.redirect('/god-admin/security/tokens')
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/security/audit-export/queue — Phase 2.3
// ---------------------------------------------------------------------------
//
// Queues a background audit-log export. Takes the same filter fields
// as the synchronous `?export=csv` short-circuit above, enqueues a
// BullMQ job, and redirects back to /god-admin/security where the
// "Your recent background exports" card now shows the new row in
// `queued` state. The worker flips it to `running` → `done` (or
// `failed`) on its own.
//
// The handler itself is small — all the heavy lifting lives in
// `packages/core/src/modules/audit/background-export.ts`. That makes
// the queue path testable in isolation from the HTTP layer.
export async function postAuditExportQueue(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const user = req.godAdmin!.user

  try {
    if (!(await csrfStore.verify(req))) {
      res.status(403).send('Invalid form submission')
      return
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    const actionFilter = typeof body.action === 'string' ? body.action.trim() : ''
    const userFilter   = typeof body.user   === 'string' ? body.user.trim()   : ''
    const fromFilter   = typeof body.from   === 'string' ? body.from.trim()   : ''
    const toFilter     = typeof body.to     === 'string' ? body.to.trim()     : ''

    const exportId = await enqueueAuditExport({
      actor_user_id: user.id,
      actor_email: user.email ?? null,
      filters: {
        action: actionFilter || undefined,
        userEmail: userFilter || undefined,
        fromIso: parseDateBoundary(fromFilter, 'start'),
        toIso: parseDateBoundary(toFilter, 'end'),
      },
    })

    // Leave a trail in audit_logs so the export itself shows up on
    // the security page in a meta-audit way ("admin X queued export Y").
    db.insertInto('audit_logs')
      .values({
        user_id: user.id,
        shop_id: null,
        action: 'audit_export_queued',
        resource_type: 'audit_export',
        resource_id: exportId,
        details: JSON.stringify({
          filters: {
            action: actionFilter || null,
            user: userFilter || null,
            from: fromFilter || null,
            to: toFilter || null,
          },
          source: 'god-admin',
        }),
        ip_address: req.ip ?? null,
      })
      .execute()
      .catch((err) =>
        console.error('[God Admin] audit_export_queued write failed:', err),
      )

    // Preserve the existing filters in the redirect so the admin
    // lands back on the same filtered view with their new export
    // row visible.
    const qs = new URLSearchParams()
    if (actionFilter) qs.set('action', actionFilter)
    if (userFilter) qs.set('user', userFilter)
    if (fromFilter) qs.set('from', fromFilter)
    if (toFilter) qs.set('to', toFilter)
    const tail = qs.toString()
    res.redirect(`/god-admin/security${tail ? '?' + tail : ''}`)
  } catch (err) {
    console.error('[God Admin] postAuditExportQueue error:', err)
    res.status(500).send(
      godLayout({
        title: 'Security',
        userEmail: user.email,
        activePath: '/god-admin/security',
        content: `<div class="card"><p style="color:var(--red)">Failed to queue export: ${esc(String(err))}</p></div>`,
      }),
    )
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/security/audit-export/:id/download — Phase 2.3
// ---------------------------------------------------------------------------
//
// Streams a finished background-export CSV file back to the admin
// who queued it. Guards:
//
//   - Meta must exist in Redis (expired exports return 404).
//   - Meta.status must be `done`.
//   - Meta.actor_user_id MUST match the caller — one admin cannot
//     download another admin's export.
//   - File path is always `<AUDIT_EXPORT_DIR>/<id>.csv` — no user
//     input ever touches the filesystem join.
export async function getAuditExportDownload(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const user = req.godAdmin!.user
  const id = (req.params as { id?: string }).id ?? ''

  try {
    const meta = await getAuditExportMeta(id)
    if (!meta) {
      res.status(404).send('Export not found or expired')
      return
    }
    if (meta.actor_user_id !== user.id) {
      res.status(403).send('Forbidden')
      return
    }
    if (meta.status !== 'done') {
      res.status(409).send(`Export is ${meta.status}, not ready for download`)
      return
    }

    const filePath = pathJoin(getAuditExportDir(), `${id}.csv`)
    const st = await fsStat(filePath).catch(() => null)
    if (!st || !st.isFile()) {
      res.status(410).send('Export file no longer available (pruned)')
      return
    }

    const filename = buildExportFilename('security-bg')
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Content-Length', String(st.size))

    // Leave a trail of the download itself.
    // Fire-and-forget — a DB hiccup shouldn't block the file transfer.
    db.insertInto('audit_logs')
      .values({
        user_id: user.id,
        shop_id: null,
        action: 'audit_export_downloaded',
        resource_type: 'audit_export',
        resource_id: id,
        details: JSON.stringify({
          row_count: meta.row_count,
          file_size_bytes: meta.file_size_bytes,
        }),
        ip_address: req.ip ?? null,
      })
      .execute()
      .catch((err: unknown) =>
        console.error('[God Admin] audit_export_downloaded write failed:', err),
      )

    const stream = createReadStream(filePath)
    stream.on('error', (err) => {
      console.error('[God Admin] export download stream error:', err)
      if (!res.headersSent) res.status(500).end('Stream error')
      else res.end()
    })
    stream.pipe(res)
  } catch (err) {
    console.error('[God Admin] getAuditExportDownload error:', err)
    res.status(500).send('Download failed')
  }
}
