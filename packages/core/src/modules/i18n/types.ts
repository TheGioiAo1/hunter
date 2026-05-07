/**
 * Gbox Platform — i18n Types
 *
 * Decision #1 Step 1.2b — Type definitions for the theme i18n system.
 *
 * Pure type module: no imports, no runtime, safe to consume from any
 * environment (Node, Cloudflare Workers, browser).
 */

/**
 * A flat dictionary of translation key → value for one (shop, locale)
 * pair. The bulk loader builds this from the `translations` table and
 * the in-memory cache stores instances of this shape.
 *
 * Keys are dot-separated to match the JSON files Shopify themes ship
 * with, e.g. `general.cart.title` or `products.product.add_to_cart`.
 * Values are plain strings; interpolation tokens like `{{ count }}`
 * stay literal in the value and are substituted at lookup time by
 * `interpolate()`.
 */
export type TranslationDict = Record<string, string>

/**
 * Optional values to substitute into a translation string. The `t()`
 * function replaces every `{{ name }}` token with the corresponding
 * key from this object. Numbers are coerced to strings; missing keys
 * leave the token literal in the output (matches Shopify behavior).
 *
 * Example:
 *   t('cart.line_item_count', { count: 3 })
 *   // value: "You have {{ count }} items"
 *   // result: "You have 3 items"
 */
export type InterpolationVars = Record<string, string | number | boolean | null | undefined>

/**
 * Options for the `t()` lookup function.
 */
export interface TranslateOptions {
  /**
   * Requested locale. Top tier of the three-tier fallback chain.
   * Usually comes from the request (URL prefix, cookie, header).
   */
  locale?: string

  /**
   * Default locale of the shop. Middle tier of the fallback chain.
   * Read from `shops.default_locale`. Required so that a shop with a
   * non-English baseline can serve a non-English fallback before
   * dropping to ultimate-fallback English.
   */
  shopDefaultLocale?: string

  /**
   * Variables to interpolate into the translated value. Token form
   * is `{{ name }}` (Liquid-style). See `InterpolationVars`.
   */
  vars?: InterpolationVars

  /**
   * Override the ultimate-fallback string. Defaults to the key itself
   * (Shopify behavior — easy to spot missing translations in dev).
   */
  fallback?: string
}

/**
 * Identifies one (shop, locale) cache entry. Used internally by the
 * cache layer; exported for testing.
 */
export interface CacheKey {
  shopId: string
  locale: string
}

/**
 * Public surface of the i18n service. Defined as an interface so the
 * theme engine can swap in a `MemoryI18nService` for tests without
 * pulling the database.
 */
export interface I18nService {
  /**
   * Look up a single key. Returns the resolved string after fallback
   * and interpolation, or `opts.fallback ?? key` if nothing matched.
   */
  t(shopId: string, key: string, opts?: TranslateOptions): Promise<string>

  /**
   * Bulk-load every translation row for a (shop, locale) pair into
   * the in-process cache. Called once per request — every subsequent
   * `t()` call hits the cache.
   */
  preload(shopId: string, locale: string): Promise<TranslationDict>

  /**
   * Insert or update a single translation row. Used by the admin UI
   * and by the theme installer when seeding `locales/*.json` files.
   */
  set(shopId: string, locale: string, key: string, value: string): Promise<void>

  /**
   * Bulk upsert. Theme install ships ~1500 keys per locale; one
   * round-trip beats 1500.
   */
  setMany(
    shopId: string,
    locale: string,
    entries: TranslationDict,
  ): Promise<number>

  /**
   * Drop the in-memory cache for a (shop, locale) pair. Called by the
   * admin UI after an edit so the next request reads fresh data.
   */
  invalidate(shopId: string, locale?: string): void
}
