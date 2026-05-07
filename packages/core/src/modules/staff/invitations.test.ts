import { describe, it, expect } from 'vitest'
import { _hashToken, _generateToken } from './invitations.js'

describe('_hashToken', () => {
  it('is deterministic', () => {
    expect(_hashToken('abc123')).toBe(_hashToken('abc123'))
  })
  it('produces a 64-char hex', () => {
    const h = _hashToken('x')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })
  it('differs for different inputs', () => {
    expect(_hashToken('a')).not.toBe(_hashToken('b'))
  })
})

describe('_generateToken', () => {
  it('generates a 64-char hex token', () => {
    expect(_generateToken()).toMatch(/^[0-9a-f]{64}$/)
  })
  it('is not sequential (two calls produce different tokens)', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) seen.add(_generateToken())
    expect(seen.size).toBe(100)
  })
})
