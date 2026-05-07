/**
 * Gbox Platform — Express CSRF Middleware Helper (Phase 0 Step 0.4 + 0.4b-redis)
 *
 * Shared Express glue around `./csrf.js`. Until this file existed each
 * app (accounts login, signup, god-admin login) hand-rolled the same
 * three things:
 *
 *   1. An in-memory `Map<cookieId, secret>` with periodic eviction.
 *   2. A `setupCSRF(res)` helper that rolls a new cookie + form token.
 *   3. A `checkCSRFToken(req)` helper that looks up the secret, calls
 *      `validateCSRF`, and deletes the secret for one-time use.
 *
 * The duplication meant every new form in a new file either skipped
 * CSRF entirely (the default failure mode) or copy-pasted ~50 lines of
 * boilerplate. Making it shared also makes it testable in isolation.
 *
 * Usage:
 *
 *   // 1. Create one store per app (sharing the backend across routes).
 *   const csrf = createCsrfStore({ cookieName: 'gbox_csrf' })
 *
 *   // 2. In the GET handler that renders the form:
 *   const token = await csrf.issue(res, isProduction())
 *   res.send(renderForm(token))
 *
 *   // 3. In the POST handler:
 *   if (!(await csrf.verify(req))) {
 *     res.status(403).send('Invalid form submission')
 *     return
 *   }
 *
 * Phase 0.4b-redis — Pluggable backend:
 *
 *   The secret storage is now pluggable via the `CsrfSecretStore`
 *   interface. By default, `createCsrfStore` instantiates an in-memory
 *   backend (same behavior as Phase 0.4). Production multi-process
 *   deployments (PM2 cluster) can inject a Redis-backed store so that
 *   a POST landing on worker B can verify a token issued by worker A:
 *
 *     import Redis from 'ioredis'
 *     const redis = new Redis(process.env.REDIS_URL)
 *     const csrf = createCsrfStore({
 *       cookieName: 'gbox_csrf',
 *       backend: createRedisCsrfStore(redis, 'gbox:csrf'),
 *     })
 *
 *   The Redis backend duck-types the client so we don't need to add
 *   `ioredis` (or `redis`) as a dependency of this package — the
 *   consuming app provides the real client at wire-up time, and tests
 *   use an in-memory fake.
 *
 * Security notes:
 *   - The secret is consumed on first successful verify (one-time use),
 *     exactly like the existing pattern in accounts/login.ts. That stops
 *     replay attacks on stale tokens.
 *   - Token validation uses the timing-safe comparator from `./csrf.js`
 *     (which wraps `crypto.timingSafeEqual`).
 *   - Failed verifies also burn the secret to remove the brute-force
 *     retry window over a single cookie id.
 */

import type { Request, Response } from 'express'
import { randomBytes, createHash } from 'crypto'

import {
  generateCSRFPair,
  validateCSRF,
  csrfHiddenField,
} from './csrf.js'
import { parseCookies } from './session.js'
import { getRedis } from '../cache/redis.js'

// ---------------------------------------------------------------------------
// `req.csrfToken` type contract — declaration merge into Express types.
//
// Why: pre-2026-04-25 the codebase had two read shapes co-existing in
// production:
//
//   - the store-admin GET middleware sets `req.csrfToken = "<hex>"`
//     (a plain string), which is what THIS module's `issue` /
//     `getOrIssue` returns,
//   - some pages were copy-pasted from a `csrf-csrf` example and
//     read it as `typeof req.csrfToken === 'function' ? req.csrfToken()
//     : ''` — silently rendering empty tokens in production because
//     `typeof "abc" === 'function'` is false (bugs 94 + the dormant
//     onboarding-banner bug found in the architectural sweep).
//
// Fixing the union here means a future copy-paste of the function
// shape would fail tsc immediately, instead of waiting for a seller
// to hit "Submit" in production.
//
// We DO NOT type it as `string | undefined` because some apps mount
// the issuing middleware ONLY on /admin/store/:slug — pages outside
// that prefix have no token. The optional chaining at callsites
// (`req.csrfToken ?? ''`) is correct, and we want TS to keep nudging
// callers to check.
// ---------------------------------------------------------------------------

declare module 'express-serve-static-core' {
  interface Request {
    /**
     * CSRF token (sha256 hex, 64 chars) to embed in form `_csrf`
     * fields. Set by the GET middleware that calls
     * `csrfStore.getOrIssue(req, res, isProduction)`. Undefined on
     * routes that don't run that middleware.
     *
     * NEVER assign a function value here — the page-render side
     * unconditionally treats this as a string after 2026-04-25.
     */
    csrfToken?: string
  }
}

