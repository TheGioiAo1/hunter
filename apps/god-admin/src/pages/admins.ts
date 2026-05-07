/**
 * God Admin — Admin Hierarchy Management (Phase 6)
 *
 * ONLY accessible by the Default God Admin (is_default_admin = true).
 *
 * GET  /god-admin/admins          — List all God Admins
 * GET  /god-admin/admins/create   — Create God Admin form
 * POST /god-admin/admins/create   — Create God Admin
 * POST /god-admin/admins/:id/delete — Delete (soft) God Admin
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'
import {
  hashPassword,
  validatePasswordStrength,
} from '../../../../packages/core/src/modules/auth/password.js'
// Phase 0 Step 0.4b: CSRF on every God Admin hierarchy mutation.
// These actions (create admin, delete admin) are the single most
// destructive endpoints in the platform, so they get Rule 1
// tokens even though `guardDefaultAdmin` already gates them behind
// the default-admin session.
import { createCsrfStore } from '../../../../packages/core/src/modules/auth/csrf-express.js'

// ---------------------------------------------------------------------------
// Module-level CSRF store
// ---------------------------------------------------------------------------

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_god_admins' })

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

function fullDate(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function statusBadge(status: string | null): string {
  const s = status || 'unknown'
  const map: Record<string, string> = {
    active: 'badge-green', disabled: 'badge-red', owner: 'badge-blue',
  }
  return `<span class="badge ${map[s] || 'badge-gray'}">${esc(s)}</span>`
}

// ---------------------------------------------------------------------------
// Access guard — returns true if request should be blocked (non-default admin)
// ---------------------------------------------------------------------------

function guardDefaultAdmin(req: Request, res: Response): boolean {
  if (req.godAdmin!.isDefaultAdmin) return false

  res.status(403).send(godLayout({
    title: 'Forbidden',
    userEmail: req.godAdmin!.user.email,
    activePath: '/god-admin/admins',
    content: `
      <div class="card" style="text-align:center;padding:48px">
        <div style="font-size:48px;opacity:0.5;margin-bottom:12px">&#128274;</div>
        <p style="color:var(--red);font-size:15px;font-weight:600;margin-bottom:8px">Access Denied</p>
        <p style="color:var(--god-text-secondary)">Only the Default God Admin can manage the admin hierarchy.</p>
        <a href="/god-admin" class="btn btn-secondary btn-sm" style="margin-top:16px">Back to Dashboard</a>
      </div>`,
  }))
  return true
}

// ---------------------------------------------------------------------------
// GET /god-admin/admins — List all God Admins
// ---------------------------------------------------------------------------

export async function getAdmins(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  if (guardDefaultAdmin(req, res)) return

  const user = req.godAdmin!.user

  // Issue one token for the page — every inline delete-admin form
  // inside the list table embeds it. Submitting any single row burns
  // the token, and the subsequent page reload re-issues a fresh one.
  const csrfToken = await csrfStore.issue(res, isProduction())
  const csrfField = csrfStore.hiddenField(csrfToken)

  try {
    const admins = await db.selectFrom('users as u')
      .leftJoin(
        db.selectFrom('sessions')
          .where('expires_at', '>', new Date().toISOString())
          .groupBy('user_id')
          .select(['user_id', sql<string>`max(created_at)`.as('last_login')])
          .as('sl'),
        'sl.user_id', 'u.id',
      )
      .where('u.role', '=', 'owner')
      .select([
        'u.id', 'u.email', 'u.name', 'u.status', 'u.is_default_admin',
        'u.created_at', 'sl.last_login',
      ])
      .orderBy(sql`u.is_default_admin`, 'desc')
      .orderBy('u.created_at', 'asc')
      .execute()

    const tableRows = admins.length > 0
      ? admins.map(a => {
          const defaultBadge = a.is_default_admin
            ? '<span class="badge" style="background:linear-gradient(135deg,rgba(239,68,68,0.15),rgba(249,115,22,0.15));color:#f97316">DEFAULT</span> '
            : ''
          const deleteBtn = a.is_default_admin
            ? '<span class="badge badge-gray">Protected</span>'
            : `<form method="post" action="/god-admin/admins/${a.id}/delete" style="display:inline">${csrfField}<button type="submit" class="btn btn-danger btn-sm" onclick="return confirm('Delete this God Admin? Their sessions will be revoked and account disabled.')">Delete</button></form>`

          return `
          <tr>
            <td>${defaultBadge}${esc(a.email)}</td>
            <td>${esc(a.name) || '-'}</td>
            <td>${statusBadge(a.status)}</td>
            <td>${fullDate(a.last_login)}</td>
            <td>${fullDate(a.created_at)}</td>
            <td>${deleteBtn}</td>
          </tr>`
        }).join('')
      : '<tr><td colspan="6" style="text-align:center;color:var(--god-text-muted);padding:24px">No admins found</td></tr>'

    const content = `
      <div class="page-header">
        <h1>God Admin Hierarchy</h1>
        <a href="/god-admin/admins/create" class="btn btn-primary btn-sm">Create God Admin</a>
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom:12px">All God Admins (role = owner)</div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Status</th>
              <th>Last Login</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>

      <div class="card" style="border-color:var(--god-border-light)">
        <div class="card-title" style="margin-bottom:8px">Admin Hierarchy</div>
        <p style="color:var(--god-text-secondary);font-size:13px;line-height:1.6">
          <strong style="color:var(--god-text)">Level 0 — Default God Admin:</strong> Full platform control. Cannot be deleted or demoted. Seeded at database init.<br>
          <strong style="color:var(--god-text)">Level 0 — God Admin:</strong> Created by Default Admin. Can manage all stores, users, and platform settings. Can be deleted by Default Admin.
        </p>
      </div>`

    res.send(godLayout({
      title: 'Admins',
      userEmail: user.email,
      isDefaultAdmin: true,
      activePath: '/god-admin/admins',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Admins list error:', err)
    res.status(500).send(godLayout({
      title: 'Admins',
      userEmail: user.email,
      isDefaultAdmin: true,
      activePath: '/god-admin/admins',
      content: `<div class="card"><p style="color:var(--red)">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/admins/create — Create God Admin form
// ---------------------------------------------------------------------------

export async function getCreateAdmin(req: Request, res: Response, _db: Kysely<Database>): Promise<void> {
  if (guardDefaultAdmin(req, res)) return

  const user = req.godAdmin!.user
  const error = req.query.error as string || ''
  const csrfToken = await csrfStore.issue(res, isProduction())
  const csrfField = csrfStore.hiddenField(csrfToken)

  const content = `
    <div class="page-header">
      <h1>Create God Admin</h1>
      <a href="/god-admin/admins" class="btn btn-secondary btn-sm">Back</a>
    </div>

    ${error ? `<div class="card" style="border-color:var(--red);margin-bottom:24px"><p style="color:var(--red)">${esc(error)}</p></div>` : ''}

    <div class="card" style="max-width:560px">
      <div class="card-title" style="margin-bottom:16px">New God Admin Account</div>
      <p style="color:var(--god-text-secondary);font-size:13px;margin-bottom:20px">
        This will create a new user with <strong>role = owner</strong> and full God Admin access.
        They will NOT be the Default Admin (only the original seeded account holds that status).
      </p>
      <form method="post" action="/god-admin/admins/create">
        ${csrfField}
        <div style="margin-bottom:16px">
          <label style="display:block;font-size:13px;font-weight:600;color:var(--god-text-muted);margin-bottom:6px">Email *</label>
          <input type="email" name="email" class="search-input" style="width:100%;min-width:0" required placeholder="admin@gbox.co">
        </div>
        <div style="margin-bottom:16px">
          <label style="display:block;font-size:13px;font-weight:600;color:var(--god-text-muted);margin-bottom:6px">Name *</label>
          <input type="text" name="name" class="search-input" style="width:100%;min-width:0" required placeholder="Full name">
        </div>
        <div style="margin-bottom:20px">
          <label style="display:block;font-size:13px;font-weight:600;color:var(--god-text-muted);margin-bottom:6px">Password *</label>
          <input type="text" name="password" class="search-input" style="width:100%;min-width:0" required placeholder="Min 8 chars, 1 uppercase, 1 digit">
          <p style="color:var(--god-text-muted);font-size:11px;margin-top:4px">The password will be shown to you after creation. Share it securely with the new admin.</p>
        </div>
        <button type="submit" class="btn btn-primary">Create God Admin</button>
      </form>
    </div>`

  res.send(godLayout({
    title: 'Create God Admin',
    userEmail: user.email,
    isDefaultAdmin: true,
    activePath: '/god-admin/admins',
    content,
  }))
}

// ---------------------------------------------------------------------------
// POST /god-admin/admins/create — Create God Admin
// ---------------------------------------------------------------------------

export async function postCreateAdmin(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  if (guardDefaultAdmin(req, res)) return

  // CSRF first — these are the most destructive endpoints on the
  // platform, so the token check runs before we even look at the body.
  if (!(await csrfStore.verify(req))) {
    res.redirect('/god-admin/admins/create?error=' + encodeURIComponent('Invalid form submission. Please reload and try again.'))
    return
  }

  const currentUser = req.godAdmin!.user
  const email = (req.body.email || '').trim().toLowerCase()
  const name = (req.body.name || '').trim()
  const password = (req.body.password || '').trim()

  // Validation
  if (!email || !name) {
    res.redirect('/god-admin/admins/create?error=' + encodeURIComponent('Email and name are required'))
    return
  }

  // Phase 0 Step 0.6: unify on the shared strength validator so the
  // rules here match signup/login/reset exactly. Any future rule change
  // (e.g. a deny-list for common passwords) lands in ONE place.
  if (!password) {
    res.redirect('/god-admin/admins/create?error=' + encodeURIComponent('Password is required'))
    return
  }
  const strength = validatePasswordStrength(password)
  if (!strength.valid) {
    res.redirect('/god-admin/admins/create?error=' + encodeURIComponent(strength.errors.join(' ')))
    return
  }

  try {
    // Check duplicate
    const existing = await db.selectFrom('users').where('email', '=', email).select('id').executeTakeFirst()
    if (existing) {
      res.redirect('/god-admin/admins/create?error=' + encodeURIComponent('A user with this email already exists'))
      return
    }

    const passwordHash = await hashPassword(password)

    // Create user with role='owner', is_default_admin=false
    const result = await db.insertInto('users').values({
      email,
      name,
      role: 'owner',
      status: 'active',
      password_hash: passwordHash,
      is_default_admin: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id').executeTakeFirst()

    // Audit log
    await db.insertInto('audit_logs').values({
      user_id: currentUser.id,
      action: 'god_admin.created',
      resource_type: 'user',
      resource_id: result?.id || null,
      ip_address: req.ip || null,
      details: JSON.stringify({ email, name, created_by: currentUser.email }),
    }).execute()

    res.redirect('/god-admin/admins')
  } catch (err) {
    console.error('[God Admin] Create admin error:', err)
    res.redirect('/god-admin/admins/create?error=' + encodeURIComponent('Failed to create admin: ' + String(err)))
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/admins/:id/delete — Soft-delete God Admin
// ---------------------------------------------------------------------------

export async function postDeleteAdmin(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  if (guardDefaultAdmin(req, res)) return

  // CSRF: reject silently (redirect) rather than 500, so the attacker
  // can't distinguish "token missing" from "id not found".
  if (!(await csrfStore.verify(req))) {
    res.redirect('/god-admin/admins')
    return
  }

  const currentUser = req.godAdmin!.user
  const adminId = req.params.id

  try {
    // Fetch target
    const target = await db.selectFrom('users')
      .where('id', '=', adminId)
      .where('role', '=', 'owner')
      .select(['id', 'email', 'is_default_admin'])
      .executeTakeFirst()

    if (!target) {
      res.redirect('/god-admin/admins')
      return
    }

    // CANNOT delete self (is_default_admin = true)
    if (target.is_default_admin) {
      res.redirect('/god-admin/admins')
      return
    }

    // Delete all sessions first
    await db.deleteFrom('sessions').where('user_id', '=', adminId).execute()

    // Soft delete: set status='disabled'
    await db.updateTable('users')
      .set({ status: 'disabled', updated_at: new Date().toISOString() })
      .where('id', '=', adminId)
      .execute()

    // Audit log
    await db.insertInto('audit_logs').values({
      user_id: currentUser.id,
      action: 'god_admin.deleted',
      resource_type: 'user',
      resource_id: adminId,
      ip_address: req.ip || null,
      details: JSON.stringify({ deleted_email: target.email, deleted_by: currentUser.email }),
    }).execute()

    res.redirect('/god-admin/admins')
  } catch (err) {
    console.error('[God Admin] Delete admin error:', err)
    res.redirect('/god-admin/admins')
  }
}
