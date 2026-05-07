/**
 * Gbox Accounts — 2FA Login Challenge (Phase 0 §8 Item #3)
 *
 * Reached AFTER the password step in /accounts/login when the user has
 * 2FA enrolled. A session cookie is already set at this point but
 * `sessions.two_fa_verified` is FALSE, so the enforcement middleware
 * (apps/accounts/src/middleware/enforce-2fa.ts) only allows the user
 * onto /accounts/login/2fa* routes until the second factor clears.
 *
 * Flow
 * ----
 *   GET  /login/2fa              — TOTP entry form (primary)
 *   POST /login/2fa              — verify TOTP
 *   GET  /login/2fa/email        — email OTP fallback form
 *   POST /login/2fa/email/send   — send 6-digit email code
 *   POST /login/2fa/email        — verify email code
 *   GET  /login/2fa/backup       — backup-code entry form
 *   POST /login/2fa/backup       — verify backup code
 *
 * All POSTs are CSRF-protected via the `gbox_csrf_account_2fa` store.
 * On success, we flip `sessions.two_fa_verified=TRUE` and redirect to
 * the stored `return_to` (falling back to the accounts root /).
 *
 * Design note: this file is a direct port of
 * `apps/god-admin/src/pages/login-2fa.ts` adapted to the accounts
 * portal — same guard shape, same rate-limit keys (namespaced
 * `accounts_2fa_*`), same email send path, but uses `authLayout`
 * instead of the god-admin dark shell.
 */

import type { Request, Response } from 'express'
import { createCsrfStore } from '@gbox/core/modules/auth/csrf-express.js'
import { logAuditEvent } from '@gbox/core/modules/auth/audit.js'
import {
  getSessionTokenFromCookies,
  validateSession,
} from '@gbox/core/modules/auth/session.js'
import {
  getTwoFactorRow,
  verifyTotpCode,
  consumeBackupCode,
  generateEmailOtp,
  storeEmailOtp,
  verifyEmailOtp,
  markSessionTwoFaVerified,
  getSessionTwoFaVerified,
  EMAIL_OTP_EXPIRY_MS,
} from '@gbox/core/modules/auth/two-factor.js'
import { sendTemplatedEmail } from '@gbox/core/modules/email/send.js'
import { checkRateLimit, resetRateLimit } from '@gbox/core/modules/auth/rate-limit.js'

import { authLayout } from '../layouts/auth-layout.js'

// ---------------------------------------------------------------------------
// Module-level database client. Core modules are already updated to handle
// null db for demo/mock mode. Handlers are updated to remove the db parameter.
// ---------------------------------------------------------------------------

const db = null as any

// ---------------------------------------------------------------------------
// Shared CSRF store — same cookie name as two-factor.ts so the /login/2fa
// and /account/2fa flows can roam the same browser session without
// stepping on each other's tokens.
// ---------------------------------------------------------------------------

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_account_2fa' })

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function getClientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown'
}

function escapeHtml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** BFCache defeat — see apps/god-admin/src/pages/login-2fa.ts */
function setNoStoreHeaders(res: Response): void {
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, private, max-age=0',
  )
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
}

// ---------------------------------------------------------------------------
// Session guard — shared by every handler below
// ---------------------------------------------------------------------------

interface TwoFaGuardOk {
  ok: true
  token: string
  userId: string
  email: string
}
interface TwoFaGuardFail {
  ok: false
  redirectTo: string
}

async function requirePending2fa(
  req: Request,
  _res: Response,
): Promise<TwoFaGuardOk | TwoFaGuardFail> {
  const token = getSessionTokenFromCookies(req.headers.cookie ?? '')
  if (!token) {
    return { ok: false, redirectTo: '/accounts/login' }
  }
  const result = await validateSession(db, token)
  if (!result.valid || !result.session) {
    return { ok: false, redirectTo: '/accounts/login' }
  }
  const verified = await getSessionTwoFaVerified(db, token)
  if (verified !== false) {
    return { ok: false, redirectTo: '/accounts/stores' }
  }
  return {
    ok: true,
    token,
    userId: result.session.user.id,
    email: result.session.user.email,
  }
}

