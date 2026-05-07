/**
 * Gbox Platform — Admin Translator (Phase 2 Step 2.10)
 *
 * Creates a memoized `t()` function bound to a single locale. The
 * function reads from the static dictionary registry, falls back to
 * en-US if the locale's dictionary is missing a key (should never
 * happen thanks to the typed `AdminLocaleDict`, but guards against
 * runtime dictionary tampering), and interpolates `{name}` tokens.
 *
 * Interpolation syntax is SINGLE BRACE `{name}` — deliberately
 * different from the theme engine's double-brace `{{ name }}` so
 * there's zero chance of a Liquid template accidentally matching
 * admin strings or vice versa.
 *
 * The translator is synchronous (no Promises). Dictionaries are
 * bundled, so there's nothing to await — the admin UI can call `t()`
 * inline inside template literals without sprinkling await.
 */

import type {
  AdminLocale,
  AdminMessageKey,
  AdminTranslator,
  AdminLocaleDict,
} from './types.js'
import { DEFAULT_ADMIN_LOCALE, ADMIN_LOCALES } from './types.js'
import { ADMIN_LOCALE_DICTS } from './locales.js'

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

/**
 * Replace every `{name}` token in `template` with the value from
 * `vars[name]`. Unknown keys stay as literals (matches Shopify), so
 * a typo in a var name is visible in the rendered output.
 *
 * Only simple `{word}` tokens are matched — no nested paths, no
 * format specifiers. Use Intl.NumberFormat/DateFormat directly for
 * anything fancier (see `format.ts`).
 */
export function interpolateAdmin(
  template: string,
  vars: Record<string, string | number> | undefined,
): string {
  if (!vars || template.indexOf('{') === -1) return template
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (key in vars) {
      const v = vars[key]
      return String(v)
    }
    return match
  })
}

// ---------------------------------------------------------------------------
// Locale coercion
// ---------------------------------------------------------------------------

/**
 * Narrow an arbitrary string into a supported `AdminLocale`. If the
 * input isn't recognized, returns the default. Useful for reading
 * request headers / cookies / user preferences where the value is
 * `string`.
 */
export function isAdminLocale(value: unknown): value is AdminLocale {
  return (
    typeof value === 'string' &&
    (ADMIN_LOCALES as readonly string[]).includes(value)
  )
}

export function coerceAdminLocale(value: unknown): AdminLocale {
  return isAdminLocale(value) ? value : DEFAULT_ADMIN_LOCALE
}

// ---------------------------------------------------------------------------
// createTranslator
// ---------------------------------------------------------------------------

/**
 * Build a `t()` function bound to a locale. Reads from the static
 * dictionary registry so construction is O(1); no per-call dict
 * lookups beyond a single object read.
 *
 * Fallback chain: `locale` → `en-US` → key literal. The key-literal
 * fallback makes missing strings visible in the UI during dev.
 */
export function createTranslator(locale: AdminLocale): AdminTranslator {
  const primary: AdminLocaleDict = ADMIN_LOCALE_DICTS[locale]
  const fallback: AdminLocaleDict = ADMIN_LOCALE_DICTS[DEFAULT_ADMIN_LOCALE]
  return function t(
    key: AdminMessageKey,
    vars?: Record<string, string | number>,
  ): string {
    const value = primary[key] ?? fallback[key] ?? key
    return interpolateAdmin(value, vars)
  }
}
