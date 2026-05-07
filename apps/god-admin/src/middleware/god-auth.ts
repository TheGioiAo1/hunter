/**
 * God Admin — Authentication Middleware
 *
 * Protects ALL /god-admin/* routes (except /god-admin/login).
 * Only the seeded Default God Admin (level 0, is_default_admin=true)
 * can access — per CLAUDE.md Rule 2. Uses the shared admin-levels
 * helper as the single source of truth.
 *
 * Flow:
 *   1. Skip if path is /god-admin/login or /god-admin/logout (public)
 *   2. Read gbox_session cookie
 *   3. Validate session via shared session module
 *   4. Fetch is_default_admin flag from DB
 *   5. Call isGodAdmin({ userRole, isDefaultAdmin })
 *   6. If not God Admin -> 403
 *   7. If no session -> redirect to /god-admin/login
 *   8. Attach { user, session, isDefaultAdmin, levelLabel } to req.godAdmin
 */

import { createHash } from 'crypto'
import type { Request, Response, NextFunction } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import type { SessionData, SessionUser } from '../../../../packages/core/src/modules/auth/session.js'
import {
  getSessionTokenFromCookies,
  validateSession,
  deleteSession,
  clearSessionCookie,
} from '../../../../packages/core/src/modules/auth/session.js'
import {
  isGodAdmin,
  describeAdminLevel,
} from '../../../../packages/core/src/modules/auth/admin-levels.js'
import {
  getSessionTwoFaVerified,
  isTwoFactorEnabled,
} from '../../../../packages/core/src/modules/auth/two-factor.js'
import {
  parseCidrList,
  ipInAllowlist,
  normaliseRequestIp,
} from '../../../../packages/core/src/modules/auth/ip-allowlist.js'
import {
  cacheGet,
  cacheSet,
} from '../../../../packages/core/src/modules/cache/redis.js'
import {
  isDevSessionToken,
  getDevMockUser,
  getDevMockSession,
} from '../lib/dev-bypass.js'

// ---------------------------------------------------------------------------
// God-admin session TTL policy (stricter than the shared 30-day sliding
// window that serves customers / sellers). A platform-admin cookie that
// stayed valid for a month would be a standing compromise window — so
// we clamp it here:
//
//   GOD_ABSOLUTE_TTL_MS — maximum lifetime from session creation.
//                         After this the cookie is dead even if the
//                         admin was active until the last second.
//   GOD_IDLE_TTL_MS     — maximum gap between requests on the same
//                         cookie. Tracked in Redis as
//                         `god-idle:<sha256(token)>`.
//
// Both are enforced in godAuth. Tunable via env (GOD_ABS_TTL_MINUTES,
// GOD_IDLE_TTL_MINUTES) so ops can tighten during an incident without a
// redeploy.
// ---------------------------------------------------------------------------

function envMinutesMs(name: string, defaultMinutes: number): number {
  const raw = process.env[name]
  const n = raw ? parseInt(raw, 10) : NaN
  const minutes = Number.isFinite(n) && n > 0 ? n : defaultMinutes
  return minutes * 60 * 1000
}

const GOD_ABSOLUTE_TTL_MS = envMinutesMs('GOD_ABS_TTL_MINUTES', 8 * 60)   // 8h default
const GOD_IDLE_TTL_MS = envMinutesMs('GOD_IDLE_TTL_MINUTES', 2 * 60)      // 2h default

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

// ---------------------------------------------------------------------------
// Extend Express Request
// ---------------------------------------------------------------------------

export interface GodAdminContext {
  user: SessionUser
  session: SessionData
  isDefaultAdmin: boolean
  /** Human-readable admin level label, e.g. "God Admin" — filled in by middleware. */
  levelLabel: string
}

declare global {
  namespace Express {
    interface Request {
      godAdmin?: GodAdminContext
    }
  }
}

// ---------------------------------------------------------------------------
// 403 Page
// ---------------------------------------------------------------------------

function render403(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access Denied - Gbox God Admin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #0f172a;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #e2e8f0;
    }
    .container {
      text-align: center;
      max-width: 480px;
      padding: 40px;
    }
    .shield {
      font-size: 64px;
      margin-bottom: 24px;
      opacity: 0.6;
    }
    h1 {
      font-size: 28px;
      font-weight: 700;
      color: #ef4444;
      margin-bottom: 12px;
    }
    p {
      color: #94a3b8;
      font-size: 15px;
      line-height: 1.6;
      margin-bottom: 24px;
    }
    .code {
      font-size: 13px;
      color: #64748b;
      font-family: 'SF Mono', Monaco, monospace;
    }
    a {
      color: #3b82f6;
      text-decoration: none;
    }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="shield">&#128274;</div>
    <h1>Access Denied</h1>
    <p>God Admin Only &mdash; This area is restricted to the Default God Admin (level 0).<br>
    Your current role does not have permission to access this dashboard.</p>
    <!--
      IMPORTANT: this MUST point to /god-admin/logout, NOT /god-admin/login.
      At this point the visitor is holding a valid session cookie for a
      non-default-admin owner — sending them to /login would let
      getGodLogin auto-redirect them back to /god-admin on the mere
      presence of role='owner', which bounces into this 403 again and
      creates a permanent loop. /logout deletes the sessions row, evicts
      the Redis cache and clears the cookie before redirecting to the
      login form, so they land clean.
    -->
    <p><a href="/god-admin/logout">Sign out &amp; back to Login</a></p>
    <div class="code">HTTP 403 Forbidden</div>
  </div>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// 403 Page — IP allowlist denial (Phase 0 §8 Item #4)
