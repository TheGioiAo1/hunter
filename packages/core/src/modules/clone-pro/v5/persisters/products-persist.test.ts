import { describe, it, expect } from 'vitest'
import { persistProducts } from './products-persist.js'
import type { ScrapedProduct } from '../types.js'

// Shared fake-tx builder that records every write + maps tables to
// fake RETURNING ids. Kysely's real insert chain has several shapes —
// we replicate the ones persisters actually use:
//   `.insertInto(t).values(v).onConflict(cb).returning('id').executeTakeFirst()`
//   `.insertInto(t).values(v).execute()`
function makeFakeTx() {
  const writes: Array<{ table: string; values: any; upsert: boolean }> = []
  let idCounter = 0
  const nextId = (table: string) => `${table}-${++idCounter}`
  const tx: any = {
    insertInto: (table: string) => ({
      values: (v: any) => ({
        onConflict: (_cb: any) => ({
          returning: (_col: string) => ({
            executeTakeFirst: async () => {
              writes.push({ table, values: v, upsert: true })
              return { id: nextId(table) }
            },
          }),
          execute: async () => {
            writes.push({ table, values: v, upsert: true })
            return undefined
          },
        }),
        execute: async () => {
          writes.push({ table, values: v, upsert: false })
          return undefined
        },
      }),
    }),
  }
  return { tx, writes }
}

const baseProduct: ScrapedProduct = {
  source_id: '1',
  handle: 'tee-a',
  title: 'Tee A',
  body_html: '<p>x</p>',
  vendor: 'Allbirds',
  product_type: 'Shirt',
  tags: ['cotton', 'summer'],
  images: [
    { src: 'https://cdn.x/1.jpg', alt: 'Tee', position: 1 },
    { src: 'https://cdn.x/2.jpg', alt: null, position: 2 },
  ],
  variants: [
    {
      source_id: 'v1',
      title: 'S',
      price: '29.00',
      compare_at_price: null,
      sku: 'T-S',
      inventory_quantity: 10,
      option_values: ['S'],
      weight: 200,
      weight_unit: 'g',
    },
  ],
  options: [{ name: 'Size', position: 1, values: ['S', 'M', 'L'] }],
}

describe('persistProducts', () => {
  it('upserts product by (shop_id, slug) using real column names', async () => {
    const { tx, writes } = makeFakeTx()
    const res = await persistProducts(tx, 'shop-1', [baseProduct])

    expect(res.inserted + res.updated).toBe(1)
    const productWrite = writes.find((w) => w.table === 'products')!
    // slug, NOT handle. body_html, NOT description_html. tags is text[].
    expect(productWrite.values).toMatchObject({
      shop_id: 'shop-1',
      slug: 'tee-a',
      title: 'Tee A',
      body_html: '<p>x</p>',
      vendor: 'Allbirds',
      product_type: 'Shirt',
      status: 'draft',
    })
    // tags passed through as array (text[])
    expect(productWrite.values.tags).toEqual(['cotton', 'summer'])
  })

  it('writes one product_options + one variant + two images for the sample product', async () => {
    const { tx, writes } = makeFakeTx()
    await persistProducts(tx, 'shop-1', [baseProduct])

    expect(writes.filter((w) => w.table === 'product_options')).toHaveLength(1)
    expect(writes.filter((w) => w.table === 'product_variants')).toHaveLength(1)
    expect(writes.filter((w) => w.table === 'product_images')).toHaveLength(2)

    const variantWrite = writes.find((w) => w.table === 'product_variants')!
    // Variant uses option1/2/3 columns (not option_values)
    expect(variantWrite.values).toMatchObject({
      title: 'S',
      price: '29.00',
      compare_at_price: null,
      sku: 'T-S',
      inventory_quantity: 10,
      option1: 'S',
      option2: null,
      option3: null,
    })
    // Weight preserved as the numeric string Kysely will insert.
    expect(variantWrite.values.weight).toBe(200)

    const optWrite = writes.find((w) => w.table === 'product_options')!
    expect(optWrite.values).toMatchObject({
      name: 'Size',
      position: 1,
    })
    expect(optWrite.values.values).toEqual(['S', 'M', 'L'])
  })

  it('variant with sku uses ON CONFLICT upsert (sku path)', async () => {
    const { tx, writes } = makeFakeTx()
    await persistProducts(tx, 'shop-1', [baseProduct])
    const variantWrite = writes.find((w) => w.table === 'product_variants')!
    expect(variantWrite.upsert).toBe(true)
  })

  it('variant without sku falls back to plain INSERT (no dedup)', async () => {
    const productNoSku: ScrapedProduct = {
      ...baseProduct,
      variants: [
        {
          ...baseProduct.variants[0],
          sku: null,
        },
      ],
    }
    const { tx, writes } = makeFakeTx()
    await persistProducts(tx, 'shop-1', [productNoSku])
    const variantWrite = writes.find((w) => w.table === 'product_variants')!
    // No onConflict for sku-less variants — plain insert path.
    expect(variantWrite.upsert).toBe(false)
    expect(variantWrite.values.sku).toBeNull()
  })

  it('propagates insert errors (does NOT swallow — pg 25P02 aborts the whole tx)', async () => {
    // Why this test matters: persisters run inside `withSerializable`, so
    // any caught error would leave the Postgres transaction in state
    // `25P02 current transaction is aborted`, causing every subsequent
    // query to fail opaquely. The correct behavior is to let errors
    // propagate so withSerializable can either retry (40001/40P01) or
    // fail the whole clone cleanly.
    const second: ScrapedProduct = { ...baseProduct, handle: 'tee-b', title: 'Tee B' }
    const tx: any = {
      insertInto: (table: string) => ({
        values: (v: any) => {
          if (table === 'products' && v.slug === 'tee-a') {
            return {
              onConflict: () => ({
                returning: () => ({
                  executeTakeFirst: async () => {
                    throw new Error('unique violation (fake)')
                  },
                }),
              }),
            }
          }
          return {
            onConflict: () => ({
              returning: () => ({ executeTakeFirst: async () => ({ id: 'prod-2' }) }),
              execute: async () => undefined,
            }),
            execute: async () => undefined,
          }
        },
      }),
    }
    await expect(persistProducts(tx, 'shop-1', [baseProduct, second])).rejects.toThrow(
      'unique violation (fake)',
    )
  })
})
