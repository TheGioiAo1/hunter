/**
 * Gbox Platform — Idempotency Middleware (Stripe/Shopify pattern)
 *
 * A POST request carrying `Idempotency-Key: <uuid>` should be safe to
 * retry. If the same key + body hash was seen before, we replay the
 * cached response instead of re-running the handler.
 *
 * Storage:
 *   - Redis is the hot cache (`idem:<shop>:<key>`, TTL 24h).
 *   - The `idempotency_keys` DB table is the durable backup so a Redis
 *     flush doesn't cause double-charges.
 *
 * Scope rules (Shopify):
 *   - Keys are scoped per-shop (two different merchants can reuse the
 *     same UUID without colliding — the DB PK is (key, shop_id)).
 *   - Key must be <= 128 chars, method must be POST/PUT/PATCH/DELETE.
 *   - If the second request has the SAME key but a DIFFERENT body hash,
 *     we return 422 "idempotency_key_in_use" — the client is reusing a
 *     key for a different payload which is an abuse/bug.
 *
 * How to apply:
 *   app.post('/api/2026-04/checkout', idempotency(), checkoutHandler)
 */

import type { Request, Response, NextFunction } from 'express'
import crypto from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { cacheGet, cacheSet, getRedis } from '../cache/redis.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IdempotencyOptions {
  /** Where to pull the shop_id from. Default: req.shopId */
  getShopId?: (req: Request) => string | undefined
  /** Where to pull the idempotency key from. Default: req.headers['idempotency-key'] */
  getKey?: (req: Request) => string | undefined
  /** Redis TTL in seconds. Default: 24h */
  ttlSeconds?: number
  /** DB instance — if provided, will also write a durable row. */
  db?: Kysely<Database>
}

export interface CachedResponse {
  status_code: number
  body: unknown
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashBody(body: unknown): string {
  const normalized = JSON.stringify(body ?? {})
  return crypto.createHash('sha256').update(normalized).digest('hex')
}

function redisKey(shop_id: string, key: string): string {
  return `idem:${shop_id}:${key}`
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export function idempotency(opts: IdempotencyOptions = {}) {
  const ttl = opts.ttlSeconds ?? 24 * 60 * 60
  const getShopId = opts.getShopId ?? ((req: Request) => (req as any).shopId)
  const getKey =
    opts.getKey ??
    ((req: Request) => {
      const h = req.headers['idempotency-key']
      return Array.isArray(h) ? h[0] : h
    })

  return async function idempotencyMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    // Only apply to mutating methods.
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return next()
    }

    const key = getKey(req)
    if (!key) return next() // Idempotency is opt-in via header.

    if (key.length > 128) {
      return res.status(400).json({
        error: 'invalid_idempotency_key',
        message: 'Idempotency-Key must be <= 128 characters',
      })
    }

    const shopId = getShopId(req)
    if (!shopId) {
      // Can't scope safely without shop context — proceed without caching.
      return next()
    }

    const bodyHash = hashBody(req.body)
    const rKey = redisKey(shopId, key)

    // 1. Redis fast path.
    const cached = await cacheGet<CachedResponse & { request_hash: string }>(rKey)
    if (cached) {
      if (cached.request_hash !== bodyHash) {
        return res.status(422).json({
          error: 'idempotency_key_in_use',
          message: 'This Idempotency-Key was used with a different request body',
        })
      }
      res.setHeader('Idempotency-Replay', 'true')
      return res.status(cached.status_code).json(cached.body)
    }

    // 2. DB fallback (durable).
    if (opts.db) {
      const row = await opts.db
        .selectFrom('idempotency_keys')
        .select(['request_hash', 'status_code', 'response_body'])
        .where('key', '=', key)
        .where('shop_id', '=', shopId)
        .executeTakeFirst()

      if (row) {
        if (row.request_hash !== bodyHash) {
          return res.status(422).json({
            error: 'idempotency_key_in_use',
            message: 'This Idempotency-Key was used with a different request body',
          })
        }
        // Warm the Redis cache so subsequent retries are fast.
        await cacheSet(
          rKey,
          {
            status_code: row.status_code,
            body: row.response_body,
            request_hash: bodyHash,
          },
          ttl,
        )
        res.setHeader('Idempotency-Replay', 'true')
        return res.status(row.status_code).json(row.response_body)
      }
    }

    // 3. First-seen — attempt to claim the key atomically via Redis SET NX.
    //    If two concurrent requests race, only the first wins and the
    //    second gets a 409 "idempotency_in_progress".
    let lockAcquired = false
    try {
      const redis = await getRedis()
      const claimed = await redis.set(
        `${rKey}:lock`,
        '1',
        { NX: true, EX: 60 }, // 60s lock — longer than any handler should run
      )
      if (!claimed) {
        return res.status(409).json({
          error: 'idempotency_in_progress',
          message: 'A request with this Idempotency-Key is still being processed',
        })
      }
      lockAcquired = true
    } catch {
      // Redis down — degrade gracefully, skip the lock. The DB row still
      // protects us from a true duplicate on subsequent retries.
    }

    // 4. Hook into res.json so we capture the body. Persist + lock release
    //    runs from `res.on('finish')` so it covers BOTH the happy `res.json`
    //    path and the case where the global error handler short-circuits
    //    with a synchronous throw.
    let capturedBody: unknown = undefined
    const originalJson = res.json.bind(res)
    res.json = function capturedJson(body: unknown) {
      capturedBody = body
      return originalJson(body)
    }

    res.on('finish', () => {
      void (async () => {
        try {
          // Successful (or 4xx) responses get persisted so retries replay them.
          // 5xx is intentionally NOT cached (PRINCIPLES.md P2 — "retry must be safe");
          // we just release the lock so the client can legitimately retry.
          if (res.statusCode < 500) {
            await persistResponse(opts.db, {
              key,
              shop_id: shopId,
              request_hash: bodyHash,
              status_code: res.statusCode,
              body: capturedBody,
              ttlSeconds: ttl,
            })
          }
        } catch (err) {
          console.error('[idempotency] persist failed:', (err as Error).message)
        } finally {
          // Always release the lock, regardless of outcome — otherwise a
          // single 500 poisons the key for the full lock TTL (60s).
          if (lockAcquired) {
            try {
              const redis = await getRedis()
              await redis.del(`${rKey}:lock`)
            } catch {
              // Lock will expire on its own.
            }
          }
        }
      })()
    })

    return next()
  }
}

// ---------------------------------------------------------------------------
// Persist response (Redis + DB)
// ---------------------------------------------------------------------------

async function persistResponse(
  db: Kysely<Database> | undefined,
  args: {
    key: string
    shop_id: string
    request_hash: string
    status_code: number
    body: unknown
    ttlSeconds: number
  },
): Promise<void> {
  // Caller already filters status >= 500; this is a defensive guard.
  if (args.status_code >= 500) return

  // Redis cache.
  await cacheSet(
    redisKey(args.shop_id, args.key),
    {
      status_code: args.status_code,
      body: args.body,
      request_hash: args.request_hash,
    },
    args.ttlSeconds,
  )

  // Durable DB row — skip if no db handle was provided.
  if (!db) return

  const expiresAt = new Date(Date.now() + args.ttlSeconds * 1000).toISOString()

  await db
    .insertInto('idempotency_keys')
    .values({
      key: args.key,
      shop_id: args.shop_id,
      request_hash: args.request_hash,
      status_code: args.status_code,
      response_body: JSON.stringify(args.body) as any,
      expires_at: expiresAt,
    } as any)
    .onConflict((oc) => oc.doNothing())
    .execute()
}
