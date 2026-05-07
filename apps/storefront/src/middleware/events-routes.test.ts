/**
 * Gbox Storefront — Events beacon routes tests (Stage 3E.3)
 *
 * Covers the single endpoint:
 *
 *   POST /events     Client-side analytics beacon. Theme JS or
 *                    merchant-custom JS posts {type, ...} here to
 *                    record events the server can't observe on
 *                    its own (e.g. product carousel click,
 *                    video play, time-on-page ping).
 *
 * The route is the last place to validate the verb — we use the
 * same `STOREFRONT_EVENT_VERBS` allowlist the recorder uses so
 * a typo in the theme JS fails loudly instead of silently
 * polluting the funnel.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { buildRequestContextMiddleware } from './request-context.js'
import { buildResolveShopMiddleware } from './resolve-shop.js'
import { buildCookieMiddleware } from './cookies.js'
import { buildEventsRoutes } from './events-routes.js'
import type { ResolvedShop } from './resolve-shop.js'

// ---------------------------------------------------------------------------
// Fixtures + stubs
// ---------------------------------------------------------------------------

const DEMO_SHOP: ResolvedShop = {
  id: 'shop_demo',
  slug: 'demo',
  name: 'Demo',
  currency: 'USD',
  defaultLocale: 'en',
  status: 'active',
}

let server: Server
let baseUrl: string
let recordPageView: ReturnType<typeof vi.fn>
let recordAddToCart: ReturnType<typeof vi.fn>
let recordCheckoutStart: ReturnType<typeof vi.fn>
let recordPurchase: ReturnType<typeof vi.fn>

beforeAll(async () => {
  const app = express()
  app.use(buildRequestContextMiddleware({ serviceName: 'gbox-storefront' }))
  app.use(
    buildResolveShopMiddleware({
      lookup: async (host) => (host === 'demo.gbox.test' ? DEMO_SHOP : null),
      trustForwardedHost: true,
    }),
  )
  app.use(buildCookieMiddleware({}))
  app.use((req, _res, next) => {
    const cid = req.headers['x-test-customer-id']
    if (typeof cid === 'string') (req as any).gboxCustomerId = cid
    next()
  })
  app.use((req, res, next) =>
    buildEventsRoutes({
      recordPageView: (...a: any[]) => recordPageView(...a),
      recordAddToCart: (...a: any[]) => recordAddToCart(...a),
      recordCheckoutStart: (...a: any[]) => recordCheckoutStart(...a),
      recordPurchase: (...a: any[]) => recordPurchase(...a),
    })(req, res, next),
  )

  server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
})

beforeEach(() => {
  recordPageView = vi.fn(async () => {})
  recordAddToCart = vi.fn(async () => {})
  recordCheckoutStart = vi.fn(async () => {})
  recordPurchase = vi.fn(async () => {})
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function postJson(
  body: unknown,
  opts: { cookie?: string; customerId?: string; host?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-host': opts.host ?? 'demo.gbox.test',
  }
  if (opts.cookie) headers['cookie'] = opts.cookie
  if (opts.customerId) headers['x-test-customer-id'] = opts.customerId
  return fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// Positive path
// ---------------------------------------------------------------------------

describe('POST /events — valid events', () => {
  it('accepts page_view and returns 204 No Content', async () => {
    const res = await postJson(
      { type: 'page_view', path: '/products/cap' },
      { cookie: 'cart=cart_token' },
    )
    expect(res.status).toBe(204)
    expect(recordPageView).toHaveBeenCalledTimes(1)
    const call = recordPageView.mock.calls[0]
    expect(call[0]).toBe('shop_demo')
    expect(call[1]).toMatchObject({
      path: '/products/cap',
      sessionId: 'cart_token',
    })
  })

  it('accepts add_to_cart with variant + product + quantity + price', async () => {
    const res = await postJson(
      {
        type: 'add_to_cart',
        variant_id: 'v1',
        product_id: 'p1',
        quantity: 2,
        price: '19.99',
        currency: 'USD',
      },
      { cookie: 'cart=sess' },
    )
    expect(res.status).toBe(204)
    expect(recordAddToCart).toHaveBeenCalledTimes(1)
    expect(recordAddToCart.mock.calls[0][1]).toMatchObject({
      variantId: 'v1',
      productId: 'p1',
      quantity: 2,
      price: '19.99',
      currency: 'USD',
      sessionId: 'sess',
    })
  })

  it('accepts checkout_start with checkout_id + total', async () => {
    const res = await postJson(
      {
        type: 'checkout_start',
        checkout_id: 'chk_1',
        total: '49.99',
        currency: 'USD',
        item_count: 3,
      },
      { cookie: 'cart=sess' },
    )
    expect(res.status).toBe(204)
    expect(recordCheckoutStart.mock.calls[0][1]).toMatchObject({
      checkoutId: 'chk_1',
      total: '49.99',
      currency: 'USD',
      itemCount: 3,
      sessionId: 'sess',
    })
  })

  it('accepts purchase with order_id + total', async () => {
    const res = await postJson(
      {
        type: 'purchase',
        order_id: 'ord_1',
        total: '49.99',
        currency: 'USD',
        item_count: 3,
      },
      { cookie: 'cart=sess' },
    )
    expect(res.status).toBe(204)
    expect(recordPurchase.mock.calls[0][1]).toMatchObject({
      orderId: 'ord_1',
      total: '49.99',
      currency: 'USD',
      itemCount: 3,
      sessionId: 'sess',
    })
  })

  it('forwards the customer id from req.gboxCustomerId', async () => {
    await postJson(
      { type: 'page_view', path: '/' },
      { cookie: 'cart=sess', customerId: 'cus_alice' },
    )
    expect(recordPageView.mock.calls[0][1].customerId).toBe('cus_alice')
  })

  it('uses the request id as fallback session id when no cart cookie', async () => {
    const res = await postJson({ type: 'page_view', path: '/' })
    const reqId = res.headers.get('x-request-id')
    expect(recordPageView.mock.calls[0][1].sessionId).toBe(reqId)
  })
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('POST /events — validation', () => {
  it('rejects an unknown verb with 400', async () => {
    const res = await postJson({ type: 'hack_attempt' })
    expect(res.status).toBe(400)
    expect(recordPageView).not.toHaveBeenCalled()
  })

  it('rejects a missing type with 400', async () => {
    const res = await postJson({ path: '/' })
    expect(res.status).toBe(400)
  })

  it('rejects a non-JSON body with 400', async () => {
    const res = await fetch(`${baseUrl}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'x-forwarded-host': 'demo.gbox.test',
      },
      body: 'plain text',
    })
    expect(res.status).toBe(400)
  })

  it('rejects page_view without a path with 400', async () => {
    const res = await postJson({ type: 'page_view' })
    expect(res.status).toBe(400)
  })

  it('rejects add_to_cart without variant_id with 400', async () => {
    const res = await postJson({
      type: 'add_to_cart',
      product_id: 'p1',
      quantity: 1,
      price: '1',
      currency: 'USD',
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 when host does not resolve to a shop', async () => {
    const res = await postJson(
      { type: 'page_view', path: '/' },
      { host: 'nobody.gbox.test' },
    )
    // resolve-shop intercepts first.
    expect([404, 400]).toContain(res.status)
  })
})

// ---------------------------------------------------------------------------
// Defensive: recorder exceptions are swallowed
// ---------------------------------------------------------------------------

describe('POST /events — fault tolerance', () => {
  it('returns 204 even when the recorder throws', async () => {
    recordPageView.mockRejectedValueOnce(new Error('db down'))
    const res = await postJson(
      { type: 'page_view', path: '/' },
      { cookie: 'cart=sess' },
    )
    expect(res.status).toBe(204)
  })
})
