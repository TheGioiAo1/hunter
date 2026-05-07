/**
 * BE Payment Service wrapper (Gbox-Payment-Service / api-payment.gbox.co).
 * Manages payment gateway records per shop — PayPal, Stripe, etc.
 *
 * Routes (BE):
 *   GET    /api/{shop_id}/public              — public list (AllowAnonymous, cached)
 *   GET    /api/{shop_id}                     — list (Authorize)
 *   GET    /api/{shop_id}/{payment_id}        — detail
 *   POST   /api/{shop_id}                     — create payment (body=Payment)
 *   PUT    /api/{shop_id}/{payment_id}        — update
 *   PUT    /api/{shop_id}/position            — reorder
 *   DELETE /api/{shop_id}/{payment_id}        — delete
 *   POST   /api/{shop_id}/process/{gateway}/{order_id}/{payment_method_id}
 *
 * Payment shape (BE model):
 *   { id, shop_id, name, description, public_key, private_key,
 *     paygate, active, live, position, create_date, update_date }
 *
 *   paygate: 'Paypal' | 'Stripe' | 'COD' | 'Banking'  (BE ValidValues — PascalCase!)
 *   public_key: gateway-specific (PayPal merchant_id, Stripe pub key, ...)
 *   private_key: secret (PayPal client_secret, Stripe secret key, ...)
 *   live: true=production, false=sandbox
 */

import { ProductApiError } from './product-api-errors.js'
import { createApiContext, type ApiContext } from './product-api-client.js'

const BASE = (process.env.API_PAYMENT_BASE_URL || 'https://api-payment.gbox.co').replace(/\/+$/, '')
const TIMEOUT_MS = 8000

export { createApiContext, type ApiContext }

// BE Payment.cs: [ValidValues("Paypal", "Stripe", "COD", "Banking")]
export const PAYGATES = ['Paypal', 'Stripe', 'COD', 'Banking'] as const
export type Paygate = typeof PAYGATES[number]

export interface BePayment {
  id?: string
  shop_id?: string
  name?: string | null
  description?: string | null
  public_key?: string | null
  private_key?: string | null
  paygate?: Paygate | string | null
  active?: boolean | null
  live?: boolean | null
  disable_update_tracking?: boolean | null
  position?: number | null
  create_date?: string | null
  update_date?: string | null
}

export function isPaygate(v: unknown): v is Paygate {
  return typeof v === 'string' && (PAYGATES as readonly string[]).includes(v)
}

export function paygateLabel(p: string | null | undefined): string {
  switch (p) {
    case 'Paypal':  return 'PayPal'
    case 'Stripe':  return 'Stripe'
    case 'COD':     return 'Cash on delivery'
    case 'Banking': return 'Bank transfer'
    default:        return p ?? '—'
  }
}

export interface PaymentListResponse {
  pagination?: { page?: number; limit?: number; count?: number }
  data?: BePayment[]
}

function shopBase(shopId: string): string {
  return `${BASE}/api/${encodeURIComponent(shopId)}`
}

interface FetchInit extends Omit<RequestInit, 'signal'> {
  token?: string
}

