/**
 * Gbox Storefront — Checkout Routes tests (Stage 3B.4 + 3B.5)
 *
 * Thin HTTP skin over the existing core checkout service + handoff
 * token module. The storefront route is the glue that turns "visitor
 * clicks Checkout" into:
 *
 *   1. Fetch the cart from Redis (via the injected CartService).
 *   2. Hand the cart's lines to core's `createCheckout` so a priced
 *      `CheckoutSession` is minted and cached in Redis.
 *   3. Sign a single-use handoff token via `issueHandoffToken`.
 *   4. 303 the browser (or return JSON, depending on Accept header)
 *      at the canonical checkout URL with the token in the query.
 *
 * We mock both `createCheckout` and `issueHandoffToken` via the deps
 * bag so these tests never touch Postgres or Redis. The core
 * modules have their own exhaustive unit suites.
 *
 * What this test pins down:
 *
 *   • POST /checkout with no cookie → 422 (nothing to check out).
 *   • POST /checkout with an empty cart → 422.
 *   • POST /checkout happy path (HTML Accept header) → 303 to
 *     `https://checkout.gbox.co/c/<id>?hop=<token>`.
 *   • Same happy path with `Accept: application/json` → 200 JSON
 *     with `checkout_url`, `checkout_id`, `handoff_token` fields.
 *   • The cart is destroyed after a successful hand-off so the
 *     next visit starts fresh (critical to avoid double-buying).
 *   • A cart that belongs to a different shop is rejected with 409.
 *   • Upstream failures (createCheckout throws) surface as 500
 *     and do NOT destroy the cart.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { buildRequestContextMiddleware } from './request-context.js'
import { buildResolveShopMiddleware } from './resolve-shop.js'
import { buildCookieMiddleware } from './cookies.js'
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
let service: CartService
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
  app.use((req, res, next) =>
    buildCheckoutRoutes({
      service,
      createCheckout,
      issueHandoffToken,
      checkoutHost: 'https://checkout.gbox.test',
    })(req, res, next),
  )

  server = createServer(app)
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  )
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
})

beforeEach(() => {
  service = new CartService(memoryStore())
  createCheckout = vi.fn(async (_shopId: string, _lines: unknown[]) => ({
    id: 'chk_test_123',
    shop_id: DEMO_SHOP.id,
    total_price: '45.00',
    currency: 'USD',
  }))
  issueHandoffToken = vi.fn(
    async (_input: {
      checkoutId: string
      shopId: string
      customerId: string | null
    }) => ({
      token: 'handoff.test.token',
      payload: {
        checkoutId: 'chk_test_123',
        shopId: DEMO_SHOP.id,
        customerId: null,
        iat: Date.now(),
        exp: Date.now() + 300_000,
        nonce: 'nonce_test',
      },
    }),
  )
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function checkoutFetch(
  init: RequestInit = {},
  cookie?: string,
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('x-forwarded-host', 'demo.gbox.test')
  if (cookie) headers.set('cookie', cookie)
  return fetch(`${baseUrl}/checkout`, {
    ...init,
    method: init.method ?? 'POST',
    headers,
    redirect: 'manual',
  })
}

async function seedCartWithLines(): Promise<string> {
  const cart = await service.createCart(DEMO_SHOP.id)
  await service.addItem(cart.token, DEMO_SHOP.id, {
    variant_id: 'var_1',
    quantity: 2,
  })
  await service.addItem(cart.token, DEMO_SHOP.id, {
    variant_id: 'var_2',
    quantity: 1,
  })
  return cart.token
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe('POST /checkout — happy path', () => {
  it('303s to the checkout host with hop token on HTML submissions', async () => {
    const token = await seedCartWithLines()
    const res = await checkoutFetch({}, `cart=${token}`)
    expect(res.status).toBe(303)
    const location = res.headers.get('location')!
    expect(location).toMatch(/^https:\/\/checkout\.gbox\.test\/c\/chk_test_123\?hop=/)
    expect(location).toContain('handoff.test.token')
  })

  it('returns JSON when Accept: application/json is set', async () => {
    const token = await seedCartWithLines()
    const res = await checkoutFetch(
      { headers: { accept: 'application/json' } },
      `cart=${token}`,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as {
      checkout_id: string
      checkout_url: string
      handoff_token: string
    }
    expect(body.checkout_id).toBe('chk_test_123')
    expect(body.handoff_token).toBe('handoff.test.token')
    expect(body.checkout_url).toContain('hop=handoff.test.token')
  })

  it('forwards the cart lines to createCheckout in the expected shape', async () => {
    const token = await seedCartWithLines()
    await checkoutFetch({}, `cart=${token}`)
    expect(createCheckout).toHaveBeenCalledTimes(1)
    const [shopId, lines] = createCheckout.mock.calls[0]!
    expect(shopId).toBe(DEMO_SHOP.id)
    expect(lines).toEqual([
      { variant_id: 'var_1', quantity: 2 },
      { variant_id: 'var_2', quantity: 1 },
    ])
  })

  it('destroys the cart after a successful hand-off', async () => {
    const token = await seedCartWithLines()
    await checkoutFetch({}, `cart=${token}`)
    expect(await service.getCart(token)).toBeNull()
  })

  it('issues the handoff token scoped to the new checkout + shop', async () => {
    const token = await seedCartWithLines()
    await checkoutFetch({}, `cart=${token}`)
    expect(issueHandoffToken).toHaveBeenCalledWith({
      checkoutId: 'chk_test_123',
      shopId: DEMO_SHOP.id,
      customerId: null,
    })
  })

  it('forwards the signed-in customer id when req.gboxCustomerId is stamped', async () => {
    // Mount a one-off tiny app that stamps req.gboxCustomerId BEFORE
    // the checkout routes run, mimicking what the customer-session
    // middleware does in production. We can't reuse the shared
    // server because it doesn't install customer-session.
    const express1 = (await import('express')).default
    const { createServer: createServer1 } = await import('node:http')

    const tinyApp = express1()
    tinyApp.use(buildRequestContextMiddleware({ serviceName: 'gbox-storefront' }))
    tinyApp.use(
      buildResolveShopMiddleware({
        lookup: async (host) =>
          host === 'demo.gbox.test' ? DEMO_SHOP : null,
        trustForwardedHost: true,
      }),
    )
    tinyApp.use(buildCookieMiddleware({}))
    tinyApp.use((req, _res, next) => {
      req.gboxCustomerId = 'cus_signed_in'
      next()
    })
    tinyApp.use((req, res, next) =>
      buildCheckoutRoutes({
        service,
        createCheckout,
        issueHandoffToken,
        checkoutHost: 'https://checkout.gbox.test',
      })(req, res, next),
    )

    const tinyServer = createServer1(tinyApp)
    await new Promise<void>((resolve) =>
      tinyServer.listen(0, '127.0.0.1', resolve),
    )
    const addr = tinyServer.address() as { port: number }
    const tinyUrl = `http://127.0.0.1:${addr.port}`

    try {
      const token = await seedCartWithLines()
      const res = await fetch(`${tinyUrl}/checkout`, {
        method: 'POST',
        headers: {
          'x-forwarded-host': 'demo.gbox.test',
          cookie: `cart=${token}`,
        },
        redirect: 'manual',
      })
      expect(res.status).toBe(303)
      expect(issueHandoffToken).toHaveBeenCalledWith({
        checkoutId: 'chk_test_123',
        shopId: DEMO_SHOP.id,
        customerId: 'cus_signed_in',
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        tinyServer.close((err) => (err ? reject(err) : resolve())),
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Negative paths
// ---------------------------------------------------------------------------

describe('POST /checkout — negatives', () => {
  it('422s when no cart cookie is present', async () => {
    const res = await checkoutFetch()
    expect(res.status).toBe(422)
    expect(createCheckout).not.toHaveBeenCalled()
  })

  it('422s when the cart cookie points at a missing cart', async () => {
    const res = await checkoutFetch({}, 'cart=ct_evaporated')
    expect(res.status).toBe(422)
    expect(createCheckout).not.toHaveBeenCalled()
  })

  it('422s when the cart is empty', async () => {
    const cart = await service.createCart(DEMO_SHOP.id)
    const res = await checkoutFetch({}, `cart=${cart.token}`)
    expect(res.status).toBe(422)
    expect(createCheckout).not.toHaveBeenCalled()
  })

  it('409s when the cart belongs to a different shop', async () => {
    const cart = await service.createCart('shop_other')
    await service.addItem(cart.token, 'shop_other', {
      variant_id: 'var_1',
      quantity: 1,
    })
    const res = await checkoutFetch({}, `cart=${cart.token}`)
    expect(res.status).toBe(409)
  })

  it('500s and leaves the cart intact when createCheckout throws', async () => {
    createCheckout.mockImplementationOnce(async () => {
      throw new Error('variant not found')
    })
    const token = await seedCartWithLines()
    const res = await checkoutFetch(
      { headers: { accept: 'application/json' } },
      `cart=${token}`,
    )
    expect(res.status).toBe(500)
    // Cart still exists so the visitor can retry.
    expect(await service.getCart(token)).not.toBeNull()
  })

  it('500s and leaves the cart intact when issueHandoffToken throws', async () => {
    issueHandoffToken.mockImplementationOnce(async () => {
      throw new Error('redis down')
    })
    const token = await seedCartWithLines()
    const res = await checkoutFetch(
      { headers: { accept: 'application/json' } },
      `cart=${token}`,
    )
    expect(res.status).toBe(500)
    expect(await service.getCart(token)).not.toBeNull()
  })
})
