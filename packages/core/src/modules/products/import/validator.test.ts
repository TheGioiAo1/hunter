/**
 * Validator tests — every rule gets at least a positive + negative case.
 */

import { describe, it, expect } from 'vitest'
import { validateParsed } from './validator.js'
import type { ParsedProduct, ParsedVariant } from './csv-parser.js'

function makeVariant(overrides: Partial<ParsedVariant> = {}): ParsedVariant {
  return {
    sourceRow: 2,
    sku: 'SKU-1',
    barcode: null,
    price: '10.00',
    compare_at_price: null,
    cost: null,
    grams: 100,
    weight_unit: 'g',
    inventory_quantity: 5,
    inventory_policy: 'deny',
    inventory_tracker: '',
    fulfillment_service: 'manual',
    requires_shipping: true,
    taxable: true,
    option1: 'Small',
    option2: null,
    option3: null,
    image_url: null,
    hs_code: null,
    country_of_origin: null,
    metafields: {},
    ...overrides,
  }
}

function makeProduct(overrides: Partial<ParsedProduct> = {}): ParsedProduct {
  return {
    sourceRow: 2,
    handle: 'tshirt',
    title: 'Red Tee',
    body_html: null,
    vendor: null,
    product_type: null,
    tags: null,
    published: null,
    status: 'active',
    seo_title: null,
    seo_description: null,
    gift_card: null,
    variants: [makeVariant()],
    images: [],
    optionNames: ['Size', null, null],
    metafields: {},
    extraColumns: {},
    ...overrides,
  }
}

describe('validateParsed — baseline', () => {
  it('a minimal well-formed product has zero errors', () => {
    const r = validateParsed([makeProduct()])
    expect(r.issues.filter((i) => i.severity === 'error')).toHaveLength(0)
    expect(r.blockedProducts).toBe(0)
  })
})

describe('validateParsed — handle', () => {
  it('flags invalid handle format', () => {
    const r = validateParsed([makeProduct({ handle: 'Has Spaces' })])
    expect(r.issues.find((i) => i.code === 'handle_invalid_format')).toBeTruthy()
    expect(r.blockedHandles.has('Has Spaces')).toBe(true)
  })

  it('accepts kebab-case and numeric handles', () => {
    for (const h of ['tshirt', 'tshirt-xl', 'abc-123', '12-pack']) {
      const r = validateParsed([makeProduct({ handle: h })])
      expect(r.issues.find((i) => i.code === 'handle_invalid_format')).toBeFalsy()
    }
  })

  it('flags duplicate handle across products', () => {
    const r = validateParsed([
      makeProduct({ handle: 'dup' }),
      makeProduct({ handle: 'dup', sourceRow: 10 }),
    ])
    expect(
      r.issues.filter((i) => i.code === 'handle_duplicate_in_upload'),
    ).toHaveLength(1) // single report per handle
    expect(r.blockedHandles.has('dup')).toBe(true)
  })
})

describe('validateParsed — title', () => {
  it('flags missing title', () => {
    const r = validateParsed([makeProduct({ title: null })])
    expect(r.issues.find((i) => i.code === 'title_required')).toBeTruthy()
  })

  it('flags whitespace-only title', () => {
    const r = validateParsed([makeProduct({ title: '   ' })])
    expect(r.issues.find((i) => i.code === 'title_required')).toBeTruthy()
  })
})

describe('validateParsed — status enum', () => {
  it('accepts active/draft/archived', () => {
    for (const s of ['active', 'draft', 'archived']) {
      const r = validateParsed([makeProduct({ status: s })])
      expect(r.issues.find((i) => i.code === 'status_invalid')).toBeFalsy()
    }
  })

  it('rejects unknown status', () => {
    const r = validateParsed([makeProduct({ status: 'foo' })])
    expect(r.issues.find((i) => i.code === 'status_invalid')).toBeTruthy()
  })
})

describe('validateParsed — variants presence', () => {
  it('flags product with no variants', () => {
    const r = validateParsed([makeProduct({ variants: [] })])
    expect(r.issues.find((i) => i.code === 'no_variants')).toBeTruthy()
  })
})

describe('validateParsed — option values', () => {
  it('requires option1 value when option1 name is set', () => {
    const r = validateParsed([
      makeProduct({
        optionNames: ['Size', null, null],
        variants: [makeVariant({ option1: null })],
      }),
    ])
    expect(r.issues.find((i) => i.code === 'option1_required')).toBeTruthy()
  })

  it('does not require option1 value when name is missing', () => {
    const r = validateParsed([
      makeProduct({
        optionNames: [null, null, null],
        variants: [makeVariant({ option1: null })],
      }),
    ])
    expect(r.issues.find((i) => i.code === 'option1_required')).toBeFalsy()
  })

  it('flags duplicate option combos', () => {
    const r = validateParsed([
      makeProduct({
        variants: [
          makeVariant({ sku: 'A', option1: 'Small', sourceRow: 2 }),
          makeVariant({ sku: 'B', option1: 'Small', sourceRow: 3 }),
        ],
      }),
    ])
    expect(r.issues.find((i) => i.code === 'variant_duplicate_options')).toBeTruthy()
  })
})

