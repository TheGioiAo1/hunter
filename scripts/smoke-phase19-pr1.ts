/**
 * Gbox Platform — Phase 19 PR1 smoke (Clone Pro v5 — Shopify-native MVP)
 *
 * Offline end-to-end smoke. Mocks `fetch` with a static fixture map and
 * validates wiring across the whole pipeline without touching the
 * network or Postgres:
 *
 *   [1]      platform detector identifies Shopify from /products.json probe
 *   [2..3]   shopify-products scraper maps 1 product + preserves decimal price
 *   [4]      shopify-collections scraper links product handles through the pivot
 *   [5]      sitemap-pages scraper extracts only /pages/* URLs (R3 anti-mix)
 *   [6]      menu parser resolves relative anchors against source URL
 *   [7]      theme-tokens extracts :root CSS vars
 *   [8..9]   DESIGN.md export produces markdown + does NOT leak source host
 *            (Iron Rule 5 parity with admin surfaces)
 *   [10]     grader returns high-band letter for a high-quality clone
 *   [11]     validator rejects products without images (R3 guardrail)
 *   [12..14] end-to-end pipeline: platform=shopify, preview mounted,
 *            grade ≥ B, stats.productsImported=1
 *
 * Real-DB integration lives under tests/integration/ (not a smoke).
 *
 *   npx tsx scripts/smoke-phase19-pr1.ts
 */

import { runCloneProV5 } from '../packages/core/src/modules/clone-pro/v5/pipeline.js'
import { detectPlatform } from '../packages/core/src/modules/clone-pro/v5/platform-detect.js'
import { scrapeShopifyProducts } from '../packages/core/src/modules/clone-pro/v5/scrapers/shopify-products.js'
import { scrapeShopifyCollections } from '../packages/core/src/modules/clone-pro/v5/scrapers/shopify-collections.js'
import { scrapeSitemapPages } from '../packages/core/src/modules/clone-pro/v5/scrapers/sitemap-pages.js'
import { parseMenuTree } from '../packages/core/src/modules/clone-pro/v5/scrapers/menu-parser.js'
import { extractThemeTokens } from '../packages/core/src/modules/clone-pro/v5/scrapers/theme-tokens.js'
import { exportDesignMd } from '../packages/core/src/modules/clone-pro/v5/design-md-export.js'
import { gradeClone } from '../packages/core/src/modules/clone-pro/v5/grader.js'
import { validateProducts } from '../packages/core/src/modules/clone-pro/v5/validate/guardrails.js'

// ---------------------------------------------------------------------------
// Asserter
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`[ok] ${msg}`)
    passed++
  } else {
    console.error(`[fail] ${msg}`)
    failed++
  }
}

// ---------------------------------------------------------------------------
// Fixture map. Keys are the exact URL strings the scrapers construct via
// `new URL(path, 'https://demo.test').toString()`. Every unknown URL
// returns a 404 body so route-check failures look realistic.
// ---------------------------------------------------------------------------

function makeFixtures(): Record<
  string,
  { ok: boolean; status?: number; json?: () => Promise<any>; text?: () => Promise<string> }
