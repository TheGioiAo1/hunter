/**
 * Clone Pro v7 — orchestrator unit tests.
 *
 * Sprint 2 Task 2.6. The v7 orchestrator is a 1:1 copy of v6's
 * `runCloneProV6` with one substitution: Stage 4 replaces the AI
 * Sonnet bucket scrapers with the Lonspy XPath bulk crawler.
 * Stages 1-3 + 5-12 still call into the v6 stages wholesale (DRY).
 *
 * Tests cover:
 *   - happy path (all stages succeed; runStage4Lonspy returns DTOs)
 *   - quality gate failure surfaces as a hard abort
 *   - shape of the result mirrors v6 RunV6Result with stage4 swapped
 *     to include rowsHarvested/rowsFailed/qualityScore.
 */

import { describe, it, expect, vi } from 'vitest'
import { runCloneProV7 } from './orchestrator.js'
import { QualityBelowThresholdError } from './stages/stage4-lonspy-bulk.js'

function makeFakeDb(): any {
  let nextId = 0
  return {
    insertInto: () => ({
      values: (rows: any) => ({
        execute: async () => {},
        returningAll: () => ({
          execute: async () =>
            Array.isArray(rows)
              ? rows.map((r: any) => ({ ...r, id: `id-${nextId++}` }))
              : [{ ...rows, id: `id-${nextId++}` }],
        }),
      }),
    }),
    updateTable: () => ({
      set: () => ({
        where: () => ({ execute: async () => {} }),
      }),
    }),
    selectFrom: () => ({
      where: () => ({
        select: () => ({
          execute: async () => [],
          executeTakeFirst: async () => null,
        }),
      }),
      select: () => ({
        where: () => ({ execute: async () => [] }),
      }),
    }),
  }
}

function makeBaseDeps() {
  return {
    discoverUrls: vi.fn().mockResolvedValue({
      urls: [
        { sourceUrl: 'https://shop.com/', discoveredVia: 'sitemap', depth: 0 },
      ],
      sitemapFound: true,
    }),
    classifyUrls: vi.fn().mockResolvedValue({ 'https://shop.com/': 'page' }),
    renderUrls: vi.fn().mockResolvedValue([
      {
        queueId: 'id-0',
        sourceUrl: 'https://shop.com/',
        html: '<html></html>',
        screenshotSha1: null,
        assetUrls: [],
        viewportWidth: 1280,
        viewportHeight: 720,
      },
    ]),
    runStage4Lonspy: vi.fn().mockResolvedValue({
      products: [{ sourceHandle: 'p1', title: 'P1', images: [], variants: [] }],
      collections: [],
      pages: [],
      warnings: [],
      qualityScore: 1,
      rowsHarvested: 1,
      rowsFailed: 0,
    }),
    buildAssetGraph: vi.fn().mockReturnValue([]),
    downloadAssets: vi.fn().mockResolvedValue({
      downloaded: 0,
      skipped: 0,
      failed: 0,
      aborted: false,
    }),
    runPersisters: vi.fn().mockResolvedValue({
      bucketFailures: [],
      products: { inserted: 1 },
      collections: { inserted: 0 },
      pages: { inserted: 0 },
      blogPosts: { inserted: 0 },
      menus: { inserted: 0 },
      themeTokens: null,
      themeFiles: null,
      urlRedirects: null,
      genericMedia: null,
    }),
    applyRewriter: vi.fn().mockResolvedValue({ rowsRewritten: 0 }),
    verifyNoLeaks: vi.fn().mockResolvedValue({ ok: true, totalLeaks: 0, leaks: [] }),
    runVerification: vi.fn().mockResolvedValue({
      pixelDiffPct: 0,
      cardinality: { ok: true, overallPct: 100, productsPct: 100 },
      reachability: { totalAssets: 0, ok: 0, notFound: 0 },
    }),
    computeGrade: vi.fn().mockReturnValue({ letter: 'A', score: 95, perCheck: {} }),
    autoPublish: vi.fn().mockResolvedValue({ published: true }),
    finalize: vi.fn().mockResolvedValue(undefined),
    emitProgress: vi.fn().mockResolvedValue(undefined),
    emitStage: vi.fn().mockResolvedValue(undefined),
  }
}

