/**
 * supporter.gbox.co — invitation accept flow.
 *
 * Routes:
 *   GET  /invite/:token  → render accept form (or "link expired" page)
 *   POST /invite/:token  → create user row + support_agent_profiles row,
 *                           flip invitation to 'accepted', issue session cookie,
 *                           redirect to /inbox.
 *
 * Iron Rule 1:
 *   - password is bcrypt-hashed before insert (SALT_ROUNDS=12 per password.ts)
 *   - raw invite token NEVER touches the DB; we re-hash it to find the row
 *   - session token is the normal gbox_session (createSession), so the new
 *     staff member is auto-signed-in after accept — no second login step.
 *
 * Iron Rule 5:
 *   - Expired / revoked / bogus tokens all render the same "link
 *     expired" page — no timing leaks between "never existed" and
 *     "already used".
 *   - Error messages on POST never mention "god admin" or the invite
 *     row's internals. Diagnostic reasons go to support_audit_log.
 *
 * Notes on user-row creation semantics:
 *   - If an existing `users` row matches the invite email, we LINK to it
 *     instead of creating a dup. The invitee picks a new password (which
 *     we overwrite) — this is by design: the god admin who sent the
 *     invite has implicitly vouched for email ownership.
 *   - Either way we upsert `support_agent_profiles` with the preset
 *     chosen by the god admin on the invite.
 *   - Everything happens in a single transaction to avoid half-created
 *     state on crash.
 */

import type { Request, Response } from 'express'
import {
  acceptInvitation,
  findValidInvitation,
  logStaffAction,
  normalizeEmail,
  PRESET_LABEL,
} from '@gbox/core/modules/support-staff/index.js'
import { hashPassword, validatePasswordStrength } from '@gbox/core/modules/auth/password.js'
import {
  createSession,
  getSessionCookieOptions,
  serializeSessionCookie,
} from '@gbox/core/modules/auth/session.js'
import { staffLayout, esc } from '../layouts/staff-layout.js'

const isProduction = () => process.env.NODE_ENV === 'production'

export async function getInvite(
  req: Request,
  res: Response,
  db: any,
): Promise<void> {
  const token = String(req.params.token ?? '')
  const invite = await findValidInvitation(db, token).catch(() => null)

  if (!invite) {
    renderExpired(res)
    return
  }

  const flashMsg = typeof req.query.err === 'string' ? req.query.err : ''
  const flash =
    flashMsg === 'weak'
      ? { kind: 'err' as const, text: 'Password does not meet strength requirements.' }
      : flashMsg === 'mismatch'
        ? { kind: 'err' as const, text: 'Passwords do not match.' }
        : flashMsg === 'server'
          ? { kind: 'err' as const, text: 'Could not complete signup. Please try again.' }
          : null

  const content = `
    <div style="max-width:460px;margin:40px auto">
      <h2 style="margin:0 0 4px;font-size:18px">You're invited to Gbox Support</h2>
      <p style="color:var(--text-muted);margin:0 0 20px;font-size:13px">
        Email: <strong>${esc(invite.email)}</strong><br>
        Role: <strong>${esc(PRESET_LABEL[invite.preset] ?? invite.preset)}</strong>
      </p>
      ${
        invite.message
          ? `<div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:20px;font-size:13px;color:var(--text-muted)">
               <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Message from the team</div>
               ${esc(invite.message).replaceAll('\n', '<br>')}
             </div>`
          : ''
      }
      <form method="post" action="/invite/${esc(token)}" style="display:flex;flex-direction:column;gap:14px">
        <div>
          <label for="display_name">Display name</label>
          <input id="display_name" name="display_name" type="text" value="${esc(invite.displayName)}" required maxlength="60">
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">This is the name sellers see. Keep it first-name only, e.g. "Minh".</div>
        </div>
        <div>
          <label for="password">Choose a password</label>
          <input id="password" name="password" type="password" autocomplete="new-password" required minlength="10">
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">At least 10 characters, with a number, uppercase letter, and symbol.</div>
        </div>
        <div>
          <label for="password_confirm">Confirm password</label>
          <input id="password_confirm" name="password_confirm" type="password" autocomplete="new-password" required minlength="10">
        </div>
        <button type="submit" class="btn">Accept and sign in</button>
      </form>
    </div>
  `
  res
    .status(200)
    .type('html')
    .send(
      staffLayout({
        title: 'Accept invitation',
        user: null,
        activePage: 'none',
        content,
        flash,
      }),
    )
}

