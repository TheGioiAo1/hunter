/**
 * Phase 19 PR1 LIVE-DB smoke — Clone Pro v5 persisters against real Postgres.
 *
 * Not part of smoke-matrix (not windows-runnable — local box cannot reach PG).
 * Run from server 2: `DATABASE_URL=... npx tsx scripts/smoke-phase19-pr1-live-db.ts`
 *
 * Proves: migrations 091 + 091b landed correctly AND the persister stack can
 * write into the real schema under SERIALIZABLE isolation. Uses hand-crafted
 * DTOs (no network fetch — no allbirds.com bandwidth burn during review).
 * Self-cleans — shop row is DELETEd in a finally block; CASCADE removes all
 * dependent products/collections/pages/menus/theme tokens.
 */

import 'dotenv/config'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import type { Database } from '../packages/db/src/schema/tables.js'
import { runCloneImport } from '../packages/core/src/modules/clone-pro/v5/persisters/import-transaction.js'
import { persistProducts } from '../packages/core/src/modules/clone-pro/v5/persisters/products-persist.js'
import { persistCollections } from '../packages/core/src/modules/clone-pro/v5/persisters/collections-persist.js'
import { persistPages } from '../packages/core/src/modules/clone-pro/v5/persisters/pages-persist.js'
import { persistMenus } from '../packages/core/src/modules/clone-pro/v5/persisters/menus-persist.js'
import { persistTheme } from '../packages/core/src/modules/clone-pro/v5/persisters/theme-persist.js'
import type {
  ScrapedProduct,
  ScrapedCollection,
  ScrapedPage,
  ThemeTokens,
} from '../packages/core/src/modules/clone-pro/v5/types.js'
import type { FlaggedMenuTree } from '../packages/core/src/modules/clone-pro/v5/validate/guardrails.js'

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new Pool({ connectionString: DATABASE_URL }) }),
})

let passed = 0
let failed = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`[ok] ${msg}`)
    passed++
  } else {
    console.error(`[FAIL] ${msg}`)
    failed++
  }
}

const suffix = Math.random().toString(36).slice(2, 8)
const testSlug = `v5-smoke-${suffix}`
let shopId: string | null = null
let jobId: string | null = null

