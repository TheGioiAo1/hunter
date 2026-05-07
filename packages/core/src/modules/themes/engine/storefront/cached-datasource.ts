/**
 * Gbox Platform — Cached Storefront Data Source (Phase 3B)
 *
 * Decorator that wraps any `StorefrontDataSource` implementation and
 * serves its read methods out of a `CacheBackend` (typically the
 * tiered backend from `cache/tiered.ts`: in-process LRU → Redis).
 *
 * This is the read-side of the 100K-RPS plan in
 * `docs/superpowers/specs/2026-04-07-100k-rps-system-design.md`. The
 * production DB data source (`DbDataSource`) hits PostgreSQL on
 * every call; at peak RPS with ~10 queries per page, that is the
 * single biggest bottleneck. Wrapping it here moves almost all
 * reads out of the query path:
 *
 *   storefront request
 *     → CachedStorefrontDataSource.loadProductByHandle
 *       → backend.get('gbox:store:<shop>:product:<locale>:<handle>')
 *         ↳ HIT (in-process LRU)  → return immediately
 *         ↳ HIT (Redis)           → warm LRU, return
 *         ↳ MISS                   → DbDataSource.loadProductByHandle
 *                                     → backend.set(..., ttlSeconds)
 *                                     → return
 *
 * Design rules:
 *
 *   1. **Decorator, not replacement.** We intentionally do not edit
 *      `DbDataSource` — cache wiring is a cross-cutting concern and
 *      the decorator pattern keeps concerns separated. Tests can
 *      still exercise `DbDataSource` directly without Redis.
 *
 *   2. **Cache the stable reads, pass through the volatile ones.**
 *      Carts and customer sessions mutate per request and must NOT
 *      be cached — those calls are forwarded unchanged. Shop,
 *      product, collection, page, blog, article reads all cache.
 *
 *   3. **Key shape.** Every key is shaped as
 *      `gbox:store:<shopId>:<resource>:<locale>:<handleOrPage>`.
 *      Including `shopId` in the key guarantees multi-tenant
 *      isolation; including `locale` guarantees that translated
 *      fields don't leak across language switches.
 *
 *   4. **Negative caching.** We set `cacheNull: true` for handle
 *      lookups because "this slug does not exist" is a stable
 *      answer for the short TTLs we use (60s for products, 120s
 *      for collections). Without negative caching, attackers
 *      scanning the storefront for slugs like `/products/admin`
 *      would trigger a DB query on every request.
 *
 *   5. **Per-method TTL.** Different resources change at different
 *      rates. Options take the defaults from Shopify's own CDN
 *      behaviour and the existing `api-cache.ts` middleware:
 *
 *        shop          → 600s  (10 min — settings change rarely)
 *        product       → 60s   (inventory updates matter)
 *        collection    → 120s  (product list churn is slower)
 *        collectionPg  → 30s   (pagination pages — feels live)
 *        page/policy   → 600s  (CMS pages are near-static)
 *        blog          → 300s  (5 min)
 *        article       → 300s
 *        listCols      → 60s   (storefront nav, shown everywhere)
 *
 *   6. **Invalidation methods.** Each wrapped method has a matching
 *      `invalidate*` method that calls `backend.delPattern` with a
 *      pattern narrow enough to drop only the affected keys. Write
 *      paths in the admin API (create/update/delete product) call
 *      these after the DB write lands.
 */

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
// Options
// ---------------------------------------------------------------------------

/**
 * Per-resource TTL overrides. All values are in SECONDS. Omitting a
 * field uses the default. Set a field to `0` to disable caching for
 * that resource class specifically (still goes through the
 * decorator but never reads/writes the cache).
 */
export interface CachedDataSourceTtls {
  shop?: number
  product?: number
  collection?: number
  collectionProducts?: number
  listCollections?: number
  page?: number
  policy?: number
  blog?: number
  article?: number
}

export interface CachedDataSourceOptions {
  /** The cache backend to use. Usually `createTieredCacheBackend(...)`. */
  backend: CacheBackend
  /**
   * Namespace prefix for every key this decorator writes. Defaults
   * to `gbox:store`. Override if you run multiple platform tenants
   * on the same Redis and need a wider isolation than shop id alone.
   */
  keyPrefix?: string
  /** Per-resource TTL overrides (seconds). */
  ttls?: CachedDataSourceTtls
}

// Defaults chosen to match the comment block above.
const DEFAULT_TTLS: Required<CachedDataSourceTtls> = {
  shop: 600,
  product: 60,
  collection: 120,
  collectionProducts: 30,
  listCollections: 60,
  page: 600,
  policy: 600,
  blog: 300,
  article: 300,
}

const DEFAULT_PREFIX = 'gbox:store'

