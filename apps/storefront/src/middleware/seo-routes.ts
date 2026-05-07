/**
 * Gbox Storefront — SEO Routes (Stage 3D.1 + 3D.2)
 *
 * Two crawler-facing endpoints:
 *
 *   GET /robots.txt   Shop-scoped crawl policy + sitemap pointer.
 *   GET /sitemap.xml  Flat sitemap listing every indexable URL
 *                     (products, collections, pages, blogs,
 *                     blog articles) for the resolved shop.
 *
 * Design:
 *
 *   1. **Shop-scoped**. Both endpoints run AFTER the resolve-shop
 *      middleware, so the resolved shop id is already on the
 *      request. We never serve a sitemap for a shop we don't
 *      recognise — the resolve-shop 404 intercepts first.
 *
 *   2. **Password-protected stores stay out of the index.** If
 *      `getShopCrawlPolicy` reports `crawlable: false`, robots.txt
 *      emits a wholesale `Disallow: /` (with no `Sitemap:` line)
 *      and `/sitemap.xml` returns a 404. This matches Shopify's
 *      behaviour: a private store advertising its sitemap defeats
 *      the purpose of the password wall.
 *
 *   3. **Data via injected source functions**, not the
 *      `StorefrontDataSource` interface. The datasource is
 *      page-request shaped — it has `loadProductByHandle`, not
 *      "list every product". Rather than pollute the datasource
 *      interface with a sitemap-only method, we accept narrow
 *      source functions in the deps bag. In production they bind
 *      to `listProducts(db, shopId, {status:'active'}, {limit:…})`
 *      etc.; in tests they're vi.fn() stubs.
 *
 *   4. **XML is assembled by string concatenation.** We don't pull
 *      in a DOM builder — the schema is tiny and the escaping
 *      surface is narrow. A dedicated `escapeXml` helper handles
 *      the five XML special characters.
 *
 *   5. **Single file for now.** Shopify's guidance is to split at
 *      50k URLs using a sitemap index. This MVP emits a single
 *      flat sitemap because the typical Gbox shop is under 5k
 *      URLs. A later stage will add `/sitemap_products-1.xml`
 *      children + a `/sitemap.xml` index when listProductsForSeo
 *      returns more than the limit. The cut-over is gated on a
 *      `maxUrlsPerFile` option already in the deps shape so the
 *      upgrade is non-breaking.
 */

import type { NextFunction, Request, Response, Router } from 'express'
import express from 'express'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SeoEntry {
  handle: string
  /** Most-recent mtime in ISO 8601. Rendered as YYYY-MM-DD in the sitemap. */
  updated_at?: string | null
}

export interface BlogSeoEntry extends SeoEntry {
  articles?: SeoEntry[]
}

export interface ShopCrawlPolicy {
  /** True when the shop should be crawled + indexed. */
  crawlable: boolean
  /** True when the shop has the password wall enabled. */
  passwordProtected: boolean
}

