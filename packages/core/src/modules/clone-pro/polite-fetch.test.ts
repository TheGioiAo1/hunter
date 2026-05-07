/**
 * Phase 7 Step 7.3 — `politeFetch` wrapper contract tests.
 *
 * `politeFetch` is the single front door every clone-pro crawler
 * call should go through. Three responsibilities in fixed order:
 *   1. Ask the `RobotsGuard` — if disallowed, skip (return
 *      `{ skipped: true, reason: 'robots' }`). The guard short-
 *      circuits whole branches of the crawl without a fetch cost.
 *   2. Rate-limit per-host through `rateLimitedFetch`.
 *   3. Delegate to `safeFetch` with the stable GboxCloneBot UA.
 *
 * If the caller omits the guard (no RobotsGuard passed), robots is
 * bypassed but rate-limiting + UA injection still apply — that's
 * the transition path for call sites that haven't been wired with
 * a guard yet.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { politeFetch } from './polite-fetch.js'
import { RobotsGuard } from './robots-guard.js'
import * as safeFetchMod from '../clone-shopify/safe-fetch.js'
import * as rateLimiterMod from './rate-limiter.js'
import { CLONE_BOT_USER_AGENT } from './constants.js'

function stubSafeFetchOk() {
  return vi
    .spyOn(safeFetchMod, 'safeFetch')
    .mockImplementation((async (url: string) => ({
      statusCode: 200,
      headers: {},
      body: Buffer.from('ok', 'utf8'),
      finalUrl: url,
    })) as unknown as typeof safeFetchMod.safeFetch)
}

describe('Phase 7.3 — politeFetch', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    rateLimiterMod.__resetRateLimitersForTest()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('delegates to safeFetch with the stable GboxCloneBot UA by default', async () => {
    const fetchSpy = stubSafeFetchOk()

    const res = await politeFetch('https://example.com/page')

    expect(res.statusCode).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, opts] = fetchSpy.mock.calls[0] as [string, { userAgent?: string }]
    expect(opts?.userAgent).toBe(CLONE_BOT_USER_AGENT)
  })

  it('forwards caller-provided safeFetch options (timeoutMs, maxBytes)', async () => {
    const fetchSpy = stubSafeFetchOk()

    await politeFetch('https://example.com/page', {
      fetchOptions: { timeoutMs: 5_000, maxBytes: 1024 },
    })

    const [, opts] = fetchSpy.mock.calls[0] as [
      string,
      { timeoutMs?: number; maxBytes?: number; userAgent?: string },
    ]
    expect(opts?.timeoutMs).toBe(5_000)
    expect(opts?.maxBytes).toBe(1024)
    // Still enforces our UA even when caller passes other opts.
    expect(opts?.userAgent).toBe(CLONE_BOT_USER_AGENT)
  })

  it('short-circuits when the robots guard disallows the URL', async () => {
    const fetchSpy = stubSafeFetchOk()

    // Build a guard that denies /admin by installing a fake robots.txt.
    vi.spyOn(safeFetchMod, 'safeFetch').mockImplementationOnce(
      (async () => ({
        statusCode: 200,
        headers: {},
        body: Buffer.from(
          'User-agent: *\nDisallow: /admin\n',
          'utf8',
        ),
        finalUrl: 'https://example.com/robots.txt',
      })) as unknown as typeof safeFetchMod.safeFetch,
    )
    const guard = new RobotsGuard('https://example.com/')
    await guard.load()

    // Now replace the mock — from here on, any safeFetch call would
    // be a "real" body fetch. The guard should prevent it.
    fetchSpy.mockImplementation((async (url: string) => ({
      statusCode: 200,
      headers: {},
      body: Buffer.from(`body of ${url}`, 'utf8'),
      finalUrl: url,
    })) as unknown as typeof safeFetchMod.safeFetch)

    const before = fetchSpy.mock.calls.length
    const res = await politeFetch('https://example.com/admin/login', {
      robots: guard,
    })
    const after = fetchSpy.mock.calls.length

    expect(res.skipped).toBe(true)
    expect(res.reason).toBe('robots')
    // No safeFetch was issued for /admin/login (the only call was
    // the robots.txt itself before the test started).
    expect(after).toBe(before)
  })

  it('still fetches when robots guard allows the URL', async () => {
    // robots.txt says /admin disallowed; /products is allowed.
    vi.spyOn(safeFetchMod, 'safeFetch').mockImplementationOnce(
      (async () => ({
        statusCode: 200,
        headers: {},
        body: Buffer.from(
          'User-agent: *\nDisallow: /admin\n',
          'utf8',
        ),
        finalUrl: 'https://example.com/robots.txt',
      })) as unknown as typeof safeFetchMod.safeFetch,
    )
    const guard = new RobotsGuard('https://example.com/')
    await guard.load()

    const fetchSpy = vi
      .spyOn(safeFetchMod, 'safeFetch')
      .mockImplementation((async (url: string) => ({
        statusCode: 200,
        headers: {},
        body: Buffer.from('body', 'utf8'),
        finalUrl: url,
      })) as unknown as typeof safeFetchMod.safeFetch)

    const res = await politeFetch('https://example.com/products/42', {
      robots: guard,
    })

    expect(res.skipped).toBeFalsy()
    expect(res.statusCode).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('routes through rateLimitedFetch keyed by URL host', async () => {
    stubSafeFetchOk()
    const rateSpy = vi.spyOn(rateLimiterMod, 'rateLimitedFetch')

    await politeFetch('https://shop.example.com/p/1')

    expect(rateSpy).toHaveBeenCalledTimes(1)
    const [host] = rateSpy.mock.calls[0] as [string, unknown]
    expect(host).toBe('shop.example.com')
  })

  it('propagates safeFetch errors unchanged (no swallow)', async () => {
    vi.spyOn(safeFetchMod, 'safeFetch').mockRejectedValue(
      new Error('ECONNRESET'),
    )

    await expect(politeFetch('https://example.com/')).rejects.toThrow(
      'ECONNRESET',
    )
  })
})
