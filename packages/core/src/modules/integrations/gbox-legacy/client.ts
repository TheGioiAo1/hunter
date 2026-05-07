/**
 * HTTP client for the legacy .NET Gbox stack.
 *
 *  - `loginLegacy` — POST /api/token, returns a JWT string
 *  - `getCachedOrLoginToken` — cache-aware wrapper used by push path
 *  - `createLegacyProduct` — POST /api/{shop_id}?check_exists=false&clone=false
 *  - `fetchMyShops` — GET /api/user/me or GET /api/shop/my (best-effort)
 *
 * Error handling is shape-stable: every export returns `{ok, ...}` so
 * callers can branch without try/catch gymnastics. Underlying `fetch`
 * errors (DNS, TLS, timeout) map to `network_error`.
 */

import type { Kysely } from 'kysely'
import type { Database } from '../../../../../db/src/schema/tables.js'
import {
  getActiveConfigResolved,
  markLoginError,
  markLoginOk,
  type LegacyGboxConfigResolved,
} from './config.ts'
import { getCachedToken, storeToken, invalidateToken } from './token-cache.ts'
import type {
  LegacyProductPayload,
  LegacyCreateProductResult,
  LegacyAuthResponseLoose,
  LegacyPushErrorCode,
} from './types.ts'

// ───────────────────────────────────────────────────────────
// Login
// ───────────────────────────────────────────────────────────

export interface LoginResult {
  readonly ok: boolean
  readonly token: string | null
  readonly errorCode: LegacyPushErrorCode | null
  readonly errorMessage: string | null
  readonly httpStatus: number
}

/**
 * POST /api/token with {email, password}. The .NET response shape is
 * undocumented — we probe the common field locations and take the
 * first token-shaped string ≥ 20 chars. Identical probe list to
 * scripts/legacy-gbox-create-products.ts so the two stay in sync.
 */
export async function loginLegacy(
  authBase: string,
  email: string,
  password: string,
): Promise<LoginResult> {
  const url = `${authBase.replace(/\/$/, '')}/api/token`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: '*/*',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    })
  } catch (e: any) {
    return {
      ok: false,
      token: null,
      errorCode: 'network_error',
      errorMessage: `Network: ${e?.message ?? String(e)}`,
      httpStatus: 0,
    }
  }

  const rawText = await res.text()
  let body: LegacyAuthResponseLoose | string | null = null
  try {
    body = rawText ? (JSON.parse(rawText) as any) : null
  } catch {
    // Non-JSON response — surface what we can
    if (!res.ok) {
      return {
        ok: false,
        token: null,
        errorCode: res.status >= 500 ? 'network_error' : 'auth_failed',
        errorMessage: `Auth (non-JSON, HTTP ${res.status}): ${rawText.slice(0, 200)}`,
        httpStatus: res.status,
      }
    }
    // 200 with non-JSON plaintext body → treat as raw token
    body = rawText
  }

  if (!res.ok) {
    return {
      ok: false,
      token: null,
      errorCode: res.status === 401 || res.status === 403 ? 'auth_failed' : 'http_4xx',
      errorMessage:
        typeof body === 'object' && body && 'message' in (body as any)
          ? String((body as any).message)
          : `Auth HTTP ${res.status}: ${rawText.slice(0, 200)}`,
      httpStatus: res.status,
    }
  }

  const candidates: Array<unknown> = [
    typeof body === 'object' && body ? (body as any).access_token : null,
    typeof body === 'object' && body ? (body as any).token : null,
    typeof body === 'object' && body ? (body as any).data?.access_token : null,
    typeof body === 'object' && body ? (body as any).data?.token : null,
    typeof body === 'object' && body ? (body as any).result?.access_token : null,
    typeof body === 'object' && body ? (body as any).result?.token : null,
    typeof body === 'string' ? body : null,
  ]
  const token = candidates.find(
    (v): v is string => typeof v === 'string' && v.length >= 20,
  )
  if (!token) {
    return {
      ok: false,
      token: null,
      errorCode: 'bad_response',
      errorMessage: `Auth OK but no recognizable token field. Body preview: ${JSON.stringify(body).slice(0, 300)}`,
      httpStatus: res.status,
    }
  }
  return {
    ok: true,
    token,
    errorCode: null,
    errorMessage: null,
    httpStatus: res.status,
  }
}

