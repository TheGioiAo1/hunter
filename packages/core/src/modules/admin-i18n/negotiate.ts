/**
 * Gbox Platform — Admin Locale Negotiation (Phase 2 Step 2.10)
 *
 * Decides which `AdminLocale` to serve for a given request, based on
 * a three-tier fallback chain:
 *
 *   1. The `gbox_locale` cookie (user's explicit preference)
 *   2. The `Accept-Language` request header (browser preference)
 *   3. The platform default (en-US)
 *
 * The cookie ALWAYS wins — a user who manually picks a language
 * should not be overridden by whatever their browser happens to
 * advertise.
 *
 * Header parsing handles quality values (`en;q=0.9`) and region
 * aliases (`en` → `en-US`, `fr` → `fr-FR`) so a browser that asks
 * for `en` gets a reasonable answer instead of falling through.
 */

import type { AdminLocale } from './types.js'
import { ADMIN_LOCALES, DEFAULT_ADMIN_LOCALE } from './types.js'
import { isAdminLocale } from './translator.js'

/**
 * Cookie name that stores the user's chosen admin locale.
 */
export const ADMIN_LOCALE_COOKIE = 'gbox_locale'

/**
 * Cookie max-age in seconds — one year, same as Shopify admin.
 */
export const ADMIN_LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

/**
 * Pull the admin locale cookie out of a `Cookie` request header
 * string. Returns `null` if the cookie is absent or holds an
 * unsupported value.
 */
export function readLocaleFromCookieHeader(
  cookieHeader: string | undefined,
): AdminLocale | null {
  if (!cookieHeader) return null
  const parts = cookieHeader.split(/;\s*/)
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name === ADMIN_LOCALE_COOKIE) {
      return isAdminLocale(value) ? value : null
    }
  }
  return null
}

/**
 * Build a `Set-Cookie` value that stores the user's locale choice.
 * Caller concatenates this onto their `Set-Cookie` header (or passes
 * it to Express's `res.setHeader`). Mirrors the theme cookie defaults
 * so both toggles behave identically.
 */
export function buildLocaleCookie(locale: AdminLocale): string {
  return [
    `${ADMIN_LOCALE_COOKIE}=${locale}`,
    `Path=/`,
    `Max-Age=${ADMIN_LOCALE_COOKIE_MAX_AGE_SECONDS}`,
    `HttpOnly`,
    `SameSite=Lax`,
  ].join('; ')
}

// ---------------------------------------------------------------------------
// Accept-Language parsing
// ---------------------------------------------------------------------------

interface ParsedLang {
  tag: string
  quality: number
}

/**
 * Parse an `Accept-Language` header into a quality-sorted list of
 * lower-cased language tags. Invalid entries are dropped silently.
 *
 * Example: `"de-DE,de;q=0.9,en-US;q=0.8"` →
 *   [
 *     { tag: 'de-DE', quality: 1   },
 *     { tag: 'de',    quality: 0.9 },
 *     { tag: 'en-US', quality: 0.8 },
 *   ]
 */
export function parseAcceptLanguage(header: string): ParsedLang[] {
  const entries: ParsedLang[] = []
  for (const raw of header.split(',')) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const [tag, ...params] = trimmed.split(';').map(s => s.trim())
    if (!tag) continue
    let quality = 1
    for (const p of params) {
      const m = p.match(/^q=(-?\d*\.?\d+)$/i)
      if (m) {
        const n = Number(m[1])
        if (Number.isFinite(n)) quality = Math.max(0, Math.min(1, n))
      }
    }
    entries.push({ tag, quality })
  }
  entries.sort((a, b) => b.quality - a.quality)
  return entries
}

/**
 * Map a bare language tag to the closest supported admin locale.
 * Rules:
 *   - Exact match wins (`de-DE` → `de-DE`).
 *   - Case-insensitive match (`de-de` → `de-DE`).
 *   - Bare language code maps to the first supported regional variant
 *     in declaration order (`de` → `de-DE`, `en` → `en-US`,
 *     `fr` → `fr-FR`, `es` → `es-ES`).
 *   - No match returns `null` so the caller can try the next entry.
 */
export function resolveLanguageTag(tag: string): AdminLocale | null {
  const lower = tag.toLowerCase()
  for (const locale of ADMIN_LOCALES) {
    if (locale.toLowerCase() === lower) return locale
  }
  // Bare language? Return the first supported regional variant.
  const bare = lower.split('-')[0]
  for (const locale of ADMIN_LOCALES) {
    if (locale.toLowerCase().startsWith(bare + '-')) return locale
  }
  return null
}

/**
 * Walk a parsed Accept-Language list and return the first entry that
 * resolves to a supported admin locale.
 */
export function pickLocaleFromAcceptLanguage(
  header: string | undefined,
): AdminLocale | null {
  if (!header) return null
  const parsed = parseAcceptLanguage(header)
  for (const entry of parsed) {
    const resolved = resolveLanguageTag(entry.tag)
    if (resolved !== null) return resolved
  }
  return null
}

// ---------------------------------------------------------------------------
// Top-level negotiation
// ---------------------------------------------------------------------------

/**
 * Request-shaped input — only the fields we need. Works with Express
 * `req`, Fetch `Request`, and plain objects in tests.
 */
export interface NegotiateInput {
  cookieHeader?: string | undefined
  acceptLanguageHeader?: string | undefined
}

/**
 * Resolve the admin locale for a request. Order of precedence:
 *   1. `gbox_locale` cookie (user's explicit choice)
 *   2. `Accept-Language` header (browser default)
 *   3. `en-US`
 */
export function negotiateAdminLocale(input: NegotiateInput): AdminLocale {
  const fromCookie = readLocaleFromCookieHeader(input.cookieHeader)
  if (fromCookie !== null) return fromCookie
  const fromHeader = pickLocaleFromAcceptLanguage(input.acceptLanguageHeader)
  if (fromHeader !== null) return fromHeader
  return DEFAULT_ADMIN_LOCALE
}

/**
 * Express-friendly shortcut that accepts the `req` object directly.
 * Looks at `req.headers.cookie` and `req.headers['accept-language']`.
 */
export function readLocaleFromRequest(req: {
  headers?: {
    cookie?: string | string[] | undefined
    'accept-language'?: string | string[] | undefined
  }
}): AdminLocale {
  const cookieHeader = Array.isArray(req.headers?.cookie)
    ? req.headers?.cookie.join('; ')
    : req.headers?.cookie
  const acceptLanguageHeader = Array.isArray(req.headers?.['accept-language'])
    ? req.headers?.['accept-language'].join(',')
    : req.headers?.['accept-language']
  return negotiateAdminLocale({
    cookieHeader,
    acceptLanguageHeader,
  })
}
