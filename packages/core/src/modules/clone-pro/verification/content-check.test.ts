/**
 * Clone Pro v4 — Content Completeness Check tests
 *
 * The check compares expected counts (derived from discovered pages
 * grouped by pageType) against actual counts read from the DB via
 * `db.selectFrom(table).select(countAll).where('shop_id', =, X).executeTakeFirst()`.
 *
 * We stub Kysely with a tiny chainable object that returns the count
 * for the right table name — no real DB required.
 */

import { describe, it, expect } from 'vitest'
import { runContentCheck } from './content-check.js'
import type { DiscoveredPage, PageType } from '../discovery/deep-crawler.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePage(pageType: PageType): DiscoveredPage {
  return {
    url: `https://example.com/${pageType}`,
    title: pageType,
    pageType,
    statusCode: 200,
    html: '<html></html>',
    outLinks: [],
    depth: 1,
  }
}

interface StubCounts {
  pages?: number
  blog_posts?: number
  collections?: number
}

/**
 * Build a minimal Kysely stub whose `selectFrom(table)` returns a
 * chainable that eventually yields `{ c: String(count) }` — matching the
 * Postgres bigint-as-string convention our code handles.
 */
function stubDb(counts: StubCounts): any {
  return {
    selectFrom(table: string) {
      const raw = (counts as Record<string, number | undefined>)[table]
      const count = raw ?? 0
      const chain: any = {
        select: () => chain,
        where: () => chain,
        executeTakeFirst: async () => ({ c: String(count) }),
      }
      return chain
    },
  }
}

const EXEC_STATS = {
  pagesImported: 0,
  blogPostsImported: 0,
  collectionsImported: 0,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runContentCheck', () => {
  it('returns 100 and info finding when no pages/blog/collections were discovered', async () => {
    const result = await runContentCheck({
      db: stubDb({}),
      shopId: 'shop_a',
      discoveredPages: [makePage('home'), makePage('product')], // neither type is counted
      executionStats: EXEC_STATS,
    })
    expect(result.score).toBe(100)
    expect(result.passed).toBe(true)
    expect(result.findings[0].severity).toBe('info')
    expect(result.findings[0].message.toLowerCase()).toContain('skipped')
  })

  it('returns 100 when every discovered page/blog/collection persisted', async () => {
    const pages = [
      makePage('page'),
      makePage('page'),
      makePage('blog-post'),
      makePage('collection'),
    ]
    // Expected: 2 pages, 1 blog, 1 collection — DB has all.
    const result = await runContentCheck({
      db: stubDb({ pages: 2, blog_posts: 1, collections: 1 }),
      shopId: 'shop_a',
      discoveredPages: pages,
      executionStats: EXEC_STATS,
    })
    expect(result.score).toBe(100)
    expect(result.passed).toBe(true)
    // Every finding should be info, no errors.
    expect(result.findings.every((f) => f.severity === 'info')).toBe(true)
  })

  it('emits error severity when more than half of pages are missing', async () => {
    // 4 pages expected, DB only has 1 → 3/4 missing = 75% gap → error.
    const pages = [
      makePage('page'),
      makePage('page'),
      makePage('page'),
      makePage('page'),
    ]
    const result = await runContentCheck({
      db: stubDb({ pages: 1 }),
      shopId: 'shop_a',
      discoveredPages: pages,
      executionStats: EXEC_STATS,
    })
    expect(result.findings.some(
      (f) => f.severity === 'error' && f.message.toLowerCase().includes('pages'),
    )).toBe(true)
    expect(result.passed).toBe(false)
  })

  it('emits warning severity when gap is between 20%–50%', async () => {
    // 5 pages expected, DB has 4 → 1/5 = 20% gap → warning.
    const pages = [
      makePage('page'),
      makePage('page'),
      makePage('page'),
      makePage('page'),
      makePage('page'),
    ]
    const result = await runContentCheck({
      db: stubDb({ pages: 4 }),
      shopId: 'shop_a',
      discoveredPages: pages,
      executionStats: EXEC_STATS,
    })
    expect(result.findings.some(
      (f) => f.severity === 'warning' && f.message.toLowerCase().includes('pages'),
    )).toBe(true)
  })

  it('counts policy pages alongside regular pages', async () => {
    // policy should roll into the pages bucket (per content-check.ts logic).
    const pages = [makePage('page'), makePage('policy'), makePage('policy')]
    const result = await runContentCheck({
      db: stubDb({ pages: 3 }),
      shopId: 'shop_a',
      discoveredPages: pages,
      executionStats: EXEC_STATS,
    })
    expect(result.score).toBe(100)
    expect(result.passed).toBe(true)
  })

  it('averages per-type ratios evenly (not weighted by count)', async () => {
    // 10 pages expected, 10 persisted = 100%
    // 1 blog expected, 0 persisted = 0%
    // Avg = 50 → score 50, passed false (needs ≥85 AND no errors).
    const pages = [
      ...Array.from({ length: 10 }, () => makePage('page')),
      makePage('blog-post'),
    ]
    const result = await runContentCheck({
      db: stubDb({ pages: 10, blog_posts: 0 }),
      shopId: 'shop_a',
      discoveredPages: pages,
      executionStats: EXEC_STATS,
    })
    expect(result.score).toBe(50)
    expect(result.passed).toBe(false)
  })

  it('handles numeric count values in addition to stringified bigints', async () => {
    // Kysely returns bigints as strings on Postgres; some adapters hand back
    // numbers directly. parseCount handles both — prove it.
    const db: any = {
      selectFrom(table: string) {
        const count = table === 'pages' ? 2 : 0 // raw number, not string
        const chain: any = {
          select: () => chain,
          where: () => chain,
          executeTakeFirst: async () => ({ c: count }),
        }
        return chain
      },
    }
    const result = await runContentCheck({
      db,
      shopId: 'shop_a',
      discoveredPages: [makePage('page'), makePage('page')],
      executionStats: EXEC_STATS,
    })
    expect(result.score).toBe(100)
  })

  it('treats DB count > expected as no gap (not negative score)', async () => {
    // DB has more rows than we discovered (maybe hand-authored content)
    // — the ratio is clamped to 1.0; overall score 100; all findings info.
    const result = await runContentCheck({
      db: stubDb({ pages: 50 }),
      shopId: 'shop_a',
      discoveredPages: [makePage('page')],
      executionStats: EXEC_STATS,
    })
    expect(result.score).toBe(100)
    expect(result.findings.every((f) => f.severity === 'info')).toBe(true)
  })

  it('passes at the 85% threshold boundary', async () => {
    // 10 pages expected, 9 persisted = 90% — above threshold, no errors.
    const pages = Array.from({ length: 10 }, () => makePage('page'))
    const result = await runContentCheck({
      db: stubDb({ pages: 9 }),
      shopId: 'shop_a',
      discoveredPages: pages,
      executionStats: EXEC_STATS,
    })
    expect(result.score).toBe(90)
    // 1/10 = 10% gap → info severity (below 20%), no errors.
    expect(result.findings.every((f) => f.severity === 'info')).toBe(true)
    expect(result.passed).toBe(true)
  })
})
