/**
 * Gbox Platform — Checkout Handoff Tokens (Decision #2)
 *
 * Signed, one-shot, short-lived tokens that let a storefront on a custom
 * domain (e.g. `shop.acme.com`) hand a buyer off to the Gbox-controlled
 * checkout subdomain (`checkout.gbox.co`) without leaking the customer
 * session cookie across eTLD+1 boundaries.
 *
 * Flow:
 *   1. Storefront calls `POST /api/store/:slug/checkout/handoff-token`
 *      → server calls `signHandoffToken({ checkoutId, shopId, customerId })`
 *      → stores `handoff:nonce:<nonce>` in Redis with TTL, returns token
 *   2. Browser navigates to `https://checkout.gbox.co/c/<checkoutId>?hop=<token>`
 *   3. `apps/checkout` calls `redeemHandoffToken(token)` — signature check
 *      + Redis DEL (atomic one-shot). First redeem wins.
 *   4. On success the checkout app mints a Domain=.gbox.co session cookie
 *      and 302s to the same URL without the `hop` query param.
 *
 * Security properties:
 *   - HMAC-SHA256 signed with `CHECKOUT_HANDOFF_SECRET` (32-byte random env).
 *   - Signature verified with `timingSafeEqual` — no string-compare timing.
 *   - Expiry carried in the payload (`exp` field, ms epoch) AND enforced
 *     independently by the Redis TTL, so a leaked token is useless after
 *     5 minutes even if the Redis key is somehow resurrected.
 *   - Nonce DEL is atomic (`redis.del()` returns the count of keys
 *     actually deleted) — a replay returns 0 and we reject.
 *   - Body is base64url(JSON) so it is URL-safe without percent-encoding.
 *   - NO sensitive data in the payload — only ids the caller already has.
 *     The cookie mint happens server-side after verification.
 *
 * Env:
 *   CHECKOUT_HANDOFF_SECRET  32+ byte random string. REQUIRED in production
 *                            (fail-fast at first call). Dev falls back to
 *                            a deterministic hash of NODE_ENV so tests
 *                            without the env var still work.
 *
 * Related:
 *   docs/superpowers/specs/2026-04-08-checkout-subdomain-split.md
 */

import crypto from 'node:crypto'
import { getRedis } from '../cache/redis.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long a handoff token is valid for (milliseconds). */
export const HANDOFF_TOKEN_TTL_MS = 5 * 60 * 1000 // 5 minutes (owner-approved)

/** Redis key prefix for the one-shot nonce store. */
const NONCE_KEY_PREFIX = 'handoff:nonce:'

/** Dev fallback secret — NEVER used in production. */
const DEV_FALLBACK_SECRET =
  'gbox-dev-handoff-secret-do-not-use-in-production-0123456789abcdef'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HandoffTokenPayload {
  /** Gbox checkout session id (`chk_xxx`). */
  checkoutId: string
  /** Shop uuid that owns the checkout. */
  shopId: string
  /** Authenticated customer uuid, or null if the buyer is a guest. */
  customerId: string | null
  /** Issued-at, ms since epoch. */
  iat: number
  /** Expiry, ms since epoch. Must equal iat + HANDOFF_TOKEN_TTL_MS. */
  exp: number
  /** 16-byte hex nonce, also used as the Redis one-shot key. */
  nonce: string
}

export interface SignedHandoffToken {
  /** The token string to hand to the browser (base64url payload + '.' + base64url sig). */
  token: string
  /** The payload we just signed (for callers that want to log it). */
  payload: HandoffTokenPayload
}

export class HandoffTokenError extends Error {
  constructor(public code: HandoffErrorCode, message: string) {
    super(message)
    this.name = 'HandoffTokenError'
  }
}

