/**
 * Gbox Storefront — Express Handler Wrapper (Stage 3A.8)
 *
 * Bridges the storefront Express pipeline (request-context →
 * resolve-shop → cookies → locale → assets) to the framework-
 * agnostic `handleStorefrontRequest` function from
 * `@gbox/core/modules/themes/engine/storefront`.
 *
 * Why a dedicated wrapper instead of just `createExpressStorefrontHandler`?
 *
 *   1. **Per-request `StorefrontHandlerOptions`.** Each shop runs
 *      its own theme, so the engine / datasource / themeConfig
 *      bundle is shop-scoped. The core adapter captures a single
 *      static `opts` at construction time, which assumes one
 *      theme per deploy — fine for tests, wrong for multi-tenant.
 *      This wrapper calls `deps.getHandlerOptions(req)` on every
 *      request so the caller (`server.ts`) can decide how to cache.
 *
 *   2. **Authoritative locale.** The storefront locale middleware
 *      (3A.6) has already picked the active locale using URL
 *      prefix → cookie → Accept-Language → shop default. The core
 *      router re-runs its own negotiation that only knows about
 *      URL prefix + Accept-Language. To make our middleware's
 *      decision win, we rewrite the request path to include the
 *      chosen locale as a URL prefix and ensure
 *      `opts.locales.supported` contains it — that way the router's
 *      URL-prefix branch always fires first and produces the same
 *      locale we already negotiated.
 *
 *   3. **Context injection from `req.gbox*`.** The theme engine's
 *      `StorefrontRequestContext` fields (`cookies`, `shopId`, …)
 *      come straight from middleware-stamped request properties,
 *      so the handler layer never has to re-parse cookies or
 *      re-resolve the shop.
 *
 * Missing pieces explicitly OUT of scope for this stage:
 *
 *   • Caching the compiled engine / loader across requests. Every
 *     invocation of `getHandlerOptions` creates a fresh bundle.
 *     Production will add a per-shop LRU in a later stage once we
 *     have real theme publishing semantics to invalidate against.
 *   • Theme config hot-reload. The current contract is "build the
 *     theme config once and pass it in".
 */

import type { Request, Response, NextFunction } from 'express'
import {
  handleStorefrontRequest,
  type StorefrontHandlerOptions,
  type StorefrontRequestContext,
  type LocaleConfig,
} from '@gbox/core/modules/themes/engine/storefront/index.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StorefrontHandlerDeps {
  /**
   * Resolve the `StorefrontHandlerOptions` bundle for the current
   * request. Typically pulls the resolved shop from `req.gboxShop`,
   * looks up (or lazily constructs) the theme engine + datasource
   * for that shop, and returns them packaged with the locale config.
   *
   * Return `null` to signal "no theme is currently published for
   * this shop"; the middleware will respond with a 404.
   *
   * Errors thrown here are forwarded to `next(err)` so the Express
   * error pipeline can 500 them — this is the right behaviour for
   * genuine infrastructure failures (DB down, theme row corrupt).
   */
  getHandlerOptions: (
    req: Request,
  ) =>
    | StorefrontHandlerOptions
    | null
    | Promise<StorefrontHandlerOptions | null>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collapse Express's query / header value shapes (string |
 * string[] | undefined) into the flat `Record<string, string>` the
 * core router expects.
 */
function flattenStringMap(
  raw: Record<string, unknown> | undefined,
  lowerCaseKeys: boolean,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw) return out
  for (const [k, v] of Object.entries(raw)) {
    if (v == null) continue
    const key = lowerCaseKeys ? k.toLowerCase() : k
    if (Array.isArray(v)) {
      const first = v[0]
      if (first != null) out[key] = String(first)
      continue
    }
    if (typeof v === 'object') {
      out[key] = JSON.stringify(v)
      continue
    }
    out[key] = String(v)
  }
  return out
}

/**
 * Build the path we hand to the core router. When our middleware
 * has already chosen a locale (it always has, by Stage 3A.6), we
 * construct `/<locale><strippedPath>` so the router's URL-prefix
 * branch matches and picks the exact same locale. This makes our
 * four-source cascade (URL → cookie → Accept-Language → default)
 * survive the hand-off even though the core router only knows
 * about two of those sources.
 */
function pathForRouter(req: Request): string {
  const gboxLocale = req.gboxLocale
  const bare =
    gboxLocale?.strippedPath ??
    (typeof req.path === 'string' ? req.path : '/')

  if (!gboxLocale) return bare
  if (bare === '/') return `/${gboxLocale.locale}`
  return `/${gboxLocale.locale}${bare}`
}

/**
 * Ensure `opts.locales.supported` contains the chosen locale,
 * otherwise the router's URL-prefix step would refuse to match it
 * and fall through to Accept-Language. We create a fresh config
 * object (never mutate the caller's) so concurrent requests with
 * different locales don't race each other.
 */
