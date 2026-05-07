/**
 * Gbox Platform — safe-message.ts unit tests.
 *
 * Iron rule 5: seller-facing strings must never leak god-admin paths,
 * internal feature flags, or the supporter.gbox.co hostname. This test
 * suite is the canonical enforcement point — every added leak-term
 * needs a test row here.
 */
import { describe, it, expect } from 'vitest'
import {
  LEAK_TERMS_REGEX,
  SAFE_MESSAGE_EN,
  SAFE_MESSAGE_VI,
  assertSellerSafe,
  safeMessage,
} from './safe-message.ts'

describe('safeMessage', () => {
  it('returns the English canonical by default', () => {
    const res = safeMessage(new Error('pg: tuple too big in shard 7'))
    expect(res.safe).toBe(SAFE_MESSAGE_EN)
    expect(res.safe).toBe('Please contact Gbox support.')
    expect(res.diagnostic).toBe('pg: tuple too big in shard 7')
  })

  it('returns the Vietnamese canonical when locale=vi', () => {
    const res = safeMessage(new Error('boom'), { locale: 'vi' })
    expect(res.safe).toBe(SAFE_MESSAGE_VI)
    expect(res.safe).toBe('Vui lòng liên hệ Gbox support.')
  })

  it('handles string errors', () => {
    const res = safeMessage('string-error')
    expect(res.diagnostic).toBe('string-error')
    expect(res.safe).toBe(SAFE_MESSAGE_EN)
  })

  it('handles null / undefined gracefully', () => {
    expect(safeMessage(null).diagnostic).toBe('unknown error')
    expect(safeMessage(undefined).diagnostic).toBe('unknown error')
  })

  it('JSON-serialises plain objects', () => {
    const res = safeMessage({ code: 'P0001', detail: 'oops' })
    expect(res.diagnostic).toContain('P0001')
    expect(res.diagnostic).toContain('oops')
  })

  it('falls back to sentinel for unserialisable inputs', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const res = safeMessage(cycle)
    expect(res.diagnostic).toBe('[unserialisable error]')
  })

  it('diagnostic is never piped into `safe`', () => {
    const res = safeMessage(new Error('SECRET LEAK: /god-admin/feature'))
    expect(res.safe).not.toContain('SECRET')
    expect(res.safe).not.toContain('/god-admin/')
  })
})

describe('LEAK_TERMS_REGEX', () => {
  const LEAKY_STRINGS = [
    'user is not a god admin',
    'hit /god-admin/feature-flags',
    'Go to supporter.gbox.co to escalate',
    'FEATURE_FLAG_SUPPORT_V2 is off',
    'feature flag disabled',
    'platform admin only',
    'internal route /foo',
    'check $env.SUPPORT_MESSAGE_ENCRYPTION_KEY',
    'god_admin must enable',
  ]
  for (const s of LEAKY_STRINGS) {
    it(`flags leak: "${s}"`, () => {
      expect(LEAK_TERMS_REGEX.test(s)).toBe(true)
    })
  }

  const CLEAN_STRINGS = [
    'Please contact Gbox support.',
    'Your order was paid.',
    'Admin panel updated.',
    'god-mode cheat in our game',  // unrelated "god" — not "god admin"
    'platform update available',   // "platform" alone is fine
    'https://gbox.co/support',
    'Vui lòng liên hệ Gbox support.',
  ]
  for (const s of CLEAN_STRINGS) {
    it(`does not flag clean: "${s}"`, () => {
      expect(LEAK_TERMS_REGEX.test(s)).toBe(false)
    })
  }
})

describe('assertSellerSafe', () => {
  it('returns true for a clean string', () => {
    expect(assertSellerSafe('Please contact Gbox support.')).toBe(true)
  })

  it('returns false if any leak term is present', () => {
    expect(assertSellerSafe('goto /god-admin/ for this')).toBe(false)
  })

  it('returns true for the canonical Vietnamese message', () => {
    expect(assertSellerSafe(SAFE_MESSAGE_VI)).toBe(true)
  })
})
