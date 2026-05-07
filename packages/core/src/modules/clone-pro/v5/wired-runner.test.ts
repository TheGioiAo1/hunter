import { describe, it, expect, vi } from 'vitest'
import { runCloneProV5Wired } from './wired-runner.js'

// The wired-runner is the worker-side adapter between the pure
// `runCloneProV5` orchestrator and the DB row updates. We don't
// exercise the real pipeline here — we just verify:
//   1. The adapter writes `running` then `succeeded` on the happy path
//      with grade + score + preview_url + design_md persisted.
//   2. It writes `failed` + error_message when the injected pipeline
//      throws, with no grade/score update.
//   3. It accepts a `_runPipeline` seam so tests don't need the real
//      fetch/db-backed scrapers.

describe('runCloneProV5Wired', () => {
  it('persists succeeded status + grade + score + preview_url + design_md on happy path', async () => {
    const updates: Array<Record<string, unknown>> = []
    const db: any = {
      _updates: updates,
    }
    const jobStoreSpy = vi.fn(async (_db: any, _jobId: string, patch: any) => {
      updates.push(patch)
      return {}
    })

    await runCloneProV5Wired(db, {
      shopId: 'shop-1',
      jobId: 'job-1',
      sourceUrl: 'https://x.com',
      _updateStorefrontCloneJob: jobStoreSpy,
      _runPipeline: async () => ({
        platform: 'shopify' as const,
        previewUrl: 'https://job-1.clone-preview.gbox.local',
        grade: {
          score: 88,
          letter: 'B' as const,
          breakdown: {
            route_check_pct: 1,
            product_completeness_pct: 1,
            css_token_pct: 0.5,
            page_body_pct: 1,
            menu_resolution_pct: 1,
          },
          warnings: [],
        },
        designMd: '# Demo Design System\n- primary: #111',
        stats: {
          productsImported: 3,
          productsDiscovered: 3,
          collectionsImported: 1,
          pagesImported: 1,
          menuItems: 2,
          menuBroken: 0,
        },
      }),
    })

    // Two writes: one 'running' marker, one terminal 'succeeded'.
    expect(updates.length).toBeGreaterThanOrEqual(2)
    const running = updates.find((u) => u.status === 'running')
    const terminal = updates.find((u) => u.status === 'succeeded')
    expect(running).toBeDefined()
    expect(terminal).toBeDefined()
    expect(terminal!.grade).toBe('B')
    expect(terminal!.score).toBe(88)
    // Dedicated columns (migration 038) — list views need these without
    // parsing result_json. Both previewUrl + designMd are top-level
    // patch keys translated to preview_url / design_md in the updater.
    expect(terminal!.previewUrl).toBe('https://job-1.clone-preview.gbox.local')
    expect(typeof terminal!.designMd).toBe('string')
    expect(terminal!.designMd as string).toMatch(/Demo Design System/)
    // result_json persists the full blob for drill-down views.
    const terminalKeys = Object.keys(terminal!).join(',')
    expect(terminalKeys).toMatch(/resultJson|result_json/)
  })

  it('persists failed status + error_message when pipeline throws', async () => {
    const updates: Array<Record<string, unknown>> = []
    const db: any = {}
    const jobStoreSpy = vi.fn(async (_db: any, _jobId: string, patch: any) => {
      updates.push(patch)
      return {}
    })

    const result = await runCloneProV5Wired(db, {
      shopId: 'shop-1',
      jobId: 'job-1',
      sourceUrl: 'https://x.com',
      _updateStorefrontCloneJob: jobStoreSpy,
      _runPipeline: async () => {
        throw new Error('scrape failed: HTTP 500')
      },
    })

    const terminal = updates.find((u) => u.status === 'failed')
    expect(terminal).toBeDefined()
    // Seller-safe error surface: the raw message is preserved for
    // admin-side diagnostics but the caller is expected to show a
    // generic string to the seller. We only assert the message is
    // persisted — the seller-facing scrub lives at the UI layer.
    expect(String(terminal!.errorMessage ?? '')).toMatch(/scrape failed/i)
    // grade/score should remain NOT set on failure.
    expect(terminal!.grade).toBeUndefined()
    expect(terminal!.score).toBeUndefined()
    // Runner reports terminal status back to the worker.
    expect(result.status).toBe('failed')
  })

  it('rounds score to integer for the smallint DB column but preserves precision in resultJson', async () => {
    // Regression: hit during phase-19 real-web smoke. The grader emits
    // `score: 33.58` (2-decimal precision) but `storefront_clone_jobs.score`
    // is a Postgres `smallint`. The DB throws
    //   invalid input syntax for type smallint: "33.58"
    // unless we round at the boundary. Full-precision score is still
    // kept in `resultJson.grade.score` for drill-down views.
    const updates: Array<Record<string, unknown>> = []
    const jobStoreSpy = vi.fn(async (_db: any, _jobId: string, patch: any) => {
      updates.push(patch)
      return {}
    })

    await runCloneProV5Wired({} as any, {
      shopId: 'shop-1',
      jobId: 'job-1',
      sourceUrl: 'https://x.com',
      _updateStorefrontCloneJob: jobStoreSpy,
      _runPipeline: async () => ({
        platform: 'shopify' as const,
        previewUrl: 'https://x.clone-preview.gbox.local',
        grade: {
          score: 33.58,  // ← float from real grader
          letter: 'F' as const,
          breakdown: {
            route_check_pct: 0.5,
            product_completeness_pct: 0.3,
            css_token_pct: 0.1,
            page_body_pct: 0.2,
            menu_resolution_pct: 0.1,
          },
          warnings: [],
        },
        designMd: '# Demo',
        stats: {
          productsImported: 0, productsDiscovered: 0, collectionsImported: 0,
          pagesImported: 0, menuItems: 0, menuBroken: 0,
        },
      }),
    })

    const terminal = updates.find((u) => u.status === 'succeeded')!
    expect(terminal.score).toBe(34)                                    // rounded for smallint
    expect(Number.isInteger(terminal.score as number)).toBe(true)
    // Full precision preserved in the JSONB payload.
    expect((terminal.resultJson as any).grade.score).toBe(33.58)
  })

  it('returns succeeded status + grade letter so the worker can skip retry', async () => {
    const db: any = {}
    const jobStoreSpy = vi.fn(async () => ({}))

    const result = await runCloneProV5Wired(db, {
      shopId: 'shop-1',
      jobId: 'job-1',
      sourceUrl: 'https://x.com',
      _updateStorefrontCloneJob: jobStoreSpy,
      _runPipeline: async () => ({
        platform: 'shopify' as const,
        previewUrl: 'https://x.clone-preview.gbox.local',
        grade: {
          score: 91,
          letter: 'A' as const,
          breakdown: {
            route_check_pct: 1,
            product_completeness_pct: 1,
            css_token_pct: 0.8,
            page_body_pct: 1,
            menu_resolution_pct: 1,
          },
          warnings: [],
        },
        designMd: '# Demo',
        stats: {
          productsImported: 1,
          productsDiscovered: 1,
          collectionsImported: 0,
          pagesImported: 0,
          menuItems: 0,
          menuBroken: 0,
        },
      }),
    })

    expect(result.status).toBe('succeeded')
    expect(result.grade).toBe('A')
    expect(result.score).toBe(91)
  })
})
