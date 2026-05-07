import { describe, it, expect } from 'vitest'
import { rewriteSources, applyRewriterToDb } from './stage8-path-rewriter.js'

describe('Stage 8 — path rewriter', () => {
  const rules = {
    sourceHost: 'bibliobloom.com',
    sourceCdnHosts: ['cdn.shopify.com', 'cdn.bibliobloom.com'],
    targetCdnUrl: 'https://cdn.gbox.co/clone-storage/d549d092',
    productHandleResolver: (handle: string) => handle,
    collectionHandleResolver: (handle: string) => handle,
    pageHandleResolver: (handle: string) => handle,
    blogResolver: (blog: string, post: string) => `${blog}/${post}`,
    assetMap: new Map([
      ['https://cdn.shopify.com/s/files/widget.jpg', 'sha1abc.jpg'],
    ]),
  }

  it('rewrites /products/<handle>', () => {
    const r = rewriteSources('Visit https://bibliobloom.com/products/widget today!', rules)
    expect(r).toBe('Visit /products/widget today!')
  })

  it('rewrites cdn.shopify.com to cdn.gbox.co', () => {
    const r = rewriteSources('<img src="https://cdn.shopify.com/s/files/widget.jpg">', rules)
    expect(r).toContain('cdn.gbox.co/clone-storage/d549d092/sha1abc.jpg')
  })

  it('rewrites /collections/<handle>', () => {
    const r = rewriteSources('See https://bibliobloom.com/collections/sale', rules)
    expect(r).toBe('See /collections/sale')
  })

  it('rewrites /pages/<handle>', () => {
    const r = rewriteSources('https://bibliobloom.com/pages/about', rules)
    expect(r).toBe('/pages/about')
  })

  it('rewrites /blogs/<blog>/<post>', () => {
    const r = rewriteSources('https://bibliobloom.com/blogs/news/launch', rules)
    expect(r).toBe('/blogs/news/launch')
  })

  it('preserves /cart and /account URLs as-is paths', () => {
    const r = rewriteSources('https://bibliobloom.com/cart', rules)
    expect(r).toBe('/cart')
  })

  it('strips source-domain absolute references in <a href>', () => {
    const r = rewriteSources('<a href="https://bibliobloom.com/products/x">x</a>', rules)
    expect(r).toBe('<a href="/products/x">x</a>')
  })

  it('leaves unrelated domains alone', () => {
    const r = rewriteSources('https://example.com/external', rules)
    expect(r).toBe('https://example.com/external')
  })
})

describe('applyRewriterToDb', () => {
  it('walks rows and rewrites in-place', async () => {
    const updates: any[] = []
    // applyRewriterToDb branches on cfg.table === 'menu_items' (uses innerJoin)
    // vs others (where-shop_id). Mock both shapes.
    const fakeDb = {
      selectFrom: (table: string) => ({
        // Non-menu_items path: where().select().execute()
        where: () => ({
          select: () => ({
            execute: async () =>
              table === 'products'
                ? [
                    {
                      id: 'p1',
                      shop_id: 's',
                      title: 'X',
                      body_html: '<a href="https://bibliobloom.com/products/x">x</a>',
                    },
                  ]
                : [],
          }),
        }),
        // menu_items + product_images both use innerJoin().where().[where()].select().execute()
        innerJoin: () => ({
          where: () => ({
            // menu_items: 1 where → select → execute
            select: () => ({ execute: async () => [] }),
            // product_images: 2 wheres → select → execute
            where: () => ({
              select: () => ({ execute: async () => [] }),
            }),
          }),
        }),
      }),
      updateTable: (table: string) => ({
        set: (vals: any) => ({
          where: () => ({
            execute: async () => {
              updates.push({ table, vals })
            },
          }),
        }),
      }),
    }

    const r = await applyRewriterToDb({
      db: fakeDb as any,
      shopId: 's',
      sourceHost: 'bibliobloom.com',
      sourceCdnHosts: [],
      targetCdnUrl: '',
      assetMap: new Map(),
      productHandleResolver: (h) => h,
      collectionHandleResolver: (h) => h,
      pageHandleResolver: (h) => h,
      blogResolver: (b, p) => `${b}/${p}`,
    })

    expect(r.rowsRewritten).toBe(1)
    expect(updates[0].vals.body_html).toBe('<a href="/products/x">x</a>')
  })
})
