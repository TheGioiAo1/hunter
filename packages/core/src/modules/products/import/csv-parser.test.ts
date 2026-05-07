/**
 * CSV parser tests — exercises tokenizer edge cases and the row-grouping
 * contract (first row authoritative, subsequent rows extend variants/images).
 */

import { describe, it, expect } from 'vitest'
import {
  tokenizeCsv,
  parseCsv,
  HeaderIndex,
  ParseError,
} from './csv-parser.js'

// ---------------------------------------------------------------------------
// tokenizeCsv
// ---------------------------------------------------------------------------

describe('tokenizeCsv', () => {
  it('tokenizes a simple 2x2 grid', () => {
    const out = tokenizeCsv('a,b\n1,2\n')
    expect(out).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('handles quoted fields with commas', () => {
    const out = tokenizeCsv('a,b\n"hello, world","bye"\n')
    expect(out).toEqual([
      ['a', 'b'],
      ['hello, world', 'bye'],
    ])
  })

  it('handles escaped double-quotes inside quoted fields', () => {
    const out = tokenizeCsv('a\n"she said ""hi"""\n')
    expect(out).toEqual([['a'], ['she said "hi"']])
  })

  it('handles embedded newlines inside quoted fields', () => {
    const out = tokenizeCsv('a,b\n"line1\nline2",c\n')
    expect(out).toEqual([
      ['a', 'b'],
      ['line1\nline2', 'c'],
    ])
  })

  it('handles CRLF line endings', () => {
    const out = tokenizeCsv('a,b\r\n1,2\r\n')
    expect(out).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('handles file without trailing newline', () => {
    const out = tokenizeCsv('a,b\n1,2')
    expect(out).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('drops all-empty trailing rows', () => {
    const out = tokenizeCsv('a,b\n1,2\n,\n,\n')
    expect(out).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('throws ParseError on unterminated quote', () => {
    expect(() => tokenizeCsv('a,b\n"open\n')).toThrow(ParseError)
  })

  it('throws ParseError on stray quote mid-field', () => {
    expect(() => tokenizeCsv('a,b\nhe"llo,world\n')).toThrow(ParseError)
  })
})

// ---------------------------------------------------------------------------
// HeaderIndex
// ---------------------------------------------------------------------------

describe('HeaderIndex', () => {
  it('resolves canonical headers case-insensitively', () => {
    const hx = new HeaderIndex(['Handle', 'Title', 'Variant SKU'])
    expect(hx.index('HANDLE')).toBe(0)
    expect(hx.index('  title  ')).toBe(1)
    expect(hx.index('Variant SKU')).toBe(2)
    expect(hx.index('missing')).toBe(-1)
  })

  it('parses Shopify-format product metafield column', () => {
    const hx = new HeaderIndex([
      'Handle',
      'Product Metafield: custom.material [single_line_text_field]',
    ])
    expect(hx.metafieldColumns).toHaveLength(1)
    expect(hx.metafieldColumns[0]).toMatchObject({
      owner: 'product',
      namespace: 'custom',
      key: 'material',
      value_type: 'single_line_text_field',
      cacheKey: 'custom.material',
    })
  })

  it('parses Shopify-format variant metafield column', () => {
    const hx = new HeaderIndex([
      'Handle',
      'Variant Metafield: custom.ribbon [boolean]',
    ])
    expect(hx.metafieldColumns[0]).toMatchObject({
      owner: 'variant',
      namespace: 'custom',
      key: 'ribbon',
      value_type: 'boolean',
    })
  })

  it('captures unknown columns as extraColumns', () => {
    const hx = new HeaderIndex(['Handle', 'Custom Audit', 'Reserved Q'])
    expect(hx.extraColumns).toEqual(['Custom Audit', 'Reserved Q'])
  })

  it('returns empty string for missing column cell', () => {
    const hx = new HeaderIndex(['Handle'])
    expect(hx.get(['h1'], 'Missing')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// parseCsv — header-level validation
// ---------------------------------------------------------------------------

describe('parseCsv — top-level validation', () => {
  it('returns empty products on empty input', () => {
    const r = parseCsv('')
    expect(r.products).toEqual([])
    expect(r.headers).toEqual([])
  })

  it('throws ParseError when Handle column missing', () => {
    expect(() => parseCsv('Title,Body\nFoo,Bar\n')).toThrow(ParseError)
  })

  it('skips rows with blank Handle and logs a note', () => {
    const r = parseCsv('Handle,Title\n,Missing\n')
    expect(r.products).toHaveLength(0)
    expect(r.notes).toHaveLength(1)
    expect(r.notes[0]!.message).toMatch(/no Handle/i)
  })
})

// ---------------------------------------------------------------------------
// parseCsv — single-product single-variant
// ---------------------------------------------------------------------------

describe('parseCsv — single product', () => {
  it('parses a minimal single-variant product', () => {
    const csv = [
      'Handle,Title,Vendor,Type,Tags,Published,Status,Variant SKU,Variant Price,Option1 Name,Option1 Value',
      'tshirt,Red Tee,Gbox,Apparel,"new, sale",true,active,SKU-1,12.00,Size,Small',
    ].join('\n')
    const r = parseCsv(csv)

    expect(r.products).toHaveLength(1)
    const p = r.products[0]!
    expect(p.handle).toBe('tshirt')
    expect(p.title).toBe('Red Tee')
    expect(p.vendor).toBe('Gbox')
    expect(p.product_type).toBe('Apparel')
    expect(p.tags).toEqual(['new', 'sale'])
    expect(p.published).toBe(true)
    expect(p.status).toBe('active')
    expect(p.optionNames).toEqual(['Size', null, null])
    expect(p.variants).toHaveLength(1)
    expect(p.variants[0]).toMatchObject({
      sku: 'SKU-1',
      price: '12.00',
      option1: 'Small',
    })
  })

  it('parses variant deep fields (migration 054)', () => {
    const csv = [
      'Handle,Title,Variant SKU,Variant Price,Variant HS Code,Variant Country of Origin,Variant Inventory Policy,Variant Inventory Tracker',
      'hat,Cap,SKU-2,20.00,6505.00,vn,continue,shopify',
    ].join('\n')
    const r = parseCsv(csv)
    const v = r.products[0]!.variants[0]!
    expect(v.hs_code).toBe('6505.00')
    expect(v.country_of_origin).toBe('VN') // upper-cased
    expect(v.inventory_policy).toBe('continue')
    expect(v.inventory_tracker).toBe('shopify')
  })
})

// ---------------------------------------------------------------------------
// parseCsv — multi-row product
// ---------------------------------------------------------------------------

describe('parseCsv — multi-row grouping', () => {
  it('groups multiple variant rows under one product by Handle', () => {
    const csv = [
      'Handle,Title,Variant SKU,Option1 Name,Option1 Value,Variant Price',
      'tshirt,Red Tee,SKU-S,Size,Small,12.00',
      'tshirt,,SKU-M,,Medium,13.00',
      'tshirt,,SKU-L,,Large,14.00',
    ].join('\n')
    const r = parseCsv(csv)
    expect(r.products).toHaveLength(1)
    const p = r.products[0]!
    expect(p.title).toBe('Red Tee')
    expect(p.variants).toHaveLength(3)
    expect(p.variants.map((v) => v.sku)).toEqual(['SKU-S', 'SKU-M', 'SKU-L'])
    expect(p.variants.map((v) => v.option1)).toEqual(['Small', 'Medium', 'Large'])
  })

  it('appends extra image rows without duplicating variants', () => {
    const csv = [
      'Handle,Title,Variant SKU,Variant Price,Image Src,Image Alt Text,Image Position',
      'tshirt,Red Tee,SKU-1,12.00,https://img/1.jpg,Front,1',
      'tshirt,,,,https://img/2.jpg,Back,2',
      'tshirt,,,,https://img/3.jpg,Side,3',
    ].join('\n')
    const r = parseCsv(csv)
    const p = r.products[0]!
    expect(p.variants).toHaveLength(1) // only the first row contributes a variant
    expect(p.images).toHaveLength(3)
    expect(p.images.map((i) => i.src)).toEqual([
      'https://img/1.jpg',
      'https://img/2.jpg',
      'https://img/3.jpg',
    ])
  })

  it('deduplicates images with identical Src', () => {
    const csv = [
      'Handle,Title,Variant SKU,Image Src',
      'p1,Prod,SKU-1,https://img/a.jpg',
      'p1,,,https://img/a.jpg',
    ].join('\n')
    const p = parseCsv(csv).products[0]!
    expect(p.images).toHaveLength(1)
  })

  it('ignores product-level fields on subsequent rows (first row authoritative)', () => {
    const csv = [
      'Handle,Title,Vendor,Variant SKU',
      'p1,Original,VendorA,SKU-1',
      'p1,Overridden,VendorB,SKU-2',
    ].join('\n')
    const p = parseCsv(csv).products[0]!
    expect(p.title).toBe('Original')
    expect(p.vendor).toBe('VendorA')
  })

  it('preserves first-appearance order across multiple products', () => {
    const csv = [
      'Handle,Title,Variant SKU',
      'b,B Product,SKU-B',
      'a,A Product,SKU-A',
      'b,,SKU-B2',
    ].join('\n')
    const r = parseCsv(csv)
    expect(r.products.map((p) => p.handle)).toEqual(['b', 'a'])
  })
})

// ---------------------------------------------------------------------------
// parseCsv — metafields
// ---------------------------------------------------------------------------

describe('parseCsv — metafields', () => {
  it('attaches product metafields from first row only', () => {
    const csv = [
      'Handle,Title,Variant SKU,Product Metafield: custom.material [single_line_text_field]',
      'p1,Prod,SKU-1,cotton',
      'p1,,SKU-2,IGNORED',
    ].join('\n')
    const p = parseCsv(csv).products[0]!
    expect(p.metafields['custom.material']).toMatchObject({
      namespace: 'custom',
      key: 'material',
      value_type: 'single_line_text_field',
      value: 'cotton',
    })
    // Ensure the IGNORED row didn't overwrite
    expect(p.metafields['custom.material']!.value).toBe('cotton')
  })

  it('attaches variant metafields to the variant on that row', () => {
    const csv = [
      'Handle,Title,Variant SKU,Variant Metafield: custom.flag [boolean]',
      'p1,Prod,SKU-1,true',
      'p1,,SKU-2,false',
    ].join('\n')
    const p = parseCsv(csv).products[0]!
    expect(p.variants[0]!.metafields['custom.flag']!.value).toBe('true')
    expect(p.variants[1]!.metafields['custom.flag']!.value).toBe('false')
  })

  it('skips empty metafield cells', () => {
    const csv = [
      'Handle,Title,Variant SKU,Product Metafield: custom.material [single_line_text_field]',
      'p1,Prod,SKU-1,',
    ].join('\n')
    const p = parseCsv(csv).products[0]!
    expect(p.metafields).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// parseCsv — extra (forward-compat) columns
// ---------------------------------------------------------------------------

describe('parseCsv — extra columns', () => {
  it('preserves unknown columns on product.extraColumns', () => {
    const csv = [
      'Handle,Title,Variant SKU,Custom Audit,Reserved Q',
      'p1,Prod,SKU-1,auditor-X,Q9',
    ].join('\n')
    const p = parseCsv(csv).products[0]!
    expect(p.extraColumns).toEqual({
      'Custom Audit': 'auditor-X',
      'Reserved Q': 'Q9',
    })
  })
})
