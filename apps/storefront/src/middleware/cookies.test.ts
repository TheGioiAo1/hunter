/**
 * Gbox Storefront — Cookie Middleware tests (Stage 3A.5)
 *
 * The cookie middleware is the third storefront-specific piece in
 * the chain (after request-context and resolve-shop). Its job is
 * narrow: parse the incoming `Cookie` header, pull out the three
 * cookies the storefront cares about at v1 — `cart`, `_session`,
 * and `locale` — and stamp them onto the request as a typed
 * `req.gboxCookies` object. It does NOT set any response cookies;
 * writes are handled by the cart (3B) and auth (3C) phases.
 *
 * Rules:
 *
 *   • No header → empty cookies object, never undefined.
 *   • Unknown cookie names are ignored (don't leak to req).
 *   • Malformed cookie values are logged (via req.gboxCtx.logger)
 *     and discarded — never throw.
 *   • Max length per cookie value defends against header-stuffing
 *     abuse: 4096 bytes is the RFC practical limit for a cookie.
 *   • Case-insensitive cookie name match is NOT performed — we
 *     expect the exact names `cart`, `_session`, `locale`.
 *   • Values are URL-decoded (browsers set e.g. `locale=en-US`
 *     raw, but older clients may percent-encode).
 */

import { describe, it, expect, vi } from 'vitest'
import {
  buildCookieMiddleware,
  parseCookieHeader,
  MAX_COOKIE_VALUE_LENGTH,
} from './cookies.js'

// ---------------------------------------------------------------------------
// parseCookieHeader()
// ---------------------------------------------------------------------------

describe('parseCookieHeader', () => {
  it('returns an empty object for undefined', () => {
    expect(parseCookieHeader(undefined)).toEqual({})
  })

  it('returns an empty object for empty string', () => {
    expect(parseCookieHeader('')).toEqual({})
  })

  it('parses a single cookie', () => {
    expect(parseCookieHeader('cart=abc123')).toEqual({ cart: 'abc123' })
  })

  it('parses multiple cookies separated by semicolons', () => {
    expect(
      parseCookieHeader('cart=abc; _session=tok; locale=en-US'),
    ).toEqual({ cart: 'abc', _session: 'tok', locale: 'en-US' })
  })

  it('tolerates extra whitespace around names and values', () => {
    expect(parseCookieHeader('  cart = abc ; locale = en-US  ')).toEqual({
      cart: 'abc',
      locale: 'en-US',
    })
  })

  it('URL-decodes percent-encoded values', () => {
    expect(parseCookieHeader('locale=en%2DUS')).toEqual({ locale: 'en-US' })
  })

  it('keeps the last value when a cookie name is repeated', () => {
    expect(parseCookieHeader('cart=first; cart=second')).toEqual({
      cart: 'second',
    })
  })

  it('skips cookies with no = (no value)', () => {
    expect(parseCookieHeader('justaname; cart=abc')).toEqual({ cart: 'abc' })
  })

  it('handles quoted values (strips surrounding quotes)', () => {
    expect(parseCookieHeader('cart="abc 123"')).toEqual({ cart: 'abc 123' })
  })

  it('drops values longer than MAX_COOKIE_VALUE_LENGTH', () => {
    const huge = 'x'.repeat(MAX_COOKIE_VALUE_LENGTH + 1)
    expect(parseCookieHeader(`cart=${huge}`)).toEqual({})
  })

  it('ignores values containing CR/LF (header injection defence)', () => {
    expect(parseCookieHeader('cart=abc\r\nBad: yes')).toEqual({})
  })

  it('ignores malformed percent encoding and keeps other cookies', () => {
    expect(parseCookieHeader('cart=%E0%A4; locale=en-US')).toEqual({
      locale: 'en-US',
    })
  })
})

// ---------------------------------------------------------------------------
// buildCookieMiddleware — end-to-end
// ---------------------------------------------------------------------------

describe('buildCookieMiddleware', () => {
  interface FakeReq {
    headers: Record<string, string | undefined>
    gboxCtx?: { logger: { warn: () => void; info: () => void; error: () => void } }
    gboxCookies?: {
      cart: string | null
      session: string | null
      locale: string | null
      all: Record<string, string>
    }
  }

  function mkReq(header?: string): FakeReq {
    return {
      headers: { cookie: header } as Record<string, string | undefined>,
      gboxCtx: { logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } },
    }
  }

  it('attaches an empty shape when the Cookie header is missing', () => {
    const mw = buildCookieMiddleware()
    const req = mkReq(undefined)
    mw(req as never, {} as never, vi.fn())
    expect(req.gboxCookies).toBeDefined()
    expect(req.gboxCookies?.cart).toBeNull()
    expect(req.gboxCookies?.session).toBeNull()
    expect(req.gboxCookies?.locale).toBeNull()
    expect(req.gboxCookies?.all).toEqual({})
  })

  it('extracts the cart, session, and locale cookies into typed slots', () => {
    const mw = buildCookieMiddleware()
    const req = mkReq('cart=c123; _session=s456; locale=en-US')
    mw(req as never, {} as never, vi.fn())
    expect(req.gboxCookies?.cart).toBe('c123')
    expect(req.gboxCookies?.session).toBe('s456')
    expect(req.gboxCookies?.locale).toBe('en-US')
  })

  it('exposes the full bag via gboxCookies.all for future readers', () => {
    const mw = buildCookieMiddleware()
    const req = mkReq('cart=c; custom=x')
    mw(req as never, {} as never, vi.fn())
    expect(req.gboxCookies?.all).toEqual({ cart: 'c', custom: 'x' })
    // Typed slots only surface the known names
    expect(req.gboxCookies?.cart).toBe('c')
    expect(req.gboxCookies?.session).toBeNull()
  })

  it('calls next() with no error', () => {
    const mw = buildCookieMiddleware()
    const req = mkReq('cart=c')
    const next = vi.fn()
    mw(req as never, {} as never, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledWith()
  })

  it('never throws on malformed header', () => {
    const mw = buildCookieMiddleware()
    const req = mkReq('this is not a valid cookie header')
    const next = vi.fn()
    expect(() => mw(req as never, {} as never, next)).not.toThrow()
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('sets cart/session/locale to null when only unrelated cookies arrive', () => {
    const mw = buildCookieMiddleware()
    const req = mkReq('foo=bar; baz=qux')
    mw(req as never, {} as never, vi.fn())
    expect(req.gboxCookies?.cart).toBeNull()
    expect(req.gboxCookies?.session).toBeNull()
    expect(req.gboxCookies?.locale).toBeNull()
    expect(req.gboxCookies?.all).toEqual({ foo: 'bar', baz: 'qux' })
  })

  it('handles array-valued Cookie header (rare but permitted by Node)', () => {
    const mw = buildCookieMiddleware()
    const req = mkReq(undefined)
    req.headers.cookie = (['cart=c1', 'locale=de-DE'] as unknown) as string
    mw(req as never, {} as never, vi.fn())
    expect(req.gboxCookies?.cart).toBe('c1')
    expect(req.gboxCookies?.locale).toBe('de-DE')
  })
})
