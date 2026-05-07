/**
 * Security Module — CORS Configuration
 *
 * Configures Cross-Origin Resource Sharing for the Platform API.
 * Only whitelisted origins can access the API from browsers.
 */

import cors from 'cors'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { cacheGet, cacheSet } from '../cache/redis.js'

// Static allow-list — always allowed, regardless of environment.
// Extra origins can be added at runtime via `CORS_ALLOWED_ORIGINS`
// (comma-separated list of full origins). Wildcard suffixes live in
// `CORS_ALLOWED_ORIGIN_SUFFIXES` (comma-separated bare hostnames; e.g.
// "gbox.co,thaibeotit.com" allows `https://*.gbox.co` + `*.thaibeotit.com`).
const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  // Local development (all 6 app ports)
  'http://localhost:4321',   // Platform API
  'http://localhost:4322',   // Legacy / reserved
  'http://localhost:4323',   // Accounts
  'http://localhost:4324',   // God Admin
  'http://localhost:4325',   // Store Admin
  'http://localhost:4326',   // Storefront
  'http://localhost:4327',   // Checkout
  // LAN test server
  'http://192.168.1.13:4321',
  'http://192.168.1.13:4323',
  'http://192.168.1.13:4324',
  'http://192.168.1.13:4325',
  'http://192.168.1.13:4326',
  'http://192.168.1.13:4327',
  // Production (gbox.co) — kept for compat; wildcard below also covers these.
  'https://gbox.co',
  'https://www.gbox.co',
  'https://admin.gbox.co',
  'https://accounts.gbox.co',
  'https://api.gbox.co',
]

// Hostnames whose subdomains (and apex) are allowed. Every entry
// authorizes `https?://(<sub>.)*<suffix>(:port)?`. Defaults cover
// the main production brand and the LAN-test dev brand so that a
// fresh checkout with an empty env file still works for both.
const DEFAULT_ALLOWED_SUFFIXES: readonly string[] = ['gbox.co', 'thaibeotit.com']

function splitEnvList(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

// Resolve allow-list and suffixes once at module load. Tests that
// mutate process.env should reset modules between cases.
const ALLOWED_ORIGINS: readonly string[] = [
  ...DEFAULT_ALLOWED_ORIGINS,
  ...splitEnvList(process.env.CORS_ALLOWED_ORIGINS),
]
const ALLOWED_SUFFIXES: readonly string[] = [
  ...DEFAULT_ALLOWED_SUFFIXES,
  ...splitEnvList(process.env.CORS_ALLOWED_ORIGIN_SUFFIXES),
]
// Escape dots so each suffix is treated literally when embedded in the regex.
const SUFFIX_REGEX = new RegExp(
  `^https?:\\/\\/([a-z0-9-]+\\.)*(?:${ALLOWED_SUFFIXES.map((s) =>
    s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ).join('|')})(:\\d+)?$`,
  'i',
)

// Dynamic origin matcher — allows static list, any configured suffix
// (e.g. *.gbox.co, *.thaibeotit.com), and everything in non-prod.
function originMatcher(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
  // Allow requests with no origin (server-to-server, curl, mobile apps,
  // same-origin form POSTs where the browser omits the header).
  if (!origin) {
    callback(null, true)
    return
  }

  // Static allow-list path (fast).
  if (ALLOWED_ORIGINS.includes(origin)) {
    callback(null, true)
    return
  }

  // Any *.<suffix> origin.
  if (ALLOWED_SUFFIXES.length > 0 && SUFFIX_REGEX.test(origin)) {
    callback(null, true)
    return
  }

  // Dev convenience: allow all origins when not in production.
  if (process.env.NODE_ENV !== 'production') {
    callback(null, true)
    return
  }

  // Store custom domains are validated at the route level via
  // dynamicShopCors (shop_domains + shops.custom_domain lookup).
  callback(new Error(`CORS: Origin ${origin} not allowed`))
}

/**
 * CORS middleware for the Platform API.
 * Restricts browser-based API access to whitelisted origins.
 */
export const corsConfig = cors({
  origin: originMatcher,
  credentials: true,             // Allow cookies (session tokens)
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Requested-With'],
  exposedHeaders: ['X-Total-Count', 'X-Page', 'X-Per-Page'],
  maxAge: 600,                   // Preflight cache: 10 minutes
})

/**
 * Restrictive CORS for admin panels — only same-origin + API server.
 */
export const adminCorsConfig = cors({
  origin: originMatcher,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
  maxAge: 600,
})

// ---------------------------------------------------------------------------
// PHASE 4.2.4 — Dynamic CORS per shop custom domain
//
// Merchants bring their own domains (my-shop.com, shop.acme.com).
// We can't know them at boot, so the origin validator has to consult
// the DB. Result is cached in Redis (`cors:ok:<host>`) for 5 minutes.
// ---------------------------------------------------------------------------

const DYNAMIC_CACHE_TTL = 5 * 60 // 5 minutes

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Create a CORS middleware that dynamically allows any verified shop
 * domain in addition to the static `ALLOWED_ORIGINS` list.
 */
export function dynamicShopCors(db: Kysely<Database>) {
  return cors({
    origin: async (origin, callback) => {
      if (!origin) return callback(null, true)

      // Static allow-list + configured suffix wildcards (fast path).
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true)
      if (ALLOWED_SUFFIXES.length > 0 && SUFFIX_REGEX.test(origin)) {
        return callback(null, true)
      }

      const host = hostOf(origin)
      if (!host) return callback(new Error(`CORS: invalid origin ${origin}`))

      // Redis cache hit/miss.
      const cacheKey = `cors:ok:${host}`
      const cached = await cacheGet<boolean>(cacheKey)
      if (cached === true) return callback(null, true)
      if (cached === false) {
        return callback(new Error(`CORS: origin ${origin} not allowed`))
      }

      // DB lookup — any verified shop_domains row or shops.custom_domain.
      try {
        const verified = await db
          .selectFrom('shop_domains')
          .select('shop_id')
          .where('domain', '=', host)
          .where('verified', '=', true)
          .executeTakeFirst()

        if (verified) {
          await cacheSet(cacheKey, true, DYNAMIC_CACHE_TTL)
          return callback(null, true)
        }

        const customShop = await db
          .selectFrom('shops')
          .select('id')
          .where('custom_domain', '=', host)
          .executeTakeFirst()

        if (customShop) {
          await cacheSet(cacheKey, true, DYNAMIC_CACHE_TTL)
          return callback(null, true)
        }

        // Negative cache to avoid DB thrash on repeated bad origins.
        await cacheSet(cacheKey, false, 60)
        return callback(new Error(`CORS: origin ${origin} not allowed`))
      } catch (err) {
        // On DB error, fail closed in prod, open in dev.
        if (process.env.NODE_ENV !== 'production') return callback(null, true)
        return callback(err as Error)
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-CSRF-Token',
      'X-Requested-With',
      'X-Shop-Domain',
      'Idempotency-Key',
    ],
    exposedHeaders: ['X-Total-Count', 'X-Page', 'X-Per-Page', 'Idempotency-Replay'],
    maxAge: 600,
  })
}
