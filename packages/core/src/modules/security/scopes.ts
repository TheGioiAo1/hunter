/**
 * Security Module — API Token Scopes (Shopify scopes pattern)
 *
 * `api_tokens.scopes` is a JSON array of scope strings like
 * ['read_products', 'write_products', 'read_orders'].
 *
 * Apply as middleware on routes that mutate data:
 *
 *   app.post('/api/2026-04/products', requireScope('write_products'), handler)
 *
 * Resolution:
 *   - Expects `Authorization: Bearer <token>` on the request.
 *   - Loads api_tokens by SHA-256(token).
 *   - Checks the scope is in the token's scope array.
 *   - Populates `req.apiToken` for downstream auditing.
 *
 * Scope naming follows Shopify: `read_X` / `write_X` where `write_X`
 * implicitly grants `read_X`.
 */

import type { Request, Response, NextFunction } from 'express'
import crypto from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Database, ApiTokenTable } from '@gbox/db/schema/tables.js'

type Selectable<T> = {
  [K in keyof T]: T[K] extends import('kysely').ColumnType<infer S, any, any>
    ? S
    : T[K]
}

export type ApiToken = Selectable<ApiTokenTable>

declare module 'express-serve-static-core' {
  interface Request {
    apiToken?: ApiToken
  }
}

export type Scope =
  | 'read_products' | 'write_products'
  | 'read_orders' | 'write_orders'
  | 'read_customers' | 'write_customers'
  | 'read_inventory' | 'write_inventory'
  | 'read_discounts' | 'write_discounts'
  | 'read_shipping' | 'write_shipping'
  | 'read_content' | 'write_content'
  | 'read_themes' | 'write_themes'
  | 'read_webhooks' | 'write_webhooks'
  | 'read_metafields' | 'write_metafields'
  | 'read_analytics'
  | 'read_gift_cards' | 'write_gift_cards'
  | 'read_apps' | 'write_apps'

export interface ScopeOptions {
  db: Kysely<Database>
  /** If true, a missing token returns 401. Default: true */
  required?: boolean
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

function tokenFromRequest(req: Request): string | null {
  const h = req.headers['authorization']
  const val = Array.isArray(h) ? h[0] : h
  if (!val) return null
  if (!val.toLowerCase().startsWith('bearer ')) return null
  return val.slice(7).trim() || null
}

function hasScope(tokenScopes: string[] | null, required: Scope): boolean {
  if (!tokenScopes || tokenScopes.length === 0) return false
  // Exact match
  if (tokenScopes.includes(required)) return true
  // write_X implicitly grants read_X
  if (required.startsWith('read_')) {
    const writeVersion = 'write_' + required.slice(5)
    if (tokenScopes.includes(writeVersion)) return true
  }
  return false
}

/**
 * Middleware that requires the request's API token to have `scope`.
 * Returns 401 if no token, 403 if token exists but lacks the scope.
 */
export function requireScope(scope: Scope, opts: ScopeOptions) {
  const { db, required = true } = opts

  return async function requireScopeMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const raw = tokenFromRequest(req)
    if (!raw) {
      if (!required) return next()
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Missing Bearer token',
      })
    }

    const tokenHash = hashToken(raw)
    const row = (await db
      .selectFrom('api_tokens')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst()) as ApiToken | undefined

    if (!row) {
      return res.status(401).json({
        error: 'invalid_token',
        message: 'Bearer token not recognized',
      })
    }

    // scopes stored as JSONB string[] — Kysely returns as parsed array
    const scopes = (row.scopes as unknown as string[] | null) ?? []
    if (!hasScope(scopes, scope)) {
      return res.status(403).json({
        error: 'insufficient_scope',
        message: `This token lacks the required scope: ${scope}`,
        required_scope: scope,
      })
    }

    // Best-effort last_used_at touch — fire-and-forget to avoid blocking.
    void db
      .updateTable('api_tokens')
      .set({ last_used_at: new Date().toISOString() } as any)
      .where('id', '=', row.id)
      .execute()
      .catch(() => {})

    req.apiToken = row
    return next()
  }
}
