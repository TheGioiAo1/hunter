/**
 * Unit tests for the Products CSV exporter.
 *
 * Coverage:
 *   - buildHeaders: core columns always present in Shopify order
 *   - buildHeaders: optional column groups (SEO, Cost, metafields) gated
 *   - productToRows: single variant / single image
 *   - productToRows: multi-variant (product fields only on first row)
 *   - productToRows: extra images emit trailing image-only rows
 *   - productToRows: status → Published + Status columns
 *   - productToRows: metafield cells placed on the right row/variant
 *   - exportProductsCsv: escaping (commas, quotes, newlines)
 *   - exportProductsCsv: empty product list ⇒ header-only
 *   - discoverMetafieldColumns: dedup + deterministic ordering
 *   - grams conversion from kg/g/lb/oz
 */

import { describe, it, expect } from 'vitest'
import {
  buildHeaders,
  CORE_COLUMNS,
  csvField,
  discoverMetafieldColumns,
  exportProductsCsv,
  metafieldHeader,
  productToRows,
  type ExportProduct,
  type ExportVariant,
  type MetafieldColumn,
} from './csv-exporter.js'

// ---------------------------------------------------------------------------
// Factories — keep tests readable without each re-declaring all fields
// ---------------------------------------------------------------------------

function makeVariant(overrides: Partial<ExportVariant> = {}): ExportVariant {
  return {
    id: 'v-1',
    sku: 'SKU-1',
    barcode: null,
    price: '12.00',
    compare_at_price: null,
    cost: null,
    grams: 0,
    weight: null,
    weight_unit: 'kg',
    inventory_quantity: 0,
    inventory_policy: 'deny',
    inventory_tracker: 'shopify',
    fulfillment_service: 'manual',
    requires_shipping: true,
    taxable: true,
    option1: null,
    option2: null,
    option3: null,
    image_url: null,
    hs_code: null,
    country_of_origin: null,
    metafields: {},
    ...overrides,
  }
}

