/**
 * Internal JWT minting / verification for the dashboard ↔ sidecar hop.
 *
 * The dashboard (apps/god-admin) proxies chat requests to the sidecar
 * (apps/god-admin-agent). The sidecar is not publicly exposed, but we
 * still protect it with a short-lived HS256 token so anyone who sneaks
 * onto the LAN can't just POST /agent/chat directly.
 *
 * - Algorithm: HS256 (shared secret via JWT_SECRET env).
 * - Lifetime: 5 minutes.
 * - Audience: `gbox-agent-sidecar` (hardcoded).
 * - Issuer: `gbox-god-admin` (hardcoded).
 * - Claims shape: InternalJwtClaims (see types.ts).
 *
 * The secret can be rotated at runtime — the sidecar reads env on
 * every request via the factory closure (useful for kill-switch + rotation).
 */

import { SignJWT, jwtVerify, errors as joseErrors } from 'jose'
import type { InternalJwtClaims } from './types.ts'

const AUDIENCE = 'gbox-agent-sidecar'
const ISSUER = 'gbox-god-admin'
const TTL_SECONDS = 5 * 60

export class InvalidJwtError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | 'expired'
      | 'bad_signature'
      | 'wrong_audience'
      | 'wrong_issuer'
      | 'malformed'
      | 'missing_claim',
  ) {
    super(message)
    this.name = 'InvalidJwtError'
  }
}

function secretKeyBytes(secret: string): Uint8Array {
  if (!secret || secret.length < 32) {
    throw new Error(
      `JWT_SECRET must be at least 32 characters (got ${secret.length}). ` +
        `Use "openssl rand -hex 32" to generate one.`,
    )
  }
  return new TextEncoder().encode(secret)
}

export interface SignInternalJwtInput {
  /** Dashboard session id. */
  sid: string
  /** Agent session id. */
  aid: string
  /** HS256 shared secret (min 32 chars). */
  secret: string
  /** Override the clock for deterministic tests. */
  now?: () => number
}

/**
 * Mint a new internal JWT for one dashboard → sidecar request.
 * TTL is fixed at 5 minutes; there is no refresh.
 */
export async function signInternalJwt(
  input: SignInternalJwtInput,
): Promise<string> {
  const now = input.now ?? (() => Date.now())
  const iat = Math.floor(now() / 1000)
  const exp = iat + TTL_SECONDS

  const token = await new SignJWT({ sid: input.sid, aid: input.aid })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('god_admin_default')
    .setAudience(AUDIENCE)
    .setIssuer(ISSUER)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(secretKeyBytes(input.secret))

  return token
}

export interface VerifyInternalJwtInput {
  token: string
  secret: string
  now?: () => number
}

/**
 * Verify a token produced by signInternalJwt. Returns the decoded
 * claims on success; throws InvalidJwtError on any failure.
 */
export async function verifyInternalJwt(
  input: VerifyInternalJwtInput,
): Promise<InternalJwtClaims> {
  const clockNow = input.now
    ? () => Math.floor(input.now!() / 1000)
    : undefined

  try {
    const { payload } = await jwtVerify(input.token, secretKeyBytes(input.secret), {
      audience: AUDIENCE,
      issuer: ISSUER,
      algorithms: ['HS256'],
      ...(clockNow ? { currentDate: new Date(clockNow() * 1000) } : {}),
    })

    if (
      payload.sub !== 'god_admin_default' ||
      typeof payload.sid !== 'string' ||
      typeof payload.aid !== 'string' ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number'
    ) {
      throw new InvalidJwtError('missing or malformed claim', 'missing_claim')
    }

    return {
      sub: 'god_admin_default',
      sid: payload.sid,
      aid: payload.aid,
      iat: payload.iat,
      exp: payload.exp,
    }
  } catch (err) {
    if (err instanceof InvalidJwtError) throw err
    if (err instanceof joseErrors.JWTExpired) {
      throw new InvalidJwtError('token expired', 'expired')
    }
    if (err instanceof joseErrors.JWTClaimValidationFailed) {
      const claim = (err as { claim?: string }).claim
      if (claim === 'aud') throw new InvalidJwtError('wrong audience', 'wrong_audience')
      if (claim === 'iss') throw new InvalidJwtError('wrong issuer', 'wrong_issuer')
      throw new InvalidJwtError(`claim failed: ${claim}`, 'missing_claim')
    }
    if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
      throw new InvalidJwtError('bad signature', 'bad_signature')
    }
    if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid) {
      throw new InvalidJwtError('malformed token', 'malformed')
    }
    throw new InvalidJwtError((err as Error).message, 'malformed')
  }
}
