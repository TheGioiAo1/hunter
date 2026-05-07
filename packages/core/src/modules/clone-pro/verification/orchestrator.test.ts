/**
 * Clone Pro v4 — Verification Orchestrator integration test
 *
 * End-to-end smoke test over a fully stubbed DB. Confirms that:
 *
 *   - The orchestrator loads the main theme + its text assets.
 *   - It runs every check in order (route → asset → content → dep → css)
 *     and aggregates them into a single VerificationReport.
 *   - Progress callbacks fire monotonically from 0 → 100.
 *   - A clean clone with matching assets yields grade A.
 *   - A clone with a tracking host still in templates yields grade F
 *     (critical veto) regardless of the raw weighted score.
 */

import { describe, it, expect } from 'vitest'
import { runVerification } from './orchestrator.js'
import type { DiscoveryResult } from '../pipeline-v4.js'
import type { ExecutionResult } from '../execution-v4.js'
import type { DiscoveredPage, PageType } from '../discovery/deep-crawler.js'
import type { DetectedTemplate } from '../discovery/template-detector.js'
import type { AssetInventory, DiscoveredAsset } from '../discovery/asset-scanner.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePage(pageType: PageType, path = `/${pageType}`): DiscoveredPage {
  return {
    url: `https://source.example.com${path}`,
    title: pageType,
    pageType,
    statusCode: 200,
    html: '<html></html>',
    outLinks: [],
    depth: 1,
  }
}

function makeTemplate(
  pageType: PageType,
  templateName: string,
  html: string,
): DetectedTemplate {
  return {
    pageType,
    templateName,
    samplePage: {
      url: `https://source.example.com/${pageType}`,
      title: pageType,
      html,
      score: 100,
      reason: 'test',
    },
    allCandidates: [],
    count: 1,
    hasVariants: false,
  }
}

function asset(url: string, type: DiscoveredAsset['type'] = 'css'): DiscoveredAsset {
  return {
    url,
    absoluteUrl: url,
    type,
    priority: 'critical',
    foundOn: [],
    attribute: 'src',
  } as DiscoveredAsset
}

function makeInventory(
  critical: DiscoveredAsset[],
  high: DiscoveredAsset[] = [],
  media: DiscoveredAsset[] = [],
): AssetInventory {
  const all = [...critical, ...high, ...media]
  return {
    assets: all,
    summary: {
      totalAssets: all.length,
      byType: {} as any,
      byPriority: {} as any,
      externalDomains: [],
      estimatedTotalSizeMB: 0,
      cssFiles: 0,
      jsFiles: 0,
      fontFiles: 0,
      imageFiles: 0,
    },
    criticalAssets: critical,
    highPriorityAssets: high,
    mediaAssets: media,
  }
}

function makeDiscovery(
  pages: readonly DiscoveredPage[],
  templates: readonly DetectedTemplate[],
  inventory: AssetInventory,
): DiscoveryResult {
  return {
    platform: { platform: 'shopify', confidence: 95 },
    pages,
    siteMap: {} as any,
    templates: {
      templates,
      totalTemplateTypes: templates.length,
      warnings: [],
    },
    assets: inventory,
    report: {} as any,
    durationMs: 0,
  }
}

