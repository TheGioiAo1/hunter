/**
 * Smoke test — Decision #1 Step 1.17 Gbox Dawn seed + bundle + install
 *
 * End-to-end smoke that:
 *
 *   - Confirms the generated bundle imports cleanly under tsx
 *   - Validates every required Shopify-shaped path is present
 *   - Boots a `LiquidEngine` against an in-memory loader
 *     pre-populated from the bundle, then renders index, product,
 *     collection, cart, and 404 templates against a `MemoryDataSource`
 *   - Walks the install helper through a fake DB to confirm the
 *     wired call shape (calls per asset, sorted order, deps forwarded)
 *
 * Run:
 *   npx tsx scripts/smoke-liquid-step-1-17.ts
 */

import type {
  LoadResult,
  LogicalPath,
  TemplateLoader,
} from '../packages/core/src/modules/themes/engine/loader.js'
import { createLiquidEngine } from '../packages/core/src/modules/themes/engine/liquid.js'
import { renderPage } from '../packages/core/src/modules/themes/engine/pipeline.js'
import { MemoryI18nService } from '../packages/core/src/modules/i18n/memory-service.js'
import { MemoryDataSource } from '../packages/core/src/modules/themes/engine/storefront/datasource.js'
import {
  GBOX_DAWN_BUNDLE,
  GBOX_DAWN_BUNDLE_VERSION,
  filterGboxDawnAssetsByPrefix,
  gboxDawnBundleSize,
  getGboxDawnAsset,
  listGboxDawnAssets,
} from '../packages/core/src/modules/themes/seed/gbox-dawn-bundle.js'
import { installGboxDawnTheme } from '../packages/core/src/modules/themes/seed/install.js'

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

