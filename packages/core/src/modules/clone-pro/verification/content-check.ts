/**
 * Clone Pro v4 — Content Completeness Check (Phase 3.3)
 *
 * Verifies that the pages/blog-posts/collections surfaced by discovery
 * actually landed in the database. Useful for catching silent persist
 * failures where Phase 2 reported success but the persister's try/catch
 * swallowed the actual insert.
 *
 * We read row counts directly from the DB, keyed by shop_id, and compare
 * against `expected` counts from discovery. A slight discrepancy is
 * expected (duplicate slugs collapse to one row, fragments collapse to
 * base URLs) so we pass as long as we're within a small tolerance.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { DiscoveredPage } from '../discovery/deep-crawler.js'
import type { CheckResult, Finding } from './types.js'

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface ContentCheckInput {
  readonly db: Kysely<Database>
  readonly shopId: string
  readonly discoveredPages: readonly DiscoveredPage[]
  /** Tally from Phase 2 execution — used as a secondary reference. */
  readonly executionStats: {
    readonly pagesImported: number
    readonly blogPostsImported: number
    readonly collectionsImported: number
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runContentCheck(input: ContentCheckInput): Promise<CheckResult> {
  const started = Date.now()
  const findings: Finding[] = []

  const expected = countExpected(input.discoveredPages)
  const actual = await countActual(input.db, input.shopId)

  const pagesGap = expected.pages - actual.pages
  const blogGap = expected.blog - actual.blog
  const collGap = expected.collections - actual.collections

  // ── Emit findings for each content type ────────────────────────────
  if (expected.pages > 0) {
    const sev = severityForGap(pagesGap, expected.pages)
    findings.push({
      category: 'content',
      severity: sev,
      message: `Pages: ${actual.pages}/${expected.pages} persisted${pagesGap > 0 ? ` (${pagesGap} missing)` : ''}.`,
      context: { expected: expected.pages, actual: actual.pages, gap: pagesGap },
    })
  }
  if (expected.blog > 0) {
    const sev = severityForGap(blogGap, expected.blog)
    findings.push({
      category: 'content',
      severity: sev,
      message: `Blog posts: ${actual.blog}/${expected.blog} persisted${blogGap > 0 ? ` (${blogGap} missing)` : ''}.`,
      context: { expected: expected.blog, actual: actual.blog, gap: blogGap },
    })
  }
  if (expected.collections > 0) {
    const sev = severityForGap(collGap, expected.collections)
    findings.push({
      category: 'content',
      severity: sev,
      message: `Collections: ${actual.collections}/${expected.collections} persisted${collGap > 0 ? ` (${collGap} missing)` : ''}.`,
      context: {
        expected: expected.collections,
        actual: actual.collections,
        gap: collGap,
      },
    })
  }

  if (expected.pages === 0 && expected.blog === 0 && expected.collections === 0) {
    findings.push({
      category: 'content',
      severity: 'info',
      message: 'No pages, blog posts, or collections discovered — content check skipped.',
    })
    return {
      category: 'content',
      score: 100,
      passed: true,
      summary: 'No content to verify.',
      findings,
      durationMs: Date.now() - started,
    }
  }

  // ── Scoring — average of per-type ratios, weighted equally ─────────
  const ratios: number[] = []
  if (expected.pages > 0) ratios.push(Math.max(0, Math.min(1, actual.pages / expected.pages)))
  if (expected.blog > 0) ratios.push(Math.max(0, Math.min(1, actual.blog / expected.blog)))
  if (expected.collections > 0) ratios.push(Math.max(0, Math.min(1, actual.collections / expected.collections)))
  const avgRatio = ratios.length === 0 ? 1 : ratios.reduce((a, b) => a + b, 0) / ratios.length
  const score = Math.round(avgRatio * 100)

  // Pass if no errors and ≥ 85% of expected content persisted.
  const hasError = findings.some((f) => f.severity === 'error' || f.severity === 'critical')
  const passed = !hasError && score >= 85

  const summary = `Content: ${actual.pages + actual.blog + actual.collections}/${expected.pages + expected.blog + expected.collections} rows persisted (${score}%).`

  return {
    category: 'content',
    score,
    passed,
    summary,
    findings,
    durationMs: Date.now() - started,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Counts {
  pages: number
  blog: number
  collections: number
}

function countExpected(pages: readonly DiscoveredPage[]): Counts {
  const c: Counts = { pages: 0, blog: 0, collections: 0 }
  for (const p of pages) {
    if (p.pageType === 'page' || p.pageType === 'policy') c.pages++
    else if (p.pageType === 'blog-post') c.blog++
    else if (p.pageType === 'collection') c.collections++
  }
  return c
}

async function countActual(db: Kysely<Database>, shopId: string): Promise<Counts> {
  // We select with an explicit count alias and read the first row. Kysely
  // returns strings for bigint counts on Postgres — parseInt to normalise.
  const pagesRow = await db
    .selectFrom('pages')
    .select((eb) => eb.fn.countAll<string>().as('c'))
    .where('shop_id', '=', shopId)
    .executeTakeFirst()

  const blogRow = await db
    .selectFrom('blog_posts')
    .select((eb) => eb.fn.countAll<string>().as('c'))
    .where('shop_id', '=', shopId)
    .executeTakeFirst()

  const collRow = await db
    .selectFrom('collections')
    .select((eb) => eb.fn.countAll<string>().as('c'))
    .where('shop_id', '=', shopId)
    .executeTakeFirst()

  return {
    pages: parseCount(pagesRow?.c),
    blog: parseCount(blogRow?.c),
    collections: parseCount(collRow?.c),
  }
}

function parseCount(v: unknown): number {
  if (v == null) return 0
  if (typeof v === 'number') return v
  const parsed = parseInt(String(v), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function severityForGap(gap: number, expected: number): Finding['severity'] {
  if (gap <= 0) return 'info'
  const ratio = gap / expected
  if (ratio >= 0.5) return 'error'
  if (ratio >= 0.2) return 'warning'
  return 'info'
}
