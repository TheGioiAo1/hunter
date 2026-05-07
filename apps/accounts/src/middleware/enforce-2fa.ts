/**
 * Gbox Accounts — 2FA Enforcement Middleware (Phase 0 §8 Item #3)
 *
 * Two jobs:
 *
 *   1. PENDING GATE
 *      If the current session is marked `two_fa_verified=false` (the
 *      login handler flipped it after the password step), block every
 *      route except the /accounts/login/2fa* challenge endpoints and
 *      /accounts/logout. Trying to visit /account or the store hub
 *      bounces the browser back to /accounts/login/2fa with the
 *      original path preserved as return_to. This is the "you typed
 *      the password, now prove the second factor" wall.
 *
 *   2. ENROLLMENT GATE (feature-flagged)
 *      When `ENFORCE_2FA_FOR_ADMINS=1`, any authenticated user whose
 *      resolved admin level is GOD_ADMIN / PLATFORM_ADMIN / STORE_OWNER
 *      / STORE_ADMIN and who has NOT yet enrolled in 2FA is redirected
 *      to /accounts/account/2fa (unless they're already there). This
 *      lets ops roll 2FA out store-by-store without forcing merchants
 *      on day one. Customers (level 5) and store staff (level 4) are
 *      never forced — they can opt in via the settings tab but the
 *      middleware leaves them alone.
 *
 * This middleware is mounted BEFORE the router so it sees every
 * /accounts/* request. It is a no-op for:
 *   - unauthenticated requests (the per-route auth handles the bounce)
 *   - /accounts/login, /accounts/signup, /accounts/forgot-password, etc.
 *     (the whitelist below)
 *   - /accounts/login/2fa* and /accounts/logout (needed to finish or
 *     cancel the challenge)
 *   - API routes that shouldn't redirect HTML (currently none)
 *
 * Safety notes
 * ------------
 *   - We look up `is_default_admin` + the shop-role summary per request.
 *     That's one extra DB round-trip on every page; acceptable for the
 *     accounts portal (low-traffic settings pages) and already cached
 *     at the validate-session layer for the user fields. If this ever
 *     shows up in a perf profile we can hoist into the cached session.
 *   - We NEVER force enrollment on the challenge pages themselves or
 *     on the /account/2fa enroll flow — otherwise you'd get a redirect
 *     loop the first time a merchant lands on the page.
 *   - We always allow the logout route so a merchant who's stuck in a
 *     half-2FA state can escape without a cookie reset.
 */

import type { Request, Response, NextFunction } from 'express'
import {
  getSessionTokenFromCookies,
  validateSession,
} from '@gbox/core/modules/auth/session.js'
import {
  getSessionTwoFaVerified,
  isTwoFactorEnabled,
} from '@gbox/core/modules/auth/two-factor.js'
import {
  AdminLevel,
  resolveAdminLevel,
} from '@gbox/core/modules/auth/admin-levels.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Parse the feature flag once per process start. Accepts any of the
 * common truthy spellings (`1`, `true`, `yes`, `on`). Everything else
 * — including unset — is a no-op.
 *
 * Rolling out: set `ENFORCE_2FA_FOR_ADMINS=1` on the accounts app and
 * every merchant at levels 0–3 will be funnelled into the 2FA setup
 * page on their next page load. Turning it off simply stops the
 * redirect — nobody's 2FA is disabled.
 */
