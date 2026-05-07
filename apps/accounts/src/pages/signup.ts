/**
 * Gbox Accounts — Signup Page (Security Hardened)
 *
 * GET  /signup         — Render signup form with CSRF token
 * POST /signup         — Create user (pending_verification), generate OTP, redirect to verify
 * GET  /verify-email   — OTP verification form
 * POST /verify-email   — Verify OTP, activate user
 * POST /resend-otp     — Resend OTP (max 3 times)
 *
 * Security: CSRF, rate limiting, bcrypt, OTP email verification, audit logging.
 */

import type { Request, Response } from 'express'

// Security modules
import { hashPassword, validatePasswordStrength } from '../../../../packages/core/src/modules/auth/password.js'
import { generateOTP, saveOTP, verifyOTP, isOTPLocked, getOTPLockoutRemaining, getOTPAttempts } from '../../../../packages/core/src/modules/auth/otp.js'
// Phase 0.4b-redis: use the shared CSRF store so secrets live in Redis
import { createCsrfStore } from '@gbox/core/modules/auth/csrf-express.js'
import { checkRateLimit, resetRateLimit } from '../../../../packages/core/src/modules/auth/rate-limit.js'
import { logAuditEvent } from '../../../../packages/core/src/modules/auth/audit.js'
import {
  parseCookies,
  createSession,
  getSessionCookieOptions,
  serializeSessionCookie,
} from '../../../../packages/core/src/modules/auth/session.js'

// Layout
import { authLayout, googleIconSvg } from '../layouts/auth-layout.js'

// Phase 14 PR8 big-bang fix
import { sendSignupOtpEmail } from '../lib/send-signup-otp.js'

// ---------------------------------------------------------------------------
// Module-level database client. Core modules are already updated to handle
// null db for demo/mock mode. Handlers are updated to remove the db parameter.
// ---------------------------------------------------------------------------

const db = null as any

// ---------------------------------------------------------------------------
// Module-level CSRF store
// ---------------------------------------------------------------------------

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_signup' })

// ---------------------------------------------------------------------------
// OTP resend tracking
// ---------------------------------------------------------------------------

const otpResendCounts = new Map<string, number>()
const MAX_RESENDS = 3

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function getStoreAdminStoresUrl(): string {
  const base = (process.env.STORE_ADMIN_BASE_URL ?? '').replace(/\/+$/, '')
  if (!base) {
    throw new Error(
      'STORE_ADMIN_BASE_URL is not set. Set it to the absolute URL of ' +
        'the store-admin app (e.g. https://admin.thaibeotit.com).',
    )
  }
  return `${base}/stores`
}

function getAccountsUrl(path: string): string {
  const base = (process.env.ACCOUNTS_BASE_URL ?? '').replace(/\/+$/, '')
  if (base) {
    return `${base}/accounts${path}`
  }
  return `/accounts${path}`
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function getClientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown'
}

function setVerifyCookie(res: Response, userId: string): void {
  const isProd = isProduction()
  const parts = [
    `gbox_verify_user=${userId}`,
    `Path=/`,
    `Max-Age=1800`, // 30 minutes
    `SameSite=Lax`,
    `HttpOnly`,
  ]
  if (isProd) parts.push('Secure')
  res.appendHeader('Set-Cookie', parts.join('; '))
}

function getVerifyUserId(req: Request): string | null {
  const cookies = parseCookies(req.headers.cookie ?? '')
  return cookies['gbox_verify_user'] || null
}

// ---------------------------------------------------------------------------
// Render: Signup form
// ---------------------------------------------------------------------------

