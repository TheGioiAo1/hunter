/**
 * Gbox Storefront — Host→Shop Resolver Middleware (Stage 3A.4)
 *
 * Every storefront request must be anchored to a shop before any
 * downstream middleware (cookies, locale, theme render) can run.
 * This middleware is the anchor: it takes the incoming Host header,
 * normalizes it, consults a bounded LRU cache, falls back to a DB
 * lookup, and attaches the resolved shop to `req.gboxShop` +
 * `req.gboxShopId`.
 *
 * Lookup strategy (first match wins):
 *
 *   1. Trusted X-Forwarded-Host header (when the app is sitting
 *      behind nginx and `trustForwardedHost` is set).
 *   2. Express/Node `Host` header.
 *
 * Then, after normalization (`host.toLowerCase().strip(':port').strip('.')`):
 *
 *   A. In-memory LRU cache hit → skip DB.
 *   B. `lookup(host)` — the injected DB function. In production this
 *      is a Kysely query joining `shop_domains` and `shops`; in
 *      tests it is a plain function.
 *   C. Dev-only fallback: if the host is localhost/127.0.0.1 and the
 *      `STOREFRONT_DEV_SHOP_SLUG` env is set, call `lookupBySlug`
 *      instead. This lets local developers hit the storefront on
 *      `http://localhost:4326/` without having to fake /etc/hosts.
 *
 * Outcomes:
 *
 *   - **Hit** → req.gboxShop + req.gboxShopId set, cache warmed,
 *     `next()` called.
 *   - **Miss** → 404 response (plain text for now; Stage 3A.9 will
 *     wrap this in a templated page). The miss is negative-cached
 *     so repeated requests for the same bogus host do NOT keep
 *     hitting the database.
 *   - **Error** → logged, `next(err)` called so the error-handler
 *     can produce a 500. NOT cached.
 *
 * The cache is intentionally injected (not a module-level global)
 * so that tests can observe and reset it without touching the
 * file system.
 */

import type { Request, Response, NextFunction } from 'express'
import { LruCache } from '../lib/lru-cache.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResolvedShop {
  id: string
  slug: string
  name: string
  currency: string
  defaultLocale: string
  status: string
}

export type ShopLookup = (host: string) => Promise<ResolvedShop | null>
export type ShopLookupBySlug = (slug: string) => Promise<ResolvedShop | null>

export interface ResolveShopMiddlewareOptions {
  /** Required — DB lookup by host (shop_domains.domain first, then shops fallback). */
  lookup: ShopLookup
  /** Optional — DB lookup by slug, used only when devShopSlug is set and host is local. */
  lookupBySlug?: ShopLookupBySlug
  /**
   * When set, any request whose host normalizes to `localhost` or
   * `127.0.0.1` will resolve to the shop whose slug equals this
   * value. Intended for `STOREFRONT_DEV_SHOP_SLUG` in local dev
   * only — leaving it unset in production is safer.
   */
  devShopSlug?: string
  /**
   * If true, prefer the `X-Forwarded-Host` header over the real
   * `Host` header. Enable this only when the app runs behind a
   * trusted reverse proxy (nginx on Server 1). Off by default.
   */
  trustForwardedHost?: boolean
  /**
   * Cache capacity. Defaults to 1024 entries — enough to hold every
   * custom domain a mid-sized platform deals with in memory.
   */
  cacheMaxEntries?: number
  /**
   * Cache TTL in milliseconds. Defaults to 60_000 (60 seconds) —
   * balances hot-path throughput against the need for custom-domain
   * changes to propagate without a process restart.
   */
  cacheTtlMs?: number
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Attached by resolve-shop middleware. */
    gboxShop?: ResolvedShop
    /** Shortcut for `req.gboxShop?.id` — widely read downstream. */
    gboxShopId?: string
  }
}

// ---------------------------------------------------------------------------
// Host normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a raw Host header into the exact string the lookup
 * function expects. Returns `null` if the value is unusable.
 *
 * Rules (applied in order):
 *   1. Trim surrounding whitespace.
 *   2. Lowercase.
 *   3. Strip the port, taking care not to mangle IPv6 addresses
 *      (which are bracketed: `[::1]:4326` → `[::1]`).
 *   4. Strip a trailing dot (FQDN canonicalization).
 *   5. Reject empty strings.
 */
