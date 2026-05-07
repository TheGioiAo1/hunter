/**
 * Design Library — queries (Phase D1).
 *
 * The tests validate three things for each public helper:
 *
 *   1. The Kysely chain hits the right table + filters so we don't
 *      accidentally return seed rows in "My Clones" or vice versa.
 *   2. Row → domain conversion strips the DB shape (snake_case,
 *      timestamptz) and normalises nulls/defaults.
 *   3. Safety rails (empty shopId, unknown category, out-of-range
 *      limit) don't make the DB do unnecessary work.
 *
 * We use a fake db that records every method call so the assertions
 * read like a storyboard. Same pattern as `collections/best-sellers.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import {
  countSeedEntries,
  countSeedEntriesByCategory,
  getEntryById,
  getEntryBySlug,
  listFeaturedSeeds,
  listGallery,
  listMyClones,
} from './queries.js'

interface Call {
  method: string
  args: unknown[]
}

/**
 * Build a fake Kysely instance that records method calls and returns
 * `rows` on execute() / `row` on executeTakeFirst(). Also supports
 * selectAll and the `eb => eb.fn.countAll()` shape used in the count
 * helpers.
 */
function fakeDb(options: {
  rows?: any[]
  row?: any
} = {}) {
  const calls: Call[] = []
  const chain: any = {
    selectFrom: (t: string) => (calls.push({ method: 'selectFrom', args: [t] }), chain),
    select: (arg: unknown) => {
      // Support both array-select and eb-lambda form.
      if (typeof arg === 'function') {
        const fn = arg as (eb: any) => any
        fn({ fn: { countAll: () => ({ as: () => ({}) }) } })
        calls.push({ method: 'select', args: ['<countAll lambda>'] })
      } else {
        calls.push({ method: 'select', args: [arg] })
      }
      return chain
    },
    selectAll: () => (calls.push({ method: 'selectAll', args: [] }), chain),
    where: (col: unknown, op?: unknown, val?: unknown) => (
      calls.push({ method: 'where', args: [col, op, val] }), chain
    ),
    groupBy: (col: unknown) => (calls.push({ method: 'groupBy', args: [col] }), chain),
    orderBy: (col: unknown, dir?: unknown) => (
      calls.push({ method: 'orderBy', args: [col, dir] }), chain
    ),
    limit: (n: number) => (calls.push({ method: 'limit', args: [n] }), chain),
    execute: async () => options.rows ?? [],
    executeTakeFirst: async () => options.row,
  }
  const db = { selectFrom: (t: string) => chain.selectFrom(t) }
  return { db, calls }
}

// ---------------------------------------------------------------------------
// listGallery
// ---------------------------------------------------------------------------

describe('listGallery', () => {
  it('filters to source=seed and orders by title', async () => {
    const { db, calls } = fakeDb({ rows: [] })
    await listGallery(db as any, {})
    expect(
      calls.some(
        (c) =>
          c.method === 'where' && c.args[0] === 'source' && c.args[2] === 'seed',
      ),
    ).toBe(true)
    expect(
      calls.some(
        (c) => c.method === 'orderBy' && c.args[0] === 'title' && c.args[1] === 'asc',
      ),
    ).toBe(true)
  })

  it('applies category filter when provided', async () => {
    const { db, calls } = fakeDb({ rows: [] })
    await listGallery(db as any, { category: 'finance' })
    expect(
      calls.some(
        (c) =>
          c.method === 'where' &&
          c.args[0] === 'category' &&
          c.args[2] === 'finance',
      ),
    ).toBe(true)
  })

  it('no-ops (returns [] without querying) for unknown category', async () => {
    const { db, calls } = fakeDb({ rows: [{ id: 'shouldnotbereturned' }] })
    const result = await listGallery(db as any, { category: 'not-a-bucket' as any })
    expect(result).toEqual([])
    expect(calls.length).toBe(0)
  })

  it('clamps out-of-range limit to 200', async () => {
    const { db, calls } = fakeDb({ rows: [] })
    await listGallery(db as any, { limit: 99999 })
    expect(calls.some((c) => c.method === 'limit' && c.args[0] === 200)).toBe(true)
  })

  it('converts raw DB row to DesignLibraryCard shape', async () => {
    const now = '2026-04-18T10:00:00.000Z'
    const { db } = fakeDb({
      rows: [
        {
          id: 'u-1',
          slug: 'stripe',
          source: 'seed',
          shopId: null,
          title: 'Stripe',
          summary: 'Payments for the internet.',
          category: 'finance',
          thumbnailUrl: 'https://cdn.example/stripe.png',
          storageTier: 'hot',
          createdAt: now,
          updatedAt: now,
        },
      ],
    })
    const [card] = await listGallery(db as any, {})
    expect(card).toEqual({
      id: 'u-1',
      slug: 'stripe',
      source: 'seed',
      shopId: null,
      title: 'Stripe',
      summary: 'Payments for the internet.',
      category: 'finance',
      thumbnailUrl: 'https://cdn.example/stripe.png',
      storageTier: 'hot',
      createdAt: now,
      updatedAt: now,
    })
  })

  it('coerces Date timestamps to ISO strings', async () => {
    const { db } = fakeDb({
      rows: [
        {
          id: 'u-1',
          slug: 'a',
          source: 'seed',
          shopId: null,
          title: 'A',
          summary: null,
          category: null,
          thumbnailUrl: null,
          storageTier: 'hot',
          createdAt: new Date('2026-04-18T00:00:00Z'),
          updatedAt: new Date('2026-04-18T00:00:00Z'),
        },
      ],
    })
    const [card] = await listGallery(db as any, {})
    expect(card.createdAt).toBe('2026-04-18T00:00:00.000Z')
    expect(card.updatedAt).toBe('2026-04-18T00:00:00.000Z')
  })
})

