/**
 * Gbox Storefront — Account Routes (Stage 3C.2)
 *
 * Mutation endpoints for the buyer-side customer account flow. These
 * are the targets of the Liquid templates' login / logout forms:
 *
 *   POST /account/login          Request a magic link + OTP.
 *   GET  /account/login/verify   Click-through from the email.
 *   POST /account/otp            Paste-the-code fallback.
 *   POST /account/logout         Revoke session + clear cookie.
 *
 * Why NOT inside the storefront handler?
 *
 *   The storefront `GET /{*splat}` handler is a pure renderer — it
 *   loads drops, runs Liquid, returns HTML. Authentication mutations
 *   require request-body parsing, cookie writes, and error shaping
 *   that would make the renderer's surface area explode. Splitting
 *   mutations into a dedicated sub-router keeps both layers small
 *   and makes each endpoint independently unit-testable.
 *
 *   GET routes for account pages (`/account`, `/account/orders`, …)
 *   STILL flow through the storefront handler — they are just
 *   templated pages that read `customer.*` drops from the data source.
 *   That part is wired in 3C.3 when we update `loadCustomerBySession`.
 *
 * Security rules enforced here:
 *
 *   1. **No email enumeration.** `POST /account/login` always
 *      returns 200 regardless of whether the address exists, is
 *      malformed, or caused the core module to throw. An attacker
 *      cannot probe "is alice@example.com a customer?" via timing
 *      or status code. The underlying error is logged server-side
 *      for operators.
 *
 *   2. **Cookie set by US, not core.** `verifyMagicLink` /
 *      `verifyOtpCode` return a plaintext session token. This
 *      middleware is responsible for converting it into a
 *      `Set-Cookie` header with HttpOnly + SameSite=Lax + the right
 *      Secure flag for the environment. Core never touches HTTP.
 *
 *   3. **Logout ALWAYS clears.** Even if no `gbox_customer_session`
 *      cookie was sent in, the response still emits a clearing
 *      `Set-Cookie` so a zombie cookie from another tab gets wiped
 *      on the browser side.
 *
 *   4. **Errors → user-safe messages.** `CustomerAuthError` carries
 *      both a machine `code` and a human `message`. We forward the
 *      message to the client so templates can show "incorrect code"
 *      without the caller having to guess the status → copy mapping.
 *      The core `status` (400 / 429 / …) becomes the HTTP status.
 *
 * Like the cart and checkout routers, every external dependency
 * (issueLoginCode, verifyMagicLink, verifyOtpCode, revokeSession) is
 * injected via the `deps` bag so tests run without Postgres. In
 * production the server entrypoint binds them to the core functions
 * with the active Kysely instance.
 */

