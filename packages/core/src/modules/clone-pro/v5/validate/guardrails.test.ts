import { describe, it, expect } from 'vitest'
import {
  validateProducts, validateCollections, validatePages, validateMenuTree,
} from './guardrails.js'
import type { ScrapedProduct, ScrapedCollection, ScrapedPage, MenuTree } from '../types.js'

const validProduct: ScrapedProduct = {
  source_id: '1', handle: 'tee-a', title: 'Tee', body_html: '<p>x</p>',
  vendor: null, product_type: null, tags: [],
  images: [{ src: 'https://cdn.x/1.jpg', alt: null, position: 1 }],
  variants: [{
    source_id: 'v1', title: 'S', price: '29.00', compare_at_price: null,
    sku: null, inventory_quantity: null, option_values: ['S'],
    weight: null, weight_unit: null,
  }],
  options: [{ name: 'Size', position: 1, values: ['S', 'M'] }],
}

describe('validateProducts', () => {
  it('accepts product with handle + title + ≥1 image', () => {
    const { accepted, rejected } = validateProducts([validProduct])
    expect(accepted).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })

  it('rejects product with no images', () => {
    const bad = { ...validProduct, images: [] }
    const { accepted, rejected } = validateProducts([bad])
    expect(accepted).toHaveLength(0)
    expect(rejected[0].reason).toMatch(/image/i)
  })

  it('rejects product with empty handle', () => {
    const bad = { ...validProduct, handle: '' }
    const { accepted, rejected } = validateProducts([bad])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatch(/handle/i)
  })

  it('rejects product with empty title', () => {
    const bad = { ...validProduct, title: '   ' }
    const { accepted, rejected } = validateProducts([bad])
    expect(rejected).toHaveLength(1)
  })
})

describe('validateCollections', () => {
  const valid: ScrapedCollection = {
    source_id: '10', handle: 'sale', title: 'Sale', body_html: '',
    image: null, product_handles: ['a', 'b'],
  }

  it('accepts collection with ≥1 product reference', () => {
    const { accepted } = validateCollections([valid])
    expect(accepted).toHaveLength(1)
  })

  it('rejects collection with zero products', () => {
    const { rejected } = validateCollections([{ ...valid, product_handles: [] }])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatch(/empty/i)
  })
})

describe('validatePages', () => {
  const valid: ScrapedPage = {
    url: 'https://x.com/pages/about', slug: 'about',
    title: 'About', body_html: '<p>body</p>',
  }

  it('rejects URL that maps to blocked prefix (defence-in-depth)', () => {
    const { rejected } = validatePages([{ ...valid, url: 'https://x.com/products/tee' }])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatch(/blocked/i)
  })

  it('rejects page with no title', () => {
    const { rejected } = validatePages([{ ...valid, title: '' }])
    expect(rejected).toHaveLength(1)
  })
})

describe('validateMenuTree', () => {
  it('flags menu items whose URL does not resolve to any imported resource', () => {
    const tree: MenuTree = {
      handle: 'main', nodes: [
        { label: 'About', url: 'https://x.com/pages/about', children: [] },
        { label: 'Gone', url: 'https://x.com/pages/deadlink', children: [] },
      ],
    }
    const importedUrls = new Set(['https://x.com/pages/about'])
    const { tree: flagged } = validateMenuTree(tree, importedUrls)
    expect((flagged.nodes as any)[0].broken).toBeFalsy()
    expect((flagged.nodes as any)[1].broken).toBe(true)
  })
})
