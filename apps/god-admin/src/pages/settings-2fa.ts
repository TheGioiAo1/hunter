/**
 * God Admin — 2FA Settings Page
 *
 * This page lives INSIDE the authenticated god-admin zone (the
 * god-auth middleware has already verified the user is a fully
 * logged-in God Admin — including their 2FA if already enrolled).
 *
 * Routes
 * ------
 *   GET  /god-admin/settings/2fa                   — setup / status page
 *   POST /god-admin/settings/2fa/enable            — verify first code, enable + show backup codes
 *   POST /god-admin/settings/2fa/disable           — disable entirely (requires TOTP confirmation)
 *   POST /god-admin/settings/2fa/regenerate-backup — regenerate backup codes (requires TOTP)
 *
 * Enrollment flow
 * ---------------
 *   1. User visits the page for the first time → server calls
 *      startTwoFactorEnrollment() which upserts a user_2fa row with a
 *      fresh secret and enabled=false.
 *   2. Server generates an inline PNG data URL for the otpauth://
 *      URI via the `qrcode` npm package (runs entirely in-process, no
 *      3rd-party services touched), and shows the plaintext secret
 *      alongside for manual entry.
 *   3. User scans with Google Authenticator, enters the 6-digit code,
 *      server verifies via verifyTotpCode(). On success, enableTwoFactor()
 *      flips enabled=true and returns 10 single-use backup codes.
 *   4. Backup codes are displayed exactly ONCE on a confirmation screen.
 *
 * Note
 * ----
 * The QR code is generated *server-side* as a base64 PNG embedded in
 * the page via a `data:` URL. The TOTP secret never leaves this
 * process — we previously used chart.googleapis.com which (a) leaked
 * the secret to a 3rd party and (b) was deprecated by Google in late
 * 2024 so the image wouldn't render anymore. `qrcode` is pure-JS,
 * already hoisted to the repo root node_modules, and adds no new
 * dependencies to install.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
// Local QR-code generation — keeps the TOTP secret on our infrastructure
// instead of shipping it to a 3rd-party chart API. `qrcode` is a pure-JS
// package already resolved at the repo root via workspace hoisting; no
// extra install is needed. We use the default CJS import which Node's
// ESM loader unwraps automatically.
import QRCode from 'qrcode'

import { godLayout, readThemeFromRequest } from '../layouts/god-layout.js'
// Phase 0.4b-redis: shared CSRF store (auto-Redis via REDIS_URL) so the
// 2FA settings page works under pm2 cluster mode.
import { createCsrfStore } from '@gbox/core/modules/auth/csrf-express.js'
import { logAuditEvent } from '../../../../packages/core/src/modules/auth/audit.js'
import {
  getSessionTokenFromCookies,
  createSession as createNewSession,
  deleteSession as deleteOneSession,
  deleteAllUserSessions,
  getSessionCookieOptions,
  serializeSessionCookie,
} from '../../../../packages/core/src/modules/auth/session.js'
import { verifyPassword } from '../../../../packages/core/src/modules/auth/password.js'
// Phase 0 close-the-loop — rotate the session whenever 2FA is
// enabled / disabled / backup codes regenerated. Those are all
// privilege-change events and any pre-existing cookie must be
// invalidated the instant the change lands.
import { rotateSession } from '../../../../packages/core/src/modules/auth/rotate-session.js'
import {
  buildOtpAuthUrl,
  getTwoFactorRow,
  startTwoFactorEnrollment,
  enableTwoFactor,
  disableTwoFactor,
  regenerateBackupCodes,
  verifyTotpCode,
} from '../../../../packages/core/src/modules/auth/two-factor.js'

// ---------------------------------------------------------------------------
// Module-level CSRF store — Redis-backed when REDIS_URL is set.
// ---------------------------------------------------------------------------

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_god_settings_2fa' })

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function escapeHtml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Phase 0 close-the-loop — rotate the session token after a 2FA
 * privilege change and force-logout every OTHER active session on
 * the same user. Keeps the caller's browser logged in via the new
 * cookie; everything else must re-authenticate from scratch.
 */