function makeProduct(overrides: Partial<ExportProduct> = {}): ExportProduct {
  return {
    id: 'p-1',
    handle: 'shirt',
    title: 'T-Shirt',
    body_html: '<p>Cozy</p>',
    vendor: 'Acme',
    product_type: 'Apparel',
    tags: ['cotton', 'unisex'],
    status: 'active',
    published_at: '2026-04-01T00:00:00.000Z',
    seo_title: null,
    seo_description: null,
    variants: [makeVariant()],
    images: [],
    options: [],
    metafields: {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// csvField helper
// ---------------------------------------------------------------------------

describe('csvField', () => {
  it('returns plain strings untouched', () => {
    expect(csvField('plain')).toBe('plain')
  })

  it('wraps values containing commas in quotes', () => {
    expect(csvField('a, b')).toBe('"a, b"')
  })

  it('doubles quotes inside quoted values', () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
  })

  it('wraps values containing newlines', () => {
    expect(csvField('line1\nline2')).toBe('"line1\nline2"')
  })

  it('stringifies numbers', () => {
    expect(csvField(42)).toBe('42')
  })

  it('treats null and undefined as empty', () => {
    expect(csvField(null)).toBe('')
    expect(csvField(undefined)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

describe('buildHeaders', () => {
  it('returns core columns in Shopify order by default + SEO + Cost', () => {
    const headers = buildHeaders()
    expect(headers.slice(0, CORE_COLUMNS.length)).toEqual([...CORE_COLUMNS])
    // SEO + Cost columns ship by default
    expect(headers).toContain('SEO Title')
    expect(headers).toContain('SEO Description')
    expect(headers).toContain('Cost per item')
  })

  it('drops SEO columns when includeSeo=false', () => {
    const headers = buildHeaders({ includeSeo: false })
    expect(headers).not.toContain('SEO Title')
    expect(headers).not.toContain('SEO Description')
  })

  it('drops Cost column when includeCost=false', () => {
    const headers = buildHeaders({ includeCost: false })
    expect(headers).not.toContain('Cost per item')
  })

  it('appends metafield columns in order after core+SEO+Cost', () => {
    const mfCols: MetafieldColumn[] = [
      {
        owner: 'product',
        namespace: 'custom',
        key: 'material',
        value_type: 'single_line_text_field',
        cacheKey: 'custom.material',
        header: 'Product Metafield: custom.material [single_line_text_field]',
      },
      {
        owner: 'variant',
        namespace: 'custom',
        key: 'care',
        value_type: 'multi_line_text_field',
        cacheKey: 'custom.care',
        header: 'Variant Metafield: custom.care [multi_line_text_field]',
      },
    ]
    const headers = buildHeaders({ metafieldColumns: mfCols })
    expect(headers[headers.length - 2]).toBe(mfCols[0].header)
    expect(headers[headers.length - 1]).toBe(mfCols[1].header)
  })

  it('filters metafield columns by include flags', () => {
    const mfCols: MetafieldColumn[] = [
      {
        owner: 'product',
        namespace: 'custom',
        key: 'a',
        value_type: 'json',
        cacheKey: 'custom.a',
        header: 'Product Metafield: custom.a [json]',
      },
      {
        owner: 'variant',
        namespace: 'custom',
        key: 'b',
        value_type: 'json',
        cacheKey: 'custom.b',
        header: 'Variant Metafield: custom.b [json]',
      },
    ]
    const headersNoVariant = buildHeaders({
      metafieldColumns: mfCols,
      includeVariantMetafields: false,
    })
    expect(headersNoVariant).toContain(mfCols[0].header)
    expect(headersNoVariant).not.toContain(mfCols[1].header)
  })
})

describe('metafieldHeader', () => {
  it('builds Shopify-style header text for product metafields', () => {
    expect(
      metafieldHeader({
        owner: 'product',
        namespace: 'custom',
        key: 'material',
        value_type: 'single_line_text_field',
      }),
    ).toBe('Product Metafield: custom.material [single_line_text_field]')
  })

  it('distinguishes variant metafield headers', () => {
    expect(
      metafieldHeader({
        owner: 'variant',
        namespace: 'custom',
        key: 'care',
        value_type: 'multi_line_text_field',
      }),
    ).toBe('Variant Metafield: custom.care [multi_line_text_field]')
  })
})

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

describe('productToRows — single variant', () => {
  it('emits exactly one row', () => {
    const rows = productToRows(makeProduct())
    expect(rows).toHaveLength(1)
  })

  it('populates Handle, Title, Body, Vendor, Type, Tags, Published on the first row', () => {
    const headers = buildHeaders()
    const rows = productToRows(
      makeProduct({
        status: 'active',
        tags: ['a', 'b'],
      }),
    )
    const row = rows[0]
    expect(row[headers.indexOf('Handle')]).toBe('shirt')
    expect(row[headers.indexOf('Title')]).toBe('T-Shirt')
    expect(row[headers.indexOf('Body (HTML)')]).toBe('<p>Cozy</p>')
    expect(row[headers.indexOf('Vendor')]).toBe('Acme')
    expect(row[headers.indexOf('Type')]).toBe('Apparel')
    expect(row[headers.indexOf('Tags')]).toBe('a, b')
    expect(row[headers.indexOf('Published')]).toBe('TRUE')
    expect(row[headers.indexOf('Status')]).toBe('active')
  })

  it('populates variant fields on the single row', () => {
    const headers = buildHeaders()
    const rows = productToRows(
      makeProduct({
        variants: [
          makeVariant({
            sku: 'ABC-1',
            price: '19.99',
            compare_at_price: '29.99',
            inventory_quantity: 42,
            barcode: '1234567890',
            requires_shipping: true,
            taxable: false,
          }),
        ],
      }),
    )
    const row = rows[0]
    expect(row[headers.indexOf('Variant SKU')]).toBe('ABC-1')
    expect(row[headers.indexOf('Variant Price')]).toBe('19.99')
    expect(row[headers.indexOf('Variant Compare At Price')]).toBe('29.99')
    expect(row[headers.indexOf('Variant Inventory Qty')]).toBe('42')
    expect(row[headers.indexOf('Variant Barcode')]).toBe('1234567890')
    expect(row[headers.indexOf('Variant Requires Shipping')]).toBe('TRUE')
    expect(row[headers.indexOf('Variant Taxable')]).toBe('FALSE')
  })
})

describe('productToRows — status mapping', () => {
  it('draft status → Published=FALSE, Status=draft', () => {
    const headers = buildHeaders()
    const rows = productToRows(makeProduct({ status: 'draft' }))
    expect(rows[0][headers.indexOf('Published')]).toBe('FALSE')
    expect(rows[0][headers.indexOf('Status')]).toBe('draft')
  })

  it('archived status → Published=FALSE, Status=archived', () => {
    const headers = buildHeaders()
    const rows = productToRows(makeProduct({ status: 'archived' }))
    expect(rows[0][headers.indexOf('Published')]).toBe('FALSE')
    expect(rows[0][headers.indexOf('Status')]).toBe('archived')
  })
})

describe('productToRows — multi-variant', () => {
  it('emits one row per variant', () => {
    const rows = productToRows(
      makeProduct({
        variants: [
          makeVariant({ id: 'v1', option1: 'Red', sku: 'R' }),
          makeVariant({ id: 'v2', option1: 'Blue', sku: 'B' }),
          makeVariant({ id: 'v3', option1: 'Green', sku: 'G' }),
        ],
        options: [{ name: 'Color', position: 1 }],
      }),
    )
    expect(rows).toHaveLength(3)
  })

  it('populates product-level fields only on the first variant row', () => {
    const headers = buildHeaders()
    const rows = productToRows(
      makeProduct({
        title: 'Shirt',
        variants: [
          makeVariant({ id: 'v1', option1: 'Red' }),
          makeVariant({ id: 'v2', option1: 'Blue' }),
        ],
        options: [{ name: 'Color', position: 1 }],
      }),
    )
    const t = headers.indexOf('Title')
    const v = headers.indexOf('Vendor')
    expect(rows[0][t]).toBe('Shirt')
    expect(rows[0][v]).toBe('Acme')
    expect(rows[1][t]).toBe('')
    expect(rows[1][v]).toBe('')
  })

  it('repeats Option1 Name on every row but Option1 Value differs', () => {
    const headers = buildHeaders()
    const rows = productToRows(
      makeProduct({
        variants: [
          makeVariant({ id: 'v1', option1: 'Red' }),
          makeVariant({ id: 'v2', option1: 'Blue' }),
        ],
        options: [{ name: 'Color', position: 1 }],
      }),
    )
    const o1n = headers.indexOf('Option1 Name')
    const o1v = headers.indexOf('Option1 Value')
    expect(rows[0][o1n]).toBe('Color')
    expect(rows[1][o1n]).toBe('Color')
    expect(rows[0][o1v]).toBe('Red')
    expect(rows[1][o1v]).toBe('Blue')
  })
})

describe('productToRows — images', () => {
  it('puts first image on the first variant row', () => {
    const headers = buildHeaders()
    const rows = productToRows(
      makeProduct({
        images: [{ src: 'https://cdn/img1.png', alt: 'front', position: 1 }],
      }),
    )
    expect(rows[0][headers.indexOf('Image Src')]).toBe('https://cdn/img1.png')
    expect(rows[0][headers.indexOf('Image Position')]).toBe('1')
    expect(rows[0][headers.indexOf('Image Alt Text')]).toBe('front')
  })

  it('emits trailing image-only rows for additional images', () => {
    const headers = buildHeaders()
    const rows = productToRows(
      makeProduct({
        images: [
          { src: 'https://cdn/img1.png', alt: 'a', position: 1 },
          { src: 'https://cdn/img2.png', alt: 'b', position: 2 },
          { src: 'https://cdn/img3.png', alt: 'c', position: 3 },
        ],
      }),
    )
    // 1 variant row + 2 extra image rows
    expect(rows).toHaveLength(3)
    expect(rows[1][headers.indexOf('Handle')]).toBe('shirt')
    expect(rows[1][headers.indexOf('Title')]).toBe('')
    expect(rows[1][headers.indexOf('Image Src')]).toBe('https://cdn/img2.png')
    expect(rows[2][headers.indexOf('Image Src')]).toBe('https://cdn/img3.png')
  })
})

describe('productToRows — metafields', () => {
  const productCol: MetafieldColumn = {
    owner: 'product',
    namespace: 'custom',
    key: 'material',
    value_type: 'single_line_text_field',
    cacheKey: 'custom.material',
    header: 'Product Metafield: custom.material [single_line_text_field]',
  }
  const variantCol: MetafieldColumn = {
    owner: 'variant',
    namespace: 'custom',
    key: 'care',
    value_type: 'single_line_text_field',
    cacheKey: 'custom.care',
    header: 'Variant Metafield: custom.care [single_line_text_field]',
  }

  it('puts product metafield on the first row only', () => {
    const headers = buildHeaders({ metafieldColumns: [productCol] })
    const rows = productToRows(
      makeProduct({
        metafields: {
          'custom.material': {
            namespace: 'custom',
            key: 'material',
            value_type: 'single_line_text_field',
            value: '"cotton"',
          },
        },
        variants: [makeVariant({ id: 'v1' }), makeVariant({ id: 'v2' })],
        options: [{ name: 'Color', position: 1 }],
      }),
      { metafieldColumns: [productCol] },
    )
    const col = headers.indexOf(productCol.header)
    expect(rows[0][col]).toBe('"cotton"')
    expect(rows[1][col]).toBe('')
  })

  it('puts variant metafield on each variant row', () => {
    const headers = buildHeaders({ metafieldColumns: [variantCol] })
    const rows = productToRows(
      makeProduct({
        variants: [
          makeVariant({
            id: 'v1',
            metafields: {
              'custom.care': {
                namespace: 'custom',
                key: 'care',
                value_type: 'single_line_text_field',
                value: '"wash cold"',
              },
            },
          }),
          makeVariant({
            id: 'v2',
            metafields: {
              'custom.care': {
                namespace: 'custom',
                key: 'care',
                value_type: 'single_line_text_field',
                value: '"dry clean"',
              },
            },
          }),
        ],
      }),
      { metafieldColumns: [variantCol] },
    )
    const col = headers.indexOf(variantCol.header)
    expect(rows[0][col]).toBe('"wash cold"')
    expect(rows[1][col]).toBe('"dry clean"')
  })
})

// ---------------------------------------------------------------------------
// CSV serialization
// ---------------------------------------------------------------------------

describe('exportProductsCsv', () => {
  it('returns a header-only CSV for an empty list', () => {
    const csv = exportProductsCsv([])
    const [headerLine, ...rest] = csv.split('\n')
    expect(rest).toHaveLength(0)
    expect(headerLine).toContain('Handle')
    expect(headerLine).toContain('Title')
  })

  it('escapes commas and quotes in text fields', () => {
    const csv = exportProductsCsv([
      makeProduct({
        title: 'Hoodie, "Classic"',
        body_html: null,
        variants: [makeVariant()],
      }),
    ])
    // Header + 1 data line
    const lines = csv.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('"Hoodie, ""Classic"""')
  })

  it('escapes newlines in body_html', () => {
    const csv = exportProductsCsv([
      makeProduct({
        body_html: 'line1\nline2',
      }),
    ])
    // Newline inside a quoted field means the CSV string contains a literal
    // \n inside quotes — so splitting on \n will produce 3 pieces for a
    // header + one data row with one embedded newline.
    expect(csv.split('\n')).toHaveLength(3)
    expect(csv).toContain('"line1\nline2"')
  })
})

// ---------------------------------------------------------------------------
// Metafield column discovery
// ---------------------------------------------------------------------------

describe('discoverMetafieldColumns', () => {
  it('deduplicates identical rows', () => {
    const cols = discoverMetafieldColumns([
      { owner_type: 'product', namespace: 'custom', key: 'material', value_type: 'single_line_text_field' },
      { owner_type: 'product', namespace: 'custom', key: 'material', value_type: 'single_line_text_field' },
    ])
    expect(cols).toHaveLength(1)
  })

  it('puts product columns before variant columns', () => {
    const cols = discoverMetafieldColumns([
      { owner_type: 'variant', namespace: 'custom', key: 'care', value_type: 'single_line_text_field' },
      { owner_type: 'product', namespace: 'custom', key: 'material', value_type: 'single_line_text_field' },
    ])
    expect(cols[0].owner).toBe('product')
    expect(cols[1].owner).toBe('variant')
  })

  it('sorts within each owner group alphabetically by namespace.key', () => {
    const cols = discoverMetafieldColumns([
      { owner_type: 'product', namespace: 'custom', key: 'zeta', value_type: 'json' },
      { owner_type: 'product', namespace: 'custom', key: 'alpha', value_type: 'json' },
      { owner_type: 'product', namespace: 'abc', key: 'x', value_type: 'json' },
    ])
    expect(cols.map((c) => c.cacheKey)).toEqual(['abc.x', 'custom.alpha', 'custom.zeta'])
  })

  it('ignores unsupported owner_types (e.g. shop, order)', () => {
    const cols = discoverMetafieldColumns([
      { owner_type: 'shop', namespace: 'custom', key: 'x', value_type: 'json' },
      { owner_type: 'order', namespace: 'custom', key: 'y', value_type: 'json' },
      { owner_type: 'product', namespace: 'custom', key: 'z', value_type: 'json' },
    ])
    expect(cols).toHaveLength(1)
    expect(cols[0].cacheKey).toBe('custom.z')
  })
})

// ---------------------------------------------------------------------------
// Migration 054 — Variant HS Code + Country of Origin
// ---------------------------------------------------------------------------

describe('buildHeaders — variant deep fields (migration 054)', () => {
  it('includes Variant HS Code in the core header', () => {
    expect(buildHeaders()).toContain('Variant HS Code')
  })

  it('includes Variant Country of Origin in the core header', () => {
    expect(buildHeaders()).toContain('Variant Country of Origin')
  })

  it('positions the 053 columns after Status (core-tail, before metafields)', () => {
    const mfCol: MetafieldColumn = {
      owner: 'product',
      namespace: 'custom',
      key: 'mat',
      value_type: 'json',
      cacheKey: 'custom.mat',
      header: 'Product Metafield: custom.mat [json]',
    }
    const h = buildHeaders({ metafieldColumns: [mfCol] })
    const statusIdx = h.indexOf('Status')
    const hsIdx = h.indexOf('Variant HS Code')
    const cooIdx = h.indexOf('Variant Country of Origin')
    const mfIdx = h.indexOf(mfCol.header)
    expect(statusIdx).toBeGreaterThan(-1)
    expect(hsIdx).toBeGreaterThan(statusIdx)
    expect(cooIdx).toBeGreaterThan(statusIdx)
    // Metafields still land *after* the core tail, so 053 columns
    // do not slip past them.
    expect(mfIdx).toBeGreaterThan(cooIdx)
  })
})

describe('productToRows — variant deep fields (migration 054)', () => {
  it('emits hs_code + country_of_origin on each variant row', () => {
    const headers = buildHeaders()
    const rows = productToRows(
      makeProduct({
        variants: [
          makeVariant({ id: 'v1', hs_code: '6109.10.00', country_of_origin: 'VN' }),
          makeVariant({ id: 'v2', hs_code: '6109.10.01', country_of_origin: 'CN' }),
        ],
      }),
    )
    expect(rows).toHaveLength(2)
    expect(rows[0][headers.indexOf('Variant HS Code')]).toBe('6109.10.00')
    expect(rows[0][headers.indexOf('Variant Country of Origin')]).toBe('VN')
    expect(rows[1][headers.indexOf('Variant HS Code')]).toBe('6109.10.01')
    expect(rows[1][headers.indexOf('Variant Country of Origin')]).toBe('CN')
  })

  it('leaves hs_code + country_of_origin blank when null', () => {
    const headers = buildHeaders()
    const rows = productToRows(
      makeProduct({
        variants: [makeVariant({ hs_code: null, country_of_origin: null })],
      }),
    )
    expect(rows[0][headers.indexOf('Variant HS Code')]).toBe('')
    expect(rows[0][headers.indexOf('Variant Country of Origin')]).toBe('')
  })

  it('leaves the two columns blank on extra-image trailing rows', () => {
    const headers = buildHeaders()
    const rows = productToRows(
      makeProduct({
        variants: [makeVariant({ hs_code: '6109.10.00', country_of_origin: 'VN' })],
        images: [
          { src: 'a.jpg', alt: null, position: 1 },
          { src: 'b.jpg', alt: null, position: 2 },
        ],
      }),
    )
    // First row carries the variant data; second row is the extra-image row.
    expect(rows).toHaveLength(2)
    expect(rows[0][headers.indexOf('Variant HS Code')]).toBe('6109.10.00')
    // Extra image rows must not copy HS/COO — they belong to a specific
    // variant, not an image-only row.
    expect(rows[1][headers.indexOf('Variant HS Code')]).toBe('')
    expect(rows[1][headers.indexOf('Variant Country of Origin')]).toBe('')
  })
})
