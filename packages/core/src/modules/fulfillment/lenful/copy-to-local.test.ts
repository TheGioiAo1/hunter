/**
 * Unit tests for `copyCatalogEntryToLocalProduct`.
 *
 * These tests mock the Kysely db with a chainable Proxy (same pattern
 * used in products/service.test.ts). We verify:
 *
 *   1. Happy path — products + variants + images + lenful_product_map
 *      rows all get written, with correct shapes.
 *   2. No-variants edge case — a single default variant is created.
 *   3. Missing thumbnail / empty gallery — no image rows written.
 *   4. Idempotent re-import — two calls with the same entry generate
 *      different slugs (because of the random suffix).
 *   5. Duplicate-key from Postgres surfaces as `errorCode=duplicate_slug`.
 *   6. Validation — missing shopId or missing entry returns typed errors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { copyCatalogEntryToLocalProduct } from './copy-to-local.ts'
import type { NormalizedCatalogEntry } from './catalog-sync.ts'

// ───────────────────────────────────────────────────────────────
// Chainable Proxy mock for Kysely query builder
// ───────────────────────────────────────────────────────────────

function chainable(result: any = undefined): any {
  const obj: any = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return undefined
        if (prop === 'execute') {
          return vi
            .fn()
            .mockResolvedValue(
              Array.isArray(result) ? result : [result].filter(Boolean),
            )
        }
        if (prop === 'executeTakeFirst') {
          return vi.fn().mockResolvedValue(result ?? null)
        }
        if (prop === 'executeTakeFirstOrThrow') {
          return vi.fn().mockImplementation(async () => {
            if (result == null) throw new Error('no result')
            return result
          })
        }
        return vi.fn().mockReturnValue(obj)
      },
    },
  )
  return obj
}

interface MockCalls {
  inserts: Array<{ table: string; values: any }>
  error?: Error
}

function createMockDb(
  fixtures: {
    productRow?: any
    variantRows?: any[]
    throwOnInsert?: Error
  } = {},
): { db: any; calls: MockCalls } {
  const calls: MockCalls = { inserts: [] }

  const makeTrx = () => {
    const trx: any = {
      insertInto: vi.fn().mockImplementation((table: string) => {
        return new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === 'then') return undefined
              if (prop === 'values') {
                return vi.fn().mockImplementation((values: any) => {
                  calls.inserts.push({ table, values })
                  if (fixtures.throwOnInsert) {
                    return {
                      returningAll: () => ({
                        executeTakeFirstOrThrow: vi
                          .fn()
                          .mockRejectedValue(fixtures.throwOnInsert),
                        execute: vi
                          .fn()
                          .mockRejectedValue(fixtures.throwOnInsert),
                      }),
                      execute: vi
                        .fn()
                        .mockRejectedValue(fixtures.throwOnInsert),
                    }
                  }
                  // Return-based on table
                  if (table === 'products') {
                    return {
                      returningAll: () => ({
                        executeTakeFirstOrThrow: vi
                          .fn()
                          .mockResolvedValue(
                            fixtures.productRow ?? {
                              id: 'prod-mock-id',
                              slug: values.slug,
                              title: values.title,
                            },
                          ),
                      }),
                    }
                  }
                  if (table === 'product_variants') {
                    const rows = fixtures.variantRows ??
                      (Array.isArray(values) ? values : [values]).map(
                        (v: any, i: number) => ({
                          id: `var-${i}`,
                          ...v,
                        }),
                      )
                    return {
                      returningAll: () => ({
                        execute: vi.fn().mockResolvedValue(rows),
                      }),
                    }
                  }
                  // product_images, lenful_product_map → just resolve
                  return {
                    execute: vi.fn().mockResolvedValue([]),
                  }
                })
              }
              return vi.fn()
            },
          },
        )
      }),
    }
    return trx
  }

  const db: any = {
    transaction: vi.fn().mockReturnValue({
      execute: vi.fn().mockImplementation(async (fn: Function) => {
        return fn(makeTrx())
      }),
    }),
  }
  return { db, calls }
}

// ───────────────────────────────────────────────────────────────
// Fixture — a "typical" normalized Lenful catalog entry
// ───────────────────────────────────────────────────────────────

function makeEntry(
  overrides: Partial<NormalizedCatalogEntry> = {},
): NormalizedCatalogEntry {
  return {
    lenful_product_id: 'lenful-abc-123',
    lenful_product_sku: 'TSHIRT-CLASSIC',
    title: 'Classic T-Shirt',
    description: 'A soft cotton tee with a relaxed fit.',
    category_slug: 'apparel-tshirt',
    category_name: 'T-Shirts',
    thumbnail_url: 'https://cdn.lenful.test/thumb.jpg',
    gallery_urls: [
      'https://cdn.lenful.test/gallery-1.jpg',
      'https://cdn.lenful.test/gallery-2.jpg',
    ],
    base_price: 19.99,
    currency: 'USD',
    variants: [
      {
        id: 'v1',
        sku: 'TS-S-BLACK',
        title: 'Small / Black',
        options: [
          { name: 'Size', value: 'S' },
          { name: 'Color', value: 'Black' },
        ],
        price: 19.99,
        thumbnail: null,
        raw: null,
      },
      {
        id: 'v2',
        sku: 'TS-M-BLACK',
        title: 'Medium / Black',
        options: [
          { name: 'Size', value: 'M' },
          { name: 'Color', value: 'Black' },
        ],
        price: 21.99,
        thumbnail: null,
        raw: null,
      },
    ],
    options: [
      { name: 'Size', values: ['S', 'M'] },
      { name: 'Color', values: ['Black'] },
    ],
    raw: null,
    ...overrides,
  }
}

// ───────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────

describe('copyCatalogEntryToLocalProduct', () => {
  const shopId = 'shop-001'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes products + variants + images + map on happy path', async () => {
    const { db, calls } = createMockDb({
      productRow: { id: 'prod-happy', slug: 'slug-ignored', title: 't' },
      variantRows: [
        { id: 'var-1', sku: 'LNF-TSHIRT-CLASSIC-XXX-TS-S-BLACK' },
        { id: 'var-2', sku: 'LNF-TSHIRT-CLASSIC-XXX-TS-M-BLACK' },
      ],
    })

    const entry = makeEntry()
    const result = await copyCatalogEntryToLocalProduct(db, {
      shopId,
      entry,
      userId: 'user-42',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.productId).toBe('prod-happy')
    expect(result.variantCount).toBe(2)
    expect(result.imageCount).toBe(3) // thumbnail + 2 gallery

    // Verify inserts
    const tables = calls.inserts.map((c) => c.table)
    expect(tables).toContain('products')
    expect(tables).toContain('product_variants')
    expect(tables).toContain('product_images')
    expect(tables).toContain('lenful_product_map')

    // Product insert shape
    const productInsert = calls.inserts.find((c) => c.table === 'products')!
    expect(productInsert.values.shop_id).toBe(shopId)
    expect(productInsert.values.title).toBe('Classic T-Shirt')
    expect(productInsert.values.status).toBe('draft')
    expect(productInsert.values.published_at).toBeNull()
    expect(productInsert.values.vendor).toBe('Lenful POD')
    expect(productInsert.values.tags).toContain('lenful')
    expect(productInsert.values.tags).toContain('pod')
    expect(productInsert.values.tags).toContain('apparel-tshirt')
    expect(productInsert.values.slug).toMatch(/^classic-t-shirt-/)
    expect(productInsert.values.product_type).toBe('T-Shirts')

    // Variant inserts
    const variantInsert = calls.inserts.find(
      (c) => c.table === 'product_variants',
    )!
    const variants = variantInsert.values as any[]
    expect(Array.isArray(variants)).toBe(true)
    expect(variants).toHaveLength(2)
    expect(variants[0].option1).toBe('S')
    expect(variants[0].option2).toBe('Black')
    expect(variants[0].price).toBe('19.99')
    expect(variants[1].option1).toBe('M')
    expect(variants[1].price).toBe('21.99')
    // Every variant's SKU should be uniquely prefixed
    expect(variants[0].sku).toMatch(/^LNF-TSHIRT-CLASSIC-/)
    expect(variants[1].sku).toMatch(/^LNF-TSHIRT-CLASSIC-/)

    // Image inserts (thumbnail first)
    const imageInsert = calls.inserts.find(
      (c) => c.table === 'product_images',
    )!
    const images = imageInsert.values as any[]
    expect(images).toHaveLength(3)
    expect(images[0].src).toBe('https://cdn.lenful.test/thumb.jpg')
    expect(images[0].position).toBe(1)
    expect(images[1].position).toBe(2)
    expect(images[2].position).toBe(3)

    // Map inserts — one per variant
    const mapInsert = calls.inserts.find(
      (c) => c.table === 'lenful_product_map',
    )!
    const mapRows = mapInsert.values as any[]
    expect(mapRows).toHaveLength(2)
    expect(mapRows[0].gbox_product_id).toBe('prod-happy')
    expect(mapRows[0].lenful_product_id).toBe('lenful-abc-123')
    expect(mapRows[0].gbox_variant_id).toBe('var-1')
    expect(mapRows[0].mapped_by).toBe('user-42')
  })

  it('creates a single default variant when entry has none', async () => {
    const { db, calls } = createMockDb({
      productRow: { id: 'prod-default', slug: 's', title: 't' },
      variantRows: [{ id: 'var-default', sku: 'LNF-X-DEFAULT' }],
    })
    const entry = makeEntry({
      variants: [],
      options: [],
    })
    const result = await copyCatalogEntryToLocalProduct(db, { shopId, entry })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.variantCount).toBe(1)

    const variantInsert = calls.inserts.find(
      (c) => c.table === 'product_variants',
    )!
    const variants = variantInsert.values as any[]
    expect(variants).toHaveLength(1)
    expect(variants[0].title).toBe('Default')
    expect(variants[0].option1).toBe('Default')
    expect(variants[0].option2).toBeNull()
    expect(variants[0].option3).toBeNull()
    expect(variants[0].sku).toMatch(/-DEFAULT$/)

    // Map row falls back to a product-level (variant=null) row
    const mapInsert = calls.inserts.find(
      (c) => c.table === 'lenful_product_map',
    )!
    const mapRows = mapInsert.values as any[]
    expect(mapRows).toHaveLength(1)
    expect(mapRows[0].gbox_variant_id).toBeNull()
  })

  it('writes no image rows when thumbnail + gallery are empty', async () => {
    const { db, calls } = createMockDb({
      productRow: { id: 'prod-no-imgs', slug: 's', title: 't' },
    })
    const entry = makeEntry({
      thumbnail_url: null,
      gallery_urls: [],
    })
    const result = await copyCatalogEntryToLocalProduct(db, { shopId, entry })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.imageCount).toBe(0)

    const imageInsert = calls.inserts.find(
      (c) => c.table === 'product_images',
    )
    expect(imageInsert).toBeUndefined()
  })

  it('dedupes repeated image URLs', async () => {
    const { db, calls } = createMockDb({
      productRow: { id: 'prod-dedup', slug: 's', title: 't' },
    })
    const entry = makeEntry({
      thumbnail_url: 'https://cdn.test/a.jpg',
      gallery_urls: [
        'https://cdn.test/a.jpg',
        'https://cdn.test/b.jpg',
        'https://cdn.test/b.jpg',
      ],
    })
    const result = await copyCatalogEntryToLocalProduct(db, { shopId, entry })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.imageCount).toBe(2)

    const imageInsert = calls.inserts.find(
      (c) => c.table === 'product_images',
    )!
    const images = imageInsert.values as any[]
    expect(images).toHaveLength(2)
  })

  it('generates distinct slugs for repeated imports of the same entry', async () => {
    const slugs: string[] = []
    for (let i = 0; i < 4; i++) {
      const { db, calls } = createMockDb({
        productRow: { id: `prod-${i}`, slug: `s${i}`, title: 't' },
      })
      const result = await copyCatalogEntryToLocalProduct(db, {
        shopId,
        entry: makeEntry(),
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const productInsert = calls.inserts.find(
        (c) => c.table === 'products',
      )!
      slugs.push(productInsert.values.slug)
    }
    // Slugs all start with the title but end in a unique suffix
    const prefix = 'classic-t-shirt-'
    for (const s of slugs) expect(s).toMatch(new RegExp(`^${prefix}`))
    // All slugs are distinct — the random suffix guarantees it with
    // overwhelming probability (2B space, 4 draws → collision ~0%)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('maps duplicate-key errors to errorCode=duplicate_slug', async () => {
    const { db } = createMockDb({
      throwOnInsert: new Error(
        'duplicate key value violates unique constraint "idx_products_shop_slug"',
      ),
    })
    const result = await copyCatalogEntryToLocalProduct(db, {
      shopId,
      entry: makeEntry(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('duplicate_slug')
  })

  it('maps generic DB errors to errorCode=insert_failed', async () => {
    const { db } = createMockDb({
      throwOnInsert: new Error('connection refused'),
    })
    const result = await copyCatalogEntryToLocalProduct(db, {
      shopId,
      entry: makeEntry(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('insert_failed')
    expect(result.errorMessage).toContain('connection refused')
  })

  it('returns missing_shop when shopId is empty', async () => {
    const { db } = createMockDb()
    const result = await copyCatalogEntryToLocalProduct(db, {
      shopId: '',
      entry: makeEntry(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('missing_shop')
  })

  it('returns missing_entry when entry is falsy', async () => {
    const { db } = createMockDb()
    const result = await copyCatalogEntryToLocalProduct(db, {
      shopId,
      entry: null as any,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('missing_entry')
  })

  it('falls back to Lenful SKU when title is missing', async () => {
    const { db, calls } = createMockDb({
      productRow: { id: 'prod-notitle', slug: 's', title: 't' },
    })
    const entry = makeEntry({ title: null })
    const result = await copyCatalogEntryToLocalProduct(db, { shopId, entry })
    expect(result.ok).toBe(true)
    const productInsert = calls.inserts.find((c) => c.table === 'products')!
    expect(productInsert.values.title).toBe('TSHIRT-CLASSIC')
    // Slug derived from the SKU (lower-cased, slugified)
    expect(productInsert.values.slug).toMatch(/^tshirt-classic-/)
  })
})
