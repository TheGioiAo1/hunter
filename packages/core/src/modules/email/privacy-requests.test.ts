/**
 * Unit tests for email/privacy-requests.ts — pure helpers only.
 *
 * DB-driven functions (requestDataExport, requestAccountDeletion,
 * markExportReady, consumeDownloadToken, cancelDeletion,
 * adminCancelDeletion, listPrivacyRequests, getPrivacyRequestById,
 * listDeletionsDueForFinalization, markFailed) are covered end-to-end
 * in `scripts/smoke-phase14-pr5.ts` against a live gbox_platform DB.
 *
 * Pure-function test surface: token minting, hashing, constant-time
 * compare, grace-day resolution.
 */

import crypto from 'node:crypto'
import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import {
  mintRawToken,
  hashToken,
  constantTimeHashEqual,
  resolveGraceDays,
} from './privacy-requests.js'

describe('mintRawToken — secure random token', () => {
  it('returns 48 hex chars (24 bytes)', () => {
    const token = mintRawToken()
    expect(token).toHaveLength(48)
    expect(token).toMatch(/^[0-9a-f]{48}$/)
  })

  it('produces distinct tokens on back-to-back calls', () => {
    const a = mintRawToken()
    const b = mintRawToken()
    expect(a).not.toBe(b)
  })

  it('produces 1000 distinct tokens (birthday-collision sanity)', () => {
    const set = new Set<string>()
    for (let i = 0; i < 1000; i++) set.add(mintRawToken())
    expect(set.size).toBe(1000)
  })
})

describe('hashToken — deterministic sha256', () => {
  it('produces 64 hex chars', () => {
    const hash = hashToken('test-token')
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic', () => {
    expect(hashToken('same-input')).toBe(hashToken('same-input'))
  })

  it('differs across distinct inputs', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'))
  })

  it('matches explicit sha256 construction', () => {
    const expected = crypto.createHash('sha256').update('my-raw').digest('hex')
    expect(hashToken('my-raw')).toBe(expected)
  })

  it('round-trips with mintRawToken', () => {
    const raw = mintRawToken()
    const hash = hashToken(raw)
    expect(hashToken(raw)).toBe(hash)
  })
})

describe('constantTimeHashEqual — side-channel-safe comparator', () => {
  it('returns true for identical hashes', () => {
    const h = hashToken('same')
    expect(constantTimeHashEqual(h, h)).toBe(true)
  })

  it('returns false for different hashes', () => {
    const a = hashToken('a')
    const b = hashToken('b')
    expect(constantTimeHashEqual(a, b)).toBe(false)
  })

  it('returns false for non-string inputs', () => {
    expect(constantTimeHashEqual(null as any, hashToken('x'))).toBe(false)
    expect(constantTimeHashEqual(undefined as any, hashToken('x'))).toBe(false)
    expect(constantTimeHashEqual(42 as any, hashToken('x'))).toBe(false)
  })

  it('returns false for mismatched lengths', () => {
    const h = hashToken('x')
    expect(constantTimeHashEqual(h, h.slice(0, 32))).toBe(false)
  })

  it('returns false for non-hex inputs of correct length', () => {
    const bogus = 'z'.repeat(64)
    const real = hashToken('test')
    expect(constantTimeHashEqual(bogus, real)).toBe(false)
  })

  it('returns false when both strings are non-64-length', () => {
    // Regression guard: even identical short strings shouldn't pass.
    expect(constantTimeHashEqual('abc', 'abc')).toBe(false)
  })
})

describe('resolveGraceDays — config resolution', () => {
  const origGrace = process.env.PRIVACY_DELETION_GRACE_DAYS

  beforeEach(() => {
    delete process.env.PRIVACY_DELETION_GRACE_DAYS
  })

  afterEach(() => {
    if (origGrace == null) delete process.env.PRIVACY_DELETION_GRACE_DAYS
    else process.env.PRIVACY_DELETION_GRACE_DAYS = origGrace
  })

  it('defaults to 30 when nothing is set', () => {
    expect(resolveGraceDays()).toBe(30)
  })

  it('uses env override when set', () => {
    process.env.PRIVACY_DELETION_GRACE_DAYS = '7'
    expect(resolveGraceDays()).toBe(7)
  })

  it('uses function override when set', () => {
    expect(resolveGraceDays(14)).toBe(14)
  })

  it('function override beats env override', () => {
    process.env.PRIVACY_DELETION_GRACE_DAYS = '7'
    expect(resolveGraceDays(60)).toBe(60)
  })

  it('rejects negative function overrides', () => {
    expect(resolveGraceDays(-5)).toBe(30)
  })

  it('rejects zero function override', () => {
    expect(resolveGraceDays(0)).toBe(30)
  })

  it('rejects NaN function override', () => {
    expect(resolveGraceDays(NaN)).toBe(30)
  })

  it('rejects non-numeric env value', () => {
    process.env.PRIVACY_DELETION_GRACE_DAYS = 'banana'
    expect(resolveGraceDays()).toBe(30)
  })

  it('rejects negative env value', () => {
    process.env.PRIVACY_DELETION_GRACE_DAYS = '-7'
    expect(resolveGraceDays()).toBe(30)
  })

  it('rejects zero env value', () => {
    process.env.PRIVACY_DELETION_GRACE_DAYS = '0'
    expect(resolveGraceDays()).toBe(30)
  })

  it('truncates fractional function overrides', () => {
    expect(resolveGraceDays(7.9)).toBe(7)
  })

  it('accepts small positive values', () => {
    expect(resolveGraceDays(1)).toBe(1)
  })
})

describe('token → hash flow — roundtrip smoke', () => {
  it('mint → hash → compare works end-to-end', () => {
    const raw = mintRawToken()
    const hash = hashToken(raw)
    expect(constantTimeHashEqual(hashToken(raw), hash)).toBe(true)
  })

  it('different raw tokens hash to different values', () => {
    const a = mintRawToken()
    const b = mintRawToken()
    expect(constantTimeHashEqual(hashToken(a), hashToken(b))).toBe(false)
  })

  it('tampered raw token fails compare', () => {
    const raw = mintRawToken()
    const tamperedHash = hashToken(raw.slice(0, -1) + '0')
    const realHash = hashToken(raw)
    // Overwhelmingly likely tampered hash != real hash (256-bit collision)
    expect(constantTimeHashEqual(tamperedHash, realHash)).toBe(false)
  })
})
