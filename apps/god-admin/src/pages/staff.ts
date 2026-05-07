/**
 * God Admin — Staff Management (Platform Staff across ALL stores)
 *
 * GET  /god-admin/staff          — List all staff (users with store roles)
 * GET  /god-admin/staff/:id      — Staff member detail
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'

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

function shortDate(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fullDate(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function roleBadge(role: string | null): string {
  const r = role || 'unknown'
  const map: Record<string, string> = {
    owner: 'badge-blue',
    admin: 'badge-yellow',
    editor: 'badge-green',
    viewer: 'badge-gray',
  }
  return `<span class="badge ${map[r] || 'badge-gray'}">${esc(r)}</span>`
}

function statusBadge(status: string | null): string {
  const s = status || 'unknown'
  const map: Record<string, string> = {
    active: 'badge-green',
    disabled: 'badge-red',
    suspended: 'badge-red',
  }
  return `<span class="badge ${map[s] || 'badge-gray'}">${esc(s)}</span>`
}

// ---------------------------------------------------------------------------
// GET /god-admin/staff — Staff listing page
// ---------------------------------------------------------------------------

export async function getStaff(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user
  const search = (req.query.search as string || '').trim()
  const roleFilter = (req.query.role as string || '').trim()
  const storeFilter = (req.query.store as string || '').trim()
  const page = Math.max(1, parseInt(req.query.page as string || '1', 10))
  const perPage = 50
  const offset = (page - 1) * perPage

  try {
    // Parallel: summary stats + store list for filter dropdown + staff list
    const [
      totalStaffRow,
      activeStaffRow,
      storesWithStaffRow,
      avgStaffRow,
      allStores,
      staffRows,
      countRow,
    ] = await Promise.all([
      // Total staff members (distinct users who have at least one user_shops entry)
      db.selectFrom('user_shops')
        .select(sql<string>`count(distinct user_id)`.as('cnt'))
        .executeTakeFirst(),

      // Active staff
      db.selectFrom('user_shops as us')
        .innerJoin('users as u', 'u.id', 'us.user_id')
        .where('u.status', '=', 'active')
        .select(sql<string>`count(distinct us.user_id)`.as('cnt'))
        .executeTakeFirst(),

      // Stores with staff
      db.selectFrom('user_shops')
        .select(sql<string>`count(distinct shop_id)`.as('cnt'))
        .executeTakeFirst(),

      // Average staff per store
      db.selectFrom(
        db.selectFrom('user_shops')
          .groupBy('shop_id')
          .select([sql<string>`count(*)`.as('staff_count')])
          .as('per_store')
      )
        .select(sql<string>`coalesce(round(avg(cast(staff_count as numeric)), 1), 0)`.as('avg'))
        .executeTakeFirst(),

      // All stores for filter dropdown
      db.selectFrom('shops')
        .select(['id', 'name'])
        .orderBy('name', 'asc')
        .execute(),

      // Staff listing query (joined)
      (() => {
        let q = db.selectFrom('user_shops as us')
          .innerJoin('users as u', 'u.id', 'us.user_id')
          .innerJoin('shops as s', 's.id', 'us.shop_id')
          .leftJoin(
            db.selectFrom('sessions')
              .where('expires_at', '>', new Date().toISOString())
              .groupBy('user_id')
              .select(['user_id', sql<string>`max(created_at)`.as('last_login')])
              .as('sl'),
            'sl.user_id', 'u.id',
          )
          .select([
            'u.id as user_id',
            'u.name',
            'u.email',
            'u.status',
            'us.role as store_role',
            's.id as shop_id',
            's.name as shop_name',
            'sl.last_login',
          ])

        if (search) {
          q = q.where((eb) =>
            eb.or([
              eb('u.email', 'ilike', `%${search}%`),
              eb('u.name', 'ilike', `%${search}%`),
            ])
          )
        }

        if (roleFilter) {
          q = q.where('us.role', '=', roleFilter)
        }

        if (storeFilter) {
          q = q.where('us.shop_id', '=', storeFilter)
        }

        return q.orderBy('u.name', 'asc').orderBy('s.name', 'asc').limit(perPage).offset(offset).execute()
      })(),

      // Count for pagination
      (() => {
        let q = db.selectFrom('user_shops as us')
          .innerJoin('users as u', 'u.id', 'us.user_id')
          .innerJoin('shops as s', 's.id', 'us.shop_id')
          .select(sql<string>`count(*)`.as('cnt'))

        if (search) {
          q = q.where((eb) =>
            eb.or([
              eb('u.email', 'ilike', `%${search}%`),
              eb('u.name', 'ilike', `%${search}%`),
            ])
          )
        }

        if (roleFilter) {
          q = q.where('us.role', '=', roleFilter)
        }

        if (storeFilter) {
          q = q.where('us.shop_id', '=', storeFilter)
        }

        return q.executeTakeFirst()
      })(),
    ])

    const totalStaff = Number(totalStaffRow?.cnt || 0)
    const activeStaff = Number(activeStaffRow?.cnt || 0)
    const storesWithStaff = Number(storesWithStaffRow?.cnt || 0)
    const avgStaff = (avgStaffRow as any)?.avg ?? '0'
    const totalCount = Number(countRow?.cnt || 0)
    const totalPages = Math.ceil(totalCount / perPage) || 1

    // Build store filter options
    const storeOptions = allStores.map(s =>
      `<option value="${esc(s.id)}"${storeFilter === s.id ? ' selected' : ''}>${esc(s.name)}</option>`
    ).join('')

    // Build table rows
    const tableRows = staffRows.length > 0
      ? staffRows.map(r => `
        <tr>
          <td>${esc(r.name) || '-'}</td>
          <td>${esc(r.email)}</td>
          <td>${roleBadge(r.store_role)}</td>
          <td><a href="/god-admin/stores/${r.shop_id}">${esc(r.shop_name)}</a></td>
          <td>${shortDate(r.last_login)}</td>
          <td>${statusBadge(r.status)}</td>
          <td><a href="/god-admin/staff/${r.user_id}" class="btn btn-primary btn-sm">View</a></td>
        </tr>`).join('')
      : '<tr><td colspan="7" style="text-align:center;color:var(--gray-400);padding:24px">No staff members found</td></tr>'

    // Pagination
    const paginationHtml = totalPages > 1
      ? `<div style="display:flex;justify-content:center;align-items:center;gap:12px;padding:16px 0">
          ${page > 1 ? `<a href="/god-admin/staff?page=${page - 1}&search=${encodeURIComponent(search)}&role=${encodeURIComponent(roleFilter)}&store=${encodeURIComponent(storeFilter)}" class="btn btn-secondary btn-sm">Previous</a>` : ''}
          <span style="color:var(--god-text-secondary);font-size:13px">Page ${page} of ${totalPages} (${fmtNum(totalCount)} results)</span>
          ${page < totalPages ? `<a href="/god-admin/staff?page=${page + 1}&search=${encodeURIComponent(search)}&role=${encodeURIComponent(roleFilter)}&store=${encodeURIComponent(storeFilter)}" class="btn btn-secondary btn-sm">Next</a>` : ''}
        </div>`
      : ''

    const content = `
      <div class="page-header">
        <h1>Platform Staff</h1>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Total Staff Members</div>
          <div class="stat-value">${fmtNum(totalStaff)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Active Staff</div>
          <div class="stat-value">${fmtNum(activeStaff)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Stores with Staff</div>
          <div class="stat-value">${fmtNum(storesWithStaff)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Avg Staff per Store</div>
          <div class="stat-value">${esc(String(avgStaff))}</div>
        </div>
      </div>

      <div class="card">
        <form method="get" action="/god-admin/staff" class="toolbar">
          <input type="text" name="search" class="search-input" placeholder="Search by email or name..." value="${esc(search)}">
          <select name="role" class="filter-select">
            <option value="">All Roles</option>
            <option value="owner"${roleFilter === 'owner' ? ' selected' : ''}>Owner</option>
            <option value="admin"${roleFilter === 'admin' ? ' selected' : ''}>Admin</option>
            <option value="editor"${roleFilter === 'editor' ? ' selected' : ''}>Editor</option>
            <option value="viewer"${roleFilter === 'viewer' ? ' selected' : ''}>Viewer</option>
          </select>
          <select name="store" class="filter-select">
            <option value="">All Stores</option>
            ${storeOptions}
          </select>
          <button type="submit" class="btn btn-primary btn-sm">Filter</button>
        </form>

        <table class="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Store</th>
              <th>Last Login</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>

        ${paginationHtml}
      </div>`

    res.send(godLayout({
      title: 'Platform Staff',
      userEmail: req.godAdmin!.user.email,
      userName: req.godAdmin!.user.name,
      isDefaultAdmin: req.godAdmin?.isDefaultAdmin,
      activePath: '/god-admin/staff',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Staff list error:', err)
    res.status(500).send(godLayout({
      title: 'Platform Staff',
      userEmail: req.godAdmin!.user.email,
      userName: req.godAdmin!.user.name,
      isDefaultAdmin: req.godAdmin?.isDefaultAdmin,
      activePath: '/god-admin/staff',
      content: `<div class="card"><p style="color:var(--red)">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/staff/:id — Staff member detail
// ---------------------------------------------------------------------------

export async function getStaffDetail(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const userId = req.params.id

  try {
    // Fetch user
    const target = await db.selectFrom('users')
      .where('id', '=', userId)
      .select(['id', 'name', 'email', 'role', 'status', 'created_at', 'updated_at'])
      .executeTakeFirst()

    if (!target) {
      res.status(404).send(godLayout({
        title: 'Staff Not Found',
        userEmail: req.godAdmin!.user.email,
        userName: req.godAdmin!.user.name,
        isDefaultAdmin: req.godAdmin?.isDefaultAdmin,
        activePath: '/god-admin/staff',
        content: `<div class="card"><p style="color:var(--red)">Staff member not found.</p><a href="/god-admin/staff" class="btn btn-secondary btn-sm" style="margin-top:12px">&larr; Back to Staff</a></div>`,
      }))
      return
    }

    // Parallel: stores, audit logs, active sessions count
    const [shops, auditLogs, sessionCountRow] = await Promise.all([
      // All stores this user has access to
      db.selectFrom('user_shops as us')
        .innerJoin('shops as s', 's.id', 'us.shop_id')
        .where('us.user_id', '=', userId)
        .select(['s.id as shop_id', 's.name', 's.slug', 's.status', 'us.role'])
        .orderBy('s.name', 'asc')
        .execute(),

      // Recent activity (last 10 audit_logs)
      db.selectFrom('audit_logs')
        .where('user_id', '=', userId)
        .select(['id', 'action', 'resource_type', 'details', 'created_at'])
        .orderBy('created_at', 'desc')
        .limit(10)
        .execute(),

      // Active sessions count
      db.selectFrom('sessions')
        .where('user_id', '=', userId)
        .where('expires_at', '>', new Date().toISOString())
        .select(sql<string>`count(*)`.as('cnt'))
        .executeTakeFirst(),
    ])

    const activeSessions = Number(sessionCountRow?.cnt || 0)

    // Store access table
    const shopsRows = shops.length > 0
      ? shops.map(s => `
        <tr>
          <td><a href="/god-admin/stores/${s.shop_id}">${esc(s.name)}</a></td>
          <td class="mono">${esc(s.slug)}</td>
          <td>${roleBadge(s.role)}</td>
          <td>${statusBadge(s.status)}</td>
        </tr>`).join('')
      : '<tr><td colspan="4" style="text-align:center;color:var(--gray-400);padding:16px">No store access</td></tr>'

    // Audit log table
    const auditRows = auditLogs.length > 0
      ? auditLogs.map(a => `
        <tr>
          <td>${esc(a.action)}</td>
          <td>${esc(a.resource_type) || '-'}</td>
          <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(a.details)}">${esc(a.details) || '-'}</td>
          <td>${fullDate(a.created_at)}</td>
        </tr>`).join('')
      : '<tr><td colspan="4" style="text-align:center;color:var(--gray-400);padding:16px">No recent activity</td></tr>'

    const content = `
      <div class="page-header">
        <h1>${esc(target.name) || esc(target.email)}</h1>
        <div class="action-group">
          <a href="/god-admin/users/${target.id}" class="btn btn-primary btn-sm">View in Users</a>
          <a href="/god-admin/staff" class="btn btn-secondary btn-sm">&larr; Back to Staff</a>
        </div>
      </div>

      <div class="two-col">
        <div class="card">
          <div class="card-title" style="margin-bottom:12px">User Info</div>
          <div class="info-row"><span class="info-label">ID</span><span class="info-value mono">${esc(target.id)}</span></div>
          <div class="info-row"><span class="info-label">Name</span><span class="info-value">${esc(target.name) || '-'}</span></div>
          <div class="info-row"><span class="info-label">Email</span><span class="info-value">${esc(target.email)}</span></div>
          <div class="info-row"><span class="info-label">Role</span><span class="info-value">${roleBadge(target.role)}</span></div>
          <div class="info-row"><span class="info-label">Status</span><span class="info-value">${statusBadge(target.status)}</span></div>
          <div class="info-row"><span class="info-label">Active Sessions</span><span class="info-value">${fmtNum(activeSessions)}</span></div>
          <div class="info-row"><span class="info-label">Created</span><span class="info-value">${fullDate(target.created_at)}</span></div>
          <div class="info-row"><span class="info-label">Updated</span><span class="info-value">${fullDate(target.updated_at)}</span></div>
        </div>

        <div class="card">
          <div class="card-title" style="margin-bottom:12px">Store Access (${shops.length})</div>
          <table class="data-table">
            <thead><tr><th>Store</th><th>Slug</th><th>Role</th><th>Status</th></tr></thead>
            <tbody>${shopsRows}</tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom:12px">Recent Activity</div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Action</th>
              <th>Resource Type</th>
              <th>Details</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>${auditRows}</tbody>
        </table>
      </div>`

    res.send(godLayout({
      title: `Staff: ${target.name || target.email}`,
      userEmail: req.godAdmin!.user.email,
      userName: req.godAdmin!.user.name,
      isDefaultAdmin: req.godAdmin?.isDefaultAdmin,
      activePath: '/god-admin/staff',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Staff detail error:', err)
    res.status(500).send(godLayout({
      title: 'Staff Detail',
      userEmail: req.godAdmin!.user.email,
      userName: req.godAdmin!.user.name,
      isDefaultAdmin: req.godAdmin?.isDefaultAdmin,
      activePath: '/god-admin/staff',
      content: `<div class="card"><p style="color:var(--red)">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}
