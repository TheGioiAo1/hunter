/**
 * God Admin — User Management (Category C)
 *
 * GET  /god-admin/users              — List all users
 * GET  /god-admin/users/create       — Create user form
 * POST /god-admin/users              — Create user
 * GET  /god-admin/users/:id          — User detail
 * POST /god-admin/users/:id/disable  — Disable user
 * POST /god-admin/users/:id/enable   — Enable user
 * POST /god-admin/users/:id/reset-pw — Reset user password
 * POST /god-admin/users/:id/impersonate — Impersonate user
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { randomBytes } from 'crypto'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'
import {
  hashPassword,
  validatePasswordStrength,
} from '../../../../packages/core/src/modules/auth/password.js'
import {
  createSession,
  serializeSessionCookie,
  getSessionCookieOptions,
  deleteAllUserSessions,
} from '../../../../packages/core/src/modules/auth/session.js'
// Phase 0 Step 0.4b: CSRF for every user-mutation endpoint. A single
// store is shared across the create form, the detail-page row
// actions (disable/enable/reset-pw/impersonate), and any future
// forms on the same surface — they all submit one at a time so a
// shared cookie is fine.
import { createCsrfStore } from '../../../../packages/core/src/modules/auth/csrf-express.js'

// ---------------------------------------------------------------------------
// Module-level CSRF store
// ---------------------------------------------------------------------------

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_god_users' })

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

function shortDate(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fullDate(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * Generate a random password guaranteed to satisfy `validatePasswordStrength`
 * (≥8 chars + ≥1 uppercase + ≥1 digit).
 *
 * Phase 0 Step 0.6 notes:
 * The original impl just picked `length` chars uniformly from a 68-char
 * alphabet, which had a ~7.9% chance of producing a password with zero
 * digits — enough that auto-reset flows would intermittently fail the
 * shared strength validator. We now force one uppercase and one digit
 * into the output and then shuffle the position so the guarantee holds
 * without leaking predictable structure (the forced chars aren't at
 * fixed indices).
 */
