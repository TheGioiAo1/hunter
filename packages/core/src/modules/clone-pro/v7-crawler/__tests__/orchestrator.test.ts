import { describe, it, expect } from 'vitest'
import { crawlSite } from '../orchestrator.js'

const SHOPIFY_LISTING_HTML = `<html><head><meta name="generator" content="Shopify"></head>
<body>
  <article class="product-card"><a href="/products/a" title="Alpha"><img src="/i/a.jpg"></a></article>
  <article class="product-card"><a href="/products/b" title="Beta"><img src="/i/b.jpg"></a></article>
</body></html>`

const SHOPIFY_DETAIL_HTML_A = `<html><body><main>
  <h1>Alpha</h1>
  <span class="price">$10.00</span>
  <div class="rte">An alpha widget.</div>
  <meta property="og:image" content="https://cdn.example.com/a.jpg">
</main></body></html>`

const SHOPIFY_DETAIL_HTML_B = `<html><body><main>
  <h1>Beta</h1>
  <span class="price">$20.00</span>
  <div class="rte">A beta widget.</div>
  <meta property="og:image" content="https://cdn.example.com/b.jpg">
</main></body></html>`

describe('orchestrator.crawlSite', () => {
  it('uses Shopify /products.json fast-path for shopify-classic', async () => {
    const fetchFn = async (url: string) => {
      if (url.includes('/products.json')) {
        return JSON.stringify({
          products: [
            { id: 1, title: 'A', handle: 'a', body_html: '<p>desc</p>', vendor: 'X', product_type: '', tags: [], images: [{ src: 'i1.jpg' }], variants: [{ id: 1, title: 'X', price: '10', compare_at_price: null, sku: 'A1' }], options: [] },
            { id: 2, title: 'B', handle: 'b', body_html: '<p>desc</p>', vendor: 'X', product_type: '', tags: [], images: [{ src: 'i2.jpg' }], variants: [{ id: 2, title: 'X', price: '20', compare_at_price: null, sku: 'B1' }], options: [] },
          ],
        })
      }
      return SHOPIFY_LISTING_HTML // for the platform-detect home fetch
    }
    const res = await crawlSite('https://shop.example.com/collections/all', {
      fetch: fetchFn,
      products_limit: 2,
      concurrency: 5,
    })
    expect(res.platform).toBe('shopify-classic')
    expect(res.config_used).toBe('shopify-products-json')
    expect(res.products).toHaveLength(2)
  })

  it('falls back to XPath when forceXpath=true', async () => {
    const fetchFn = async (url: string) => {
      if (url.includes('/products/a')) return SHOPIFY_DETAIL_HTML_A
      if (url.includes('/products/b')) return SHOPIFY_DETAIL_HTML_B
      return SHOPIFY_LISTING_HTML
    }
    const res = await crawlSite('https://shop.example.com/collections/all', {
      fetch: fetchFn,
      products_limit: 2,
      forceXpath: true,
    })
    expect(res.platform).toBe('shopify-classic')
    expect(res.config_used).toBe('shopify-classic.json')
    expect(res.products).toHaveLength(2)
  })

  it('throws raw error for unknown platform (caller pipes through safeMessage)', async () => {
    const fetchFn = async () => `<html><body>plain</body></html>`
    await expect(
      crawlSite('https://x.example.com', { fetch: fetchFn }),
    ).rejects.toThrow(/unknown platform/i)
  })

  it('reports failed product URLs as warnings without aborting (XPath path)', async () => {
    const fetchFn = async (url: string) => {
      if (url.includes('/products/a')) return SHOPIFY_DETAIL_HTML_A
      if (url.includes('/products/b')) throw new Error('boom')
      return SHOPIFY_LISTING_HTML
    }
    const res = await crawlSite('https://shop.example.com/collections/all', {
      fetch: fetchFn,
      products_limit: 2,
      forceXpath: true,
    })
    expect(res.products).toHaveLength(1)
    expect(res.warnings.length).toBeGreaterThan(0)
    expect(res.warnings.some((w) => /failed/i.test(w))).toBe(true)
  })
})
