/**
 * supporter.gbox.co — staff management (god-admin only).
 *
 * Routes:
 *   GET  /staff            → list current staff + pending invitations
 *   POST /staff/invite     → create a new invitation (email, name, preset, optional message)
 *   POST /staff/revoke/:id → revoke a pending invitation
 *
 * Permissions:
 *   - `support:staff:invite` (god_admin only) — required for POST /staff/invite
 *   - `support:staff:manage` (god_admin only) — required for POST /staff/revoke/:id
 *   - GET /staff requires the user to have a staff row; the L1/L2/Lead
 *     views are read-only. Only god_admin sees the "Send invitation" form.
 *
 * Iron Rule 5: no "god admin" in any user-facing text. We label the
 * preset in the `Role` column with the human name ("God Admin" is shown
 * in the staff portal ONLY because the label itself is descriptive — but
 * we do NOT say "contact god admin" or expose the /god-admin/ surface).
 */

import type { Request, Response } from 'express'
import type { SupportAgentPreset } from '@gbox/db/schema/tables.js'
import {
  canStaff,
  createInvitation,
  hasPermission,
  listInvitations,
  logStaffAction,
  PRESET_LABEL,
  revokeInvitation,
  twoFaMode,
  type InvitationRow,
} from '@gbox/core/modules/support-staff/index.js'
import { staffLayout, esc } from '../layouts/staff-layout.js'

export async function getStaff(
  req: Request,
  res: Response,
  db: any,
): Promise<void> {
  if (!req.staffUser) {
    res.redirect('/login')
    return
  }
  const user = req.staffUser
  const canInvite = canStaff(user, 'support:staff:invite')
  const canManage = canStaff(user, 'support:staff:manage')

  // List all active staff (with presets).
  const staff = await (db as any)
    .selectFrom('support_agent_profiles as p')
    .innerJoin('users as u', 'u.id', 'p.user_id')
    .select([
      'p.user_id as userId',
      'p.display_name as displayName',
      'p.preset as preset',
      'p.is_active as isActive',
      'p.last_seen_at as lastSeenAt',
      'u.email as email',
    ])
    .orderBy('p.is_active', 'desc')
    .orderBy('p.last_seen_at', 'desc')
    .execute()
    .catch(() => [])

  // List all invitations for god-admins; just pending for non-admins.
  let invitations: InvitationRow[] = []
  if (canInvite) {
    invitations = await listInvitations(db, { limit: 100 }).catch(() => [])
  }

  const flashMsg = typeof req.query.msg === 'string' ? req.query.msg : ''
  const flashErr = typeof req.query.err === 'string' ? req.query.err : ''
  const flash =
    flashMsg === 'invited'
      ? { kind: 'ok' as const, text: 'Invitation sent. Share the link privately with the invitee.' }
      : flashMsg === 'revoked'
        ? { kind: 'ok' as const, text: 'Invitation revoked.' }
        : flashErr === 'email'
          ? { kind: 'err' as const, text: 'Invalid email address.' }
          : flashErr === 'name'
            ? { kind: 'err' as const, text: 'Display name must be 1–60 characters.' }
            : flashErr === 'preset'
              ? { kind: 'err' as const, text: 'Invalid role selection.' }
              : flashErr === 'dup'
                ? { kind: 'warn' as const, text: 'A pending invitation already exists for that email.' }
                : flashErr === 'server'
                  ? { kind: 'err' as const, text: 'Could not send invitation. Please try again.' }
                  : null

  // If an invitation was just created and the raw token was passed in the
  // query (one-shot display), render the copyable link prominently.
  const freshToken = typeof req.query.t === 'string' ? req.query.t : ''
  const freshTokenBlock =
    freshToken && flashMsg === 'invited' ? renderFreshInviteLink(req, freshToken) : ''

  const content = `
    ${freshTokenBlock}
    ${canInvite ? renderInviteForm() : ''}
    <h2 style="margin-top:30px;font-size:15px">Current staff</h2>
    ${renderStaffTable(staff, user.userId)}
    ${
      canInvite
        ? `<h2 style="margin-top:30px;font-size:15px">Invitations</h2>
           ${renderInvitationTable(invitations, canManage)}`
        : ''
    }
  `

  res
    .status(200)
    .type('html')
    .send(
      staffLayout({
        title: 'Staff',
        user,
        activePage: 'staff',
        content,
        flash,
      }),
    )
}

