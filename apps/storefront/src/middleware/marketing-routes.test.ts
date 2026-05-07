/**
 * Gbox Storefront — Marketing subscribe route tests (Stage 4.5)
 *
 * Covers the single endpoint:
 *
 *   POST /marketing/subscribe
 *     Collects a newsletter signup from the storefront (exit-intent
 *     popup, footer form, checkout upsell). Forwards the email,
 *     optional name, source, and request metadata into the
 *     `subscribe` dep the caller wires in.
 *
 * Tests pin:
 *   • Shop-scoping: 404 when no `req.gboxShopId` is stamped.
 *   • Validation: missing body, missing email, invalid email, oversized payload.
 *   • Happy path: returns 204 and calls the dep with a normalised input.
 *   • Double opt-in dedupe: returns 200 with a friendly JSON message when dep reports `already_subscribed`.
 *   • Dep throws → 500 without leaking details (JSON `error` only).
 *   • CSRF token handed back on GET-less flow: not applicable (beacon-style
 *     POST with same-origin only). We verify the route still requires
 *     `application/json` and rejects other content types.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { buildRequestContextMiddleware } from './request-context.js'
import { buildResolveShopMiddleware } from './resolve-shop.js'
import { buildCookieMiddleware } from './cookies.js'
import { buildMarketingRoutes } from './marketing-routes.js'
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
let subscribe: ReturnType<typeof vi.fn>

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
    buildMarketingRoutes({
      subscribe: (...a: any[]) => subscribe(...a),
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
  subscribe = vi.fn().mockResolvedValue({ ok: true })
})

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      host: 'demo.gbox.test',
      'x-forwarded-host': 'demo.gbox.test',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('POST /marketing/subscribe — validation', () => {
  it('returns 404 when the host does not resolve to a shop', async () => {
    const res = await fetch(`${baseUrl}/marketing/subscribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: 'nobody.gbox.test',
        'x-forwarded-host': 'nobody.gbox.test',
      },
      body: JSON.stringify({ email: 'a@b.co' }),
    })
    expect(res.status).toBe(404)
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('rejects missing email with 400', async () => {
    const res = await post('/marketing/subscribe', {})
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string }
    expect(json.error.toLowerCase()).toContain('email')
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('rejects an obviously-invalid email with 400', async () => {
    const res = await post('/marketing/subscribe', { email: 'not-an-email' })
    expect(res.status).toBe(400)
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('rejects a non-JSON body with 400', async () => {
    const res = await post('/marketing/subscribe', 'email=a@b.co', {
      'content-type': 'application/x-www-form-urlencoded',
    })
    expect(res.status).toBe(400)
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('rejects oversized payloads', async () => {
    const big = 'x'.repeat(5000)
    const res = await post('/marketing/subscribe', { email: `${big}@b.co` })
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('POST /marketing/subscribe — happy path', () => {
  it('accepts a valid email, normalises it, and calls the dep', async () => {
    const res = await post('/marketing/subscribe', {
      email: '  Alice@Example.COM ',
      name: 'Alice',
      source: 'footer',
    })
    expect(res.status).toBe(204)
    expect(subscribe).toHaveBeenCalledTimes(1)
    const [shopId, input] = subscribe.mock.calls[0]!
    expect(shopId).toBe('shop_demo')
    expect(input.email).toBe('alice@example.com')
    expect(input.name).toBe('Alice')
    expect(input.source).toBe('footer')
  })

  it('defaults source to "unknown" when missing', async () => {
    await post('/marketing/subscribe', { email: 'bob@b.co' })
    const [, input] = subscribe.mock.calls[0]!
    expect(input.source).toBe('unknown')
  })

  it('reports already_subscribed with a 200 + friendly message', async () => {
    subscribe.mockResolvedValueOnce({ ok: false, reason: 'already_subscribed' })
    const res = await post('/marketing/subscribe', { email: 'dup@b.co' })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { status: string }
    expect(json.status).toBe('already_subscribed')
  })

  it('returns 500 on internal error but without leaking details', async () => {
    subscribe.mockRejectedValueOnce(new Error('db on fire'))
    const res = await post('/marketing/subscribe', { email: 'c@b.co' })
    expect(res.status).toBe(500)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('internal error')
    expect(JSON.stringify(json)).not.toContain('db on fire')
  })
})
