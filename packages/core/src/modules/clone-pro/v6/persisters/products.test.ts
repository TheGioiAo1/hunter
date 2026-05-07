import { describe, it, expect } from 'vitest'
import { productsPersister } from './products.js'

// ---------------------------------------------------------------------------
// Minimal DTO factory
// ---------------------------------------------------------------------------
function makeProductDto(overrides: Partial<Parameters<typeof productsPersister['persist']>[0]['dtos'][number]> = {}) {
  return {
    sourceHandle: 'widget',
    sourceUrl: 'https://x.com/products/widget',
    title: 'Widget',
    bodyHtml: '<p>desc</p>',
    vendor: 'Acme',
    productType: null,
    tags: ['eco', 'sale'],
    variants: [
      {
        sourceVariantId: 'v1',
        title: 'Default',
        price: '9.99',
        compareAtPrice: null,
        sku: 'sku-1',
        optionValues: {},
        available: true,
      },
    ],
    options: [],
    images: [{ sourceUrl: 'https://x.com/i.jpg', alt: null, position: 1 }],
    seo: { title: null, description: null },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ProductsPersister', () => {
  it('inserts new product with clone_snapshot + source=clone', async () => {
    const inserts: any[] = []

    const fakeDb = {
      transaction: () => ({
        setIsolationLevel: () => ({
          execute: async (fn: any) => fn(makeTrx(inserts, {})),
        }),
      }),
    }

    const r = await productsPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [makeProductDto()],
    })

    expect(r.inserted).toBe(1)
    expect(r.skippedEdited).toBe(0)
    expect(r.updated).toBe(0)
    expect(r.errors).toHaveLength(0)

    const productInsert = inserts.find((i) => i.table === 'products')
    expect(productInsert?.values).toMatchObject({
      slug: 'widget',
      source: 'clone',
      clone_snapshot: expect.any(String),
    })
    // Snapshot should be valid JSON with key fields
    const snap = JSON.parse(productInsert.values.clone_snapshot)
    expect(snap.title).toBe('Widget')
  })

  it('skips update when source=edited (re-clone preserves seller edit)', async () => {
    const inserts: any[] = []
    const existingProducts = [
      { id: 'p1', shop_id: 'shop-1', slug: 'widget', source: 'edited', title: 'Seller Edited' },
    ]

    const fakeDb = {
      transaction: () => ({
        setIsolationLevel: () => ({
          execute: async (fn: any) => fn(makeTrx(inserts, { products: existingProducts })),
        }),
      }),
    }

    const r = await productsPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [
        makeProductDto({
          title: 'Source Title',
          bodyHtml: '',
          vendor: null,
          tags: [],
          variants: [],
          options: [],
          images: [],
        }),
      ],
    })

    expect(r.skippedEdited).toBe(1)
    expect(r.updated).toBe(0)
    expect(r.inserted).toBe(0)
    // No product insert should have happened
    expect(inserts.filter((i) => i.table === 'products')).toHaveLength(0)
  })

  it('updates existing clone-source product without touching clone_snapshot', async () => {
    const inserts: any[] = []
    const updates: any[] = []
    const existingProducts = [
      { id: 'p1', shop_id: 'shop-1', slug: 'widget', source: 'clone', title: 'Old Title' },
    ]

    const fakeDb = {
      transaction: () => ({
        setIsolationLevel: () => ({
          execute: async (fn: any) => fn(makeTrx(inserts, { products: existingProducts }, updates)),
        }),
      }),
    }

    const r = await productsPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [makeProductDto({ title: 'New Title' })],
    })

    expect(r.updated).toBe(1)
    expect(r.inserted).toBe(0)
    expect(r.skippedEdited).toBe(0)
    const productUpdate = updates.find((u) => u.table === 'products')
    expect(productUpdate?.values.title).toBe('New Title')
    expect(productUpdate?.values.source).toBe('clone')
  })
})

// ---------------------------------------------------------------------------
// Fake transaction builder
// ---------------------------------------------------------------------------
function makeTrx(
  inserts: any[],
  existing: Record<string, any[]> = {},
  updates: any[] = [],
): any {
  return {
    selectFrom: (table: string) => ({
      where: () => ({
        where: () => ({
          select: () => ({
            executeTakeFirst: async () => existing[table]?.[0] ?? undefined,
            execute: async () => existing[table] ?? [],
          }),
        }),
      }),
    }),
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
    updateTable: (table: string) => ({
      set: (values: any) => ({
        where: () => ({
          where: () => ({
            execute: async () => {
              updates.push({ table, values })
            },
          }),
          execute: async () => {
            updates.push({ table, values })
          },
        }),
      }),
    }),
    deleteFrom: () => ({
      where: () => ({
        where: () => ({
          execute: async () => {},
        }),
        execute: async () => {},
      }),
    }),
  }
}