function ensureLocaleSupported(
  opts: StorefrontHandlerOptions,
  locale: string | undefined,
): StorefrontHandlerOptions {
  if (!locale) return opts
  const existing = opts.locales
  const supported = existing?.supported ?? ['en']
  const hasLocale = supported.some(
    (s) => s.toLowerCase() === locale.toLowerCase(),
  )
  if (hasLocale) return opts
  const nextConfig: LocaleConfig = {
    supported: [...supported, locale],
    default: existing?.default ?? locale,
  }
  return { ...opts, locales: nextConfig }
}

/**
 * Build the framework-agnostic request context from the Express
 * request + the middleware-stamped properties.
 */
function buildContext(req: Request): StorefrontRequestContext {
  // The core router was written before the customer-auth module
  // settled on `gbox_customer_session` as the cookie name and still
  // reads the session token as `req.cookies['_session']`. Alias one
  // into the other here so both names resolve to the same value —
  // that way the router keeps working unchanged and the rest of the
  // codebase can use the canonical `gbox_customer_session` everywhere.
  const rawCookies =
    (req.cookies as Record<string, string> | undefined) ?? {}
  const sessionValue =
    rawCookies['gbox_customer_session'] ?? rawCookies['_session'] ?? null
  const cookies: Record<string, string> = sessionValue
    ? {
        ...rawCookies,
        _session: sessionValue,
        gbox_customer_session: sessionValue,
      }
    : rawCookies
  return {
    method: (req.method ?? 'GET').toUpperCase(),
    path: pathForRouter(req),
    query: flattenStringMap(
      req.query as unknown as Record<string, unknown>,
      false,
    ),
    headers: flattenStringMap(
      req.headers as unknown as Record<string, unknown>,
      true,
    ),
    cookies,
    host:
      (req as unknown as { hostname?: string }).hostname ??
      (typeof req.headers.host === 'string' ? req.headers.host : ''),
    designMode: detectDesignMode(
      req.query as unknown as Record<string, unknown>,
      req.headers as unknown as Record<string, unknown>,
      typeof req.gboxPreviewThemeId === 'string' && req.gboxPreviewThemeId.length > 0,
    ),
    shopId: req.gboxShopId,
  }
}

/**
 * `?design_mode=true` (theme editor iframe) OR the
 * `x-gbox-design-mode` header trip design mode, which the router
 * surfaces into `request.design_mode` for Liquid templates.
 */
/**
 * `?design_mode=true` (theme editor iframe) OR the
 * `x-gbox-design-mode` header trip design mode, which the router
 * surfaces into `request.design_mode` for Liquid templates.
 *
 * Security: design mode is only enabled when there is also a valid
 * preview token on the request (stamped by theme-preview middleware
 * as `req.gboxPreviewThemeId`). Without this guard, any visitor
 * could flip design mode on by adding the query param.
 */
function detectDesignMode(
  query: Record<string, unknown>,
  headers: Record<string, unknown>,
  hasPreviewToken?: boolean,
): boolean {
  // Only allow design mode when a valid preview token was presented
  if (!hasPreviewToken) return false
  const q = query['design_mode']
  if (typeof q === 'string' && q.toLowerCase() === 'true') return true
  const h = headers['x-gbox-design-mode']
  if (typeof h === 'string' && h.toLowerCase() === 'true') return true
  return false
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Build the Express middleware that terminates every non-asset
 * storefront request. Place it LAST in `buildApp()` — it never
 * calls `next()` on a successful match (it either sends the
 * rendered response or forwards a true error to `next(err)`).
 */
export function buildStorefrontHandler(
  deps: StorefrontHandlerDeps,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async function storefrontHandler(req, res, next) {
    let baseOpts: StorefrontHandlerOptions | null
    try {
      baseOpts = await deps.getHandlerOptions(req)
    } catch (err) {
      next(err)
      return
    }

    if (baseOpts === null) {
      // No theme is currently published for this shop. Stage 3A.9
      // will replace this with a branded 404 template; for now
      // plain text is fine and matches the resolve-shop middleware.
      res.status(404).type('text/plain').send('404 No Theme Available')
      return
    }

    const opts = ensureLocaleSupported(baseOpts, req.gboxLocale?.locale)

    let response
    try {
      response = await handleStorefrontRequest(opts, buildContext(req))
    } catch (err) {
      // The core router catches its own rendering errors and maps
      // them to 500; reaching this branch means something deeper
      // broke (opts.engine missing, prepareThemeConfig threw, …).
      next(err)
      return
    }

    res.status(response.status)
    for (const [k, v] of Object.entries(response.headers)) {
      res.set(k, v)
    }
    res.send(response.body)
  }
}