export async function postInvite(
  req: Request,
  res: Response,
  db: any,
): Promise<void> {
  const token = String(req.params.token ?? '')
  const invite = await findValidInvitation(db, token).catch(() => null)
  if (!invite) {
    renderExpired(res)
    return
  }

  const displayName = String(req.body?.display_name ?? invite.displayName).trim().slice(0, 60)
  const password = String(req.body?.password ?? '')
  const passwordConfirm = String(req.body?.password_confirm ?? '')

  if (password !== passwordConfirm) {
    res.redirect(`/invite/${encodeURIComponent(token)}?err=mismatch`)
    return
  }
  const strength = validatePasswordStrength(password)
  if (!strength.valid) {
    res.redirect(`/invite/${encodeURIComponent(token)}?err=weak`)
    return
  }

  const passwordHash = await hashPassword(password)
  const email = normalizeEmail(invite.email)

  try {
    const userId = await db.transaction().execute(async (trx: any) => {
      // 1. Upsert users row. If an existing row matches, update it.
      const existing = await (trx as any)
        .selectFrom('users')
        .select(['id', 'status'])
        .where('email', '=', email)
        .executeTakeFirst()
      let uid: string
      if (existing) {
        uid = String(existing.id)
        await (trx as any)
          .updateTable('users')
          .set({
            password_hash: passwordHash,
            name: displayName,
            status: 'active',
          })
          .where('id', '=', uid)
          .execute()
      } else {
        const ins = await (trx as any)
          .insertInto('users')
          .values({
            email,
            password_hash: passwordHash,
            name: displayName,
            role: 'staff',
            status: 'active',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        uid = String(ins.id)
      }

      // 2. Upsert support_agent_profiles row.
      const existingProfile = await (trx as any)
        .selectFrom('support_agent_profiles')
        .select(['user_id'])
        .where('user_id', '=', uid)
        .executeTakeFirst()
      if (existingProfile) {
        await (trx as any)
          .updateTable('support_agent_profiles')
          .set({
            display_name: displayName,
            preset: invite.preset,
            is_active: true,
          })
          .where('user_id', '=', uid)
          .execute()
      } else {
        await (trx as any)
          .insertInto('support_agent_profiles')
          .values({
            user_id: uid,
            display_name: displayName,
            preset: invite.preset,
            is_active: true,
          })
          .execute()
      }

      // 3. Flip invitation.
      await acceptInvitation(trx as any, {
        invitationId: invite.id,
        userId: uid,
      })

      return uid
    })

    logStaffAction(db, {
      actorUserId: userId,
      actorPreset: invite.preset,
      action: 'invite.accept',
      targetUserId: userId,
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
      details: { email, preset: invite.preset },
    }).catch(() => {})

    // 4. Issue session cookie — auto sign-in the new agent.
    const { token: sessionToken } = await createSession(db, userId, {
      ipAddress: req.ip ?? undefined,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? undefined,
    })
    const cookieOpts = getSessionCookieOptions(isProduction())
    res.setHeader('Set-Cookie', serializeSessionCookie(sessionToken, cookieOpts))
    res.redirect('/inbox')
  } catch (err) {
    logStaffAction(db, {
      actorUserId: null,
      actorPreset: invite.preset,
      action: 'invite.accept',
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
      details: { error: (err as Error).message, email },
    }).catch(() => {})
    res.redirect(`/invite/${encodeURIComponent(token)}?err=server`)
  }
}

function renderExpired(res: Response): void {
  res
    .status(400)
    .type('html')
    .send(
      staffLayout({
        title: 'Link expired',
        user: null,
        activePage: 'none',
        content: `
          <div style="max-width:420px;margin:60px auto;text-align:center">
            <h2 style="margin:0 0 10px;font-size:18px">This invitation link is no longer valid</h2>
            <p style="color:var(--text-muted);font-size:13px">It may have expired, been revoked, or already been used. Please contact the person who invited you for a fresh link.</p>
          </div>
        `,
      }),
    )
}
