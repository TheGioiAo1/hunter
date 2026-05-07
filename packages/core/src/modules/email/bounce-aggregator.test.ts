/**
 * Unit tests for email/bounce-aggregator.ts — pure helpers only.
 *
 * The DB-driven `runSoftBounceAggregator` is covered end-to-end in
 * `scripts/smoke-phase14-pr5.ts` against a live gbox_platform DB (it
 * seeds bounces, runs the aggregator, asserts suppression + idempotency).
 *
 * Pure-function test surface: window-day clamping, threshold clamping,
 * max-candidates clamping, computeWindowStart arithmetic.
 */

import { describe, expect, it } from 'vitest'
import {
  normaliseWindowDays,
  normaliseThreshold,
  normaliseMaxCandidates,
  computeWindowStart,
  DEFAULT_WINDOW_DAYS,
  DEFAULT_THRESHOLD,
  DEFAULT_MAX_CANDIDATES,
  MAX_WINDOW_DAYS,
  MAX_THRESHOLD,
} from './bounce-aggregator.js'

describe('normaliseWindowDays — input clamping', () => {
  it('defaults to 30 when undefined', () => {
    expect(normaliseWindowDays(undefined)).toBe(DEFAULT_WINDOW_DAYS)
    expect(normaliseWindowDays(undefined)).toBe(30)
  })

  it('passes through valid small values', () => {
    expect(normaliseWindowDays(1)).toBe(1)
    expect(normaliseWindowDays(7)).toBe(7)
    expect(normaliseWindowDays(90)).toBe(90)
  })

  it('caps at MAX_WINDOW_DAYS (365)', () => {
    expect(normaliseWindowDays(365)).toBe(365)
    expect(normaliseWindowDays(500)).toBe(MAX_WINDOW_DAYS)
    expect(normaliseWindowDays(9999)).toBe(MAX_WINDOW_DAYS)
  })

  it('falls back to default on non-positive', () => {
    expect(normaliseWindowDays(0)).toBe(DEFAULT_WINDOW_DAYS)
    expect(normaliseWindowDays(-1)).toBe(DEFAULT_WINDOW_DAYS)
    expect(normaliseWindowDays(-1000)).toBe(DEFAULT_WINDOW_DAYS)
  })

  it('falls back to default on NaN / Infinity', () => {
    expect(normaliseWindowDays(NaN)).toBe(DEFAULT_WINDOW_DAYS)
    expect(normaliseWindowDays(Infinity)).toBe(DEFAULT_WINDOW_DAYS)
    expect(normaliseWindowDays(-Infinity)).toBe(DEFAULT_WINDOW_DAYS)
  })

  it('floors fractional values', () => {
    expect(normaliseWindowDays(7.9)).toBe(7)
    expect(normaliseWindowDays(1.01)).toBe(1)
  })
})

describe('normaliseThreshold — input clamping', () => {
  it('defaults to 5 when undefined', () => {
    expect(normaliseThreshold(undefined)).toBe(DEFAULT_THRESHOLD)
    expect(normaliseThreshold(undefined)).toBe(5)
  })

  it('passes through valid values', () => {
    expect(normaliseThreshold(1)).toBe(1)
    expect(normaliseThreshold(10)).toBe(10)
    expect(normaliseThreshold(100)).toBe(100)
  })

  it('caps at MAX_THRESHOLD (1000)', () => {
    expect(normaliseThreshold(1000)).toBe(1000)
    expect(normaliseThreshold(5000)).toBe(MAX_THRESHOLD)
  })

  it('falls back to default on zero or negative', () => {
    expect(normaliseThreshold(0)).toBe(DEFAULT_THRESHOLD)
    expect(normaliseThreshold(-1)).toBe(DEFAULT_THRESHOLD)
  })

  it('falls back to default on NaN / Infinity', () => {
    expect(normaliseThreshold(NaN)).toBe(DEFAULT_THRESHOLD)
    expect(normaliseThreshold(Infinity)).toBe(DEFAULT_THRESHOLD)
  })

  it('floors fractional values', () => {
    expect(normaliseThreshold(5.9)).toBe(5)
    expect(normaliseThreshold(1.5)).toBe(1)
  })
})

