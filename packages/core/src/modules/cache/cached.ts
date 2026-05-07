/**
 * Gbox Platform — Transparent cached() Wrapper (Phase 8.1)
 *
 * Function-memoization helper for storefront drop loaders. The
 * storefront-side data layer reads dozens of "near-static" values
 * per page (active theme, shop settings, navigation tree, …) — most
 * of which only change a few times a day. This wrapper lets a loader
 * function opt into Redis-backed caching with one line of config:
 *
 *   const getActiveTheme = cached(
 *     (shopId: string) => loadActiveThemeFromDb(db, shopId),
 *     {
 *       backend: redisCacheBackend,        // injected at app boot
 *       keyPrefix: 'shop:activeTheme',
 *       keyParts: (shopId) => shopId,
 *       ttlSeconds: 300,                   // 5 minutes
 *     },
 *   )
 *
 *   // Read sites:
 *   const theme = await getActiveTheme(shopId)
 *
 *   // On theme publish, in the write path:
 *   await getActiveTheme.invalidate(shopId)
 *
 * Design rules:
 *
 *   1. **Inject the backend.** No `import { cacheGet } from
 *      './redis.js'` here — that would make every test require a
 *      Redis instance. Tests pass an in-memory `CacheBackend`, prod
 *      passes the Redis-backed adapter.
 *
 *   2. **Fail open.** If the backend errors (Redis down), the
 *      wrapper falls through to the underlying function and
 *      returns its real value. The cache is an optimization, never
 *      a correctness boundary.
 *
 *   3. **Don't cache nulls by default.** A `null` from the loader
 *      usually means "row not found, the merchant will create it
 *      shortly" — caching that traps the storefront in a stale
 *      404 until TTL expires. Callers who DO want negative caching
 *      (e.g. "this slug is permanently dead") opt in via
 *      `cacheNull: true`.
 *
 *   4. **Per-key + bulk invalidation.** The wrapped function gets
 *      `.invalidate(...args)` and `.invalidateAll()` methods so
 *      write paths can blow the cache without poking at Redis
 *      directly.
 */

// ---------------------------------------------------------------------------
// Backend interface — minimal so tests can stub it
// ---------------------------------------------------------------------------

/**
 * The slice of `cache/redis.ts` the wrapper actually depends on.
 * Production wires this to `{ get: cacheGet, set: cacheSet, … }`;
 * tests pass an in-memory Map.
 */
export interface CacheBackend {
  get<T = unknown>(key: string): Promise<T | null>
  set<T = unknown>(key: string, value: T, ttlSeconds: number): Promise<void>
  del(key: string): Promise<void>
  /** Should accept a glob pattern (e.g. `prefix:*`) and clear matches. */
  delPattern(pattern: string): Promise<number>
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CachedOptions<TArgs extends unknown[]> {
  backend: CacheBackend
  /** Cache key namespace. Joined with the keyParts result via `:`. */
  keyPrefix: string
  /** Maps the call's arguments to a stable per-key suffix. */
  keyParts: (...args: TArgs) => string
  /** Cache TTL in seconds. */
  ttlSeconds: number
  /**
   * If true, cache `null` / `undefined` results too. Defaults to
   * false because negative caching is a frequent source of stale
   * 404s on freshly-created records.
   */
  cacheNull?: boolean
}

// ---------------------------------------------------------------------------
// CachedFunction shape — wrapped fn + invalidation methods
// ---------------------------------------------------------------------------

export interface CachedFunction<TArgs extends unknown[], TResult> {
  (...args: TArgs): Promise<TResult>
  /** Drop the entry for these specific args. */
  invalidate(...args: TArgs): Promise<void>
  /** Drop every entry under the keyPrefix. Sparingly — uses SCAN. */
  invalidateAll(): Promise<void>
}

// ---------------------------------------------------------------------------
// cached
// ---------------------------------------------------------------------------

export function cached<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: CachedOptions<TArgs>,
): CachedFunction<TArgs, TResult> {
  const { backend, keyPrefix, keyParts, ttlSeconds, cacheNull = false } = options

  function buildKey(args: TArgs): string {
    const suffix = keyParts(...args)
    return `${keyPrefix}:${suffix}`
  }

  // Stored values are wrapped in { v: ... } so the wrapper can
  // distinguish "key not present" (backend.get returns null) from
  // "key present, value is null" (backend.get returns { v: null }).
  // Without the envelope, negative caching would be impossible
  // through any backend whose get() returns `T | null`.
  type Envelope = { v: TResult }

  const wrapped = async function call(...args: TArgs): Promise<TResult> {
    const key = buildKey(args)

    // Step 1 — try the cache. Fail-open on backend errors.
    let envelope: Envelope | null = null
    try {
      envelope = await backend.get<Envelope>(key)
    } catch {
      // ignore — fall through to underlying call
    }
    if (envelope && typeof envelope === 'object' && 'v' in envelope) {
      return envelope.v
    }

    // Step 2 — call the underlying loader.
    const fresh = await fn(...args)

    // Step 3 — write back unless it's nullish and we don't want
    // negative caching. Errors writing the cache are swallowed —
    // we already have the real value, the user should still get it.
    if (cacheNull || (fresh !== null && fresh !== undefined)) {
      try {
        await backend.set<Envelope>(key, { v: fresh }, ttlSeconds)
      } catch {
        // ignore
      }
    }

    return fresh
  } as CachedFunction<TArgs, TResult>

  wrapped.invalidate = async function invalidate(...args: TArgs): Promise<void> {
    const key = buildKey(args)
    try {
      await backend.del(key)
    } catch {
      // ignore — best effort
    }
  }

  wrapped.invalidateAll = async function invalidateAll(): Promise<void> {
    try {
      await backend.delPattern(`${keyPrefix}:*`)
    } catch {
      // ignore — best effort
    }
  }

  return wrapped
}

// ---------------------------------------------------------------------------
// redisCacheBackend — adapter for production wiring
// ---------------------------------------------------------------------------

/**
 * Builds a `CacheBackend` from the existing `cache/redis.ts`
 * helpers. Kept here (rather than in redis.ts) so the dependency
 * goes one direction: cached → redis, never the other way. Apps
 * import this once at boot and pass it into every `cached()` call.
 */
export function redisCacheBackend(deps: {
  get: <T = unknown>(key: string) => Promise<T | null>
  set: (key: string, value: unknown, ttl: number) => Promise<void>
  del: (key: string) => Promise<void>
  delPattern: (pattern: string) => Promise<number>
}): CacheBackend {
  return {
    get: deps.get,
    set: (key, value, ttl) => deps.set(key, value, ttl),
    del: deps.del,
    delPattern: deps.delPattern,
  }
}
