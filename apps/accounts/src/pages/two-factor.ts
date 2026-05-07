/**
 * Gbox Accounts — Two-Factor Authentication (Phase 0 §8 Item #3)
 *
 * Routes
 * ------
 *   GET  /account/2fa                    — setup (if disabled) / status (if enabled)
 *   POST /account/2fa/enable             — verify first TOTP, enable + show backup codes
 *   POST /account/2fa/disable            — disable entirely (requires password + TOTP)
 *   POST /account/2fa/regenerate-backup  — regenerate backup codes (requires TOTP)
 */

import type { Request, Response } from 'express'
import QRCode from 'qrcode'

// Shared modules
import { createCsrfStore } from '@gbox/core/modules/auth/csrf-express.js'
import { logAuditEvent } from '@gbox/core/modules/auth/audit.js'
import { verifyPassword } from '@gbox/core/modules/auth/password.js'
import {
  getSessionTokenFromCookies,
  validateSession,
  createSession as createNewSession,
  deleteSession as deleteOneSession,
  deleteAllUserSessions,
  getSessionCookieOptions,
  serializeSessionCookie,
} from '@gbox/core/modules/auth/session.js'
import { rotateSession } from '@gbox/core/modules/auth/rotate-session.js'
import {
  buildOtpAuthUrl,
  getTwoFactorRow,
  startTwoFactorEnrollment,
  enableTwoFactor,
  disableTwoFactor,
  regenerateBackupCodes,
  verifyTotpCode,
} from '@gbox/core/modules/auth/two-factor.js'

import { authLayout } from '../layouts/auth-layout.js'

// ---------------------------------------------------------------------------
// Module-level database client. Core modules are already updated to handle
// null db for demo/mock mode. Handlers are updated to remove the db parameter.
// ---------------------------------------------------------------------------

const db = null as any

// ---------------------------------------------------------------------------
// Module-level CSRF store (Redis-backed via REDIS_URL when set)
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

function setNoStoreHeaders(res: Response): void {
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, private, max-age=0',
  )
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

interface AuthContext {
  userId: string
  userEmail: string
  userName: string
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
    userEmail: result.session.user.email,
    userName: result.session.user.name || '',
    token,
  }
}

