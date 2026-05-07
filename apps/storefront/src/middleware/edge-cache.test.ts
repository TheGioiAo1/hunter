/**
 * Gbox Storefront — Edge Cache Middleware Tests
 *
 * Covers both the pure router (`pickCachePreset`) and the Express
 * middleware wrapper. No running Express instance — we drive the
 * middleware with hand-rolled req/res fakes so tests stay fast and
 * isolated.
 */

import { describe, it, expect, vi } from 'vitest'
import type { Request, Response } from 'express'
import {
  pickCachePreset,
  buildEdgeCacheHeadersMiddleware,
} from './edge-cache.js'

function makeRes(): Response & { headers: Record<string, string> } {
  const headers: Record<string, string> = {}
  const res = {
    headers,
    setHeader(name: string, value: string) {
      headers[name] = value
      return res
    },
    set(name: string, value: string) {
      headers[name] = value
      return res
    },
  }
  return res as unknown as Response & { headers: Record<string, string> }
}

function makeReq(method: string, path: string): Request {
  return { method, path } as unknown as Request
}

describe('pickCachePreset', () => {
  it('skips /_health so the monitor sees default JSON', () => {
    expect(pickCachePreset('GET', '/_health')).toBeNull()
  })

  it('assets route → theme_asset_immutable', () => {
    expect(pickCachePreset('GET', '/assets/theme.css')).toBe(
      'theme_asset_immutable',
    )
    expect(pickCachePreset('GET', '/assets/fonts/inter.woff2')).toBe(
      'theme_asset_immutable',
    )
  })

  it('checkout is never cacheable, even on GET', () => {
    expect(pickCachePreset('GET', '/checkout')).toBe('no_store')
    expect(pickCachePreset('GET', '/checkout/contact')).toBe('no_store')
    expect(pickCachePreset('POST', '/checkout')).toBe('no_store')
  })

  it('cart routes are personalised_private', () => {
    expect(pickCachePreset('GET', '/cart')).toBe('personalised_private')
    expect(pickCachePreset('GET', '/cart.js')).toBe('personalised_private')
    expect(pickCachePreset('POST', '/cart/add.js')).toBe('personalised_private')
  })

  it('account routes are personalised_private (login, orders, logout)', () => {
    expect(pickCachePreset('GET', '/account')).toBe('personalised_private')
    expect(pickCachePreset('GET', '/account/orders')).toBe('personalised_private')
    expect(pickCachePreset('POST', '/account/logout')).toBe('personalised_private')
  })

  it('event beacons + marketing subscribe are no_store writes', () => {
    expect(pickCachePreset('POST', '/events')).toBe('no_store')
    expect(pickCachePreset('POST', '/marketing/subscribe')).toBe('no_store')
  })

  it('non-GET mutations on otherwise cacheable paths fall back to no_store', () => {
    expect(pickCachePreset('POST', '/products/foo')).toBe('no_store')
    expect(pickCachePreset('PUT', '/collections/bar')).toBe('no_store')
    expect(pickCachePreset('DELETE', '/pages/about')).toBe('no_store')
  })

  it('public HTML routes get storefront_html_swr', () => {
    expect(pickCachePreset('GET', '/')).toBe('storefront_html_swr')
    expect(pickCachePreset('GET', '/products/tee-black')).toBe(
      'storefront_html_swr',
    )
    expect(pickCachePreset('GET', '/collections/sale')).toBe(
      'storefront_html_swr',
    )
    expect(pickCachePreset('GET', '/blogs/news/launching')).toBe(
      'storefront_html_swr',
    )
    expect(pickCachePreset('GET', '/pages/about')).toBe('storefront_html_swr')
    expect(pickCachePreset('HEAD', '/products/tee-black')).toBe(
      'storefront_html_swr',
    )
  })

  it('does not mis-route a path that merely contains /cart substring', () => {
    // e.g. /products/shopping-cart-sticker should be public HTML.
    expect(pickCachePreset('GET', '/products/shopping-cart-sticker')).toBe(
      'storefront_html_swr',
    )
  })
})

describe('buildEdgeCacheHeadersMiddleware', () => {
  it('stamps Cache-Control + CDN-Cache-Control on a public HTML GET', () => {
    const mw = buildEdgeCacheHeadersMiddleware()
    const req = makeReq('GET', '/products/tee-black')
    const res = makeRes()
    const next = vi.fn()
    mw(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.headers['Cache-Control']).toContain('must-revalidate')
    expect(res.headers['CDN-Cache-Control']).toContain('max-age=60')
    expect(res.headers['Vary']).toBe('Accept-Language, Cookie')
  })

  it('stamps no-store on /checkout', () => {
    const mw = buildEdgeCacheHeadersMiddleware()
    const req = makeReq('GET', '/checkout')
    const res = makeRes()
    mw(req, res, vi.fn())
    expect(res.headers['Cache-Control']).toBe('no-store')
    expect(res.headers['CDN-Cache-Control']).toBe('no-store')
  })

  it('stamps immutable on /assets/theme.css', () => {
    const mw = buildEdgeCacheHeadersMiddleware()
    const req = makeReq('GET', '/assets/theme.css')
    const res = makeRes()
    mw(req, res, vi.fn())
    expect(res.headers['Cache-Control']).toContain('immutable')
    expect(res.headers['CDN-Cache-Control']).toContain('max-age=31536000')
  })

  it('does NOT stamp any headers on /_health', () => {
    const mw = buildEdgeCacheHeadersMiddleware()
    const req = makeReq('GET', '/_health')
    const res = makeRes()
    mw(req, res, vi.fn())
    expect(res.headers['Cache-Control']).toBeUndefined()
    expect(res.headers['CDN-Cache-Control']).toBeUndefined()
  })

  it('respects bypassPaths option', () => {
    const mw = buildEdgeCacheHeadersMiddleware({
      bypassPaths: ['/special'],
    })
    const req = makeReq('GET', '/special')
    const res = makeRes()
    mw(req, res, vi.fn())
    expect(res.headers['Cache-Control']).toBeUndefined()
  })

  it('always calls next() exactly once per request', () => {
    const mw = buildEdgeCacheHeadersMiddleware()
    const calls: string[] = []
    const cases = [
      ['GET', '/'],
      ['GET', '/assets/theme.css'],
      ['POST', '/cart/add.js'],
      ['POST', '/events'],
      ['GET', '/_health'],
    ]
    for (const [method, path] of cases) {
      const req = makeReq(method!, path!)
      const res = makeRes()
      const next = vi.fn(() => calls.push(`${method} ${path}`))
      mw(req, res, next)
      expect(next).toHaveBeenCalledTimes(1)
    }
    expect(calls).toHaveLength(5)
  })
})
