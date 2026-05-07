/**
 * Gbox Platform — Email tracking (Phase 14 PR4)
 *
 * Open-pixel + click-redirect plumbing for the email system. Pure
 * functions only — no DB, no Express, no side effects. The routes that
 * consume this module (apps/storefront/src/routes/email-tracking.ts)
 * and the send pipeline (packages/core/src/modules/email/send.ts)
 * handle I/O; this module is the crypto + HTML-manipulation logic.
 *
 * DESIGN
 * ------
 *
 * Tokens are HMAC-SHA256(EMAIL_TRACKING_SECRET, delivery_id) truncated
 * to 32 hex chars (128 bits). Deterministic: same delivery → same
 * token. Not a secret — its job is to prove "this URL was minted by
 * us" (tamper resistance), not to hide the delivery ID.
 *
 * Why deterministic:
 *   - Recipient clicks a link 6 months after the send. We don't want
 *     to store a random token per delivery + join on it; HMAC lets us
 *     verify the token on the fly given the claimed delivery_id.
 *   - Actually the route doesn't get a delivery_id — it gets a token.
 *     So we store the token on the delivery row (migration 086,
 *     UNIQUE partial index) and look up the row by token. HMAC gives
 *     us a collision-resistant opaque identifier that doubles as an
 *     integrity check: if someone crafts a token that happens to
 *     match a row in the DB, they had to brute-force the HMAC.
 *
 * Why not a random UUID:
 *   - UUIDs leak no info, which is fine, but they need to be persisted
 *     somewhere. HMAC is one-way, so we get persistence-free signing
 *     while keeping the "nobody can forge a valid token" property.
 *     (Same trade-off PR1 made for unsubscribe tokens — see
 *     preferences.ts::generateUnsubscribeToken.)
 *
 * IRON RULE 5
 * -----------
 * Nothing in this module mentions god_admin. The URLs it produces
 * begin with `/email/track/` — no /god-admin/ substring. Errors are
 * never surfaced to the recipient; the route callers swallow failures
 * and return the pixel / redirect to `/`.
 */

import crypto from 'node:crypto'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * 32-hex-char token = 16 bytes = 128 bits. Plenty for a non-secret
 * integrity-signed identifier. Full SHA-256 hex (64 chars) would work
 * but bloats every link by 32 chars for zero security benefit.
 */
const TOKEN_HEX_LENGTH = 32

/**
 * 43-byte transparent 1×1 GIF (GIF89a). Industry standard pixel —
 * Mailchimp, Shopify, SendGrid all use GIFs at this exact size. PNGs
 * are ~68 bytes; JPEGs can't represent transparency.
 *
 * Hand-crafted byte sequence (not base64 because we serve it as the
 * response body directly; a Buffer is the cheapest representation).
 */
export const TRANSPARENT_GIF_PIXEL: Buffer = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // 'GIF89a' magic
  0x01, 0x00, 0x01, 0x00,             // 1×1 logical screen
  0x80, 0x00, 0x00,                   // global color table flag + bg color idx
  0x00, 0x00, 0x00,                   // RGB[0] = black
  0xff, 0xff, 0xff,                   // RGB[1] = white
  0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, // graphic control ext (transparent)
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // image descriptor
  0x02, 0x02, 0x44, 0x01, 0x00,       // LZW compressed pixel
  0x3b,                                // trailer
])

// ---------------------------------------------------------------------------
// Token sign / verify
// ---------------------------------------------------------------------------

/**
 * Return the HMAC secret from env, falling back to a loud insecure
 * default that still works in dev. Production MUST set this — the
 * ops runbook (docs/ops/release-checklist.md) lists it as required.
 */
function getSecret(): string {
  const env = process.env.EMAIL_TRACKING_SECRET
  if (env && env.trim().length >= 16) return env.trim()
  // Dev / CI fallback — intentionally ugly so no one copies it to prod.
  return 'gbox-dev-insecure-DO-NOT-USE-IN-PROD'
}

/**
 * Mint a deterministic token for a delivery. Two calls with the same
 * delivery_id return the same string — intentional, so we can store
 * it on `email_deliveries.tracking_token` once and keep verifying on
 * every hit without storing random nonces.
 *
 * Why String(deliveryId): delivery_id is a BIGINT in the DB; Node
 * returns it as a number (or BigInt for very large IDs). Coercing to
 * string normalises both cases.
 */
export function generateTrackingToken(deliveryId: number | bigint | string): string {
  const input = String(deliveryId)
  const mac = crypto.createHmac('sha256', getSecret()).update(input).digest('hex')
  return mac.slice(0, TOKEN_HEX_LENGTH)
}

