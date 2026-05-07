import { describe, it, expect, vi } from 'vitest'
import { dispatchBucketScrapers } from './stage4-bucket-scrapers.js'

describe('Stage 4 — bucket scraper dispatch', () => {
  it('routes product-classified URLs to product scraper', async () => {
    const productScraper = { classification: 'product' as const, scrape: vi.fn().mockResolvedValue({ sourceHandle: 'x' }) }
    const r = await dispatchBucketScrapers({
      pages: [{
        queueId: 'q1', sourceUrl: 'https://example.com/products/x', html: '', screenshotSha1: null, assetUrls: [], viewportWidth: 1280, viewportHeight: 800,
        classification: 'product' as const,
      }],
      isShopify: true,
      callAI: undefined,
      scrapers: { products: [productScraper], collections: [], pages: [], blog: [], menu: null, theme: null } as any,
    })
    expect(productScraper.scrape).toHaveBeenCalledOnce()
    expect(r.products).toHaveLength(1)
  })

  it('falls back from shopify to generic scraper if first returns null', async () => {
    const shopifyScraper = { classification: 'product' as const, scrape: vi.fn().mockResolvedValue(null) }
    const genericScraper = { classification: 'product' as const, scrape: vi.fn().mockResolvedValue({ sourceHandle: 'g' }) }
    const r = await dispatchBucketScrapers({
      pages: [{ queueId: 'q', sourceUrl: 'https://x.com/products/y', html: '', screenshotSha1: null, assetUrls: [], viewportWidth: 1280, viewportHeight: 800, classification: 'product' as const }],
      isShopify: false,
      callAI: async () => '{}',
      scrapers: { products: [shopifyScraper, genericScraper], collections: [], pages: [], blog: [], menu: null, theme: null } as any,
    })
    expect(genericScraper.scrape).toHaveBeenCalled()
    expect(r.products).toHaveLength(1)
  })
})
