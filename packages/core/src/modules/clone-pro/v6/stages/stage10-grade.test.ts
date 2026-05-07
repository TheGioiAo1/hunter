import { describe, it, expect } from 'vitest'
import { computeGrade } from './stage10-grade.js'

describe('Stage 10 — grader (40/30/20/10 weights)', () => {
  it('A grade for >=90 composite', () => {
    const r = computeGrade({ pixelDiffPct: 1, cardinalityPct: 99, asset404Count: 0, totalAssets: 100, aiVisionScore: 95 })
    expect(r.score).toBeGreaterThanOrEqual(90)
    expect(r.letter).toBe('A')
  })

  it('F grade when cardinality < 50% and other checks also fail', () => {
    // pixelScore=0 (diff 50%*2=100 clamped), cardinality=30, reachability=50, aiVision=0
    // composite = 0*0.4 + 30*0.3 + 50*0.2 + 0*0.1 = 0+9+10+0 = 19 → F
    const r = computeGrade({ pixelDiffPct: 50, cardinalityPct: 30, asset404Count: 50, totalAssets: 100, aiVisionScore: 0 })
    expect(r.letter).toBe('F')
  })

  it('penalises high pixel diff', () => {
    const r = computeGrade({ pixelDiffPct: 80, cardinalityPct: 99, asset404Count: 0, totalAssets: 100, aiVisionScore: 95 })
    expect(r.score).toBeLessThan(80)
  })
})
