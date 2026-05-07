/**
 * Gbox Storefront — Checkout Handoff Routes (Stage 3B.4 + 3B.5)
 *
 * Single endpoint that turns a Redis-only cart into a priced
 * `CheckoutSession` and hands the buyer off to the checkout
 * subdomain with a signed, single-use token:
 *
 *   POST /checkout
 *     ← body: optional { email }
 *     → 303 Location: https://checkout.gbox.co/c/<id>?hop=<token>
 *     → or 200 JSON when Accept: application/json
 *
 * The storefront NEVER talks to Postgres directly — both the
 * `createCheckout` service (which hydrates variants + prices the
 * cart server-side) and the `issueHandoffToken` helper (which signs
 * + stores the one-shot nonce) live in `@gbox/core`. This file is
 * deliberately dumb glue so the hand-off can be unit tested without
 * a database.
 *
 * Why one endpoint instead of the four Shopify exposes?
 *
 *   In Shopify the checkout itself lives inside admin-controlled
 *   templates. In Gbox the checkout app is a separate subdomain
 *   (`checkout.gbox.co`) — see
 *   `docs/superpowers/specs/2026-04-08-checkout-subdomain-split.md`.
 *   The storefront only needs to "launch" the checkout, not run it.
 *   A single POST /checkout that creates + redirects is all the
 *   theme's `<form action="/checkout">` needs.
 *
 *   The checkout app itself (Stage 3C+) then exposes the per-step
 *   PATCH endpoints (update shipping address, select rate, apply
 *   discount, complete). Those don't live here.
 *
 * Design choices worth calling out:
 *
 *   1. **Accept header steers the response.** The hand-off is a
 *      browser-driven action almost all of the time, so a 303
 *      redirect is the right default. Merchant JS that posts
 *      XHR-style (fetch / axios with `Accept: application/json`)
 *      gets a JSON body instead so they can do their own redirect.
 *
 *   2. **Cart destroyed only AFTER success.** If `createCheckout`
 *      or `issueHandoffToken` throws, the cart is left untouched
 *      so the visitor can retry. This matches Shopify's behaviour
 *      — a failed checkout attempt must not lose the basket.
 *
 *   3. **Dependency-injected service + helpers.** Tests stub these
 *      so we never need Postgres or Redis. Production wires them
 *      to the real core exports.
 *
 *   4. **No secondary validation.** Quantity / variant validation
 *      already happens inside `createCheckout` and will throw a
 *      human-readable error if a variant has been deleted or a
 *      quantity is bad. We surface that error as a 500 rather than
 *      re-implementing the check here.
 */

import type { NextFunction, Request, Response, Router } from 'express'
import express from 'express'
import type { CartService } from '@gbox/core/modules/cart/service.js'

// ---------------------------------------------------------------------------
// Deps — injected so tests can stub without spinning up core
// ---------------------------------------------------------------------------

/**
 * Subset of the core checkout session we read after creation. The
 * real core type has ~15 more fields; we only care about the id
 * (for URL assembly) so keeping the type narrow lets tests mock it
 * without building a full `CheckoutSession`.
 */
export interface CreatedCheckout {
  id: string
  shop_id: string
  total_price?: string
  currency?: string
  [extra: string]: unknown
}

export interface SignedHandoff {
  token: string
  payload: {
    checkoutId: string
    shopId: string
    customerId: string | null
    iat: number
    exp: number
    nonce: string
  }
}

