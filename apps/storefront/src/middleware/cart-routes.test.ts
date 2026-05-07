/**
 * Gbox Storefront — Cart Routes tests (Stage 3B.2)
 *
 * Exercises the Shopify-compatible Ajax cart endpoints end-to-end
 * against a real Express app with cookie + resolve-shop middleware
 * wired in, so each test also asserts the Set-Cookie round trip
 * that binds a fresh visitor to their brand-new cart.
 *
 * The service layer (`CartService` + `memoryStore`) is re-used
 * verbatim from the Phase 3B.1 unit tests — the routes are a thin
 * HTTP skin over that layer, and mocking the service here would
 * just re-test the plumbing we're already verifying in the service
 * suite.
 *
 * Endpoints under test:
 *
 *   GET  /cart.js              → current cart JSON (mint on miss)
 *   POST /cart/add.js          → append line, 200 + updated cart
 *   POST /cart/change.js       → set quantity (0 ⇒ remove)
 *   POST /cart/update.js       → bulk updates / note / attributes
 *   POST /cart/clear.js        → empty lines, keep token
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { buildCookieMiddleware } from './cookies.js'
import { buildResolveShopMiddleware } from './resolve-shop.js'
import { buildRequestContextMiddleware } from './request-context.js'
import { buildCartRoutes } from './cart-routes.js'
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

beforeAll(async () => {
  // Each test suite shares one HTTP server but gets a fresh service
  // in `beforeEach`. We rebuild the routes middleware each time so
  // they capture the fresh service — Express lets us swap the stack
  // via a sub-router mounted inside a wrapper.
  const app = express()
  app.use(buildRequestContextMiddleware({ serviceName: 'gbox-storefront' }))
  app.use(
    buildResolveShopMiddleware({
      lookup: async (host) => (host === 'demo.gbox.test' ? DEMO_SHOP : null),
      trustForwardedHost: true,
    }),
  )
  app.use(buildCookieMiddleware({}))
  // We mount the cart routes behind a closure that reads the current
  // `service` binding — that way `beforeEach` can swap it without
  // rebuilding the whole Express instance.
  app.use((req, res, next) => buildCartRoutes({ service })(req, res, next))

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
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function cartFetch(
  pathAndQuery: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  if (!headers.has('x-forwarded-host')) {
    headers.set('x-forwarded-host', 'demo.gbox.test')
  }
  return fetch(`${baseUrl}${pathAndQuery}`, { ...init, headers })
}

/**
 * Extract the `cart=...` value from a Set-Cookie header. Returns
 * null when the header is absent — individual tests decide whether
 * that is expected.
 */
function extractCartCookie(res: Response): string | null {
  const raw = res.headers.get('set-cookie')
  if (!raw) return null
  // Node `fetch` flattens multiple Set-Cookie headers into one
  // comma-separated string, but cookie values themselves contain
  // commas (Expires=...) so a simple split is fragile. We match on
  // the cookie name directly.
  const match = raw.match(/(?:^|,\s*)cart=([^;,\s]+)/)
  return match ? decodeURIComponent(match[1]!) : null
}

// ---------------------------------------------------------------------------
// GET /cart.js
// ---------------------------------------------------------------------------

