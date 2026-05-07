/**
 * Gbox Storefront — i18n middleware tests (Stage 5.6)
 *
 * Hooks the pure `translateKey` helper from `@gbox/core` into the
 * storefront request pipeline.
 *
 * Contract:
 *   1. Runs AFTER the locale middleware (reads `req.gboxLocale`).
 *   2. Calls a dep-injected async loader once per request to fetch
 *      translation bundles for the resolved shop.
 *   3. Stamps `req.gboxT(key, vars?)` — a SYNCHRONOUS translator
 *      pinned to the current request's locale + fallback chain.
 *   4. Never throws: missing bundles / loader errors fall back to
 *      returning the key itself (Shopify behaviour — makes missing
 *      translations obvious in dev).
 *   5. Exposes the raw bundles on `req.gboxTranslations` for
 *      downstream handlers that want to hand them to the theme
 *      engine (one payload per request — no double-load).
 */

import { describe, it, expect, vi } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { buildI18nMiddleware, type I18nLoader } from './i18n.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    gboxLocale: { locale: 'en', strippedPath: '/' },
    ...overrides,
  } as unknown as Request
}

const res = {} as Response
const next: NextFunction = vi.fn()

const bundles = {
  en: {
    'cart.title': 'Cart',
    'cart.count': 'You have {{ count }} items',
  },
  vi: {
    'cart.title': 'Giỏ hàng',
  },
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe('buildI18nMiddleware — happy paths', () => {
  it('stamps a sync t() that resolves the requested locale', async () => {
    const loader: I18nLoader = vi.fn().mockResolvedValue(bundles)
    const mw = buildI18nMiddleware({ loader, defaultLocale: 'en' })

    const req = mkReq({
      gboxLocale: { locale: 'vi', strippedPath: '/' },
    } as Partial<Request>)
    await mw(req, res, next)

    expect(loader).toHaveBeenCalledTimes(1)
    expect(typeof req.gboxT).toBe('function')
    expect(req.gboxT!('cart.title')).toBe('Giỏ hàng')
    expect(next).toHaveBeenCalled()
  })

  it('falls back to the default locale when the requested key is missing', async () => {
    const loader: I18nLoader = vi.fn().mockResolvedValue(bundles)
    const mw = buildI18nMiddleware({ loader, defaultLocale: 'en' })

    const req = mkReq({
      gboxLocale: { locale: 'vi', strippedPath: '/' },
    } as Partial<Request>)
    await mw(req, res, next)

    // "cart.count" is only in `en` — should fall back.
    expect(req.gboxT!('cart.count', { count: 3 })).toBe('You have 3 items')
  })

  it('interpolates vars through translateKey', async () => {
    const loader: I18nLoader = vi.fn().mockResolvedValue(bundles)
    const mw = buildI18nMiddleware({ loader, defaultLocale: 'en' })
    const req = mkReq()
    await mw(req, res, next)
    expect(req.gboxT!('cart.count', { count: 7 })).toBe('You have 7 items')
  })

  it('returns the key itself when every locale misses', async () => {
    const loader: I18nLoader = vi.fn().mockResolvedValue(bundles)
    const mw = buildI18nMiddleware({ loader, defaultLocale: 'en' })
    const req = mkReq()
    await mw(req, res, next)
    expect(req.gboxT!('unknown.key')).toBe('unknown.key')
  })

  it('exposes raw bundles on req.gboxTranslations for downstream handlers', async () => {
    const loader: I18nLoader = vi.fn().mockResolvedValue(bundles)
    const mw = buildI18nMiddleware({ loader, defaultLocale: 'en' })
    const req = mkReq()
    await mw(req, res, next)
    expect(req.gboxTranslations).toEqual(bundles)
  })

  it('defaults locale to defaultLocale when req.gboxLocale is missing', async () => {
    const loader: I18nLoader = vi.fn().mockResolvedValue(bundles)
    const mw = buildI18nMiddleware({ loader, defaultLocale: 'en' })
    const req = mkReq({ gboxLocale: undefined } as Partial<Request>)
    await mw(req, res, next)
    expect(req.gboxT!('cart.title')).toBe('Cart')
  })
})

// ---------------------------------------------------------------------------
// Failure modes — must never 500 the request
// ---------------------------------------------------------------------------

describe('buildI18nMiddleware — failure modes', () => {
  it('returns key-as-fallback when the loader throws', async () => {
    const loader: I18nLoader = vi.fn().mockRejectedValue(new Error('db down'))
    const mw = buildI18nMiddleware({ loader, defaultLocale: 'en' })

    const req = mkReq()
    await mw(req, res, next)

    expect(next).toHaveBeenCalled()
    // Should NOT forward the error — missing translations are a
    // soft failure on the storefront.
    const callArgs = (next as ReturnType<typeof vi.fn>).mock.calls.at(-1) ?? []
    expect(callArgs[0]).toBeUndefined()

    expect(req.gboxT!('cart.title')).toBe('cart.title')
    expect(req.gboxTranslations).toEqual({})
  })

  it('returns key-as-fallback when the loader returns null', async () => {
    const loader: I18nLoader = vi.fn().mockResolvedValue(null)
    const mw = buildI18nMiddleware({ loader, defaultLocale: 'en' })
    const req = mkReq()
    await mw(req, res, next)
    expect(req.gboxT!('cart.title')).toBe('cart.title')
    expect(req.gboxTranslations).toEqual({})
  })

  it('handles a loader that returns an empty bundle map', async () => {
    const loader: I18nLoader = vi.fn().mockResolvedValue({})
    const mw = buildI18nMiddleware({ loader, defaultLocale: 'en' })
    const req = mkReq()
    await mw(req, res, next)
    expect(req.gboxT!('cart.title')).toBe('cart.title')
  })

  it('passes the resolved shop + locale to the loader', async () => {
    const loader: I18nLoader = vi.fn().mockResolvedValue(bundles)
    const mw = buildI18nMiddleware({ loader, defaultLocale: 'en' })

    const req = mkReq({
      gboxShop: {
        id: 'shop_123',
        slug: 'gbox',
        domain: 'gbox.test',
        defaultLocale: 'vi',
      },
      gboxLocale: { locale: 'vi-VN', strippedPath: '/' },
    } as unknown as Partial<Request>)
    await mw(req, res, next)

    expect(loader).toHaveBeenCalledWith({
      shop: expect.objectContaining({ id: 'shop_123' }),
      locale: 'vi-VN',
      defaultLocale: 'vi',
    })
  })
})
