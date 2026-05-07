/**
 * Unit tests for email/suppression.ts — pure helpers only.
 *
 * DB-driven functions (checkSuppressed, addSuppression, listSuppressions,
 * countActiveSuppressions, countRecentByReason, unsuppress,
 * getSuppressionById) are covered end-to-end in
 * `scripts/smoke-phase14-pr4b.ts` against a live gbox_platform DB.
 *
 * Why no in-memory mock DB: Kysely + pg roundtrips are the surface we
 * actually need to verify (ON CONFLICT partial-index semantics,
 * shop_id IS NULL vs = comparison, partial UNIQUE conflict target
 * construction). A mock would hide exactly the code we care about.
 */

import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hashEmail } from './suppression.js'

describe('hashEmail — pure function', () => {
  it('is deterministic for the same input', () => {
    expect(hashEmail('user@example.com')).toBe(hashEmail('user@example.com'))
  })

  it('lowercases before hashing', () => {
    expect(hashEmail('User@Example.COM')).toBe(hashEmail('user@example.com'))
  })

  it('returns 64 hex chars (SHA-256)', () => {
    const hash = hashEmail('user@example.com')
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('differs across distinct emails', () => {
    expect(hashEmail('a@example.com')).not.toBe(hashEmail('b@example.com'))
  })

  it('matches crypto.createHash explicitly', () => {
    const expected = crypto
      .createHash('sha256')
      .update('user@example.com')
      .digest('hex')
    expect(hashEmail('User@Example.COM')).toBe(expected)
  })

  it('does not crash on whitespace-only input', () => {
    expect(() => hashEmail('   ')).not.toThrow()
  })

  it('does not crash on empty string', () => {
    expect(() => hashEmail('')).not.toThrow()
  })

  it('handles Unicode addresses', () => {
    const asciiHash = hashEmail('test@example.com')
    const unicodeHash = hashEmail('tëst@example.com')
    expect(unicodeHash).toHaveLength(64)
    expect(unicodeHash).not.toBe(asciiHash)
  })
})
