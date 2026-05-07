/**
 * Unit test — checkout handoff tokens (Step 2.1 of Decision #2).
 *
 * Scope:
 *   packages/core/src/modules/checkout/handoff.ts
 *
 * Cases:
 *   1. sign → verify → redeem → payload matches (happy path)
 *   2. expired token → HandoffTokenError('expired')
 *   3. tampered signature → HandoffTokenError('bad_signature')
 *   4. malformed payload (missing field) → HandoffTokenError('malformed')
 *   5. replay attack: second redeem of the same nonce → 'already_redeemed'
 *   6. tampered body bytes → 'bad_signature' (not malformed)
 *
 * Requires a running Redis (REDIS_URL env or default localhost:6379).
 * No database writes — this module is pure crypto + Redis.
 *
 * Run:
 *   REDIS_URL=redis://... npx tsx tests/checkout-handoff.test.ts
 */

import {
  signHandoffToken,
  verifyHandoffToken,
  storeHandoffNonce,
  redeemHandoffNonce,
  issueHandoffToken,
  consumeHandoffToken,
  HandoffTokenError,
  HANDOFF_TOKEN_TTL_MS,
} from '../packages/core/src/modules/checkout/handoff.js'
import { closeRedis } from '../packages/core/src/modules/cache/redis.js'

function assert(cond: any, msg: string): asserts cond {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg)
}

async function expectThrows(
  fn: () => Promise<unknown> | unknown,
  expectedCode: string,
  label: string,
): Promise<void> {
  let threw = false
  try {
    await fn()
  } catch (err) {
    threw = true
    assert(
      err instanceof HandoffTokenError,
      `${label}: wrong error class: ${(err as Error).constructor.name}`,
    )
    assert(
      (err as HandoffTokenError).code === expectedCode,
      `${label}: expected code "${expectedCode}", got "${(err as HandoffTokenError).code}" (${(err as Error).message})`,
    )
  }
  assert(threw, `${label}: expected to throw but did not`)
}