describe('runCloneProV7', () => {
  it('runs all 12 stages on happy path', async () => {
    const deps = makeBaseDeps()
    const result = await runCloneProV7({
      jobId: 'job-1',
      shopId: 'shop-1',
      sourceUrl: 'https://shop.com',
      productsLimit: 200,
      deps: { db: makeFakeDb(), ...deps },
    })
    expect(result.stage1.urlsDiscovered).toBe(1)
    expect(result.stage4.products).toBe(1)
    expect(result.stage4.qualityScore).toBe(1)
    expect(result.stage10.letter).toBe('A')
    expect(deps.runStage4Lonspy).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        sourceUrl: 'https://shop.com',
        productsLimit: 200,
      }),
    )
  })

  it('passes products_limit through to Stage 4', async () => {
    const deps = makeBaseDeps()
    await runCloneProV7({
      jobId: 'job-2',
      shopId: 'shop-1',
      sourceUrl: 'https://shop.com',
      productsLimit: 50,
      deps: { db: makeFakeDb(), ...deps },
    })
    expect(deps.runStage4Lonspy).toHaveBeenCalledWith(
      expect.objectContaining({ productsLimit: 50 }),
    )
  })

  it('passes null products_limit (full crawl)', async () => {
    const deps = makeBaseDeps()
    await runCloneProV7({
      jobId: 'job-3',
      shopId: 'shop-1',
      sourceUrl: 'https://shop.com',
      productsLimit: null,
      deps: { db: makeFakeDb(), ...deps },
    })
    expect(deps.runStage4Lonspy).toHaveBeenCalledWith(
      expect.objectContaining({ productsLimit: null }),
    )
  })

  it('aborts on Stage 1 zero URLs', async () => {
    const deps = makeBaseDeps()
    deps.discoverUrls = vi.fn().mockResolvedValue({ urls: [], sitemapFound: false })
    await expect(
      runCloneProV7({
        jobId: 'job-4',
        shopId: 'shop-1',
        sourceUrl: 'https://shop.com',
        productsLimit: 200,
        deps: { db: makeFakeDb(), ...deps },
      }),
    ).rejects.toThrow(/Stage 1/)
  })

  it('propagates QualityBelowThresholdError from Stage 4', async () => {
    const deps = makeBaseDeps()
    deps.runStage4Lonspy = vi
      .fn()
      .mockRejectedValue(new QualityBelowThresholdError(0.5, 0.95))
    await expect(
      runCloneProV7({
        jobId: 'job-5',
        shopId: 'shop-1',
        sourceUrl: 'https://shop.com',
        productsLimit: 200,
        deps: { db: makeFakeDb(), ...deps },
      }),
    ).rejects.toBeInstanceOf(QualityBelowThresholdError)
  })

  it('aborts when Stage 6 reports aborted=true', async () => {
    const deps = makeBaseDeps()
    deps.downloadAssets = vi.fn().mockResolvedValue({
      downloaded: 0,
      skipped: 0,
      failed: 99,
      aborted: true,
    })
    await expect(
      runCloneProV7({
        jobId: 'job-6',
        shopId: 'shop-1',
        sourceUrl: 'https://shop.com',
        productsLimit: 200,
        deps: { db: makeFakeDb(), ...deps },
      }),
    ).rejects.toThrow(/Stage 6/)
  })

  it('aborts when Stage 8 grep gate finds source-domain leaks', async () => {
    const deps = makeBaseDeps()
    deps.verifyNoLeaks = vi.fn().mockResolvedValue({
      ok: false,
      totalLeaks: 3,
      leaks: [],
    })
    await expect(
      runCloneProV7({
        jobId: 'job-7',
        shopId: 'shop-1',
        sourceUrl: 'https://shop.com',
        productsLimit: 200,
        deps: { db: makeFakeDb(), ...deps },
      }),
    ).rejects.toThrow(/grep gate/)
  })

  it('emits progress in monotonically increasing order', async () => {
    const deps = makeBaseDeps()
    const progressCalls: number[] = []
    deps.emitProgress = vi
      .fn()
      .mockImplementation(async (_jobId: string, pct: number) => {
        progressCalls.push(pct)
      })
    await runCloneProV7({
      jobId: 'job-8',
      shopId: 'shop-1',
      sourceUrl: 'https://shop.com',
      productsLimit: 200,
      deps: { db: makeFakeDb(), ...deps },
    })
    for (let i = 1; i < progressCalls.length; i++) {
      expect(progressCalls[i]).toBeGreaterThanOrEqual(progressCalls[i - 1])
    }
    // Ends at 100
    expect(progressCalls[progressCalls.length - 1]).toBe(100)
  })

  it('finalizes with the v7 grade letter', async () => {
    const deps = makeBaseDeps()
    deps.computeGrade = vi.fn().mockReturnValue({ letter: 'B', score: 80, perCheck: {} })
    const result = await runCloneProV7({
      jobId: 'job-9',
      shopId: 'shop-1',
      sourceUrl: 'https://shop.com',
      productsLimit: 200,
      deps: { db: makeFakeDb(), ...deps },
    })
    expect(result.stage10.letter).toBe('B')
    expect(deps.finalize).toHaveBeenCalled()
  })

  it('passes sourceUrl host to Stage 8 path rewriter', async () => {
    const deps = makeBaseDeps()
    await runCloneProV7({
      jobId: 'job-10',
      shopId: 'shop-1',
      sourceUrl: 'https://example.com/shop',
      productsLimit: null,
      deps: { db: makeFakeDb(), ...deps },
    })
    expect(deps.applyRewriter).toHaveBeenCalledWith(
      expect.objectContaining({ sourceHost: 'example.com' }),
    )
  })
})
