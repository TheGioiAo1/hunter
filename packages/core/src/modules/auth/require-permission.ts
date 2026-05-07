/**
 * Gbox Platform — requirePermission Express Middleware (Phase 7.2)
 *
 * Companion to `requireLevel()` from `./require-level.ts`. Where
 * `requireLevel` enforces a baseline tier for an entire route group
 * ("you must be at least a Store Staff to access /admin/:slug"),
 * this middleware enforces a SPECIFIC action permission inside a
 * sub-route ("you must be able to do shop.invite_staff to POST to
 * /admin/:slug/staff/invite").
 *
 * Mount it AFTER `requireLevel` — it expects `req.auth` to already
 * be populated:
 *
 *   app.use('/admin/:slug', requireLevel(db, {
 *     minimum: AdminLevel.STORE_STAFF,
 *     shopSlugParam: 'slug',
 *   }))
 *
 *   app.post(
 *     '/admin/:slug/staff/invite',
 *     requirePermission('shop.invite_staff'),
 *     handleInvite,
 *   )
 *
 * The split exists because most routes don't need a per-action
 * check — the route-group baseline is enough. Wrapping every single
 * route in `requirePermission()` would be overkill and would push
 * permission knowledge into hundreds of files. The catalog stays in
 * `permissions.ts` and only the routes that need the extra gate
 * import this middleware.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express'

import { canPerform, type Permission } from './permissions.js'
import { describeAdminLevel } from './admin-levels.js'

export interface RequirePermissionOptions {
  /**
   * Optional handler called when the permission check fails. Defaults
   * to a 403 with a JSON body. Apps that render HTML pages should
   * supply their own renderer.
   */
  onForbidden?: (
    req: Request,
    res: Response,
    ctx: { permission: Permission; actualLabel: string },
  ) => void | Promise<void>
}

function defaultOnForbidden(
  _req: Request,
  res: Response,
  ctx: { permission: Permission; actualLabel: string },
): void {
  res.status(403).json({
    error: 'forbidden',
    message: `Your role ("${ctx.actualLabel}") does not allow "${ctx.permission}".`,
    permission: ctx.permission,
  })
}

/**
 * Returns a middleware that 403s the request unless `req.auth` (from
 * `requireLevel`) satisfies the given permission.
 *
 * Throws synchronously at wire-up if `permission` isn't in the
 * catalog — that way typos crash at boot, not at request time.
 */
export function requirePermission(
  permission: Permission,
  options: RequirePermissionOptions = {},
): RequestHandler {
  // Validate the permission name once, at module load. The throw
  // here surfaces in PM2 logs immediately if someone passes a
  // misspelled string.
  if (!permission || typeof permission !== 'string') {
    throw new Error(`requirePermission: permission name is required`)
  }

  const onForbidden = options.onForbidden ?? defaultOnForbidden

  return async function requirePermissionMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const auth = req.auth
    if (!auth) {
      // requireLevel didn't run (or failed silently). Refuse.
      // Returning 401 here rather than 403 because "no session"
      // and "wrong session" are different on-call signals.
      res.status(401).json({ error: 'unauthenticated' })
      return
    }

    const ctxInput = {
      isDefaultAdmin: auth.isDefaultAdmin,
      userRole: auth.user.role,
      shopRole: auth.shopRole,
    }

    if (!canPerform(ctxInput, permission)) {
      await onForbidden(req, res, {
        permission,
        actualLabel: describeAdminLevel(ctxInput),
      })
      return
    }

    next()
  }
}
