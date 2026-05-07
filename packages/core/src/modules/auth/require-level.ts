/**
 * Gbox Platform — requireLevel Express Middleware (Mongo edition)
 *
 * Thin Express wrapper around `hasAtLeastLevel` + session validation.
 * The single middleware every admin route should use to gate on
 * CLAUDE.md Rule 2's 6-level hierarchy.
 *
 * Backed by `Gbox-Users.users` (is_default_admin), `Gbox-Shops.shops`
 * (slug → shop), and `Gbox-Users.user_shops` (per-shop role).
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express'

import { getMongoDb } from '../db/mongo.js'
import type { ShopDoc, UserDoc, UserShopDoc } from '../db/types.js'
import {
  AdminLevel,
  describeAdminLevel,
  hasAtLeastLevel,
  resolveAdminLevel,
} from './admin-levels.js'
import {
  getSessionTokenFromCookies,
  validateSession,
  type SessionData,
  type SessionUser,
} from './session.js'

// ---------------------------------------------------------------------------
// Request augmentation
// ---------------------------------------------------------------------------

export interface RequireLevelShop {
  id: string
  name: string
  slug: string
  domain: string | null
  status: string
}

export interface RequireLevelContext {
  user: SessionUser
  session: SessionData
  isDefaultAdmin: boolean
  shopRole: string | null
  shop: RequireLevelShop | null
  level: AdminLevel
  levelLabel: string
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: RequireLevelContext
    }
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RequireLevelOptions {
  minimum: AdminLevel
  shopSlugParam?: string
  onUnauthenticated?: (req: Request, res: Response) => void | Promise<void>
  onForbidden?: (
    req: Request,
    res: Response,
    ctx: { required: AdminLevel; actual: AdminLevel; actualLabel: string },
  ) => void | Promise<void>
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function defaultOnUnauthenticated(req: Request, res: Response): void {
  const returnTo = encodeURIComponent(req.originalUrl || req.url || '/')
  res.redirect(`/accounts/login?return_to=${returnTo}`)
}

function defaultOnForbidden(
  _req: Request,
  res: Response,
  ctx: { required: AdminLevel; actual: AdminLevel; actualLabel: string },
): void {
  res
    .status(403)
    .type('text/plain')
    .send(
      `Access denied — this page requires at least "${describeAdminLevel({
        userRole: null,
        isDefaultAdmin: ctx.required === AdminLevel.GOD_ADMIN,
      })}" (level ${ctx.required}); your effective level is "${
        ctx.actualLabel
      }" (level ${ctx.actual}).`,
    )
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function requireLevel(
  _db: unknown,
  options: RequireLevelOptions,
): RequestHandler {
  const onUnauthenticated = options.onUnauthenticated ?? defaultOnUnauthenticated
  const onForbidden = options.onForbidden ?? defaultOnForbidden

  return async function requireLevelMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const cookieHeader = req.headers.cookie ?? ''
    const token = getSessionTokenFromCookies(cookieHeader)
    if (!token) {
      await onUnauthenticated(req, res)
      return
    }

    const result = await validateSession(_db, token)
    if (!result.valid || !result.session) {
      await onUnauthenticated(req, res)
      return
    }
    const user = result.session.user

    const usersDb = await getMongoDb('USERS')
    const userRow = await usersDb
      .collection<UserDoc>('users')
      .findOne({ _id: user.id }, { projection: { is_default_admin: 1 } })
    const isDefaultAdmin = userRow?.is_default_admin === true

    let shop: RequireLevelShop | null = null
    let shopRole: string | null = null

    if (options.shopSlugParam) {
      const slug = req.params?.[options.shopSlugParam]
      if (slug && typeof slug === 'string' && slug.length > 0) {
        const shopsDb = await getMongoDb('SHOPS')
        const shopRow = await shopsDb
          .collection<ShopDoc>('shops')
          .findOne({ slug })
        if (!shopRow) {
          res.status(404).type('text/plain').send(`Shop "${slug}" not found.`)
          return
        }
        shop = {
          id: shopRow._id,
          name: shopRow.name,
          slug: shopRow.slug,
          domain: shopRow.domain,
          status: shopRow.status,
        }

        const membership = await usersDb
          .collection<UserShopDoc>('user_shops')
          .findOne({ user_id: user.id, shop_id: shop.id }, { projection: { role: 1 } })
        shopRole = membership?.role ?? null
      }
    }

    const input = { userRole: user.role, isDefaultAdmin, shopRole }
    const actual = resolveAdminLevel(input)

    if (!hasAtLeastLevel(input, options.minimum)) {
      await onForbidden(req, res, {
        required: options.minimum,
        actual,
        actualLabel: describeAdminLevel(input),
      })
      return
    }

    req.auth = {
      user,
      session: result.session,
      isDefaultAdmin,
      shopRole,
      shop,
      level: actual,
      levelLabel: describeAdminLevel(input),
    }

    next()
  }
}
