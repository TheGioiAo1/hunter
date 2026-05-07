/**
 * Security Module — Rate Limiting
 *
 * Configurable rate limiters for different endpoint categories.
 *
 * KNOWN BUG (2026-04-26): the `getRedisStore()` helper below is
 * imported but never wired into `createRateLimiter`. Every limiter
 * therefore runs against express-rate-limit's default MemoryStore,
 * keeping per-process counters that don't share across the PM2
 * cluster. Result: occasional 429 storms after `pm2 reload`, when a
 * fresh process's counter stacks on top of the old process's lingering
 * counter for the same IP. Tracked as a follow-up — fix is to make
 * the factory async and resolve `store: await getRedisStore(prefix)`
 * into the rateLimit({...}) options at boot time.
 *
 * Until that lands, the global `/admin/` blanket guard is disabled in
 * `apps/store-admin/src/server.ts` (auth + CSRF + per-route limiters
 * still apply).
 */

import rateLimit from 'express-rate-limit'
import type { Request, Response } from 'express'

// ---------------------------------------------------------------------------
// Redis store loader (lazy — avoids import errors if redis not installed)
// ---------------------------------------------------------------------------

let redisStoreInstance: any = null

async function getRedisStore(prefix: string) {
  try {
    const { default: RedisStore } = await import('rate-limit-redis')
    const { getRedis } = await import('../cache/redis.js')
    const redis = await getRedis()

    return new RedisStore({
      sendCommand: (...args: string[]) => redis.sendCommand(args),
      prefix: `rl:${prefix}:`,
    })
  } catch {
    console.warn('[Rate Limit] Redis unavailable, using in-memory store')
    return undefined // Falls back to MemoryStore
  }
}

// ---------------------------------------------------------------------------
// Factory — create custom rate limiters
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  /** Window in milliseconds */
  windowMs: number
  /** Max requests per window per key */
  max: number
  /** Message returned on 429 */
  message?: string
  /** Key generator (defaults to IP) */
  keyGenerator?: (req: Request) => string
  /** Skip successful requests (count only failures) */
  skipSuccessfulRequests?: boolean
  /** Skip failed requests (count only successes) */
  skipFailedRequests?: boolean
  /** Store prefix for Redis keys */
  prefix?: string
}

export function createRateLimiter(config: RateLimitConfig) {
  return rateLimit({
    windowMs: config.windowMs,
    max: config.max,
    standardHeaders: true,
    legacyHeaders: false,
    // Disable ALL validations to avoid IPv6 key generator errors
    validate: false as any,
    message: {
      error: 'Too many requests',
      message: config.message || 'Rate limit exceeded. Please try again later.',
      retryAfter: Math.ceil(config.windowMs / 1000),
    },
    keyGenerator: config.keyGenerator || ((req: Request) => {
      return req.ip || req.socket?.remoteAddress || '127.0.0.1'
    }),
    skipSuccessfulRequests: config.skipSuccessfulRequests || false,
    skipFailedRequests: config.skipFailedRequests || false,
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        error: 'Too many requests',
        message: config.message || 'Rate limit exceeded. Please try again later.',
        retryAfter: Math.ceil(config.windowMs / 1000),
      })
    },
  })
}

// ---------------------------------------------------------------------------
// Pre-configured limiters
// ---------------------------------------------------------------------------

/**
 * Auth endpoints: 5 requests per minute (strict — brute force protection)
 * Apply to: POST /login, POST /signup, POST /forgot-password
 */
export const authLimiter = createRateLimiter({
  windowMs: 60 * 1000,      // 1 minute
  max: 5,
  message: 'Too many authentication attempts. Please wait 1 minute.',
  skipSuccessfulRequests: false,
  prefix: 'auth',
})

/**
 * API write endpoints: 30 requests per minute per IP
 * Apply to: POST, PUT, DELETE on /api/* routes
 */
export const apiLimiter = createRateLimiter({
  windowMs: 60 * 1000,      // 1 minute
  max: 30,
  message: 'API rate limit exceeded. Max 30 write operations per minute.',
  prefix: 'api-write',
})

/**
 * API read endpoints: 120 requests per minute per IP
 * Apply to: GET on /api/* routes
 */
export const apiReadLimiter = createRateLimiter({
  windowMs: 60 * 1000,      // 1 minute
  max: 120,
  message: 'API rate limit exceeded. Max 120 read operations per minute.',
  prefix: 'api-read',
})

/**
 * Strict limiter for dangerous operations: 3 per 5 minutes
 * Apply to: DELETE /stores, user impersonation, password reset triggers
 */
export const strictLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,  // 5 minutes
  max: 3,
  message: 'Too many sensitive operations. Please wait 5 minutes.',
  prefix: 'strict',
})

/**
 * General page limiter: 60 requests per minute
 * Apply to: all HTML page routes on admin/god-admin
 */
export const pageLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many page requests. Please slow down.',
  prefix: 'page',
})

// ---------------------------------------------------------------------------
// PHASE 4.2.1 — Checkout / payment limiters
//
// Without these, an attacker can burn through stolen cards at the
// /checkout endpoint to test validity. Stripe/Shopify block ~10 tries
// per IP/minute and then require CAPTCHA. We match that baseline here.
// ---------------------------------------------------------------------------

/**
 * Checkout: 10 submissions per minute per IP.
 * Apply to: POST /checkout, POST /checkouts/:id/complete.
 */
export const checkoutLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many checkout attempts. Please wait a moment.',
  prefix: 'checkout',
})

/**
 * Payment capture: 20 per minute per shop.
 * Apply to: POST /payments/capture, POST /transactions.
 * Keyed by shop so one angry merchant can't block another.
 */
export const paymentLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: 'Too many payment operations. Please wait a moment.',
  prefix: 'payment',
  keyGenerator: (req: Request) =>
    (req as any).shopId || req.ip || '127.0.0.1',
})

/**
 * Refund issue: 30 per 5 minutes per shop.
 * Apply to: POST /refunds, POST /orders/:id/refund.
 */
export const refundLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 30,
  message: 'Too many refund operations. Please wait a moment.',
  prefix: 'refund',
  keyGenerator: (req: Request) =>
    (req as any).shopId || req.ip || '127.0.0.1',
})
