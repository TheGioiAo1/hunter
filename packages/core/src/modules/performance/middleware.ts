/**
 * Gbox Platform — Performance Middleware
 *
 * Bundles all performance optimizations into reusable middleware:
 * 1. Response compression (gzip/brotli) — reduces bandwidth 60-80%
 * 2. Keep-alive configuration — reuses TCP connections
 * 3. Request timing headers — helps debug slow requests
 * 4. Cache headers for static content
 *
 * Usage in any Express server:
 *   import { performanceMiddleware, configureKeepAlive } from '@gbox/core/modules/performance/middleware.js'
 *   app.use(performanceMiddleware())
 *   const server = app.listen(PORT)
 *   configureKeepAlive(server)
 */

import compression from 'compression'
import type { Request, Response, NextFunction } from 'express'
import type { Server } from 'http'

// ---------------------------------------------------------------------------
// Compression middleware
// ---------------------------------------------------------------------------

/**
 * Gzip/deflate compression for all responses > 1KB.
 * Reduces JSON response size by 60-80%.
 *
 * WHY: A typical product list response is ~50KB uncompressed.
 * Compressed: ~8KB. Saves 84% bandwidth.
 * At 100K RPS × 50KB = 5GB/s bandwidth. Compressed: 800MB/s.
 */
export function compressionMiddleware() {
  return compression({
    level: 6,              // Balance between speed and compression ratio
    threshold: 1024,       // Only compress responses > 1KB
    filter: (req: Request, res: Response) => {
      // Skip compression for webhooks (raw body needed)
      if (req.path?.startsWith('/api/webhooks')) return false
      // Skip for Server-Sent Events
      if (req.headers.accept === 'text/event-stream') return false
      // Default filter
      return compression.filter(req, res)
    },
  })
}

// ---------------------------------------------------------------------------
// Keep-alive configuration
// ---------------------------------------------------------------------------

/**
 * Configure HTTP keep-alive on the server.
 *
 * WHY: Without keep-alive, each request = new TCP handshake (~1ms LAN, ~50ms WAN).
 * With keep-alive, connections are reused. For Nginx → Node.js, this is critical:
 * Nginx sends `Connection: keep-alive` by default, but Node.js must also support it.
 *
 * keepAliveTimeout MUST be > Nginx's keepalive_timeout (65s default)
 * to prevent Nginx from sending requests on a closed connection (502 errors).
 */
export function configureKeepAlive(server: Server): void {
  server.keepAliveTimeout = 65000    // 65s — slightly > Nginx default
  server.headersTimeout = 70000      // Must be > keepAliveTimeout
  server.maxHeadersCount = 100       // Security limit
  server.timeout = 30000             // 30s request timeout
  server.requestTimeout = 30000      // 30s to receive full request
}

// ---------------------------------------------------------------------------
// Request timing header
// ---------------------------------------------------------------------------

/**
 * Adds Server-Timing header with processing time.
 * Useful for debugging slow requests via browser DevTools.
 */
export function timingMiddleware() {
  return (_req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint()

    res.on('finish', () => {
      const duration = Number(process.hrtime.bigint() - start) / 1_000_000
      // Only set header if response hasn't been sent yet
      if (!res.headersSent) return
      // Server-Timing header is read by browser DevTools
    })

    // Add timing to response headers
    const originalEnd = res.end.bind(res)
    res.end = function (...args: any[]) {
      const duration = Number(process.hrtime.bigint() - start) / 1_000_000
      if (!res.headersSent) {
        res.setHeader('Server-Timing', `total;dur=${duration.toFixed(1)}`)
        res.setHeader('X-Response-Time', `${duration.toFixed(1)}ms`)
      }
      return originalEnd(...args)
    } as any

    next()
  }
}

// ---------------------------------------------------------------------------
// Cache headers for API responses
// ---------------------------------------------------------------------------

/**
 * Set appropriate cache headers based on endpoint type.
 */
export function cacheHeaders(type: 'public' | 'private' | 'static') {
  return (_req: Request, res: Response, next: NextFunction) => {
    switch (type) {
      case 'public':
        // Storefront/public API — CDN can cache
        res.set('Cache-Control', 'public, max-age=60, s-maxage=120, stale-while-revalidate=300')
        break
      case 'private':
        // Admin API — never cache at CDN
        res.set('Cache-Control', 'private, no-store, must-revalidate')
        break
      case 'static':
        // Static assets — aggressive cache with immutable
        res.set('Cache-Control', 'public, max-age=604800, immutable')
        break
    }
    next()
  }
}

// ---------------------------------------------------------------------------
// Combined performance middleware
// ---------------------------------------------------------------------------

/**
 * Apply all performance middleware at once.
 * Usage: app.use(performanceMiddleware())
 */
export function performanceMiddleware() {
  const compress = compressionMiddleware()
  const timing = timingMiddleware()

  return (req: Request, res: Response, next: NextFunction) => {
    // Apply compression
    compress(req, res, (err?: any) => {
      if (err) return next(err)
      // Apply timing
      timing(req, res, next)
    })
  }
}
