/**
 * Gbox Platform — Theme Locale loader + schema-translation resolver
 *
 * Decision #1 Step 1.15 — Shopify themes ship two flavors of locale
 * file in `locales/`:
 *
 *   - Storefront strings:   `<locale>.json`             (e.g. `en.json`)
 *   - Schema-only strings:  `<locale>.schema.json`      (e.g. `en.schema.json`)
 *
 * Plus, the **default** locale carries an extra `.default` suffix
 * marker:
 *
 *   - `en.default.json`
 *   - `en.default.schema.json`
 *
 * The marker is metadata, not part of the locale tag. We strip it
 * during parsing and remember which locale was the default so the
 * fallback chain in `I18nService.t()` is seeded correctly.
 *
 * Two key separations:
 *
 *   1. **Storefront vs schema strings.** Storefront keys are reachable
 *      from templates via `{{ 'cart.title' | t }}`. Schema keys are
 *      only consumed by the theme editor (and our `t:` resolver). We
 *      keep them in separate maps so a typo in a schema key never
 *      causes a runtime template lookup to silently succeed.
 *
 *   2. **Theme i18n vs platform i18n.** Per Q3, theme locale files
 *      flow through the SAME `I18nService` interface the rest of the
 *      platform uses (the i18n module from Step 1.2b). We do NOT
 *      build a parallel bundle system. The loader's job is to
 *      `setMany()` the parsed strings into the service under a given
 *      shopId; downstream Liquid filters keep working unchanged.
 *
 * Schema-translation references (`t:foo.bar.baz`):
 *
 *   Section schemas + theme settings schemas can use `"label": "t:foo.bar"`
 *   to defer the human-readable label to the locale file. The
 *   resolver in this file walks an arbitrary value tree, replacing
 *   any string starting with `t:` by looking it up in the schema
 *   locale dict (NOT the storefront one).
 *
 *   We do this at RENDER TIME (per Q4) so the same parsed schema
 *   can produce different drops for `vi` vs `en` visitors without
 *   re-parsing.
 */

import type { I18nService } from '../../../i18n/index.js'
import type { TemplateLoader } from '../loader.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Per-locale flat string dictionary. Keys are dot-separated to
 * match Shopify and the existing i18n service shape.
 *
 *   { "general.cart.title": "Cart" }
 */
export type ThemeLocaleDict = Record<string, string>

/**
 * Two-tier per-locale bundle: storefront strings + schema strings.
 * Both are flat (we flatten nested JSON during parsing).
 */
export interface ThemeLocaleEntry {
  /** Storefront keys, fed into the I18nService for `{{ 'k' | t }}`. */
  storefront: ThemeLocaleDict
  /**
   * Schema keys, used by the `t:` reference resolver in section +
   * theme settings schemas. NEVER fed into I18nService.
   */
  schema: ThemeLocaleDict
}

/**
 * Result of `loadThemeLocales`. The default locale is exposed
 * separately so callers (and the i18n service) can wire it as the
 * shop's default for fallback purposes.
 */