// ---------------------------------------------------------------------------
// Backend interface
// ---------------------------------------------------------------------------

/**
 * Pluggable secret storage for the CSRF middleware. Implementations
 * must be safe for concurrent access and must honor TTL expiry.
 *
 * All methods are async so the same interface supports in-memory
 * Maps as well as Redis / Memcached / SQL.
 */
export interface CsrfSecretStore {
  /**
   * Store `secret` under `cookieId`, expiring after `ttlSeconds`.
   * Implementations must replace any existing value under the same
   * key rather than appending.
   */
  set(cookieId: string, secret: string, ttlSeconds: number): Promise<void>
  /**
   * Fetch the secret for `cookieId`, or `null` if missing / expired.
   */
  get(cookieId: string): Promise<string | null>
  /**
   * Remove `cookieId`. Idempotent — must not throw on missing keys.
   */
  delete(cookieId: string): Promise<void>
  /**
   * Optional: number of live entries, used by tests.
   */
  size?(): Promise<number>
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CsrfStoreOptions {
  /** Cookie name to store the cookie-id. Default: `gbox_csrf`. */
  cookieName?: string
  /** Form field name the POST handler reads the token from. Default: `_csrf`. */
  fieldName?: string
  /**
   * Max entries before the oldest half is evicted. Same pattern used by
   * the original login.ts store — keeps memory bounded under load. Only
   * used by the default in-memory backend; Redis backends ignore this.
   */
  maxEntries?: number
  /**
   * Cookie TTL in seconds. Default: 1 hour, which matches the typical
   * time a user spends looking at a form before submitting. The same
   * value is also used as the per-entry TTL in the backend so that
   * abandoned carts can't leak secrets forever.
   */
  cookieTtlSeconds?: number
  /**
   * Optional pluggable backend. Highest priority — if provided this
   * wins over every auto-detection. Pass a Redis-backed or fake store
   * here for tests, or a custom SQL-backed store for specialised
   * deployments.
   *
   * If omitted, `createCsrfStore` auto-selects:
   *   1. `createNodeRedisCsrfBackend(keyPrefix)` when `process.env.REDIS_URL`
   *      is set (cluster-safe — required by pm2 multi-worker deployments).
   *   2. `createMemoryCsrfStore({ maxEntries })` otherwise. In production
   *      without Redis the factory also logs a loud warning because
   *      in-memory CSRF silently breaks as soon as pm2 scales past 1
   *      worker — the GET and POST round-robin to different processes
   *      and the secret lookup misses.
   */
  backend?: CsrfSecretStore
  /**
   * Override the Redis key prefix used by the auto-selected Redis
   * backend. Ignored when an explicit `backend` is provided. Defaults
   * to `gbox:csrf:<cookieName>` so multiple forms on the same app
   * (signup, login, reset, checkout, …) don't collide even though
   * they share one Redis instance.
   */
  redisKeyPrefix?: string
}

export interface CsrfStore {
  /**
   * Issue a fresh token: mints a new secret, stores it under a new
   * cookie id, sets the `gbox_csrf=<cookieId>` cookie on `res`, and
   * returns the token for embedding in the form.
   */
  issue(res: Response, isProduction: boolean): Promise<string>
  /**
   * Reuse-aware variant of `issue`. If the request already carries a
   * valid `<cookieName>` cookie that still has a backend secret, return
   * the deterministic `sha256(secret)` token WITHOUT minting a new
   * cookie id (no Set-Cookie emitted). Otherwise fall through to the
   * normal `issue` path.
   *
   * Why this exists:
   *   `issue()` always rotates the cookie id. Apps that mount the GET
   *   middleware on a parent path (e.g. `app.use('/admin/store/:slug')`)
   *   end up rotating the cookie on EVERY page load. A form rendered on
   *   /onboarding/clone embeds token-A tied to cookieId-A. The user's
   *   browser polls /first-run a few times → each GET issues a new
   *   token-N tied to a NEW cookieId-N, overwriting the cookie. Submit
   *   the form: cookie sends cookieId-N, form sends token-A → mismatch
   *   → 403. Multi-tab makes it worse (every tab steals the cookie from
   *   every other tab).
   *
   *   Tokens here are deterministic (`token = sha256(secret)`), so the
   *   secret + cookie id ARE the auth — re-deriving the same token
   *   from the same secret is safe. Reuse keeps every page-load idle on
   *   the existing cookie and lets the original form's token match.
   *
   * The one-time-use guarantee on `verify()` is unchanged: the secret
   * is consumed on POST, so a fresh `getOrIssue` after submit will mint
   * a new cookie id (because the existing one has no backend entry).
   */
  getOrIssue(req: Request, res: Response, isProduction: boolean): Promise<string>
  /**
   * Verify a POST: reads the cookieId from `req.headers.cookie`, looks
   * up the secret, runs `validateCSRF`, and deletes the secret on
   * success. Returns true/false.
   */
  verify(req: Request): Promise<boolean>
  /**
   * Render a hidden input for HTML forms. Thin wrapper around
   * `csrfHiddenField` for convenience so callers import ONE module.
   */
  hiddenField(token: string): string
  /** Test helper: number of active entries in the store. */
  size(): Promise<number>
}

// ---------------------------------------------------------------------------
// Memory backend
// ---------------------------------------------------------------------------

export interface MemoryCsrfStoreOptions {
  /**
   * When the store grows past this many entries, half of the oldest
   * entries are evicted to keep memory bounded. Default 10,000.
   */
  maxEntries?: number
  /**
   * Injected clock for tests. Returns the current time in milliseconds.
   * Defaults to `Date.now`.
   */
  now?: () => number
}

interface MemoryEntry {
  secret: string
  expiresAtMs: number
}

/**
 * In-memory secret store. Wraps a `Map<cookieId, {secret, expiresAtMs}>`
 * with per-entry TTL expiry and halve-when-full eviction. This is the
 * default backend — suitable for single-process deployments (and for
 * tests).
 */
export function createMemoryCsrfStore(
  options: MemoryCsrfStoreOptions = {},
): CsrfSecretStore {
  const maxEntries = options.maxEntries ?? 10_000
  const now = options.now ?? Date.now
  const entries = new Map<string, MemoryEntry>()

  function evictIfFull() {
    if (entries.size <= maxEntries) return
    const keys = Array.from(entries.keys())
    const half = Math.floor(keys.length / 2)
    for (let i = 0; i < half; i++) {
      entries.delete(keys[i])
    }
  }

  function purgeExpired(cookieId: string): void {
    const hit = entries.get(cookieId)
    if (hit && hit.expiresAtMs <= now()) {
      entries.delete(cookieId)
    }
  }

  return {
    async set(cookieId, secret, ttlSeconds) {
      entries.set(cookieId, {
        secret,
        expiresAtMs: now() + ttlSeconds * 1000,
      })
      evictIfFull()
    },
    async get(cookieId) {
      purgeExpired(cookieId)
      const hit = entries.get(cookieId)
      return hit ? hit.secret : null
    },
    async delete(cookieId) {
      entries.delete(cookieId)
    },
    async size() {
      return entries.size
    },
  }
}

// ---------------------------------------------------------------------------
// Redis backend
// ---------------------------------------------------------------------------

/**
 * Duck-typed Redis client interface. Deliberately minimal so consumers
 * can pass `ioredis`, `node-redis`, or an in-memory fake in tests
 * without this package taking a dependency on any specific library.
 *
 * The `set` signature matches `ioredis.set(key, value, 'EX', seconds)`
 * and `node-redis` v4's `set(key, value, { EX: seconds })`. Implementers
 * that need a different shape should write a thin adapter.
 */
export interface RedisLikeClient {
  set(
    key: string,
    value: string,
    mode: 'EX',
    ttlSeconds: number,
  ): Promise<unknown>
  get(key: string): Promise<string | null>
  del(key: string): Promise<unknown>
}

/**
 * Create a Redis-backed CSRF secret store. Keys are namespaced under
 * `${keyPrefix}:${cookieId}` (default prefix `gbox:csrf`) so multiple
 * apps (accounts, admin, checkout) can share a Redis instance without
 * colliding. TTL is passed through to Redis `SET ... EX <ttl>`.
 */
export function createRedisCsrfStore(
  client: RedisLikeClient,
  keyPrefix: string = 'gbox:csrf',
): CsrfSecretStore {
  const key = (cookieId: string) => `${keyPrefix}:${cookieId}`

  return {
    async set(cookieId, secret, ttlSeconds) {
      await client.set(key(cookieId), secret, 'EX', ttlSeconds)
    },
    async get(cookieId) {
      return await client.get(key(cookieId))
    },
    async delete(cookieId) {
      await client.del(key(cookieId))
    },
  }
}

// ---------------------------------------------------------------------------
// Shared node-redis v5 backend (used when REDIS_URL is configured)
// ---------------------------------------------------------------------------

/**
 * CSRF backend that uses the process-wide node-redis v5 client from
 * `@gbox/core/modules/cache/redis.js`. Unlike `createRedisCsrfStore`
 * above — which takes an ioredis-shaped client and exists so tests
 * can inject a fake — this variant speaks node-redis v5's options
 * object (`{ EX: ttlSeconds }`) and lazily resolves the singleton.
 *
 * Why this exists:
 *   Every TS app (accounts, store-admin, god-admin, checkout, …)
 *   shares one Redis connection via `getRedis()`. Before this helper
 *   every `createCsrfStore` callsite had to hand-wire a backend OR
 *   quietly fall back to in-memory — under pm2 cluster mode with >1
 *   worker, in-memory is broken because the GET that mints the
 *   secret and the POST that verifies it round-robin to different
 *   workers. Centralising Redis here lets the factory make the right
 *   choice by default.
 *
 * Keys are namespaced `${prefix}:${cookieId}` with a trailing-colon
 * cleanup, so call sites can pass e.g. `gbox:csrf:signup` without
 * worrying about accidental double colons.
 */
export function createNodeRedisCsrfBackend(
  keyPrefix: string = 'gbox:csrf',
): CsrfSecretStore {
  const prefix = keyPrefix.replace(/:+$/, '')
  const redisKey = (cookieId: string) => `${prefix}:${cookieId}`

  return {
    async set(cookieId, secret, ttlSeconds) {
      const client = await getRedis()
      await client.set(redisKey(cookieId), secret, { EX: ttlSeconds })
    },
    async get(cookieId) {
      const client = await getRedis()
      const value = await client.get(redisKey(cookieId))
      return typeof value === 'string' ? value : null
    },
    async delete(cookieId) {
      const client = await getRedis()
      await client.del(redisKey(cookieId))
    },
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const ONE_HOUR_SECONDS = 60 * 60

let warnedMissingRedisInProd = false

/**
 * Pick a backend for `createCsrfStore` when the caller did not pass
 * one explicitly. Behaviour:
 *
 *   1. REDIS_URL set → shared node-redis v5 backend. Required for
 *      pm2 cluster mode (>1 worker) because in-memory state does not
 *      round-trip across forked workers.
 *   2. REDIS_URL unset → in-memory backend (same as Phase 0.4).
 *      In production we log a one-shot warning so ops notices that
 *      CSRF will break as soon as the app scales past 1 instance.
 *
 * Split out for testability — the unit tests flip env vars and call
 * this directly without going through the full factory.
 */
export function resolveDefaultCsrfBackend(
  cookieName: string,
  maxEntries: number,
  redisKeyPrefix?: string,
): CsrfSecretStore {
  if (process.env.REDIS_URL) {
    return createNodeRedisCsrfBackend(
      redisKeyPrefix ?? `gbox:csrf:${cookieName}`,
    )
  }
  if (process.env.NODE_ENV === 'production' && !warnedMissingRedisInProd) {
    warnedMissingRedisInProd = true
    // eslint-disable-next-line no-console
    console.warn(
      '[csrf-express] REDIS_URL not set in production — falling back to ' +
        'in-memory CSRF store. This will cause "Invalid form submission" ' +
        'errors under pm2 cluster mode with >1 worker. Set REDIS_URL to ' +
        'a running Redis instance to enable cluster-safe CSRF.',
    )
  }
  return createMemoryCsrfStore({ maxEntries })
}

export function createCsrfStore(options: CsrfStoreOptions = {}): CsrfStore {
  const cookieName = options.cookieName ?? 'gbox_csrf'
  const fieldName = options.fieldName ?? '_csrf'
  const maxEntries = options.maxEntries ?? 10_000
  const cookieTtl = options.cookieTtlSeconds ?? ONE_HOUR_SECONDS
  const backend =
    options.backend ??
    resolveDefaultCsrfBackend(cookieName, maxEntries, options.redisKeyPrefix)

  async function issue(res: Response, isProduction: boolean): Promise<string> {
    const { token, secret } = generateCSRFPair()
    const cookieId = randomBytes(16).toString('hex')
    await backend.set(cookieId, secret, cookieTtl)

    const parts = [
      `${cookieName}=${cookieId}`,
      `Path=/`,
      `Max-Age=${cookieTtl}`,
      `SameSite=Lax`,
      `HttpOnly`,
    ]
    if (isProduction) parts.push('Secure')
    // `appendHeader` preserves any existing Set-Cookie (e.g. session).
    res.appendHeader('Set-Cookie', parts.join('; '))

    return token
  }

  async function getOrIssue(
    req: Request,
    res: Response,
    isProduction: boolean,
  ): Promise<string> {
    // Try to reuse an existing cookie id if its backend secret is still
    // alive. `token = sha256(secret)` is deterministic, so re-deriving
    // it from the same secret is byte-identical to the original issue.
    const cookies = parseCookies(req.headers.cookie ?? '')
    const existingCookieId = cookies[cookieName]
    if (existingCookieId) {
      const secret = await backend.get(existingCookieId)
      if (secret) {
        return createHash('sha256').update(secret).digest('hex')
      }
    }
    // No existing cookie OR existing cookie's secret has expired / been
    // consumed by a prior verify. Mint fresh, which writes a new
    // Set-Cookie.
    return await issue(res, isProduction)
  }

  async function verify(req: Request): Promise<boolean> {
    const cookies = parseCookies(req.headers.cookie ?? '')
    const cookieId = cookies[cookieName]
    if (!cookieId) return false

    const secret = await backend.get(cookieId)
    if (!secret) return false

    // 2026-04-27 — accept the token from EITHER req.headers['x-csrf-token']
    // (AJAX / fetch + JSON, e.g. the theme customizer's POST handlers)
    // OR req.body[fieldName] (traditional <form> with hidden input).
    // Before this change every customizer fetch returned 403 because
    // the client sent the header but the server only looked at the body.
    // Symptom Thai surfaced: "Add section button doesn't work" — every
    // POST to /customize/sections/* failed CSRF and the client alert()'d
    // the 403. Express normalises header names to lowercase so we read
    // 'x-csrf-token' rather than the original casing.
    const headerToken = req.headers['x-csrf-token']
    const headerStr =
      typeof headerToken === 'string'
        ? headerToken
        : Array.isArray(headerToken)
          ? headerToken[0]
          : undefined
    const bodyToken = (req.body as Record<string, unknown> | undefined)?.[
      fieldName
    ]
    const submitted =
      typeof headerStr === 'string' && headerStr.length > 0
        ? headerStr.trim()
        : bodyToken
    if (typeof submitted !== 'string' || submitted.length === 0) return false

    // 2026-04-25 — switched away from one-time-use semantics.
    //
    // The previous implementation deleted the secret on EVERY verify
    // (success or failure), turning every form submit into a "your
    // token is now dead" event. Combined with browser bfcache that
    // restores form pages on Back, this caused legitimate users to
    // 403 every time they:
    //
    //   - went back from a result page to re-submit a form,
    //   - opened multiple tabs of the same form (one tab consumed,
    //     other tabs immediately stale),
    //   - refreshed a result page that the browser tried to POST-
    //     replay (Chrome warns + auto-resubmits),
    //   - hit a transient network failure and the browser retried.
    //
    // Standard double-submit-cookie CSRF impls (Rails, Django,
    // express-csurf) keep the secret alive for the cookie's TTL and
    // verify match-only. The `secret` here lives in HttpOnly Secure
    // SameSite=Lax storage with a 1-hour TTL, so an attacker who
    // doesn't already have the user's session can't read it. Replay
    // is N/A because anyone with both the token AND the matching
    // cookie already has the session anyway.
    //
    // Brute-force concern: token = sha256(32 random bytes). Forcing
    // a sha256 collision to a known target is computationally
    // infeasible. Burn-on-failure was theatre, not security.
    //
    // Net effect:
    //   - bug 96 (back-button + paste URL = 403) goes away
    //   - multi-tab forms work
    //   - cookie + secret pair are unique per page-render-session
    //     (still rotated when explicit `issue()` is called) and
    //     auto-expire at cookie TTL
    return validateCSRF(submitted, secret)
  }

  return {
    issue,
    getOrIssue,
    verify,
    hiddenField: csrfHiddenField,
    size: async () => {
      if (typeof backend.size === 'function') {
        return await backend.size()
      }
      return 0
    },
  }
}
