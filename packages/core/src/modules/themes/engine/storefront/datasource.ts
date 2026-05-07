/**
 * Gbox Platform — Storefront Data Source
 *
 * Decision #1 Step 1.14 — The interface every storefront route
 * loader uses to pull drops from the data layer, plus an in-memory
 * implementation for tests + smoke + dev.
 *
 * Why an interface, not a concrete class?
 *
 *   - The router is one chunk of glue logic; the data layer is
 *     another. Keeping them separated by an interface lets us swap
 *     between Postgres (production), R2 cache (edge), and an
 *     in-memory map (tests) without touching the router.
 *
 *   - Step 1.14 only ships `MemoryDataSource`. The Postgres adapter
 *     lives in a future step alongside the actual storefront
 *     queries — they'll need joins, prepared statements, and a
 *     read replica. We don't want to block this step on that work.
 *
 *   - Mocking an interface in unit tests is one line; mocking a
 *     concrete class with a hidden DB connection is a maintenance
 *     hazard.
 *
 * Naming: `loadX` for "fetch by handle/id", `listX` for paginated
 * collections. Methods that return null for "not found" do so
 * explicitly — they NEVER throw on a missing handle. Throws are
 * reserved for true infrastructure errors (DB down, malformed
 * row) and become 500s in the router.
 */

// ---------------------------------------------------------------------------
// Drop shapes (kept loose — Liquid doesn't care about TS field types)
// ---------------------------------------------------------------------------

/** Shop drop. Mirrors Shopify's `shop` global. */
export interface ShopDrop {
  id: string
  name: string
  domain?: string
  email?: string
  phone?: string
  default_locale?: string
  currency?: string
  money_format?: string
  [extra: string]: unknown
}

/** Product drop. Mirrors Shopify's `product` global. */
export interface ProductDrop {
  id: string
  handle: string
  title: string
  description?: string
  vendor?: string
  type?: string
  tags?: string[]
  price?: number
  compare_at_price?: number | null
  available?: boolean
  variants?: unknown[]
  images?: unknown[]
  featured_image?: unknown
  options?: unknown[]
  url?: string
  [extra: string]: unknown
}

/** Collection drop. */
export interface CollectionDrop {
  id: string
  handle: string
  title: string
  description?: string
  url?: string
  /** Total products across all pages — for pagination. */
  products_count?: number
  /** Tag filter applied to this view, if any. */
  current_tag?: string | null
  // ---- Phase C4 — storefront parity fields ----------------------------
  /**
   * Merchant-chosen sort (manual/alpha-asc/price-desc/…). The datasource
   * applies this server-side inside `loadCollectionProducts`, but we
   * surface it on the drop too so Liquid templates can render a
   * "Sort: {{ collection.sort_order }}" indicator and so client-side
   * re-sort widgets know the current order.
   */
  sort_order?: string | null
  /** Custom <title> override. Falls through to `title` when null. */
  seo_title?: string | null
  /** Custom <meta description> override. Falls through to description. */
  seo_description?: string | null
  /**
   * First-publish timestamp. Used by the sitemap loader for
   * `<lastmod>` on collection URLs and by theme templates that
   * highlight "new" collections.
   */
  published_at?: string | null
  [extra: string]: unknown
}

/** Page drop. */
export interface PageDrop {
  id: string
  handle: string
  title: string
  content: string
  url?: string
  template_suffix?: string | null
  [extra: string]: unknown
}

/** Policy drop (privacy/refund/terms/shipping). */
export interface PolicyDrop {
  id: string
  handle: string
  title: string
  body: string
  url?: string
  [extra: string]: unknown
}

/** Blog drop. */
export interface BlogDrop {
  id: string
  handle: string
  title: string
  url?: string
  articles_count?: number
  current_tag?: string | null
  [extra: string]: unknown
}

/** Article drop. */
export interface ArticleDrop {
  id: string
  handle: string
  title: string
  content: string
  excerpt?: string
  author?: string
  published_at?: string
  url?: string
  [extra: string]: unknown
}

/** Customer drop. */
export interface CustomerDrop {
  id: string
  email: string
  first_name?: string
  last_name?: string
  orders_count?: number
  total_spent?: number
  [extra: string]: unknown
}