export interface LoadThemeLocalesResult {
  /** Locale tag → bundle. Includes the default locale entry too. */
  byLocale: Record<string, ThemeLocaleEntry>
  /** Locale tag detected from `<locale>.default.json`, or null. */
  defaultLocale: string | null
  /** Non-fatal warnings (parse errors, conflicting defaults, …). */
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Flatten a nested locale JSON tree to dot-separated keys.
 *
 *   { "cart": { "title": "Cart", "subtotal": "Sub" } }
 *
 * becomes
 *
 *   { "cart.title": "Cart", "cart.subtotal": "Sub" }
 *
 * Arrays are coerced to indexed keys (`cart.items.0`) — Shopify
 * doesn't ship arrays in locale files in practice, but we accept
 * them rather than throwing on a forwards-compat case.
 *
 * Non-string leaves are coerced to `String(leaf)` so a locale file
 * with a number doesn't crash the loader.
 */
export function flattenLocaleTree(
  tree: unknown,
  prefix = '',
): ThemeLocaleDict {
  const out: ThemeLocaleDict = {}
  if (tree == null) return out
  if (typeof tree !== 'object') {
    if (prefix) out[prefix] = String(tree)
    return out
  }
  if (Array.isArray(tree)) {
    tree.forEach((v, i) => {
      const key = prefix ? `${prefix}.${i}` : String(i)
      Object.assign(out, flattenLocaleTree(v, key))
    })
    return out
  }
  for (const [k, v] of Object.entries(tree as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v == null) continue
    if (typeof v === 'object') {
      Object.assign(out, flattenLocaleTree(v, key))
    } else {
      out[key] = String(v)
    }
  }
  return out
}

/**
 * Parse the contents of one locale JSON file. Returns a flat dict
 * via `flattenLocaleTree`. Throws on JSON parse error.
 */
export function parseThemeLocaleFile(
  source: string,
  fileName: string,
): ThemeLocaleDict {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`[gbox-engine] ${fileName}: invalid JSON — ${msg}`)
  }
  return flattenLocaleTree(raw)
}

/**
 * Decompose a `locales/...` filename into its parts:
 *
 *   en.default.json        → { locale: 'en', flavor: 'storefront', isDefault: true }
 *   en.default.schema.json → { locale: 'en', flavor: 'schema',     isDefault: true }
 *   vi.json                → { locale: 'vi', flavor: 'storefront', isDefault: false }
 *   vi.schema.json         → { locale: 'vi', flavor: 'schema',     isDefault: false }
 *
 * Returns null when the filename doesn't match the expected shape
 * (so callers can skip it without throwing).
 */
