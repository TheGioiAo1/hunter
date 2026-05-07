/**
 * Gbox Platform — Search Service
 *
 * Full-text search using PostgreSQL tsvector / tsquery for ranked results
 * across products, orders, customers, and pages.
 */

import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchFilters {
  category?: string
  min_price?: string
  max_price?: string
  in_stock?: boolean
  tags?: string[]
}

export interface SearchPagination {
  limit?: number
  offset?: number
}

export interface ProductSearchResult {
  id: string
  title: string
  slug: string
  price: string
  image: string | null
  relevance: number
}

export interface OrderSearchResult {
  id: string
  order_number: number
  email: string | null
  customer_name: string | null
  financial_status: string
  total_price: string
  created_at: string
}

export interface CustomerSearchResult {
  id: string
  email: string | null
  first_name: string | null
  last_name: string | null
  phone: string | null
  orders_count: number
  total_spent: string
}

export interface PageSearchResult {
  id: string
  title: string
  slug: string
  excerpt: string | null
}

export interface CombinedSearchResults {
  products: ProductSearchResult[]
  orders: OrderSearchResult[]
  customers: CustomerSearchResult[]
  pages: PageSearchResult[]
}

// ---------------------------------------------------------------------------
// searchProducts
// ---------------------------------------------------------------------------

/**
 * Full-text search across products.title, products.body_html, and
 * product_variants.sku using PostgreSQL ts_vector + ts_query with ranking.
 */
export async function searchProducts(
  db: Kysely<Database>,
  shopId: string,
  query: string,
  filters: SearchFilters = {},
  pagination: SearchPagination = {},
): Promise<{ results: ProductSearchResult[]; total: number }> {
  const { limit = 20, offset = 0 } = pagination
  const tsQuery = toTsQuery(query)

  if (!tsQuery) {
    return { results: [], total: 0 }
  }

  // Build the base query joining products with their first variant and first image
  let baseQuery = db
    .selectFrom('products as p')
    .leftJoin('product_variants as pv', 'pv.product_id', 'p.id')
    .leftJoin('product_images as pi', 'pi.product_id', 'p.id')
    .where('p.shop_id', '=', shopId)
    .where('p.status', '=', 'active')
    .where(
      sql<boolean>`(
        to_tsvector('english', coalesce(p.title, ''))
        || to_tsvector('english', coalesce(p.body_html, ''))
        || to_tsvector('english', coalesce(pv.sku, ''))
      ) @@ to_tsquery('english', ${tsQuery})`,
    )

  // Apply optional filters
  if (filters.category) {
    baseQuery = baseQuery.where('p.product_type', '=', filters.category)
  }
  if (filters.min_price) {
    baseQuery = baseQuery.where('pv.price', '>=', filters.min_price)
  }
  if (filters.max_price) {
    baseQuery = baseQuery.where('pv.price', '<=', filters.max_price)
  }
  if (filters.in_stock) {
    baseQuery = baseQuery.where('pv.inventory_quantity', '>', 0)
  }
  if (filters.tags && filters.tags.length > 0) {
    baseQuery = baseQuery.where('p.tags', '&&', filters.tags)
  }

  // Count query
  const countResult = await db
    .selectFrom(
      baseQuery
        .select(sql<string>`p.id`.as('pid'))
        .groupBy('p.id')
        .as('sub'),
    )
    .select(db.fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow()

  // Results query with ranking
  const rows = await baseQuery
    .select([
      'p.id',
      'p.title',
      'p.slug',
      sql<string>`min(pv.price)`.as('price'),
      sql<string | null>`min(pi.src)`.as('image'),
      sql<number>`ts_rank(
        to_tsvector('english', coalesce(p.title, ''))
        || to_tsvector('english', coalesce(p.body_html, ''))
        || to_tsvector('english', coalesce(pv.sku, '')),
        to_tsquery('english', ${tsQuery})
      )`.as('relevance'),
    ])
    .groupBy(['p.id', 'p.title', 'p.slug'])
    .orderBy('relevance', 'desc')
    .limit(limit)
    .offset(offset)
    .execute()

  const results: ProductSearchResult[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    slug: r.slug,
    price: r.price ?? '0',
    image: r.image,
    relevance: Number(r.relevance),
  }))

  return { results, total: Number(countResult.count) }
}

// ---------------------------------------------------------------------------
// searchOrders
// ---------------------------------------------------------------------------

/**
 * Search orders by order_number, customer email, or customer name.
 */
