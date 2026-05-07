/**
 * Clone Pro — ai-seo-optimizer tests
 *
 * Validates the batch SEO optimizer against a chainable mock DB and
 * a minimal AIBridge stub. The goal of these tests is to pin the
 * contract of `optimizeSeoForShop`:
 *
 *   - Calls AI once per candidate row that's missing SEO
 *   - Writes generated title + description back via UPDATE
 *   - Respects `dryRun` (no writes)
 *   - Truncates title to 60 chars / description to 155 chars
 *   - Treats empty AI results + thrown errors as non-fatal failures
 *   - Fires `onProgress` with the correct total and 1-based index
 *   - Reports per-entity counts in the result
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { optimizeSeoForShop } from './ai-seo-optimizer.js'
import type { AIBridge } from './ai-bridge.js'

// ---------------------------------------------------------------------------
// Helpers: mock AIBridge
// ---------------------------------------------------------------------------

function makeAi(overrides: Partial<AIBridge> = {}): AIBridge {
  return {
    provider: 'openai' as any,
    capabilities: {
      layoutAnalysis: true,
      sectionDetection: true,
      contentRewriting: true,
      imageAltText: true,
      seoOptimization: true,
    } as any,
    analyzeLayout: vi.fn() as any,
    analyzeContent: vi.fn() as any,
    generateAltText: vi.fn() as any,
    suggestSections: vi.fn() as any,
    rewriteContent: vi.fn() as any,
    generateSeoMeta: vi.fn().mockResolvedValue({
      title: 'Generated Title',
      description: 'Generated description.',
      ogTitle: 'Generated Title',
      keywords: ['a', 'b'],
    }),
    ...overrides,
  } as AIBridge
}

// ---------------------------------------------------------------------------
// Helpers: chainable mock DB
//
// We record fetches (table → returned rows) and updates (table + set
// values + id WHERE). The builder chain accepts any method call and
// ends with `.execute()` returning the prerecorded rows (for SELECT)
// or the recorded update (for UPDATE).
// ---------------------------------------------------------------------------

interface DbState {
  readonly rowsByTable: Record<string, Array<Record<string, any>>>
  readonly updates: Array<{ table: string; set: Record<string, any>; id: string }>
}

function makeDb(rowsByTable: Record<string, Array<Record<string, any>>>): {
  db: any
  state: DbState
} {
  const state: DbState = { rowsByTable, updates: [] }

  function makeSelect(table: string) {
    const rows = rowsByTable[table] ?? []
    const builder: any = {
      select: () => builder,
      where: () => builder,
      limit: () => builder,
      execute: vi.fn().mockResolvedValue(rows),
    }
    return builder
  }

  function makeUpdate(table: string) {
    let currentSet: Record<string, any> = {}
    let currentId = ''
    const builder: any = {
      set: (v: Record<string, any>) => {
        currentSet = v
        return builder
      },
      where: (col: string, _op: string, val: any) => {
        if (col === 'id') currentId = val
        return builder
      },
      execute: vi.fn().mockImplementation(async () => {
        state.updates.push({ table, set: currentSet, id: currentId })
      }),
    }
    return builder
  }

  const db = {
    selectFrom: vi.fn().mockImplementation((table: string) => makeSelect(table)),
    updateTable: vi.fn().mockImplementation((table: string) => makeUpdate(table)),
  }

  return { db, state }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('optimizeSeoForShop — core behaviour', () => {
  it('calls AI once per candidate across all four entity types', async () => {
    const ai = makeAi()
    const { db } = makeDb({
      products: [{ id: 'p1', title: 'Red Shoe', body_html: 'Classic.' }],
      pages: [{ id: 'pg1', title: 'About', body_html: 'Our story.' }],
      collections: [{ id: 'c1', title: 'Summer', body_html: 'Bright things.' }],
      blog_posts: [
        { id: 'b1', title: 'Launch', body_html: 'We launched!', excerpt: null },
      ],
    })

    const result = await optimizeSeoForShop({
      db,
      shopId: 'shop-1',
      ai,
    })

    expect(ai.generateSeoMeta).toHaveBeenCalledTimes(4)
    expect(result.productsOptimized).toBe(1)
    expect(result.pagesOptimized).toBe(1)
    expect(result.collectionsOptimized).toBe(1)
    expect(result.blogPostsOptimized).toBe(1)
    expect(result.failed).toBe(0)
  })

  it('persists generated SEO meta to the correct tables', async () => {
    const ai = makeAi()
    const { db, state } = makeDb({
      products: [{ id: 'p1', title: 'Red Shoe', body_html: '' }],
      pages: [{ id: 'pg1', title: 'About', body_html: '' }],
      collections: [],
      blog_posts: [],
    })

    await optimizeSeoForShop({ db, shopId: 'shop-1', ai })

    expect(state.updates).toHaveLength(2)
    const productUpd = state.updates.find((u) => u.table === 'products')!
    expect(productUpd.id).toBe('p1')
    expect(productUpd.set.seo_title).toBe('Generated Title')
    expect(productUpd.set.seo_description).toBe('Generated description.')
    expect(typeof productUpd.set.updated_at).toBe('string')

    const pageUpd = state.updates.find((u) => u.table === 'pages')!
    expect(pageUpd.id).toBe('pg1')
  })

  it('honours dryRun — no UPDATE is executed', async () => {
    const ai = makeAi()
    const { db, state } = makeDb({
      products: [{ id: 'p1', title: 'Red Shoe', body_html: '' }],
      pages: [],
      collections: [],
      blog_posts: [],
    })

    const result = await optimizeSeoForShop({
      db,
      shopId: 'shop-1',
      ai,
      dryRun: true,
    })

    expect(state.updates).toHaveLength(0)
    // Optimized count still increments — we've "succeeded" at generation.
    expect(result.productsOptimized).toBe(1)
  })

  it('falls back to blog excerpt when body_html is missing', async () => {
    const ai = makeAi()
    const { db } = makeDb({
      products: [],
      pages: [],
      collections: [],
      blog_posts: [
        { id: 'b1', title: 'Post', body_html: null, excerpt: 'Excerpt text.' },
      ],
    })

    await optimizeSeoForShop({ db, shopId: 'shop-1', ai })

    expect(ai.generateSeoMeta).toHaveBeenCalledWith('Post', 'Excerpt text.')
  })
})

describe('optimizeSeoForShop — truncation', () => {
  it('caps title at 60 chars and description at 155 chars', async () => {
    const longTitle = 'A'.repeat(200)
    const longDesc = 'B'.repeat(500)
    const ai = makeAi({
      generateSeoMeta: vi.fn().mockResolvedValue({
        title: longTitle,
        description: longDesc,
        ogTitle: longTitle,
        keywords: [],
      }),
    })
    const { db, state } = makeDb({
      products: [{ id: 'p1', title: 'x', body_html: '' }],
      pages: [],
      collections: [],
      blog_posts: [],
    })

    await optimizeSeoForShop({ db, shopId: 'shop-1', ai })

    const upd = state.updates[0]!
    expect(upd.set.seo_title.length).toBeLessThanOrEqual(60)
    expect(upd.set.seo_description.length).toBeLessThanOrEqual(155)
  })

  it('uses the source row title when AI returns an empty title', async () => {
    const ai = makeAi({
      generateSeoMeta: vi.fn().mockResolvedValue({
        title: '',
        description: 'A decent description.',
        ogTitle: '',
        keywords: [],
      }),
    })
    const { db, state } = makeDb({
      products: [{ id: 'p1', title: 'Fallback Title', body_html: '' }],
      pages: [],
      collections: [],
      blog_posts: [],
    })

    await optimizeSeoForShop({ db, shopId: 'shop-1', ai })

    expect(state.updates[0]!.set.seo_title).toBe('Fallback Title')
  })
})

describe('optimizeSeoForShop — failures are non-fatal', () => {
  beforeEach(() => {
    // Silence the "[ai-seo-optimizer] … failed" warnings from the
    // happy path of the failure test.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('counts thrown AI errors as failures and keeps going', async () => {
    const ai = makeAi({
      generateSeoMeta: vi
        .fn()
        .mockRejectedValueOnce(new Error('rate limited'))
        .mockResolvedValue({
          title: 'Ok',
          description: 'Ok.',
          ogTitle: 'Ok',
          keywords: [],
        }),
    })
    const { db, state } = makeDb({
      products: [
        { id: 'p1', title: 'A', body_html: '' },
        { id: 'p2', title: 'B', body_html: '' },
      ],
      pages: [],
      collections: [],
      blog_posts: [],
    })

    const result = await optimizeSeoForShop({ db, shopId: 'shop-1', ai })

    expect(result.failed).toBe(1)
    expect(result.productsOptimized).toBe(1)
    expect(state.updates).toHaveLength(1)
    expect(state.updates[0]!.id).toBe('p2')
  })

  it('counts empty AI meta as a failure', async () => {
    const ai = makeAi({
      generateSeoMeta: vi.fn().mockResolvedValue({
        title: '',
        description: '',
        ogTitle: '',
        keywords: [],
      }),
    })
    const { db, state } = makeDb({
      products: [{ id: 'p1', title: '', body_html: '' }],
      pages: [],
      collections: [],
      blog_posts: [],
    })

    const result = await optimizeSeoForShop({ db, shopId: 'shop-1', ai })

    expect(result.productsOptimized).toBe(0)
    expect(result.failed).toBe(1)
    expect(state.updates).toHaveLength(0)
  })
})

describe('optimizeSeoForShop — progress reporting', () => {
  it('calls onProgress once per item with 1-based index and total', async () => {
    const ai = makeAi()
    const { db } = makeDb({
      products: [
        { id: 'p1', title: 'A', body_html: '' },
        { id: 'p2', title: 'B', body_html: '' },
      ],
      pages: [{ id: 'pg1', title: 'C', body_html: '' }],
      collections: [],
      blog_posts: [],
    })
    const progress = vi.fn()

    await optimizeSeoForShop({
      db,
      shopId: 'shop-1',
      ai,
      onProgress: progress,
    })

    expect(progress).toHaveBeenCalledTimes(3)
    expect(progress.mock.calls[0]).toEqual([1, 3, 'product:A'])
    expect(progress.mock.calls[1]).toEqual([2, 3, 'product:B'])
    expect(progress.mock.calls[2]).toEqual([3, 3, 'page:C'])
  })

  it('is a safe no-op when there are zero candidates', async () => {
    const ai = makeAi()
    const { db } = makeDb({ products: [], pages: [], collections: [], blog_posts: [] })

    const result = await optimizeSeoForShop({ db, shopId: 'shop-1', ai })

    expect(ai.generateSeoMeta).not.toHaveBeenCalled()
    expect(result.productsOptimized).toBe(0)
    expect(result.failed).toBe(0)
  })
})
