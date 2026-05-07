/**
 * Gbox Storefront — Email tracking routes (Phase 14 PR4)
 *
 * Two endpoints, both token-authed, both PUBLIC (no shop scoping, no
 * session). Mirror the unsubscribe-routes.ts design for the same reason:
 * email recipients click these URLs from any client, we can't assume
 * cookies, shop context, or session state.
 *
 *   GET /email/track/open/:token.gif
 *     Always returns a 43-byte transparent GIF89a. Side-effect: bumps
 *     open_count + appends email_events('open'). On invalid / unknown
 *     token, still returns the pixel (anti-enumeration + don't show
 *     broken images in inboxes).
 *
 *   GET /email/track/click/:token?u=<base64url(target)>
 *     Always returns 302. Redirects to the decoded target if valid +
 *     safe (http/https, no control chars, no file:/javascript:), else
 *     redirects to `/` (anti-enumeration).
 *
 * WHY THIS LIVES IN STOREFRONT AND NOT ACCOUNTS
 * ---------------------------------------------
 * Scope doc §3: the storefront app already has a stable public URL per
 * shop (and a fallback platform host). It's the same machine the pixel
 * lands on when the recipient is signed out. Accounts-portal is
 * auth-walled and not every recipient has an account.
 *
 * IRON RULE 5
 * -----------
 * No god-admin copy. Errors never render HTML — the GIF + redirect
 * path can't leak any internal state. Server-side logs get the reason
 * (not_found / invalid_target / db_error), but the recipient only sees
 * a 1×1 GIF or a 302.
 *
 * CACHE HEADERS
 * -------------
 * Gmail Image Proxy caches the GIF aggressively; we can't stop that —
 * that's what gives opens their inherent noise floor. But we set
 * `Cache-Control: no-store, no-cache, must-revalidate, max-age=0` so
 * non-Gmail clients (Outlook, Apple Mail without MPP) at least re-hit
 * us each open. Same `Cache-Control` on the redirect route.
 */

import type { NextFunction, Request, Response, Router } from 'express'
import express from 'express'

import {
  TRANSPARENT_GIF_PIXEL,
} from '@gbox/core/modules/email/tracking.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HitMeta {
  ip: string | null
  userAgent: string | null
}

export interface EmailTrackingRoutesDeps {
  /**
   * Record an open-pixel hit. Production:
   *   `(t, m) => recordOpen(db, t, m)` from
   *   `@gbox/core/modules/email/tracking-recorder`.
   *
   * Must NEVER throw — the route swallows failures in addition, but
   * the contract is "best-effort" so callers can just await and move on.
   */
  recordOpen: (token: string, meta: HitMeta) => Promise<void>
  /**
   * Record a click-redirect hit. Returns the safe target URL if the
   * token + encoded-target pair validates, else null. The route uses
   * the result to decide between 302-to-target and 302-to-`/`.
   */
  recordClick: (
    token: string,
    encodedTarget: string,
    meta: HitMeta,
  ) => Promise<{ target: string | null }>
}

// ---------------------------------------------------------------------------
// Token shape
// ---------------------------------------------------------------------------

const TOKEN_RE = /^[0-9a-f]{32}$/i

function isValidTokenShape(t: unknown): t is string {
  return typeof t === 'string' && TOKEN_RE.test(t)
}

// ---------------------------------------------------------------------------
// Hit-meta extraction
// ---------------------------------------------------------------------------

function extractHitMeta(req: Request): HitMeta {
  // Trust proxy is set at the app level in production; req.ip honours
  // X-Forwarded-For in that mode. Fall back to socket remoteAddress for
  // bare-metal / test setups.
  const ip =
    (typeof req.ip === 'string' && req.ip) ||
    req.socket?.remoteAddress ||
    null
  const ua = typeof req.headers['user-agent'] === 'string'
    ? req.headers['user-agent']
    : null
  return { ip, userAgent: ua }
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function sendPixel(res: Response): void {
  // Belt + braces: the real tracking-disabling work is `no-store`, but
  // some proxies respect only older directives. Set the whole set.
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, max-age=0',
  )
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Content-Type', 'image/gif')
  res.setHeader('Content-Length', String(TRANSPARENT_GIF_PIXEL.length))
  // X-Content-Type-Options: nosniff stops IE from guessing the type as
  // HTML and executing embedded scripts. Defence in depth — a 43-byte
  // GIF has no scripts to run, but zero-cost to set.
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.status(200).end(TRANSPARENT_GIF_PIXEL)
}

function sendRedirect(res: Response, location: string): void {
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, max-age=0',
  )
  res.setHeader('Pragma', 'no-cache')
  // 302 (not 301) — a 301 could be cached by browsers and then a future
  // recipient with the same token wouldn't hit us. 302 keeps every
  // click server-side visible.
  res.redirect(302, location)
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildEmailTrackingRoutes(
  deps: EmailTrackingRoutesDeps,
): (req: Request, res: Response, next: NextFunction) => void {
  const router: Router = express.Router()

  // -------------------------------------------------------------------------
  // GET /email/track/open/:token.gif
  // -------------------------------------------------------------------------
  //
  // Express sees the `.gif` suffix as a literal part of the path, so
  // `req.params.token` is just the 32-hex token. We validate shape
  // first, then hand off to the recorder. Both paths end with the
  // same pixel response — recipient sees no difference on a bad
  // token, which is deliberate (anti-enumeration).
  //
  // We RESPOND FIRST, then await the recorder. Process will finish
  // the DB write before exiting; routers don't cut promises short.
  router.get('/email/track/open/:token.gif', (req, res) => {
    // Send the pixel immediately so the recipient's client shows the
    // image without waiting on our DB round-trip.
    sendPixel(res)

    const token = req.params.token
    if (!isValidTokenShape(token)) {
      // Don't bother the DB for obvious garbage. Logged server-side by
      // the caller if they care.
      return
    }

    // Fire recorder. Any failure is swallowed; the pixel already went.
    deps.recordOpen(token, extractHitMeta(req)).catch(() => {
      // Best-effort. Logged in the recorder itself.
    })
  })

  // -------------------------------------------------------------------------
  // GET /email/track/click/:token
  // -------------------------------------------------------------------------
  router.get('/email/track/click/:token', async (req, res) => {
    const token = req.params.token
    const encoded =
      typeof req.query.u === 'string' ? req.query.u : ''

    // Shape check — bail to `/` on garbage. We still fire the recorder
    // after the redirect for the "recorded invalid click" metric, but
    // it's best-effort.
    if (!isValidTokenShape(token) || encoded.length === 0) {
      sendRedirect(res, '/')
      return
    }

    try {
      const result = await deps.recordClick(
        token,
        encoded,
        extractHitMeta(req),
      )
      if (result.target) {
        sendRedirect(res, result.target)
      } else {
        // Target decoded as null (javascript:/data:/malformed) OR
        // token didn't match any delivery. Either way, redirect home.
        sendRedirect(res, '/')
      }
    } catch {
      // Recorder threw despite being best-effort — still redirect the
      // recipient somewhere sensible so they don't see a broken page.
      sendRedirect(res, '/')
    }
  })

  return router as unknown as (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => void
}
