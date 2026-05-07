import { describe, it, expect } from 'vitest'
import { estimateCloneCost, COST_PER_URL } from './estimate-cost.js'

describe('estimateCloneCost — Sprint 0 BYOK gate', () => {
  it('returns linear cost when given URL count', () => {
    const r = estimateCloneCost({ urlCount: 100, provider: 'anthropic', model: 'claude-haiku-4-5-20251001' })
    expect(r.urlCount).toBe(100)
    expect(r.aiCallsEstimate).toBe(2)  // 100 / 50 batch
    expect(r.aiCostUsd).toBeCloseTo(100 * COST_PER_URL.anthropic['claude-haiku-4-5-20251001'], 4)
  })

  it('caps cost at $5 floor advisory threshold', () => {
    const r = estimateCloneCost({ urlCount: 10000, provider: 'openai', model: 'gpt-5' })
    expect(r.advisory).toContain('Ensure your provider')
  })

  it('handles unknown model with conservative default', () => {
    const r = estimateCloneCost({ urlCount: 100, provider: 'anthropic', model: 'unknown-x' })
    expect(r.aiCostUsd).toBeGreaterThan(0)
    expect(r.modelKnown).toBe(false)
  })
})
