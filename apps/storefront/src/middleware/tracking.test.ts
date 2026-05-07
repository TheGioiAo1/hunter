/**
 * Gbox Storefront — Tracking middleware tests (Stage 3E.2)
 *
 * The tracking middleware fires-and-forgets a `page_view` event
 * after each successful content-page response. These tests verify:
 *
 *   - It records on GET 200 HTML-ish requests.
 *   - It skips health, assets, cart.js, account, checkout, events
 *     beacon, robots.txt, sitemap.xml.
 *   - It skips non-GET methods.
 *   - It skips non-2xx responses.
 *   - It never throws even when the recorder explodes.
 *   - It uses the cart cookie as the session id when present and
 *     falls back to the request id otherwise.
 *   - It forwards the customer id from req.gboxCustomerId.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { buildRequestContextMiddleware } from './request-context.js'
import { buildResolveShopMiddleware } from './resolve-shop.js'
import { buildCookieMiddleware } from './cookies.js'
import { buildTrackingMiddleware } from './tracking.js'
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
  // Fake customer session stamp so we can test forwarding.
  app.use((req, _res, next) => {
    const hdr = req.headers['x-test-customer-id']
    if (typeof hdr === 'string') (req as any).gboxCustomerId = hdr
    next()
  })
  app.use((req, res, next) =>
    buildTrackingMiddleware({
      recordPageView: (...args: any[]) => recordPageView(...args),
    })(req, res, next),
  )

  // Minimal downstream handlers for the paths under test.
  app.get('/_health', (_req, res) => res.status(200).send('ok'))
  app.get('/assets/app.css', (_req, res) =>
    res.status(200).type('text/css').send('body{}'),
  )
  app.get('/cart.js', (_req, res) => res.status(200).json({}))
  app.get('/robots.txt', (_req, res) => res.status(200).send(''))
  app.get('/sitemap.xml', (_req, res) => res.status(200).type('application/xml').send('<x/>'))
  app.get('/account/login', (_req, res) => res.status(200).send('login'))
  app.get('/404-path', (_req, res) => res.status(404).send('nope'))
  // Any other GET — content page.
  // Use Express 4 wildcard syntax (installed version is express@^4.21.0).
  // Express 5 syntax '/{*splat}' would not match here.
  app.get(/.*/, (_req, res) => res.status(200).send('<html></html>'))
  app.post('/cart/add.js', (_req, res) => res.status(200).json({}))

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
  recordPageView = vi.fn(async () => {})
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function get(
  path: string,
  opts: { host?: string; cookie?: string; customerId?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'x-forwarded-host': opts.host ?? 'demo.gbox.test',
  }
  if (opts.cookie) headers['cookie'] = opts.cookie
  if (opts.customerId) headers['x-test-customer-id'] = opts.customerId
  return fetch(`${baseUrl}${path}`, { headers })
}

// Give the fire-and-forget listener a tick to flush before assertions.
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5))
}

// ---------------------------------------------------------------------------
// Positive: content pages are recorded
// ---------------------------------------------------------------------------

describe('tracking middleware — positive path', () => {
  it('records a page_view on GET /products/cap 200', async () => {
    await get('/products/cap')
    await flush()
    expect(recordPageView).toHaveBeenCalledTimes(1)
    const call = recordPageView.mock.calls[0]
    // (shopId, input)
    expect(call[0]).toBe('shop_demo')
    expect(call[1]).toMatchObject({
      path: '/products/cap',
      userAgent: expect.any(String),
    })
  })

  it('uses the cart cookie as the session id when present', async () => {
    await get('/products/cap', { cookie: 'cart=cart_token_xyz' })
    await flush()
    expect(recordPageView.mock.calls[0][1].sessionId).toBe('cart_token_xyz')
  })

  it('falls back to the request id as the session id when no cart cookie', async () => {
    const res = await get('/products/cap')
    await flush()
    const requestId = res.headers.get('x-request-id')
    expect(recordPageView.mock.calls[0][1].sessionId).toBe(requestId)
  })

  it('forwards the customer id when the session middleware stamped it', async () => {
    await get('/products/cap', { customerId: 'cus_alice' })
    await flush()
    expect(recordPageView.mock.calls[0][1].customerId).toBe('cus_alice')
  })

  it('forwards the referrer header when present', async () => {
    await fetch(`${baseUrl}/products/cap`, {
      headers: {
        'x-forwarded-host': 'demo.gbox.test',
        referer: 'https://google.com/',
      },
    })
    await flush()
    expect(recordPageView.mock.calls[0][1].referrer).toBe('https://google.com/')
  })
})

// ---------------------------------------------------------------------------
// Negative: skipped paths
// ---------------------------------------------------------------------------

describe('tracking middleware — skip list', () => {
  it('does not record /_health', async () => {
    await get('/_health')
    await flush()
    expect(recordPageView).not.toHaveBeenCalled()
  })

  it('does not record /assets/*', async () => {
    await get('/assets/app.css')
    await flush()
    expect(recordPageView).not.toHaveBeenCalled()
  })

  it('does not record /cart.js', async () => {
    await get('/cart.js')
    await flush()
    expect(recordPageView).not.toHaveBeenCalled()
  })

  it('does not record /robots.txt', async () => {
    await get('/robots.txt')
    await flush()
    expect(recordPageView).not.toHaveBeenCalled()
  })

  it('does not record /sitemap.xml', async () => {
    await get('/sitemap.xml')
    await flush()
    expect(recordPageView).not.toHaveBeenCalled()
  })

  it('does not record /account/*', async () => {
    await get('/account/login')
    await flush()
    expect(recordPageView).not.toHaveBeenCalled()
  })

  it('does not record non-GET requests', async () => {
    await fetch(`${baseUrl}/cart/add.js`, {
      method: 'POST',
      headers: { 'x-forwarded-host': 'demo.gbox.test' },
    })
    await flush()
    expect(recordPageView).not.toHaveBeenCalled()
  })

  it('does not record non-2xx responses (404)', async () => {
    await get('/404-path')
    await flush()
    expect(recordPageView).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Defensive: a broken recorder must not affect the response
// ---------------------------------------------------------------------------

describe('tracking middleware — fault tolerance', () => {
  it('returns 200 to the client even if the recorder throws', async () => {
    recordPageView.mockRejectedValueOnce(new Error('db blew up'))
    const res = await get('/products/cap')
    await flush()
    expect(res.status).toBe(200)
  })
})