describe('normaliseMaxCandidates — input clamping', () => {
  it('defaults to 500 when undefined', () => {
    expect(normaliseMaxCandidates(undefined)).toBe(DEFAULT_MAX_CANDIDATES)
    expect(normaliseMaxCandidates(undefined)).toBe(500)
  })

  it('passes through valid values', () => {
    expect(normaliseMaxCandidates(1)).toBe(1)
    expect(normaliseMaxCandidates(1000)).toBe(1000)
    expect(normaliseMaxCandidates(10000)).toBe(10000)
  })

  it('caps at 10000', () => {
    expect(normaliseMaxCandidates(10001)).toBe(10000)
    expect(normaliseMaxCandidates(1_000_000)).toBe(10000)
  })

  it('falls back on zero or negative', () => {
    expect(normaliseMaxCandidates(0)).toBe(DEFAULT_MAX_CANDIDATES)
    expect(normaliseMaxCandidates(-50)).toBe(DEFAULT_MAX_CANDIDATES)
  })

  it('falls back on NaN / Infinity', () => {
    expect(normaliseMaxCandidates(NaN)).toBe(DEFAULT_MAX_CANDIDATES)
    expect(normaliseMaxCandidates(Infinity)).toBe(DEFAULT_MAX_CANDIDATES)
  })
})

describe('computeWindowStart — ISO arithmetic', () => {
  it('subtracts exact ms for 30 days', () => {
    const now = new Date('2024-06-15T12:00:00.000Z')
    const start = computeWindowStart(now, 30)
    expect(start.toISOString()).toBe('2024-05-16T12:00:00.000Z')
  })

  it('subtracts exact ms for 1 day', () => {
    const now = new Date('2024-01-02T00:00:00.000Z')
    const start = computeWindowStart(now, 1)
    expect(start.toISOString()).toBe('2024-01-01T00:00:00.000Z')
  })

  it('crosses month boundary', () => {
    const now = new Date('2024-03-05T10:00:00.000Z')
    const start = computeWindowStart(now, 30)
    // Feb 2024 = 29 days (leap) → 2024-02-04T10:00:00Z
    expect(start.toISOString()).toBe('2024-02-04T10:00:00.000Z')
  })

  it('crosses year boundary', () => {
    const now = new Date('2025-01-15T00:00:00.000Z')
    const start = computeWindowStart(now, 30)
    expect(start.toISOString()).toBe('2024-12-16T00:00:00.000Z')
  })

  it('handles max window (365d)', () => {
    const now = new Date('2025-01-15T00:00:00.000Z')
    const start = computeWindowStart(now, 365)
    expect(start.toISOString()).toBe('2024-01-16T00:00:00.000Z')
  })

  it('preserves milliseconds', () => {
    const now = new Date('2024-06-15T12:34:56.789Z')
    const start = computeWindowStart(now, 7)
    expect(start.toISOString()).toBe('2024-06-08T12:34:56.789Z')
  })

  it('does not mutate the input Date', () => {
    const now = new Date('2024-06-15T12:00:00.000Z')
    const originalIso = now.toISOString()
    computeWindowStart(now, 30)
    expect(now.toISOString()).toBe(originalIso)
  })
})

describe('constants sanity', () => {
  it('defaults match PR5 scope doc', () => {
    expect(DEFAULT_WINDOW_DAYS).toBe(30)
    expect(DEFAULT_THRESHOLD).toBe(5)
    expect(DEFAULT_MAX_CANDIDATES).toBe(500)
  })

  it('MAX constants are safely above defaults', () => {
    expect(MAX_WINDOW_DAYS).toBeGreaterThan(DEFAULT_WINDOW_DAYS)
    expect(MAX_THRESHOLD).toBeGreaterThan(DEFAULT_THRESHOLD)
  })
})
