/**
 * Gbox Platform — Checkout Handoff Token Unit Tests
 *
 * CI-suitable vitest coverage for `handoff.ts`. The original Step 2.1
 * tests live in `tests/checkout-handoff.test.ts` but require a running
 * Redis instance, so they don't run under `npm test`. This file covers
 * the pure-crypto half (sign + verify + all error modes) and mocks
 * `getRedis` for the Redis-dependent half (store + redeem + replay).
 *
 * Run:
 *   npx vitest run packages/core/src/modules/checkout/handoff.test.ts
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Redis mock — lives at top-level so `vi.mock` can hoist before imports
// ---------------------------------------------------------------------------

const fakeRedisStore = new Map<string, string>()

function makeFakeRedis() {
  return {
    async set(
      key: string,
      value: string,
      opts?: { NX?: boolean; EX?: number },
    ) {
      if (opts?.NX && fakeRedisStore.has(key)) return null
      fakeRedisStore.set(key, value)
      return 'OK'
    },
    async get(key: string) {
      return fakeRedisStore.get(key) ?? null
    },
    async del(key: string) {
      const had = fakeRedisStore.delete(key)
      return had ? 1 : 0
    },
  }
}

vi.mock('../cache/redis.js', () => ({
  getRedis: vi.fn(async () => makeFakeRedis()),
}))

// Import AFTER the mock is registered.
import {
  signHandoffToken,
  verifyHandoffToken,
  storeHandoffNonce,
  redeemHandoffNonce,
  issueHandoffToken,
  consumeHandoffToken,
  HandoffTokenError,
  HANDOFF_TOKEN_TTL_MS,
} from './handoff.js'

// ---------------------------------------------------------------------------
// Shared fixture values
// ---------------------------------------------------------------------------

const CHECKOUT_ID = 'chk_test_123'
const SHOP_ID = 'shop_test_abc'
const CUSTOMER_ID = 'cust_test_xyz'

beforeEach(() => {
  fakeRedisStore.clear()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// signHandoffToken — pure, no Redis
// ---------------------------------------------------------------------------

describe('signHandoffToken', () => {
  it('produces a token with a body.signature shape', () => {
    const { token, payload } = signHandoffToken({
      checkoutId: CHECKOUT_ID,
      shopId: SHOP_ID,
      customerId: CUSTOMER_ID,
    })
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(payload.checkoutId).toBe(CHECKOUT_ID)
    expect(payload.shopId).toBe(SHOP_ID)
    expect(payload.customerId).toBe(CUSTOMER_ID)
    expect(payload.nonce).toMatch(/^[0-9a-f]{32}$/) // 16 bytes hex
  })

  it('sets exp = iat + HANDOFF_TOKEN_TTL_MS', () => {
    const now = 1_700_000_000_000
    const { payload } = signHandoffToken({
      checkoutId: CHECKOUT_ID,
      shopId: SHOP_ID,
      customerId: null,
      now,
    })
    expect(payload.iat).toBe(now)
    expect(payload.exp).toBe(now + HANDOFF_TOKEN_TTL_MS)
  })

  it('accepts null customerId (guest checkout)', () => {
    const { payload } = signHandoffToken({
      checkoutId: CHECKOUT_ID,
      shopId: SHOP_ID,
      customerId: null,
    })
    expect(payload.customerId).toBeNull()
  })

  it('generates a fresh nonce on every call', () => {
    const a = signHandoffToken({
      checkoutId: CHECKOUT_ID,
      shopId: SHOP_ID,
      customerId: null,
    })
    const b = signHandoffToken({
      checkoutId: CHECKOUT_ID,
      shopId: SHOP_ID,
      customerId: null,
    })
    expect(a.payload.nonce).not.toBe(b.payload.nonce)
    expect(a.token).not.toBe(b.token)
  })

  it('rejects empty checkoutId', () => {
    expect(() =>
      signHandoffToken({ checkoutId: '', shopId: SHOP_ID, customerId: null }),
    ).toThrow(HandoffTokenError)
  })

  it('rejects empty shopId', () => {
    expect(() =>
      signHandoffToken({ checkoutId: CHECKOUT_ID, shopId: '', customerId: null }),
    ).toThrow(HandoffTokenError)
  })
})

// ---------------------------------------------------------------------------
// verifyHandoffToken — pure, no Redis
// ---------------------------------------------------------------------------

describe('verifyHandoffToken', () => {
  it('round-trips a freshly signed token', () => {
    const { token, payload } = signHandoffToken({
      checkoutId: CHECKOUT_ID,
      shopId: SHOP_ID,
      customerId: CUSTOMER_ID,
    })
    const verified = verifyHandoffToken(token)
    expect(verified).toEqual(payload)
  })

  it('rejects empty string', () => {
    expect(() => verifyHandoffToken('')).toThrow(
      expect.objectContaining({ code: 'malformed' }),
    )
  })

  it('rejects token without a dot separator', () => {
    expect(() => verifyHandoffToken('no-separator-here')).toThrow(
      expect.objectContaining({ code: 'malformed' }),
    )
  })

  it('rejects token with dot at position zero', () => {
    expect(() => verifyHandoffToken('.sigonly')).toThrow(
      expect.objectContaining({ code: 'malformed' }),
    )
  })

  it('rejects token with dot at last position', () => {
    expect(() => verifyHandoffToken('bodyonly.')).toThrow(
      expect.objectContaining({ code: 'malformed' }),
    )
  })

  it('rejects a tampered signature with code=bad_signature', () => {
    const { token } = signHandoffToken({
      checkoutId: CHECKOUT_ID,
      shopId: SHOP_ID,
      customerId: null,
    })
    // Flip the last character of the signature to something clearly different.
    const last = token.slice(-1)
    const replacement = last === 'A' ? 'B' : 'A'
    const tampered = token.slice(0, -1) + replacement
    expect(() => verifyHandoffToken(tampered)).toThrow(
      expect.objectContaining({ code: 'bad_signature' }),
    )
  })

  it('rejects a tampered body (different body, stale signature)', () => {
    const { token } = signHandoffToken({
      checkoutId: CHECKOUT_ID,
      shopId: SHOP_ID,
      customerId: null,
    })
    const dot = token.indexOf('.')
    // Replace body with garbage that still looks base64url-ish.
    const forged = 'aGVsbG93b3JsZA' + token.slice(dot)
    expect(() => verifyHandoffToken(forged)).toThrow(
      expect.objectContaining({ code: 'bad_signature' }),
    )
  })

  it('rejects a token past its exp with code=expired', () => {
    const iat = 1_700_000_000_000
    const { token } = signHandoffToken({
      checkoutId: CHECKOUT_ID,
      shopId: SHOP_ID,
      customerId: null,
      now: iat,
    })
    // Verify at exp + 1ms — should be rejected.
    expect(() =>
      verifyHandoffToken(token, { now: iat + HANDOFF_TOKEN_TTL_MS + 1 }),
    ).toThrow(expect.objectContaining({ code: 'expired' }))
  })

  it('accepts a token issued exactly `exp - 1` ms ago', () => {
    const iat = 1_700_000_000_000
    const { token } = signHandoffToken({
      checkoutId: CHECKOUT_ID,
      shopId: SHOP_ID,
      customerId: null,
      now: iat,
    })
    const verified = verifyHandoffToken(token, {
      now: iat + HANDOFF_TOKEN_TTL_MS - 1,
    })
    expect(verified.checkoutId).toBe(CHECKOUT_ID)
  })

  it('rejects tokens from the future (clock skew > 30s)', () => {
    const futureIat = 1_700_000_000_000
    const { token } = signHandoffToken({
      checkoutId: CHECKOUT_ID,
      shopId: SHOP_ID,
      customerId: null,
      now: futureIat,
    })
    // Verify BEFORE iat by more than 30 seconds — reject as malformed.
    expect(() =>
      verifyHandoffToken(token, { now: futureIat - 60_000 }),
    ).toThrow(expect.objectContaining({ code: 'malformed' }))
  })
})

// ---------------------------------------------------------------------------
// storeHandoffNonce + redeemHandoffNonce — Redis mocked
// ---------------------------------------------------------------------------

describe('storeHandoffNonce / redeemHandoffNonce', () => {
  it('stores a fresh nonce and returns true', async () => {
    const { payload } = signHandoffToken({
      checkoutId: CHECKOUT_ID,
      shopId: SHOP_ID,
      customerId: CUSTOMER_ID,
    })
    const stored = await storeHandoffNonce(payload)
    expect(stored).toBe(true)
    expect(fakeRedisStore.size).toBe(1)
  })

  it('refuses to overwrite an existing nonce (NX semantics)', async () => {
    const { payload } = signHandoffToken({
      checkoutId: CHECKOUT_ID,
      shopId: SHOP_ID,
      customerId: null,
    })
    const first = await storeHandoffNonce(payload)
    const second = await storeHandoffNonce(payload)
    expect(first).toBe(true)
    expect(second).toBe(false)
  })

  it('redeems a stored nonce and returns the metadata', async () => {
    const { payload } = signHandoffToken({
      checkoutId: CHECKOUT_ID,
      shopId: SHOP_ID,
      customerId: CUSTOMER_ID,
    })
    await storeHandoffNonce(payload)

    const redeemed = await redeemHandoffNonce(payload.nonce)
    expect(redeemed).toEqual({
      checkoutId: CHECKOUT_ID,
      shopId: SHOP_ID,
      customerId: CUSTOMER_ID,
    })
    // After redeem the store must be empty (one-shot).
    expect(fakeRedisStore.size).toBe(0)
  })

  it('rejects replay: second redeem throws already_redeemed', async () => {
    const { payload } = signHandoffToken({
      checkoutId: CHECKOUT_ID,
      shopId: SHOP_ID,
      customerId: null,
    })
    await storeHandoffNonce(payload)
    await redeemHandoffNonce(payload.nonce)

    await expect(redeemHandoffNonce(payload.nonce)).rejects.toThrow(
      expect.objectContaining({ code: 'already_redeemed' }),
    )
  })

  it('rejects unknown nonce as already_redeemed', async () => {
    await expect(
      redeemHandoffNonce('deadbeefdeadbeefdeadbeefdeadbeef'),
    ).rejects.toThrow(expect.objectContaining({ code: 'already_redeemed' }))
  })

  it('rejects empty nonce as malformed', async () => {
    await expect(redeemHandoffNonce('')).rejects.toThrow(
      expect.objectContaining({ code: 'malformed' }),
    )
  })
})

// ---------------------------------------------------------------------------
// Composites: issueHandoffToken + consumeHandoffToken
// ---------------------------------------------------------------------------

describe('issueHandoffToken', () => {
  it('signs AND stores atomically — token is redeemable', async () => {
    const signed = await issueHandoffToken({
      checkoutId: CHECKOUT_ID,
      shopId: SHOP_ID,
      customerId: CUSTOMER_ID,
    })
    expect(signed.token).toBeTruthy()
    // Redis should now hold the nonce.
    expect(fakeRedisStore.size).toBe(1)
    // And we can consume it.
    const payload = await consumeHandoffToken(signed.token)
    expect(payload.checkoutId).toBe(CHECKOUT_ID)
    expect(fakeRedisStore.size).toBe(0)
  })
})

describe('consumeHandoffToken', () => {
  it('verifies signature AND deletes nonce in one call', async () => {
    const signed = await issueHandoffToken({
      checkoutId: CHECKOUT_ID,
      shopId: SHOP_ID,
      customerId: null,
    })
    const payload = await consumeHandoffToken(signed.token)
    expect(payload.shopId).toBe(SHOP_ID)
    // Second consume must fail — one-shot.
    await expect(consumeHandoffToken(signed.token)).rejects.toThrow(
      expect.objectContaining({ code: 'already_redeemed' }),
    )
  })

  it('rejects tampered tokens before touching Redis', async () => {
    const signed = await issueHandoffToken({
      checkoutId: CHECKOUT_ID,
      shopId: SHOP_ID,
      customerId: null,
    })
    // Tamper the signature half by replacing its last 8 chars with a
    // fixed known-bad suffix. The previous 1-char flip was theoretically
    // correct but produced a rare intermittent CI flake — harden by
    // guaranteeing a multi-byte signature delta that can never coincide
    // with the genuine HMAC output.
    const dotIdx = signed.token.indexOf('.')
    expect(dotIdx).toBeGreaterThan(0) // sanity — shape is "body.signature"
    const body = signed.token.slice(0, dotIdx)
    const sig = signed.token.slice(dotIdx + 1)
    const bad = body + '.' + sig.slice(0, -8) + 'AAAAAAAA'
    expect(bad).not.toBe(signed.token) // tampered must differ
    await expect(consumeHandoffToken(bad)).rejects.toThrow(
      expect.objectContaining({ code: 'bad_signature' }),
    )
    // Redis must still hold the original nonce (not deleted by failed verify).
    expect(fakeRedisStore.size).toBe(1)
  })
})