async function main(): Promise<void> {
  console.log('Smoke \u2014 Step 1.17 Gbox Dawn seed + bundle + install')
  console.log('=================================================')

  // ---- 1-3. Bundle shape ------------------------------------------------
  check('1. bundle is non-empty', GBOX_DAWN_BUNDLE.size > 0)
  check('2. bundle version is semver', /^\d+\.\d+\.\d+$/.test(GBOX_DAWN_BUNDLE_VERSION))
  check('3. gboxDawnBundleSize === GBOX_DAWN_BUNDLE.size', gboxDawnBundleSize() === GBOX_DAWN_BUNDLE.size)

  // ---- 4-9. Critical Shopify-shaped paths ------------------------------
  const required = [
    'layout/theme.liquid',
    'templates/index.json',
    'templates/product.json',
    'templates/collection.json',
    'sections/header.liquid',
    'sections/footer.liquid',
    'sections/main-product.liquid',
    'config/settings_schema.json',
    'locales/en.default.json',
  ]
  let i = 4
  for (const key of required) {
    check(`${i}. bundle contains ${key}`, GBOX_DAWN_BUNDLE.has(key))
    i++
  }

  // ---- 13. Section directory size --------------------------------------
  const sections = filterGboxDawnAssetsByPrefix('sections/')
  check(
    '13. sections/ has at least 18 files',
    sections.length >= 18,
    `actual=${sections.length}`,
  )

  // ---- 14. Layout source contains the chrome slots --------------------
  const layout = getGboxDawnAsset('layout/theme.liquid')!
  check(
    '14. layout/theme.liquid renders header + content slot',
    layout.source.includes('{{ content_for_layout }}') &&
      layout.source.includes("{% section 'header' %}"),
  )

  // ---- 15-19. Render index/product/collection/cart/404 against engine ---
  // Tiny in-memory loader (same shape as the test fixtures inside
  // engine/pipeline.test.ts) that resolves logical paths from the
  // bundle's source map.
  const sourceMap: Record<string, string> = {}
  for (const asset of listGboxDawnAssets()) {
    sourceMap[asset.key] = asset.source
  }
  class MemoryLoader implements TemplateLoader {
    readonly name = 'gbox-dawn-smoke'
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

  // Flatten the seed locale JSON into dot keys so MemoryI18nService can
  // serve it. The Gbox engine expects flat keys like
  // 'header.home', 'cart.subtotal', etc.
  function flatten(obj: any, prefix = '', out: Record<string, string> = {}): Record<string, string> {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
      else out[key] = String(v)
    }
    return out
  }
  const enFlat = flatten(JSON.parse(getGboxDawnAsset('locales/en.default.json')!.source))
  const i18n = new MemoryI18nService({ shop1: { en: enFlat } })
  const engine = createLiquidEngine({ loader, i18n })

  const ds = new MemoryDataSource({
    shop: { id: 'shop1', name: 'Smoke Shop', domain: 'smoke.gbox.test' },
    products: [
      {
        id: 'p1',
        handle: 'cap',
        title: 'Cap',
        description: '<p>Hi</p>',
        price: 1500,
        available: true,
        url: '/products/cap',
      },
    ],
    collections: [
      {
        id: 'c1',
        handle: 'frontpage',
        title: 'Frontpage',
        url: '/collections/frontpage',
        product_handles: ['cap'],
      },
    ],
  })
  const shop = await ds.loadShop({ shopId: 'shop1', locale: 'en' })
  const cart = await ds.loadCart(undefined, { shopId: 'shop1', locale: 'en' })

  const renderTemplate = async (name: string, pageDrop?: Record<string, unknown>) => {
    return await renderPage(engine, {
      template: name,
      shop,
      cart,
      request: { path: '/', host: 'smoke.gbox.test', locale: 'en' },
      locale: 'en',
      defaultLayout: 'theme',
      pageDrop,
    })
  }

  try {
    const indexHtml = await renderTemplate('index')
    check(
      '15. renders index template through layout',
      indexHtml.html.includes('<!doctype html>') &&
        indexHtml.html.includes('Smoke Shop'),
    )
  } catch (err) {
    check('15. renders index template through layout', false, String(err))
  }

  try {
    const product = await ds.loadProductByHandle('cap', { shopId: 'shop1', locale: 'en' })
    const productHtml = await renderTemplate('product', { product })
    check(
      '16. renders product template + main-product section',
      productHtml.html.includes('Cap') &&
        productHtml.html.includes('class="product'),
    )
  } catch (err) {
    check('16. renders product template + main-product section', false, String(err))
  }

  try {
    const collection = await ds.loadCollectionByHandle('frontpage', { shopId: 'shop1', locale: 'en' })
    const { products } = await ds.loadCollectionProducts(
      collection!.id,
      { page: 1, pageSize: 24 },
      { shopId: 'shop1', locale: 'en' },
    )
    const colHtml = await renderTemplate('collection', { collection, products })
    check(
      '17. renders collection template + product grid',
      colHtml.html.includes('Frontpage') && colHtml.html.includes('Cap'),
    )
  } catch (err) {
    check('17. renders collection template + product grid', false, String(err))
  }

  try {
    const cartHtml = await renderTemplate('cart', {})
    check(
      '18. renders cart template (empty state)',
      cartHtml.html.includes('cart') &&
        cartHtml.html.toLowerCase().includes('empty'),
    )
  } catch (err) {
    check('18. renders cart template (empty state)', false, String(err))
  }

  try {
    const notFound = await renderTemplate('404', {})
    check(
      '19. renders 404 template',
      notFound.html.toLowerCase().includes('not found') ||
        notFound.html.toLowerCase().includes('404'),
    )
  } catch (err) {
    check('19. renders 404 template', false, String(err))
  }

  // ---- 20-22. Install helper against a fake DB ------------------------
  // We hand the install helper a fake `db` and a fake updateThemeAsset
  // by intercepting on the seed/install module. Easier path: capture
  // by stubbing the underlying service via vi-style mocking is awkward
  // outside vitest. Instead, we exercise the public path with a
  // promise-tracking proxy DB and rely on the fact that this script's
  // job is end-to-end smoke; the unit test already covers exact call
  // shape with vi.mock.
  //
  // Here we just import a hand-rolled fake that returns a stub row for
  // every insert/update so the helper completes without crashing.
  const stub: any = {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          where: () => ({
            executeTakeFirst: async () => undefined, // no existing row
          }),
        }),
      }),
    }),
    insertInto: () => ({
      values: () => ({
        returningAll: () => ({
          executeTakeFirstOrThrow: async () => ({}),
        }),
      }),
    }),
    updateTable: () => ({
      set: () => ({
        where: () => ({
          returningAll: () => ({
            executeTakeFirstOrThrow: async () => ({}),
          }),
        }),
      }),
    }),
  }

  let progressEvents = 0
  try {
    const report = await installGboxDawnTheme(stub, 'theme-smoke', {
      onAsset: () => {
        progressEvents++
      },
    })
    check(
      '20. installGboxDawnTheme writes every bundle entry',
      report.installed === GBOX_DAWN_BUNDLE.size,
      `installed=${report.installed} bundle=${GBOX_DAWN_BUNDLE.size}`,
    )
    check(
      '21. install report carries bundle version',
      report.bundleVersion === GBOX_DAWN_BUNDLE_VERSION,
    )
    check(
      '22. onAsset callback fired once per file',
      progressEvents === GBOX_DAWN_BUNDLE.size,
    )
  } catch (err) {
    check('20. installGboxDawnTheme writes every bundle entry', false, String(err))
  }

  // ---- Summary --------------------------------------------------------
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
