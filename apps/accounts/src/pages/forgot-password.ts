/**
 * Gbox Accounts — Forgot Password & Reset Password
 *
 * GET  /forgot-password           — Email input form
 * POST /forgot-password           — Generate reset token, show confirmation
 * GET  /reset-password?token=xxx  — New password form
 * POST /reset-password            — Validate token, update password
 */

import type { Request, Response } from 'express'
import { createHash, randomBytes } from 'crypto'
import { authLayout } from '../layouts/auth-layout.js'
// Phase 14 PR2 commit 3: password-reset email migrated to the unified
// `sendTemplatedEmail` pipeline so it lands in `email_deliveries`, respects
// shop overrides, and dedupes webhook retries via the idempotency key.
import { sendTemplatedEmail } from '@gbox/core/modules/email/send.js'
// Phase 0 Step 0.5 (bcrypt sweep): this file used to hash passwords with
// SHA-256, which silently downgraded any bcrypt user who reset their
// password. Now it delegates to the shared password module so the full
// reset flow writes a bcrypt hash.
import {
  hashPassword,
  validatePasswordStrength,
} from '@gbox/core/modules/auth/password.js'
// Phase 0 Step 0.4: CSRF on the reset-password form. Forgot-password
// itself (email input) doesn't strictly need CSRF because submitting
// it doesn't mutate attacker-controlled state — but reset-password
// sets a brand-new password, so it MUST be protected.
import { createCsrfStore } from '@gbox/core/modules/auth/csrf-express.js'

// ---------------------------------------------------------------------------
// Module-level database client. Core modules are already updated to handle
// null db for demo/mock mode. Handlers are updated to remove the db parameter.
// ---------------------------------------------------------------------------

const db = null as any

// ---------------------------------------------------------------------------
// Module-level CSRF store for the reset-password form
// ---------------------------------------------------------------------------

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_reset' })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateResetToken(): string {
  return randomBytes(32).toString('hex')
}

// Reset tokens are still SHA-256 hashed at rest — they're one-time
// single-purpose nonces, not passwords, so a fast hash is correct (and
// the TTL is 1 hour). bcrypt would be pointless here.
function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000 // 1 hour

// ---------------------------------------------------------------------------
// Forgot Password — Render
// ---------------------------------------------------------------------------

function renderForgotPassword(opts?: { error?: string; success?: string }): string {
  return authLayout({
    title: 'Forgot password',
    content: `
      <h1>Reset your password</h1>
      <p class="subtitle">Enter your email and we'll send you a reset link</p>

      ${opts?.error ? `<div class="error-msg">${escapeHtml(opts.error)}</div>` : ''}
      ${opts?.success ? `<div class="success-msg">${escapeHtml(opts.success)}</div>` : ''}

      ${
        opts?.success
          ? ''
          : `
      <form method="POST" action="/accounts/forgot-password">
        <div class="form-group">
          <label for="email">Email address</label>
          <input type="email" id="email" name="email" placeholder="you@example.com" required autocomplete="email" autofocus>
        </div>

        <button type="submit" class="btn btn-primary mt-16">Send reset link</button>
      </form>
      `
      }

      <p class="text-center text-sm mt-24">
        <a href="/accounts/login" class="link">Back to login</a>
      </p>
    `,
  })
}

// ---------------------------------------------------------------------------
// Reset Password — Render
// ---------------------------------------------------------------------------

function renderResetPassword(
  token: string,
  opts?: { error?: string; success?: string; csrfToken?: string },
): string {
  return authLayout({
    title: 'Set new password',
    content: `
      <h1>Set a new password</h1>
      <p class="subtitle">Choose a strong password for your account</p>

      ${opts?.error ? `<div class="error-msg">${escapeHtml(opts.error)}</div>` : ''}
      ${opts?.success ? `<div class="success-msg">${escapeHtml(opts.success)}</div>` : ''}

      ${
        opts?.success
          ? `
        <a href="/accounts/login" class="btn btn-primary mt-16">Log in with your new password</a>
      `
          : `
      <form method="POST" action="/accounts/reset-password">
        <input type="hidden" name="token" value="${escapeAttr(token)}">
        ${opts?.csrfToken ? csrfStore.hiddenField(opts.csrfToken) : ''}

        <div class="form-group">
          <label for="password">New password</label>
          <input type="password" id="password" name="password" placeholder="At least 8 characters" required minlength="8" autocomplete="new-password" autofocus>
        </div>

        <div class="form-group">
          <label for="password_confirm">Confirm new password</label>
          <input type="password" id="password_confirm" name="password_confirm" placeholder="Repeat your password" required minlength="8" autocomplete="new-password">
        </div>

        <button type="submit" class="btn btn-primary mt-16">Update password</button>
      </form>
      `
      }

      <p class="text-center text-sm mt-24">
        <a href="/accounts/login" class="link">Back to login</a>
      </p>
    `,
  })
}

// ---------------------------------------------------------------------------
// Handlers — Forgot Password
// ---------------------------------------------------------------------------

export function getForgotPassword(_req: Request, res: Response): void {
  res.send(renderForgotPassword())
}

