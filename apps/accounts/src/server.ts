/**
 * Gbox Accounts Portal — Express Server
 *
 * Serves accounts.gbox.co (port 4323)
 * Handles: login, signup, store management, password reset, account settings, logout
 */

// Load root .env (cùng cấp với apps/). Find-up từ cwd vì khi chạy
// `npm run dev:accounts`, cwd = apps/accounts/ → dotenv mặc định không
// thấy file root. Helper này đi lên cho tới khi gặp .env hoặc filesystem root.
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { config as dotenvConfig } from 'dotenv'
;(function loadRootEnv() {
  let dir = process.cwd()
  for (let i = 0; i < 8; i++) {
    const p = resolve(dir, '.env')
    if (existsSync(p)) { dotenvConfig({ path: p }); return }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
})()

import express from 'express'
import { adminSecurityHeaders } from '@gbox/core/modules/security/headers.js'
import { sanitizeResponseMiddleware } from '@gbox/core/modules/security/sanitize-middleware.js'
import { adminCorsConfig } from '@gbox/core/modules/security/cors.js'
import { authLimiter, pageLimiter } from '@gbox/core/modules/security/rate-limit.js'
import { performanceMiddleware, configureKeepAlive } from '@gbox/core/modules/performance/middleware.js'
import { requestLogger, correlationId, shopifyErrorHandler, installProcessErrorHandlers } from '@gbox/core/modules/logging/logger.js'
import { closeRedis } from '@gbox/core/modules/cache/redis.js'
import {
  getSessionTokenFromCookies,
  clearSessionCookie,
} from '@gbox/core/modules/auth/session.js'

// Pages
import { getLogin, postLogin } from './pages/login.js'
// Phase 0 §8 Item #3 — 2FA challenge (TOTP / email / backup codes),
// plus the /account/2fa settings flow. Both surfaces live in their
// own files to keep login.ts lean.
import {
  getLogin2fa,
  postLogin2fa,
  getLogin2faEmail,
  postLogin2faEmailSend,
  postLogin2faEmailVerify,
  getLogin2faBackup,
  postLogin2faBackup,
} from './pages/login-2fa.js'
import {
  getTwoFactorPage,
  postTwoFactorEnable,
  postTwoFactorDisable,
  postTwoFactorRegenerateBackup,
} from './pages/two-factor.js'
import { createEnforce2faMiddleware } from './middleware/enforce-2fa.js'
import { getSignup, postSignup, getVerifyEmail, postVerifyEmail, postResendOtp } from './pages/signup.js'
import { getStores, postDeleteStore } from './pages/stores.js'
import {
  getCreateStore,
  postCreateStore,
  getStoreCreated,
  getWelcomeToAdmin,
} from './pages/create-store.js'
import {
  getForgotPassword,
  postForgotPassword,
  getResetPassword,
  postResetPassword,
} from './pages/forgot-password.js'
// Phase 14 PR1 — Shopify-class one-click unsubscribe. This is the landing
// URL built into every marketing / lifecycle / reviews email footer by
// `@gbox/core/modules/email/preferences.ts::buildUnsubscribeUrl`. No
// login required — the hashed token IS the auth (CAN-SPAM + RFC 8058).
import { getUnsubscribe, postUnsubscribe } from './pages/unsubscribe.js'
// Phase 14 PR1.5 — customer-facing preference center. Shares the same
// raw unsubscribe-token auth as /unsubscribe (token IS auth; no login
// required per CAN-SPAM / RFC 8058 convention).
import { getEmailPreferences, postEmailPreferences } from './pages/email-preferences.js'
// Phase 14 PR5 — GDPR/Privacy center. Reuses the customer's
// unsubscribe token as the landing-page auth signal; single-use
// download / cancel tokens from `customer_privacy_requests` authenticate
// the finalizer links emailed to the customer.
import {
  getPrivacy,
  postRequestExport,
  postRequestDeletion,
  getDownloadToken,
  getCancelDeletion,
} from './pages/privacy.js'
import {
  getAccount,
  postProfile,
  getPasswordForm,
  postPassword,
  getSessionsPage,
  postRevokeAllSessions,
} from './pages/account-settings.js'

// Google OAuth (OIDC) — seller-only sign-in path. Deliberately NOT
// exposed on /god-admin (Iron Rule 5: god admins use password + 2FA
// only). See apps/accounts/src/pages/oauth-google.ts for the flow.
import {
  getOAuthGoogleStart,
  getOAuthGoogleCallback,
} from './pages/oauth-google.js'

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.ACCOUNTS_PORT ?? process.env.PORT ?? '4323', 10)
const app = express()

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.set('trust proxy', 1)

