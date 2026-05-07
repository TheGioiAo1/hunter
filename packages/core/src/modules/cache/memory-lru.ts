/**
 * Gbox Platform — Bounded LRU with TTL (Phase 3A)
 *
 * Tiny, dependency-free LRU cache used by the tiered cache backend
 * as an in-memory fallback layer. The storefront already has a near
 * identical class under `apps/storefront/src/lib/lru-cache.ts` but
 * that lives in the storefront app and can't be imported from
 * `packages/core` without inverting the dependency graph. So we own
 * a second, independent copy here — kept deliberately small.
 *
 * Design rules:
 *
 *   1. **Bounded memory.** A misbehaving tenant spraying unique keys
 *      must never exhaust the Node heap. Hard cap on entry count.
 *   2. **Absolute TTL.** Each entry expires at insert time + ttlMs.
 *      Rereading an expired entry returns `undefined` and eagerly
 *      evicts it.
 *   3. **Recency on read.** A `get` that hits bumps the entry to the
 *      most-recently-used slot so frequently-read hot keys survive
 *      capacity pressure. Leverages the insertion-order iteration
 *      guarantee of `Map`.
 *   4. **Synchronous.** Callable from the tiered backend hot path
 *      without awaiting anything.
 *   5. **Clock injection.** Tests drive TTL expiry with a fake clock
 *      instead of `vi.useFakeTimers` so we don't globally monkey
 *      with `Date.now`.
 *
 * This is NOT the storefront's LruCache re-exported — we deliberately
 * keep it isolated so the two modules can evolve independently.
 */

export interface MemoryLruOptions {
  /** Maximum number of entries. Must be >= 1. */
  maxEntries: number
  /** Default TTL in milliseconds. `0` disables TTL. Must be >= 0. */
  defaultTtlMs: number
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number
}

interface Entry<V> {
  value: V
  expiresAt: number
}

export class MemoryLru<V = unknown> {
  private readonly store = new Map<string, Entry<V>>()
  private readonly maxEntries: number
  private readonly defaultTtlMs: number
  private readonly now: () => number

  constructor(options: MemoryLruOptions) {
    if (!Number.isFinite(options.maxEntries) || options.maxEntries < 1) {
      throw new RangeError(
        `MemoryLru.maxEntries must be >= 1, got ${options.maxEntries}`,
      )
    }
    if (!Number.isFinite(options.defaultTtlMs) || options.defaultTtlMs < 0) {
      throw new RangeError(
        `MemoryLru.defaultTtlMs must be >= 0, got ${options.defaultTtlMs}`,
      )
    }
    this.maxEntries = Math.floor(options.maxEntries)
    this.defaultTtlMs = options.defaultTtlMs
    this.now = options.now ?? Date.now
  }

  get size(): number {
    return this.store.size
  }

  /**
   * Look up a value. Returns `undefined` on miss or expired entry.
   * On a live hit the entry is bumped to most-recently-used.
   */
  get(key: string): V | undefined {
    const entry = this.store.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt !== Infinity && this.now() >= entry.expiresAt) {
      this.store.delete(key)
      return undefined
    }
    // Bump recency.
    this.store.delete(key)
    this.store.set(key, entry)
    return entry.value
  }

  /**
   * Insert or update a value. Optional per-call TTL override (seconds).
   * Evicts the oldest entry when the cache is at capacity.
   */
  set(key: string, value: V, ttlSeconds?: number): void {
    if (this.store.has(key)) {
      this.store.delete(key)
    } else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value
      if (oldestKey !== undefined) this.store.delete(oldestKey)
    }

    const ttlMs =
      ttlSeconds !== undefined ? Math.max(0, ttlSeconds) * 1000 : this.defaultTtlMs
    this.store.set(key, {
      value,
      expiresAt: ttlMs > 0 ? this.now() + ttlMs : Infinity,
    })
  }

  /** Drop a single entry. Returns true if present, false otherwise. */
  delete(key: string): boolean {
    return this.store.delete(key)
  }

  /** Drop every entry. */
  clear(): void {
    this.store.clear()
  }

  /**
   * Drop every entry whose key matches a glob pattern with `*`
   * wildcards. Used by `delPattern` in the tiered backend so that
   * `cached().invalidateAll()` blows the in-memory layer too.
   *
   * The pattern syntax only supports `*` (zero or more chars) — the
   * same subset `cacheDelPattern` uses against Redis SCAN's MATCH,
   * so the behaviour is consistent across both tiers.
   */
  deletePattern(pattern: string): number {
    const re = globToRegExp(pattern)
    let deleted = 0
    for (const key of Array.from(this.store.keys())) {
      if (re.test(key)) {
        this.store.delete(key)
        deleted += 1
      }
    }
    return deleted
  }

  /**
   * Whether the cache currently holds a LIVE entry for the key.
   * Expired entries count as absent.
   */
  has(key: string): boolean {
    const entry = this.store.get(key)
    if (entry === undefined) return false
    if (entry.expiresAt !== Infinity && this.now() >= entry.expiresAt) {
      this.store.delete(key)
      return false
    }
    return true
  }
}

/**
 * Convert a `*`-glob pattern to a regex. Escapes every other regex
 * metacharacter so callers don't accidentally inject one via their
 * keyPrefix. Exported for tests only.
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}
