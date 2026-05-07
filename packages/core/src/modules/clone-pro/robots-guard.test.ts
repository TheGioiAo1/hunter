/**
 * Phase 7 Step 7.3 — `RobotsGuard` unit tests.
 *
 * The guard is created once per clone job. Its job is to answer
 * `isAllowed(url)` according to the source site's `robots.txt`. The
 * crawler calls it before fetching each candidate URL; a `false`
 * answer means SKIP + warn, not FAIL.
 *
 * Contract pinned here:
 *   1. `load()` fetches `<origin>/robots.txt` exactly once per instance
 *      (subsequent calls are no-ops — the parser is cached).
 *   2. HTTP 404 on robots.txt = allow everything (best-effort, most
 *      small sites don't serve a robots.txt at all).
 *   3. HTTP 2xx with parseable content: honor `Disallow` for our UA
 *      token `GboxCloneBot`.
 *   4. UA-specific blocks override `User-agent: *`.
 *   5. `CLONE_ROBOTS_ENFORCED=false` short-circuits to "allow all" —
 *      the rollback escape hatch documented in Phase 7 spec §8.
 *   6. Calling `isAllowed()` before `load()` is safe — it returns
 *      `true` (fail-open, because we haven't learned any restrictions
 *      yet).
 *   7. URLs with a different origin than the guard's source are
 *      treated as out-of-scope and allowed — the guard only speaks
 *      for its own host.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { RobotsGuard } from './robots-guard.js'
import * as safeFetchMod from '../clone-shopify/safe-fetch.js'

type SafeFetchFn = typeof safeFetchMod.safeFetch

function stubSafeFetch(
  implementation: (
    url: string,
    opts?: unknown,
  ) => Promise<{
    statusCode: number
    headers: Record<string, string>
    body: Buffer
    finalUrl: string
  }>,
): ReturnType<typeof vi.spyOn<typeof safeFetchMod, 'safeFetch'>> {
  return vi
    .spyOn(safeFetchMod, 'safeFetch')
    .mockImplementation(implementation as unknown as SafeFetchFn)
}

describe('Phase 7.3 — RobotsGuard', () => {
  beforeEach(() => {
    // Silence the guard's own warn logs — they're not asserted on,
    // but leaking them pollutes the test reporter output.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.CLONE_ROBOTS_ENFORCED
  })

  it('fetches /robots.txt from the source origin on load()', async () => {
    const spy = stubSafeFetch(async (url: string) => ({
      statusCode: 200,
      headers: {},
      body: Buffer.from('User-agent: *\nAllow: /\n', 'utf8'),
      finalUrl: url,
    }))

    const guard = new RobotsGuard('https://example.com/start-path')
    await guard.load()

    expect(spy).toHaveBeenCalledTimes(1)
    const [calledUrl] = spy.mock.calls[0] as [string]
    expect(calledUrl).toBe('https://example.com/robots.txt')
  })

  it('treats 404 robots.txt as "allow everything"', async () => {
    stubSafeFetch(async (url: string) => ({
      statusCode: 404,
      headers: {},
      body: Buffer.alloc(0),
      finalUrl: url,
    }))

    const guard = new RobotsGuard('https://example.com/')
    await guard.load()

    expect(guard.isAllowed('https://example.com/anything')).toBe(true)
    expect(guard.isAllowed('https://example.com/admin')).toBe(true)
  })

  it('honors explicit Disallow for GboxCloneBot user-agent', async () => {
    stubSafeFetch(async (url: string) => ({
      statusCode: 200,
      headers: {},
      body: Buffer.from(
        [
          'User-agent: GboxCloneBot',
          'Disallow: /admin',
          'Disallow: /private/',
          'Allow: /public',
          '',
          'User-agent: *',
          'Allow: /',
        ].join('\n'),
        'utf8',
      ),
      finalUrl: url,
    }))

    const guard = new RobotsGuard('https://shop.example.com/')
    await guard.load()

    expect(guard.isAllowed('https://shop.example.com/admin')).toBe(false)
    expect(guard.isAllowed('https://shop.example.com/admin/login')).toBe(false)
    expect(guard.isAllowed('https://shop.example.com/private/docs')).toBe(false)
    expect(guard.isAllowed('https://shop.example.com/public/page')).toBe(true)
    expect(guard.isAllowed('https://shop.example.com/products')).toBe(true)
  })

  it('falls back to User-agent: * rules when no GboxCloneBot block is present', async () => {
    stubSafeFetch(async (url: string) => ({
      statusCode: 200,
      headers: {},
      body: Buffer.from(
        [
          'User-agent: *',
          'Disallow: /checkout',
          'Disallow: /cart',
        ].join('\n'),
        'utf8',
      ),
      finalUrl: url,
    }))

    const guard = new RobotsGuard('https://shop.example.com/')
    await guard.load()

    expect(guard.isAllowed('https://shop.example.com/checkout')).toBe(false)
    expect(guard.isAllowed('https://shop.example.com/cart')).toBe(false)
    expect(guard.isAllowed('https://shop.example.com/products')).toBe(true)
  })

  it('caches robots.txt — load() is idempotent, only one safeFetch per instance', async () => {
    const spy = stubSafeFetch(async (url: string) => ({
      statusCode: 200,
      headers: {},
      body: Buffer.from('User-agent: *\nDisallow: /x\n', 'utf8'),
      finalUrl: url,
    }))

    const guard = new RobotsGuard('https://example.com/')
    await guard.load()
    await guard.load()
    await guard.load()

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('fails open on network error — safeFetch throws → allow everything', async () => {
    stubSafeFetch(async () => {
      throw new Error('ECONNRESET')
    })

    const guard = new RobotsGuard('https://flaky.example.com/')
    await guard.load()

    // We do NOT block a job just because robots.txt couldn't be
    // fetched. That would turn a transient network blip into a
    // permanent clone failure.
    expect(guard.isAllowed('https://flaky.example.com/anything')).toBe(true)
  })

  it('treats URLs from a different origin as out-of-scope (allow)', async () => {
    stubSafeFetch(async (url: string) => ({
      statusCode: 200,
      headers: {},
      body: Buffer.from('User-agent: *\nDisallow: /\n', 'utf8'),
      finalUrl: url,
    }))

    const guard = new RobotsGuard('https://shop.example.com/')
    await guard.load()

    // Even though the guard's robots.txt says "block everything",
    // a CDN URL from a different origin isn't the guard's to judge.
    expect(guard.isAllowed('https://cdn.shopify.com/some-asset.js')).toBe(true)
    expect(guard.isAllowed('https://fonts.googleapis.com/x.css')).toBe(true)
  })

  it('CLONE_ROBOTS_ENFORCED=false disables enforcement entirely (allow all)', async () => {
    process.env.CLONE_ROBOTS_ENFORCED = 'false'

    const spy = stubSafeFetch(async (url: string) => ({
      statusCode: 200,
      headers: {},
      body: Buffer.from('User-agent: *\nDisallow: /\n', 'utf8'),
      finalUrl: url,
    }))

    const guard = new RobotsGuard('https://shop.example.com/')
    await guard.load()

    // Rollback flag flips behaviour to "allow everything" and we
    // don't even bother fetching robots.txt (wasted request).
    expect(guard.isAllowed('https://shop.example.com/admin')).toBe(true)
    expect(guard.isAllowed('https://shop.example.com/private')).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  it('isAllowed() before load() fails open (returns true)', async () => {
    const guard = new RobotsGuard('https://shop.example.com/')
    // No load() call; we haven't fetched robots.txt yet.
    expect(guard.isAllowed('https://shop.example.com/anything')).toBe(true)
  })

  it('passes the GboxCloneBot UA token into the parser isAllowed call', async () => {
    // This is the "UA-specific rules win" guarantee. The parser's
    // behaviour is driven by the UA we pass in — if we accidentally
    // passed `*` or left it blank, UA-specific blocks in robots.txt
    // would not resolve. The test proves that isn't happening.
    stubSafeFetch(async (url: string) => ({
      statusCode: 200,
      headers: {},
      body: Buffer.from(
        [
          'User-agent: *',
          'Allow: /',
          '',
          'User-agent: GboxCloneBot',
          'Disallow: /products',
        ].join('\n'),
        'utf8',
      ),
      finalUrl: url,
    }))

    const guard = new RobotsGuard('https://shop.example.com/')
    await guard.load()

    // `*` says allow /products, but the UA-specific block for
    // GboxCloneBot overrides — proves we're passing the right UA.
    expect(guard.isAllowed('https://shop.example.com/products')).toBe(false)
  })

  it('handles malformed robots.txt without throwing — fails open', async () => {
    stubSafeFetch(async (url: string) => ({
      statusCode: 200,
      headers: {},
      // Garbage content; robots-parser should still load without
      // blowing up — worst case it matches nothing, which means allow.
      body: Buffer.from('\x00\x01 not a real robots file \xff\xfe', 'binary'),
      finalUrl: url,
    }))

    const guard = new RobotsGuard('https://shop.example.com/')
    await expect(guard.load()).resolves.not.toThrow()
    expect(guard.isAllowed('https://shop.example.com/anything')).toBe(true)
  })
})