// ---------------------------------------------------------------------------

function renderIpDenied(clientIp: string | null): string {
  const escaped = (clientIp ?? 'unknown')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access Denied - IP Not Allowed</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #e2e8f0;
    }
    .container { text-align: center; max-width: 520px; padding: 40px; }
    .shield { font-size: 64px; margin-bottom: 24px; opacity: 0.6; }
    h1 { font-size: 28px; font-weight: 700; color: #f59e0b; margin-bottom: 12px; }
    p { color: #94a3b8; font-size: 15px; line-height: 1.6; margin-bottom: 16px; }
    .ip {
      display: inline-block;
      padding: 6px 12px;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 6px;
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 13px;
      color: #f1f5f9;
    }
    .code { font-size: 13px; color: #64748b; font-family: 'SF Mono', Monaco, monospace; margin-top: 16px; }
    a { color: #3b82f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="shield">&#128737;</div>
    <h1>IP Not Allowed</h1>
    <p>Your account has an IP allowlist configured and this request did not originate from an approved network.</p>
    <p>Your IP: <span class="ip">${escaped}</span></p>
    <p>If this is unexpected, sign in from an allowlisted network or ask ops to update the allowlist.</p>
    <p><a href="/god-admin/logout">Sign out</a></p>
    <div class="code">HTTP 403 Forbidden &middot; allowlist</div>
  </div>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Middleware Factory
// ---------------------------------------------------------------------------

export function createGodAuthMiddleware(db: Kysely<Database>) {
  return async function godAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Skip auth for login and logout routes
    if (req.path === '/login' || req.path === '/logout') {
      next()
      return
    }

    // The 2FA challenge pages run on a "pending 2FA" session — they
    // validate the session themselves and own their own guard, so skip
    // the dashboard-gate here. Same for /logout (already skipped above).
    const isTwoFaChallengePath =
      req.path === '/login/2fa' ||
      req.path.startsWith('/login/2fa/')
    if (isTwoFaChallengePath) {
      next()
      return
    }

    const cookieHeader = req.headers.cookie ?? ''
    const token = getSessionTokenFromCookies(cookieHeader)

    // No session cookie -> redirect to God Admin login
    if (!token) {
      const returnTo = encodeURIComponent(req.originalUrl)
      res.redirect(`/god-admin/login?return_to=${returnTo}`)
      return
    }

    // DEV-ONLY BYPASS — token được mint từ login bypass có prefix riêng,
    // skip validateSession + DB query is_default_admin. Page handler
    // downstream nào touch DB sẽ tự crash riêng (out of scope bypass này).
    if (isDevSessionToken(token)) {
      req.godAdmin = {
        user: getDevMockUser(),
        session: getDevMockSession(),
        isDefaultAdmin: true,
        levelLabel: 'Dev God Admin (BYPASS)',
      }
      next()
      return
    }

    // Validate the session
    const result = await validateSession(db, token)

    if (!result.valid || !result.session) {
      const returnTo = encodeURIComponent(req.originalUrl)
      res.redirect(`/god-admin/login?return_to=${returnTo}`)
      return
    }

    // ---------------------------------------------------------------------
    // God-admin-specific TTL enforcement
    //
    // The shared validateSession() above accepts any unexpired row from
    // the `sessions` table (30-day sliding window — fine for customers
    // / sellers). For god-admin we add a stricter gate:
    //
    //   1. Absolute lifetime (default 8h from createdAt). Hard cutoff
    //      regardless of activity — forces a fresh password + 2FA at
    //      least daily.
    //   2. Idle timeout (default 2h since last request on this cookie).
    //      Tracked in Redis so it's zero-cost on cache hit.
    //
    // If either limit is exceeded, we delete the DB session, clear the
    // cookie, and redirect to /login with a reason hint (login page can
    // render a small banner — "your session expired, please sign in").
    //
    // Fail-safe: if Redis is unreachable the idle check is SKIPPED with
    // a warning. The absolute check always runs because it uses only
    // session.createdAt which validateSession already hydrated. Never
    // block a legitimate god admin because Redis is slow.
    // ---------------------------------------------------------------------

    const tokenHash = createHash('sha256').update(token).digest('hex')
    const absoluteAgeMs = Date.now() - new Date(result.session.createdAt).getTime()

    if (absoluteAgeMs > GOD_ABSOLUTE_TTL_MS) {
      await deleteSession(db, token).catch(() => {})
      res.setHeader('Set-Cookie', clearSessionCookie(isProduction()))
      const returnTo = encodeURIComponent(req.originalUrl)
      res.redirect(`/god-admin/login?return_to=${returnTo}&reason=expired`)
      return
    }

    const idleKey = `god-idle:${tokenHash}`
    try {
      const lastActive = await cacheGet<number>(idleKey)
      if (
        typeof lastActive === 'number' &&
        Date.now() - lastActive > GOD_IDLE_TTL_MS
      ) {
        await deleteSession(db, token).catch(() => {})
        res.setHeader('Set-Cookie', clearSessionCookie(isProduction()))
        const returnTo = encodeURIComponent(req.originalUrl)
        res.redirect(`/god-admin/login?return_to=${returnTo}&reason=idle`)
        return
      }
      // Refresh the idle marker. TTL set slightly above the policy so a
      // request right at the edge doesn't get false-positive rejected.
      await cacheSet(
        idleKey,
        Date.now(),
        Math.ceil((GOD_IDLE_TTL_MS + 60_000) / 1000),
      )
    } catch (err) {
      console.warn(
        '[god-auth] idle-timeout redis unavailable — skipping:',
        (err as Error).message,
      )
    }

    // Fetch is_default_admin flag — required for the God Admin gate.
    // Bug fix (Phase 0 Step 0.2): the old middleware only checked
    // user.role==='owner', which allowed Platform Admins (role='owner'
    // but is_default_admin=false) to access God Admin routes. Per
    // CLAUDE.md Rule 2, only Level 0 (is_default_admin=true) may
    // access this app.
    const userRow = await db
      .selectFrom('users')
      .select(['is_default_admin', 'ip_allowlist'])
      .where('id', '=', result.session.user.id)
      .executeTakeFirst()

    const isDefaultAdmin = userRow?.is_default_admin === true

    // CRITICAL gate: MUST be the seeded Default God Admin. Uses the
    // shared admin-levels helper (single source of truth for
    // Rule 2 hierarchy — see packages/core/src/modules/auth/admin-levels.ts).
    if (
      !isGodAdmin({
        userRole: result.session.user.role,
        isDefaultAdmin,
      })
    ) {
      res.status(403).send(render403())
      return
    }

    // ---------------------------------------------------------------------
    // Phase 0.6: 2FA gate
    //
    // If the user has 2FA enrolled, the sessions row must have
    // two_fa_verified=true to access any dashboard URL. Otherwise the
    // user was authenticated with a password only (step 1 of 2) and we
    // must bounce them to /god-admin/login/2fa until they complete the
    // challenge.
    //
    // We read two_fa_verified directly from the sessions row rather
    // than from the session user object because it's a per-SESSION
    // state, not a per-USER state — and it has to survive a full
    // dashboard browse without another DB query. For now we accept the
    // extra DB roundtrip; can cache later.
    // ---------------------------------------------------------------------
    const twoFaEnabled = await isTwoFactorEnabled(db, result.session.user.id)
    if (twoFaEnabled) {
      const verified = await getSessionTwoFaVerified(db, token)
      if (!verified) {
        const returnTo = encodeURIComponent(req.originalUrl)
        res.redirect(`/god-admin/login/2fa?return_to=${returnTo}`)
        return
      }
    }

    // ---------------------------------------------------------------------
    // Phase 0 §8 Item #4: IP allowlist gate
    //
    // `users.ip_allowlist` is a JSONB array of CIDR strings. NULL or an
    // empty array means the allowlist is disabled — God Admin can sign
    // in from anywhere (default behaviour). A non-empty array means the
    // request IP MUST match at least one CIDR, otherwise we 403.
    //
    // We intentionally enforce this AFTER the 2FA gate so the user can
    // still reach the 2FA challenge page from an allowlisted IP if they
    // raced a misconfiguration; the /login and /login/2fa paths were
    // short-circuited above.
    //
    // If parsing a stored CIDR fails we refuse the request — a broken
    // allowlist should fail closed. The god admin can always fix it via
    // CLI once they realise something is wrong (the error is logged).
    // ---------------------------------------------------------------------
    const rawAllowlist = userRow?.ip_allowlist as string[] | null | undefined
    if (Array.isArray(rawAllowlist) && rawAllowlist.length > 0) {
      const parsed = parseCidrList(rawAllowlist)
      if (parsed.errors.length > 0) {
        console.error(
          '[god-auth] ip_allowlist contains invalid CIDRs for user',
          result.session.user.id,
          parsed.errors,
        )
      }
      const clientIp = normaliseRequestIp(req.ip ?? null)
      if (!clientIp || !ipInAllowlist(clientIp, parsed.valid)) {
        console.warn(
          '[god-auth] IP allowlist denied',
          { userId: result.session.user.id, clientIp, path: req.path },
        )
        res.status(403).send(renderIpDenied(clientIp))
        return
      }
    }

    // Attach god admin context to request. `describeAdminLevel` is
    // exported for logging/UI surfaces that want the human-readable
    // label ("God Admin", "Platform Admin", etc.) without a role switch.
    req.godAdmin = {
      user: result.session.user,
      session: result.session,
      isDefaultAdmin,
      levelLabel: describeAdminLevel({
        userRole: result.session.user.role,
        isDefaultAdmin,
      }),
    }

    next()
  }
}
