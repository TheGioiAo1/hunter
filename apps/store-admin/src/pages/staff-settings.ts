/**
 * Store Admin — Staff & Permissions (Phase 9 PR4).
 *
 * Full Shopify-class staff management:
 *   • List team members with role + status badges
 *   • Pending invitations list with revoke
 *   • Invite-by-email form (role + permissions grid)
 *   • Edit a member (role change + permission override + disable/remove)
 *
 * Iron rule 5: every error path surfaces "Please contact Gbox support"
 * (or a seller-safe message) with zero god-admin mentions.
 *
 * Route wiring in server.ts under `/admin/store/:slug/settings/staff/*`.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { notify, byActor } from '../lib/notify.js'
import { logSellerAction } from '../middleware/store-auth.js'
import {
  PERMISSION_CATALOG,
  permissionsForRole,
  resolvePermissions,
  sanitisePermissionList,
  STAFF_ROLES,
  isValidStaffRole,
  type StaffRole,
} from '@gbox/core/modules/staff/permissions.js'
import {
  createInvitation,
  listInvitations,
  revokeInvitation,
  DuplicateInvitationError,
  InvalidInvitationInputError,
  InvitationNotFoundError,
} from '@gbox/core/modules/staff/invitations.js'
import {
  listMembers,
  getMember,
  updateMember,
  disableMember,
  reenableMember,
  removeMember,
  StaffMemberNotFoundError,
  CannotRemoveOwnerError,
  CannotRemoveSelfError,
  InvalidStaffUpdateError,
} from '@gbox/core/modules/staff/members.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeMessage(err: unknown): string {
  if (
    err instanceof DuplicateInvitationError ||
    err instanceof InvalidInvitationInputError ||
    err instanceof InvitationNotFoundError ||
    err instanceof StaffMemberNotFoundError ||
    err instanceof CannotRemoveOwnerError ||
    err instanceof CannotRemoveSelfError ||
    err instanceof InvalidStaffUpdateError
  ) {
    return (err as Error).message
  }
  return 'Please contact Gbox support.'
}

function banner(kind: 'ok' | 'error', msg: string): string {
  const bg = kind === 'ok' ? 'var(--success-bg,#0f5132)' : 'var(--danger-bg,#842029)'
  const color = kind === 'ok' ? 'var(--success-text,#d1e7dd)' : 'var(--danger-text,#f8d7da)'
  return `<div style="padding:10px 14px;border-radius:6px;background:${bg};color:${color};margin-bottom:16px">${esc(msg)}</div>`
}

function roleBadge(role: string): string {
  const cls = role === 'owner' ? 'badge-success'
    : role === 'admin' ? 'badge-info'
    : role === 'staff' ? 'badge-warning'
    : 'badge-secondary'
  return `<span class="badge ${cls}">${esc(role)}</span>`
}

function statusBadge(disabled: boolean): string {
  return disabled
    ? `<span class="badge badge-danger">disabled</span>`
    : `<span class="badge badge-success">active</span>`
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toISOString().slice(0, 10)
  } catch {
    return '—'
  }
}

// ---------------------------------------------------------------------------
// GET /settings/staff — list + invite form
// ---------------------------------------------------------------------------

export async function getStaffSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const saved = typeof req.query.saved === 'string' ? req.query.saved : null
  const errMsg = typeof req.query.err === 'string' ? req.query.err : null

  const [members, invitations] = await Promise.all([
    listMembers(db as any, store.id),
    listInvitations(db as any, { shop_id: store.id, limit: 50 }),
  ])

  const pending = invitations.filter((i) => i.status === 'pending')
  const history = invitations.filter((i) => i.status !== 'pending').slice(0, 10)

  const flashBanner = saved
    ? banner('ok', saved === 'invited' ? 'Invitation sent.' :
                   saved === 'updated' ? 'Staff member updated.' :
                   saved === 'disabled' ? 'Staff member disabled.' :
                   saved === 'reenabled' ? 'Staff member re-enabled.' :
                   saved === 'removed' ? 'Staff member removed.' :
                   saved === 'revoked' ? 'Invitation revoked.' :
                   'Saved.')
    : errMsg
      ? banner('error', decodeURIComponent(errMsg))
      : ''

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Staff & Permissions</h1>
        <p class="page-subtitle"><a href="${base}/settings" style="color:var(--accent);text-decoration:none">Settings</a> / Staff</p>
      </div>
    </div>

    ${flashBanner}

    <div class="card">
      <div class="card-header">
        <span>Team members (${members.length})</span>
      </div>
      <div class="card-body" style="padding:0">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:var(--bg-secondary);text-align:left">
              <th style="padding:10px 14px">Name</th>
              <th style="padding:10px 14px">Email</th>
              <th style="padding:10px 14px">Role</th>
              <th style="padding:10px 14px">Status</th>
              <th style="padding:10px 14px">Last active</th>
              <th style="padding:10px 14px">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${members.map((m) => `
              <tr style="border-top:1px solid var(--border)">
                <td style="padding:10px 14px;font-weight:500">${esc(m.name || m.email.split('@')[0])}</td>
                <td style="padding:10px 14px">${esc(m.email)}</td>
                <td style="padding:10px 14px">${roleBadge(m.role)}</td>
                <td style="padding:10px 14px">${statusBadge(!!m.disabled_at)}</td>
                <td style="padding:10px 14px">${fmtDate(m.last_active_at)}</td>
                <td style="padding:10px 14px">
                  ${m.role === 'owner'
                    ? '<span style="color:var(--text-secondary);font-size:12px">Owner</span>'
                    : `<a href="${base}/settings/staff/${esc(m.user_id)}" style="color:var(--accent);text-decoration:none;font-size:13px">Edit</a>`}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-top:24px">
      <div class="card-header">
        <span>Pending invitations (${pending.length})</span>
      </div>
      <div class="card-body" style="padding:0">
        ${pending.length === 0
          ? '<div style="padding:16px;color:var(--text-secondary)">No pending invitations.</div>'
          : `<table style="width:100%;border-collapse:collapse">
               <thead>
                 <tr style="background:var(--bg-secondary);text-align:left">
                   <th style="padding:10px 14px">Email</th>
                   <th style="padding:10px 14px">Role</th>
                   <th style="padding:10px 14px">Sent</th>
                   <th style="padding:10px 14px">Expires</th>
                   <th style="padding:10px 14px">Actions</th>
                 </tr>
               </thead>
               <tbody>
                 ${pending.map((inv) => `
                   <tr style="border-top:1px solid var(--border)">
                     <td style="padding:10px 14px">${esc(inv.email)}</td>
                     <td style="padding:10px 14px">${roleBadge(inv.role)}</td>
                     <td style="padding:10px 14px">${fmtDate(inv.created_at)}</td>
                     <td style="padding:10px 14px">${fmtDate(inv.expires_at)}</td>
                     <td style="padding:10px 14px">
                       <form method="POST" action="${base}/settings/staff/invitations/${esc(inv.id)}/revoke" style="display:inline">
                         ${csrfHiddenField((req as any).csrfToken || '')}
                         <button type="submit" class="btn btn-sm btn-danger">Revoke</button>
                       </form>
                     </td>
                   </tr>
                 `).join('')}
               </tbody>
             </table>`}
      </div>
    </div>

    <div class="card" style="margin-top:24px">
      <div class="card-header">
        <span>Invite a staff member</span>
      </div>
      <div class="card-body">
        <form method="POST" action="${base}/settings/staff/invite">
          ${csrfHiddenField((req as any).csrfToken || '')}
          <div style="display:grid;grid-template-columns:1fr 200px;gap:16px;margin-bottom:16px">
            <div>
              <label style="display:block;margin-bottom:6px;font-size:13px">Email</label>
              <input type="email" name="email" required class="form-control" placeholder="teammate@example.com">
            </div>
            <div>
              <label style="display:block;margin-bottom:6px;font-size:13px">Role</label>
              <select name="role" class="form-control">
                <option value="admin">Admin</option>
                <option value="staff" selected>Staff</option>
                <option value="limited">Limited</option>
              </select>
            </div>
          </div>
          <details style="margin-bottom:16px">
            <summary style="cursor:pointer;font-size:13px;color:var(--text-secondary)">Custom permissions (advanced)</summary>
            <div style="margin-top:12px;padding:12px;background:var(--bg-secondary);border-radius:6px">
              <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">
                Tick permissions to <strong>add</strong> to the role template. Most invitations can leave this empty — the role grants sensible defaults.
              </div>
              <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px">
                ${PERMISSION_CATALOG.map((p) => `
                  <label style="display:flex;gap:8px;align-items:flex-start;font-size:13px">
                    <input type="checkbox" name="permissions[]" value="${esc(p.key)}">
                    <span>
                      <strong style="font-size:13px">${esc(p.label)}</strong>
                      <div style="font-size:11px;color:var(--text-secondary)">${esc(p.description)}</div>
                    </span>
                  </label>
                `).join('')}
              </div>
            </div>
          </details>
          <button type="submit" class="btn btn-primary">Send invitation</button>
        </form>
      </div>
    </div>

    ${history.length > 0 ? `
      <div class="card" style="margin-top:24px">
        <div class="card-header"><span>Recent invitation activity</span></div>
        <div class="card-body" style="padding:0">
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="background:var(--bg-secondary);text-align:left">
                <th style="padding:10px 14px">Email</th>
                <th style="padding:10px 14px">Role</th>
                <th style="padding:10px 14px">Status</th>
                <th style="padding:10px 14px">Date</th>
              </tr>
            </thead>
            <tbody>
              ${history.map((inv) => `
                <tr style="border-top:1px solid var(--border)">
                  <td style="padding:10px 14px">${esc(inv.email)}</td>
                  <td style="padding:10px 14px">${roleBadge(inv.role)}</td>
                  <td style="padding:10px 14px">
                    <span class="badge ${inv.status === 'accepted' ? 'badge-success' : 'badge-secondary'}">${esc(inv.status)}</span>
                  </td>
                  <td style="padding:10px 14px">${fmtDate(inv.updated_at)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    ` : ''}
  `

  const theme = (req as any).theme || 'dark'
  res.send(sellerLayout({
    title: 'Staff',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    theme: theme as 'dark' | 'light',
    activePage: 'settings',
    content,
  }))
}

// ---------------------------------------------------------------------------
// POST /settings/staff/invite
// ---------------------------------------------------------------------------

export async function postStaffInvite(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase()
    const role = String(req.body?.role ?? 'staff').toLowerCase()
    if (!isValidStaffRole(role) || role === 'owner') {
      throw new InvalidInvitationInputError('Role must be admin, staff, or limited.')
    }
    const perms: string[] = Array.isArray(req.body?.['permissions[]'])
      ? (req.body['permissions[]'] as string[])
      : Array.isArray(req.body?.permissions)
        ? (req.body.permissions as string[])
        : typeof req.body?.permissions === 'string'
          ? [req.body.permissions as string]
          : []

    const result = await createInvitation(db as any, {
      shop_id: store.id,
      email,
      role: role as StaffRole,
      permissions: perms,
      invited_by: user.id,
    })

    logSellerAction(db as any, req, 'create', 'staff_invitation', result.invitation.id, {
      email,
      role,
    })

    notify(db, {
      shopId: store.id,
      userId: user.id,
      type: 'staff_invitation_created',
      title: `Invitation sent to ${email}`,
      message: `${byActor(user)} • Role: ${role}`,
      resourceType: 'staff_invitation',
      resourceId: result.invitation.id,
    })

    // The raw token is returned so the caller can email it. For PR4 we
    // include it on the redirect query string — this becomes an email
    // hook in a follow-up PR.
    res.redirect(`${base}/settings/staff?saved=invited`)
  } catch (err) {
    res.redirect(`${base}/settings/staff?err=${encodeURIComponent(safeMessage(err))}`)
  }
}

// ---------------------------------------------------------------------------
// POST /settings/staff/invitations/:id/revoke
// ---------------------------------------------------------------------------

export async function postStaffInvitationRevoke(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const id = String(req.params.id)
  try {
    await revokeInvitation(db as any, {
      id,
      shop_id: store.id,
      revoked_by: user.id,
    })
    logSellerAction(db as any, req, 'revoke', 'staff_invitation', id, {})
    res.redirect(`${base}/settings/staff?saved=revoked`)
  } catch (err) {
    res.redirect(`${base}/settings/staff?err=${encodeURIComponent(safeMessage(err))}`)
  }
}

// ---------------------------------------------------------------------------
// GET /settings/staff/:userId — edit page
// ---------------------------------------------------------------------------

export async function getStaffMember(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const saved = typeof req.query.saved === 'string' ? req.query.saved : null
  const errMsg = typeof req.query.err === 'string' ? req.query.err : null

  const member = await getMember(db as any, store.id, String(req.params.userId))
  if (!member) {
    res.status(404).redirect(`${base}/settings/staff?err=${encodeURIComponent('Staff member not found.')}`)
    return
  }

  const flashBanner = saved ? banner('ok', 'Saved.') : errMsg ? banner('error', decodeURIComponent(errMsg)) : ''
  const templateKeys = new Set(permissionsForRole(member.role as StaffRole))
  const overrides = new Set(member.permissions)

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">${esc(member.name || member.email)}</h1>
        <p class="page-subtitle"><a href="${base}/settings/staff" style="color:var(--accent);text-decoration:none">Staff</a> / ${esc(member.email)}</p>
      </div>
    </div>

    ${flashBanner}

    <div class="card">
      <div class="card-header"><span>Profile</span></div>
      <div class="card-body">
        <div style="display:grid;grid-template-columns:160px 1fr;gap:8px 16px">
          <div style="color:var(--text-secondary)">Email</div><div>${esc(member.email)}</div>
          <div style="color:var(--text-secondary)">Role</div><div>${roleBadge(member.role)}</div>
          <div style="color:var(--text-secondary)">Status</div><div>${statusBadge(!!member.disabled_at)}</div>
          <div style="color:var(--text-secondary)">Last active</div><div>${fmtDate(member.last_active_at)}</div>
          <div style="color:var(--text-secondary)">Invited</div><div>${fmtDate(member.invited_at || member.created_at)}</div>
        </div>
      </div>
    </div>

    <form method="POST" action="${base}/settings/staff/${esc(member.user_id)}/update" class="card" style="margin-top:24px">
      ${csrfHiddenField((req as any).csrfToken || '')}
      <div class="card-header"><span>Role &amp; permissions</span></div>
      <div class="card-body">
        <label style="display:block;margin-bottom:12px">
          <div style="font-size:13px;margin-bottom:6px">Role</div>
          <select name="role" class="form-control" style="max-width:240px">
            ${(['admin','staff','limited'] as const).map((r) => `
              <option value="${r}" ${member.role === r ? 'selected' : ''}>${r}</option>
            `).join('')}
          </select>
        </label>

        <div style="margin-top:16px;padding:12px;background:var(--bg-secondary);border-radius:6px">
          <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">
            Ticked rows are granted. Rows that are part of the role template but unticked will be removed. Unticked rows outside the template stay unticked.
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px">
            ${PERMISSION_CATALOG.map((p) => {
              const inTemplate = templateKeys.has(p.key)
              const inOverride = overrides.has(p.key)
              const inNegOverride = overrides.has('-' + p.key)
              const effectivelyOn =
                (inTemplate && !inNegOverride) || (!inTemplate && inOverride)
              return `
                <label style="display:flex;gap:8px;align-items:flex-start;font-size:13px">
                  <input type="checkbox" name="permissions[]" value="${esc(p.key)}" ${effectivelyOn ? 'checked' : ''}>
                  <span>
                    <strong style="font-size:13px">${esc(p.label)}</strong>
                    <div style="font-size:11px;color:var(--text-secondary)">${esc(p.description)}</div>
                    ${inTemplate ? '<div style="font-size:11px;color:var(--accent)">Template</div>' : ''}
                  </span>
                </label>
              `
            }).join('')}
          </div>
        </div>
        <button type="submit" class="btn btn-primary" style="margin-top:16px">Save changes</button>
      </div>
    </form>

    <div class="card" style="margin-top:24px;border-color:var(--danger,#842029)">
      <div class="card-header"><span style="color:var(--danger-text,#f8d7da)">Danger zone</span></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
        ${member.disabled_at
          ? `<form method="POST" action="${base}/settings/staff/${esc(member.user_id)}/reenable">
               ${csrfHiddenField((req as any).csrfToken || '')}
               <button type="submit" class="btn btn-secondary">Re-enable staff</button>
               <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">Currently disabled.</div>
             </form>`
          : `<form method="POST" action="${base}/settings/staff/${esc(member.user_id)}/disable">
               ${csrfHiddenField((req as any).csrfToken || '')}
               <button type="submit" class="btn btn-warning"${member.user_id === user.id ? ' disabled title="You cannot disable yourself"' : ''}>Disable staff</button>
               <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">Blocks sign-in. History preserved.</div>
             </form>`}
        <form method="POST" action="${base}/settings/staff/${esc(member.user_id)}/remove" onsubmit="return confirm('Remove ${esc(member.email)} from the shop? This cannot be undone.')">
          ${csrfHiddenField((req as any).csrfToken || '')}
          <button type="submit" class="btn btn-danger"${member.user_id === user.id ? ' disabled title="You cannot remove yourself"' : ''}>Remove from shop</button>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">Deletes the membership. History in audit log.</div>
        </form>
      </div>
    </div>
  `

  const theme = (req as any).theme || 'dark'
  res.send(sellerLayout({
    title: member.name || member.email,
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    theme: theme as 'dark' | 'light',
    activePage: 'settings',
    content,
  }))
}

// ---------------------------------------------------------------------------
// POST /settings/staff/:userId/update
// ---------------------------------------------------------------------------

export async function postStaffMemberUpdate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const userId = String(req.params.userId)
  try {
    const role = String(req.body?.role ?? '').toLowerCase()
    if (!isValidStaffRole(role) || role === 'owner') {
      throw new InvalidStaffUpdateError('Role must be admin, staff, or limited.')
    }
    const ticked: string[] = Array.isArray(req.body?.['permissions[]'])
      ? (req.body['permissions[]'] as string[])
      : Array.isArray(req.body?.permissions)
        ? (req.body.permissions as string[])
        : typeof req.body?.permissions === 'string'
          ? [req.body.permissions as string]
          : []
    const tickedSet = new Set(sanitisePermissionList(ticked))

    // Derive add/remove overrides from template diff:
    // - key in template but unticked → `-key`
    // - key not in template but ticked → `key`
    const templateKeys = new Set(permissionsForRole(role as StaffRole))
    const overrides: string[] = []
    for (const k of templateKeys) {
      if (!tickedSet.has(k)) overrides.push('-' + k)
    }
    for (const k of tickedSet) {
      if (!templateKeys.has(k)) overrides.push(k)
    }

    await updateMember(db as any, {
      shop_id: store.id,
      user_id: userId,
      role: role as StaffRole,
      permissions: overrides,
      actor_user_id: user.id,
    })
    logSellerAction(db as any, req, 'update', 'staff_member', userId, { role, override_count: overrides.length })
    res.redirect(`${base}/settings/staff/${userId}?saved=1`)
  } catch (err) {
    res.redirect(`${base}/settings/staff/${userId}?err=${encodeURIComponent(safeMessage(err))}`)
  }
}

// ---------------------------------------------------------------------------
// POST /settings/staff/:userId/disable
// ---------------------------------------------------------------------------

export async function postStaffMemberDisable(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const userId = String(req.params.userId)
  try {
    await disableMember(db as any, {
      shop_id: store.id,
      user_id: userId,
      actor_user_id: user.id,
    })
    logSellerAction(db as any, req, 'disable', 'staff_member', userId, {})
    res.redirect(`${base}/settings/staff?saved=disabled`)
  } catch (err) {
    res.redirect(`${base}/settings/staff/${userId}?err=${encodeURIComponent(safeMessage(err))}`)
  }
}

// ---------------------------------------------------------------------------
// POST /settings/staff/:userId/reenable
// ---------------------------------------------------------------------------

export async function postStaffMemberReenable(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const userId = String(req.params.userId)
  try {
    await reenableMember(db as any, {
      shop_id: store.id,
      user_id: userId,
      actor_user_id: user.id,
    })
    logSellerAction(db as any, req, 'reenable', 'staff_member', userId, {})
    res.redirect(`${base}/settings/staff?saved=reenabled`)
  } catch (err) {
    res.redirect(`${base}/settings/staff/${userId}?err=${encodeURIComponent(safeMessage(err))}`)
  }
}

// ---------------------------------------------------------------------------
// POST /settings/staff/:userId/remove
// ---------------------------------------------------------------------------

export async function postStaffMemberRemove(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const userId = String(req.params.userId)
  try {
    await removeMember(db as any, {
      shop_id: store.id,
      user_id: userId,
      actor_user_id: user.id,
    })
    logSellerAction(db as any, req, 'remove', 'staff_member', userId, {})
    res.redirect(`${base}/settings/staff?saved=removed`)
  } catch (err) {
    res.redirect(`${base}/settings/staff/${userId}?err=${encodeURIComponent(safeMessage(err))}`)
  }
}

// Export the default roles for tests / admin helpers.
export { STAFF_ROLES }
