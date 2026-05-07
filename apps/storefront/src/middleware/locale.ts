/**
 * Gbox Storefront — Locale Middleware (Stage 3A.6)
 *
 * Sits after `resolve-shop` and `cookies` in the pipeline so it can
 * read from every input source a visitor might use to express a
 * language preference, and decides which locale should drive the
 * current request.
 *
 * Precedence (first match wins):
 *
 *   1. **URL prefix** — `/vi/products/foo` → `vi`. Highest priority
 *      because it's an explicit choice (a link, a search result, a
 *      bookmark). When a prefix is consumed we rewrite `req.url` and
 *      `req.path` so the downstream router sees the bare path.
 *
 *   2. **`locale` cookie** — set by a previous visit or by a future
 *      language-switcher UI. Lower-cased before matching so `VI`
 *      coming back from an older client still resolves.
 *
 *   3. **`Accept-Language` header** — parsed with q-weights via the
 *      shared core helper. Supports base-language fallback
 *      (`fr-CA` → `fr`) for shops that don't have every dialect.
 *
 *   4. **Shop default locale** from `req.gboxShop.defaultLocale`.
 *      When there is no shop (defensive fallback for edge cases
 *      where the resolver is bypassed), `options.defaultLocale` or
 *      `'en'` is used.
 *
 * The result lands on `req.gboxLocale = { locale, strippedPath }`;
 * the storefront router in the theme engine reads `strippedPath`
 * when matching its route table, so nothing downstream has to
 * re-parse the URL.
 *
 * Design notes:
 *
 *   • **Never throws.** Like every other storefront middleware, a
 *     bad cookie or malformed header must never 500 the request.
 *     We log nothing — Accept-Language parsing is intentionally
 *     best-effort.
 *   • **Reuses the core helper.** `stripLocalePrefix`,
 *     `parseAcceptLanguage`, and `pickFromAcceptLanguage` all live
 *     in `@gbox/core/modules/themes/engine/storefront/locale.js`
 *     and are already unit-tested there. This file's only job is
 *     to stitch them together with the cookie source and Express
 *     integration.
 *   • **Supported locales via callback.** `getSupportedLocales` is
 *     a function, not a static array, so a future stage can return
 *     per-shop lists straight from the database without redeploying
 *     the middleware.
 */

import type { Request, Response, NextFunction } from 'express'
import {
  stripLocalePrefix,
  parseAcceptLanguage,
  pickFromAcceptLanguage,
  type LocaleConfig,
  type LocaleNegotiation,
} from '@gbox/core/modules/themes/engine/storefront/locale.js'
import type { ResolvedShop } from './resolve-shop.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LocaleMiddlewareOptions {
  /**
   * Returns the list of locales the current shop supports. Called
   * once per request, with the resolved shop (or `undefined` in the
   * defensive case where `gboxShop` is missing).
   */
  getSupportedLocales: (shop?: ResolvedShop) => string[]
  /**
   * Fallback default locale used when `req.gboxShop` is missing
   * (e.g. the resolver was bypassed in a test). Defaults to `'en'`.
   */
  defaultLocale?: string
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Attached by the locale middleware. */
    gboxLocale?: LocaleNegotiation
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a `LocaleConfig` for the core helpers. Guarantees that
 * `config.default` is a member of `config.supported` — the core
 * helpers rely on that invariant when walking Accept-Language tags.
 */
function buildConfig(
  supported: string[],
  preferredDefault: string,
): LocaleConfig {
  const list = supported.length > 0 ? supported : [preferredDefault]
  const hasPreferred = list.some(
    (s) => s.toLowerCase() === preferredDefault.toLowerCase(),
  )
  return {
    supported: list,
    default: hasPreferred ? preferredDefault : list[0]!,
  }
}

/**
 * Match a cookie value against the supported locale list. Case-
 * insensitive; returns the canonical supported tag (preserving the
 * case configured on the shop) or `null` when unsupported.
 */
function matchCookieLocale(
  cookieValue: string | null | undefined,
  supported: string[],
): string | null {
  if (!cookieValue) return null
  const lowered = cookieValue.trim().toLowerCase()
  if (!lowered) return null
  const hit = supported.find((s) => s.toLowerCase() === lowered)
  return hit ?? null
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Build the locale middleware. The returned function is synchronous
 * and allocation-light — safe to run on every storefront request
 * including asset fetches.
 */
export function buildLocaleMiddleware(
  options: LocaleMiddlewareOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  const fallbackDefault = options.defaultLocale ?? 'en'

  return function localeMiddleware(req, _res, next) {
    const shop = req.gboxShop
    const supported = options.getSupportedLocales(shop)
    const shopDefault = shop?.defaultLocale ?? fallbackDefault
    const config = buildConfig(supported, shopDefault)

    // Split req.url into path + query so that rewriting for a URL
    // locale prefix doesn't clobber the query string.
    const rawUrl = typeof req.url === 'string' ? req.url : '/'
    const qIdx = rawUrl.indexOf('?')
    const pathPart = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx)
    const queryPart = qIdx === -1 ? '' : rawUrl.slice(qIdx)

    // 1. URL prefix — highest priority.
    const fromPrefix = stripLocalePrefix(pathPart, config)
    if (fromPrefix) {
      req.gboxLocale = fromPrefix
      // Rewrite the request so downstream middleware + the theme
      // router see the bare path. `req.path` is a getter in real
      // Express, but we overwrite the property anyway — tests rely
      // on it, and the downstream handler in the storefront adapter
      // reads `req.path` from the same object.
      ;(req as { url: string }).url = fromPrefix.strippedPath + queryPart
      try {
        ;(req as { path: string }).path = fromPrefix.strippedPath
      } catch {
        // In real Express, `req.path` is a getter defined on the
        // prototype; some runtimes reject direct assignment. The
        // getter derives from `req.url`, which we already rewrote,
        // so the downstream reader still sees the stripped path.
      }
      next()
      return
    }

    // 2. Cookie.
    const cookieLocale = matchCookieLocale(
      req.gboxCookies?.locale ?? null,
      config.supported,
    )
    if (cookieLocale) {
      req.gboxLocale = { locale: cookieLocale, strippedPath: pathPart }
      next()
      return
    }

    // 3. Accept-Language header.
    const acceptLang = req.headers['accept-language']
    if (typeof acceptLang === 'string' && acceptLang.length > 0) {
      const parsed = parseAcceptLanguage(acceptLang)
      const picked = pickFromAcceptLanguage(parsed, config)
      if (picked) {
        req.gboxLocale = { locale: picked, strippedPath: pathPart }
        next()
        return
      }
    }

    // 4. Shop default (or the configured fallback when no shop).
    req.gboxLocale = { locale: config.default, strippedPath: pathPart }
    next()
  }
}