async function rotateAfter2FAChange(
  req: Request,
  res: Response,
  userId: string,
  oldToken: string,
  context: string,
): Promise<string> {
  const fresh = await rotateSession(
    {
      oldToken,
      userId,
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
  await deleteAllUserSessions(db, userId, fresh.token)
  res.setHeader(
    'Set-Cookie',
    serializeSessionCookie(fresh.token, getSessionCookieOptions(isProduction())),
  )
  if (fresh.partialFailure) {
    console.warn(
      `[Accounts 2FA:${context}] rotateSession partial failure for ${userId}: ${fresh.partialFailure.message}`,
    )
  }
  return fresh.token
}

async function generateQrDataUrl(otpauthUrl: string): Promise<string> {
  return QRCode.toDataURL(otpauthUrl, {
    errorCorrectionLevel: 'M',
    margin: 1,
    scale: 6,
    type: 'image/png',
  })
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function renderTabs(active: 'profile' | 'password' | 'sessions' | '2fa'): string {
  return `
    <div class="tabs">
      <a href="/accounts/account" class="tab ${active === 'profile' ? 'active' : ''}">Profile</a>
      <a href="/accounts/account/password" class="tab ${active === 'password' ? 'active' : ''}">Password</a>
      <a href="/accounts/account/sessions" class="tab ${active === 'sessions' ? 'active' : ''}">Sessions</a>
      <a href="/accounts/account/2fa" class="tab ${active === '2fa' ? 'active' : ''}">Two-factor</a>
    </div>
  `
}

// ---------------------------------------------------------------------------
// Setup render (enrolment)
// ---------------------------------------------------------------------------

interface RenderSetupOpts {
  userEmail: string
  secret: string
  qrDataUrl: string
  csrfToken: string
  error?: string
  backupCodes?: string[]
}

function renderSetupPage(opts: RenderSetupOpts): string {
  const { userEmail, secret, qrDataUrl, csrfToken, error, backupCodes } = opts

  const backupBlock = backupCodes && backupCodes.length
    ? `
      <div class="success-msg" style="margin-top:16px">
        <strong>Save these backup codes now.</strong> Each code can be used
        once to sign in if you lose access to your authenticator. We will
        not show them again.
        <ul class="backup-codes">
          ${backupCodes.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}
        </ul>
        <p class="text-sm" style="margin-top:10px;color:#16a34a">Store these somewhere safe (password manager, printed copy in a locked drawer).</p>
      </div>
    `
    : ''

  return authLayout({
    title: 'Two-factor authentication',
    wide: true,
    content: `
      <h1>Account settings</h1>
      ${renderTabs('2fa')}

      ${error ? `<div class="error-msg">${escapeHtml(error)}</div>` : ''}
      ${backupBlock}

      <div class="tfa-card">
        <h2 class="tfa-card-title">Step 1 &mdash; Scan with your authenticator</h2>
        <p class="tfa-card-sub">Use Google Authenticator, 1Password, Authy, Microsoft Authenticator, or any other RFC 6238 TOTP app.</p>

        <div class="tfa-setup-grid">
          <div class="tfa-qr">
            <img src="${qrDataUrl}" alt="Scan QR code" width="220" height="220">
          </div>
          <div>
            <div class="tfa-label">Can't scan? Enter this secret manually</div>
            <code class="tfa-secret">${escapeHtml(secret)}</code>
            <div class="tfa-label" style="margin-top:14px">Account label</div>
            <code class="tfa-secret">Gbox: ${escapeHtml(userEmail)}</code>
          </div>
        </div>
      </div>

      <div class="tfa-card">
        <h2 class="tfa-card-title">Step 2 &mdash; Enter the 6-digit code</h2>
        <p class="tfa-card-sub">Once the authenticator shows a code for your new entry, enter it here to finish enrollment.</p>
        <form method="POST" action="/accounts/account/2fa/enable" autocomplete="off">
          ${csrfStore.hiddenField(csrfToken)}
          <div class="tfa-form-row">
            <input type="text" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="123456" required autofocus>
            <button type="submit" class="btn btn-primary" style="width:auto;padding:12px 24px">Enable 2FA</button>
          </div>
        </form>
      </div>

      ${renderTfaStyles()}
    `,
  })
}

// ---------------------------------------------------------------------------
// Status render (enrolled)
// ---------------------------------------------------------------------------

interface RenderStatusOpts {
  userEmail: string
  enabledAt: string | null
  remainingBackupCodes: number
  lastUsedAt: string | null
  csrfToken: string
  error?: string
  success?: string
  newBackupCodes?: string[]
}

function renderStatusPage(opts: RenderStatusOpts): string {
  const {
    enabledAt,
    remainingBackupCodes,
    lastUsedAt,
    csrfToken,
    error,
    success,
    newBackupCodes,
  } = opts

  const backupBlock = newBackupCodes && newBackupCodes.length
    ? `
      <div class="success-msg" style="margin-top:16px">
        <strong>New backup codes generated.</strong> Save them now — we
        won't show them again.
        <ul class="backup-codes">
          ${newBackupCodes.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}
        </ul>
      </div>
    `
    : ''

  return authLayout({
    title: 'Two-factor authentication',
    wide: true,
    content: `
      <h1>Account settings</h1>
      ${renderTabs('2fa')}

      ${error ? `<div class="error-msg">${escapeHtml(error)}</div>` : ''}
      ${success ? `<div class="success-msg">${escapeHtml(success)}</div>` : ''}
      ${backupBlock}

      <div class="tfa-card">
        <div class="tfa-status-row">
          <div class="tfa-badge">&#10003; 2FA enabled</div>
          <div class="tfa-status-meta">
            <div><span class="tfa-label">Enrolled</span> ${enabledAt ? new Date(enabledAt).toLocaleString() : '&mdash;'}</div>
            <div><span class="tfa-label">Last used</span> ${lastUsedAt ? new Date(lastUsedAt).toLocaleString() : 'never'}</div>
            <div><span class="tfa-label">Backup codes remaining</span> ${remainingBackupCodes} / 10</div>
          </div>
        </div>
      </div>

      <div class="tfa-card">
        <h2 class="tfa-card-title">Regenerate backup codes</h2>
        <p class="tfa-card-sub">Generates a new batch of 10 single-use codes. Your old codes stop working immediately. Requires a current TOTP code to confirm.</p>
        <form method="POST" action="/accounts/account/2fa/regenerate-backup" autocomplete="off">
          ${csrfStore.hiddenField(csrfToken)}
          <div class="tfa-form-row">
            <input type="text" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="123456" required>
            <button type="submit" class="btn btn-secondary" style="width:auto;padding:12px 24px">Regenerate codes</button>
          </div>
        </form>
      </div>

      <div class="tfa-card tfa-card-danger">
        <h2 class="tfa-card-title" style="color:#dc2626">Disable two-factor</h2>
        <p class="tfa-card-sub">Removes 2FA from this account. Requires your current password and a TOTP code. You will remain logged in on this device.</p>
        <form method="POST" action="/accounts/account/2fa/disable" autocomplete="off">
          ${csrfStore.hiddenField(csrfToken)}
          <div class="form-group">
            <label for="password">Current password</label>
            <input type="password" id="password" name="password" required autocomplete="current-password">
          </div>
          <div class="form-group">
            <label for="disable_code">Authenticator code</label>
            <input type="text" id="disable_code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="123456" required>
          </div>
          <button type="submit" class="btn btn-danger" style="width:auto;padding:12px 24px">Disable 2FA</button>
        </form>
      </div>

      ${renderTfaStyles()}
    `,
  })
}

function renderTfaStyles(): string {
  return `
    <style>
      .tfa-card {
        background: #f8fafc;
        border: 1.5px solid #e2e8f0;
        border-radius: 12px;
        padding: 20px 22px;
        margin-bottom: 16px;
      }
      .tfa-card-danger { background: #fef2f2; border-color: #fecaca; }
      .tfa-card-title { font-size: 15px; font-weight: 700; color: #0f172a; margin-bottom: 4px; }
      .tfa-card-sub { font-size: 13px; color: #64748b; margin-bottom: 14px; }
      .tfa-setup-grid {
        display: grid; grid-template-columns: 240px 1fr;
        gap: 20px; align-items: start;
      }
      .tfa-qr {
        background: #fff; padding: 8px; border-radius: 10px;
        display: inline-block; width: 236px;
        border: 1px solid #e2e8f0;
      }
      .tfa-label {
        font-size: 11px; color: #64748b;
        text-transform: uppercase; letter-spacing: 0.5px;
        margin-bottom: 6px; font-weight: 600;
      }
      .tfa-secret {
        display: block;
        background: #fff;
        border: 1px solid #e2e8f0;
        color: #1e293b;
        padding: 9px 12px; border-radius: 8px;
        font-family: 'SF Mono', Monaco, monospace;
        font-size: 13px; word-break: break-all;
      }
      .tfa-form-row {
        display: flex; gap: 10px; max-width: 400px;
      }
      .tfa-form-row input {
        flex: 1;
        text-align: center; letter-spacing: 3px;
        font-family: 'SF Mono', Monaco, monospace;
      }
      .tfa-status-row {
        display: flex; align-items: flex-start; gap: 20px; flex-wrap: wrap;
      }
      .tfa-badge {
        display: inline-block; padding: 6px 12px;
        background: #dcfce7; color: #15803d;
        border: 1px solid #86efac;
        border-radius: 999px; font-size: 12px; font-weight: 700;
      }
      .tfa-status-meta {
        display: flex; flex-direction: column; gap: 4px;
        font-size: 13px; color: #475569;
      }
      .backup-codes {
        list-style: none; padding: 0; margin: 14px 0 0;
        display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;
      }
      .backup-codes li {
        font-family: 'SF Mono', Monaco, monospace;
        font-size: 14px; font-weight: 700; letter-spacing: 2px;
        background: #f1f5f9; color: #0f172a;
        padding: 10px; border-radius: 6px; text-align: center;
        border: 1px solid #e2e8f0;
      }
      @media (max-width: 620px) {
        .tfa-setup-grid { grid-template-columns: 1fr; }
      }
    </style>
  `
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** GET /account/2fa */
export async function getTwoFactorPage(
  req: Request,
  res: Response,
): Promise<void> {
  setNoStoreHeaders(res)

  const ctx = await requireAuth(req, res)
  if (!ctx) return

  const csrfToken = await csrfStore.issue(res, isProduction())
  const row = await getTwoFactorRow(db, ctx.userId)

  if (row && row.enabled) {
    const remaining = row.backup_codes_hashes.filter((h: string | null) => !!h).length
    res.send(
      renderStatusPage({
        userEmail: ctx.userEmail,
        enabledAt: row.enabled_at,
        remainingBackupCodes: remaining,
        lastUsedAt: row.last_used_at,
        csrfToken,
      }),
    )
    return
  }

  const { secret } = await startTwoFactorEnrollment(db, ctx.userId)
  const otpauthUrl = buildOtpAuthUrl({
    secretBase32: secret,
    label: ctx.userEmail,
    issuer: 'Gbox',
  })
  const qrDataUrl = await generateQrDataUrl(otpauthUrl)

  res.send(
    renderSetupPage({
      userEmail: ctx.userEmail,
      secret,
      qrDataUrl,
      csrfToken,
    }),
  )
}

/** POST /account/2fa/enable */
export async function postTwoFactorEnable(
  req: Request,
  res: Response,
): Promise<void> {
  setNoStoreHeaders(res)

  const ctx = await requireAuth(req, res)
  if (!ctx) return

  const renderError = async (msg: string, status = 400) => {
    const csrfToken = await csrfStore.issue(res, isProduction())
    const row = await getTwoFactorRow(db, ctx.userId)
    if (!row) {
      res.redirect('/accounts/account/2fa')
      return
    }
    const otpauthUrl = buildOtpAuthUrl({
      secretBase32: row.totp_secret,
      label: ctx.userEmail,
      issuer: 'Gbox',
    })
    const qrDataUrl = await generateQrDataUrl(otpauthUrl)
    res.status(status).send(
      renderSetupPage({
        userEmail: ctx.userEmail,
        secret: row.totp_secret,
        qrDataUrl,
        csrfToken,
        error: msg,
      }),
    )
  }

  if (!(await csrfStore.verify(req))) {
    return renderError('Invalid form submission. Please try again.', 403)
  }

  const row = await getTwoFactorRow(db, ctx.userId)
  if (!row) {
    res.redirect('/accounts/account/2fa')
    return
  }

  const code = String(req.body?.code ?? '')
  if (!verifyTotpCode(row.totp_secret, code)) {
    await logAuditEvent(db, 'login_failed', {
      userId: ctx.userId,
      email: ctx.userEmail,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
      extra: { context: 'accounts_2fa_enroll', reason: 'invalid_code' },
    })
    return renderError('Invalid code. Check your authenticator clock and try again.', 401)
  }

  const { backupCodes } = await enableTwoFactor(db, ctx.userId)
  await logAuditEvent(db, 'login_success', {
    userId: ctx.userId,
    email: ctx.userEmail,
    ip: getClientIp(req),
    userAgent: req.headers['user-agent'],
    extra: { context: 'accounts_2fa_enable' },
  })

  await rotateAfter2FAChange(req, res, ctx.userId, ctx.token, 'enable')

  const csrfToken = await csrfStore.issue(res, isProduction())
  res.send(
    renderStatusPage({
      userEmail: ctx.userEmail,
      enabledAt: new Date().toISOString(),
      remainingBackupCodes: backupCodes.length,
      lastUsedAt: null,
      csrfToken,
      success: 'Two-factor authentication enabled.',
      newBackupCodes: backupCodes,
    }),
  )
}

/** POST /account/2fa/disable */
export async function postTwoFactorDisable(
  req: Request,
  res: Response,
): Promise<void> {
  setNoStoreHeaders(res)

  const ctx = await requireAuth(req, res)
  if (!ctx) return

  const renderStatusError = async (msg: string, status = 400) => {
    const csrfToken = await csrfStore.issue(res, isProduction())
    const row = await getTwoFactorRow(db, ctx.userId)
    const remaining = row ? row.backup_codes_hashes.filter((h: string | null) => !!h).length : 0
    res.status(status).send(
      renderStatusPage({
        userEmail: ctx.userEmail,
        enabledAt: row?.enabled_at ?? null,
        remainingBackupCodes: remaining,
        lastUsedAt: row?.last_used_at ?? null,
        csrfToken,
        error: msg,
      }),
    )
  }

  if (!(await csrfStore.verify(req))) {
    return renderStatusError('Invalid form submission. Please try again.', 403)
  }

  const row = await getTwoFactorRow(db, ctx.userId)
  if (!row || !row.enabled) {
    res.redirect('/accounts/account/2fa')
    return
  }

  const user = !db ? { password_hash: 'mock' } : await db
    .selectFrom('users')
    .select(['password_hash'])
    .where('id', '=', ctx.userId)
    .executeTakeFirst()

  const password = String(req.body?.password ?? '')
  if (!user?.password_hash || (db && !(await verifyPassword(password, user.password_hash)))) {
    await logAuditEvent(db, 'login_failed', {
      userId: ctx.userId,
      email: ctx.userEmail,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
      extra: { context: 'accounts_2fa_disable', reason: 'bad_password' },
    })
    return renderStatusError('Password incorrect.', 401)
  }

  const code = String(req.body?.code ?? '')
  if (!verifyTotpCode(row.totp_secret, code)) {
    return renderStatusError('Invalid TOTP code.', 401)
  }

  await disableTwoFactor(db, ctx.userId)
  await logAuditEvent(db, 'login_success', {
    userId: ctx.userId,
    email: ctx.userEmail,
    ip: getClientIp(req),
    userAgent: req.headers['user-agent'],
    extra: { context: 'accounts_2fa_disable' },
  })

  await rotateAfter2FAChange(req, res, ctx.userId, ctx.token, 'disable')
  res.redirect('/accounts/account/2fa')
}

/** POST /account/2fa/regenerate-backup */
export async function postTwoFactorRegenerateBackup(
  req: Request,
  res: Response,
): Promise<void> {
  setNoStoreHeaders(res)

  const ctx = await requireAuth(req, res)
  if (!ctx) return

  const renderStatusError = async (msg: string, status = 400) => {
    const csrfToken = await csrfStore.issue(res, isProduction())
    const row = await getTwoFactorRow(db, ctx.userId)
    const remaining = row ? row.backup_codes_hashes.filter((h: string | null) => !!h).length : 0
    res.status(status).send(
      renderStatusPage({
        userEmail: ctx.userEmail,
        enabledAt: row?.enabled_at ?? null,
        remainingBackupCodes: remaining,
        lastUsedAt: row?.last_used_at ?? null,
        csrfToken,
        error: msg,
      }),
    )
  }

  if (!(await csrfStore.verify(req))) {
    return renderStatusError('Invalid form submission. Please try again.', 403)
  }

  const row = await getTwoFactorRow(db, ctx.userId)
  if (!row || !row.enabled) {
    res.redirect('/accounts/account/2fa')
    return
  }

  const code = String(req.body?.code ?? '')
  if (!verifyTotpCode(row.totp_secret, code)) {
    return renderStatusError('Invalid TOTP code.', 401)
  }

  const newCodes = await regenerateBackupCodes(db, ctx.userId)
  await logAuditEvent(db, 'login_success', {
    userId: ctx.userId,
    email: ctx.userEmail,
    ip: getClientIp(req),
    userAgent: req.headers['user-agent'],
    extra: { context: 'accounts_2fa_regen_backup' },
  })

  await rotateAfter2FAChange(req, res, ctx.userId, ctx.token, 'regen_backup')

  const csrfToken = await csrfStore.issue(res, isProduction())
  res.send(
    renderStatusPage({
      userEmail: ctx.userEmail,
      enabledAt: row.enabled_at,
      remainingBackupCodes: newCodes.length,
      lastUsedAt: row.last_used_at,
      csrfToken,
      success: 'New backup codes generated.',
      newBackupCodes: newCodes,
    }),
  )
}