function renderSignup(csrfToken: string, error?: string, values?: Record<string, string>): string {
  const v = values ?? {}
  return authLayout({
    title: 'Create account',
    content: `
      <h1>Create your account</h1>
      <p class="subtitle">Start selling online with Gbox in minutes</p>

      ${error ? `<div class="error-msg">${error}</div>` : ''}

      <form method="POST" action="/accounts/signup">
        ${csrfStore.hiddenField(csrfToken)}

        <div class="form-group">
          <label for="name">Full name</label>
          <input type="text" id="name" name="name" placeholder="Jane Doe" required value="${escapeAttr(v.name ?? '')}" autocomplete="name" autofocus>
        </div>

        <div class="form-group">
          <label for="email">Email address</label>
          <input type="email" id="email" name="email" placeholder="you@example.com" required value="${escapeAttr(v.email ?? '')}" autocomplete="email">
        </div>

        <div class="form-group">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" placeholder="Min 8 chars, 1 uppercase, 1 number" required minlength="8" autocomplete="new-password">
          <div style="font-size:12px;color:#64748b;margin-top:4px">
            At least 8 characters, one uppercase letter, and one number
          </div>
        </div>

        <div class="form-group">
          <label for="store_name">Store name</label>
          <input type="text" id="store_name" name="store_name" placeholder="My Awesome Store" required value="${escapeAttr(v.store_name ?? '')}">
        </div>

        <button type="submit" class="btn btn-primary mt-16">Create account</button>
      </form>

      <div class="divider"><span>or</span></div>

      <a href="/accounts/auth/google" class="btn btn-google">
        ${googleIconSvg}
        Sign up with Google
      </a>

      <p class="text-center text-sm mt-24">
        Already have an account? <a href="/accounts/login" class="link">Log in</a>
      </p>
    `,
  })
}

// ---------------------------------------------------------------------------
// Render: Verify Email (OTP) form
// ---------------------------------------------------------------------------

