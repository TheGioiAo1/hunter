/**
 * Gbox Accounts — Account Settings Page
 *
 * GET  /account              — Account settings (profile tab)
 * POST /account/profile      — Update name/email
 * POST /account/password     — Change password
 * GET  /account/sessions     — Active sessions list
 * POST /account/sessions/revoke-all  — Revoke all other sessions
 */

import type { Request, Response } from 'express'
import {
  getSessionTokenFromCookies,
  validateSession,
  getUserSessions,
  deleteAllUserSessions,
  getSessionCookieOptions,
  serializeSessionCookie,
  createSession as createNewSession,
  deleteSession as deleteOneSession,
} from '@gbox/core/modules/auth/session.js'
import { rotateSession } from '@gbox/core/modules/auth/rotate-session.js'
import {
  hashPassword,
  verifyPassword,
  isLegacyHash,
  validatePasswordStrength,
} from '@gbox/core/modules/auth/password.js'
import { createCsrfStore } from '@gbox/core/modules/auth/csrf-express.js'
import { authLayout } from '../layouts/auth-layout.js'

// ---------------------------------------------------------------------------
// Module-level database client. Core modules are already updated to handle
// null db for demo/mock mode. Handlers are updated to remove the db parameter.
// ---------------------------------------------------------------------------

const db = null as any

// ---------------------------------------------------------------------------
// Module-level CSRF store
// ---------------------------------------------------------------------------

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_account' })

