/**
 * Gbox Platform — Google OAuth (OIDC) module.
 *
 * Seller-only. The god-admin login surface deliberately does NOT offer
 * Google sign-in (Iron Rule 5: god-admin is internal tooling, password +
 * 2FA only). This file is only ever imported from the accounts portal.
 *
 * Why hand-rolled instead of pulling in a library:
 *   - Our surface is exactly one provider + one flow (authorize → code →
 *     token → id_token). `openid-client`, `arctic`, and `passport-google`
 *     all ship hundreds of KB of dependency surface to solve problems we
 *     don't have (multi-provider strategy, dynamic discovery, session
 *     middleware). Keeping the module tree flat is worth ~150 lines.
 *   - Zero new deps means the lockfile diff is clean and audit reviewers
 *     can read the whole flow in one file.
 *   - Iron rule 1 — we want to control exactly what hits the wire.
 *
 * Flow:
 *   1. `GET /accounts/auth/google` → generate `state` + `nonce`, stash
 *      the pair in Redis with a 10-minute TTL, 302 to Google's consent
 *      screen (via `buildAuthorizeUrl`).
 *   2. Google → `GET /accounts/auth/google/callback?code=...&state=...`
 *   3. Look the state up in Redis, validate + delete so it can't replay.
 *      Exchange the code for tokens at Google's token endpoint
 *      (`exchangeCode`). Verify the id_token's signature, audience,
 *      issuer, expiry, and nonce (`verifyIdToken`).
 *   4. Upsert the user row + `oauth_accounts` row. Mint a normal
 *      `gbox_session` cookie. Caller handles the session bit; we just
 *      return the verified claims.
 *
 * Security notes:
 *   - `state` is 32 bytes random, survives exactly one callback, and is
 *     deleted from Redis before the token exchange runs. A replay can't
 *     piggy-back on a valid `code` because the state guard already
 *     burned the lookup row.
 *   - `nonce` lives inside the id_token and binds the claim set to this
 *     specific authorization request — protects against token injection
 *     if an attacker somehow got a real Google id_token for a different
 *     flow.
 *   - `email_verified` MUST be true in the returned claims. Google's
 *     OIDC docs guarantee this is a boolean (or the string "true") and
 *     is false for unverified mailboxes. We reject anything else.
 *   - `aud` must equal our client_id exactly, not just start-with. The
 *     tokeninfo endpoint does this too, but belt-and-braces.
 *   - We never store the access_token or refresh_token. Post-login the
 *     user holds a Gbox session cookie; we don't call Google APIs on
 *     their behalf. `oauth_accounts` tracks the Google user id only so
 *     future re-logins resolve to the same user row even if the email
 *     changes at Google (rare but real: Workspace domain migrations).
 */

import { randomBytes } from 'node:crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GoogleOAuthConfig {
  /** OAuth 2.0 client id from Google Cloud Console. */
  clientId: string
  /** OAuth 2.0 client secret. Stored only in memory; never hits logs. */
  clientSecret: string
  /**
   * Absolute callback URL registered with Google. Must match EXACTLY —
   * even a trailing slash mismatch makes Google 400 the token exchange.
   */
  redirectUri: string
}

export interface GoogleTokenResponse {
  access_token: string
  id_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
  scope?: string
}

export interface GoogleIdClaims {
  iss: string
  sub: string
  aud: string
  exp: number
  iat: number
  email: string
  email_verified: boolean | string
  name?: string
  picture?: string
  given_name?: string
  family_name?: string
  locale?: string
  nonce?: string
  hd?: string // Workspace hosted-domain, e.g. "gbox.co"
}

export interface GoogleStateRecord {
  nonce: string
  returnTo: string
  createdAt: number
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Read Google OAuth config from env. Returns `null` (not throws) when
 * unset — the accounts portal uses the null case to render a "Google
 * login temporarily unavailable" banner instead of 500-ing.
 *
 * `baseUrl` is the public URL of the accounts portal (e.g.
 * `https://accounts.gbox.co`). The redirect URI is derived from it so
 * dev + prod stay in sync without a separate env var.
 */
export function getGoogleOAuthConfig(
  baseUrl: string,
): GoogleOAuthConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim()
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret) return null
  const trimmedBase = baseUrl.replace(/\/+$/, '')
  return {
    clientId,
    clientSecret,
    redirectUri: `${trimmedBase}/accounts/auth/google/callback`,
  }
}

export function isGoogleOAuthConfigured(): boolean {
  return (
    !!process.env.GOOGLE_CLIENT_ID?.trim() &&
    !!process.env.GOOGLE_CLIENT_SECRET?.trim()
  )
}

// ---------------------------------------------------------------------------
// Authorize step
// ---------------------------------------------------------------------------

