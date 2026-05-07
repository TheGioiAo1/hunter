/**
 * Smoke test — Decision #1 Step 1.20 E2E HTTP smoke
 *
 * Boots an Express server in-process with the full LiquidJS engine
 * backed by the Gbox Dawn bundle (via MemoryLoader + MemoryDataSource),
 * then fires real HTTP requests against every storefront page type
 * and asserts 200 OK + expected HTML content.
 *
 * This validates the ENTIRE rendering stack end-to-end:
 *   Express adapter → Router → Locale → Route matching → Data loading →
 *   Pipeline (JSON/Liquid resolve → layout → sections → snippets) → HTML
 *
 * Run:
 *   npx tsx scripts/smoke-http-step-1-20.ts
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'

import type {
  LoadResult,
  LogicalPath,
  TemplateLoader,
} from '../packages/core/src/modules/themes/engine/loader.js'
import { createLiquidEngine } from '../packages/core/src/modules/themes/engine/liquid.js'
import { createExpressStorefrontHandler } from '../packages/core/src/modules/themes/engine/storefront/express-adapter.js'
import { createDefaultErrorLogger } from '../packages/core/src/modules/themes/engine/storefront/error-logger.js'
import { MemoryDataSource } from '../packages/core/src/modules/themes/engine/storefront/datasource.js'
import { MemoryI18nService } from '../packages/core/src/modules/i18n/memory-service.js'
import {
  getGboxDawnAsset,
  listGboxDawnAssets,
} from '../packages/core/src/modules/themes/seed/gbox-dawn-bundle.js'
import { prepareThemeConfig } from '../packages/core/src/modules/themes/engine/storefront/theme-config-loader.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++
    console.log(`  \u2713 ${name}`)
  } else {
    failed++
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`)
  }
}

function flatten(obj: any, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out[key] = String(v)
  }
  return out
}

async function httpGet(url: string): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body,
          headers: res.headers as Record<string, string>,
        })
      })
    }).on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Smoke \u2014 Step 1.20 E2E HTTP Storefront')
  console.log('=================================================')

  // ---- Build engine from Gbox Dawn bundle --------------------------------

  const sourceMap: Record<string, string> = {}
  for (const asset of listGboxDawnAssets()) {
    sourceMap[asset.key] = asset.source
  }

  class MemoryLoader implements TemplateLoader {
    readonly name = 'e2e-smoke'
    constructor(public readonly files: Record<string, string> = {}) {}
    async load(p: LogicalPath): Promise<string | null> {
      return this.files[p] ?? null
    }
    async loadWithMeta(p: LogicalPath): Promise<LoadResult | null> {
      const src = this.files[p]
      return src === undefined ? null : { source: src }
    }
    async exists(p: LogicalPath): Promise<boolean> {
      return p in this.files
    }
    async list(prefix = ''): Promise<LogicalPath[]> {
      return Object.keys(this.files).filter((k) => k.startsWith(prefix))
    }
  }

  const loader = new MemoryLoader(sourceMap)
  const enFlat = flatten(JSON.parse(getGboxDawnAsset('locales/en.default.json')!.source))
  const i18n = new MemoryI18nService({ shop1: { en: enFlat } })
  const engine = createLiquidEngine({ loader, i18n })

  const themeConfigResult = await prepareThemeConfig({ loader, i18n, shopId: 'shop1' })

  const ds = new MemoryDataSource({
    shop: { id: 'shop1', name: 'E2E Shop', domain: 'e2e.gbox.test' },
    products: [
      {
        id: 'p1',
        handle: 'cap',
        title: 'Baseball Cap',
        description: '<p>A great cap</p>',
        price: 2500,
        available: true,
        url: '/products/cap',
        vendor: 'TestBrand',
      },
    ],
    collections: [
      {
        id: 'c1',
        handle: 'summer',
        title: 'Summer Collection',
        url: '/collections/summer',
        product_handles: ['cap'],
      },
    ],
    pages: [
      {
        id: 'pg1',
        handle: 'about',
        title: 'About Us',
        content: '<p>About our store</p>',
        url: '/pages/about',
      },
    ],
    blogs: [
      {
        id: 'b1',
        handle: 'news',
        title: 'News',
        url: '/blogs/news',
        article_handles: ['hello'],
      },
    ],
    articles: [
      {
        id: 'a1',
        handle: 'hello',
        title: 'Hello World',
        content: '<p>First post</p>',
        url: '/blogs/news/hello',
        author: 'Thai',
      },
    ],
  })

  const errorLogger = createDefaultErrorLogger()

  const handler = createExpressStorefrontHandler({
    engine,
    datasource: ds,
    errorLogger,
    locales: { supported: ['en'], default: 'en' },
    themeConfig: themeConfigResult.themeConfig,
  })

  // ---- Boot Express server -----------------------------------------------

  const app = express()
  app.get('/health', (_req, res) => { res.json({ status: 'ok' }) })
  app.use(handler as any)

  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`
  console.log(`  Server listening on ${base}`)

  // ---- Fire requests -----------------------------------------------------

  try {
    // 1. Health check
    const health = await httpGet(`${base}/health`)
    check('1. /health returns 200', health.status === 200)

    // 2. Homepage
    const index = await httpGet(`${base}/`)
    check(
      '2. GET / renders homepage with layout',
      index.status === 200 &&
        index.body.includes('<!doctype html>') &&
        index.body.includes('E2E Shop'),
      `status=${index.status}`,
    )

    // 3. Product page
    const product = await httpGet(`${base}/products/cap`)
    check(
      '3. GET /products/cap renders product page',
      product.status === 200 &&
        product.body.includes('Baseball Cap') &&
        product.body.includes('class="product'),
      `status=${product.status}`,
    )

    // 4. Collection page
    const collection = await httpGet(`${base}/collections/summer`)
    check(
      '4. GET /collections/summer renders collection',
      collection.status === 200 &&
        collection.body.includes('Summer Collection'),
      `status=${collection.status}`,
    )

    // 5. Cart page
    const cart = await httpGet(`${base}/cart`)
    check(
      '5. GET /cart renders cart (empty state)',
      cart.status === 200 &&
        cart.body.toLowerCase().includes('cart'),
      `status=${cart.status}`,
    )

    // 6. 404 page
    const notFound = await httpGet(`${base}/nonexistent-page-xyz`)
    check(
      '6. GET /unknown returns 404 template',
      notFound.status === 404,
      `status=${notFound.status}`,
    )

    // 7. Search page
    const search = await httpGet(`${base}/search?q=cap`)
    check(
      '7. GET /search renders search page',
      search.status === 200 &&
        search.body.toLowerCase().includes('search'),
      `status=${search.status}`,
    )

    // 8. Content-Type is text/html
    check(
      '8. Response Content-Type includes text/html',
      (index.headers['content-type'] ?? '').includes('text/html'),
      `ct=${index.headers['content-type']}`,
    )

    // 9. POST returns 405
    const postResult = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(`${base}/`, { method: 'POST' }, (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
      })
      req.on('error', reject)
      req.end()
    })
    check('9. POST / returns 405', postResult.status === 405, `status=${postResult.status}`)

  } finally {
    server.close()
  }

  // ---- Summary -----------------------------------------------------------
  console.log('=================================================')
  console.log(`Passed: ${passed}`)
  console.log(`Failed: ${failed}`)
  if (failed > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Smoke test crashed:', err)
  process.exit(1)
})