/** Cart drop. */
export interface CartDrop {
  token?: string
  item_count: number
  total_price?: number
  items: unknown[]
  [extra: string]: unknown
}

/** Gift card drop. */
export interface GiftCardDrop {
  id: string
  code?: string
  balance: number
  currency?: string
  expires_on?: string | null
  url?: string
  [extra: string]: unknown
}

/** Search results drop. */
export interface SearchDrop {
  performed: boolean
  terms: string
  results_count: number
  results: unknown[]
  [extra: string]: unknown
}

// ---------------------------------------------------------------------------
// Datasource interface
// ---------------------------------------------------------------------------

/**
 * Per-load options. `shopId` is the multi-tenant key — every method
 * accepts it explicitly so the datasource can scope queries
 * correctly. `locale` is the negotiated locale (for translated
 * fields when the underlying store supports them).
 */
export interface DataSourceContext {
  shopId: string
  locale: string
}

/**
 * Pagination args for collection / blog loaders. `page` is
 * 1-indexed; `pageSize` is the upper bound (loader may clamp).
 */
export interface PageArgs {
  page: number
  pageSize: number
}

/**
 * The contract every storefront data source implements. Methods
 * return `null` for "not found"; throws are reserved for true
 * infrastructure errors.
 */
export interface StorefrontDataSource {
  /** Default shop id for single-tenant deployments + tests. */
  defaultShopId(): string

  /** Load shop drop. Throws if shop doesn't exist (mis-routing). */
  loadShop(ctx: DataSourceContext): Promise<ShopDrop>

  /** Load a customer by session token, or null when anonymous. */
  loadCustomerBySession(
    sessionToken: string | undefined,
    ctx: DataSourceContext,
  ): Promise<CustomerDrop | null>

  /** Load (or build empty) a cart by token. Always returns a drop. */
  loadCart(
    cartToken: string | undefined,
    ctx: DataSourceContext,
  ): Promise<CartDrop>

  /** Load product by handle. Null when handle doesn't exist. */
  loadProductByHandle(
    handle: string,
    ctx: DataSourceContext,
  ): Promise<ProductDrop | null>

  /** Load collection by handle. Null when handle doesn't exist. */
  loadCollectionByHandle(
    handle: string,
    ctx: DataSourceContext,
  ): Promise<CollectionDrop | null>

  /**
   * Load a page of products inside a collection. Returns the
   * sliced product list and the total count for pagination math.
   * Tag filter is the optional 4th arg from the URL pattern.
   */
  loadCollectionProducts(
    collectionId: string,
    page: PageArgs,
    ctx: DataSourceContext,
    tag?: string,
  ): Promise<{ products: ProductDrop[]; total: number }>

  /** List ALL collections (for `/collections` index). */
  listCollections(
    ctx: DataSourceContext,
  ): Promise<CollectionDrop[]>

  /** Load page by handle. Null when handle doesn't exist. */
  loadPageByHandle(
    handle: string,
    ctx: DataSourceContext,
  ): Promise<PageDrop | null>

  /** Load policy by handle (privacy/refund/etc.). */
  loadPolicyByHandle(
    handle: string,
    ctx: DataSourceContext,
  ): Promise<PolicyDrop | null>

  /** Load blog by handle. */
  loadBlogByHandle(
    handle: string,
    ctx: DataSourceContext,
  ): Promise<BlogDrop | null>

  /** Load article by blog handle + article handle. */
  loadArticleByHandles(
    blogHandle: string,
    articleHandle: string,
    ctx: DataSourceContext,
  ): Promise<ArticleDrop | null>

  /**
   * Page the articles inside a blog (with optional tag filter).
   * Mirrors `loadCollectionProducts` for blogs.
   */
  loadBlogArticles(
    blogId: string,
    page: PageArgs,
    ctx: DataSourceContext,
    tag?: string,
  ): Promise<{ articles: ArticleDrop[]; total: number }>

  /** Load gift card by id. Null when id is unknown. */
  loadGiftCardById(
    id: string,
    ctx: DataSourceContext,
  ): Promise<GiftCardDrop | null>

  /**
   * Run a search. Always returns a `SearchDrop` with
   * `performed: false` when terms are empty (Shopify semantics —
   * the search template renders the empty form when this is the
   * case).
   */
  runSearch(
    terms: string,
    page: PageArgs,
    ctx: DataSourceContext,
  ): Promise<SearchDrop>
}

