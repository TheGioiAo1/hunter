/**
 * Gbox Storefront — Handler Wrapper tests (Stage 3A.8)
 *
 * These tests exercise `buildStorefrontHandler` in isolation — no
 * Express app, no HTTP server, no theme engine. We feed it a fake
 * `StorefrontHandlerOptions` whose `datasource` is a
 * `MemoryDataSource` and whose `engine` is a stub that records the
 * render call and returns a canned body.
 *
 * The point is to pin down:
 *
 *   1. The wrapper converts Express request shapes into the
 *      framework-agnostic `StorefrontRequestContext`.
 *   2. The wrapper rewrites `ctx.path` so the chosen locale (from
 *      `req.gboxLocale`) becomes a URL prefix the core router's
 *      first negotiation branch will latch onto.
 *   3. The wrapper adds the chosen locale to `opts.locales.supported`
 *      when it isn't already there (otherwise the router would
 *      reject the URL prefix).
 *   4. A `null` return from `getHandlerOptions` produces a plain
 *      404 without touching the core router.
 *   5. Thrown errors from `getHandlerOptions` forward to `next(err)`.
 *
 * End-to-end rendering with the real Liquid engine + the Gbox Dawn
 * seed theme lives in `app.integration.test.ts` — this file only
 * proves the wrapper's glue logic.
 */

import { describe, it, expect, vi } from 'vitest'
import { buildStorefrontHandler } from './handler.js'
import type {
  StorefrontHandlerOptions,
  StorefrontRequestContext,
  StorefrontResponse,
} from '@gbox/core/modules/themes/engine/storefront/index.js'

// ---------------------------------------------------------------------------
// Fake options builder
// ---------------------------------------------------------------------------

/**
 * Build a `StorefrontHandlerOptions` whose engine just records the
 * render call and returns a string. The datasource / router plumbing
 * are bypassed via a stub of `opts.engine` that records the context
 * passed into it. We can't stub `handleStorefrontRequest` directly
 * (it's imported inside the wrapper), so instead we use a real
 * `MemoryDataSource` and a fake Liquid engine that always returns
 * the same body.
 */
function mkFakeHandlerOptions(): {
  opts: StorefrontHandlerOptions
  rendered: { body: string; calls: number }
} {
  // We need a real-looking engine because the router destructures it.
  // A minimal stub with the two methods renderPage + renderSections
  // use is enough. Luckily the router only touches opts.engine via
  // those functions, which accept a `LiquidEngine` but otherwise are
  // pure; we replace them for tests.
  //
  // Simpler approach: we stub opts at the boundary and bypass
  // `handleStorefrontRequest` entirely by providing our own
  // `getHandlerOptions` that records and returns null, PLUS a
  // separate path that exercises the happy rendering branch via
  // the real `handleStorefrontRequest` over an
  // in-memory datasource.
  //
  // For the simple assertions below we just check how our wrapper
  // normalises the context — those tests don't need a real engine.
  const rendered = { body: '', calls: 0 }
  const fakeEngine = {
    liquid: {
      parseAndRender: async () => {
        rendered.calls++
        return '<html>fake</html>'
      },
    },
  } as unknown as StorefrontHandlerOptions['engine']

  // MemoryDataSource with a single product and a single collection.
  // The router will pull shop / customer / cart on every request.
  const opts: StorefrontHandlerOptions = {
    engine: fakeEngine,
    datasource: {
      defaultShopId: () => 'shop_1',
      async loadShop() {
        return { id: 'shop_1', name: 'Fake' }
      },
      async loadCustomerBySession() {
        return null
      },
      async loadCart() {
        return { item_count: 0, total_price: 0, items: [] }
      },
      async loadProductByHandle() {
        return null
      },
      async loadCollectionByHandle() {
        return null
      },
      async loadCollectionProducts() {
        return { products: [], total: 0 }
      },
      async loadAllCollections() {
        return []
      },
      // Router's index-route loader calls `ds.listCollections(ctx)`
      // inside a Promise.all. If this method is missing, the Promise.all
      // argument evaluation throws a TypeError before the Promise.all
      // is constructed, which orphans the already-created `loadShop`
      // rejected promise (no handler attached) → unhandled rejection.
      async listCollections() {
        return []
      },
      async loadPageByHandle() {
        return null
      },
      async loadPolicyByHandle() {
        return null
      },
      async loadBlogByHandle() {
        return null
      },
      async loadBlogArticles() {
        return { articles: [], total: 0 }
      },
      async loadArticleByHandle() {
        return null
      },
      async loadGiftCardById() {
        return null
      },
      async search() {
        return { results: [] }
      },
    } as unknown as StorefrontHandlerOptions['datasource'],
    locales: { supported: ['en'], default: 'en' },
  }

  return { opts, rendered }
}

// ---------------------------------------------------------------------------
// Fake req / res
// ---------------------------------------------------------------------------