export type HandoffErrorCode =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'already_redeemed'
  | 'redis_unavailable'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSecret(): Buffer {
  const envSecret = process.env.CHECKOUT_HANDOFF_SECRET
  if (envSecret && envSecret.length >= 32) {
    return Buffer.from(envSecret, 'utf8')
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[handoff] CHECKOUT_HANDOFF_SECRET is required in production ' +
        '(must be 32+ bytes). Set a random value in your env and restart.',
    )
  }
  return Buffer.from(DEV_FALLBACK_SECRET, 'utf8')
}

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function base64urlDecode(s: string): Buffer {
  // Restore '=' padding for Node's base64 decoder.
  const pad = 4 - (s.length % 4)
  const padded = pad === 4 ? s : s + '='.repeat(pad)
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function hmac(secret: Buffer, data: string): Buffer {
  return crypto.createHmac('sha256', secret).update(data).digest()
}

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------

/**
 * Mint a new handoff token. The caller is responsible for persisting the
 * nonce in Redis via `storeHandoffNonce()` before returning the token to
 * the browser — we keep the two operations separate so tests can verify
 * each piece in isolation.
 */
export function signHandoffToken(input: {
  checkoutId: string
  shopId: string
  customerId: string | null
  now?: number // injectable for tests
}): SignedHandoffToken {
  if (!input.checkoutId || !input.shopId) {
    throw new HandoffTokenError('malformed', 'checkoutId and shopId are required')
  }

  const now = input.now ?? Date.now()
  const payload: HandoffTokenPayload = {
    checkoutId: input.checkoutId,
    shopId: input.shopId,
    customerId: input.customerId ?? null,
    iat: now,
    exp: now + HANDOFF_TOKEN_TTL_MS,
    nonce: crypto.randomBytes(16).toString('hex'),
  }

  const body = base64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'))
  const sig = base64urlEncode(hmac(getSecret(), body))
  return {
    token: `${body}.${sig}`,
    payload,
  }
}

// ---------------------------------------------------------------------------
// Verify (signature + expiry only — NOT the nonce)
// ---------------------------------------------------------------------------

/**
 * Verify the signature and the expiry window on a token. This is a pure
 * function: it does NOT touch Redis and does NOT enforce one-shot-ness.
 * Pair with `redeemHandoffNonce()` for the full check.
 *
 * Throws `HandoffTokenError` with a specific `.code` on failure. Callers
 * should map the code to an HTTP status (typically 400 for malformed,
 * 401 for bad_signature/expired).
 */
export function verifyHandoffToken(
  token: string,
  opts: { now?: number } = {},
): HandoffTokenPayload {
  if (!token || typeof token !== 'string') {
    throw new HandoffTokenError('malformed', 'token is empty')
  }
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) {
    throw new HandoffTokenError('malformed', 'token is missing signature section')
  }
  const body = token.slice(0, dot)
  const sigPart = token.slice(dot + 1)

  // Constant-time signature check.
  const expected = hmac(getSecret(), body)
  let provided: Buffer
  try {
    provided = base64urlDecode(sigPart)
  } catch {
    throw new HandoffTokenError('malformed', 'signature is not valid base64url')
  }
  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  ) {
    throw new HandoffTokenError('bad_signature', 'signature does not verify')
  }

  // Decode the payload after we've authenticated it.
  let payload: HandoffTokenPayload
  try {
    payload = JSON.parse(base64urlDecode(body).toString('utf8'))
  } catch {
    throw new HandoffTokenError('malformed', 'payload is not valid JSON')
  }

  // Sanity-check the shape — an attacker could have a VALID signature on
  // a bogus payload only if they own the secret, but be paranoid.
  if (
    typeof payload.checkoutId !== 'string' ||
    typeof payload.shopId !== 'string' ||
    (payload.customerId !== null && typeof payload.customerId !== 'string') ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number' ||
    typeof payload.nonce !== 'string'
  ) {
    throw new HandoffTokenError('malformed', 'payload fields are invalid')
  }

  const now = opts.now ?? Date.now()
  if (now >= payload.exp) {
    throw new HandoffTokenError(
      'expired',
      `token expired at ${new Date(payload.exp).toISOString()}`,
    )
  }
  // Reject tokens issued in the future by more than a clock-skew window.
  // 30s of skew is generous for our intra-rack deployment.
  if (payload.iat > now + 30_000) {
    throw new HandoffTokenError(
      'malformed',
      'token iat is more than 30s in the future — clock skew?',
    )
  }

  return payload
}

// ---------------------------------------------------------------------------
// Redis one-shot nonce store
// ---------------------------------------------------------------------------

/**
 * Persist the nonce for a signed token. Uses SET NX so a second call
 * with the same nonce returns false and the caller can treat it as a
 * programming error (signHandoffToken generates 16-byte random, so a
 * real collision is astronomically unlikely).
 *
 * TTL is the token's remaining lifetime in seconds. Redis will auto-expire
 * even if redemption never happens, so abandoned carts don't leak keys.
 */