async function rotateAfter2FAChange(
  req: Request,
  res: Response,
  db: Kysely<Database>,
  userId: string,
  context: string,
): Promise<void> {
  const oldToken = getSessionTokenFromCookies(req.headers.cookie ?? '') ?? ''
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
  // Force logout every other device — the operator may have granted
  // 2FA on the wrong device, and this wipes any shadow sessions.
  await deleteAllUserSessions(db, userId, fresh.token)
  res.setHeader(
    'Set-Cookie',
    serializeSessionCookie(fresh.token, getSessionCookieOptions(isProduction())),
  )
  if (fresh.partialFailure) {
    console.warn(
      `[2FA:${context}] rotateSession partial failure for ${userId}: ${fresh.partialFailure.message}`,
    )
  }
}

/**
 * Prevent the 2FA setup page from being cached by the browser in ANY
 * form — especially the back/forward cache (BFCache). BFCache is a
 * Chrome/Firefox optimization that keeps a full DOM snapshot of the
 * previous page in memory so Back navigation is instant; unfortunately
 * that snapshot includes the plaintext TOTP secret and the PNG QR
 * code we rendered, which would let anyone with access to the browser
 * session recover the secret after enrollment by simply pressing
 * Back. `Cache-Control: no-store` is the spec-defined opt-out from
 * BFCache (https://web.dev/articles/bfcache#never-cache-with-no-store),
 * and combined with the legacy headers below we also defeat HTTP
 * proxy caches and IE/Edge Legacy.
 *
 * Applied to every 2FA settings response — even the status page,
 * because a compromised-browser scenario shouldn't let an attacker
 * recover backup codes or remaining-codes counts either.
 */
function setNoStoreHeaders(res: Response): void {
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, private, max-age=0',
  )
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
}

function getClientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown'
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

interface RenderSetupOpts {
  userEmail: string
  secret: string
  otpauthUrl: string
  /**
   * Inline `data:image/png;base64,...` URL for the QR code. Generated
   * server-side via `qrcode` so the TOTP secret never leaves this
   * process. See `generateQrDataUrl()`.
   */
  qrDataUrl: string
  csrfToken: string
  error?: string
  backupCodes?: string[] // shown exactly once right after first enable
}

/**
 * Generate a base64-encoded PNG data URL for an otpauth:// URI. Runs
 * entirely in-process (no network, no 3rd party). Called by
 * `getSettings2fa` and `renderError` in `postSettings2faEnable`.
 *
 * Why PNG and not SVG: Google Authenticator + Authy both handle PNG
 * without issue, and data-URL PNGs render offline in every browser
 * we care about. SVG would be smaller but adds one more edge-case
 * (sandboxed SVG rendering in some email clients that preview admin
 * pages in-app).
 *
 * Error correction level M = tolerates ~15% damage; margin 1 keeps
 * the visual footprint tight; scale 6 gives a ~220×220 px image which
 * matches the previous chart.googleapis.com layout.
 */
async function generateQrDataUrl(otpauthUrl: string): Promise<string> {
  return QRCode.toDataURL(otpauthUrl, {
    errorCorrectionLevel: 'M',
    margin: 1,
    scale: 6,
    type: 'image/png',
  })
}

