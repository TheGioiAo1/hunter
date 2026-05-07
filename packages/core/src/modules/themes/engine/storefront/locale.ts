/**
 * Gbox Platform — Storefront Locale Negotiation
 *
 * Decision #1 Step 1.14 — Pure helpers that pick the active locale
 * for a storefront request. Three sources, in priority order:
 *
 *   1. URL prefix (`/vi/products/foo` → locale = `vi`).
 *      Highest priority because it's the explicit choice of the
 *      visitor / search engine. Shopify behaves the same way.
 *
 *   2. `Accept-Language` HTTP header. We parse the q-weighted list
 *      and take the first locale that matches a supported one.
 *      A naive prefix match (`en-US` → `en`) is enough for v1.
 *
 *   3. Shop default locale from `LocaleConfig.default`. Always a
 *      member of `supported` (we validate this on construction).
 *
 * Why a separate file? The router calls this on every request and
 * we want it pure + tested in isolation. The result type bundles
 * `strippedPath` so the router never has to re-do prefix logic.
 */

/**
 * Locale configuration for a storefront. `supported` is the list of
 * locales the shop has enabled (BCP-47 tags lower-cased: `en`, `vi`,
 * `en-gb`, …). `default` is the fallback for visitors with no
 * preference; it MUST appear in `supported`.
 */
export interface LocaleConfig {
  supported: string[]
  default: string
}

/**
 * Result of `negotiateLocale`. `strippedPath` is the request path
 * with the locale prefix removed (or unchanged when no prefix was
 * present); the router matches its route table against this value.
 */
export interface LocaleNegotiation {
  locale: string
  strippedPath: string
}

/** Default locale config: english only. Suitable for tests + smoke. */
export const DEFAULT_LOCALE_CONFIG: LocaleConfig = {
  supported: ['en'],
  default: 'en',
}

/**
 * Strip a leading `/locale/...` prefix from `path` when the first
 * segment matches one of the supported locales (case-insensitive).
 *
 * Returns `null` when no prefix matches — the caller falls back to
 * Accept-Language / default.
 *
 * Edge cases handled:
 *   - `/vi`        → `{ locale: 'vi', strippedPath: '/' }`
 *   - `/vi/`       → `{ locale: 'vi', strippedPath: '/' }`
 *   - `/vi/foo`    → `{ locale: 'vi', strippedPath: '/foo' }`
 *   - `/violet`    → `null` (segment is not exactly `vi`)
 *   - `/EN/foo`    → `{ locale: 'en', strippedPath: '/foo' }`
 */
export function stripLocalePrefix(
  path: string,
  config: LocaleConfig,
): LocaleNegotiation | null {
  if (!path.startsWith('/')) return null
  // Slice the first segment after the leading slash.
  const slashIdx = path.indexOf('/', 1)
  const firstSeg =
    slashIdx === -1 ? path.slice(1) : path.slice(1, slashIdx)
  if (!firstSeg) return null
  const lower = firstSeg.toLowerCase()
  const match = config.supported.find((s) => s.toLowerCase() === lower)
  if (!match) return null
  // The remainder of the path. Empty when path was `/vi`.
  const rest = slashIdx === -1 ? '' : path.slice(slashIdx)
  return {
    locale: match,
    strippedPath: rest === '' ? '/' : rest,
  }
}

/**
 * Parse an `Accept-Language` header value into an ordered list of
 * locale tags, sorted by quality. Returns lowercased tags.
 *
 * Example: `en-US,en;q=0.9,vi;q=0.8` → `['en-us', 'en', 'vi']`.
 *
 * Malformed entries (missing tag, NaN q) are dropped silently —
 * Accept-Language parsing is best-effort and we'd rather serve the
 * default locale than 500 on a quirky header.
 */
export function parseAcceptLanguage(header: string): string[] {
  if (!header) return []
  const parts = header.split(',')
  const ranked: Array<{ tag: string; q: number; idx: number }> = []
  parts.forEach((raw, idx) => {
    const trimmed = raw.trim()
    if (!trimmed) return
    const [tagPart, ...params] = trimmed.split(';')
    const tag = tagPart.trim().toLowerCase()
    if (!tag || tag === '*') return
    let q = 1
    for (const param of params) {
      const eq = param.indexOf('=')
      if (eq === -1) continue
      const key = param.slice(0, eq).trim().toLowerCase()
      if (key !== 'q') continue
      const num = Number.parseFloat(param.slice(eq + 1).trim())
      if (Number.isFinite(num)) q = num
    }
    ranked.push({ tag, q, idx })
  })
  // Sort by q descending, stable on original index.
  ranked.sort((a, b) => (b.q - a.q) || (a.idx - b.idx))
  return ranked.map((r) => r.tag)
}

/**
 * Pick the best supported locale from a parsed Accept-Language list.
 *
 * Per-tag priority: for each parsed tag (already ranked by quality),
 * try an exact supported match first; if that fails, try a
 * base-language match (`en-us` → `en`); only then move on to the
 * next tag. This preserves the visitor's stated preference order
 * — a higher-q `fr-CA` should beat a lower-q `en`, even though `fr`
 * isn't an exact match.
 *
 * Returns `null` when no tag (exact or base-language) matches.
 */
export function pickFromAcceptLanguage(
  parsed: string[],
  config: LocaleConfig,
): string | null {
  const supportedLower = config.supported.map((s) => s.toLowerCase())
  for (const tag of parsed) {
    // Exact match first.
    const exact = supportedLower.indexOf(tag)
    if (exact !== -1) return config.supported[exact]
    // Then base-language fallback (`fr-ca` → `fr`).
    const dash = tag.indexOf('-')
    if (dash === -1) continue
    const base = tag.slice(0, dash)
    const baseIdx = supportedLower.indexOf(base)
    if (baseIdx !== -1) return config.supported[baseIdx]
  }
  return null
}

/**
 * Top-level negotiation. Walks the three sources in priority order
 * and ALWAYS returns a result — there is no failure mode, just a
 * cascade ending at `config.default`.
 */
export function negotiateLocale(
  path: string,
  acceptLanguage: string | undefined,
  config: LocaleConfig,
): LocaleNegotiation {
  // 1. URL prefix wins.
  const fromPrefix = stripLocalePrefix(path, config)
  if (fromPrefix) return fromPrefix

  // 2. Accept-Language header.
  if (acceptLanguage) {
    const parsed = parseAcceptLanguage(acceptLanguage)
    const picked = pickFromAcceptLanguage(parsed, config)
    if (picked) {
      return { locale: picked, strippedPath: path }
    }
  }

  // 3. Shop default.
  return { locale: config.default, strippedPath: path }
}
