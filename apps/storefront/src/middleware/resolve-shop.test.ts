/**
 * Gbox Storefront — Host→Shop Resolver tests (Stage 3A.4)
 *
 * The resolver is the first piece of storefront-specific business
 * logic in the request pipeline. Its single job:
 *
 *   Given the incoming Host header, figure out which shop should
 *   render this request, attach its id + slug + currency to the
 *   request, and hand control to the next middleware. If no shop
 *   matches, respond 404 immediately (no body — the later error-
 *   handler stage will replace that with a templated page).
 *
 * Tests cover:
 *
 *   • Host header normalization (strip port, lowercase, strip
 *     trailing dot, strip X-Forwarded-Host support).
 *   • DB lookup path — when an entry exists in shop_domains.
 *   • DB lookup path — fallback to shops.domain / shops.custom_domain.
 *   • Cache path — second hit for the same host skips the DB.
 *   • Miss path — 404 + no cache poisoning.
 *   • Dev fallback — when the host is localhost and env
 *     STOREFRONT_DEV_SHOP_SLUG is set, resolve the shop by slug so
 *     local dev doesn't require fake /etc/hosts entries.
 *   • Unknown-host negative cache (so the same bogus Host doesn't
 *     slam the database on every refresh).
 */

import { describe, it, expect, vi } from 'vitest'
import {
  buildResolveShopMiddleware,
  normalizeHost,
  type ResolvedShop,
  type ShopLookup,
} from './resolve-shop.js'

// ---------------------------------------------------------------------------
// normalizeHost()
// ---------------------------------------------------------------------------

