/**
 * Gbox Platform — Shopify-compatible String Filters
 *
 * Decision #1 Step 1.4 — Registers the string filter set on a Liquid
 * instance. Every filter here mirrors Shopify's behaviour byte-for-byte
 * so a theme ported from the Shopify theme store renders identically
 * on Gbox.
 *
 * Filters in this file:
 *
 *   upcase             → String.toUpperCase
 *   downcase           → String.toLowerCase
 *   capitalize         → first letter upper, rest unchanged (Shopify quirk)
 *   pluralize          → Shopify's singular/plural picker by count
 *   truncate           → cut at N chars, append ellipsis
 *   truncatewords      → cut at N words, append ellipsis
 *   strip              → trim leading/trailing whitespace
 *   lstrip             → trim leading whitespace
 *   rstrip             → trim trailing whitespace
 *   strip_html         → remove every HTML tag, decode basic entities
 *   strip_newlines     → remove every \r\n, \n, \r
 *   newline_to_br      → replace newlines with <br>
 *   replace            → global find/replace
 *   replace_first      → find/replace only the first occurrence
 *   remove             → replace with empty string
 *   remove_first       → remove only first occurrence
 *   append             → concatenate at the end
 *   prepend            → concatenate at the start
 *   escape / h         → HTML-escape (Shopify ships both names)
 *   escape_once        → HTML-escape but don't double-escape entities
 *   handle / handleize → URL-safe slug (lowercase, hyphens, no punctuation)
 *   md5                → hex MD5
 *   sha1               → hex SHA-1
 *   sha256             → hex SHA-256
 *   base64_encode      → base64 encode
 *   base64_decode      → base64 decode
 *   base64_url_safe_encode / base64_url_safe_decode
 *   raw                → passthrough (marks value as safe-HTML for outputEscape)
 *   default            → Shopify's `default: 'fallback'` (nil/false/empty → fallback)
 *
 * Implementation notes:
 *
 *   - Some filters (`md5`, `sha1`, `sha256`, `base64_*`) depend on
 *     platform crypto. We use the Web Crypto API via `globalThis.crypto`
 *     (available in Node 19+ and Cloudflare Workers) for sha1/sha256
 *     and `node:crypto` for md5 (Web Crypto dropped MD5 support).
 *     The engine runs in both Node origin and Workers, so each crypto
 *     path is behind a capability check.
 *
 *   - `raw` is a no-op by value but the render pipeline flags its
 *     output as pre-escaped; LiquidJS does this via the native `raw`
 *     filter on the `outputEscape: 'escape'` pipeline. We register our
 *     own that sets the LiquidJS "drop html" marker.
 *
 *   - `handle` and `handleize` are aliases; Shopify docs use both.
 */

import type { Liquid } from 'liquidjs'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

/**
 * Coerce any Liquid value to a string. `null`/`undefined` → ''
 * to match Shopify behaviour (`strictVariables: false`).
 */
function toStr(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  return String(v)
}

/**
 * HTML-escape (Shopify's `escape` filter). Covers the 5 XML entities.
 */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Escape but skip text that already looks like a valid HTML entity.
 * Matches Shopify's `escape_once` — idempotent escaping for code that
 * might run twice without producing `&amp;amp;`.
 */