async function main(): Promise<void> {
  try {
    // ─── Seed test shop + clone job ─────────────────────────────────────
    const shop = await db
      .insertInto('shops')
      .values({
        name: `v5 smoke ${suffix}`,
        slug: testSlug,
        email: `smoke-${suffix}@test.gbox.local`,
      } as any)
      .returning('id')
      .executeTakeFirstOrThrow()
    shopId = shop.id as string
    assert(!!shopId, `seeded test shop (id=${shopId})`)

    const job = await db
      .insertInto('storefront_clone_jobs')
      .values({
        shop_id: shopId,
        source_url: 'https://demo.test',
        status: 'running',
      } as any)
      .returning('id')
      .executeTakeFirstOrThrow()
    jobId = job.id as string
    assert(!!jobId, `seeded test clone job (id=${jobId})`)

    // ─── DTO fixtures ────────────────────────────────────────────────────
    const products: ScrapedProduct[] = [
      {
        source_id: '1',
        handle: 'smoke-tee',
        title: 'Smoke Tee',
        body_html: '<p>test</p>',
        vendor: 'Smoke',
        product_type: 'Shirt',
        tags: ['smoke', 'test'],
        images: [{ src: 'https://cdn.test/1.jpg', alt: 'Tee', position: 1 }],
        variants: [
          {
            source_id: 'v1',
            title: 'S',
            price: '29.00',
            compare_at_price: null,
            sku: `SMOKE-${suffix}-S`,
            inventory_quantity: 5,
            option_values: ['S'],
            weight: 100,
            weight_unit: 'g',
          },
        ],
        options: [{ name: 'Size', position: 1, values: ['S', 'M', 'L'] }],
      },
    ]

    const collections: ScrapedCollection[] = [
      {
        source_id: '10',
        handle: 'smoke-sale',
        title: 'Smoke Sale',
        body_html: null,
        image: null,
        product_handles: ['smoke-tee'],
      },
    ]

    const pages: ScrapedPage[] = [
      {
        url: 'https://demo.test/pages/smoke-about',
        slug: `smoke-about-${suffix}`,
        title: 'Smoke About',
        body_html: '<p>Founded for smoke testing.</p>',
      },
    ]

    const menuTree: FlaggedMenuTree = {
      handle: `smoke-main-${suffix}`,
      nodes: [
        {
          label: 'Shop',
          url: 'https://demo.test/collections/smoke-sale',
          broken: false,
          children: [
            {
              label: 'Sale',
              url: 'https://demo.test/collections/smoke-sale',
              broken: false,
              children: [],
            },
          ],
        },
        { label: 'Dead', url: 'https://demo.test/dead', broken: true, children: [] },
      ],
    }

    const themeTokens: ThemeTokens = {
      colors: {
        primary: '#ff0000',
        secondary: '#00ff00',
        background: '#ffffff',
        text: '#000000',
      },
      typography: {
        heading_family: 'Helvetica',
        body_family: 'Inter',
        base_size_px: 16,
      },
      spacing: { base_px: 8 },
      radius_px: 4,
      raw_css_vars: { '--color-primary': '#ff0000' },
    }

    // ─── Drive the full persist stack under SERIALIZABLE ─────────────────
    const statsResult = await runCloneImport(db, jobId, async (tx) => {
      const pRes = await persistProducts(tx as any, shopId!, products)
      const cRes = await persistCollections(tx as any, shopId!, collections)
      const pgRes = await persistPages(tx as any, shopId!, pages)
      const mRes = await persistMenus(tx as any, shopId!, menuTree)
      await persistTheme(tx as any, shopId!, themeTokens)
      return {
        productsInserted: pRes.inserted,
        collectionsInserted: cRes.inserted,
        pagesInserted: pgRes.inserted,
        menuItems: mRes.itemsInserted,
      }
    })

    assert(statsResult.productsInserted === 1, `persist products returned inserted=1 (got ${statsResult.productsInserted})`)
    assert(statsResult.collectionsInserted === 1, `persist collections returned inserted=1`)
    assert(statsResult.pagesInserted === 1, `persist pages returned inserted=1`)
    assert(statsResult.menuItems === 3, `persist menus returned 3 items (Shop + Sale + Dead) — got ${statsResult.menuItems}`)

    // ─── Verify rows actually landed in DB ──────────────────────────────
    const productCount = await db
      .selectFrom('products')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('shop_id', '=', shopId)
      .executeTakeFirst()
    assert((productCount?.n ?? 0) === 1, `1 product row in products WHERE shop_id (got ${productCount?.n})`)

    const variantCount = await db
      .selectFrom('product_variants as pv')
      .innerJoin('products as p', 'p.id', 'pv.product_id')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('p.shop_id', '=', shopId)
      .executeTakeFirst()
    assert((variantCount?.n ?? 0) === 1, `1 variant via product join`)

    const optionCount = await db
      .selectFrom('product_options as po')
      .innerJoin('products as p', 'p.id', 'po.product_id')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('p.shop_id', '=', shopId)
      .executeTakeFirst()
    assert((optionCount?.n ?? 0) === 1, `1 product_options row`)

    const imageCount = await db
      .selectFrom('product_images as pi')
      .innerJoin('products as p', 'p.id', 'pi.product_id')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('p.shop_id', '=', shopId)
      .executeTakeFirst()
    assert((imageCount?.n ?? 0) === 1, `1 product_images row`)

    const collCount = await db
      .selectFrom('collections')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('shop_id', '=', shopId)
      .executeTakeFirst()
    assert((collCount?.n ?? 0) === 1, `1 collection row`)

    const pivotCount = await db
      .selectFrom('collection_products as cp')
      .innerJoin('collections as c', 'c.id', 'cp.collection_id')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('c.shop_id', '=', shopId)
      .executeTakeFirst()
    assert((pivotCount?.n ?? 0) === 1, `1 collection_products pivot row`)

    const pageCount = await db
      .selectFrom('pages')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('shop_id', '=', shopId)
      .executeTakeFirst()
    assert((pageCount?.n ?? 0) === 1, `1 page row`)

    const menuRow = await db
      .selectFrom('menus')
      .select(['id', 'slug', 'title'])
      .where('shop_id', '=', shopId)
      .executeTakeFirst()
    assert(menuRow?.slug === `smoke-main-${suffix}`, `menu row slug matches handle`)

    const menuItemRows = await db
      .selectFrom('menu_items')
      .select(['title', 'broken', 'depth', 'parent_id'])
      .where('menu_id', '=', menuRow!.id as string)
      .orderBy('position')
      .execute()
    assert(menuItemRows.length === 3, `3 menu_items rows`)
    const deadItem = menuItemRows.find((r) => r.title === 'Dead')
    assert(deadItem?.broken === true, `menu_items.broken=true for dead link`)
    const saleItem = menuItemRows.find((r) => r.title === 'Sale')
    assert((saleItem?.depth ?? 0) === 1, `menu_items.depth=1 for nested Sale item`)

    const themeRow = await db
      .selectFrom('shop_theme_tokens')
      .select(['shop_id', 'tokens_json'])
      .where('shop_id', '=', shopId)
      .executeTakeFirst()
    assert(!!themeRow, `shop_theme_tokens row exists`)
    const tokensJson = themeRow?.tokens_json as any
    assert(tokensJson?.colors?.primary === '#ff0000', `theme tokens_json.colors.primary = #ff0000`)

    // ─── Verify checkpoint written by runCloneImport ────────────────────
    const checkpointRow = await db
      .selectFrom('clone_checkpoints')
      .select(['phase', 'step'])
      .where('job_id', '=', jobId)
      .executeTakeFirst()
    assert(checkpointRow?.phase === 'persist' && checkpointRow?.step === 'complete', `clone_checkpoints row written by wrapper`)
  } finally {
    // ─── Self-clean ─────────────────────────────────────────────────────
    if (shopId) {
      try {
        // Cascade: products → variants/options/images → collections → pivot → pages → menus → menu_items
        // shop_theme_tokens cascades via FK.
        // clone_checkpoints cascades via storefront_clone_jobs FK.
        // storefront_clone_jobs deletion is manual (no shop FK cascade in that direction).
        await db.deleteFrom('collection_products')
          .where('collection_id', 'in',
            db.selectFrom('collections').select('id').where('shop_id', '=', shopId),
          )
          .execute()
        await db.deleteFrom('collections').where('shop_id', '=', shopId).execute()
        await db.deleteFrom('product_images')
          .where('product_id', 'in',
            db.selectFrom('products').select('id').where('shop_id', '=', shopId),
          )
          .execute()
        await db.deleteFrom('product_variants')
          .where('product_id', 'in',
            db.selectFrom('products').select('id').where('shop_id', '=', shopId),
          )
          .execute()
        await db.deleteFrom('product_options')
          .where('product_id', 'in',
            db.selectFrom('products').select('id').where('shop_id', '=', shopId),
          )
          .execute()
        await db.deleteFrom('products').where('shop_id', '=', shopId).execute()
        await db.deleteFrom('pages').where('shop_id', '=', shopId).execute()
        await db.deleteFrom('menu_items')
          .where('menu_id', 'in',
            db.selectFrom('menus').select('id').where('shop_id', '=', shopId),
          )
          .execute()
        await db.deleteFrom('menus').where('shop_id', '=', shopId).execute()
        await db.deleteFrom('shop_theme_tokens').where('shop_id', '=', shopId).execute()
        if (jobId) {
          await db.deleteFrom('clone_checkpoints').where('job_id', '=', jobId).execute()
          await db.deleteFrom('storefront_clone_jobs').where('id', '=', jobId).execute()
        }
        await db.deleteFrom('shops').where('id', '=', shopId).execute()
        console.log(`[cleanup] removed test shop + all dependents`)
      } catch (e) {
        console.error(`[cleanup-failed]`, (e as Error).message)
      }
    }
    await db.destroy()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