export async function postInviteStaff(
  req: Request,
  res: Response,
  db: any,
): Promise<void> {
  if (!req.staffUser) {
    res.redirect('/login')
    return
  }
  const user = req.staffUser
  if (!hasPermission(user.preset, 'support:staff:invite')) {
    logStaffAction(db, {
      actorUserId: user.userId,
      actorPreset: user.preset,
      action: 'perm.deny',
      denyReason: 'support:staff:invite',
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
    }).catch(() => {})
    res.status(403).type('html').send('<p>Forbidden.</p>')
    return
  }

  const email = String(req.body?.email ?? '')
  const displayName = String(req.body?.display_name ?? '')
  const preset = String(req.body?.preset ?? '') as SupportAgentPreset
  const message = String(req.body?.message ?? '').trim() || undefined

  const result = await createInvitation(db, {
    email,
    displayName,
    preset,
    invitedBy: user.userId,
    message,
  })

  if (!result.ok) {
    logStaffAction(db, {
      actorUserId: user.userId,
      actorPreset: user.preset,
      action: 'invite.send',
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
      details: { error: result.error.code, email },
    }).catch(() => {})
    const errCode =
      result.error.code === 'invalid_email'
        ? 'email'
        : result.error.code === 'invalid_display_name'
          ? 'name'
          : result.error.code === 'invalid_preset'
            ? 'preset'
            : result.error.code === 'duplicate_pending'
              ? 'dup'
              : 'server'
    res.redirect(`/staff?err=${errCode}`)
    return
  }

  logStaffAction(db, {
    actorUserId: user.userId,
    actorPreset: user.preset,
    action: 'invite.send',
    ipAddress: req.ip ?? null,
    userAgent: (req.headers['user-agent'] ?? null) as string | null,
    details: { email, preset, invitationId: result.data.invitationId },
  }).catch(() => {})

  // Pass the raw token once in the URL so the page can show a copyable
  // link. It's not persisted in history further than this redirect.
  res.redirect(`/staff?msg=invited&t=${encodeURIComponent(result.data.rawToken)}`)
}

export async function postRevokeStaff(
  req: Request,
  res: Response,
  db: any,
): Promise<void> {
  if (!req.staffUser) {
    res.redirect('/login')
    return
  }
  const user = req.staffUser
  if (!hasPermission(user.preset, 'support:staff:manage')) {
    logStaffAction(db, {
      actorUserId: user.userId,
      actorPreset: user.preset,
      action: 'perm.deny',
      denyReason: 'support:staff:manage',
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
    }).catch(() => {})
    res.status(403).type('html').send('<p>Forbidden.</p>')
    return
  }

  const id = String(req.params.id ?? '')
  const ok = await revokeInvitation(db, { invitationId: id, revokedBy: user.userId }).catch(() => false)

  logStaffAction(db, {
    actorUserId: user.userId,
    actorPreset: user.preset,
    action: 'invite.revoke',
    ipAddress: req.ip ?? null,
    userAgent: (req.headers['user-agent'] ?? null) as string | null,
    details: { invitationId: id, success: ok },
  }).catch(() => {})

  res.redirect(`/staff?msg=revoked`)
}

// ── Renderers ─────────────────────────────────────────────────────────

function renderInviteForm(): string {
  const options = (Object.keys(PRESET_LABEL) as SupportAgentPreset[])
    .map((p) => {
      const twoFa = twoFaMode(p)
      const twoFaNote =
        twoFa === 'mandatory' ? ' — 2FA required' : twoFa === 'recommended' ? ' — 2FA recommended' : ''
      return `<option value="${esc(p)}">${esc(PRESET_LABEL[p])}${esc(twoFaNote)}</option>`
    })
    .join('')
  return `
    <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin-bottom:20px">
      <h2 style="margin:0 0 12px;font-size:15px">Invite a new staff member</h2>
      <form method="post" action="/staff/invite" style="display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <div style="flex:1 1 240px;min-width:200px">
            <label for="email">Email</label>
            <input id="email" name="email" type="email" required maxlength="320" autocomplete="off">
          </div>
          <div style="flex:1 1 200px;min-width:180px">
            <label for="display_name">Display name</label>
            <input id="display_name" name="display_name" type="text" required maxlength="60" placeholder="Minh">
          </div>
          <div style="flex:1 1 200px;min-width:180px">
            <label for="preset">Role</label>
            <select id="preset" name="preset" required>${options}</select>
          </div>
        </div>
        <div>
          <label for="message">Personal message (optional)</label>
          <textarea id="message" name="message" rows="2" maxlength="500" placeholder="Hi Minh, welcome to the team!"></textarea>
        </div>
        <div>
          <button type="submit" class="btn">Send invitation</button>
        </div>
      </form>
    </div>
  `
}