/**
 * Build the Google consent-screen redirect URL.
 *
 * `prompt=select_account` forces the account chooser even when the
 * user is already signed into exactly one Google account; without it
 * returning users get auto-logged as whichever account they last used,
 * which is surprising in a multi-account world (agency staff, shared
 * machines). Trade-off: one extra click.
 *
 * `access_type=online` — we don't need offline refresh tokens because
 * we're only using Google for *authentication*, not *authorization to
 * Google APIs*. Skipping `offline` means no refresh_token to store +
 * rotate, which is a simpler attack surface.
 */
export function buildAuthorizeUrl(
  cfg: GoogleOAuthConfig,
  state: string,
  nonce: string,
): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    access_type: 'online',
    prompt: 'select_account',
    include_granted_scopes: 'true',
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

export function generateOAuthState(): string {
  return randomBytes(32).toString('hex')
}

export function generateOAuthNonce(): string {
  return randomBytes(32).toString('hex')
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const TOKENINFO_ENDPOINT = 'https://oauth2.googleapis.com/tokeninfo'

export class GoogleOAuthError extends Error {
  public readonly status: number
  public readonly code: string
  constructor(code: string, message: string, status = 502) {
    super(message)
    this.name = 'GoogleOAuthError'
    this.code = code
    this.status = status
  }
}

/**
 * Exchange an authorization `code` for the token bundle (access_token +
 * id_token, optionally refresh_token). Uses URL-encoded form body per
 * the OIDC spec; Google rejects JSON here.
 *
 * Failure modes mapped to a single `GoogleOAuthError` so callers don't
 * have to distinguish "Google was down" from "user revoked consent in
 * the middle of the flow" — both end up on the error page.
 */
export async function exchangeCode(
  cfg: GoogleOAuthConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: 'authorization_code',
  }).toString()

  let resp: Response
  try {
    resp = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
  } catch (err) {
    throw new GoogleOAuthError(
      'network',
      `Google token endpoint unreachable: ${(err as Error).message}`,
    )
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new GoogleOAuthError(
      'token_exchange_failed',
      `Google token exchange failed: ${resp.status} ${text.slice(0, 200)}`,
      resp.status,
    )
  }
  const json = (await resp.json()) as GoogleTokenResponse
  if (!json.id_token) {
    throw new GoogleOAuthError(
      'no_id_token',
      'Google token response had no id_token',
    )
  }
  return json
}

// ---------------------------------------------------------------------------
// id_token verification
// ---------------------------------------------------------------------------

/**
 * Verify a Google id_token by calling the `tokeninfo` endpoint.
 *
 * Google's tokeninfo validates the JWS signature + iss + aud + exp
 * server-side and returns the parsed claims. Trade-off vs local JWKS
 * verification: one extra HTTPS round-trip, but ~80 lines less code,
 * no JWKS cache to maintain, no key-rotation race window. Acceptable
 * for login (~1/session) though we'd switch to JWKS if we started
 * calling this on every request.
 *
 * We still verify `aud`, `iss`, `exp`, `nonce`, and `email_verified`
 * locally on the response — tokeninfo "accepted" the token but we owe
 * defence-in-depth to the session it's about to mint.
 */
export async function verifyIdToken(
  idToken: string,
  expected: { audience: string; nonce: string },
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleIdClaims> {
  const url = `${TOKENINFO_ENDPOINT}?id_token=${encodeURIComponent(idToken)}`
  let resp: Response
  try {
    resp = await fetchImpl(url)
  } catch (err) {
    throw new GoogleOAuthError(
      'network',
      `Google tokeninfo unreachable: ${(err as Error).message}`,
    )
  }
  if (!resp.ok) {
    throw new GoogleOAuthError(
      'id_token_invalid',
      `Google tokeninfo returned ${resp.status}`,
      resp.status,
    )
  }
  const claims = (await resp.json()) as GoogleIdClaims

  if (claims.aud !== expected.audience) {
    throw new GoogleOAuthError(
      'aud_mismatch',
      `id_token audience mismatch: got ${claims.aud}, expected ${expected.audience}`,
    )
  }
  if (
    claims.iss !== 'https://accounts.google.com' &&
    claims.iss !== 'accounts.google.com'
  ) {
    throw new GoogleOAuthError(
      'iss_mismatch',
      `id_token issuer mismatch: ${claims.iss}`,
    )
  }
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) {
    throw new GoogleOAuthError('expired', 'id_token is expired')
  }
  // tokeninfo returns strings; JSON parsing at the library level
  // normalises to bool for valid JSON. Accept both to be robust.
  const verified =
    claims.email_verified === true || claims.email_verified === 'true'
  if (!verified) {
    throw new GoogleOAuthError(
      'email_unverified',
      'Google reports email as unverified',
    )
  }
  if (expected.nonce && claims.nonce !== expected.nonce) {
    throw new GoogleOAuthError(
      'nonce_mismatch',
      'id_token nonce mismatch (possible replay)',
    )
  }
  if (!claims.email || !claims.sub) {
    throw new GoogleOAuthError(
      'missing_claims',
      'id_token missing required email/sub claim',
    )
  }
  return claims
}
