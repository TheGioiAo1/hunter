/**
 * Unit tests for integrations/health.ts.
 *
 * Only the pure formatter is covered here — the DB-touching
 * `onIntegrationCallError()` needs a live Postgres harness and is
 * smoke-tested by `smoke-phase14-pr6.ts` instead (see spec §4).
 */

import { describe, it, expect } from 'vitest'
import { formatPercent } from './health.js'

describe('formatPercent', () => {
  it('rounds 0.127 to 13%', () => {
    expect(formatPercent(0.127)).toBe('13%')
  })

  it('rounds 0.10 to 10%', () => {
    expect(formatPercent(0.1)).toBe('10%')
  })

  it('zero is "0%"', () => {
    expect(formatPercent(0)).toBe('0%')
  })

  it('one is "100%"', () => {
    expect(formatPercent(1)).toBe('100%')
  })

  it('NaN is "0%"', () => {
    expect(formatPercent(Number.NaN)).toBe('0%')
  })

  it('negative is "0%" (defensive)', () => {
    expect(formatPercent(-0.3)).toBe('0%')
  })

  it('rounds to nearest integer (banker-safe around 0.5)', () => {
    // 0.505 → 51 via Math.round's half-up rule.
    expect(formatPercent(0.505)).toBe('51%')
  })
})
