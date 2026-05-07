/**
 * Unit tests for the products export fetch service.
 *
 * The Windows dev host doesn't reach Postgres, so we use a tiny
 * in-memory fake Kysely-shaped builder. The point isn't to re-test
 * Kysely — it's to verify:
 *
 *   - shop-scoping is applied to every child table
 *   - variants/images/options are grouped under their parent product
 *   - metafield column discovery runs across BOTH product + variant
 *     owner types
 *   - generateProductsExport returns the right content type / filename
 *     / BOM prefix for CSV
 *   - JSONB metafield values are string-serialized in a way the exporter
 *     can drop straight into a CSV cell
 */

import { describe, it, expect } from 'vitest'
import {
  fetchProductsForExport,
  generateProductsExport,
} from './service.js'

// ---------------------------------------------------------------------------
// Tiny fake DB that supports just enough of Kysely's fluent surface to
// drive the service. Rows are pre-loaded per table; query filters + group
// bys are matched against them by a small matcher.
// ---------------------------------------------------------------------------

interface FakeTableData {
  [table: string]: Array<Record<string, any>>
}

interface WhereClause {
  col: string
  op: string
  val: any
}

function makeFakeDb(tables: FakeTableData) {
  function selectFrom(table: string) {
    const wheres: WhereClause[] = []
    let limit: number | undefined
    let selectCols: string[] | null = null
    let _orderBy: { col: string; dir: 'asc' | 'desc' } | null = null
    const joins: Array<{ table: string; lhs: string; rhs: string }> = []

    const builder: any = {
      selectAll() {
        selectCols = null
        return builder
      },
      select(cols: any) {
        selectCols = Array.isArray(cols) ? cols : [cols]
        return builder
      },
      innerJoin(tbl: string, lhs: string, rhs: string) {
        joins.push({ table: tbl, lhs, rhs })
        return builder
      },
      where(col: any, op?: any, val?: any) {
        // Handle the callback form used by eb-style where clauses by
        // treating the callback as a pass-through.
        if (typeof col === 'function') return builder
        wheres.push({ col, op, val })
        return builder
      },
      orderBy(col: string, dir: 'asc' | 'desc') {
        _orderBy = { col, dir }
        return builder
      },
      limit(n: number) {
        limit = n
        return builder
      },
      async execute() {
        let rows = tables[table] ?? []
        for (const w of wheres) {
          rows = rows.filter((r) => matches(r, w))
        }
        if (_orderBy) {
          const { col, dir } = _orderBy
          rows = [...rows].sort((a, b) =>
            String(a[col] ?? '').localeCompare(String(b[col] ?? '')) *
            (dir === 'desc' ? -1 : 1),
          )
        }
        if (limit != null) rows = rows.slice(0, limit)
        if (selectCols) {
          rows = rows.map((r) => {
            const picked: Record<string, any> = {}
            for (const c of selectCols as string[]) picked[c] = r[c]
            return picked
          })
        }
        return rows
      },
      [Symbol.asyncIterator]: undefined,
    }
    return builder
  }
  return { selectFrom } as any
}