function renderFreshInviteLink(req: Request, token: string): string {
  // Build full URL using the request's host. supporter.gbox.co in prod.
  const host = (req.get?.('host') ?? 'supporter.gbox.co').toString()
  const proto = (req.secure ? 'https' : (req.protocol ?? 'https'))
  const link = `${proto}://${host}/invite/${encodeURIComponent(token)}`
  return `
    <div style="background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);color:var(--ok);border-radius:10px;padding:14px 16px;margin-bottom:20px">
      <div style="font-size:12px;font-weight:600;margin-bottom:6px">Invitation created — share this link privately (expires in 7 days)</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="text" readonly value="${esc(link)}" onclick="this.select()" style="flex:1 1 260px;min-width:0;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">
        <button type="button" class="btn btn-secondary" onclick="navigator.clipboard.writeText(this.previousElementSibling.value);this.textContent='Copied!';setTimeout(() => this.textContent='Copy', 1500)">Copy</button>
      </div>
    </div>
  `
}

function renderStaffTable(
  rows: Array<{
    userId: string
    displayName: string
    preset: SupportAgentPreset
    isActive: boolean
    lastSeenAt: string | null
    email: string
  }>,
  currentUserId: string,
): string {
  if (rows.length === 0) {
    return `<div style="color:var(--text-muted);padding:20px;text-align:center">No staff members yet.</div>`
  }
  const body = rows
    .map((r) => {
      const presetLabel = PRESET_LABEL[r.preset] ?? r.preset
      const isYou = r.userId === currentUserId
      const active = r.isActive
        ? `<span class="pill pill-resolved">Active</span>`
        : `<span class="pill pill-closed">Inactive</span>`
      const lastSeen = r.lastSeenAt ? esc(formatRelative(r.lastSeenAt)) : '—'
      return `<tr>
        <td>
          <div style="font-weight:600">${esc(r.displayName)}${isYou ? ' <span style="color:var(--text-muted);font-size:11px">(you)</span>' : ''}</div>
          <div style="font-size:11px;color:var(--text-muted)">${esc(r.email)}</div>
        </td>
        <td>${esc(presetLabel)}</td>
        <td>${active}</td>
        <td style="font-size:12px">${lastSeen}</td>
      </tr>`
    })
    .join('')
  return `<table class="data-table">
    <thead>
      <tr><th>Name</th><th>Role</th><th>Status</th><th>Last seen</th></tr>
    </thead>
    <tbody>${body}</tbody>
  </table>`
}

function renderInvitationTable(rows: InvitationRow[], canRevoke: boolean): string {
  if (rows.length === 0) {
    return `<div style="color:var(--text-muted);padding:20px;text-align:center">No invitations on file.</div>`
  }
  const body = rows
    .map((r) => {
      const presetLabel = PRESET_LABEL[r.preset] ?? r.preset
      const statusPill =
        r.status === 'pending'
          ? `<span class="pill pill-open">Pending</span>`
          : r.status === 'accepted'
            ? `<span class="pill pill-resolved">Accepted</span>`
            : r.status === 'revoked'
              ? `<span class="pill pill-closed">Revoked</span>`
              : `<span class="pill pill-closed">Expired</span>`
      const actionCell =
        r.status === 'pending' && canRevoke
          ? `<form method="post" action="/staff/revoke/${esc(r.id)}" style="margin:0" onsubmit="return confirm('Revoke this invitation?')">
               <button type="submit" class="btn btn-secondary" style="font-size:12px">Revoke</button>
             </form>`
          : ''
      return `<tr>
        <td>
          <div style="font-weight:500">${esc(r.email)}</div>
          <div style="font-size:11px;color:var(--text-muted)">Invited as ${esc(r.displayName)}</div>
        </td>
        <td>${esc(presetLabel)}</td>
        <td>${statusPill}</td>
        <td style="font-size:12px">${esc(formatRelative(r.createdAt))}</td>
        <td style="font-size:12px">${esc(formatRelative(r.expiresAt))}</td>
        <td>${actionCell}</td>
      </tr>`
    })
    .join('')
  return `<table class="data-table">
    <thead>
      <tr><th>Email</th><th>Role</th><th>Status</th><th>Created</th><th>Expires</th><th></th></tr>
    </thead>
    <tbody>${body}</tbody>
  </table>`
}

function formatRelative(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return iso
  const deltaS = Math.round((Date.now() - then) / 1000)
  if (Math.abs(deltaS) < 60) return 'just now'
  if (Math.abs(deltaS) < 3600) return `${Math.round(Math.abs(deltaS) / 60)}m ${deltaS > 0 ? 'ago' : 'from now'}`
  if (Math.abs(deltaS) < 86400) return `${Math.round(Math.abs(deltaS) / 3600)}h ${deltaS > 0 ? 'ago' : 'from now'}`
  return `${Math.round(Math.abs(deltaS) / 86400)}d ${deltaS > 0 ? 'ago' : 'from now'}`
}
