/**
 * Google OAuth (OIDC) — authorize + callback handlers for the accounts
 * portal.
 *
 * This is the seller-facing "Continue with Google" flow. God-admin
 * login deliberately does NOT offer this path (Iron Rule 5 +
 * Rule 1: admin hierarchy level 0/1 is password + 2FA only).
 *
 * Route layout:
 *   GET  /accounts/auth/google           — getOAuthGoogleStart
 *   GET  /accounts/auth/google/callback  — getOAuthGoogleCallback
 *
 * Flow:
 *   1. Seller clicks "Continue with Google" on /accounts/login (or
 *      /accounts/signup). Browser navigates to /accounts/auth/google.
 *   2. `getOAuthGoogleStart` generates a random `state` + `nonce`,
 *      stores them in Redis under `oauth:google:state:<state>` with
 *      TTL 600s, and 302s the browser to Google's consent screen.
 *   3. Google sends the user back to
 *      `/accounts/auth/google/callback?code=...&state=...`.
 *   4. `getOAuthGoogleCallback` looks up + deletes the Redis record,
 *      exchanges the code for tokens, verifies the id_token, upserts
 *      `users` + `oauth_accounts`, mints a normal `gbox_session`
 *      cookie, and bounces to the store picker.
 *
 * Graceful degradation:
 *   - When `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are unset in
 *     the environment, `getGoogleOAuthConfig()` returns null and we
 *     redirect back to `/accounts/login?error=google_unavailable`.
 *     This lets us ship the UI without the env vars provisioned.
 *   - Every Google / DB failure ends up on the login page with a
 *     specific `?error=google_…` code, never a 500.
 */

import type { Request, Response } from 'express'
import {
  getGoogleOAuthConfig,
  buildAuthorizeUrl,
  generateOAuthState,
  generateOAuthNonce,
  exchangeCode,
  verifyIdToken,
  GoogleOAuthError,
  type GoogleStateRecord,
} from '@gbox/core/modules/auth/google-oauth.js'
import { cacheGet, cacheSet, cacheDel } from '@gbox/core/modules/cache/redis.js'
import {
  createSession,
  getSessionCookieOptions,
  serializeSessionCookie,
} from '@gbox/core/modules/auth/session.js'
import {
  isTwoFactorEnabled,
  markSessionTwoFaPending,
} from '@gbox/core/modules/auth/two-factor.js'
import { logAuditEvent } from '@gbox/core/modules/auth/audit.js'

// ---------------------------------------------------------------------------
// Module-level database client. Core modules are already updated to handle
// null db for demo/mock mode. Handlers are updated to remove the db parameter.
// ---------------------------------------------------------------------------

const db = null as any

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_TTL_SEC = 600 // 10 minutes; Google consent screens timeout ~5m
const STATE_KEY_PREFIX = 'oauth:google:state:'
const LOGIN_PATH = '/accounts/login'
const DEFAULT_POST_LOGIN = '/accounts/stores'

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function accountsBaseUrl(req: Request): string {
  const envBase = process.env.ACCOUNTS_BASE_URL?.replace(/\/+$/, '')
  if (envBase) return envBase
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol
  const host = req.headers.host || 'localhost'
  return `${proto}://${host}`
}

function redirectToLoginWithError(res: Response, code: string): void {
  res.redirect(`${LOGIN_PATH}?error=google_${code}`)
}

/**
 * Only allow same-host relative paths as `return_to`. Anything else
 * (absolute URL, scheme-relative, path traversal) gets silently
 * replaced with the default landing page — no open-redirect surface.
 */
function safeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return ''
  if (!raw.startsWith('/') || raw.startsWith('//')) return ''
  if (/[\0\r\n]/.test(raw)) return ''
  return raw
}

// ---------------------------------------------------------------------------
// GET /accounts/auth/google
// ---------------------------------------------------------------------------

export async function getOAuthGoogleStart(
  req: Request,
  res: Response,
): Promise<void> {
  const cfg = getGoogleOAuthConfig(accountsBaseUrl(req))
  if (!cfg) {
    redirectToLoginWithError(res, 'unavailable')
    return
  }

  const state = generateOAuthState()
  const nonce = generateOAuthNonce()
  const returnTo = safeReturnTo(req.query.return_to)

  const record: GoogleStateRecord = {
    nonce,
    returnTo,
    createdAt: Date.now(),
  }
  await cacheSet(`${STATE_KEY_PREFIX}${state}`, record, STATE_TTL_SEC)

  res.redirect(buildAuthorizeUrl(cfg, state, nonce))
}

// ---------------------------------------------------------------------------
// GET /accounts/auth/google/callback
// ---------------------------------------------------------------------------

