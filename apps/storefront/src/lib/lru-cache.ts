/**
 * Gbox Storefront — Tiny LRU Cache (Stage 3A.4)
 *
 * The storefront's host→shop resolver has to hit the database for
 * every incoming request to find out which shop owns the incoming
 * `Host` header. At even modest traffic that adds up to hundreds of
 * wasted `SELECT ... WHERE domain = $1` queries per second, so we
 * put a bounded in-memory cache in front of it.
 *
 * Requirements that shape the design:
 *
 *   1. **Bounded memory.** Must never grow unbounded — a misbehaving
 *      client spraying thousands of unique Host headers cannot be
 *      allowed to exhaust RAM.
 *   2. **Absolute TTL.** Each entry expires after a fixed duration
 *      from the moment it was *inserted*, so a custom-domain change
 *      is guaranteed to be visible within `ttlMs` even under load.
 *   3. **Recency eviction.** When the cache hits `maxEntries`, the
 *      oldest (least recently accessed) entry is dropped. This is
 *      classic LRU behaviour.
 *   4. **Synchronous.** Must be callable from inside a middleware
 *      hot path without touching I/O. No promises, no timers.
 *   5. **No dependencies.** We deliberately avoid pulling in
 *      `lru-cache` because its full API surface is overkill for the
 *      handful of operations the resolver needs.
 *
 * Implementation: a `Map<K, { value, expiresAt }>`. JavaScript
 * guarantees insertion-order iteration on `Map`, so to keep LRU
 * semantics we `delete` + `set` on every `get` (a hit bumps the
 * entry to the most-recently-used position). Eviction pops the
 * first entry via the iterator.
 *
 * This is not the fastest LRU implementation on the planet, but it
 * is simple, correct, dependency-free, and gives us O(1) ops on
 * cache hits / misses which is all the resolver needs.
 */

export interface LruCacheOptions {
  /** Maximum number of entries. Must be >= 1. */
  maxEntries: number
  /** Entry TTL in milliseconds. Must be >= 0. `0` disables TTL. */
  ttlMs: number
  /**
   * Clock injection — primarily used by tests so that TTL expiry
   * can be driven deterministically without `vi.useFakeTimers`.
   * Defaults to `Date.now`.
   */
  now?: () => number
}

interface LruEntry<V> {
  value: V
  expiresAt: number
}

export class LruCache<K, V> {
  private readonly store = new Map<K, LruEntry<V>>()
  private readonly maxEntries: number
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(options: LruCacheOptions) {
    if (!Number.isFinite(options.maxEntries) || options.maxEntries < 1) {
      throw new RangeError(
        `LruCache.maxEntries must be >= 1, got ${options.maxEntries}`,
      )
    }
    if (!Number.isFinite(options.ttlMs) || options.ttlMs < 0) {
      throw new RangeError(
        `LruCache.ttlMs must be >= 0, got ${options.ttlMs}`,
      )
    }
    this.maxEntries = Math.floor(options.maxEntries)
    this.ttlMs = options.ttlMs
    this.now = options.now ?? Date.now
  }

  /** Current number of entries (including any that may be expired). */
  get size(): number {
    return this.store.size
  }

  /**
   * Look up a value. Returns `undefined` on miss OR on expired hit
   * (the expired entry is eagerly removed). On a live hit, the
   * entry is refreshed as most-recently-used.
   */
  get(key: K): V | undefined {
    const entry = this.store.get(key)
    if (entry === undefined) return undefined
    if (this.ttlMs > 0 && this.now() >= entry.expiresAt) {
      // Expired — drop it and report a miss.
      this.store.delete(key)
      return undefined
    }
    // Bump to most-recently-used position.
    this.store.delete(key)
    this.store.set(key, entry)
    return entry.value
  }

  /**
   * Insert or update a value. If the cache is at capacity the
   * oldest entry is evicted first. Reinserting an existing key
   * refreshes its TTL.
   */
  set(key: K, value: V): void {
    if (this.store.has(key)) {
      this.store.delete(key)
    } else if (this.store.size >= this.maxEntries) {
      // Evict the oldest entry (first in iteration order).
      const oldestKey = this.store.keys().next().value
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey)
      }
    }
    this.store.set(key, {
      value,
      expiresAt: this.ttlMs > 0 ? this.now() + this.ttlMs : Infinity,
    })
  }

  /** Remove an entry. Returns true if it was present, false otherwise. */
  delete(key: K): boolean {
    return this.store.delete(key)
  }

  /** Drop every entry. */
  clear(): void {
    this.store.clear()
  }

  /**
   * Whether the cache currently holds a *live* entry for the given
   * key. Expired entries count as absent.
   */
  has(key: K): boolean {
    const entry = this.store.get(key)
    if (entry === undefined) return false
    if (this.ttlMs > 0 && this.now() >= entry.expiresAt) {
      this.store.delete(key)
      return false
    }
    return true
  }
}
