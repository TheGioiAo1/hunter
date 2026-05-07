/**
 * Clone Pro v7 — cost-budget guardrail tests.
 *
 * Sprint 5 Task 5.7 (follow-up). Caps the per-job AI spend at
 * `MAX_CLONE_PRO_V7_USD` (default 5.00 USD). Stage 14 (vision-extract)
 * + Stage 16 (visual-verify retry) accumulate cost via `addCost`; if
 * the running total exceeds the cap, the orchestrator throws
 * `CostBudgetExceededError` and the worker scrubs the message via
 * `safeMessage()` before surfacing to the seller.
 *
 * Why per-job, not per-shop monthly?
 *   - Shop-level monthly cost lives on `shop_ai_config.monthly_cost_usd_cents`
 *     (migration 093) for the long-running budget.
 *   - Per-job cap protects the seller from a runaway clone (e.g. Stage 16
 *     hits its 3-retry cap on a stubborn site, each retry costing $0.30
 *     vision = $1+ per job; default $5/job lets us roll out the kill-switch).
 */

import { describe, it, expect } from 'vitest'
import {
  CloneProCostTracker,
  CostBudgetExceededError,
  resolveMaxBudgetUsd,
  CLAUDE_MODEL_PRICING,
} from './cost-budget.js'

describe('resolveMaxBudgetUsd', () => {
  const original = process.env.MAX_CLONE_PRO_V7_USD

  function restore() {
    if (original === undefined) delete process.env.MAX_CLONE_PRO_V7_USD
    else process.env.MAX_CLONE_PRO_V7_USD = original
  }

  it('defaults to 5.00 USD when env unset', () => {
    delete process.env.MAX_CLONE_PRO_V7_USD
    expect(resolveMaxBudgetUsd()).toBe(5)
    restore()
  })

  it('honours MAX_CLONE_PRO_V7_USD override', () => {
    process.env.MAX_CLONE_PRO_V7_USD = '12.50'
    expect(resolveMaxBudgetUsd()).toBe(12.5)
    restore()
  })

  it('falls back to default on non-numeric env value', () => {
    process.env.MAX_CLONE_PRO_V7_USD = 'banana'
    expect(resolveMaxBudgetUsd()).toBe(5)
    restore()
  })

  it('falls back to default on negative env value (safety)', () => {
    process.env.MAX_CLONE_PRO_V7_USD = '-1'
    expect(resolveMaxBudgetUsd()).toBe(5)
    restore()
  })
})

describe('CloneProCostTracker', () => {
  it('starts at zero spend', () => {
    const tracker = new CloneProCostTracker({ maxUsd: 5 })
    expect(tracker.getSpentUsd()).toBe(0)
  })

  it('accumulates cost across addCost calls', () => {
    const tracker = new CloneProCostTracker({ maxUsd: 5 })
    tracker.addCost('stage14', 0.5)
    tracker.addCost('stage16', 0.3)
    expect(tracker.getSpentUsd()).toBeCloseTo(0.8, 5)
  })

  it('breaks out cost by stage', () => {
    const tracker = new CloneProCostTracker({ maxUsd: 5 })
    tracker.addCost('stage14', 0.5)
    tracker.addCost('stage14', 0.2)
    tracker.addCost('stage16', 0.3)
    const breakdown = tracker.getBreakdown()
    expect(breakdown.stage14).toBeCloseTo(0.7, 5)
    expect(breakdown.stage16).toBeCloseTo(0.3, 5)
  })

  it('throws CostBudgetExceededError when total crosses maxUsd', () => {
    const tracker = new CloneProCostTracker({ maxUsd: 5 })
    tracker.addCost('stage14', 4.5)
    expect(() => tracker.addCost('stage16', 1)).toThrow(CostBudgetExceededError)
  })

  it('error includes spent + limit in the message but not full diagnostic', () => {
    const tracker = new CloneProCostTracker({ maxUsd: 1 })
    tracker.addCost('stage14', 0.7)
    let caught: CostBudgetExceededError | null = null
    try {
      tracker.addCost('stage16', 0.5)
    } catch (err) {
      caught = err as CostBudgetExceededError
    }
    expect(caught).toBeInstanceOf(CostBudgetExceededError)
    expect(caught!.spentUsd).toBeCloseTo(1.2, 5)
    expect(caught!.limitUsd).toBe(1)
    expect(caught!.lastStage).toBe('stage16')
  })

  it('does NOT throw when adding zero cost (boundary)', () => {
    const tracker = new CloneProCostTracker({ maxUsd: 5 })
    tracker.addCost('stage14', 5)
    // Adding zero on the boundary should not throw — we're EQUAL not OVER.
    expect(() => tracker.addCost('stage16', 0)).not.toThrow()
  })

  it('does NOT throw when total === maxUsd exactly (strict gt)', () => {
    const tracker = new CloneProCostTracker({ maxUsd: 5 })
    expect(() => tracker.addCost('stage14', 5)).not.toThrow()
    expect(tracker.getSpentUsd()).toBe(5)
  })

  it('persists incoming USD as-is (no rounding noise)', () => {
    const tracker = new CloneProCostTracker({ maxUsd: 100 })
    tracker.addCost('stage14', 0.001)
    tracker.addCost('stage14', 0.002)
    expect(tracker.getSpentUsd()).toBeCloseTo(0.003, 6)
  })
})

