/**
 * Gbox Platform — Tiered Cache Backend Tests (Phase 3A)
 *
 * Shape mirrors cached.test.ts:
 *
 *   1. Build a fake set of Redis helpers backed by an in-memory Map
 *      so we can observe hit/miss/fail behaviour without Redis.
 *   2. Fake clock so TTLs are deterministic.
 *   3. Exercise the failover path by flipping a `redisDown` flag on
 *      the fake, watching reads fall back to the in-memory tier.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createTieredCacheBackend, type RedisHelpers } from './tiered.js'
import { MemoryLru, globToRegExp } from './memory-lru.js'

// ---------------------------------------------------------------------------
// Fake Redis helpers — stand-in for cache/redis.ts
// ---------------------------------------------------------------------------

interface FakeRedis extends RedisHelpers {
  // knobs
  redisDown: boolean
  getCalls: number
  setCalls: number
  delCalls: number
  delPatternCalls: number
  store: Map<string, unknown>
}

function createFakeRedis(): FakeRedis {
  const store = new Map<string, unknown>()
  const fake: FakeRedis = {
    redisDown: false,
    getCalls: 0,
    setCalls: 0,
    delCalls: 0,
    delPatternCalls: 0,
    store,
    async get<T>(key: string): Promise<T | null> {
      fake.getCalls += 1
      if (fake.redisDown) return null
      return (store.get(key) as T) ?? null
    },
    async set(key: string, value: unknown, _ttlSeconds: number): Promise<void> {
      fake.setCalls += 1
      if (fake.redisDown) return // matches cache/redis.ts fail-open
      store.set(key, value)
    },
    async del(key: string): Promise<void> {
      fake.delCalls += 1
      if (fake.redisDown) return
      store.delete(key)
    },
    async delPattern(pattern: string): Promise<number> {
      fake.delPatternCalls += 1
      if (fake.redisDown) return 0
      const re = globToRegExp(pattern)
      let deleted = 0
      for (const key of Array.from(store.keys())) {
        if (re.test(key)) {
          store.delete(key)
          deleted += 1
        }
      }
      return deleted
    },
  }
  return fake
}

// ---------------------------------------------------------------------------
// MemoryLru pure tests
// ---------------------------------------------------------------------------

describe('MemoryLru', () => {
  let clock: number
  const now = () => clock
  beforeEach(() => {
    clock = 1_000_000
  })

  it('stores and retrieves values', () => {
    const lru = new MemoryLru({ maxEntries: 3, defaultTtlMs: 1000, now })
    lru.set('a', 1)
    lru.set('b', 2)
    expect(lru.get('a')).toBe(1)
    expect(lru.get('b')).toBe(2)
    expect(lru.get('c')).toBeUndefined()
  })

  it('expires entries after the TTL', () => {
    const lru = new MemoryLru({ maxEntries: 3, defaultTtlMs: 1000, now })
    lru.set('a', 'live')
    clock += 999
    expect(lru.get('a')).toBe('live')
    clock += 2
    expect(lru.get('a')).toBeUndefined()
  })

  it('treats defaultTtlMs=0 as no expiry', () => {
    const lru = new MemoryLru({ maxEntries: 3, defaultTtlMs: 0, now })
    lru.set('a', 'forever')
    clock += 10_000_000
    expect(lru.get('a')).toBe('forever')
  })

  it('evicts the LRU entry when capacity is exceeded', () => {
    const lru = new MemoryLru({ maxEntries: 2, defaultTtlMs: 1000, now })
    lru.set('a', 1)
    lru.set('b', 2)
    lru.set('c', 3) // evicts 'a' (oldest)
    expect(lru.get('a')).toBeUndefined()
    expect(lru.get('b')).toBe(2)
    expect(lru.get('c')).toBe(3)
  })

  it('bumps recency on get so hot keys survive eviction', () => {
    const lru = new MemoryLru({ maxEntries: 2, defaultTtlMs: 1000, now })
    lru.set('a', 1)
    lru.set('b', 2)
    lru.get('a') // bump 'a'
    lru.set('c', 3) // should now evict 'b', not 'a'
    expect(lru.get('a')).toBe(1)
    expect(lru.get('b')).toBeUndefined()
    expect(lru.get('c')).toBe(3)
  })

  it('per-call ttlSeconds overrides the default', () => {
    const lru = new MemoryLru({ maxEntries: 3, defaultTtlMs: 60_000, now })
    lru.set('a', 1, 1) // 1 second
    clock += 1_001
    expect(lru.get('a')).toBeUndefined()
  })

  it('deletePattern drops matching keys and returns the count', () => {
    const lru = new MemoryLru({ maxEntries: 10, defaultTtlMs: 1000, now })
    lru.set('shop:activeTheme:1', 'a')
    lru.set('shop:activeTheme:2', 'b')
    lru.set('shop:settings:1', 'c')
    const n = lru.deletePattern('shop:activeTheme:*')
    expect(n).toBe(2)
    expect(lru.get('shop:activeTheme:1')).toBeUndefined()
    expect(lru.get('shop:activeTheme:2')).toBeUndefined()
    expect(lru.get('shop:settings:1')).toBe('c')
  })

  it('rejects invalid options', () => {
    expect(() => new MemoryLru({ maxEntries: 0, defaultTtlMs: 1000 })).toThrow(/maxEntries/)
    expect(() => new MemoryLru({ maxEntries: 10, defaultTtlMs: -1 })).toThrow(/defaultTtlMs/)
  })

  it('has() reports live / expired / missing correctly', () => {
    const lru = new MemoryLru({ maxEntries: 3, defaultTtlMs: 1000, now })
    lru.set('a', 1)
    expect(lru.has('a')).toBe(true)
    expect(lru.has('b')).toBe(false)
    clock += 1001
    expect(lru.has('a')).toBe(false)
  })
})

describe('globToRegExp', () => {
  it('matches simple wildcards', () => {
    const re = globToRegExp('shop:*')
    expect(re.test('shop:abc')).toBe(true)
    expect(re.test('shop:')).toBe(true)
    expect(re.test('other:abc')).toBe(false)
  })

  it('escapes regex metacharacters in the literal portion', () => {
    const re = globToRegExp('a.b:*')
    // the `.` must match a literal dot, not any char
    expect(re.test('a.b:x')).toBe(true)
    expect(re.test('aXb:x')).toBe(false)
  })

  it('anchors both ends', () => {
    const re = globToRegExp('shop:*')
    expect(re.test('prefix:shop:abc')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tiered backend tests
// ---------------------------------------------------------------------------

describe('createTieredCacheBackend', () => {
  let clock: number
  const now = () => clock
  beforeEach(() => {
    clock = 1_000_000
  })

  it('writes to both tiers and reads from the local tier first', async () => {
    const redis = createFakeRedis()
    const backend = createTieredCacheBackend(redis, { now, memoryMaxTtlMs: 60_000 })

    await backend.set('k', { v: 1 }, 300)
    expect(redis.setCalls).toBe(1)
    expect(redis.store.get('k')).toEqual({ v: 1 })

    const first = await backend.get('k')
    expect(first).toEqual({ v: 1 })
    // get should be satisfied by the local tier — Redis get is not called.
    expect(redis.getCalls).toBe(0)
  })

  it('falls back to Redis when the local tier misses, then warms local', async () => {
    const redis = createFakeRedis()
    const backend = createTieredCacheBackend(redis, { now })

    // Simulate Redis already having the value (populated by a sibling worker).
    redis.store.set('k', { v: 42 })

    const first = await backend.get('k')
    expect(first).toEqual({ v: 42 })
    expect(redis.getCalls).toBe(1)

    // Second read should now be served out of the local tier.
    const second = await backend.get('k')
    expect(second).toEqual({ v: 42 })
    expect(redis.getCalls).toBe(1) // unchanged
  })

  it('continues serving local hits when Redis is down', async () => {
    const redis = createFakeRedis()
    const backend = createTieredCacheBackend(redis, { now, memoryMaxTtlMs: 60_000 })

    await backend.set('k', { v: 'hot' }, 300)
    redis.redisDown = true

    // Local tier is still warm — reads succeed.
    const v = await backend.get('k')
    expect(v).toEqual({ v: 'hot' })
  })

  it('returns null for cold reads when Redis is down', async () => {
    const redis = createFakeRedis()
    const backend = createTieredCacheBackend(redis, { now })
    redis.redisDown = true

    const v = await backend.get('cold-key')
    expect(v).toBeNull()
  })

  it('refuses to mask Redis writes longer than memoryMaxTtlMs', async () => {
    const redis = createFakeRedis()
    const backend = createTieredCacheBackend(redis, { now, memoryMaxTtlMs: 2_000 })

    // Sibling worker writes to Redis BEFORE our worker sets anything locally.
    redis.store.set('shared', 'new')

    // Our worker warms its local tier with an older value at t=0.
    await backend.set('shared', 'old', 3600)
    expect(await backend.get('shared')).toBe('old') // local first

    // After memoryMaxTtlMs the local entry expires — we should see the
    // fresher Redis value rather than the stale local one.
    clock += 2_001
    // Reset the "store in Redis" to prove the local-capped TTL hands off.
    redis.store.set('shared', 'new')
    expect(await backend.get('shared')).toBe('new')
  })

  it('del() drops the key from both tiers', async () => {
    const redis = createFakeRedis()
    const backend = createTieredCacheBackend(redis, { now })

    await backend.set('k', 'v', 300)
    await backend.del('k')

    expect(redis.store.has('k')).toBe(false)
    expect(redis.delCalls).toBe(1)

    // Local tier — next get should miss. Redis is empty too, so null.
    const v = await backend.get('k')
    expect(v).toBeNull()
  })

  it('delPattern() clears matching local entries AND calls Redis SCAN', async () => {
    const redis = createFakeRedis()
    const backend = createTieredCacheBackend(redis, { now })

    await backend.set('shop:theme:1', 'a', 300)
    await backend.set('shop:theme:2', 'b', 300)
    await backend.set('shop:settings:1', 'c', 300)

    const n = await backend.delPattern('shop:theme:*')
    // Local and remote both dropped 2 → Math.max = 2.
    expect(n).toBe(2)
    expect(redis.store.has('shop:theme:1')).toBe(false)
    expect(redis.store.has('shop:theme:2')).toBe(false)
    expect(redis.store.has('shop:settings:1')).toBe(true)

    // Local tier also cleared.
    expect(await backend.get('shop:theme:1')).toBeNull()
    expect(await backend.get('shop:settings:1')).toBe('c')
  })

  it('uses defaults when options omitted', async () => {
    const redis = createFakeRedis()
    // No options — exercises default memoryMaxEntries + defaultTtlMs path.
    const backend = createTieredCacheBackend(redis)
    await backend.set('k', 1, 10)
    expect(await backend.get('k')).toBe(1)
  })
})
