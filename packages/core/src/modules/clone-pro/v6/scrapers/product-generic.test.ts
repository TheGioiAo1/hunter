import { describe, it, expect, vi } from 'vitest'
import { productGenericScraper } from './product-generic.js'

describe('product-generic scraper (AI-driven)', () => {
  it('asks AI to map DOM → ProductDTO', async () => {
    const html = `<html><body>
      <h1 class="product-title">Eco Mug</h1>
      <span class="price">$24.50</span>
      <img src="/img/mug.jpg" alt="Mug">
    </body></html>`
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify({
      title: 'Eco Mug',
      bodyHtml: '',
      price: '24.50',
      images: ['/img/mug.jpg'],
      variants: [{ sku: 'mug-1', price: '24.50', optionValues: {} }],
    }))
    const r = await productGenericScraper.scrape(
      { queueId: 'q1', sourceUrl: 'https://eco.com/shop/eco-mug', html, screenshotSha1: null, assetUrls: ['/img/mug.jpg'], viewportWidth: 1280, viewportHeight: 800 },
      { isShopify: false, callAI: async (sys, usr) => aiCall(sys, usr) },
    )
    expect(r).not.toBeNull()
    expect(r!.title).toBe('Eco Mug')
    expect(r!.images[0].sourceUrl).toBe('/img/mug.jpg')
    expect(aiCall).toHaveBeenCalledOnce()
  })

  it('returns null when AI returns invalid JSON', async () => {
    const r = await productGenericScraper.scrape(
      { queueId: 'q1', sourceUrl: 'https://eco.com/shop/x', html: '<html></html>', screenshotSha1: null, assetUrls: [], viewportWidth: 1280, viewportHeight: 800 },
      { isShopify: false, callAI: async () => 'not-json' },
    )
    expect(r).toBeNull()
  })
})
