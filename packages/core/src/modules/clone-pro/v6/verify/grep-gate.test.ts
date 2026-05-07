import { describe, it, expect } from 'vitest'
import { verifyNoSourceLeaks } from './grep-gate.js'

describe('verify/grep-gate (Iron Rule 5)', () => {
  it('returns ok=true when no source-host references found', async () => {
    const fakeDb = makeDb({
      products: [{ id: 'p1', body_html: '<p>fully rewritten</p>' }],
      pages: [{ id: 'pg1', body_html: '/pages/about' }],
      blog_posts: [],
      menu_items: [{ id: 'mi1', url: '/products/x' }],
      collections: [],
    })
    const r = await verifyNoSourceLeaks({ db: fakeDb, shopId: 'shop-1', sourceHost: 'bibliobloom.com' })
    expect(r.ok).toBe(true)
    expect(r.totalLeaks).toBe(0)
  })

  it('flags rows containing source-host', async () => {
    const fakeDb = makeDb({
      products: [{ id: 'p1', body_html: '<p>see https://bibliobloom.com/products/x</p>' }],
      pages: [{ id: 'pg1', body_html: 'clean' }],
      blog_posts: [],
      menu_items: [],
      collections: [],
    })
    const r = await verifyNoSourceLeaks({ db: fakeDb, shopId: 'shop-1', sourceHost: 'bibliobloom.com' })
    expect(r.ok).toBe(false)
    expect(r.totalLeaks).toBe(1)
    expect(r.leaks[0]).toMatchObject({ table: 'products', rowId: 'p1' })
  })
})

function makeDb(seeds: any) {
  return {
    selectFrom: (table: string) => ({
      // non-menu_items path
      where: () => ({ select: () => ({ execute: async () => seeds[table] ?? [] }) }),
      // menu_items path: innerJoin().where().select().execute()
      innerJoin: () => ({
        where: () => ({ select: () => ({ execute: async () => seeds.menu_items ?? [] }) }),
      }),
    }),
  } as any
}