// ---------------------------------------------------------------------------
// Envelope helper — distinguishes "miss" from "cached null"
// ---------------------------------------------------------------------------

type Envelope<T> = { v: T }

// ---------------------------------------------------------------------------
// Decorator
// ---------------------------------------------------------------------------

export class CachedStorefrontDataSource implements StorefrontDataSource {
  private readonly backend: CacheBackend
  private readonly prefix: string
  private readonly ttls: Required<CachedDataSourceTtls>

  constructor(
    private readonly inner: StorefrontDataSource,
    options: CachedDataSourceOptions,
  ) {
    this.backend = options.backend
    this.prefix = options.keyPrefix ?? DEFAULT_PREFIX
    this.ttls = { ...DEFAULT_TTLS, ...(options.ttls ?? {}) }
  }

  // -------------------------------------------------------------------------
  // Key construction
  // -------------------------------------------------------------------------

  private keyFor(resource: string, ctx: DataSourceContext, ...parts: string[]): string {
    return [this.prefix, ctx.shopId, resource, ctx.locale, ...parts].join(':')
  }

  private async memo<T>(
    key: string,
    ttlSeconds: number,
    loader: () => Promise<T>,
    cacheNull: boolean,
  ): Promise<T> {
    if (ttlSeconds <= 0) {
      // Per-resource opt-out — skip the cache entirely.
      return loader()
    }

    let envelope: Envelope<T> | null = null
    try {
      envelope = await this.backend.get<Envelope<T>>(key)
    } catch {
      // Fail-open — ignore and load fresh.
    }
    if (envelope && typeof envelope === 'object' && 'v' in envelope) {
      return envelope.v
    }

    const fresh = await loader()

    if (cacheNull || (fresh !== null && fresh !== undefined)) {
      try {
        await this.backend.set<Envelope<T>>(key, { v: fresh }, ttlSeconds)
      } catch {
        // Fail-open on write errors too.
      }
    }

    return fresh
  }

  // -------------------------------------------------------------------------
  // Pass-through — no caching, not tenant-stable
  // -------------------------------------------------------------------------

  defaultShopId(): string {
    return this.inner.defaultShopId()
  }

  loadCart(cartToken: string | undefined, ctx: DataSourceContext): Promise<CartDrop> {
    return this.inner.loadCart(cartToken, ctx)
  }

  loadCustomerBySession(
    sessionToken: string | undefined,
    ctx: DataSourceContext,
  ): Promise<CustomerDrop | null> {
    return this.inner.loadCustomerBySession(sessionToken, ctx)
  }

  runSearch(
    terms: string,
    page: PageArgs,
    ctx: DataSourceContext,
  ): Promise<SearchDrop> {
    // Query strings have near-infinite cardinality — caching every
    // user's typo would trash the cache. Future optimisation: cache
    // the top-N popular search terms with a short TTL.
    return this.inner.runSearch(terms, page, ctx)
  }

  loadGiftCardById(id: string, ctx: DataSourceContext): Promise<GiftCardDrop | null> {
    // Gift card balances are sensitive and change on redemption —
    // never cache.
    return this.inner.loadGiftCardById(id, ctx)
  }

  // -------------------------------------------------------------------------
  // Cached read paths
  // -------------------------------------------------------------------------

  loadShop(ctx: DataSourceContext): Promise<ShopDrop> {
    const key = this.keyFor('shop', ctx)
    return this.memo(key, this.ttls.shop, () => this.inner.loadShop(ctx), false)
  }

  loadProductByHandle(
    handle: string,
    ctx: DataSourceContext,
  ): Promise<ProductDrop | null> {
    const key = this.keyFor('product', ctx, handle)
    return this.memo(
      key,
      this.ttls.product,
      () => this.inner.loadProductByHandle(handle, ctx),
      true,
    )
  }

  loadCollectionByHandle(
    handle: string,
    ctx: DataSourceContext,
  ): Promise<CollectionDrop | null> {
    const key = this.keyFor('collection', ctx, handle)
    return this.memo(
      key,
      this.ttls.collection,
      () => this.inner.loadCollectionByHandle(handle, ctx),
      true,
    )
  }

  loadCollectionProducts(
    collectionId: string,
    page: PageArgs,
    ctx: DataSourceContext,
    tag?: string,
  ): Promise<{ products: ProductDrop[]; total: number }> {
    const tagPart = tag ? `t:${tag}` : 'notag'
    const pagePart = `p${page.page}s${page.pageSize}`
    const key = this.keyFor('collectionProducts', ctx, collectionId, tagPart, pagePart)
    return this.memo(
      key,
      this.ttls.collectionProducts,
      () => this.inner.loadCollectionProducts(collectionId, page, ctx, tag),
      false,
    )
  }

