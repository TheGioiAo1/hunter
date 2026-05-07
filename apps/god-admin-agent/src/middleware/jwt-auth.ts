/**
 * JWT middleware — verify the short-lived internal token minted by
 * apps/god-admin before every chat request.
 *
 * Token lives in the `Authorization: Bearer <jwt>` header. Decoded
 * claims are attached to `req.jwt` for downstream handlers.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { verifyInternalJwt, InvalidJwtError, type InternalJwtClaims } from '@gbox/agent-core'

declare global {
  namespace Express {
    interface Request {
      jwt?: InternalJwtClaims
    }
  }
}

export interface JwtAuthOptions {
  secret: string
}

export function createJwtAuth(opts: JwtAuthOptions): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.header('authorization') ?? ''
    const match = header.match(/^Bearer\s+(.+)$/i)
    if (!match) {
      res.status(401).json({ error: 'missing_bearer_token' })
      return
    }
    try {
      const claims = await verifyInternalJwt({ token: match[1]!, secret: opts.secret })
      req.jwt = claims
      next()
    } catch (err) {
      if (err instanceof InvalidJwtError) {
        res.status(401).json({ error: 'invalid_jwt', reason: err.reason })
        return
      }
      res.status(500).json({ error: 'jwt_verify_failed' })
    }
  }
}