import type { NextFunction, Request, Response, Router } from 'express'
import express from 'express'
import {
  CUSTOMER_COOKIE_NAME,
  CustomerAuthError,
  type IssueCodeResult,
  type VerifyResult,
} from '@gbox/core/modules/customer-auth/index.js'

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface AccountRoutesDeps {
  /**
   * Issue a magic link + OTP for (shop, email). In production this is
   * `issueLoginCode(db, shopId, email, ip)` from core.
   */
  issueLoginCode: (
    shopId: string,
    email: string,
    ip?: string,
  ) => Promise<IssueCodeResult>
  /** Verify a magic-link token. Production: `verifyMagicLink(db, …)`. */
  verifyMagicLink: (
    shopId: string,
    email: string,
    token: string,
    ctx: { ip?: string; userAgent?: string },
  ) => Promise<VerifyResult>
  /** Verify a 6-digit OTP. Production: `verifyOtpCode(db, …)`. */
  verifyOtpCode: (
    shopId: string,
    email: string,
    code: string,
    ctx: { ip?: string; userAgent?: string },
  ) => Promise<VerifyResult>
  /** Revoke a session by its plaintext token. */
  revokeSession: (token: string) => Promise<void>
  /**
   * Hook invoked every time a magic link is issued. In production
   * this enqueues an email via the BullMQ mailer; in dev / tests the
   * harness logs the token so a developer can click it. Optional —
   * when absent the token is silently dropped.
   */
  onMagicLinkIssued?: (input: {
    shopId: string
    email: string
    magicLinkToken: string
    otpCode: string
    expiresAt: Date
  }) => Promise<void> | void
  /** Cookie name — defaults to CUSTOMER_COOKIE_NAME. */
  cookieName?: string
  /** Cookie domain (e.g. `.gbox.co`). Optional. */
  cookieDomain?: string
  /** Override Secure flag. Defaults to `NODE_ENV === 'production'`. */
  secureCookie?: boolean
  /**
   * Where /account/login/verify redirects on success. Defaults to
   * `/account`. Exposed so future stages (accounts portal on
   * accounts.gbox.co) can target a different landing page.
   */
  redirectAfterLogin?: string
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildAccountRoutes(
  deps: AccountRoutesDeps,
): (req: Request, res: Response, next: NextFunction) => void {
  const cookieName = deps.cookieName ?? CUSTOMER_COOKIE_NAME
  const secureCookie =
    deps.secureCookie ?? process.env.NODE_ENV === 'production'
  const redirectAfterLogin = deps.redirectAfterLogin ?? '/account'

  const router: Router = express.Router()
  router.use(express.json({ limit: '16kb' }))
  router.use(express.urlencoded({ extended: false, limit: '16kb' }))

  // -----------------------------------------------------------------
  // POST /account/login — request magic link + OTP
  // -----------------------------------------------------------------

  router.post('/account/login', async (req, res, next) => {
    try {
      const shopId = requireShop(req, res)
      if (!shopId) return
      const email = typeof req.body?.email === 'string' ? req.body.email.trim() : ''
      if (!email) {
        return jsonError(res, 422, 'Email is required')
      }

      // Fire the core call but NEVER surface its outcome to the
      // caller. Both success and failure produce an identical 200
      // response so the storefront cannot be used as an oracle to
      // discover which addresses belong to customers.
      try {
        const result = await deps.issueLoginCode(
          shopId,
          email,
          typeof req.ip === 'string' ? req.ip : undefined,
        )
        if (deps.onMagicLinkIssued) {
          try {
            await deps.onMagicLinkIssued({
              shopId,
              email,
              magicLinkToken: result.magicLinkToken,
              otpCode: result.otpCode,
              expiresAt: result.expiresAt,
            })
          } catch (hookErr) {
            req.gboxCtx?.logger?.warn?.(
              { err: hookErr },
              'account-routes: onMagicLinkIssued hook threw (delivery may fail)',
            )
          }
        }
      } catch (err) {
        req.gboxCtx?.logger?.info?.(
          { err, email },
          'account-routes: issueLoginCode rejected (masked to caller)',
        )
      }

      if (wantsJson(req)) {
        res.status(200)
        res.set('Content-Type', 'application/json; charset=utf-8')
        res.send(JSON.stringify({ ok: true }))
        return
      }

      // Browser form submit → 303 to the "check your inbox" page.
      res.status(303)
      res.set('Location', '/account/login?sent=1')
      res.set('Content-Type', 'text/plain; charset=utf-8')
      res.send('Check your inbox for a login link.')
    } catch (err) {
      next(err)
    }
  })

  // -----------------------------------------------------------------
  // GET /account/login/verify — click-through from the magic link
  // -----------------------------------------------------------------

  router.get('/account/login/verify', async (req, res, next) => {
    try {
      const shopId = requireShop(req, res)
      if (!shopId) return

      const email =
        typeof req.query.email === 'string' ? req.query.email.trim() : ''
      const token = typeof req.query.token === 'string' ? req.query.token : ''
      if (!email || !token) {
        return jsonError(res, 422, 'email and token are required')
      }

      let verified: VerifyResult
      try {
        verified = await deps.verifyMagicLink(shopId, email, token, {
          ip: typeof req.ip === 'string' ? req.ip : undefined,
          userAgent:
            typeof req.headers['user-agent'] === 'string'
              ? req.headers['user-agent']
              : undefined,
        })
      } catch (err) {
        req.gboxCtx?.logger?.info?.(
          { err, email },
          'account-routes: verifyMagicLink rejected',
        )
        const message =
          err instanceof CustomerAuthError
            ? err.message
            : 'Login link is invalid or has expired.'
        // Bounce back to the login page with the error message in
        // the query string so the template can render it.
        res.status(303)
        res.set(
          'Location',
          `/account/login?error=${encodeURIComponent(message)}`,
        )
        res.set('Content-Type', 'text/plain; charset=utf-8')
        res.send(message)
        return
      }

      writeSessionCookie(res, {
        cookieName,
        token: verified.sessionToken,
        expiresAt: verified.sessionExpiresAt,
        secure: secureCookie,
        domain: deps.cookieDomain,
      })

      res.status(303)
      res.set('Location', redirectAfterLogin)
      res.set('Content-Type', 'text/plain; charset=utf-8')
      res.send(`Redirecting to ${redirectAfterLogin}`)
    } catch (err) {
      next(err)
    }
  })

  // -----------------------------------------------------------------
  // POST /account/otp — paste-the-code fallback
  // -----------------------------------------------------------------

  router.post('/account/otp', async (req, res, next) => {
    try {
      const shopId = requireShop(req, res)
      if (!shopId) return

      const email = typeof req.body?.email === 'string' ? req.body.email.trim() : ''
      const code = typeof req.body?.code === 'string' ? req.body.code.trim() : ''
      if (!email || !code) {
        return jsonError(res, 422, 'email and code are required')
      }

      let verified: VerifyResult
      try {
        verified = await deps.verifyOtpCode(shopId, email, code, {
          ip: typeof req.ip === 'string' ? req.ip : undefined,
          userAgent:
            typeof req.headers['user-agent'] === 'string'
              ? req.headers['user-agent']
              : undefined,
        })
      } catch (err) {
        if (err instanceof CustomerAuthError) {
          return jsonError(res, err.status ?? 400, err.message, err.code)
        }
        throw err
      }

      writeSessionCookie(res, {
        cookieName,
        token: verified.sessionToken,
        expiresAt: verified.sessionExpiresAt,
        secure: secureCookie,
        domain: deps.cookieDomain,
      })

      res.status(200)
      res.set('Content-Type', 'application/json; charset=utf-8')
      res.send(
        JSON.stringify({
          ok: true,
          customer_id: verified.customer_id,
          new_customer: verified.newCustomer,
        }),
      )
    } catch (err) {
      next(err)
    }
  })

  // -----------------------------------------------------------------
  // POST /account/logout — revoke + clear
  // -----------------------------------------------------------------

  router.post('/account/logout', async (req, res, next) => {
    try {
      const token = req.gboxCookies?.all?.[cookieName] ?? null
      if (token) {
        try {
          await deps.revokeSession(token)
        } catch (err) {
          req.gboxCtx?.logger?.warn?.(
            { err },
            'account-routes: revokeSession threw — still clearing cookie',
          )
        }
      }

      // Emit the clearing Set-Cookie unconditionally so any zombie
      // cookie the browser holds (e.g. from an older login on a
      // sibling tab) gets wiped.
      clearSessionCookie(res, {
        cookieName,
        secure: secureCookie,
        domain: deps.cookieDomain,
      })

      if (wantsJson(req)) {
        res.status(200)
        res.set('Content-Type', 'application/json; charset=utf-8')
        res.send(JSON.stringify({ ok: true }))
        return
      }

      res.status(303)
      res.set('Location', '/')
      res.set('Content-Type', 'text/plain; charset=utf-8')
      res.send('Redirecting to /')
    } catch (err) {
      next(err)
    }
  })

  return router as unknown as (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireShop(req: Request, res: Response): string | null {
  const shopId = typeof req.gboxShopId === 'string' ? req.gboxShopId : null
  if (!shopId) {
    res.status(400)
    res.set('Content-Type', 'application/json; charset=utf-8')
    res.send(
      JSON.stringify({
        ok: false,
        status: 400,
        message: 'Shop could not be resolved',
      }),
    )
    return null
  }
  return shopId
}

function wantsJson(req: Request): boolean {
  const accept = req.headers.accept
  if (typeof accept === 'string' && /\bapplication\/json\b/i.test(accept)) {
    return true
  }
  // Clients that POST JSON bodies (fetch / axios / merchant JS) almost
  // always want a JSON response even when they forget to set `Accept`.
  // Browser form submits use `application/x-www-form-urlencoded`, which
  // is how we distinguish them from XHR-style callers.
  const contentType = req.headers['content-type']
  if (
    typeof contentType === 'string' &&
    /\bapplication\/json\b/i.test(contentType)
  ) {
    return true
  }
  return false
}

function jsonError(
  res: Response,
  status: number,
  message: string,
  code?: string,
): void {
  res.status(status)
  res.set('Content-Type', 'application/json; charset=utf-8')
  res.send(
    JSON.stringify({
      ok: false,
      status,
      message,
      ...(code ? { code } : {}),
    }),
  )
}

interface CookieShape {
  cookieName: string
  token?: string
  expiresAt?: Date
  secure: boolean
  domain?: string | undefined
}

function writeSessionCookie(res: Response, opts: CookieShape): void {
  const parts = [
    `${opts.cookieName}=${encodeURIComponent(opts.token ?? '')}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (opts.domain) parts.push(`Domain=${opts.domain}`)
  if (opts.secure) parts.push('Secure')
  if (opts.expiresAt) {
    const maxAge = Math.max(
      0,
      Math.floor((opts.expiresAt.getTime() - Date.now()) / 1000),
    )
    parts.push(`Max-Age=${maxAge}`)
    parts.push(`Expires=${opts.expiresAt.toUTCString()}`)
  }
  res.append('Set-Cookie', parts.join('; '))
}

function clearSessionCookie(
  res: Response,
  opts: Omit<CookieShape, 'token' | 'expiresAt'>,
): void {
  const parts = [
    `${opts.cookieName}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ]
  if (opts.domain) parts.push(`Domain=${opts.domain}`)
  if (opts.secure) parts.push('Secure')
  res.append('Set-Cookie', parts.join('; '))
}
