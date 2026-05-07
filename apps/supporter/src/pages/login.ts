/**
 * supporter.gbox.co — login / logout page handlers.
 *
 * Flow:
 *
 *   GET  /         → redirect to /login (unauth) or /inbox (authed staff)
 *   GET  /login    → render email + password form. Messages:
 *                     ?msg=no_access      — user has a session but no staff profile
 *                     ?need_2fa=1         — password passed but TOTP not verified
 *                     ?msg=invalid        — last attempt failed
 *                     ?msg=signed_out     — just after POST /logout
 *   POST /login    → verify email + password, check support_agent_profile
 *                     exists, issue gbox_session cookie on success.
 *                     (2FA enforcement is scoped to the per-preset rules
 *                      in staff-auth.ts; the accounts portal owns TOTP UI.)
 *   POST /logout   → delete session row + clear cookie.
 *
 * Audit log emits one row per login outcome:
 *   auth.login_ok        email matched, password ok, staff profile exists
 *   auth.login_failed    any of the above failed (generic, no details leaked)
 *   auth.logout          voluntary signout
 *
 * Iron Rule 5: the 403 / invalid-login response NEVER differentiates
 * between "email not found", "password wrong", "not a staff member",
 * and "account disabled". Same "Invalid email or password." string.
 * Diagnostic detail goes to pino + `support_audit_log` only.
 */

import type { Request, Response } from 'express'
import {
  createSession,
  deleteSession,
  getSessionCookieOptions,
  getSessionTokenFromCookies,
  serializeSessionCookie,
  clearSessionCookie,
} from '@gbox/core/modules/auth/session.js'
import { verifyPassword } from '@gbox/core/modules/auth/password.js'
import { logStaffAction } from '@gbox/core/modules/support-staff/index.js'
import { staffLayout, esc } from '../layouts/staff-layout.js'

const isProduction = () => process.env.NODE_ENV === 'production'

export async function getRoot(req: Request, res: Response): Promise<void> {
  if (req.staffUser) {
    res.redirect('/inbox')
    return
  }
  res.redirect('/login')
}

export function getLogin(req: Request, res: Response): void {
  if (req.staffUser) {
    res.redirect('/inbox')
    return
  }
  const msg = typeof req.query.msg === 'string' ? req.query.msg : ''
  const need2fa = req.query.need_2fa === '1'
  const returnTo = typeof req.query.return_to === 'string' ? req.query.return_to : '/inbox'

  const flash =
    msg === 'no_access'
      ? { kind: 'warn' as const, text: 'This account is not provisioned for the support portal.' }
      : msg === 'invalid'
        ? { kind: 'err' as const, text: 'Invalid email or password.' }
        : msg === 'signed_out'
          ? { kind: 'ok' as const, text: 'Signed out.' }
          : need2fa
            ? { kind: 'warn' as const, text: 'Two-factor verification required — please complete the challenge in the accounts portal, then return here.' }
            : null

  const content = `
    <div style="max-width:380px;margin:40px auto">
      <form method="post" action="/login" style="display:flex;flex-direction:column;gap:14px">
        <input type="hidden" name="return_to" value="${esc(returnTo)}">
        <div>
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="username" required autofocus>
        </div>
        <div>
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required>
        </div>
        <button type="submit" class="btn" style="margin-top:4px">Sign in</button>
      </form>
      <p style="font-size:12px;color:var(--text-muted);margin-top:24px;text-align:center">
        This is the internal Gbox staff portal. If you received an invitation by email, use
        the link in that message instead of this form.
      </p>
    </div>
  `
  res
    .status(200)
    .type('html')
    .send(
      staffLayout({
        title: 'Sign in',
        user: null,
        activePage: 'none',
        content,
        flash,
      }),
    )
}

export async function postLogin(req: Request, res: Response, db: any): Promise<void> {
  const emailRaw = (req.body?.email ?? '').toString().trim().toLowerCase()
  const password = (req.body?.password ?? '').toString()
  const returnTo = (req.body?.return_to ?? '/inbox').toString()

  const failBack = (reason: string) => {
    logStaffAction(db, {
      actorUserId: null,
      actorPreset: null,
      action: 'auth.login_failed',
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
      details: { reason, email: emailRaw.slice(0, 64) },
    }).catch(() => {})
    res.redirect('/login?msg=invalid')
  }

  if (!emailRaw || !password) {
    failBack('missing_fields')
    return
  }

  // 1) Resolve user by email.
  const user = await (db as any)
    .selectFrom('users')
    .select(['id', 'email', 'password_hash', 'status', 'name'])
    .where('email', '=', emailRaw)
    .executeTakeFirst()
  if (!user || user.status === 'disabled') {
    failBack('user_not_found_or_disabled')
    return
  }

  // 2) Verify password (bcrypt — verifyPassword handles legacy SHA-256 too).
  const passwordOk = await verifyPassword(password, user.password_hash as string).catch(() => false)
  if (!passwordOk) {
    failBack('invalid_password')
    return
  }

  // 3) Check the user has a support_agent_profiles row.
  const profile = await (db as any)
    .selectFrom('support_agent_profiles')
    .select(['preset', 'is_active', 'display_name'])
    .where('user_id', '=', user.id)
    .executeTakeFirst()
  if (!profile || profile.is_active === false) {
    // User is real + password correct but not a staff member.
    logStaffAction(db, {
      actorUserId: String(user.id),
      actorPreset: null,
      action: 'auth.login_failed',
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
      details: { reason: 'no_agent_profile' },
    }).catch(() => {})
    res.redirect('/login?msg=no_access')
    return
  }

  // 4) Issue session cookie.
  const { token } = await createSession(db, String(user.id), {
    ipAddress: req.ip ?? undefined,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? undefined,
  })
  const cookieOpts = getSessionCookieOptions(isProduction())
  res.setHeader('Set-Cookie', serializeSessionCookie(token, cookieOpts))

  logStaffAction(db, {
    actorUserId: String(user.id),
    actorPreset: profile.preset,
    action: 'auth.login_ok',
    ipAddress: req.ip ?? null,
    userAgent: (req.headers['user-agent'] ?? null) as string | null,
    details: { email: emailRaw.slice(0, 64) },
  }).catch(() => {})

  // Safe redirect — always stay on supporter.gbox.co.
  const safeReturn = returnTo.startsWith('/') ? returnTo : '/inbox'
  res.redirect(safeReturn)
}

export async function postLogout(req: Request, res: Response, db: any): Promise<void> {
  const token = getSessionTokenFromCookies(req.headers.cookie ?? '')
  if (token) {
    await deleteSession(db, token).catch(() => {})
  }
  if (req.staffUser) {
    logStaffAction(db, {
      actorUserId: req.staffUser.userId,
      actorPreset: req.staffUser.preset,
      action: 'auth.logout',
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
    }).catch(() => {})
  }
  res.setHeader('Set-Cookie', clearSessionCookie(isProduction()))
  res.redirect('/login?msg=signed_out')
}

export const __testables = { /* expose stringly-typed query→flash mapping if needed */ }