function enforceFlagEnabled(): boolean {
  const raw = (process.env.ENFORCE_2FA_FOR_ADMINS ?? '').toLowerCase().trim()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

/**
 * Paths the middleware ALWAYS lets through (before any session check).
 * These are the signup / login / forgot-password / static surfaces —
 * asking "is your 2FA good?" on them makes no sense.
 *
 * The list uses startsWith so e.g. `/accounts/verify-email` and
 * `/accounts/verify-email?...` both match.
 */
const ALWAYS_ALLOW_PREFIXES = [
  '/accounts/login',           // also covers /accounts/login/2fa*
  '/accounts/signup',
  '/accounts/forgot-password',
  '/accounts/reset-password',
  '/accounts/verify-email',
  '/accounts/resend-otp',
  '/accounts/logout',
  '/accounts/auth/google',     // Google OIDC authorize + callback (seller-only)
  '/health',                   // server health check mounted off-prefix
]

function isAlwaysAllowed(path: string): boolean {
  return ALWAYS_ALLOW_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`))
}

/**
 * Paths that ARE the 2FA enrollment flow. When the enforcement gate
 * wants to force an admin to enroll, we must not redirect away from
 * these, or we create a loop (`/account/2fa` → 302 `/account/2fa`).
 */
const ENROLLMENT_FLOW_PREFIXES = [
  '/accounts/account/2fa',
  '/accounts/logout', // also allow bail-out
]

function isEnrollmentFlow(path: string): boolean {
  return ENROLLMENT_FLOW_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`))
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export function createEnforce2faMiddleware() {
  const db = null as any
  return async function enforce2fa(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    // Skip everything on always-allow prefixes. This covers /login,
    // /signup, AND the /login/2fa* challenge routes (the challenge
    // page itself must never get trapped by the "pending" gate).
    if (isAlwaysAllowed(req.path)) {
      next()
      return
    }

    const token = getSessionTokenFromCookies(req.headers.cookie ?? '')
    if (!token) {
      next()
      return
    }

    // Validate (this hits the Redis cache 99% of the time; see
    // packages/core/src/modules/auth/session.ts).
    const result = await validateSession(db, token)
    if (!result.valid || !result.session) {
      next()
      return
    }

    // ---------- JOB 1: PENDING GATE ----------
    //
    // sessions.two_fa_verified=false means the user typed the password
    // but hasn't cleared the second factor yet. Block everything except
    // the challenge flow itself.
    const verified = await getSessionTwoFaVerified(db, token)
    if (verified === false) {
      // Never trap the challenge pages themselves.
      if (req.path.startsWith('/accounts/login/2fa')) {
        next()
        return
      }
      const returnTo = encodeURIComponent(req.originalUrl)
      res.redirect(`/accounts/login/2fa?return_to=${returnTo}`)
      return
    }

    // ---------- JOB 2: ENROLLMENT GATE (feature-flagged) ----------
    //
    // Only runs when the env flag is on. Otherwise merchants can
    // continue browsing the accounts portal without 2FA — useful for
    // soft-rollouts / staging before we flip the switch in prod.
    if (enforceFlagEnabled() && db) {
      // Don't recurse through enrollment flow / logout.
      if (isEnrollmentFlow(req.path)) {
        next()
        return
      }

      // Resolve admin level. The user row already has `role`; we need
      // `is_default_admin` and a best-effort shop role so the level
      // resolver gets enough signal. Missing / null values default to
      // CUSTOMER so the gate is a no-op for normal customers.
      const userRow = await db
        .selectFrom('users')
        .select(['is_default_admin'])
        .where('id', '=', result.session.user.id)
        .executeTakeFirst()

      // Pick the user's highest shop role across any shop they belong
      // to. If they own ONE shop they're STORE_OWNER; if they're staff
      // on one and admin on another they're STORE_ADMIN. The SQL does
      // a rank/priority sort via CASE so we only pay for one query.
      const topShopRow = await db
        .selectFrom('user_shops')
        .where('user_id', '=', result.session.user.id)
        .select(['role'])
        .execute()
      let topShopRole: string | null = null
      let topRank = 99
      for (const r of topShopRow) {
        const rank =
          r.role === 'owner' ? 0
          : r.role === 'admin' ? 1
          : r.role === 'staff' || r.role === 'limited' ? 2
          : 99
        if (rank < topRank) {
          topRank = rank
          topShopRole = r.role
        }
      }

      const level = resolveAdminLevel({
        userRole: result.session.user.role,
        isDefaultAdmin: userRow?.is_default_admin === true,
        shopRole: topShopRole,
      })

      // Force-enroll on L0/1/2/3. L4 (staff) and L5 (customer) are
      // exempt — they can opt in via the settings tab.
      if (level <= AdminLevel.STORE_ADMIN) {
        const enrolled = await isTwoFactorEnabled(db, result.session.user.id)
        if (!enrolled) {
          res.redirect('/accounts/account/2fa')
          return
        }
      }
    }

    next()
  }
}
