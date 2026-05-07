/**
 * Unit tests for the tracking module (Phase 14 PR4).
 *
 * This module is 100% pure — no DB, no network, no Express — so we can
 * cover every invariant with fast in-process assertions. The routes
 * (apps/storefront/src/routes/email-tracking.ts, PR4 commit 5) and the
 * send integration (send.ts, PR4 commit 4) depend on every guarantee
 * exercised below; treat the tests as the contract documentation.
 *
 * Coverage map:
 *   §1 generateTrackingToken — determinism, secret-sensitive, length
 *   §2 verifyTrackingToken   — round-trip, rejects tamper, constant-time safe
 *   §3 URL builders          — shape, encoding, slash-normalisation
 *   §4 decodeClickTarget     — rejects javascript:/data:/malformed
 *   §5 injectPixel           — body/html/fragment placement + idempotency
 *   §6 rewriteHtmlLinks      — only http(s), idempotent, preserves attrs
 *   §7 base64url codec       — RFC 4648 §5 round-trip incl. unicode
 *   §8 TRANSPARENT_GIF_PIXEL — 43 bytes, starts with 'GIF89a'
 *   §9 env helpers           — resolveTrackingBaseUrl + isTrackingEnabled
 *  §10 isTrackedCategory     — whitelist matches PR4 scope doc §3b
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  generateTrackingToken,
  verifyTrackingToken,
  buildPixelUrl,
  buildClickUrl,
  decodeClickTarget,
  injectPixel,
  rewriteHtmlLinks,
  rewriteHtmlLinksWithCount,
  base64UrlEncode,
  base64UrlDecode,
  TRANSPARENT_GIF_PIXEL,
  resolveTrackingBaseUrl,
  isTrackingEnabled,
  isTrackedCategory,
} from './tracking.js'

// ---------------------------------------------------------------------------
// Env capture/restore
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'EMAIL_TRACKING_SECRET',
  'EMAIL_TRACKING_BASE_URL',
  'EMAIL_TRACKING_ENABLED',
  'STOREFRONT_BASE_URL',
]
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = {}
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  for (const k of ENV_KEYS) delete process.env[k]
  // Pin a deterministic secret for token tests — without it we'd use
  // the loud dev fallback which is still deterministic but noisy.
  process.env.EMAIL_TRACKING_SECRET = 'test-secret-at-least-16-chars-long'
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

// ---------------------------------------------------------------------------
// §1 generateTrackingToken
// ---------------------------------------------------------------------------

describe('generateTrackingToken', () => {
  it('is deterministic — same delivery → same token', () => {
    const a = generateTrackingToken(12345)
    const b = generateTrackingToken(12345)
    expect(a).toBe(b)
  })

  it('returns a 32-hex-char string', () => {
    const t = generateTrackingToken(42)
    expect(t).toMatch(/^[0-9a-f]{32}$/)
  })

  it('changes when the secret changes', () => {
    const before = generateTrackingToken(42)
    process.env.EMAIL_TRACKING_SECRET = 'different-secret-16-chars-min'
    const after = generateTrackingToken(42)
    expect(after).not.toBe(before)
  })

  it('distinguishes adjacent delivery IDs', () => {
    const a = generateTrackingToken(100)
    const b = generateTrackingToken(101)
    expect(a).not.toBe(b)
  })

  it('accepts number, bigint, string deliveryIds and agrees on value', () => {
    const fromNum = generateTrackingToken(12345)
    const fromBig = generateTrackingToken(BigInt(12345))
    const fromStr = generateTrackingToken('12345')
    expect(fromBig).toBe(fromNum)
    expect(fromStr).toBe(fromNum)
  })
})

// ---------------------------------------------------------------------------
// §2 verifyTrackingToken
// ---------------------------------------------------------------------------

describe('verifyTrackingToken', () => {
  it('accepts a token it just minted', () => {
    const t = generateTrackingToken(42)
    expect(verifyTrackingToken(t, 42)).toBe(true)
  })

  it('rejects a token with the wrong delivery ID', () => {
    const t = generateTrackingToken(42)
    expect(verifyTrackingToken(t, 43)).toBe(false)
  })

  it('rejects tampered tokens (last char flipped)', () => {
    const t = generateTrackingToken(42)
    const tampered = t.slice(0, -1) + (t.endsWith('0') ? '1' : '0')
    expect(verifyTrackingToken(tampered, 42)).toBe(false)
  })

  it('rejects non-hex characters', () => {
    expect(verifyTrackingToken('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', 42)).toBe(false)
  })

  it('rejects wrong-length input', () => {
    expect(verifyTrackingToken('abc', 42)).toBe(false)
    expect(verifyTrackingToken('a'.repeat(64), 42)).toBe(false)
  })

  it('rejects non-string input without throwing', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(verifyTrackingToken(null as any, 42)).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(verifyTrackingToken(123 as any, 42)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// §3 URL builders
// ---------------------------------------------------------------------------

describe('buildPixelUrl / buildClickUrl', () => {
  it('buildPixelUrl appends /email/track/open/<token>.gif', () => {
    const url = buildPixelUrl('https://gbox.co', 'abc123')
    expect(url).toBe('https://gbox.co/email/track/open/abc123.gif')
  })

  it('buildPixelUrl strips trailing slash on base', () => {
    const url = buildPixelUrl('https://gbox.co/', 'abc123')
    expect(url).toBe('https://gbox.co/email/track/open/abc123.gif')
  })

  it('buildClickUrl base64url-encodes the target', () => {
    const url = buildClickUrl('https://gbox.co', 'abc', 'https://shop.com/p/hat')
    expect(url.startsWith('https://gbox.co/email/track/click/abc?u=')).toBe(true)
    // Round-trip the encoded param:
    const encoded = url.split('?u=')[1]
    expect(base64UrlDecode(encoded)).toBe('https://shop.com/p/hat')
  })

  it('buildClickUrl encodes URL-unsafe characters in base64url (no +,/,=)', () => {
    // Target containing '+', '/', '=', spaces, unicode — base64url must
    // emit only [-_A-Za-z0-9].
    const tricky = 'https://example.com/a?q=hello world&x=äöü+100%'
    const url = buildClickUrl('https://gbox.co', 'tok', tricky)
    const encoded = url.split('?u=')[1]
    expect(encoded).toMatch(/^[-_A-Za-z0-9]+$/)
    expect(base64UrlDecode(encoded)).toBe(tricky)
  })
})

// ---------------------------------------------------------------------------
// §4 decodeClickTarget — security filter
// ---------------------------------------------------------------------------

describe('decodeClickTarget', () => {
  it('round-trips a valid https URL', () => {
    const encoded = base64UrlEncode('https://shop.com/products/hat')
    expect(decodeClickTarget(encoded)).toBe('https://shop.com/products/hat')
  })

  it('accepts http (non-TLS) URLs — dev stores may not have SSL yet', () => {
    const encoded = base64UrlEncode('http://localhost:4322/x')
    expect(decodeClickTarget(encoded)).toBe('http://localhost:4322/x')
  })

  it('rejects javascript: URLs', () => {
    const encoded = base64UrlEncode('javascript:alert(1)')
    expect(decodeClickTarget(encoded)).toBeNull()
  })

  it('rejects data: URLs', () => {
    const encoded = base64UrlEncode('data:text/html,<script>')
    expect(decodeClickTarget(encoded)).toBeNull()
  })

  it('rejects file: URLs', () => {
    const encoded = base64UrlEncode('file:///etc/passwd')
    expect(decodeClickTarget(encoded)).toBeNull()
  })

  it('rejects URLs containing control characters', () => {
    // CRLF header-injection attempt.
    const encoded = base64UrlEncode('https://shop.com/\r\nX-Inject: boom')
    expect(decodeClickTarget(encoded)).toBeNull()
  })

  it('rejects malformed URLs (no hostname)', () => {
    const encoded = base64UrlEncode('https://')
    expect(decodeClickTarget(encoded)).toBeNull()
  })

  it('returns null on base64 decode failure rather than throwing', () => {
    // Non-base64 gibberish.
    expect(decodeClickTarget('!!!not base64!!!')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// §5 injectPixel
// ---------------------------------------------------------------------------

describe('injectPixel', () => {
  const PIXEL_URL = 'https://gbox.co/email/track/open/abc.gif'

  it('injects the img tag before </body>', () => {
    const html = '<html><body><p>hi</p></body></html>'
    const out = injectPixel(html, PIXEL_URL)
    expect(out).toContain(`src="${PIXEL_URL}"`)
    expect(out.indexOf(PIXEL_URL)).toBeLessThan(out.indexOf('</body>'))
  })

  it('falls back to </html> if no </body>', () => {
    const html = '<html><p>hi</p></html>'
    const out = injectPixel(html, PIXEL_URL)
    expect(out).toContain(PIXEL_URL)
    expect(out.indexOf(PIXEL_URL)).toBeLessThan(out.indexOf('</html>'))
  })

  it('appends to the end for fragment HTML', () => {
    const html = '<p>hi</p>'
    const out = injectPixel(html, PIXEL_URL)
    expect(out.endsWith(PIXEL_URL + '" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;outline:0;" />')).toBe(true)
  })

  it('is idempotent — running twice does not double-inject', () => {
    const html = '<html><body><p>hi</p></body></html>'
    const once = injectPixel(html, PIXEL_URL)
    const twice = injectPixel(once, PIXEL_URL)
    expect(twice).toBe(once)
    // Exactly one pixel url reference.
    const occurrences = (twice.match(/\/email\/track\/open\//g) || []).length
    expect(occurrences).toBe(1)
  })

  it('escapes special characters in the src attribute', () => {
    const evil = 'https://gbox.co/email/track/open/abc.gif?a="&b=<x'
    const out = injectPixel('<html><body></body></html>', evil)
    expect(out).not.toContain('<x')     // '<' escaped
    expect(out).toContain('&amp;')       // '&' escaped
    expect(out).toContain('&quot;')      // '"' escaped
  })
})

// ---------------------------------------------------------------------------
// §6 rewriteHtmlLinks
// ---------------------------------------------------------------------------

describe('rewriteHtmlLinks', () => {
  const BASE = 'https://gbox.co'
  const TOKEN = 'tok1234'

  it('wraps absolute http(s) hrefs in the click redirect', () => {
    const html = '<a href="https://shop.com/p">Buy</a>'
    const out = rewriteHtmlLinks(html, TOKEN, BASE)
    expect(out).toContain(`${BASE}/email/track/click/${TOKEN}?u=`)
  })

  it('leaves mailto:, tel:, and relative hrefs alone', () => {
    const html =
      '<a href="mailto:x@y.com">mail</a>' +
      '<a href="tel:+123">call</a>' +
      '<a href="/about">about</a>' +
      '<a href="#section">anchor</a>'
    const out = rewriteHtmlLinks(html, TOKEN, BASE)
    // Nothing got rewritten.
    expect(out.includes('/email/track/click/')).toBe(false)
  })

  it('skips javascript: hrefs (defence in depth even though templates are trusted)', () => {
    const html = '<a href="javascript:evil()">x</a>'
    const out = rewriteHtmlLinks(html, TOKEN, BASE)
    expect(out).toBe(html)
  })

  it('is idempotent — running twice does not wrap twice', () => {
    const html = '<a href="https://shop.com/p">Buy</a>'
    const once = rewriteHtmlLinks(html, TOKEN, BASE)
    const twice = rewriteHtmlLinks(once, TOKEN, BASE)
    expect(twice).toBe(once)
  })

  it('does not wrap the pixel URL itself', () => {
    const pixelUrl = `${BASE}/email/track/open/abc.gif`
    const html = `<img src="${pixelUrl}" /><a href="${pixelUrl}">fallback</a>`
    const out = rewriteHtmlLinks(html, TOKEN, BASE)
    expect(out).toBe(html)
  })

  it('preserves other attributes on the <a> tag', () => {
    const html = '<a class="cta" data-foo="1" href="https://x.com/">go</a>'
    const out = rewriteHtmlLinks(html, TOKEN, BASE)
    expect(out).toContain('class="cta"')
    expect(out).toContain('data-foo="1"')
    expect(out).toMatch(/href="https:\/\/gbox\.co\/email\/track\/click\//)
  })

  it('rewriteHtmlLinksWithCount returns the number of rewrites', () => {
    const html =
      '<a href="https://a.com/">a</a>' +
      '<a href="https://b.com/">b</a>' +
      '<a href="mailto:x@y">m</a>'
    const { count } = rewriteHtmlLinksWithCount(html, TOKEN, BASE)
    expect(count).toBe(2)
  })

  it('handles single-quoted href attributes', () => {
    const html = "<a href='https://shop.com/p'>x</a>"
    const out = rewriteHtmlLinks(html, TOKEN, BASE)
    expect(out).toContain("href='https://gbox.co/email/track/click/")
  })
})

// ---------------------------------------------------------------------------
// §7 base64url codec
// ---------------------------------------------------------------------------

describe('base64UrlEncode / base64UrlDecode', () => {
  it('round-trips ASCII', () => {
    const s = 'hello world'
    expect(base64UrlDecode(base64UrlEncode(s))).toBe(s)
  })

  it('round-trips unicode (UTF-8 safe)', () => {
    const s = 'xin chào — こんにちは 🎉'
    expect(base64UrlDecode(base64UrlEncode(s))).toBe(s)
  })

  it('never emits +, /, or = in the output', () => {
    // Inputs that force +, / in standard base64.
    const pairs = ['>>>', '???', 'abc/xyz+foo==']
    for (const s of pairs) {
      const enc = base64UrlEncode(s)
      expect(enc).not.toMatch(/[+/=]/)
    }
  })

  it('handles input lengths that need 1, 2, 3 bytes of padding', () => {
    expect(base64UrlDecode(base64UrlEncode('a'))).toBe('a')
    expect(base64UrlDecode(base64UrlEncode('ab'))).toBe('ab')
    expect(base64UrlDecode(base64UrlEncode('abc'))).toBe('abc')
    expect(base64UrlDecode(base64UrlEncode('abcd'))).toBe('abcd')
  })
})

// ---------------------------------------------------------------------------
// §8 TRANSPARENT_GIF_PIXEL
// ---------------------------------------------------------------------------

describe('TRANSPARENT_GIF_PIXEL', () => {
  it('is a Buffer', () => {
    expect(Buffer.isBuffer(TRANSPARENT_GIF_PIXEL)).toBe(true)
  })

  it('is 43 bytes (minimal GIF89a)', () => {
    expect(TRANSPARENT_GIF_PIXEL.length).toBe(43)
  })

  it('starts with GIF89a magic', () => {
    expect(TRANSPARENT_GIF_PIXEL.subarray(0, 6).toString('ascii')).toBe('GIF89a')
  })

  it('ends with GIF trailer 0x3b', () => {
    expect(TRANSPARENT_GIF_PIXEL[TRANSPARENT_GIF_PIXEL.length - 1]).toBe(0x3b)
  })
})

// ---------------------------------------------------------------------------
// §9 env helpers
// ---------------------------------------------------------------------------

describe('resolveTrackingBaseUrl', () => {
  it('prefers EMAIL_TRACKING_BASE_URL when set', () => {
    process.env.EMAIL_TRACKING_BASE_URL = 'https://track.gbox.co'
    process.env.STOREFRONT_BASE_URL = 'https://storefront.gbox.co'
    expect(resolveTrackingBaseUrl()).toBe('https://track.gbox.co')
  })

  it('falls back to STOREFRONT_BASE_URL', () => {
    process.env.STOREFRONT_BASE_URL = 'https://storefront.gbox.co'
    expect(resolveTrackingBaseUrl()).toBe('https://storefront.gbox.co')
  })

  it('falls back to http://localhost:4322 as last resort', () => {
    expect(resolveTrackingBaseUrl()).toBe('http://localhost:4322')
  })

  it('strips trailing slash', () => {
    process.env.EMAIL_TRACKING_BASE_URL = 'https://x.com/'
    expect(resolveTrackingBaseUrl()).toBe('https://x.com')
  })

  it('ignores non-http values', () => {
    process.env.EMAIL_TRACKING_BASE_URL = 'javascript:alert(1)'
    expect(resolveTrackingBaseUrl()).toBe('http://localhost:4322')
  })
})

describe('isTrackingEnabled', () => {
  it('defaults to true when env unset', () => {
    expect(isTrackingEnabled()).toBe(true)
  })

  it('treats "0", "false", "no", "off" as disabled', () => {
    for (const v of ['0', 'false', 'no', 'off', 'FALSE', 'Off']) {
      process.env.EMAIL_TRACKING_ENABLED = v
      expect(isTrackingEnabled()).toBe(false)
    }
  })

  it('treats "1", "true", other strings as enabled', () => {
    for (const v of ['1', 'true', 'on', 'yes']) {
      process.env.EMAIL_TRACKING_ENABLED = v
      expect(isTrackingEnabled()).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// §10 isTrackedCategory
// ---------------------------------------------------------------------------

describe('isTrackedCategory', () => {
  it('includes marketing, lifecycle, reviews', () => {
    expect(isTrackedCategory('marketing')).toBe(true)
    expect(isTrackedCategory('lifecycle')).toBe(true)
    expect(isTrackedCategory('reviews')).toBe(true)
  })

  it('excludes transactional and admin categories', () => {
    expect(isTrackedCategory('transactional')).toBe(false)
    expect(isTrackedCategory('admin')).toBe(false)
    expect(isTrackedCategory('system')).toBe(false)
  })

  it('rejects null / undefined / empty string defensively', () => {
    expect(isTrackedCategory(null)).toBe(false)
    expect(isTrackedCategory(undefined)).toBe(false)
    expect(isTrackedCategory('')).toBe(false)
  })
})
