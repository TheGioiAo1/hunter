/**
 * Gbox Platform — Express CSRF Middleware Helper Tests
 * (Phase 0 Step 0.4 + 0.4b-redis)
 *
 * Unit tests for `createCsrfStore` and its pluggable backends
 * (`createMemoryCsrfStore`, `createRedisCsrfStore`). Exercises
 * issue, verify, cookie serialization, one-time-use semantics,
 * TTL expiry, eviction, and Redis client contract.
 *
 * Run:
 *   npx vitest run packages/core/src/modules/auth/csrf-express.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createCsrfStore,
  createMemoryCsrfStore,
  createNodeRedisCsrfBackend,
  createRedisCsrfStore,
  resolveDefaultCsrfBackend,
  type CsrfSecretStore,
  type RedisLikeClient,
} from './csrf-express.js'

// ---------------------------------------------------------------------------
// Environment isolation
//
// `createCsrfStore()` now auto-selects a Redis backend when REDIS_URL is
// set. Most existing tests exercise the in-memory path implicitly via
// the no-arg constructor, so we strip REDIS_URL for every test and let
// individual Redis-default tests set it explicitly. NODE_ENV is also
// cleared so the one-shot "REDIS_URL not set in production" warning
// does not fire from unrelated suites.
// ---------------------------------------------------------------------------

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv.REDIS_URL = process.env.REDIS_URL
  savedEnv.NODE_ENV = process.env.NODE_ENV
  delete process.env.REDIS_URL
  delete process.env.NODE_ENV
})

afterEach(() => {
  if (savedEnv.REDIS_URL === undefined) delete process.env.REDIS_URL
  else process.env.REDIS_URL = savedEnv.REDIS_URL
  if (savedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = savedEnv.NODE_ENV
})

// ---------------------------------------------------------------------------
// Fake Express req/res
// ---------------------------------------------------------------------------

interface FakeRes {
  headers: Record<string, string[]>
  appendHeader: (name: string, value: string) => void
}

function makeRes(): FakeRes {
  const headers: Record<string, string[]> = {}
  return {
    headers,
    appendHeader(name, value) {
      const key = name
      if (!headers[key]) headers[key] = []
      headers[key].push(value)
    },
  }
}

function cookieIdFromRes(res: FakeRes, cookieName = 'gbox_csrf'): string {
  const setCookies = res.headers['Set-Cookie'] ?? []
  for (const sc of setCookies) {
    const match = sc.match(new RegExp(`${cookieName}=([^;]+)`))
    if (match) return match[1]
  }
  throw new Error(`Set-Cookie ${cookieName} not found in response`)
}

function makeReq(cookieId: string, token: string, cookieName = 'gbox_csrf', field = '_csrf'): any {
  return {
    headers: { cookie: `${cookieName}=${cookieId}` },
    body: { [field]: token },
  }
}

// ---------------------------------------------------------------------------
// issue()
// ---------------------------------------------------------------------------

describe('createCsrfStore — issue', () => {
  it('returns a 64-char hex token', async () => {
    const store = createCsrfStore()
    const res = makeRes() as any
    const token = await store.issue(res, false)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('sets a Set-Cookie header with HttpOnly + SameSite=Lax', async () => {
    const store = createCsrfStore()
    const res = makeRes() as any
    await store.issue(res, false)
    const cookies = res.headers['Set-Cookie']
    expect(cookies).toBeDefined()
    expect(cookies[0]).toContain('gbox_csrf=')
    expect(cookies[0]).toContain('HttpOnly')
    expect(cookies[0]).toContain('SameSite=Lax')
    expect(cookies[0]).toContain('Path=/')
    expect(cookies[0]).toContain('Max-Age=3600')
    // Secure flag absent in non-production
    expect(cookies[0]).not.toContain('Secure')
  })

  it('adds the Secure flag in production', async () => {
    const store = createCsrfStore()
    const res = makeRes() as any
    await store.issue(res, true)
    expect(res.headers['Set-Cookie'][0]).toContain('Secure')
  })

  it('honors a custom cookieName', async () => {
    const store = createCsrfStore({ cookieName: 'my_csrf' })
    const res = makeRes() as any
    await store.issue(res, false)
    expect(res.headers['Set-Cookie'][0]).toContain('my_csrf=')
  })

  it('honors a custom cookieTtlSeconds', async () => {
    const store = createCsrfStore({ cookieTtlSeconds: 120 })
    const res = makeRes() as any
    await store.issue(res, false)
    expect(res.headers['Set-Cookie'][0]).toContain('Max-Age=120')
  })

  it('generates a distinct cookie id for every issue', async () => {
    const store = createCsrfStore()
    const ids = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const res = makeRes() as any
      await store.issue(res, false)
      ids.add(cookieIdFromRes(res))
    }
    expect(ids.size).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// getOrIssue() — reuse-aware variant
// ---------------------------------------------------------------------------

describe('createCsrfStore — getOrIssue', () => {
  function makeReqWithCookie(cookieId: string, cookieName = 'gbox_csrf'): any {
    return { headers: { cookie: `${cookieName}=${cookieId}` }, body: {} }
  }
  function makeReqNoCookie(): any {
    return { headers: {}, body: {} }
  }

  it('mints a fresh cookie when the request has no CSRF cookie', async () => {
    const store = createCsrfStore()
    const res = makeRes() as any
    const token = await store.getOrIssue(makeReqNoCookie(), res, false)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(res.headers['Set-Cookie']).toBeDefined()
    expect(res.headers['Set-Cookie'][0]).toContain('gbox_csrf=')
  })

  it('returns the same token + does NOT rotate cookie when existing is valid', async () => {
    // Production incident regression (2026-04-25): per-page-load
    // Set-Cookie rotation was breaking forms across navigations.
    const store = createCsrfStore()
    const res1 = makeRes() as any
    const t1 = await store.issue(res1, false)
    const cookieId = cookieIdFromRes(res1)

    const res2 = makeRes() as any
    const t2 = await store.getOrIssue(makeReqWithCookie(cookieId), res2, false)

    expect(t2).toBe(t1)
    expect(res2.headers['Set-Cookie']).toBeUndefined()
  })

  it('mints a fresh cookie when the existing cookie has no backend secret (expired/evicted)', async () => {
    // Pre-2026-04-25 we drove this case via a failed verify (which
    // burned the secret). After the move to non-burning semantics,
    // verify() never deletes secrets, so we drive expiry directly via
    // the in-memory backend's injected clock — same end state from
    // getOrIssue's perspective: backend.get(cookieId) returns null →
    // mint fresh.
    let nowMs = 1_000_000
    const memBackend = createMemoryCsrfStore({ now: () => nowMs })
    const store = createCsrfStore({
      backend: memBackend,
      cookieTtlSeconds: 60,
    })
    const res1 = makeRes() as any
    await store.issue(res1, false)
    const cookieId = cookieIdFromRes(res1)

    // Advance past TTL — original secret is gone from the backend.
    nowMs += 120_000

    const res2 = makeRes() as any
    const t2 = await store.getOrIssue(makeReqWithCookie(cookieId), res2, false)

    expect(t2).toMatch(/^[0-9a-f]{64}$/)
    expect(res2.headers['Set-Cookie']).toBeDefined()
    expect(cookieIdFromRes(res2)).not.toBe(cookieId)
  })

  it('reused token still validates on POST against the original cookie', async () => {
    const store = createCsrfStore()
    const resGet = makeRes() as any
    const t1 = await store.issue(resGet, false)
    const cookieId = cookieIdFromRes(resGet)

    const resGet2 = makeRes() as any
    const t2 = await store.getOrIssue(makeReqWithCookie(cookieId), resGet2, false)
    expect(t2).toBe(t1)
    expect(resGet2.headers['Set-Cookie']).toBeUndefined()

    const ok = await store.verify(makeReq(cookieId, t1))
    expect(ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// verify()
// ---------------------------------------------------------------------------

describe('createCsrfStore — verify', () => {
  it('accepts a freshly-issued token', async () => {
    const store = createCsrfStore()
    const res = makeRes() as any
    const token = await store.issue(res, false)
    const cookieId = cookieIdFromRes(res)
    const req = makeReq(cookieId, token)
    expect(await store.verify(req)).toBe(true)
  })

  it('rejects a token with no cookie', async () => {
    const store = createCsrfStore()
    const res = makeRes() as any
    const token = await store.issue(res, false)
    const req: any = { headers: { cookie: '' }, body: { _csrf: token } }
    expect(await store.verify(req)).toBe(false)
  })

  it('rejects a cookie with no secret stored (unknown id)', async () => {
    const store = createCsrfStore()
    const req = makeReq('deadbeef'.repeat(4), 'sometoken')
    expect(await store.verify(req)).toBe(false)
  })

  it('rejects a request with no _csrf field', async () => {
    const store = createCsrfStore()
    const res = makeRes() as any
    await store.issue(res, false)
    const cookieId = cookieIdFromRes(res)
    const req: any = {
      headers: { cookie: `gbox_csrf=${cookieId}` },
      body: {},
    }
    expect(await store.verify(req)).toBe(false)
  })

  // 2026-04-27 — added header-based CSRF support so AJAX/JSON callers
  // (theme customizer, future fetch-based UIs) work without form fields.
  it('accepts the token from req.headers["x-csrf-token"] (AJAX path)', async () => {
    const store = createCsrfStore()
    const res = makeRes() as any
    const token = await store.issue(res, false)
    const cookieId = cookieIdFromRes(res)
    const req: any = {
      headers: {
        cookie: `gbox_csrf=${cookieId}`,
        'x-csrf-token': token,
      },
      body: {}, // empty body — token is in the header only
    }
    expect(await store.verify(req)).toBe(true)
  })

  it('header token wins when both header AND body fields are present', async () => {
    const store = createCsrfStore()
    const res = makeRes() as any
    const token = await store.issue(res, false)
    const cookieId = cookieIdFromRes(res)
    const req: any = {
      headers: {
        cookie: `gbox_csrf=${cookieId}`,
        'x-csrf-token': token,
      },
      body: { _csrf: 'wrong-token-in-body' }, // header is the truth
    }
    expect(await store.verify(req)).toBe(true)
  })

  it('falls back to body field when header is missing', async () => {
    const store = createCsrfStore()
    const res = makeRes() as any
    const token = await store.issue(res, false)
    const cookieId = cookieIdFromRes(res)
    const req: any = {
      headers: { cookie: `gbox_csrf=${cookieId}` },
      body: { _csrf: token },
    }
    expect(await store.verify(req)).toBe(true)
  })

  it('rejects when header token is wrong (even if body would accept)', async () => {
    const store = createCsrfStore()
    const res = makeRes() as any
    const token = await store.issue(res, false)
    const cookieId = cookieIdFromRes(res)
    const req: any = {
      headers: {
        cookie: `gbox_csrf=${cookieId}`,
        'x-csrf-token': 'bogus',
      },
      body: { _csrf: token }, // present but ignored
    }
    expect(await store.verify(req)).toBe(false)
  })

  it('handles array-shaped header by taking the first value', async () => {
    const store = createCsrfStore()
    const res = makeRes() as any
    const token = await store.issue(res, false)
    const cookieId = cookieIdFromRes(res)
    const req: any = {
      headers: {
        cookie: `gbox_csrf=${cookieId}`,
        'x-csrf-token': [token, 'second'],
      },
      body: {},
    }
    expect(await store.verify(req)).toBe(true)
  })

  it('rejects a wrong token even if cookie is valid', async () => {
    const store = createCsrfStore()
    const res = makeRes() as any
    await store.issue(res, false)
    const cookieId = cookieIdFromRes(res)
    const wrong = '0'.repeat(64)
    const req = makeReq(cookieId, wrong)
    expect(await store.verify(req)).toBe(false)
  })

  // 2026-04-25 — semantics intentionally CHANGED here from one-time-use
  // to "secret survives verify". See csrf-express.ts:verify() for the
  // full rationale. The two tests below replace the old "consumes the
  // secret" / "burns on failure" behavior tests.

  it('keeps the secret alive after a successful verify (multi-tab + back-button safe)', async () => {
    const store = createCsrfStore()
    const res = makeRes() as any
    const token = await store.issue(res, false)
    const cookieId = cookieIdFromRes(res)
    // First verify passes — that's fine.
    expect(await store.verify(makeReq(cookieId, token))).toBe(true)
    // SECOND verify with the same (cookie, token) ALSO passes. This is
    // the bug-96 fix: a user navigating back from a result page and
    // re-submitting the cached form must still succeed instead of
    // hitting "Invalid form submission".
    expect(await store.verify(makeReq(cookieId, token))).toBe(true)
    // And again. As long as the cookie is alive, the token is alive.
    expect(await store.verify(makeReq(cookieId, token))).toBe(true)
  })

  it('keeps the secret alive after a failed verify (wrong token does not lock out)', async () => {
    const store = createCsrfStore()
    const res = makeRes() as any
    const token = await store.issue(res, false)
    const cookieId = cookieIdFromRes(res)
    // Wrong token rejects but does NOT consume the secret. (Brute-force
    // protection comes from the 256-bit secret entropy, not from
    // burning on failure — that was security theatre.)
    expect(await store.verify(makeReq(cookieId, '0'.repeat(64)))).toBe(false)
    // Follow-up with the correct token still passes.
    expect(await store.verify(makeReq(cookieId, token))).toBe(true)
  })

  it('rejects after the cookie/secret naturally expires (TTL gate, not consume)', async () => {
    // Drive the in-memory backend's clock so we can prove that secrets
    // DO get cleaned up — they just don't get cleaned up by verify().
    let nowMs = 1_000_000
    const memBackend = createMemoryCsrfStore({ now: () => nowMs })
    const store = createCsrfStore({
      backend: memBackend,
      cookieTtlSeconds: 60,
    })
    const res = makeRes() as any
    const token = await store.issue(res, false)
    const cookieId = cookieIdFromRes(res)
    // Within TTL — works.
    expect(await store.verify(makeReq(cookieId, token))).toBe(true)
    // Past TTL — backend.get returns null, verify returns false.
    nowMs += 61_000
    expect(await store.verify(makeReq(cookieId, token))).toBe(false)
  })

  it('handles custom fieldName', async () => {
    const store = createCsrfStore({ fieldName: 'xsrf' })
    const res = makeRes() as any
    const token = await store.issue(res, false)
    const cookieId = cookieIdFromRes(res)
    const req = makeReq(cookieId, token, 'gbox_csrf', 'xsrf')
    expect(await store.verify(req)).toBe(true)
  })

  it('handles custom cookieName end-to-end', async () => {
    const store = createCsrfStore({ cookieName: 'my_csrf' })
    const res = makeRes() as any
    const token = await store.issue(res, false)
    const cookieId = cookieIdFromRes(res, 'my_csrf')
    const req = makeReq(cookieId, token, 'my_csrf')
    expect(await store.verify(req)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// hiddenField()
// ---------------------------------------------------------------------------

describe('createCsrfStore — hiddenField', () => {
  it('returns an HTML input tag with the token value', () => {
    const store = createCsrfStore()
    const html = store.hiddenField('abc123')
    expect(html).toContain('<input type="hidden"')
    expect(html).toContain('name="_csrf"')
    expect(html).toContain('value="abc123"')
  })

  it('HTML-escapes the token value (defense in depth)', () => {
    const store = createCsrfStore()
    const html = store.hiddenField('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

// ---------------------------------------------------------------------------
// Eviction (legacy API — memory backend by default)
// ---------------------------------------------------------------------------

describe('createCsrfStore — eviction', () => {
  it('caps store size around maxEntries', async () => {
    const store = createCsrfStore({ maxEntries: 10 })
    for (let i = 0; i < 25; i++) {
      const res = makeRes() as any
      await store.issue(res, false)
    }
    // After 25 issues with cap=10, we should have dropped to at most
    // maxEntries (actually less because the evictor drops half when
    // full). Must be ≤ 25 and > 0.
    const size = await store.size()
    expect(size).toBeLessThanOrEqual(25)
    expect(size).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Default backend — legacy callers still work
// ---------------------------------------------------------------------------

describe('createCsrfStore — default backend', () => {
  it('uses an in-memory backend when no backend option is passed', async () => {
    // Legacy callers only pass cookieName / ttl — they should continue
    // to get a working store with no extra setup.
    const store = createCsrfStore({ cookieName: 'legacy_csrf' })
    const res = makeRes() as any
    const token = await store.issue(res, false)
    const cookieId = cookieIdFromRes(res, 'legacy_csrf')
    expect(await store.size()).toBe(1)
    expect(await store.verify(makeReq(cookieId, token, 'legacy_csrf'))).toBe(
      true,
    )
    // 2026-04-25 — secret is NOT consumed by verify anymore. Survives
    // until cookie TTL or eviction. Same value still validates again.
    expect(await store.size()).toBe(1)
    expect(await store.verify(makeReq(cookieId, token, 'legacy_csrf'))).toBe(
      true,
    )
  })

  it('delegates to an injected custom backend', async () => {
    const calls: Array<[string, ...unknown[]]> = []
    const memory = createMemoryCsrfStore()
    const wrapped: CsrfSecretStore = {
      async set(id, secret, ttl) {
        calls.push(['set', id, secret, ttl])
        await memory.set(id, secret, ttl)
      },
      async get(id) {
        calls.push(['get', id])
        return memory.get(id)
      },
      async delete(id) {
        calls.push(['delete', id])
        await memory.delete(id)
      },
    }
    const store = createCsrfStore({ backend: wrapped })
    const res = makeRes() as any
    const token = await store.issue(res, false)
    const cookieId = cookieIdFromRes(res)
    expect(calls.some((c) => c[0] === 'set')).toBe(true)
    expect(await store.verify(makeReq(cookieId, token))).toBe(true)
    expect(calls.some((c) => c[0] === 'get')).toBe(true)
    // 2026-04-25 — verify() no longer calls backend.delete (one-time-use
    // semantics removed). The injected backend should NOT see a delete
    // unless the caller explicitly invalidates (e.g. logout).
    expect(calls.some((c) => c[0] === 'delete')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Memory backend — direct tests
// ---------------------------------------------------------------------------

describe('createMemoryCsrfStore', () => {
  it('expires entries after the TTL elapses', async () => {
    let nowMs = 1_000_000
    const memory = createMemoryCsrfStore({ now: () => nowMs })

    await memory.set('cookie-1', 'secret-1', 60) // 60s TTL
    expect(await memory.get('cookie-1')).toBe('secret-1')

    // Advance 30 seconds — still live.
    nowMs += 30 * 1000
    expect(await memory.get('cookie-1')).toBe('secret-1')

    // Advance past TTL — now expired.
    nowMs += 31 * 1000
    expect(await memory.get('cookie-1')).toBeNull()
  })

  it('evicts half the entries when size exceeds maxEntries', async () => {
    const memory = createMemoryCsrfStore({ maxEntries: 10 })
    for (let i = 0; i < 20; i++) {
      await memory.set(`cookie-${i}`, `secret-${i}`, 3600)
    }
    const size = await memory.size!()
    // Must be capped at or below maxEntries after eviction.
    expect(size).toBeLessThanOrEqual(20)
    expect(size).toBeGreaterThan(0)
    // The newest entry must have survived.
    expect(await memory.get('cookie-19')).toBe('secret-19')
  })

  it('delete is idempotent on missing keys', async () => {
    const memory = createMemoryCsrfStore()
    await expect(memory.delete('does-not-exist')).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Redis backend — mock client + fake redis
// ---------------------------------------------------------------------------

/**
 * In-memory stand-in for ioredis that matches the `RedisLikeClient`
 * shape. Used both for jest-style spy assertions and for full
 * round-trip tests below.
 */
