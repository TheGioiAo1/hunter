/**
 * Unit tests for email/consent-ledger.ts — pure helpers only.
 *
 * DB-driven functions (recordConsent, listConsentEvents,
 * latestConsentFor, countConsentEvents) are covered end-to-end in
 * `scripts/smoke-phase14-pr5.ts` against a live gbox_platform DB.
 *
 * What we DO test here:
 *   - detectPIIKeys() — the metadata-sanitizer, pure function
 *   - hashIpWithCurrentSalt() — env-sensitive IP hasher, pure (reads env)
 *   - hashIpWithSaltForTest() — deterministic variant used by smoke
 */

import crypto from 'node:crypto'
import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import {
  detectPIIKeys,
  hashIpWithCurrentSalt,
  hashIpWithSaltForTest,
} from './consent-ledger.js'

describe('detectPIIKeys — metadata sanitizer', () => {
  it('returns empty array for null', () => {
    expect(detectPIIKeys(null)).toEqual([])
  })

  it('returns empty array for undefined', () => {
    expect(detectPIIKeys(undefined)).toEqual([])
  })

  it('returns empty array for empty object', () => {
    expect(detectPIIKeys({})).toEqual([])
  })

  it('allows clean keys', () => {
    expect(
      detectPIIKeys({
        source: 'checkout',
        referrer: 'https://example.com',
        utm_campaign: 'spring-sale',
        ab_test_variant: 'B',
      }),
    ).toEqual([])
  })

  it('detects plain "email" key', () => {
    expect(detectPIIKeys({ email: 'a@b.com' })).toEqual(['email'])
  })

  it('detects suffix like "user_email"', () => {
    expect(detectPIIKeys({ user_email: 'a@b.com' })).toEqual(['user_email'])
  })

  it('detects "phone"', () => {
    expect(detectPIIKeys({ phone: '+1-555-0100' })).toEqual(['phone'])
  })

  it('detects "primary_phone"', () => {
    expect(detectPIIKeys({ primary_phone: '+1-555' })).toEqual(['primary_phone'])
  })

  it('detects "address"', () => {
    expect(detectPIIKeys({ address: '1 Main St' })).toEqual(['address'])
  })

  it('detects "address1"', () => {
    expect(detectPIIKeys({ address1: '1 Main St' })).toEqual(['address1'])
  })

  it('detects "last_name"', () => {
    expect(detectPIIKeys({ last_name: 'Smith' })).toEqual(['last_name'])
  })

  it('detects "first_name"', () => {
    expect(detectPIIKeys({ first_name: 'Alice' })).toEqual(['first_name'])
  })

  it('is case-insensitive', () => {
    expect(detectPIIKeys({ Email: 'x' })).toEqual(['Email'])
    expect(detectPIIKeys({ PHONE: 'x' })).toEqual(['PHONE'])
  })

  it('walks nested objects and reports dotted path', () => {
    const result = detectPIIKeys({
      source: 'api',
      context: {
        user_email: 'leaked@example.com',
      },
    })
    expect(result).toEqual(['context.user_email'])
  })

  it('walks deeply nested objects', () => {
    const result = detectPIIKeys({
      level1: {
        level2: {
          level3: {
            phone: '+1',
          },
        },
      },
    })
    expect(result).toEqual(['level1.level2.level3.phone'])
  })

  it('reports multiple offenders', () => {
    const result = detectPIIKeys({
      email: 'a',
      user_name: 'b',
      nested: { phone: 'c' },
    })
    expect(result.sort()).toEqual(['email', 'nested.phone', 'user_name'])
  })

  it('ignores array values that contain PII-ish keys as array elements', () => {
    // Array values are walked as objects by the recursive walker but
    // their numeric indices don't match the PII key regex. Even if an
    // array contains a string "email", that's a value not a key.
    expect(detectPIIKeys({ tags: ['email', 'phone', 'name'] })).toEqual([])
  })

  it('allows "username" (not "_name" or start-of-string "name")', () => {
    // Regex requires underscore or start-of-string BEFORE the trigger
    // word. "username" has "name" as a suffix but not after "_" → clean.
    // A caller deliberately trying to smuggle PII with 'user_name'
    // (underscore-name) WILL be caught — see separate test above.
    expect(detectPIIKeys({ username: 'alice' })).toEqual([])
  })

  it('allows "naming_convention" (not a PII key)', () => {
    // "naming_convention" doesn't have ^name or _name → clean.
    expect(detectPIIKeys({ naming_convention: 'camelCase' })).toEqual([])
  })

  it('catches "user_name" (underscore before name)', () => {
    expect(detectPIIKeys({ user_name: 'alice' })).toEqual(['user_name'])
  })

  it('does not report non-object values', () => {
    // Passing a string or number as "metadata" is caller error but
    // shouldn't crash.
    expect(detectPIIKeys('string-not-object' as any)).toEqual([])
    expect(detectPIIKeys(42 as any)).toEqual([])
  })
})

