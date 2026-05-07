/**
 * Gbox Accounts — Login Page (Mongo-direct edition)
 *
 * GET  /login  — Render login form with CSRF token
 * POST /login  — Validate credentials against Mongo Gbox-Users.users,
 *                bcrypt-verify password, create session row in
 *                Gbox-Users.sessions, set cookie, redirect.
 */

import type { Request, Response } from 'express'

import { createCsrfStore } from '@gbox/core/modules/auth/csrf-express.js'
import { checkRateLimit, resetRateLimit } from '@gbox/core/modules/auth/rate-limit.js'
import { logAuditEvent } from '@gbox/core/modules/auth/audit.js'
import { verifyPassword } from '@gbox/core/modules/auth/password.js'
import { getUserByEmail } from '@gbox/core/modules/auth/service.js'
import {
  createSession,
  getSessionCookieOptions,
  serializeSessionCookie,
} from '@gbox/core/modules/auth/session.js'

import { authLayout, googleIconSvg } from '../layouts/auth-layout.js'

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_login' })

const DEFAULT_POST_LOGIN = '/accounts/stores'

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function getClientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown'
}

/**
 * Same-origin relative paths only — drops absolute URLs / scheme-relative
 * / control chars to close the open-redirect surface.
 */
function safeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return ''
  if (!raw.startsWith('/') || raw.startsWith('//')) return ''
  if (/[\0\r\n]/.test(raw)) return ''
  return raw
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Whitelist allowed user fields when surfacing to the browser
 * (localStorage). Avoid leaking password_hash / reset_token columns
 * if a future change widens the projection.
 */
function sanitizeUser(user: Record<string, unknown>): Record<string, unknown> {
  if (!user || typeof user !== 'object') return {}
  const allowed = [
    'id', 'email', 'first_name', 'last_name', 'full_name',
    'name', 'avatar', 'avatar_url', 'role', 'is_active', 'create_date',
  ] as const
  const out: Record<string, unknown> = {}
  for (const k of allowed) {
    const v = (user as Record<string, unknown>)[k]
    if (v !== undefined && v !== null) out[k] = v
  }
  return out
}

function escapeInlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/-->/g, '--\\u003e')
    .replace(/ /g, '\\u2028')
    .replace(/ /g, '\\u2029')
}

