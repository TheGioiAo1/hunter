/**
 * Gbox Storefront — Locale Middleware tests (Stage 3A.6)
 *
 * The storefront locale middleware runs AFTER resolve-shop and
 * cookies, so it can read:
 *
 *   • the shop's default + supported locale list,
 *   • the visitor's `locale` cookie (set by a prior visit or by a
 *     future language switcher UI),
 *   • the raw `Accept-Language` header,
 *
 * and decide which locale should drive this request. The output
 * lands on `req.gboxLocale = { locale, strippedPath }` and — when a
 * URL locale prefix was consumed — the request's `url` / `path` are
 * rewritten in place so the downstream router sees the bare path.
 *
 * Precedence (first match wins):
 *
 *   1. URL prefix (`/vi/products/foo` → vi)
 *   2. Cookie   (`locale=vi`          → vi)
 *   3. Accept-Language header
 *   4. Shop default locale
 *
 * These tests cover every branch plus edge cases: unsupported
 * cookie, missing header, missing shop, case normalization.
 */

import { describe, it, expect, vi } from 'vitest'
import { buildLocaleMiddleware } from './locale.js'
import type { ResolvedShop } from './resolve-shop.js'
import type { StorefrontCookies } from './cookies.js'

const SHOP: ResolvedShop = {
  id: 'shop_uuid',
  slug: 'demo',
  name: 'Demo',
  currency: 'USD',
  defaultLocale: 'en',
  status: 'active',
}

const MULTI_LOCALE_SHOP: ResolvedShop = {
  ...SHOP,
  defaultLocale: 'en',
}

interface FakeReq {
  headers: Record<string, string | undefined>
  url: string
  path: string
  gboxShop?: ResolvedShop
  gboxCookies?: StorefrontCookies
  gboxLocale?: { locale: string; strippedPath: string }
  gboxCtx?: { logger: { info: () => void; warn: () => void; error: () => void } }
}

