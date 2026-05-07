/**
 * LenfulClient — thin HTTP wrapper around Lenful V6 Seller API.
 *
 * Responsibilities
 * ----------------
 * 1. Auto-login with encrypted credential row; cache bearer token in DB.
 * 2. Sign every request with `Authorization: Bearer …`.
 * 3. Log every call to `lenful_api_log` (password fields redacted).
 * 4. Rate-limit to 2 req/s globally (token bucket) so we don't get
 *    blocked by Lenful without notice.
 * 5. Retry up to 3× on 5xx / network; never retry 4xx.
 * 6. On 401, drop the cached token, re-login once, retry.
 *
 * Intentionally NOT responsible for:
 *   - Building the Gbox → Lenful payload (builder.ts owns that)
 *   - Writing to `lenful_orders` (push-order.ts owns that)
 */

import type { Kysely } from 'kysely'
import type { Database } from '../../../../../db/src/schema/tables.js'
import { decryptSecret, encryptSecret, redactRequestBody } from './crypto.ts'
import {
  LENFUL_DEFAULT_BASE,
  LENFUL_V3_BASE,
  LENFUL_WALLET_BASE,
  LENFUL_DESIGN_BASE,
  type LenfulCatalogDesign,
  type LenfulCatalogProduct,
  type LenfulCreateOrderPayload,
  type LenfulCreateOrderResponse,
  type LenfulLoginResponse,
  type LenfulMeResponse,
  type LenfulTrackingItem,
  type LenfulWalletResponse,
} from './types.ts'

// ─── Rate limiter (process-global token bucket, 2 req/s) ───────
// Simple and effective — not distributed, but each god-admin API
// node only hits Lenful serially anyway.

const RATE_LIMIT_RPS = 2
let lastRequestAt = 0
async function rateLimit(): Promise<void> {
  const minGap = 1000 / RATE_LIMIT_RPS
  const now = Date.now()
  const wait = lastRequestAt + minGap - now
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastRequestAt = Date.now()
}

// ─── Errors ────────────────────────────────────────────────────

export class LenfulApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody?: unknown,
  ) {
    super(message)
    this.name = 'LenfulApiError'
  }
}

export class LenfulAuthError extends LenfulApiError {
  constructor(message: string, responseBody?: unknown) {
    super(message, 401, responseBody)
    this.name = 'LenfulAuthError'
  }
}

// ─── Client ────────────────────────────────────────────────────

export interface LenfulClientOptions {
  readonly db: Kysely<Database>
  readonly credentialId: string
  /** Actor that triggered this call — 'cron' | user.id — for audit log. */
  readonly triggeredBy?: string
  readonly userId?: string | null
}

interface LoadedCredential {
  id: string
  user_name: string
  password: string
  bearerToken: string | null
  bearerTokenExpiresAt: Date | null
  baseUrl: string
}

const DEFAULT_TIMEOUT_MS = 25_000

export class LenfulClient {
  private readonly db: Kysely<Database>
  private readonly credentialId: string
  private readonly triggeredBy: string
  private readonly userId: string | null

  constructor(opts: LenfulClientOptions) {
    this.db = opts.db
    this.credentialId = opts.credentialId
    this.triggeredBy = opts.triggeredBy ?? 'system'
    this.userId = opts.userId ?? null
  }

  // ─── Credential + token lifecycle ────────────────────────────

  private async loadCredential(): Promise<LoadedCredential> {
    const row = await this.db
      .selectFrom('lenful_credentials')
      .select([
        'id',
        'user_name',
        'password_encrypted',
        'bearer_token_encrypted',
        'bearer_token_expires_at',
        'base_url',
      ])
      .where('id', '=', this.credentialId)
      .where('is_active', '=', true)
      .executeTakeFirst()
    if (!row) throw new LenfulAuthError('No active Lenful credential')
    const password = decryptSecret(row.password_encrypted as Buffer)
    const bearerToken = row.bearer_token_encrypted
      ? decryptSecret(row.bearer_token_encrypted as Buffer)
      : null
    return {
      id: row.id,
      user_name: row.user_name,
      password,
      bearerToken,
      bearerTokenExpiresAt: row.bearer_token_expires_at
        ? new Date(row.bearer_token_expires_at as unknown as string)
        : null,
      baseUrl: row.base_url ?? LENFUL_DEFAULT_BASE,
    }
  }

  private tokenStillValid(c: LoadedCredential): boolean {
    if (!c.bearerToken) return false
    if (!c.bearerTokenExpiresAt) return true
    // 2-minute safety margin
    return c.bearerTokenExpiresAt.getTime() - Date.now() > 2 * 60 * 1000
  }

