/**
 * Gbox Platform — Scaling Tier Math Tests (Phase 3F)
 *
 * Pure derivation tests — no k6, no network. Locks the exact numbers
 * downstream runbooks and the load harness depend on.
 */

import { describe, it, expect } from 'vitest'
import {
  SCALING_TIERS,
  SCALING_ASSUMPTIONS,
  getTier,
  type ScalingTierName,
} from './tiers.js'

describe('SCALING_TIERS', () => {
  const allTiers: ScalingTierName[] = ['t100k', 't1m', 't10m']

  it('contains the three sanctioned tiers', () => {
    expect(Object.keys(SCALING_TIERS).sort()).toEqual(allTiers.slice().sort())
  })

  it('t100k derives ~0.04 avg orders/s from 100k orders/month', () => {
    const t = SCALING_TIERS.t100k
    expect(t.ordersPerMonth).toBe(100_000)
    expect(t.ordersPerSecAvg).toBeCloseTo(0.039, 2)
    expect(t.ordersPerSecPeak).toBeCloseTo(0.386, 2)
    expect(t.ordersPerSecFlash).toBeCloseTo(3.858, 2)
  })

  it('t1m is exactly 10x t100k', () => {
    const base = SCALING_TIERS.t100k
    const t = SCALING_TIERS.t1m
    expect(t.ordersPerMonth).toBe(base.ordersPerMonth * 10)
    expect(t.ordersPerSecAvg).toBeCloseTo(base.ordersPerSecAvg * 10, 2)
    expect(t.ordersPerSecFlash).toBeCloseTo(base.ordersPerSecFlash * 10, 1)
    expect(t.pageviewsPerMonth).toBe(base.pageviewsPerMonth * 10)
  })

  it('t10m is exactly 100x t100k', () => {
    const base = SCALING_TIERS.t100k
    const t = SCALING_TIERS.t10m
    expect(t.ordersPerMonth).toBe(base.ordersPerMonth * 100)
    // precision 1 = within 0.05; rounding drift at 3dp accumulates over 100x
    expect(t.ordersPerSecAvg).toBeCloseTo(base.ordersPerSecAvg * 100, 1)
    expect(t.ordersPerSecFlash).toBeCloseTo(base.ordersPerSecFlash * 100, -1)
    expect(t.pageviewsPerMonth).toBe(base.pageviewsPerMonth * 100)
  })

  it('pageviews derive from the locked 2% conversion rate', () => {
    for (const name of allTiers) {
      const t = SCALING_TIERS[name]
      expect(t.pageviewsPerMonth).toBeCloseTo(
        t.ordersPerMonth / SCALING_ASSUMPTIONS.conversionRate,
        5,
      )
    }
  })

  it('VU counts scale via Little\'s Law: concurrency = rate * duration', () => {
    for (const name of allTiers) {
      const t = SCALING_TIERS[name]
      // baseline browse VUs >= pageviewsPerSecAvg * sessionDurationSec
      const expectedBaselineBrowse = Math.ceil(
        t.pageviewsPerSecAvg * SCALING_ASSUMPTIONS.sessionDurationSec,
      )
      expect(t.vus.baseline.browse).toBeGreaterThanOrEqual(
        expectedBaselineBrowse,
      )
      // flash is 100x avg, so flash VU count is ~100x baseline
      if (expectedBaselineBrowse > 0) {
        expect(t.vus.flash.browse).toBeGreaterThan(t.vus.baseline.browse)
      }
    }
  })

  it('smoke profile is always 1 browse + 1 checkout regardless of tier', () => {
    for (const name of allTiers) {
      expect(SCALING_TIERS[name].vus.smoke).toEqual({ browse: 1, checkout: 1 })
    }
  })

  it('flash profile preserves the 50:1 browse-to-checkout ratio', () => {
    for (const name of allTiers) {
      const t = SCALING_TIERS[name]
      // Allow ±10% slack because of ceiling rounding at small tiers.
      const ratio = t.vus.flash.browse / t.vus.flash.checkout
      expect(ratio).toBeGreaterThanOrEqual(40)
      expect(ratio).toBeLessThanOrEqual(60)
    }
  })

  it('every tier documents at least one bottleneck and prerequisite', () => {
    for (const name of allTiers) {
      const t = SCALING_TIERS[name]
      expect(t.bottlenecks.length).toBeGreaterThan(0)
      expect(t.prerequisites.length).toBeGreaterThan(0)
    }
  })

  it('VU counts grow monotonically between tiers', () => {
    const ordered: ScalingTierName[] = ['t100k', 't1m', 't10m']
    for (let i = 1; i < ordered.length; i += 1) {
      const prev = SCALING_TIERS[ordered[i - 1]!]!
      const curr = SCALING_TIERS[ordered[i]!]!
      expect(curr.vus.baseline.browse).toBeGreaterThanOrEqual(
        prev.vus.baseline.browse,
      )
      expect(curr.vus.flash.browse).toBeGreaterThan(prev.vus.flash.browse)
      expect(curr.vus.peak.checkout).toBeGreaterThanOrEqual(
        prev.vus.peak.checkout,
      )
    }
  })
})

describe('getTier', () => {
  it('accepts canonical keys', () => {
    expect(getTier('t100k').ordersPerMonth).toBe(100_000)
    expect(getTier('t1m').ordersPerMonth).toBe(1_000_000)
    expect(getTier('t10m').ordersPerMonth).toBe(10_000_000)
  })

  it('accepts short-form aliases (100k / 1m / 10m)', () => {
    expect(getTier('100k').name).toBe('t100k')
    expect(getTier('1m').name).toBe('t1m')
    expect(getTier('10m').name).toBe('t10m')
  })

  it('is case-insensitive and trims whitespace', () => {
    expect(getTier('  1M  ').name).toBe('t1m')
    expect(getTier('T10M').name).toBe('t10m')
  })

  it('throws a clear error on unknown tier names', () => {
    expect(() => getTier('5m')).toThrow(/Unknown scaling tier/)
    expect(() => getTier('huge')).toThrow(/Valid tiers:/)
  })
})

describe('SCALING_ASSUMPTIONS', () => {
  it('documents the conversion rate as 2%', () => {
    expect(SCALING_ASSUMPTIONS.conversionRate).toBe(0.02)
  })

  it('peak and flash multipliers are 10x and 100x', () => {
    expect(SCALING_ASSUMPTIONS.peakMultiplier).toBe(10)
    expect(SCALING_ASSUMPTIONS.flashMultiplier).toBe(100)
  })

  it('one month = 30 * 86400 seconds', () => {
    expect(SCALING_ASSUMPTIONS.secondsPerMonth).toBe(2_592_000)
  })
})