// ---------------------------------------------------------------------------
// In-memory implementation (for tests, smoke, dev preview)
// ---------------------------------------------------------------------------

/**
 * Seed shape for `MemoryDataSource`. Each field is optional — the
 * data source returns null/empty for anything missing.
 */
export interface MemoryDataSourceSeed {
  shop?: Partial<ShopDrop>
  products?: ProductDrop[]
  collections?: Array<
    CollectionDrop & { product_handles?: string[] }
  >
  pages?: PageDrop[]
  policies?: PolicyDrop[]
  blogs?: Array<BlogDrop & { article_handles?: string[] }>
  articles?: ArticleDrop[]
  giftCards?: GiftCardDrop[]
  customers?: Array<CustomerDrop & { session_token?: string }>
  carts?: Record<string, CartDrop>
  search?: { results: unknown[] }
}

/**
 * Tests + smoke + dev-mode-without-DB data source. Holds everything
 * in JS Maps; lookups are O(n) by handle which is fine for the
 * volumes a single test ever uses.
 *
 * NOT for production. The Postgres adapter is a separate file.
 */
export class MemoryDataSource implements StorefrontDataSource {
  private readonly shop: ShopDrop
  private readonly productsByHandle = new Map<string, ProductDrop>()
  private readonly collectionsByHandle = new Map<
    string,
    CollectionDrop & { product_handles?: string[] }
  >()
  private readonly pagesByHandle = new Map<string, PageDrop>()
  private readonly policiesByHandle = new Map<string, PolicyDrop>()
  private readonly blogsByHandle = new Map<
    string,
    BlogDrop & { article_handles?: string[] }
  >()
  private readonly articlesByHandle = new Map<string, ArticleDrop>()
  private readonly giftCardsById = new Map<string, GiftCardDrop>()
  private readonly customersBySession = new Map<string, CustomerDrop>()
  private readonly cartsByToken: Record<string, CartDrop>
  private readonly searchResults: unknown[]

  constructor(private readonly seed: MemoryDataSourceSeed = {}) {
    this.shop = {
      id: 'shop_memory',
      name: 'Gbox Memory Shop',
      domain: 'memory.gbox.test',
      default_locale: 'en',
      currency: 'USD',
      money_format: '${{amount}}',
      ...(seed.shop ?? {}),
    }
    for (const p of seed.products ?? []) {
      this.productsByHandle.set(p.handle, p)
    }
    for (const c of seed.collections ?? []) {
      this.collectionsByHandle.set(c.handle, c)
    }
    for (const p of seed.pages ?? []) {
      this.pagesByHandle.set(p.handle, p)
    }
    for (const p of seed.policies ?? []) {
      this.policiesByHandle.set(p.handle, p)
    }
    for (const b of seed.blogs ?? []) {
      this.blogsByHandle.set(b.handle, b)
    }
    for (const a of seed.articles ?? []) {
      this.articlesByHandle.set(a.handle, a)
    }
    for (const g of seed.giftCards ?? []) {
      this.giftCardsById.set(g.id, g)
    }
    for (const c of seed.customers ?? []) {
      if (c.session_token) {
        this.customersBySession.set(c.session_token, c)
      }
    }
    this.cartsByToken = seed.carts ?? {}
    this.searchResults = seed.search?.results ?? []
  }

  defaultShopId(): string {
    return this.shop.id
  }

  async loadShop(_ctx?: DataSourceContext): Promise<ShopDrop> {
    return this.shop
  }

  async loadCustomerBySession(
    sessionToken: string | undefined,
    _ctx?: DataSourceContext,
  ): Promise<CustomerDrop | null> {
    if (!sessionToken) return null
    return this.customersBySession.get(sessionToken) ?? null
  }

  async loadCart(
    cartToken: string | undefined,
    _ctx?: DataSourceContext,
  ): Promise<CartDrop> {
    if (cartToken && this.cartsByToken[cartToken]) {
      return this.cartsByToken[cartToken]
    }
    // Empty cart for anon visitors / unknown tokens.
    return {
      token: cartToken,
      item_count: 0,
      total_price: 0,
      items: [],
    }
  }

