/**
 * Unit tests for email/salt-rotation.ts — pure helpers only.
 *
 * DB-driven `rotateTrackingSalt` / `getLastRotation` / `listRotations`
 * are covered end-to-end in `scripts/smoke-phase14-pr5.ts` against a
 * live gbox_platform DB (rotation → audit row → rate limit → --force).
 *
 * Pure-function test surface: salt minting, hashing, rotatedBy shape
 * validation.
 */

import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  mintSalt,
  hashSalt,
  isValidRotatedBy,
  SALT_BYTES,
  DEFAULT_RATE_LIMIT_MS,
} from './salt-rotation.js'

describe('mintSalt — cryptographic random salt', () => {
  it('produces 64 hex chars (32 bytes)', () => {
    const salt = mintSalt()
    expect(salt).toHaveLength(64)
    expect(salt).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces distinct salts on back-to-back calls', () => {
    const a = mintSalt()
    const b = mintSalt()
    expect(a).not.toBe(b)
  })

  it('produces 1000 distinct salts (birthday-collision sanity)', () => {
    const set = new Set<string>()
    for (let i = 0; i < 1000; i++) set.add(mintSalt())
    expect(set.size).toBe(1000)
  })
})

describe('hashSalt — deterministic sha256', () => {
  it('produces 64 hex chars', () => {
    const hash = hashSalt('some-salt-value')
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic', () => {
    expect(hashSalt('same-salt')).toBe(hashSalt('same-salt'))
  })

  it('differs across distinct inputs', () => {
    expect(hashSalt('salt-v1')).not.toBe(hashSalt('salt-v2'))
  })

  it('matches explicit sha256 construction', () => {
    const expected = crypto.createHash('sha256').update('test-salt').digest('hex')
    expect(hashSalt('test-salt')).toBe(expected)
  })

  it('round-trips with mintSalt', () => {
    const salt = mintSalt()
    const hash = hashSalt(salt)
    expect(hashSalt(salt)).toBe(hash)
  })

  it('handles empty string (deterministic but distinct from null)', () => {
    // Policy: rotateTrackingSalt passes null for empty/missing salt,
    // so hashSalt('') is never reached in practice — but assert it
    // does not throw and returns a stable hash.
    const h = hashSalt('')
    expect(h).toHaveLength(64)
    expect(h).toBe(crypto.createHash('sha256').update('').digest('hex'))
  })
})

describe('isValidRotatedBy — actor shape check', () => {
  it('accepts plain "cli"', () => {
    expect(isValidRotatedBy('cli')).toBe(true)
  })

  it('accepts plain "system"', () => {
    expect(isValidRotatedBy('system')).toBe(true)
  })

  it('accepts "cli:<name>" with non-empty suffix', () => {
    expect(isValidRotatedBy('cli:thai-laptop')).toBe(true)
    expect(isValidRotatedBy('cli:ops-bot')).toBe(true)
    expect(isValidRotatedBy('cli:x')).toBe(true)
  })

  it('accepts "admin:<uuid>"', () => {
    expect(isValidRotatedBy('admin:550e8400-e29b-41d4-a716-446655440000')).toBe(true)
  })

  it('rejects empty "cli:" suffix', () => {
    expect(isValidRotatedBy('cli:')).toBe(false)
  })

  it('rejects empty "admin:" suffix', () => {
    expect(isValidRotatedBy('admin:')).toBe(false)
  })

  it('rejects unknown prefixes', () => {
    expect(isValidRotatedBy('root')).toBe(false)
    expect(isValidRotatedBy('attacker')).toBe(false)
    expect(isValidRotatedBy('svc:abc')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isValidRotatedBy('')).toBe(false)
  })

  it('rejects non-string inputs (typed as string)', () => {
    // @ts-expect-error intentional runtime check
    expect(isValidRotatedBy(null)).toBe(false)
    // @ts-expect-error
    expect(isValidRotatedBy(undefined)).toBe(false)
    // @ts-expect-error
    expect(isValidRotatedBy(42)).toBe(false)
    // @ts-expect-error
    expect(isValidRotatedBy({ role: 'admin' })).toBe(false)
  })
})

describe('constants sanity', () => {
  it('SALT_BYTES = 32 (256-bit)', () => {
    expect(SALT_BYTES).toBe(32)
  })

  it('DEFAULT_RATE_LIMIT_MS = 1 hour', () => {
    expect(DEFAULT_RATE_LIMIT_MS).toBe(60 * 60 * 1000)
    expect(DEFAULT_RATE_LIMIT_MS).toBe(3_600_000)
  })
})

describe('rotation hash invariants', () => {
  it('rotating invalidates the old-salt hash correlation', () => {
    const oldSalt = mintSalt()
    const newSalt = mintSalt()
    expect(hashSalt(oldSalt)).not.toBe(hashSalt(newSalt))
  })

  it('double-rotation produces 3 distinct salt hashes', () => {
    const s0 = mintSalt()
    const s1 = mintSalt()
    const s2 = mintSalt()
    const hashes = new Set([hashSalt(s0), hashSalt(s1), hashSalt(s2)])
    expect(hashes.size).toBe(3)
  })
})
