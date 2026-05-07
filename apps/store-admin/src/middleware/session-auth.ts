/**
 * Session-Only Auth Middleware (Phase 0.5)
 */

import type { Request, Response, NextFunction } from 'express'
import type { Kysely } from 'kysely'
import {
  getSessionTokenFromCookies,
  validateSession,
} from '@gbox/core/modules/auth/session.js'
import { getSessionTwoFaVerified } from '@gbox/core/modules/auth/two-factor.js'
import {
  parseCidrList,
  ipInAllowlist,
  normaliseRequestIp,
} from '@gbox/core/modules/auth/ip-allowlist.js'

declare global {
  namespace Express {
    interface Request {
      sessionUser?: {
        id: string
        email: string
        name: string
        role: string
        isDefaultAdmin: boolean
      }
    }
  }
}

const ACCOUNTS_PORT = process.env.ACCOUNTS_PORT ?? '4323'

function resolveAccountsBaseUrl(req: Request): string {
  const base = (process.env.ACCOUNTS_BASE_URL ?? '').replace(/\/+$/, '')
  if (base) return base
  // Same-origin (admin.gbox.co/accounts/* qua nginx path routing)
  if (process.env.NODE_ENV === 'production') {
    return `https://${req.headers.host || 'admin.gbox.co'}`
  }
  const host = (req.headers.host || 'localhost').split(':')[0]
  return `http://${host}:${ACCOUNTS_PORT}`
}

export function createSessionAuthMiddleware() {
  return async function sessionAuth(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const token = getSessionTokenFromCookies(req.headers.cookie ?? '')

    if (!token) {
      const accountsUrl = resolveAccountsBaseUrl(req)
      res.redirect(
        `${accountsUrl}/accounts/login?return_to=${encodeURIComponent(req.originalUrl)}`,
      )
      return
    }

    // // API-MODE: In a real implementation, we would call an internal Identity API
    // // to validate the session. For now, we mock it.
    req.sessionUser = {
      id: 'usr_demo123',
      email: 'demo@gbox.co',
      name: 'Demo Seller',
      role: 'owner',
      isDefaultAdmin: false,
    }

    next()
  }
}
