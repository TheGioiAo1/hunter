import { describe, it, expect } from 'vitest'
import { menuScraper } from './menu-scraper.js'

describe('menu-scraper', () => {
  it('extracts top-level + nested menu items from <nav>', async () => {
    const html = `<html><body>
      <nav role="navigation">
        <ul>
          <li><a href="/collections/sale">Sale</a></li>
          <li><a href="/collections/all">Shop</a>
            <ul>
              <li><a href="/products/x">Widget X</a></li>
            </ul>
          </li>
          <li><a href="/pages/about">About</a></li>
        </ul>
      </nav></body></html>`
    const r = await menuScraper.scrape(
      { queueId: 'q1', sourceUrl: 'https://example.com/', html, screenshotSha1: null, assetUrls: [], viewportWidth: 1280, viewportHeight: 800 },
      { isShopify: true },
    )
    expect(r!.items).toHaveLength(3)
    expect(r!.items[0].title).toBe('Sale')
    expect(r!.items[1].children).toHaveLength(1)
    expect(r!.items[1].children[0].title).toBe('Widget X')
  })
})
