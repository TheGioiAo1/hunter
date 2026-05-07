import { describe, it, expect } from 'vitest'
import { productShopifyScraper } from './product-shopify.js'

describe('product-shopify scraper', () => {
  it('extracts product from Shopify-product-page HTML using JSON-LD', async () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Widget X","description":"<p>Great</p>","brand":{"name":"Acme"},"image":["https://cdn.shopify.com/s/files/1/0001/widget1.jpg","https://cdn.shopify.com/s/files/1/0001/widget2.jpg"],"offers":[{"@type":"Offer","price":"19.99","priceCurrency":"USD","sku":"SKU-1","availability":"https://schema.org/InStock"}]}</script>
      </head><body></body></html>`
    const r = await productShopifyScraper.scrape(
      { queueId: 'q1', sourceUrl: 'https://example.com/products/widget-x', html, screenshotSha1: null, assetUrls: [], viewportWidth: 1280, viewportHeight: 800 },
      { isShopify: true },
    )
    expect(r).not.toBeNull()
    expect(r!.title).toBe('Widget X')
    expect(r!.sourceHandle).toBe('widget-x')
    expect(r!.images).toHaveLength(2)
    expect(r!.variants[0].price).toBe('19.99')
  })

  it('returns null for non-Shopify pages', async () => {
    const r = await productShopifyScraper.scrape(
      { queueId: 'q1', sourceUrl: 'https://example.com/products/x', html: '<html></html>', screenshotSha1: null, assetUrls: [], viewportWidth: 1280, viewportHeight: 800 },
      { isShopify: false },
    )
    expect(r).toBeNull()
  })
})