export interface CheckoutRoutesDeps {
  /** Cart store — reads the cart to hand off, destroys it on success. */
  service: CartService
  /**
   * Build a checkout session from the cart lines. In production
   * this is `CheckoutService.createCheckout` bound to the active
   * Kysely instance; tests inject a spy.
   */
  createCheckout: (
    shopId: string,
    lines: Array<{ variant_id: string; quantity: number }>,
    options?: {
      utm?: {
        source?: string | null
        medium?: string | null
        campaign?: string | null
        content?: string | null
        term?: string | null
      }
    },
  ) => Promise<CreatedCheckout>
  /**
   * Sign + persist a one-shot handoff token. In production this is
   * `CheckoutService.issueHandoffToken`; tests inject a spy.
   */
  issueHandoffToken: (input: {
    checkoutId: string
    shopId: string
    customerId: string | null
  }) => Promise<SignedHandoff>
  /**
   * Base URL for the checkout subdomain (no trailing slash). The
   * final redirect looks like `<checkoutHost>/c/<id>?hop=<token>`.
   * Defaults to `process.env.CHECKOUT_PUBLIC_URL` when unset.
   */
  checkoutHost?: string
  /**
   * Optional analytics hook fired AFTER the checkout has been
   * created AND the handoff token signed, but BEFORE the cart is
   * destroyed. Receives the created checkout + cart snapshot so
   * the caller can record a `checkout_start` event. Errors are
   * caught and dropped — a broken analytics pipeline must not
   * stop the buyer from reaching the checkout page.
   */
  onCheckoutStart?: (input: {
    shopId: string
    checkoutId: string
    total: string
    currency: string
    itemCount: number
    sessionId: string
    customerId: string | null
  }) => void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildCheckoutRoutes(
  deps: CheckoutRoutesDeps,
): (req: Request, res: Response, next: NextFunction) => void {
  const {
    service,
    createCheckout,
    issueHandoffToken,
    checkoutHost = process.env.CHECKOUT_PUBLIC_URL ??
      'https://checkout.gbox.co',
  } = deps

  const router: Router = express.Router()
  router.use(express.json({ limit: '32kb' }))
  router.use(express.urlencoded({ extended: false, limit: '32kb' }))

  // -----------------------------------------------------------------
  // POST /checkout
  // -----------------------------------------------------------------

  router.post('/checkout', async (req, res, next) => {
    try {
      const shopId =
        typeof req.gboxShopId === 'string' ? req.gboxShopId : null
      if (!shopId) {
        return next(
          new Error('Checkout route reached without a resolved shop'),
        )
      }

      // --- 1. Fetch the cart --------------------------------------
      const token = req.gboxCookies?.cart ?? null
      if (!token) {
        return jsonError(res, 422, 'Cart is empty')
      }
      const cart = await service.getCart(token)
      if (!cart) {
        return jsonError(res, 422, 'Cart is empty')
      }
      if (cart.shop_id !== shopId) {
        return jsonError(
          res,
          409,
          'Cart belongs to a different shop',
        )
      }
      if (cart.lines.length === 0) {
        return jsonError(res, 422, 'Cart is empty')
      }

      // --- 2. Create the checkout ---------------------------------
      const lines = cart.lines.map((l) => ({
        variant_id: l.variant_id,
        quantity: l.quantity,
      }))
      // Sprint 2b — forward UTM attribution captured by
      // `utm-capture` middleware (stamped from the `gbox_utm`
      // first-party cookie) so the order row gets campaign /
      // source / medium for the store-admin Orders filters.
      const utm = req.gboxUtm
      let checkout: CreatedCheckout
      try {
        checkout = await createCheckout(
          shopId,
          lines,
          utm && (utm.source || utm.medium || utm.campaign || utm.content || utm.term)
            ? { utm }
            : undefined,
        )
      } catch (err) {
        // A failure here is usually "variant deleted", "insufficient
        // inventory", or "shop currency missing". Surface the
        // message as a 500 JSON body (matching the templated error
        // middleware's contract) but leave the cart intact so the
        // visitor can fix whatever caused it.
        return jsonError(
          res,
          500,
          (err as Error).message || 'Failed to create checkout',
        )
      }

      // --- 3. Sign the hand-off token -----------------------------
      // The customer-session middleware (Stage 3C.1) stamps
      // `req.gboxCustomerId` whenever the visitor is signed in. We
      // forward it to core so the checkout subdomain can skip the
      // "email address" step for known buyers and so the order gets
      // attributed to the right customer in reporting.
      const customerId =
        typeof req.gboxCustomerId === 'string' && req.gboxCustomerId.length > 0
          ? req.gboxCustomerId
          : null
      let handoff: SignedHandoff
      try {
        handoff = await issueHandoffToken({
          checkoutId: checkout.id,
          shopId,
          customerId,
        })
      } catch (err) {
        return jsonError(
          res,
          500,
          (err as Error).message || 'Failed to sign handoff token',
        )
      }

      // --- 4a. Fire analytics BEFORE cart destruction so the
      //         hook still has access to the cart's session id
      //         (token). Errors are swallowed — analytics never
      //         breaks checkout.
      if (deps.onCheckoutStart) {
        try {
          deps.onCheckoutStart({
            shopId,
            checkoutId: checkout.id,
            total: typeof checkout.total_price === 'string' ? checkout.total_price : '0',
            currency: typeof checkout.currency === 'string' ? checkout.currency : 'USD',
            itemCount: cart.lines.reduce((n, l) => n + l.quantity, 0),
            sessionId: cart.token,
            customerId,
          })
        } catch {
          // intentionally swallowed
        }
      }

      // --- 4. Destroy the cart (after success) --------------------
      await service.destroyCart(cart.token)

      const url =
        `${checkoutHost.replace(/\/+$/, '')}/c/${encodeURIComponent(checkout.id)}` +
        `?hop=${encodeURIComponent(handoff.token)}`

      // --- 5. Respond ---------------------------------------------
      if (wantsJson(req)) {
        res.status(200)
        res.set('Content-Type', 'application/json; charset=utf-8')
        res.send(
          JSON.stringify({
            checkout_id: checkout.id,
            checkout_url: url,
            handoff_token: handoff.token,
          }),
        )
        return
      }

      // Browser form submit — 303 See Other forces the next fetch to
      // be a GET even though we POSTed here.
      res.status(303)
      res.set('Location', url)
      res.set('Content-Type', 'text/plain; charset=utf-8')
      res.send(`Redirecting to ${url}`)
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

function wantsJson(req: Request): boolean {
  const accept = req.headers.accept
  if (typeof accept !== 'string') return false
  // Match `application/json` OR `application/json, */*` etc. Does
  // NOT match `*/*` alone because browser form submits send that.
  return /\bapplication\/json\b/i.test(accept)
}

function jsonError(res: Response, status: number, description: string): void {
  res.status(status)
  res.set('Content-Type', 'application/json; charset=utf-8')
  res.send(
    JSON.stringify({
      status,
      message: description,
      description,
    }),
  )
}
