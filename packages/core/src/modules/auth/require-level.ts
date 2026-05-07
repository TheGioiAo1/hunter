/**
 * Gbox Platform — requireLevel Express Middleware (Phase 0 Step 0.8)
 *
 * Thin Express wrapper around `hasAtLeastLevel` + session validation.
 * This is the ONE middleware every admin route (god-admin, store-admin,
 * accounts, api) should use to gate on CLAUDE.md Rule 2's 6-level
 * hierarchy. Before this existed each app rolled its own copy of
 * "validate session → fetch is_default_admin → compare role", which is
 * exactly how the God Admin privilege-escalation bug (Phase 0 Step 0.2)
 * slipped in.
 *
 * Design rules:
 *   - Framework-agnostic Express types only (no app-specific imports).
 *   - Pure function style: factory → middleware. No module state.
 *   - The gate is `resolveAdminLevel()` from ./admin-levels.js — single
 *     source of truth.
 *   - Shop context is resolved lazily: if you pass `shopSlugParam` and
 *     the route has that param, the middleware will load the shop and
 *     user_shops row and factor shopRole into the level calculation.
 *   - `req.auth` is the ONLY property we attach. We do NOT poke at
 *     `req.store`/`req.storeUser`/`req.godAdmin` — those are legacy
 *     names the per-app middleware will keep until the migration is
 *     complete.
 *
 * Usage:
 *
 *   // Route-level: any staff tier or above
 *   app.use('/admin', requireLevel(db, { minimum: AdminLevel.STORE_STAFF }))
 *
 *   // Shop-scoped: load shop from :slug and require at least Store Admin
 *   app.use(
 *     '/admin/:slug',
 *     requireLevel(db, {
 *       minimum: AdminLevel.STORE_ADMIN,
 *       shopSlugParam: 'slug',
 *     }),
 *   )
 *
 *   // God Admin only
 *   app.use('/god-admin', requireLevel(db, { minimum: AdminLevel.GOD_ADMIN }))
 *
 * Then inside the route handler:
 *
 *   app.get('/admin/:slug/orders', (req, res) => {
 *     const level = req.auth!.level          // AdminLevel enum
 *     const user  = req.auth!.user           // SessionUser
 *     const shop  = req.auth!.shop           // { id, name, slug, ... } | null
 *     ...
 *   })
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express'
import type { Kysely } from 'kysely'

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

/**
 * Shop row shape resolved by `requireLevel` when `shopSlugParam` is set.
 * Kept intentionally minimal — routes that need more columns should
 * re-query by id. This is a *gating* primitive, not a data loader.
 */
export interface RequireLevelShop {
  id: string
  name: string
  slug: string
  domain: string | null
  status: string
}

/**
 * Context attached to `req.auth` after the middleware succeeds.
 */
