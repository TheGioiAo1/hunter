/**
 * God Admin — Activity Feed Page (Category A5: Activity Feed)
 *
 * GET /god-admin/activity
 *
 * Displays:
 * - audit_logs LEFT JOIN users, ordered by created_at DESC
 * - Filters: action type, user, date range
 * - Pagination: 50 per page
 * - Timeline display with color-coded action badges
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string | null | undefined): string {
  if (!s) return ''
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function actionBadgeClass(action: string): string {
  const green = ['create', 'login', 'enable', 'activate', 'register', 'signup', 'approve', 'verify']
  const red = ['fail', 'delete', 'suspend', 'disable', 'ban', 'reject', 'revoke', 'login_failed']
  const yellow = ['update', 'edit', 'modify', 'change', 'reset', 'patch']

  const lower = (action || '').toLowerCase()
  if (red.some(k => lower.includes(k))) return 'badge-red'
  if (green.some(k => lower.includes(k))) return 'badge-green'
  if (yellow.some(k => lower.includes(k))) return 'badge-yellow'
  return 'badge-blue'
}

function timelineDotColor(action: string): string {
  const lower = (action || '').toLowerCase()
  const red = ['fail', 'delete', 'suspend', 'disable', 'ban', 'reject', 'revoke', 'login_failed']
  const green = ['create', 'login', 'enable', 'activate', 'register', 'signup', 'approve', 'verify']
  const yellow = ['update', 'edit', 'modify', 'change', 'reset', 'patch']

  if (red.some(k => lower.includes(k))) return 'var(--red)'
  if (green.some(k => lower.includes(k))) return 'var(--green)'
  if (yellow.some(k => lower.includes(k))) return 'var(--yellow)'
  return 'var(--blue)'
}

const PAGE_SIZE = 50

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------

export async function getActivity(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user

  // Parse query params
  const page = Math.max(1, parseInt(String(req.query.page)) || 1)
  const filterAction = String(req.query.action || '').trim()
  const filterUser = String(req.query.user || '').trim()
  const filterFrom = String(req.query.from || '').trim()
  const filterTo = String(req.query.to || '').trim()
  const offset = (page - 1) * PAGE_SIZE

  try {
    // Build WHERE conditions dynamically
    const conditions: string[] = []
    const params: unknown[] = []

    if (filterAction) {
      conditions.push(`al.action = $${params.length + 1}`)
      params.push(filterAction)
    }
    if (filterUser) {
      conditions.push(`u.email ILIKE $${params.length + 1}`)
      params.push(`%${filterUser}%`)
    }
    if (filterFrom) {
      conditions.push(`al.created_at >= $${params.length + 1}`)
      params.push(filterFrom)
    }
    if (filterTo) {
      conditions.push(`al.created_at <= $${params.length + 1}`)
      params.push(filterTo + 'T23:59:59.999Z')
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''

    // Count total matching rows
    const countResult = await sql<{ count: string }>`
      SELECT count(*) as count
      FROM audit_logs al
      LEFT JOIN users u ON u.id = al.user_id
      ${sql.raw(whereClause)}
    `.execute(db)

    const totalRows = Number(countResult.rows[0]?.count ?? 0)
    const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE))

    // Fetch paginated results
    const logsResult = await sql<{
      id: string
      action: string
      resource_type: string
      resource_id: string
      ip_address: string
      details: string
      created_at: string
      user_email: string
    }>`
      SELECT al.id, al.action, al.resource_type, al.resource_id,
             al.ip_address, al.details::text, al.created_at,
             coalesce(u.email, 'system') as user_email
      FROM audit_logs al
      LEFT JOIN users u ON u.id = al.user_id
      ${sql.raw(whereClause)}
      ORDER BY al.created_at DESC
      LIMIT ${sql.raw(String(PAGE_SIZE))} OFFSET ${sql.raw(String(offset))}
    `.execute(db)

    const logs = logsResult.rows

    // Get distinct actions for the filter dropdown
    const actionsResult = await sql<{ action: string }>`
      SELECT DISTINCT action FROM audit_logs ORDER BY action ASC
    `.execute(db)
    const distinctActions = actionsResult.rows.map(r => r.action)

    // Get distinct user emails for the filter dropdown
    const usersResult = await sql<{ email: string }>`
      SELECT DISTINCT u.email
      FROM audit_logs al
      INNER JOIN users u ON u.id = al.user_id
      ORDER BY u.email ASC
      LIMIT 100
    `.execute(db)
    const distinctUsers = usersResult.rows.map(r => r.email)

    // Build action options
    const actionOptions = distinctActions.map(a =>
      `<option value="${esc(a)}" ${filterAction === a ? 'selected' : ''}>${esc(a)}</option>`
    ).join('')

    // Build user options
    const userOptions = distinctUsers.map(u =>
      `<option value="${esc(u)}" ${filterUser === u ? 'selected' : ''}>${esc(u)}</option>`
    ).join('')

    // Build timeline items
    const timelineHtml = logs.length > 0
      ? logs.map(log => `
          <div class="timeline-item">
            <div class="timeline-dot" style="background:${timelineDotColor(log.action)}"></div>
            <div class="timeline-content">
              <div class="timeline-header">
                <span class="badge ${actionBadgeClass(log.action)}">${esc(log.action)}</span>
                <span class="timeline-user">${esc(log.user_email)}</span>
                <span class="timeline-resource mono">${esc(log.resource_type)}${log.resource_id ? ':' + esc(log.resource_id) : ''}</span>
              </div>
              <div class="timeline-meta">
                <span class="mono">${esc(log.ip_address)}</span>
                <span class="timeline-time">${fmtDateTime(log.created_at)}</span>
              </div>
            </div>
          </div>`).join('')
      : `<div class="empty-state">
           <div class="empty-state-text">No activity logs found matching your filters.</div>
         </div>`

    // Pagination controls
    const buildUrl = (p: number) => {
      const params = new URLSearchParams()
      params.set('page', String(p))
      if (filterAction) params.set('action', filterAction)
      if (filterUser) params.set('user', filterUser)
      if (filterFrom) params.set('from', filterFrom)
      if (filterTo) params.set('to', filterTo)
      return `/god-admin/activity?${params.toString()}`
    }

    let paginationHtml = ''
    if (totalPages > 1) {
      const pages: string[] = []
      if (page > 1) {
        pages.push(`<a href="${buildUrl(page - 1)}" class="btn btn-secondary btn-sm">Prev</a>`)
      }
      // Show page numbers: first, current-1, current, current+1, last
      const pageSet = new Set<number>()
      pageSet.add(1)
      if (page > 1) pageSet.add(page - 1)
      pageSet.add(page)
      if (page < totalPages) pageSet.add(page + 1)
      pageSet.add(totalPages)

      const sortedPages = Array.from(pageSet).sort((a, b) => a - b)
      let prev = 0
      for (const p of sortedPages) {
        if (prev && p - prev > 1) {
          pages.push('<span class="pagination-ellipsis">...</span>')
        }
        if (p === page) {
          pages.push(`<span class="btn btn-primary btn-sm">${p}</span>`)
        } else {
          pages.push(`<a href="${buildUrl(p)}" class="btn btn-secondary btn-sm">${p}</a>`)
        }
        prev = p
      }

      if (page < totalPages) {
        pages.push(`<a href="${buildUrl(page + 1)}" class="btn btn-secondary btn-sm">Next</a>`)
      }
      paginationHtml = `
        <div class="pagination">
          <span class="pagination-info">Page ${page} of ${totalPages} (${totalRows} total)</span>
          <div class="pagination-buttons">${pages.join('')}</div>
        </div>`
    } else if (totalRows > 0) {
      paginationHtml = `<div class="pagination"><span class="pagination-info">${totalRows} record(s)</span></div>`
    }

    const content = `
      <style>
        .timeline-item {
          display: flex; gap: 14px; padding: 14px 0;
          border-bottom: 1px solid var(--god-border);
          position: relative;
        }
        .timeline-item:last-child { border-bottom: none; }
        .timeline-dot {
          width: 10px; height: 10px; border-radius: 50%;
          flex-shrink: 0; margin-top: 5px;
        }
        .timeline-content { flex: 1; min-width: 0; }
        .timeline-header {
          display: flex; align-items: center; gap: 10px;
          flex-wrap: wrap; margin-bottom: 4px;
        }
        .timeline-user {
          font-size: 13px; font-weight: 600; color: var(--god-accent);
        }
        .timeline-resource {
          font-size: 12px; color: var(--god-text-muted);
        }
        .timeline-meta {
          display: flex; align-items: center; gap: 16px;
          font-size: 12px; color: var(--god-text-muted);
        }
        .timeline-time { color: var(--god-text-dim); }

        .filters-form {
          display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap;
          margin-bottom: 20px;
        }
        .filter-group {
          display: flex; flex-direction: column; gap: 4px;
        }
        .filter-label {
          font-size: 11px; font-weight: 600; color: var(--god-text-muted);
          text-transform: uppercase; letter-spacing: 0.5px;
        }
        .filter-date {
          padding: 8px 12px; border: 1.5px solid var(--god-border-light);
          border-radius: 8px; font-size: 13px; font-family: inherit;
          background: var(--god-bg); color: var(--god-text);
          outline: none;
        }
        .filter-date:focus { border-color: var(--god-accent); }

        .pagination {
          display: flex; align-items: center; justify-content: space-between;
          margin-top: 20px; padding-top: 16px;
          border-top: 1px solid var(--god-border);
          flex-wrap: wrap; gap: 12px;
        }
        .pagination-info { font-size: 13px; color: var(--god-text-muted); }
        .pagination-buttons { display: flex; gap: 6px; align-items: center; }
        .pagination-ellipsis { color: var(--god-text-muted); font-size: 13px; padding: 0 4px; }
      </style>

      <div class="page-header">
        <h1>Activity Feed</h1>
      </div>

      <div class="card">
        <form method="GET" action="/god-admin/activity" class="filters-form">
          <div class="filter-group">
            <label class="filter-label">Action</label>
            <select name="action" class="filter-select">
              <option value="">All Actions</option>
              ${actionOptions}
            </select>
          </div>
          <div class="filter-group">
            <label class="filter-label">User</label>
            <select name="user" class="filter-select">
              <option value="">All Users</option>
              ${userOptions}
            </select>
          </div>
          <div class="filter-group">
            <label class="filter-label">From</label>
            <input type="date" name="from" class="filter-date" value="${esc(filterFrom)}">
          </div>
          <div class="filter-group">
            <label class="filter-label">To</label>
            <input type="date" name="to" class="filter-date" value="${esc(filterTo)}">
          </div>
          <button type="submit" class="btn btn-primary btn-sm" style="align-self:flex-end">Filter</button>
          <a href="/god-admin/activity" class="btn btn-secondary btn-sm" style="align-self:flex-end">Reset</a>
        </form>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">Activity Log</div>
          <span class="badge badge-blue">${totalRows} entries</span>
        </div>
        <div class="timeline-list">
          ${timelineHtml}
        </div>
        ${paginationHtml}
      </div>
    `

    res.send(godLayout({
      title: 'Activity Feed',
      userEmail: user.email,
      activePath: '/god-admin/activity',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Activity error:', err)
    res.status(500).send(godLayout({
      title: 'Activity Feed',
      userEmail: user.email,
      activePath: '/god-admin/activity',
      content: `<div class="card"><p style="color:var(--red)">Error loading activity feed: ${esc(String(err))}</p></div>`,
    }))
  }
}
