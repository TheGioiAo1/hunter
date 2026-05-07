import { describe, it, expect } from 'vitest'
import { runStage12 } from './stage12-finalize.js'

describe('Stage 12 — finalize', () => {
  it('persists metrics + design_md + result_json', async () => {
    const inserts: any[] = []
    const updates: any[] = []
    const fakeDb = {
      insertInto: (table: string) => ({
        values: (vals: any) => ({ execute: async () => { inserts.push({ table, vals }) } }),
      }),
      updateTable: (table: string) => ({
        set: (vals: any) => ({ where: () => ({ execute: async () => { updates.push({ table, vals }) } }) }),
      }),
    }
    await runStage12({
      db: fakeDb as any,
      jobId: 'j',
      shopId: 's',
      metrics: {
        pixelDiffPct: 2.5,
        cardinalityPct: 99,
        cardinalityProductsActual: 99,
        cardinalityProductsSource: 100,
        asset404Count: 0,
        aiCostUsdCents: 42,
        totalAssetBytes: 187_000_000,
        durationMs: 210_000,
        grade: { letter: 'A', score: 92, perCheck: {} },
      },
      designMd: '# DESIGN',
      resultJson: { stage1: 'ok' },
    })
    expect(inserts.find((i) => i.table === 'clone_run_metrics')).toBeDefined()
    expect(updates.find((u) => u.table === 'storefront_clone_jobs').vals.design_md).toBe('# DESIGN')
  })
})
