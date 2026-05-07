/**
 * Gbox Storefront — Customer Session Middleware (Stage 3C.1)
 *
 * Reads the `gbox_customer_session` cookie that the account login
 * flow writes, looks it up via the injected `getSessionByToken`
 * function (production binding: `@gbox/core/modules/customer-auth`),
 * and — if valid — attaches a light-weight customer profile to the
 * request so:
 *
 *   • the storefront handler can render `customer.*` drops in
 *     account-aware templates (header "Hi, Alice", greeting on
 *     `/account`, etc.),
 *   • the checkout hand-off route can forward `req.gboxCustomerId`
 *     into `issueHandoffToken` instead of passing `null`, and
 *   • downstream mutation routes (cart, checkout, account, wishlist)
 *     can attribute actions to the signed-in buyer.
 *
 * Design rules:
 *
 *   1. **Shop-scoped.** A session whose `shop_id` doesn't match the
 *      resolved shop is treated as anonymous. A cookie leaked from
 *      `brand-a.gbox.co` must never authenticate on `brand-b.gbox.co`
 *      even if a user has both domains open in the same browser.
 *
 *   2. **Never fails the request.** Any error from the lookup or the
 *      profile load is swallowed — the visitor just renders as an
 *      anonymous buyer. The storefront must never 500 because the
 *      customer database hiccuped.
 *
 *   3. **Optional profile.** The middleware ALWAYS stamps
 *      `gboxCustomerId` when the session is valid, but the profile
 *      itself is optional — if the customer row has been deleted
 *      (merchant disabled the account) we still record the id so
 *      audit logs can trace "who hit /account" but render as
 *      anonymous to avoid leaking a stale profile.
 *
 *   4. **Cookie name is pinned to core.** We import
 *      `CUSTOMER_COOKIE_NAME` from `@gbox/core/modules/customer-auth`
 *      so there is ONE source of truth for the cookie name across
 *      the admin, the accounts portal, and the storefront. Tests
 *      override via the `cookieName` option.
 *
 *   5. **Dependency-injected.** `getSessionByToken` + `loadCustomer`
 *      come from the caller so tests can inject pure fakes. In
 *      production the server entrypoint binds them to the real Kysely
 *      instance + the customers service.
 */

import type { NextFunction, Request, Response } from 'express'
import { CUSTOMER_COOKIE_NAME } from '@gbox/core/modules/customer-auth/index.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Light-weight customer profile the storefront renders in templates.
 * We intentionally DO NOT forward every column from the `customers`
 * table — the storefront only needs name, email, order stats, and
 * addresses to render account pages. Anything sensitive
 * (password_hash, admin notes, tax_exempt) stays in the core service.
 */
export interface CustomerProfile {
  id: string
  email: string | null
  first_name: string | null
  last_name: string | null
  orders_count: number
  total_spent: string
  addresses?: Array<{
    id: string
    first_name: string | null
    last_name: string | null
    company: string | null
    address1: string | null
    address2: string | null
    city: string | null
    province: string | null
    country: string | null
    zip: string | null
    phone: string | null
    is_default: boolean
  }>
}

export interface CustomerSessionLookupResult {
  customer_id: string
  shop_id: string
  expires_at: Date
}

export interface CustomerSessionMiddlewareOptions {
  /**
   * Resolve a session token to `{customer_id, shop_id, expires_at}`
   * or `null` if the token is unknown / expired. In production this
   * is bound to `getSessionByToken(db, token)` from
   * `@gbox/core/modules/customer-auth`.
   */
  getSessionByToken: (
    token: string,
  ) => Promise<CustomerSessionLookupResult | null>
  /**
   * Fetch the customer profile for the resolved shop + customer id.
   * Must return `null` when the customer row has been deleted so the
   * middleware can render as anonymous. In production this is bound
   * to the `customers/service.getCustomer` helper.
   */
  loadCustomer: (
    shopId: string,
    customerId: string,
  ) => Promise<CustomerProfile | null>
  /**
   * Override the cookie name. Defaults to the constant exported by
   * core so admin + accounts + storefront stay in lockstep.
   */
  cookieName?: string
}

// Augment the Express request type so TypeScript knows about the
// fields we stamp here. Kept in the same file as the factory so
// nothing else has to know about the module.
declare module 'express-serve-static-core' {
  interface Request {
    /**
     * Full customer profile (or null for anonymous visitors / ghost
     * sessions). Drops into the `customer` Liquid variable.
     */
    gboxCustomer?: CustomerProfile | null
    /**
     * Just the customer id. Stamped even when the profile is null
     * (e.g. soft-deleted customer row) so routes that only care
     * about "who clicked this" still get attribution.
     */
    gboxCustomerId?: string | null
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the customer session middleware. Safe to call multiple times
 * — it holds no mutable state of its own.
 */
export function buildCustomerSessionMiddleware(
  options: CustomerSessionMiddlewareOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  const cookieName = options.cookieName ?? CUSTOMER_COOKIE_NAME

  return async function customerSessionMiddleware(req, _res, next) {
    // Start every request as anonymous so downstream code can rely on
    // the fields being present even when the lookup short-circuits.
    req.gboxCustomer = null
    req.gboxCustomerId = null

    try {
      const shopId =
        typeof req.gboxShopId === 'string' && req.gboxShopId.length > 0
          ? req.gboxShopId
          : null
      const token = req.gboxCookies?.all?.[cookieName] ?? null

      if (!shopId || !token) {
        return next()
      }

      let session: CustomerSessionLookupResult | null
      try {
        session = await options.getSessionByToken(token)
      } catch (err) {
        req.gboxCtx?.logger?.warn?.(
          { err },
          'customer-session: getSessionByToken threw — treating as anonymous',
        )
        return next()
      }

      if (!session) return next()

      // Cross-shop safety — a cookie minted on brand-a.gbox.co must
      // NEVER authenticate on brand-b.gbox.co, even if both shops
      // share the same platform domain cookie scope.
      if (session.shop_id !== shopId) {
        req.gboxCtx?.logger?.warn?.(
          {
            sessionShop: session.shop_id,
            requestShop: shopId,
          },
          'customer-session: cookie from a different shop — dropping',
        )
        return next()
      }

      // From here on we know the session is valid for THIS shop, so
      // always stamp the id even if the profile fetch fails.
      req.gboxCustomerId = session.customer_id

      let profile: CustomerProfile | null = null
      try {
        profile = await options.loadCustomer(shopId, session.customer_id)
      } catch (err) {
        req.gboxCtx?.logger?.warn?.(
          { err, customerId: session.customer_id },
          'customer-session: loadCustomer threw — rendering as anonymous',
        )
        profile = null
      }

      req.gboxCustomer = profile
      return next()
    } catch (err) {
      // Last-line-of-defence catch — no customer lookup should ever
      // crash the storefront request pipeline.
      req.gboxCtx?.logger?.warn?.(
        { err },
        'customer-session: unexpected failure — continuing as anonymous',
      )
      req.gboxCustomer = null
      req.gboxCustomerId = null
      return next()
    }
  }
}