/**
 * Returns a valid JWT for the active config. Uses the in-memory cache
 * when present + fresh, otherwise logs in and caches. Updates the
 * `last_login_*` columns as a side effect so the god-admin UI can show
 * the most recent auth state.
 *
 * Returns null on failure (the login path has already written the
 * error to `last_error_*`).
 */
export async function getValidToken(
  db: Kysely<Database>,
  config: LegacyGboxConfigResolved,
): Promise<{ token: string | null; result: LoginResult }> {
  const cached = getCachedToken(config.auth_base, config.master_email)
  if (cached) {
    return {
      token: cached,
      result: {
        ok: true,
        token: cached,
        errorCode: null,
        errorMessage: null,
        httpStatus: 200,
      },
    }
  }
  const result = await loginLegacy(
    config.auth_base,
    config.master_email,
    config.master_password,
  )
  if (!result.ok || !result.token) {
    await markLoginError(
      db,
      config.id,
      result.errorCode === 'auth_failed' ? 'auth_failed' : 'network_error',
      result.errorMessage ?? 'unknown login error',
    )
    return { token: null, result }
  }
  storeToken(config.auth_base, config.master_email, result.token)
  await markLoginOk(db, config.id)
  return { token: result.token, result }
}

// ───────────────────────────────────────────────────────────
// Create product on the master shop
// ───────────────────────────────────────────────────────────

export interface CreateProductInput {
  readonly db: Kysely<Database>
  readonly product: LegacyProductPayload
}

/**
 * POST the given product payload to the active master shop. Handles
 * the login round-trip transparently. On `401` we invalidate the
 * cached token once and retry ONE time — covers the edge case where
 * the JWT expired between cache lookup and HTTP send.
 */
export async function createLegacyProduct(
  input: CreateProductInput,
): Promise<
  | { ok: true; result: LegacyCreateProductResult; config: LegacyGboxConfigResolved }
  | {
      ok: false
      errorCode: LegacyPushErrorCode
      errorMessage: string
      config: LegacyGboxConfigResolved | null
      result: LegacyCreateProductResult | null
    }
> {
  const config = await getActiveConfigResolved(input.db)
  if (!config) {
    return {
      ok: false,
      errorCode: 'no_config',
      // Iron Rule 5 (CLAUDE.md): never leak a `/god-admin/*` path or
      // feature name in a message a seller could end up seeing. Callers
      // that have already sanitised the error chain can inspect
      // `errorCode === 'no_config'` to drive their UX — the message is
      // intentionally generic so that if a caller forgets to branch on
      // errorCode and surfaces `errorMessage` verbatim, sellers still
      // see only "contact Gbox support".
      errorMessage:
        'Legacy integration not configured. Please contact Gbox support.',
      config: null,
      result: null,
    }
  }

  const tokenRes = await getValidToken(input.db, config)
  if (!tokenRes.token) {
    return {
      ok: false,
      errorCode: tokenRes.result.errorCode ?? 'auth_failed',
      errorMessage: tokenRes.result.errorMessage ?? 'Login failed',
      config,
      result: null,
    }
  }

  let result = await postProduct({
    productBase: config.product_base,
    shopId: config.master_shop_id,
    token: tokenRes.token,
    product: input.product,
  })

  // 401 handling — one retry after forcing a fresh login. Protects
  // against clock skew / premature exp refresh.
  if (result.status === 401) {
    invalidateToken(config.auth_base, config.master_email)
    const retry = await getValidToken(input.db, config)
    if (retry.token) {
      result = await postProduct({
        productBase: config.product_base,
        shopId: config.master_shop_id,
        token: retry.token,
        product: input.product,
      })
    }
  }

  if (result.ok) {
    return { ok: true, result, config }
  }

  const code: LegacyPushErrorCode =
    result.status === 0
      ? 'network_error'
      : result.status >= 500
        ? 'http_5xx'
        : result.status === 401 || result.status === 403
          ? 'auth_failed'
          : 'http_4xx'
  return {
    ok: false,
    errorCode: code,
    errorMessage: result.errorMessage ?? `HTTP ${result.status}`,
    config,
    result,
  }
}

