/**
 * parsers.test.ts — Phase 12.5 PR4
 *
 * Anthropic can and will return slightly-off JSON (markdown fences,
 * trailing comments, empty arrays, missing fields). The parsers
 * MUST never throw — they return a null / empty-array sentinel and
 * the calling surface decides the fallback.
 *
 * Also covers the crypto round-trip for config-store (tampered-tag,
 * empty-key, wrong-key branches) + mapAnthropicError's status-code
 * → kind mapping.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseSummaryBullets } from './summarize-thread.ts'
import {
  SUPPORT_CATEGORIES,
  parseCategorizeResponse,
} from './auto-categorize.ts'
import { parseSentimentResponse } from './sentiment-flag.ts'
import { mapAnthropicError, SupportAIError } from './client.ts'
import {
  decryptAnthropicKey,
  encryptAnthropicKey,
  isEncryptedKeyBlob,
} from './config-store.ts'

// ===========================================================================
// parseSummaryBullets
// ===========================================================================

describe('parseSummaryBullets', () => {
  it('extracts three dash bullets', () => {
    const input = '- first fact\n- second fact\n- third fact'
    expect(parseSummaryBullets(input)).toEqual([
      'first fact',
      'second fact',
      'third fact',
    ])
  })

  it('handles asterisk bullets', () => {
    const input = '* first\n* second\n* third'
    expect(parseSummaryBullets(input)).toEqual(['first', 'second', 'third'])
  })

  it('handles unicode bullet (\u2022)', () => {
    const input = '\u2022 first\n\u2022 second\n\u2022 third'
    expect(parseSummaryBullets(input)).toEqual(['first', 'second', 'third'])
  })

  it('truncates at 3 bullets', () => {
    const input = '- a\n- b\n- c\n- d\n- e'
    expect(parseSummaryBullets(input)).toEqual(['a', 'b', 'c'])
  })

  it('returns empty array on zero-bullet response', () => {
    expect(parseSummaryBullets('here is some prose')).toEqual([])
  })

  it('ignores blank lines between bullets', () => {
    const input = '- a\n\n- b\n  \n- c'
    expect(parseSummaryBullets(input)).toEqual(['a', 'b', 'c'])
  })
})

// ===========================================================================
// parseCategorizeResponse
// ===========================================================================

describe('parseCategorizeResponse', () => {
  it('parses a strict JSON response', () => {
    const raw = '{"category":"payment","confidence":0.92,"rationale":"PayPal mentioned"}'
    const res = parseCategorizeResponse(raw)
    expect(res).toEqual({
      category: 'payment',
      confidence: 0.92,
      rationale: 'PayPal mentioned',
    })
  })

  it('strips markdown code fences', () => {
    const raw = '```json\n{"category":"technical","confidence":0.5,"rationale":"setup"}\n```'
    const res = parseCategorizeResponse(raw)
    expect(res?.category).toBe('technical')
  })

  it('accepts every canonical category', () => {
    for (const c of SUPPORT_CATEGORIES) {
      const raw = `{"category":"${c}","confidence":0.5,"rationale":"x"}`
      expect(parseCategorizeResponse(raw)?.category).toBe(c)
    }
  })

  it('clamps confidence to [0,1]', () => {
    expect(
      parseCategorizeResponse(
        '{"category":"other","confidence":1.5,"rationale":"x"}',
      )?.confidence,
    ).toBe(1)
    expect(
      parseCategorizeResponse(
        '{"category":"other","confidence":-0.1,"rationale":"x"}',
      )?.confidence,
    ).toBe(0)
  })

  it('truncates rationale to 80 chars', () => {
    const long = 'x'.repeat(200)
    const res = parseCategorizeResponse(
      `{"category":"other","confidence":0.5,"rationale":"${long}"}`,
    )
    expect(res?.rationale.length).toBe(80)
  })

  it('returns null on malformed JSON', () => {
    expect(parseCategorizeResponse('{not json}')).toBeNull()
  })

  it('returns null on unknown category', () => {
    expect(
      parseCategorizeResponse(
        '{"category":"fish","confidence":0.5,"rationale":"x"}',
      ),
    ).toBeNull()
  })

  it('returns null on empty string', () => {
    expect(parseCategorizeResponse('')).toBeNull()
  })
})

// ===========================================================================
// parseSentimentResponse
// ===========================================================================

describe('parseSentimentResponse', () => {
  it('parses a 3-element response', () => {
    const raw = JSON.stringify([
      { index: 0, label: 'angry', score: 0.9 },
      { index: 1, label: 'neutral', score: 0.4 },
      { index: 2, label: 'happy', score: 0.7 },
    ])
    expect(parseSentimentResponse(raw, 3)).toHaveLength(3)
  })

  it('strips markdown fences', () => {
    const raw = '```json\n[{"index":0,"label":"angry","score":0.9}]\n```'
    expect(parseSentimentResponse(raw, 1)).toHaveLength(1)
  })

  it('rejects index out of range', () => {
    const raw = JSON.stringify([{ index: 5, label: 'angry', score: 0.9 }])
    expect(parseSentimentResponse(raw, 2)).toEqual([])
  })

  it('rejects unknown label', () => {
    const raw = JSON.stringify([{ index: 0, label: 'sad', score: 0.9 }])
    expect(parseSentimentResponse(raw, 1)).toEqual([])
  })

  it('clamps score to [0,1]', () => {
    const raw = JSON.stringify([{ index: 0, label: 'angry', score: 5 }])
    expect(parseSentimentResponse(raw, 1)[0].score).toBe(1)
  })

  it('returns [] on non-array', () => {
    expect(parseSentimentResponse('{"not":"array"}', 1)).toEqual([])
  })

  it('returns [] on JSON syntax error', () => {
    expect(parseSentimentResponse('not json', 1)).toEqual([])
  })
})

// ===========================================================================
// mapAnthropicError
// ===========================================================================

describe('mapAnthropicError', () => {
  it('maps 401 to auth', () => {
    const e = mapAnthropicError({ status: 401, message: 'bad key' })
    expect(e).toBeInstanceOf(SupportAIError)
    expect(e.kind).toBe('auth')
  })

  it('maps 403 to auth', () => {
    expect(mapAnthropicError({ status: 403, message: 'forbidden' }).kind).toBe(
      'auth',
    )
  })

  it('maps 429 to transient', () => {
    expect(mapAnthropicError({ status: 429, message: 'slow down' }).kind).toBe(
      'transient',
    )
  })

  it('maps 500 to transient', () => {
    expect(mapAnthropicError({ status: 500, message: 'srv err' }).kind).toBe(
      'transient',
    )
  })

  it('maps 503 to transient', () => {
    expect(mapAnthropicError({ status: 503, message: 'srv err' }).kind).toBe(
      'transient',
    )
  })

  it('maps content_filter to policy', () => {
    expect(
      mapAnthropicError({
        status: 400,
        message: 'blocked',
        error: { type: 'content_filter' },
      }).kind,
    ).toBe('policy')
  })

  it('maps unknown shapes to unknown', () => {
    expect(mapAnthropicError({ weird: 'shape' }).kind).toBe('unknown')
  })

  it('maps raw Error to unknown', () => {
    expect(mapAnthropicError(new Error('boom')).kind).toBe('unknown')
  })

  it('preserves status code', () => {
    expect(mapAnthropicError({ status: 429, message: 'x' }).statusCode).toBe(
      429,
    )
  })
})

// ===========================================================================
// config-store crypto round-trip
// ===========================================================================

describe('encryptAnthropicKey / decryptAnthropicKey', () => {
  // Use a fixed 32-byte hex key for deterministic tests.
  const testKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  let originalKey: string | undefined

  beforeEach(() => {
    originalKey = process.env.SUPPORT_AI_ENCRYPTION_KEY
    process.env.SUPPORT_AI_ENCRYPTION_KEY = testKey
  })

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.SUPPORT_AI_ENCRYPTION_KEY
    } else {
      process.env.SUPPORT_AI_ENCRYPTION_KEY = originalKey
    }
  })

  it('round-trips a plaintext key', () => {
    const plaintext = 'sk-ant-api-key-1234567890abcdef'
    const blob = encryptAnthropicKey(plaintext)
    expect(blob.v).toBe(1)
    expect(blob.ct).toMatch(/^[0-9a-f]+$/)
    expect(blob.iv).toMatch(/^[0-9a-f]+$/)
    expect(blob.tag).toMatch(/^[0-9a-f]+$/)
    expect(decryptAnthropicKey(blob)).toBe(plaintext)
  })

  it('produces a unique IV per encryption', () => {
    const a = encryptAnthropicKey('key1')
    const b = encryptAnthropicKey('key1')
    expect(a.iv).not.toBe(b.iv)
    expect(a.ct).not.toBe(b.ct)
  })

  it('throws on tag tamper', () => {
    const blob = encryptAnthropicKey('secret')
    const tampered = { ...blob, tag: 'a'.repeat(32) }
    expect(() => decryptAnthropicKey(tampered)).toThrow()
  })

  it('throws when env var is missing', () => {
    delete process.env.SUPPORT_AI_ENCRYPTION_KEY
    const origOauth = process.env.OAUTH_ENCRYPTION_KEY
    delete process.env.OAUTH_ENCRYPTION_KEY
    try {
      expect(() => encryptAnthropicKey('x')).toThrow(/Missing/)
    } finally {
      if (origOauth !== undefined) process.env.OAUTH_ENCRYPTION_KEY = origOauth
    }
  })

  it('returns empty string on null blob', () => {
    expect(decryptAnthropicKey(null)).toBe('')
    expect(decryptAnthropicKey(undefined)).toBe('')
  })

  it('returns empty string on wrong version blob', () => {
    // @ts-expect-error — deliberately wrong version
    expect(decryptAnthropicKey({ v: 2, ct: '', iv: '', tag: '' })).toBe('')
  })
})

describe('isEncryptedKeyBlob', () => {
  it('accepts a well-formed blob', () => {
    const blob = { v: 1, ct: 'ab', iv: 'cd', tag: 'ef' }
    expect(isEncryptedKeyBlob(blob)).toBe(true)
  })

  it('rejects null/undefined', () => {
    expect(isEncryptedKeyBlob(null)).toBe(false)
    expect(isEncryptedKeyBlob(undefined)).toBe(false)
  })

  it('rejects wrong version', () => {
    expect(isEncryptedKeyBlob({ v: 2, ct: '', iv: '', tag: '' })).toBe(false)
  })

  it('rejects missing field', () => {
    expect(isEncryptedKeyBlob({ v: 1, ct: '', iv: '' })).toBe(false)
  })

  it('rejects non-object', () => {
    expect(isEncryptedKeyBlob('string')).toBe(false)
    expect(isEncryptedKeyBlob(42)).toBe(false)
  })
})
