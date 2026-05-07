import { describe, it, expect } from 'vitest'
import { persistCollections } from './collections-persist.js'
import type { ScrapedCollection } from '../types.js'

const sample: ScrapedCollection = {
  source_id: '10',
  handle: 'sale',
  title: 'Sale',
  body_html: '<p>s</p>',
  image: { src: 'https://cdn.x/sale.jpg', alt: 'Sale', position: 1 },
  product_handles: ['tee-a', 'tee-b'],
}

function makeFakeTx(products: Array<{ id: string; slug: string }>) {
  const writes: any[] = []
  const tx: any = {
    insertInto: (table: string) => ({
      values: (v: any) => ({
        onConflict: (_cb: any) => ({
          returning: (_c: string) => ({
            executeTakeFirst: async () => {
              writes.push({ table, values: v, upsert: true })
              if (table === 'collections') return { id: 'coll-1' }
              return null
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
    selectFrom: (_t: string) => ({
      select: (_c: any) => ({
        where: (_a: any, _op: any, _b: any) => ({
          where: (_a2: any, _op2: any, _b2: any) => ({
            execute: async () => products,
          }),
        }),
      }),
    }),
    deleteFrom: (_t: string) => ({
      where: (_a: any, _op: any, _b: any) => ({
        execute: async () => undefined,
      }),
    }),
  }
  return { tx, writes }
}

describe('persistCollections', () => {
  it('upserts collection by (shop_id, slug) using image_url + body_html cols', async () => {
    const { tx, writes } = makeFakeTx([
      { id: 'prod-a', slug: 'tee-a' },
      { id: 'prod-b', slug: 'tee-b' },
    ])
    const res = await persistCollections(tx, 'shop-1', [sample])

    expect(res.inserted + res.updated).toBe(1)
    const collWrite = writes.find((w) => w.table === 'collections')!
    // Real schema: slug (not handle), image_url (not image_src), body_html.
    expect(collWrite.values).toMatchObject({
      shop_id: 'shop-1',
      slug: 'sale',
      title: 'Sale',
      body_html: '<p>s</p>',
      image_url: 'https://cdn.x/sale.jpg',
    })
  })

  it('resolves DTO product_handles → product_ids via products.slug', async () => {
    const { tx, writes } = makeFakeTx([
      { id: 'prod-a', slug: 'tee-a' },
      { id: 'prod-b', slug: 'tee-b' },
    ])
    const res = await persistCollections(tx, 'shop-1', [sample])

    expect(res.pivotLinks).toBe(2)
    const pivots = writes.filter((w) => w.table === 'collection_products')
    expect(pivots).toHaveLength(2)
    expect(pivots.map((p) => p.values.product_id).sort()).toEqual(['prod-a', 'prod-b'])
  })

  it('silently drops handles that do not resolve to any product', async () => {
    // Only tee-a imported; tee-b missing.
    const { tx, writes } = makeFakeTx([{ id: 'prod-a', slug: 'tee-a' }])
    const res = await persistCollections(tx, 'shop-1', [sample])

    expect(res.pivotLinks).toBe(1)
    const pivots = writes.filter((w) => w.table === 'collection_products')
    expect(pivots).toHaveLength(1)
    expect(pivots[0].values.product_id).toBe('prod-a')
  })

  it('null image resolves to null image_url (not crash on c.image?.src)', async () => {
    const noImg: ScrapedCollection = { ...sample, image: null }
    const { tx, writes } = makeFakeTx([])
    await persistCollections(tx, 'shop-1', [noImg])
    const collWrite = writes.find((w) => w.table === 'collections')!
    expect(collWrite.values.image_url).toBeNull()
  })
})
