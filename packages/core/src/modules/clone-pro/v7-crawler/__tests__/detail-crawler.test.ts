import { describe, it, expect } from 'vitest'
import { crawlDetails, extractRowFromDetail } from '../detail-crawler.js'
import type { Config } from '../types.js'

const CONFIG: Config = {
  delay: 1,
  item: {
    xpath: '//main',
    elements: [
      { name: 'Title', xpath: '//h1', attr: null, replaces: null },
      { name: 'Price', xpath: "//span[contains(@class,'price-current')]", attr: null, replaces: [{ from: '$', to: '' }] },
      { name: 'OldPrice', xpath: "//span[contains(@class,'price-was')]", attr: null, replaces: [{ from: '$', to: '' }] },
      { name: 'Description', xpath: "//div[@class='description']", attr: null, replaces: null },
      { name: 'Variants', xpath: "//select[@name='variant']/option", attr: null, replaces: null },
    ],
    images_in_detail: {
      name: 'GalleryImages',
      xpath: "//div[contains(@class,'product-gallery')]//img",
      attr: 'src',
      replaces: null,
    },
  },
}

const FULL_DETAIL_HTML = `<html><body><main>
  <h1>Cool Widget</h1>
  <span class="price-was">$49.99</span>
  <span class="price-current">$29.99</span>
  <div class="description">A long description of the cool widget. Made of premium materials.</div>
  <div class="product-gallery">
    <img src="https://cdn.example.com/img1.jpg">
    <img src="https://cdn.example.com/img2.jpg">
    <img src="https://cdn.example.com/img3.jpg">
  </div>
  <select name="variant">
    <option>Red / S</option>
    <option>Red / M</option>
    <option>Blue / S</option>
  </select>
</main></body></html>`

describe('detail-crawler', () => {
  describe('extractRowFromDetail (pure)', () => {
    it('extracts a full row with all fields populated', () => {
      const row = extractRowFromDetail(FULL_DETAIL_HTML, 'https://shop.example.com/products/widget', CONFIG)
      expect(row.Title).toBe('Cool Widget')
      expect(row.Price).toBe(29.99)
      expect(row.OldPrice).toBe(49.99)
      expect(row.Description).toContain('cool widget')
      expect(row.ImageUrls).toEqual([
        'https://cdn.example.com/img1.jpg',
        'https://cdn.example.com/img2.jpg',
        'https://cdn.example.com/img3.jpg',
      ])
      expect(row.Spin).toEqual(['Red / S', 'Red / M', 'Blue / S'])
      expect(row.Link).toBe('https://shop.example.com/products/widget')
      expect(row.ImageUrlType).toBe('ONLINE')
    })

    it('parses decimal prices correctly', () => {
      const row = extractRowFromDetail(FULL_DETAIL_HTML, 'https://x', CONFIG)
      expect(row.Price).toBe(29.99)
      expect(row.OldPrice).toBe(49.99)
    })

    it('returns null for missing Title', () => {
      const html = `<html><body><main></main></body></html>`
      const row = extractRowFromDetail(html, 'https://x', CONFIG)
      expect(row.Title).toBeNull()
    })

    it('returns null for non-numeric Price', () => {
      const html = `<html><body><main><span class="price-current">N/A</span></main></body></html>`
      const row = extractRowFromDetail(html, 'https://x', CONFIG)
      expect(row.Price).toBeNull()
    })

    it('returns empty array for missing GalleryImages', () => {
      const html = `<html><body><main><h1>X</h1></main></body></html>`
      const row = extractRowFromDetail(html, 'https://x', CONFIG)
      expect(row.ImageUrls).toEqual([])
    })

    it('returns null Spin for missing variants', () => {
      const html = `<html><body><main><h1>X</h1></main></body></html>`
      const row = extractRowFromDetail(html, 'https://x', CONFIG)
      expect(row.Spin).toBeNull()
    })

    it('preserves the source product URL on Link', () => {
      const url = 'https://shop.example.com/products/cool-widget?variant=1'
      const row = extractRowFromDetail(FULL_DETAIL_HTML, url, CONFIG)
      expect(row.Link).toBe(url)
    })

    it('respects price replaces', () => {
      const cfg: Config = {
        ...CONFIG,
        item: {
          ...CONFIG.item,
          elements: CONFIG.item.elements.map((e) =>
            e.name === 'Price'
              ? { ...e, replaces: [{ from: '$', to: '' }, { from: 'USD', to: '' }, { from: ',', to: '' }] }
              : e,
          ),
        },
      }
      const html = `<html><body><main><h1>X</h1><span class="price-current">$1,299.50 USD</span></main></body></html>`
      const row = extractRowFromDetail(html, 'https://x', cfg)
      expect(row.Price).toBe(1299.5)
    })
  })

  describe('crawlDetails (parallel)', () => {
    it('fetches multiple URLs and returns Row[]', async () => {
      const fetchFn = async (url: string) => {
        return FULL_DETAIL_HTML.replace('Cool Widget', `Widget ${url.split('/').pop()}`)
      }
      const urls = [
        'https://shop.example.com/products/a',
        'https://shop.example.com/products/b',
        'https://shop.example.com/products/c',
      ]
      const res = await crawlDetails(urls, CONFIG, { fetch: fetchFn, concurrency: 5 })
      expect(res.rows).toHaveLength(3)
      expect(res.failed_urls).toEqual([])
      expect(res.rows.map((r) => r.Title).sort()).toEqual(['Widget a', 'Widget b', 'Widget c'])
    })

    it('records failed URLs without aborting the batch', async () => {
      const fetchFn = async (url: string) => {
        if (url.endsWith('/b')) throw new Error('boom')
        return FULL_DETAIL_HTML
      }
      const urls = [
        'https://shop.example.com/products/a',
        'https://shop.example.com/products/b',
        'https://shop.example.com/products/c',
      ]
      const res = await crawlDetails(urls, CONFIG, { fetch: fetchFn, concurrency: 5 })
      expect(res.rows).toHaveLength(2)
      expect(res.failed_urls).toEqual(['https://shop.example.com/products/b'])
    })

    it('respects concurrency cap', async () => {
      let inFlight = 0
      let maxInFlight = 0
      const fetchFn = async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 10))
        inFlight -= 1
        return FULL_DETAIL_HTML
      }
      const urls = Array.from({ length: 10 }, (_, i) => `https://shop.example.com/products/p${i}`)
      await crawlDetails(urls, CONFIG, { fetch: fetchFn, concurrency: 3 })
      expect(maxInFlight).toBeLessThanOrEqual(3)
    })

    it('returns empty result for empty URL list', async () => {
      const res = await crawlDetails([], CONFIG, { fetch: async () => '' })
      expect(res.rows).toEqual([])
      expect(res.failed_urls).toEqual([])
    })
  })
})
