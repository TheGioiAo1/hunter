/**
 * Gbox Checkout — Express Server
 *
 * Serves `checkout.gbox.co` (default port 4327).
 *
 * Responsibilities:
 *   1. Accept inbound buyers from two modes:
 *      - Mode A (Gbox subdomain storefront): no token needed, session
 *        cookie auto-sent via Domain=.gbox.co.
 *      - Mode B (custom-domain storefront): one-shot `?hop=<token>`
 *        query param. We verify + consume the handoff token, mint a
 *        Domain=.gbox.co customer session cookie IF a customerId was
 *        attached, then 302 to the clean URL.
 *   2. Render a 3-step checkout UI (info → shipping → payment).
 *   3. Proxy checkout state changes back to the Platform API
 *      (`api.gbox.co`) over HTTPS, forwarding the buyer's cookies.
 *   4. Host the PayPal SDK loader + browser buttons initializer.
 *
 * Decision #2 reference:
 *   docs/superpowers/specs/2026-04-08-checkout-subdomain-split.md
 *
 * Hard boundaries:
 *   - NO theme system here (Decision #1 governs the storefront only).
 *   - NO merchant JS (strict CSP in lib/security-headers.ts).
 *   - NO direct DB writes — everything goes through the Platform API.
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
import cookieParser from 'cookie-parser'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { performanceMiddleware, configureKeepAlive } from '@gbox/core/modules/performance/middleware.js'
import { requestLogger, correlationId, shopifyErrorHandler, installProcessErrorHandlers } from '@gbox/core/modules/logging/logger.js'
import { closeRedis } from '@gbox/core/modules/cache/redis.js'
import { pageLimiter } from '@gbox/core/modules/security/rate-limit.js'
import { sanitizeResponseMiddleware } from '@gbox/core/modules/security/sanitize-middleware.js'
import {
  consumeHandoffToken,
  HandoffTokenError,
} from '@gbox/core/modules/checkout/handoff.js'
import {
  CUSTOMER_COOKIE_NAME,
  buildCustomerCookieOptions,
  SESSION_TTL_DAYS,
} from '@gbox/core/modules/customer-auth/index.js'

import {
  checkoutSecurityHeaders,
  staticCacheHeaders,
} from './lib/security-headers.js'
import { renderLayout, esc } from './components/layout.js'
import { getCheckoutPage } from './pages/checkout.js'
import { getThankyouPage } from './pages/thankyou.js'

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

const PORT = parseInt(
  process.env.CHECKOUT_PORT ?? process.env.PORT ?? '4327',
  10,
)
// // API-MODE: previously `createDb()` from `@gbox/db`. Stubbed to null;
// // checkout does NO direct DB writes (everything routes via Platform API),
// // so the only consumer is the shutdown drain (guarded below).
const db = null as any
const app = express()

// Resolve the static directory relative to this module. Using
// fileURLToPath + dirname keeps this correct under tsx, node --loader,
// and compiled dist output alike.
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const STATIC_DIR = resolve(__dirname, 'static')

app.set('trust proxy', 1)
app.disable('x-powered-by')

app.use(correlationId())
app.use(performanceMiddleware())
app.use(requestLogger('gbox-checkout'))
app.use(checkoutSecurityHeaders)
app.use(cookieParser())
app.use(express.urlencoded({ extended: false, limit: '64kb' }))
// NOTE: checkout does not accept JSON bodies — all forms are urlencoded.

// Phase 0 close-the-loop — if a future route ever ships JSON (e.g. a
// PayPal callback, a cart-sync ping), the wrapper scrubs it. Free
// defence in depth even though today's checkout flow is HTML-only.
app.use(sanitizeResponseMiddleware())

// Rate limit all checkout pages
app.use('/c/', pageLimiter)

// ---------------------------------------------------------------------------
// /static/* — bootstrap script + any future images/CSS
// ---------------------------------------------------------------------------

app.use('/static', staticCacheHeaders, express.static(STATIC_DIR, {
  fallthrough: false,
  index: false,
  dotfiles: 'deny',
  maxAge: '1d',
}))

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'gbox-checkout',
    port: PORT,
    timestamp: new Date().toISOString(),
  })
})

// ---------------------------------------------------------------------------
// GET /c/:checkoutId — main checkout page (handles Mode A + Mode B handoff)
// ---------------------------------------------------------------------------

app.get('/c/:checkoutId', async (req, res, next) => {
  try {
    const checkoutId = req.params.checkoutId
    const hopToken = typeof req.query.hop === 'string' ? req.query.hop : null

    // ---- Mode B: one-shot handoff token ----
    if (hopToken) {
      let payload
      try {
        payload = await consumeHandoffToken(hopToken)
      } catch (err) {
        if (err instanceof HandoffTokenError) {
          const reason =
            err.code === 'already_redeemed'
              ? 'This checkout link was already used. Return to the store and try again.'
              : err.code === 'expired'
                ? 'This checkout link has expired. Return to the store and try again.'
                : 'Invalid checkout link.'
          return res
            .status(400)
            .type('html')
            .send(renderErrorPage('Link expired', reason))
        }
        throw err
      }

      // Defence in depth — the token MUST carry the same checkoutId.
      if (payload.checkoutId !== checkoutId) {
        return res
          .status(400)
          .type('html')
          .send(
            renderErrorPage(
              'Invalid link',
              'The handoff token does not match this checkout.',
            ),
          )
      }

      // If the token carried an authenticated customerId, we can't mint
      // a full customer session from here (we don't have a plaintext
      // session token — those live only in the API). What we CAN do is
      // set a flag cookie that the API's customerAuth middleware would
      // reject anyway, so for now we simply don't mint anything and let
      // the buyer proceed as a guest. Future work: add a "trade handoff
      // for session" endpoint on the API.
      //
      // For the 95% case (guest buyers), this is fine.

      // 302 to the clean URL to keep the hop token out of the address
      // bar, browser history, and Referer headers.
      res.setHeader(
        'Set-Cookie',
        buildHandoffBreadcrumbCookie(payload.shopId, payload.customerId),
      )
      return res.redirect(302, `/c/${encodeURIComponent(checkoutId)}`)
    }

    // ---- Mode A: render the page ----
    return await getCheckoutPage(req, res, { checkoutId })
  } catch (err) {
    return next(err)
  }
})

// ---------------------------------------------------------------------------
// GET /c/:checkoutId/thankyou — post-payment confirmation page
// ---------------------------------------------------------------------------

app.get('/c/:checkoutId/thankyou', async (req, res, next) => {
  try {
    return await getThankyouPage(req, res, {
      checkoutId: req.params.checkoutId,
    })
  } catch (err) {
    return next(err)
  }
})

// ---------------------------------------------------------------------------
// POST /c/:checkoutId/* — form handlers are defined in pages/checkout.ts
// ---------------------------------------------------------------------------

import {
  postCheckoutEmail,
  postCheckoutShipping,
  postCheckoutRate,
  postCheckoutDiscount,
  postCheckoutDiscountRemove,
  postCheckoutGiftCard,
} from './pages/checkout.js'

app.post('/c/:checkoutId/email', (req, res, next) => {
  postCheckoutEmail(req, res, { checkoutId: req.params.checkoutId }).catch(next)
})
app.post('/c/:checkoutId/shipping', (req, res, next) => {
  postCheckoutShipping(req, res, { checkoutId: req.params.checkoutId }).catch(next)
})
app.post('/c/:checkoutId/rate', (req, res, next) => {
  postCheckoutRate(req, res, { checkoutId: req.params.checkoutId }).catch(next)
})
// Phase 5 PR1 — apply a discount code from the order summary sidebar.
// Always available (Shopify parity: the field stays visible on all
// three steps). Errors round-trip via `?discount_error=...` so PRG
// keeps reload idempotent.
app.post('/c/:checkoutId/discount', (req, res, next) => {
  postCheckoutDiscount(req, res, { checkoutId: req.params.checkoutId }).catch(next)
})
app.post('/c/:checkoutId/discount/remove', (req, res, next) => {
  postCheckoutDiscountRemove(req, res, { checkoutId: req.params.checkoutId }).catch(next)
})
// Phase 10 PR2 — apply a gift card code from the order summary sidebar.
// Mirrors the discount row: strict CSP, PRG-via-query-param flash. All
// validation happens in the Platform API; we just proxy + render.
app.post('/c/:checkoutId/gift-card', (req, res, next) => {
  postCheckoutGiftCard(req, res, { checkoutId: req.params.checkoutId }).catch(next)
})

// ---------------------------------------------------------------------------
// 404 + error handlers
// ---------------------------------------------------------------------------

app.use((req, res) => {
  res
    .status(404)
    .type('html')
    .send(
      renderErrorPage(
        'Checkout not found',
        `We couldn\u2019t find a checkout session at ${esc(req.path)}. Return to the store and try again.`,
      ),
    )
})

app.use(
  (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // eslint-disable-next-line no-console
    console.error('[gbox-checkout] unhandled error:', err.message, err.stack)
    if (res.headersSent) return
    res
      .status(500)
      .type('html')
      .send(
        renderErrorPage(
          'Something went wrong',
          'We hit an unexpected error processing your checkout. Please return to the store and try again. If the problem persists, contact support.',
        ),
      )
  },
)

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Shopify-format error handler
app.use(shopifyErrorHandler())
// Phase 14 PR6 — `db` wiring fires `platform_incident_alert` emails
// on uncaught exceptions + unhandled rejections (60s dedup on
// sha256(err.msg + env)). See platform-alerts/send.ts.
installProcessErrorHandlers('gbox-checkout', { db })

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[gbox-checkout] listening on http://0.0.0.0:${PORT} | PID: ${process.pid} | NODE_ENV=${process.env.NODE_ENV ?? 'development'}`,
  )
})

configureKeepAlive(server)

async function shutdown() {
  // eslint-disable-next-line no-console
  console.log('[gbox-checkout] shutting down...')
  // // API-MODE: db is null in demo mode; only Redis needs draining.
  await closeRedis().catch(() => {})
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort breadcrumb cookie after a successful handoff. This is NOT
 * a customer session — just a short-lived marker the checkout page can
 * show ("Shopping as <email>"). The real session stays in the API.
 *
 * We DO set Domain=.gbox.co so future Gbox subdomain visits see it, per
 * Decision #2 §8.1.
 */