export function normalizeHost(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return null
  let host = raw.trim().toLowerCase()
  if (host.length === 0) return null

  // IPv6 literal: `[addr]:port` → `[addr]`
  if (host.startsWith('[')) {
    const closeIdx = host.indexOf(']')
    if (closeIdx !== -1) {
      host = host.slice(0, closeIdx + 1)
    }
  } else {
    // IPv4 / DNS: strip the last `:NNNN` segment
    const colonIdx = host.lastIndexOf(':')
    if (colonIdx !== -1) {
      host = host.slice(0, colonIdx)
    }
  }

  // Strip trailing FQDN dot.
  while (host.endsWith('.')) {
    host = host.slice(0, -1)
  }

  if (host.length === 0) return null
  return host
}

// ---------------------------------------------------------------------------
// Cache value (either a hit or a negative-cached miss)
// ---------------------------------------------------------------------------

type CacheValue =
  | { kind: 'hit'; shop: ResolvedShop }
  | { kind: 'miss' }

// ---------------------------------------------------------------------------
// Dev-host detection
// ---------------------------------------------------------------------------

const DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])

function isLocalHost(host: string): boolean {
  return DEV_HOSTS.has(host)
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export function buildResolveShopMiddleware(
  options: ResolveShopMiddlewareOptions,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const {
    lookup,
    lookupBySlug,
    devShopSlug,
    trustForwardedHost = false,
    cacheMaxEntries = 1024,
    cacheTtlMs = 60_000,
  } = options

  const cache = new LruCache<string, CacheValue>({
    maxEntries: cacheMaxEntries,
    ttlMs: cacheTtlMs,
  })

  function respond404(res: Response): void {
    res.status(404).type('text/plain').send('404 Shop Not Found')
  }

  function pickHost(req: Request): string | null {
    const fwd = trustForwardedHost
      ? (req.headers['x-forwarded-host'] as string | undefined)
      : undefined
    const raw = fwd ?? (req.headers.host as string | undefined)
    return normalizeHost(raw)
  }

  return async function resolveShopMiddleware(req, res, next) {
    const host = pickHost(req)
    const logger = req.gboxCtx?.logger

    if (host === null) {
      logger?.warn?.({ host: req.headers.host }, 'resolve-shop: missing or invalid Host header')
      respond404(res)
      return
    }

    // 1. Cache lookup.
    const cached = cache.get(host)
    if (cached !== undefined) {
      if (cached.kind === 'hit') {
        req.gboxShop = cached.shop
        req.gboxShopId = cached.shop.id
        next()
        return
      }
      // Negative-cached miss.
      respond404(res)
      return
    }

    // 2. Dev fallback — localhost + configured slug.
    if (devShopSlug && lookupBySlug && isLocalHost(host)) {
      try {
        const shop = await lookupBySlug(devShopSlug)
        if (shop) {
          cache.set(host, { kind: 'hit', shop })
          req.gboxShop = shop
          req.gboxShopId = shop.id
          next()
          return
        }
        // Slug set but no shop — fall through to normal miss handling
        // (do NOT attempt the host lookup, since we already know the
        // dev fallback is authoritative when host is local).
        cache.set(host, { kind: 'miss' })
        respond404(res)
        return
      } catch (err) {
        logger?.error?.({ err, host, devShopSlug }, 'resolve-shop: dev lookup failed')
        next(err)
        return
      }
    }

    // 3. Production DB lookup by host.
    try {
      const shop = await lookup(host)
      if (shop === null) {
        cache.set(host, { kind: 'miss' })
        logger?.warn?.({ host }, 'resolve-shop: no shop for host')
        respond404(res)
        return
      }
      cache.set(host, { kind: 'hit', shop })
      req.gboxShop = shop
      req.gboxShopId = shop.id
      next()
    } catch (err) {
      // DB errors are NEVER cached — we want the next request to
      // retry once the database recovers.
      logger?.error?.({ err, host }, 'resolve-shop: lookup threw')
      next(err)
    }
  }
}