// ---------------------------------------------------------------------------
// listMyClones
// ---------------------------------------------------------------------------

describe('listMyClones', () => {
  it('filters to source=clone + shopId and orders newest-first', async () => {
    const { db, calls } = fakeDb({ rows: [] })
    await listMyClones(db as any, { shopId: 'shop-42' })
    expect(
      calls.some(
        (c) => c.method === 'where' && c.args[0] === 'source' && c.args[2] === 'clone',
      ),
    ).toBe(true)
    expect(
      calls.some(
        (c) => c.method === 'where' && c.args[0] === 'shop_id' && c.args[2] === 'shop-42',
      ),
    ).toBe(true)
    expect(
      calls.some(
        (c) =>
          c.method === 'orderBy' &&
          c.args[0] === 'created_at' &&
          c.args[1] === 'desc',
      ),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// listFeaturedSeeds
// ---------------------------------------------------------------------------

describe('listFeaturedSeeds', () => {
  it('filters to source=seed AND featured_rank IS NOT NULL', async () => {
    const { db, calls } = fakeDb({ rows: [] })
    await listFeaturedSeeds(db as any)
    expect(
      calls.some(
        (c) => c.method === 'where' && c.args[0] === 'source' && c.args[2] === 'seed',
      ),
    ).toBe(true)
    expect(
      calls.some(
        (c) =>
          c.method === 'where' &&
          c.args[0] === 'featured_rank' &&
          c.args[1] === 'is not' &&
          c.args[2] === null,
      ),
    ).toBe(true)
  })

  it('orders by featured_rank ASC then slug ASC', async () => {
    const { db, calls } = fakeDb({ rows: [] })
    await listFeaturedSeeds(db as any)
    const orderBys = calls.filter((c) => c.method === 'orderBy')
    expect(orderBys[0]).toEqual({ method: 'orderBy', args: ['featured_rank', 'asc'] })
    expect(orderBys[1]).toEqual({ method: 'orderBy', args: ['slug', 'asc'] })
  })

  it('applies LIMIT 4 by default — the welcome page only shows 4 tiles', async () => {
    const { db, calls } = fakeDb({ rows: [] })
    await listFeaturedSeeds(db as any)
    expect(calls.some((c) => c.method === 'limit' && c.args[0] === 4)).toBe(true)
  })

  it('caps an explicit high limit at 4 (prevents future flood)', async () => {
    const { db, calls } = fakeDb({ rows: [] })
    await listFeaturedSeeds(db as any, { limit: 100 })
    const limitCall = calls.find((c) => c.method === 'limit')
    expect(limitCall?.args[0]).toBe(4)
  })

  it('returns [] on an empty result set (fresh DB / no seeded featured picks)', async () => {
    const { db } = fakeDb({ rows: [] })
    const out = await listFeaturedSeeds(db as any)
    expect(out).toEqual([])
  })

  it('maps rows to DesignLibraryCard shape', async () => {
    const { db } = fakeDb({
      rows: [
        {
          id: 'uuid-1',
          slug: 'airbnb',
          source: 'seed',
          shopId: null,
          title: 'Airbnb',
          summary: 'Editorial travel marketplace.',
          category: 'travel',
          thumbnailUrl: 'https://cdn.example.com/airbnb.webp',
          storageTier: 'hot',
          createdAt: '2026-04-18T00:00:00.000Z',
          updatedAt: '2026-04-18T00:00:00.000Z',
        },
      ],
    })
    const out = await listFeaturedSeeds(db as any)
    expect(out).toHaveLength(1)
    expect(out[0].slug).toBe('airbnb')
    expect(out[0].title).toBe('Airbnb')
    expect(out[0].category).toBe('travel')
    expect(out[0].thumbnailUrl).toBe('https://cdn.example.com/airbnb.webp')
  })
})

// ---------------------------------------------------------------------------
// getEntryBySlug
// ---------------------------------------------------------------------------

describe('getEntryBySlug', () => {
  it('returns null when slug not found', async () => {
    const { db } = fakeDb({ row: undefined })
    const entry = await getEntryBySlug(db as any, { slug: 'unknown' })
    expect(entry).toBeNull()
  })

  it('scopes seed lookups with shop_id IS NULL', async () => {
    const { db, calls } = fakeDb({ row: undefined })
    await getEntryBySlug(db as any, { slug: 'stripe', source: 'seed' })
    expect(
      calls.some(
        (c) =>
          c.method === 'where' &&
          c.args[0] === 'shop_id' &&
          c.args[1] === 'is' &&
          c.args[2] === null,
      ),
    ).toBe(true)
  })

  it('requires shopId for clone lookups — null without it', async () => {
    const { db, calls } = fakeDb({ row: { id: 'should-not-return', source: 'clone' } })
    const entry = await getEntryBySlug(db as any, {
      slug: 'clone-abc',
      source: 'clone',
      // shopId intentionally omitted
    })
    expect(entry).toBeNull()
    // Importantly — no DB round trip either. This protects against a
    // caller bug leaking another shop's clone row.
    expect(calls.length).toBe(0)
  })

  it('maps all columns to the camelCase entry shape', async () => {
    const now = new Date('2026-04-18T00:00:00Z')
    const { db } = fakeDb({
      row: {
        id: 'u-1',
        slug: 'airbnb',
        source: 'seed',
        shop_id: null,
        title: 'Airbnb',
        summary: 'Belong anywhere.',
        category: 'travel',
        design_md: '# Airbnb\n\nBelong anywhere.',
        preview_html: '<html>light</html>',
        preview_dark_html: '<html>dark</html>',
        preview_html_url: null,
        preview_dark_html_url: null,
        thumbnail_url: null,
        storage_tier: 'hot',
        source_theme_id: null,
        source_clone_job_id: null,
        upstream_sha: '80bbbc2',
        created_at: now,
        updated_at: now,
      },
    })
    const entry = await getEntryBySlug(db as any, {
      slug: 'airbnb',
      source: 'seed',
    })
    expect(entry).toEqual({
      id: 'u-1',
      slug: 'airbnb',
      source: 'seed',
      shopId: null,
      title: 'Airbnb',
      summary: 'Belong anywhere.',
      category: 'travel',
      designMd: '# Airbnb\n\nBelong anywhere.',
      previewHtml: '<html>light</html>',
      previewDarkHtml: '<html>dark</html>',
      previewHtmlUrl: null,
      previewDarkHtmlUrl: null,
      thumbnailUrl: null,
      storageTier: 'hot',
      sourceThemeId: null,
      sourceCloneJobId: null,
      upstreamSha: '80bbbc2',
      createdAt: '2026-04-18T00:00:00.000Z',
      updatedAt: '2026-04-18T00:00:00.000Z',
    })
  })
})

// ---------------------------------------------------------------------------
// getEntryById
// ---------------------------------------------------------------------------

describe('getEntryById', () => {
  it('returns null when id not found', async () => {
    const { db } = fakeDb({ row: undefined })
    const entry = await getEntryById(db as any, 'missing')
    expect(entry).toBeNull()
  })

  it('queries by exact id and does not constrain source', async () => {
    const { db, calls } = fakeDb({ row: undefined })
    await getEntryById(db as any, 'u-42')
    expect(
      calls.some(
        (c) => c.method === 'where' && c.args[0] === 'id' && c.args[2] === 'u-42',
      ),
    ).toBe(true)
    // Must NOT add a source filter — the id is globally unique.
    expect(
      calls.some(
        (c) => c.method === 'where' && c.args[0] === 'source',
      ),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Count helpers
// ---------------------------------------------------------------------------

describe('countSeedEntries', () => {
  it('returns 0 for empty table', async () => {
    const { db } = fakeDb({ row: undefined })
    const count = await countSeedEntries(db as any)
    expect(count).toBe(0)
  })

  it('coerces string counts (pg returns numeric as string) to number', async () => {
    const { db } = fakeDb({ row: { c: '58' } })
    const count = await countSeedEntries(db as any)
    expect(count).toBe(58)
  })
})

describe('countSeedEntriesByCategory', () => {
  it('returns all buckets at zero when table is empty', async () => {
    const { db } = fakeDb({ rows: [] })
    const counts = await countSeedEntriesByCategory(db as any)
    expect(counts).toEqual({
      ecom: 0,
      ai: 0,
      devtool: 0,
      saas: 0,
      media: 0,
      finance: 0,
      social: 0,
      travel: 0,
      lifestyle: 0,
    })
  })

  it('merges grouped rows into the full bucket shape', async () => {
    const { db } = fakeDb({
      rows: [
        { category: 'ai', c: 13 },
        { category: 'devtool', c: 21 },
        { category: 'saas', c: 7 },
      ],
    })
    const counts = await countSeedEntriesByCategory(db as any)
    expect(counts.ai).toBe(13)
    expect(counts.devtool).toBe(21)
    expect(counts.saas).toBe(7)
    // Unset buckets default to 0 (rather than undefined).
    expect(counts.finance).toBe(0)
  })
})
