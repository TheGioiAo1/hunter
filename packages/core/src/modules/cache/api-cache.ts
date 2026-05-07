/**
 * API Response Cache Middleware
 *
 * Redis-backed response caching for GET endpoints.
 * Dramatically reduces DB load for read-heavy traffic.
 *
 * Cache strategy:
 * - Products list: 60s TTL
 * - Single product: 300s TTL
 * - Collections: 300s TTL
 * - Dashboard stats: 300s TTL
 * - Store settings: 600s TTL
 * - Orders list: 30s TTL (changes frequently)
 */

import type { Request, Response, NextFunction } from 'express'
import { cacheGet, cacheSet, cacheDelPattern } from './redis.js'

// ---------------------------------------------------------------------------
// Cache middleware factory
// ---------------------------------------------------------------------------

export interface CacheOptions {
  /** TTL in seconds */
  ttl: number
  /** Custom key generator (default: method + url + session) */
  keyGenerator?: (req: Request) => string
  /** Only cache if response status matches (default: 200) */
  statusCodes?: number[]
  /** Skip cache for these conditions */
  skipIf?: (req: Request) => boolean
}

/**
 * Express middleware that caches JSON responses in Redis.
 * Only caches GET requests with 200 status codes.
 *
 * Usage: app.get('/api/...', apiCache({ ttl: 60 }), handler)
 */
export function apiCache(options: CacheOptions) {
  const { ttl, statusCodes = [200] } = options

  return async (req: Request, res: Response, next: NextFunction) => {
    // Only cache GET requests
    if (req.method !== 'GET') return next()

    // Skip if condition met
    if (options.skipIf?.(req)) return next()

    // Generate cache key
    const key = options.keyGenerator
      ? options.keyGenerator(req)
      : `apicache:${req.originalUrl}`

    // Check cache
    try {
      const cached = await cacheGet<{ body: any; headers: Record<string, string> }>(key)
      if (cached) {
        res.set('X-Cache', 'HIT')
        res.set('X-Cache-TTL', String(ttl))
        if (cached.headers) {
          for (const [k, v] of Object.entries(cached.headers)) {
            res.set(k, v)
          }
        }
        res.json(cached.body)
        return
      }
    } catch {
      // Cache error — continue without cache
    }

    // Cache miss — intercept response
    const originalJson = res.json.bind(res)
    res.json = function (body: any) {
      // Only cache successful responses
      if (statusCodes.includes(res.statusCode)) {
        cacheSet(key, { body, headers: { 'Content-Type': 'application/json' } }, ttl).catch(() => {})
      }
      res.set('X-Cache', 'MISS')
      return originalJson(body)
    }

    next()
  }
}

// ---------------------------------------------------------------------------
// Cache invalidation helpers
// ---------------------------------------------------------------------------

/**
 * Invalidate all cached product lists for a shop.
 */
export async function invalidateProductCache(shopId: string): Promise<void> {
  await cacheDelPattern(`apicache:*/products*`)
  await cacheDelPattern(`apicache:*/store/${shopId}/*`)
}

/**
 * Invalidate a specific product cache.
 */
export async function invalidateProductById(productId: string): Promise<void> {
  await cacheDelPattern(`apicache:*/products/${productId}*`)
}

/**
 * Invalidate all cached collections for a shop.
 */
export async function invalidateCollectionCache(shopId: string): Promise<void> {
  await cacheDelPattern(`apicache:*/collections*`)
}

/**
 * Invalidate order caches for a shop.
 */
export async function invalidateOrderCache(shopId: string): Promise<void> {
  await cacheDelPattern(`apicache:*/orders*`)
}

/**
 * Invalidate customer caches for a shop.
 */
export async function invalidateCustomerCache(shopId: string): Promise<void> {
  await cacheDelPattern(`apicache:*/customers*`)
}

/**
 * Invalidate dashboard/analytics caches.
 */
export async function invalidateDashboardCache(): Promise<void> {
  await cacheDelPattern(`apicache:*/dashboard*`)
  await cacheDelPattern(`apicache:*/analytics*`)
}

/**
 * Invalidate ALL API caches (nuclear option — use sparingly).
 */
export async function invalidateAllCache(): Promise<void> {
  await cacheDelPattern('apicache:*')
}

// ---------------------------------------------------------------------------
// Pre-configured cache middleware instances
// ---------------------------------------------------------------------------

/** Products list: 60s cache */
export const cacheProducts = apiCache({ ttl: 60 })

/** Single product: 300s cache */
export const cacheProduct = apiCache({ ttl: 300 })

/** Collections: 300s cache */
export const cacheCollections = apiCache({ ttl: 300 })

/** Orders list: 30s cache (changes frequently) */
export const cacheOrders = apiCache({ ttl: 30 })

/** Customers list: 60s cache */
export const cacheCustomers = apiCache({ ttl: 60 })

/** Discounts: 120s cache */
export const cacheDiscounts = apiCache({ ttl: 120 })

/** Dashboard/analytics: 300s cache */
export const cacheDashboard = apiCache({ ttl: 300 })

/** Store settings: 600s cache */
export const cacheSettings = apiCache({ ttl: 600 })
