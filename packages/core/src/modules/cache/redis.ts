/**
 * Gbox Platform — Redis Cache Module
 *
 * Centralized Redis client with cache helpers.
 * Used for: session caching, rate limiting, checkout sessions,
 * API response caching, CSRF tokens, OTP tracking.
 *
 * Single Redis instance handles 200,000+ ops/s — sufficient for 100K RPS.
 */

import { createClient, type RedisClientType } from 'redis'

// ---------------------------------------------------------------------------
// Singleton client
// ---------------------------------------------------------------------------

let client: RedisClientType | null = null
let connecting: Promise<RedisClientType> | null = null

/**
 * Get or create the Redis client singleton.
 * Lazy-initialized on first call. Safe to call multiple times.
 */
export async function getRedis(): Promise<RedisClientType> {
  if (client?.isReady) return client

  // Prevent multiple simultaneous connection attempts
  if (connecting) return connecting

  connecting = (async () => {
    const url = process.env.REDIS_URL || 'redis://localhost:6379'

    client = createClient({
      url,
      socket: {
        reconnectStrategy: (retries: number) => {
          if (retries > 20) return new Error('Redis: max reconnect attempts reached')
          return Math.min(retries * 100, 5000)
        },
        connectTimeout: 5000,
        keepAlive: true,
      },
    }) as RedisClientType

    client.on('error', (err) => {
      console.error('[Redis] Error:', err.message)
    })

    client.on('connect', () => {
      console.log('[Redis] Connected')
    })

    client.on('reconnecting', () => {
      console.log('[Redis] Reconnecting...')
    })

    await client.connect()
    connecting = null
    return client
  })()

  return connecting
}

/**
 * Check if Redis is available (non-blocking).
 */
export function isRedisReady(): boolean {
  return client?.isReady ?? false
}

/**
 * Gracefully close Redis connection.
 */
export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit()
    client = null
  }
}

// ---------------------------------------------------------------------------
// Cache helpers — JSON serialization built-in
// ---------------------------------------------------------------------------

/**
 * Get a cached value by key. Returns null on miss or Redis unavailable.
 */
export async function cacheGet<T = any>(key: string): Promise<T | null> {
  try {
    const redis = await getRedis()
    const val = await redis.get(key)
    return val ? JSON.parse(val) : null
  } catch {
    return null // Graceful degradation — cache miss on error
  }
}

/**
 * Set a cache value with TTL (seconds).
 */
export async function cacheSet(key: string, value: any, ttlSeconds: number): Promise<void> {
  try {
    const redis = await getRedis()
    await redis.set(key, JSON.stringify(value), { EX: ttlSeconds })
  } catch {
    // Silent fail — cache write failure shouldn't break the app
  }
}

/**
 * Delete a single cache key.
 */
export async function cacheDel(key: string): Promise<void> {
  try {
    const redis = await getRedis()
    await redis.del(key)
  } catch {
    // Silent fail
  }
}

/**
 * Delete all keys matching a pattern (use sparingly — O(N) scan).
 * For cache invalidation on writes.
 */
export async function cacheDelPattern(pattern: string): Promise<number> {
  try {
    const redis = await getRedis()
    let deleted = 0
    let cursor = '0'

    do {
      const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 100 })
      cursor = String(result.cursor)
      if (result.keys.length > 0) {
        await redis.del(result.keys)
        deleted += result.keys.length
      }
    } while (cursor !== '0')

    return deleted
  } catch {
    return 0
  }
}

/**
 * Increment a counter with TTL. Useful for rate limiting.
 * Returns the new count after increment.
 */
export async function cacheIncr(key: string, ttlSeconds: number): Promise<number> {
  try {
    const redis = await getRedis()
    const count = await redis.incr(key)
    if (count === 1) {
      // First increment — set TTL
      await redis.expire(key, ttlSeconds)
    }
    return count
  } catch {
    return 0
  }
}

/**
 * Get remaining TTL for a key (seconds). -1 if no TTL, -2 if key doesn't exist.
 */
export async function cacheTTL(key: string): Promise<number> {
  try {
    const redis = await getRedis()
    return await redis.ttl(key)
  } catch {
    return -2
  }
}

/**
 * Set a hash field.
 */
export async function cacheHSet(key: string, field: string, value: string, ttlSeconds?: number): Promise<void> {
  try {
    const redis = await getRedis()
    await redis.hSet(key, field, value)
    if (ttlSeconds) await redis.expire(key, ttlSeconds)
  } catch {
    // Silent fail
  }
}

/**
 * Get a hash field.
 */
export async function cacheHGet(key: string, field: string): Promise<string | null> {
  try {
    const redis = await getRedis()
    const val = await redis.hGet(key, field)
    return val ?? null
  } catch {
    return null
  }
}

/**
 * Ping Redis — for health checks.
 */
export async function redisPing(): Promise<boolean> {
  try {
    const redis = await getRedis()
    const result = await redis.ping()
    return result === 'PONG'
  } catch {
    return false
  }
}
