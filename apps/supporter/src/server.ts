/**
 * Gbox Supporter — Express server for supporter.gbox.co.
 *
 * Port:   4328 (prod); override with SUPPORTER_PORT
 * Routes: /, /login, /logout, /inbox, /tickets/:id (+ mutation sub-paths),
 *          /invite/:token (+ POST), /staff (+ invite/revoke), /healthz
 *
 * Middleware stack:
 *
 *   1. correlationId / requestLogger      — same as store-admin
 *   2. adminSecurityHeaders                — CSP, referrer, HSTS
 *   3. adminCorsConfig                     — *.gbox.co + dev origins
 *   4. express.urlencoded / express.json   — form + JSON body parsers
 *   5. sanitizeResponseMiddleware          — scrub sensitive fields
 *   6. pageLimiter                         — 60 req/min/IP default
 *   7. staffAuth (createStaffAuthMiddleware) — session cookie → req.staffUser
 *
 * Permission checks are done INSIDE each handler (not via middleware) so
 * a POST that lacks the scope logs the actual attempted action via
 * `support_audit_log`. See individual page handlers.
 *
 * Graceful shutdown calls `destroyDb()` on SIGTERM / SIGINT.
 *
 * Per spec §12.5.6: this server is FULL REWRITE of the PRD's "staff
 * portal" stub; all future PRs (PR4 AI, PR5 SLA, PR6 polish) plug in
 * here without restructuring the middleware stack.
 */

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
import { createStaffAuthMiddleware } from './middleware/staff-auth.js'
import { adminSecurityHeaders } from '@gbox/core/modules/security/headers.js'
import { sanitizeResponseMiddleware } from '@gbox/core/modules/security/sanitize-middleware.js'
import { adminCorsConfig } from '@gbox/core/modules/security/cors.js'
import { pageLimiter } from '@gbox/core/modules/security/rate-limit.js'
import { performanceMiddleware, configureKeepAlive } from '@gbox/core/modules/performance/middleware.js'
import { requestLogger, correlationId, shopifyErrorHandler, installProcessErrorHandlers } from '@gbox/core/modules/logging/logger.js'

// Page handlers
import { getRoot, getLogin, postLogin, postLogout } from './pages/login.js'
import { getInbox } from './pages/inbox.js'
import {
  getTicket,
  postReply,
  postInternalNote,
  postStatus,
  postPriority,
  postClaim,
} from './pages/ticket.js'
import { getInvite, postInvite } from './pages/invite.js'
import { getStaff, postInviteStaff, postRevokeStaff } from './pages/staff.js'

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.SUPPORTER_PORT ?? '4328', 10)
// // API-MODE: previously `createDb()` from `@gbox/db`. Stubbed null;
// // page handlers should guard `if (!db)` and route through the API
// // gateway when one becomes available.
const db = null as any
const app = express()

app.set('trust proxy', 1)

// Observability + security
app.use(correlationId())
app.use(performanceMiddleware())
app.use(requestLogger('gbox-supporter'))
app.use(adminSecurityHeaders)
app.use(adminCorsConfig)

// Body parsers (form-encoded for page forms; JSON for future API routes)
app.use(express.urlencoded({ extended: false, limit: '512kb' }))
app.use(express.json({ limit: '512kb' }))

// Sensitive-field scrubber
app.use(sanitizeResponseMiddleware())

// Rate limit — shared limiter for all pages. Invite-accept + login get
// another layer from the session cookie itself (brute-force resistance
// via `createSession`'s token-hash lookup).
app.use(pageLimiter)

// Staff auth — attaches req.staffUser if the session cookie resolves.
// Public paths (/, /login, /invite, /healthz) bypass the bounce-to-login
// logic but still get req.staffUser populated if a cookie is present.
const staffAuth = createStaffAuthMiddleware(db, {
  publicPaths: ['/', '/login', '/login/', '/invite', '/health', '/healthz', '/favicon.ico'],
})
app.use(staffAuth)

// ---------------------------------------------------------------------------
// Health check (no auth)
// ---------------------------------------------------------------------------

// `/health` alias for cùng pattern 6 service khác (deploy script check /health).
// Giữ `/healthz` cho backwards compat (existing monitors / external probes).
app.get(['/health', '/healthz'], (_req, res) => {
  res.json({
    status: 'ok',
    service: 'gbox-supporter',
    timestamp: new Date().toISOString(),
  })
})

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Root redirect
app.get('/', (req, res) => getRoot(req, res))

// Auth
app.get('/login', (req, res) => getLogin(req, res))
app.post('/login', (req, res) => postLogin(req, res, db))
app.post('/logout', (req, res) => postLogout(req, res, db))

// Invite accept (public — no session required)
app.get('/invite/:token', (req, res) => getInvite(req, res, db))
app.post('/invite/:token', (req, res) => postInvite(req, res, db))

// Inbox (signed-in staff landing page)
app.get('/inbox', (req, res) => getInbox(req, res, db))

// Ticket detail + mutations
app.get('/tickets/:id', (req, res) => getTicket(req, res, db))
app.post('/tickets/:id/reply', (req, res) => postReply(req, res, db))
app.post('/tickets/:id/internal-note', (req, res) => postInternalNote(req, res, db))
app.post('/tickets/:id/status', (req, res) => postStatus(req, res, db))
app.post('/tickets/:id/priority', (req, res) => postPriority(req, res, db))
app.post('/tickets/:id/claim', (req, res) => postClaim(req, res, db))

// Staff management
app.get('/staff', (req, res) => getStaff(req, res, db))
app.post('/staff/invite', (req, res) => postInviteStaff(req, res, db))
app.post('/staff/revoke/:id', (req, res) => postRevokeStaff(req, res, db))

// Placeholder routes — stubbed for PR4 + PR5 landing:
app.get('/canned-replies', (_req, res) => {
  res.status(200).type('html').send(
    `<!doctype html><meta charset="utf-8"><title>Canned replies</title><p style="font-family:sans-serif;padding:40px">Canned replies editor — coming in PR4. <a href="/inbox">Back to inbox</a>.</p>`,
  )
})
app.get('/analytics', (_req, res) => {
  res.status(200).type('html').send(
    `<!doctype html><meta charset="utf-8"><title>Analytics</title><p style="font-family:sans-serif;padding:40px">Analytics — coming in PR6. <a href="/inbox">Back to inbox</a>.</p>`,
  )
})
app.get('/settings/profile', (_req, res) => {
  res.status(200).type('html').send(
    `<!doctype html><meta charset="utf-8"><title>Profile</title><p style="font-family:sans-serif;padding:40px">Profile editor — coming in PR6. <a href="/inbox">Back to inbox</a>.</p>`,
  )
})

// Catch-all 404 — the `/.*/` form works on both Express 4 and 5.
app.get(/.*/, (_req, res) => {
  res.status(404).type('html').send('<p>Not found.</p>')
})

// Error handler (must be last)
app.use(shopifyErrorHandler())
installProcessErrorHandlers('gbox-supporter')

// ---------------------------------------------------------------------------
// Listen
// ---------------------------------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(`[Gbox Supporter] Running on http://localhost:${PORT} | PID: ${process.pid}`)
  console.log(`[Gbox Supporter] ENV: ${process.env.NODE_ENV ?? 'development'}`)
})
configureKeepAlive(server)

async function shutdown(): Promise<void> {
  console.log('[Gbox Supporter] Shutting down...')
  // // API-MODE: db stubbed null in demo; nothing to drain.
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