describe('normalizeHost', () => {
  it('returns null for undefined/null/empty', () => {
    expect(normalizeHost(undefined)).toBeNull()
    expect(normalizeHost(null)).toBeNull()
    expect(normalizeHost('')).toBeNull()
  })

  it('lowercases the host', () => {
    expect(normalizeHost('Shop.Gbox.Co')).toBe('shop.gbox.co')
  })

  it('strips the port', () => {
    expect(normalizeHost('shop.gbox.co:4326')).toBe('shop.gbox.co')
  })

  it('strips ipv4 port', () => {
    expect(normalizeHost('127.0.0.1:8080')).toBe('127.0.0.1')
  })

  it('strips a trailing dot (FQDN canonicalization)', () => {
    expect(normalizeHost('shop.gbox.co.')).toBe('shop.gbox.co')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeHost('  shop.gbox.co  ')).toBe('shop.gbox.co')
  })

  it('handles ipv6 by returning the bracketed host (no port)', () => {
    // Express hostname for ipv6 looks like `[::1]` — the port comes
    // from a separate `:NNNN` suffix after the closing bracket.
    expect(normalizeHost('[::1]:4326')).toBe('[::1]')
  })

  it('returns null for values that collapse to an empty string', () => {
    expect(normalizeHost(':4326')).toBeNull()
    expect(normalizeHost('   ')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const DEMO_SHOP: ResolvedShop = {
  id: 'shop_demo_uuid',
  slug: 'demo',
  name: 'Demo Shop',
  currency: 'USD',
  defaultLocale: 'en-US',
  status: 'active',
}

function fakeReq(
  host: string | undefined,
  extraHeaders: Record<string, string> = {},
): {
  headers: Record<string, string | undefined>
  gboxCtx: { id: string; startedAt: number; logger: { warn: () => void; info: () => void; error: () => void } }
  gboxShopId?: string
  gboxShop?: ResolvedShop
} {
  return {
    headers: { host, ...extraHeaders } as Record<string, string | undefined>,
    gboxCtx: {
      id: 'req_test',
      startedAt: Date.now(),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    },
  }
}

function fakeRes(): {
  statusCode: number
  ended: boolean
  body: string
  status(code: number): unknown
  send(body: string): unknown
  type(t: string): unknown
  end(): unknown
} {
  return {
    statusCode: 200,
    ended: false,
    body: '',
    status(code) {
      this.statusCode = code
      return this
    },
    send(body) {
      this.body = body
      this.ended = true
      return this
    },
    type(_t) {
      return this
    },
    end() {
      this.ended = true
      return this
    },
  }
}

// ---------------------------------------------------------------------------
// Happy path — DB hit + cache
// ---------------------------------------------------------------------------

describe('resolve-shop middleware — DB hit path', () => {
  it('looks up the shop by host and attaches it to the request', async () => {
    const lookup: ShopLookup = vi.fn(async (host: string) => {
      return host === 'demo.gbox.test' ? DEMO_SHOP : null
    })
    const mw = buildResolveShopMiddleware({ lookup })

    const req = fakeReq('demo.gbox.test')
    const res = fakeRes()
    const next = vi.fn()

    await mw(req as never, res as never, next)

    expect(lookup).toHaveBeenCalledWith('demo.gbox.test')
    expect(req.gboxShopId).toBe('shop_demo_uuid')
    expect(req.gboxShop).toEqual(DEMO_SHOP)
    expect(next).toHaveBeenCalledWith()
    expect(res.ended).toBe(false)
  })

  it('caches the hit so a second request does not touch the database', async () => {
    const lookup: ShopLookup = vi.fn(async (host: string) => {
      return host === 'demo.gbox.test' ? DEMO_SHOP : null
    })
    const mw = buildResolveShopMiddleware({ lookup })

    const req1 = fakeReq('demo.gbox.test')
    await mw(req1 as never, fakeRes() as never, vi.fn())
    const req2 = fakeReq('demo.gbox.test')
    await mw(req2 as never, fakeRes() as never, vi.fn())

    expect(lookup).toHaveBeenCalledTimes(1)
    expect(req2.gboxShopId).toBe('shop_demo_uuid')
  })

  it('normalizes the host before lookup (port stripped, lowercased)', async () => {
    const lookup: ShopLookup = vi.fn(async () => DEMO_SHOP)
    const mw = buildResolveShopMiddleware({ lookup })

    const req = fakeReq('Demo.Gbox.Test:4326')
    await mw(req as never, fakeRes() as never, vi.fn())

    expect(lookup).toHaveBeenCalledWith('demo.gbox.test')
  })

  it('prefers X-Forwarded-Host when trust proxy is on (nginx hop)', async () => {
    const lookup: ShopLookup = vi.fn(async () => DEMO_SHOP)
    const mw = buildResolveShopMiddleware({ lookup, trustForwardedHost: true })

    const req = fakeReq('localhost:4326', {
      'x-forwarded-host': 'demo.gbox.test',
    })
    await mw(req as never, fakeRes() as never, vi.fn())

    expect(lookup).toHaveBeenCalledWith('demo.gbox.test')
  })

  it('ignores X-Forwarded-Host when trust proxy is off (default)', async () => {
    const lookup: ShopLookup = vi.fn(async () => DEMO_SHOP)
    const mw = buildResolveShopMiddleware({ lookup })

    const req = fakeReq('localhost', {
      'x-forwarded-host': 'attacker.example',
    })
    await mw(req as never, fakeRes() as never, vi.fn())

    expect(lookup).toHaveBeenCalledWith('localhost')
  })
})

// ---------------------------------------------------------------------------
// Miss path
// ---------------------------------------------------------------------------

describe('resolve-shop middleware — miss path', () => {
  it('responds 404 when no shop matches', async () => {
    const lookup: ShopLookup = vi.fn(async () => null)
    const mw = buildResolveShopMiddleware({ lookup })

    const req = fakeReq('unknown.example.com')
    const res = fakeRes()
    const next = vi.fn()

    await mw(req as never, res as never, next)

    expect(res.statusCode).toBe(404)
    expect(res.ended).toBe(true)
    expect(next).not.toHaveBeenCalled()
  })

  it('responds 404 when Host header is missing', async () => {
    const lookup: ShopLookup = vi.fn(async () => DEMO_SHOP)
    const mw = buildResolveShopMiddleware({ lookup })

    const req = fakeReq(undefined)
    const res = fakeRes()
    await mw(req as never, res as never, vi.fn())

    expect(res.statusCode).toBe(404)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('negative-caches an unknown host (second miss does NOT hit the database)', async () => {
    const lookup: ShopLookup = vi.fn(async () => null)
    const mw = buildResolveShopMiddleware({ lookup })

    await mw(fakeReq('unknown.example.com') as never, fakeRes() as never, vi.fn())
    await mw(fakeReq('unknown.example.com') as never, fakeRes() as never, vi.fn())

    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('propagates DB errors via next(err) without caching', async () => {
    const lookup: ShopLookup = vi.fn(async () => {
      throw new Error('connection refused')
    })
    const mw = buildResolveShopMiddleware({ lookup })

    const req = fakeReq('demo.gbox.test')
    const next = vi.fn()
    await mw(req as never, fakeRes() as never, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error)
    // Second call should retry (not cached)
    const next2 = vi.fn()
    await mw(fakeReq('demo.gbox.test') as never, fakeRes() as never, next2)
    expect(lookup).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// Dev fallback
// ---------------------------------------------------------------------------

describe('resolve-shop middleware — dev fallback', () => {
  it('when host is localhost and devShopSlug is set, looks up by slug instead', async () => {
    const lookup: ShopLookup = vi.fn(async () => null)
    const lookupBySlug = vi.fn(async (slug: string) => {
      return slug === 'demo' ? DEMO_SHOP : null
    })
    const mw = buildResolveShopMiddleware({
      lookup,
      lookupBySlug,
      devShopSlug: 'demo',
    })

    const req = fakeReq('localhost:4326')
    await mw(req as never, fakeRes() as never, vi.fn())

    expect(lookupBySlug).toHaveBeenCalledWith('demo')
    expect(req.gboxShopId).toBe('shop_demo_uuid')
  })

  it('also applies the fallback to 127.0.0.1', async () => {
    const lookupBySlug = vi.fn(async () => DEMO_SHOP)
    const mw = buildResolveShopMiddleware({
      lookup: vi.fn(async () => null),
      lookupBySlug,
      devShopSlug: 'demo',
    })

    const req = fakeReq('127.0.0.1:4326')
    await mw(req as never, fakeRes() as never, vi.fn())

    expect(lookupBySlug).toHaveBeenCalled()
    expect(req.gboxShop).toEqual(DEMO_SHOP)
  })

  it('does NOT apply the fallback to non-local hosts', async () => {
    const lookupBySlug = vi.fn(async () => DEMO_SHOP)
    const mw = buildResolveShopMiddleware({
      lookup: vi.fn(async () => null),
      lookupBySlug,
      devShopSlug: 'demo',
    })

    const req = fakeReq('evil.example.com')
    const res = fakeRes()
    await mw(req as never, res as never, vi.fn())

    expect(lookupBySlug).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(404)
  })

  it('does nothing when devShopSlug is not configured', async () => {
    const mw = buildResolveShopMiddleware({
      lookup: vi.fn(async () => null),
    })

    const req = fakeReq('localhost:4326')
    const res = fakeRes()
    await mw(req as never, res as never, vi.fn())

    expect(res.statusCode).toBe(404)
  })
})
