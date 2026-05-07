/**
 * Gbox Platform — Profanity Filter Unit Tests (Phase 10 PR3)
 */

import { describe, it, expect } from 'vitest'
import {
  countProfanityHits,
  containsProfanity,
  maskProfanity,
  normaliseExtraTerms,
  _builtInLists,
} from './profanity.js'

describe('Reviews / Profanity', () => {
  describe('_builtInLists', () => {
    it('exposes copies of both lexicons', () => {
      const lists = _builtInLists()
      expect(lists.en.length).toBeGreaterThan(10)
      expect(lists.vi.length).toBeGreaterThan(5)
      // mutating the returned array doesn't poison the module state
      lists.en.push('injected')
      const again = _builtInLists()
      expect(again.en).not.toContain('injected')
    })
  })

  describe('countProfanityHits', () => {
    it('returns 0 on empty input', () => {
      expect(countProfanityHits('')).toBe(0)
      expect(countProfanityHits(null as any)).toBe(0)
      expect(countProfanityHits(undefined as any)).toBe(0)
    })

    it('catches a plain English slur', () => {
      expect(countProfanityHits('This is fucking bad')).toBe(1)
    })

    it('does NOT match inside larger words (word boundaries)', () => {
      expect(countProfanityHits('classic bass')).toBe(0)
      expect(countProfanityHits('assassinate')).toBe(0)
    })

    it('counts multiple hits in one sentence', () => {
      expect(countProfanityHits('fuck this shit')).toBe(2)
    })

    it('matches case-insensitively', () => {
      expect(countProfanityHits('FUCK')).toBe(1)
      expect(countProfanityHits('Fuck')).toBe(1)
    })

    it('catches Vietnamese profanity even with diacritics', () => {
      expect(countProfanityHits('đụ má')).toBeGreaterThan(0)
      expect(countProfanityHits('địt mẹ')).toBeGreaterThan(0)
      expect(countProfanityHits('lồn')).toBe(1)
    })

    it('catches Vietnamese profanity without diacritics', () => {
      expect(countProfanityHits('du ma')).toBeGreaterThan(0)
      expect(countProfanityHits('dit me')).toBeGreaterThan(0)
    })

    it('hits VN shortcut abbreviations', () => {
      expect(countProfanityHits('vcl that was bad')).toBe(1)
    })

    it('accepts and matches extra terms', () => {
      expect(countProfanityHits('this is garbage', ['garbage'])).toBe(1)
    })

    it('does not match storefront spam keywords outside default list', () => {
      expect(countProfanityHits('buy low sell high', [])).toBe(0)
    })

    it('catches built-in spam signals', () => {
      expect(countProfanityHits('total scam from this shop')).toBe(1)
      expect(countProfanityHits('fraud! thief!')).toBe(2)
    })
  })

  describe('containsProfanity', () => {
    it('returns true when at least one match', () => {
      expect(containsProfanity('fuck')).toBe(true)
    })

    it('returns false on clean text', () => {
      expect(containsProfanity('great product, loved it')).toBe(false)
    })
  })

  describe('maskProfanity', () => {
    it('returns empty string for empty input', () => {
      expect(maskProfanity('')).toBe('')
    })

    it('replaces hits with * of the same length', () => {
      const out = maskProfanity('fuck this')
      expect(out).toBe('**** this')
      expect(out.length).toBe('fuck this'.length)
    })

    it('preserves the length with diacritics', () => {
      const input = 'đụ má'
      const output = maskProfanity(input)
      expect(output.length).toBe(input.length)
      // first 2 characters should be masked
      expect(output.startsWith('**')).toBe(true)
    })

    it('respects extra terms', () => {
      expect(maskProfanity('this is garbage', ['garbage'])).toBe(
        'this is *******',
      )
    })
  })

  describe('normaliseExtraTerms', () => {
    it('accepts string arrays', () => {
      expect(normaliseExtraTerms(['foo', 'BAR', 'baz'])).toEqual([
        'foo',
        'bar',
        'baz',
      ])
    })

    it('de-dupes', () => {
      expect(normaliseExtraTerms(['foo', 'FOO', 'foo'])).toEqual(['foo'])
    })

    it('strips diacritics', () => {
      expect(normaliseExtraTerms(['đụ', 'Đm'])).toEqual(['du', 'dm'])
    })

    it('accepts JSON string', () => {
      expect(normaliseExtraTerms('["alpha","BETA"]')).toEqual([
        'alpha',
        'beta',
      ])
    })

    it('falls back to comma-separated parsing', () => {
      expect(normaliseExtraTerms('foo, bar , baz')).toEqual([
        'foo',
        'bar',
        'baz',
      ])
    })

    it('ignores non-string entries', () => {
      expect(normaliseExtraTerms(['ok', 1, null, undefined, 'yes'] as any)).toEqual([
        'ok',
        'yes',
      ])
    })

    it('caps at 200 terms', () => {
      const big = Array.from({ length: 500 }, (_, i) => `t${i}`)
      const out = normaliseExtraTerms(big)
      expect(out.length).toBe(200)
    })

    it('returns [] for garbage input', () => {
      expect(normaliseExtraTerms(42 as any)).toEqual([])
      expect(normaliseExtraTerms(null)).toEqual([])
    })
  })
})
