/**
 * Theme Customizer — picker-search unit tests
 *
 * Cases:
 *   1. clampLimit guards against non-numbers, negatives, floats, large values
 *   2. escapeLike escapes %, _, \
 *   3. searchProducts adds ilike + status=active + scopes to shop
 *   4. searchProducts returns clean payload shape (id, handle, title, meta)
 *   5. searchCollections similar shape
 *   6. searchPages similar shape
 *   7. searchBlogs similar shape
 *   8. searchArticles joins blogs and includes blog_title in meta
 */

import { describe, it, expect } from 'vitest'
import {
  searchProducts,
  searchCollections,
  searchPages,
  searchBlogs,
  searchArticles,
  __test,
} from './picker-search.js'

const { clampLimit, escapeLike } = __test

describe('clampLimit', () => {
  it('clamps to fallback for non-numbers', () => {
    expect(clampLimit('abc')).toBe(20)
    expect(clampLimit(undefined)).toBe(20)
    expect(clampLimit(null)).toBe(20)
  })
  it('clamps negatives + zero to fallback', () => {
    expect(clampLimit(-5)).toBe(20)
    expect(clampLimit(0)).toBe(20)
  })
  it('rounds + caps at MAX_LIMIT', () => {
    expect(clampLimit(7.7)).toBe(7)
    expect(clampLimit(99)).toBe(50)
  })
})

describe('escapeLike', () => {
  it('escapes special chars', () => {
    expect(escapeLike('100%')).toBe('100\\%')
    expect(escapeLike('a_b')).toBe('a\\_b')
    expect(escapeLike('a\\b')).toBe('a\\\\b')
  })
  it('passes plain text through', () => {
    expect(escapeLike('hello world')).toBe('hello world')
  })
})

// ─── DB mock ─────────────────────────────────────────────────────────────

interface Captured {
  table: string
  joins: string[]
  where: Array<{ col: string; op: string; val: any }>
  limit?: number
  orderBy?: string
}

function mockDb(rows: any[], capture: Captured) {
  const builder: any = {
    selectFrom(table: string) {
      capture.table = table
      const leaf: any = {
        select() { return leaf },
        leftJoin(table2: string) { capture.joins.push(table2); return leaf },
        where(col: string, op: string, val: any) {
          capture.where.push({ col, op, val })
          return leaf
        },
        orderBy(col: string) { capture.orderBy = col; return leaf },
        limit(n: number) { capture.limit = n; return leaf },
        async execute() { return rows },
      }
      return leaf
    },
  }
  return builder
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('searchProducts', () => {
  it('scopes to shop, filters status=active, applies ilike pattern', async () => {
    const cap: Captured = { table: '', joins: [], where: [] }
    const out = await searchProducts(
      mockDb([{ id: 'p1', handle: 'tee', title: 'Tee shirt', status: 'active' }], cap),
      'shop-A',
      'tee',
      10,
    )
    expect(out.items).toHaveLength(1)
    expect(out.items[0]).toEqual({ id: 'p1', handle: 'tee', title: 'Tee shirt', meta: 'active' })
    expect(cap.table).toBe('products')
    expect(cap.where.find((w) => w.col === 'shop_id')!.val).toBe('shop-A')
    expect(cap.where.find((w) => w.col === 'status')!.val).toBe('active')
    expect(cap.where.find((w) => w.col === 'title')!.op).toBe('ilike')
    expect(cap.where.find((w) => w.col === 'title')!.val).toBe('%tee%')
    expect(cap.limit).toBe(10)
  })

  it('skips ilike when q is empty', async () => {
    const cap: Captured = { table: '', joins: [], where: [] }
    await searchProducts(mockDb([], cap), 'shop-A', '')
    expect(cap.where.find((w) => w.op === 'ilike')).toBeUndefined()
  })
})

describe('searchCollections', () => {
  it('returns clean payload', async () => {
    const cap: Captured = { table: '', joins: [], where: [] }
    const out = await searchCollections(
      mockDb([{ id: 'c1', handle: 'spring', title: 'Spring 2026' }], cap),
      'shop-A',
      '',
    )
    expect(out.items[0]).toEqual({ id: 'c1', handle: 'spring', title: 'Spring 2026' })
    expect(cap.table).toBe('collections')
  })
})

describe('searchPages', () => {
  it('returns clean payload', async () => {
    const cap: Captured = { table: '', joins: [], where: [] }
    const out = await searchPages(
      mockDb([{ id: 'pg1', handle: 'about', title: 'About Us' }], cap),
      'shop-A',
      '',
    )
    expect(out.items[0]).toEqual({ id: 'pg1', handle: 'about', title: 'About Us' })
    expect(cap.table).toBe('pages')
  })
})

describe('searchBlogs', () => {
  it('returns clean payload', async () => {
    const cap: Captured = { table: '', joins: [], where: [] }
    const out = await searchBlogs(
      mockDb([{ id: 'b1', handle: 'news', title: 'News' }], cap),
      'shop-A',
      '',
    )
    expect(out.items[0]).toEqual({ id: 'b1', handle: 'news', title: 'News' })
    expect(cap.table).toBe('blogs')
  })
})

describe('searchArticles', () => {
  it('joins blogs and surfaces blog_title in meta', async () => {
    const cap: Captured = { table: '', joins: [], where: [] }
    const out = await searchArticles(
      mockDb([{ id: 'a1', handle: 'hello', title: 'Hello World', blog_title: 'News' }], cap),
      'shop-A',
      'hello',
    )
    expect(out.items[0]).toEqual({ id: 'a1', handle: 'hello', title: 'Hello World', meta: 'News' })
    expect(cap.joins).toContain('blogs as b')
    expect(cap.where.find((w) => w.col === 'bp.shop_id')!.val).toBe('shop-A')
  })
})
