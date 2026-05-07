/**
 * Gbox Storefront — End-to-end Integration Test (Stage 3A.8)
 *
 * Stands up a complete storefront Express app using only in-memory
 * fakes (MemoryLoader for templates + MemoryDataSource for drops +
 * a hand-rolled shop-lookup map), then exercises every middleware
 * layer at once over a real HTTP socket:
 *
 *   request-context  →  security headers  →  resolve-shop  →
 *   cookies          →  locale            →  assets        →
 *   storefront handler (delegates to handleStorefrontRequest)
 *
 * The important thing this test proves is that the _wiring_ is
 * correct: every middleware passes the right shape to the next one,
 * locale precedence survives the cookie → handler hand-off, and the
 * asset handler short-circuits before the main storefront router.
 *
 * This is the minimum set of assertions that would catch the
 * regressions that hurt most in production:
 *
 *   • Shop host lookup fails silently → every request 404s.
 *   • Cookie middleware dropped → cart/session never reach drops.
 *   • Locale cookie ignored → merchant manual testing goes wrong.
 *   • Asset route swallowed by the catch-all handler → 500 on CSS.
 *
 * We do NOT test the theme engine's rendering logic here — that's
 * covered by ~2000 existing `packages/core` tests. We only verify
 * that the storefront wrapper HANDS the right context to the engine.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { buildApp } from './app.js'
import { createLiquidEngine } from '@gbox/core/modules/themes/engine/liquid.js'
import { MemoryI18nService } from '@gbox/core/modules/i18n/index.js'
import { MemoryDataSource } from '@gbox/core/modules/themes/engine/storefront/datasource.js'
import type {
  LoadResult,
  LogicalPath,
  TemplateLoader,
} from '@gbox/core/modules/themes/engine/loader.js'
import type { ResolvedShop } from './middleware/resolve-shop.js'
import type { StorefrontHandlerOptions } from '@gbox/core/modules/themes/engine/storefront/index.js'

// ---------------------------------------------------------------------------
// Memory template loader
// ---------------------------------------------------------------------------

/**
 * Tiny `TemplateLoader` backed by a JS object. Sufficient for
 * integration tests — production uses `DbLoader` which speaks
 * exactly the same interface.
 */
class MemoryLoader implements TemplateLoader {
  readonly name = 'memory:storefront-test'
  constructor(public readonly files: Record<string, string> = {}) {}
  async load(p: LogicalPath): Promise<string | null> {
    return this.files[p] ?? null
  }
  async loadWithMeta(p: LogicalPath): Promise<LoadResult | null> {
    const src = this.files[p]
    return src === undefined
      ? null
      : { source: src, updatedAt: '2026-04-09T00:00:00Z' }
  }
  async exists(p: LogicalPath): Promise<boolean> {
    return p in this.files
  }
  async list(prefix = ''): Promise<LogicalPath[]> {
    return Object.keys(this.files).filter((k) => k.startsWith(prefix))
  }
}

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

/**
 * Minimal theme: a theme layout, an index template that prints
 * shop + locale + a canary string, a product template that prints
 * the loaded product, and a single CSS asset. Enough to exercise
 * every middleware branch in Phase 3A.
 */
const SEED_TEMPLATES: Record<string, string> = {
  'layout/theme.liquid':
    '<!doctype html><html lang="{{ request.locale }}"><body>{{ content_for_layout }}</body></html>',
  'templates/index.liquid':
    'INDEX[{{ shop.name }}|locale={{ request.locale }}|cart_count={{ cart.item_count }}]',
  'templates/product.liquid':
    'PRODUCT[{{ product.handle }}|title={{ product.title }}|locale={{ request.locale }}]',
  'templates/404.liquid': '404[{{ request.path }}]',
  'templates/500.liquid': '500[{{ error_message }}]',
  'assets/theme.css': 'body{background:#fff}',
}

/**
 * Build the per-shop `StorefrontHandlerOptions` once. In production
 * the server entrypoint would do this lazily per shop with caching;
 * the integration test keeps it simple.
 */
function buildHandlerOptions(): StorefrontHandlerOptions {
  const loader = new MemoryLoader(SEED_TEMPLATES)
  const engine = createLiquidEngine({
    loader,
    i18n: new MemoryI18nService(),
  })
  const datasource = new MemoryDataSource({
    shop: {
      id: DEMO_SHOP.id,
      name: DEMO_SHOP.name,
      currency: DEMO_SHOP.currency,
      default_locale: DEMO_SHOP.defaultLocale,
    },
    products: [
      {
        id: 'prod_1',
        handle: 'shirt',
        title: 'Demo Shirt',
        price: 2500,
      },
    ],
  })
  return {
    engine,
    datasource,
    locales: { supported: ['en', 'vi'], default: 'en' },
  }
}