/**
 * Constant-time verify a (token, deliveryId) pair. Used by the
 * tracking routes as a belt-and-braces check: we already look up the
 * delivery by token (via the partial UNIQUE index), so a matching
 * row implies the token is valid. But if we ever flip the lookup
 * direction (e.g. "verify before DB hit"), this is the primitive.
 *
 * Returns true iff the token was minted by us for that deliveryId.
 * Timing-safe comparison defeats length-extension / oracle attacks.
 */
export function verifyTrackingToken(
  token: string,
  deliveryId: number | bigint | string,
): boolean {
  if (typeof token !== 'string') return false
  if (token.length !== TOKEN_HEX_LENGTH) return false
  if (!/^[0-9a-f]+$/.test(token)) return false

  const expected = generateTrackingToken(deliveryId)

  // timingSafeEqual requires equal-length buffers. We already checked
  // length above, but guard defensively.
  const a = Buffer.from(token, 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

/**
 * Build the absolute pixel URL used in HTML emails. `baseUrl` should
 * be the public origin of the tracking route (typically the storefront
 * host for dev, a dedicated tracking domain for prod). No trailing
 * slash required; we normalise.
 *
 * Example:
 *   buildPixelUrl('https://gbox.co', 'abc123...')
 *     → 'https://gbox.co/email/track/open/abc123....gif'
 */
export function buildPixelUrl(baseUrl: string, token: string): string {
  const origin = stripTrailingSlash(baseUrl)
  return `${origin}/email/track/open/${encodeURIComponent(token)}.gif`
}

/**
 * Build the absolute click-redirect URL that wraps a target link. The
 * target is base64url-encoded in the `u` query param — URL-safe and
 * preserves all characters (including '#' fragments and '?' queries)
 * without requiring multi-level URL encoding.
 *
 * Base64url (RFC 4648 §5): standard base64 with `+` → `-`, `/` → `_`,
 * no padding `=`. Safe to drop into a URL query param without %
 * encoding.
 *
 * Example:
 *   buildClickUrl('https://gbox.co', 'abc123', 'https://shop.com/products/hat')
 *     → 'https://gbox.co/email/track/click/abc123?u=aHR0cHM6Ly9zaG9wLmNvbS9wcm9kdWN0cy9oYXQ'
 */
export function buildClickUrl(baseUrl: string, token: string, target: string): string {
  const origin = stripTrailingSlash(baseUrl)
  const encoded = base64UrlEncode(target)
  return `${origin}/email/track/click/${encodeURIComponent(token)}?u=${encoded}`
}

/**
 * Decode the `u` param from a click-redirect URL back to the original
 * target. Returns null if the input is malformed. Routes should fall
 * back to `/` (storefront home) on null — never surface an error page
 * to the recipient.
 */
export function decodeClickTarget(encoded: string): string | null {
  try {
    const decoded = base64UrlDecode(encoded)
    // Sanity: reject non-http(s) schemes to stop javascript: / data: /
    // file: / chrome-extension: injections. No open-redirect to any
    // internal protocol.
    if (!/^https?:\/\//i.test(decoded)) return null
    // Reject control characters and newlines in the URL.
    if (/[\x00-\x1f\x7f]/.test(decoded)) return null
    // Reject obviously-malformed URLs.
    try {
      const u = new URL(decoded)
      if (!u.hostname) return null
    } catch {
      return null
    }
    return decoded
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// HTML manipulation — pixel injection + link rewriting
// ---------------------------------------------------------------------------

/**
 * Inject a 1×1 tracking pixel at the end of the HTML body. Idempotent
 * — if the HTML already contains a pixel URL with this token, we
 * return the input unchanged (defence against double-injection when
 * the same HTML is piped through the renderer twice).
 *
 * Strategy:
 *   1. If `</body>` exists → insert pixel just before it.
 *   2. Else if `</html>` exists → insert just before it.
 *   3. Else → append to end. Renderers can emit fragment HTML; we
 *      don't want to drop the pixel just because the document isn't
 *      well-formed.
 *
 * The pixel is styled with `display:block;width:1px;height:1px`
 * inline so email clients don't expand the image (some render 1×1
 * transparent GIFs as much larger "broken image" placeholders when
 * disabled).
 */
export function injectPixel(html: string, pixelUrl: string): string {
  if (html.includes(pixelUrl)) return html

  const pixelTag =
    `<img src="${escapeAttr(pixelUrl)}" width="1" height="1" alt="" ` +
    `style="display:block;width:1px;height:1px;border:0;outline:0;" />`

  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${pixelTag}</body>`)
  }
  if (/<\/html\s*>/i.test(html)) {
    return html.replace(/<\/html\s*>/i, `${pixelTag}</html>`)
  }
  return html + pixelTag
}

/**
 * Rewrite every `<a href="http(s)://…">` in the HTML to go through the
 * click-tracking redirect. Non-http(s) hrefs (mailto:, tel:, anchors,
 * javascript:) are left alone.
 *
 * Design:
 *   - Only rewrite absolute http(s) URLs. Relative paths in email HTML
 *     are broken anyway (no base URL in inbox); if we see one we leave
 *     it for the recipient's client to choke on.
 *   - Rewrite wraps the URL in our redirect — idempotent check: if the
 *     href already starts with `baseUrl + '/email/track/click/'` we
 *     skip. Useful when a caller accidentally runs the rewriter twice.
 *   - We explicitly skip the pixel URL itself — the pixel is injected
 *     after rewriting, but in test setups the HTML may already have
 *     the pixel and we don't want to rewrite it into a redirect of a
 *     pixel of a…
 *   - We preserve the `<a>` tag's other attributes verbatim. A regex
 *     doesn't do full HTML parsing but the email HTML we generate
 *     comes from trusted templates, not user input — regex is safe
 *     here. (For user-submitted HTML we'd pull in a parser.)
 *
 * Returns the rewritten HTML. Count of rewrites is available via
 * `rewriteHtmlLinksWithCount` for the smoke assertions.
 */
export function rewriteHtmlLinks(
  html: string,
  token: string,
  baseUrl: string,
): string {
  return rewriteHtmlLinksWithCount(html, token, baseUrl).html
}

/** Same as rewriteHtmlLinks but returns { html, count } for tests. */
export function rewriteHtmlLinksWithCount(
  html: string,
  token: string,
  baseUrl: string,
): { html: string; count: number } {
  const origin = stripTrailingSlash(baseUrl)
  const clickPrefix = `${origin}/email/track/click/`
  const pixelPrefix = `${origin}/email/track/open/`

  let count = 0
  // Match href="..." or href='...' — NOT href=foo (unquoted, rare and
  // our templates never emit that). Capture group 1 = opening quote,
  // group 2 = URL content, group 3 = closing quote.
  const HREF_REGEX = /href\s*=\s*(["'])((?:(?!\1).)*)\1/gi

  const rewritten = html.replace(HREF_REGEX, (match, quote, url: string) => {
    // Only http / https absolute URLs.
    if (!/^https?:\/\//i.test(url)) return match
    // Already a click-redirect (idempotency).
    if (url.startsWith(clickPrefix)) return match
    // Pixel URL — never rewrite that.
    if (url.startsWith(pixelPrefix)) return match

    count++
    const wrapped = buildClickUrl(baseUrl, token, url)
    return `href=${quote}${wrapped}${quote}`
  })

  return { html: rewritten, count }
}

// ---------------------------------------------------------------------------
// Helpers — kept local because they're 3 lines each
// ---------------------------------------------------------------------------

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** RFC 4648 §5 base64url encoding (no padding). */
export function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

/** RFC 4648 §5 base64url decoding. Throws on malformed input. */
export function base64UrlDecode(input: string): string {
  // Re-pad to a multiple of 4 for Node's base64 decoder.
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4)
  const b64 = padded.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64').toString('utf8')
}

// ---------------------------------------------------------------------------
// Runtime helpers for the send pipeline + routes
// ---------------------------------------------------------------------------

/**
 * Resolve the public base URL for tracking links. Prefers explicit
 * `EMAIL_TRACKING_BASE_URL`, falls back to `STOREFRONT_BASE_URL`,
 * then finally `http://localhost:4322` for dev.
 *
 * Sharing one env var (STOREFRONT_BASE_URL) with the storefront
 * module is intentional — tracking routes live under the storefront
 * in PR4 per scope doc §3. A future PR can split tracking onto a
 * dedicated domain by flipping EMAIL_TRACKING_BASE_URL.
 */
export function resolveTrackingBaseUrl(): string {
  const explicit = process.env.EMAIL_TRACKING_BASE_URL
  if (explicit && /^https?:\/\//i.test(explicit)) return stripTrailingSlash(explicit)
  const storefront = process.env.STOREFRONT_BASE_URL
  if (storefront && /^https?:\/\//i.test(storefront)) return stripTrailingSlash(storefront)
  return 'http://localhost:4322'
}

/**
 * Feature kill-switch. Default: ON. Set EMAIL_TRACKING_ENABLED=0
 * (or 'false') to disable pixel injection + link rewriting without
 * touching the schema. Existing tracked emails in inboxes continue to
 * work (the routes stay live); just no new tracking.
 */
export function isTrackingEnabled(): boolean {
  const raw = process.env.EMAIL_TRACKING_ENABLED
  if (raw == null) return true
  const v = raw.trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'no' && v !== 'off'
}

/**
 * Categories whose rendered HTML gets the full pixel + link-rewrite
 * treatment. Transactional (`password_reset`, `order_confirmation`,
 * etc.) is excluded by design — see scope doc §3b for the reasoning.
 */
const TRACKED_CATEGORIES = new Set<string>(['marketing', 'lifecycle', 'reviews'])

export function isTrackedCategory(category: string | null | undefined): boolean {
  if (!category) return false
  return TRACKED_CATEGORIES.has(category)
}