> {
  const productBody = {
    products: [
      {
        id: 1,
        handle: 'tee',
        title: 'Tee',
        body_html: '<p>x</p>',
        vendor: 'Demo',
        product_type: null,
        tags: 'a,b',
        images: [{ src: 'https://cdn.demo.test/1.jpg', alt: null, position: 1 }],
        variants: [
          {
            id: 10,
            title: 'S',
            price: '29.00',
            compare_at_price: null,
            sku: 'T-S',
            inventory_quantity: 5,
            option1: 'S',
            option2: null,
            option3: null,
            weight: 100,
            weight_unit: 'g',
          },
        ],
        options: [{ name: 'Size', position: 1, values: ['S'] }],
      },
    ],
  }

  return {
    'https://demo.test/products.json?limit=1': {
      ok: true,
      json: async () => ({ products: [{ id: 1 }] }),
    },
    'https://demo.test/products.json?limit=250&page=1': {
      ok: true,
      json: async () => productBody,
    },
    'https://demo.test/products.json?limit=250&page=2': {
      ok: true,
      json: async () => ({ products: [] }),
    },
    'https://demo.test/collections.json?limit=250&page=1': {
      ok: true,
      json: async () => ({
        collections: [
          {
            id: 100,
            handle: 'all',
            title: 'All',
            body_html: null,
            image: null,
          },
        ],
      }),
    },
    'https://demo.test/collections.json?limit=250&page=2': {
      ok: true,
      json: async () => ({ collections: [] }),
    },
    'https://demo.test/collections/all/products.json?limit=250&page=1': {
      ok: true,
      json: async () => ({ products: [{ handle: 'tee' }] }),
    },
    'https://demo.test/collections/all/products.json?limit=250&page=2': {
      ok: true,
      json: async () => ({ products: [] }),
    },
    'https://demo.test/sitemap.xml': {
      ok: true,
      text: async () =>
        '<?xml version="1.0"?>\n<urlset><url><loc>https://demo.test/pages/about</loc></url></urlset>',
    },
    'https://demo.test/pages/about': {
      ok: true,
      text: async () =>
        '<html><head><title>About</title></head><body><main><p>Founded 2024.</p></main></body></html>',
    },
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const fixtures = makeFixtures()
  const fakeFetch = (async (url: any, _init?: any) => {
    const u = typeof url === 'string' ? url : url.toString()
    if (fixtures[u]) return fixtures[u]
    // Unknown URLs 404 — matters for any code that conditionally retries.
    return {
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => '',
    }
  }) as typeof globalThis.fetch

  // [1] platform detector
  const platform = await detectPlatform('https://demo.test', { fetch: fakeFetch })
  assert(
    platform === 'shopify',
    'platform detector identifies Shopify from /products.json probe',
  )

  // [2..3] products scraper
  const products = await scrapeShopifyProducts('https://demo.test', { fetch: fakeFetch })
  assert(
    products.length === 1 && products[0].handle === 'tee',
    'shopify-products scrapes + maps 1 product',
  )
  assert(
    products[0].variants[0].price === '29.00',
    'variant price preserved as decimal string (no float coercion)',
  )

  // [4] collections scraper
  const collections = await scrapeShopifyCollections('https://demo.test', { fetch: fakeFetch })
  assert(
    collections.length === 1 && collections[0].product_handles.length === 1,
    'shopify-collections scrapes + links product handles through pivot',
  )

  // [5] sitemap pages — R3 anti-mix only lets /pages/* through
  const pages = await scrapeSitemapPages('https://demo.test', { fetch: fakeFetch })
  assert(
    pages.length === 1 && pages[0].slug === 'about',
    'sitemap-pages extracts only /pages/* URLs (R3 anti-mix)',
  )

  // [6] menu parser resolves relative anchors
  const menu = parseMenuTree(
    '<html><body><header><nav><ul><li><a href="/pages/about">About</a></li></ul></nav></header></body></html>',
    'https://demo.test',
  )
  assert(
    menu.nodes.length === 1 && menu.nodes[0].url === 'https://demo.test/pages/about',
    'menu parser resolves relative URLs against source',
  )

  // [7] theme-tokens extracts :root CSS vars
  const tokens = extractThemeTokens(
    '<html><head><style>:root{--color-primary:#111;}</style></head></html>',
  )
  assert(tokens.colors.primary === '#111', 'theme-tokens extracts :root CSS vars')

  // [8..9] DESIGN.md export + Iron Rule 5 leak check
  const md = exportDesignMd({ shopName: 'Demo', tokens, sourceHost: 'demo.test' })
  assert(
    md.startsWith('# Demo') && md.includes('primary: #111'),
    'DESIGN.md exporter produces valid markdown',
  )
  assert(
    !md.includes('demo.test'),
    'Iron Rule 5: DESIGN.md does NOT leak source host',
  )

  // [10] grader — high-quality input → A or B
  const g = gradeClone({
    routeCheckPct: 0.95,
    productCompletenessPct: 0.98,
    cssTokenPct: 0.75,
    pageBodyPct: 0.9,
    menuResolutionPct: 0.9,
  })
  assert(
    g.letter === 'A' || g.letter === 'B',
    'grader returns high-band letter for high-quality clone',
  )

  // [11] validator — R3 anti-mix rejects images-less product
  const badProduct = { ...products[0], images: [] }
  const { rejected } = validateProducts([badProduct])
  assert(
    rejected.length === 1 && /image/i.test(rejected[0].reason),
    'validator rejects product without images (R3 guardrail)',
  )

  // [12..14] end-to-end pipeline (in-memory persist + mock preview)
  const result = await runCloneProV5(
    {
      jobId: 'smoke-1',
      shopId: 'shop-1',
      sourceUrl: 'https://demo.test',
      sourceHost: 'demo.test',
      scope: { products: true, collections: true, pages: true, menu: true, theme: true },
    },
    {
      scrapers: {
        detectPlatform: async () => 'shopify' as const,
        fetchHomepage: async () =>
          '<html><header><nav><ul><li><a href="/pages/about">About</a></li></ul></nav></header><style>:root{--color-primary:#111;}</style></html>',
        scrapeProducts: async () => products,
        scrapeCollections: async () => collections,
        scrapePages: async () => pages,
        parseMenu: parseMenuTree,
        extractTokens: extractThemeTokens,
      },
      persisters: {
        persistAll: async (args) => ({
          productsInserted: args.products.length,
          collectionsInserted: args.collections.length,
          pagesInserted: args.pages.length,
          menuItems: 1,
        }),
        mountPreview: async (jobId) => `https://${jobId}.clone-preview.gbox.local`,
      },
      verify: {
        routeCheck: async (urls) => ({
          total: urls.length,
          passCount: urls.length,
          passRate: 1,
          failures: [],
        }),
      },
    },
  )

  assert(result.platform === 'shopify', 'pipeline result.platform = shopify')
  assert(
    result.previewUrl.includes('.clone-preview.'),
    'pipeline mounts preview subdomain',
  )
  assert(
    result.grade.letter === 'A' || result.grade.letter === 'B',
    'end-to-end grade ≥ B',
  )
  assert(result.stats.productsImported === 1, 'pipeline stats.productsImported=1')

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