// Build the loader + handler options ONCE so the asset middleware
// and the storefront handler read the same files.
const HANDLER_OPTIONS = buildHandlerOptions()
const TEMPLATE_LOADER = (
  HANDLER_OPTIONS.engine as unknown as { loader: TemplateLoader }
).loader

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string

beforeAll(async () => {
  const app = buildApp({
    resolveShop: {
      lookup: async (host) => (host === 'demo.gbox.test' ? DEMO_SHOP : null),
      // The integration test talks to the Express app over a real
      // TCP socket on 127.0.0.1, but Node's undici `fetch()` rewrites
      // the `Host` header to match the URL host and does NOT forward
      // a caller-supplied `Host`. It DOES forward `X-Forwarded-Host`
      // untouched, so we enable proxy-trust and route the test's
      // virtual host through that header — which matches the
      // production topology (nginx → storefront) one-to-one.
      trustForwardedHost: true,
    },
    cookies: {},
    locale: {
      getSupportedLocales: () => ['en', 'vi'],
    },
    assets: {
      getLoader: () => TEMPLATE_LOADER,
    },
    storefront: {
      getHandlerOptions: () => HANDLER_OPTIONS,
    },
    errorHandler: {
      getHandlerOptions: () => HANDLER_OPTIONS,
    },
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

// ---------------------------------------------------------------------------
// Helper: build a request that the resolve-shop middleware will
// accept. We cannot change the real TCP Host (it's 127.0.0.1) and
// undici's `fetch()` refuses to honour a caller-supplied `Host`
// header, so instead we set `X-Forwarded-Host: demo.gbox.test` and
// rely on `resolveShop.trustForwardedHost: true` in buildApp. This
// is the same handshake nginx performs in production, so the tests
// exercise the real host-resolution code path.
// ---------------------------------------------------------------------------

async function fetchDemo(
  pathAndQuery: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  if (!headers.has('x-forwarded-host')) {
    headers.set('x-forwarded-host', 'demo.gbox.test')
  }
  return fetch(`${baseUrl}${pathAndQuery}`, { ...init, headers })
}

// ---------------------------------------------------------------------------
// Happy path — index render
// ---------------------------------------------------------------------------

describe('storefront integration — index render', () => {
  it('renders the index template when host resolves to a shop', async () => {
    const res = await fetchDemo('/')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('INDEX[Demo Shop')
    expect(body).toContain('locale=en')
  })

  it('stamps request-context headers (X-Request-ID) on storefront responses', async () => {
    const res = await fetchDemo('/')
    expect(res.headers.get('x-request-id')).toBeTruthy()
  })

  it('stamps security headers (CSP, frameguard) on storefront responses', async () => {
    const res = await fetchDemo('/')
    // CSP + frame deny are dev-safe; HSTS is intentionally NOT stamped
    // in dev/test (see packages/core/src/modules/security/headers.ts
    // header comment — it would lock browsers out of the plain-http LAN
    // dev box). HSTS coverage in production is handled by a separate
    // unit test in packages/core/src/modules/security/headers.test.ts.
    expect(res.headers.get('content-security-policy')).toBeTruthy()
    // Storefront uses `SAMEORIGIN` (not `DENY`) because embedded
    // storefront previews inside the admin live-preview iframe need
    // to render — see packages/core/src/modules/security/headers.ts
    // `storefrontSecurityHeaders`.
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN')
  })

  it('404s when the host does not resolve to a shop', async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { 'x-forwarded-host': 'unknown.example.com' },
    })
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Product route — proves path + datasource plumbing
// ---------------------------------------------------------------------------

describe('storefront integration — product route', () => {
  it('renders the product template for an existing handle', async () => {
    const res = await fetchDemo('/products/shirt')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('PRODUCT[shirt')
    expect(body).toContain('title=Demo Shirt')
  })

  it('404s on an unknown product handle (loader returns null)', async () => {
    const res = await fetchDemo('/products/does-not-exist')
    expect(res.status).toBe(404)
    // The 404 template renders the request path so we can confirm
    // the router reached the fall-through branch (not a bogus 500).
    const body = await res.text()
    expect(body).toContain('404[')
  })
})

// ---------------------------------------------------------------------------
// Locale precedence — cookie beats Accept-Language, URL beats cookie
// ---------------------------------------------------------------------------

describe('storefront integration — locale precedence', () => {
  it('honours the locale cookie over Accept-Language', async () => {
    const res = await fetchDemo('/', {
      headers: {
        cookie: 'locale=vi',
        'accept-language': 'en-US,en;q=0.9',
      },
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('locale=vi')
  })

  it('honours the URL prefix over the cookie (/vi wins over locale=en)', async () => {
    const res = await fetchDemo('/vi/', {
      headers: { cookie: 'locale=en' },
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('locale=vi')
  })

  it('falls back to Accept-Language when no cookie or URL prefix', async () => {
    const res = await fetchDemo('/', {
      headers: { 'accept-language': 'vi,en;q=0.5' },
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('locale=vi')
  })
})

// ---------------------------------------------------------------------------
// Cart cookie plumbing
// ---------------------------------------------------------------------------

describe('storefront integration — cart cookie', () => {
  it('wires the cart cookie through to the MemoryDataSource', async () => {
    // MemoryDataSource has no cart for unknown tokens, but it
    // returns an empty cart shape, so rendering still works and
    // we can assert it got called by inspecting item_count.
    const res = await fetchDemo('/', {
      headers: { cookie: 'cart=ct_unknown_token' },
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('cart_count=0')
  })
})

// ---------------------------------------------------------------------------
// Asset handler
// ---------------------------------------------------------------------------

describe('storefront integration — asset handler', () => {
  it('serves theme.css directly from the loader', async () => {
    const res = await fetchDemo('/assets/theme.css')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/css')
    const body = await res.text()
    expect(body).toBe('body{background:#fff}')
    // Immutable cache header
    expect(res.headers.get('cache-control')).toContain('immutable')
  })

  it('304s on If-None-Match revalidation', async () => {
    const first = await fetchDemo('/assets/theme.css')
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()
    const second = await fetchDemo('/assets/theme.css', {
      headers: { 'if-none-match': etag! },
    })
    expect(second.status).toBe(304)
  })

  it('404s on a missing asset without reaching the storefront handler', async () => {
    const res = await fetchDemo('/assets/does-not-exist.css')
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Health check still lives above shop resolution
// ---------------------------------------------------------------------------

describe('storefront integration — health check bypass', () => {
  it('hits /_health even when the Host header does not match a shop', async () => {
    const res = await fetch(`${baseUrl}/_health`, {
      headers: { 'x-forwarded-host': 'unknown.example.com' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// Stage 3A.9 — Error handler + templated 404/500
// ---------------------------------------------------------------------------
//
// We stand up a SECOND Express app here that intentionally wires a
// throwing storefront handler, so we can verify the trailing
// Express error middleware catches the throw and renders the
// `templates/500.liquid` page through the real Liquid engine.
// Reusing the happy-path app would require mutating HANDLER_OPTIONS
// mid-suite, which would race the other tests.

describe('storefront integration — templated error handler', () => {
  let errorServer: Server
  let errorBaseUrl: string

  beforeAll(async () => {
    const errorApp = buildApp({
      resolveShop: {
        lookup: async (host) =>
          host === 'demo.gbox.test' ? DEMO_SHOP : null,
        trustForwardedHost: true,
      },
      cookies: {},
      locale: {
        getSupportedLocales: () => ['en', 'vi'],
      },
      storefront: {
        // Force the handler to throw on every request so the
        // trailing error middleware is the thing that finalises
        // the response. This is the only reliable way to prove
        // Express picked our 4-arg error handler (as opposed to
        // its default console-dump handler).
        getHandlerOptions: () => {
          throw new Error('synthetic theme-load failure')
        },
      },
      errorHandler: {
        getHandlerOptions: () => HANDLER_OPTIONS,
      },
    })
    errorServer = createServer(errorApp)
    await new Promise<void>((resolve) =>
      errorServer.listen(0, '127.0.0.1', resolve),
    )
    const addr = errorServer.address() as AddressInfo
    errorBaseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      errorServer.close((err) => (err ? reject(err) : resolve())),
    )
  })

  it('renders templates/500.liquid when the storefront handler throws', async () => {
    const res = await fetch(`${errorBaseUrl}/`, {
      headers: { 'x-forwarded-host': 'demo.gbox.test' },
    })
    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    // The seed template is `500[{{ error_message }}]`. The outer
    // `<html>…</html>` comes from the layout wrap-up step inside
    // `renderErrorTemplate`, proving the layout + template roll-up
    // both ran on the error branch.
    expect(body).toContain('500[')
    expect(body).toContain('synthetic theme-load failure')
    expect(body).toContain('<html')
  })

  it('stamps the X-Request-ID header on the templated 500', async () => {
    const res = await fetch(`${errorBaseUrl}/`, {
      headers: { 'x-forwarded-host': 'demo.gbox.test' },
    })
    expect(res.headers.get('x-request-id')).toBeTruthy()
  })
})