function isProductionEnv(): boolean {
  return process.env.NODE_ENV === 'production'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function getBackToStoresUrl(): string {
  const base = (process.env.STORE_ADMIN_BASE_URL ?? '').replace(/\/+$/, '')
  if (!base) return '/accounts/stores'
  return `${base}/stores`
}

interface AuthContext {
  userId: string
  userName: string
  userEmail: string
  token: string
}

async function requireAuth(
  req: Request,
  res: Response,
): Promise<AuthContext | null> {
  const token = getSessionTokenFromCookies(req.headers.cookie ?? '')
  if (!token) {
    res.redirect('/accounts/login')
    return null
  }
  const result = await validateSession(db, token)
  if (!result.valid || !result.session) {
    res.redirect('/accounts/login')
    return null
  }
  return {
    userId: result.session.user.id,
    userName: result.session.user.name || '',
    userEmail: result.session.user.email,
    token,
  }
}

// ---------------------------------------------------------------------------
// Profile tab render
// ---------------------------------------------------------------------------

function renderProfile(
  user: { name: string; email: string },
  opts?: { error?: string; success?: string; csrfToken?: string },
): string {
  return authLayout({
    title: 'Account settings',
    wide: true,
    content: `
      <h1>Account settings</h1>

      <div class="tabs">
        <a href="/accounts/account" class="tab active">Profile</a>
        <a href="/accounts/account/password" class="tab">Password</a>
        <a href="/accounts/account/sessions" class="tab">Sessions</a>
        <a href="/accounts/account/2fa" class="tab">Two-factor</a>
      </div>

      ${opts?.error ? `<div class="error-msg">${escapeHtml(opts.error)}</div>` : ''}
      ${opts?.success ? `<div class="success-msg">${escapeHtml(opts.success)}</div>` : ''}

      <form method="POST" action="/accounts/account/profile">
        ${opts?.csrfToken ? csrfStore.hiddenField(opts.csrfToken) : ''}
        <div class="form-group">
          <label for="name">Full name</label>
          <input type="text" id="name" name="name" value="${escapeAttr(user.name)}" required>
        </div>

        <div class="form-group">
          <label for="email">Email address</label>
          <input type="email" id="email" name="email" value="${escapeAttr(user.email)}" required>
        </div>

        <button type="submit" class="btn btn-primary" style="width:auto;padding:10px 24px">Save changes</button>
      </form>

      <div class="text-center mt-24">
        <a href="${getBackToStoresUrl()}" class="link text-sm">Back to stores</a>
      </div>
    `,
  })
}

// ---------------------------------------------------------------------------
// Password tab render
// ---------------------------------------------------------------------------

function renderPasswordForm(
  opts?: { error?: string; success?: string; csrfToken?: string },
): string {
  return authLayout({
    title: 'Change password',
    wide: true,
    content: `
      <h1>Account settings</h1>

      <div class="tabs">
        <a href="/accounts/account" class="tab">Profile</a>
        <a href="/accounts/account/password" class="tab active">Password</a>
        <a href="/accounts/account/sessions" class="tab">Sessions</a>
        <a href="/accounts/account/2fa" class="tab">Two-factor</a>
      </div>

      ${opts?.error ? `<div class="error-msg">${escapeHtml(opts.error)}</div>` : ''}
      ${opts?.success ? `<div class="success-msg">${escapeHtml(opts.success)}</div>` : ''}

      <form method="POST" action="/accounts/account/password">
        ${opts?.csrfToken ? csrfStore.hiddenField(opts.csrfToken) : ''}
        <div class="form-group">
          <label for="current_password">Current password</label>
          <input type="password" id="current_password" name="current_password" required autocomplete="current-password">
        </div>

        <div class="form-group">
          <label for="new_password">New password</label>
          <input type="password" id="new_password" name="new_password" placeholder="At least 8 characters" required minlength="8" autocomplete="new-password">
        </div>

        <div class="form-group">
          <label for="confirm_password">Confirm new password</label>
          <input type="password" id="confirm_password" name="confirm_password" required minlength="8" autocomplete="new-password">
        </div>

        <button type="submit" class="btn btn-primary" style="width:auto;padding:10px 24px">Update password</button>
      </form>

      <div class="text-center mt-24">
        <a href="${getBackToStoresUrl()}" class="link text-sm">Back to stores</a>
      </div>
    `,
  })
}

// ---------------------------------------------------------------------------
// Sessions tab render
// ---------------------------------------------------------------------------

function renderSessions(
  sessions: Array<{
    id: string
    ipAddress: string | null
    userAgent: string | null
    createdAt: string
    expiresAt: string
  }>,
  opts?: { success?: string; csrfToken?: string },
): string {
  const sessionRows = sessions
    .map(
      (s, i) => `
      <div class="session-item">
        <div>
          <div class="session-info" style="font-weight:500;color:#1e293b">
            ${escapeHtml(parseUserAgent(s.userAgent))}
          </div>
          <div class="session-info">
            IP: ${escapeHtml(s.ipAddress || 'Unknown')}
            &middot; Created: ${formatDate(s.createdAt)}
          </div>
        </div>
        ${i === 0 ? '<span class="session-current">Current</span>' : ''}
      </div>
    `,
    )
    .join('')

  return authLayout({
    title: 'Active sessions',
    wide: true,
    content: `
      <h1>Account settings</h1>

      <div class="tabs">
        <a href="/accounts/account" class="tab">Profile</a>
        <a href="/accounts/account/password" class="tab">Password</a>
        <a href="/accounts/account/sessions" class="tab active">Sessions</a>
        <a href="/accounts/account/2fa" class="tab">Two-factor</a>
      </div>

      ${opts?.success ? `<div class="success-msg">${escapeHtml(opts.success)}</div>` : ''}

      <p class="text-sm mb-16">These are all active sessions for your account.</p>

      <div style="margin-bottom:24px">
        ${sessionRows || '<p class="text-sm" style="color:#94a3b8">No active sessions found.</p>'}
      </div>

      ${
        sessions.length > 1
          ? `
        <form method="POST" action="/accounts/account/sessions/revoke-all">
          ${opts?.csrfToken ? csrfStore.hiddenField(opts.csrfToken) : ''}
          <button type="submit" class="btn btn-danger" style="width:auto;padding:10px 24px">
            Revoke all other sessions
          </button>
        </form>
      `
          : ''
      }

      <div class="text-center mt-24">
        <a href="${getBackToStoresUrl()}" class="link text-sm">Back to stores</a>
      </div>
    `,
  })
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** GET /account */
export async function getAccount(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = await requireAuth(req, res)
  if (!ctx) return
  const csrfToken = await csrfStore.issue(res, isProductionEnv())
  res.send(renderProfile({ name: ctx.userName, email: ctx.userEmail }, { csrfToken }))
}

/** POST /account/profile */
export async function postProfile(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = await requireAuth(req, res)
  if (!ctx) return

  if (!(await csrfStore.verify(req))) {
    const csrfToken = await csrfStore.issue(res, isProductionEnv())
    res.status(403).send(
      renderProfile(
        { name: ctx.userName, email: ctx.userEmail },
        { error: 'Invalid form submission. Please try again.', csrfToken },
      ),
    )
    return
  }

  const { name, email } = req.body ?? {}

  if (!name || !email) {
    const csrfToken = await csrfStore.issue(res, isProductionEnv())
    res
      .status(400)
      .send(
        renderProfile(
          { name: ctx.userName, email: ctx.userEmail },
          { error: 'Name and email are required.', csrfToken },
        ),
      )
    return
  }

  const emailClean = email.toLowerCase().trim()

  // Phase 14 Demo Mode
  if (!db) {
    console.log('[account-settings] Demo mode: profile update success');
    const csrfToken = await csrfStore.issue(res, isProductionEnv())
    res.send(
      renderProfile(
        { name, email: emailClean },
        { success: 'Profile updated successfully.', csrfToken },
      ),
    )
    return
  }

  if (emailClean !== ctx.userEmail) {
    const existing = await db
      .selectFrom('users')
      .select('id')
      .where('email', '=', emailClean)
      .where('id', '!=', ctx.userId)
      .executeTakeFirst()

    if (existing) {
      const csrfToken = await csrfStore.issue(res, isProductionEnv())
      res.status(409).send(
        renderProfile(
          { name: name.trim(), email: emailClean },
          { error: 'This email is already in use by another account.', csrfToken },
        ),
      )
      return
    }
  }

  await db
    .updateTable('users')
    .set({
      name: name.trim(),
      email: emailClean,
    })
    .where('id', '=', ctx.userId)
    .execute()

  const csrfToken = await csrfStore.issue(res, isProductionEnv())
  res.send(
    renderProfile(
      { name: name.trim(), email: emailClean },
      { success: 'Profile updated.', csrfToken },
    ),
  )
}

/** GET /account/password */
export async function getPasswordForm(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = await requireAuth(req, res)
  if (!ctx) return
  const csrfToken = await csrfStore.issue(res, isProductionEnv())
  res.send(renderPasswordForm({ csrfToken }))
}

/** POST /account/password */
export async function postPassword(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = await requireAuth(req, res)
  if (!ctx) return

  if (!(await csrfStore.verify(req))) {
    const csrfToken = await csrfStore.issue(res, isProductionEnv())
    res.status(403).send(
      renderPasswordForm({
        error: 'Invalid form submission. Please try again.',
        csrfToken,
      }),
    )
    return
  }

  const { current_password, new_password, confirm_password } = req.body ?? {}

  if (!current_password || !new_password || !confirm_password) {
    const csrfToken = await csrfStore.issue(res, isProductionEnv())
    res
      .status(400)
      .send(renderPasswordForm({ error: 'All fields are required.', csrfToken }))
    return
  }

  const strength = validatePasswordStrength(new_password)
  if (!strength.valid) {
    const csrfToken = await csrfStore.issue(res, isProductionEnv())
    res
      .status(400)
      .send(
        renderPasswordForm({
          error: strength.errors.join(' '),
          csrfToken,
        }),
      )
    return
  }

  if (new_password !== confirm_password) {
    const csrfToken = await csrfStore.issue(res, isProductionEnv())
    res
      .status(400)
      .send(
        renderPasswordForm({ error: 'New passwords do not match.', csrfToken }),
      )
    return
  }

  // Phase 14 Demo Mode
  if (!db) {
    console.log('[account-settings] Demo mode: password update success');
    const csrfToken = await csrfStore.issue(res, isProductionEnv())
    res.send(renderPasswordForm({ success: 'Password updated.', csrfToken }))
    return
  }

  const user = await db
    .selectFrom('users')
    .select(['password_hash'])
    .where('id', '=', ctx.userId)
    .executeTakeFirst()

  if (!user?.password_hash) {
    const csrfToken = await csrfStore.issue(res, isProductionEnv())
    res
      .status(400)
      .send(
        renderPasswordForm({
          error: 'No password set on this account. Use Forgot Password to set one.',
          csrfToken,
        }),
      )
    return
  }

  const currentOk = await verifyPassword(current_password, user.password_hash)
  if (!currentOk) {
    const csrfToken = await csrfStore.issue(res, isProductionEnv())
    res
      .status(401)
      .send(
        renderPasswordForm({
          error: 'Current password is incorrect.',
          csrfToken,
        }),
      )
    return
  }

  const newHash = await hashPassword(new_password)
  await db
    .updateTable('users')
    .set({ password_hash: newHash })
    .where('id', '=', ctx.userId)
    .execute()

  if (isLegacyHash(user.password_hash)) {
    console.log(
      `[Password] Migrated legacy SHA-256 → bcrypt for user ${ctx.userId}`,
    )
  }

  const fresh = await rotateSession(
    {
      oldToken: ctx.token,
      userId: ctx.userId,
      meta: {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      },
    },
    {
      createSession: (uid, meta) => createNewSession(db, uid, meta),
      deleteSession: (t) => deleteOneSession(db, t),
    },
  )
  await deleteAllUserSessions(db, ctx.userId, fresh.token)
  res.setHeader(
    'Set-Cookie',
    serializeSessionCookie(fresh.token, getSessionCookieOptions(isProduction())),
  )
  if (fresh.partialFailure) {
    console.warn(
      `[Password] rotateSession partial failure for ${ctx.userId}: ${fresh.partialFailure.message}`,
    )
  }

  const csrfToken = await csrfStore.issue(res, isProductionEnv())
  res.send(renderPasswordForm({ success: 'Password updated.', csrfToken }))
}

/** GET /account/sessions */
export async function getSessionsPage(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = await requireAuth(req, res)
  if (!ctx) return

  const sessions = await getUserSessions(db, ctx.userId)
  const csrfToken = await csrfStore.issue(res, isProductionEnv())
  res.send(renderSessions(sessions, { csrfToken }))
}

/** POST /account/sessions/revoke-all */
export async function postRevokeAllSessions(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = await requireAuth(req, res)
  if (!ctx) return

  if (!(await csrfStore.verify(req))) {
    const sessions = await getUserSessions(db, ctx.userId)
    const csrfToken = await csrfStore.issue(res, isProductionEnv())
    res.status(403).send(renderSessions(sessions, { csrfToken }))
    return
  }

  await deleteAllUserSessions(db, ctx.userId)

  const { token } = await createNewSession(db, ctx.userId, {
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  })

  const cookieOpts = getSessionCookieOptions(isProduction())
  res.setHeader('Set-Cookie', serializeSessionCookie(token, cookieOpts))

  const sessions = await getUserSessions(db, ctx.userId)
  const csrfToken = await csrfStore.issue(res, isProductionEnv())
  res.send(
    renderSessions(sessions, {
      success: 'All other sessions have been revoked.',
      csrfToken,
    }),
  )
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function parseUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device'

  if (ua.includes('Chrome') && !ua.includes('Edg')) return 'Chrome'
  if (ua.includes('Firefox')) return 'Firefox'
  if (ua.includes('Safari') && !ua.includes('Chrome')) return 'Safari'
  if (ua.includes('Edg')) return 'Microsoft Edge'
  if (ua.includes('Opera') || ua.includes('OPR')) return 'Opera'

  if (ua.includes('Windows')) return 'Windows Browser'
  if (ua.includes('Mac')) return 'Mac Browser'
  if (ua.includes('Linux')) return 'Linux Browser'
  if (ua.includes('Android')) return 'Android Browser'
  if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS Browser'

  return 'Unknown browser'
}

function formatDate(isoString: string): string {
  try {
    const date = new Date(isoString)
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return isoString
  }
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