function renderSetupContent(opts: RenderSetupOpts): string {
  const { userEmail, secret, qrDataUrl, csrfToken, error, backupCodes } = opts

  const backupBlock = backupCodes && backupCodes.length
    ? `
      <div class="alert alert-success">
        <strong>Save these backup codes now.</strong> Each code can be used
        once to sign in if you lose access to your authenticator. We will
        not show them again.
        <ul class="backup-codes">
          ${backupCodes.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}
        </ul>
        <p style="margin-top:12px;font-size:12px;color:#64748b">Store these somewhere safe (password manager, printed copy in a locked drawer).</p>
      </div>
    `
    : ''

  return `
    <div class="page-head">
      <h1 class="page-title">Two-Factor Authentication</h1>
      <p class="page-sub">Protect your God Admin account <strong>${escapeHtml(userEmail)}</strong> with a second factor.</p>
    </div>

    ${error ? `<div class="alert alert-error">${escapeHtml(error)}</div>` : ''}
    ${backupBlock}

    <div class="card">
      <h2 class="card-title">Step 1 &mdash; Scan with your authenticator</h2>
      <p class="card-sub">Use Google Authenticator, 1Password, Authy, Microsoft Authenticator, or any other RFC 6238 TOTP app.</p>
      <div class="setup-grid">
        <div class="qr-box">
          <img src="${qrDataUrl}" alt="Scan QR code" width="220" height="220">
        </div>
        <div>
          <p class="label">Can't scan? Enter this secret manually:</p>
          <code class="secret">${escapeHtml(secret)}</code>
          <p class="label" style="margin-top:16px">Account label</p>
          <code class="secret">Gbox God Admin: ${escapeHtml(userEmail)}</code>
        </div>
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">Step 2 &mdash; Enter the 6-digit code</h2>
      <p class="card-sub">Once the authenticator app shows a code for your new entry, enter it here to finish enrollment.</p>
      <form method="POST" action="/god-admin/settings/2fa/enable" autocomplete="off">
        ${csrfStore.hiddenField(csrfToken)}
        <div class="form-row">
          <input type="text" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="123456" required autofocus>
          <button type="submit" class="btn btn-primary">Enable 2FA</button>
        </div>
      </form>
    </div>

    <style>
      .page-head { margin-bottom: 24px; }
      .page-title { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
      .page-sub { color: var(--god-fg-muted, #64748b); font-size: 14px; }
      .card {
        background: var(--god-card, #1e293b);
        border: 1px solid var(--god-border, #334155);
        border-radius: 12px; padding: 24px; margin-bottom: 20px;
      }
      .card-title { font-size: 16px; font-weight: 700; margin-bottom: 4px; }
      .card-sub { color: var(--god-fg-muted, #94a3b8); font-size: 13px; margin-bottom: 16px; }
      .setup-grid {
        display: grid; grid-template-columns: 240px 1fr;
        gap: 24px; align-items: start;
      }
      .qr-box {
        background: #fff; padding: 10px; border-radius: 10px;
        display: inline-block; width: 240px;
      }
      .label {
        font-size: 12px; color: var(--god-fg-muted, #94a3b8);
        text-transform: uppercase; letter-spacing: 0.5px;
        margin-bottom: 6px;
      }
      .secret {
        display: block;
        background: var(--god-bg, #0f172a);
        border: 1px solid var(--god-border, #334155);
        color: var(--god-fg, #e2e8f0);
        padding: 10px 12px; border-radius: 8px;
        font-family: 'SF Mono', Monaco, monospace;
        font-size: 13px; word-break: break-all;
      }
      .form-row { display: flex; gap: 12px; max-width: 400px; }
      .form-row input {
        flex: 1; padding: 12px 16px;
        background: var(--god-bg, #0f172a);
        border: 1.5px solid var(--god-border, #334155);
        border-radius: 8px; color: var(--god-fg, #e2e8f0);
        font-size: 16px; font-family: 'SF Mono', Monaco, monospace;
        text-align: center; letter-spacing: 3px;
      }
      .btn {
        padding: 12px 20px; border-radius: 8px; border: none;
        font-size: 14px; font-weight: 700; cursor: pointer;
      }
      .btn-primary {
        background: linear-gradient(135deg, #3b82f6, #2563eb); color: #fff;
      }
      .btn-danger {
        background: linear-gradient(135deg, #ef4444, #dc2626); color: #fff;
      }
      .btn-secondary {
        background: var(--god-border, #334155); color: var(--god-fg, #e2e8f0);
      }
      .alert {
        padding: 16px; border-radius: 10px;
        margin-bottom: 20px; font-size: 13px;
      }
      .alert-error {
        background: rgba(239, 68, 68, 0.12);
        border: 1px solid rgba(239, 68, 68, 0.3);
        color: #fca5a5;
      }
      .alert-success {
        background: rgba(34, 197, 94, 0.12);
        border: 1px solid rgba(34, 197, 94, 0.3);
        color: #86efac;
      }
      .backup-codes {
        list-style: none; padding: 0; margin: 16px 0 0;
        display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;
      }
      .backup-codes li {
        font-family: 'SF Mono', Monaco, monospace;
        font-size: 14px; font-weight: 700; letter-spacing: 2px;
        background: rgba(15, 23, 42, 0.6);
        padding: 10px; border-radius: 6px; text-align: center;
      }
      @media (max-width: 720px) {
        .setup-grid { grid-template-columns: 1fr; }
      }
    </style>
  `
}

