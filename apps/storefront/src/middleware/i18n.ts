/**
 * Gbox Storefront — i18n middleware (Stage 5.6)
 *
 * Bridges the pure `translateKey` helper in `@gbox/core` to the
 * storefront Express pipeline. Runs once per request, AFTER the
 * locale middleware has pinned `req.gboxLocale`, and stamps a
 * synchronous translator on the request object:
 *
 *   req.gboxT('cart.title')             // → 'Giỏ hàng'
 *   req.gboxT('cart.count', { count: 3 }) // → 'You have 3 items'
 *
 * The caller injects a `loader(ctx)` that returns the translation
 * bundles for the resolved shop (from the `translations` table,
 * from a CDN-cached JSON file, from a per-shop memory LRU, …).
 * This module never talks to a database directly — it only knows
 * how to glue the loader output onto the request.
 *
 * Failure policy: soft. A thrown loader, a null bundle map, a
 * missing key — none of them must 500 the storefront. The
 * Shopify convention is that a miss shows the key verbatim so
 * the developer sees it immediately. We keep that, and stash an
 * empty bundle map on the request so downstream code has a
 * stable contract.
 *
 * Why a middleware rather than calling translateKey inline in
 * the handler? The theme engine template layer needs a sync
 * `t()` to hand to Liquid filters — making the bundle load
 * happen in middleware means the hot render path stays
 * synchronous and the bundle can be reused for every Liquid
 * `{{ 'cart.title' | t }}` in the same template.
 */

import type { Request, Response, NextFunction } from 'express'
import {
  translateKey,
  type TranslationBundles,
} from '@gbox/core/modules/i18n/translate.js'
import type { InterpolationVars } from '@gbox/core/modules/i18n/types.js'
import type { ResolvedShop } from './resolve-shop.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The synchronous translator function stamped on the request. */
export type TranslateFn = (key: string, vars?: InterpolationVars) => string

export interface I18nLoaderContext {
  /** The resolved shop (if any) — for per-shop bundle lookups. */
  shop?: ResolvedShop
  /**
   * The locale the locale middleware picked for THIS request —
   * loaders can use it to decide which bundles to fetch, e.g. for
   * a CDN-cached JSON file named after the locale.
   */
  locale: string
  /** Shop default locale, also the final tier of the fallback chain. */
  defaultLocale: string
}

/**
 * Async loader the caller plugs in to fetch the bundles. Allowed
 * to resolve to:
 *   - a populated `TranslationBundles`
 *   - an empty object `{}` when the shop has no translations
 *   - `null` to signal "no bundle available" (same as empty)
 * The loader is permitted to throw — the middleware swallows
 * the error and falls back to key-as-value.
 */
export type I18nLoader = (
  ctx: I18nLoaderContext,
) => Promise<TranslationBundles | null> | TranslationBundles | null

export interface I18nMiddlewareOptions {
  loader: I18nLoader
  /**
   * Fallback default locale when no resolved shop is present (tests,
   * health checks, edge cases where resolve-shop was bypassed).
   */
  defaultLocale?: string
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Bundles loaded for the current shop (empty object on miss). */
    gboxTranslations?: TranslationBundles
    /**
     * Synchronous translator pinned to the current request's
     * locale + fallback chain. Missing keys return the key itself.
     */
    gboxT?: TranslateFn
  }
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export function buildI18nMiddleware(
  options: I18nMiddlewareOptions,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const fallbackDefault = options.defaultLocale ?? 'en'

  return async function i18nMiddleware(req, _res, next) {
    const shop = req.gboxShop
    const resolvedLocale =
      req.gboxLocale?.locale ?? shop?.defaultLocale ?? fallbackDefault
    const defaultLocale = shop?.defaultLocale ?? fallbackDefault

    // Load bundles — never let a loader failure 500 the request.
    // A thrown loader = missing translations, which degrades to
    // key-as-value (matches Shopify behaviour and keeps the
    // storefront rendering).
    let bundles: TranslationBundles
    try {
      const raw = await options.loader({
        shop,
        locale: resolvedLocale,
        defaultLocale,
      })
      bundles = raw ?? {}
    } catch {
      bundles = {}
    }

    req.gboxTranslations = bundles
    req.gboxT = (key: string, vars?: InterpolationVars): string =>
      translateKey(bundles, resolvedLocale, key, {
        defaultLocale,
        vars,
      })

    next()
  }
}