function getReturnTo(req: Request): string {
  const q = req.query.return_to
  if (typeof q !== 'string') return '/accounts/stores'
  const decoded = decodeURIComponent(q)
  if (decoded.startsWith('/') && !decoded.startsWith('//')) return decoded
  return '/accounts/stores'
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

type ChallengeMode = 'totp' | 'email' | 'backup'

interface RenderOpts {
  mode: ChallengeMode
  csrfToken: string
  email: string
  returnTo: string
  error?: string
  info?: string
}

function render2faPage(opts: RenderOpts): string {
  const { mode, csrfToken, email, returnTo, error, info } = opts
  const rt = encodeURIComponent(returnTo)

  let title = ''
  let subtitle = ''
  let formHtml = ''

  if (mode === 'totp') {
    title = 'Two-factor authentication'
    subtitle = `Enter the 6-digit code from your authenticator app for <strong>${escapeHtml(email)}</strong>.`
    formHtml = `
      <form method="POST" action="/accounts/login/2fa?return_to=${rt}" autocomplete="off">
        ${csrfStore.hiddenField(csrfToken)}
        <div class="form-group">
          <label for="code">Authenticator code</label>
          <input type="text" id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" autofocus required placeholder="123456" style="text-align:center;letter-spacing:4px;font-family:'SF Mono',Monaco,monospace;font-size:20px">
        </div>
        <button type="submit" class="btn btn-primary">Verify</button>
      </form>
      <p class="text-center text-sm mt-24">
        <a href="/accounts/login/2fa/email?return_to=${rt}" class="link">Use email code instead</a>
        &middot;
        <a href="/accounts/login/2fa/backup?return_to=${rt}" class="link">Use backup code</a>
      </p>
    `
  } else if (mode === 'email') {
    title = 'Email verification'
    subtitle = `We'll email a 6-digit code to <strong>${escapeHtml(email)}</strong>.`
    formHtml = `
      <form method="POST" action="/accounts/login/2fa/email/send?return_to=${rt}" style="margin-bottom:16px">
        ${csrfStore.hiddenField(csrfToken)}
        <button type="submit" class="btn btn-secondary">Send code to ${escapeHtml(email)}</button>
      </form>
      <form method="POST" action="/accounts/login/2fa/email?return_to=${rt}" autocomplete="off">
        ${csrfStore.hiddenField(csrfToken)}
        <div class="form-group">
          <label for="code">Email code</label>
          <input type="text" id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required placeholder="123456" style="text-align:center;letter-spacing:4px;font-family:'SF Mono',Monaco,monospace;font-size:20px">
        </div>
        <button type="submit" class="btn btn-primary">Verify</button>
      </form>
      <p class="text-center text-sm mt-24">
        <a href="/accounts/login/2fa?return_to=${rt}" class="link">Back to authenticator</a>
        &middot;
        <a href="/accounts/login/2fa/backup?return_to=${rt}" class="link">Use backup code</a>
      </p>
    `
  } else {
    title = 'Backup code'
    subtitle = `Enter one of the single-use backup codes you saved when you enrolled 2FA.`
    formHtml = `
      <form method="POST" action="/accounts/login/2fa/backup?return_to=${rt}" autocomplete="off">
        ${csrfStore.hiddenField(csrfToken)}
        <div class="form-group">
          <label for="code">Backup code</label>
          <input type="text" id="code" name="code" autocomplete="off" required placeholder="ABCDE-12345" style="text-transform:uppercase;letter-spacing:2px;font-family:'SF Mono',Monaco,monospace">
        </div>
        <button type="submit" class="btn btn-primary">Verify</button>
      </form>
      <p class="text-center text-sm mt-24">
        <a href="/accounts/login/2fa?return_to=${rt}" class="link">Back to authenticator</a>
        &middot;
        <a href="/accounts/login/2fa/email?return_to=${rt}" class="link">Use email code</a>
      </p>
    `
  }

  return authLayout({
    title,
    content: `
      <h1>${title}</h1>
      <p class="subtitle">${subtitle}</p>

      ${error ? `<div class="error-msg">${escapeHtml(error)}</div>` : ''}
      ${info ? `<div class="success-msg">${escapeHtml(info)}</div>` : ''}

      ${formHtml}

      <p class="text-center text-sm mt-24">
        <a href="/accounts/logout" class="link">Sign out</a>
      </p>
    `,
  })
}

// ---------------------------------------------------------------------------
// GET /login/2fa — TOTP form
// ---------------------------------------------------------------------------

export async function getLogin2fa(
  req: Request,
  res: Response,
): Promise<void> {
  setNoStoreHeaders(res)
  const guard = await requirePending2fa(req, res)
  if (!guard.ok) {
    res.redirect(guard.redirectTo)
    return
  }
  const csrfToken = await csrfStore.issue(res, isProduction())
  res.send(
    render2faPage({
      mode: 'totp',
      csrfToken,
      email: guard.email,
      returnTo: getReturnTo(req),
    }),
  )
}

// ---------------------------------------------------------------------------
// POST /login/2fa — verify TOTP
// ---------------------------------------------------------------------------

export async function postLogin2fa(
  req: Request,
  res: Response,
): Promise<void> {
  setNoStoreHeaders(res)
  const guard = await requirePending2fa(req, res)
  if (!guard.ok) {
    res.redirect(guard.redirectTo)
    return
  }

  const ip = getClientIp(req)
  const rateKey = `accounts_2fa_totp:${guard.userId}:${ip}`
  const rateResult = await checkRateLimit(rateKey)
  if (!rateResult.allowed) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(429).send(
      render2faPage({
        mode: 'totp',
        csrfToken,
        email: guard.email,
        returnTo: getReturnTo(req),
        error: `Too many attempts. Try again in ${rateResult.retryAfter ?? 60} seconds.`,
      }),
    )
    return
  }

  if (!(await csrfStore.verify(req))) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(403).send(
      render2faPage({
        mode: 'totp',
        csrfToken,
        email: guard.email,
        returnTo: getReturnTo(req),
        error: 'Invalid form submission. Please try again.',
      }),
    )
    return
  }

  const row = await getTwoFactorRow(db, guard.userId)
  if (!row || !row.enabled) {
    res.redirect('/accounts/login')
    return
  }

  const code = String(req.body?.code ?? '')
  const ok = verifyTotpCode(row.totp_secret, code)
  if (!ok) {
    await logAuditEvent(db, 'login_failed', {
      userId: guard.userId,
      email: guard.email,
      ip,
      userAgent: req.headers['user-agent'],
      extra: { context: 'accounts_2fa_totp', reason: 'invalid_code' },
    })
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(401).send(
      render2faPage({
        mode: 'totp',
        csrfToken,
        email: guard.email,
        returnTo: getReturnTo(req),
        error: 'Invalid code. Try again.',
      }),
    )
    return
  }

  await markSessionTwoFaVerified(db, guard.token, guard.userId)
  await resetRateLimit(rateKey)
  await logAuditEvent(db, 'login_success', {
    userId: guard.userId,
    email: guard.email,
    ip,
    userAgent: req.headers['user-agent'],
    extra: { context: 'accounts_2fa_totp' },
  })
  res.redirect(getReturnTo(req))
}

