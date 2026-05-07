import { describe, it, expect, vi } from 'vitest'
import { scrapeShopifyCollections } from './shopify-collections.js'

const collectionsPage = {
  collections: [
    {
      id: 10, handle: 'sale', title: 'Sale', body_html: '<p>Discounted</p>',
      image: { src: 'https://cdn.x/sale.jpg', alt: 'Sale', position: 1 },
    },
  ],
}
const saleProducts = { products: [{ id: 1, handle: 'tee-a' }, { id: 2, handle: 'tee-b' }] }

describe('scrapeShopifyCollections', () => {
  it('lists collections then fetches each collection\'s products by handle', async () => {
    const fetchMock = vi.fn()
      // collections.json page 1
      .mockResolvedValueOnce({ ok: true, json: async () => collectionsPage })
      // collections.json page 2 (empty → stop)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ collections: [] }) })
      // /collections/sale/products.json page 1
      .mockResolvedValueOnce({ ok: true, json: async () => saleProducts })
      // /collections/sale/products.json page 2 (empty)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ products: [] }) })

    const out = await scrapeShopifyCollections('https://shop.example.com', { fetch: fetchMock as any })

    expect(out).toHaveLength(1)
    expect(out[0].handle).toBe('sale')
    expect(out[0].product_handles).toEqual(['tee-a', 'tee-b'])
    expect(out[0].image?.src).toBe('https://cdn.x/sale.jpg')
  })

  it('omits collections with zero products (R3 guardrail — no empty collection imports)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => collectionsPage })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ collections: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ products: [] }) })

    const out = await scrapeShopifyCollections('https://shop.example.com', { fetch: fetchMock as any })
    expect(out).toHaveLength(0)
  })

  it('skips one flaky collection on persistent 5xx without nuking the pipeline', async () => {
    // Regression: allbirds.com had a single legacy collection
    // (bogo15-collection-q3-2023) returning 502 forever. The old scraper
    // was fail-fast — one 502 killed the whole 100+ collection import.
    // Now we retry once with backoff, then skip + warn.
    const twoCollections = {
      collections: [
        { id: 10, handle: 'sale', title: 'Sale', body_html: null, image: null },
        { id: 11, handle: 'broken', title: 'Broken', body_html: null, image: null },
      ],
    }
    const fetchMock = vi.fn()
      // collections.json page 1
      .mockResolvedValueOnce({ ok: true, json: async () => twoCollections })
      // collections.json page 2 (empty → stop)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ collections: [] }) })
      // /collections/sale/products.json page 1 (good)
      .mockResolvedValueOnce({ ok: true, json: async () => saleProducts })
      // /collections/sale/products.json page 2 (empty)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ products: [] }) })
      // /collections/broken/products.json — first attempt: 502
      .mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) })
      // /collections/broken/products.json — retry: still 502
      .mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) })

    const warnings: string[] = []
    const out = await scrapeShopifyCollections('https://shop.example.com', {
      fetch: fetchMock as any,
      onWarn: (m) => warnings.push(m),
      retryDelayMs: 0,  // no backoff in tests
    })

    // Good collection survives; broken one is dropped.
    expect(out).toHaveLength(1)
    expect(out[0].handle).toBe('sale')
    expect(out[0].product_handles).toEqual(['tee-a', 'tee-b'])

    // Warning captured — surfaces via GradeResult.warnings to seller UI.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/broken/)
    expect(warnings[0]).toMatch(/502/)
    expect(warnings[0]).toMatch(/after retry/)
  })

  it('recovers when 5xx is transient (retry succeeds)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => collectionsPage })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ collections: [] }) })
      // First attempt: 503 (transient)
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      // Retry: 200 OK
      .mockResolvedValueOnce({ ok: true, json: async () => saleProducts })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ products: [] }) })

    const warnings: string[] = []
    const out = await scrapeShopifyCollections('https://shop.example.com', {
      fetch: fetchMock as any,
      onWarn: (m) => warnings.push(m),
      retryDelayMs: 0,
    })

    expect(out).toHaveLength(1)
    expect(out[0].product_handles).toEqual(['tee-a', 'tee-b'])
    // No warning — retry succeeded.
    expect(warnings).toHaveLength(0)
  })

  it('skips 4xx without retry (permanent — e.g. collection deleted)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => collectionsPage })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ collections: [] }) })
      // 404 — permanent, do not retry
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })

    const warnings: string[] = []
    const out = await scrapeShopifyCollections('https://shop.example.com', {
      fetch: fetchMock as any,
      onWarn: (m) => warnings.push(m),
      retryDelayMs: 0,
    })

    expect(out).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/404/)
    expect(warnings[0]).not.toMatch(/after retry/)  // no retry attempted
    // Exactly 3 fetch calls: 2 listing pages + 1 (no retry) handle fetch
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