export function parseLocaleFileName(name: string): {
  locale: string
  flavor: 'storefront' | 'schema'
  isDefault: boolean
} | null {
  // Expected structure:
  //   <locale>[.default][.schema].json
  if (!name.endsWith('.json')) return null
  const stem = name.slice(0, -'.json'.length)
  const parts = stem.split('.')
  if (parts.length === 0) return null
  // Walk from the right collecting marker tokens.
  let isSchema = false
  let isDefault = false
  while (parts.length > 1) {
    const last = parts[parts.length - 1]
    if (last === 'schema' && !isSchema) {
      isSchema = true
      parts.pop()
      continue
    }
    if (last === 'default' && !isDefault) {
      isDefault = true
      parts.pop()
      continue
    }
    break
  }
  const locale = parts.join('.')
  if (!locale) return null
  return {
    locale,
    flavor: isSchema ? 'schema' : 'storefront',
    isDefault,
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** Default directory inside the theme tree where locale files live. */
export const THEME_LOCALES_DIR = 'locales/'

/**
 * Load every `locales/<locale>.json` (and `.schema.json`) file out
 * of a `TemplateLoader`. Parse errors are recorded as warnings; the
 * file is skipped but the rest of the directory still loads. We
 * never throw on individual file failures — a broken `vi.json`
 * shouldn't take down the `en` storefront.
 *
 * The default locale marker (`<locale>.default.json`) is detected
 * across the directory. If multiple files claim the marker, the
 * first wins and the rest are recorded as warnings.
 */
export async function loadThemeLocales(
  loader: TemplateLoader,
): Promise<LoadThemeLocalesResult> {
  const warnings: string[] = []
  const byLocale: Record<string, ThemeLocaleEntry> = {}
  let defaultLocale: string | null = null

  const files = await loader.list(THEME_LOCALES_DIR)
  for (const path of files) {
    // path looks like `locales/en.default.json`. Strip the prefix
    // to get the bare filename.
    const name = path.startsWith(THEME_LOCALES_DIR)
      ? path.slice(THEME_LOCALES_DIR.length)
      : path
    if (!name || name.includes('/')) continue // skip nested files
    const meta = parseLocaleFileName(name)
    if (!meta) continue

    const src = await loader.load(path)
    if (src === null) continue
    let dict: ThemeLocaleDict
    try {
      dict = parseThemeLocaleFile(src, path)
    } catch (err) {
      warnings.push(
        err instanceof Error ? err.message : String(err),
      )
      continue
    }

    const entry = (byLocale[meta.locale] ??= {
      storefront: {},
      schema: {},
    })
    if (meta.flavor === 'schema') {
      Object.assign(entry.schema, dict)
    } else {
      Object.assign(entry.storefront, dict)
    }

    if (meta.isDefault) {
      if (defaultLocale === null) {
        defaultLocale = meta.locale
      } else if (defaultLocale !== meta.locale) {
        warnings.push(
          `[gbox-engine] multiple locales claim .default marker (kept "${defaultLocale}", dropped "${meta.locale}")`,
        )
      }
    }
  }

  return { byLocale, defaultLocale, warnings }
}

/**
 * Push every storefront-flavor entry from a `LoadThemeLocalesResult`
 * into an `I18nService`. Used by the storefront router at handler
 * init so the Liquid `t` filter just works.
 *
 * Schema-flavor entries are NOT pushed — they're consumed only by
 * the `t:` reference resolver in this file (`resolveSchemaTranslations`)
 * and never need to live in the i18n service.
 */
export async function applyThemeLocalesToI18n(
  i18n: I18nService,
  shopId: string,
  result: LoadThemeLocalesResult,
): Promise<void> {
  for (const [locale, entry] of Object.entries(result.byLocale)) {
    if (Object.keys(entry.storefront).length === 0) continue
    await i18n.setMany(shopId, locale, entry.storefront)
  }
}

// ---------------------------------------------------------------------------
// Schema-translation resolver
// ---------------------------------------------------------------------------

/**
 * Walk an arbitrary value tree (parsed schema, settings schema,
 * block schema, …), replacing any string of the form `t:foo.bar.baz`
 * with the matching value from `schemaDict`. Other strings, numbers,
 * booleans, nulls, and structural nodes pass through unchanged.
 *
 * The walker creates new objects/arrays for any subtree that
 * actually contained a `t:` reference, so the input is never
 * mutated and unchanged subtrees share references with the input
 * (cheap structural sharing).
 *
 * Missing references fall back to the bare key (e.g. `t:foo.bar` →
 * `foo.bar`) so theme editors can spot the gap immediately. This is
 * the same behaviour the i18n filter uses for missing storefront
 * keys (Shopify standard).
 */
export function resolveSchemaTranslations<T>(
  value: T,
  schemaDict: ThemeLocaleDict,
): T {
  return walkValue(value, schemaDict) as T
}

/** Internal recursive walker. */
function walkValue(value: unknown, dict: ThemeLocaleDict): unknown {
  if (typeof value === 'string') {
    return resolveOneRef(value, dict)
  }
  if (Array.isArray(value)) {
    let changed = false
    const out: unknown[] = new Array(value.length)
    for (let i = 0; i < value.length; i++) {
      const next = walkValue(value[i], dict)
      out[i] = next
      if (next !== value[i]) changed = true
    }
    return changed ? out : value
  }
  if (value && typeof value === 'object') {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const next = walkValue(v, dict)
      out[k] = next
      if (next !== v) changed = true
    }
    return changed ? out : value
  }
  return value
}

/**
 * Resolve a single string. If it doesn't start with `t:` it's
 * returned unchanged. The `t:` prefix is the Shopify convention —
 * we don't accept any other prefixes.
 */
function resolveOneRef(raw: string, dict: ThemeLocaleDict): string {
  if (!raw.startsWith('t:')) return raw
  const key = raw.slice(2)
  if (key in dict) return dict[key]
  // Missing reference — return the bare key. Matches Shopify behaviour
  // and makes broken refs visible in the editor.
  return key
}
