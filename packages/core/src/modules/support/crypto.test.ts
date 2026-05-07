/**
 * Gbox Platform — Support message encryption unit tests.
 *
 * Covers the AES-256-GCM wire format pinned by migration 074:
 *
 *   - 32-byte key, 12-byte IV, 16-byte tag
 *   - hex env parsing rejects short/long/non-hex input loudly
 *   - encrypt → decrypt roundtrip is byte-exact for ASCII, UTF-8, emoji
 *   - auth-tag tamper detection throws (so queries.safelyDecrypt hides it)
 *   - rotation helper decrypts with old key + re-encrypts with new key
 *   - resolveCurrentKey / resolveKeyForVersion read env correctly
 */
import { describe, it, expect } from 'vitest'
import {
  SUPPORT_MESSAGE_KEY_ENV,
  decryptMessage,
  encryptMessage,
  generateMessageKey,
  parseMessageKey,
  resolveCurrentKey,
  resolveKeyForVersion,
  rotateMessage,
} from './crypto.ts'

function key32(): Buffer {
  // Deterministic-ish key derived from a literal so tests don't depend
  // on env or platform crypto state. Not a secret — it's in the repo.
  return Buffer.from(
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    'hex',
  )
}

function altKey32(): Buffer {
  return Buffer.from(
    'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
    'hex',
  )
}

describe('parseMessageKey', () => {
  it('accepts a valid 64-char hex string', () => {
    const buf = parseMessageKey(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    )
    expect(buf.length).toBe(32)
  })

  it('rejects empty string', () => {
    expect(() => parseMessageKey('')).toThrow(/is empty/)
  })

  it('rejects non-hex characters', () => {
    expect(() => parseMessageKey('zzzz' + 'a'.repeat(60))).toThrow(/must be hex/)
  })

  it('rejects short hex (not 32 bytes)', () => {
    expect(() => parseMessageKey('deadbeef')).toThrow(/32 bytes/)
  })

  it('rejects long hex (> 32 bytes)', () => {
    expect(() =>
      parseMessageKey('00'.repeat(40)),
    ).toThrow(/32 bytes/)
  })
})

describe('encryptMessage / decryptMessage', () => {
  it('roundtrips ASCII text', () => {
    const key = key32()
    const enc = encryptMessage('Hello Gbox support', key)
    expect(enc.ciphertext.length).toBeGreaterThan(0)
    expect(enc.iv.length).toBe(12)
    expect(enc.tag.length).toBe(16)
    expect(enc.keyVersion).toBe(1)
    const plain = decryptMessage(enc, key)
    expect(plain).toBe('Hello Gbox support')
  })

  it('roundtrips UTF-8 (Vietnamese)', () => {
    const key = key32()
    const input = 'Xin chào Gbox, đơn hàng của tôi có vấn đề với thanh toán.'
    const enc = encryptMessage(input, key)
    expect(decryptMessage(enc, key)).toBe(input)
  })

  it('roundtrips emoji + mixed script', () => {
    const key = key32()
    const input = '订单 ORDER#1234 đã thanh toán 🎉 50% OFF'
    const enc = encryptMessage(input, key)
    expect(decryptMessage(enc, key)).toBe(input)
  })

  it('produces a fresh IV per call (no nonce reuse)', () => {
    const key = key32()
    const a = encryptMessage('same plaintext', key)
    const b = encryptMessage('same plaintext', key)
    expect(a.iv.equals(b.iv)).toBe(false)
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false)
  })

  it('rejects empty plaintext', () => {
    expect(() => encryptMessage('', key32())).toThrow(/empty/)
  })

  it('rejects non-string plaintext', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => encryptMessage(42 as any, key32())).toThrow(/string/)
  })

  it('rejects wrong-length key on encrypt', () => {
    expect(() => encryptMessage('x', Buffer.from('short'))).toThrow(/32 bytes/)
  })

  it('rejects wrong-length key on decrypt', () => {
    const enc = encryptMessage('x', key32())
    expect(() => decryptMessage(enc, Buffer.from('short'))).toThrow(/32 bytes/)
  })

  it('rejects a tampered auth tag', () => {
    const key = key32()
    const enc = encryptMessage('tamper me', key)
    const badTag = Buffer.from(enc.tag)
    badTag[0] ^= 0xff
    expect(() =>
      decryptMessage({ ciphertext: enc.ciphertext, iv: enc.iv, tag: badTag }, key),
    ).toThrow()
  })

  it('rejects a tampered ciphertext', () => {
    const key = key32()
    const enc = encryptMessage('tamper me', key)
    const badCt = Buffer.from(enc.ciphertext)
    badCt[0] ^= 0xff
    expect(() =>
      decryptMessage({ ciphertext: badCt, iv: enc.iv, tag: enc.tag }, key),
    ).toThrow()
  })

  it('rejects a wrong-key decrypt', () => {
    const enc = encryptMessage('wrong key test', key32())
    expect(() => decryptMessage(enc, altKey32())).toThrow()
  })

  it('rejects bad iv length on decrypt', () => {
    const enc = encryptMessage('x', key32())
    expect(() =>
      decryptMessage(
        { ciphertext: enc.ciphertext, iv: Buffer.alloc(8), tag: enc.tag },
        key32(),
      ),
    ).toThrow(/iv length/)
  })

  it('rejects bad tag length on decrypt', () => {
    const enc = encryptMessage('x', key32())
    expect(() =>
      decryptMessage(
        { ciphertext: enc.ciphertext, iv: enc.iv, tag: Buffer.alloc(8) },
        key32(),
      ),
    ).toThrow(/tag length/)
  })
})