export async function postForgotPassword(
  req: Request,
  res: Response,
): Promise<void> {
  const { email } = req.body ?? {}

  if (!email) {
    res.status(400).send(renderForgotPassword({ error: 'Email is required.' }))
    return
  }

  const emailClean = email.toLowerCase().trim()

  // Phase 14 Demo Mode — if db is null, just show success
  if (!db) {
    console.log('[forgot-password] Demo mode: showing success banner');
    res.send(
      renderForgotPassword({
        success:
          'If an account with that email exists, we sent a password reset link. Check your inbox.',
      }),
    )
    return
  }

  // Look up user — always show success to prevent email enumeration
  const user = await db
    .selectFrom('users')
    .select(['id', 'email'])
    .where('email', '=', emailClean)
    .where('status', '=', 'active')
    .executeTakeFirst()

  if (user) {
    // Generate reset token
    const rawToken = generateResetToken()
    const tokenHash = hashResetToken(rawToken)
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString()

    await db
      .updateTable('users')
      .set({
        password_reset_token: tokenHash,
        password_reset_expires: expiresAt,
      })
      .where('id', '=', user.id)
      .execute()

    const accountsBase = (process.env.ACCOUNTS_BASE_URL ?? '').replace(/\/+$/, '')
    const resetBase = accountsBase
      ? accountsBase
      : `${isProduction() ? 'https' : 'http'}://${req.headers.host}`
    const resetUrl = `${resetBase}/accounts/reset-password?token=${rawToken}`

    try {
      const result = await sendTemplatedEmail(db, {
        templateKey: 'password_reset',
        to: user.email,
        shopId: 'platform',
        variables: {
          user_name: user.email,
          reset_url: resetUrl,
        },
        idempotencyKey: `password_reset:${user.id}:${tokenHash}`,
      })
      if (!result.ok) {
        console.error(
          `[Password Reset] send failed for ${user.email}: ${result.reason ?? 'unknown'}`,
        )
      } else {
        console.log(`[Password Reset] delivery ${result.deliveryId} queued for ${user.email}`)
      }
    } catch (emailErr) {
      console.error(`[Password Reset] Email failed for ${user.email}:`, emailErr)
    }
  }

  // Always show success (prevents email enumeration)
  res.send(
    renderForgotPassword({
      success:
        'If an account with that email exists, we sent a password reset link. Check your inbox.',
    }),
  )
}

// ---------------------------------------------------------------------------
// Handlers — Reset Password
// ---------------------------------------------------------------------------

export async function getResetPassword(
  req: Request,
  res: Response,
): Promise<void> {
  const token = (req.query.token as string) ?? ''

  if (!token) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(400).send(
      renderResetPassword('', {
        error: 'Invalid or missing reset token. Please request a new reset link.',
        csrfToken,
      }),
    )
    return
  }

  // Phase 14 Demo Mode
  if (!db) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.send(renderResetPassword(token, { csrfToken }))
    return
  }

  // Verify token exists and is not expired
  const tokenHash = hashResetToken(token)
  const user = await db
    .selectFrom('users')
    .select('id')
    .where('password_reset_token', '=', tokenHash)
    .where('password_reset_expires', '>', new Date().toISOString())
    .executeTakeFirst()

  if (!user) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(400).send(
      renderResetPassword('', {
        error: 'This reset link has expired or is invalid. Please request a new one.',
        csrfToken,
      }),
    )
    return
  }

  const csrfToken = await csrfStore.issue(res, isProduction())
  res.send(renderResetPassword(token, { csrfToken }))
}

export async function postResetPassword(
  req: Request,
  res: Response,
): Promise<void> {
  // CSRF first — burn the secret even on failure to stop probing.
  if (!(await csrfStore.verify(req))) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    const formToken = (req.body?.token as string | undefined) ?? ''
    res.status(403).send(
      renderResetPassword(formToken, {
        error: 'Invalid form submission. Please reload and try again.',
        csrfToken,
      }),
    )
    return
  }

  const { token, password, password_confirm } = req.body ?? {}

  if (!token || !password) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res
      .status(400)
      .send(
        renderResetPassword(token ?? '', {
          error: 'All fields are required.',
          csrfToken,
        }),
      )
    return
  }

  const strength = validatePasswordStrength(password)
  if (!strength.valid) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res
      .status(400)
      .send(
        renderResetPassword(token, {
          error: strength.errors.join(' '),
          csrfToken,
        }),
      )
    return
  }

  if (password !== password_confirm) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res
      .status(400)
      .send(
        renderResetPassword(token, {
          error: 'Passwords do not match.',
          csrfToken,
        }),
      )
    return
  }

  // Phase 14 Demo Mode
  if (!db) {
    console.log('[forgot-password] Demo mode: reset success');
    res.send(
      renderResetPassword('', {
        success: 'Your password has been updated. You can now log in with your new password.',
      }),
    )
    return
  }

  // Verify token
  const tokenHash = hashResetToken(token)
  const user = await db
    .selectFrom('users')
    .select('id')
    .where('password_reset_token', '=', tokenHash)
    .where('password_reset_expires', '>', new Date().toISOString())
    .executeTakeFirst()

  if (!user) {
    const csrfToken = await csrfStore.issue(res, isProduction())
    res.status(400).send(
      renderResetPassword('', {
        error: 'This reset link has expired or is invalid. Please request a new one.',
        csrfToken,
      }),
    )
    return
  }

  const passwordHash = await hashPassword(password)
  await db
    .updateTable('users')
    .set({
      password_hash: passwordHash,
      password_reset_token: null,
      password_reset_expires: null,
    })
    .where('id', '=', user.id)
    .execute()

  // Invalidate all existing sessions for security
  await db.deleteFrom('sessions').where('user_id', '=', user.id).execute()

  res.send(
    renderResetPassword('', {
      success: 'Your password has been updated. You can now log in with your new password.',
    }),
  )
}

// ---------------------------------------------------------------------------
// Utils
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

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
