/**
 * Gbox Platform — MemoryDataSource tests
 *
 * Decision #1 Step 1.14. Cover the in-memory datasource that backs
 * tests + smoke + dev preview. The interface guarantees:
 *
 *   - Methods return null for missing handles (never throw).
 *   - Pagination math is correct.
 *   - Tag filters are applied where supported.
 *   - The default cart shape is sane for anonymous visitors.
 */

import { describe, it, expect } from 'vitest'
import {
  MemoryDataSource,
  type DataSourceContext,
  type MemoryDataSourceSeed,
} from './datasource.js'

const CTX: DataSourceContext = { shopId: 'shop_memory', locale: 'en' }

function makeDs(seed: MemoryDataSourceSeed = {}): MemoryDataSource {
  return new MemoryDataSource(seed)
}

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------

describe('MemoryDataSource — shop', () => {
  it('returns the seeded shop merged over defaults', async () => {
    const ds = makeDs({ shop: { name: 'Acme' } })
    const shop = await ds.loadShop(CTX)
    expect(shop.id).toBe('shop_memory')
    expect(shop.name).toBe('Acme')
    expect(shop.currency).toBe('USD')
  })

  it('defaultShopId returns the seeded id', () => {
    const ds = makeDs({ shop: { id: 'shop_x' } })
    expect(ds.defaultShopId()).toBe('shop_x')
  })
})

// ---------------------------------------------------------------------------
// Customer + cart
// ---------------------------------------------------------------------------