describe('rotateMessage', () => {
  it('decrypts under old key + re-encrypts under new key', () => {
    const oldKey = key32()
    const newKey = altKey32()
    const enc1 = encryptMessage('rotate-me', oldKey, 1)
    const enc2 = rotateMessage(enc1, oldKey, newKey, 2)
    expect(enc2.keyVersion).toBe(2)
    expect(decryptMessage(enc2, newKey)).toBe('rotate-me')
    // Old key no longer works on new ciphertext.
    expect(() => decryptMessage(enc2, oldKey)).toThrow()
  })
})

describe('generateMessageKey', () => {
  it('produces a 64-char hex string', () => {
    const hex = generateMessageKey()
    expect(hex).toMatch(/^[0-9a-f]{64}$/)
    // Parseable back to 32-byte buffer.
    expect(parseMessageKey(hex).length).toBe(32)
  })

  it('produces a fresh key each call', () => {
    expect(generateMessageKey()).not.toBe(generateMessageKey())
  })
})

describe('resolveCurrentKey', () => {
  it('reads the key from env + defaults version to 1', () => {
    const hex = generateMessageKey()
    const { key, version } = resolveCurrentKey({
      [SUPPORT_MESSAGE_KEY_ENV]: hex,
    })
    expect(key.length).toBe(32)
    expect(version).toBe(1)
  })

  it('respects explicit version env var', () => {
    const hex = generateMessageKey()
    const { version } = resolveCurrentKey({
      [SUPPORT_MESSAGE_KEY_ENV]: hex,
      SUPPORT_MESSAGE_KEY_CURRENT_VERSION: '3',
    })
    expect(version).toBe(3)
  })

  it('throws when env var is absent', () => {
    expect(() => resolveCurrentKey({})).toThrow(/not set/)
  })

  it('throws when version is not a positive int', () => {
    const hex = generateMessageKey()
    expect(() =>
      resolveCurrentKey({
        [SUPPORT_MESSAGE_KEY_ENV]: hex,
        SUPPORT_MESSAGE_KEY_CURRENT_VERSION: '0',
      }),
    ).toThrow(/positive integer/)
    expect(() =>
      resolveCurrentKey({
        [SUPPORT_MESSAGE_KEY_ENV]: hex,
        SUPPORT_MESSAGE_KEY_CURRENT_VERSION: 'abc',
      }),
    ).toThrow(/positive integer/)
  })
})

describe('resolveKeyForVersion', () => {
  it('returns the base env key for version=1', () => {
    const hex = generateMessageKey()
    const key = resolveKeyForVersion(1, { [SUPPORT_MESSAGE_KEY_ENV]: hex })
    expect(key.length).toBe(32)
  })

  it('returns the versioned env key for version>1', () => {
    const hex = generateMessageKey()
    const key = resolveKeyForVersion(2, {
      [`${SUPPORT_MESSAGE_KEY_ENV}_V2`]: hex,
    })
    expect(key.length).toBe(32)
  })

  it('throws if the versioned env key is missing', () => {
    expect(() => resolveKeyForVersion(5, {})).toThrow(/not set/)
  })

  it('throws on invalid version (< 1)', () => {
    expect(() => resolveKeyForVersion(0)).toThrow(/invalid key version/)
    expect(() => resolveKeyForVersion(-1)).toThrow(/invalid key version/)
  })
})
