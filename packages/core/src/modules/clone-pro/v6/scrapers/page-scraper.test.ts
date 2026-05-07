import { describe, it, expect } from 'vitest'
import { pageScraper } from './page-scraper.js'

describe('page-scraper', () => {
  it('extracts /pages/<handle> from Shopify page', async () => {
    const html = `<html><body><main><h1>About Us</h1><p>We sell mugs.</p></main></body></html>`
    const r = await pageScraper.scrape(
      { queueId: 'q1', sourceUrl: 'https://example.com/pages/about', html, screenshotSha1: null, assetUrls: [], viewportWidth: 1280, viewportHeight: 800 },
      { isShopify: true },
    )
    expect(r!.sourceHandle).toBe('about')
    expect(r!.title).toBe('About Us')
    expect(r!.bodyHtml).toContain('We sell mugs')
    expect(r!.isPolicy).toBe(false)
  })

  it('marks /policies/<handle> as policy', async () => {
    const r = await pageScraper.scrape(
      { queueId: 'q1', sourceUrl: 'https://example.com/policies/privacy-policy', html: '<main><h1>Privacy</h1></main>', screenshotSha1: null, assetUrls: [], viewportWidth: 1280, viewportHeight: 800 },
      { isShopify: true },
    )
    expect(r!.isPolicy).toBe(true)
  })
})
