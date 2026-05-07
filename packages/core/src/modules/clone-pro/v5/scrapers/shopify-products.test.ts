import { describe, it, expect, vi } from 'vitest'
import { scrapeShopifyProducts } from './shopify-products.js'

const page1 = {
  products: [
    {
      id: 123, handle: 'tee-a', title: 'Tee A', body_html: '<p>A</p>',
      vendor: 'Allbirds', product_type: 'Shirt', tags: 'cotton,organic',
      images: [{ src: 'https://cdn.x/1.jpg', alt: null, position: 1 }],
      variants: [{
        id: 901, title: 'S', price: '29.00', compare_at_price: null,
        sku: 'TEE-A-S', inventory_quantity: 10, option1: 'S', option2: null, option3: null,
        weight: 200, weight_unit: 'g',
      }],
      options: [{ name: 'Size', position: 1, values: ['S', 'M', 'L'] }],
    },
  ],
}

describe('scrapeShopifyProducts', () => {
  it('paginates through /products.json until an empty page', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => page1 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ products: [] }) })

    const out = await scrapeShopifyProducts('https://shop.example.com', { fetch: fetchMock as any, pageSize: 250 })

    expect(out).toHaveLength(1)
    expect(out[0].handle).toBe('tee-a')
    expect(out[0].variants).toHaveLength(1)
    expect(out[0].variants[0].option_values).toEqual(['S'])
    expect(out[0].options[0].values).toEqual(['S', 'M', 'L'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toMatch(/products\.json\?limit=250&page=1/)
    expect(fetchMock.mock.calls[1][0]).toMatch(/products\.json\?limit=250&page=2/)
  })

  it('preserves decimal price strings (no float coercion)', async () => {
    const weirdPrice = {
      products: [{ ...page1.products[0], variants: [{ ...page1.products[0].variants[0], price: '29.99' }] }],
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => weirdPrice })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ products: [] }) })
    const out = await scrapeShopifyProducts('https://shop.example.com', { fetch: fetchMock as any })
    expect(out[0].variants[0].price).toBe('29.99')  // string, not number
  })

  it('splits comma-separated tags into array', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => page1 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ products: [] }) })
    const out = await scrapeShopifyProducts('https://shop.example.com', { fetch: fetchMock as any })
    expect(out[0].tags).toEqual(['cotton', 'organic'])
  })

  it('passes through array-shaped tags (newer storefronts like allbirds.com)', async () => {
    // Regression: allbirds.com returns tags as string[] instead of the
    // classic comma-separated string. The scraper must handle both.
    // Hit this during phase-19 E2E smoke; see commit notes.
    const arrayTags = {
      products: [{ ...page1.products[0], tags: ['wool', 'natural', 'merino'] as any }],
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => arrayTags })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ products: [] }) })
    const out = await scrapeShopifyProducts('https://shop.example.com', { fetch: fetchMock as any })
    expect(out[0].tags).toEqual(['wool', 'natural', 'merino'])
  })

  it('handles null / missing tags as empty array', async () => {
    const noTags = {
      products: [{ ...page1.products[0], tags: null as any }],
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => noTags })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ products: [] }) })
    const out = await scrapeShopifyProducts('https://shop.example.com', { fetch: fetchMock as any })
    expect(out[0].tags).toEqual([])
  })

  it('stops at maxPages cap (safety limit)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => page1 })
    const out = await scrapeShopifyProducts('https://shop.example.com', {
      fetch: fetchMock as any, maxPages: 3,
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(out).toHaveLength(3)
  })

  it('throws on non-ok response mid-pagination (fail-fast)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => page1 })
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
    await expect(scrapeShopifyProducts('https://shop.example.com', { fetch: fetchMock as any }))
      .rejects.toThrow(/500/)
  })
})
