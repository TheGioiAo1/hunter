/**
 * Gbox Storefront — Customer session middleware tests (Stage 3C.1)
 *
 * Covers the middleware that reads the `gbox_customer_session` cookie,
 * looks it up via the injected `getSessionByToken` helper, and (if
 * valid) stamps `req.gboxCustomer` + `req.gboxCustomerId` so downstream
 * middleware / the storefront handler can render account-aware pages.
 *
 * The middleware is dep-injected so these tests never touch Postgres.
 * The real wiring in `server.ts` binds the deps to the core
 * `getSessionByToken` + the customers service.
 *
 * Pinned behaviour:
 *
 *   • No cookie → `gboxCustomer = null`, next still called.
 *   • Cookie present but no shop resolved → null customer (shouldn't
 *     happen in prod; defensive).
 *   • Unknown / expired session token → null customer.
 *   • Session belongs to a different shop → null customer (cross-shop
 *     safety — a cookie leaked from `shop-a` must not authenticate on
 *     `shop-b`).
 *   • Valid session → customer profile stamped on req.
 *   • Internal error (db down) → swallowed, null customer, next called
 *     with no error so the request path keeps rendering. The storefront
 *     never 500s because the customer lookup failed.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { buildRequestContextMiddleware } from './request-context.js'
import { buildResolveShopMiddleware } from './resolve-shop.js'
import { buildCookieMiddleware } from './cookies.js'
import {
  buildCustomerSessionMiddleware,
  type CustomerProfile,
} from './customer-session.js'
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

const FAKE_CUSTOMER: CustomerProfile = {
  id: 'cus_alice',
  email: 'alice@example.com',
  first_name: 'Alice',
  last_name: 'Example',
  orders_count: 3,
  total_spent: '124.50',
  addresses: [],
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string
let getSessionByToken: ReturnType<typeof vi.fn>
let loadCustomer: ReturnType<typeof vi.fn>
let lastReq: {
  gboxCustomer?: CustomerProfile | null
  gboxCustomerId?: string | null
}

beforeAll(async () => {
  const app = express()
  app.use(buildRequestContextMiddleware({ serviceName: 'gbox-storefront' }))
  app.use(
    buildResolveShopMiddleware({
      lookup: async (host) =>
        host === 'demo.gbox.test' ? DEMO_SHOP : null,
      trustForwardedHost: true,
    }),
  )
  app.use(buildCookieMiddleware({}))
  app.use((req, res, next) =>
    buildCustomerSessionMiddleware({
      getSessionByToken,
      loadCustomer,
    })(req, res, next),
  )
  app.get('/_probe', (req, res) => {
    lastReq = {
      gboxCustomer: req.gboxCustomer,
      gboxCustomerId: req.gboxCustomerId,
    }
    res.json({
      customer: req.gboxCustomer ?? null,
      customerId: req.gboxCustomerId ?? null,
    })
  })

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
  lastReq = {}
  getSessionByToken = vi.fn(async (_token: string) => null)
  loadCustomer = vi.fn(async (_shop: string, _id: string) => null)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function probe(cookie?: string): Promise<Response> {
  const headers = new Headers()
  headers.set('x-forwarded-host', 'demo.gbox.test')
  if (cookie) headers.set('cookie', cookie)
  return fetch(`${baseUrl}/_probe`, { headers })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildCustomerSessionMiddleware — anonymous paths', () => {
  it('leaves gboxCustomer null when no session cookie is present', async () => {
    const res = await probe()
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      customer: unknown
      customerId: unknown
    }
    expect(body.customer).toBeNull()
    expect(body.customerId).toBeNull()
    expect(getSessionByToken).not.toHaveBeenCalled()
    expect(loadCustomer).not.toHaveBeenCalled()
  })

  it('ignores unrelated cookies without calling the session lookup', async () => {
    const res = await probe('cart=ct_abc; locale=en')
    expect(res.status).toBe(200)
    expect(getSessionByToken).not.toHaveBeenCalled()
  })

  it('treats an unknown/expired token as anonymous', async () => {
    getSessionByToken.mockResolvedValueOnce(null)
    const res = await probe('gbox_customer_session=stale_token_abc')
    const body = (await res.json()) as { customer: unknown }
    expect(body.customer).toBeNull()
    expect(getSessionByToken).toHaveBeenCalledWith('stale_token_abc')
    expect(loadCustomer).not.toHaveBeenCalled()
  })

  it('rejects a session whose shop_id does not match the resolved shop', async () => {
    getSessionByToken.mockResolvedValueOnce({
      customer_id: 'cus_alice',
      shop_id: 'shop_other',
      expires_at: new Date(Date.now() + 60_000),
    })
    const res = await probe('gbox_customer_session=cross_shop_token')
    const body = (await res.json()) as { customer: unknown }
    expect(body.customer).toBeNull()
    // Must NOT leak customer across shops.
    expect(loadCustomer).not.toHaveBeenCalled()
  })
})

describe('buildCustomerSessionMiddleware — authenticated', () => {
  it('stamps req.gboxCustomer + req.gboxCustomerId on a valid session', async () => {
    getSessionByToken.mockResolvedValueOnce({
      customer_id: 'cus_alice',
      shop_id: DEMO_SHOP.id,
      expires_at: new Date(Date.now() + 3_600_000),
    })
    loadCustomer.mockResolvedValueOnce(FAKE_CUSTOMER)

    const res = await probe('gbox_customer_session=good.session.token')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      customer: CustomerProfile | null
      customerId: string | null
    }
    expect(body.customerId).toBe('cus_alice')
    expect(body.customer?.email).toBe('alice@example.com')
    expect(body.customer?.first_name).toBe('Alice')
    expect(loadCustomer).toHaveBeenCalledWith(DEMO_SHOP.id, 'cus_alice')
  })

  it('still stamps the id even when the customer row has been soft-deleted', async () => {
    // Edge case: the session row is still live but the customer row
    // has been removed (merchant disabled the account). We keep the
    // id on the request so audit logs can still capture "who tried
    // to hit /account", but render as anonymous.
    getSessionByToken.mockResolvedValueOnce({
      customer_id: 'cus_ghost',
      shop_id: DEMO_SHOP.id,
      expires_at: new Date(Date.now() + 3_600_000),
    })
    loadCustomer.mockResolvedValueOnce(null)

    await probe('gbox_customer_session=still_valid_token')
    expect(lastReq.gboxCustomerId).toBe('cus_ghost')
    expect(lastReq.gboxCustomer).toBeNull()
  })
})

describe('buildCustomerSessionMiddleware — defensive', () => {
  it('swallows getSessionByToken errors and continues as anonymous', async () => {
    getSessionByToken.mockRejectedValueOnce(new Error('db exploded'))
    const res = await probe('gbox_customer_session=problem_token')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { customer: unknown }
    expect(body.customer).toBeNull()
  })

  it('swallows loadCustomer errors and continues as anonymous', async () => {
    getSessionByToken.mockResolvedValueOnce({
      customer_id: 'cus_alice',
      shop_id: DEMO_SHOP.id,
      expires_at: new Date(Date.now() + 3_600_000),
    })
    loadCustomer.mockRejectedValueOnce(new Error('customers table locked'))
    const res = await probe('gbox_customer_session=good_token')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { customer: unknown }
    expect(body.customer).toBeNull()
  })
})
