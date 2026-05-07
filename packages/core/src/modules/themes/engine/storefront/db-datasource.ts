/**
 * Gbox Platform — Database Storefront Data Source
 *
 * Decision #1 Step 1.19. Production data source that queries
 * PostgreSQL for all storefront drops: shop, products, collections,
 * pages, blogs, articles, cart, customer, etc.
 *
 * Maps the existing Gbox database schema (001_initial) to the
 * Shopify-compatible drop interfaces that the Liquid templates
 * consume. Each method follows the `StorefrontDataSource` contract:
 * returns `null` for missing records, only throws for true
 * infrastructure errors.
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type {
  ArticleDrop,
  BlogDrop,
  CartDrop,
  CollectionDrop,
  CustomerDrop,
  DataSourceContext,
  GiftCardDrop,
  PageDrop,
  PageArgs,
  PolicyDrop,
  ProductDrop,
  SearchDrop,
  ShopDrop,
  StorefrontDataSource,
} from './datasource.js'
import type { CartService } from '../../../cart/service.js'
import { hydrateCart } from '../../../cart/hydrate.js'
import {
  getSessionByToken,
  type CustomerSessionInfo,
} from '../../../customer-auth/service.js'
import { getCustomer } from '../../../customers/service.js'
import { rankCollectionBestSellers } from '../../../collections/best-sellers.js'

/**
 * Optional dependency bag. Keeping this as a bag lets later stages
 * (wishlist, customer-session cache, …) opt in without breaking the
 * constructor signature.
 */
export interface DbDataSourceDeps {
  /**
   * Redis-backed cart store. When present, `loadCart` reads the
   * buyer's cart from Redis and hydrates it against the live
   * catalogue; when absent, `loadCart` returns the empty stub so
   * legacy tests that don't care about cart state still pass.
   */
  cartService?: CartService
  /**
   * Override the "token → session" lookup. Tests inject a spy so
   * the datasource's `loadCustomerBySession` code path can be
   * exercised without hitting the real `customer_sessions` table.
   * Production binds this to `getSessionByToken(db, token)` from
   * `@gbox/core/modules/customer-auth` so the SHA-256 hashed token
   * is checked against the live sessions table.
   *
   * When omitted AND the datasource has a `db` (which it always
   * does), `loadCustomerBySession` falls back to calling the real
   * `getSessionByToken(db, token)` directly — this is the production
   * default and requires zero extra wiring.
   */
  resolveCustomerSession?: (
    token: string,
  ) => Promise<CustomerSessionInfo | null>
}

