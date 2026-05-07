/**
 * Gbox Storefront — Tracking hooks integration tests (Stage 3E.4)
 *
 * Verifies that the optional analytics hooks wired into
 * `cart-routes.ts` (`onLineAdded`) and `checkout-routes.ts`
 * (`onCheckoutStart`) fire after the mutation succeeds.
 *
 * Uses an in-memory cart store (re-implemented tiny) and a stub
 * createCheckout, so these tests don't depend on the full core
 * services — they're HTTP-contract tests, not end-to-end tests.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { buildRequestContextMiddleware } from './request-context.js'
import { buildResolveShopMiddleware } from './resolve-shop.js'
import { buildCookieMiddleware } from './cookies.js'
import { buildCartRoutes } from './cart-routes.js'
import { buildCheckoutRoutes } from './checkout-routes.js'
import {
  CartService,
  type Cart,
  type CartStore,
} from '@gbox/core/modules/cart/service.js'
import type { ResolvedShop } from './resolve-shop.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEMO_SHOP: ResolvedShop = {
  id: 'shop_demo',
  slug: 'demo',
  name: 'Demo Shop',
  currency: 'USD',
  defaultLocale: 'en',
  status: 'active',
}

function memoryStore(): CartStore {
  const map = new Map<string, Cart>()
  return {
    async get(t) {
      const c = map.get(t)
      return c ? structuredClone(c) : null
    },
    async set(t, c) {
      map.set(t, structuredClone(c))
    },
    async del(t) {
      map.delete(t)
    },
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string
let onLineAdded: ReturnType<typeof vi.fn>
let onCheckoutStart: ReturnType<typeof vi.fn>
let cartService: CartService
let createCheckout: ReturnType<typeof vi.fn>
let issueHandoffToken: ReturnType<typeof vi.fn>

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
  cartService = new CartService(memoryStore())
  app.use((req, res, next) =>
    buildCartRoutes({
      service: cartService,
      onLineAdded: (...a: any[]) => onLineAdded(...a),
    })(req, res, next),
  )
  app.use((req, res, next) =>
    buildCheckoutRoutes({
      service: cartService,
      createCheckout: (...a: any[]) => createCheckout(...a),
      issueHandoffToken: (...a: any[]) => issueHandoffToken(...a),
      onCheckoutStart: (...a: any[]) => onCheckoutStart(...a),
      checkoutHost: 'https://checkout.gbox.test',
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
  onLineAdded = vi.fn()
  onCheckoutStart = vi.fn()
  createCheckout = vi.fn(async (shopId: string, _lines: unknown) => ({
    id: 'chk_123',
    shop_id: shopId,
    total_price: '39.98',
    currency: 'USD',
  }))
  issueHandoffToken = vi.fn(async () => ({
    token: 'handoff-token',
    payload: {
      checkoutId: 'chk_123',
      shopId: 'shop_demo',
      customerId: null,
      iat: Date.now(),
      exp: Date.now() + 60_000,
    },
  }))
})

// ---------------------------------------------------------------------------
// cart-routes onLineAdded
// ---------------------------------------------------------------------------

describe('cart-routes onLineAdded hook', () => {
  it('fires once per line after a successful /cart/add.js', async () => {
    const res = await fetch(`${baseUrl}/cart/add.js`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-host': 'demo.gbox.test',
      },
      body: JSON.stringify({ id: 'var_1', quantity: 2 }),
    })
    expect(res.status).toBe(200)
    expect(onLineAdded).toHaveBeenCalledTimes(1)
    const args = onLineAdded.mock.calls[0][0]
    expect(args.shopId).toBe('shop_demo')
    expect(args.line.variant_id).toBe('var_1')
    expect(args.line.quantity).toBe(2)
    expect(typeof args.sessionId).toBe('string')
    expect(args.sessionId.length).toBeGreaterThan(0)
  })

  it('does not affect the cart response when the hook throws', async () => {
    onLineAdded.mockImplementationOnce(() => {
      throw new Error('analytics down')
    })
    const res = await fetch(`${baseUrl}/cart/add.js`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-host': 'demo.gbox.test',
      },
      body: JSON.stringify({ id: 'var_99', quantity: 1 }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.item_count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// checkout-routes onCheckoutStart
// ---------------------------------------------------------------------------

describe('checkout-routes onCheckoutStart hook', () => {
  it('fires after a successful /checkout handoff', async () => {
    // First, seed a cart.
    const addRes = await fetch(`${baseUrl}/cart/add.js`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-host': 'demo.gbox.test',
      },
      body: JSON.stringify({ id: 'var_chk', quantity: 2 }),
    })
    expect(addRes.status).toBe(200)
    const setCookie = addRes.headers.get('set-cookie') ?? ''
    const cartMatch = setCookie.match(/cart=([^;]+)/)
    expect(cartMatch).not.toBeNull()
    const cartCookie = cartMatch![0]

    // Now checkout.
    const res = await fetch(`${baseUrl}/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-forwarded-host': 'demo.gbox.test',
        cookie: cartCookie,
      },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    expect(onCheckoutStart).toHaveBeenCalledTimes(1)
    const args = onCheckoutStart.mock.calls[0][0]
    expect(args).toMatchObject({
      shopId: 'shop_demo',
      checkoutId: 'chk_123',
      total: '39.98',
      currency: 'USD',
      itemCount: 2,
    })
    expect(typeof args.sessionId).toBe('string')
  })
})
