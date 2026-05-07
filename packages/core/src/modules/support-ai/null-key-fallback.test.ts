/**
 * null-key-fallback.test.ts — Phase 12.5 PR4
 *
 * Assert the graceful-degrade contract: every AI surface must
 * return false from the predicate and throw the typed error when
 * keys are missing, disabled, or over budget. Shipping Phase 12.5
 * WITHOUT an Anthropic key on day 1 relies on this passing.
 */

import { describe, it, expect } from 'vitest'
import {
  AINotConfiguredError,
  assertAISupportConfigured,
  isAISupportConfigured,
  missingReason,
} from './null-key-fallback.ts'

const BASE = {
  anthropicApiKey: 'sk-ant-valid-demo',
  enabled: true,
  spentCentsThisMonth: 0,
  capCents: 20_000,
}

describe('isAISupportConfigured', () => {
  it('is true for a fully configured keyset', () => {
    expect(isAISupportConfigured(BASE)).toBe(true)
  })

  it('is false when key is empty string', () => {
    expect(isAISupportConfigured({ ...BASE, anthropicApiKey: '' })).toBe(false)
  })

  it('is false when key is whitespace only', () => {
    expect(isAISupportConfigured({ ...BASE, anthropicApiKey: '   ' })).toBe(false)
  })

  it('is false when enabled=false', () => {
    expect(isAISupportConfigured({ ...BASE, enabled: false })).toBe(false)
  })

  it('is false when cap is 0', () => {
    expect(isAISupportConfigured({ ...BASE, capCents: 0 })).toBe(false)
  })

  it('is false when spend >= cap', () => {
    expect(
      isAISupportConfigured({ ...BASE, spentCentsThisMonth: 20_000 }),
    ).toBe(false)
  })

  it('is true when spend just under cap', () => {
    expect(
      isAISupportConfigured({ ...BASE, spentCentsThisMonth: 19_999 }),
    ).toBe(true)
  })
})

describe('missingReason', () => {
  it('returns null when all good', () => {
    expect(missingReason(BASE)).toBeNull()
  })

  it('returns key-missing message when empty key', () => {
    const r = missingReason({ ...BASE, anthropicApiKey: '' })
    expect(r).toContain('Anthropic API key')
  })

  it('returns disabled message when flag false', () => {
    const r = missingReason({ ...BASE, enabled: false })
    expect(r).toContain('AI trợ lý đang tắt')
  })

  it('returns budget message when spend past cap', () => {
    const r = missingReason({ ...BASE, spentCentsThisMonth: 20_000 })
    expect(r).toContain('budget')
  })

  it('returns zero-cap message', () => {
    const r = missingReason({ ...BASE, capCents: 0 })
    expect(r).toContain('0')
  })
})

describe('assertAISupportConfigured', () => {
  it('does not throw when configured', () => {
    expect(() => assertAISupportConfigured(BASE)).not.toThrow()
  })

  it('throws AINotConfiguredError[missing_key] when key empty', () => {
    let caught: Error | null = null
    try {
      assertAISupportConfigured({ ...BASE, anthropicApiKey: '' })
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeInstanceOf(AINotConfiguredError)
    expect((caught as AINotConfiguredError).reason).toBe('missing_key')
  })

  it('throws AINotConfiguredError[disabled] when flag false', () => {
    try {
      assertAISupportConfigured({ ...BASE, enabled: false })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(AINotConfiguredError)
      expect((e as AINotConfiguredError).reason).toBe('disabled')
    }
  })

  it('throws AINotConfiguredError[budget_exceeded] when spent >= cap', () => {
    try {
      assertAISupportConfigured({ ...BASE, spentCentsThisMonth: 25_000 })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(AINotConfiguredError)
      expect((e as AINotConfiguredError).reason).toBe('budget_exceeded')
    }
  })
})

describe('AINotConfiguredError', () => {
  it('has the correct name', () => {
    const err = new AINotConfiguredError('missing_key')
    expect(err.name).toBe('AINotConfiguredError')
  })

  it('has a default message per reason', () => {
    expect(new AINotConfiguredError('missing_key').message).toContain(
      'not configured',
    )
    expect(new AINotConfiguredError('disabled').message).toContain('disabled')
    expect(new AINotConfiguredError('budget_exceeded').message).toContain(
      'budget',
    )
  })

  it('allows a custom message override', () => {
    expect(new AINotConfiguredError('missing_key', 'custom').message).toBe(
      'custom',
    )
  })
})
