/**
 * Gbox Platform — Shop Context Middleware (Shopify pattern)
 *
 * Resolves the "current shop" for every incoming request and stamps:
 *
 *   req.shop    — the full Shop row (cached per-request)
 *   req.shopId  — shop primary key, convenient shorthand
 *
 * Resolution order (first match wins):
 *
 *   1. Explicit header `X-Shop-Domain` (server-to-server calls, tests).
 *   2. API token `Authorization: Bearer <token>` → api_tokens.shop_id.
 *   3. Request Host/hostname → shops.domain / shops.custom_domain /
 *      verified shop_domains entry.
 *
 * Result is cached in Redis (`shop:host:<host>` / `shop:id:<id>`) for
 * 5 minutes to keep per-request overhead below 1ms.
 *
 * Why this exists:
 *   Manual `req.query.shop_id` threading is how multi-tenant data leaks
 *   happen. A single forgotten `WHERE shop_id=?` exposes another
 *   merchant's orders. By centralizing the resolution, downstream
 *   handlers never have to parse shop context themselves.
 */

import type { Request, Response, NextFunction } from 'express'
import crypto from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Database, ShopTable } from '@gbox/db/schema/tables.js'
import { cacheGet, cacheSet } from '../cache/redis.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Selectable<T> = {
  [K in keyof T]: T[K] extends import('kysely').ColumnType<infer S, any, any>
    ? S
    : T[K]
}

export type Shop = Selectable<ShopTable>

declare module 'express-serve-static-core' {
  interface Request {
    shop?: Shop
    shopId?: string
  }
}

export interface ShopContextOptions {
  db: Kysely<Database>
  /** Optional: if true (default), missing shop = 404 on any non-public path. */
  required?: boolean
  /** Paths that skip shop resolution (e.g. /health, /_metrics). */
  skipPaths?: RegExp[]
}

const CACHE_TTL = 5 * 60 // 5 minutes
const DEFAULT_SKIP = [/^\/health$/, /^\/_metrics/, /^\/favicon\.ico$/]

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export function shopContext(opts: ShopContextOptions) {
  const { db, required = false, skipPaths = DEFAULT_SKIP } = opts

  return async function shopContextMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    if (skipPaths.some((rx) => rx.test(req.path))) return next()

    try {
      const shop = await resolveShop(db, req)
      if (shop) {
        req.shop = shop
        req.shopId = shop.id
      } else if (required) {
        return res.status(404).json({
          error: 'shop_not_found',
          message: 'No shop context could be derived from this request',
        })
      }
      return next()
    } catch (err) {
      console.error('[shopContext] resolution error:', (err as Error).message)
      // Fail open on errors — better to serve public endpoints than 500.
      return next()
    }
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

async function resolveShop(
  db: Kysely<Database>,
  req: Request,
): Promise<Shop | null> {
  // 1. X-Shop-Domain header (explicit override).
  const headerDomain = headerValue(req.headers['x-shop-domain'])
  if (headerDomain) {
    const s = await shopByHost(db, headerDomain)
    if (s) return s
  }

  // 2. API token.
  const auth = headerValue(req.headers['authorization'])
  if (auth?.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim()
    if (token) {
      const s = await shopByApiToken(db, token)
      if (s) return s
    }
  }

  // 3. Host header.
  const host = (req.hostname || headerValue(req.headers['host']) || '')
    .toLowerCase()
    .split(':')[0]
  if (host) {
    const s = await shopByHost(db, host)
    if (s) return s
  }

  return null
}

function headerValue(v: string | string[] | undefined): string | undefined {
  if (!v) return undefined
  return Array.isArray(v) ? v[0] : v
}

// ---------------------------------------------------------------------------
// Lookups (cached)
// ---------------------------------------------------------------------------

async function shopByHost(
  db: Kysely<Database>,
  host: string,
): Promise<Shop | null> {
  const cacheKey = `shop:host:${host}`
  const cached = await cacheGet<Shop>(cacheKey)
  if (cached) return cached

  // Try primary domain column.
  let shop = (await db
    .selectFrom('shops')
    .selectAll()
    .where('domain', '=', host)
    .executeTakeFirst()) as Shop | undefined

  if (!shop) {
    shop = (await db
      .selectFrom('shops')
      .selectAll()
      .where('custom_domain', '=', host)
      .executeTakeFirst()) as Shop | undefined
  }

  if (!shop) {
    const domainRow = await db
      .selectFrom('shop_domains')
      .select('shop_id')
      .where('domain', '=', host)
      .where('verified', '=', true)
      .executeTakeFirst()
    if (domainRow) {
      shop = (await db
        .selectFrom('shops')
        .selectAll()
        .where('id', '=', domainRow.shop_id)
        .executeTakeFirst()) as Shop | undefined
    }
  }

  if (shop) await cacheSet(cacheKey, shop, CACHE_TTL)
  return shop ?? null
}

async function shopByApiToken(
  db: Kysely<Database>,
  token: string,
): Promise<Shop | null> {
  // Tokens are stored as SHA-256 hashes (api_tokens.token_hash).
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const cacheKey = `shop:token:${tokenHash}`
  const cached = await cacheGet<Shop>(cacheKey)
  if (cached) return cached

  const tokenRow = await db
    .selectFrom('api_tokens')
    .select(['shop_id'])
    .where('token_hash', '=', tokenHash)
    .executeTakeFirst()
    .catch(() => undefined)

  if (!tokenRow?.shop_id) return null

  const shop = (await db
    .selectFrom('shops')
    .selectAll()
    .where('id', '=', tokenRow.shop_id)
    .executeTakeFirst()) as Shop | undefined

  if (shop) await cacheSet(cacheKey, shop, CACHE_TTL)
  return shop ?? null
}
