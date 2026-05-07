/**
 * pick-model.test.ts — Phase 12.5 PR4
 *
 * Cover every branch of pickModel() + the price sheet math. Spec
 * §10.6.1 pins the decision tree; these tests are the regression
 * fence around it.
 */

import { describe, it, expect } from 'vitest'
import {
  ANTHROPIC_SKU,
  HIGH_STAKES_KEYWORDS,
  OPUS_CONFIDENCE_FLOOR,
  SUPPORT_AI_PRICE_SHEET,
  computeCostCents,
  pickModel,
} from './pick-model.ts'

describe('pickModel — decision tree', () => {
  it('returns opus for payment + normal priority', () => {
    expect(
      pickModel({ category: 'payment', priority: 'normal', subject: 'help' }, 0),
    ).toBe('opus-4')
  })

  it('returns opus for payment + high priority', () => {
    expect(
      pickModel({ category: 'payment', priority: 'high', subject: 'help' }, 0),
    ).toBe('opus-4')
  })

  it('returns opus for payment + urgent priority', () => {
    expect(
      pickModel({ category: 'payment', priority: 'urgent', subject: 'help' }, 0),
    ).toBe('opus-4')
  })

  it('returns sonnet for payment + LOW priority', () => {
    // Low-priority payment tickets (e.g. "invoice question") are
    // intentionally downgraded to Sonnet — not worth $0.03 each.
    expect(
      pickModel({ category: 'payment', priority: 'low', subject: 'invoice' }, 0),
    ).toBe('sonnet-4-5')
  })

  it('returns opus on chargeback subject', () => {
    expect(
      pickModel(
        { category: 'onboarding', priority: 'normal', subject: 'Chargeback filed by customer' },
        0,
      ),
    ).toBe('opus-4')
  })

  it('returns opus on dispute subject (case insensitive)', () => {
    expect(
      pickModel(
        { category: 'onboarding', priority: 'normal', subject: 'DISPUTE this charge' },
        0,
      ),
    ).toBe('opus-4')
  })

  it('returns opus on legal subject', () => {
    expect(
      pickModel(
        { category: 'account', priority: 'normal', subject: 'Legal demand' },
        0,
      ),
    ).toBe('opus-4')
  })

  it('returns opus on lawyer subject', () => {
    expect(
      pickModel(
        { category: 'account', priority: 'normal', subject: 'My lawyer wrote this' },
        0,
      ),
    ).toBe('opus-4')
  })

  it('returns opus on report subject', () => {
    expect(
      pickModel(
        { category: 'technical', priority: 'low', subject: 'I want to report fraud' },
        0,
      ),
    ).toBe('opus-4')
  })

  it('returns opus on fraud subject', () => {
    expect(
      pickModel(
        { category: 'onboarding', priority: 'normal', subject: 'Possible fraud on account' },
        0,
      ),
    ).toBe('opus-4')
  })

  it('returns opus when confidence >= 0.85', () => {
    expect(
      pickModel(
        { category: 'technical', priority: 'normal', subject: 'product setup' },
        0.85,
      ),
    ).toBe('opus-4')
  })

  it('returns opus when confidence well above 0.85', () => {
    expect(
      pickModel(
        { category: 'technical', priority: 'normal', subject: 'product setup' },
        0.99,
      ),
    ).toBe('opus-4')
  })

  it('returns sonnet when confidence just below threshold', () => {
    expect(
      pickModel(
        { category: 'technical', priority: 'normal', subject: 'product setup' },
        0.8499,
      ),
    ).toBe('sonnet-4-5')
  })

  it('returns sonnet for default low-stakes ticket', () => {
    expect(
      pickModel(
        { category: 'technical', priority: 'normal', subject: 'setup question' },
        0,
      ),
    ).toBe('sonnet-4-5')
  })

  it('returns sonnet for other + normal priority', () => {
    expect(
      pickModel(
        { category: 'other', priority: 'normal', subject: 'how do I add a logo?' },
        0,
      ),
    ).toBe('sonnet-4-5')
  })
})

describe('HIGH_STAKES_KEYWORDS', () => {
  it('matches each pinned keyword case-insensitively', () => {
    for (const kw of ['chargeback', 'dispute', 'legal', 'lawyer', 'report', 'fraud']) {
      expect(HIGH_STAKES_KEYWORDS.test(kw)).toBe(true)
      expect(HIGH_STAKES_KEYWORDS.test(kw.toUpperCase())).toBe(true)
    }
  })

  it('does not match unrelated words', () => {
    expect(HIGH_STAKES_KEYWORDS.test('packaging damaged')).toBe(false)
    expect(HIGH_STAKES_KEYWORDS.test('order cancellation')).toBe(false)
  })
})

describe('OPUS_CONFIDENCE_FLOOR', () => {
  it('is pinned at 0.85 per spec §10.6.1', () => {
    expect(OPUS_CONFIDENCE_FLOOR).toBe(0.85)
  })
})

describe('ANTHROPIC_SKU', () => {
  it('resolves both semantic models to concrete SKU ids', () => {
    expect(ANTHROPIC_SKU['sonnet-4-5']).toContain('claude-sonnet')
    expect(ANTHROPIC_SKU['opus-4']).toContain('claude-opus')
  })

  it('has exactly two entries', () => {
    expect(Object.keys(ANTHROPIC_SKU).sort()).toEqual(['opus-4', 'sonnet-4-5'])
  })
})

describe('computeCostCents', () => {
  it('computes sonnet cost: 1M in, 1M out = $3 + $15 = 1800 cents', () => {
    expect(computeCostCents('sonnet-4-5', 1_000_000, 1_000_000)).toBe(1800)
  })

  it('computes opus cost: 1M in, 1M out = $15 + $75 = 9000 cents', () => {
    expect(computeCostCents('opus-4', 1_000_000, 1_000_000)).toBe(9000)
  })

  it('computes sonnet cost for typical reply (500 in + 300 out)', () => {
    // input: 500/1M * 300 cents = 0.15 cents
    // output: 300/1M * 1500 cents = 0.45 cents
    // total: 0.6 cents → floor to 0
    expect(computeCostCents('sonnet-4-5', 500, 300)).toBe(0)
  })

  it('computes sonnet cost for 10K in + 1K out = 3 + 1.5 = 4 cents floored', () => {
    expect(computeCostCents('sonnet-4-5', 10_000, 1_000)).toBe(4)
  })

  it('computes opus cost for 5K in + 2K out = 7.5 + 15 = 22.5 → 22 cents floored', () => {
    expect(computeCostCents('opus-4', 5_000, 2_000)).toBe(22)
  })

  it('handles zero tokens', () => {
    expect(computeCostCents('sonnet-4-5', 0, 0)).toBe(0)
    expect(computeCostCents('opus-4', 0, 0)).toBe(0)
  })
})

describe('SUPPORT_AI_PRICE_SHEET', () => {
  it('has sonnet priced cheaper than opus on both dimensions', () => {
    const s = SUPPORT_AI_PRICE_SHEET['sonnet-4-5']
    const o = SUPPORT_AI_PRICE_SHEET['opus-4']
    expect(s.inputCentsPerMillion).toBeLessThan(o.inputCentsPerMillion)
    expect(s.outputCentsPerMillion).toBeLessThan(o.outputCentsPerMillion)
  })
})
