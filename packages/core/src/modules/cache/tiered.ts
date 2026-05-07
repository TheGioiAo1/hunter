/**
 * Gbox Platform — Tiered Cache Backend (Phase 3A)
 *
 * A `CacheBackend` implementation that layers an in-process LRU in
 * front of Redis. It exists to solve two specific production
 * problems we hit with the single-tier Redis backend:
 *
 *   1. **Redis outage resilience.** When Redis is unreachable the
 *      existing helpers (`cacheGet`, `cacheSet`) silently return
 *      `null`, which means every request falls through to Postgres
 *      until Redis comes back. At 100K RPS that is a self-DDoS.
 *      With a tiered backend, hot keys keep serving out of the
 *      in-process LRU even during a Redis blip — each PM2 worker
 *      has its own copy of the top-N entries.
 *
 *   2. **Sub-millisecond reads for hot keys.** Redis is already
 *      fast (~0.3ms p50) but crossing the socket for the shop's
 *      active theme on every storefront request is still wasteful
 *      when the value is effectively immutable for 5 minutes. An
 *      in-process LRU hit is ~0.01ms.
 *
 * Trade-off: the local LRU is per-process, so invalidation is only
 * authoritative locally. That matches how the product is deployed —
 * writes go through the admin API which then calls
 * `cached.invalidate()`, which calls `backend.del()` on its own
 * worker. Other workers will still see the old value until their
 * local entry TTLs out OR they get bumped by a cross-worker
 * invalidation signal (left as a Phase 3B follow-up via Redis
 * pub/sub — noted but not built here so we don't couple too many
 * moving pieces at once).
 *
 * Write path:
 *   1. Write to the in-process LRU immediately (synchronous, never
 *      fails).
 *   2. Write-through to Redis asynchronously. Errors are swallowed
 *      by the underlying helper, matching the `cached()` fail-open
 *      contract.
 *
 * Read path:
 *   1. Look in the LRU. On hit, return immediately.
 *   2. On miss, try Redis via the injected helper. On hit, populate
 *      the LRU and return.
 *   3. On miss everywhere, return `null` so `cached()` falls through
 *      to the loader.
 *
 * Delete path:
 *   1. Drop from LRU (authoritative locally).
 *   2. Drop from Redis (authoritative across the cluster).
 *
 * delPattern path:
 *   1. Drop matching keys from the LRU via `MemoryLru.deletePattern`.
 *   2. Drop matching keys from Redis via SCAN (handled by the helper).
 *
 * The backend DOES NOT own Redis connection management. It takes
 * the same four helper functions `cached()` already depends on — so
 * tests can stub them with in-memory doubles and production wires
 * them to `cache/redis.ts`. This keeps dependencies pointing in one
 * direction (tiered → redis, never the other way).
 */

import type { CacheBackend } from './cached.js'
import { MemoryLru } from './memory-lru.js'
import { cacheDel, cacheDelPattern, cacheGet, cacheSet } from './redis.js'

// ---------------------------------------------------------------------------
// Injected Redis helpers — the same four `cached.ts` already uses
// ---------------------------------------------------------------------------

export interface RedisHelpers {
  get<T = unknown>(key: string): Promise<T | null>
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>
  del(key: string): Promise<void>
  delPattern(pattern: string): Promise<number>
}

