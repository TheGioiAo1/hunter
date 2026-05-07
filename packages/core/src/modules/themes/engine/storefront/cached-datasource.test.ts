/**
 * Gbox Platform — CachedStorefrontDataSource Tests (Phase 3B)
 *
 * Strategy:
 *   1. Stand up a stub `StorefrontDataSource` with call counters so
 *      every cache hit / miss is directly observable.
 *   2. Use a Map-backed in-memory `CacheBackend` with a glob-to-regex
 *      delPattern so pattern invalidation tests are self-contained.
 *   3. Exercise hot paths, cached-null, pagination key shape, and
 *      the full set of invalidate* helpers.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { CachedStorefrontDataSource } from './cached-datasource.js'
import type { CacheBackend } from '../../../cache/cached.js'
import type {
  ArticleDrop,
  BlogDrop,
  CartDrop,
  CollectionDrop,
  CustomerDrop,
  DataSourceContext,
  GiftCardDrop,
  PageArgs,
  PageDrop,
  PolicyDrop,
  ProductDrop,
  SearchDrop,
  ShopDrop,
  StorefrontDataSource,
} from './datasource.js'

// ---------------------------------------------------------------------------
// Stub inner datasource
// ---------------------------------------------------------------------------

interface StubCalls {
  loadShop: number
  loadProductByHandle: number
  loadCollectionByHandle: number
  loadCollectionProducts: number
  listCollections: number
  loadPageByHandle: number
  loadPolicyByHandle: number
  loadBlogByHandle: number
  loadArticleByHandles: number
  loadBlogArticles: number
  loadCart: number
  loadCustomerBySession: number
  runSearch: number
  loadGiftCardById: number
}

function createStub(): {
  inner: StorefrontDataSource
  calls: StubCalls
  products: Map<string, ProductDrop | null>
} {
  const calls: StubCalls = {
    loadShop: 0,
    loadProductByHandle: 0,
    loadCollectionByHandle: 0,
    loadCollectionProducts: 0,
    listCollections: 0,
    loadPageByHandle: 0,
    loadPolicyByHandle: 0,
    loadBlogByHandle: 0,
    loadArticleByHandles: 0,
    loadBlogArticles: 0,
    loadCart: 0,
    loadCustomerBySession: 0,
    runSearch: 0,
    loadGiftCardById: 0,
  }
  const products = new Map<string, ProductDrop | null>([
    ['hat', { id: 'p1', handle: 'hat', title: 'Hat' }],
    ['missing', null],
  ])

  const inner: StorefrontDataSource = {
    defaultShopId: () => 'shop_1',
    async loadShop(_ctx): Promise<ShopDrop> {
      calls.loadShop += 1
      return { id: 'shop_1', name: 'Test Shop', currency: 'USD' }
    },
    async loadCustomerBySession(_t, _c): Promise<CustomerDrop | null> {
      calls.loadCustomerBySession += 1
      return null
    },
    async loadCart(_t, _c): Promise<CartDrop> {
      calls.loadCart += 1
      return { item_count: 0, items: [] }
    },
    async loadProductByHandle(handle, _ctx): Promise<ProductDrop | null> {
      calls.loadProductByHandle += 1
      return products.get(handle) ?? null
    },
    async loadCollectionByHandle(handle, _ctx): Promise<CollectionDrop | null> {
      calls.loadCollectionByHandle += 1
      if (handle === 'shoes') {
        return { id: 'c1', handle: 'shoes', title: 'Shoes' }
      }
      return null
    },
    async loadCollectionProducts(_id, _p, _ctx, _t) {
      calls.loadCollectionProducts += 1
      return { products: [{ id: 'p1', handle: 'hat', title: 'Hat' }], total: 1 }
    },
    async listCollections(_ctx) {
      calls.listCollections += 1
      return [{ id: 'c1', handle: 'shoes', title: 'Shoes' }]
    },
    async loadPageByHandle(handle, _ctx): Promise<PageDrop | null> {
      calls.loadPageByHandle += 1
      if (handle === 'about') return { id: 'pg1', handle: 'about', title: 'About', content: '' }
      return null
    },
    async loadPolicyByHandle(_h, _ctx): Promise<PolicyDrop | null> {
      calls.loadPolicyByHandle += 1
      return null
    },
    async loadBlogByHandle(handle, _ctx): Promise<BlogDrop | null> {
      calls.loadBlogByHandle += 1
      if (handle === 'news') return { id: 'b1', handle: 'news', title: 'News' }
      return null
    },
    async loadArticleByHandles(_bh, _ah, _ctx): Promise<ArticleDrop | null> {
      calls.loadArticleByHandles += 1
      return { id: 'a1', handle: 'first-post', title: 'First post', content: '' }
    },
    async loadBlogArticles(_id, _p, _ctx, _t) {
      calls.loadBlogArticles += 1
      return { articles: [], total: 0 }
    },
    async loadGiftCardById(_id, _ctx): Promise<GiftCardDrop | null> {
      calls.loadGiftCardById += 1
      return null
    },
    async runSearch(terms, _p, _ctx): Promise<SearchDrop> {
      calls.runSearch += 1
      return { performed: true, terms, results_count: 0, results: [] }
    },
  }

  return { inner, calls, products }
}

// ---------------------------------------------------------------------------
// In-memory CacheBackend with glob support
// ---------------------------------------------------------------------------

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

function createMemoryBackend(): CacheBackend & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    store,
    async get<T>(key: string): Promise<T | null> {
      return (store.get(key) as T) ?? null
    },
    async set<T>(key: string, value: T, _ttl: number): Promise<void> {
      store.set(key, value)
    },
    async del(key: string): Promise<void> {
      store.delete(key)
    },
    async delPattern(pattern: string): Promise<number> {
      const re = globToRegExp(pattern)
      let n = 0
      for (const key of Array.from(store.keys())) {
        if (re.test(key)) {
          store.delete(key)
          n += 1
        }
      }
      return n
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const ctx: DataSourceContext = { shopId: 'shop_1', locale: 'en' }
const page: PageArgs = { page: 1, pageSize: 10 }

describe('CachedStorefrontDataSource', () => {
  let stub: ReturnType<typeof createStub>
  let backend: ReturnType<typeof createMemoryBackend>
  let ds: CachedStorefrontDataSource

  beforeEach(() => {
    stub = createStub()
    backend = createMemoryBackend()
    ds = new CachedStorefrontDataSource(stub.inner, { backend })
  })

  // --- happy-path caching ---

  it('caches loadShop — second call hits the cache', async () => {
    await ds.loadShop(ctx)
    await ds.loadShop(ctx)
    expect(stub.calls.loadShop).toBe(1)
  })

  it('caches loadProductByHandle by handle', async () => {
    await ds.loadProductByHandle('hat', ctx)
    await ds.loadProductByHandle('hat', ctx)
    await ds.loadProductByHandle('hat', ctx)
    expect(stub.calls.loadProductByHandle).toBe(1)
  })

  it('caches null results for product handle lookups (negative caching)', async () => {
    const first = await ds.loadProductByHandle('missing', ctx)
    const second = await ds.loadProductByHandle('missing', ctx)
    expect(first).toBeNull()
    expect(second).toBeNull()
    expect(stub.calls.loadProductByHandle).toBe(1)
  })

  it('isolates cache entries across shops', async () => {
    await ds.loadProductByHandle('hat', { shopId: 'shop_1', locale: 'en' })
    await ds.loadProductByHandle('hat', { shopId: 'shop_2', locale: 'en' })
    expect(stub.calls.loadProductByHandle).toBe(2)
  })

  it('isolates cache entries across locales', async () => {
    await ds.loadProductByHandle('hat', { shopId: 'shop_1', locale: 'en' })
    await ds.loadProductByHandle('hat', { shopId: 'shop_1', locale: 'th' })
    expect(stub.calls.loadProductByHandle).toBe(2)
  })

  it('caches loadCollectionByHandle', async () => {
    await ds.loadCollectionByHandle('shoes', ctx)
    await ds.loadCollectionByHandle('shoes', ctx)
    expect(stub.calls.loadCollectionByHandle).toBe(1)
  })

  it('caches listCollections', async () => {
    await ds.listCollections(ctx)
    await ds.listCollections(ctx)
    expect(stub.calls.listCollections).toBe(1)
  })

  it('keys collection products by tag + page so different views cache independently', async () => {
    await ds.loadCollectionProducts('c1', { page: 1, pageSize: 10 }, ctx)
    await ds.loadCollectionProducts('c1', { page: 2, pageSize: 10 }, ctx)
    await ds.loadCollectionProducts('c1', { page: 1, pageSize: 10 }, ctx, 'sale')
    expect(stub.calls.loadCollectionProducts).toBe(3)
    // Re-hit all three — should be cached now.
    await ds.loadCollectionProducts('c1', { page: 1, pageSize: 10 }, ctx)
    await ds.loadCollectionProducts('c1', { page: 2, pageSize: 10 }, ctx)
    await ds.loadCollectionProducts('c1', { page: 1, pageSize: 10 }, ctx, 'sale')
    expect(stub.calls.loadCollectionProducts).toBe(3)
  })

  it('caches loadPageByHandle + loadBlogByHandle + loadArticleByHandles', async () => {
    await ds.loadPageByHandle('about', ctx)
    await ds.loadPageByHandle('about', ctx)
    await ds.loadBlogByHandle('news', ctx)
    await ds.loadBlogByHandle('news', ctx)
    await ds.loadArticleByHandles('news', 'first-post', ctx)
    await ds.loadArticleByHandles('news', 'first-post', ctx)

    expect(stub.calls.loadPageByHandle).toBe(1)
    expect(stub.calls.loadBlogByHandle).toBe(1)
    expect(stub.calls.loadArticleByHandles).toBe(1)
  })

  // --- passthrough ---

  it('never caches loadCart', async () => {
    await ds.loadCart('tok', ctx)
    await ds.loadCart('tok', ctx)
    expect(stub.calls.loadCart).toBe(2)
  })

  it('never caches loadCustomerBySession', async () => {
    await ds.loadCustomerBySession('tok', ctx)
    await ds.loadCustomerBySession('tok', ctx)
    expect(stub.calls.loadCustomerBySession).toBe(2)
  })

  it('never caches runSearch', async () => {
    await ds.runSearch('shoe', page, ctx)
    await ds.runSearch('shoe', page, ctx)
    expect(stub.calls.runSearch).toBe(2)
  })

  it('forwards defaultShopId', () => {
    expect(ds.defaultShopId()).toBe('shop_1')
  })

  // --- ttl=0 opt-out ---

  it('disables caching for a resource when ttl is 0', async () => {
    const optOut = new CachedStorefrontDataSource(stub.inner, {
      backend,
      ttls: { product: 0 },
    })
    await optOut.loadProductByHandle('hat', ctx)
    await optOut.loadProductByHandle('hat', ctx)
    expect(stub.calls.loadProductByHandle).toBe(2)
  })

  // --- fail-open on backend errors ---

  it('falls through to the loader when backend.get throws', async () => {
    const flakyBackend: CacheBackend = {
      async get<T>(_key: string): Promise<T | null> {
        throw new Error('redis down')
      },
      async set<T>(_k: string, _v: T, _t: number): Promise<void> {
        throw new Error('redis down')
      },
      async del() {},
      async delPattern() {
        return 0
      },
    }
    const failDs = new CachedStorefrontDataSource(stub.inner, { backend: flakyBackend })
    const first = await failDs.loadShop(ctx)
    const second = await failDs.loadShop(ctx)
    expect(first.id).toBe('shop_1')
    expect(second.id).toBe('shop_1')
    // Both calls should have hit the loader because the cache is broken.
    expect(stub.calls.loadShop).toBe(2)
  })

  // --- invalidation helpers ---

  it('invalidateProduct drops the specific product across locales', async () => {
    await ds.loadProductByHandle('hat', { shopId: 'shop_1', locale: 'en' })
    await ds.loadProductByHandle('hat', { shopId: 'shop_1', locale: 'th' })
    expect(stub.calls.loadProductByHandle).toBe(2)

    await ds.invalidateProduct('shop_1', 'hat')

    await ds.loadProductByHandle('hat', { shopId: 'shop_1', locale: 'en' })
    await ds.loadProductByHandle('hat', { shopId: 'shop_1', locale: 'th' })
    expect(stub.calls.loadProductByHandle).toBe(4)
  })

  it('invalidateCollection drops both the drop and its paginated product pages', async () => {
    await ds.loadCollectionByHandle('shoes', ctx)
    await ds.loadCollectionProducts('c1', { page: 1, pageSize: 10 }, ctx)
    await ds.loadCollectionProducts('c1', { page: 2, pageSize: 10 }, ctx)
    await ds.listCollections(ctx)
    expect(stub.calls.loadCollectionByHandle).toBe(1)
    expect(stub.calls.loadCollectionProducts).toBe(2)
    expect(stub.calls.listCollections).toBe(1)

    await ds.invalidateCollection('shop_1', 'shoes', 'c1')

    await ds.loadCollectionByHandle('shoes', ctx)
    await ds.loadCollectionProducts('c1', { page: 1, pageSize: 10 }, ctx)
    await ds.loadCollectionProducts('c1', { page: 2, pageSize: 10 }, ctx)
    await ds.listCollections(ctx)
    expect(stub.calls.loadCollectionByHandle).toBe(2)
    expect(stub.calls.loadCollectionProducts).toBe(4)
    expect(stub.calls.listCollections).toBe(2)
  })

  it('invalidateShop clears every resource for that shop, leaving other shops alone', async () => {
    // Populate shop_1 + shop_2.
    await ds.loadShop({ shopId: 'shop_1', locale: 'en' })
    await ds.loadProductByHandle('hat', { shopId: 'shop_1', locale: 'en' })
    await ds.loadShop({ shopId: 'shop_2', locale: 'en' })

    await ds.invalidateShop('shop_1')

    // shop_1 entries must reload.
    await ds.loadShop({ shopId: 'shop_1', locale: 'en' })
    await ds.loadProductByHandle('hat', { shopId: 'shop_1', locale: 'en' })
    expect(stub.calls.loadShop).toBe(3) // 2 shop_1, 1 shop_2
    expect(stub.calls.loadProductByHandle).toBe(2)

    // shop_2 entry must still be cached.
    await ds.loadShop({ shopId: 'shop_2', locale: 'en' })
    expect(stub.calls.loadShop).toBe(3)
  })

  it('invalidateShopSettings clears only the shop drop', async () => {
    await ds.loadShop(ctx)
    await ds.loadProductByHandle('hat', ctx)
    await ds.invalidateShopSettings('shop_1')
    await ds.loadShop(ctx)
    await ds.loadProductByHandle('hat', ctx)
    expect(stub.calls.loadShop).toBe(2)
    expect(stub.calls.loadProductByHandle).toBe(1) // product still cached
  })

  it('invalidatePage / invalidateBlog / invalidateArticle target their own keys', async () => {
    await ds.loadPageByHandle('about', ctx)
    await ds.loadBlogByHandle('news', ctx)
    await ds.loadArticleByHandles('news', 'first-post', ctx)

    await ds.invalidatePage('shop_1', 'about')
    await ds.invalidateBlog('shop_1', 'news', 'b1')
    await ds.invalidateArticle('shop_1', 'news', 'first-post')

    await ds.loadPageByHandle('about', ctx)
    await ds.loadBlogByHandle('news', ctx)
    await ds.loadArticleByHandles('news', 'first-post', ctx)

    expect(stub.calls.loadPageByHandle).toBe(2)
    expect(stub.calls.loadBlogByHandle).toBe(2)
    expect(stub.calls.loadArticleByHandles).toBe(2)
  })

  it('supports a custom key prefix for platform-level isolation', async () => {
    const customDs = new CachedStorefrontDataSource(stub.inner, {
      backend,
      keyPrefix: 'tenant-a:store',
    })
    await customDs.loadShop(ctx)
    // Verify the prefix actually shows up in the backing store.
    const keys = Array.from(backend.store.keys())
    expect(keys.some((k) => k.startsWith('tenant-a:store:shop_1:shop:'))).toBe(true)
  })
})