describe('hashIpWithCurrentSalt — env-driven IP hasher', () => {
  const origSalt = process.env.EMAIL_TRACKING_IP_SALT

  beforeEach(() => {
    delete process.env.EMAIL_TRACKING_IP_SALT
  })

  afterEach(() => {
    if (origSalt == null) delete process.env.EMAIL_TRACKING_IP_SALT
    else process.env.EMAIL_TRACKING_IP_SALT = origSalt
  })

  it('returns null for null IP', () => {
    expect(hashIpWithCurrentSalt(null)).toBe(null)
  })

  it('returns null for undefined IP', () => {
    expect(hashIpWithCurrentSalt(undefined)).toBe(null)
  })

  it('returns null for empty string IP', () => {
    expect(hashIpWithCurrentSalt('')).toBe(null)
  })

  it('returns null when salt env is unset (fail-closed, no weak default)', () => {
    expect(process.env.EMAIL_TRACKING_IP_SALT).toBeUndefined()
    expect(hashIpWithCurrentSalt('1.2.3.4')).toBe(null)
  })

  it('produces sha256 hex when salt is set', () => {
    process.env.EMAIL_TRACKING_IP_SALT = 'test-salt-abc'
    const hash = hashIpWithCurrentSalt('1.2.3.4')
    expect(hash).not.toBe(null)
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for the same IP + salt', () => {
    process.env.EMAIL_TRACKING_IP_SALT = 'deterministic-salt'
    const h1 = hashIpWithCurrentSalt('192.168.1.1')
    const h2 = hashIpWithCurrentSalt('192.168.1.1')
    expect(h1).toBe(h2)
  })

  it('differs across salts (rotation invalidates old hashes)', () => {
    process.env.EMAIL_TRACKING_IP_SALT = 'salt-v1'
    const h1 = hashIpWithCurrentSalt('10.0.0.1')
    process.env.EMAIL_TRACKING_IP_SALT = 'salt-v2'
    const h2 = hashIpWithCurrentSalt('10.0.0.1')
    expect(h1).not.toBe(h2)
  })

  it('differs across distinct IPs under same salt', () => {
    process.env.EMAIL_TRACKING_IP_SALT = 'shared-salt'
    const h1 = hashIpWithCurrentSalt('10.0.0.1')
    const h2 = hashIpWithCurrentSalt('10.0.0.2')
    expect(h1).not.toBe(h2)
  })

  it('handles IPv6 addresses', () => {
    process.env.EMAIL_TRACKING_IP_SALT = 'v6-salt'
    const h = hashIpWithCurrentSalt('2001:db8::1')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('matches explicit sha256 construction', () => {
    process.env.EMAIL_TRACKING_IP_SALT = 'explicit-salt'
    const expected = crypto
      .createHash('sha256')
      .update('explicit-salt:127.0.0.1')
      .digest('hex')
    expect(hashIpWithCurrentSalt('127.0.0.1')).toBe(expected)
  })
})

describe('hashIpWithSaltForTest — deterministic variant for smoke', () => {
  it('returns consistent hex hash', () => {
    const h = hashIpWithSaltForTest('10.0.0.1', 'test-salt')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('matches explicit sha256 construction', () => {
    const expected = crypto
      .createHash('sha256')
      .update('smoke-salt:203.0.113.1')
      .digest('hex')
    expect(hashIpWithSaltForTest('203.0.113.1', 'smoke-salt')).toBe(expected)
  })

  it('is not affected by env mutations (smoke-safe)', () => {
    const origSalt = process.env.EMAIL_TRACKING_IP_SALT
    process.env.EMAIL_TRACKING_IP_SALT = 'env-salt'
    const h1 = hashIpWithSaltForTest('1.1.1.1', 'arg-salt')
    process.env.EMAIL_TRACKING_IP_SALT = 'different-env-salt'
    const h2 = hashIpWithSaltForTest('1.1.1.1', 'arg-salt')
    expect(h1).toBe(h2)
    if (origSalt == null) delete process.env.EMAIL_TRACKING_IP_SALT
    else process.env.EMAIL_TRACKING_IP_SALT = origSalt
  })
})
