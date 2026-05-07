/**
 * Phase 7 Step 7.4 — content sanitization.
 *
 * Every chunk of cloned HTML, CSS, or image URL that the pipeline
 * persists to our own DB should pass through one of the three
 * helpers in this module. The runner writes to storefront-rendered
 * tables, so skipping sanitization here = shipping XSS / mixed-
 * content / legacy IE vectors to our merchants' shoppers.
 *
 * Design:
 *   - One tiny surface: three named functions, no classes, no
 *     dependency injection. Call sites don't configure — the
 *     config lives in this file and is locked by the Phase 7 spec.
 *   - HTML sanitization is `sanitize-html` with a locked allowlist
 *     of structural + inline formatting tags and safe attributes.
 *     `<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>` and
 *     every event-handler attr are stripped (they're not on the
 *     allowlist, so sanitize-html drops them).
 *   - CSS sanitization runs BEFORE the file is written to a theme.
 *     We regex-strip `@import url(...)` lines whose host isn't on a
 *     tiny allowlist of known-safe CDNs (fonts.googleapis.com,
 *     cdn.jsdelivr.net, …). We also strip legacy IE `expression(...)`
 *     because some scrapers inadvertently preserve it.
 *   - Image URL validation is a boolean gate for the media-
 *     ingestion stage: we only download images from http(s). Data
 *     URLs, javascript:, file:, and protocol-relative paths are
 *     rejected. Protocol-relative is explicitly rejected because
 *     the crawler should have resolved against a base URL already.
 *
 * Rollback: spec §8 allows a `CLONE_SANITIZE_ENABLED=false` env
 * flag. Hooking that up is deferred to the call-sites commit — the
 * primitives here are always strict. Flipping the flag would make
 * call sites bypass the helper entirely.
 */

import sanitizeHtml from 'sanitize-html'

/**
 * Hosts whose CSS `@import url(...)` directives we allow to
 * survive sanitization. Everything else is deleted. Keep this list
 * short; adding a host here means trusting that host to serve
 * non-malicious CSS forever.
 */
export const ALLOWED_CSS_IMPORT_HOSTS: readonly string[] = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'unpkg.com',
]

/**
 * Locked sanitize-html config. Exported only for the unit test that
 * verifies drift; DO NOT re-export as a mutable options object —
 * call sites must always run through `sanitizeClonedHtml`.
 */
const HTML_CONFIG: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'ul', 'ol', 'li',
    'strong', 'em', 'b', 'i', 'u', 's',
    'a', 'img',
    'blockquote', 'code', 'pre',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'div', 'span',
  ],
  allowedAttributes: {
    a: ['href', 'name', 'target', 'rel', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    '*': ['class', 'id', 'style'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: {
    // Images MUST be http(s) — we rehost them, and we can't
    // download a `data:` URL or a `javascript:` pseudo-scheme.
    img: ['http', 'https'],
  },
  // Default, but pinned here for clarity: unknown tags and their
  // content are discarded.
  disallowedTagsMode: 'discard',
}

/**
 * Sanitize cloned HTML before writing it to our DB. Strips scripts,
 * iframes, event handlers, `javascript:` hrefs, `data:` image srcs
 * — see HTML_CONFIG for the full allowlist. Null/undefined/empty
 * inputs return the empty string so call sites don't need to guard.
 */
export function sanitizeClonedHtml(html: string): string {
  if (!html || typeof html !== 'string') return ''
  return sanitizeHtml(html, HTML_CONFIG)
}

/**
 * Sanitize cloned CSS before writing it to a theme file. The main
 * job is `@import` allowlisting — an attacker who plants
 * `@import url("evil.com/styles.css")` in a source site's CSS
 * would otherwise hijack every page of our clone to pull hostile
 * styles (font substitution, layout disruption, at worst a full
 * phishing overlay).
 *
 * sanitize-html doesn't do CSS — we regex-scan and filter. Two
 * passes:
 *   1. Strip every `@import url(...)` rule whose host isn't on the
 *      `ALLOWED_CSS_IMPORT_HOSTS` list, AND every `@import` with
 *      a non-http(s) URL (data:, javascript:, file:).
 *   2. Strip legacy IE `expression(...)` — a JS-in-CSS vector that
 *      shouldn't exist anywhere modern but sometimes leaks through
 *      old theme archives.
 */
export function sanitizeClonedCss(css: string): string {
  if (!css || typeof css !== 'string') return ''

  let out = css

  // Pass 1: @import with any URL shape. Matches:
  //   @import url("https://x/");
  //   @import url('https://x/');
  //   @import url(https://x/);
  //   @import "https://x/";
  //   @import 'https://x/';
  //   @import url("data:...");
  //
  // We capture the URL substring and decide: allowlist-host =
  // keep, otherwise delete the whole `@import ... ;` rule.
  const IMPORT_RE =
    /@import\s+(?:url\s*\(\s*['"]?([^'")]+)['"]?\s*\)|['"]([^'"]+)['"])\s*;?/gi
  out = out.replace(IMPORT_RE, (match, urlParen, urlQuoted) => {
    const raw = String(urlParen ?? urlQuoted ?? '').trim()
    if (!raw) return ''
    if (isAllowedCssImportUrl(raw)) return match
    return ''
  })

  // Pass 2: legacy IE expression(...). We do NOT try to perfectly
  // parse CSS here — a simple string strip is enough because
  // `expression(` is never legitimate content in a 2020+ stylesheet.
  // Case-insensitive so `EXPRESSION(` doesn't slip through.
  out = out.replace(/expression\s*\([^)]*\)/gi, '')

  return out
}

function isAllowedCssImportUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return ALLOWED_CSS_IMPORT_HOSTS.includes(url.hostname.toLowerCase())
  } catch {
    // Relative paths in @import (e.g., "./theme.css") are a
    // legitimate Shopify pattern. We keep them — they'll resolve
    // against our own theme, not an external CDN.
    // But `data:` and `javascript:` throw here too because they
    // parse as URLs in Node — we caught those in the protocol check
    // above. This catch only fires for true relative paths.
    return !raw.startsWith('data:') && !raw.startsWith('javascript:') && !raw.startsWith('file:')
  }
}

/**
 * Is this an URL we're willing to fetch an image from? The runner
 * calls this before enqueueing a download to S3. Only http(s) are
 * accepted — everything else (data:, javascript:, file:, protocol-
 * relative, bare paths, garbage) is rejected.
 *
 * Caller responsibility: resolve protocol-relative URLs against
 * the page's base URL before handing to this function. If we see
 * `//cdn.com/x.png` here, that's a crawler bug — we don't know
 * the base, so we can't safely complete the URL.
 */
export function isSafeImageUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}
