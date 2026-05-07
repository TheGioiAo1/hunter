/**
 * Gbox Storefront — Tracking Middleware (Stage 3E.2)
 *
 * Automatic page_view recorder. Installed BEFORE the storefront
 * handler so it sees every GET request and can register a
 * `finish` listener on the response — we record the event after
 * the response is sent so the buyer never waits on analytics IO.
 *
 * Design:
 *
 *   1. **Skip list over allow list.** The middleware runs against
 *      the full URL space, so the skip list explicitly names every
 *      path that is NOT a content page: `/_health`, `/assets/*`,
 *      `/cart.js` + `/cart/*`, `/checkout`, `/account*`, `/events`,
 *      `/robots.txt`, `/sitemap.xml`. Anything else is treated as
 *      a content page and recorded.
 *
 *   2. **Only GET, only 2xx.** POSTs are mutation endpoints (cart
 *      add, login, etc.) and fire their own events via
 *      `record*` calls inline with the mutation handler. Non-2xx
 *      responses are noise for the funnel (redirects don't count
 *      as views either — the follow-up GET does).
 *
 *   3. **Session id resolution.** Uses the cart cookie as a stable
 *      anonymous session id when present; falls back to the
 *      request id otherwise. Anonymous page views without any
 *      cookie won't cluster into sessions, which is fine for MVP —
 *      once a visitor hits any cart action they start showing up
 *      under a stable id.
 *
 *   4. **Defensive IO.** The injected `recordPageView` is wrapped
 *      in try/catch: any throw is caught, logged at WARN via the
 *      request logger, and swallowed. The core recorder already
 *      eats DB errors; this is belt-and-braces in case a caller
 *      injects something else.
 */

import type { Request, Response, NextFunction } from 'express'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrackingPageViewInput {
  path: string
  referrer: string | null
  userAgent: string
  sessionId: string
  customerId?: string | null
  /** UTM attribution — filled from req.gboxUtm if available. */
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
  /** Hashed or raw IP — for analytics. */
  ip?: string | null
}

export interface TrackingMiddlewareOptions {
  /**
   * Called after every recorded content-page response. In
   * production this binds to
   * `(shopId, input) => recordPageView(db, shopId, input)` from
   * `@gbox/core/modules/events`; in tests it's a `vi.fn()`.
   */
  recordPageView: (
    shopId: string,
    input: TrackingPageViewInput,
  ) => Promise<void>
}

// ---------------------------------------------------------------------------
// Skip-list predicates
// ---------------------------------------------------------------------------

/**
 * Paths the tracker NEVER records a page_view for. Order matters
 * only for readability — we test each entry.
 */
const SKIP_EXACT = new Set<string>([
  '/_health',
  '/cart.js',
  '/checkout',
  '/robots.txt',
  '/sitemap.xml',
  '/events',
])

const SKIP_PREFIXES = [
  '/assets/',
  '/cart/',
  '/account/',
  '/account', // bare /account (dashboard is themed but we still keep it out)
  '/events/',
]

function isSkipped(path: string): boolean {
  // Strip the query string before comparing — `/products/cap?page=2`
  // is still a content page.
  const qIdx = path.indexOf('?')
  const clean = qIdx === -1 ? path : path.slice(0, qIdx)
  if (SKIP_EXACT.has(clean)) return true
  for (const prefix of SKIP_PREFIXES) {
    if (clean === prefix || clean.startsWith(prefix)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export function buildTrackingMiddleware(
  opts: TrackingMiddlewareOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  return function trackingMiddleware(req, res, next) {
    // Non-GET never records. Fast reject.
    if (req.method !== 'GET') return next()

    const path = req.originalUrl || req.url || '/'
    if (isSkipped(path)) return next()

    // Register the finish listener BEFORE calling next() so we
    // don't miss events if downstream middleware finishes
    // synchronously.
    res.on('finish', () => {
      try {
        const status = res.statusCode
        if (status < 200 || status >= 300) return

        const shopId =
          typeof req.gboxShopId === 'string' ? req.gboxShopId : null
        if (!shopId) return

        const cartCookie = req.gboxCookies?.cart ?? null
        const requestId = req.gboxCtx?.id ?? null
        const sessionId = cartCookie || requestId || ''
        if (!sessionId) return

        const referrerHeader = req.headers.referer
        const referrer =
          typeof referrerHeader === 'string' && referrerHeader.length > 0
            ? referrerHeader
            : null

        const uaHeader = req.headers['user-agent']
        const userAgent = typeof uaHeader === 'string' ? uaHeader : ''

        const customerId =
          typeof req.gboxCustomerId === 'string' && req.gboxCustomerId.length > 0
            ? req.gboxCustomerId
            : null

        // Resolve UTM attribution from the upstream UTM capture middleware.
        const utm = (req as any).gboxUtm as
          | { source?: string | null; medium?: string | null; campaign?: string | null }
          | undefined

        // Resolve IP for analytics (privacy-hashed by the recorder).
        const rawIp =
          (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
          req.socket?.remoteAddress ??
          null

        const input: TrackingPageViewInput = {
          path: stripQuery(path),
          referrer,
          userAgent,
          sessionId,
          customerId,
          utmSource: utm?.source ?? null,
          utmMedium: utm?.medium ?? null,
          utmCampaign: utm?.campaign ?? null,
          ip: rawIp,
        }

        // Fire-and-forget. We DO NOT await — finish listeners
        // should return promptly, and the recorder already
        // swallows its own errors.
        Promise.resolve()
          .then(() => opts.recordPageView(shopId, input))
          .catch((err) => {
            try {
              req.gboxCtx?.logger?.warn(
                { err, path: input.path },
                'tracking recordPageView failed',
              )
            } catch {
              // Even the logger failed. Give up silently.
            }
          })
      } catch (err) {
        try {
          req.gboxCtx?.logger?.warn({ err }, 'tracking finish listener threw')
        } catch {
          // nothing more we can do.
        }
      }
    })

    next()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripQuery(path: string): string {
  const qIdx = path.indexOf('?')
  return qIdx === -1 ? path : path.slice(0, qIdx)
}