export async function searchOrders(
  db: Kysely<Database>,
  shopId: string,
  query: string,
): Promise<OrderSearchResult[]> {
  const pattern = `%${query}%`

  const rows = await db
    .selectFrom('orders as o')
    .leftJoin('customers as c', 'c.id', 'o.customer_id')
    .where('o.shop_id', '=', shopId)
    .where((eb) =>
      eb.or([
        eb('o.order_number', '=', parseInt(query, 10) || -1),
        eb('o.email', 'ilike', pattern),
        eb('c.email', 'ilike', pattern),
        eb('c.first_name', 'ilike', pattern),
        eb('c.last_name', 'ilike', pattern),
        eb(
          sql<string>`concat(c.first_name, ' ', c.last_name)`,
          'ilike',
          pattern,
        ),
      ]),
    )
    .select([
      'o.id',
      'o.order_number',
      'o.email',
      sql<string | null>`concat(c.first_name, ' ', c.last_name)`.as('customer_name'),
      'o.financial_status',
      'o.total_price',
      'o.created_at',
    ])
    .orderBy('o.created_at', 'desc')
    .limit(20)
    .execute()

  return rows.map((r) => ({
    id: r.id,
    order_number: Number(r.order_number),
    email: r.email,
    customer_name: r.customer_name,
    financial_status: r.financial_status,
    total_price: r.total_price,
    created_at: r.created_at,
  }))
}

// ---------------------------------------------------------------------------
// searchCustomers
// ---------------------------------------------------------------------------

/**
 * Search customers by email, name, or phone.
 */
export async function searchCustomers(
  db: Kysely<Database>,
  shopId: string,
  query: string,
): Promise<CustomerSearchResult[]> {
  const pattern = `%${query}%`

  const rows = await db
    .selectFrom('customers')
    .where('shop_id', '=', shopId)
    .where((eb) =>
      eb.or([
        eb('email', 'ilike', pattern),
        eb('first_name', 'ilike', pattern),
        eb('last_name', 'ilike', pattern),
        eb('phone', 'ilike', pattern),
        eb(
          sql<string>`concat(first_name, ' ', last_name)`,
          'ilike',
          pattern,
        ),
      ]),
    )
    .select([
      'id',
      'email',
      'first_name',
      'last_name',
      'phone',
      'orders_count',
      'total_spent',
    ])
    .orderBy('orders_count', 'desc')
    .limit(20)
    .execute()

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    first_name: r.first_name,
    last_name: r.last_name,
    phone: r.phone,
    orders_count: Number(r.orders_count),
    total_spent: r.total_spent,
  }))
}

// ---------------------------------------------------------------------------
// searchAll
// ---------------------------------------------------------------------------

/**
 * Combined search across products, orders, customers, and pages.
 */
export async function searchAll(
  db: Kysely<Database>,
  shopId: string,
  query: string,
): Promise<CombinedSearchResults> {
  const [productResult, orders, customers, pages] = await Promise.all([
    searchProducts(db, shopId, query, {}, { limit: 5 }),
    searchOrders(db, shopId, query),
    searchCustomers(db, shopId, query),
    searchPages(db, shopId, query),
  ])

  return {
    products: productResult.results,
    orders: orders.slice(0, 5),
    customers: customers.slice(0, 5),
    pages: pages.slice(0, 5),
  }
}

// ---------------------------------------------------------------------------
// searchPages (internal helper used by searchAll)
// ---------------------------------------------------------------------------

async function searchPages(
  db: Kysely<Database>,
  shopId: string,
  query: string,
): Promise<PageSearchResult[]> {
  const pattern = `%${query}%`

  const rows = await db
    .selectFrom('pages')
    .where('shop_id', '=', shopId)
    .where('published', '=', true)
    .where((eb) =>
      eb.or([
        eb('title', 'ilike', pattern),
        eb('body_html', 'ilike', pattern),
      ]),
    )
    .select(['id', 'title', 'slug', 'body_html'])
    .orderBy('updated_at', 'desc')
    .limit(10)
    .execute()

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    slug: r.slug,
    excerpt: r.body_html
      ? r.body_html.replace(/<[^>]+>/g, '').slice(0, 200)
      : null,
  }))
}

// ---------------------------------------------------------------------------
// buildSearchIndex
// ---------------------------------------------------------------------------

/**
 * Rebuild or create GIN indexes for full-text search on products.
 * Safe to call repeatedly (uses IF NOT EXISTS).
 */
export async function buildSearchIndex(
  db: Kysely<Database>,
  _shopId: string,
): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_products_search
    ON products
    USING gin(
      to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body_html, ''))
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_product_variants_sku_search
    ON product_variants
    USING gin(
      to_tsvector('english', coalesce(sku, ''))
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_pages_search
    ON pages
    USING gin(
      to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body_html, ''))
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_blog_posts_search
    ON blog_posts
    USING gin(
      to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body_html, ''))
    )
  `.execute(db)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a user query string into a PostgreSQL tsquery expression.
 * Splits on whitespace, sanitises each token, and joins with '&'.
 */
function toTsQuery(raw: string): string | null {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-zA-Z0-9]/g, ''))
    .filter(Boolean)

  if (tokens.length === 0) return null

  // Use prefix matching (:*) for the last token to support search-as-you-type
  return tokens
    .map((t, i) => (i === tokens.length - 1 ? `${t}:*` : t))
    .join(' & ')
}
