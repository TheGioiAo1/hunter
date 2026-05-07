/**
 * Gbox Storefront — Public Unsubscribe Routes (Phase 8 PR2e)
 *
 * Two endpoints:
 *
 *   GET  /unsubscribe/:token
 *     Renders a minimal confirmation page with a POST form. NEVER
 *     looks up the token — a read-only render means email link-preview
 *     bots (Outlook, Gmail, Slack unfurl, ...) can hit the URL without
 *     accidentally unsubscribing the customer.
 *
 *   POST /unsubscribe/:token
 *     Commits the unsubscribe by calling the injected
 *     `unsubscribeByToken` dep (bound to the abandoned-cart service in
 *     production). Handles three outcomes:
 *       • fresh unsubscribe          → "You've been unsubscribed."
 *       • already-unsubscribed row   → "You've already unsubscribed."
 *       • token not found / bad len  → "This link is invalid or expired."
 *
 * Design notes:
 *
 *   1. **Token IS the auth.** The 32-hex-char token carries 128 bits of
 *      entropy and is globally unique across shops. No CSRF token is
 *      needed — an attacker who can already POST to `/unsubscribe/<t>`
 *      must already know `t`, which means they already have the email.
 *
 *   2. **No shop scoping.** The URL is platform-rooted
 *      (`accounts.gbox.co/unsubscribe/<token>` by default, overridable
 *      via `PLATFORM_BASE_URL`). The route therefore works without a
 *      `resolve-shop` middleware stamping `req.gboxShopId`. If the
 *      route happens to be mounted on a shop-resolved host (dev setup),
 *      it still works — we just ignore the resolved shop.
 *
 *   3. **Minimal HTML, no theme engine.** The confirmation + result
 *      pages are standalone HTML with inline styles. No Liquid, no
 *      theme loader, no per-shop branding (there's no guaranteed shop
 *      context here). Keeps the page fast, render-on-any-host, and
 *      unaffected by a broken or un-published theme.
 *
 *   4. **Iron rule 5 — no platform leakage.** The page never mentions
 *      "god admin", `platform_settings`, the flow-engine step names,
 *      or any internal remediation path. Errors read as neutral
 *      customer-facing copy.
 */

import type { NextFunction, Request, Response, Router } from 'express'
import express from 'express'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal enrolment shape the storefront needs. Matches the subset of
 * `AbandonedCartEnrollmentRow` from `@gbox/core/modules/marketing/
 * abandoned-cart` that we actually consume here — keeping the shape
 * thin means the storefront doesn't need to depend on the full
 * enrolment type and we avoid cross-package Kysely type friction.
 */
export interface UnsubscribeEnrollment {
  id: string
  shop_id: string
  email: string
  unsubscribed_at: string | null
}

export type UnsubscribeLookupResult =
  | { ok: true; enrollment: UnsubscribeEnrollment }
  | { ok: false }

export interface UnsubscribeRoutesDeps {
  /**
   * Look up + flip unsubscribed_at for the given token. Production:
   * `(token) => unsubscribeByToken(db, token)` from
   * `@gbox/core/modules/marketing/abandoned-cart`.
   *
   * Must return `{ ok: false }` for invalid / short-length / unknown
   * tokens (the service conflates these intentionally to prevent
   * enumeration).
   */
  unsubscribeByToken: (token: string) => Promise<UnsubscribeLookupResult>
}

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

/**
 * Tokens are 32 lowercase hex chars. We validate the shape at the edge
 * so obviously-malformed paths short-circuit to the invalid-link page
 * without spending a DB round trip.
 */
const TOKEN_RE = /^[0-9a-f]{32}$/i