interface FakeReq {
  method: string
  url: string
  path: string
  query: Record<string, unknown>
  headers: Record<string, string | undefined>
  cookies?: Record<string, string>
  hostname?: string
  gboxShop?: { id: string; defaultLocale: string } | undefined
  gboxShopId?: string
  gboxLocale?: { locale: string; strippedPath: string }
}

function mkReq(overrides: Partial<FakeReq> = {}): FakeReq {
  return {
    method: 'GET',
    url: '/',
    path: '/',
    query: {},
    headers: { host: 'demo.gbox.test' },
    cookies: {},
    hostname: 'demo.gbox.test',
    gboxShop: { id: 'shop_1', defaultLocale: 'en' },
    gboxShopId: 'shop_1',
    gboxLocale: { locale: 'en', strippedPath: '/' },
    ...overrides,
  }
}

interface FakeRes {
  statusCode: number
  headers: Record<string, string>
  body: string
  ended: boolean
  status(code: number): FakeRes
  set(name: string, value: string): FakeRes
  type(t: string): FakeRes
  send(body: string): FakeRes
}

function mkRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    headers: {},
    body: '',
    ended: false,
    status(code) {
      this.statusCode = code
      return this
    },
    set(name, value) {
      this.headers[name.toLowerCase()] = value
      return this
    },
    type(t) {
      this.headers['content-type'] = t
      return this
    },
    send(body) {
      this.body = body
      this.ended = true
      return this
    },
  }
  return res
}

// ---------------------------------------------------------------------------
// Null options → 404
// ---------------------------------------------------------------------------

