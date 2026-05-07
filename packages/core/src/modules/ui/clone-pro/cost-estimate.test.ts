import { describe, it, expect } from 'vitest'
import { renderCostEstimate, computeEstimate, costEstimateCss } from './cost-estimate.js'

describe('CostEstimate', () => {
  it('sums alt-text + seo into total', () => {
    expect(computeEstimate({ altText: true, seo: true }).totalCents).toBe(65)
  })
  it('returns 0 when both toggles off', () => {
    expect(computeEstimate({ altText: false, seo: false }).totalCents).toBe(0)
  })
  it('alt-text only = 40c', () => {
    expect(computeEstimate({ altText: true, seo: false }).totalCents).toBe(40)
  })
  it('seo only = 25c', () => {
    expect(computeEstimate({ altText: false, seo: true }).totalCents).toBe(25)
  })
  it('renders the dollar amount', () => {
    expect(renderCostEstimate({ altText: true, seo: true })).toContain('$0.65')
  })
  it('renders "Free" when total is 0', () => {
    expect(renderCostEstimate({ altText: false, seo: false })).toContain('Free')
  })
  it('emits data-cost-cents hook for live updates', () => {
    expect(renderCostEstimate({ altText: true, seo: true })).toContain('data-cost-cents="65"')
  })
  it('exports costEstimateCss', () => {
    expect(costEstimateCss).toMatch(/gbx-cost/)
  })
})