/** Convert a dollar amount (as stored in the DB) to cents for Shopify-compat money filters */
function dollarsToCents(v: unknown): number {
  if (v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

// ---------------------------------------------------------------------------
// Phase C4 — collection sort_order helpers
// ---------------------------------------------------------------------------

/**
 * Canonical sort_order values, mirrored from the admin `<select>` in
 * `apps/store-admin/src/pages/collections.ts`. Anything outside this
 * set is treated as `manual` so an old migration row, a CSV import,
 * or a typo can never take the storefront page down.
 */
type SortMode =
  | 'manual'
  | 'best-selling'
  | 'alpha-asc'
  | 'alpha-desc'
  | 'price-asc'
  | 'price-desc'
  | 'created-asc'
  | 'created-desc'

function normaliseSortOrder(raw: string | null | undefined): SortMode {
  switch (raw) {
    case 'best-selling':
    case 'alpha-asc':
    case 'alpha-desc':
    case 'price-asc':
    case 'price-desc':
    case 'created-asc':
    case 'created-desc':
      return raw
    case 'manual':
    default:
      return 'manual'
  }
}

/**
 * Map an alpha/created sort mode to a `(column, direction)` pair we
 * can hand to Kysely's `orderBy`. `manual`, `best-selling`, and the
 * two price modes are handled in dedicated branches inside
 * `loadCollectionProducts`, so they aren't in the switch.
 */
function productColumnSpec(mode: SortMode): {
  column: string
  direction: 'asc' | 'desc'
} {
  switch (mode) {
    case 'alpha-asc':
      return { column: 'p.title', direction: 'asc' }
    case 'alpha-desc':
      return { column: 'p.title', direction: 'desc' }
    case 'created-asc':
      return { column: 'p.created_at', direction: 'asc' }
    case 'created-desc':
      return { column: 'p.created_at', direction: 'desc' }
    default:
      return { column: 'cp.position', direction: 'asc' }
  }
}

export class DbDataSource implements StorefrontDataSource {
  private readonly shopId: string

  constructor(
    private readonly db: Kysely<Database>,
    shopId: string,
    private readonly deps: DbDataSourceDeps = {},
  ) {
    this.shopId = shopId
  }

  defaultShopId(): string {
    return this.shopId
  }

  async loadShop(ctx: DataSourceContext): Promise<ShopDrop> {
    const row = await this.db
      .selectFrom('shops')
      .selectAll()
      .where('id', '=', ctx.shopId)
      .executeTakeFirstOrThrow()

    return {
      id: row.id,
      name: row.name,
      domain: (row as any).domain ?? undefined,
      email: (row as any).email ?? undefined,
      phone: (row as any).phone ?? undefined,
      whatsapp_phone: (row as any).whatsapp_phone ?? undefined,
      currency: (row as any).currency ?? 'USD',
      default_locale: ctx.locale,
    }
  }

  async loadCustomerBySession(
    sessionToken: string | undefined,
    ctx: DataSourceContext,
  ): Promise<CustomerDrop | null> {
    if (!sessionToken) return null

    // Resolve the token → session either via the injected spy (tests)
    // or via the real customer-auth lookup (production). Both return
    // `null` when the token is unknown / expired / mis-scoped; any
    // thrown error is swallowed so a transient DB hiccup never turns
    // a storefront page into a 500.
    let session: CustomerSessionInfo | null = null
    try {
      session = this.deps.resolveCustomerSession
        ? await this.deps.resolveCustomerSession(sessionToken)
        : await getSessionByToken(this.db, sessionToken)
    } catch {
      return null
    }
    if (!session) return null

    // Shop scoping — a cookie minted on brand-a must never resolve
    // a customer on brand-b even if they share the same database.
    // `ctx.shopId` is the request's resolved shop; `session.shop_id`
    // is the shop the customer authenticated to. They must match.
    if (session.shop_id !== ctx.shopId) return null

    // Fetch the profile via the customers service so address book
    // + order stats come through for free.
    let profile: Awaited<ReturnType<typeof getCustomer>> = null
    try {
      profile = await getCustomer(this.db, ctx.shopId, session.customer_id)
    } catch {
      return null
    }
    if (!profile) return null

    return {
      id: (profile as any).id,
      email: (profile as any).email ?? null,
      first_name: (profile as any).first_name ?? undefined,
      last_name: (profile as any).last_name ?? undefined,
      // Forward the denormalised stats + addresses so templates that
      // read `customer.orders_count`, `customer.total_spent`, and
      // `customer.addresses` render without extra datasource calls.
      orders_count: (profile as any).orders_count ?? 0,
      total_spent: (profile as any).total_spent ?? '0',
      addresses: Array.isArray((profile as any).addresses)
        ? (profile as any).addresses
        : [],
    } as CustomerDrop
  }

  async loadCart(
    cartToken: string | undefined,
    ctx: DataSourceContext,
  ): Promise<CartDrop> {
    // No cart service wired in? Keep the legacy empty-drop behaviour
    // so downstream tests that don't mock Redis still pass and the
    // storefront never 500s on cart reads during early bring-up.
    const svc = this.deps.cartService
    if (!svc) {
      return { item_count: 0, total_price: 0, items: [] }
    }
    const cart = cartToken ? await svc.getCart(cartToken) : null
    // Hydrate against the live catalogue using the shop id from
    // `ctx` rather than the constructor-bound shopId — this keeps
    // multi-tenant callers that share one datasource instance
    // correct even if the constructor shopId differs from the
    // request's resolved shop.
    return hydrateCart(this.db, cart, ctx.shopId)
  }

  async loadProductByHandle(
    handle: string,
    ctx: DataSourceContext,
  ): Promise<ProductDrop | null> {
    const row = await this.db
      .selectFrom('products')
      .selectAll()
      .where('shop_id', '=', ctx.shopId)
      .where('slug', '=', handle)
      .where('status', '=', 'active')
      .executeTakeFirst()

    if (!row) return null

    const p = row as any

    // Load variants
    const variants = await this.db
      .selectFrom('product_variants')
      .selectAll()
      .where('product_id', '=', p.id)
      .orderBy('position', 'asc')
      .execute()
      .catch(() => [])

    // Load images
    const images = await this.db
      .selectFrom('product_images' as any)
      .selectAll()
      .where('product_id', '=', p.id)
      .orderBy('position' as any, 'asc')
      .execute()
      .catch(() => [])

    const firstVariant = variants[0] as any
    const imageUrls = images.map((i: any) => i.src || i.url)

    // Phase 3.B — expose rich image objects with srcset_json for
    // responsive <img srcset> rendering. Falls back to plain URL
    // strings for backward compat with existing themes.
    const imageObjects = images.map((i: any) => ({
      src: i.src || i.url,
      alt: i.alt || null,
      width: i.width || null,
      height: i.height || null,
      srcset_json: i.srcset_json || null,
    }))

    return {
      id: p.id,
      handle: p.slug,
      title: p.title,
      description: p.body_html ?? p.description ?? '',
      vendor: p.vendor ?? undefined,
      type: p.product_type ?? undefined,
      tags: p.tags ? (Array.isArray(p.tags) ? p.tags : String(p.tags).split(',').map((t: string) => t.trim())) : [],
      price: dollarsToCents(firstVariant?.price),
      compare_at_price: firstVariant?.compare_at_price ? dollarsToCents(firstVariant.compare_at_price) : null,
      available: p.status === 'active',
      variants: variants.map((v: any) => ({
        id: v.id,
        title: v.title,
        price: dollarsToCents(v.price),
        compare_at_price: v.compare_at_price ? dollarsToCents(v.compare_at_price) : null,
        sku: v.sku,
        available: (v.inventory_quantity ?? 0) > 0,
        inventory_quantity: v.inventory_quantity,
      })),
      images: imageUrls,
      image_objects: imageObjects,
      featured_image: imageUrls[0] ?? null,
      featured_image_object: imageObjects[0] ?? null,
      options: [], // Simplified — full options support is a future step
      url: `/products/${p.slug}`,
      // Phase 3.C — SEO fields (fallback to title/description if null)
      seo_title: (p as any).seo_title || null,
      seo_description: (p as any).seo_description || null,
    }
  }

  async loadCollectionByHandle(
    handle: string,
    ctx: DataSourceContext,
  ): Promise<CollectionDrop | null> {
    // Note: in Shopify-speak this is "handle"; in our schema the column
    // is `slug`. The two terms map 1:1 — both are URL-safe identifiers.
    //
    // Phase C4 — `published = true` filter. Draft collections must NEVER
    // render on the storefront; hitting their URL has to 404 rather than
    // leak an in-progress merchandising page. Shopify enforces the same
    // invariant via the `visible` flag.
    //
    // Phase C3c — scheduled publish gate. `published_at` in the future
    // means the merchant scheduled the collection to go live later; we
    // hide it until NOW() catches up. `published_at IS NULL` is the
    // legacy case (pre-migration-048) and stays visible as long as
    // `published=true`.
    const row = await this.db
      .selectFrom('collections')
      .selectAll()
      .where('shop_id', '=', ctx.shopId)
      .where('slug', '=', handle)
      .where('published', '=', true)
      .where((eb) =>
        eb.or([
          eb('published_at' as any, 'is', null),
          eb('published_at' as any, '<=', new Date().toISOString() as any),
        ]),
      )
      .executeTakeFirst()

    if (!row) return null

    const c = row as any

    // Count products in collection — only published / active ones,
    // matching the filter `loadCollectionProducts` applies below. If
    // the count counted drafts too the paginator's total-pages math
    // would overshoot and render an empty last page.
    //
    // Cast `this.db` to any so Kysely's joined-builder typing doesn't
    // complain about the un-typed `collection_products` table. The
    // rest of the chain still works correctly at runtime.
    const dbAny = this.db as any
    const countRow = await dbAny
      .selectFrom('collection_products as cp')
      .innerJoin('products as p', 'p.id', 'cp.product_id')
      .select(dbAny.fn.countAll().as('count'))
      .where('cp.collection_id', '=', c.id)
      .where('p.status', '=', 'active')
      .executeTakeFirst()
      .catch(() => ({ count: 0 }))

    // The DB column is `slug`; the storefront drop exposes it as `handle`
    // because Liquid templates speak Shopify-style. Fall back to the
    // parameter to keep behaviour stable on pre-migration rows.
    const collectionHandle: string = c.slug ?? c.handle ?? handle
    return {
      id: c.id,
      handle: collectionHandle,
      title: c.title,
      description: c.body_html ?? c.description ?? '',
      url: `/collections/${collectionHandle}`,
      products_count: Number((countRow as any)?.count ?? 0),
      // Phase C4 — storefront parity fields. Fallbacks to null (not
      // undefined) so Liquid `{% if collection.seo_title %}` guards
      // behave correctly with legacy rows where the columns are NULL.
      sort_order: c.sort_order ?? null,
      seo_title: c.seo_title ?? null,
      seo_description: c.seo_description ?? null,
      published_at: c.published_at ?? null,
    }
  }

  async loadCollectionProducts(
    collectionId: string,
    page: PageArgs,
    ctx: DataSourceContext,
    _tag?: string,
  ): Promise<{ products: ProductDrop[]; total: number }> {
    const offset = (page.page - 1) * page.pageSize

    // -----------------------------------------------------------------
    // Phase C4 — honour `collections.sort_order`.
    //
    // The Shopify admin UI lets merchants pick from eight sort modes
    // (manual, best-selling, alpha-asc/desc, price-asc/desc,
    // created-asc/desc). We read the chosen mode once up front and
    // translate it into a SQL `ORDER BY`. The look-up is best-effort —
    // a missing collection / pg hiccup falls back to `manual` so the
    // storefront never 500s on a transient error.
    // -----------------------------------------------------------------
    let sortOrderRaw: string | null = null
    try {
      const colRow = await this.db
        .selectFrom('collections')
        .select('sort_order' as any)
        .where('id', '=', collectionId)
        .where('shop_id', '=', ctx.shopId)
        .executeTakeFirst()
      sortOrderRaw = ((colRow as any)?.sort_order ?? null) as string | null
    } catch {
      sortOrderRaw = null
    }
    const sortMode = normaliseSortOrder(sortOrderRaw)

    // -----------------------------------------------------------------
    // Count active members — the pagination math needs this BEFORE we
    // know which products to hydrate. Drafts are excluded so the total
    // matches the list (otherwise the last page renders empty when the
    // collection has drafts mixed in).
    //
    // As with `loadCollectionByHandle`, escape to `any` so Kysely's
    // joined-builder types don't fight the un-typed join tables.
    // -----------------------------------------------------------------
    const dbAny = this.db as any
    const countRow = await dbAny
      .selectFrom('collection_products as cp')
      .innerJoin('products as p', 'p.id', 'cp.product_id')
      .select(dbAny.fn.countAll().as('count'))
      .where('cp.collection_id', '=', collectionId)
      .where('p.status', '=', 'active')
      .executeTakeFirst()
      .catch(() => ({ count: 0 }))

    const total = Number((countRow as any)?.count ?? 0)
    if (total === 0) return { products: [], total }

    // -----------------------------------------------------------------
    // Resolve the paginated id list.
    //
    //   * `manual` — ORDER BY cp.position ASC.
    //   * `best-selling` — ORDER BY SUM(order_line_items.quantity) DESC
    //       over the last 30 days (Phase C3a), with cp.position ASC as a
    //       deterministic tiebreak. Delegated to
    //       `rankCollectionBestSellers` so the ranker is unit-testable in
    //       isolation.
    //   * `alpha-*` / `created-*` — ORDER BY on the products column.
    //   * `price-*` — ORDER BY on MIN(variant.price) via a correlated
    //       subquery; products without variants sort as price 0 so they
    //       cluster at the top of `price-asc`.
    // -----------------------------------------------------------------
    let productIds: string[] = []
    try {
      if (sortMode === 'manual') {
        const cpRows = await dbAny
          .selectFrom('collection_products as cp')
          .innerJoin('products as p', 'p.id', 'cp.product_id')
          .select('cp.product_id as product_id')
          .where('cp.collection_id', '=', collectionId)
          .where('p.status', '=', 'active')
          .orderBy('cp.position', 'asc')
          .limit(page.pageSize)
          .offset(offset)
          .execute()
        productIds = (cpRows as any[]).map((r) => r.product_id)
      } else if (sortMode === 'best-selling') {
        // Phase C3a — real sales-based ranker. Errors here are caught
        // by the outer try/catch and fall back to manual ordering.
        const rank = await rankCollectionBestSellers(this.db as any, {
          shopId: ctx.shopId,
          collectionId,
          limit: page.pageSize,
          offset,
        })
        productIds = rank.productIds
      } else if (sortMode === 'price-asc' || sortMode === 'price-desc') {
        const direction = sortMode === 'price-asc' ? 'asc' : 'desc'
        const rows = await dbAny
          .selectFrom('collection_products as cp')
          .innerJoin('products as p', 'p.id', 'cp.product_id')
          .select([
            'p.id as id',
            sql<number>`COALESCE((SELECT MIN(pv.price) FROM product_variants pv WHERE pv.product_id = p.id), 0)`.as(
              'min_price',
            ),
          ])
          .where('cp.collection_id', '=', collectionId)
          .where('p.status', '=', 'active')
          .orderBy('min_price', direction)
          .limit(page.pageSize)
          .offset(offset)
          .execute()
        productIds = (rows as any[]).map((r) => r.id)
      } else {
        // alpha-asc, alpha-desc, created-asc, created-desc
        const { column, direction } = productColumnSpec(sortMode)
        const rows = await dbAny
          .selectFrom('collection_products as cp')
          .innerJoin('products as p', 'p.id', 'cp.product_id')
          .select('p.id as id')
          .where('cp.collection_id', '=', collectionId)
          .where('p.status', '=', 'active')
          .orderBy(column, direction)
          .limit(page.pageSize)
          .offset(offset)
          .execute()
        productIds = (rows as any[]).map((r) => r.id)
      }
    } catch {
      // Anything goes wrong with the ORDER BY query → fall back to
      // plain position ordering. Better a slightly-off visual order
      // than a 500 on a page that used to render fine.
      const cpRows = await this.db
        .selectFrom('collection_products' as any)
        .select('product_id' as any)
        .where('collection_id', '=', collectionId)
        .orderBy('position' as any, 'asc')
        .limit(page.pageSize)
        .offset(offset)
        .execute()
        .catch(() => [])
      productIds = (cpRows as any[]).map((r) => r.product_id)
    }

    if (productIds.length === 0) return { products: [], total }

    const rows = await this.db
      .selectFrom('products')
      .selectAll()
      .where('id', 'in', productIds)
      .where('status', '=', 'active')
      .execute()

    // Batch-load variants and images for all products
    const allVariants = await this.db
      .selectFrom('product_variants')
      .selectAll()
      .where('product_id', 'in', productIds)
      .orderBy('position', 'asc')
      .execute()
      .catch(() => [])

    const allImages = await this.db
      .selectFrom('product_images' as any)
      .selectAll()
      .where('product_id', 'in', productIds)
      .orderBy('position' as any, 'asc')
      .execute()
      .catch(() => [])

    // Group by product_id
    const variantsByProduct = new Map<string, any[]>()
    for (const v of allVariants as any[]) {
      const arr = variantsByProduct.get(v.product_id) ?? []
      arr.push(v)
      variantsByProduct.set(v.product_id, arr)
    }

    const imagesByProduct = new Map<string, any[]>()
    for (const img of allImages as any[]) {
      const arr = imagesByProduct.get(img.product_id) ?? []
      arr.push(img)
      imagesByProduct.set(img.product_id, arr)
    }

    // Postgres returns `WHERE id IN (...)` rows in arbitrary order, so
    // re-sort them into the `productIds` sequence chosen above.
    // Without this step, the ORDER BY work above is thrown away
    // whenever the in-clause shuffles rows.
    const rowsById = new Map<string, any>()
    for (const r of rows as any[]) rowsById.set(r.id, r)
    const orderedRows = productIds
      .map((id) => rowsById.get(id))
      .filter((r): r is any => r != null)

    const products: ProductDrop[] = orderedRows.map((r: any) => {
      const variants = variantsByProduct.get(r.id) ?? []
      const images = imagesByProduct.get(r.id) ?? []
      const firstVariant = variants[0]
      const imageUrls = images.map((i: any) => i.src || i.url)
      const imageObjects = images.map((i: any) => ({
        src: i.src || i.url,
        alt: i.alt || null,
        width: i.width || null,
        height: i.height || null,
        srcset_json: i.srcset_json || null,
      }))

      return {
        id: r.id,
        handle: r.slug,
        title: r.title,
        description: r.body_html ?? r.description ?? '',
        vendor: r.vendor ?? undefined,
        type: r.product_type ?? undefined,
        price: dollarsToCents(firstVariant?.price),
        compare_at_price: firstVariant?.compare_at_price ? dollarsToCents(firstVariant.compare_at_price) : null,
        available: r.status === 'active',
        variants: variants.map((v: any) => ({
          id: v.id,
          title: v.title,
          price: dollarsToCents(v.price),
          compare_at_price: v.compare_at_price ? dollarsToCents(v.compare_at_price) : null,
        })),
        images: imageUrls,
        featured_image: imageUrls[0] ?? null,
        featured_image_object: imageObjects[0] ?? null,
        url: `/products/${r.slug}`,
      }
    })

    return { products, total }
  }

  async listCollections(ctx: DataSourceContext): Promise<CollectionDrop[]> {
    // Phase C4 — exclude draft collections. `/collections` index + the
    // home-page `collections[handle]` hash must both hide anything the
    // merchant hasn't flipped to published yet.
    //
    // Phase C3c — future-dated `published_at` means "scheduled to go
    // live later"; hide until NOW() catches up. Mirrors the gate in
    // `loadCollectionByHandle` so a scheduled collection's direct URL
    // and its appearance in the index stay consistent.
    const rows = await this.db
      .selectFrom('collections')
      .selectAll()
      .where('shop_id', '=', ctx.shopId)
      .where('published', '=', true)
      .where((eb) =>
        eb.or([
          eb('published_at' as any, 'is', null),
          eb('published_at' as any, '<=', new Date().toISOString() as any),
        ]),
      )
      .orderBy('title', 'asc')
      .execute()

    return rows.map((r: any) => {
      const handle: string = r.slug ?? r.handle
      return {
        id: r.id,
        handle,
        title: r.title,
        description: r.body_html ?? r.description ?? '',
        url: `/collections/${handle}`,
        // Surface the same parity fields as loadCollectionByHandle so
        // the `/collections` index page can render SEO overrides and
        // the home-page section eager-loader can pass the merchant-
        // chosen sort when it calls loadCollectionProducts.
        sort_order: r.sort_order ?? null,
        seo_title: r.seo_title ?? null,
        seo_description: r.seo_description ?? null,
        published_at: r.published_at ?? null,
      }
    })
  }

  async loadPageByHandle(
    handle: string,
    ctx: DataSourceContext,
  ): Promise<PageDrop | null> {
    const row = await this.db
      .selectFrom('pages' as any)
      .selectAll()
      .where('shop_id', '=', ctx.shopId)
      .where('slug', '=', handle)
      .executeTakeFirst()
      .catch(() => null)

    if (!row) return null
    const p = row as any

    return {
      id: p.id,
      handle: p.slug ?? p.handle,
      title: p.title,
      content: p.body_html ?? p.content ?? '',
      url: `/pages/${p.slug ?? p.handle}`,
      template_suffix: p.template_suffix ?? null,
    }
  }

  async loadPolicyByHandle(
    handle: string,
    _ctx: DataSourceContext,
  ): Promise<PolicyDrop | null> {
    // Policies are stored as pages with specific handles in Shopify
    // For now, return null — policies are a future feature
    return null
  }

  async loadBlogByHandle(
    handle: string,
    ctx: DataSourceContext,
  ): Promise<BlogDrop | null> {
    const row = await this.db
      .selectFrom('blogs' as any)
      .selectAll()
      .where('shop_id', '=', ctx.shopId)
      .where('handle', '=', handle)
      .executeTakeFirst()
      .catch(() => null)

    if (!row) return null
    const b = row as any

    return {
      id: b.id,
      handle: b.handle,
      title: b.title,
      url: `/blogs/${b.handle}`,
    }
  }

  async loadArticleByHandles(
    blogHandle: string,
    articleHandle: string,
    ctx: DataSourceContext,
  ): Promise<ArticleDrop | null> {
    const blog = await this.loadBlogByHandle(blogHandle, ctx)
    if (!blog) return null

    const row = await this.db
      .selectFrom('articles' as any)
      .selectAll()
      .where('blog_id', '=', blog.id)
      .where('handle', '=', articleHandle)
      .executeTakeFirst()
      .catch(() => null)

    if (!row) return null
    const a = row as any

    return {
      id: a.id,
      handle: a.handle,
      title: a.title,
      content: a.body_html ?? a.content ?? '',
      excerpt: a.excerpt ?? undefined,
      author: a.author ?? undefined,
      published_at: a.published_at ?? undefined,
      url: `/blogs/${blogHandle}/${a.handle}`,
    }
  }

  async loadBlogArticles(
    blogId: string,
    page: PageArgs,
    _ctx: DataSourceContext,
    _tag?: string,
  ): Promise<{ articles: ArticleDrop[]; total: number }> {
    const offset = (page.page - 1) * page.pageSize

    const countRow = await this.db
      .selectFrom('articles' as any)
      .select(this.db.fn.countAll<number>().as('count'))
      .where('blog_id', '=', blogId)
      .executeTakeFirst()
      .catch(() => ({ count: 0 }))

    const total = Number((countRow as any)?.count ?? 0)

    const rows = await this.db
      .selectFrom('articles' as any)
      .selectAll()
      .where('blog_id', '=', blogId)
      .orderBy('published_at' as any, 'desc')
      .limit(page.pageSize)
      .offset(offset)
      .execute()
      .catch(() => [])

    const articles: ArticleDrop[] = rows.map((r: any) => ({
      id: r.id,
      handle: r.handle,
      title: r.title,
      content: r.body_html ?? r.content ?? '',
      excerpt: r.excerpt ?? undefined,
      author: r.author ?? undefined,
      published_at: r.published_at ?? undefined,
    }))

    return { articles, total }
  }

  async loadGiftCardById(
    _id: string,
    _ctx: DataSourceContext,
  ): Promise<GiftCardDrop | null> {
    // Gift cards are a future feature
    return null
  }

  async runSearch(
    terms: string,
    page: PageArgs,
    ctx: DataSourceContext,
  ): Promise<SearchDrop> {
    if (!terms.trim()) {
      return { performed: false, terms: '', results_count: 0, results: [] }
    }

    const pattern = `%${terms}%`
    const offset = (page.page - 1) * page.pageSize

    const rows = await this.db
      .selectFrom('products')
      .selectAll()
      .where('shop_id', '=', ctx.shopId)
      .where('status', '=', 'active')
      .where((eb) =>
        eb.or([
          eb('title', 'ilike', pattern),
          eb('body_html' as any, 'ilike', pattern),
        ]),
      )
      .limit(page.pageSize)
      .offset(offset)
      .execute()
      .catch(() => [])

    const results: ProductDrop[] = rows.map((r: any) => ({
      id: r.id,
      handle: r.slug,
      title: r.title,
      description: r.body_html ?? '',
      vendor: r.vendor ?? undefined,
      price: 0,
      available: true,
      url: `/products/${r.slug}`,
    }))

    return {
      performed: true,
      terms,
      results_count: results.length,
      results,
    }
  }
}
