import { describe, it, expect } from 'vitest'
import { gradeClone } from './grader.js'

describe('gradeClone', () => {
  it('returns A when all metrics are high', () => {
    const r = gradeClone({
      routeCheckPct: 0.97,
      productCompletenessPct: 0.99,
      cssTokenPct: 0.85,
      pageBodyPct: 0.96,
      menuResolutionPct: 0.92,
    })
    expect(r.letter).toBe('A')
    expect(r.score).toBeGreaterThanOrEqual(90)
  })

  it('returns F when most metrics fail', () => {
    const r = gradeClone({
      routeCheckPct: 0.30,
      productCompletenessPct: 0.40,
      cssTokenPct: 0.20,
      pageBodyPct: 0.50,
      menuResolutionPct: 0.10,
    })
    expect(r.letter).toBe('F')
  })

  it('weights route-check at 40% (highest weight)', () => {
    const allOther = { productCompletenessPct: 1, cssTokenPct: 1, pageBodyPct: 1, menuResolutionPct: 1 }
    const high = gradeClone({ routeCheckPct: 1, ...allOther })
    const low = gradeClone({ routeCheckPct: 0, ...allOther })
    expect(high.score - low.score).toBeCloseTo(40, 1)
  })

  it('emits warnings for failing metrics', () => {
    const r = gradeClone({
      routeCheckPct: 0.50,
      productCompletenessPct: 0.99,
      cssTokenPct: 0.90,
      pageBodyPct: 0.99,
      menuResolutionPct: 0.99,
    })
    expect(r.warnings.some((w) => w.toLowerCase().includes('route'))).toBe(true)
  })
})