async function postProduct(args: {
  productBase: string
  shopId: string
  token: string
  product: LegacyProductPayload
}): Promise<LegacyCreateProductResult> {
  const qs = new URLSearchParams({ check_exists: 'false', clone: 'false' })
  const url = `${args.productBase.replace(/\/$/, '')}/api/${encodeURIComponent(args.shopId)}?${qs.toString()}`
  const startedAt = Date.now()
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: '*/*',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.token}`,
      },
      body: JSON.stringify({ ...args.product, shop_id: args.shopId }),
    })
  } catch (e: any) {
    return {
      status: 0,
      ok: false,
      legacyProductId: null,
      errorMessage: `Network: ${e?.message ?? String(e)}`,
      rawBody: null,
      latencyMs: Date.now() - startedAt,
    }
  }
  const txt = await res.text()
  let body: any = null
  try {
    body = txt ? JSON.parse(txt) : null
  } catch {
    body = { _non_json: txt.slice(0, 400) }
  }
  const legacyProductId =
    body?.id ?? body?._id ?? body?.data?.id ?? body?.result?.id ?? null
  const errorMessage = res.ok
    ? null
    : (body?.message ?? body?.error ?? `HTTP ${res.status}`)
  return {
    status: res.status,
    ok: res.ok,
    legacyProductId: legacyProductId ? String(legacyProductId) : null,
    errorMessage,
    rawBody: body,
    latencyMs: Date.now() - startedAt,
  }
}

// ───────────────────────────────────────────────────────────
// Best-effort shop discovery — used by the "Fetch shop id" button
// ───────────────────────────────────────────────────────────

export interface MyShopsResult {
  readonly ok: boolean
  readonly shops: ReadonlyArray<{ id: string; name: string | null }>
  readonly errorMessage: string | null
  readonly httpStatus: number
  readonly probedPath: string | null
}

/**
 * Try a few known legacy endpoints to discover which shops the logged-in
 * user owns. The .NET stack has no single canonical route; we probe in
 * order:
 *
 *   1. GET {shop_base}/api/shop/my
 *   2. GET {shop_base}/api/user/me          (returns shops[] sometimes)
 *   3. GET {auth_base}/api/user/me          (returns shops[] sometimes)
 *
 * First response that parses as JSON with an array of shop-ish objects
 * wins. Returns an empty list (ok=false) if nothing probed worked —
 * god-admin UI falls back to the manual shop_id input.
 */
export async function fetchMyShops(args: {
  authBase: string
  shopBase: string
  token: string
}): Promise<MyShopsResult> {
  const probes: Array<{ path: string; url: string }> = [
    { path: 'shop_base /api/shop/my', url: `${args.shopBase.replace(/\/$/, '')}/api/shop/my` },
    { path: 'shop_base /api/user/me', url: `${args.shopBase.replace(/\/$/, '')}/api/user/me` },
    { path: 'auth_base /api/user/me', url: `${args.authBase.replace(/\/$/, '')}/api/user/me` },
  ]
  for (const p of probes) {
    let res: Response
    try {
      res = await fetch(p.url, {
        method: 'GET',
        headers: {
          Accept: '*/*',
          Authorization: `Bearer ${args.token}`,
        },
      })
    } catch {
      continue
    }
    if (!res.ok) continue
    let body: any
    try {
      body = await res.json()
    } catch {
      continue
    }
    const shops = coerceShopsFromBody(body)
    if (shops.length > 0) {
      return {
        ok: true,
        shops,
        errorMessage: null,
        httpStatus: res.status,
        probedPath: p.path,
      }
    }
  }
  return {
    ok: false,
    shops: [],
    errorMessage:
      'No shops returned from /api/shop/my, /api/user/me. Enter the shop id manually.',
    httpStatus: 0,
    probedPath: null,
  }
}

function coerceShopsFromBody(
  body: any,
): ReadonlyArray<{ id: string; name: string | null }> {
  // Candidate arrays in order of likelihood
  const candidates: Array<unknown> = [
    body?.shops,
    body?.data?.shops,
    body?.result?.shops,
    body?.stores,
    body?.data?.stores,
    Array.isArray(body) ? body : null,
  ]
  for (const c of candidates) {
    if (!Array.isArray(c) || c.length === 0) continue
    const out: { id: string; name: string | null }[] = []
    for (const row of c) {
      if (!row || typeof row !== 'object') continue
      const id = (row as any).id ?? (row as any)._id ?? (row as any).shop_id
      if (id == null) continue
      out.push({
        id: String(id),
        name:
          typeof (row as any).name === 'string'
            ? (row as any).name
            : typeof (row as any).shop_name === 'string'
              ? (row as any).shop_name
              : null,
      })
    }
    if (out.length > 0) return out
  }
  return []
}
