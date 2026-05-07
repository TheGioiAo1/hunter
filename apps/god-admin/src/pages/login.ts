/**
 * God Admin — Isolated Login Page
 *
 * GET  /god-admin/login  — Render login form with CSRF token
 * POST /god-admin/login  — Validate credentials, create session, redirect to dashboard
 *
 * Security: CSRF, rate limiting (5/min), bcrypt, audit logging, anti-enumeration.
 * ONLY role='owner' can login here.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'

import { hashPassword, verifyPassword, isLegacyHash } from '../../../../packages/core/src/modules/auth/password.js'
// Phase 0.4b-redis: shared CSRF store (auto-selects Redis backend via
// REDIS_URL) so the god-admin login form works under pm2 cluster mode.
import { createCsrfStore } from '@gbox/core/modules/auth/csrf-express.js'
import { checkRateLimit, resetRateLimit } from '../../../../packages/core/src/modules/auth/rate-limit.js'
import { logAuditEvent } from '../../../../packages/core/src/modules/auth/audit.js'
import {
  createSession,
  getSessionCookieOptions,
  serializeSessionCookie,
  getSessionTokenFromCookies,
  validateSession,
  deleteSession,
  clearSessionCookie,
} from '../../../../packages/core/src/modules/auth/session.js'
import {
  isTwoFactorEnabled,
  markSessionTwoFaPending,
} from '../../../../packages/core/src/modules/auth/two-factor.js'
import {
  isDevBypassEnabled,
  verifyDevCredentials,
  mintDevSessionToken,
} from '../lib/dev-bypass.js'

// ---------------------------------------------------------------------------
// Module-level CSRF store — auto-Redis when REDIS_URL set.
// ---------------------------------------------------------------------------

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_god_login' })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function getClientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown'
}

// ---------------------------------------------------------------------------
// Render Login Page
// ---------------------------------------------------------------------------

function renderLoginPage(csrfToken: string, error?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>God Admin Login - Gbox Platform</title>
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

    .login-container {
      width: 100%;
      max-width: 420px;
      padding: 24px;
    }

    /* Logo Section */
    .logo-section {
      text-align: center;
      margin-bottom: 40px;
    }

    .logo {
      font-size: 32px;
      font-weight: 800;
      color: #ffffff;
      letter-spacing: -1px;
      margin-bottom: 8px;
    }

    .logo span { color: #3b82f6; }

    .god-badge {
      display: inline-block;
      background: linear-gradient(135deg, #ef4444, #f97316);
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      padding: 3px 10px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 12px;
    }

    .login-subtitle {
      color: #64748b;
      font-size: 14px;
    }

    /* Card */
    .login-card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 16px;
      padding: 32px;
    }

    .login-card h2 {
      font-size: 20px;
      font-weight: 700;
      color: #f1f5f9;
      margin-bottom: 24px;
      text-align: center;
    }

    /* Error */
    .error-msg {
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #fca5a5;
      padding: 12px 16px;
      border-radius: 10px;
      font-size: 13px;
      margin-bottom: 20px;
      line-height: 1.5;
    }

    /* Form */
    .form-group {
      margin-bottom: 20px;
    }

    .form-group label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: #94a3b8;
      margin-bottom: 6px;
      letter-spacing: 0.3px;
    }

    .form-group input {
      width: 100%;
      padding: 12px 16px;
      background: #0f172a;
      border: 1.5px solid #334155;
      border-radius: 10px;
      color: #e2e8f0;
      font-size: 14px;
      font-family: inherit;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }

    .form-group input:focus {
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
    }

    .form-group input::placeholder { color: #475569; }

    /* Submit Button */
    .btn-login {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #3b82f6, #2563eb);
      color: #ffffff;
      border: none;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 700;
      font-family: inherit;
      cursor: pointer;
      transition: opacity 0.2s, transform 0.1s;
      margin-top: 8px;
    }

    .btn-login:hover { opacity: 0.9; }
    .btn-login:active { transform: scale(0.98); }

    /* Footer */
    .login-footer {
      text-align: center;
      margin-top: 24px;
      color: #475569;
      font-size: 12px;
    }

    .login-footer a {
      color: #3b82f6;
      text-decoration: none;
    }

    .login-footer a:hover { text-decoration: underline; }

    /* Security badge */
    .security-info {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      margin-top: 20px;
      color: #475569;
      font-size: 11px;
    }

    .security-info svg { opacity: 0.5; }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="logo-section">
      <div class="logo">G<span>box</span></div>
      <div class="god-badge">God Admin</div>
      <div class="login-subtitle">Platform Management System</div>
    </div>

    <div class="login-card">
      <h2>Sign in</h2>

      ${error ? `<div class="error-msg">${error}</div>` : ''}

      <form method="POST" action="/god-admin/login">
        ${csrfStore.hiddenField(csrfToken)}

        <div class="form-group">
          <label for="email">Email address</label>
          <input type="email" id="email" name="email" placeholder="admin@gbox.co" required autocomplete="email" autofocus>
        </div>

        <div class="form-group">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" placeholder="Enter your password" required autocomplete="current-password">
        </div>

        <button type="submit" class="btn-login">Sign in to God Admin</button>
      </form>
    </div>

    <div class="security-info">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      Protected by rate limiting &amp; CSRF — God Admin access only
    </div>

    <div class="login-footer">
      <a href="/">Back to Storefront</a>
    </div>
  </div>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Build a Set-Cookie header that clears the session cookie in dev/prod.
 *
 * Thin wrapper around the shared `clearSessionCookie()` helper so the
 * Domain attribute is read from `SESSION_COOKIE_DOMAIN` env var instead
 * of being hard-coded to `.gbox.co`. The old hard-code broke logout
 * whenever the platform ran under a non-gbox.co host (thaibeotit.com
 * during pre-cutover staging, future white-label tenants): the browser
 * silently dropped the Set-Cookie because its Domain didn't match the
 * request host, so the session cookie kept living on the client even
 * after the server-side row was deleted.
 *
 * The shared helper already handles Max-Age=0 + Expires=<epoch> + the
 * SameSite=Lax / HttpOnly / Secure flags.
 */
function buildSessionClearCookie(): string {
  return clearSessionCookie(isProduction())
}

/**
 * GET /god-admin/login
 *
 * Phase 0.6 bug fix: the previous implementation redirected to /god-admin
 * on the mere presence of a gbox_session cookie. That caused an infinite
 * redirect loop whenever the cookie was stale (server reinstall wiped the
 * sessions table, or the session expired) — getGodLogin would redirect to
 * /god-admin, godAuth would reject the invalid token and redirect back to
 * /god-admin/login, and round we'd go.
 *
 * Fix: actually validate the session against the DB. If it's valid AND the
 * user is a God Admin (role=owner), redirect to the dashboard. Otherwise
 * clear the stale cookie and render the login form so the user can
 * actually log in.
 *
 * Phase 0.6 follow-up: the auto-redirect branch only checked
 * `role === 'owner'`, but CLAUDE.md Rule 2 says access to this app is
 * restricted to the Default God Admin (`is_default_admin = true`). A
 * regular platform owner (role=owner, is_default_admin=false) that
 * somehow ended up at /god-admin/login with a valid cookie would be
 * redirected to /god-admin, then rejected by godAuth with the 403 page,
 * whose "Back to Login" link would bounce them straight back here →
 * permanent loop. Fixed by also checking is_default_admin before
 * auto-redirecting; anything less drops the cookie and renders the
 * login form so the user can sign in with the actual Default God Admin
 * account.
 */
export async function getGodLogin(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const token = getSessionTokenFromCookies(req.headers.cookie ?? '')

  if (token) {
    const result = await validateSession(db, token)
    if (result.valid && result.session && result.session.user.role === 'owner') {
      // Double-check is_default_admin — the session's user.role alone
      // isn't enough to get into the god dashboard (see godAuth).
      const userRow = await db
        .selectFrom('users')
        .select(['is_default_admin'])
        .where('id', '=', result.session.user.id)
        .executeTakeFirst()

      if (userRow?.is_default_admin === true) {
        // Valid Default God Admin session — go straight to the dashboard.
        res.redirect('/god-admin')
        return
      }
      // Owner but NOT the Default God Admin. Kill the stuck session so
      // the user can log in as the actual Default God Admin without
      // looping through the godAuth 403 page.
      try {
        await deleteSession(db, token)
      } catch (err) {
        console.error('[god-admin] getGodLogin deleteSession error:', err)
      }
    }
    // Stale / invalid / non-default-admin cookie → kill it so the next
    // request doesn't come back in with the same bad token.
    res.appendHeader('Set-Cookie', buildSessionClearCookie())
  }

  const csrfToken = await csrfStore.issue(res, isProduction())
  res.send(renderLoginPage(csrfToken))
}

/**
 * POST /god-admin/login
 */
export async function postGodLogin(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const ip = getClientIp(req)

  // 1. Validate CSRF
  if (!(await csrfStore.verify(req))) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(403).send(renderLoginPage(csrfToken, 'Invalid form submission. Please try again.'))
    return
  }

  // 1.5 DEV-ONLY BYPASS — chạy local khi @gbox/db chưa restore.
  // Disabled hoàn toàn khi NODE_ENV=production. Đặt TRƯỚC rate limit +
  // logAuditEvent để tránh chạm db=null khi rate exhausted hoặc audit
  // log trên đường error path. CSRF vẫn enforced ở trên.
  {
    const { email: bypassEmail, password: bypassPassword } = req.body ?? {}
    if (
      typeof bypassEmail === 'string' &&
      typeof bypassPassword === 'string' &&
      isDevBypassEnabled() &&
      verifyDevCredentials(bypassEmail, bypassPassword)
    ) {
      const token = mintDevSessionToken()
      const cookieOpts = getSessionCookieOptions(isProduction())
      res.setHeader('Set-Cookie', serializeSessionCookie(token, cookieOpts))
      try {
        await resetRateLimit(`god_login:${ip}`)
      } catch {
        /* fail-open in dev */
      }
      console.warn('[god-admin] DEV BYPASS login granted for', bypassEmail)
      res.redirect('/god-admin')
      return
    }
  }

  // 2. Rate limit (5 attempts/minute)
  const rateKey = `god_login:${ip}`
  const rateResult = await checkRateLimit(rateKey)
  if (!rateResult.allowed) {
    await logAuditEvent(db, 'login_locked', {
      ip,
      userAgent: req.headers['user-agent'],
      extra: { context: 'god_admin', retryAfter: rateResult.retryAfter },
    })

    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(429).send(renderLoginPage(csrfToken, `Too many login attempts. Try again in ${rateResult.retryAfter ?? 60} seconds.`))
    return
  }

  const { email, password } = req.body ?? {}

  if (!email || !password) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(400).send(renderLoginPage(csrfToken, 'Email and password are required.'))
    return
  }

  const emailClean = email.toLowerCase().trim()

  // 3. Find user by email
  const user = await db
    .selectFrom('users')
    .selectAll()
    .where('email', '=', emailClean)
    .executeTakeFirst()

  // 4. Anti-enumeration: generic error
  if (!user) {
    await logAuditEvent(db, 'login_failed', {
      email: emailClean,
      ip,
      userAgent: req.headers['user-agent'],
      extra: { context: 'god_admin', reason: 'user_not_found' },
    })

    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(401).send(renderLoginPage(csrfToken, 'Invalid email or password.'))
    return
  }

  // 5. MUST be role='owner' to access God Admin
  if (user.role !== 'owner') {
    await logAuditEvent(db, 'login_failed', {
      userId: user.id,
      email: emailClean,
      ip,
      userAgent: req.headers['user-agent'],
      extra: { context: 'god_admin', reason: 'not_owner' },
    })

    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(401).send(renderLoginPage(csrfToken, 'Invalid email or password.'))
    return
  }

  // 5b. MUST be the Default God Admin (is_default_admin=true) — the
  // god-auth middleware rejects anything else with a 403 Access Denied
  // page. If we create a session here and then the middleware blocks
  // the redirect, the user ends up stuck on the 403 with no way back
  // to the login form (classic bounce: /god-admin/login creates session
  // → redirects to /god-admin → godAuth 403 → Back to Login → stale
  // session auto-redirects to /god-admin → 403 again). Close the loop
  // at the POST step by refusing to mint a session for non-default
  // owners in the first place. We use the same generic "Invalid email
  // or password." message for anti-enumeration (don't leak that the
  // email exists and has owner role, just not the DEFAULT owner role).
  if (user.is_default_admin !== true) {
    await logAuditEvent(db, 'login_failed', {
      userId: user.id,
      email: emailClean,
      ip,
      userAgent: req.headers['user-agent'],
      extra: { context: 'god_admin', reason: 'not_default_admin' },
    })

    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(401).send(renderLoginPage(csrfToken, 'Invalid email or password.'))
    return
  }

  // 6. Check account status
  if (user.status === 'disabled') {
    await logAuditEvent(db, 'login_failed', {
      userId: user.id,
      email: emailClean,
      ip,
      userAgent: req.headers['user-agent'],
      extra: { context: 'god_admin', reason: 'account_disabled' },
    })

    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(403).send(renderLoginPage(csrfToken, 'This account has been suspended.'))
    return
  }

  // 7. Verify password
  if (!user.password_hash) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(401).send(renderLoginPage(csrfToken, 'No password set for this account.'))
    return
  }

  const passwordValid = await verifyPassword(password, user.password_hash)
  if (!passwordValid) {
    await logAuditEvent(db, 'login_failed', {
      userId: user.id,
      email: emailClean,
      ip,
      userAgent: req.headers['user-agent'],
      extra: { context: 'god_admin', reason: 'invalid_password' },
    })

    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(401).send(renderLoginPage(csrfToken, 'Invalid email or password.'))
    return
  }

  // 8. Auto-upgrade legacy hash
  // Phase 0 Step 0.6: emit the same breadcrumb line as accounts/login.ts
  // so we can grep `[Auth] Auto-upgraded` across all admin logs and count
  // how many God Admin accounts are still on the legacy SHA-256 format.
  if (isLegacyHash(user.password_hash)) {
    const newHash = await hashPassword(password)
    await db
      .updateTable('users')
      .set({ password_hash: newHash })
      .where('id', '=', user.id)
      .execute()
    console.log(`[Auth] Auto-upgraded password hash to bcrypt for user ${user.id}`)
  }

  // 9. Create session
  const { token } = await createSession(db, user.id, {
    ipAddress: ip,
    userAgent: req.headers['user-agent'],
  })

  // Set session cookie
  const cookieOpts = getSessionCookieOptions(isProduction())
  res.setHeader('Set-Cookie', serializeSessionCookie(token, cookieOpts))

  // Reset rate limit
  await resetRateLimit(rateKey)

  // 10. Check 2FA enrollment — if enabled, the session is created but
  // marked "pending TOTP verification". The god-auth middleware will
  // only allow /god-admin/login/2fa* paths until the second factor is
  // validated. See packages/core/src/modules/auth/two-factor.ts.
  const twoFaEnabled = await isTwoFactorEnabled(db, user.id)

  if (twoFaEnabled) {
    // Mark session as pending 2FA
    await markSessionTwoFaPending(db, token)

    await logAuditEvent(db, 'login_success', {
      userId: user.id,
      email: emailClean,
      ip,
      userAgent: req.headers['user-agent'],
      extra: { context: 'god_admin', pending_2fa: true },
    })

    // Preserve return_to across the 2FA step
    const returnToQ = typeof req.query.return_to === 'string'
      ? `?return_to=${encodeURIComponent(req.query.return_to)}`
      : ''
    res.redirect(`/god-admin/login/2fa${returnToQ}`)
    return
  }

  // 11. Audit log (no 2FA path)
  await logAuditEvent(db, 'login_success', {
    userId: user.id,
    email: emailClean,
    ip,
    userAgent: req.headers['user-agent'],
    extra: { context: 'god_admin' },
  })

  // 12. Redirect to dashboard (or return_to)
  const returnTo = typeof req.query.return_to === 'string'
    ? decodeURIComponent(req.query.return_to)
    : '/god-admin'

  // Security: only allow redirects to /god-admin paths
  const safePath = returnTo.startsWith('/god-admin') ? returnTo : '/god-admin'
  res.redirect(safePath)
}

/**
 * GET /god-admin/logout
 *
 * Phase 0.6 bug fix: the previous implementation only cleared the
 * browser cookie. If the same browser (or an attacker who grabbed the
 * cookie) replayed the token, the DB row was still there and the
 * Redis cache still had the session → user was effectively still
 * logged in. Now we:
 *
 *   1. Delete the sessions row in Postgres
 *   2. Evict the Redis cache entry for session:<tokenHash>
 *   3. Clear the cookie with both Max-Age=0 AND Expires=<epoch> so no
 *      browser decides to keep it alive
 *   4. Redirect to the login page
 *
 * deleteSession() handles (1) + (2) atomically — see
 * packages/core/src/modules/auth/session.ts.
 */
export async function getGodLogout(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const token = getSessionTokenFromCookies(req.headers.cookie ?? '')
  if (token) {
    try {
      await deleteSession(db, token)
    } catch (err) {
      // Don't block logout on a DB/Redis hiccup — we still want the
      // cookie cleared client-side. Log and continue.
      console.error('[god-admin] logout deleteSession error:', err)
    }
  }

  res.setHeader('Set-Cookie', buildSessionClearCookie())
  res.redirect('/god-admin/login')
}