// ---------------------------------------------------------------------------
// GET /login/2fa/email — Email OTP form
// ---------------------------------------------------------------------------

export async function getLogin2faEmail(
  req: Request,
  res: Response,
): Promise<void> {
  setNoStoreHeaders(res)
  const guard = await requirePending2fa(req, res)
  if (!guard.ok) {
    res.redirect(guard.redirectTo)
    return
  }
  const csrfToken = await csrfStore.issue(res, isProduction())
  res.send(
    render2faPage({
      mode: 'email',
      csrfToken,
      email: guard.email,
      returnTo: getReturnTo(req),
    }),
  )
}

// ---------------------------------------------------------------------------
// POST /login/2fa/email/send — send a fresh 6-digit code
// ---------------------------------------------------------------------------

export async function postLogin2faEmailSend(
  req: Request,
  res: Response,
): Promise<void> {
  setNoStoreHeaders(res)
  const guard = await requirePending2fa(req, res)
  if (!guard.ok) {
    res.redirect(guard.redirectTo)
    return
  }

  if (!(await csrfStore.verify(req))) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(403).send(
      render2faPage({
        mode: 'email',
        csrfToken,
        email: guard.email,
        returnTo: getReturnTo(req),
        error: 'Invalid form submission. Please try again.',
      }),
    )
    return
  }

  const ip = getClientIp(req)
  const rateKey = `accounts_2fa_email_send:${guard.userId}:${ip}`
  const rateResult = await checkRateLimit(rateKey)
  if (!rateResult.allowed) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(429).send(
      render2faPage({
        mode: 'email',
        csrfToken,
        email: guard.email,
        returnTo: getReturnTo(req),
        error: `Please wait ${rateResult.retryAfter ?? 60} seconds before requesting another code.`,
      }),
    )
    return
  }

  const { code, hash, expiresAt } = generateEmailOtp()
  await storeEmailOtp(db, guard.userId, hash, expiresAt)

  try {
    const result = await sendTemplatedEmail(db, {
      templateKey: 'two_fa_code',
      to: guard.email,
      shopId: null,
      recipientUserId: guard.userId,
      variables: {
        code,
        expires_minutes: Math.round(EMAIL_OTP_EXPIRY_MS / 60_000),
      },
      idempotencyKey: `two_fa_code:accounts:${guard.userId}:${hash.slice(0, 16)}`,
    })
    if (!result.ok) {
      console.error('[accounts] 2fa email send failed:', result.reason, result.error ?? '')
    }
  } catch (err) {
    console.error('[accounts] 2fa email send error:', err)
  }

  await logAuditEvent(db, 'otp_sent', {
    userId: guard.userId,
    email: guard.email,
    ip,
    userAgent: req.headers['user-agent'],
    extra: { context: 'accounts_2fa_email' },
  })

  const csrfToken = await csrfStore.issue(res, isProduction())
  res.send(
    render2faPage({
      mode: 'email',
      csrfToken,
      email: guard.email,
      returnTo: getReturnTo(req),
      info: `We sent a 6-digit code to ${guard.email}. It expires in 10 minutes.`,
    }),
  )
}

