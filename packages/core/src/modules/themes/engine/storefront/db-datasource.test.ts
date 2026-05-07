/**
 * Gbox Platform — DbDataSource tests
 *
 * Decision #1 Step 1.19. Verifies the database data source
 * implements the StorefrontDataSource interface correctly.
 * Uses a fake Kysely-shaped stub (no real DB needed).
 */

import { describe, expect, it } from 'vitest'
import { DbDataSource } from './db-datasource.js'

// ---------------------------------------------------------------------------
// Fake database stub — returns minimal rows for tested methods
// ---------------------------------------------------------------------------

const fakeShop = { id: 'shop-1', name: 'Test Shop', email: 'test@test.com', domain: 'test.gbox.test', currency: 'USD' }
const fakeProduct = { id: 'p1', slug: 'cap', title: 'Cap', body_html: '<p>A cap</p>', vendor: 'Vendor', status: 'active', shop_id: 'shop-1' }

/**
 * Strip `"col"` down to its tail segment after the last `.`. Used so
 * that Phase C4's join queries, which reference `cp.collection_id`
 * or `p.status`, filter the same fake rows as the un-aliased form.
 */
function tailCol(col: string): string {
  const i = col.lastIndexOf('.')
  return i >= 0 ? col.slice(i + 1) : col
}

/**
 * Extract the base table from a `"foo as x"` alias expression.
 */
function baseTable(expr: string): string {
  const m = expr.match(/^([a-z_]+)(?:\s+as\s+[a-z_]+)?$/i)
  return m ? m[1]! : expr
}

