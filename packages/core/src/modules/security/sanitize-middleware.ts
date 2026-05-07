/**
 * Gbox Platform — Sanitize Response Express Middleware (Phase 7.1)
 *
 * Wraps `res.json()` so every JSON response goes through
 * `sanitizeForResponse()` before it ships. This is the
 * defence-in-depth Iron Rule #1 demands: even when a route author
 * forgets to project `select()` away `password_hash`, the middleware
 * still scrubs the field on the way out.
 *
 * Mount it once, as early in the chain as possible:
 *
 *   import { sanitizeResponseMiddleware } from '@gbox/core/modules/security/sanitize-middleware.js'
 *
 *   app.use(express.json())
 *   app.use(sanitizeResponseMiddleware())
 *   // ... routes
 *
 * Performance: the wrapper only fires for `res.json()` calls. Routes
 * that stream binary, render templates, or call `res.send(string)`
 * are unaffected. The recursive walker is O(nodes) over the JSON
 * tree, which is fine for the response sizes we deal with — if a
 * route is shipping a megabyte of JSON, the sanitizer is the least
 * of your problems.
 */

import type { Request, Response, NextFunction } from 'express'
import { sanitizeForResponse, type SanitizeOptions } from './sanitize.js'

export interface SanitizeMiddlewareOptions extends SanitizeOptions {
  /**
   * Optional predicate to skip sanitization for specific requests.
   * Returning true → response passes through untouched. Use sparingly
   * — the default of "scrub everything" is the safe path.
   *
   * Example: skip the god-admin "raw row inspector" endpoint where
   * the operator explicitly wants to see the credential columns.
   *
   *   skip: (req) => req.path === '/admin/rows/raw'
   */
  skip?: (req: Request) => boolean
}

/**
 * Returns an Express middleware that monkey-patches `res.json` to run
 * the sanitizer on every payload before serializing.
 */
export function sanitizeResponseMiddleware(
  options: SanitizeMiddlewareOptions = {},
) {
  const { skip, ...sanitizeOptions } = options

  return function sanitizeResponse(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (skip && skip(req)) {
      next()
      return
    }

    const originalJson = res.json.bind(res)

    res.json = function patchedJson(body?: unknown): Response {
      const cleaned = sanitizeForResponse(body, sanitizeOptions)
      return originalJson(cleaned)
    }

    next()
  }
}
