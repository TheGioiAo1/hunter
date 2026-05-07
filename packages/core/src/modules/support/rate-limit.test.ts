/**
 * Gbox Platform — rate-limit.ts unit tests.
 *
 * The DB-driven increment path lives behind `checkRateLimit(db,…)` and
 * is exercised by the PR1 smoke (which runs against the real
 * Postgres). This file pins the pure-math contract that `computeWindow`
 * enforces — the same algebra the DB path relies on:
 *
 *   windowStart = floor(now / windowMs) * windowMs
 *   resetsAt    = windowStart + windowMs
 *
 * Plus the fact that `SUPPORT_RATE_LIMITS` matches the spec caps
 * (10 tickets/hr per shop, 60 messages/hr per user).
 */
import { describe, it, expect } from 'vitest'
import {
  SUPPORT_RATE_LIMITS,
  computeWindow,
  type RateLimitSpec,
} from './rate-limit.ts'

const HOUR = 60 * 60 * 1000

describe('SUPPORT_RATE_LIMITS catalog', () => {
  it('pins create-ticket cap at 10/hour per shop', () => {
    expect(SUPPORT_RATE_LIMITS.CREATE_TICKET).toMatchObject({
      endpoint: 'support:create_ticket',
      scopeType: 'shop',
      windowMs: HOUR,
      maxHits: 10,
    })
  })

  it('pins post-message cap at 60/hour per user', () => {
    expect(SUPPORT_RATE_LIMITS.POST_MESSAGE).toMatchObject({
      endpoint: 'support:post_message',
      scopeType: 'user',
      windowMs: HOUR,
      maxHits: 60,
    })
  })
})

describe('computeWindow', () => {
  const hourSpec: Pick<RateLimitSpec, 'windowMs'> = { windowMs: HOUR }

  it('floors `now` down to the bucket start', () => {
    const now = new Date('2026-04-22T10:37:42.123Z')
    const { windowStart } = computeWindow(hourSpec, now)
    expect(windowStart.toISOString()).toBe('2026-04-22T10:00:00.000Z')
  })

  it('resetsAt is windowStart + windowMs', () => {
    const now = new Date('2026-04-22T10:37:42.123Z')
    const { windowStart, resetsAt } = computeWindow(hourSpec, now)
    expect(resetsAt.getTime() - windowStart.getTime()).toBe(HOUR)
  })

  it('instants exactly on a bucket boundary map to that bucket', () => {
    const now = new Date('2026-04-22T11:00:00.000Z')
    const { windowStart } = computeWindow(hourSpec, now)
    expect(windowStart.toISOString()).toBe('2026-04-22T11:00:00.000Z')
  })

  it('instants 1ms before a boundary still map to the previous bucket', () => {
    const now = new Date('2026-04-22T10:59:59.999Z')
    const { windowStart } = computeWindow(hourSpec, now)
    expect(windowStart.toISOString()).toBe('2026-04-22T10:00:00.000Z')
  })

  it('windowMs=60000 (1 minute) buckets correctly', () => {
    const spec = { windowMs: 60_000 }
    const { windowStart } = computeWindow(spec, new Date('2026-04-22T10:37:42.500Z'))
    expect(windowStart.toISOString()).toBe('2026-04-22T10:37:00.000Z')
  })

  it('windowMs=24h (day) buckets by UTC day', () => {
    const day = 24 * HOUR
    const spec = { windowMs: day }
    const { windowStart } = computeWindow(spec, new Date('2026-04-22T10:37:42.500Z'))
    expect(windowStart.toISOString()).toBe('2026-04-22T00:00:00.000Z')
  })

  it('consecutive calls in the same window share the same bucket', () => {
    const a = computeWindow(hourSpec, new Date('2026-04-22T10:01:00.000Z'))
    const b = computeWindow(hourSpec, new Date('2026-04-22T10:59:59.000Z'))
    expect(a.windowStart.toISOString()).toBe(b.windowStart.toISOString())
    expect(a.resetsAt.toISOString()).toBe(b.resetsAt.toISOString())
  })

  it('calls across a boundary get different buckets', () => {
    const a = computeWindow(hourSpec, new Date('2026-04-22T10:59:59.000Z'))
    const b = computeWindow(hourSpec, new Date('2026-04-22T11:00:00.000Z'))
    expect(a.windowStart.toISOString()).not.toBe(b.windowStart.toISOString())
    expect(b.windowStart.getTime() - a.windowStart.getTime()).toBe(HOUR)
  })
})
