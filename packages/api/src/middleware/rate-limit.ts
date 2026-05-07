/**
 * Gbox Platform — Rate Limiting Middleware
 *
 * Sliding window rate limiter using PostgreSQL.
 * Defaults:
 *   - 120 requests per minute per IP (Shopify-compatible)
 *   - 40 requests per second for API token requests
 *
 * Returns 429 with Retry-After header when exceeded.
 * Sets X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset headers.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitOptions {
  /** Time window in milliseconds (default: 60_000 = 1 minute). */
  windowMs?: number
  /** Max requests allowed in the window (default: 120). */
  maxRequests?: number
  /** Function to derive the rate-limit key from a request (default: IP-based). */
  keyGenerator?: (request: Request) => string
}

export interface RateLimitResult {
  allowed: boolean
  limit: number
  remaining: number
  resetAt: Date
  retryAfterSeconds?: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  })
}

/**
 * Default key generator extracts IP from X-Forwarded-For or falls back
 * to a generic key.
 */
function defaultKeyGenerator(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  const ip = forwarded ? forwarded.split(',')[0]!.trim() : 'unknown'
  return `ip:${ip}`
}

// ---------------------------------------------------------------------------
// Core rate-limit check (sliding window)
// ---------------------------------------------------------------------------

/**
 * Check and update rate limit for a given key using a sliding window.
 * Uses the rate_limits table with atomic operations.
 */
export async function checkRateLimit(
  db: Kysely<Database>,
  key: string,
  windowMs: number,
  maxRequests: number,
): Promise<RateLimitResult> {
  const now = new Date()
  const windowStart = new Date(now.getTime() - windowMs)

  // Clean up expired entries for this key
  await db
    .deleteFrom('rate_limits')
    .where('key', '=', key)
    .where('window_start', '<', windowStart.toISOString())
    .execute()

  // Count current requests in window
  const countResult = await db
    .selectFrom('rate_limits')
    .select(db.fn.countAll<number>().as('count'))
    .where('key', '=', key)
    .where('window_start', '>=', windowStart.toISOString())
    .executeTakeFirstOrThrow()

  const currentCount = Number(countResult.count)

  const resetAt = new Date(now.getTime() + windowMs)

  if (currentCount >= maxRequests) {
    // Find the oldest entry in the window to calculate retry-after
    const oldest = await db
      .selectFrom('rate_limits')
      .select('window_start')
      .where('key', '=', key)
      .orderBy('window_start', 'asc')
      .limit(1)
      .executeTakeFirst()

    const retryAfterMs = oldest
      ? new Date(oldest.window_start).getTime() + windowMs - now.getTime()
      : windowMs

    return {
      allowed: false,
      limit: maxRequests,
      remaining: 0,
      resetAt,
      retryAfterSeconds: Math.ceil(Math.max(retryAfterMs, 1000) / 1000),
    }
  }

  // Record this request
  await db
    .insertInto('rate_limits')
    .values({
      key,
      window_start: now.toISOString(),
      request_count: 1,
    })
    .execute()

  return {
    allowed: true,
    limit: maxRequests,
    remaining: maxRequests - currentCount - 1,
    resetAt,
  }
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Creates a rate limiting middleware function.
 *
 * Usage:
 * ```ts
 * const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 120 })
 * const response = await limiter(db, request, handler)
 * ```
 */
export function createRateLimiter(options: RateLimitOptions = {}) {
  const {
    windowMs = 60_000,
    maxRequests = 120,
    keyGenerator = defaultKeyGenerator,
  } = options

  return async function rateLimitMiddleware(
    db: Kysely<Database>,
    request: Request,
    next: () => Promise<Response>,
  ): Promise<Response> {
    const key = keyGenerator(request)
    const result = await checkRateLimit(db, key, windowMs, maxRequests)

    const rateLimitHeaders: Record<string, string> = {
      'X-RateLimit-Limit': String(result.limit),
      'X-RateLimit-Remaining': String(result.remaining),
      'X-RateLimit-Reset': String(Math.floor(result.resetAt.getTime() / 1000)),
    }

    if (!result.allowed) {
      return json(
        {
          errors: ['Exceeded API rate limit. Please retry after the Retry-After period.'],
        },
        429,
        {
          ...rateLimitHeaders,
          'Retry-After': String(result.retryAfterSeconds),
        },
      )
    }

    // Proceed with the actual handler
    const response = await next()

    // Append rate-limit headers to the response
    const newHeaders = new Headers(response.headers)
    for (const [k, v] of Object.entries(rateLimitHeaders)) {
      newHeaders.set(k, v)
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    })
  }
}

// ---------------------------------------------------------------------------
// Pre-configured limiters
// ---------------------------------------------------------------------------

/**
 * Default IP-based rate limiter: 120 requests per minute.
 */
export const defaultLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 120,
})

/**
 * API token rate limiter: 40 requests per second.
 */
export const apiTokenLimiter = createRateLimiter({
  windowMs: 1_000,
  maxRequests: 40,
  keyGenerator: (request: Request) => {
    const auth = request.headers.get('authorization') ?? ''
    const token = auth.replace(/^Bearer\s+/i, '')
    return token ? `token:${token}` : defaultKeyGenerator(request)
  },
})