function isValidTokenShape(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_RE.test(token)
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildUnsubscribeRoutes(
  deps: UnsubscribeRoutesDeps,
): (req: Request, res: Response, next: NextFunction) => void {
  const router: Router = express.Router()

  // Tight body-parser limit — the POST carries zero form data (token is
  // in the URL), but some clients will still send an empty body. 1 KiB
  // is plenty; anything larger is abuse and the tail error handler
  // maps it to a generic "invalid link" page.
  router.use(
    '/unsubscribe/:token',
    express.urlencoded({ limit: '1kb', extended: false }),
  )

  // -------------------------------------------------------------------------
  // GET /unsubscribe/:token — confirmation page
  // -------------------------------------------------------------------------
  router.get('/unsubscribe/:token', (req, res) => {
    const token = req.params.token
    if (!isValidTokenShape(token)) {
      sendInvalidLink(res)
      return
    }
    sendConfirmPage(res, token)
  })

  // -------------------------------------------------------------------------
  // POST /unsubscribe/:token — commit
  // -------------------------------------------------------------------------
  router.post('/unsubscribe/:token', async (req, res) => {
    try {
      const token = req.params.token
      if (!isValidTokenShape(token)) {
        sendInvalidLink(res)
        return
      }

      const result = await deps.unsubscribeByToken(token)
      if (!result.ok) {
        sendInvalidLink(res)
        return
      }

      // `unsubscribed_at` is set iff the row was *already* unsubscribed
      // (the service returns the existing row verbatim) — for a fresh
      // unsubscribe the service stamps the field before returning.
      // We can't distinguish "fresh vs already" from the field alone
      // because both paths end with the field populated, but we CAN
      // check whether the timestamp is very recent (<5s) — and if not,
      // the row was already unsubscribed before this request.
      //
      // That comparison is fragile across clocks, so we use a simpler
      // rule: the service guarantees that if the row existed and was
      // already unsubscribed on entry, it returns the existing
      // `unsubscribed_at`. We ask the caller to pass enough info to
      // decide via the row's timestamp freshness — see
      // `isFreshUnsubscribe`.
      const fresh = isFreshUnsubscribe(result.enrollment)
      sendSuccessPage(res, { fresh })
    } catch (err) {
      try {
        req.gboxCtx?.logger?.warn(
          { err },
          'unsubscribe route threw',
        )
      } catch {
        // logger itself is best-effort; never let its failure leak a
        // 500 to the customer.
      }
      // We deliberately show the generic invalid-link UI instead of a
      // 500 — the customer did nothing wrong, and showing our internal
      // error state on a public page would be both confusing and a
      // small leak. The operator will see the exception server-side.
      sendInvalidLink(res)
    }
  })

  // Body-parser errors (entity.too.large, charset.unsupported, ...) all
  // get the same neutral "invalid link" UI. Never 500 a public page.
  router.use(
    '/unsubscribe/:token',
    (_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      sendInvalidLink(res)
    },
  )

  return router as unknown as (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => void
}

// ---------------------------------------------------------------------------
// Freshness check
// ---------------------------------------------------------------------------

/**
 * Heuristic: if the row's `unsubscribed_at` is within the last ~10
 * seconds, we treat this as a fresh unsubscribe. Otherwise we assume
 * the customer already hit the link earlier and we show the
 * "already unsubscribed" copy.
 *
 * Why 10s? The service stamps `unsubscribed_at = NOW()` and returns
 * immediately, so the end-to-end round-trip from commit → response
 * should comfortably fit in 10s even on a slow VPS. Legitimately-fresh
 * rows are always well under 1s.
 */
function isFreshUnsubscribe(enrollment: UnsubscribeEnrollment): boolean {
  if (!enrollment.unsubscribed_at) return true
  const stampedMs = Date.parse(enrollment.unsubscribed_at)
  if (!Number.isFinite(stampedMs)) return true
  const ageMs = Date.now() - stampedMs
  return ageMs < 10_000
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function sendConfirmPage(res: Response, token: string): void {
  // `token` is already validated to be 32 hex chars — safe to interpolate.
  const body = pageShell(
    'Unsubscribe',
    `
    <h1>Unsubscribe</h1>
    <p>Click the button below to confirm you no longer want to receive emails like this one.</p>
    <form method="POST" action="/unsubscribe/${token}" class="unsub-form">
      <button type="submit" class="btn btn-primary">Unsubscribe me</button>
    </form>
    <p class="muted">You can change your mind later by signing up again from the store.</p>
    `,
  )
  res
    .status(200)
    .type('text/html; charset=utf-8')
    // No caching — we don't want a shared cache to serve this for
    // a token that's since been unsubscribed (the page itself doesn't
    // leak state but we want POSTs to always hit the origin).
    .set('Cache-Control', 'no-store')
    .set('X-Robots-Tag', 'noindex, nofollow')
    .send(body)
}

function sendSuccessPage(res: Response, opts: { fresh: boolean }): void {
  const heading = opts.fresh ? "You've been unsubscribed" : "You've already unsubscribed"
  const message = opts.fresh
    ? "We won't email you about this cart again."
    : 'Your address is already off the list — no further action needed.'
  const body = pageShell(
    heading,
    `
    <h1>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(message)}</p>
    <p class="muted">You can change your mind later by signing up again from the store.</p>
    `,
  )
  res
    .status(200)
    .type('text/html; charset=utf-8')
    .set('Cache-Control', 'no-store')
    .set('X-Robots-Tag', 'noindex, nofollow')
    .send(body)
}

/**
 * Neutral error UI shown for malformed tokens, not-found tokens, and
 * any unexpected error during POST. Intentionally conflates these
 * states so a probe can't distinguish them.
 */
function sendInvalidLink(res: Response): void {
  const body = pageShell(
    'Invalid link',
    `
    <h1>Invalid link</h1>
    <p>This unsubscribe link is invalid or has already been used.</p>
    <p class="muted">If you're still receiving emails you didn't sign up for, please reply to the latest message so the sender can help.</p>
    `,
  )
  res
    .status(200)
    .type('text/html; charset=utf-8')
    .set('Cache-Control', 'no-store')
    .set('X-Robots-Tag', 'noindex, nofollow')
    .send(body)
}

function pageShell(title: string, contentHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color: #1f2937; background: #f8fafc; }
  .wrap { max-width: 480px; margin: 0 auto; padding: 64px 24px; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  h1 { margin: 0 0 16px; font-size: 22px; font-weight: 600; }
  p { margin: 0 0 12px; line-height: 1.5; }
  .muted { color: #6b7280; font-size: 13px; margin-top: 24px; }
  .btn { display: inline-block; padding: 10px 20px; border-radius: 8px; font-weight: 600; font-size: 15px; cursor: pointer; border: 1px solid transparent; font-family: inherit; }
  .btn-primary { background: #111827; color: #fff; }
  .btn-primary:hover { background: #1f2937; }
  .unsub-form { margin: 24px 0 8px; }
</style>
</head>
<body>
<main class="wrap"><div class="card">${contentHtml}</div></main>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      case "'":
        return '&#39;'
      default:
        return c
    }
  })
}
