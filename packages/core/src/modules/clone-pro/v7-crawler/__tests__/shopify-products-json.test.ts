import { describe, it, expect } from 'vitest'
import { fetchShopifyProductsJson, shopifyProductToRow, baseOriginOf } from '../shopify-products-json.js'

const SAMPLE_RESPONSE = {
  products: [
    {
      id: 1,
      title: 'Alpha Bookmark',
      handle: 'alpha-bookmark',
      body_html: '<p>A long body html description that exceeds two hundred characters in length so the quality gate passes for the smoke test that checks description length is at least two hundred characters and we want this to be long enough.</p>',
      vendor: 'BrandX',
      product_type: 'Bookmark',
      tags: ['t1', 't2'],
      images: [
        { src: 'https://cdn.shopify.com/i/1.jpg' },
        { src: 'https://cdn.shopify.com/i/2.jpg' },
        { src: 'https://cdn.shopify.com/i/3.jpg' },
      ],
      variants: [
        { id: 11, title: 'Red', price: '14.95', compare_at_price: '19.95', sku: 'A-RED' },
        { id: 12, title: 'Blue', price: '14.95', compare_at_price: null, sku: 'A-BLU' },
      ],
      options: [{ name: 'Color', position: 1, values: ['Red', 'Blue'] }],
    },
  ],
}

describe('shopify-products-json', () => {
  describe('baseOriginOf', () => {
    it('strips path and query from a collection URL', () => {
      expect(baseOriginOf('https://shop.example.com/collections/all?page=2')).toBe('https://shop.example.com')
    })
    it('preserves origin only for any URL', () => {
      expect(baseOriginOf('https://www.bibliobloom.com/products/x')).toBe('https://www.bibliobloom.com')
    })
  })

  describe('shopifyProductToRow', () => {
    it('maps a single Shopify product to a v7 Row', () => {
      const p = SAMPLE_RESPONSE.products[0]
      const row = shopifyProductToRow(p, 'https://shop.example.com')
      expect(row.Title).toBe('Alpha Bookmark')
      expect(row.Link).toBe('https://shop.example.com/products/alpha-bookmark')
      expect(row.ImageUrls).toEqual([
        'https://cdn.shopify.com/i/1.jpg',
        'https://cdn.shopify.com/i/2.jpg',
        'https://cdn.shopify.com/i/3.jpg',
      ])
      expect(row.Description).toContain('long body html')
      expect(row.Price).toBe(14.95)
      expect(row.OldPrice).toBe(19.95)
      expect(row.tags).toEqual(['t1', 't2'])
      expect(row.Spin).toEqual(['Red', 'Blue'])
      expect(row.ImageUrlType).toBe('ONLINE')
    })

    it('handles a product with no compare_at_price (null OldPrice)', () => {
      const p = { ...SAMPLE_RESPONSE.products[0], variants: [{ id: 1, title: 'X', price: '5.00', compare_at_price: null, sku: 'X' }] }
      const row = shopifyProductToRow(p, 'https://shop.example.com')
      expect(row.OldPrice).toBeNull()
    })

    it('handles a product with no images (empty array)', () => {
      const p = { ...SAMPLE_RESPONSE.products[0], images: [] }
      const row = shopifyProductToRow(p, 'https://shop.example.com')
      expect(row.ImageUrls).toEqual([])
    })
  })

  describe('fetchShopifyProductsJson', () => {
    it('fetches /products.json and paginates until limit is reached or empty', async () => {
      const calls: string[] = []
      const fetchFn = async (url: string): Promise<string> => {
        calls.push(url)
        if (url.includes('page=1')) return JSON.stringify({ products: SAMPLE_RESPONSE.products })
        if (url.includes('page=2')) return JSON.stringify({ products: SAMPLE_RESPONSE.products })
        return JSON.stringify({ products: [] })
      }
      const rows = await fetchShopifyProductsJson('https://shop.example.com/collections/all', {
        perPage: 1,
        limit: 2,
        fetch: fetchFn,
      })
      expect(rows).toHaveLength(2)
      expect(calls.length).toBeGreaterThanOrEqual(2)
    })

    it('stops paginating on empty response', async () => {
      let count = 0
      const fetchFn = async (): Promise<string> => {
        count += 1
        if (count === 1) return JSON.stringify({ products: SAMPLE_RESPONSE.products })
        return JSON.stringify({ products: [] })
      }
      const rows = await fetchShopifyProductsJson('https://shop.example.com', {
        fetch: fetchFn,
      })
      expect(rows).toHaveLength(1)
    })

    it('returns empty array on malformed JSON', async () => {
      const fetchFn = async (): Promise<string> => 'not json'
      const rows = await fetchShopifyProductsJson('https://shop.example.com', { fetch: fetchFn })
      expect(rows).toEqual([])
    })
  })
})