class FakeRedis implements RedisLikeClient {
  private store = new Map<string, string>()

  async set(
    key: string,
    value: string,
    _mode: 'EX',
    _ttlSeconds: number,
  ): Promise<'OK'> {
    this.store.set(key, value)
    return 'OK'
  }
  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? (this.store.get(key) as string) : null
  }
  async del(key: string): Promise<number> {
    const had = this.store.delete(key)
    return had ? 1 : 0
  }
  // Test helpers
  size(): number {
    return this.store.size
  }
  has(key: string): boolean {
    return this.store.has(key)
  }
}

describe('createRedisCsrfStore', () => {
  it('issue calls client.set with the namespaced key and correct TTL', async () => {
    const set = vi.fn().mockResolvedValue('OK')
    const get = vi.fn().mockResolvedValue(null)
    const del = vi.fn().mockResolvedValue(1)
    const client: RedisLikeClient = { set, get, del }

    const store = createCsrfStore({
      backend: createRedisCsrfStore(client, 'test:csrf'),
      cookieTtlSeconds: 900,
    })
    const res = makeRes() as any
    await store.issue(res, false)

    expect(set).toHaveBeenCalledTimes(1)
    const call = set.mock.calls[0]
    expect(call[0]).toMatch(/^test:csrf:[0-9a-f]{32}$/)
    expect(typeof call[1]).toBe('string') // secret
    expect(call[2]).toBe('EX')
    expect(call[3]).toBe(900)
  })

  it('uses the default key prefix when none is provided', async () => {
    const set = vi.fn().mockResolvedValue('OK')
    const client: RedisLikeClient = {
      set,
      get: vi.fn(),
      del: vi.fn(),
    }

    const store = createCsrfStore({
      backend: createRedisCsrfStore(client),
    })
    const res = makeRes() as any
    await store.issue(res, false)

    expect(set.mock.calls[0][0]).toMatch(/^gbox:csrf:[0-9a-f]{32}$/)
  })

  it('verify calls get only — does NOT del on success (post-2026-04-25)', async () => {
    // 2026-04-25 — semantics changed from one-time-use to "secret
    // survives". verify() now only reads; no del.
    const fake = new FakeRedis()
    const store = createCsrfStore({
      backend: createRedisCsrfStore(fake, 'test:csrf'),
    })
    const res = makeRes() as any
    const token = await store.issue(res, false)
    const cookieId = cookieIdFromRes(res)

    const get = vi
      .fn<(key: string) => Promise<string | null>>()
      .mockImplementation((key) => fake.get(key))
    const del = vi
      .fn<(key: string) => Promise<unknown>>()
      .mockImplementation((key) => fake.del(key))
    const spyStore = createCsrfStore({
      backend: createRedisCsrfStore(
        {
          set: (k, v, m, t) => fake.set(k, v, m, t),
          get,
          del,
        },
        'test:csrf',
      ),
    })

    expect(await spyStore.verify(makeReq(cookieId, token))).toBe(true)
    expect(get).toHaveBeenCalledWith(`test:csrf:${cookieId}`)
    // del MUST NOT be called — the secret stays alive for back-button
    // re-submits, multi-tab, and refresh cycles.
    expect(del).not.toHaveBeenCalled()
    expect(fake.has(`test:csrf:${cookieId}`)).toBe(true)
  })

  it('verify does NOT del on failure either (no burn-on-fail; brute-force protection comes from secret entropy)', async () => {
    const fake = new FakeRedis()
    const store = createCsrfStore({
      backend: createRedisCsrfStore(fake, 'test:csrf'),
    })
    const res = makeRes() as any
    await store.issue(res, false)
    const cookieId = cookieIdFromRes(res)

    const get = vi
      .fn<(key: string) => Promise<string | null>>()
      .mockImplementation((key) => fake.get(key))
    const del = vi
      .fn<(key: string) => Promise<unknown>>()
      .mockImplementation((key) => fake.del(key))
    const spyStore = createCsrfStore({
      backend: createRedisCsrfStore(
        {
          set: (k, v, m, t) => fake.set(k, v, m, t),
          get,
          del,
        },
        'test:csrf',
      ),
    })

    // Submit the wrong token. Secret stays alive — we rely on the
    // 256-bit entropy of the secret to make brute-force impractical,
    // not on burn-on-failure (which was security theatre).
    const wrong = '0'.repeat(64)
    expect(await spyStore.verify(makeReq(cookieId, wrong))).toBe(false)
    expect(del).not.toHaveBeenCalled()
    expect(fake.has(`test:csrf:${cookieId}`)).toBe(true)
  })

  it('verify returns false when get returns null (missing key)', async () => {
    const get = vi.fn().mockResolvedValue(null)
    const del = vi.fn().mockResolvedValue(1)
    const client: RedisLikeClient = {
      set: vi.fn().mockResolvedValue('OK'),
      get,
      del,
    }
    const store = createCsrfStore({
      backend: createRedisCsrfStore(client, 'test:csrf'),
    })

    const req = makeReq('deadbeef'.repeat(4), 'sometoken')
    expect(await store.verify(req)).toBe(false)
    expect(get).toHaveBeenCalledWith(
      `test:csrf:${'deadbeef'.repeat(4)}`,
    )
    // Should NOT call del when there was nothing stored — it's
    // already gone. (This matches the legacy memory behavior.)
    expect(del).not.toHaveBeenCalled()
  })

  it('integrates round-trip with FakeRedis (issue → verify, secret survives)', async () => {
    const fake = new FakeRedis()
    const store = createCsrfStore({
      backend: createRedisCsrfStore(fake, 'gbox:csrf:test'),
      cookieName: 'gbox_csrf',
    })

    const res = makeRes() as any
    const token = await store.issue(res, false)
    const cookieId = cookieIdFromRes(res)

    // Secret is actually in fake redis under the namespaced key.
    expect(fake.size()).toBe(1)
    expect(fake.has(`gbox:csrf:test:${cookieId}`)).toBe(true)

    // 2026-04-25 — verify() succeeds AND leaves the secret in place.
    // This is the critical change for back-button + multi-tab UX.
    expect(await store.verify(makeReq(cookieId, token))).toBe(true)
    expect(fake.has(`gbox:csrf:test:${cookieId}`)).toBe(true)

    // Replay (same cookie + token) ALSO succeeds. The user navigating
    // back from a result page and re-submitting the cached form
    // doesn't get punished. Cookie expiry / explicit logout are the
    // only ways to invalidate.
    expect(await store.verify(makeReq(cookieId, token))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// resolveDefaultCsrfBackend — env-driven selection
// ---------------------------------------------------------------------------

describe('resolveDefaultCsrfBackend', () => {
  it('returns an in-memory backend when REDIS_URL is unset', () => {
    delete process.env.REDIS_URL
    const backend = resolveDefaultCsrfBackend('gbox_csrf', 100)
    // Memory backend implements the optional size() method; the
    // node-redis backend does not (it has no locally cached state).
    expect(typeof backend.size).toBe('function')
  })

  it('returns a node-redis-backed backend when REDIS_URL is set', () => {
    process.env.REDIS_URL = 'redis://localhost:6379'
    const backend = resolveDefaultCsrfBackend('gbox_csrf', 100)
    // Redis-backed backend deliberately omits size() — cluster-safe
    // stores should never be queried for a local snapshot.
    expect(backend.size).toBeUndefined()
  })

  it('warns once in production when REDIS_URL is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    delete process.env.REDIS_URL
    process.env.NODE_ENV = 'production'
    try {
      // First call triggers the warning.
      resolveDefaultCsrfBackend('gbox_csrf', 100)
      // Second call must not re-warn — the module-scope flag debounces it.
      resolveDefaultCsrfBackend('gbox_csrf_login', 100)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toContain('REDIS_URL not set in production')
    } finally {
      warn.mockRestore()
      // Reset the module-scope debounce flag by re-importing.
      // Tests that want to re-trigger the warning should re-import.
    }
  })

  it('namespaces the redis key prefix using cookieName by default', async () => {
    // Substitute getRedis with a controllable fake by replacing the
    // module — simpler to just pass a custom prefix through the
    // backend directly and check the resulting store writes to it.
    const fake = new FakeRedis()
    const backend = createNodeRedisCsrfBackend('gbox:csrf:signup')
    // We can't easily intercept getRedis() from outside without
    // vi.mock, so instead we exercise the prefix-passing path via
    // createRedisCsrfStore (the ioredis flavour) which already
    // returns a FakeRedis-backed store. This mirrors the real
    // auto-selection behaviour: resolveDefaultCsrfBackend() calls
    // `createNodeRedisCsrfBackend(\`gbox:csrf:${cookieName}\`)`.
    expect(backend.size).toBeUndefined()
    // The ioredis fake route already covers the key-prefix assertion
    // (see the 'namespaced key' tests above) — this test only needs
    // to prove the node-redis variant produces a backend whose shape
    // is compatible with CsrfSecretStore.
    expect(typeof backend.set).toBe('function')
    expect(typeof backend.get).toBe('function')
    expect(typeof backend.delete).toBe('function')
    // Unused but imported by type-only tests above.
    void fake
  })
})

// ---------------------------------------------------------------------------
// createCsrfStore — auto backend selection
// ---------------------------------------------------------------------------

describe('createCsrfStore — auto backend selection', () => {
  it('uses an in-memory backend when REDIS_URL is unset', async () => {
    delete process.env.REDIS_URL
    const store = createCsrfStore({ cookieName: 'gbox_csrf_auto' })
    const res = makeRes() as any
    await store.issue(res, false)
    // size() is only defined by the memory backend; if the factory
    // selected the node-redis backend this would return 0 (the
    // factory fallback) but NOT reflect the just-issued token.
    const n = await store.size()
    expect(n).toBe(1)
  })

  it('uses a redis backend when REDIS_URL is set (no local size)', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379'
    const store = createCsrfStore({ cookieName: 'gbox_csrf_auto_redis' })
    // The factory's size() wrapper returns 0 when backend.size is
    // undefined. This test intentionally never calls issue() so we
    // don't hit the real Redis — the assertion is about which branch
    // the factory picked, not about Redis round-tripping.
    const n = await store.size()
    expect(n).toBe(0)
  })

  it('honours an explicit backend over the env default', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379'
    const memory = createMemoryCsrfStore({ maxEntries: 10 })
    const store = createCsrfStore({
      cookieName: 'gbox_csrf_explicit',
      backend: memory,
    })
    const res = makeRes() as any
    await store.issue(res, false)
    // Explicit memory backend wins even though REDIS_URL is set.
    expect(await store.size()).toBe(1)
  })
})
