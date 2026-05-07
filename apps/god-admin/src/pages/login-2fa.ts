/**
 * God Admin — 2FA Challenge Routes
 *
 * Reached AFTER the password step in /god-admin/login when the user
 * has 2FA enrolled. A session cookie is already set at this point,
 * but `sessions.two_fa_verified` is FALSE so the god-auth middleware
 * will only allow the user onto these challenge URLs until the second
 * factor is validated.
 *
 * Flow
 * ----
 *   GET  /god-admin/login/2fa              — TOTP entry form (primary)
 *   POST /god-admin/login/2fa              — verify TOTP
 *   GET  /god-admin/login/2fa/email        — email OTP fallback form
 *   POST /god-admin/login/2fa/email/send   — send 6-digit email code
 *   POST /god-admin/login/2fa/email        — verify email code
 *   GET  /god-admin/login/2fa/backup       — backup-code entry form
 *   POST /god-admin/login/2fa/backup       — verify backup code
 *
 * All POSTs are CSRF-protected with the `gbox_csrf_god` cookie / _csrf
 * form field pattern already used by the password login page.
 *
 * On success, we flip sessions.two_fa_verified=TRUE and redirect back
 * to the dashboard (or the original return_to target).
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'

// Phase 0.4b-redis: shared CSRF store (auto-selects Redis backend when
// REDIS_URL is set) so the god-admin 2FA challenge pages work under pm2
// cluster mode — the GET that mints the token and the POST that verifies
// it round-robin to different workers.
import { createCsrfStore } from '@gbox/core/modules/auth/csrf-express.js'
import { logAuditEvent } from '../../../../packages/core/src/modules/auth/audit.js'
import {
  getSessionTokenFromCookies,
  validateSession,
} from '../../../../packages/core/src/modules/auth/session.js'
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
} from '../../../../packages/core/src/modules/auth/two-factor.js'
import { sendTemplatedEmail } from '../../../../packages/core/src/modules/email/send.js'
import { checkRateLimit, resetRateLimit } from '../../../../packages/core/src/modules/auth/rate-limit.js'

// ---------------------------------------------------------------------------
// Module-level CSRF store — backed by Redis when REDIS_URL is set.
// ---------------------------------------------------------------------------

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_god_2fa' })

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function getClientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown'
}

/**
 * Defeat browser caching (including back/forward cache) on all
 * authentication-sensitive pages. BFCache stores a complete DOM snapshot
 * of the previous page — including any plaintext codes, form inputs, or
 * CSRF tokens — and replays it instantly on Back navigation without
 * contacting the server. For a 2FA challenge page that accepts codes
 * and shows error messages tied to a specific session state, that's a
 * CSRF / session-confusion footgun. `Cache-Control: no-store` is the
 * spec-defined opt-out from BFCache.
 */
function setNoStoreHeaders(res: Response): void {
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, private, max-age=0',
  )
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
}