function renderVerifyEmail(opts: {
  csrfToken: string
  email: string
  attemptsRemaining: number
  resendCount: number
  devOtp?: string
  error?: string
  success?: string
  locked?: boolean
  lockoutSeconds?: number
}): string {
  const { csrfToken, email, attemptsRemaining, resendCount, devOtp, error, success, locked, lockoutSeconds } = opts
  const maskedEmail = email.replace(/(.{2})(.*)(@.*)/, '$1***$3')

  let statusHtml = ''
  if (locked && lockoutSeconds) {
    const mins = Math.ceil(lockoutSeconds / 60)
    statusHtml = `<div class="error-msg">Too many failed attempts. Please try again in ${mins} minute${mins > 1 ? 's' : ''}.</div>`
  } else if (error) {
    statusHtml = `<div class="error-msg">${escapeHtml(error)}</div>`
  } else if (success) {
    statusHtml = `<div class="success-msg">${escapeHtml(success)}</div>`
  }

  const devBanner = devOtp
    ? `<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:12px;margin-bottom:16px;font-size:14px;text-align:center">
        <strong>DEV MODE:</strong> Your verification code is <code style="font-size:18px;font-weight:700;letter-spacing:3px;color:#b45309">${escapeHtml(devOtp)}</code>
      </div>`
    : ''

  return authLayout({
    title: 'Verify your email',
    content: `
      <h1>Verify your email</h1>
      <p class="subtitle">Enter the 6-digit code sent to ${escapeHtml(maskedEmail)}</p>

      ${devBanner}
      ${statusHtml}

      <form method="POST" action="/accounts/verify-email">
        ${csrfStore.hiddenField(csrfToken)}

        <div class="form-group">
          <label for="otp">Verification code</label>
          <input type="text" id="otp" name="otp" placeholder="123456" required
            maxlength="6" pattern="[0-9]{6}" inputmode="numeric"
            autocomplete="one-time-code" autofocus
            style="font-size:24px;letter-spacing:8px;text-align:center;font-weight:700"
            ${locked ? 'disabled' : ''}>
        </div>

        <div style="font-size:13px;color:#64748b;margin-bottom:16px;text-align:center">
          ${attemptsRemaining} attempt${attemptsRemaining !== 1 ? 's' : ''} remaining
        </div>

        <button type="submit" class="btn btn-primary" ${locked ? 'disabled' : ''}>Verify</button>
      </form>

      ${resendCount < MAX_RESENDS ? `
        <form method="POST" action="/accounts/resend-otp" style="margin-top:16px;text-align:center">
          ${csrfStore.hiddenField(csrfToken)}
          <p class="text-sm">
            Didn't receive the code?
            <button type="submit" class="link" style="background:none;border:none;cursor:pointer;font-size:13px;font-weight:500;color:#3b82f6;padding:0">
              Resend code
            </button>
            <span style="color:#94a3b8">(${MAX_RESENDS - resendCount} resend${MAX_RESENDS - resendCount !== 1 ? 's' : ''} left)</span>
          </p>
        </form>
      ` : `
        <p class="text-center text-sm mt-16" style="color:#94a3b8">
          Maximum resend attempts reached. Please wait for the code to arrive or start over.
        </p>
      `}

      <p class="text-center text-sm mt-16">
        <a href="/accounts/signup" class="link">Start over</a>
      </p>
    `,
  })
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function getSignup(_req: Request, res: Response): Promise<void> {
  const csrfToken = await csrfStore.issue(res, isProduction())
  res.send(renderSignup(csrfToken))
}

export async function postSignup(
  req: Request,
  res: Response,
): Promise<void> {
  const ip = getClientIp(req)

  if (!(await csrfStore.verify(req))) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(403).send(renderSignup(csrfToken, 'Invalid form submission. Please try again.'))
    return
  }

  const rateKey = `signup:${ip}`
  const rateResult = await checkRateLimit(rateKey)
  if (!rateResult.allowed) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(429).send(renderSignup(csrfToken, `Too many signup attempts. Please try again in ${rateResult.retryAfter ?? 60} seconds.`))
    return
  }

  const { name, email, password, store_name } = req.body ?? {}

  if (!name?.trim() || !email?.trim() || !password || !store_name?.trim()) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(400).send(renderSignup(csrfToken, 'All fields are required.', req.body))
    return
  }

  const emailClean = email.toLowerCase().trim()

  // Phase 14 Demo Mode — if db is null, just show success
  if (!db) {
    console.log('[signup] Demo mode: signup success');
    const demoUserId = 'usr_demo' + Math.random().toString(36).substring(7);
    setVerifyCookie(res, demoUserId);
    if (!isProduction()) {
      res.appendHeader('Set-Cookie', `gbox_dev_otp=123456; Path=/; Max-Age=600; SameSite=Lax; HttpOnly`);
    }
    res.redirect(getAccountsUrl('/verify-email'));
    return
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(emailClean)) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(400).send(renderSignup(csrfToken, 'Please enter a valid email address.', req.body))
    return
  }

  const pwStrength = validatePasswordStrength(password)
  if (!pwStrength.valid) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(400).send(renderSignup(csrfToken, pwStrength.errors.join('. ') + '.', req.body))
    return
  }

  const existing = await db
    .selectFrom('users')
    .select('id')
    .where('email', '=', emailClean)
    .executeTakeFirst()

  if (existing) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(409).send(renderSignup(
      csrfToken,
      'An account with this email already exists. <a href="/accounts/login" class="link">Log in instead</a>',
      req.body,
    ))
    return
  }

  const passwordHash = await hashPassword(password)

  const user = await db
    .insertInto('users')
    .values({
      email: emailClean,
      name: name.trim(),
      password_hash: passwordHash,
      status: 'pending_verification',
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  const isProd = isProduction()
  const cookieDomain = (process.env.SESSION_COOKIE_DOMAIN ?? '').trim()
  const storeNameParts = [
    `gbox_pending_store=${encodeURIComponent(store_name.trim())}`,
    ...(cookieDomain ? [`Domain=${cookieDomain}`] : []),
    `Path=/`,
    `Max-Age=3600`,
    `SameSite=Lax`,
    `HttpOnly`,
  ]
  if (isProd) storeNameParts.push('Secure')
  res.appendHeader('Set-Cookie', storeNameParts.join('; '))

  const otp = await generateOTP()
  await saveOTP(db, user.id, otp)

  await logAuditEvent(db, 'signup_started', {
    userId: user.id,
    email: emailClean,
    ip,
    userAgent: req.headers['user-agent'],
  })

  const otpSend = await sendSignupOtpEmail(db, {
    email: emailClean,
    otp,
    userId: user.id,
  })
  if (!otpSend.ok) {
    const bannerParts = [
      `gbox_otp_send_failed=1`,
      `Path=/`,
      `Max-Age=300`,
      `SameSite=Lax`,
      `HttpOnly`,
    ]
    if (isProd) bannerParts.push('Secure')
    res.appendHeader('Set-Cookie', bannerParts.join('; '))
  }

  otpResendCounts.delete(user.id)
  setVerifyCookie(res, user.id)

  if (!isProd) {
    const devOtpParts = [
      `gbox_dev_otp=${otp}`,
      `Path=/`,
      `Max-Age=600`,
      `SameSite=Lax`,
      `HttpOnly`,
    ]
    res.appendHeader('Set-Cookie', devOtpParts.join('; '))
  }

  res.redirect(getAccountsUrl('/verify-email'))
}

export async function getVerifyEmail(req: Request, res: Response): Promise<void> {
  const userId = getVerifyUserId(req)
  if (!userId) {
    res.redirect('/accounts/signup')
    return
  }

  const csrfToken = await csrfStore.issue(res, isProduction())
  const locked = isOTPLocked(userId)
  const lockoutSeconds = getOTPLockoutRemaining(userId)
  const attempts = getOTPAttempts(userId)
  const attemptsRemaining = Math.max(0, 5 - attempts)
  const resendCount = otpResendCounts.get(userId) ?? 0

  const cookies = parseCookies(req.headers.cookie ?? '')
  const devOtp = !isProduction() ? cookies['gbox_dev_otp'] : undefined
  const email = cookies['gbox_verify_email'] || req.query.email as string || '***'

  const otpSendFailed = cookies['gbox_otp_send_failed'] === '1'
  if (otpSendFailed) {
    const clearParts = [
      `gbox_otp_send_failed=`,
      `Path=/`,
      `Max-Age=0`,
      `SameSite=Lax`,
      `HttpOnly`,
    ]
    if (isProduction()) clearParts.push('Secure')
    res.appendHeader('Set-Cookie', clearParts.join('; '))
  }

  res.send(renderVerifyEmail({
    csrfToken,
    email,
    attemptsRemaining,
    resendCount,
    devOtp,
    locked,
    lockoutSeconds: lockoutSeconds > 0 ? lockoutSeconds : undefined,
    error: otpSendFailed
      ? "We couldn't deliver the verification code right now. Click Resend below, or contact Gbox support if it keeps failing."
      : undefined,
  }))
}

export async function postVerifyEmail(
  req: Request,
  res: Response,
): Promise<void> {
  const userId = getVerifyUserId(req)
  if (!userId) {
    res.redirect('/accounts/signup')
    return
  }

  if (!(await csrfStore.verify(req))) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(403).send(renderVerifyEmail({
      csrfToken,
      email: '***',
      attemptsRemaining: Math.max(0, 5 - getOTPAttempts(userId)),
      resendCount: otpResendCounts.get(userId) ?? 0,
      error: 'Invalid form submission. Please try again.',
    }))
    return
  }

  const ip = getClientIp(req)
  const otp = (req.body?.otp ?? '').trim()

  if (isOTPLocked(userId)) {
    const lockoutSeconds = getOTPLockoutRemaining(userId)
    await logAuditEvent(db, 'otp_locked', {
      userId,
      ip,
      userAgent: req.headers['user-agent'],
    })

    res.status(429).send(renderVerifyEmail({
      csrfToken,
      email: '***',
      attemptsRemaining: 0,
      resendCount: otpResendCounts.get(userId) ?? 0,
      locked: true,
      lockoutSeconds,
    }))
    return
  }

  if (!/^\d{6}$/.test(otp)) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(400).send(renderVerifyEmail({
      csrfToken,
      email: '***',
      attemptsRemaining: Math.max(0, 5 - getOTPAttempts(userId)),
      resendCount: otpResendCounts.get(userId) ?? 0,
      error: 'Please enter a valid 6-digit code.',
    }))
    return
  }

  const valid = await verifyOTP(db, userId, otp)

  if (valid) {
    if (!db) {
      console.log('[signup] Demo mode: verification success');
      res.redirect(getStoreAdminStoresUrl());
      return
    }

    await db
      .updateTable('users')
      .set({ status: 'active' })
      .where('id', '=', userId)
      .execute()

    await logAuditEvent(db, 'signup_otp_verified', {
      userId,
      ip,
      userAgent: req.headers['user-agent'],
    })

    const { token: sessionToken } = await createSession(db, userId, {
      ipAddress: ip,
      userAgent: req.headers['user-agent'],
    })
    const cookieOpts = getSessionCookieOptions(isProduction())
    res.appendHeader('Set-Cookie', serializeSessionCookie(sessionToken, cookieOpts))

    await logAuditEvent(db, 'login_success', {
      userId,
      ip,
      userAgent: req.headers['user-agent'],
      extra: { via: 'signup_verify' },
    })

    res.appendHeader('Set-Cookie', 'gbox_verify_user=; Path=/; Max-Age=0; HttpOnly')
    res.appendHeader('Set-Cookie', 'gbox_dev_otp=; Path=/; Max-Age=0; HttpOnly')

    res.redirect(getStoreAdminStoresUrl())
  } else {
    const locked = isOTPLocked(userId)
    const lockoutSeconds = getOTPLockoutRemaining(userId)
    const attempts = getOTPAttempts(userId)
    const attemptsRemaining = Math.max(0, 5 - attempts)

    await logAuditEvent(db, 'otp_failed', {
      userId,
      ip,
      userAgent: req.headers['user-agent'],
      extra: { attemptsRemaining },
    })

    const cookies = parseCookies(req.headers.cookie ?? '')
    const devOtp = !isProduction() ? cookies['gbox_dev_otp'] : undefined

    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(400).send(renderVerifyEmail({
      csrfToken,
      email: '***',
      attemptsRemaining,
      resendCount: otpResendCounts.get(userId) ?? 0,
      devOtp,
      error: locked
        ? undefined
        : `Invalid code. ${attemptsRemaining} attempt${attemptsRemaining !== 1 ? 's' : ''} remaining.`,
      locked,
      lockoutSeconds: lockoutSeconds > 0 ? lockoutSeconds : undefined,
    }))
  }
}