  async loadProductByHandle(
    handle: string,
    _ctx?: DataSourceContext,
  ): Promise<ProductDrop | null> {
    return this.productsByHandle.get(handle) ?? null
  }

  async loadCollectionByHandle(
    handle: string,
    _ctx?: DataSourceContext,
  ): Promise<CollectionDrop | null> {
    return this.collectionsByHandle.get(handle) ?? null
  }

  async loadCollectionProducts(
    collectionId: string,
    page: PageArgs,
    _ctx: DataSourceContext,
    tag?: string,
  ): Promise<{ products: ProductDrop[]; total: number }> {
    // Find the collection by id (linear scan — fine for tests).
    let collection:
      | (CollectionDrop & { product_handles?: string[] })
      | undefined
    for (const c of this.collectionsByHandle.values()) {
      if (c.id === collectionId) {
        collection = c
        break
      }
    }
    if (!collection || !collection.product_handles) {
      return { products: [], total: 0 }
    }
    let products = collection.product_handles
      .map((h) => this.productsByHandle.get(h))
      .filter((p): p is ProductDrop => p != null)
    if (tag) {
      products = products.filter((p) => (p.tags ?? []).includes(tag))
    }
    const total = products.length
    const offset = Math.max(0, (page.page - 1) * page.pageSize)
    const slice = products.slice(offset, offset + page.pageSize)
    return { products: slice, total }
  }

  async listCollections(_ctx?: DataSourceContext): Promise<CollectionDrop[]> {
    return [...this.collectionsByHandle.values()]
  }

  async loadPageByHandle(
    handle: string,
    _ctx?: DataSourceContext,
  ): Promise<PageDrop | null> {
    return this.pagesByHandle.get(handle) ?? null
  }

  async loadPolicyByHandle(
    handle: string,
    _ctx?: DataSourceContext,
  ): Promise<PolicyDrop | null> {
    return this.policiesByHandle.get(handle) ?? null
  }

  async loadBlogByHandle(
    handle: string,
    _ctx?: DataSourceContext,
  ): Promise<BlogDrop | null> {
    return this.blogsByHandle.get(handle) ?? null
  }

  async loadArticleByHandles(
    blogHandle: string,
    articleHandle: string,
    _ctx?: DataSourceContext,
  ): Promise<ArticleDrop | null> {
    const blog = this.blogsByHandle.get(blogHandle)
    if (!blog || !blog.article_handles?.includes(articleHandle)) {
      return null
    }
    return this.articlesByHandle.get(articleHandle) ?? null
  }

  async loadBlogArticles(
    blogId: string,
    page: PageArgs,
    _ctx: DataSourceContext,
    tag?: string,
  ): Promise<{ articles: ArticleDrop[]; total: number }> {
    let blog: (BlogDrop & { article_handles?: string[] }) | undefined
    for (const b of this.blogsByHandle.values()) {
      if (b.id === blogId) {
        blog = b
        break
      }
    }
    if (!blog || !blog.article_handles) {
      return { articles: [], total: 0 }
    }
    let articles = blog.article_handles
      .map((h) => this.articlesByHandle.get(h))
      .filter((a): a is ArticleDrop => a != null)
    if (tag) {
      // No tag field on the article drop in the seed; treat as
      // "no matches" for now. Real datasource will filter on
      // article tags.
      articles = []
    }
    const total = articles.length
    const offset = Math.max(0, (page.page - 1) * page.pageSize)
    return {
      articles: articles.slice(offset, offset + page.pageSize),
      total,
    }
  }

  async loadGiftCardById(
    id: string,
    _ctx?: DataSourceContext,
  ): Promise<GiftCardDrop | null> {
    return this.giftCardsById.get(id) ?? null
  }

  async runSearch(
    terms: string,
    page: PageArgs,
    _ctx?: DataSourceContext,
  ): Promise<SearchDrop> {
    if (!terms || !terms.trim()) {
      return {
        performed: false,
        terms: '',
        results_count: 0,
        results: [],
      }
    }
    // Naive: every seed result matches every non-empty query.
    const total = this.searchResults.length
    const offset = Math.max(0, (page.page - 1) * page.pageSize)
    return {
      performed: true,
      terms,
      results_count: total,
      results: this.searchResults.slice(offset, offset + page.pageSize),
    }
  }
}
