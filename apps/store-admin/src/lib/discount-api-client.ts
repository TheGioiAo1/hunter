/**
 * Discount API client — wrapper Gbox-Order-Service DiscountController.
 *
 * BASE: ENV API_ORDER_BASE_URL (default https://api-order.gbox.co)
 * Routes:
 *   GET    /api/{shop_id}/discount?fields=&keyword=&page=1&limit=10&status=&IsAuto=&startDate=&endDate=
 *   GET    /api/{shop_id}/discount/{discount_id}
 *   POST   /api/{shop_id}/discount                       (Authorize App)
 *   PUT    /api/{shop_id}/discount/{discount_id}         (Authorize App)
 *   DELETE /api/{shop_id}/discount/{discount_id}
 *   DELETE /api/{shop_id}/discount  body=string[] ids
 *
 * BE auto-uppercases name + code on save.
 * Enum serialization: BE returns enums as numbers (Mongo BSON).
 *   DiscountType:  0=percent, 1=fix
 *   RangeType:     0=SubTotal, 1=ItenNumber  (sic — BE typo "Iten")
 *   DiscountEntity: 0=category, 1=product
 */

import { ProductApiError } from './product-api-errors.js'
import { createApiContext, type ApiContext } from './product-api-client.js'
import { fetchJson } from './api-fetch-json.js'

const ORDER_BASE = (
  process.env.API_ORDER_BASE_URL || 'https://api-order.gbox.co'
).replace(/\/+$/, '')

export { createApiContext, ProductApiError }
export type { ApiContext }

// ─── Types — bám 1-1 BE Discount.cs ─────

export type DiscountType = 0 | 1                 // 0=percent, 1=fix
export type RangeType = 0 | 1                    // 0=SubTotal, 1=ItenNumber
export type DiscountEntityKind = 0 | 1           // 0=category, 1=product

export interface SubEntityObject {
  entity_id?: string | null
  entity_name?: string | null
  entity_sku?: string | null
  discount_value?: number | null
}

export interface EntityObject {
  entity_id?: string | null
  entity_name?: string | null
  sub_items?: SubEntityObject[] | null
}

export interface BeDiscount {
  id?: string
  shop_id?: string | null
  name?: string | null                            // required, BE upper-cases
  code?: string | null                            // null/empty = auto-apply
  is_auto?: boolean | null
  discount_type?: DiscountType | null
  discount_value?: number | null
  start_date?: string | null                      // ISO datetime
  end_date?: string | null
  range_type?: RangeType | null
  min_value?: number | null
  max_value?: number | null
  ids?: string[] | null
  entities?: EntityObject[] | null
  entity?: DiscountEntityKind | null
  entity_excluded?: boolean | null
  individual_use?: boolean | null
  excluded_sale_items?: boolean | null
  customer_emails?: string[] | null
  status?: boolean | null
  usage_limit?: number | null
  usage_limit_per_user?: number | null
  created_at?: string | null
}

export interface DiscountListResponse {
  pagination?: { page?: number; limit?: number; count?: number }
  data?: BeDiscount[]
}

export interface ListDiscountsOpts {
  fields?: string
  keyword?: string
  page?: number
  limit?: number
  status?: boolean
  is_auto?: boolean
  start_date?: string
  end_date?: string
}

// ─── HTTP wrapper ─────

function shopBase(shopId: string): string {
  return `${ORDER_BASE}/api/${encodeURIComponent(shopId)}/discount`
}

const fetch$ = <T>(url: string, init: Parameters<typeof fetchJson>[1]) =>
  fetchJson<T>(url, init, 'Discount')

// ─── CRUD ─────

export async function listDiscounts(
  ctx: ApiContext,
  opts: ListDiscountsOpts = {},
): Promise<DiscountListResponse> {
  const params = new URLSearchParams()
  params.set('page', String(opts.page ?? 1))
  params.set('limit', String(opts.limit ?? 20))
  if (opts.fields) params.set('fields', opts.fields)
  if (opts.keyword) params.set('keyword', opts.keyword)
  if (typeof opts.status === 'boolean') params.set('status', String(opts.status))
  // BE param name: IsAuto (PascalCase) — quan trọng
  if (typeof opts.is_auto === 'boolean') params.set('IsAuto', String(opts.is_auto))
  if (opts.start_date) params.set('startDate', opts.start_date)
  if (opts.end_date) params.set('endDate', opts.end_date)
  return fetch$<DiscountListResponse>(`${shopBase(ctx.shopId)}?${params}`, {
    method: 'GET',
    token: ctx.token,
  })
}

export async function getDiscount(ctx: ApiContext, id: string): Promise<BeDiscount | null> {
  try {
    const r = await fetch$<BeDiscount | null>(`${shopBase(ctx.shopId)}/${encodeURIComponent(id)}`, {
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

export async function createDiscount(ctx: ApiContext, body: BeDiscount): Promise<BeDiscount> {
  return fetch$<BeDiscount>(shopBase(ctx.shopId), {
    method: 'POST',
    body: JSON.stringify(body),
    token: ctx.token,
  })
}

export async function updateDiscount(
  ctx: ApiContext,
  id: string,
  body: BeDiscount,
): Promise<BeDiscount> {
  return fetch$<BeDiscount>(`${shopBase(ctx.shopId)}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
    token: ctx.token,
  })
}

export async function deleteDiscount(ctx: ApiContext, id: string): Promise<void> {
  await fetch$<unknown>(`${shopBase(ctx.shopId)}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    token: ctx.token,
  })
}

export async function deleteDiscounts(ctx: ApiContext, ids: string[]): Promise<void> {
  if (!ids.length) return
  await fetch$<unknown>(shopBase(ctx.shopId), {
    method: 'DELETE',
    body: JSON.stringify(ids),
    token: ctx.token,
  })
}

// ─── Helpers ─────

export function discountTypeLabel(t: DiscountType | null | undefined): string {
  if (t === 0) return 'Percent'
  if (t === 1) return 'Fixed amount'
  return '—'
}

export function rangeTypeLabel(r: RangeType | null | undefined): string {
  if (r === 0) return 'Order subtotal'
  if (r === 1) return 'Item count'
  return 'No minimum'
}

export function entityKindLabel(e: DiscountEntityKind | null | undefined): string {
  if (e === 0) return 'Category'
  if (e === 1) return 'Product'
  return '—'
}

/** Compute display status: active | scheduled | expired | disabled */
export function discountStatus(d: BeDiscount): 'active' | 'scheduled' | 'expired' | 'disabled' {
  if (d.status === false) return 'disabled'
  const now = Date.now()
  const start = d.start_date ? new Date(d.start_date).getTime() : null
  const end = d.end_date ? new Date(d.end_date).getTime() : null
  if (end != null && end < now) return 'expired'
  if (start != null && start > now) return 'scheduled'
  return 'active'
}
