import { describe, it, expect } from 'vitest'
import { signInternalJwt, verifyInternalJwt, InvalidJwtError } from './jwt.ts'

const SECRET = 'a'.repeat(64)
const OTHER_SECRET = 'b'.repeat(64)

describe('internal jwt — round trip', () => {
  it('signs then verifies with matching secret', async () => {
    const token = await signInternalJwt({
      sid: 'dash-1',
      aid: 'agent-1',
      secret: SECRET,
    })
    const claims = await verifyInternalJwt({ token, secret: SECRET })

    expect(claims.sub).toBe('god_admin_default')
    expect(claims.sid).toBe('dash-1')
    expect(claims.aid).toBe('agent-1')
    expect(claims.exp - claims.iat).toBe(5 * 60)
  })

  it('short secret is rejected at sign time', async () => {
    await expect(
      signInternalJwt({ sid: 's', aid: 'a', secret: 'too-short' }),
    ).rejects.toThrow(/JWT_SECRET must be at least 32 characters/)
  })
})

describe('internal jwt — failure modes', () => {
  it('rejects a tampered token', async () => {
    const token = await signInternalJwt({
      sid: 'dash-1',
      aid: 'agent-1',
      secret: SECRET,
    })
    // Flip one char in the payload segment to break the signature.
    const parts = token.split('.')
    parts[1] = parts[1].slice(0, -1) + (parts[1].slice(-1) === 'A' ? 'B' : 'A')
    const tampered = parts.join('.')

    await expect(
      verifyInternalJwt({ token: tampered, secret: SECRET }),
    ).rejects.toMatchObject({
      name: 'InvalidJwtError',
      reason: 'bad_signature',
    })
  })

  it('rejects a token signed with a different secret', async () => {
    const token = await signInternalJwt({
      sid: 'dash-1',
      aid: 'agent-1',
      secret: OTHER_SECRET,
    })

    await expect(
      verifyInternalJwt({ token, secret: SECRET }),
    ).rejects.toMatchObject({
      name: 'InvalidJwtError',
      reason: 'bad_signature',
    })
  })

  it('rejects an expired token', async () => {
    const fixedNow = 1_700_000_000_000
    const token = await signInternalJwt({
      sid: 'dash-1',
      aid: 'agent-1',
      secret: SECRET,
      now: () => fixedNow,
    })

    // 6 minutes later — past the 5 min TTL.
    const later = fixedNow + 6 * 60 * 1000
    await expect(
      verifyInternalJwt({ token, secret: SECRET, now: () => later }),
    ).rejects.toMatchObject({
      name: 'InvalidJwtError',
      reason: 'expired',
    })
  })

  it('rejects malformed token', async () => {
    await expect(
      verifyInternalJwt({ token: 'not.a.jwt', secret: SECRET }),
    ).rejects.toBeInstanceOf(InvalidJwtError)
  })
})
