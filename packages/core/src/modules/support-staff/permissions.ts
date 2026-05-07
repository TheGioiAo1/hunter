/**
 * Gbox Platform — Support staff permission checks.
 *
 * Single entry point `hasPermission(preset, scope)` backed by the
 * locked matrix in `presets.ts`. Also exports a thin Express
 * middleware factory `requireSupportPermission(scope, logDeny)` that
 * wraps the check with an audit-log row on deny.
 *
 * Design notes:
 *
 *  - The middleware is lazy about the audit layer — it takes a
 *    `logDeny` callback, NOT a `Kysely` instance. That lets the test
 *    suite pin the deny path without a real DB, and lets the app
 *    wire in its own `logStaffAction` implementation. Keeps this
 *    module DB-free.
 *
 *  - Deny responses are intentionally generic (403 + "Forbidden").
 *    We do NOT leak the scope name to the client — Iron Rule 5.
 *    The scope is logged server-side via `logDeny` so ops can see
 *    what triggered, but the HTTP body stays opaque.
 *
 *  - A second middleware `requireAnyPermission` handles routes that
 *    accept either of two scopes (e.g. the ticket detail view is
 *    readable by any preset, but the internal-note section requires
 *    a stricter scope — a route can `requireSupportPermission(...)`
 *    twice for different path segments, or pass an OR-list).
 */

import type { SupportAgentPreset } from '@gbox/db/schema/tables.js'
import {
  PERMISSION_MATRIX,
  type SupportPermissionScope,
} from './presets.ts'

/**
 * `true` iff the given preset is allowed to take an action gated on
 * `scope`. The matrix is a compile-time constant — no DB hit.
 *
 * Unknown presets (not in the catalog) always return `false`. This
 * is the fail-closed default for a JWT / session token that has a
 * malformed preset claim.
 */
export function hasPermission(
  preset: SupportAgentPreset | string | null | undefined,
  scope: SupportPermissionScope,
): boolean {
  if (!preset) return false
  const row = PERMISSION_MATRIX[preset as SupportAgentPreset]
  if (!row) return false
  return row[scope] === true
}

/**
 * `true` iff the preset has **any** of the given scopes. Handy for
 * page-level gates that accept a family of related actions.
 */
export function hasAnyPermission(
  preset: SupportAgentPreset | string | null | undefined,
  scopes: readonly SupportPermissionScope[],
): boolean {
  return scopes.some((s) => hasPermission(preset, s))
}

/**
 * Contract for the staff-user shape we attach to `req` in the
 * supporter.gbox.co auth middleware. Kept local so this module
 * doesn't depend on Express types.
 */
export interface StaffRequestUser {
  userId: string
  preset: SupportAgentPreset
  displayName: string
}

/**
 * Callback signature for writing a deny row to `support_audit_log`.
 * The auth middleware injects its own implementation (usually
 * `logStaffAction` from `./audit-log.ts` bound to a Kysely instance).
 */
export type DenyLogger = (event: {
  actorUserId: string | null
  actorPreset: string | null
  scope: SupportPermissionScope
  path: string
  method: string
  ip?: string | null
  userAgent?: string | null
}) => void | Promise<void>

export interface MinimalExpressReq {
  path: string
  method: string
  ip?: string
  headers: { [k: string]: string | string[] | undefined }
  staffUser?: StaffRequestUser | null
}

export interface MinimalExpressRes {
  status: (code: number) => MinimalExpressRes
  type: (mime: string) => MinimalExpressRes
  send: (body: string) => void
}

/**
 * Express-compatible middleware factory. Returns a handler that:
 *   1. Reads `req.staffUser` (set upstream by the session/auth
 *      middleware — see `apps/supporter/src/middleware/staff-auth.ts`).
 *   2. If missing → 401 with a generic body.
 *   3. If present but the preset fails the scope → 403 and fires
 *      `logDeny({ ... })` for the audit log.
 *   4. Otherwise calls `next()`.
 *
 * NEVER leaks the scope name or the preset to the client body.
 */
export function requireSupportPermission(
  scope: SupportPermissionScope,
  logDeny: DenyLogger,
) {
  return async function supportPermissionMiddleware(
    req: MinimalExpressReq,
    res: MinimalExpressRes,
    next: () => void,
  ): Promise<void> {
    const user = req.staffUser ?? null
    if (!user) {
      res.status(401).type('text/html').send('<p>Sign in required.</p>')
      return
    }
    if (!hasPermission(user.preset, scope)) {
      await Promise.resolve(
        logDeny({
          actorUserId: user.userId,
          actorPreset: user.preset,
          scope,
          path: req.path,
          method: req.method,
          ip: req.ip ?? null,
          userAgent: extractUa(req.headers['user-agent']),
        }),
      ).catch(() => {
        // Audit log is best-effort; never fail a deny because the
        // write failed. The logger impl should handle its own errors.
      })
      res.status(403).type('text/html').send('<p>Forbidden.</p>')
      return
    }
    next()
  }
}

function extractUa(raw: string | string[] | undefined): string | null {
  if (!raw) return null
  return Array.isArray(raw) ? (raw[0] ?? null) : raw
}

/**
 * Pure (no req/res) helper for server-side checks inside a handler
 * (e.g. a page that shows different UI for L1 vs L2 without returning
 * a 403). Use when the whole route ISN'T gated but a section of the
 * page needs a stricter check.
 */
export function canStaff(
  user: StaffRequestUser | null | undefined,
  scope: SupportPermissionScope,
): boolean {
  if (!user) return false
  return hasPermission(user.preset, scope)
}