export async function getOAuthGoogleCallback(
  req: Request,
  res: Response,
): Promise<void> {
  const cfg = getGoogleOAuthConfig(accountsBaseUrl(req))
  if (!cfg) {
    redirectToLoginWithError(res, 'unavailable')
    return
  }

  const errParam = typeof req.query.error === 'string' ? req.query.error : ''
  if (errParam) {
    redirectToLoginWithError(res, 'cancelled')
    return
  }

  const code = typeof req.query.code === 'string' ? req.query.code : ''
  const state = typeof req.query.state === 'string' ? req.query.state : ''
  if (!code || !state) {
    redirectToLoginWithError(res, 'invalid')
    return
  }

  const stateKey = `${STATE_KEY_PREFIX}${state}`
  const stored = await cacheGet<GoogleStateRecord>(stateKey)
  if (!stored) {
    redirectToLoginWithError(res, 'expired')
    return
  }
  await cacheDel(stateKey)

  let claims
  try {
    const tokens = await exchangeCode(cfg, code)
    claims = await verifyIdToken(tokens.id_token, {
      audience: cfg.clientId,
      nonce: stored.nonce,
    })
  } catch (err) {
    const code = err instanceof GoogleOAuthError ? err.code : 'failed'
    console.warn('[oauth-google] verification failed:', code, (err as Error).message)
    redirectToLoginWithError(res, code)
    return
  }

  const emailLower = claims.email.toLowerCase().trim()
  const ip = req.ip ?? req.socket.remoteAddress ?? null
  const userAgent = req.headers['user-agent'] ?? null

  // Phase 14 Demo Mode — if db is null, just redirect to stores hub
  if (!db) {
    console.log('[oauth-google] Demo mode: redirecting to stores');
    res.redirect(stored.returnTo || DEFAULT_POST_LOGIN);
    return
  }

  let userId: string
  let createdNew = false
  try {
    userId = await db.transaction().execute(async (tx: any) => {
      const byProvider = await tx
        .selectFrom('oauth_accounts')
        .select(['user_id'])
        .where('provider', '=', 'google')
        .where('provider_user_id', '=', claims.sub)
        .executeTakeFirst()

      if (byProvider) return byProvider.user_id

      const byEmail = await tx
        .selectFrom('users')
        .select(['id', 'is_default_admin'])
        .where('email', '=', emailLower)
        .executeTakeFirst()

      let uid: string
      if (byEmail) {
        if (byEmail.is_default_admin === true) {
          throw new GoogleOAuthError(
            'admin_blocked',
            'This account is reserved. Please contact Gbox support.',
          )
        }
        uid = byEmail.id
      } else {
        const inserted = await tx
          .insertInto('users')
          .values({
            email: emailLower,
            name: claims.name || emailLower.split('@')[0],
            role: 'owner',
            status: 'active',
            avatar_url: claims.picture ?? null,
          })
          .returning(['id'])
          .executeTakeFirstOrThrow()
        uid = inserted.id
        createdNew = true
      }

      await tx
        .insertInto('oauth_accounts')
        .values({
          user_id: uid,
          provider: 'google',
          provider_user_id: claims.sub,
          access_token_ciphertext: null,
          access_token_iv: null,
          access_token_tag: null,
          refresh_token_ciphertext: null,
          refresh_token_iv: null,
          refresh_token_tag: null,
          expires_at: null,
        })
        .onConflict((oc: any) => oc.columns(['user_id', 'provider']).doNothing())
        .execute()

      return uid
    })
  } catch (err) {
    if (err instanceof GoogleOAuthError && err.code === 'admin_blocked') {
      redirectToLoginWithError(res, 'admin_blocked')
      return
    }
    console.error('[oauth-google] upsert failed:', (err as Error).message)
    redirectToLoginWithError(res, 'failed')
    return
  }

  const { token } = await createSession(db, userId, {
    ipAddress: ip ?? undefined,
    userAgent: userAgent ?? undefined,
  })
  const cookieOpts = getSessionCookieOptions(isProduction())
  res.setHeader('Set-Cookie', serializeSessionCookie(token, cookieOpts))

  const twoFaEnrolled = await isTwoFactorEnabled(db, userId)
  if (twoFaEnrolled) {
    await markSessionTwoFaPending(db, token)
    await logAuditEvent(db, 'login_success', {
      userId,
      email: emailLower,
      ip: ip ?? undefined,
      userAgent: userAgent ?? undefined,
      extra: { context: 'oauth_google', pending_2fa: true, created: createdNew },
    })
    res.redirect(
      `/accounts/login/2fa${
        stored.returnTo
          ? `?return_to=${encodeURIComponent(stored.returnTo)}`
          : ''
      }`,
    )
    return
  }

  await logAuditEvent(db, 'login_success', {
    userId,
    email: emailLower,
    ip: ip ?? undefined,
    userAgent: userAgent ?? undefined,
    extra: { context: 'oauth_google', created: createdNew },
  })

  res.redirect(stored.returnTo || DEFAULT_POST_LOGIN)
}
