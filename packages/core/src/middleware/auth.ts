/**
 * Gbox Platform — Auth Middleware (SP-04)
 *
 * Shared authentication middleware used by ALL Gbox services:
 * - accounts.gbox.co (account portal)
 * - admin.gbox.co (store admin)
 * - {slug}.gbox.co (storefront, customer auth)
 * - checkout.gbox.co (checkout flow)
 *
 * Reads the gbox_session cookie, validates it, and populates request context.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { Request, Response, NextFunction } from 'express'
import {
  getSessionTokenFromCookies,
  validateSession,
  validateSessionWithShop,
  type SessionData,
} from '../modules/auth/session.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthContext {
  /** The validated session data */
  session: SessionData
  /** Raw session token (for cookie refresh) */
  token: string
}

/**
 * Helper type for handlers that consume the legacy auth field. Note: the
 * canonical `req.auth` slot is owned by `require-level.ts` and holds a
 * richer `RequireLevelContext`. This older middleware writes its lighter
 * `{ session, token }` shape into `req.gboxLegacyAuth` to avoid the
 * collision. Both helpers below read from the same slot.
 */
export type AuthRequest = Request & {
  gboxLegacyAuth?: AuthContext
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Populated by `createAuthMiddleware` (legacy SP-04 path). */
    gboxLegacyAuth?: AuthContext
  }
}

export interface AuthMiddlewareOptions {
  /**
   * If true, requests without a valid session are rejected.
   * - For HTML pages: redirects to redirectUrl
   * - For API routes: returns 401 JSON
   * Default: true
   */
  requireAuth?: boolean

  /**
   * If true, the middleware will extract a shop slug from the URL
   * (expects /store/:slug pattern) and validate the user has access.
   * Sets session.shopId and session.shopRole.
   * Default: false
   */
  requireShop?: boolean

  /**
   * Where to redirect unauthenticated users (HTML pages).
   * Default: accounts.gbox.co/login (production) or /accounts/login (dev)
   */
  redirectUrl?: string

  /**
   * If true, returns JSON 401 instead of redirecting.
   * Use for API routes.
   * Default: false
   */
  jsonResponse?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function getDefaultRedirectUrl(): string {
  return isProduction()
    ? 'https://accounts.gbox.co/login'
    : '/accounts/login'
}

/**
 * Extract shop slug from URL path.
 * Supports patterns like /store/{slug} or /store/{slug}/anything
 */
function extractShopSlug(path: string): string | null {
  const match = path.match(/^\/store\/([a-z0-9][a-z0-9-]*)/)
  return match ? match[1] : null
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Create an Express middleware that validates the gbox_session cookie
 * and populates `req.auth` with session data.
 *
 * Usage:
 * ```ts
 * import { createAuthMiddleware } from '@gbox/core/middleware/auth.js'
 *
 * // Require auth for all routes
 * app.use(createAuthMiddleware(db, { requireAuth: true }))
 *
 * // Require auth + shop access for store admin routes
 * app.use('/store/:slug', createAuthMiddleware(db, {
 *   requireAuth: true,
 *   requireShop: true,
 * }))
 *
 * // Optional auth (storefront: logged-in users get personalized experience)
 * app.use(createAuthMiddleware(db, { requireAuth: false }))
 *
 * // API routes return JSON 401
 * app.use('/api', createAuthMiddleware(db, {
 *   requireAuth: true,
 *   jsonResponse: true,
 * }))
 * ```
 */
export function createAuthMiddleware(
  db: Kysely<Database>,
  options: AuthMiddlewareOptions = {},
) {
  const {
    requireAuth = true,
    requireShop = false,
    redirectUrl,
    jsonResponse = false,
  } = options

  return async function authMiddleware(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const token = getSessionTokenFromCookies(req.headers.cookie ?? '')

    // No token present
    if (!token) {
      if (requireAuth) {
        return denyAccess(res, redirectUrl, jsonResponse, req.originalUrl)
      }
      return next()
    }

    // Validate session
    if (requireShop) {
      // Extract shop slug from URL and look up shop ID
      const slug = extractShopSlug(req.path) ?? (req.params as any).slug
      if (!slug) {
        if (jsonResponse) {
          res.status(400).json({ error: 'Missing shop identifier in URL.' })
          return
        }
        return denyAccess(res, redirectUrl, jsonResponse, req.originalUrl)
      }

      // Look up shop by slug to get ID
      const shop = await db
        .selectFrom('shops')
        .select(['id', 'slug', 'status'])
        .where('slug', '=', slug)
        .executeTakeFirst()

      if (!shop || shop.status !== 'active') {
        if (jsonResponse) {
          res.status(404).json({ error: 'Shop not found.' })
          return
        }
        res.status(404).send('Shop not found')
        return
      }

      const result = await validateSessionWithShop(db, token, shop.id)
      if (!result.valid || !result.session) {
        return denyAccess(res, redirectUrl, jsonResponse, req.originalUrl)
      }

      req.gboxLegacyAuth = { session: result.session, token: result.token ?? token }
    } else {
      // Basic session validation (no shop context)
      const result = await validateSession(db, token)
      if (!result.valid || !result.session) {
        if (requireAuth) {
          return denyAccess(res, redirectUrl, jsonResponse, req.originalUrl)
        }
        return next()
      }

      req.gboxLegacyAuth = { session: result.session, token: result.token ?? token }
    }

    next()
  }
}

// ---------------------------------------------------------------------------
// Deny access helper
// ---------------------------------------------------------------------------

function denyAccess(
  res: Response,
  redirectUrl: string | undefined,
  jsonResponse: boolean,
  originalUrl: string,
): void {
  if (jsonResponse) {
    res.status(401).json({
      error: 'Authentication required.',
      code: 'UNAUTHORIZED',
    })
    return
  }

  const target = redirectUrl ?? getDefaultRedirectUrl()
  // Append return_to parameter so user can be redirected back after login
  const separator = target.includes('?') ? '&' : '?'
  res.redirect(`${target}${separator}return_to=${encodeURIComponent(originalUrl)}`)
}

// ---------------------------------------------------------------------------
// Convenience: extract auth from request (type-safe)
// ---------------------------------------------------------------------------

/**
 * Get the auth context from a request that has been through the auth middleware.
 * Throws if auth is not present (use after requireAuth middleware).
 */
export function getAuth(req: AuthRequest): AuthContext {
  if (!req.gboxLegacyAuth) {
    throw new Error(
      'Auth context not found on request. Ensure createAuthMiddleware({ requireAuth: true }) is applied.',
    )
  }
  return req.gboxLegacyAuth
}

/**
 * Get the auth context if present, or null if not authenticated.
 * Use after optional auth middleware.
 */
export function getOptionalAuth(req: AuthRequest): AuthContext | null {
  return req.gboxLegacyAuth ?? null
}