interface RenderStatusOpts {
  userEmail: string
  enabledAt: string | null
  remainingBackupCodes: number
  lastUsedAt: string | null
  csrfToken: string
  error?: string
  newBackupCodes?: string[]
}

function renderStatusContent(opts: RenderStatusOpts): string {
  const {
    userEmail, enabledAt, remainingBackupCodes, lastUsedAt,
    csrfToken, error, newBackupCodes,
  } = opts

  const backupBlock = newBackupCodes && newBackupCodes.length
    ? `
      <div class="alert alert-success">
        <strong>New backup codes generated.</strong> Save them now — we
        won't show them again.
        <ul class="backup-codes">
          ${newBackupCodes.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}
        </ul>
      </div>
    `
    : ''

  return `
    <div class="page-head">
      <h1 class="page-title">Two-Factor Authentication</h1>
      <p class="page-sub">Status for <strong>${escapeHtml(userEmail)}</strong></p>
    </div>

    ${error ? `<div class="alert alert-error">${escapeHtml(error)}</div>` : ''}
    ${backupBlock}

    <div class="card">
      <div class="status-row">
        <div class="status-badge enabled">&#10003; 2FA Enabled</div>
        <div class="status-meta">
          <div><span class="label">Enrolled</span> ${enabledAt ? new Date(enabledAt).toLocaleString() : '&mdash;'}</div>
          <div><span class="label">Last used</span> ${lastUsedAt ? new Date(lastUsedAt).toLocaleString() : 'never'}</div>
          <div><span class="label">Backup codes remaining</span> ${remainingBackupCodes} / 10</div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">Regenerate backup codes</h2>
      <p class="card-sub">Generates a new batch of 10 single-use backup codes. This invalidates your old backup codes. Requires a current TOTP code to confirm.</p>
      <form method="POST" action="/god-admin/settings/2fa/regenerate-backup" autocomplete="off">
        ${csrfStore.hiddenField(csrfToken)}
        <div class="form-row">
          <input type="text" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="123456" required>
          <button type="submit" class="btn btn-secondary">Regenerate codes</button>
        </div>
      </form>
    </div>

    <div class="card">
      <h2 class="card-title" style="color:#fca5a5">Disable 2FA</h2>
      <p class="card-sub">Removes 2FA from this account. Requires your current password and a TOTP code.</p>
      <form method="POST" action="/god-admin/settings/2fa/disable" autocomplete="off">
        ${csrfStore.hiddenField(csrfToken)}
        <div class="form-col">
          <input type="password" name="password" placeholder="Current password" required>
          <input type="text" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="123456" required>
          <button type="submit" class="btn btn-danger">Disable 2FA</button>
        </div>
      </form>
    </div>

    <style>
      .page-head { margin-bottom: 24px; }
      .page-title { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
      .page-sub { color: var(--god-fg-muted, #64748b); font-size: 14px; }
      .card {
        background: var(--god-card, #1e293b);
        border: 1px solid var(--god-border, #334155);
        border-radius: 12px; padding: 24px; margin-bottom: 20px;
      }
      .card-title { font-size: 16px; font-weight: 700; margin-bottom: 4px; }
      .card-sub { color: var(--god-fg-muted, #94a3b8); font-size: 13px; margin-bottom: 16px; }
      .status-row { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
      .status-badge {
        display: inline-block; padding: 8px 14px;
        background: rgba(34,197,94,0.15); color: #86efac;
        border: 1px solid rgba(34,197,94,0.3);
        border-radius: 999px; font-size: 13px; font-weight: 700;
      }
      .status-meta { display: flex; gap: 24px; flex-wrap: wrap; font-size: 13px; color: var(--god-fg-muted, #94a3b8); }
      .label {
        text-transform: uppercase; letter-spacing: 0.5px;
        font-size: 11px; color: var(--god-fg-muted, #64748b);
      }
      .form-row { display: flex; gap: 12px; max-width: 400px; }
      .form-col { display: flex; flex-direction: column; gap: 12px; max-width: 360px; }
      .form-row input, .form-col input {
        padding: 12px 16px;
        background: var(--god-bg, #0f172a);
        border: 1.5px solid var(--god-border, #334155);
        border-radius: 8px; color: var(--god-fg, #e2e8f0);
        font-size: 14px; font-family: inherit;
      }
      .form-row input { text-align: center; letter-spacing: 3px; font-family: 'SF Mono', Monaco, monospace; font-size: 16px; flex: 1; }
      .btn { padding: 12px 20px; border-radius: 8px; border: none; font-size: 14px; font-weight: 700; cursor: pointer; }
      .btn-primary { background: linear-gradient(135deg, #3b82f6, #2563eb); color: #fff; }
      .btn-danger { background: linear-gradient(135deg, #ef4444, #dc2626); color: #fff; }
      .btn-secondary { background: var(--god-border, #334155); color: var(--god-fg, #e2e8f0); }
      .alert { padding: 16px; border-radius: 10px; margin-bottom: 20px; font-size: 13px; }
      .alert-error { background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.3); color: #fca5a5; }
      .alert-success { background: rgba(34,197,94,0.12); border: 1px solid rgba(34,197,94,0.3); color: #86efac; }
      .backup-codes {
        list-style: none; padding: 0; margin: 16px 0 0;
        display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;
      }
      .backup-codes li {
        font-family: 'SF Mono', Monaco, monospace;
        font-size: 14px; font-weight: 700; letter-spacing: 2px;
        background: rgba(15, 23, 42, 0.6);
        padding: 10px; border-radius: 6px; text-align: center;
      }
    </style>
  `
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function getSettings2fa(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  // Set BFCache-defeating headers BEFORE any `res.send` / `res.redirect`
  // so they apply even to the unauthenticated redirect branch below.
  // This is the P0 fix for the BFCache secret-leak vulnerability where
  // pressing Back on the browser would reveal the plaintext TOTP secret
  // from a stale DOM snapshot.
  setNoStoreHeaders(res)

  const ctx = req.godAdmin
  if (!ctx) {
    res.redirect('/god-admin/login')
    return
  }

  const csrfToken = await csrfStore.issue(res, isProduction())
  const row = await getTwoFactorRow(db, ctx.user.id)

  if (row && row.enabled) {
    const remaining = row.backup_codes_hashes.filter((h) => !!h).length
    res.send(
      godLayout({
        title: '2FA Settings',
        userEmail: ctx.user.email,
        isDefaultAdmin: ctx.isDefaultAdmin,
        activePath: '/god-admin/settings/2fa',
        theme: readThemeFromRequest(req),
        content: renderStatusContent({
          userEmail: ctx.user.email,
          enabledAt: row.enabled_at,
          remainingBackupCodes: remaining,
          lastUsedAt: row.last_used_at,
          csrfToken,
        }),
      }),
    )
    return
  }

  // Not enrolled (or enrollment incomplete) → start/refresh the secret
  const { secret } = await startTwoFactorEnrollment(db, ctx.user.id)
  const otpauthUrl = buildOtpAuthUrl({
    secretBase32: secret,
    label: ctx.user.email,
    issuer: 'Gbox God Admin',
  })
  const qrDataUrl = await generateQrDataUrl(otpauthUrl)

  res.send(
    godLayout({
      title: 'Enable 2FA',
      userEmail: ctx.user.email,
      isDefaultAdmin: ctx.isDefaultAdmin,
      activePath: '/god-admin/settings/2fa',
      theme: readThemeFromRequest(req),
      content: renderSetupContent({
        userEmail: ctx.user.email,
        secret,
        otpauthUrl,
        qrDataUrl,
        csrfToken,
      }),
    }),
  )
}

export async function postSettings2faEnable(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  // BFCache defeat — never let this response (or its error re-render)
  // get stashed by the browser. See setNoStoreHeaders() for the full
  // rationale.
  setNoStoreHeaders(res)

  const ctx = req.godAdmin
  if (!ctx) {
    res.redirect('/god-admin/login')
    return
  }

  const renderError = async (msg: string, status = 400) => {
    const csrfToken = await csrfStore.issue(res, isProduction())
    const row = await getTwoFactorRow(db, ctx.user.id)
    if (!row) {
      res.redirect('/god-admin/settings/2fa')
      return
    }
    const otpauthUrl = buildOtpAuthUrl({
      secretBase32: row.totp_secret,
      label: ctx.user.email,
      issuer: 'Gbox God Admin',
    })
    const qrDataUrl = await generateQrDataUrl(otpauthUrl)
    res.status(status).send(
      godLayout({
        title: 'Enable 2FA',
        userEmail: ctx.user.email,
        isDefaultAdmin: ctx.isDefaultAdmin,
        activePath: '/god-admin/settings/2fa',
        theme: readThemeFromRequest(req),
        content: renderSetupContent({
          userEmail: ctx.user.email,
          secret: row.totp_secret,
          otpauthUrl,
          qrDataUrl,
          csrfToken,
          error: msg,
        }),
      }),
    )
  }

  if (!(await csrfStore.verify(req))) {
    return renderError('Invalid form submission. Please try again.', 403)
  }

  const row = await getTwoFactorRow(db, ctx.user.id)
  if (!row) {
    res.redirect('/god-admin/settings/2fa')
    return
  }

  const code = String(req.body?.code ?? '')
  if (!verifyTotpCode(row.totp_secret, code)) {
    await logAuditEvent(db, 'login_failed', {
      userId: ctx.user.id,
      email: ctx.user.email,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
      extra: { context: 'god_admin_2fa_enroll', reason: 'invalid_code' },
    })
    return renderError('Invalid code. Check your authenticator clock and try again.', 401)
  }

  const { backupCodes } = await enableTwoFactor(db, ctx.user.id)
  await logAuditEvent(db, 'login_success', {
    userId: ctx.user.id,
    email: ctx.user.email,
    ip: getClientIp(req),
    userAgent: req.headers['user-agent'],
    extra: { context: 'god_admin_2fa_enable' },
  })

  // Phase 0 close-the-loop — privilege change, rotate session.
  await rotateAfter2FAChange(req, res, db, ctx.user.id, 'enable')

  const csrfToken = await csrfStore.issue(res, isProduction())
  res.send(
    godLayout({
      title: '2FA Enabled',
      userEmail: ctx.user.email,
      isDefaultAdmin: ctx.isDefaultAdmin,
      activePath: '/god-admin/settings/2fa',
      theme: readThemeFromRequest(req),
      content: renderStatusContent({
        userEmail: ctx.user.email,
        enabledAt: new Date().toISOString(),
        remainingBackupCodes: backupCodes.length,
        lastUsedAt: null,
        csrfToken,
        newBackupCodes: backupCodes,
      }),
    }),
  )
}

export async function postSettings2faDisable(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  setNoStoreHeaders(res)

  const ctx = req.godAdmin
  if (!ctx) {
    res.redirect('/god-admin/login')
    return
  }

  const renderStatusError = async (msg: string, status = 400) => {
    const csrfToken = await csrfStore.issue(res, isProduction())
    const row = await getTwoFactorRow(db, ctx.user.id)
    const remaining = row ? row.backup_codes_hashes.filter((h) => !!h).length : 0
    res.status(status).send(
      godLayout({
        title: '2FA Settings',
        userEmail: ctx.user.email,
        isDefaultAdmin: ctx.isDefaultAdmin,
        activePath: '/god-admin/settings/2fa',
        theme: readThemeFromRequest(req),
        content: renderStatusContent({
          userEmail: ctx.user.email,
          enabledAt: row?.enabled_at ?? null,
          remainingBackupCodes: remaining,
          lastUsedAt: row?.last_used_at ?? null,
          csrfToken,
          error: msg,
        }),
      }),
    )
  }

  if (!(await csrfStore.verify(req))) {
    return renderStatusError('Invalid form submission. Please try again.', 403)
  }

  const row = await getTwoFactorRow(db, ctx.user.id)
  if (!row || !row.enabled) {
    res.redirect('/god-admin/settings/2fa')
    return
  }

  // Re-fetch user to compare password
  const user = await db
    .selectFrom('users')
    .select(['password_hash'])
    .where('id', '=', ctx.user.id)
    .executeTakeFirst()

  const password = String(req.body?.password ?? '')
  if (!user?.password_hash || !(await verifyPassword(password, user.password_hash))) {
    await logAuditEvent(db, 'login_failed', {
      userId: ctx.user.id,
      email: ctx.user.email,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
      extra: { context: 'god_admin_2fa_disable', reason: 'bad_password' },
    })
    return renderStatusError('Password incorrect.', 401)
  }

  const code = String(req.body?.code ?? '')
  if (!verifyTotpCode(row.totp_secret, code)) {
    return renderStatusError('Invalid TOTP code.', 401)
  }

  await disableTwoFactor(db, ctx.user.id)
  await logAuditEvent(db, 'login_success', {
    userId: ctx.user.id,
    email: ctx.user.email,
    ip: getClientIp(req),
    userAgent: req.headers['user-agent'],
    extra: { context: 'god_admin_2fa_disable' },
  })
  // Phase 0 close-the-loop — privilege change, rotate session.
  await rotateAfter2FAChange(req, res, db, ctx.user.id, 'disable')
  res.redirect('/god-admin/settings/2fa')
}

export async function postSettings2faRegenerate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  setNoStoreHeaders(res)

  const ctx = req.godAdmin
  if (!ctx) {
    res.redirect('/god-admin/login')
    return
  }

  const renderStatusError = async (msg: string, status = 400) => {
    const csrfToken = await csrfStore.issue(res, isProduction())
    const row = await getTwoFactorRow(db, ctx.user.id)
    const remaining = row ? row.backup_codes_hashes.filter((h) => !!h).length : 0
    res.status(status).send(
      godLayout({
        title: '2FA Settings',
        userEmail: ctx.user.email,
        isDefaultAdmin: ctx.isDefaultAdmin,
        activePath: '/god-admin/settings/2fa',
        theme: readThemeFromRequest(req),
        content: renderStatusContent({
          userEmail: ctx.user.email,
          enabledAt: row?.enabled_at ?? null,
          remainingBackupCodes: remaining,
          lastUsedAt: row?.last_used_at ?? null,
          csrfToken,
          error: msg,
        }),
      }),
    )
  }

  if (!(await csrfStore.verify(req))) {
    return renderStatusError('Invalid form submission. Please try again.', 403)
  }

  const row = await getTwoFactorRow(db, ctx.user.id)
  if (!row || !row.enabled) {
    res.redirect('/god-admin/settings/2fa')
    return
  }

  const code = String(req.body?.code ?? '')
  if (!verifyTotpCode(row.totp_secret, code)) {
    return renderStatusError('Invalid TOTP code.', 401)
  }

  const newCodes = await regenerateBackupCodes(db, ctx.user.id)
  await logAuditEvent(db, 'login_success', {
    userId: ctx.user.id,
    email: ctx.user.email,
    ip: getClientIp(req),
    userAgent: req.headers['user-agent'],
    extra: { context: 'god_admin_2fa_regen_backup' },
  })

  // Phase 0 close-the-loop — regenerating backup codes is a
  // privilege-defining event (any previously-shared backup code is
  // void). Rotate the session so stolen cookies can't ride along.
  await rotateAfter2FAChange(req, res, db, ctx.user.id, 'regen_backup')

  const csrfToken = await csrfStore.issue(res, isProduction())
  res.send(
    godLayout({
      title: '2FA Settings',
      userEmail: ctx.user.email,
      isDefaultAdmin: ctx.isDefaultAdmin,
      activePath: '/god-admin/settings/2fa',
      theme: readThemeFromRequest(req),
      content: renderStatusContent({
        userEmail: ctx.user.email,
        enabledAt: row.enabled_at,
        remainingBackupCodes: newCodes.length,
        lastUsedAt: row.last_used_at,
        csrfToken,
        newBackupCodes: newCodes,
      }),
    }),
  )
}