async function main() {
  const suffix = Math.random().toString(36).slice(2, 10)

  // Force a deterministic dev secret so the test runs without needing
  // CHECKOUT_HANDOFF_SECRET in the env.
  const savedSecret = process.env.CHECKOUT_HANDOFF_SECRET
  const savedEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'test'
  delete process.env.CHECKOUT_HANDOFF_SECRET

  try {
    // ========================================================================
    // Case 1 — happy path: sign + store + redeem round-trips the payload
    // ========================================================================
    const input = {
      checkoutId: `chk_test_${suffix}`,
      shopId: `shop_${suffix}`,
      customerId: `cust_${suffix}`,
    }
    const signed = signHandoffToken(input)
    assert(signed.token.includes('.'), 'token should have a "." separator')
    assert(signed.payload.checkoutId === input.checkoutId, 'payload checkoutId')
    assert(signed.payload.shopId === input.shopId, 'payload shopId')
    assert(signed.payload.customerId === input.customerId, 'payload customerId')
    assert(signed.payload.nonce.length === 32, 'nonce should be 16 bytes hex')
    assert(
      signed.payload.exp === signed.payload.iat + HANDOFF_TOKEN_TTL_MS,
      'exp == iat + TTL',
    )

    // Verify is pure — no side effects, call twice.
    const v1 = verifyHandoffToken(signed.token)
    const v2 = verifyHandoffToken(signed.token)
    assert(v1.nonce === v2.nonce, 'verify is idempotent')
    assert(v1.checkoutId === input.checkoutId, 'verified checkoutId matches')

    const stored = await storeHandoffNonce(signed.payload)
    assert(stored === true, 'storeHandoffNonce should return true on first store')

    const redeemed = await redeemHandoffNonce(signed.payload.nonce)
    assert(
      redeemed.checkoutId === input.checkoutId,
      `redeemed checkoutId wrong: ${redeemed.checkoutId}`,
    )
    assert(redeemed.shopId === input.shopId, 'redeemed shopId matches')
    assert(redeemed.customerId === input.customerId, 'redeemed customerId matches')
    console.log('PASS 1/6 — sign → verify → store → redeem happy path')

    // ========================================================================
    // Case 2 — expired token
    // ========================================================================
    const expiredInput = {
      checkoutId: `chk_exp_${suffix}`,
      shopId: `shop_${suffix}`,
      customerId: null,
      now: Date.now() - HANDOFF_TOKEN_TTL_MS - 1000, // issued 5m1s ago
    }
    const expired = signHandoffToken(expiredInput)
    await expectThrows(
      () => verifyHandoffToken(expired.token),
      'expired',
      'Case 2',
    )
    console.log('PASS 2/6 — expired token rejected')

    // ========================================================================
    // Case 3 — tampered signature (flip one char)
    // ========================================================================
    const good = signHandoffToken({
      checkoutId: `chk_tamper_${suffix}`,
      shopId: `shop_${suffix}`,
      customerId: null,
    })
    const dot = good.token.indexOf('.')
    const body = good.token.slice(0, dot)
    const sig = good.token.slice(dot + 1)
    // Flip a character in the MIDDLE of the signature. The final char
    // of a base64url-encoded 32-byte hash only carries 4 meaningful
    // bits (256 bits / 6 bits per char = 42.67 chars) so a last-char
    // flip can be a no-op at the decoded level. Middle chars use all
    // 6 bits so any flip changes the bytes and fails the MAC check.
    const mid = Math.floor(sig.length / 2)
    const midChar = sig[mid]
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const altChar = alphabet[(alphabet.indexOf(midChar) + 17) % alphabet.length]
    const tamperedSig = sig.slice(0, mid) + altChar + sig.slice(mid + 1)
    const tamperedToken = `${body}.${tamperedSig}`
    await expectThrows(
      () => verifyHandoffToken(tamperedToken),
      'bad_signature',
      'Case 3',
    )
    console.log('PASS 3/6 — tampered signature rejected (bad_signature)')

    // ========================================================================
    // Case 4 — malformed token (no dot separator)
    // ========================================================================
    await expectThrows(
      () => verifyHandoffToken('not-a-real-token-at-all'),
      'malformed',
      'Case 4',
    )
    // Empty string
    await expectThrows(
      () => verifyHandoffToken(''),
      'malformed',
      'Case 4 (empty)',
    )
    console.log('PASS 4/6 — malformed tokens rejected')

    // ========================================================================
    // Case 5 — replay attack: second redeem of the same nonce
    // ========================================================================
    const replay = await issueHandoffToken({
      checkoutId: `chk_replay_${suffix}`,
      shopId: `shop_${suffix}`,
      customerId: `cust_${suffix}`,
    })
    // First consume wins.
    const first = await consumeHandoffToken(replay.token)
    assert(first.nonce === replay.payload.nonce, 'first consume returns nonce')
    // Second consume must reject.
    await expectThrows(
      () => consumeHandoffToken(replay.token),
      'already_redeemed',
      'Case 5',
    )
    console.log('PASS 5/6 — replay attack rejected (already_redeemed)')

    // ========================================================================
    // Case 6 — tampered body bytes (still b64url-shaped, different content)
    // ========================================================================
    const clean = signHandoffToken({
      checkoutId: `chk_body_${suffix}`,
      shopId: `shop_${suffix}`,
      customerId: null,
    })
    const cleanDot = clean.token.indexOf('.')
    const cleanBody = clean.token.slice(0, cleanDot)
    const cleanSig = clean.token.slice(cleanDot + 1)
    // Flip a character in the body — signature will no longer match.
    const bodyFlipped =
      cleanBody[0] === 'a'
        ? 'b' + cleanBody.slice(1)
        : 'a' + cleanBody.slice(1)
    await expectThrows(
      () => verifyHandoffToken(`${bodyFlipped}.${cleanSig}`),
      'bad_signature',
      'Case 6',
    )
    console.log('PASS 6/6 — tampered body rejected (bad_signature)')

    console.log('\nALL PASSED — handoff token module is sound')
  } finally {
    if (savedSecret !== undefined) {
      process.env.CHECKOUT_HANDOFF_SECRET = savedSecret
    }
    if (savedEnv !== undefined) {
      process.env.NODE_ENV = savedEnv
    } else {
      delete process.env.NODE_ENV
    }
    await closeRedis().catch(() => {})
  }
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  console.error(err.stack)
  process.exit(1)
})
