/**
 * Gbox Platform — Theme preview tokens (Stage 3F.1)
 *
 * A preview token is a short-lived HMAC that lets an admin open an
 * unpublished draft theme on the live storefront without exposing it
 * to search engines or random visitors. The admin dashboard mints a
 * token for (shopId, themeId, adminId); the storefront verifies the
 * token, flips the active theme for that single request, and stamps
 * `X-Robots-Tag: noindex, nofollow` on the response.
 *
 * Wire format
 * -----------
 *
 *   <base64url(payload)>.<base64url(HMAC-SHA256(payload))>
 *
 * where `payload` is UTF-8 JSON of:
 *
 *   {
 *     shopId:   string,
 *     themeId:  string,
 *     adminId:  string,
 *     iat:      number,  // seconds since epoch
 *     exp:      number,  // seconds since epoch
 *   }
 *
 * The signature is computed over the base64url-encoded payload (NOT
 * the raw JSON) so verification never has to re-stringify and risk
 * key ordering differences. Both halves use base64url (RFC 4648 §5)
 * so the token is safe to drop into a query string without any
 * percent-encoding.
 *
 * Why a roll-your-own instead of JWT?
 *
 *   - We control both ends, so header negotiation (alg=HS256 etc.)
 *     just adds attack surface (`alg=none` et al).
 *   - The payload is fixed and tiny — no need for a general claim
 *     parser.
 *   - Keeping the module self-contained means it's trivial to port
 *     to Cloudflare Workers once Stage 6 starts, since Workers only
 *     ship a subset of `node:crypto`.
 *
 * The tests in `preview-token.test.ts` pin both the happy path AND
 * every failure reason (`'format' | 'signature' | 'expired' | …`),
 * so any future refactor has to keep that contract green.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/**
 * Preview tokens live for one hour. Long enough for a merchant to
 * click through a full template tour, short enough that a leaked URL
 * stops working before the end of the same support session.
 */
export const PREVIEW_TOKEN_TTL_MINUTES = 60

/**
 * We allow a tiny amount of negative clock skew between the admin
 * (which signed the token) and the storefront (which verifies it).
 * 30 seconds is enough for an NTP-synced fleet but small enough that
 * a genuinely tampered `iat` still looks wrong.
 */
const CLOCK_SKEW_SECONDS = 30

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreviewTokenInput {
  shopId: string
  themeId: string
  adminId: string
}

export interface PreviewTokenPayload extends PreviewTokenInput {
  /** Seconds since epoch — when the token was signed. */
  iat: number
  /** Seconds since epoch — when the token stops being valid. */
  exp: number
}

export type PreviewTokenFailureReason =
  | 'format'
  | 'signature'
  | 'expired'
  | 'future'
  | 'payload'

export type PreviewTokenVerifyResult =
  | { ok: true; payload: PreviewTokenPayload }
  | { ok: false; reason: PreviewTokenFailureReason }

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------

/**
 * Build a signed, URL-safe preview token for the given (shop, theme,
 * admin) triple. The issued-at / expires-at stamps are derived from
 * the current clock — pass a `vi.setSystemTime()` in tests to pin it.
 */
export function signPreviewToken(
  secret: string,
  input: PreviewTokenInput,
): string {
  if (!secret || typeof secret !== 'string') {
    throw new Error('signPreviewToken: secret must be a non-empty string')
  }
  if (!input || typeof input !== 'object') {
    throw new Error('signPreviewToken: input must be an object')
  }
  if (!input.shopId || !input.themeId || !input.adminId) {
    throw new Error(
      'signPreviewToken: shopId, themeId, and adminId are all required',
    )
  }

  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + PREVIEW_TOKEN_TTL_MINUTES * 60

  const payload: PreviewTokenPayload = {
    shopId: input.shopId,
    themeId: input.themeId,
    adminId: input.adminId,
    iat,
    exp,
  }

  const body = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'))
  const signature = sign(secret, body)

  return `${body}.${signature}`
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verify a preview token against the given secret. Returns a
 * discriminated union so callers can distinguish why a token was
 * rejected (useful for logging without leaking details to the
 * client). On success the caller MUST still compare
 * `payload.shopId` against the shop the current request resolved
 * to — this module only knows the token was signed by someone who
 * holds the secret, not that the storefront host matches.
 */
export function verifyPreviewToken(
  secret: string,
  token: string,
): PreviewTokenVerifyResult {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'format' }
  }

  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, reason: 'format' }
  }
  // Reject multi-dot tokens (the signature must not itself contain
  // a separator, and base64url doesn't produce one).
  if (token.indexOf('.', dot + 1) !== -1) {
    return { ok: false, reason: 'format' }
  }

  const body = token.slice(0, dot)
  const signature = token.slice(dot + 1)

  if (!isBase64Url(body) || !isBase64Url(signature)) {
    return { ok: false, reason: 'format' }
  }

  // --- Signature check (time-constant) -------------------------------
  const expected = sign(secret, body)
  const a = Buffer.from(signature, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature' }
  }

  // --- Decode payload -----------------------------------------------
  let decoded: unknown
  try {
    const json = base64UrlDecode(body).toString('utf8')
    decoded = JSON.parse(json)
  } catch {
    return { ok: false, reason: 'payload' }
  }
  if (!isPayload(decoded)) {
    return { ok: false, reason: 'payload' }
  }

  // --- Freshness ----------------------------------------------------
  const nowSec = Math.floor(Date.now() / 1000)
  if (decoded.iat > nowSec + CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'future' }
  }
  if (decoded.exp <= nowSec) {
    return { ok: false, reason: 'expired' }
  }

  return { ok: true, payload: decoded }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sign(secret: string, body: string): string {
  const mac = createHmac('sha256', secret)
  mac.update(body)
  return base64UrlEncode(mac.digest())
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function base64UrlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? 0 : 4 - (input.length % 4)
  const b64 =
    input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad)
  return Buffer.from(b64, 'base64')
}

function isBase64Url(input: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(input)
}

function isPayload(value: unknown): value is PreviewTokenPayload {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.shopId === 'string' &&
    typeof v.themeId === 'string' &&
    typeof v.adminId === 'string' &&
    typeof v.iat === 'number' &&
    typeof v.exp === 'number' &&
    Number.isFinite(v.iat) &&
    Number.isFinite(v.exp)
  )
}
