/**
 * Store Admin — Activity / Audit Log
 *
 * Paginated viewer for audit_logs with filters: date range, action type, user.
 * Shows: timestamp, user, action, resource type, resource ID, IP, details.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'

export async function getActivityLog(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`

  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1)
  const perPage = 50
  const offset = (page - 1) * perPage
  const search = (req.query.q as string || '').trim()
  const actionFilter = (req.query.action as string || '').trim()
  const dateFrom = (req.query.from as string || '').trim()
  const dateTo = (req.query.to as string || '').trim()

  // Build query with join for user emails
  let baseQuery = db.selectFrom('audit_logs')
    .leftJoin('users', 'users.id', 'audit_logs.user_id')
    .where('audit_logs.shop_id', '=', store.id)

  if (search) {
    baseQuery = baseQuery.where((eb) =>
      eb.or([
        eb('audit_logs.action', 'ilike', `%${search}%`),
        eb('users.email', 'ilike', `%${search}%`),
        eb('audit_logs.resource_type', 'ilike', `%${search}%`),
      ])
    )
  }

  if (actionFilter) {
    baseQuery = baseQuery.where('audit_logs.action', '=', actionFilter)
  }

  if (dateFrom) {
    baseQuery = baseQuery.where('audit_logs.created_at', '>=', dateFrom as any)
  }

  if (dateTo) {
    // Add end-of-day
    baseQuery = baseQuery.where('audit_logs.created_at', '<=', `${dateTo}T23:59:59` as any)
  }

  const [logs, totalResult] = await Promise.all([
    baseQuery
      .select([
        'audit_logs.id',
        'users.email as user_email',
        'audit_logs.action',
        'audit_logs.resource_type',
        'audit_logs.resource_id',
        'audit_logs.details',
        'audit_logs.ip_address',
        'audit_logs.created_at',
      ])
      .orderBy('audit_logs.created_at', 'desc')
      .limit(perPage)
      .offset(offset)
      .execute(),

    baseQuery
      .select(db.fn.count('audit_logs.id').as('count'))
      .executeTakeFirst(),
  ])

  // Fetch distinct action types for filter dropdown
  const actionTypes = await db.selectFrom('audit_logs')
    .select('action')
    .where('shop_id', '=', store.id)
    .distinct()
    .orderBy('action', 'asc')
    .execute()

  const totalCount = Number(totalResult?.count ?? 0)
  const totalPages = Math.max(1, Math.ceil(totalCount / perPage))

  // Build query string for pagination
  const qsParams: string[] = []
  if (search) qsParams.push(`q=${encodeURIComponent(search)}`)
  if (actionFilter) qsParams.push(`action=${encodeURIComponent(actionFilter)}`)
  if (dateFrom) qsParams.push(`from=${encodeURIComponent(dateFrom)}`)
  if (dateTo) qsParams.push(`to=${encodeURIComponent(dateTo)}`)
  const qsSuffix = qsParams.length > 0 ? '&' + qsParams.join('&') : ''

  const actionBadgeColor = (action: string): string => {
    switch (action) {
      case 'create': return 'badge-success'
      case 'delete': return 'badge-danger'
      case 'update': return 'badge-warning'
      case 'login': return 'badge-info'
      default: return 'badge-neutral'
    }
  }

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Activity Log</h1>
        <p class="page-subtitle">${totalCount} action${totalCount !== 1 ? 's' : ''} recorded</p>
      </div>
    </div>

    <!-- FILTERS -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-body" style="padding:12px 16px">
        <form method="GET" action="${base}/activity" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <input
            type="text"
            name="q"
            value="${esc(search)}"
            placeholder="Search by action, user, or resource..."
            style="flex:1;min-width:200px;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)"
          >
          <select name="action"
            style="padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)">
            <option value="">All actions</option>
            ${actionTypes.map(a => `<option value="${esc(a.action)}" ${a.action === actionFilter ? 'selected' : ''}>${esc(a.action)}</option>`).join('')}
          </select>
          <input type="date" name="from" value="${esc(dateFrom)}" placeholder="From"
            style="padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)">
          <input type="date" name="to" value="${esc(dateTo)}" placeholder="To"
            style="padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)">
          <button type="submit" class="btn btn-outline btn-sm">Filter</button>
          ${(search || actionFilter || dateFrom || dateTo) ? `<a href="${base}/activity" class="btn btn-outline btn-sm">Clear</a>` : ''}
        </form>
      </div>
    </div>

    <!-- LOGS TABLE -->
    <div class="card">
      <div class="card-header">
        <span>Activity${search ? ' matching "' + esc(search) + '"' : ''}${actionFilter ? ' (' + esc(actionFilter) + ')' : ''}</span>
        <span style="font-size:12px;color:var(--s-text-dim)">${totalCount} entries</span>
      </div>
      <div class="card-body" style="padding:0">
        ${logs.length > 0 ? `
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>User</th>
                  <th>Action</th>
                  <th>Resource</th>
                  <th>IP Address</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                ${logs.map(l => {
                  const ts = new Date(l.created_at as string)
                  const dateStr = ts.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
                  const details = l.details ? (typeof l.details === 'string' ? l.details : JSON.stringify(l.details)).slice(0, 80) : ''
                  return `
                    <tr>
                      <td style="font-size:12px;color:var(--s-text-dim);white-space:nowrap">${dateStr}</td>
                      <td style="font-size:13px">${esc(l.user_email || 'System')}</td>
                      <td>
                        <span class="badge ${actionBadgeColor(l.action)}">${esc(l.action || '')}</span>
                      </td>
                      <td style="font-size:13px;color:var(--s-text-muted)">
                        ${esc(l.resource_type || '')}${l.resource_id ? ` <span style="font-family:monospace;font-size:11px">${esc(String(l.resource_id).slice(0, 8))}...</span>` : ''}
                      </td>
                      <td style="font-size:12px;color:var(--s-text-dim);font-family:monospace">${esc(l.ip_address || 'N/A')}</td>
                      <td style="font-size:12px;color:var(--s-text-dim);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(details)}">${esc(details)}</td>
                    </tr>
                  `
                }).join('')}
              </tbody>
            </table>
          </div>

          ${totalPages > 1 ? `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-top:1px solid var(--s-border);font-size:13px;color:var(--s-text-dim)">
              <span>Page ${page} of ${totalPages}</span>
              <div style="display:flex;gap:4px">
                ${page > 1
                  ? `<a href="${base}/activity?page=${page - 1}${qsSuffix}" class="btn btn-outline btn-sm">&laquo; Previous</a>`
                  : `<span class="btn btn-outline btn-sm" style="opacity:0.4;pointer-events:none">&laquo; Previous</span>`}
                ${page < totalPages
                  ? `<a href="${base}/activity?page=${page + 1}${qsSuffix}" class="btn btn-outline btn-sm">Next &raquo;</a>`
                  : `<span class="btn btn-outline btn-sm" style="opacity:0.4;pointer-events:none">Next &raquo;</span>`}
              </div>
            </div>
          ` : ''}
        ` : `
          <div style="text-align:center;padding:40px;color:var(--s-text-dim)">
            <div style="font-size:32px;margin-bottom:12px">&#128220;</div>
            <div style="font-weight:600;margin-bottom:4px">${search || actionFilter ? 'No matching activity' : 'No activity logged yet'}</div>
            <div style="font-size:13px">${search || actionFilter ? 'Try adjusting your filters.' : 'Actions will appear here as your team uses the store admin.'}</div>
          </div>
        `}
      </div>
    </div>
  `

  res.send(sellerLayout({
    title: 'Activity Log',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'settings',
    content,
    theme: theme as 'dark' | 'light',
  }))
}
