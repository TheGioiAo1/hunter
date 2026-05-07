/**
 * Gbox Platform — cost tracker + budget gate tests
 *
 * Pins:
 *
 *   - InMemoryCostStore honours the half-open window `[from, to)`.
 *   - Roll-ups split totals by provider and by purpose.
 *   - WindowBudgetGate refuses when either daily or monthly cap
 *     would be breached; lets through otherwise.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  InMemoryCostStore,
  startOfUtcDay,
  startOfUtcMonth,
} from './cost-tracker.js'
import {
  MapBudgetConfig,
  StaticBudgetConfig,
  WindowBudgetGate,
} from './budget.js'
import type { CostRecord } from './types.js'

function makeRecord(overrides: Partial<CostRecord>): CostRecord {
  return {
    shopId: 'shop_1',
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    purpose: 'test',
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    costCents: 10,
    occurredAt: '2026-04-16T12:00:00.000Z',
    durationMs: 100,
    ...overrides,
  }
}

describe('InMemoryCostStore', () => {
  let store: InMemoryCostStore
  beforeEach(() => {
    store = new InMemoryCostStore()
  })

  it('records and rolls up a single entry', async () => {
    await store.record(makeRecord({ costCents: 25 }))
    const rollup = await store.rollup(
      'shop_1',
      '2026-04-16T00:00:00.000Z',
      '2026-04-17T00:00:00.000Z',
    )
    expect(rollup.totalCostCents).toBe(25)
    expect(rollup.callCount).toBe(1)
    expect(rollup.totalTokens).toBe(150)
  })

  it('excludes records outside the window', async () => {
    await store.record(makeRecord({ occurredAt: '2026-04-15T10:00:00.000Z', costCents: 10 }))
    await store.record(makeRecord({ occurredAt: '2026-04-16T10:00:00.000Z', costCents: 20 }))
    await store.record(makeRecord({ occurredAt: '2026-04-17T10:00:00.000Z', costCents: 30 }))
    const rollup = await store.rollup(
      'shop_1',
      '2026-04-16T00:00:00.000Z',
      '2026-04-17T00:00:00.000Z',
    )
    expect(rollup.totalCostCents).toBe(20)
    expect(rollup.callCount).toBe(1)
  })

  it('splits rollup by provider and by purpose', async () => {
    await store.record(makeRecord({ provider: 'anthropic', purpose: 'seo', costCents: 10 }))
    await store.record(makeRecord({ provider: 'google', purpose: 'seo', costCents: 5 }))
    await store.record(makeRecord({ provider: 'anthropic', purpose: 'alt_text', costCents: 3 }))
    const rollup = await store.rollup(
      'shop_1',
      '2026-04-16T00:00:00.000Z',
      '2026-04-17T00:00:00.000Z',
    )
    expect(rollup.byProvider.anthropic?.cents).toBe(13)
    expect(rollup.byProvider.google?.cents).toBe(5)
    expect(rollup.byPurpose.seo?.cents).toBe(15)
    expect(rollup.byPurpose.alt_text?.cents).toBe(3)
  })

  it('isolates shops from each other', async () => {
    await store.record(makeRecord({ shopId: 'shop_A', costCents: 100 }))
    await store.record(makeRecord({ shopId: 'shop_B', costCents: 200 }))
    const a = await store.rollup('shop_A', '2026-04-16T00:00:00.000Z', '2026-04-17T00:00:00.000Z')
    const b = await store.rollup('shop_B', '2026-04-16T00:00:00.000Z', '2026-04-17T00:00:00.000Z')
    expect(a.totalCostCents).toBe(100)
    expect(b.totalCostCents).toBe(200)
  })

  it('returns zeroed rollup for unknown shops', async () => {
    const rollup = await store.rollup(
      'shop_unknown',
      '2026-04-16T00:00:00.000Z',
      '2026-04-17T00:00:00.000Z',
    )
    expect(rollup.totalCostCents).toBe(0)
    expect(rollup.callCount).toBe(0)
  })
})

describe('Time-window helpers', () => {
  it('computes start of UTC day correctly', () => {
    const d = new Date('2026-04-16T14:32:11.345Z')
    expect(startOfUtcDay(d)).toBe('2026-04-16T00:00:00.000Z')
  })

  it('computes start of UTC month correctly', () => {
    const d = new Date('2026-04-16T14:32:11.345Z')
    expect(startOfUtcMonth(d)).toBe('2026-04-01T00:00:00.000Z')
  })

  it('handles month boundary', () => {
    const d = new Date('2026-05-01T00:00:00.000Z')
    expect(startOfUtcMonth(d)).toBe('2026-05-01T00:00:00.000Z')
  })
})

describe('WindowBudgetGate', () => {
  it('allows calls when no cap is configured', async () => {
    const store = new InMemoryCostStore()
    const gate = new WindowBudgetGate({
      reader: store,
      config: new StaticBudgetConfig({ dailyCapCents: null, monthlyCapCents: null }),
    })
    await expect(gate.canSpend('shop_1', 9999)).resolves.toBe(true)
  })

  it('refuses when daily cap would be exceeded by this call', async () => {
    const store = new InMemoryCostStore()
    await store.record(makeRecord({ shopId: 'shop_1', costCents: 80 }))
    const gate = new WindowBudgetGate({
      reader: store,
      config: new StaticBudgetConfig({ dailyCapCents: 100, monthlyCapCents: null }),
      now: () => new Date('2026-04-16T15:00:00.000Z'),
    })
    // already spent 80, asking for 25 more → 105 > 100 → refuse
    await expect(gate.canSpend('shop_1', 25)).resolves.toBe(false)
  })

  it('refuses when monthly cap would be exceeded', async () => {
    const store = new InMemoryCostStore()
    // Spread spend across the month.
    await store.record(makeRecord({ shopId: 'shop_1', costCents: 500, occurredAt: '2026-04-03T10:00:00.000Z' }))
    await store.record(makeRecord({ shopId: 'shop_1', costCents: 400, occurredAt: '2026-04-12T10:00:00.000Z' }))
    const gate = new WindowBudgetGate({
      reader: store,
      config: new StaticBudgetConfig({ dailyCapCents: null, monthlyCapCents: 1000 }),
      now: () => new Date('2026-04-16T15:00:00.000Z'),
    })
    // already 900 this month, asking for 150 → 1050 > 1000 → refuse
    await expect(gate.canSpend('shop_1', 150)).resolves.toBe(false)
  })

  it('allows when both caps have headroom', async () => {
    const store = new InMemoryCostStore()
    await store.record(makeRecord({ shopId: 'shop_1', costCents: 10, occurredAt: '2026-04-16T09:00:00.000Z' }))
    const gate = new WindowBudgetGate({
      reader: store,
      config: new StaticBudgetConfig({ dailyCapCents: 100, monthlyCapCents: 1000 }),
      now: () => new Date('2026-04-16T15:00:00.000Z'),
    })
    await expect(gate.canSpend('shop_1', 50)).resolves.toBe(true)
  })

  it('MapBudgetConfig returns per-shop caps with fallback to defaults', async () => {
    const map = new Map([
      ['shop_premium', { dailyCapCents: 10_000, monthlyCapCents: 100_000 }],
    ])
    const config = new MapBudgetConfig(map, {
      dailyCapCents: 100,
      monthlyCapCents: 1000,
    })
    expect(await config.resolve('shop_premium')).toEqual({
      dailyCapCents: 10_000,
      monthlyCapCents: 100_000,
    })
    expect(await config.resolve('shop_free')).toEqual({
      dailyCapCents: 100,
      monthlyCapCents: 1000,
    })
  })
})