function createFakeDb() {
  const db: any = {
    fn: {
      countAll: () => ({ as: () => 'count' }),
    },
    selectFrom: (tableExpr: string) => {
      const table = baseTable(tableExpr)
      const buildChain = (rows: any[]) => {
        const chain: any = {
          selectAll: () => chain,
          select: () => chain,
          // innerJoin is a pass-through — the fake keeps the base
          // rows unchanged because the `where` filters that follow
          // already do the narrowing the join would have done.
          innerJoin: () => chain,
          leftJoin: () => chain,
          where: (col: string, op: string, val: any) => {
            const key = tailCol(col)
            const filtered = rows.filter((r) => {
              if (op === '=') return r[key] === val
              if (op === 'in') return val.includes(r[key])
              if (op === 'ilike') return String(r[key] ?? '').toLowerCase().includes(val.replace(/%/g, '').toLowerCase())
              if (op === '>') return r[key] > val
              return true
            })
            return buildChain(filtered)
          },
          orderBy: () => chain,
          limit: () => chain,
          offset: () => chain,
          execute: async () => rows,
          executeTakeFirst: async () => rows[0] ?? undefined,
          executeTakeFirstOrThrow: async () => {
            if (rows.length === 0) throw new Error('No rows')
            return rows[0]
          },
        }
        // Allow `where` to work with expression builder
        chain.where = (colOrFn: any, op?: string, val?: any) => {
          if (typeof colOrFn === 'function') {
            // Expression builder — just pass through
            return chain
          }
          const key = tailCol(colOrFn)
          const filtered = rows.filter((r) => {
            if (op === '=') return r[key] === val
            if (op === 'in') return val.includes(r[key])
            if (op === 'ilike') return String(r[key] ?? '').toLowerCase().includes(val.replace(/%/g, '').toLowerCase())
            if (op === '>') return r[key] > val
            return true
          })
          return buildChain(filtered)
        }
        return chain
      }

      if (table === 'shops') return buildChain([fakeShop])
      if (table === 'products') return buildChain([fakeProduct])
      if (table === 'product_variants') return buildChain([{ id: 'v1', product_id: 'p1', title: 'Default', price: 1500, position: 1 }])
      if (table === 'product_images') return buildChain([])
      // The schema column is `slug` (Shopify "handle" → our "slug").
      // Phase C4 — the fake collection now ships the same columns the
      // real schema added (published, sort_order, seo_*, published_at)
      // so the storefront queries filter + project correctly.
      if (table === 'collections')
        return buildChain([
          {
            id: 'c1',
            slug: 'frontpage',
            title: 'Frontpage',
            shop_id: 'shop-1',
            published: true,
            sort_order: 'manual',
            seo_title: 'Front Page SEO',
            seo_description: 'Best products',
            published_at: '2026-04-01T00:00:00Z',
            body_html: null,
          },
        ])
      if (table === 'collection_products')
        return buildChain([
          // Fake row carries product.status so the innerJoin + status
          // filter path resolves with the single product row above.
          { collection_id: 'c1', product_id: 'p1', position: 1, status: 'active' },
        ])
      if (table === 'sessions') return buildChain([])
      if (table === 'users') return buildChain([])
      return buildChain([])
    },
  }
  return db
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const ctx = { shopId: 'shop-1', locale: 'en' }

describe('DbDataSource', () => {
  const db = createFakeDb()
  const ds = new DbDataSource(db, 'shop-1')

  it('returns the default shop id', () => {
    expect(ds.defaultShopId()).toBe('shop-1')
  })

  it('loads the shop drop', async () => {
    const shop = await ds.loadShop(ctx)
    expect(shop.id).toBe('shop-1')
    expect(shop.name).toBe('Test Shop')
    expect(shop.currency).toBe('USD')
  })

  it('returns null customer when no session', async () => {
    const customer = await ds.loadCustomerBySession(undefined, ctx)
    expect(customer).toBeNull()
  })

  it('returns empty cart', async () => {
    const cart = await ds.loadCart(undefined, ctx)
    expect(cart.item_count).toBe(0)
    expect(cart.items).toEqual([])
  })

  it('loads a product by handle', async () => {
    const product = await ds.loadProductByHandle('cap', ctx)
    expect(product).not.toBeNull()
    expect(product!.title).toBe('Cap')
    expect(product!.handle).toBe('cap')
    expect(product!.url).toBe('/products/cap')
  })

  it('returns null for missing product', async () => {
    const product = await ds.loadProductByHandle('nonexistent', ctx)
    expect(product).toBeNull()
  })

  it('loads a collection by handle', async () => {
    const collection = await ds.loadCollectionByHandle('frontpage', ctx)
    expect(collection).not.toBeNull()
    expect(collection!.title).toBe('Frontpage')
    expect(collection!.url).toBe('/collections/frontpage')
  })

  it('returns null for missing collection', async () => {
    const collection = await ds.loadCollectionByHandle('nonexistent', ctx)
    expect(collection).toBeNull()
  })

  // -------------------------------------------------------------------
  // Phase C4 — collection drop surfaces merchant-facing SEO fields
  // -------------------------------------------------------------------
  it('exposes sort_order / seo_* / published_at on the collection drop', async () => {
    const collection = await ds.loadCollectionByHandle('frontpage', ctx)
    expect(collection).not.toBeNull()
    expect(collection!.sort_order).toBe('manual')
    expect(collection!.seo_title).toBe('Front Page SEO')
    expect(collection!.seo_description).toBe('Best products')
    expect(collection!.published_at).toBe('2026-04-01T00:00:00Z')
  })

  it('lists collections', async () => {
    const collections = await ds.listCollections(ctx)
    expect(collections.length).toBeGreaterThan(0)
    expect(collections[0]!.handle).toBe('frontpage')
    // Phase C4 — the same SEO + sort fields show up on the index list
    expect(collections[0]!.sort_order).toBe('manual')
    expect(collections[0]!.seo_title).toBe('Front Page SEO')
    expect(collections[0]!.published_at).toBe('2026-04-01T00:00:00Z')
  })

  it('returns empty search when no terms', async () => {
    const result = await ds.runSearch('', { page: 1, pageSize: 10 }, ctx)
    expect(result.performed).toBe(false)
    expect(result.results).toEqual([])
  })

  it('runs a search with terms', async () => {
    const result = await ds.runSearch('Cap', { page: 1, pageSize: 10 }, ctx)
    expect(result.performed).toBe(true)
    expect(result.terms).toBe('Cap')
  })

  it('returns null for policies (not yet implemented)', async () => {
    const policy = await ds.loadPolicyByHandle('privacy', ctx)
    expect(policy).toBeNull()
  })

  it('returns null for gift cards (not yet implemented)', async () => {
    const gc = await ds.loadGiftCardById('gc1', ctx)
    expect(gc).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Phase C4 — published filter + sort_order behaviour
//
// These tests use a richer fake DB that records the `orderBy` column
// for each query, so we can assert the sort mode reaches Kysely.
// ---------------------------------------------------------------------------

function createCollectionFakeDb(opts: {
  collection: any
  cpRows?: any[]
  products?: any[]
  onOrderBy?: (col: string, direction: string) => void
}) {
  const collection = opts.collection
  const cpRows = opts.cpRows ?? []
  const products = opts.products ?? []

  const db: any = {
    // Mark `countAll` outputs with a sentinel so `select()` can route
    // count queries through a `{count: N}` path without us having to
    // sniff the Kysely internals.
    fn: {
      countAll: () => ({ as: () => ({ __isCountRef: true }) }),
    },
    selectFrom: (tableExpr: string) => {
      const base = tableExpr.match(/^([a-z_]+)/i)?.[1] ?? tableExpr
      const build = (rows: any[], isCount = false) => {
        const chain: any = {
          selectAll: () => chain,
          select: (arg?: any) => {
            if (arg && typeof arg === 'object' && arg.__isCountRef) {
              return build(rows, true)
            }
            return chain
          },
          innerJoin: () => chain,
          leftJoin: () => chain,
          orderBy: (col: string, direction: string) => {
            opts.onOrderBy?.(col, direction)
            return chain
          },
          limit: () => chain,
          offset: () => chain,
          execute: async () => rows,
          executeTakeFirst: async () => {
            if (isCount) return { count: rows.length }
            return rows[0] ?? undefined
          },
          executeTakeFirstOrThrow: async () => {
            if (rows.length === 0) throw new Error('empty')
            return rows[0]
          },
        }
        chain.where = (colOrFn: any, op?: any, val?: any) => {
          if (typeof colOrFn === 'function') return build(rows, isCount)
          const tail = String(colOrFn).split('.').pop()!
          const filtered = rows.filter((r) => {
            if (op === '=') return r[tail] === val
            if (op === 'in') return val.includes(r[tail])
            return true
          })
          return build(filtered, isCount)
        }
        return chain
      }

      if (base === 'collections') {
        return build(collection ? [collection] : [])
      }
      if (base === 'collection_products') return build(cpRows)
      if (base === 'products') return build(products)
      if (base === 'product_variants') return build([])
      if (base === 'product_images') return build([])
      return build([])
    },
  }
  return db
}

describe('DbDataSource.loadCollectionByHandle — Phase C4', () => {
  const ctx = { shopId: 'shop-1', locale: 'en' }

  it('returns null for a draft (unpublished) collection', async () => {
    const db = createCollectionFakeDb({
      collection: {
        id: 'c1',
        slug: 'draft',
        title: 'Draft',
        shop_id: 'shop-1',
        published: false, // <-- storefront should not see this
      },
      cpRows: [],
      products: [],
    })
    const ds = new DbDataSource(db, 'shop-1')
    const result = await ds.loadCollectionByHandle('draft', ctx)
    expect(result).toBeNull()
  })

  it('returns the collection when published=true', async () => {
    const db = createCollectionFakeDb({
      collection: {
        id: 'c1',
        slug: 'live',
        title: 'Live',
        shop_id: 'shop-1',
        published: true,
        sort_order: 'alpha-asc',
        seo_title: 'Live SEO',
        seo_description: 'Shop live',
        published_at: '2026-04-10T00:00:00Z',
        body_html: '<p>live</p>',
      },
    })
    const ds = new DbDataSource(db, 'shop-1')
    const result = await ds.loadCollectionByHandle('live', ctx)
    expect(result).not.toBeNull()
    expect(result!.sort_order).toBe('alpha-asc')
    expect(result!.seo_title).toBe('Live SEO')
    expect(result!.seo_description).toBe('Shop live')
    expect(result!.published_at).toBe('2026-04-10T00:00:00Z')
    expect(result!.description).toBe('<p>live</p>')
  })
})

describe('DbDataSource.listCollections — Phase C4', () => {
  const ctx = { shopId: 'shop-1', locale: 'en' }

  it('excludes unpublished collections from the index', async () => {
    // Fake returns both rows because our stub doesn't fully model the
    // chained `where`s — but the Kysely query path applies both the
    // shop_id + published filters, and the fake's `where` will drop
    // the unpublished row since it lacks `published=true`.
    const db = createCollectionFakeDb({
      collection: null,
    })
    // Override selectFrom to return two rows for `collections`
    db.selectFrom = ((orig) => (tableExpr: string) => {
      if (tableExpr === 'collections') {
        let rows = [
          { id: 'c1', slug: 'live', title: 'Live', shop_id: 'shop-1', published: true },
          { id: 'c2', slug: 'draft', title: 'Draft', shop_id: 'shop-1', published: false },
        ]
        const chain: any = {
          selectAll: () => chain,
          select: () => chain,
          innerJoin: () => chain,
          orderBy: () => chain,
          limit: () => chain,
          offset: () => chain,
          execute: async () => rows,
          executeTakeFirst: async () => rows[0] ?? undefined,
        }
        chain.where = (col: any, op: any, val: any) => {
          if (typeof col === 'function') return chain
          rows = rows.filter((r: any) => r[col] === val)
          chain.execute = async () => rows
          chain.executeTakeFirst = async () => rows[0] ?? undefined
          return chain
        }
        return chain
      }
      return orig(tableExpr)
    })(db.selectFrom)

    const ds = new DbDataSource(db, 'shop-1')
    const list = await ds.listCollections(ctx)
    expect(list).toHaveLength(1)
    expect(list[0]!.handle).toBe('live')
  })
})

describe('DbDataSource.loadCollectionProducts — sort_order', () => {
  const ctx = { shopId: 'shop-1', locale: 'en' }

  function makeSortCapture(sortOrder: string | null) {
    const orderByCalls: Array<{ col: string; direction: string }> = []
    const db = createCollectionFakeDb({
      collection: {
        id: 'c1',
        slug: 'any',
        title: 'Any',
        shop_id: 'shop-1',
        published: true,
        sort_order: sortOrder,
      },
      cpRows: [{ collection_id: 'c1', product_id: 'p1', position: 1, status: 'active' }],
      products: [
        { id: 'p1', slug: 'cap', title: 'Cap', status: 'active', shop_id: 'shop-1', body_html: '' },
      ],
      onOrderBy: (col, direction) => orderByCalls.push({ col, direction }),
    })
    return { db, orderByCalls }
  }

  it('manual sort falls through to cp.position ASC', async () => {
    const { db, orderByCalls } = makeSortCapture('manual')
    const ds = new DbDataSource(db, 'shop-1')
    await ds.loadCollectionProducts('c1', { page: 1, pageSize: 10 }, ctx)
    expect(
      orderByCalls.some((c) => c.col === 'cp.position' && c.direction === 'asc'),
    ).toBe(true)
  })

  it('alpha-desc sorts on products.title DESC', async () => {
    const { db, orderByCalls } = makeSortCapture('alpha-desc')
    const ds = new DbDataSource(db, 'shop-1')
    await ds.loadCollectionProducts('c1', { page: 1, pageSize: 10 }, ctx)
    expect(
      orderByCalls.some((c) => c.col === 'p.title' && c.direction === 'desc'),
    ).toBe(true)
  })

  it('created-desc sorts on products.created_at DESC', async () => {
    const { db, orderByCalls } = makeSortCapture('created-desc')
    const ds = new DbDataSource(db, 'shop-1')
    await ds.loadCollectionProducts('c1', { page: 1, pageSize: 10 }, ctx)
    expect(
      orderByCalls.some((c) => c.col === 'p.created_at' && c.direction === 'desc'),
    ).toBe(true)
  })

  it('price-asc sorts on a min_price alias ASC', async () => {
    const { db, orderByCalls } = makeSortCapture('price-asc')
    const ds = new DbDataSource(db, 'shop-1')
    await ds.loadCollectionProducts('c1', { page: 1, pageSize: 10 }, ctx)
    expect(
      orderByCalls.some((c) => c.col === 'min_price' && c.direction === 'asc'),
    ).toBe(true)
  })

  it('best-selling ranks by SUM(order_line_items.quantity) DESC with cp.position tiebreak (Phase C3a)', async () => {
    // Phase C3a — best-selling now uses a real sales aggregation.
    // The ranker orders by `sold DESC` (primary) and `cp.position ASC`
    // (deterministic tiebreak for products with no sales or equal
    // sales in the rolling window).
    const { db, orderByCalls } = makeSortCapture('best-selling')
    const ds = new DbDataSource(db, 'shop-1')
    await ds.loadCollectionProducts('c1', { page: 1, pageSize: 10 }, ctx)
    expect(
      orderByCalls.some((c) => c.col === 'sold' && c.direction === 'desc'),
    ).toBe(true)
    expect(
      orderByCalls.some((c) => c.col === 'cp.position' && c.direction === 'asc'),
    ).toBe(true)
  })

  it('unknown sort_order degrades to manual', async () => {
    const { db, orderByCalls } = makeSortCapture('garbage-from-csv-import')
    const ds = new DbDataSource(db, 'shop-1')
    await ds.loadCollectionProducts('c1', { page: 1, pageSize: 10 }, ctx)
    expect(
      orderByCalls.some((c) => c.col === 'cp.position' && c.direction === 'asc'),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Customer session lookup (Stage 3C.3)
// ---------------------------------------------------------------------------

describe('DbDataSource.loadCustomerBySession', () => {
  function mkCustomerDb(customerRow: any): any {
    const db: any = {
      fn: { countAll: () => ({ as: () => 'count' }), max: () => ({ as: () => 'last_order_at' }) },
      selectFrom: (table: string) => {
        const build = (rows: any[]) => {
          const chain: any = {
            selectAll: () => chain,
            select: () => chain,
            orderBy: () => chain,
            limit: () => chain,
            offset: () => chain,
            execute: async () => rows,
            executeTakeFirst: async () => rows[0] ?? undefined,
          }
          chain.where = (_col: any, _op?: any, _val?: any) => build(rows)
          return chain
        }
        if (table === 'customers') return build(customerRow ? [customerRow] : [])
        if (table === 'customer_addresses') return build([])
        if (table === 'orders') return build([{ count: 0, last_order_at: null }])
        return build([])
      },
    }
    return db
  }

  it('returns null when no session token is supplied', async () => {
    const ds = new DbDataSource(mkCustomerDb(null), 'shop-1')
    const result = await ds.loadCustomerBySession(undefined, {
      shopId: 'shop-1',
      locale: 'en',
    })
    expect(result).toBeNull()
  })

  it('returns null when the session lookup finds nothing', async () => {
    const ds = new DbDataSource(mkCustomerDb(null), 'shop-1', {
      resolveCustomerSession: async () => null,
    })
    const result = await ds.loadCustomerBySession('stale', {
      shopId: 'shop-1',
      locale: 'en',
    })
    expect(result).toBeNull()
  })

  it('rejects a session whose shop_id differs from ctx.shopId', async () => {
    const ds = new DbDataSource(mkCustomerDb(null), 'shop-1', {
      resolveCustomerSession: async () => ({
        customer_id: 'cus_alice',
        shop_id: 'shop-OTHER',
        expires_at: new Date(Date.now() + 60_000),
      }),
    })
    const result = await ds.loadCustomerBySession('good', {
      shopId: 'shop-1',
      locale: 'en',
    })
    expect(result).toBeNull()
  })

  it('hydrates the profile on a valid session', async () => {
    const customerRow = {
      id: 'cus_alice',
      shop_id: 'shop-1',
      email: 'alice@example.com',
      first_name: 'Alice',
      last_name: 'Example',
      orders_count: 3,
      total_spent: '99.50',
    }
    const ds = new DbDataSource(mkCustomerDb(customerRow), 'shop-1', {
      resolveCustomerSession: async () => ({
        customer_id: 'cus_alice',
        shop_id: 'shop-1',
        expires_at: new Date(Date.now() + 60_000),
      }),
    })
    const result = await ds.loadCustomerBySession('good', {
      shopId: 'shop-1',
      locale: 'en',
    })
    expect(result).not.toBeNull()
    expect(result!.id).toBe('cus_alice')
    expect(result!.email).toBe('alice@example.com')
    expect(result!.first_name).toBe('Alice')
    expect((result as any).orders_count).toBe(3)
    expect((result as any).total_spent).toBe('99.50')
  })

  it('swallows lookup errors and returns null', async () => {
    const ds = new DbDataSource(mkCustomerDb(null), 'shop-1', {
      resolveCustomerSession: async () => {
        throw new Error('db down')
      },
    })
    const result = await ds.loadCustomerBySession('good', {
      shopId: 'shop-1',
      locale: 'en',
    })
    expect(result).toBeNull()
  })
})
