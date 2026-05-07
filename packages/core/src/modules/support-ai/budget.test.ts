/**
 * budget.test.ts — Phase 12.5 PR4
 *
 * Pins the budget classifier. `evaluateBudget` is the single oracle
 * for "is AI allowed to fire?" so we test the boundaries, the
 * clamping, and the pathological inputs.
 */

import { describe, it, expect } from 'vitest'
import {
  BUDGET_WARN_THRESHOLD,
  DEFAULT_BUDGET_CAP_CENTS,
  evaluateBudget,
  isWithinBudget,
  monthKey,
} from './budget.ts'

describe('evaluateBudget — classifications', () => {
  it('returns ok for fresh month', () => {
    const s = evaluateBudget(0)
    expect(s.state).toBe('ok')
    expect(s.spentCents).toBe(0)
    expect(s.capCents).toBe(DEFAULT_BUDGET_CAP_CENTS)
    expect(s.remainingCents).toBe(DEFAULT_BUDGET_CAP_CENTS)
    expect(s.percentUsed).toBe(0)
  })

  it('returns ok at 79% used', () => {
    expect(evaluateBudget(15_799).state).toBe('ok')
  })

  it('returns warn at exactly 80%', () => {
    // 16_000 / 20_000 = 0.80 exactly
    expect(evaluateBudget(16_000).state).toBe('warn')
  })

  it('returns warn at 99%', () => {
    expect(evaluateBudget(19_999).state).toBe('warn')
  })

  it('returns exceeded at exactly 100%', () => {
    expect(evaluateBudget(20_000).state).toBe('exceeded')
  })

  it('returns exceeded past cap', () => {
    const s = evaluateBudget(25_000)
    expect(s.state).toBe('exceeded')
    expect(s.remainingCents).toBe(0)
  })

  it('clamps negative spend to 0', () => {
    const s = evaluateBudget(-100)
    expect(s.state).toBe('ok')
    expect(s.spentCents).toBe(0)
  })
})

describe('evaluateBudget — custom cap', () => {
  it('respects a $50 cap', () => {
    const cap = 5_000
    expect(evaluateBudget(0, cap).state).toBe('ok')
    expect(evaluateBudget(3_999, cap).state).toBe('ok')
    expect(evaluateBudget(4_000, cap).state).toBe('warn')
    expect(evaluateBudget(5_000, cap).state).toBe('exceeded')
  })

  it('returns exceeded when cap is 0', () => {
    const s = evaluateBudget(0, 0)
    expect(s.state).toBe('exceeded')
    expect(s.remainingCents).toBe(0)
  })

  it('returns exceeded when cap is negative (treated as 0)', () => {
    expect(evaluateBudget(0, -1).state).toBe('exceeded')
  })
})

describe('isWithinBudget', () => {
  it('is true when under cap', () => {
    expect(isWithinBudget(10_000)).toBe(true)
  })

  it('is true at warn threshold', () => {
    expect(isWithinBudget(16_000)).toBe(true)
  })

  it('is false at cap', () => {
    expect(isWithinBudget(20_000)).toBe(false)
  })

  it('is false past cap', () => {
    expect(isWithinBudget(25_000)).toBe(false)
  })
})

describe('BUDGET_WARN_THRESHOLD', () => {
  it('is pinned at 0.80 per spec §10.6.2', () => {
    expect(BUDGET_WARN_THRESHOLD).toBe(0.8)
  })
})

describe('DEFAULT_BUDGET_CAP_CENTS', () => {
  it('is $200 (20_000 cents) per spec', () => {
    expect(DEFAULT_BUDGET_CAP_CENTS).toBe(20_000)
  })
})

describe('monthKey', () => {
  it('formats YYYY-MM zero-padded', () => {
    // January 2026 in UTC
    const jan = new Date(Date.UTC(2026, 0, 15, 12, 0, 0))
    expect(monthKey(jan)).toBe('2026-01')
  })

  it('zero-pads single-digit months', () => {
    const apr = new Date(Date.UTC(2026, 3, 22, 0, 0, 0))
    expect(monthKey(apr)).toBe('2026-04')
  })

  it('uses UTC regardless of server timezone', () => {
    // 2025-12-31 23:30 Pacific is 2026-01-01 07:30 UTC — should roll to next month
    const boundary = new Date('2025-12-31T23:30:00-08:00')
    expect(monthKey(boundary)).toBe('2026-01')
  })

  it('defaults to now() when no arg', () => {
    const result = monthKey()
    expect(result).toMatch(/^\d{4}-\d{2}$/)
  })
})
