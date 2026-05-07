/**
 * Gbox Platform — Express adapter tests
 *
 * Decision #1 Step 1.14. Cover the structural Express request →
 * StorefrontRequestContext conversion and the middleware shim that
 * forwards `handleStorefrontRequest` results back through
 * `res.status().set().send()`.
 */

import { describe, it, expect, vi } from 'vitest'
import { createLiquidEngine } from '../liquid.js'
import { MemoryI18nService } from '../../../i18n/index.js'
import type {
  LoadResult,
  LogicalPath,
  TemplateLoader,
} from '../loader.js'
import {
  createExpressStorefrontHandler,
  expressToStorefrontContext,
  type ExpressLikeRequest,
  type ExpressLikeResponse,
} from './express-adapter.js'
import { MemoryDataSource } from './datasource.js'

class MemoryLoader implements TemplateLoader {
  readonly name = 'memory'
  constructor(public readonly files: Record<string, string> = {}) {}
  async load(p: LogicalPath): Promise<string | null> {
    return this.files[p] ?? null
  }
  async loadWithMeta(p: LogicalPath): Promise<LoadResult | null> {
    const src = this.files[p]
    return src === undefined ? null : { source: src }
  }
  async exists(p: LogicalPath): Promise<boolean> {
    return p in this.files
  }
  async list(prefix = ''): Promise<LogicalPath[]> {
    return Object.keys(this.files).filter((k) => k.startsWith(prefix))
  }
}

function fakeRes(): ExpressLikeResponse & {
  _status?: number
  _headers?: Record<string, string>
  _body?: string
} {
  const res: any = {}
  res.status = (code: number) => {
    res._status = code
    return res
  }
  res.set = (h: Record<string, string>) => {
    res._headers = h
    return res
  }
  res.send = (body: string) => {
    res._body = body
    return res
  }
  return res
}

// ---------------------------------------------------------------------------
// expressToStorefrontContext
// ---------------------------------------------------------------------------

describe('expressToStorefrontContext', () => {
  it('uppercases method, defaults to GET', () => {
    const ctx = expressToStorefrontContext({
      method: 'get',
      path: '/foo',
      query: {},
      headers: {},
    } as ExpressLikeRequest)
    expect(ctx.method).toBe('GET')
  })

  it('ensures leading slash on path', () => {
    const ctx = expressToStorefrontContext({
      method: 'GET',
      path: 'foo',
      query: {},
      headers: {},
    } as ExpressLikeRequest)
    expect(ctx.path).toBe('/foo')
  })

  it('collapses array query params to first value', () => {
    const ctx = expressToStorefrontContext({
      method: 'GET',
      path: '/',
      query: { tags: ['a', 'b'] },
      headers: {},
    } as ExpressLikeRequest)
    expect(ctx.query).toEqual({ tags: 'a' })
  })

  it('lowercases header keys', () => {
    const ctx = expressToStorefrontContext({
      method: 'GET',
      path: '/',
      query: {},
      headers: { 'Accept-Language': 'vi,en' },
    } as ExpressLikeRequest)
    expect(ctx.headers['accept-language']).toBe('vi,en')
  })

  it('extracts host from req.hostname', () => {
    const ctx = expressToStorefrontContext({
      method: 'GET',
      path: '/',
      query: {},
      headers: {},
      hostname: 'shop.gbox.test',
    } as ExpressLikeRequest)
    expect(ctx.host).toBe('shop.gbox.test')
  })

  it('falls back to x-forwarded-host header', () => {
    const ctx = expressToStorefrontContext({
      method: 'GET',
      path: '/',
      query: {},
      headers: { 'x-forwarded-host': 'a.example, b.example' },
    } as ExpressLikeRequest)
    expect(ctx.host).toBe('a.example')
  })

  it('detects design_mode from query and header', () => {
    const a = expressToStorefrontContext({
      method: 'GET',
      path: '/',
      query: { design_mode: 'true' },
      headers: {},
    } as ExpressLikeRequest)
    expect(a.designMode).toBe(true)
    const b = expressToStorefrontContext({
      method: 'GET',
      path: '/',
      query: {},
      headers: { 'x-gbox-design-mode': 'true' },
    } as ExpressLikeRequest)
    expect(b.designMode).toBe(true)
  })

  it('forwards gboxShopId when present', () => {
    const ctx = expressToStorefrontContext({
      method: 'GET',
      path: '/',
      query: {},
      headers: {},
      gboxShopId: 'shop_x',
    } as ExpressLikeRequest)
    expect(ctx.shopId).toBe('shop_x')
  })
})

// ---------------------------------------------------------------------------
// createExpressStorefrontHandler
// ---------------------------------------------------------------------------

describe('createExpressStorefrontHandler', () => {
  it('writes status, headers, and body via Express res chain', async () => {
    const engine = createLiquidEngine({
      loader: new MemoryLoader({
        'layout/theme.liquid': '<html>{{ content_for_layout }}</html>',
        'templates/index.liquid': 'INDEX',
      }),
      i18n: new MemoryI18nService(),
    })
    const handler = createExpressStorefrontHandler({
      engine,
      datasource: new MemoryDataSource({
        shop: { id: 'shop_memory', name: 'Acme' },
      }),
    })
    const res = fakeRes()
    const next = vi.fn()
    await handler(
      {
        method: 'GET',
        path: '/',
        query: {},
        headers: {},
        cookies: {},
      } as ExpressLikeRequest,
      res,
      next,
    )
    expect(res._status).toBe(200)
    expect(res._headers?.['content-type']).toContain('text/html')
    expect(res._body).toContain('INDEX')
    expect(next).not.toHaveBeenCalled()
  })

  it('forwards unexpected throws to next(err)', async () => {
    // Build a real engine but a fake request whose `headers` property
    // throws on access — that bypasses the router's catch (which only
    // wraps the loader / render path) and lets the adapter's outer
    // try/catch forward to next().
    const engine = createLiquidEngine({
      loader: new MemoryLoader({
        'layout/theme.liquid': '<html>{{ content_for_layout }}</html>',
        'templates/index.liquid': 'INDEX',
      }),
      i18n: new MemoryI18nService(),
    })
    const handler = createExpressStorefrontHandler({
      engine,
      datasource: new MemoryDataSource({
        shop: { id: 'shop_memory', name: 'Acme' },
      }),
    })
    const res = fakeRes()
    const next = vi.fn()
    const evilReq: any = {
      method: 'GET',
      path: '/',
      query: {},
      cookies: {},
    }
    Object.defineProperty(evilReq, 'headers', {
      get() {
        throw new Error('synthetic header read failure')
      },
    })
    await handler(evilReq, res, next)
    expect(next).toHaveBeenCalled()
  })
})
