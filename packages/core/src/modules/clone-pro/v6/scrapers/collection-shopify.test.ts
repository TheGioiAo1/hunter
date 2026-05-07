import { describe, it, expect } from 'vitest'
import { collectionShopifyScraper } from './collection-shopify.js'

describe('collection-shopify scraper', () => {
  it('extracts collection title + product handles from Shopify collection page', async () => {
    const html = `<html>
      <head><meta property="og:title" content="Sale Items"></head>
      <body>
        <h1>Sale Items</h1>
        <div class="collection-description"><p>Up to 50% off</p></div>
        <a href="/products/widget-x">Widget X</a>
        <a href="/products/widget-y">Widget Y</a>
        <a href="/cart">Cart</a>
      </body></html>`
    const r = await collectionShopifyScraper.scrape(
      { queueId: 'q1', sourceUrl: 'https://example.com/collections/sale', html, screenshotSha1: null, assetUrls: [], viewportWidth: 1280, viewportHeight: 800 },
      { isShopify: true },
    )
    expect(r).not.toBeNull()
    expect(r!.sourceHandle).toBe('sale')
    expect(r!.title).toBe('Sale Items')
    expect(r!.productHandles).toEqual(['widget-x', 'widget-y'])
  })
})
