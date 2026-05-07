/**
 * Gbox Platform — Customer auth middleware
 *
 * Reads the `gbox_customer_session` cookie, looks up the session, and
 * attaches `req.customerId` + `req.customerShopId` if valid. Auth is
 * OPT-IN: missing/invalid cookies do not block the request — handlers
 * decide whether to require auth (e.g. /api/store/:slug/account/* gates
 * on `req.customerId`, while /api/store/:slug/products is public).
 *
 * IMPORTANT: this middleware NEVER consults the merchant `users` /
 * `sessions` tables. A customer cookie cannot authenticate a merchant
 * and vice versa. The cookie names are also distinct
 * (`gbox_customer_session` vs `gbox_session`).
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { CUSTOMER_COOKIE_NAME, getSessionByToken } from './service.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      customerId?: string
      customerShopId?: string
    }
  }
}

interface CustomerAuthOptions {
  db: Kysely<Database>
  /**
   * If true, requests without a valid customer session get rejected with 401.
   * Defaults to false (opt-in mode).
   */
  required?: boolean
}

function extractCookie(req: Request, name: string): string | undefined {
  // Express may already have parsed cookies via cookie-parser.
  const parsed = (req as any).cookies?.[name]
  if (parsed) return parsed

  // Fallback: parse the Cookie header ourselves.
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const k = part.slice(0, eq).trim()
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

export function customerAuth(opts: CustomerAuthOptions): RequestHandler {
  const { db, required = false } = opts

  return async function customerAuthMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const token = extractCookie(req, CUSTOMER_COOKIE_NAME)

    if (!token) {
      if (required) {
        return res.status(401).json({
          error: 'unauthorized',
          message: 'Customer login required',
        })
      }
      return next()
    }

    try {
      const session = await getSessionByToken(db, token)
      if (session) {
        req.customerId = session.customer_id
        req.customerShopId = session.shop_id
      } else if (required) {
        return res.status(401).json({
          error: 'session_expired',
          message: 'Your session has expired. Please log in again.',
        })
      }
    } catch (err) {
      console.error('[customer-auth] middleware error:', (err as Error).message)
      if (required) {
        return res.status(500).json({
          error: 'auth_error',
          message: 'Failed to validate session',
        })
      }
    }

    return next()
  }
}

/**
 * Cookie attributes for the customer session.
 *
 * Returns the value to pass to `res.cookie(name, value, opts)`.
 *   - HttpOnly so JS can't read it (mitigates XSS exfil).
 *   - SameSite=Lax so cross-site forms still work but CSRF is bounded.
 *   - Secure in production (NODE_ENV=production).
 *   - Path=/ so every storefront route sees it.
 *   - Domain (optional, Decision #2 / Step 2.3) is set to `.gbox.co` when
 *     the request is served from a Gbox-owned subdomain so the same
 *     session cookie is visible across `accounts.gbox.co`,
 *     `<shop>.gbox.co`, and `checkout.gbox.co`. For custom-domain
 *     storefronts the option must NOT be set — the host-only default
 *     keeps the cookie scoped to the merchant's eTLD+1, and the cross
 *     to checkout.gbox.co goes through a one-shot handoff token instead
 *     (see `packages/core/src/modules/checkout/handoff.ts`).
 *
 * The `domain` value is read from the `CUSTOMER_COOKIE_DOMAIN` env var
 * by default. Callers that already know which mode they're running in
 * (e.g. `apps/checkout/server.ts` always wants `.gbox.co`) can override
 * by passing `{ domain: '.gbox.co' }` explicitly.
 */
export interface CustomerCookieOptions {
  /**
   * Override the cookie Domain attribute. Pass `'.gbox.co'` to make the
   * cookie visible to every Gbox subdomain. Pass `undefined` (or omit)
   * to fall back to `CUSTOMER_COOKIE_DOMAIN` env var, then to host-only.
   *
   * IMPORTANT: only set this when serving from a domain that you OWN at
   * eTLD+1. Setting `Domain=.gbox.co` from `evil.example.com` would be
   * silently dropped by browsers, but setting `Domain=.acme.com` from
   * `shop.acme.com` is valid and would broaden the cookie's scope —
   * which is almost never what you want for a multi-tenant platform.
   */
  domain?: string
}

export function buildCustomerCookieOptions(
  expiresAt: Date,
  opts: CustomerCookieOptions = {},
) {
  const explicitDomain = opts.domain
  const envDomain =
    explicitDomain === undefined ? process.env.CUSTOMER_COOKIE_DOMAIN : undefined
  const domain = explicitDomain ?? envDomain

  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    expires: expiresAt,
    ...(domain ? { domain } : {}),
  }
}