function escapeHtml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Session guard shared by all 2FA-challenge handlers
//
// Reads the session cookie, validates the underlying session, confirms
// that the user is a God Admin (owner), and confirms that the session
// is currently PENDING 2FA (two_fa_verified=false). Anything else sends
// the user back to /god-admin/login.
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
  res: Response,
  db: Kysely<Database>,
): Promise<TwoFaGuardOk | TwoFaGuardFail> {
  const token = getSessionTokenFromCookies(req.headers.cookie ?? '')
  if (!token) {
    return { ok: false, redirectTo: '/god-admin/login' }
  }
  const result = await validateSession(db, token)
  if (
    !result.valid ||
    !result.session ||
    result.session.user.role !== 'owner'
  ) {
    return { ok: false, redirectTo: '/god-admin/login' }
  }
  const verified = await getSessionTwoFaVerified(db, token)
  if (verified !== false) {
    // Either fully verified or row missing — nothing to challenge
    return { ok: false, redirectTo: '/god-admin' }
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
  if (typeof q !== 'string') return '/god-admin'
  const decoded = decodeURIComponent(q)
  return decoded.startsWith('/god-admin') ? decoded : '/god-admin'
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

  let formHtml = ''
  let title = ''
  let subtitle = ''

  if (mode === 'totp') {
    title = 'Two-factor authentication'
    subtitle = `Enter the 6-digit code from your authenticator app for <strong>${escapeHtml(email)}</strong>.`
    formHtml = `
      <form method="POST" action="/god-admin/login/2fa?return_to=${rt}" autocomplete="off">
        ${csrfStore.hiddenField(csrfToken)}
        <div class="form-group">
          <label for="code">Authenticator code</label>
          <input type="text" id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" autofocus required placeholder="123456">
        </div>
        <button type="submit" class="btn-primary">Verify</button>
      </form>
      <div class="alt-links">
        <a href="/god-admin/login/2fa/email?return_to=${rt}">Use email code instead</a>
        &middot;
        <a href="/god-admin/login/2fa/backup?return_to=${rt}">Use backup code</a>
      </div>
    `
  } else if (mode === 'email') {
    title = 'Email verification'
    subtitle = `We'll email a 6-digit code to <strong>${escapeHtml(email)}</strong>.`
    formHtml = `
      <form method="POST" action="/god-admin/login/2fa/email/send?return_to=${rt}" style="margin-bottom:16px">
        ${csrfStore.hiddenField(csrfToken)}
        <button type="submit" class="btn-secondary">Send code to ${escapeHtml(email)}</button>
      </form>
      <form method="POST" action="/god-admin/login/2fa/email?return_to=${rt}" autocomplete="off">
        ${csrfStore.hiddenField(csrfToken)}
        <div class="form-group">
          <label for="code">Email code</label>
          <input type="text" id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required placeholder="123456">
        </div>
        <button type="submit" class="btn-primary">Verify</button>
      </form>
      <div class="alt-links">
        <a href="/god-admin/login/2fa?return_to=${rt}">Back to authenticator</a>
        &middot;
        <a href="/god-admin/login/2fa/backup?return_to=${rt}">Use backup code</a>
      </div>
    `
  } else {
    title = 'Backup code'
    subtitle = `Enter one of the one-time backup codes you saved when you enrolled 2FA.`
    formHtml = `
      <form method="POST" action="/god-admin/login/2fa/backup?return_to=${rt}" autocomplete="off">
        ${csrfStore.hiddenField(csrfToken)}
        <div class="form-group">
          <label for="code">Backup code</label>
          <input type="text" id="code" name="code" autocomplete="off" required placeholder="ABCDE-12345" style="text-transform:uppercase;letter-spacing:2px;">
        </div>
        <button type="submit" class="btn-primary">Verify</button>
      </form>
      <div class="alt-links">
        <a href="/god-admin/login/2fa?return_to=${rt}">Back to authenticator</a>
        &middot;
        <a href="/god-admin/login/2fa/email?return_to=${rt}">Use email code</a>
      </div>
    `
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Gbox God Admin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a; min-height: 100vh; display: flex;
      align-items: center; justify-content: center; color: #e2e8f0;
    }
    .wrap { width: 100%; max-width: 440px; padding: 24px; }
    .logo { text-align: center; margin-bottom: 28px; font-size: 28px; font-weight: 800; color: #fff; letter-spacing: -1px; }
    .logo span { color: #3b82f6; }
    .god-badge {
      display: inline-block; background: linear-gradient(135deg, #ef4444, #f97316);
      color: #fff; font-size: 10px; font-weight: 700; padding: 3px 10px;
      border-radius: 4px; text-transform: uppercase; letter-spacing: 1px;
      margin-top: 4px;
    }
    .card {
      background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 32px;
    }
    h2 { font-size: 20px; font-weight: 700; color: #f1f5f9; margin-bottom: 8px; text-align: center; }
    p.sub { color: #94a3b8; font-size: 13px; margin-bottom: 24px; text-align: center; line-height: 1.5; }
    .error {
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #fca5a5; padding: 12px 16px; border-radius: 10px;
      font-size: 13px; margin-bottom: 16px;
    }
    .info {
      background: rgba(59, 130, 246, 0.12);
      border: 1px solid rgba(59, 130, 246, 0.3);
      color: #93c5fd; padding: 12px 16px; border-radius: 10px;
      font-size: 13px; margin-bottom: 16px;
    }
    .form-group { margin-bottom: 20px; }
    .form-group label {
      display: block; font-size: 13px; font-weight: 600;
      color: #94a3b8; margin-bottom: 6px;
    }
    .form-group input {
      width: 100%; padding: 14px 16px; background: #0f172a;
      border: 1.5px solid #334155; border-radius: 10px;
      color: #e2e8f0; font-size: 20px; font-family: 'SF Mono', Monaco, monospace;
      text-align: center; letter-spacing: 4px;
      outline: none; transition: border-color 0.2s, box-shadow 0.2s;
    }
    .form-group input:focus {
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
    }
    .btn-primary {
      width: 100%; padding: 14px;
      background: linear-gradient(135deg, #3b82f6, #2563eb);
      color: #fff; border: none; border-radius: 10px;
      font-size: 15px; font-weight: 700; cursor: pointer;
    }
    .btn-primary:hover { opacity: 0.92; }
    .btn-secondary {
      width: 100%; padding: 12px;
      background: #334155; color: #e2e8f0;
      border: 1px solid #475569; border-radius: 10px;
      font-size: 14px; font-weight: 600; cursor: pointer;
    }
    .btn-secondary:hover { background: #3f4f68; }
    .alt-links {
      text-align: center; margin-top: 20px; font-size: 12px; color: #64748b;
    }
    .alt-links a { color: #3b82f6; text-decoration: none; }
    .alt-links a:hover { text-decoration: underline; }
    .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #475569; }
    .footer a { color: #64748b; text-decoration: none; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="logo">G<span>box</span><div class="god-badge">God Admin</div></div>
    <div class="card">
      <h2>${title}</h2>
      <p class="sub">${subtitle}</p>
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
      ${info ? `<div class="info">${escapeHtml(info)}</div>` : ''}
      ${formHtml}
    </div>
    <div class="footer"><a href="/god-admin/logout">Sign out</a></div>
  </div>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// GET /god-admin/login/2fa — TOTP form
// ---------------------------------------------------------------------------

export async function getLogin2fa(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  setNoStoreHeaders(res)
  const guard = await requirePending2fa(req, res, db)
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
// POST /god-admin/login/2fa — verify TOTP
// ---------------------------------------------------------------------------

export async function postLogin2fa(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  setNoStoreHeaders(res)
  const guard = await requirePending2fa(req, res, db)
  if (!guard.ok) {
    res.redirect(guard.redirectTo)
    return
  }

  const ip = getClientIp(req)
  const rateKey = `god_2fa_totp:${guard.userId}:${ip}`
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
    // Shouldn't happen — the login flow only routes here when enrolled
    res.redirect('/god-admin/login')
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
      extra: { context: 'god_admin_2fa_totp', reason: 'invalid_code' },
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
    extra: { context: 'god_admin_2fa_totp' },
  })
  res.redirect(getReturnTo(req))
}

// ---------------------------------------------------------------------------
// GET /god-admin/login/2fa/email — Email OTP form
// ---------------------------------------------------------------------------

export async function getLogin2faEmail(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  setNoStoreHeaders(res)
  const guard = await requirePending2fa(req, res, db)
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
// POST /god-admin/login/2fa/email/send — send a fresh 6-digit code
// ---------------------------------------------------------------------------

export async function postLogin2faEmailSend(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  setNoStoreHeaders(res)
  const guard = await requirePending2fa(req, res, db)
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
  const rateKey = `god_2fa_email_send:${guard.userId}:${ip}`
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

  // PR2 commit 9 — routes through sendTemplatedEmail so every god-admin
  // 2FA send lands in the delivery log alongside seller 2FA sends
  // (shared template 'two_fa_code', audience='god_admin',
  // category='platform'). Copy is intentionally generic ("Your Gbox
  // sign-in code" — no mention of "God Admin") so the same row serves
  // both flows without leaking god-admin branding into any shared
  // preview/UI.
  //
  // shopId: null — platform-scoped send (2FA is auth infra, not
  // shop-scoped). The Iron-rule-5 gate in send.ts enforces this.
  //
  // Idempotency: OTP-hash-prefixed so resend requests each log a new
  // delivery (fresh hash per generateEmailOtp call), while network
  // retries of a single request dedupe.
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
      idempotencyKey: `two_fa_code:god_admin:${guard.userId}:${hash.slice(0, 16)}`,
    })
    if (!result.ok) {
      console.error('[god-admin] 2fa email send failed:', result.reason, result.error ?? '')
    }
  } catch (err) {
    console.error('[god-admin] 2fa email send error:', err)
  }

  await logAuditEvent(db, 'otp_sent', {
    userId: guard.userId,
    email: guard.email,
    ip,
    userAgent: req.headers['user-agent'],
    extra: { context: 'god_admin_2fa_email' },
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
// POST /god-admin/login/2fa/email — verify the email OTP
// ---------------------------------------------------------------------------

export async function postLogin2faEmailVerify(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  setNoStoreHeaders(res)
  const guard = await requirePending2fa(req, res, db)
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
  const rateKey = `god_2fa_email_verify:${guard.userId}:${ip}`
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
      extra: { context: 'god_admin_2fa_email', reason: result.reason ?? 'invalid' },
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
    extra: { context: 'god_admin_2fa_email' },
  })
  res.redirect(getReturnTo(req))
}

// ---------------------------------------------------------------------------
// GET /god-admin/login/2fa/backup — backup code form
// ---------------------------------------------------------------------------

export async function getLogin2faBackup(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  setNoStoreHeaders(res)
  const guard = await requirePending2fa(req, res, db)
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
// POST /god-admin/login/2fa/backup — consume a backup code
// ---------------------------------------------------------------------------

export async function postLogin2faBackup(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  setNoStoreHeaders(res)
  const guard = await requirePending2fa(req, res, db)
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
  const rateKey = `god_2fa_backup:${guard.userId}:${ip}`
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
      extra: { context: 'god_admin_2fa_backup', reason: 'invalid_code' },
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
    extra: { context: 'god_admin_2fa_backup' },
  })
  res.redirect(getReturnTo(req))
}