function mkReq(
  url = '/',
  cookies: Partial<StorefrontCookies> = {},
  acceptLanguage?: string,
  shop: ResolvedShop | undefined = SHOP,
): FakeReq {
  return {
    headers: {
      ...(acceptLanguage ? { 'accept-language': acceptLanguage } : {}),
    },
    url,
    path: url.split('?')[0],
    gboxShop: shop,
    gboxCookies: {
      cart: null,
      session: null,
      locale: null,
      all: {},
      ...cookies,
    },
    gboxCtx: {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
  }
}

// ---------------------------------------------------------------------------
// URL prefix wins
// ---------------------------------------------------------------------------

describe('locale middleware — URL prefix', () => {
  it('extracts a supported locale from the URL prefix and strips it', () => {
    const mw = buildLocaleMiddleware({
      getSupportedLocales: () => ['en', 'vi'],
    })
    const req = mkReq('/vi/products/shirt')
    const next = vi.fn()
    mw(req as never, {} as never, next)

    expect(req.gboxLocale).toEqual({
      locale: 'vi',
      strippedPath: '/products/shirt',
    })
    // URL/path rewritten so the router sees the bare path
    expect(req.url).toBe('/products/shirt')
    expect(req.path).toBe('/products/shirt')
    expect(next).toHaveBeenCalledWith()
  })

  it('URL prefix wins over a conflicting cookie', () => {
    const mw = buildLocaleMiddleware({
      getSupportedLocales: () => ['en', 'vi', 'de'],
    })
    const req = mkReq('/de/', { locale: 'vi' })
    mw(req as never, {} as never, vi.fn())
    expect(req.gboxLocale?.locale).toBe('de')
  })

  it('unknown URL prefix is NOT treated as a locale', () => {
    const mw = buildLocaleMiddleware({
      getSupportedLocales: () => ['en'],
    })
    const req = mkReq('/fr/products/shirt')
    mw(req as never, {} as never, vi.fn())
    expect(req.gboxLocale?.locale).toBe('en') // fell through to default
    expect(req.url).toBe('/fr/products/shirt') // untouched
  })

  it('case-insensitive URL prefix match', () => {
    const mw = buildLocaleMiddleware({
      getSupportedLocales: () => ['en', 'vi'],
    })
    const req = mkReq('/VI/products')
    mw(req as never, {} as never, vi.fn())
    expect(req.gboxLocale?.locale).toBe('vi')
    expect(req.url).toBe('/products')
  })
})

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

describe('locale middleware — cookie', () => {
  it('uses the locale cookie when set and supported', () => {
    const mw = buildLocaleMiddleware({
      getSupportedLocales: () => ['en', 'vi'],
    })
    const req = mkReq('/products/shirt', { locale: 'vi' })
    mw(req as never, {} as never, vi.fn())
    expect(req.gboxLocale?.locale).toBe('vi')
    expect(req.url).toBe('/products/shirt') // no stripping
  })

  it('ignores an unsupported cookie value and falls through', () => {
    const mw = buildLocaleMiddleware({
      getSupportedLocales: () => ['en'],
    })
    const req = mkReq('/', { locale: 'xx' })
    mw(req as never, {} as never, vi.fn())
    expect(req.gboxLocale?.locale).toBe('en')
  })

  it('lowercases cookie value before matching', () => {
    const mw = buildLocaleMiddleware({
      getSupportedLocales: () => ['en', 'vi'],
    })
    const req = mkReq('/', { locale: 'VI' })
    mw(req as never, {} as never, vi.fn())
    expect(req.gboxLocale?.locale).toBe('vi')
  })

  it('cookie wins over Accept-Language', () => {
    const mw = buildLocaleMiddleware({
      getSupportedLocales: () => ['en', 'vi', 'de'],
    })
    const req = mkReq('/', { locale: 'de' }, 'vi,en;q=0.5')
    mw(req as never, {} as never, vi.fn())
    expect(req.gboxLocale?.locale).toBe('de')
  })
})

// ---------------------------------------------------------------------------
// Accept-Language header
// ---------------------------------------------------------------------------

describe('locale middleware — Accept-Language', () => {
  it('picks the highest-priority supported locale from the header', () => {
    const mw = buildLocaleMiddleware({
      getSupportedLocales: () => ['en', 'vi', 'de'],
    })
    const req = mkReq('/', {}, 'vi,en;q=0.8,de;q=0.3')
    mw(req as never, {} as never, vi.fn())
    expect(req.gboxLocale?.locale).toBe('vi')
  })

  it('falls back to base language (fr-CA → fr)', () => {
    const mw = buildLocaleMiddleware({
      getSupportedLocales: () => ['en', 'fr'],
    })
    const req = mkReq('/', {}, 'fr-CA,fr;q=0.9,en;q=0.5')
    mw(req as never, {} as never, vi.fn())
    expect(req.gboxLocale?.locale).toBe('fr')
  })

  it('ignores header values that do not match any supported locale', () => {
    const mw = buildLocaleMiddleware({
      getSupportedLocales: () => ['en'],
    })
    const req = mkReq('/', {}, 'ja,ko;q=0.8')
    mw(req as never, {} as never, vi.fn())
    expect(req.gboxLocale?.locale).toBe('en') // fell through to default
  })
})

// ---------------------------------------------------------------------------
// Default fallback
// ---------------------------------------------------------------------------

describe('locale middleware — default fallback', () => {
  it('uses the shop default locale when nothing else matches', () => {
    const mw = buildLocaleMiddleware({
      getSupportedLocales: () => ['en'],
    })
    const req = mkReq('/')
    mw(req as never, {} as never, vi.fn())
    expect(req.gboxLocale?.locale).toBe('en')
  })

  it('still attaches gboxLocale when Accept-Language is missing', () => {
    const mw = buildLocaleMiddleware({
      getSupportedLocales: () => ['en'],
    })
    const req = mkReq('/products', {})
    mw(req as never, {} as never, vi.fn())
    expect(req.gboxLocale?.locale).toBe('en')
    expect(req.gboxLocale?.strippedPath).toBe('/products')
  })

  it('uses shop.defaultLocale (not en) when shop prefers vi', () => {
    const mw = buildLocaleMiddleware({
      getSupportedLocales: () => ['en', 'vi'],
    })
    const shopVi = { ...SHOP, defaultLocale: 'vi' }
    const req = mkReq('/', {}, undefined, shopVi)
    mw(req as never, {} as never, vi.fn())
    expect(req.gboxLocale?.locale).toBe('vi')
  })
})

// ---------------------------------------------------------------------------
// Defensive edge cases
// ---------------------------------------------------------------------------

describe('locale middleware — edge cases', () => {
  it('does not crash when gboxShop is missing (fall back to global default)', () => {
    const mw = buildLocaleMiddleware({
      getSupportedLocales: () => ['en'],
      defaultLocale: 'en',
    })
    const req = mkReq('/')
    req.gboxShop = undefined
    expect(() => mw(req as never, {} as never, vi.fn())).not.toThrow()
    expect(req.gboxLocale?.locale).toBe('en')
  })

  it('does not crash when gboxCookies is missing', () => {
    const mw = buildLocaleMiddleware({
      getSupportedLocales: () => ['en'],
    })
    const req = mkReq('/')
    req.gboxCookies = undefined
    expect(() => mw(req as never, {} as never, vi.fn())).not.toThrow()
    expect(req.gboxLocale?.locale).toBe('en')
  })

  it('always calls next()', () => {
    const mw = buildLocaleMiddleware({
      getSupportedLocales: () => ['en'],
    })
    const next = vi.fn()
    mw(mkReq('/') as never, {} as never, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledWith()
  })
})