// Correlation ID for request tracing
app.use(correlationId())

// Performance middleware (compression + timing)
app.use(performanceMiddleware())
app.use(requestLogger('gbox-accounts'))

// Security middleware
app.use(adminSecurityHeaders)
// Phase 0 close-the-loop — restrict CORS to gbox.co subdomains. The
// accounts portal issues the platform-wide session cookie so browser
// origins must be explicitly whitelisted before we touch any route.
app.use(adminCorsConfig)
app.use(express.urlencoded({ extended: false, limit: '1mb' }))
app.use(express.json({ limit: '1mb' }))

// Phase 0 close-the-loop — scrub sensitive fields from every JSON
// response. Mounted before routes so every handler is covered.
app.use(sanitizeResponseMiddleware())

// Rate limiting
app.use('/accounts/', pageLimiter)

// Phase 0 §8 Item #3 — 2FA enforcement. Must run AFTER express parses
// cookies but BEFORE the router so it can intercept /accounts/account/*
// and bounce pending-2fa sessions back to the challenge. The middleware
// has a built-in whitelist for /login, /signup, and the /login/2fa*
// challenge routes so this never creates a redirect loop.
app.use(createEnforce2faMiddleware())

// ---------------------------------------------------------------------------
// All routes under /accounts prefix
// ---------------------------------------------------------------------------

const router = express.Router()

// Auth pages
router.get('/login', getLogin)
router.post('/login', authLimiter, postLogin)

// 2FA challenge flow (reached after password on enrolled accounts).
// authLimiter caps each endpoint at 5 tries/min/IP so backup / email
// OTPs can't be brute-forced off a stolen session cookie.
router.get('/login/2fa', getLogin2fa)
router.post('/login/2fa', authLimiter, postLogin2fa)
router.get('/login/2fa/email', getLogin2faEmail)
router.post('/login/2fa/email/send', authLimiter, postLogin2faEmailSend)
router.post('/login/2fa/email', authLimiter, postLogin2faEmailVerify)
router.get('/login/2fa/backup', getLogin2faBackup)
router.post('/login/2fa/backup', authLimiter, postLogin2faBackup)

router.get('/signup', getSignup)
router.post('/signup', authLimiter, postSignup)
router.get('/verify-email', getVerifyEmail)
router.post('/verify-email', authLimiter, postVerifyEmail)
router.post('/resend-otp', authLimiter, postResendOtp)

router.get('/forgot-password', getForgotPassword)
router.post('/forgot-password', authLimiter, postForgotPassword)
router.get('/reset-password', getResetPassword)
router.post('/reset-password', authLimiter, postResetPassword)

// Phase 14 PR1 — public email unsubscribe (no auth — token IS auth).
router.get('/unsubscribe', getUnsubscribe)
router.post('/unsubscribe', postUnsubscribe)

// Phase 14 PR1.5 — customer-facing preference center.
router.get('/email-preferences', getEmailPreferences)
router.post('/email-preferences', postEmailPreferences)

// Phase 14 PR5 — GDPR/Privacy center.
router.get('/privacy', getPrivacy)
router.post('/privacy/export', authLimiter, postRequestExport)
router.post('/privacy/delete', authLimiter, postRequestDeletion)
router.get('/privacy/download/:token', getDownloadToken)
router.get('/privacy/cancel-deletion/:token', getCancelDeletion)

// Store selector
router.get('/stores', getStores)
router.post('/stores/:shopId/delete', authLimiter, postDeleteStore)

// Create store
router.get('/create-store', getCreateStore)
router.post('/create-store', authLimiter, postCreateStore)
router.get('/store-created', getStoreCreated)
router.get('/welcome-to-admin', getWelcomeToAdmin)

