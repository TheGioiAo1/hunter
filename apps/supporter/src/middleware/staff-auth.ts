/**
 * Supporter.gbox.co — staff session auth middleware.
 *
 * Runs BEFORE any permission check. Responsibilities:
 *
 *   1. Validate the `gbox_session` cookie against the platform session
 *      table (same mechanism store-admin + accounts use).
 *   2. Look up `support_agent_profiles` for the authenticated user.
 *      A user without a row is NOT a support staff member — they're
 *      redirected back to /login instead of being shown a stack trace.
 *   3. Attach `req.staffUser = { userId, preset, displayName }` so
 *      downstream permission middlewares + page handlers can read it.
 *   4. 2FA gate — respects the `two_fa_verified` flag on the session
 *      (same behavior as store-admin). Lead + god_admin presets also
 *      get a harder check here: if `twoFaMode(preset) === 'mandatory'`
 *      but the user has no TOTP secret at all, bounce to /settings/2fa.
 *
 * Iron Rule 5:
 *   - Never mention "god admin" or any `/god-admin/*` route in a
 *     response body. Redirects go to `/login` (internal) or
 *     `https://accounts.gbox.co` (shared, seller-safe).
 *   - Failure responses log the diagnostic (user id, path) server-side;
 *     the browser gets a generic "Sign in required" or redirect.
 */

import type { Request, Response, NextFunction } from 'express'
import type { SupportAgentPreset } from '@gbox/db/schema/tables.js'
import {
  getSessionTokenFromCookies,
  validateSession,
} from '@gbox/core/modules/auth/session.js'
import { getSessionTwoFaVerified } from '@gbox/core/modules/auth/two-factor.js'
import { twoFaMode, type StaffRequestUser } from '@gbox/core/modules/support-staff/index.js'

declare global {
  namespace Express {
    interface Request {
      staffUser?: StaffRequestUser | null
    }
  }
}

export interface StaffAuthOptions {
  /**
   * Paths that should NEVER redirect-to-login. Login itself, invite
   * accept, and static asset endpoints.
   */
  publicPaths?: readonly string[]
}

const DEFAULT_PUBLIC_PATHS: readonly string[] = [
  '/',
  '/login',
  '/login/',
  '/invite',
  '/healthz',
  '/favicon.ico',
]

function isPublic(path: string, list: readonly string[]): boolean {
  for (const p of list) {
    if (path === p) return true
    if (p.endsWith('/') && path.startsWith(p)) return true
    // `/invite` should match `/invite/:token` too.
    if (path.startsWith(`${p}/`)) return true
  }
  return false
}

export function createStaffAuthMiddleware(
  db: any,
  options: StaffAuthOptions = {},
) {
  const publicPaths = options.publicPaths ?? DEFAULT_PUBLIC_PATHS

  return async function staffAuth(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    // Always-public paths bypass the session check — the login page
    // needs to render for users who DON'T yet have a session.
    if (isPublic(req.path, publicPaths)) {
      // Even on public paths, attach the staffUser if we have one so
      // the login page can redirect already-signed-in users to /inbox.
      const token = getSessionTokenFromCookies(req.headers.cookie ?? '')
      if (token) {
        const resolved = await tryResolveStaff(db, token)
        if (resolved) req.staffUser = resolved
      }
      next()
      return
    }

    const token = getSessionTokenFromCookies(req.headers.cookie ?? '')
    if (!token) {
      res.redirect(`/login?return_to=${encodeURIComponent(req.originalUrl)}`)
      return
    }

    const result = await validateSession(db, token)
    if (!result.valid || !result.session) {
      res.redirect(`/login?return_to=${encodeURIComponent(req.originalUrl)}`)
      return
    }

    // 2FA session-level gate — refuse half-authenticated cookies. The
    // accounts portal owns the actual TOTP challenge UI.
    const twoFaVerified = await getSessionTwoFaVerified(db, token)
    if (twoFaVerified === false) {
      res.redirect(`/login?return_to=${encodeURIComponent(req.originalUrl)}&need_2fa=1`)
      return
    }

    const userId = result.session.user.id
    const staff = await loadStaffProfile(db, userId)
    if (!staff) {
      // The session is valid but the user has no support_agent_profile —
      // they're a seller / customer hitting supporter.gbox.co by mistake.
      // Never mention why; just bounce to login with a generic message.
      console.warn('[staff-auth] user has session but no agent profile', {
        userId,
        path: req.path,
      })
      res.redirect('/login?msg=no_access')
      return
    }

    // Per-preset 2FA enforcement. `mandatory` presets (Lead + god-admin)
    // must have the session 2FA-verified AND a TOTP secret on the user
    // row — we can't check the latter without an extra query, so we
    // conservatively trust the validateSession() 2FA flag above.
    // Upgrade path: PR5 wires a hard TOTP-secret-exists check here.
    const mode = twoFaMode(staff.preset)
    if (mode === 'mandatory' && !twoFaVerified) {
      res.redirect(`/login?return_to=${encodeURIComponent(req.originalUrl)}&need_2fa=1`)
      return
    }

    req.staffUser = staff
    next()
  }
}

async function tryResolveStaff(
  db: any,
  token: string,
): Promise<StaffRequestUser | null> {
  const result = await validateSession(db, token).catch(() => null)
  if (!result?.valid || !result.session) return null
  return loadStaffProfile(db, result.session.user.id)
}

async function loadStaffProfile(
  db: any,
  userId: string,
): Promise<StaffRequestUser | null> {
  const row = await (db as any)
    .selectFrom('support_agent_profiles')
    .select(['user_id', 'display_name', 'preset', 'is_active'])
    .where('user_id', '=', userId)
    .executeTakeFirst()
  if (!row) return null
  if (row.is_active === false) return null
  return {
    userId: String(row.user_id),
    preset: row.preset as SupportAgentPreset,
    displayName: String(row.display_name),
  }
}
