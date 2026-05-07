/**
 * Gbox Platform — Pure i18n translate helper (Stage 5.4)
 *
 * The existing `I18nService` / `MemoryI18nService` is async — it
 * owns DB lookup + preload + cache. That's the right shape for
 * the admin side but too heavy for the storefront render path,
 * which wants a SYNC call per `{% t 'cart.title' %}` against a
 * bundle that was loaded once at request start.
 *
 * This module is the pure floor:
 *
 *   buildLocaleFallbackChain(requested, default)
 *     e.g. buildLocaleFallbackChain('zh-Hant-TW', 'en')
 *       → ['zh-Hant-TW', 'zh-Hant', 'zh', 'en']
 *
 *   translateKey(bundles, locale, key, opts?)
 *     Walks the fallback chain, returns the first hit with
 *     `{{ var }}` tokens substituted, or `opts.fallback ?? key`
 *     if nothing matched.
 *
 * The caller loads `bundles` however it wants — from JSON files
 * shipped with the theme, from the `translations` Postgres
 * table, from a Redis cache, etc. This module never touches any
 * of that.
 */

import { interpolate } from './interpolate.js'
import type { InterpolationVars, TranslationDict } from './types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A map of locale tag → flat translation dict. Locale tags are
 * BCP-47 style (`en`, `en-US`, `zh-Hant-TW`). Keys inside each
 * dict are dot-separated (`cart.title`, `products.product.add_to_cart`)
 * to match the Shopify theme convention.
 */
export type TranslationBundles = Record<string, TranslationDict>

export interface TranslateKeyOptions {
  /**
   * Shop default locale — the final tier of the fallback chain
   * before the `fallback` string (or the key itself).
   */
  defaultLocale: string
  /** Variables to interpolate into the resolved value. */
  vars?: InterpolationVars
  /**
   * Override the ultimate-fallback string. Defaults to the key
   * itself (Shopify behaviour — makes missing translations
   * obvious in dev).
   */
  fallback?: string
}

// ---------------------------------------------------------------------------
// buildLocaleFallbackChain
// ---------------------------------------------------------------------------

/**
 * Produce the ordered list of locale tags to try when resolving a
 * key. Each tier strips one trailing subtag until the base is
 * reached; the default locale is appended if it isn't already in
 * the chain.
 *
 * Normalisation rules:
 *   - Two-letter primary tag is lowercased (`EN` → `en`).
 *   - Region subtag is uppercased (`en-us` → `en-US`).
 *   - Script subtag (4 letters) is title-cased (`zh-hant` → `zh-Hant`).
 *
 * Returns a de-duplicated array. Empty inputs return `[defaultLocale]`.
 */
export function buildLocaleFallbackChain(
  requested: string | undefined | null,
  defaultLocale: string,
): string[] {
  const normalised = normaliseLocale(requested) ?? normaliseLocale(defaultLocale)
  if (!normalised) return []

  const chain: string[] = []
  const seen = new Set<string>()

  const push = (tag: string) => {
    if (!seen.has(tag)) {
      seen.add(tag)
      chain.push(tag)
    }
  }

  // Walk the ancestors: `zh-Hant-TW` → `zh-Hant` → `zh`
  const parts = normalised.split('-')
  for (let i = parts.length; i >= 1; i--) {
    push(parts.slice(0, i).join('-'))
  }

  // Append the default locale as the final tier.
  const def = normaliseLocale(defaultLocale)
  if (def) push(def)

  return chain
}

// ---------------------------------------------------------------------------
// translateKey
// ---------------------------------------------------------------------------

export function translateKey(
  bundles: TranslationBundles,
  locale: string | undefined | null,
  key: string,
  opts: TranslateKeyOptions,
): string {
  const chain = buildLocaleFallbackChain(locale, opts.defaultLocale)

  for (const tag of chain) {
    const bundle = bundles[tag]
    if (!bundle) continue
    // hasOwnProperty check so an explicit empty string counts as a
    // real value — matches Shopify, and lets translators ship a
    // deliberate blank label without fallback.
    if (Object.prototype.hasOwnProperty.call(bundle, key)) {
      const value = bundle[key]
      if (typeof value === 'string') {
        return interpolate(value, opts.vars ?? {})
      }
    }
  }

  return opts.fallback ?? key
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Canonicalise a BCP-47 tag. Returns `null` for input that
 * obviously isn't a language tag at all.
 */
function normaliseLocale(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null

  const parts = trimmed.split(/[-_]/).filter((p) => p.length > 0)
  if (parts.length === 0) return null

  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if (i === 0) {
      // Primary language — 2 or 3 letters, always lowercase.
      if (!/^[a-zA-Z]{2,3}$/.test(p)) return null
      out.push(p.toLowerCase())
    } else if (p.length === 4 && /^[a-zA-Z]{4}$/.test(p)) {
      // Script subtag — title case (Latn, Hant, …)
      out.push(p[0]!.toUpperCase() + p.slice(1).toLowerCase())
    } else if (
      (p.length === 2 && /^[a-zA-Z]{2}$/.test(p)) ||
      (p.length === 3 && /^\d{3}$/.test(p))
    ) {
      // Region subtag — uppercase letters or 3-digit numeric.
      out.push(p.toUpperCase())
    } else {
      // Variant — lowercase.
      out.push(p.toLowerCase())
    }
  }
  return out.join('-')
}