  listCollections(ctx: DataSourceContext): Promise<CollectionDrop[]> {
    const key = this.keyFor('listCollections', ctx)
    return this.memo(
      key,
      this.ttls.listCollections,
      () => this.inner.listCollections(ctx),
      false,
    )
  }

  loadPageByHandle(handle: string, ctx: DataSourceContext): Promise<PageDrop | null> {
    const key = this.keyFor('page', ctx, handle)
    return this.memo(
      key,
      this.ttls.page,
      () => this.inner.loadPageByHandle(handle, ctx),
      true,
    )
  }

  loadPolicyByHandle(
    handle: string,
    ctx: DataSourceContext,
  ): Promise<PolicyDrop | null> {
    const key = this.keyFor('policy', ctx, handle)
    return this.memo(
      key,
      this.ttls.policy,
      () => this.inner.loadPolicyByHandle(handle, ctx),
      true,
    )
  }

  loadBlogByHandle(handle: string, ctx: DataSourceContext): Promise<BlogDrop | null> {
    const key = this.keyFor('blog', ctx, handle)
    return this.memo(
      key,
      this.ttls.blog,
      () => this.inner.loadBlogByHandle(handle, ctx),
      true,
    )
  }

  loadArticleByHandles(
    blogHandle: string,
    articleHandle: string,
    ctx: DataSourceContext,
  ): Promise<ArticleDrop | null> {
    const key = this.keyFor('article', ctx, blogHandle, articleHandle)
    return this.memo(
      key,
      this.ttls.article,
      () => this.inner.loadArticleByHandles(blogHandle, articleHandle, ctx),
      true,
    )
  }

  loadBlogArticles(
    blogId: string,
    page: PageArgs,
    ctx: DataSourceContext,
    tag?: string,
  ): Promise<{ articles: ArticleDrop[]; total: number }> {
    const tagPart = tag ? `t:${tag}` : 'notag'
    const pagePart = `p${page.page}s${page.pageSize}`
    const key = this.keyFor('blogArticles', ctx, blogId, tagPart, pagePart)
    return this.memo(
      key,
      this.ttls.blog,
      () => this.inner.loadBlogArticles(blogId, page, ctx, tag),
      false,
    )
  }

  // -------------------------------------------------------------------------
  // Invalidation helpers — call from write paths (admin API)
  // -------------------------------------------------------------------------

  /**
   * Drop every cached entry for a shop, across all locales and
   * resources. Use after a theme publish or a bulk import.
   */
  async invalidateShop(shopId: string): Promise<void> {
    await this.backend.delPattern(`${this.prefix}:${shopId}:*`)
  }

  /**
   * Drop every cached entry for a single product, across all locales.
   * Call after product create / update / delete.
   */
  async invalidateProduct(shopId: string, handle: string): Promise<void> {
    await this.backend.delPattern(`${this.prefix}:${shopId}:product:*:${handle}`)
  }

  /**
   * Drop every cached entry for a single collection (including all
   * its paginated product pages), across all locales.
   */
  async invalidateCollection(shopId: string, handle: string, collectionId?: string): Promise<void> {
    await this.backend.delPattern(`${this.prefix}:${shopId}:collection:*:${handle}`)
    if (collectionId) {
      await this.backend.delPattern(
        `${this.prefix}:${shopId}:collectionProducts:*:${collectionId}:*`,
      )
    }
    // The collection list also needs a refresh.
    await this.backend.delPattern(`${this.prefix}:${shopId}:listCollections:*`)
  }

  /**
   * Drop the shop drop for a shop (e.g. after settings update).
   */
  async invalidateShopSettings(shopId: string): Promise<void> {
    await this.backend.delPattern(`${this.prefix}:${shopId}:shop:*`)
  }

  /** Drop a CMS page (e.g. after merchant edits the About page). */
  async invalidatePage(shopId: string, handle: string): Promise<void> {
    await this.backend.delPattern(`${this.prefix}:${shopId}:page:*:${handle}`)
  }

  /** Drop a blog + every article that belonged to it. */
  async invalidateBlog(shopId: string, handle: string, blogId?: string): Promise<void> {
    await this.backend.delPattern(`${this.prefix}:${shopId}:blog:*:${handle}`)
    if (blogId) {
      await this.backend.delPattern(
        `${this.prefix}:${shopId}:blogArticles:*:${blogId}:*`,
      )
    }
  }

  /** Drop a single article by its (blog handle, article handle) pair. */
  async invalidateArticle(
    shopId: string,
    blogHandle: string,
    articleHandle: string,
  ): Promise<void> {
    await this.backend.delPattern(
      `${this.prefix}:${shopId}:article:*:${blogHandle}:${articleHandle}`,
    )
  }
}