export async function storeHandoffNonce(
  payload: HandoffTokenPayload,
): Promise<boolean> {
  const ttlMs = Math.max(1, payload.exp - Date.now())
  const ttlSeconds = Math.ceil(ttlMs / 1000)
  try {
    const redis = await getRedis()
    const result = await redis.set(
      `${NONCE_KEY_PREFIX}${payload.nonce}`,
      JSON.stringify({
        checkoutId: payload.checkoutId,
        shopId: payload.shopId,
        customerId: payload.customerId,
        iat: payload.iat,
      }),
      { NX: true, EX: ttlSeconds },
    )
    return result === 'OK'
  } catch (err) {
    throw new HandoffTokenError(
      'redis_unavailable',
      `Redis unavailable during handoff nonce store: ${(err as Error).message}`,
    )
  }
}

/**
 * Atomically consume a handoff nonce. Returns the stored metadata on
 * first redemption; throws `already_redeemed` on the second call.
 *
 * Implementation uses `redis.del()` and checks the returned count — if
 * the key existed and was deleted, count=1; otherwise count=0. This is
 * the same pattern node-redis recommends for one-shot tokens (no need
 * for a Lua script).
 */
export async function redeemHandoffNonce(
  nonce: string,
): Promise<{ checkoutId: string; shopId: string; customerId: string | null }> {
  if (!nonce || typeof nonce !== 'string') {
    throw new HandoffTokenError('malformed', 'nonce is empty')
  }
  let redis: Awaited<ReturnType<typeof getRedis>>
  try {
    redis = await getRedis()
  } catch (err) {
    throw new HandoffTokenError(
      'redis_unavailable',
      `Redis unavailable during handoff nonce redeem: ${(err as Error).message}`,
    )
  }

  const key = `${NONCE_KEY_PREFIX}${nonce}`
  // Read-then-delete: GET the value first, then DEL and check the delete
  // count. If we raced with a concurrent redeem, the DEL count is 0 and
  // we bail. This is atomic enough for single-Redis deployments (our
  // only shape). For multi-Redis we would use a Lua script, but we don't
  // run one.
  const value = await redis.get(key)
  if (!value) {
    throw new HandoffTokenError(
      'already_redeemed',
      'handoff nonce not found — token already used or expired',
    )
  }
  const delCount = await redis.del(key)
  if (delCount === 0) {
    // Lost the race with another redeemer.
    throw new HandoffTokenError(
      'already_redeemed',
      'handoff nonce was redeemed by a concurrent request',
    )
  }

  try {
    const parsed = JSON.parse(value) as {
      checkoutId: string
      shopId: string
      customerId: string | null
    }
    return {
      checkoutId: parsed.checkoutId,
      shopId: parsed.shopId,
      customerId: parsed.customerId ?? null,
    }
  } catch {
    throw new HandoffTokenError(
      'malformed',
      'handoff nonce payload in Redis is not valid JSON',
    )
  }
}

// ---------------------------------------------------------------------------
// Composite: sign + store, verify + redeem
// ---------------------------------------------------------------------------

/**
 * Convenience: sign a token AND persist its nonce in one call. The
 * caller-facing `POST /handoff-token` endpoint uses this.
 */
export async function issueHandoffToken(input: {
  checkoutId: string
  shopId: string
  customerId: string | null
}): Promise<SignedHandoffToken> {
  const signed = signHandoffToken(input)
  const stored = await storeHandoffNonce(signed.payload)
  if (!stored) {
    // Should never happen — nonce is 128 random bits.
    throw new HandoffTokenError(
      'malformed',
      'failed to store handoff nonce (collision?)',
    )
  }
  return signed
}

/**
 * Convenience: verify a token AND consume its nonce in one call. The
 * `apps/checkout` router uses this on inbound `?hop=...` redirects.
 */
export async function consumeHandoffToken(
  token: string,
): Promise<HandoffTokenPayload> {
  const payload = verifyHandoffToken(token)
  // Redeem will throw `already_redeemed` if this is a replay.
  await redeemHandoffNonce(payload.nonce)
  return payload
}