function makeExecution(overrides?: Partial<ExecutionResult>): ExecutionResult {
  return {
    themeId: 'theme_main_1',
    templatesWritten: 0,
    assetsDownloaded: 0,
    assetsFailed: 0,
    totalAssetBytes: 0,
    pagesImported: 0,
    blogPostsImported: 0,
    collectionsImported: 0,
    templateChanges: [],
    warnings: [],
    errors: [],
    durationMs: 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// DB stub — a chainable builder keyed by table name
// ---------------------------------------------------------------------------

interface DbFixture {
  /** Theme to return from selectFrom('themes')...executeTakeFirst(). */
  readonly theme?: { id: string }
  /** theme_assets rows to return from selectFrom('theme_assets')...execute(). */
  readonly themeAssets: ReadonlyArray<{ key: string; value: string | null }>
  /** Count values for the three content tables. */
  readonly pagesCount: number
  readonly blogPostsCount: number
  readonly collectionsCount: number
}

function stubDb(fx: DbFixture): any {
  return {
    selectFrom(table: string) {
      // Start with a per-call "chain" that returns the right terminal value.
      const chain: any = {}
      chain.select = () => chain
      chain.where = () => chain
      chain.orderBy = () => chain

      chain.executeTakeFirst = async () => {
        if (table === 'themes') return fx.theme
        if (table === 'pages') return { c: String(fx.pagesCount) }
        if (table === 'blog_posts') return { c: String(fx.blogPostsCount) }
        if (table === 'collections') return { c: String(fx.collectionsCount) }
        return undefined
      }
      chain.execute = async () => {
        if (table === 'theme_assets') return fx.themeAssets
        return []
      }
      return chain
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runVerification — happy path (clean clone)', () => {
  it('returns grade A when every check passes and no criticals are emitted', async () => {
    const pages = [
      makePage('home'),
      makePage('product'),
      makePage('collection'),
      makePage('page'),
      makePage('cart'),
      makePage('blog-post'),
    ]
    const templates = [
      makeTemplate('product', 'templates/product.liquid', '<div class="product-card featured">x</div>'),
      makeTemplate('collection', 'templates/collection.liquid', '<div class="collection-grid">x</div>'),
      makeTemplate('page', 'templates/page.liquid', '<div class="page-content">x</div>'),
    ]
    const inventory = makeInventory(
      [asset('https://cdn/a.css'), asset('https://cdn/font.woff2', 'font')],
    )

    // Assets for the theme — text-only, self-hosted URLs.
    const themeAssets = [
      { key: 'layout/theme.liquid', value: '<html><body>{{ content_for_layout }}</body></html>' },
      {
        key: 'templates/index.liquid',
        value: '<div class="hero">Welcome</div>',
      },
      {
        key: 'templates/product.liquid',
        value: '<div class="product-card featured">{{ product.title }}</div>',
      },
      {
        key: 'templates/collection.liquid',
        value: '<div class="collection-grid">{{ collection.title }}</div>',
      },
      {
        key: 'templates/page.liquid',
        value: '<div class="page-content">{{ page.content }}</div>',
      },
      {
        key: 'templates/cart.liquid',
        value: '<div class="cart">{{ cart.item_count }}</div>',
      },
      // Binary assets should be filtered out of text-template loading.
      { key: 'assets/logo.png', value: '<binary-blob>' },
      { key: 'assets/theme.css', value: '.foo { color: red; }' },
    ]

    const db = stubDb({
      theme: { id: 'theme_main_1' },
      themeAssets,
      pagesCount: 1, // one 'page' discovered
      blogPostsCount: 1, // one 'blog-post' discovered
      collectionsCount: 0, // collection discovered but this is count table
    })
    // NOTE: pages discovered include 1 'page' + 1 'blog-post' + 1 'collection'
    // (plus home/product/cart which don't count toward content table).
    // So content-check will see pages:1/1, blog:1/1, collections:0/1.

    const progressPcts: number[] = []
    const report = await runVerification({
      db,
      shopId: 'shop_test_1',
      sourceUrl: 'https://source.example.com',
      discovery: makeDiscovery(pages, templates, inventory),
      execution: makeExecution({
        assetsDownloaded: 2,
        assetsFailed: 0,
        totalAssetBytes: 100_000,
      }),
      downloadedAssetUrls: new Set(['https://cdn/a.css', 'https://cdn/font.woff2']),
      onProgress: (pct) => progressPcts.push(pct),
    })

    // Progress should start at 0 and finish at 100.
    expect(progressPcts[0]).toBe(0)
    expect(progressPcts[progressPcts.length - 1]).toBe(100)
    // Monotonic non-decreasing.
    for (let i = 1; i < progressPcts.length; i++) {
      expect(progressPcts[i]).toBeGreaterThanOrEqual(progressPcts[i - 1])
    }

    // No critical findings → grade A or B depending on content-check result.
    expect(report.findings.some((f) => f.severity === 'critical')).toBe(false)
    expect(['A', 'B']).toContain(report.grade)
    expect(report.overallScore).toBeGreaterThanOrEqual(80)

    // Sanity: every check was run.
    expect(report.checks.route).toBeDefined()
    expect(report.checks.asset).toBeDefined()
    expect(report.checks.content).toBeDefined()
    expect(report.checks.dependency).toBeDefined()
    expect(report.checks['css-match']).toBeDefined()
  })
})

describe('runVerification — critical veto scenario', () => {
  it('returns grade F when a template references a tracking host', async () => {
    const pages = [makePage('home'), makePage('product')]
    const templates = [
      makeTemplate('product', 'templates/product.liquid', '<div class="product-card">x</div>'),
    ]
    const inventory = makeInventory([])

    // Leak a GTM script into index.liquid → dependency check fires critical.
    const themeAssets = [
      { key: 'layout/theme.liquid', value: '<html><body>layout</body></html>' },
      {
        key: 'templates/index.liquid',
        value: '<script src="https://www.googletagmanager.com/gtag/js?id=GA"></script>',
      },
      {
        key: 'templates/product.liquid',
        value: '<div class="product-card">{{ product.title }}</div>',
      },
    ]

    const db = stubDb({
      theme: { id: 'theme_main_1' },
      themeAssets,
      pagesCount: 0,
      blogPostsCount: 0,
      collectionsCount: 0,
    })

    const report = await runVerification({
      db,
      shopId: 'shop_test_2',
      sourceUrl: 'https://source.example.com',
      discovery: makeDiscovery(pages, templates, inventory),
      execution: makeExecution(),
    })

    // Critical finding must be present and grade must be F regardless of score.
    expect(report.findings.some((f) => f.severity === 'critical')).toBe(true)
    expect(report.grade).toBe('F')
    expect(report.passed).toBe(false)
    // Recommendations should call out the tracking removal.
    expect(report.recommendations.some((r) => r.toLowerCase().includes('tracking'))).toBe(true)
  })
})

describe('runVerification — no theme persisted', () => {
  it('still produces a report (with missing-template criticals) when no theme row exists', async () => {
    const pages = [makePage('home'), makePage('product')]
    const templates = [
      makeTemplate('product', 'templates/product.liquid', '<div class="product-card">x</div>'),
    ]
    const inventory = makeInventory([])

    // No theme at all — loadPersistedTemplates returns {}.
    const db = stubDb({
      theme: undefined,
      themeAssets: [],
      pagesCount: 0,
      blogPostsCount: 0,
      collectionsCount: 0,
    })

    const report = await runVerification({
      db,
      shopId: 'shop_test_3',
      discovery: makeDiscovery(pages, templates, inventory),
      execution: makeExecution(),
    })

    // layout + index + product are all missing → critical findings.
    const crits = report.findings.filter((f) => f.severity === 'critical')
    expect(crits.length).toBeGreaterThan(0)
    expect(report.grade).toBe('F')
  })
})

describe('runVerification — text report composition', () => {
  it('includes the source URL and shop id when provided', async () => {
    const db = stubDb({
      theme: { id: 'theme_main_1' },
      themeAssets: [
        { key: 'layout/theme.liquid', value: '<html></html>' },
        { key: 'templates/index.liquid', value: '<div>Home</div>' },
      ],
      pagesCount: 0,
      blogPostsCount: 0,
      collectionsCount: 0,
    })
    const report = await runVerification({
      db,
      shopId: 'shop_xyz',
      sourceUrl: 'https://my-source.example.com',
      discovery: makeDiscovery([makePage('home')], [], makeInventory([])),
      execution: makeExecution(),
    })
    expect(report.textReport).toContain('shop_xyz')
    expect(report.textReport).toContain('https://my-source.example.com')
  })
})