describe('GET /cart.js', () => {
  it('returns a fresh empty cart when no cookie is present', async () => {
    const res = await cartFetch('/cart.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as {
      token: string
      item_count: number
      items: unknown[]
    }
    expect(body.token).toMatch(/^ct_/)
    expect(body.item_count).toBe(0)
    expect(body.items).toEqual([])
  })

  it('sets a Set-Cookie header so the browser remembers the minted token', async () => {
    const res = await cartFetch('/cart.js')
    const token = extractCartCookie(res)
    expect(token).toMatch(/^ct_/)
  })

  it('returns the existing cart when the cookie points at a live token', async () => {
    const created = await service.createCart(DEMO_SHOP.id)
    await service.addItem(created.token, DEMO_SHOP.id, {
      variant_id: 'var_1',
      quantity: 3,
    })
    const res = await cartFetch('/cart.js', {
      headers: { cookie: `cart=${created.token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      token: string
      item_count: number
      items: Array<{ variant_id: string; quantity: number }>
    }
    expect(body.token).toBe(created.token)
    expect(body.item_count).toBe(3)
    expect(body.items[0]).toMatchObject({ variant_id: 'var_1', quantity: 3 })
  })

  it('mints a new cart when the cookie token no longer exists', async () => {
    const res = await cartFetch('/cart.js', {
      headers: { cookie: 'cart=ct_evaporated' },
    })
    expect(res.status).toBe(200)
    const token = extractCartCookie(res)
    expect(token).toMatch(/^ct_/)
    expect(token).not.toBe('ct_evaporated')
  })
})

// ---------------------------------------------------------------------------
// POST /cart/add.js
// ---------------------------------------------------------------------------

describe('POST /cart/add.js', () => {
  it('adds a new line to a first-touch visitor and mints their cart', async () => {
    const res = await cartFetch('/cart/add.js', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'var_1', quantity: 2 }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      token: string
      item_count: number
      items: Array<{ variant_id: string; quantity: number }>
    }
    expect(body.token).toMatch(/^ct_/)
    expect(body.item_count).toBe(2)
    expect(body.items[0]).toMatchObject({ variant_id: 'var_1', quantity: 2 })
    expect(extractCartCookie(res)).toBe(body.token)
  })

  it('accepts the Shopify `items[]` bulk-add payload', async () => {
    const res = await cartFetch('/cart/add.js', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          { id: 'var_1', quantity: 1 },
          { id: 'var_2', quantity: 2 },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      item_count: number
      items: unknown[]
    }
    expect(body.item_count).toBe(3)
    expect(body.items).toHaveLength(2)
  })

  it('merges quantities when the same variant is added twice', async () => {
    const first = await cartFetch('/cart/add.js', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'var_1', quantity: 1 }),
    })
    const token = extractCartCookie(first)!
    const second = await cartFetch('/cart/add.js', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `cart=${token}`,
      },
      body: JSON.stringify({ id: 'var_1', quantity: 4 }),
    })
    const body = (await second.json()) as { item_count: number }
    expect(body.item_count).toBe(5)
  })

  it('rejects malformed payloads with 422', async () => {
    const res = await cartFetch('/cart/add.js', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'var_1', quantity: -2 }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { status: number; description: string }
    expect(body.status).toBe(422)
    expect(body.description).toMatch(/quantity/i)
  })

  it('rejects a missing id with 422', async () => {
    const res = await cartFetch('/cart/add.js', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quantity: 1 }),
    })
    expect(res.status).toBe(422)
  })
})

// ---------------------------------------------------------------------------
// POST /cart/change.js
// ---------------------------------------------------------------------------

describe('POST /cart/change.js', () => {
  it('updates the quantity of an existing line', async () => {
    const cart = await service.createCart(DEMO_SHOP.id)
    await service.addItem(cart.token, DEMO_SHOP.id, {
      variant_id: 'var_1',
      quantity: 1,
    })
    const res = await cartFetch('/cart/change.js', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `cart=${cart.token}`,
      },
      body: JSON.stringify({ id: 'var_1', quantity: 7 }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: Array<{ variant_id: string; quantity: number }>
    }
    expect(body.items[0]).toMatchObject({ variant_id: 'var_1', quantity: 7 })
  })

  it('removes the line when quantity is 0', async () => {
    const cart = await service.createCart(DEMO_SHOP.id)
    await service.addItem(cart.token, DEMO_SHOP.id, {
      variant_id: 'var_1',
      quantity: 3,
    })
    const res = await cartFetch('/cart/change.js', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `cart=${cart.token}`,
      },
      body: JSON.stringify({ id: 'var_1', quantity: 0 }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { item_count: number; items: unknown[] }
    expect(body.item_count).toBe(0)
    expect(body.items).toEqual([])
  })

  it('404s when the cart cookie does not exist', async () => {
    const res = await cartFetch('/cart/change.js', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: 'cart=ct_missing',
      },
      body: JSON.stringify({ id: 'var_1', quantity: 1 }),
    })
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// POST /cart/update.js
// ---------------------------------------------------------------------------

describe('POST /cart/update.js', () => {
  it('applies bulk quantity updates keyed by variant id', async () => {
    const cart = await service.createCart(DEMO_SHOP.id)
    await service.addItem(cart.token, DEMO_SHOP.id, {
      variant_id: 'var_1',
      quantity: 1,
    })
    await service.addItem(cart.token, DEMO_SHOP.id, {
      variant_id: 'var_2',
      quantity: 1,
    })
    const res = await cartFetch('/cart/update.js', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `cart=${cart.token}`,
      },
      body: JSON.stringify({ updates: { var_1: 4, var_2: 0 } }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      item_count: number
      items: Array<{ variant_id: string; quantity: number }>
    }
    expect(body.item_count).toBe(4)
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({ variant_id: 'var_1', quantity: 4 })
  })

  it('writes the note when provided', async () => {
    const cart = await service.createCart(DEMO_SHOP.id)
    const res = await cartFetch('/cart/update.js', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `cart=${cart.token}`,
      },
      body: JSON.stringify({ note: 'gift wrap please' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { note: string | null }
    expect(body.note).toBe('gift wrap please')
  })

  it('merges attributes when provided', async () => {
    const cart = await service.createCart(DEMO_SHOP.id)
    const res = await cartFetch('/cart/update.js', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `cart=${cart.token}`,
      },
      body: JSON.stringify({ attributes: { source: 'newsletter' } }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { attributes: Record<string, string> }
    expect(body.attributes).toEqual({ source: 'newsletter' })
  })

  it('mints a cart when no cookie is present and the update is additive', async () => {
    const res = await cartFetch('/cart/update.js', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'hello' }),
    })
    expect(res.status).toBe(200)
    expect(extractCartCookie(res)).toMatch(/^ct_/)
  })
})

// ---------------------------------------------------------------------------
// POST /cart/clear.js
// ---------------------------------------------------------------------------

describe('POST /cart/clear.js', () => {
  it('empties the lines but keeps the token stable', async () => {
    const cart = await service.createCart(DEMO_SHOP.id)
    await service.addItem(cart.token, DEMO_SHOP.id, {
      variant_id: 'var_1',
      quantity: 2,
    })
    const res = await cartFetch('/cart/clear.js', {
      method: 'POST',
      headers: { cookie: `cart=${cart.token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      token: string
      item_count: number
    }
    expect(body.token).toBe(cart.token)
    expect(body.item_count).toBe(0)
  })

  it('mints and returns an empty cart when no cookie is present', async () => {
    const res = await cartFetch('/cart/clear.js', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; item_count: number }
    expect(body.token).toMatch(/^ct_/)
    expect(body.item_count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Method / non-cart routes
// ---------------------------------------------------------------------------

describe('cart routes — negative paths', () => {
  it('passes non-cart requests through to the next middleware', async () => {
    // We don't mount a catch-all on the test app, so Express should
    // default to its own 404 (not our JSON 422/422).
    const res = await cartFetch('/products/shirt')
    expect(res.status).toBe(404)
    // Not the cart JSON response shape.
    const text = await res.text()
    expect(text).not.toMatch(/item_count/)
  })

  it('refuses to mix variants from a different shop', async () => {
    const cart = await service.createCart('shop_other')
    const res = await cartFetch('/cart/add.js', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `cart=${cart.token}`,
      },
      body: JSON.stringify({ id: 'var_1', quantity: 1 }),
    })
    expect(res.status).toBe(409)
  })
})
