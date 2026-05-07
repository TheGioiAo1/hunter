/**
 * Clone Pro v6 — orchestrator unit tests (Sprint 1 + Sprint 4 Batch 3)
 *
 * Covers:
 *   1. Happy path — full pipeline Stages 1-12 (all succeed, DB written).
 *   2. Stage 1 zero-URL abort — classifyUrls + renderUrls never called.
 */

import { describe, it, expect, vi } from 'vitest'
import { runCloneProV6 } from './orchestrator.js'

// ---------------------------------------------------------------------------
// Minimal fakeDb (mimics Kysely builder chain)
// ---------------------------------------------------------------------------

function makeFakeDb(): any {
  let nextId = 0
  return {
    insertInto: (_table: string) => ({
      values: (rows: any) => ({
        execute: async () => { /* persisted */ },
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
        where: () => ({
          execute: async () => {},
        }),
      }),
    }),
    selectFrom: () => ({
      where: () => ({
        select: () => ({
          execute: async () => [],
          executeTakeFirst: async () => ({ domain: 'example.gbox.co' }),
        }),
      }),
      select: () => ({
        where: () => ({
          execute: async () => [],
        }),
      }),
    }),
  }
}

// ---------------------------------------------------------------------------
// Shared stage 4-12 dep mocks
// ---------------------------------------------------------------------------

function makeStages4to12Deps() {
  return {
    dispatchScrapers: vi.fn().mockResolvedValue({
      products: [{ handle: 'product-a' }],
      collections: [],
      pages: [],
      blogPosts: [],
      menu: null,
      themeTokens: null,
    }),
    buildAssetGraph: vi.fn().mockReturnValue([]),
    downloadAssets: vi.fn().mockResolvedValue({
      downloaded: 1,
      skipped: 0,
      failed: 0,
      aborted: false,
    }),
    runPersisters: vi.fn().mockResolvedValue({
      bucketFailures: [],
      products: { inserted: 1, updated: 0, skippedEdited: 0, errors: [] },
      collections: { inserted: 0, updated: 0, skippedEdited: 0, errors: [] },
      pages: { inserted: 0, updated: 0, skippedEdited: 0, errors: [] },
      blogPosts: { inserted: 0, updated: 0, skippedEdited: 0, errors: [] },
      menus: { inserted: 0, updated: 0, skippedEdited: 0, errors: [] },
      themeTokens: { inserted: 0, updated: 0, skippedEdited: 0, errors: [] },
      themeFiles: { inserted: 0, updated: 0, skippedEdited: 0, errors: [] },
      urlRedirects: { inserted: 0, updated: 0, skippedEdited: 0, errors: [] },
      genericMedia: { inserted: 0, updated: 0, skippedEdited: 0, errors: [] },
    }),
    applyRewriter: vi.fn().mockResolvedValue({ rowsRewritten: 5 }),
    verifyNoLeaks: vi.fn().mockResolvedValue({ ok: true, totalLeaks: 0, leaks: [] }),
    runVerification: vi.fn().mockResolvedValue({
      pixelDiffPct: 1.5,
      cardinality: { ok: true, overallPct: 100, productsPct: 100 },
      reachability: { totalAssets: 10, ok: 10, notFound: 0 },
    }),
    computeGrade: vi.fn().mockReturnValue({ letter: 'A', score: 95, perCheck: {} }),
    autoPublish: vi.fn().mockResolvedValue({ published: true }),
    finalize: vi.fn().mockResolvedValue(undefined),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runCloneProV6 — orchestrator skeleton (Sprint 1)', () => {
  it('walks Stages 1-3 and persists URL queue + render cache', async () => {
    const fakeDeps = {
      db: makeFakeDb(),
      discoverUrls: vi.fn().mockResolvedValue({
        urls: [{ sourceUrl: 'https://example.com/products/a', discoveredVia: 'sitemap', depth: 0 }],
        sitemapFound: true,
      }),
      classifyUrls: vi.fn().mockResolvedValue({
        'https://example.com/products/a': 'product',
      }),
      renderUrls: vi.fn().mockResolvedValue([
        {
          queueId: 'id-0',
          sourceUrl: 'https://example.com/products/a',
          html: '<html>p</html>',
          screenshotSha1: 'sha1',
          assetUrls: [],
          viewportWidth: 1280,
          viewportHeight: 800,
        },
      ]),
      emitProgress: vi.fn().mockResolvedValue(undefined),
      emitStage: vi.fn().mockResolvedValue(undefined),
      ...makeStages4to12Deps(),
    }

    const r = await runCloneProV6({
      jobId: 'job-1',
      shopId: 'shop-1',
      sourceUrl: 'https://example.com',
      deps: fakeDeps as any,
    })

    expect(fakeDeps.discoverUrls).toHaveBeenCalledOnce()
    expect(fakeDeps.classifyUrls).toHaveBeenCalledOnce()
    expect(fakeDeps.renderUrls).toHaveBeenCalledOnce()

    expect(r.stage1).toMatchObject({ urlsDiscovered: 1, sitemapFound: true })
    expect(r.stage2).toMatchObject({ classified: 1 })
    expect(r.stage3).toMatchObject({ rendered: 1, errors: 0 })
    // Sprint 4 stages
    expect(r.stage4).toMatchObject({ products: 1, collections: 0, pages: 0 })
    expect(r.stage5).toMatchObject({ assets: 0 })
    expect(r.stage6).toMatchObject({ downloaded: 1, skipped: 0, failed: 0, aborted: false })
    expect(r.stage7).toMatchObject({ bucketFailures: [], persistInserted: 1 })
    expect(r.stage8).toMatchObject({ rowsRewritten: 5, leaksDetected: 0 })
    expect(r.stage9.pixelDiffPct).toBe(1.5)
    expect(r.stage10).toMatchObject({ letter: 'A', score: 95 })
    expect(r.stage11).toMatchObject({ published: true })
  })

  it('aborts on Stage 1 zero-results when source returns no URLs', async () => {
    const fakeDeps = {
      db: makeFakeDb(),
      discoverUrls: vi.fn().mockResolvedValue({ urls: [], sitemapFound: false }),
      classifyUrls: vi.fn(),
      renderUrls: vi.fn(),
      emitProgress: vi.fn().mockResolvedValue(undefined),
      emitStage: vi.fn().mockResolvedValue(undefined),
      ...makeStages4to12Deps(),
    }

    await expect(
      runCloneProV6({
        jobId: 'job-1',
        shopId: 'shop-1',
        sourceUrl: 'https://empty.com',
        deps: fakeDeps as any,
      }),
    ).rejects.toThrow(/no URLs/i)

    expect(fakeDeps.classifyUrls).not.toHaveBeenCalled()
    expect(fakeDeps.renderUrls).not.toHaveBeenCalled()
  })
})
