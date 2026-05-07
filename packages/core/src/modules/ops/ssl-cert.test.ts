/**
 * Gbox Platform — SSL/ACME State Machine Tests (Phase 6.4)
 *
 * Validates the pure-function planner that decides what the renewal
 * cron should do with each `shop_domains` row. The cron itself lives
 * in `scripts/ops/renew-ssl-certs.sh` and shells out to certbot — the
 * decision logic is here so it can be unit-tested without touching
 * real ACME endpoints.
 */

import { describe, it, expect } from 'vitest'
import {
  planCertAction,
  summariseSslFleet,
  type ShopDomainCertState,
} from './ssl-cert.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDomain(
  partial: Partial<ShopDomainCertState> = {},
): ShopDomainCertState {
  return {
    domain: 'shop.example.com',
    verified: true,
    sslIssuedAt: null,
    sslExpiresAt: null,
    sslLastError: null,
    ...partial,
  }
}

const NOW = new Date('2026-04-09T00:00:00.000Z')
const RENEW_BEFORE_DAYS = 30

// ---------------------------------------------------------------------------
// planCertAction
// ---------------------------------------------------------------------------

describe('planCertAction', () => {
  it('returns "wait_verification" for an unverified domain', () => {
    const action = planCertAction(
      makeDomain({ verified: false }),
      { now: NOW, renewBeforeDays: RENEW_BEFORE_DAYS },
    )
    expect(action.action).toBe('wait_verification')
  })

  it('returns "issue" for a verified domain that has no cert yet', () => {
    const action = planCertAction(
      makeDomain({ verified: true, sslExpiresAt: null }),
      { now: NOW, renewBeforeDays: RENEW_BEFORE_DAYS },
    )
    expect(action.action).toBe('issue')
  })

  it('returns "skip" when the cert is comfortably fresh', () => {
    const expiresAt = new Date('2026-06-09T00:00:00.000Z') // 61 days out
    const action = planCertAction(
      makeDomain({ verified: true, sslExpiresAt: expiresAt }),
      { now: NOW, renewBeforeDays: RENEW_BEFORE_DAYS },
    )
    expect(action.action).toBe('skip')
    expect(action.daysUntilExpiry).toBe(61)
  })

  it('returns "renew" when expiry is within the renewal window', () => {
    const expiresAt = new Date('2026-04-25T00:00:00.000Z') // 16 days out
    const action = planCertAction(
      makeDomain({ verified: true, sslExpiresAt: expiresAt }),
      { now: NOW, renewBeforeDays: RENEW_BEFORE_DAYS },
    )
    expect(action.action).toBe('renew')
    expect(action.daysUntilExpiry).toBe(16)
  })

  it('returns "renew" for an already-expired cert', () => {
    const expiresAt = new Date('2026-04-01T00:00:00.000Z') // 8 days ago
    const action = planCertAction(
      makeDomain({ verified: true, sslExpiresAt: expiresAt }),
      { now: NOW, renewBeforeDays: RENEW_BEFORE_DAYS },
    )
    expect(action.action).toBe('renew')
    expect(action.daysUntilExpiry).toBe(-8)
  })

  it('treats the boundary day (== renewBeforeDays) as still inside the window', () => {
    const expiresAt = new Date('2026-05-09T00:00:00.000Z') // exactly 30 days
    const action = planCertAction(
      makeDomain({ verified: true, sslExpiresAt: expiresAt }),
      { now: NOW, renewBeforeDays: RENEW_BEFORE_DAYS },
    )
    expect(action.action).toBe('renew')
  })

  it('respects a custom renewBeforeDays', () => {
    const expiresAt = new Date('2026-04-29T00:00:00.000Z') // 20 days out
    const wide = planCertAction(
      makeDomain({ verified: true, sslExpiresAt: expiresAt }),
      { now: NOW, renewBeforeDays: 25 },
    )
    expect(wide.action).toBe('renew')

    const narrow = planCertAction(
      makeDomain({ verified: true, sslExpiresAt: expiresAt }),
      { now: NOW, renewBeforeDays: 14 },
    )
    expect(narrow.action).toBe('skip')
  })

  it('defaults renewBeforeDays to 30 when not provided', () => {
    const expiresAt = new Date('2026-04-25T00:00:00.000Z') // 16 days
    const action = planCertAction(
      makeDomain({ verified: true, sslExpiresAt: expiresAt }),
      { now: NOW },
    )
    expect(action.action).toBe('renew')
  })
})

// ---------------------------------------------------------------------------
// summariseSslFleet
// ---------------------------------------------------------------------------

describe('summariseSslFleet', () => {
  it('returns zeroes for an empty fleet', () => {
    const summary = summariseSslFleet([], { now: NOW })
    expect(summary).toEqual({
      total: 0,
      healthy: 0,
      expiringSoon: 0,
      expired: 0,
      missing: 0,
      unverified: 0,
    })
  })

  it('counts each domain into exactly one bucket', () => {
    const fleet: ShopDomainCertState[] = [
      // healthy: cert > 30 days out
      makeDomain({
        domain: 'a.example.com',
        sslExpiresAt: new Date('2026-06-09T00:00:00.000Z'),
      }),
      // expiring soon: 16 days out
      makeDomain({
        domain: 'b.example.com',
        sslExpiresAt: new Date('2026-04-25T00:00:00.000Z'),
      }),
      // expired: 8 days ago
      makeDomain({
        domain: 'c.example.com',
        sslExpiresAt: new Date('2026-04-01T00:00:00.000Z'),
      }),
      // missing: verified but no cert
      makeDomain({
        domain: 'd.example.com',
        sslExpiresAt: null,
      }),
      // unverified: still waiting for the merchant
      makeDomain({
        domain: 'e.example.com',
        verified: false,
        sslExpiresAt: null,
      }),
    ]
    const summary = summariseSslFleet(fleet, { now: NOW })
    expect(summary).toEqual({
      total: 5,
      healthy: 1,
      expiringSoon: 1,
      expired: 1,
      missing: 1,
      unverified: 1,
    })
  })

  it('counts an unverified domain as unverified even if it somehow has a stale cert', () => {
    // Edge case: a domain was verified, got a cert, then was
    // unverified by an admin (e.g. ownership dispute). The cert
    // exists but we shouldn't be renewing it.
    const fleet: ShopDomainCertState[] = [
      makeDomain({
        verified: false,
        sslExpiresAt: new Date('2026-06-09T00:00:00.000Z'),
      }),
    ]
    const summary = summariseSslFleet(fleet, { now: NOW })
    expect(summary.unverified).toBe(1)
    expect(summary.healthy).toBe(0)
  })
})
