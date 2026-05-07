import { describe, it, expect } from 'vitest'
import type { Config, Element, Replace, Row, CrawlResult, Item } from '../types.js'

describe('v7-crawler types', () => {
  it('Config has delay + item.xpath + item.elements', () => {
    const cfg: Config = {
      delay: 2000,
      item: {
        xpath: '//article',
        elements: [
          { name: 'Title', xpath: './/h1', attr: null, replaces: null },
        ],
      },
    }
    expect(cfg.delay).toBe(2000)
    expect(cfg.item.elements[0].name).toBe('Title')
  })

  it('Element supports attr + replaces', () => {
    const replace: Replace = { from: '$', to: '' }
    const el: Element = {
      name: 'Price',
      xpath: './/span[@class="price"]',
      attr: 'data-price',
      replaces: [replace],
    }
    expect(el.attr).toBe('data-price')
    expect(el.replaces).toEqual([{ from: '$', to: '' }])
  })

  it('Item supports optional images_in_detail', () => {
    const item: Item = {
      xpath: '//div[@class="card"]',
      elements: [],
      images_in_detail: {
        name: 'Gallery',
        xpath: '//img[@class="gallery"]',
        attr: 'src',
        replaces: null,
      },
    }
    expect(item.images_in_detail?.name).toBe('Gallery')
  })

  it('Row has Title + ImageUrls + Description + Price + variants', () => {
    const row: Row = {
      Title: 'X',
      ImageUrls: ['a.jpg'],
      Description: 'D',
      Price: 9.99,
      OldPrice: 12,
      tags: ['t1'],
      short_description: 's',
      seo_description: 'q',
      Spin: ['v1'],
      Link: 'http://x',
      ImageUrlType: 'ONLINE',
    }
    expect(row.Title).toBe('X')
    expect(row.ImageUrls).toHaveLength(1)
    expect(row.Price).toBe(9.99)
    expect(row.ImageUrlType).toBe('ONLINE')
  })

  it('Row supports null/optional fields per Lonspy parity', () => {
    const row: Row = {
      Title: null,
      ImageUrls: [],
      Description: null,
      Price: null,
      Link: null,
    }
    expect(row.Title).toBeNull()
    expect(row.OldPrice).toBeUndefined()
  })

  it('CrawlResult has products + collections + pages + warnings', () => {
    const res: CrawlResult = {
      source_url: 'https://example.com',
      platform: 'shopify-classic',
      config_used: 'shopify-classic.json',
      products: [],
      collections: [{ handle: 'all', title: 'All', product_handles: ['a'] }],
      pages: [{ handle: 'about', title: 'About', body_html: '<p/>' }],
      warnings: ['1 product failed'],
    }
    expect(res.products).toEqual([])
    expect(res.collections[0].handle).toBe('all')
    expect(res.warnings).toContain('1 product failed')
  })
})