function renderLoginSuccessInterstitial(
  token: string,
  user: Record<string, unknown>,
  returnTo: string,
): string {
  const tokenJson = escapeInlineJson(token)
  const userJson = escapeInlineJson(user)
  const targetJson = escapeInlineJson(returnTo)
  const targetAttr = escapeHtmlAttr(returnTo)
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<title>Đang đăng nhập...</title>
<meta name="robots" content="noindex">
<noscript><meta http-equiv="refresh" content="0;url=${targetAttr}"></noscript>
<style>
  body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .c{text-align:center}
  .s{width:32px;height:32px;border:3px solid #334155;border-top-color:#818cf8;border-radius:50%;animation:r .8s linear infinite;margin:0 auto 12px}
  @keyframes r{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="c"><div class="s"></div><div>Đang đăng nhập...</div></div>
<script>(function(){
  try {
    localStorage.setItem('gbox_token', ${tokenJson});
    localStorage.setItem('gbox_user', JSON.stringify(${userJson}));
  } catch (e) {}
  window.location.replace(${targetJson});
})();</script>
</body></html>`
}

function renderLogin(csrfToken: string, returnTo: string, error?: string): string {
  const errorHtml = error
    ? `<div class="error"><svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 0C3.6 0 0 3.6 0 8s3.6 8 8 8 8-3.6 8-8-3.6-8-8-8zm0 12c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1zm1-3H7V4h2v5z"/></svg>${error}</div>`
    : ''

  const returnToInput = returnTo
    ? `<input type="hidden" name="return_to" value="${escapeHtmlAttr(returnTo)}"/>`
    : ''

  const body = `
    <h2 class="form-title">Log in to Gbox</h2>
    <p class="form-subtitle">Welcome back. Please enter your credentials.</p>

    <form method="post" action="/accounts/login" autocomplete="on" novalidate>
      <input type="hidden" name="_csrf" value="${csrfToken}"/>
      ${returnToInput}
      ${errorHtml}

      <div class="form-group">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required autocomplete="email" autofocus>
      </div>

      <div class="form-group">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required autocomplete="current-password">
      </div>

      <div class="form-actions">
        <button type="submit" class="btn-primary">Log in</button>
      </div>
    </form>

    <div class="divider"><span>or</span></div>

    <a href="/accounts/auth/google" class="btn-secondary">
      ${googleIconSvg}
      Continue with Google
    </a>

    <p class="form-footer">
      <a href="/accounts/forgot-password" class="link">Forgot password?</a>
      &nbsp;·&nbsp;
      <a href="/accounts/signup" class="link">Create an account</a>
    </p>
  `

  return authLayout({ title: 'Log in', body })
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function getLogin(req: Request, res: Response): Promise<void> {
  const returnTo = safeReturnTo(req.query.return_to)
  const csrfToken = await csrfStore.issue(res, isProduction())
  res.send(renderLogin(csrfToken, returnTo))
}

export async function postLogin(req: Request, res: Response): Promise<void> {
  const ip = getClientIp(req)
  const returnTo = safeReturnTo(req.query.return_to)

  if (!(await csrfStore.verify(req))) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(403).send(renderLogin(csrfToken, returnTo, 'Invalid form submission.'))
    return
  }

  const rateKey = `login:${ip}`
  const rateResult = await checkRateLimit(rateKey)
  if (!rateResult.allowed) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(429).send(renderLogin(csrfToken, returnTo, 'Too many attempts. Please wait a few minutes.'))
    return
  }

  const { email, password } = (req.body ?? {}) as { email?: string; password?: string }
  if (!email || !password) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(400).send(renderLogin(csrfToken, returnTo, 'Email and password are required.'))
    return
  }

  const emailClean = email.toLowerCase().trim()

  try {
    // 1. Lookup user
    const user = await getUserByEmail(null, emailClean)
    if (!user || !user.password_hash) {
      await logAuditEvent(null, 'login_failed', { email: emailClean, ip, extra: { reason: 'no_user' } })
      const csrfToken = await csrfStore.issue(res, isProduction())
      res.status(401).send(renderLogin(csrfToken, returnTo, 'Invalid email or password.'))
      return
    }

    // 2. Verify password
    const ok = await verifyPassword(password, user.password_hash)
    if (!ok) {
      await logAuditEvent(null, 'login_failed', { userId: user._id, email: emailClean, ip, extra: { reason: 'bad_password' } })
      const csrfToken = await csrfStore.issue(res, isProduction())
      res.status(401).send(renderLogin(csrfToken, returnTo, 'Invalid email or password.'))
      return
    }

    // 3. Refuse disabled users
    if (user.status === 'disabled') {
      await logAuditEvent(null, 'login_failed', { userId: user._id, email: emailClean, ip, extra: { reason: 'disabled' } })
      const csrfToken = await csrfStore.issue(res, isProduction())
      res.status(403).send(renderLogin(csrfToken, returnTo, 'This account has been disabled.'))
      return
    }

    // 4. Create session
    const { token } = await createSession(null, user._id, {
      ipAddress: ip,
      userAgent: req.headers['user-agent'] ?? '',
    })

    // 5. Set cookies (HttpOnly session + browser-readable user snapshot)
    const isProd = isProduction()
    const cookieOpts = getSessionCookieOptions(isProd)
    const userSnapshot = {
      id: user._id,
      email: user.email,
      name: user.name ?? '',
      full_name: user.name ?? '',
      role: user.role,
      avatar_url: user.avatar_url ?? null,
    }
    res.setHeader('Set-Cookie', [
      serializeSessionCookie(token, cookieOpts),
      `gbox_user=${encodeURIComponent(JSON.stringify(userSnapshot))}; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax${isProd ? '; Secure' : ''}`,
    ])

    await resetRateLimit(rateKey)
    await logAuditEvent(null, 'login_success', {
      userId: user._id,
      email: emailClean,
      ip,
      userAgent: req.headers['user-agent'],
    })

    // 6. Render interstitial — persist to localStorage then navigate.
    //    Always land on the stores hub for consistency; ignore return_to.
    res.send(renderLoginSuccessInterstitial(token, sanitizeUser(userSnapshot), DEFAULT_POST_LOGIN))
  } catch (err) {
    console.error('[Login] Unexpected error:', err instanceof Error ? err.message : err)
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(500).send(renderLogin(csrfToken, returnTo, 'Login failed. Please try again.'))
  }
}
