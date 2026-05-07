import { describe, it, expect } from 'vitest'
import { collectionsPersister } from './collections.js'

// ---------------------------------------------------------------------------
// Minimal DTO factory
// ---------------------------------------------------------------------------
function makeCollectionDto(
  overrides: Partial<{
    sourceHandle: string
    sourceUrl: string
    title: string
    bodyHtml: string
    productHandles: string[]
    seo: { title: string | null; description: string | null }
  }> = {},
) {
  return {
    sourceHandle: 'summer-sale',
    sourceUrl: 'https://x.com/collections/summer-sale',
    title: 'Summer Sale',
    bodyHtml: '<p>All summer items</p>',
    productHandles: ['widget', 'gadget'],
    seo: { title: null, description: null },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('CollectionsPersister', () => {
  it('inserts collection + resolves productHandles to FK pivot rows', async () => {
    const inserts: any[] = []

    // Pre-populate products so pivot resolution finds them
    const existingProducts = [
      { id: 'prod-widget', slug: 'widget', shop_id: 'shop-1' },
      { id: 'prod-gadget', slug: 'gadget', shop_id: 'shop-1' },
    ]

    const fakeDb = {
      transaction: () => ({
        setIsolationLevel: () => ({
          execute: async (fn: any) =>
            fn(makeTrx(inserts, { products: existingProducts, collections: [] })),
        }),
      }),
    }

    const r = await collectionsPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [makeCollectionDto()],
    })

    expect(r.inserted).toBe(1)
    expect(r.skippedEdited).toBe(0)
    expect(r.errors).toHaveLength(0)

    // Collection row inserted with source=clone + clone_snapshot
    const collectionInsert = inserts.find((i) => i.table === 'collections')
    expect(collectionInsert?.values).toMatchObject({
      slug: 'summer-sale',
      source: 'clone',
      clone_snapshot: expect.any(String),
    })
    const snap = JSON.parse(collectionInsert.values.clone_snapshot)
    expect(snap.title).toBe('Summer Sale')

    // Two pivot inserts (one per resolved product handle)
    const pivotInserts = inserts.filter((i) => i.table === 'collection_products')
    expect(pivotInserts).toHaveLength(2)
    const productIds = pivotInserts.map((i) => i.values.product_id)
    expect(productIds).toContain('prod-widget')
    expect(productIds).toContain('prod-gadget')
  })

  it('preserves edited collections on re-clone (skippedEdited increments)', async () => {
    const inserts: any[] = []
    const existingCollections = [
      {
        id: 'coll-1',
        shop_id: 'shop-1',
        slug: 'summer-sale',
        source: 'edited',
        title: 'Seller-Edited Collection',
      },
    ]

    const fakeDb = {
      transaction: () => ({
        setIsolationLevel: () => ({
          execute: async (fn: any) =>
            fn(makeTrx(inserts, { collections: existingCollections, products: [] })),
        }),
      }),
    }

    const r = await collectionsPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [makeCollectionDto({ title: 'Re-cloned Title' })],
    })

    expect(r.skippedEdited).toBe(1)
    expect(r.updated).toBe(0)
    expect(r.inserted).toBe(0)
    // No collection insert should have happened
    expect(inserts.filter((i) => i.table === 'collections')).toHaveLength(0)
  })

  it('skips unresolvable handles in pivot without error', async () => {
    const inserts: any[] = []
    // Only 'widget' exists; 'missing-product' does not
    const existingProducts = [{ id: 'prod-widget', slug: 'widget', shop_id: 'shop-1' }]

    const fakeDb = {
      transaction: () => ({
        setIsolationLevel: () => ({
          execute: async (fn: any) =>
            fn(makeTrx(inserts, { products: existingProducts, collections: [] })),
        }),
      }),
    }

    const r = await collectionsPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [makeCollectionDto({ productHandles: ['widget', 'missing-product'] })],
    })

    expect(r.inserted).toBe(1)
    expect(r.errors).toHaveLength(0)
    const pivotInserts = inserts.filter((i) => i.table === 'collection_products')
    // Only 1 resolved: 'widget'
    expect(pivotInserts).toHaveLength(1)
    expect(pivotInserts[0].values.product_id).toBe('prod-widget')
  })
})

// ---------------------------------------------------------------------------
// Fake transaction builder
// ---------------------------------------------------------------------------
function makeTrx(inserts: any[], existing: Record<string, any[]> = {}): any {
  // Track all deletes
  const deletes: any[] = []

  return {
    selectFrom: (table: string) => {
      // We need to handle both single-row (executeTakeFirst) and
      // multi-row (execute) lookups. The selectFrom chain returns
      // objects from the pre-populated `existing` map, filtered
      // loosely (we don't re-evaluate WHERE predicates in the fake —
      // we trust that the persister only ever queries one table at a time
      // per logical unit and the test populates the right shape).
      const rows = existing[table] ?? []
      return {
        where: () => ({
          where: () => ({
            select: () => ({
              executeTakeFirst: async () => rows[0] ?? undefined,
              execute: async () => rows,
            }),
            executeTakeFirst: async () => rows[0] ?? undefined,
            execute: async () => rows,
          }),
          select: (cols: any) => ({
            executeTakeFirst: async () => rows[0] ?? undefined,
            execute: async () => rows,
          }),
          executeTakeFirst: async () => rows[0] ?? undefined,
          execute: async () => rows,
        }),
        select: () => ({
          where: () => ({
            where: () => ({
              executeTakeFirst: async () => rows[0] ?? undefined,
              execute: async () => rows,
            }),
          }),
          execute: async () => rows,
        }),
      }
    },
    insertInto: (table: string) => ({
      values: (values: any) => ({
        returningAll: () => ({
          execute: async () => {
            inserts.push({ table, values })
            return Array.isArray(values)
              ? values.map((v: any, i: number) => ({ ...v, id: `${table}-${i}` }))
              : [{ ...values, id: `${table}-0` }]
          },
        }),
        execute: async () => {
          inserts.push({ table, values })
        },
      }),
    }),
    updateTable: () => ({
      set: () => ({
        where: () => ({
          execute: async () => {},
        }),
      }),
    }),
    deleteFrom: (table: string) => ({
      where: () => ({
        execute: async () => {
          deletes.push({ table })
        },
      }),
    }),
  }
}