describe('validateParsed — SKU uniqueness', () => {
  it('flags duplicate SKU within product', () => {
    const r = validateParsed([
      makeProduct({
        variants: [
          makeVariant({ sku: 'DUP', option1: 'Small', sourceRow: 2 }),
          makeVariant({ sku: 'DUP', option1: 'Medium', sourceRow: 3 }),
        ],
      }),
    ])
    expect(r.issues.find((i) => i.code === 'sku_duplicate_in_product')).toBeTruthy()
  })

  it('allows null SKUs to coexist (no uniqueness check on null)', () => {
    const r = validateParsed([
      makeProduct({
        variants: [
          makeVariant({ sku: null, option1: 'Small' }),
          makeVariant({ sku: null, option1: 'Medium' }),
        ],
      }),
    ])
    expect(r.issues.find((i) => i.code === 'sku_duplicate_in_product')).toBeFalsy()
  })
})

describe('validateParsed — numeric fields', () => {
  it('flags non-decimal price', () => {
    const r = validateParsed([makeProduct({ variants: [makeVariant({ price: 'abc' })] })])
    expect(r.issues.find((i) => i.code === 'decimal_invalid')).toBeTruthy()
  })

  it('flags negative price (regex rejects leading -)', () => {
    const r = validateParsed([makeProduct({ variants: [makeVariant({ price: '-1.00' })] })])
    expect(r.issues.find((i) => i.code === 'decimal_invalid')).toBeTruthy()
  })

  it('accepts empty-string price as "leave unchanged"', () => {
    const r = validateParsed([makeProduct({ variants: [makeVariant({ price: '' })] })])
    expect(r.issues.find((i) => i.code === 'decimal_invalid')).toBeFalsy()
  })

  it('flags negative inventory qty', () => {
    const r = validateParsed([
      makeProduct({ variants: [makeVariant({ inventory_quantity: -5 })] }),
    ])
    expect(r.issues.find((i) => i.code === 'inventory_quantity_negative')).toBeTruthy()
  })

  it('flags negative grams', () => {
    const r = validateParsed([makeProduct({ variants: [makeVariant({ grams: -1 })] })])
    expect(r.issues.find((i) => i.code === 'grams_negative')).toBeTruthy()
  })
})

describe('validateParsed — enums on variants', () => {
  it('rejects unknown inventory_policy', () => {
    const r = validateParsed([
      makeProduct({ variants: [makeVariant({ inventory_policy: 'bogus' })] }),
    ])
    expect(r.issues.find((i) => i.code === 'inventory_policy_invalid')).toBeTruthy()
  })

  it('warns on unknown inventory_tracker instead of blocking', () => {
    const r = validateParsed([
      makeProduct({ variants: [makeVariant({ inventory_tracker: 'amazon' })] }),
    ])
    const issue = r.issues.find((i) => i.code === 'inventory_tracker_unknown')
    expect(issue).toBeTruthy()
    expect(issue!.severity).toBe('warning')
  })

  it('warns on unknown weight_unit instead of blocking', () => {
    const r = validateParsed([
      makeProduct({ variants: [makeVariant({ weight_unit: 'stones' })] }),
    ])
    const issue = r.issues.find((i) => i.code === 'weight_unit_unknown')
    expect(issue).toBeTruthy()
    expect(issue!.severity).toBe('warning')
  })
})

describe('validateParsed — migration 054 deep fields', () => {
  it('accepts uppercase 2-letter country_of_origin', () => {
    const r = validateParsed([
      makeProduct({ variants: [makeVariant({ country_of_origin: 'VN' })] }),
    ])
    expect(r.issues.find((i) => i.code === 'country_of_origin_invalid')).toBeFalsy()
  })

  it('rejects lowercase country_of_origin (CSV parser up-cases; this guards post-bypass)', () => {
    const r = validateParsed([
      makeProduct({ variants: [makeVariant({ country_of_origin: 'vn' })] }),
    ])
    expect(r.issues.find((i) => i.code === 'country_of_origin_invalid')).toBeTruthy()
  })

  it('rejects 3-letter country_of_origin (common mistake: USA instead of US)', () => {
    const r = validateParsed([
      makeProduct({ variants: [makeVariant({ country_of_origin: 'USA' })] }),
    ])
    expect(r.issues.find((i) => i.code === 'country_of_origin_invalid')).toBeTruthy()
  })

  it('rejects hs_code > 14 chars', () => {
    const r = validateParsed([
      makeProduct({ variants: [makeVariant({ hs_code: '123456789012345' })] }),
    ])
    expect(r.issues.find((i) => i.code === 'hs_code_too_long')).toBeTruthy()
  })

  it('accepts hs_code at exactly 14 chars', () => {
    const r = validateParsed([
      makeProduct({ variants: [makeVariant({ hs_code: '12345678901234' })] }),
    ])
    expect(r.issues.find((i) => i.code === 'hs_code_too_long')).toBeFalsy()
  })
})

describe('validateParsed — blockedProducts tally', () => {
  it('counts unique handles with at least one error', () => {
    const r = validateParsed([
      makeProduct({ handle: 'p1', title: null }), // error
      makeProduct({ handle: 'p2', title: 'Fine' }), // ok
      makeProduct({ handle: 'p3', status: 'invalid' }), // error
    ])
    expect(r.blockedProducts).toBe(2)
    expect(r.blockedHandles.size).toBe(2)
  })

  it('warnings alone do not block', () => {
    const r = validateParsed([
      makeProduct({
        handle: 'p1',
        variants: [makeVariant({ inventory_tracker: 'weird' })],
      }),
    ])
    expect(r.blockedProducts).toBe(0)
  })
})
