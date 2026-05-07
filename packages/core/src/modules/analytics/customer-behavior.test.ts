/**
 * Unit tests for customer-behavior.ts (Phase 6 PR3).
 *
 * Pure helpers only — DB-bound queries are covered by smoke-phase6-pr3.ts.
 */

import { describe, it, expect } from 'vitest'
import {
  classifyRecency,
  classifyFrequency,
  computeReturningRate,
} from './customer-behavior.js'

describe('classifyRecency', () => {
  it('returns "active" for <= 30 days (default)', () => {
    expect(classifyRecency(0)).toBe('active')
    expect(classifyRecency(15)).toBe('active')
    expect(classifyRecency(30)).toBe('active')
  })

  it('returns "at_risk" for 31..60 days', () => {
    expect(classifyRecency(31)).toBe('at_risk')
    expect(classifyRecency(45)).toBe('at_risk')
    expect(classifyRecency(60)).toBe('at_risk')
  })

  it('returns "dormant" for > 60 days', () => {
    expect(classifyRecency(61)).toBe('dormant')
    expect(classifyRecency(120)).toBe('dormant')
    expect(classifyRecency(9999)).toBe('dormant')
  })

  it('returns "dormant" for null (never ordered)', () => {
    expect(classifyRecency(null)).toBe('dormant')
  })

  it('respects custom cutoffs', () => {
    expect(classifyRecency(10, { activeMax: 7, atRiskMax: 14 })).toBe('at_risk')
    expect(classifyRecency(5, { activeMax: 7, atRiskMax: 14 })).toBe('active')
    expect(classifyRecency(20, { activeMax: 7, atRiskMax: 14 })).toBe('dormant')
  })
})

describe('classifyFrequency', () => {
  it('0 orders → "none"', () => {
    expect(classifyFrequency(0)).toBe('none')
  })
  it('1 order → "one_time"', () => {
    expect(classifyFrequency(1)).toBe('one_time')
  })
  it('2..4 orders → "occasional"', () => {
    expect(classifyFrequency(2)).toBe('occasional')
    expect(classifyFrequency(3)).toBe('occasional')
    expect(classifyFrequency(4)).toBe('occasional')
  })
  it('5..9 orders → "loyal"', () => {
    expect(classifyFrequency(5)).toBe('loyal')
    expect(classifyFrequency(9)).toBe('loyal')
  })
  it('>= 10 orders → "vip"', () => {
    expect(classifyFrequency(10)).toBe('vip')
    expect(classifyFrequency(100)).toBe('vip')
  })
  it('negative orders (DB drift) → "none"', () => {
    expect(classifyFrequency(-1)).toBe('none')
  })
})

describe('computeReturningRate', () => {
  it('returns 0 when total is 0', () => {
    expect(computeReturningRate(0, 0)).toBe(0)
  })

  it('returns 0 when only new customers', () => {
    expect(computeReturningRate(10, 0)).toBe(0)
  })

  it('returns 1 when only returning customers', () => {
    expect(computeReturningRate(0, 10)).toBe(1)
  })

  it('computes ratio correctly', () => {
    expect(computeReturningRate(50, 50)).toBe(0.5)
    expect(computeReturningRate(25, 75)).toBe(0.75)
    expect(computeReturningRate(90, 10)).toBe(0.1)
  })

  it('clamps negative input to 0', () => {
    // Shouldn't happen, but belt-and-braces
    expect(computeReturningRate(10, -5)).toBe(0)
  })

  it('clamps to 0 when absurd negative input makes total <= 0', () => {
    // Defensive: if callers pass nonsense we never divide by zero / negative
    expect(computeReturningRate(-10, 5)).toBe(0)
    expect(computeReturningRate(-5, -5)).toBe(0)
  })
})