describe('MemoryDataSource — customer + cart', () => {
  it('loads a customer by session token', async () => {
    const ds = makeDs({
      customers: [
        {
          id: 'c1',
          email: 'jane@example.com',
          session_token: 'tok-1',
        },
      ],
    })
    const c = await ds.loadCustomerBySession('tok-1', CTX)
    expect(c?.email).toBe('jane@example.com')
  })

  it('returns null for an unknown session token', async () => {
    const ds = makeDs()
    expect(await ds.loadCustomerBySession('whatever', CTX)).toBeNull()
  })

  it('returns null for undefined session token (anon)', async () => {
    const ds = makeDs()
    expect(await ds.loadCustomerBySession(undefined, CTX)).toBeNull()
  })

  it('returns the seeded cart by token', async () => {
    const ds = makeDs({
      carts: {
        ck: { token: 'ck', item_count: 2, total_price: 200, items: [{}, {}] },
      },
    })
    const cart = await ds.loadCart('ck', CTX)
    expect(cart.item_count).toBe(2)
  })

  it('returns an empty cart for unknown token', async () => {
    const ds = makeDs()
    const cart = await ds.loadCart('nope', CTX)
    expect(cart.item_count).toBe(0)
    expect(cart.items).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Products + collections
// ---------------------------------------------------------------------------

describe('MemoryDataSource — products + collections', () => {
  it('loads a product by handle', async () => {
    const ds = makeDs({
      products: [{ id: 'p1', handle: 'foo', title: 'Foo' }],
    })
    const p = await ds.loadProductByHandle('foo', CTX)
    expect(p?.title).toBe('Foo')
  })

  it('returns null for unknown product handle', async () => {
    const ds = makeDs()
    expect(await ds.loadProductByHandle('nope', CTX)).toBeNull()
  })

  it('paginates collection products', async () => {
    const ds = makeDs({
      products: Array.from({ length: 5 }, (_, i) => ({
        id: `p${i}`,
        handle: `p${i}`,
        title: `P${i}`,
      })),
      collections: [
        {
          id: 'col1',
          handle: 'all',
          title: 'All',
          product_handles: ['p0', 'p1', 'p2', 'p3', 'p4'],
        },
      ],
    })
    const page1 = await ds.loadCollectionProducts(
      'col1',
      { page: 1, pageSize: 2 },
      CTX,
    )
    expect(page1.products.map((p) => p.id)).toEqual(['p0', 'p1'])
    expect(page1.total).toBe(5)
    const page3 = await ds.loadCollectionProducts(
      'col1',
      { page: 3, pageSize: 2 },
      CTX,
    )
    expect(page3.products.map((p) => p.id)).toEqual(['p4'])
  })

  it('filters collection products by tag', async () => {
    const ds = makeDs({
      products: [
        { id: 'p1', handle: 'p1', title: 'P1', tags: ['sale'] },
        { id: 'p2', handle: 'p2', title: 'P2', tags: ['new'] },
        { id: 'p3', handle: 'p3', title: 'P3', tags: ['sale', 'new'] },
      ],
      collections: [
        {
          id: 'col1',
          handle: 'all',
          title: 'All',
          product_handles: ['p1', 'p2', 'p3'],
        },
      ],
    })
    const result = await ds.loadCollectionProducts(
      'col1',
      { page: 1, pageSize: 10 },
      CTX,
      'sale',
    )
    expect(result.products.map((p) => p.id)).toEqual(['p1', 'p3'])
    expect(result.total).toBe(2)
  })

  it('returns empty when collection id is unknown', async () => {
    const ds = makeDs()
    const r = await ds.loadCollectionProducts(
      'missing',
      { page: 1, pageSize: 10 },
      CTX,
    )
    expect(r).toEqual({ products: [], total: 0 })
  })

  it('listCollections returns all seeded collections', async () => {
    const ds = makeDs({
      collections: [
        { id: 'a', handle: 'a', title: 'A' },
        { id: 'b', handle: 'b', title: 'B' },
      ],
    })
    expect((await ds.listCollections(CTX)).map((c) => c.id)).toEqual([
      'a',
      'b',
    ])
  })
})

// ---------------------------------------------------------------------------
// Pages, policies, blogs, articles
// ---------------------------------------------------------------------------

describe('MemoryDataSource — pages, policies, blogs', () => {
  it('loads a page by handle', async () => {
    const ds = makeDs({
      pages: [{ id: 'pg1', handle: 'about', title: 'About', content: 'Hi' }],
    })
    const p = await ds.loadPageByHandle('about', CTX)
    expect(p?.title).toBe('About')
  })

  it('loads a policy by handle', async () => {
    const ds = makeDs({
      policies: [
        { id: 'pol1', handle: 'privacy', title: 'Privacy', body: 'PII' },
      ],
    })
    expect((await ds.loadPolicyByHandle('privacy', CTX))?.title).toBe(
      'Privacy',
    )
  })

  it('loads a blog by handle', async () => {
    const ds = makeDs({
      blogs: [{ id: 'b1', handle: 'news', title: 'News' }],
    })
    expect((await ds.loadBlogByHandle('news', CTX))?.id).toBe('b1')
  })

  it('loads an article by blog + article handles', async () => {
    const ds = makeDs({
      blogs: [
        {
          id: 'b1',
          handle: 'news',
          title: 'News',
          article_handles: ['hello'],
        },
      ],
      articles: [
        { id: 'a1', handle: 'hello', title: 'Hello', content: 'Body' },
      ],
    })
    const a = await ds.loadArticleByHandles('news', 'hello', CTX)
    expect(a?.title).toBe('Hello')
  })

  it('returns null for an article missing from the blog', async () => {
    const ds = makeDs({
      blogs: [{ id: 'b1', handle: 'news', title: 'News', article_handles: [] }],
      articles: [
        { id: 'a1', handle: 'hello', title: 'Hello', content: 'Body' },
      ],
    })
    expect(await ds.loadArticleByHandles('news', 'hello', CTX)).toBeNull()
  })

  it('paginates blog articles', async () => {
    const ds = makeDs({
      blogs: [
        {
          id: 'b1',
          handle: 'news',
          title: 'News',
          article_handles: ['a', 'b', 'c'],
        },
      ],
      articles: [
        { id: 'a', handle: 'a', title: 'A', content: '' },
        { id: 'b', handle: 'b', title: 'B', content: '' },
        { id: 'c', handle: 'c', title: 'C', content: '' },
      ],
    })
    const r = await ds.loadBlogArticles('b1', { page: 1, pageSize: 2 }, CTX)
    expect(r.articles.map((a) => a.id)).toEqual(['a', 'b'])
    expect(r.total).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Gift cards + search
// ---------------------------------------------------------------------------

describe('MemoryDataSource — gift cards + search', () => {
  it('loads a gift card by id', async () => {
    const ds = makeDs({
      giftCards: [{ id: 'g1', balance: 5000 }],
    })
    expect((await ds.loadGiftCardById('g1', CTX))?.balance).toBe(5000)
  })

  it('runSearch returns performed=false for empty terms', async () => {
    const ds = makeDs()
    const r = await ds.runSearch('', { page: 1, pageSize: 10 }, CTX)
    expect(r.performed).toBe(false)
    expect(r.results_count).toBe(0)
  })

  it('runSearch returns seeded results for non-empty terms', async () => {
    const ds = makeDs({
      search: { results: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    })
    const r = await ds.runSearch('foo', { page: 1, pageSize: 2 }, CTX)
    expect(r.performed).toBe(true)
    expect(r.results_count).toBe(3)
    expect(r.results).toHaveLength(2)
  })
})