// ---------------------------------------------------------------------------
// POST /login/2fa/email — verify the email OTP
// ---------------------------------------------------------------------------

export async function postLogin2faEmailVerify(
  req: Request,
  res: Response,
): Promise<void> {
  setNoStoreHeaders(res)
  const guard = await requirePending2fa(req, res)
  if (!guard.ok) {
    res.redirect(guard.redirectTo)
    return
  }

  if (!(await csrfStore.verify(req))) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(403).send(
      render2faPage({
        mode: 'email',
        csrfToken,
        email: guard.email,
        returnTo: getReturnTo(req),
        error: 'Invalid form submission. Please try again.',
      }),
    )
    return
  }

  const ip = getClientIp(req)
  const rateKey = `accounts_2fa_email_verify:${guard.userId}:${ip}`
  const rateResult = await checkRateLimit(rateKey)
  if (!rateResult.allowed) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(429).send(
      render2faPage({
        mode: 'email',
        csrfToken,
        email: guard.email,
        returnTo: getReturnTo(req),
        error: `Too many attempts. Try again in ${rateResult.retryAfter ?? 60} seconds.`,
      }),
    )
    return
  }

  const code = String(req.body?.code ?? '')
  const result = await verifyEmailOtp(db, guard.userId, code)
  if (!result.ok) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    const msg =
      result.reason === 'expired'
        ? 'This code has expired. Please send a new one.'
        : result.reason === 'too_many_attempts'
          ? 'Too many attempts for this code. Please request a new one.'
          : 'Invalid code. Try again.'
    await logAuditEvent(db, 'login_failed', {
      userId: guard.userId,
      email: guard.email,
      ip,
      userAgent: req.headers['user-agent'],
      extra: { context: 'accounts_2fa_email', reason: result.reason ?? 'invalid' },
    })
    res.status(401).send(
      render2faPage({
        mode: 'email',
        csrfToken,
        email: guard.email,
        returnTo: getReturnTo(req),
        error: msg,
      }),
    )
    return
  }

  await markSessionTwoFaVerified(db, guard.token, guard.userId)
  await resetRateLimit(rateKey)
  await logAuditEvent(db, 'login_success', {
    userId: guard.userId,
    email: guard.email,
    ip,
    userAgent: req.headers['user-agent'],
    extra: { context: 'accounts_2fa_email' },
  })
  res.redirect(getReturnTo(req))
}