export interface SeoRoutesDeps {
  /** List active product handles for the shop (for /sitemap.xml). */
  listProductsForSeo: (shopId: string) => Promise<SeoEntry[]>
  /** List collection handles for the shop. */
  listCollectionsForSeo: (shopId: string) => Promise<SeoEntry[]>
  /** List page handles for the shop. */
  listPagesForSeo: (shopId: string) => Promise<SeoEntry[]>
  /** List blog + article handles for the shop. */
  listBlogsForSeo: (shopId: string) => Promise<BlogSeoEntry[]>
  /**
   * Resolve the shop's current crawl policy. In production this
   * reads `shops.password_enabled` + `shops.status`; in tests
   * it's a stub.
   */
  getShopCrawlPolicy: (shopId: string) => Promise<ShopCrawlPolicy>
  /**
   * Override the base URL used in `<loc>` entries. When unset, we
   * infer from the request host + protocol. Exposed for tests
   * that want a stable value.
   */
  baseUrlFor?: (req: Request) => string
  /**
   * Maximum URLs per sitemap file. Defaults to 50_000 (the
   * sitemap.org cap). Future stage will split when exceeded.
   */
  maxUrlsPerFile?: number
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildSeoRoutes(
  deps: SeoRoutesDeps,
): (req: Request, res: Response, next: NextFunction) => void {
  const router: Router = express.Router()

  // -----------------------------------------------------------------
  // GET /robots.txt
  // -----------------------------------------------------------------

  router.get('/robots.txt', async (req, res, next) => {
    try {
      const shopId = typeof req.gboxShopId === 'string' ? req.gboxShopId : null
      if (!shopId) {
        // resolve-shop should have 404ed already; be defensive.
        res.status(404).type('text/plain').send('Not Found')
        return
      }

      const policy = await deps.getShopCrawlPolicy(shopId)
      const base = resolveBaseUrl(req, deps.baseUrlFor)

      res.status(200)
      res.set('Content-Type', 'text/plain; charset=utf-8')
      res.set('Cache-Control', 'public, max-age=300')

      if (!policy.crawlable || policy.passwordProtected) {
        // Shut the door on every crawler AND omit the Sitemap:
        // line so indexers don't come back for it. The comment
        // tells humans why.
        res.send(
          [
            '# Gbox Storefront — crawl disabled (shop is private)',
            'User-agent: *',
            'Disallow: /',
            '',
          ].join('\n'),
        )
        return
      }

      const body = [
        '# Gbox Storefront — generated robots.txt',
        'User-agent: *',
        'Disallow: /cart',
        'Disallow: /checkout',
        'Disallow: /account',
        'Disallow: /search',
        'Disallow: /*?preview_theme_id*',
        'Disallow: /*?design_mode*',
        '',
        `Sitemap: ${base}/sitemap.xml`,
        '',
      ].join('\n')

      res.send(body)
    } catch (err) {
      next(err)
    }
  })

  // -----------------------------------------------------------------
  // GET /sitemap.xml
  // -----------------------------------------------------------------

  router.get('/sitemap.xml', async (req, res, next) => {
    try {
      const shopId = typeof req.gboxShopId === 'string' ? req.gboxShopId : null
      if (!shopId) {
        res.status(404).type('text/plain').send('Not Found')
        return
      }

      const policy = await deps.getShopCrawlPolicy(shopId)
      if (!policy.crawlable || policy.passwordProtected) {
        // A private store MUST NOT leak its product list via the
        // sitemap. 404 is the right response — "no sitemap here".
        res.status(404).type('text/plain').send('Not Found')
        return
      }

      const base = resolveBaseUrl(req, deps.baseUrlFor)

      // Pull everything in parallel — the individual source fns are
      // already shop-scoped.
      const [products, collections, pages, blogs] = await Promise.all([
        deps.listProductsForSeo(shopId),
        deps.listCollectionsForSeo(shopId),
        deps.listPagesForSeo(shopId),
        deps.listBlogsForSeo(shopId),
      ])

      const entries: Array<{ loc: string; lastmod?: string }> = []

      // Shop root — most-important URL in the file.
      entries.push({ loc: `${base}/` })

      for (const p of products) {
        entries.push({
          loc: `${base}/products/${p.handle}`,
          lastmod: formatLastmod(p.updated_at),
        })
      }
      for (const c of collections) {
        entries.push({
          loc: `${base}/collections/${c.handle}`,
          lastmod: formatLastmod(c.updated_at),
        })
      }
      for (const pg of pages) {
        entries.push({
          loc: `${base}/pages/${pg.handle}`,
          lastmod: formatLastmod(pg.updated_at),
        })
      }
      for (const b of blogs) {
        entries.push({
          loc: `${base}/blogs/${b.handle}`,
          lastmod: formatLastmod(b.updated_at),
        })
        for (const a of b.articles ?? []) {
          entries.push({
            loc: `${base}/blogs/${b.handle}/${a.handle}`,
            lastmod: formatLastmod(a.updated_at),
          })
        }
      }

      // Emit the XML. No template engine — a tight map + join is
      // faster and exactly as readable.
      const xmlParts: string[] = []
      xmlParts.push('<?xml version="1.0" encoding="UTF-8"?>')
      xmlParts.push(
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      )
      for (const e of entries) {
        xmlParts.push('  <url>')
        xmlParts.push(`    <loc>${escapeXml(e.loc)}</loc>`)
        if (e.lastmod) {
          xmlParts.push(`    <lastmod>${e.lastmod}</lastmod>`)
        }
        xmlParts.push('  </url>')
      }
      xmlParts.push('</urlset>')
      xmlParts.push('')

      res.status(200)
      res.set('Content-Type', 'application/xml; charset=utf-8')
      res.set('Cache-Control', 'public, max-age=600')
      res.send(xmlParts.join('\n'))
    } catch (err) {
      next(err)
    }
  })

  return router as unknown as (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveBaseUrl(
  req: Request,
  override?: (req: Request) => string,
): string {
  if (override) return override(req).replace(/\/+$/, '')
  // Prefer X-Forwarded-Proto when behind nginx; otherwise use the
  // req protocol (http in tests, https in prod where trust proxy
  // is set).
  const forwardedProto = req.headers['x-forwarded-proto']
  const proto =
    (typeof forwardedProto === 'string' && forwardedProto.split(',')[0]) ||
    (req as unknown as { protocol?: string }).protocol ||
    'http'
  const forwardedHost = req.headers['x-forwarded-host']
  const host =
    (typeof forwardedHost === 'string' && forwardedHost.split(',')[0]) ||
    (typeof req.headers.host === 'string' ? req.headers.host : '')
  return `${proto}://${host}`.replace(/\/+$/, '')
}

function formatLastmod(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined
  // YYYY-MM-DD is sufficient granularity for sitemaps and sidesteps
  // the "which timezone" question.
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return undefined
  return d.toISOString().slice(0, 10)
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