export interface TieredBackendOptions {
  /** Max entries the in-memory tier will hold. Defaults to 1000. */
  memoryMaxEntries?: number
  /**
   * Maximum TTL (milliseconds) applied to the in-memory tier,
   * regardless of what the caller passes. Even if a loader asks for
   * a 10-minute TTL, we cap the local copy so stale writes from
   * other workers can't hide forever. Defaults to 60s.
   */
  memoryMaxTtlMs?: number
  /**
   * Clock injection for tests. Defaults to `Date.now`. Forwarded
   * into the underlying `MemoryLru`.
   */
  now?: () => number
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a `CacheBackend` that layers an in-process LRU in front of
 * the given Redis helpers. Production wiring example:
 *
 *   import { cacheGet, cacheSet, cacheDel, cacheDelPattern } from './redis.js'
 *   const backend = createTieredCacheBackend(
 *     { get: cacheGet, set: cacheSet, del: cacheDel, delPattern: cacheDelPattern },
 *   )
 *
 *   const getActiveTheme = cached(loadActiveTheme, {
 *     backend,
 *     keyPrefix: 'shop:activeTheme',
 *     keyParts: (shopId) => shopId,
 *     ttlSeconds: 300,
 *   })
 */
export function createTieredCacheBackend(
  redis: RedisHelpers,
  options: TieredBackendOptions = {},
): CacheBackend {
  const memoryMaxEntries = options.memoryMaxEntries ?? 1000
  const memoryMaxTtlMs = options.memoryMaxTtlMs ?? 60_000

  const memory = new MemoryLru<unknown>({
    maxEntries: memoryMaxEntries,
    defaultTtlMs: memoryMaxTtlMs,
    now: options.now,
  })

  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      // Tier 1 — in-process LRU
      const local = memory.get(key)
      if (local !== undefined) {
        return local as T
      }

      // Tier 2 — Redis (fail-open: underlying helper already swallows
      // errors and returns null, so we don't need to re-catch here.)
      const remote = await redis.get<T>(key)
      if (remote !== null && remote !== undefined) {
        // Warm the local tier so the next request served by THIS
        // worker hits the LRU. Clamp at memoryMaxTtlMs so a bug
        // or test cannot stick a value in forever.
        memory.set(key, remote)
        return remote
      }

      return null
    },

    async set<T = unknown>(
      key: string,
      value: T,
      ttlSeconds: number,
    ): Promise<void> {
      // Local tier first — cap its TTL so we never mask a cluster
      // write for longer than memoryMaxTtlMs.
      const localTtlSeconds = Math.min(ttlSeconds, Math.floor(memoryMaxTtlMs / 1000))
      memory.set(key, value as unknown, localTtlSeconds)

      // Then Redis. Errors inside the helper are swallowed; if
      // Redis is down the local write still serves the next read.
      await redis.set(key, value as unknown, ttlSeconds)
    },

    async del(key: string): Promise<void> {
      memory.delete(key)
      await redis.del(key)
    },

    async delPattern(pattern: string): Promise<number> {
      const localCount = memory.deletePattern(pattern)
      const remoteCount = await redis.delPattern(pattern)
      // Return the maximum — callers use the return value only as
      // an "at least something was invalidated" signal, and the
      // local count can be 0 on a cold worker that never saw the
      // key at all.
      return Math.max(localCount, remoteCount)
    },
  }
}

// ---------------------------------------------------------------------------
// Singleton adapter — wires the tiered backend to the production
// Redis helper functions from `cache/redis.ts`. Apps that want the
// default behaviour should call this ONCE per process and share the
// returned backend across every `cached()` / `CachedStorefrontDataSource`
// instance so they all share the same in-process LRU.
// ---------------------------------------------------------------------------

/**
 * Adapter turning the four standalone `cacheGet/cacheSet/cacheDel/
 * cacheDelPattern` functions into the `RedisHelpers` shape the tiered
 * backend expects. Kept as a factory (not a module-level constant) so
 * tests that mock the singleton see the fresh implementation.
 */
export function redisHelpersFromSingleton(): RedisHelpers {
  return {
    get: <T = unknown>(key: string) => cacheGet<T>(key),
    set: (key, value, ttlSeconds) => cacheSet(key, value, ttlSeconds),
    del: (key) => cacheDel(key),
    delPattern: (pattern) => cacheDelPattern(pattern),
  }
}

let defaultBackend: CacheBackend | null = null

/**
 * Lazy singleton — returns a process-wide tiered backend wired to the
 * live Redis helpers. First call creates it; subsequent calls return
 * the same instance so the in-process LRU actually warms up instead
 * of resetting every time a caller "creates" a backend.
 *
 * Tests should call `resetDefaultTieredBackend()` in `beforeEach` to
 * isolate LRU state between cases.
 */
export function getDefaultTieredBackend(
  options: TieredBackendOptions = {},
): CacheBackend {
  if (!defaultBackend) {
    defaultBackend = createTieredCacheBackend(
      redisHelpersFromSingleton(),
      options,
    )
  }
  return defaultBackend
}

/** Test helper — drop the cached singleton so the next call rebuilds it. */
export function resetDefaultTieredBackend(): void {
  defaultBackend = null
}
