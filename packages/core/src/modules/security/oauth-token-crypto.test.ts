/**
 * Gbox Platform — OAuth token crypto unit tests
 */

import { describe, it, expect } from 'vitest'
import {
  decryptToken,
  encryptToken,
  generateOauthKey,
  parseOauthKey,
  rotateToken,
} from './oauth-token-crypto.ts'

describe('oauth-token-crypto: parseOauthKey', () => {
  it('parses a 64-char hex key into 32 bytes', () => {
    const hex = 'a'.repeat(64)
    expect(parseOauthKey(hex).length).toBe(32)
  })

  it('rejects empty input', () => {
    expect(() => parseOauthKey('')).toThrow(/empty/i)
  })

  it('rejects non-hex input', () => {
    expect(() => parseOauthKey('not-hex-not-hex-not-hex-not-hex-not-hex-not-hex-not-hex-not-hex')).toThrow(/hex/i)
  })

  it('rejects wrong length', () => {
    expect(() => parseOauthKey('abcd')).toThrow(/32 bytes/i)
  })
})

describe('oauth-token-crypto: encryptToken / decryptToken', () => {
  const key = parseOauthKey(generateOauthKey())

  it('round-trips a plaintext token', () => {
    const plaintext = 'ya29.a0AfH6SMBx_some_oauth_access_token_here'
    const enc = encryptToken(plaintext, key)
    expect(enc).not.toBeNull()
    expect(enc!.ciphertext).toBeInstanceOf(Buffer)
    expect(enc!.iv.length).toBe(12)
    expect(enc!.tag.length).toBe(16)
    expect(decryptToken(enc, key)).toBe(plaintext)
  })

  it('produces different ciphertext on repeat encryptions (fresh IV)', () => {
    const plaintext = 'same-token-twice'
    const a = encryptToken(plaintext, key)!
    const b = encryptToken(plaintext, key)!
    expect(a.iv.equals(b.iv)).toBe(false)
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false)
    // Both still round-trip to the same plaintext.
    expect(decryptToken(a, key)).toBe(plaintext)
    expect(decryptToken(b, key)).toBe(plaintext)
  })

  it('passes null straight through both directions', () => {
    expect(encryptToken(null, key)).toBeNull()
    expect(decryptToken(null, key)).toBeNull()
  })

  it('throws if the auth tag is tampered with', () => {
    const enc = encryptToken('real-token', key)!
    const tampered = { ...enc, tag: Buffer.from(enc.tag) }
    tampered.tag[0] ^= 0xff
    expect(() => decryptToken(tampered, key)).toThrow()
  })

  it('throws if the ciphertext is tampered with', () => {
    const enc = encryptToken('real-token', key)!
    const tampered = { ...enc, ciphertext: Buffer.from(enc.ciphertext) }
    tampered.ciphertext[0] ^= 0xff
    expect(() => decryptToken(tampered, key)).toThrow()
  })

  it('throws if decrypted with a different key', () => {
    const enc = encryptToken('secret', key)!
    const otherKey = parseOauthKey(generateOauthKey())
    expect(() => decryptToken(enc, otherKey)).toThrow()
  })

  it('rejects wrong-size keys at encrypt time', () => {
    const shortKey = Buffer.alloc(16)
    expect(() => encryptToken('x', shortKey)).toThrow(/32 bytes/i)
  })
})

describe('oauth-token-crypto: rotateToken', () => {
  it('moves a ciphertext from oldKey to newKey with the same plaintext', () => {
    const oldKey = parseOauthKey(generateOauthKey())
    const newKey = parseOauthKey(generateOauthKey())
    const plaintext = 'refresh-token-xyz'
    const oldEnc = encryptToken(plaintext, oldKey)
    const newEnc = rotateToken(oldEnc, oldKey, newKey)
    expect(decryptToken(newEnc, newKey)).toBe(plaintext)
    expect(() => decryptToken(newEnc, oldKey)).toThrow()
  })

  it('passes null through rotation', () => {
    const oldKey = parseOauthKey(generateOauthKey())
    const newKey = parseOauthKey(generateOauthKey())
    expect(rotateToken(null, oldKey, newKey)).toBeNull()
  })
})

describe('oauth-token-crypto: generateOauthKey', () => {
  it('produces a 64-char hex string', () => {
    const k = generateOauthKey()
    expect(k).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces different keys each call', () => {
    expect(generateOauthKey()).not.toBe(generateOauthKey())
  })

  it('is parseable by parseOauthKey', () => {
    const k = generateOauthKey()
    expect(parseOauthKey(k).length).toBe(32)
  })
})
