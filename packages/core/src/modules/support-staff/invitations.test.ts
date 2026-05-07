/**
 * Staff invitations — tests.
 *
 * DB mutations are NOT exercised here — those ride on the PR3 smoke,
 * which spins up a live Postgres. We pin the pure helpers (token gen,
 * hashing, validation, email normalisation) plus `validateCreateInvitation`.
 */
import { describe, it, expect } from 'vitest'
import {
  INVITE_TOKEN_BYTES,
  INVITE_TTL_MS,
  generateInviteToken,
  hashToken,
  normalizeEmail,
  validateCreateInvitation,
  type CreateInvitationInput,
} from './invitations.ts'

describe('generateInviteToken', () => {
  it('returns a 64-char hex raw token', () => {
    const { rawToken } = generateInviteToken()
    expect(rawToken).toMatch(/^[0-9a-f]{64}$/)
    expect(rawToken.length).toBe(INVITE_TOKEN_BYTES * 2)
  })

  it('tokenHash is SHA-256(rawToken) — 64 hex chars', () => {
    const { rawToken, tokenHash } = generateInviteToken()
    expect(tokenHash.length).toBe(64)
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/)
    // Hashing the returned raw token should produce the same digest.
    expect(hashToken(rawToken)).toBe(tokenHash)
  })

  it('generates distinct tokens across calls (randomness sanity)', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) {
      seen.add(generateInviteToken().rawToken)
    }
    expect(seen.size).toBe(100)
  })
})

describe('hashToken', () => {
  it('is deterministic', () => {
    const t = 'a'.repeat(64)
    expect(hashToken(t)).toBe(hashToken(t))
  })

  it('known-vector: SHA-256 of "abc" is the famous digest', () => {
    // Spec vector — if this breaks, node:crypto is broken or
    // someone swapped hash algorithms.
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('normalizeEmail', () => {
  it('lowercases + trims', () => {
    expect(normalizeEmail('  TEST@Example.COM  ')).toBe('test@example.com')
  })

  it('leaves already-normal emails alone', () => {
    expect(normalizeEmail('foo@bar.com')).toBe('foo@bar.com')
  })
})

describe('INVITE_TTL_MS', () => {
  it('is exactly 7 days', () => {
    expect(INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
})

describe('validateCreateInvitation', () => {
  const baseOk: CreateInvitationInput = {
    email: 'agent@example.com',
    displayName: 'Minh',
    preset: 'l1_support',
    invitedBy: '00000000-0000-0000-0000-000000000001',
  }

  it('accepts a valid input', () => {
    expect(validateCreateInvitation(baseOk)).toBeNull()
  })

  it('rejects obviously invalid email', () => {
    expect(validateCreateInvitation({ ...baseOk, email: 'no-at-sign' })?.code).toBe(
      'invalid_email',
    )
    expect(validateCreateInvitation({ ...baseOk, email: '   ' })?.code).toBe(
      'invalid_email',
    )
    expect(validateCreateInvitation({ ...baseOk, email: 'a@b' })?.code).toBe(
      'invalid_email',
    )
  })

  it('rejects too-long email (> 320 chars)', () => {
    const long = 'a'.repeat(310) + '@b.co' // 315
    expect(validateCreateInvitation({ ...baseOk, email: long })).toBeNull()
    const tooLong = 'a'.repeat(320) + '@b.co' // 325
    expect(validateCreateInvitation({ ...baseOk, email: tooLong })?.code).toBe(
      'invalid_email',
    )
  })

  it('rejects empty / too-long display names', () => {
    expect(validateCreateInvitation({ ...baseOk, displayName: '' })?.code).toBe(
      'invalid_display_name',
    )
    expect(validateCreateInvitation({ ...baseOk, displayName: '   ' })?.code).toBe(
      'invalid_display_name',
    )
    expect(
      validateCreateInvitation({ ...baseOk, displayName: 'a'.repeat(61) })?.code,
    ).toBe('invalid_display_name')
  })

  it('rejects unknown preset', () => {
    expect(
      validateCreateInvitation({
        ...baseOk,
        // @ts-expect-error — intentionally testing bad preset
        preset: 'hacker',
      })?.code,
    ).toBe('invalid_preset')
  })

  it('accepts a short message, rejects > 500 chars', () => {
    expect(validateCreateInvitation({ ...baseOk, message: 'hi' })).toBeNull()
    expect(
      validateCreateInvitation({ ...baseOk, message: 'x'.repeat(501) })?.code,
    ).toBe('invalid_message')
  })
})