describe('buildStorefrontHandler — null options', () => {
  it('returns 404 when getHandlerOptions returns null', async () => {
    const mw = buildStorefrontHandler({
      getHandlerOptions: () => null,
    })
    const req = mkReq()
    const res = mkRes()
    const next = vi.fn()
    await mw(req as never, res as never, next)
    expect(res.statusCode).toBe(404)
    expect(res.body).toContain('404')
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 404 when getHandlerOptions resolves to null (async)', async () => {
    const mw = buildStorefrontHandler({
      getHandlerOptions: async () => null,
    })
    const res = mkRes()
    await mw(mkReq() as never, res as never, vi.fn())
    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

describe('buildStorefrontHandler — errors', () => {
  it('forwards errors from getHandlerOptions via next(err)', async () => {
    const err = new Error('theme lookup failed')
    const mw = buildStorefrontHandler({
      getHandlerOptions: () => {
        throw err
      },
    })
    const next = vi.fn()
    await mw(mkReq() as never, mkRes() as never, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0]).toBe(err)
  })

  it('forwards errors thrown from async getHandlerOptions', async () => {
    const err = new Error('db timeout')
    const mw = buildStorefrontHandler({
      getHandlerOptions: async () => {
        throw err
      },
    })
    const next = vi.fn()
    await mw(mkReq() as never, mkRes() as never, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0]).toBe(err)
  })
})

// ---------------------------------------------------------------------------
// Delegation + context shaping
// ---------------------------------------------------------------------------

describe('buildStorefrontHandler — delegation', () => {
  /**
   * Swap in a spy that records the options + context passed to
   * `handleStorefrontRequest`. We intercept by providing our own
   * `getHandlerOptions` that returns a stub `opts` whose
   * `datasource.loadShop` captures the context — the router calls
   * it on every request before ever touching the engine.
   */
  function spyOnContext(): {
    deps: { getHandlerOptions: () => StorefrontHandlerOptions }
    seen: {
      shopId?: string
      path?: string
      locale?: string
      cartToken?: string | undefined
      sessionToken?: string | undefined
      errorReportShopId?: string
    }
  } {
    const seen: {
      shopId?: string
      path?: string
      locale?: string
      cartToken?: string | undefined
      sessionToken?: string | undefined
      errorReportShopId?: string
    } = {}

    // Minimal datasource: records each call that receives the
    // request-scoped values we care about. loadShop throws to
    // short-circuit before any template rendering runs.
    const datasource = {
      defaultShopId: () => 'shop_1',
      async loadShop(ctx: { shopId: string; locale: string }) {
        seen.shopId = ctx.shopId
        seen.locale = ctx.locale
        throw new Error('stop-here')
      },
      async loadCustomerBySession(sessionToken: string | undefined) {
        seen.sessionToken = sessionToken
        return null
      },
      async loadCart(cartToken: string | undefined) {
        seen.cartToken = cartToken
        return { item_count: 0, total_price: 0, items: [] }
      },
      async loadProductByHandle() {
        return null
      },
      async loadCollectionByHandle() {
        return null
      },
      async loadCollectionProducts() {
        return { products: [], total: 0 }
      },
      async loadAllCollections() {
        return []
      },
      // Router's index-route loader calls `ds.listCollections(ctx)`
      // inside a Promise.all. If this method is missing, the Promise.all
      // argument evaluation throws a TypeError before the Promise.all
      // is constructed, which orphans the already-created `loadShop`
      // rejected promise (no handler attached) → unhandled rejection.
      async listCollections() {
        return []
      },
      async loadPageByHandle() {
        return null
      },
      async loadPolicyByHandle() {
        return null
      },
      async loadBlogByHandle() {
        return null
      },
      async loadBlogArticles() {
        return { articles: [], total: 0 }
      },
      async loadArticleByHandle() {
        return null
      },
      async loadGiftCardById() {
        return null
      },
      async search() {
        return { results: [] }
      },
    }

    // Bare engine stub — loadShop throws before the engine is
    // ever touched by the happy-path render branch.
    const engine = { liquid: {} } as unknown as StorefrontHandlerOptions['engine']

    // errorLogger.report() is what the core router actually calls
    // on the 500 path. It receives { error, status, path, method,
    // shopId } — we use `path` here as a round-trip assertion
    // that our wrapper's path rewriting made it into the router.
    const errorLogger = {
      report(input: { path: string; shopId?: string }) {
        seen.path = input.path
        seen.errorReportShopId = input.shopId
      },
    }

    return {
      deps: {
        getHandlerOptions: () => ({
          engine,
          datasource:
            datasource as unknown as StorefrontHandlerOptions['datasource'],
          errorLogger:
            errorLogger as unknown as StorefrontHandlerOptions['errorLogger'],
          locales: { supported: ['en'], default: 'en' },
        }),
      },
      seen,
    }
  }

  it('hands the request shopId to the datasource via the router', async () => {
    const { deps, seen } = spyOnContext()
    const mw = buildStorefrontHandler(deps)
    await mw(
      mkReq({ gboxShopId: 'shop_42' }) as never,
      mkRes() as never,
      vi.fn(),
    )
    expect(seen.shopId).toBe('shop_42')
  })

  it('builds the router path with the locale prefix (cookie-chosen vi)', async () => {
    const { deps, seen } = spyOnContext()
    const mw = buildStorefrontHandler({
      getHandlerOptions: () => {
        const base = deps.getHandlerOptions()
        return {
          ...base,
          locales: { supported: ['en', 'vi'], default: 'en' },
        }
      },
    })
    await mw(
      mkReq({
        path: '/products/shirt',
        url: '/products/shirt',
        gboxLocale: { locale: 'vi', strippedPath: '/products/shirt' },
      }) as never,
      mkRes() as never,
      vi.fn(),
    )
    // The router re-negotiates off the path; our wrapper must
    // have prefixed with `/vi` so the router's URL-prefix branch
    // picks `vi` and produces the same locale we already chose.
    expect(seen.locale).toBe('vi')
    // errorLogger.report() receives the raw request path (before
    // the router strips the locale prefix) — proves our wrapper
    // DID prepend the `/vi` prefix the router picks up.
    expect(seen.path).toBe('/vi/products/shirt')
  })

  it('auto-adds the chosen locale to opts.locales.supported when missing', async () => {
    // Caller provides locales that DO NOT include 'vi'. Wrapper
    // should silently extend supported so the router's URL-prefix
    // branch accepts our rewritten path.
    const { deps, seen } = spyOnContext()
    const mw = buildStorefrontHandler(deps)
    await mw(
      mkReq({
        path: '/products/shirt',
        gboxLocale: { locale: 'vi', strippedPath: '/products/shirt' },
      }) as never,
      mkRes() as never,
      vi.fn(),
    )
    // If the wrapper didn't extend supported, the URL-prefix step
    // would miss and 'vi' would never flow into the datasource ctx.
    expect(seen.locale).toBe('vi')
  })

  it('passes cart and session cookie tokens through to the datasource', async () => {
    const { deps, seen } = spyOnContext()
    const mw = buildStorefrontHandler(deps)
    await mw(
      mkReq({
        cookies: { cart: 'ct_abc', _session: 'sess_xyz' },
      }) as never,
      mkRes() as never,
      vi.fn(),
    )
    // These are the only cookies the storefront router currently
    // reads, so proving they reach the datasource proves the
    // cookie bag round-trips through the context builder.
    expect(seen.cartToken).toBe('ct_abc')
    expect(seen.sessionToken).toBe('sess_xyz')
  })

  it('reports the errored path back through errorLogger.report', async () => {
    const { deps, seen } = spyOnContext()
    const mw = buildStorefrontHandler(deps)
    await mw(
      mkReq({
        path: '/products/hat',
        gboxLocale: { locale: 'en', strippedPath: '/products/hat' },
      }) as never,
      mkRes() as never,
      vi.fn(),
    )
    // errorLogger.report() sees the raw (locale-prefixed) path the
    // wrapper built, which proves the rewrite happened.
    expect(seen.path).toBe('/en/products/hat')
    expect(seen.errorReportShopId).toBe('shop_1')
  })
})