function buildHandoffBreadcrumbCookie(
  shopId: string,
  customerId: string | null,
): string {
  const value = encodeURIComponent(
    JSON.stringify({ shop: shopId, customer: customerId ?? null, t: Date.now() }),
  )
  const expires = new Date(Date.now() + 30 * 60 * 1000) // 30 min
  const opts = buildCustomerCookieOptions(expires, {
    domain: process.env.CUSTOMER_COOKIE_DOMAIN ?? undefined,
  })
  const parts: string[] = [`gbox_checkout_breadcrumb=${value}`]
  if (opts.httpOnly) parts.push('HttpOnly')
  if (opts.secure) parts.push('Secure')
  parts.push(`SameSite=${opts.sameSite === 'lax' ? 'Lax' : opts.sameSite}`)
  parts.push(`Path=${opts.path}`)
  parts.push(`Expires=${opts.expires.toUTCString()}`)
  if ((opts as any).domain) parts.push(`Domain=${(opts as any).domain}`)
  return parts.join('; ')
}

function renderErrorPage(title: string, message: string): string {
  return renderLayout({
    title,
    body: `
      <section class="card" style="grid-column: 1 / -1">
        <h1>${esc(title)}</h1>
        <p>${esc(message)}</p>
      </section>
    `,
  })
}

// Silence unused import warnings for symbols reserved for upcoming steps.
void CUSTOMER_COOKIE_NAME
void SESSION_TTL_DAYS

void SESSION_TTL_DAYS
