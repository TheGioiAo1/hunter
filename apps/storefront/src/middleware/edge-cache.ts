/**
 * Gbox Storefront — Edge Cache Headers Middleware (Phase 3 close-the-loop)
 *
 * Glue between `applyCachePolicy` from `@gbox/core/modules/cache/edge-headers`
 * and the storefront's actual request paths. This file answers one
 * question for every incoming request:
 *
 *   "Which of the six CACHE_PRESETS should stamp this response?"
 *
 * The answer is purely path-based — no session lookup, no cookie
 * parsing — so the middleware is safe to run BEFORE the resolve-shop
 * middleware. That matters because the policy also needs to apply to
 * error responses (resolve-shop 404s) and to asset hits that bypass
 * everything below it.
 *
 * Rules, in order of precedence:
 *
 *   1. `/_health` → no policy. The health endpoint already short-
 *      circuits in `buildApp()` before anything else runs, but we
 *      skip it here anyway so the default handler gets its own
 *      JSON-shaped response without a spurious Cache-Control.
 *
 *   2. `/assets/*` → `theme_asset_immutable`. Fingerprinted CSS / JS
 *      / font / image bytes. Matches the nginx snippet in
 *      `phase-3d-edge-cache-rules.md`.
 *
 *   3. `/checkout`, `/checkout/*` → `no_store`. The checkout hand-off
 *      page is never cacheable — it contains the buyer's email, the
 *      signed handoff token, and the cart line totals.
 *
 *   4. `/cart`, `/cart.js`, `/cart/*` → `personalised_private`. Same
 *      rationale as checkout: cart drop is per-session.
 *
 *   5. `/account`, `/account/*` → `personalised_private`. Dashboard +
 *      order history + login pages.
 *
 *   6. `/events`, `/marketing/subscribe` → `no_store`. Write beacons.
 *
 *   7. POST / PUT / PATCH / DELETE of anything → `no_store`. Any
 *      mutation path is trivially never cacheable.
 *
 *   8. Everything else (`/`, `/products/*`, `/collections/*`,
 *      `/blogs/*`, `/pages/*`, CMS slugs) → `storefront_html_swr`.
 *      Public, short edge TTL, long SWR, varies on Accept-Language +
 *      Cookie so the logged-in variant never poisons the anonymous
 *      cached copy.
 *
 * Implementation notes:
 *
 *   - We call `applyCachePolicy` SYNCHRONOUSLY on `res` at the top of
 *     the request, BEFORE calling `next()`. Downstream middleware
 *     that wants to override the policy (e.g. a live-preview render
 *     that always wants `no_store`) can simply re-call
 *     `applyCachePolicy(res, 'no_store')` and win — Express header
 *     setters are last-writer-wins.
 *
 *   - The path matching uses plain string prefixes instead of regex
 *     because the storefront router uses path-to-regexp v6 which
 *     strips trailing segments from `req.path`. Regex would need
 *     escaping for every dot-inclusive segment (`/cart.js`) and adds
 *     zero value over a switch ladder.
 *
 *   - The middleware is SAFE to install multiple times — stamping
 *     the same header twice is a no-op at the HTTP layer. Tests can
 *     re-wrap the middleware without special teardown.
 */

import type { NextFunction, Request, Response } from 'express'
import {
  applyCachePolicy,
  type CachePresetName,
} from '@gbox/core/modules/cache/edge-headers.js'

/**
 * Decide which preset applies to a given (method, path) pair.
 * Exported for unit tests so the rules can be asserted without a
 * running Express app.
 */
export function pickCachePreset(
  method: string,
  path: string,
): CachePresetName | null {
  // `/_health` is handled by `buildApp`'s own route; never stamp a
  // Cache-Control on it so monitors see the default JSON shape.
  if (path === '/_health') return null

  const upperMethod = method.toUpperCase()

  // Theme assets — pure immutable (fingerprinted filenames).
  if (path === '/assets' || path.startsWith('/assets/')) {
    return 'theme_asset_immutable'
  }

  // Checkout hand-off — never cache. Do this BEFORE the generic
  // mutation rule so even the GET /checkout page returns no_store.
  if (path === '/checkout' || path.startsWith('/checkout/')) {
    return 'no_store'
  }

  // Cart JSON endpoints + any future `/cart/<action>` mutations.
  if (path === '/cart' || path === '/cart.js' || path.startsWith('/cart/')) {
    return 'personalised_private'
  }

  // Account dashboard, login, logout, orders, addresses.
  if (path === '/account' || path.startsWith('/account/')) {
    return 'personalised_private'
  }

  // Event beacons + marketing subscribe — pure writes.
  if (path === '/events' || path === '/marketing/subscribe') {
    return 'no_store'
  }

  // Any non-GET/HEAD mutation across the remaining paths.
  if (upperMethod !== 'GET' && upperMethod !== 'HEAD') {
    return 'no_store'
  }

  // Public cacheable HTML — home, product pages, collections, blogs,
  // pages, policies, search results, sitemap, robots.txt.
  return 'storefront_html_swr'
}

export interface EdgeCacheHeadersOptions {
  /**
   * When true, skip stamping on any request where `req.path` already
   * matches one of the entries in this list. Useful for tests that
   * want to assert Express's default no-header response on specific
   * routes without mocking the middleware.
   */
  bypassPaths?: string[]
}

/**
 * Build the middleware. Safe to call per-test with fresh options.
 */
export function buildEdgeCacheHeadersMiddleware(
  options: EdgeCacheHeadersOptions = {},
) {
  const bypass = new Set(options.bypassPaths ?? [])
  return function edgeCacheHeadersMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (bypass.has(req.path)) {
      next()
      return
    }
    const preset = pickCachePreset(req.method, req.path)
    if (preset) {
      applyCachePolicy(res, preset)
    }
    next()
  }
}