function generateRandomPassword(length = 16): string {
  if (length < 8) length = 8
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const lower = 'abcdefghijklmnopqrstuvwxyz'
  const digit = '0123456789'
  const special = '!@#$%'
  const all = upper + lower + digit + special

  const bytes = randomBytes(length + 2) // extra entropy for the shuffle
  const chars: string[] = []
  // Force one uppercase + one digit
  chars.push(upper[bytes[0] % upper.length])
  chars.push(digit[bytes[1] % digit.length])
  // Fill the rest from the full alphabet
  for (let i = 2; i < length; i++) {
    chars.push(all[bytes[i] % all.length])
  }
  // Fisher-Yates shuffle so the forced chars don't always sit at index 0/1
  for (let i = chars.length - 1; i > 0; i--) {
    const j = bytes[length + (i % 2)] % (i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

function statusBadge(status: string | null): string {
  const s = status || 'unknown'
  const map: Record<string, string> = {
    active: 'badge-green', disabled: 'badge-red', owner: 'badge-blue',
    admin: 'badge-blue', staff: 'badge-yellow', limited: 'badge-gray',
  }
  return `<span class="badge ${map[s] || 'badge-gray'}">${esc(s)}</span>`
}

// ---------------------------------------------------------------------------
// GET /god-admin/users — List all users
// ---------------------------------------------------------------------------

export async function getUsers(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user
  const search = (req.query.search as string || '').trim()
  const roleFilter = (req.query.role as string || '').trim()
  const statusFilter = (req.query.status as string || '').trim()

  try {
    let query = db.selectFrom('users as u')
      .leftJoin(
        db.selectFrom('user_shops').groupBy('user_id').select(['user_id', sql<string>`count(*)`.as('shop_cnt')]).as('us'),
        'us.user_id', 'u.id',
      )
      .leftJoin(
        db.selectFrom('sessions')
          .where('expires_at', '>', new Date().toISOString())
          .groupBy('user_id')
          .select(['user_id', sql<string>`max(created_at)`.as('last_login')])
          .as('sl'),
        'sl.user_id', 'u.id',
      )
      .select([
        'u.id', 'u.email', 'u.name', 'u.role', 'u.status', 'u.created_at',
        sql<string>`coalesce(us.shop_cnt, 0)`.as('shops_count'),
        'sl.last_login',
      ])

    if (search) {
      query = query.where((eb) =>
        eb.or([
          eb('u.email', 'ilike', `%${search}%`),
          eb('u.name', 'ilike', `%${search}%`),
        ])
      )
    }

    if (roleFilter) {
      query = query.where('u.role', '=', roleFilter)
    }

    if (statusFilter) {
      query = query.where('u.status', '=', statusFilter)
    }

    const users = await query.orderBy('u.created_at', 'desc').limit(100).execute()

    const tableRows = users.length > 0
      ? users.map(u => `
        <tr>
          <td><a href="/god-admin/users/${u.id}">${esc(u.email)}</a></td>
          <td>${esc(u.name) || '-'}</td>
          <td>${statusBadge(u.role)}</td>
          <td>${statusBadge(u.status)}</td>
          <td>${u.shops_count}</td>
          <td>${shortDate(u.last_login)}</td>
          <td>${shortDate(u.created_at)}</td>
        </tr>`).join('')
      : '<tr><td colspan="7" style="text-align:center;color:var(--gray-400);padding:24px">No users found</td></tr>'

    const content = `
      <div class="page-header">
        <h1>All Users</h1>
        <a href="/god-admin/users/create" class="btn btn-primary btn-sm">Create User</a>
      </div>

      <div class="card">
        <form method="get" action="/god-admin/users" class="toolbar">
          <input type="text" name="search" class="search-input" placeholder="Search by email or name..." value="${esc(search)}">
          <select name="role" class="filter-select">
            <option value="">All Roles</option>
            <option value="owner"${roleFilter === 'owner' ? ' selected' : ''}>Owner</option>
            <option value="admin"${roleFilter === 'admin' ? ' selected' : ''}>Admin</option>
            <option value="staff"${roleFilter === 'staff' ? ' selected' : ''}>Staff</option>
          </select>
          <select name="status" class="filter-select">
            <option value="">All Statuses</option>
            <option value="active"${statusFilter === 'active' ? ' selected' : ''}>Active</option>
            <option value="disabled"${statusFilter === 'disabled' ? ' selected' : ''}>Disabled</option>
          </select>
          <button type="submit" class="btn btn-primary btn-sm">Filter</button>
        </form>

        <table class="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Role</th>
              <th>Status</th>
              <th>Stores</th>
              <th>Last Login</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>`

    res.send(godLayout({
      title: 'Users',
      userEmail: user.email,
      activePath: '/god-admin/users',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Users list error:', err)
    res.status(500).send(godLayout({
      title: 'Users',
      userEmail: user.email,
      activePath: '/god-admin/users',
      content: `<div class="card"><p style="color:var(--red)">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/users/:id — User detail
// ---------------------------------------------------------------------------

export async function getUserDetail(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const currentUser = req.godAdmin!.user
  const userId = req.params.id

  // One token for every action form on this page. Each row-level
  // form embeds the same hidden field; the first POST burns it,
  // the redirect back to GET re-issues a fresh one.
  const csrfToken = await csrfStore.issue(res, isProduction())
  const csrfField = csrfStore.hiddenField(csrfToken)

  try {
    const target = await db.selectFrom('users')
      .where('id', '=', userId)
      .select(['id', 'email', 'name', 'role', 'status', 'avatar_url', 'created_at', 'updated_at'])
      .executeTakeFirst()

    if (!target) {
      res.status(404).send(godLayout({
        title: 'User Not Found',
        userEmail: currentUser.email,
        activePath: '/god-admin/users',
        content: '<div class="card"><p style="color:var(--red)">User not found.</p><a href="/god-admin/users" class="btn btn-secondary btn-sm" style="margin-top:12px">Back</a></div>',
      }))
      return
    }

    const [shops, sessions, auditLogs] = await Promise.all([
      db.selectFrom('user_shops as us')
        .innerJoin('shops as s', 's.id', 'us.shop_id')
        .where('us.user_id', '=', userId)
        .select(['s.id as shop_id', 's.name', 's.slug', 'us.role', 's.status'])
        .execute(),

      db.selectFrom('sessions')
        .where('user_id', '=', userId)
        .where('expires_at', '>', new Date().toISOString())
        .select(['id', 'ip_address', 'user_agent', 'created_at', 'expires_at'])
        .orderBy('created_at', 'desc')
        .limit(10)
        .execute(),

      db.selectFrom('audit_logs')
        .where('user_id', '=', userId)
        .select(['action', 'resource_type', 'resource_id', 'ip_address', 'created_at'])
        .orderBy('created_at', 'desc')
        .limit(20)
        .execute(),
    ])

    const shopsRows = shops.length > 0
      ? shops.map(s => `
        <tr>
          <td><a href="/god-admin/stores/${s.shop_id}">${esc(s.name)}</a></td>
          <td class="mono">${esc(s.slug)}</td>
          <td>${statusBadge(s.role)}</td>
          <td>${statusBadge(s.status)}</td>
        </tr>`).join('')
      : '<tr><td colspan="4" style="text-align:center;color:var(--gray-400);padding:16px">No store access</td></tr>'

    const sessionsRows = sessions.length > 0
      ? sessions.map(s => `
        <tr>
          <td class="mono" style="font-size:11px">${esc(s.id.slice(0, 8))}...</td>
          <td>${esc(s.ip_address) || '-'}</td>
          <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(s.user_agent)}">${esc(s.user_agent) || '-'}</td>
          <td>${fullDate(s.created_at)}</td>
          <td>${fullDate(s.expires_at)}</td>
        </tr>`).join('')
      : '<tr><td colspan="5" style="text-align:center;color:var(--gray-400);padding:16px">No active sessions</td></tr>'

    const auditRows = auditLogs.length > 0
      ? auditLogs.map(a => `
        <tr>
          <td>${esc(a.action)}</td>
          <td>${esc(a.resource_type) || '-'}</td>
          <td class="mono" style="font-size:11px">${esc(a.resource_id?.slice(0, 8) ?? '') || '-'}</td>
          <td>${esc(a.ip_address) || '-'}</td>
          <td>${fullDate(a.created_at)}</td>
        </tr>`).join('')
      : '<tr><td colspan="5" style="text-align:center;color:var(--gray-400);padding:16px">No audit entries</td></tr>'

    // Don't allow disabling another god admin
    const isGodAdmin = target.role === 'owner'
    const actionButtons = isGodAdmin
      ? '<span class="badge badge-blue">Protected (God Admin)</span>'
      : target.status === 'active'
        ? `<form method="post" action="/god-admin/users/${target.id}/disable" style="display:inline">${csrfField}<button type="submit" class="btn btn-danger btn-sm" onclick="return confirm('Disable this user?')">Disable</button></form>`
        : `<form method="post" action="/god-admin/users/${target.id}/enable" style="display:inline">${csrfField}<button type="submit" class="btn btn-primary btn-sm">Enable</button></form>`

    // Reset Password button — cannot reset default God Admin's password unless you ARE the default God Admin
    const canResetPw = !isGodAdmin || req.godAdmin!.isDefaultAdmin
    const resetPwBtn = canResetPw
      ? `<form method="post" action="/god-admin/users/${target.id}/reset-pw" style="display:inline">${csrfField}<button type="submit" class="btn btn-secondary btn-sm" onclick="return confirm('Reset this user\\'s password? A new random password will be generated.')">Reset Password</button></form>`
      : ''

    // Impersonate button — ONLY for default God Admin, cannot impersonate other God Admins
    const canImpersonate = req.godAdmin!.isDefaultAdmin && !isGodAdmin
    const impersonateBtn = canImpersonate
      ? `<form method="post" action="/god-admin/users/${target.id}/impersonate" style="display:inline">${csrfField}<button type="submit" class="btn btn-secondary btn-sm" onclick="return confirm('Impersonate this user? You will be logged in as them for 1 hour.')">Impersonate</button></form>`
      : ''

    // Show flash password if present in query params
    const flashPw = req.query.pw as string || ''
    const flashPwHtml = flashPw
      ? `<div class="card" style="border-color:var(--green);margin-bottom:24px">
          <div class="card-title" style="color:var(--green);margin-bottom:8px">New Password Generated</div>
          <p style="color:var(--god-text-secondary);margin-bottom:8px">This password is shown <strong>only once</strong>. Copy it now.</p>
          <code style="display:block;background:var(--god-bg);padding:12px;border-radius:8px;font-size:15px;color:var(--god-text);user-select:all">${esc(flashPw)}</code>
        </div>`
      : ''

    const content = `
      ${flashPwHtml}
      <div class="page-header">
        <h1>${esc(target.email)}</h1>
        <div class="action-group">
          ${actionButtons}
          ${resetPwBtn}
          ${impersonateBtn}
          <a href="/god-admin/users" class="btn btn-secondary btn-sm">Back</a>
        </div>
      </div>

      <div class="two-col">
        <div class="card">
          <div class="card-title" style="margin-bottom:12px">User Info</div>
          <div class="info-row"><span class="info-label">ID</span><span class="info-value mono">${esc(target.id)}</span></div>
          <div class="info-row"><span class="info-label">Email</span><span class="info-value">${esc(target.email)}</span></div>
          <div class="info-row"><span class="info-label">Name</span><span class="info-value">${esc(target.name) || '-'}</span></div>
          <div class="info-row"><span class="info-label">Role</span><span class="info-value">${statusBadge(target.role)}</span></div>
          <div class="info-row"><span class="info-label">Status</span><span class="info-value">${statusBadge(target.status)}</span></div>
          <div class="info-row"><span class="info-label">Created</span><span class="info-value">${fullDate(target.created_at)}</span></div>
          <div class="info-row"><span class="info-label">Updated</span><span class="info-value">${fullDate(target.updated_at)}</span></div>
        </div>

        <div class="card">
          <div class="card-title" style="margin-bottom:12px">Store Access</div>
          <table class="data-table">
            <thead><tr><th>Store</th><th>Slug</th><th>Role</th><th>Status</th></tr></thead>
            <tbody>${shopsRows}</tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom:12px">Active Sessions (${sessions.length})</div>
        <table class="data-table">
          <thead><tr><th>Session</th><th>IP</th><th>User Agent</th><th>Created</th><th>Expires</th></tr></thead>
          <tbody>${sessionsRows}</tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom:12px">Audit Log</div>
        <table class="data-table">
          <thead><tr><th>Action</th><th>Resource</th><th>Resource ID</th><th>IP</th><th>Date</th></tr></thead>
          <tbody>${auditRows}</tbody>
        </table>
      </div>`

    res.send(godLayout({
      title: target.email,
      userEmail: currentUser.email,
      activePath: '/god-admin/users',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] User detail error:', err)
    res.status(500).send(godLayout({
      title: 'User Detail',
      userEmail: currentUser.email,
      activePath: '/god-admin/users',
      content: `<div class="card"><p style="color:var(--red)">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/users/:id/disable
// ---------------------------------------------------------------------------

export async function postDisableUser(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const userId = req.params.id

  // CSRF: silent redirect on failure — matches other row actions.
  if (!(await csrfStore.verify(req))) {
    res.redirect(`/god-admin/users/${userId}`)
    return
  }

  // Safety: never disable god admins
  const target = await db.selectFrom('users').where('id', '=', userId).select(['role']).executeTakeFirst()
  if (target?.role === 'owner') {
    res.redirect(`/god-admin/users/${userId}`)
    return
  }

  try {
    await db.updateTable('users')
      .set({ status: 'disabled', updated_at: new Date().toISOString() })
      .where('id', '=', userId)
      .execute()

    // Kill all sessions
    await db.deleteFrom('sessions').where('user_id', '=', userId).execute()

    // Audit log
    await db.insertInto('audit_logs').values({
      user_id: req.godAdmin!.user.id,
      action: 'user.disabled',
      resource_type: 'user',
      resource_id: userId,
      ip_address: req.ip || null,
    }).execute()

    res.redirect(`/god-admin/users/${userId}`)
  } catch (err) {
    console.error('[God Admin] Disable user error:', err)
    res.redirect(`/god-admin/users/${userId}`)
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/users/:id/enable
// ---------------------------------------------------------------------------

export async function postEnableUser(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const userId = req.params.id

  if (!(await csrfStore.verify(req))) {
    res.redirect(`/god-admin/users/${userId}`)
    return
  }

  try {
    await db.updateTable('users')
      .set({ status: 'active', updated_at: new Date().toISOString() })
      .where('id', '=', userId)
      .execute()

    // Audit log
    await db.insertInto('audit_logs').values({
      user_id: req.godAdmin!.user.id,
      action: 'user.enabled',
      resource_type: 'user',
      resource_id: userId,
      ip_address: req.ip || null,
    }).execute()

    res.redirect(`/god-admin/users/${userId}`)
  } catch (err) {
    console.error('[God Admin] Enable user error:', err)
    res.redirect(`/god-admin/users/${userId}`)
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/users/create — Create user form (C3)
// ---------------------------------------------------------------------------

export async function getCreateUser(req: Request, res: Response, _db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user
  const error = req.query.error as string || ''
  const csrfToken = await csrfStore.issue(res, isProduction())
  const csrfField = csrfStore.hiddenField(csrfToken)

  const content = `
    <div class="page-header">
      <h1>Create User</h1>
      <a href="/god-admin/users" class="btn btn-secondary btn-sm">Back</a>
    </div>

    ${error ? `<div class="card" style="border-color:var(--red);margin-bottom:24px"><p style="color:var(--red)">${esc(error)}</p></div>` : ''}

    <div class="card" style="max-width:560px">
      <form method="post" action="/god-admin/users">
        ${csrfField}
        <div style="margin-bottom:16px">
          <label style="display:block;font-size:13px;font-weight:600;color:var(--god-text-muted);margin-bottom:6px">Email *</label>
          <input type="email" name="email" class="search-input" style="width:100%;min-width:0" required placeholder="user@example.com">
        </div>
        <div style="margin-bottom:16px">
          <label style="display:block;font-size:13px;font-weight:600;color:var(--god-text-muted);margin-bottom:6px">Name</label>
          <input type="text" name="name" class="search-input" style="width:100%;min-width:0" placeholder="Full name (optional)">
        </div>
        <div style="margin-bottom:16px">
          <label style="display:block;font-size:13px;font-weight:600;color:var(--god-text-muted);margin-bottom:6px">Role *</label>
          <select name="role" class="filter-select" style="width:100%" required>
            <option value="staff">Staff</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <div style="margin-bottom:16px">
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--god-text-secondary);cursor:pointer">
            <input type="checkbox" name="auto_password" value="1" checked>
            Auto-generate password (16 characters)
          </label>
        </div>
        <div id="manual-pw-section" style="margin-bottom:16px;display:none">
          <label style="display:block;font-size:13px;font-weight:600;color:var(--god-text-muted);margin-bottom:6px">Password</label>
          <input type="text" name="password" class="search-input" style="width:100%;min-width:0" placeholder="Minimum 8 chars, 1 uppercase, 1 digit">
        </div>
        <button type="submit" class="btn btn-primary">Create User</button>
      </form>
    </div>

    <script>
      document.querySelector('[name="auto_password"]').addEventListener('change', function() {
        document.getElementById('manual-pw-section').style.display = this.checked ? 'none' : 'block';
      });
    </script>`

  res.send(godLayout({
    title: 'Create User',
    userEmail: user.email,
    activePath: '/god-admin/users',
    content,
  }))
}

// ---------------------------------------------------------------------------
// POST /god-admin/users — Create user (C3)
// ---------------------------------------------------------------------------

export async function postCreateUser(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect('/god-admin/users/create?error=' + encodeURIComponent('Invalid form submission. Please reload and try again.'))
    return
  }

  const currentUser = req.godAdmin!.user
  const email = (req.body.email || '').trim().toLowerCase()
  const name = (req.body.name || '').trim()
  const role = req.body.role === 'admin' ? 'admin' : 'staff'
  const autoPassword = req.body.auto_password === '1'
  const manualPassword = (req.body.password || '').trim()

  if (!email) {
    res.redirect('/god-admin/users/create?error=' + encodeURIComponent('Email is required'))
    return
  }

  try {
    // Check duplicate email
    const existing = await db.selectFrom('users').where('email', '=', email).select('id').executeTakeFirst()
    if (existing) {
      res.redirect('/god-admin/users/create?error=' + encodeURIComponent('A user with this email already exists'))
      return
    }

    // Generate or validate password
    // Phase 0 Step 0.6: share the exact same strength rules as
    // signup/login/reset/admins. `generateRandomPassword` already
    // guarantees ≥1 uppercase + ≥1 digit by construction, so the
    // auto branch skips the validator — but we still run it on the
    // manual branch so that a God Admin typing a weak password here
    // sees the same error message a self-signup user would see.
    let plainPassword: string
    if (autoPassword) {
      plainPassword = generateRandomPassword(16)
    } else {
      if (!manualPassword) {
        res.redirect('/god-admin/users/create?error=' + encodeURIComponent('Password is required'))
        return
      }
      const strength = validatePasswordStrength(manualPassword)
      if (!strength.valid) {
        res.redirect('/god-admin/users/create?error=' + encodeURIComponent(strength.errors.join(' ')))
        return
      }
      plainPassword = manualPassword
    }

    const passwordHash = await hashPassword(plainPassword)

    // Insert user
    const result = await db.insertInto('users').values({
      email,
      name: name || null,
      role,
      status: 'active',
      password_hash: passwordHash,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id').executeTakeFirst()

    // Audit log
    await db.insertInto('audit_logs').values({
      user_id: currentUser.id,
      action: 'user.created',
      resource_type: 'user',
      resource_id: result?.id || null,
      ip_address: req.ip || null,
      details: JSON.stringify({ email, role }),
    }).execute()

    // Redirect to user detail with flash password
    if (result?.id) {
      res.redirect(`/god-admin/users/${result.id}?pw=${encodeURIComponent(plainPassword)}`)
    } else {
      res.redirect('/god-admin/users')
    }
  } catch (err) {
    console.error('[God Admin] Create user error:', err)
    res.redirect('/god-admin/users/create?error=' + encodeURIComponent('Failed to create user: ' + String(err)))
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/users/:id/reset-pw — Reset password (C5)
// ---------------------------------------------------------------------------

export async function postResetPassword(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const currentUser = req.godAdmin!.user
  const userId = req.params.id

  if (!(await csrfStore.verify(req))) {
    res.redirect(`/god-admin/users/${userId}`)
    return
  }

  try {
    // Fetch target user
    const target = await db.selectFrom('users')
      .where('id', '=', userId)
      .select(['id', 'role', 'is_default_admin', 'email'])
      .executeTakeFirst()

    if (!target) {
      res.redirect('/god-admin/users')
      return
    }

    // Protection: cannot reset default God Admin's password unless you ARE the default God Admin
    if (target.is_default_admin && !req.godAdmin!.isDefaultAdmin) {
      res.redirect(`/god-admin/users/${userId}`)
      return
    }

    // Generate new password
    const plainPassword = generateRandomPassword(16)
    const passwordHash = await hashPassword(plainPassword)

    // Update password
    await db.updateTable('users')
      .set({ password_hash: passwordHash, updated_at: new Date().toISOString() })
      .where('id', '=', userId)
      .execute()

    // Phase 0 close-the-loop — admin-initiated password reset means
    // the target user is either compromised or has a legitimate reset
    // request. Either way every one of their existing sessions must
    // die so the old browser cookie can't keep riding the account.
    // We don't call rotateSession here because the target user isn't
    // present in this request — we just kill everything they have.
    const killed = await deleteAllUserSessions(db, userId)
    if (killed > 0) {
      console.log(
        `[God Admin] Password reset for ${target.email}: revoked ${killed} active session(s)`,
      )
    }

    // Audit log
    await db.insertInto('audit_logs').values({
      user_id: currentUser.id,
      action: 'password_reset_completed',
      resource_type: 'user',
      resource_id: userId,
      ip_address: req.ip || null,
      details: JSON.stringify({
        target_email: target.email,
        initiated_by: currentUser.email,
        sessions_revoked: killed,
      }),
    }).execute()

    // Redirect with flash password
    res.redirect(`/god-admin/users/${userId}?pw=${encodeURIComponent(plainPassword)}`)
  } catch (err) {
    console.error('[God Admin] Reset password error:', err)
    res.redirect(`/god-admin/users/${userId}`)
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/users/:id/impersonate — Impersonate user (C6)
// ---------------------------------------------------------------------------

export async function postImpersonate(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const currentUser = req.godAdmin!.user

  // CSRF first — impersonation mints a 1-hour session as another
  // user, so a stolen token would be catastrophic. Burn-on-fail.
  if (!(await csrfStore.verify(req))) {
    res.redirect(`/god-admin/users/${req.params.id}`)
    return
  }

  // ONLY allowed if isDefaultAdmin
  if (!req.godAdmin!.isDefaultAdmin) {
    res.status(403).send(godLayout({
      title: 'Forbidden',
      userEmail: currentUser.email,
      activePath: '/god-admin/users',
      content: '<div class="card"><p style="color:var(--red)">Only the Default God Admin can impersonate users.</p><a href="/god-admin/users" class="btn btn-secondary btn-sm" style="margin-top:12px">Back</a></div>',
    }))
    return
  }

  const userId = req.params.id

  try {
    // Fetch target user
    const target = await db.selectFrom('users')
      .where('id', '=', userId)
      .select(['id', 'role', 'email', 'status'])
      .executeTakeFirst()

    if (!target) {
      res.redirect('/god-admin/users')
      return
    }

    // Cannot impersonate other God Admins (role='owner')
    if (target.role === 'owner') {
      res.redirect(`/god-admin/users/${userId}`)
      return
    }

    // Cannot impersonate disabled users
    if (target.status === 'disabled') {
      res.redirect(`/god-admin/users/${userId}`)
      return
    }

    // Create a SHORT session (1 hour expiry) for target user
    const { token } = await createSession(db, target.id, {
      ipAddress: req.ip || undefined,
      userAgent: req.headers['user-agent'] || undefined,
    })

    // Override the session expiry to 1 hour
    const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    // We need to find the session we just created — it's the most recent for this user
    await db.updateTable('sessions')
      .set({ expires_at: oneHourFromNow })
      .where('user_id', '=', target.id)
      .where('ip_address', '=', req.ip || '')
      .orderBy('created_at', 'desc')
      .execute()

    // Audit log with impersonation details
    await db.insertInto('audit_logs').values({
      user_id: currentUser.id,
      action: 'user.impersonated',
      resource_type: 'user',
      resource_id: target.id,
      ip_address: req.ip || null,
      details: JSON.stringify({
        impersonator_email: currentUser.email,
        target_email: target.email,
        target_role: target.role,
        session_duration: '1 hour',
      }),
    }).execute()

    // Set the session cookie
    const isProduction = process.env.NODE_ENV === 'production'
    const cookieOpts = getSessionCookieOptions(isProduction)
    // Override max-age to 1 hour
    cookieOpts.maxAge = 3600
    res.setHeader('Set-Cookie', serializeSessionCookie(token, cookieOpts))

    // Redirect to accounts/stores as that user
    res.redirect('/accounts/stores')
  } catch (err) {
    console.error('[God Admin] Impersonate error:', err)
    res.redirect(`/god-admin/users/${userId}`)
  }
}