describe('CloneProCostTracker.addClaude — token-based accounting', () => {
  it('records cost using Claude Sonnet 4.5 pricing ($3/M input, $15/M output)', () => {
    const tracker = new CloneProCostTracker({ maxUsd: 10 })
    // 1000 input tokens × $3/1M + 500 output tokens × $15/1M
    //   = $0.003 + $0.0075 = $0.0105
    tracker.addClaude('claude-sonnet-4-5', 'stage14', 1000, 500)
    expect(tracker.getSpentUsd()).toBeCloseTo(0.0105, 6)
  })

  it('records cost using Claude Haiku 4.5 pricing ($1/M input, $5/M output)', () => {
    const tracker = new CloneProCostTracker({ maxUsd: 10 })
    // 1000 × $1/1M + 500 × $5/1M = $0.001 + $0.0025 = $0.0035
    tracker.addClaude('claude-haiku-4-5', 'stage16', 1000, 500)
    expect(tracker.getSpentUsd()).toBeCloseTo(0.0035, 6)
  })

  it('throws CostBudgetExceededError once accumulated tokens cross the cap', () => {
    // Sonnet 4.5: 1000 input + 500 output = $0.0105/call.
    // 30 calls = $0.315. Cap at $0.20 → throws around call 20.
    const tracker = new CloneProCostTracker({ maxUsd: 0.2 })
    let calls = 0
    let caught: CostBudgetExceededError | null = null
    try {
      for (let i = 0; i < 30; i++) {
        tracker.addClaude('claude-sonnet-4-5', 'stage14', 1000, 500)
        calls++
      }
    } catch (err) {
      caught = err as CostBudgetExceededError
    }
    expect(caught).toBeInstanceOf(CostBudgetExceededError)
    // 0.20 / 0.0105 = 19.04 → call 20 pushes over.
    expect(calls).toBeGreaterThanOrEqual(18)
    expect(calls).toBeLessThanOrEqual(20)
    expect(caught!.lastStage).toBe('stage14')
  })

  it('allows all 30 calls when budget is generous ($10 cap)', () => {
    const tracker = new CloneProCostTracker({ maxUsd: 10 })
    for (let i = 0; i < 30; i++) {
      tracker.addClaude('claude-sonnet-4-5', 'stage14', 1000, 500)
    }
    // 30 × $0.0105 = $0.315 — well under the $10 cap.
    expect(tracker.getSpentUsd()).toBeCloseTo(0.315, 4)
  })

  it('falls back to default sonnet pricing for an unknown model name', () => {
    const tracker = new CloneProCostTracker({ maxUsd: 10 })
    tracker.addClaude('claude-fictional-99', 'stage14', 1000, 500)
    // Default fallback = sonnet 4.5 → 0.0105
    expect(tracker.getSpentUsd()).toBeCloseTo(0.0105, 6)
  })

  it('CLAUDE_MODEL_PRICING exposes the canonical price table', () => {
    expect(CLAUDE_MODEL_PRICING['claude-sonnet-4-5']).toEqual({
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15,
    })
    expect(CLAUDE_MODEL_PRICING['claude-haiku-4-5']).toEqual({
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 5,
    })
  })

  it('addClaude with negative tokens throws RangeError (defensive)', () => {
    const tracker = new CloneProCostTracker({ maxUsd: 10 })
    expect(() =>
      tracker.addClaude('claude-sonnet-4-5', 'stage14', -1, 0),
    ).toThrow(RangeError)
    expect(() =>
      tracker.addClaude('claude-sonnet-4-5', 'stage14', 0, -1),
    ).toThrow(RangeError)
  })
})

describe('CostBudgetExceededError', () => {
  it('safeMessage returns generic seller-safe text (Iron Rule 5)', () => {
    const err = new CostBudgetExceededError({
      spentUsd: 6,
      limitUsd: 5,
      lastStage: 'stage16',
    })
    // Iron Rule 5: the .safeMessage must NOT mention internal stage names
    // or full numeric details.
    expect(err.safeMessage).toBeTypeOf('string')
    expect(err.safeMessage).not.toContain('stage16')
    expect(err.safeMessage).not.toContain('budget')
    expect(err.safeMessage).toMatch(/[Cc]ontact.*support/)
  })

  it('exposes diagnostic for server logs', () => {
    const err = new CostBudgetExceededError({
      spentUsd: 6.25,
      limitUsd: 5,
      lastStage: 'stage14',
    })
    expect(err.diagnostic).toContain('6.25')
    expect(err.diagnostic).toContain('5')
    expect(err.diagnostic).toContain('stage14')
  })
})