export interface RequireLevelContext {
  user: SessionUser
  session: SessionData
  /** True only for the seeded Default God Admin (level 0). */
  isDefaultAdmin: boolean
  /** Resolved per-shop role or null when no shop context. */
  shopRole: string | null
  /** Shop row if `shopSlugParam` resolved one, otherwise null. */
  shop: RequireLevelShop | null
  /** Effective admin level after combining platform + shop axes. */
  level: AdminLevel
  /** Human label — "God Admin", "Store Staff", etc. */
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
  /**
   * Minimum admin level the user must satisfy. Smaller number = more
   * privilege (see AdminLevel enum).
   *
   * Example: `AdminLevel.STORE_STAFF` permits Store Staff and every
   * tier above it (Store Admin → God Admin).
   */
  minimum: AdminLevel
  /**
   * Name of the route param that contains a shop slug (e.g. 'slug' for
   * `/admin/:slug/orders`). When set:
   *   1. The middleware looks up the shop by slug.
   *   2. It reads the caller's `user_shops.role` for that shop.
   *   3. Both are fed into `resolveAdminLevel({userRole, isDefaultAdmin, shopRole})`.
   *
   * When unset, only platform-level checks run (God Admin / Platform
   * Admin). That's fine for global dashboards like /god-admin.
   */
  shopSlugParam?: string
  /**
   * Called when there is no valid session. Defaults to redirecting to
   * `/accounts/login?return_to=<originalUrl>`. Apps that want a JSON
   * 401 (e.g. platform API) should supply their own handler.
   */
  onUnauthenticated?: (req: Request, res: Response) => void | Promise<void>
  /**
   * Called when the session is valid but the level is insufficient.
   * Defaults to a 403 with a plain text body.
   */
  onForbidden?: (
    req: Request,
    res: Response,
    ctx: {
      required: AdminLevel
      actual: AdminLevel
      actualLabel: string
    },
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
      `Access denied — this page requires at least "${
        describeAdminLevel({
          userRole: null,
          isDefaultAdmin: ctx.required === AdminLevel.GOD_ADMIN,
        })
      }" (level ${ctx.required}); your effective level is "${
        ctx.actualLabel
      }" (level ${ctx.actual}).`,
    )
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an Express middleware that enforces a minimum admin level.
 *
 * Why a factory and not a plain middleware? Because we need a Kysely
 * handle bound in at app-wire time — middlewares don't get a DI
 * container, so the factory closure is the cleanest shape.
 */
export function requireLevel(
  db: Kysely<any>,
  options: RequireLevelOptions,
): RequestHandler {
  const onUnauthenticated = options.onUnauthenticated ?? defaultOnUnauthenticated
  const onForbidden = options.onForbidden ?? defaultOnForbidden

  return async function requireLevelMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    // ── Step 1: extract + validate session ──────────────────────────
    const cookieHeader = req.headers.cookie ?? ''
    const token = getSessionTokenFromCookies(cookieHeader)

    if (!token) {
      await onUnauthenticated(req, res)
      return
    }

    const result = await validateSession(db, token)
    if (!result.valid || !result.session) {
      await onUnauthenticated(req, res)
      return
    }

    const user = result.session.user

    // ── Step 2: fetch is_default_admin ──────────────────────────────
    // We intentionally bypass any cache here — is_default_admin is the
    // hottest privilege flag in the system, and a stale true would be
    // catastrophic (full God Admin access after demotion).
    const userRow = await db
      .selectFrom('users')
      .select(['is_default_admin'])
      .where('id', '=', user.id)
      .executeTakeFirst()

    const isDefaultAdmin = userRow?.is_default_admin === true

    // ── Step 3: resolve shop context (optional) ─────────────────────
    let shop: RequireLevelShop | null = null
    let shopRole: string | null = null

    if (options.shopSlugParam) {
      const slug = req.params?.[options.shopSlugParam]
      if (slug && typeof slug === 'string' && slug.length > 0) {
        const shopRow = await db
          .selectFrom('shops')
          .select(['id', 'name', 'slug', 'domain', 'status'])
          .where('slug', '=', slug)
          .executeTakeFirst()

        if (!shopRow) {
          // Shop slug given but not found → 404. Don't leak session state.
          res.status(404).type('text/plain').send(`Shop "${slug}" not found.`)
          return
        }
        shop = shopRow as RequireLevelShop

        const membership = await db
          .selectFrom('user_shops')
          .select(['role'])
          .where('user_id', '=', user.id)
          .where('shop_id', '=', shop.id)
          .executeTakeFirst()

        shopRole = membership?.role ?? null
      }
    }

    // ── Step 4: gate ────────────────────────────────────────────────
    const input = {
      userRole: user.role,
      isDefaultAdmin,
      shopRole,
    }
    const actual = resolveAdminLevel(input)

    if (!hasAtLeastLevel(input, options.minimum)) {
      await onForbidden(req, res, {
        required: options.minimum,
        actual,
        actualLabel: describeAdminLevel(input),
      })
      return
    }

    // ── Step 5: attach context & continue ───────────────────────────
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
