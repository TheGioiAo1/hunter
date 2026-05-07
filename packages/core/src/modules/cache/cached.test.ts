/**
 * Gbox Platform — cached() Wrapper Tests (Phase 8.1)
 *
 * Locks down the function-memoization wrapper used by storefront
 * drop loaders. The wrapper is dependency-injected over a tiny
 * `CacheBackend` interface, so tests don't need real Redis.
 */

import { describe, it, expect, vi } from 'vitest'
import { cached, type CacheBackend } from './cached.js'

// ---------------------------------------------------------------------------
// In-memory backend used by every test
// ---------------------------------------------------------------------------

function makeMemoryBackend(): CacheBackend & {
  store: Map<string, unknown>
  pattern: string[]
} {
  const store = new Map<string, unknown>()
  const pattern: string[] = []
  return {
    store,
    pattern,
    async get<T>(key: string): Promise<T | null> {
      return (store.get(key) as T) ?? null
    },
    async set<T>(key: string, value: T, _ttlSeconds: number): Promise<void> {
      store.set(key, value)
    },
    async del(key: string): Promise<void> {
      store.delete(key)
    },
    async delPattern(p: string): Promise<number> {
      pattern.push(p)
      let n = 0
      for (const k of [...store.keys()]) {
        // very dumb prefix match — good enough for tests
        if (k.startsWith(p.replace('*', ''))) {
          store.delete(k)
          n++
        }
      }
      return n
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cached', () => {
  it('returns the underlying value on a cache miss and stores it', async () => {
    const backend = makeMemoryBackend()
    const fn = vi.fn(async (id: string) => `product-${id}`)
    const wrapped = cached(fn, {
      backend,
      keyPrefix: 'product',
      keyParts: (id: string) => id,
      ttlSeconds: 60,
    })

    const result = await wrapped('42')
    expect(result).toBe('product-42')
    expect(fn).toHaveBeenCalledTimes(1)
    // Stored as an envelope so the wrapper can distinguish "miss" from
    // "cached null". The unwrapped value is what callers see.
    expect(backend.store.get('product:42')).toEqual({ v: 'product-42' })
  })

  it('returns the cached value on a hit and skips the underlying call', async () => {
    const backend = makeMemoryBackend()
    const fn = vi.fn(async (id: string) => `product-${id}`)
    const wrapped = cached(fn, {
      backend,
      keyPrefix: 'product',
      keyParts: (id: string) => id,
      ttlSeconds: 60,
    })

    await wrapped('42')
    await wrapped('42')
    await wrapped('42')

    // Only the first call should hit the underlying fn.
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('builds composite cache keys from multi-arg keyParts', async () => {
    const backend = makeMemoryBackend()
    const fn = vi.fn(
      async (shopId: string, slug: string) => `${shopId}:${slug}`,
    )
    const wrapped = cached(fn, {
      backend,
      keyPrefix: 'product:bySlug',
      keyParts: (shopId: string, slug: string) => `${shopId}:${slug}`,
      ttlSeconds: 60,
    })

    await wrapped('shop_1', 'cool-tee')
    expect(backend.store.has('product:bySlug:shop_1:cool-tee')).toBe(true)
  })

  it('treats different keys as separate cache entries', async () => {
    const backend = makeMemoryBackend()
    const fn = vi.fn(async (id: string) => id)
    const wrapped = cached(fn, {
      backend,
      keyPrefix: 'p',
      keyParts: (id: string) => id,
      ttlSeconds: 60,
    })
    await wrapped('a')
    await wrapped('b')
    await wrapped('c')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('invalidates a single key via .invalidate(args)', async () => {
    const backend = makeMemoryBackend()
    const fn = vi.fn(async (id: string) => `v-${id}-${Math.random()}`)
    const wrapped = cached(fn, {
      backend,
      keyPrefix: 'p',
      keyParts: (id: string) => id,
      ttlSeconds: 60,
    })

    const first = await wrapped('1')
    await wrapped.invalidate('1')
    const second = await wrapped('1')

    expect(first).not.toBe(second)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('invalidates everything under the prefix via .invalidateAll()', async () => {
    const backend = makeMemoryBackend()
    const fn = vi.fn(async (id: string) => `v-${id}`)
    const wrapped = cached(fn, {
      backend,
      keyPrefix: 'p',
      keyParts: (id: string) => id,
      ttlSeconds: 60,
    })

    await wrapped('a')
    await wrapped('b')
    await wrapped.invalidateAll()

    expect(backend.pattern).toContain('p:*')
    // After clearing, the next call hits the underlying fn again.
    await wrapped('a')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('falls through to the underlying fn when the backend errors on get', async () => {
    const broken: CacheBackend = {
      async get() {
        throw new Error('redis down')
      },
      async set() {},
      async del() {},
      async delPattern() {
        return 0
      },
    }
    const fn = vi.fn(async (id: string) => `v-${id}`)
    const wrapped = cached(fn, {
      backend: broken,
      keyPrefix: 'p',
      keyParts: (id: string) => id,
      ttlSeconds: 60,
    })

    const result = await wrapped('1')
    expect(result).toBe('v-1')
    expect(fn).toHaveBeenCalled()
  })

  it('still returns the value when the backend errors on set', async () => {
    const halfBroken: CacheBackend = {
      async get() {
        return null
      },
      async set() {
        throw new Error('redis flaky')
      },
      async del() {},
      async delPattern() {
        return 0
      },
    }
    const wrapped = cached(async (id: string) => `v-${id}`, {
      backend: halfBroken,
      keyPrefix: 'p',
      keyParts: (id: string) => id,
      ttlSeconds: 60,
    })

    await expect(wrapped('1')).resolves.toBe('v-1')
  })

  it('does NOT cache null/undefined results (avoids "negative caching" footgun)', async () => {
    const backend = makeMemoryBackend()
    const fn = vi.fn(async (_id: string) => null)
    const wrapped = cached(fn, {
      backend,
      keyPrefix: 'p',
      keyParts: (id: string) => id,
      ttlSeconds: 60,
    })
    await wrapped('missing')
    await wrapped('missing')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(backend.store.size).toBe(0)
  })

  it('honours an explicit cacheNull option for callers that want negative caching', async () => {
    const backend = makeMemoryBackend()
    const fn = vi.fn(async (_id: string) => null)
    const wrapped = cached(fn, {
      backend,
      keyPrefix: 'p',
      keyParts: (id: string) => id,
      ttlSeconds: 60,
      cacheNull: true,
    })
    await wrapped('missing')
    await wrapped('missing')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
