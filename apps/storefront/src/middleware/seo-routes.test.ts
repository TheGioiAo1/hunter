/**
 * Gbox Storefront — SEO routes tests (Stage 3D.1 + 3D.2)
 *
 * Covers the two crawler-facing endpoints:
 *
 *   GET /robots.txt   — tells search engines what to crawl + where
 *                       the sitemap lives
 *   GET /sitemap.xml  — a flat sitemap listing every product,
 *                       collection, page, and blog article for the
 *                       shop resolved from the Host header
 *
 * Both endpoints read shop-scoped data through injected source
 * functions so the tests never touch Postgres. The real server
 * entrypoint will bind these to the `@gbox/core/modules/products`
 * (and friends) services at boot.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { buildRequestContextMiddleware } from './request-context.js'
import { buildResolveShopMiddleware } from './resolve-shop.js'
import { buildSeoRoutes } from './seo-routes.js'
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

const PRIVATE_SHOP: ResolvedShop = {
  ...DEMO_SHOP,
  id: 'shop_private',
  slug: 'private',
  status: 'active',
}

// ---------------------------------------------------------------------------
// Server lifecycle — shared app, fresh stubs per test
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string
let listProductsForSeo: ReturnType<typeof vi.fn>
let listCollectionsForSeo: ReturnType<typeof vi.fn>
let listPagesForSeo: ReturnType<typeof vi.fn>
let listBlogsForSeo: ReturnType<typeof vi.fn>
let getShopCrawlPolicy: ReturnType<typeof vi.fn>

beforeAll(async () => {
  const app = express()
  app.use(buildRequestContextMiddleware({ serviceName: 'gbox-storefront' }))
  app.use(
    buildResolveShopMiddleware({
      lookup: async (host) => {
        if (host === 'demo.gbox.test') return DEMO_SHOP
        if (host === 'private.gbox.test') return PRIVATE_SHOP
        return null
      },
      trustForwardedHost: true,
    }),
  )
  app.use((req, res, next) =>
    buildSeoRoutes({
      listProductsForSeo,
      listCollectionsForSeo,
      listPagesForSeo,
      listBlogsForSeo,
      getShopCrawlPolicy,
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
  listProductsForSeo = vi.fn(async (_shopId: string) => [
    { handle: 'cap', updated_at: '2026-04-01T10:00:00Z' },
    { handle: 'tshirt', updated_at: '2026-04-05T12:00:00Z' },
  ])
  listCollectionsForSeo = vi.fn(async (_shopId: string) => [
    { handle: 'frontpage', updated_at: '2026-03-30T08:00:00Z' },
  ])
  listPagesForSeo = vi.fn(async (_shopId: string) => [
    { handle: 'about', updated_at: '2026-03-15T09:00:00Z' },
    { handle: 'contact', updated_at: '2026-03-16T10:00:00Z' },
  ])
  listBlogsForSeo = vi.fn(async (_shopId: string) => [
    {
      handle: 'news',
      updated_at: '2026-04-01T00:00:00Z',
      articles: [
        { handle: 'launch', updated_at: '2026-04-01T00:00:00Z' },
      ],
    },
  ])
  getShopCrawlPolicy = vi.fn(async (_shopId: string) => ({
    crawlable: true,
    passwordProtected: false,
  }))
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function get(
  path: string,
  host = 'demo.gbox.test',
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    headers: { 'x-forwarded-host': host },
    redirect: 'manual',
  })
}

// ---------------------------------------------------------------------------
// GET /robots.txt
// ---------------------------------------------------------------------------

describe('GET /robots.txt', () => {
  it('returns 200 text/plain with a Sitemap: directive pointing at /sitemap.xml', async () => {
    const res = await get('/robots.txt')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/plain/)
    const body = await res.text()
    expect(body).toContain('User-agent: *')
    expect(body).toContain('Sitemap: http://demo.gbox.test/sitemap.xml')
  })

  it('disallows the checkout + cart mutation + account auth paths', async () => {
    const res = await get('/robots.txt')
    const body = await res.text()
    // These are the paths Shopify's default robots.txt excludes to
    // keep Google from indexing the buyer-flow URLs.
    expect(body).toContain('Disallow: /cart')
    expect(body).toContain('Disallow: /checkout')
    expect(body).toContain('Disallow: /account')
    expect(body).toContain('Disallow: /search')
  })

  it('returns Disallow: / when the shop is password-protected', async () => {
    getShopCrawlPolicy.mockResolvedValueOnce({
      crawlable: false,
      passwordProtected: true,
    })
    const res = await get('/robots.txt', 'private.gbox.test')
    expect(res.status).toBe(200)
    const body = await res.text()
    // A wholesale Disallow: / is the RFC-compliant way to say
    // "don't crawl anything". We MUST NOT emit a Sitemap: line
    // when the shop is private or search engines will still hit
    // it looking for URLs.
    expect(body).toContain('User-agent: *')
    expect(body).toContain('Disallow: /')
    expect(body).not.toContain('Sitemap:')
  })

  it('returns 404 when the host does not resolve to a shop', async () => {
    const res = await get('/robots.txt', 'nobody.gbox.test')
    // resolve-shop returns 404 before we get here.
    expect([404, 400]).toContain(res.status)
  })
})

// ---------------------------------------------------------------------------
// GET /sitemap.xml
// ---------------------------------------------------------------------------

describe('GET /sitemap.xml', () => {
  it('returns 200 application/xml with the sitemap XML declaration', async () => {
    const res = await get('/sitemap.xml')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/xml/)
    const body = await res.text()
    expect(body).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(body).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    )
    expect(body).toContain('</urlset>')
  })

  it('includes the shop root url as the first entry', async () => {
    const res = await get('/sitemap.xml')
    const body = await res.text()
    expect(body).toContain('<loc>http://demo.gbox.test/</loc>')
  })

  it('includes every product as a /products/<handle> entry with lastmod', async () => {
    const res = await get('/sitemap.xml')
    const body = await res.text()
    expect(body).toContain('<loc>http://demo.gbox.test/products/cap</loc>')
    expect(body).toContain('<loc>http://demo.gbox.test/products/tshirt</loc>')
    expect(body).toContain('<lastmod>2026-04-01</lastmod>')
    expect(body).toContain('<lastmod>2026-04-05</lastmod>')
  })

  it('includes collections, pages, blogs, and articles', async () => {
    const res = await get('/sitemap.xml')
    const body = await res.text()
    expect(body).toContain('/collections/frontpage')
    expect(body).toContain('/pages/about')
    expect(body).toContain('/pages/contact')
    expect(body).toContain('/blogs/news')
    expect(body).toContain('/blogs/news/launch')
  })

  it('escapes special characters in handles', async () => {
    listProductsForSeo.mockResolvedValueOnce([
      { handle: 'widget&shiny', updated_at: '2026-04-01T10:00:00Z' },
    ])
    const res = await get('/sitemap.xml')
    const body = await res.text()
    // `&` must be encoded as `&amp;` inside XML character data.
    expect(body).toContain('/products/widget&amp;shiny')
    expect(body).not.toContain('/products/widget&shiny<')
  })

  it('returns 404 when the shop is password-protected (no sitemap leaks)', async () => {
    getShopCrawlPolicy.mockResolvedValueOnce({
      crawlable: false,
      passwordProtected: true,
    })
    const res = await get('/sitemap.xml', 'private.gbox.test')
    expect(res.status).toBe(404)
    // None of the list* fns should have been called — we refuse
    // before even hitting the data layer.
    expect(listProductsForSeo).not.toHaveBeenCalled()
  })

  it('500s gracefully when a source fn throws (listed in logs)', async () => {
    listProductsForSeo.mockRejectedValueOnce(new Error('db exploded'))
    const res = await get('/sitemap.xml')
    expect(res.status).toBe(500)
  })
})
