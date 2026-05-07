/**
 * Gbox Storefront — Error Handler Middleware tests (Stage 3A.9)
 *
 * Exercises `buildErrorMiddleware` and `buildNotFoundMiddleware` in
 * isolation with fake req/res objects — no Express app, no HTTP
 * socket. End-to-end wiring (error handler installed last in
 * `buildApp` and triggered by a throwing storefront handler) lives
 * in `app.integration.test.ts`.
 *
 * What we pin down here:
 *
 *   1. When `getHandlerOptions` resolves to an options bundle with
 *      a `500.liquid` template, the error middleware renders that
 *      template via `handleStorefrontRequest` and responds 500
 *      with `content-type: text/html`.
 *   2. When no options are available (null / undefined deps), the
 *      middleware returns a plain-text 500.
 *   3. If rendering itself throws, the middleware never re-throws:
 *      it falls back to plain text and continues.
 *   4. Logger receives every caught error exactly once.
 *   5. `buildNotFoundMiddleware` returns the templated 404 when
 *      options are available, and plain-text when not.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  buildErrorMiddleware,
  buildNotFoundMiddleware,
} from './error-handler.js'
import type { StorefrontHandlerOptions } from '@gbox/core/modules/themes/engine/storefront/index.js'

// ---------------------------------------------------------------------------
// Fake req/res
// ---------------------------------------------------------------------------

interface FakeReq {
  method: string
  url: string
  path: string
  query: Record<string, unknown>
  headers: Record<string, string | undefined>
  cookies?: Record<string, string>
  hostname?: string
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
  headersSent: boolean
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
    headersSent: false,
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
      this.headersSent = true
      return this
    },
  }
  return res
}

// ---------------------------------------------------------------------------
// Fake StorefrontHandlerOptions — minimal but enough to survive
// `handleStorefrontRequest`'s 500 render branch.
// ---------------------------------------------------------------------------

function mkTemplatedOptions(): StorefrontHandlerOptions {
  // We fake the engine so render500 reaches parseAndRender and
  // returns our canned HTML string. `handleStorefrontRequest` calls
  // the datasource to load shop/customer/cart for the 500 drop, so
  // stub those to return harmless shapes.
  const fakeEngine = {
    liquid: {
      parseAndRender: async (_src: string) => '<html>500 TEMPLATED</html>',
    },
    loader: {
      async load(p: string) {
        if (p === 'templates/500.liquid') {
          return '{{ error_message }}'
        }
        if (p === 'layout/theme.liquid') {
          return '<html>{{ content_for_layout }}</html>'
        }
        return null
      },
      async loadWithMeta(p: string) {
        const src = await this.load(p)
        return src === null ? null : { source: src }
      },
      async exists(p: string) {
        return (await this.load(p)) !== null
      },
      async list() {
        return []
      },
    },
  } as unknown as StorefrontHandlerOptions['engine']

  const datasource = {
    defaultShopId: () => 'shop_1',
    async loadShop() {
      return { id: 'shop_1', name: 'Demo' }
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

  return {
    engine: fakeEngine,
    datasource: datasource as unknown as StorefrontHandlerOptions['datasource'],
    locales: { supported: ['en'], default: 'en' },
  }
}

// ---------------------------------------------------------------------------
// Error middleware
// ---------------------------------------------------------------------------

describe('buildErrorMiddleware', () => {
  it('renders a plain-text 500 when no getHandlerOptions is provided', async () => {
    const mw = buildErrorMiddleware({})
    const req = mkReq()
    const res = mkRes()
    const err = new Error('boom')
    await mw(err, req as never, res as never, vi.fn())
    expect(res.statusCode).toBe(500)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.body).toContain('500')
  })

  it('renders a plain-text 500 when getHandlerOptions returns null', async () => {
    const mw = buildErrorMiddleware({
      getHandlerOptions: () => null,
    })
    const res = mkRes()
    await mw(new Error('boom'), mkReq() as never, res as never, vi.fn())
    expect(res.statusCode).toBe(500)
    expect(res.headers['content-type']).toContain('text/plain')
  })

  it('renders the 500 template when getHandlerOptions returns options with a 500.liquid', async () => {
    const mw = buildErrorMiddleware({
      getHandlerOptions: () => mkTemplatedOptions(),
    })
    const res = mkRes()
    await mw(new Error('boom'), mkReq() as never, res as never, vi.fn())
    expect(res.statusCode).toBe(500)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('500 TEMPLATED')
  })

  it('falls back to plain-text 500 when rendering itself throws', async () => {
    const mw = buildErrorMiddleware({
      getHandlerOptions: () => {
        throw new Error('theme lookup failed')
      },
    })
    const res = mkRes()
    await mw(new Error('boom'), mkReq() as never, res as never, vi.fn())
    expect(res.statusCode).toBe(500)
    expect(res.headers['content-type']).toContain('text/plain')
  })

  it('invokes the caller-supplied logger once with the caught error', async () => {
    const logger = { error: vi.fn() }
    const mw = buildErrorMiddleware({ logger })
    const err = new Error('boom')
    await mw(err, mkReq() as never, mkRes() as never, vi.fn())
    expect(logger.error).toHaveBeenCalledTimes(1)
    const call = logger.error.mock.calls[0]
    // First arg is a bag with `err` set.
    expect((call[0] as { err: unknown }).err).toBe(err)
  })

  it('delegates to next(err) once response headers have already been sent', async () => {
    const mw = buildErrorMiddleware({})
    const res = mkRes()
    res.headersSent = true
    const next = vi.fn()
    const err = new Error('late')
    await mw(err, mkReq() as never, res as never, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0]).toBe(err)
    // Must not try to write a body after headers went out.
    expect(res.body).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Not-found middleware
// ---------------------------------------------------------------------------

describe('buildNotFoundMiddleware', () => {
  it('renders a plain-text 404 when no getHandlerOptions is provided', async () => {
    const mw = buildNotFoundMiddleware({})
    const req = mkReq({ path: '/nope', url: '/nope' })
    const res = mkRes()
    await mw(req as never, res as never, vi.fn())
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.body).toContain('404')
  })

  it('renders a plain-text 404 when getHandlerOptions returns null', async () => {
    const mw = buildNotFoundMiddleware({
      getHandlerOptions: () => null,
    })
    const res = mkRes()
    await mw(mkReq() as never, res as never, vi.fn())
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('text/plain')
  })

  it('delegates the rendered 404 template when options are available', async () => {
    // For 404, the fake loader needs `templates/404.liquid`.
    const base = mkTemplatedOptions()
    const loader = (base.engine as unknown as {
      loader: {
        load: (p: string) => Promise<string | null>
        loadWithMeta: (p: string) => Promise<{ source: string } | null>
      }
    }).loader
    const originalLoad = loader.load.bind(loader)
    loader.load = async (p: string) => {
      if (p === 'templates/404.liquid') return '<html>404 TEMPLATED</html>'
      return originalLoad(p)
    }
    loader.loadWithMeta = async (p: string) => {
      const src = await loader.load(p)
      return src === null ? null : { source: src }
    }
    ;(
      base.engine as unknown as {
        liquid: {
          parseAndRender: (
            s: string,
            ctx: Record<string, unknown>,
          ) => Promise<string>
        }
      }
    ).liquid.parseAndRender = async (src, ctx) => {
      // Minimal Liquid substitution: replace `{{ content_for_layout }}`
      // with the value from `ctx` so the layout wrap-up step in
      // `renderErrorTemplate` produces a visible result.
      const inner = (ctx['content_for_layout'] as string | undefined) ?? ''
      return src.replace('{{ content_for_layout }}', inner)
    }
    const mw = buildNotFoundMiddleware({
      getHandlerOptions: () => base,
    })
    const res = mkRes()
    await mw(
      mkReq({ path: '/nope', url: '/nope' }) as never,
      res as never,
      vi.fn(),
    )
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('404 TEMPLATED')
  })
})