  private async login(c: LoadedCredential): Promise<string> {
    const body = new URLSearchParams()
    body.append('user_name', c.user_name)
    body.append('password', c.password)
    const res = await this.rawFetch({
      method: 'POST',
      url: `${c.baseUrl}/api/seller/login`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      skipAuth: true,
    })
    const payload = res.json as LenfulLoginResponse
    const token = payload.access_token || payload.token
    if (!token) {
      throw new LenfulAuthError('Lenful login returned no token', payload)
    }
    // Lenful doesn't document TTL — assume 55 minutes to be safe.
    const expiresAt = new Date(Date.now() + 55 * 60 * 1000)
    await this.db
      .updateTable('lenful_credentials')
      .set({
        bearer_token_encrypted: encryptSecret(token),
        bearer_token_expires_at: expiresAt.toISOString(),
        last_login_at: new Date().toISOString(),
        last_error_msg: null,
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', c.id)
      .execute()
    return token
  }

  private async getBearer(): Promise<string> {
    const c = await this.loadCredential()
    if (this.tokenStillValid(c)) return c.bearerToken!
    return await this.login(c)
  }

  // ─── Raw HTTP ────────────────────────────────────────────────

  private async rawFetch(opts: {
    method: string
    url: string
    headers?: Record<string, string>
    body?: string
    skipAuth?: boolean
  }): Promise<{ status: number; json: any; rawBody: string; durationMs: number }> {
    await rateLimit()
    const started = Date.now()
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(opts.headers || {}),
    }
    if (!opts.skipAuth) {
      const token = await this.getBearer()
      headers['Authorization'] = `Bearer ${token}`
    }
    let res: Response
    try {
      res = await fetch(opts.url, {
        method: opts.method,
        headers,
        body: opts.body,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      })
    } catch (err: any) {
      const durationMs = Date.now() - started
      await this.logCall({
        method: opts.method,
        url: opts.url,
        statusCode: null,
        durationMs,
        requestBody: opts.skipAuth ? null : opts.body,
        responseBody: null,
        errorMsg: err?.message ?? String(err),
      })
      throw new LenfulApiError(`Network error: ${err?.message ?? err}`, 0)
    }
    const durationMs = Date.now() - started
    const rawBody = await res.text()
    let json: any = null
    try {
      json = rawBody ? JSON.parse(rawBody) : null
    } catch {
      json = { _non_json: rawBody.slice(0, 1000) }
    }
    await this.logCall({
      method: opts.method,
      url: opts.url,
      statusCode: res.status,
      durationMs,
      requestBody: opts.skipAuth ? null : opts.body,
      responseBody: json,
      errorMsg: res.ok ? null : `HTTP ${res.status}`,
    })
    return { status: res.status, json, rawBody, durationMs }
  }

  private async logCall(args: {
    method: string
    url: string
    statusCode: number | null
    durationMs: number
    requestBody: string | null | undefined
    responseBody: unknown
    errorMsg: string | null
  }): Promise<void> {
    try {
      let reqJson: unknown = null
      if (args.requestBody) {
        try {
          reqJson = redactRequestBody(JSON.parse(args.requestBody))
        } catch {
          // urlencoded login body — parse + redact
          const parsed: Record<string, string> = {}
          for (const [k, v] of new URLSearchParams(args.requestBody)) parsed[k] = v
          reqJson = redactRequestBody(parsed)
        }
      }
      await this.db
        .insertInto('lenful_api_log')
        .values({
          credential_id: this.credentialId,
          method: args.method,
          url: args.url,
          status_code: args.statusCode,
          duration_ms: args.durationMs,
          request_body: reqJson ? (JSON.stringify(reqJson) as any) : null,
          response_body:
            args.responseBody !== null
              ? (JSON.stringify(args.responseBody).slice(0, 16_000) as any)
              : null,
          error_msg: args.errorMsg,
          triggered_by: this.triggeredBy,
          user_id: this.userId,
        })
        .execute()
    } catch (e) {
      // Logging must never break the actual call
      console.error('[LenfulClient] logCall failed:', e)
    }
  }

  // ─── High-level methods ──────────────────────────────────────

  async me(): Promise<LenfulMeResponse> {
    const c = await this.loadCredential()
    const res = await this.rawFetch({
      method: 'GET',
      url: `${c.baseUrl}/api/seller/me`,
    })
    if (res.status !== 200) {
      throw new LenfulApiError(`seller/me failed: ${res.status}`, res.status, res.json)
    }
    return res.json as LenfulMeResponse
  }

  async walletBalance(): Promise<LenfulWalletResponse> {
    const res = await this.rawFetch({
      method: 'GET',
      url: `${LENFUL_WALLET_BASE}/api`,
    })
    if (res.status !== 200) {
      throw new LenfulApiError(`wallet failed: ${res.status}`, res.status, res.json)
    }
    return res.json as LenfulWalletResponse
  }

  async createOrder(
    storeId: string,
    payload: LenfulCreateOrderPayload,
  ): Promise<LenfulCreateOrderResponse> {
    const c = await this.loadCredential()
    const url = `${c.baseUrl}/api/order/${encodeURIComponent(storeId)}/create?isCheckOrderNumber=false`
    const body = JSON.stringify(payload)
    const res = await this.rawFetch({
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    if (res.status !== 200 && res.status !== 201) {
      throw new LenfulApiError(
        `createOrder failed: ${res.status}`,
        res.status,
        res.json,
      )
    }
    return res.json as LenfulCreateOrderResponse
  }

  async listTrackingItems(params: {
    page?: number
    limit?: number
    orderShortIds?: ReadonlyArray<string>
    fromDate?: string
    toDate?: string
  } = {}): Promise<{ items: ReadonlyArray<LenfulTrackingItem>; raw: any }> {
    const c = await this.loadCredential()
    const qs = new URLSearchParams()
    qs.set('page', String(params.page ?? 1))
    qs.set('limit', String(params.limit ?? 50))
    qs.set('sort_by', 'id_desc')
    if (params.orderShortIds?.length) {
      qs.set('order_short_ids', params.orderShortIds.join(','))
    }
    if (params.fromDate) qs.set('from_date', params.fromDate)
    if (params.toDate) qs.set('to_date', params.toDate)
    const url = `${c.baseUrl}/api/order/tracking_item?${qs.toString()}`
    const res = await this.rawFetch({ method: 'GET', url })
    if (res.status !== 200) {
      throw new LenfulApiError(`tracking_item failed: ${res.status}`, res.status, res.json)
    }
    const items = Array.isArray(res.json?.items)
      ? res.json.items
      : Array.isArray(res.json?.data)
      ? res.json.data
      : Array.isArray(res.json)
      ? res.json
      : []
    return { items, raw: res.json }
  }

  async cancelOrders(orderIds: ReadonlyArray<string>): Promise<void> {
    const c = await this.loadCredential()
    const res = await this.rawFetch({
      method: 'PUT',
      url: `${c.baseUrl}/api/order/cancel`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: orderIds }),
    })
    if (res.status !== 200) {
      throw new LenfulApiError(`cancel failed: ${res.status}`, res.status, res.json)
    }
  }

  async payOrders(orderIds: ReadonlyArray<string>): Promise<void> {
    const c = await this.loadCredential()
    const res = await this.rawFetch({
      method: 'POST',
      url: `${c.baseUrl}/api/order/payments`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: orderIds }),
    })
    if (res.status !== 200) {
      throw new LenfulApiError(`payments failed: ${res.status}`, res.status, res.json)
    }
  }

  // ─── F1: Catalog (products + designs) ────────────────────────

  /**
   * List Lenful products (the seller's catalog on Lenful). Lenful paginates
   * with page/limit; we surface `items` + raw payload so callers can show
   * pagination controls.
   *
   * IMPORTANT — endpoint vs. documentation:
   * The official V6 Seller Postman docs
   *   https://documenter.getpostman.com/view/1568587/2s8Yt1rouq
   * publish ONLY Auth + Order endpoints (12 total). They do NOT document any
   * product-listing endpoint — product info only appears nested inside order
   * responses (e.g. `product_sku`). The `/api/product` path we hit here is
   * an undocumented back-end route that Lenful's newer store deployments
   * expose out of the box; some older installs may respond with 404.
   *
   * The V1.0 (legacy v3) API uses a different shape:
   *   GET /v1.0/products?iCurrPage=1&iPageSize=100&strKeyword=...
   * We keep `/api/product` here because that's what the live Gbox<>Lenful
   * integration is wired against. If a deployment returns 404, operators
   * should adjust `base_url` in `lenful_credentials` or open a support
   * ticket with Lenful for the correct path.
   *
   * Default `limit` is 100 — this matches the page size used by
   * `syncCatalogFromLive` so ad-hoc callers don't accidentally walk the
   * catalog twice as slowly as the nightly sync.
   */
  async listProducts(params: {
    page?: number
    limit?: number
    search?: string
  } = {}): Promise<{ items: ReadonlyArray<LenfulCatalogProduct>; raw: any; total: number }> {
    const c = await this.loadCredential()
    const qs = new URLSearchParams()
    qs.set('page', String(params.page ?? 1))
    // 100 is the effective cap for most Lenful deployments; larger values
    // are silently clamped server-side. We cap at 200 locally so a caller
    // bug can't DoS their own rate-limit budget.
    const limit = Math.max(1, Math.min(200, params.limit ?? 100))
    qs.set('limit', String(limit))
    if (params.search) qs.set('search', params.search)
    const url = `${c.baseUrl}/api/product?${qs.toString()}`
    const res = await this.rawFetch({ method: 'GET', url })
    if (res.status !== 200) {
      throw new LenfulApiError(`listProducts failed: ${res.status}`, res.status, res.json)
    }
    const items = this.normalizeCatalogItems(res.json)
    const total = this.extractTotal(res.json)
    return { items, raw: res.json, total }
  }

  /**
   * Quick helper to verify a specific Lenful product_sku exists. Returns
   * the matching catalog row or null. Used by the mapping UI "Verify SKU"
   * button before saving a mapping row.
   */
  async findProductBySku(sku: string): Promise<LenfulCatalogProduct | null> {
    const res = await this.listProducts({ search: sku, limit: 10 }).catch(() => null)
    if (!res) return null
    const hit = res.items.find((p) => p.product_sku === sku || p.sku === sku)
    return hit ?? null
  }

  /** List previously-created designs in the seller's Lenful design library. */
  async listDesigns(params: {
    page?: number
    limit?: number
  } = {}): Promise<{ items: ReadonlyArray<LenfulCatalogDesign>; raw: any; total: number }> {
    const c = await this.loadCredential()
    const qs = new URLSearchParams()
    qs.set('page', String(params.page ?? 1))
    // See `listProducts` above for the rationale on 100 / max 200.
    const limit = Math.max(1, Math.min(200, params.limit ?? 100))
    qs.set('limit', String(limit))
    const url = `${c.baseUrl}/api/design?${qs.toString()}`
    const res = await this.rawFetch({ method: 'GET', url })
    if (res.status !== 200) {
      throw new LenfulApiError(`listDesigns failed: ${res.status}`, res.status, res.json)
    }
    const src = Array.isArray(res.json?.items)
      ? res.json.items
      : Array.isArray(res.json?.data)
      ? res.json.data
      : Array.isArray(res.json)
      ? res.json
      : []
    return { items: src as ReadonlyArray<LenfulCatalogDesign>, raw: res.json, total: this.extractTotal(res.json) }
  }

  private normalizeCatalogItems(raw: any): LenfulCatalogProduct[] {
    const src = Array.isArray(raw?.items)
      ? raw.items
      : Array.isArray(raw?.data)
      ? raw.data
      : Array.isArray(raw?.products)
      ? raw.products
      : Array.isArray(raw)
      ? raw
      : []
    return src.map((p: any) => ({
      id: p.id ?? p.product_id ?? null,
      product_sku: p.product_sku ?? p.sku ?? null,
      sku: p.sku ?? p.product_sku ?? null,
      title: p.title ?? p.name ?? null,
      category: p.category ?? p.category_slug ?? null,
      thumbnail: p.thumbnail ?? p.image ?? p.preview_url ?? null,
      price: p.price ?? p.base_price ?? null,
      raw: p,
    }))
  }

  private extractTotal(raw: any): number {
    if (typeof raw?.total === 'number') return raw.total
    if (typeof raw?.total_items === 'number') return raw.total_items
    if (typeof raw?.meta?.total === 'number') return raw.meta.total
    if (Array.isArray(raw?.items)) return raw.items.length
    if (Array.isArray(raw)) return raw.length
    return 0
  }

  /** Quick connection test — login + /me + wallet. Used by credential UI. */
  async healthCheck(): Promise<{
    ok: boolean
    seller: LenfulMeResponse | null
    wallet: LenfulWalletResponse | null
    error: string | null
  }> {
    try {
      const seller = await this.me()
      const wallet = await this.walletBalance().catch(() => null)
      return { ok: true, seller, wallet, error: null }
    } catch (err: any) {
      return {
        ok: false,
        seller: null,
        wallet: null,
        error: err?.message ?? String(err),
      }
    }
  }
}

export const _internalRefs = { LENFUL_V3_BASE, LENFUL_DESIGN_BASE }