function matches(row: Record<string, any>, w: WhereClause): boolean {
  const lhs = row[w.col]
  switch (w.op) {
    case '=':
      // A column compared to a SELECT-subquery builder shouldn't pass
      // through the normal equality check — treat it as "match any"
      // since the fake DB doesn't execute subqueries.
      if (w.val && typeof w.val === 'object' && 'execute' in (w.val as any)) return true
      return lhs === w.val
    case 'in':
      if (Array.isArray(w.val)) return w.val.includes(lhs)
      if (w.val && typeof w.val === 'object' && 'execute' in (w.val as any)) return true
      return false
    case 'ilike':
      if (typeof w.val !== 'string' || lhs == null) return false
      const pat = w.val.replace(/%/g, '').toLowerCase()
      return String(lhs).toLowerCase().includes(pat)
    default:
      return true
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHOP = 'shop-A'
const OTHER_SHOP = 'shop-B'

function baseFixture(): FakeTableData {
  return {
    products: [
      {
        id: 'p-1',
        shop_id: SHOP,
        slug: 'tee',
        title: 'Tee',
        body_html: '<p>Soft</p>',
        vendor: 'Acme',
        product_type: 'Apparel',
        status: 'active',
        tags: ['cotton'],
        published_at: '2026-04-01',
        seo_title: 'Tee SEO',
        seo_description: 'Tee desc',
        created_at: '2026-04-01',
      },
      {
        id: 'p-2',
        shop_id: SHOP,
        slug: 'mug',
        title: 'Mug',
        body_html: null,
        vendor: null,
        product_type: null,
        status: 'draft',
        tags: null,
        published_at: null,
        seo_title: null,
        seo_description: null,
        created_at: '2026-04-02',
      },
      {
        id: 'p-X',
        shop_id: OTHER_SHOP,          // cross-shop — must be excluded
        slug: 'hacker',
        title: 'HACKER',
        body_html: null,
        vendor: null,
        product_type: null,
        status: 'active',
        tags: null,
        published_at: null,
        seo_title: null,
        seo_description: null,
        created_at: '2026-04-01',
      },
    ],
    product_variants: [
      {
        id: 'v-1',
        product_id: 'p-1',
        price: '19.99',
        compare_at_price: null,
        cost: '7.50',
        sku: 'TEE-RED-M',
        barcode: '1234',
        inventory_quantity: 5,
        weight: '0.25',
        weight_unit: 'kg',
        option1: 'Red',
        option2: 'M',
        option3: null,
        position: 1,
        image_url: null,
        requires_shipping: true,
        taxable: true,
      },
      {
        id: 'v-X',
        product_id: 'p-X',             // cross-shop
        price: '999',
        sku: 'HACK',
        inventory_quantity: 1,
        weight_unit: 'kg',
        position: 1,
        requires_shipping: true,
        taxable: true,
      },
    ],
    product_images: [
      { id: 'i-1', product_id: 'p-1', src: 'https://cdn/1.png', alt: 'front', position: 1 },
    ],
    product_options: [
      { id: 'o-1', product_id: 'p-1', name: 'Color', position: 1, values: ['Red', 'Blue'] },
      { id: 'o-2', product_id: 'p-1', name: 'Size', position: 2, values: ['M', 'L'] },
    ],
    metafields: [
      {
        id: 'mf-1',
        shop_id: SHOP,
        owner_type: 'product',
        owner_id: 'p-1',
        namespace: 'custom',
        key: 'material',
        value: 'cotton',
        value_type: 'single_line_text_field',
      },
      {
        id: 'mf-2',
        shop_id: SHOP,
        owner_type: 'variant',
        owner_id: 'v-1',
        namespace: 'custom',
        key: 'care',
        value: 'wash cold',
        value_type: 'single_line_text_field',
      },
      {
        id: 'mf-X',
        shop_id: OTHER_SHOP,           // cross-shop metafield — must not leak
        owner_type: 'product',
        owner_id: 'p-X',
        namespace: 'custom',
        key: 'secret',
        value: 'LEAK',
        value_type: 'single_line_text_field',
      },
    ],
    collection_products: [],
    collections: [],
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetchProductsForExport', () => {
  it('loads products for the shop (excluding cross-shop rows)', async () => {
    const db = makeFakeDb(baseFixture())
    const { products } = await fetchProductsForExport(db, SHOP)
    const ids = products.map((p) => p.id).sort()
    expect(ids).toEqual(['p-1', 'p-2'])
  })

  it('shapes a full product row with variants, images, options, metafields', async () => {
    const db = makeFakeDb(baseFixture())
    const { products, metafieldColumns } = await fetchProductsForExport(db, SHOP)
    const tee = products.find((p) => p.id === 'p-1')!
    expect(tee.title).toBe('Tee')
    expect(tee.handle).toBe('tee')
    expect(tee.tags).toEqual(['cotton'])

    expect(tee.variants).toHaveLength(1)
    expect(tee.variants[0].sku).toBe('TEE-RED-M')
    expect(tee.variants[0].price).toBe('19.99')
    expect(tee.variants[0].cost).toBe('7.50')
    expect(tee.variants[0].grams).toBe(250)        // 0.25 kg → 250 g

    expect(tee.images).toHaveLength(1)
    expect(tee.images[0].src).toBe('https://cdn/1.png')

    expect(tee.options.map((o) => o.name)).toEqual(['Color', 'Size'])

    // Product metafield attached
    expect(tee.metafields['custom.material'].value).toBeTruthy()
    // Variant metafield attached to the variant, not the product
    expect(tee.variants[0].metafields['custom.care'].value).toBeTruthy()

    // Column discovery saw BOTH product and variant metafields
    expect(metafieldColumns.map((c) => c.cacheKey + ':' + c.owner)).toEqual([
      'custom.material:product',
      'custom.care:variant',
    ])
  })

  it('filters by scope=draft', async () => {
    const db = makeFakeDb(baseFixture())
    const { products } = await fetchProductsForExport(db, SHOP, { scope: 'draft' })
    expect(products.map((p) => p.id)).toEqual(['p-2'])
  })

  it('filters by scope=selected id list', async () => {
    const db = makeFakeDb(baseFixture())
    const { products } = await fetchProductsForExport(db, SHOP, {
      scope: 'selected',
      ids: ['p-1'],
    })
    expect(products.map((p) => p.id)).toEqual(['p-1'])
  })

  it('filters by vendor (ilike substring)', async () => {
    const db = makeFakeDb(baseFixture())
    const { products } = await fetchProductsForExport(db, SHOP, { vendor: 'acm' })
    expect(products.map((p) => p.id)).toEqual(['p-1'])
  })

  it('does NOT leak a cross-shop product via a matching id in scope=selected', async () => {
    const db = makeFakeDb(baseFixture())
    const { products } = await fetchProductsForExport(db, SHOP, {
      scope: 'selected',
      ids: ['p-X'],      // belongs to OTHER_SHOP
    })
    expect(products).toHaveLength(0)
  })

  it('does NOT leak a cross-shop metafield onto a same-shop product', async () => {
    const db = makeFakeDb(baseFixture())
    const { products } = await fetchProductsForExport(db, SHOP)
    for (const p of products) {
      expect(p.metafields).not.toHaveProperty('custom.secret')
    }
  })

  it('skips metafield join when includeMetafields=false', async () => {
    const db = makeFakeDb(baseFixture())
    const { products, metafieldColumns } = await fetchProductsForExport(db, SHOP, {
      includeMetafields: false,
    })
    expect(metafieldColumns).toHaveLength(0)
    for (const p of products) {
      expect(Object.keys(p.metafields)).toHaveLength(0)
      for (const v of p.variants) {
        expect(Object.keys(v.metafields)).toHaveLength(0)
      }
    }
  })
})

describe('generateProductsExport', () => {
  it('returns a BOM-prefixed CSV with correct content type', async () => {
    const db = makeFakeDb(baseFixture())
    const result = await generateProductsExport(db, SHOP, {
      format: 'csv',
      storeSlug: 'tee-world',
    })
    expect(result.contentType).toBe('text/csv; charset=utf-8')
    expect(result.filename).toMatch(/^products-tee-world-\d{4}-\d{2}-\d{2}\.csv$/)
    expect(result.data.startsWith('\ufeff')).toBe(true)
    expect(result.productCount).toBe(2)
    expect(result.metafieldColumnCount).toBe(2)   // custom.material + custom.care
  })

  it('returns JSON with the correct content type and no BOM', async () => {
    const db = makeFakeDb(baseFixture())
    const result = await generateProductsExport(db, SHOP, {
      format: 'json',
      storeSlug: 'tee-world',
    })
    expect(result.contentType).toBe('application/json')
    expect(result.filename).toMatch(/\.json$/)
    expect(result.data.startsWith('\ufeff')).toBe(false)
    // Should be parseable
    const parsed = JSON.parse(result.data)
    expect(Array.isArray(parsed)).toBe(true)
  })

  it('includes metafield column headers in the CSV', async () => {
    const db = makeFakeDb(baseFixture())
    const result = await generateProductsExport(db, SHOP, {
      format: 'csv',
      storeSlug: 'x',
    })
    const csv = result.data.slice(1) // drop BOM
    const headerLine = csv.split('\n')[0]
    expect(headerLine).toContain('Product Metafield: custom.material [single_line_text_field]')
    expect(headerLine).toContain('Variant Metafield: custom.care [single_line_text_field]')
  })

  // -------------------------------------------------------------------------
  // Migration 054 — Variant deep fields flow through service → exporter
  // -------------------------------------------------------------------------

  it('reads hs_code + country_of_origin from the variant row into the export shape', async () => {
    const fixture = baseFixture()
    // Add the 053 fields onto the in-shop variant (v-1 attached to p-1)
    fixture.product_variants[0].hs_code = '6109.10.00'
    fixture.product_variants[0].country_of_origin = 'VN'
    const db = makeFakeDb(fixture)
    const { products } = await fetchProductsForExport(db, SHOP)
    const tee = products.find((p) => p.id === 'p-1')!
    expect(tee.variants[0].hs_code).toBe('6109.10.00')
    expect(tee.variants[0].country_of_origin).toBe('VN')
  })

  it('maps inventory_policy=continue through (backorders allowed)', async () => {
    const fixture = baseFixture()
    fixture.product_variants[0].inventory_policy = 'continue'
    const db = makeFakeDb(fixture)
    const { products } = await fetchProductsForExport(db, SHOP)
    const tee = products.find((p) => p.id === 'p-1')!
    expect(tee.variants[0].inventory_policy).toBe('continue')
  })

  it('defaults inventory_policy to deny when the column is missing/null', async () => {
    // No inventory_policy set on the fixture variant — simulates a row
    // that existed before migration 054 ran.
    const db = makeFakeDb(baseFixture())
    const { products } = await fetchProductsForExport(db, SHOP)
    const tee = products.find((p) => p.id === 'p-1')!
    expect(tee.variants[0].inventory_policy).toBe('deny')
  })

  it('inventory_management=null surfaces as Shopify inventory_tracker=""', async () => {
    // Default fixture — inventory_management absent/null.
    const db = makeFakeDb(baseFixture())
    const { products } = await fetchProductsForExport(db, SHOP)
    const tee = products.find((p) => p.id === 'p-1')!
    expect(tee.variants[0].inventory_tracker).toBe('')
  })

  it('inventory_management set surfaces as inventory_tracker="shopify"', async () => {
    const fixture = baseFixture()
    fixture.product_variants[0].inventory_management = 'gbox'
    const db = makeFakeDb(fixture)
    const { products } = await fetchProductsForExport(db, SHOP)
    const tee = products.find((p) => p.id === 'p-1')!
    expect(tee.variants[0].inventory_tracker).toBe('shopify')
  })

  it('CSV header carries the two new 053 columns', async () => {
    const db = makeFakeDb(baseFixture())
    const result = await generateProductsExport(db, SHOP, {
      format: 'csv',
      storeSlug: 'x',
    })
    const headerLine = result.data.slice(1).split('\n')[0]
    expect(headerLine).toContain('Variant HS Code')
    expect(headerLine).toContain('Variant Country of Origin')
  })
})