// ---------------------------------------------------------------------------
// GET /login/2fa/backup — backup code form
// ---------------------------------------------------------------------------

export async function getLogin2faBackup(
  req: Request,
  res: Response,
): Promise<void> {
  setNoStoreHeaders(res)
  const guard = await requirePending2fa(req, res)
  if (!guard.ok) {
    res.redirect(guard.redirectTo)
    return
  }
  const csrfToken = await csrfStore.issue(res, isProduction())
  res.send(
    render2faPage({
      mode: 'backup',
      csrfToken,
      email: guard.email,
      returnTo: getReturnTo(req),
    }),
  )
}

// ---------------------------------------------------------------------------
// POST /login/2fa/backup — consume a backup code
// ---------------------------------------------------------------------------

export async function postLogin2faBackup(
  req: Request,
  res: Response,
): Promise<void> {
  setNoStoreHeaders(res)
  const guard = await requirePending2fa(req, res)
  if (!guard.ok) {
    res.redirect(guard.redirectTo)
    return
  }

  if (!(await csrfStore.verify(req))) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(403).send(
      render2faPage({
        mode: 'backup',
        csrfToken,
        email: guard.email,
        returnTo: getReturnTo(req),
        error: 'Invalid form submission. Please try again.',
      }),
    )
    return
  }

  const ip = getClientIp(req)
  const rateKey = `accounts_2fa_backup:${guard.userId}:${ip}`
  const rateResult = await checkRateLimit(rateKey)
  if (!rateResult.allowed) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(429).send(
      render2faPage({
        mode: 'backup',
        csrfToken,
        email: guard.email,
        returnTo: getReturnTo(req),
        error: `Too many attempts. Try again in ${rateResult.retryAfter ?? 60} seconds.`,
      }),
    )
    return
  }

  const code = String(req.body?.code ?? '')
  const ok = await consumeBackupCode(db, guard.userId, code)
  if (!ok) {
    await logAuditEvent(db, 'login_failed', {
      userId: guard.userId,
      email: guard.email,
      ip,
      userAgent: req.headers['user-agent'],
      extra: { context: 'accounts_2fa_backup', reason: 'invalid_code' },
    })
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(401).send(
      render2faPage({
        mode: 'backup',
        csrfToken,
        email: guard.email,
        returnTo: getReturnTo(req),
        error: 'Invalid backup code.',
      }),
    )
    return
  }

  await markSessionTwoFaVerified(db, guard.token, guard.userId)
  await resetRateLimit(rateKey)
  await logAuditEvent(db, 'login_success', {
    userId: guard.userId,
    email: guard.email,
    ip,
    userAgent: req.headers['user-agent'],
    extra: { context: 'accounts_2fa_backup' },
  })
  res.redirect(getReturnTo(req))
}