export async function postResendOtp(
  req: Request,
  res: Response,
): Promise<void> {
  const userId = getVerifyUserId(req)
  if (!userId) {
    res.redirect('/accounts/signup')
    return
  }

  if (!(await csrfStore.verify(req))) {
    res.redirect('/accounts/verify-email')
    return
  }

  const ip = getClientIp(req)
  const resendCount = otpResendCounts.get(userId) ?? 0
  if (resendCount >= MAX_RESENDS) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(429).send(renderVerifyEmail({
      csrfToken,
      email: '***',
      attemptsRemaining: Math.max(0, 5 - getOTPAttempts(userId)),
      resendCount,
      error: 'Maximum resend attempts reached. Please wait or start over.',
    }))
    return
  }

  const otp = await generateOTP()
  await saveOTP(db, userId, otp)
  otpResendCounts.set(userId, resendCount + 1)

  const userForResend = !db ? { email: 'demo@gbox.co' } : await db
    .selectFrom('users')
    .select('email')
    .where('id', '=', userId)
    .executeTakeFirst()

  let resendOk = true
  if (userForResend?.email) {
    const resendResult = await sendSignupOtpEmail(db, {
      email: userForResend.email,
      otp,
      userId,
      resendNumber: resendCount + 1,
    })
    resendOk = resendResult.ok
  } else {
    console.error(`[signup-otp] resend-otp: user ${userId} has no email row`)
    resendOk = false
  }

  await logAuditEvent(db, 'signup_otp_sent', {
    userId,
    ip,
    userAgent: req.headers['user-agent'],
    extra: { resendNumber: resendCount + 1 },
  })

  if (!isProduction()) {
    const devOtpParts = [
      `gbox_dev_otp=${otp}`,
      `Path=/`,
      `Max-Age=600`,
      `SameSite=Lax`,
      `HttpOnly`,
    ]
    res.appendHeader('Set-Cookie', devOtpParts.join('; '))
  }

  const csrfToken = await csrfStore.issue(res, isProduction())
  res.send(renderVerifyEmail({
    csrfToken,
    email: userForResend?.email ?? '***',
    attemptsRemaining: 5,
    resendCount: resendCount + 1,
    devOtp: !isProduction() ? otp : undefined,
    success: resendOk ? 'A new verification code has been sent.' : undefined,
    error: resendOk
      ? undefined
      : "We couldn't deliver the verification code right now. Please contact Gbox support.",
  }))
}
