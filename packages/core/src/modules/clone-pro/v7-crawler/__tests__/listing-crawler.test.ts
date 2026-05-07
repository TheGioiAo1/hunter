import { describe, it, expect } from 'vitest'
import { crawlListing } from '../listing-crawler.js'
import type { Config } from '../types.js'

const SHOPIFY_CONFIG: Config = {
  delay: 1, // tests must run fast
  item: {
    xpath: "//article[contains(@class,'product-card')]",
    elements: [
      { name: 'Title', xpath: ".//a[contains(@href,'/products/')]", attr: 'title', replaces: null },
      { name: 'Image', xpath: './/img', attr: 'src', replaces: null },
      { name: 'Link', xpath: ".//a[contains(@href,'/products/')]", attr: 'href', replaces: null },
      { name: 'Price', xpath: ".//span[contains(@class,'price')]", attr: null, replaces: null },
    ],
  },
}

function listingHtml(productHandles: string[]): string {
  const cards = productHandles
    .map(
      (h) =>
        `<article class="product-card"><a href="/products/${h}" title="Product ${h}"><img src="/img/${h}.jpg"></a><span class="price">$10.00</span></article>`,
    )
    .join('\n')
  return `<html><body>${cards}</body></html>`
}

describe('listing-crawler', () => {
  it('harvests product URLs from a single page', async () => {
    const fetchFn = async () => listingHtml(['a', 'b', 'c'])
    const res = await crawlListing('https://shop.example.com/collections/all', SHOPIFY_CONFIG, {
      fetch: fetchFn,
    })
    expect(res.product_urls).toEqual([
      'https://shop.example.com/products/a',
      'https://shop.example.com/products/b',
      'https://shop.example.com/products/c',
    ])
    expect(res.total_pages_crawled).toBeGreaterThanOrEqual(1)
  })

  it('paginates by appending ?page=N until empty', async () => {
    const calls: string[] = []
    const fetchFn = async (url: string) => {
      calls.push(url)
      if (url.includes('page=1') || !url.includes('page=')) return listingHtml(['a', 'b'])
      if (url.includes('page=2')) return listingHtml(['c', 'd'])
      return listingHtml([]) // empty → stop
    }
    const res = await crawlListing('https://shop.example.com/collections/all', SHOPIFY_CONFIG, {
      fetch: fetchFn,
    })
    expect(res.product_urls).toEqual([
      'https://shop.example.com/products/a',
      'https://shop.example.com/products/b',
      'https://shop.example.com/products/c',
      'https://shop.example.com/products/d',
    ])
    expect(calls.length).toBeGreaterThanOrEqual(3) // page1, page2, page3 (empty)
  })

  it('respects products_limit and stops early', async () => {
    const fetchFn = async () => listingHtml(['a', 'b', 'c', 'd', 'e'])
    const res = await crawlListing('https://shop.example.com/collections/all', SHOPIFY_CONFIG, {
      fetch: fetchFn,
      limit: 2,
    })
    expect(res.product_urls).toHaveLength(2)
  })

  it('deduplicates URLs across pages', async () => {
    const fetchFn = async (url: string) => {
      if (url.includes('page=2')) return listingHtml(['a', 'd']) // 'a' is dup
      return listingHtml(['a', 'b'])
    }
    const res = await crawlListing('https://shop.example.com/collections/all', SHOPIFY_CONFIG, {
      fetch: fetchFn,
    })
    const set = new Set(res.product_urls)
    expect(set.size).toBe(res.product_urls.length)
  })

  it('absolutises relative product URLs against the collection URL', async () => {
    const fetchFn = async () => listingHtml(['x'])
    const res = await crawlListing('https://shop.example.com/collections/all', SHOPIFY_CONFIG, {
      fetch: fetchFn,
    })
    expect(res.product_urls[0]).toBe('https://shop.example.com/products/x')
  })

  it('passes absolute URLs through unchanged', async () => {
    const html = `<html><body><article class="product-card"><a href="https://other.example.com/products/x" title="X"><img src="/i.jpg"></a></article></body></html>`
    const fetchFn = async () => html
    const res = await crawlListing('https://shop.example.com/collections/all', SHOPIFY_CONFIG, {
      fetch: fetchFn,
    })
    expect(res.product_urls[0]).toBe('https://other.example.com/products/x')
  })

  it('stops crawling when a page returns zero products', async () => {
    let callCount = 0
    const fetchFn = async () => {
      callCount += 1
      if (callCount === 1) return listingHtml(['a'])
      return listingHtml([]) // empty
    }
    const res = await crawlListing('https://shop.example.com/collections/all', SHOPIFY_CONFIG, {
      fetch: fetchFn,
    })
    expect(res.product_urls).toEqual(['https://shop.example.com/products/a'])
  })

  it('skips when Link element is not configured (defensive)', async () => {
    const noLinkConfig: Config = {
      ...SHOPIFY_CONFIG,
      item: {
        ...SHOPIFY_CONFIG.item,
        elements: SHOPIFY_CONFIG.item.elements.filter((e) => e.name !== 'Link'),
      },
    }
    const fetchFn = async () => listingHtml(['a', 'b'])
    const res = await crawlListing('https://shop.example.com/collections/all', noLinkConfig, {
      fetch: fetchFn,
    })
    expect(res.product_urls).toEqual([])
  })
})