async function fetchJson<T>(url: string, init: FetchInit): Promise<T> {
  const { token, headers, ...rest } = init
  let r: Response
  try {
    r = await fetch(url, {
      ...rest,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(headers ?? {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new ProductApiError('timeout', `Payment API timeout ${TIMEOUT_MS}ms`)
    }
    throw new ProductApiError('network', err?.message || 'fetch failed')
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new ProductApiError('http', `${r.status} ${r.statusText}${text ? ' — ' + text.slice(0, 200) : ''}`, r.status)
  }
  const ctype = r.headers.get('content-type') ?? ''
  if (!ctype.includes('json')) return {} as T
  return (await r.json()) as T
}

// ─── List (admin — yêu cầu auth) ───
export interface ListPaymentsOpts {
  active?: boolean
  live?: boolean
  page?: number
  limit?: number
  fields?: string                  // CSV field names — BE Project select
}
export async function listPayments(ctx: ApiContext, opts: ListPaymentsOpts = {}): Promise<PaymentListResponse> {
  const params = new URLSearchParams()
  params.set('page', String(opts.page ?? 1))
  params.set('limit', String(opts.limit ?? 100))
  if (opts.active !== undefined) params.set('active', String(opts.active))
  if (opts.live !== undefined) params.set('live', String(opts.live))
  if (opts.fields) params.set('fields', opts.fields)
  return fetchJson<PaymentListResponse>(`${shopBase(ctx.shopId)}?${params}`, {
    method: 'GET',
    token: ctx.token,
  })
}

// ─── List public (AllowAnonymous, BE Redis cached, chỉ active=true) ───
// Storefront/checkout dùng — không trả secret/private fields nếu BE projection.
export async function listPublicPayments(ctx: ApiContext): Promise<PaymentListResponse> {
  return fetchJson<PaymentListResponse>(`${shopBase(ctx.shopId)}/public`, {
    method: 'GET',
    token: ctx.token,
  })
}

// ─── Detail ───
export async function getPayment(ctx: ApiContext, paymentId: string): Promise<BePayment | null> {
  try {
    const r = await fetchJson<BePayment | null>(`${shopBase(ctx.shopId)}/${encodeURIComponent(paymentId)}`, {
      method: 'GET',
      token: ctx.token,
    })
    if (!r || !(r as any).id) return null
    return r
  } catch (err: any) {
    if (err instanceof ProductApiError && err.status === 404) return null
    throw err
  }
}

// ─── Create ───
export async function createPayment(ctx: ApiContext, body: BePayment): Promise<BePayment> {
  // Normalize paygate to BE PascalCase (defensive — BE ValidValues sẽ reject nếu sai).
  const sanitized: BePayment = {
    ...body,
    paygate: body.paygate ? normalizePaygate(body.paygate) : body.paygate,
  }
  return fetchJson<BePayment>(`${shopBase(ctx.shopId)}`, {
    method: 'POST',
    token: ctx.token,
    body: JSON.stringify(sanitized),
  })
}

// ─── Update ───
export async function updatePayment(ctx: ApiContext, paymentId: string, body: BePayment): Promise<BePayment> {
  const sanitized: BePayment = {
    ...body,
    paygate: body.paygate ? normalizePaygate(body.paygate) : body.paygate,
  }
  return fetchJson<BePayment>(`${shopBase(ctx.shopId)}/${encodeURIComponent(paymentId)}`, {
    method: 'PUT',
    token: ctx.token,
    body: JSON.stringify(sanitized),
  })
}

// ─── Delete ───
export async function deletePayment(ctx: ApiContext, paymentId: string): Promise<void> {
  await fetchJson<unknown>(`${shopBase(ctx.shopId)}/${encodeURIComponent(paymentId)}`, {
    method: 'DELETE',
    token: ctx.token,
  })
}

// ─── Bulk update positions (BE PUT /position, body=Payment[]) ───
export async function updatePaymentPositions(
  ctx: ApiContext,
  items: Array<{ id: string; position: number }>,
): Promise<void> {
  if (!items.length) return
  await fetchJson<unknown>(`${shopBase(ctx.shopId)}/position`, {
    method: 'PUT',
    token: ctx.token,
    body: JSON.stringify(items.map(i => ({ id: i.id, position: i.position }))),
  })
}

/**
 * List payments filtered by paygate (PascalCase).
 * Local filter (BE list endpoint không có paygate query param).
 */
export async function listPaymentsByGateway(
  ctx: ApiContext,
  paygate: string,
): Promise<BePayment[]> {
  const list = await listPayments(ctx, { limit: 100 }).catch(() => ({ data: [] as BePayment[] }))
  const norm = normalizePaygate(paygate)
  return (list.data || []).filter(p => p.paygate === norm)
}

/**
 * Single-active enforcement: activate target record, deactivate others cùng paygate.
 * Sequential PUT — not atomic, race-prone but acceptable cho admin panel low-concurrency.
 *
 * Returns the updated target record. Throws nếu BE PUT thất bại.
 */
export async function setActivePayment(
  ctx: ApiContext,
  paymentId: string,
  paygate: string,
): Promise<BePayment> {
  const accounts = await listPaymentsByGateway(ctx, paygate)
  const target = accounts.find(p => p.id === paymentId)
  if (!target) throw new ProductApiError('http', `Payment ${paymentId} not found in paygate ${paygate}`, 404)

  // Deactivate others first (skip already inactive để giảm noise).
  for (const p of accounts) {
    if (p.id && p.id !== paymentId && p.active) {
      await updatePayment(ctx, p.id, { ...p, active: false })
    }
  }
  // Activate target nếu chưa active.
  if (!target.active) {
    return updatePayment(ctx, paymentId, { ...target, active: true })
  }
  return target
}

/** Map common variants → BE PascalCase enum value. */
function normalizePaygate(v: string): string {
  const lower = v.toLowerCase()
  if (lower === 'paypal') return 'Paypal'
  if (lower === 'stripe') return 'Stripe'
  if (lower === 'cod' || lower === 'cash on delivery') return 'COD'
  if (lower === 'banking' || lower === 'bank transfer' || lower === 'bank') return 'Banking'
  return v  // unknown → giữ nguyên, BE sẽ reject nếu không match ValidValues
}

// ─── Helper: upsert by paygate (find existing or create) ───
/**
 * Find existing payment with matching `paygate` for this shop, then
 * update; otherwise create new. Used by PayPal onboard callback to keep
 * a single canonical PayPal record per shop.
 */
export async function upsertPaymentByGateway(
  ctx: ApiContext,
  paygate: string,
  body: BePayment,
): Promise<BePayment> {
  const list = await listPayments(ctx, { limit: 100 }).catch(() => ({ data: [] as BePayment[] }))
  const existing = (list.data || []).find(p => p.paygate === paygate)
  if (existing && existing.id) {
    return updatePayment(ctx, existing.id, { ...existing, ...body, paygate })
  }
  return createPayment(ctx, { ...body, paygate })
}
