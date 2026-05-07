import { describe, it, expect } from 'vitest'
import { checkCardinality } from './cardinality.js'

describe('cardinality check', () => {
  it('reports ok=true when overall >=99%', async () => {
    // products 99/100=99%, collections 10/10=100%, pages 5/5=100%, blogPosts 4/4=100%
    // overall = (99+100+100+100)/4 = 99.75 >= 99 → ok=true
    const counts: Record<string, number> = { products: 99, collections: 10, pages: 5, blog_posts: 4 }
    const fakeDb = {
      selectFrom: (table: string) => ({
        where: () => ({ select: () => ({ executeTakeFirst: async () => ({
          n: counts[table] ?? 0,
        }) }) }),
      }),
    }
    const r = await checkCardinality({
      db: fakeDb as any, shopId: 's',
      sourceUrlCounts: { products: 100, collections: 10, pages: 5, blogPosts: 4 },
    })
    expect(r.ok).toBe(true)
    expect(r.overallPct).toBeGreaterThanOrEqual(99)
  })

  it('reports ok=false when products lag', async () => {
    const counts: Record<string, number> = { products: 50, collections: 10, pages: 5, blog_posts: 4 }
    const fakeDb = {
      selectFrom: (table: string) => ({
        where: () => ({ select: () => ({ executeTakeFirst: async () => ({
          n: counts[table] ?? 0,
        }) }) }),
      }),
    }
    const r = await checkCardinality({
      db: fakeDb as any, shopId: 's',
      sourceUrlCounts: { products: 100, collections: 10, pages: 5, blogPosts: 4 },
    })
    expect(r.ok).toBe(false)
    expect(r.productsPct).toBe(50)
  })
})