// 2026-04-26: /clone-new-store retired
const cloneRetiredAccountsHandler = (_req: any, res: any) => {
  res.status(410).type('text/plain').send(
    'Storefront cloning is now a concierge service. Please contact Gbox support.',
  )
}
router.get('/clone-new-store', cloneRetiredAccountsHandler)
router.post('/clone-new-store/start', cloneRetiredAccountsHandler)

// Account settings
router.get('/account', getAccount)
router.post('/account/profile', authLimiter, postProfile)
router.get('/account/password', getPasswordForm)
router.post('/account/password', authLimiter, postPassword)
router.get('/account/sessions', getSessionsPage)
router.post('/account/sessions/revoke-all', authLimiter, postRevokeAllSessions)

// 2FA self-service
router.get('/account/2fa', getTwoFactorPage)
router.post('/account/2fa/enable', authLimiter, postTwoFactorEnable)
router.post('/account/2fa/disable', authLimiter, postTwoFactorDisable)
router.post('/account/2fa/regenerate-backup', authLimiter, postTwoFactorRegenerateBackup)

// Logout — chỉ clear cookie + redirect.
// accounts app không có DB connection (Redis-only) và Redis có thể hang
// vài giây khi unreachable. Cookie clear chính là cơ chế logout thực sự;
// session record DB sẽ tự expire theo TTL.
router.get('/logout', (req, res) => {
  const isProd = process.env.NODE_ENV === 'production'
  res.setHeader('Set-Cookie', clearSessionCookie(isProd))
  res.redirect('/accounts/login')
})

// Google OAuth
router.get('/auth/google', authLimiter, getOAuthGoogleStart)
router.get('/auth/google/callback', authLimiter, getOAuthGoogleCallback)

// Mount all routes under /accounts
app.use('/accounts', router)

// ---------------------------------------------------------------------------
// Root redirect
// ---------------------------------------------------------------------------

app.get('/', async (req, res) => {
  const token = getSessionTokenFromCookies(req.headers.cookie ?? '')
  if (!token) {
    res.redirect('/accounts/login')
    return
  }

  let userName = 'User'
  try {
    const userCookie = req.headers.cookie?.split('; ').find(row => row.startsWith('gbox_user='))?.split('=')[1]
    if (userCookie) {
      const userData = JSON.parse(decodeURIComponent(userCookie))
      userName = userData.first_name || userData.full_name || userName
    }
  } catch (e) {
    // Ignore parse errors
  }

  res.send(`
    <html>
      <head>
        <title>Gbox - Welcome</title>
        <style>
          body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f4f6f8; }
          .card { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; }
          h1 { color: #1a1f23; margin-bottom: 8px; }
          p { color: #637381; margin-bottom: 24px; }
          .btn { background: #008060; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; font-weight: 600; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Welcome, ${userName}!</h1>
          <p>You have successfully logged in via Gbox Auth API.</p>
          <div style="margin-bottom: 30px; padding: 15px; background: #f0fcf9; border-radius: 4px; text-align: left; font-size: 14px;">
            <strong>Mock Store Data:</strong><br/>
            - Gbox Demo Store (online)<br/>
            - Test Shop #1 (online)
          </div>
          <a href="/accounts/logout" class="btn" style="background: #d72c0d;">Log out</a>
        </div>
      </body>
    </html>
  `)
})

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'gbox-accounts', timestamp: new Date().toISOString() })
})

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Shopify-format error handler
app.use(shopifyErrorHandler())
installProcessErrorHandlers('gbox-accounts', { db: null as any })

const server = app.listen(PORT, () => {
  console.log(`[Gbox Accounts] Running on http://localhost:${PORT} | PID: ${process.pid}`)
  console.log(`[Gbox Accounts] ENV: ${process.env.NODE_ENV ?? 'development'}`)
})

// Configure keep-alive for Nginx upstream connections
configureKeepAlive(server)

// Graceful shutdown
async function shutdown() {
  console.log('[Gbox Accounts] Shutting down...')
  await closeRedis()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