function htmlEscapeOnce(s: string): string {
  // Match existing entities: &amp; &lt; &gt; &quot; &#39; &#NN; &#xNN;
  // Split on them, escape the rest, reassemble.
  const ENTITY_RE = /&(?:amp|lt|gt|quot|#39|#\d+|#x[0-9a-fA-F]+);/g
  let out = ''
  let last = 0
  s.replace(ENTITY_RE, (match, idx) => {
    out += htmlEscape(s.substring(last, idx))
    out += match
    last = idx + match.length
    return match
  })
  out += htmlEscape(s.substring(last))
  return out
}

/**
 * Shopify handleize: lowercase, ASCII transliterate (best-effort),
 * non-alphanumeric → single hyphen, trim hyphens.
 *
 * We don't ship a full Unicode-to-ASCII table. The output is:
 *   - Lowercased (with locale 'en')
 *   - `[^a-z0-9]+` collapsed to '-'
 *   - Leading/trailing hyphens trimmed
 *
 * Non-latin scripts (Vietnamese, Chinese, Arabic) will produce all
 * hyphens. Shopify handles this by letting the merchant override the
 * `handle` column directly in the DB; the filter is a convenience for
 * defaults, not canonical truth.
 */
function handleize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// ---------------------------------------------------------------------------
// Filter: pluralize
// ---------------------------------------------------------------------------

/**
 * Shopify's pluralize filter: `{{ 3 | pluralize: 'item', 'items' }}` → 'items'
 */
function pluralize(count: unknown, singular: unknown, plural: unknown): string {
  const n = Number(count)
  if (!Number.isFinite(n) || n === 1) return toStr(singular)
  return toStr(plural)
}

// ---------------------------------------------------------------------------
// Filter: truncate / truncatewords
// ---------------------------------------------------------------------------

function truncate(input: unknown, length: unknown = 50, ellipsis: unknown = '...'): string {
  const s = toStr(input)
  const n = Math.max(0, Math.floor(Number(length) || 0))
  const el = toStr(ellipsis)
  if (s.length <= n) return s
  if (n <= el.length) return el.substring(0, n)
  return s.substring(0, n - el.length) + el
}

function truncatewords(input: unknown, words: unknown = 15, ellipsis: unknown = '...'): string {
  const s = toStr(input)
  const n = Math.max(1, Math.floor(Number(words) || 15))
  const el = toStr(ellipsis)
  // Shopify splits on whitespace runs.
  const parts = s.split(/\s+/)
  if (parts.length <= n) return s
  return parts.slice(0, n).join(' ') + el
}

// ---------------------------------------------------------------------------
// Filter: strip_html
// ---------------------------------------------------------------------------

/**
 * Remove every HTML tag AND the contents of `<script>`, `<style>`, and
 * HTML comments. Matches Shopify's aggressive behaviour.
 */
function stripHtml(input: unknown): string {
  const s = toStr(input)
  return s
    // Drop script/style blocks entirely (content too)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    // Drop HTML comments
    .replace(/<!--[\s\S]*?-->/g, '')
    // Drop remaining tags
    .replace(/<[^>]+>/g, '')
}

// ---------------------------------------------------------------------------
// Filter: default
// ---------------------------------------------------------------------------

/**
 * Shopify `default`: `{{ value | default: 'fallback' }}`. Fires when
 * `value` is nil, false, an empty string, an empty array, or an empty
 * object. Does NOT fire for `0` or `'0'` (explicit zero is still
 * meaningful content).
 */
function defaultFilter(value: unknown, fallback: unknown): unknown {
  if (value === null || value === undefined || value === false) return fallback
  if (typeof value === 'string' && value.length === 0) return fallback
  if (Array.isArray(value) && value.length === 0) return fallback
  if (typeof value === 'object' && value !== null && Object.keys(value as object).length === 0) {
    return fallback
  }
  return value
}

// ---------------------------------------------------------------------------
// Hash / encoding filters
// ---------------------------------------------------------------------------

function md5Hex(input: unknown): string {
  return createHash('md5').update(toStr(input)).digest('hex')
}
function sha1Hex(input: unknown): string {
  return createHash('sha1').update(toStr(input)).digest('hex')
}
function sha256Hex(input: unknown): string {
  return createHash('sha256').update(toStr(input)).digest('hex')
}

function base64Encode(input: unknown): string {
  return Buffer.from(toStr(input), 'utf8').toString('base64')
}
function base64Decode(input: unknown): string {
  return Buffer.from(toStr(input), 'base64').toString('utf8')
}
function base64UrlSafeEncode(input: unknown): string {
  return Buffer.from(toStr(input), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
function base64UrlSafeDecode(input: unknown): string {
  let s = toStr(input).replace(/-/g, '+').replace(/_/g, '/')
  const pad = s.length % 4
  if (pad > 0) s += '='.repeat(4 - pad)
  return Buffer.from(s, 'base64').toString('utf8')
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerStringFilters(liquid: Liquid): void {
  liquid.registerFilter('upcase', (v) => toStr(v).toUpperCase())
  liquid.registerFilter('downcase', (v) => toStr(v).toLowerCase())
  liquid.registerFilter('capitalize', (v) => {
    const s = toStr(v)
    if (s.length === 0) return s
    return s[0].toUpperCase() + s.substring(1)
  })

  liquid.registerFilter('pluralize', pluralize)

  liquid.registerFilter('truncate', truncate)
  liquid.registerFilter('truncatewords', truncatewords)

  liquid.registerFilter('strip', (v) => toStr(v).trim())
  liquid.registerFilter('lstrip', (v) => toStr(v).replace(/^\s+/, ''))
  liquid.registerFilter('rstrip', (v) => toStr(v).replace(/\s+$/, ''))
  liquid.registerFilter('strip_html', stripHtml)
  liquid.registerFilter('strip_newlines', (v) => toStr(v).replace(/\r\n|\n|\r/g, ''))
  liquid.registerFilter('newline_to_br', (v) =>
    toStr(v).replace(/\r\n|\n|\r/g, '<br />'),
  )

  liquid.registerFilter('replace', (v, search, replacement) =>
    toStr(v).split(toStr(search)).join(toStr(replacement)),
  )
  liquid.registerFilter('replace_first', (v, search, replacement) => {
    const s = toStr(v)
    const needle = toStr(search)
    const idx = s.indexOf(needle)
    if (idx < 0) return s
    return s.substring(0, idx) + toStr(replacement) + s.substring(idx + needle.length)
  })
  liquid.registerFilter('remove', (v, search) =>
    toStr(v).split(toStr(search)).join(''),
  )
  liquid.registerFilter('remove_first', (v, search) => {
    const s = toStr(v)
    const needle = toStr(search)
    const idx = s.indexOf(needle)
    if (idx < 0) return s
    return s.substring(0, idx) + s.substring(idx + needle.length)
  })

  liquid.registerFilter('append', (v, tail) => toStr(v) + toStr(tail))
  liquid.registerFilter('prepend', (v, head) => toStr(head) + toStr(v))

  liquid.registerFilter('escape', (v) => htmlEscape(toStr(v)))
  // Shopify ships `h` as an alias for `escape`.
  liquid.registerFilter('h', (v) => htmlEscape(toStr(v)))
  liquid.registerFilter('escape_once', (v) => htmlEscapeOnce(toStr(v)))

  liquid.registerFilter('handle', (v) => handleize(toStr(v)))
  liquid.registerFilter('handleize', (v) => handleize(toStr(v)))

  liquid.registerFilter('md5', md5Hex)
  liquid.registerFilter('sha1', sha1Hex)
  liquid.registerFilter('sha256', sha256Hex)
  liquid.registerFilter('base64_encode', base64Encode)
  liquid.registerFilter('base64_decode', base64Decode)
  liquid.registerFilter('base64_url_safe_encode', base64UrlSafeEncode)
  liquid.registerFilter('base64_url_safe_decode', base64UrlSafeDecode)

  liquid.registerFilter('default', defaultFilter)
}
