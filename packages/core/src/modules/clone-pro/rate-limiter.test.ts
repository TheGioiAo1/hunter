/**
 * Phase 7 Step 7.3 — per-host rate limiter unit tests.
 *
 * Politeness rule: no more than 5 requests per second against any
 * single source host, per clone-worker process. Enforced through
 * `rateLimitedFetch(host, fn)` — the crawler wraps every outbound
 * `safeFetch` call in this. The throttle is per-HOSTNAME, not per
 * URL, so a site with 10k pages gets N/5s request pacing regardless
 * of path.
 *
 * What we assert:
 *   1. First request to a host runs without delay.
 *   2. 5 consecutive requests to the same host are spaced ≥ 200ms
 *      apart (= 5 req/s ceiling).
 *   3. Different hosts have independent buckets — host B isn't
 *      throttled just because host A is being hammered.
 *   4. The return value of `fn` is propagated through.
 *   5. Reset hook (`__resetRateLimitersForTest`) is usable between
 *      test cases so state doesn't leak across suites.
 *
 * We use real timers throughout. vi.useFakeTimers() and
 * setTimeout-inside-Promise interact poorly (pending microtasks vs.
 * timer queue). The window is small — MIN_INTERVAL_MS is 200ms by
 * default, so a 3-request burst test costs ~400ms.
 */

import { describe, it, expect, afterEach } from 'vitest'

import {
  rateLimitedFetch,
  __resetRateLimitersForTest,
  MIN_INTERVAL_MS,
} from './rate-limiter.js'

describe('Phase 7.3 — rateLimitedFetch', () => {
  afterEach(() => {
    __resetRateLimitersForTest()
  })

  it('runs the first request for a host without delay', async () => {
    const start = Date.now()
    await rateLimitedFetch('first.example.com', async () => {
      return 'ok'
    })
    const elapsed = Date.now() - start
    // No throttling on first hit — should be essentially immediate.
    // 100ms is a generous ceiling for cold Node on Windows.
    expect(elapsed).toBeLessThan(100)
  })

  it('propagates the return value of fn', async () => {
    const result = await rateLimitedFetch(
      'propagate.example.com',
      async () => ({ foo: 'bar' }),
    )
    expect(result).toEqual({ foo: 'bar' })
  })

  it('propagates thrown errors from fn', async () => {
    await expect(
      rateLimitedFetch('throws.example.com', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
  })

  it('spaces consecutive requests to the same host by MIN_INTERVAL_MS', async () => {
    const callTimestamps: number[] = []

    await Promise.all(
      [1, 2, 3].map(() =>
        rateLimitedFetch('same-host.example.com', async () => {
          callTimestamps.push(Date.now())
          return null
        }),
      ),
    )

    // The second fn-invocation must be at least MIN_INTERVAL_MS
    // after the first; third at least MIN_INTERVAL_MS after the
    // second. Allow a small timer-resolution slack (-20ms) so the
    // test isn't flaky on slow Windows CI.
    expect(callTimestamps).toHaveLength(3)
    expect(callTimestamps[1]! - callTimestamps[0]!).toBeGreaterThanOrEqual(
      MIN_INTERVAL_MS - 20,
    )
    expect(callTimestamps[2]! - callTimestamps[1]!).toBeGreaterThanOrEqual(
      MIN_INTERVAL_MS - 20,
    )
  })

  it('does not throttle across different hosts', async () => {
    const callTimestamps: number[] = []

    await Promise.all([
      rateLimitedFetch('host-a.example.com', async () => {
        callTimestamps.push(Date.now())
      }),
      rateLimitedFetch('host-b.example.com', async () => {
        callTimestamps.push(Date.now())
      }),
      rateLimitedFetch('host-c.example.com', async () => {
        callTimestamps.push(Date.now())
      }),
    ])

    // All three should land within a tiny window — they're on
    // independent hosts so no bucket contention. 100ms cap gives
    // plenty of slack.
    expect(callTimestamps).toHaveLength(3)
    const spread =
      Math.max(...callTimestamps) - Math.min(...callTimestamps)
    expect(spread).toBeLessThan(100)
  })

  it('resumes normal pacing after the burst drains', async () => {
    // Drain the bucket with 2 quick calls.
    await rateLimitedFetch('resume.example.com', async () => null)
    await rateLimitedFetch('resume.example.com', async () => null)

    // Wait well past the interval so state should reset.
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS + 50))

    // The next call should run immediately — we've been idle.
    const start = Date.now()
    await rateLimitedFetch('resume.example.com', async () => null)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(50)
  })

  it('MIN_INTERVAL_MS is 200ms by default (= 5 req/s)', () => {
    // The spec's 5 req/s ceiling is expressed as MIN_INTERVAL_MS.
    // Anything else than 200 means we've drifted from spec §3.7.
    // (Env override via CLONE_HOST_RATE_LIMIT still works; this
    // asserts the default.)
    expect(MIN_INTERVAL_MS).toBe(200)
  })
})
