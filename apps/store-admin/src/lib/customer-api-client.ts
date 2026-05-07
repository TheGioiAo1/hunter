/**
 * Customer API client — raw fetch wrapper for Gbox-Customer-Service
 * (api-customer.gbox.co). The codegen api-client doesn't have
 * CustomerSegmentService so we call fetch directly, following review-api-client.
 *
 * BASE URL: ENV `API_CUSTOMER_BASE_URL` (default `https://api-customer.gbox.co`).
 * Tách biệt với api-product (OpenAPI.BASE singleton) để 2 client không đụng nhau.
 *
 * Routes (BE):
 *   GET    api/{shop_id}/segments                     — list (page/limit/keyword)
 *   POST   api/{shop_id}/segments                     — create (body=SegmentMutation)
 *   GET    api/{shop_id}/segments/{id}                — detail
 *   PUT    api/{shop_id}/segments/{id}                — update
 *   DELETE api/{shop_id}/segments  (body=string[])    — bulk delete
 *   POST   api/{shop_id}/segments/preview             — body=ruleset → {count, sample[5]}
 *   GET    api/{shop_id}/segments/{id}/customers      — apply
 *   GET    api/{shop_id}/segments/summary             — auto-bucket counts
 *   GET    api/{shop_id}/customer-stats/{customer_id} — get stats per customer
 */

import { ProductApiError } from './product-api-errors.js'
import { createApiContext, type ApiContext } from './product-api-client.js'
import { fetchJson } from './api-fetch-json.js'
import type {
  ApiCustomer,
  ApiCustomerSegment,
  ApiSegmentListResponse,
  ApiSegmentPreviewResponse,
  ApiSegmentApplyResponse,
  ApiSegmentRuleSet,
  ApiSegmentSummary,
  ApiCustomerStats,
} from './customer-api-types.js'

const CUSTOMER_BASE = (
  process.env.API_CUSTOMER_BASE_URL || 'https://api-customer.gbox.co'
).replace(/\/+$/, '')

function shopBase(shopId: string): string {
  return `${CUSTOMER_BASE}/api/${encodeURIComponent(shopId)}`
}

const fetchCustomer = <T>(url: string, init: Parameters<typeof fetchJson>[1]) =>
  fetchJson<T>(url, init, 'Customer')

// Re-export createApiContext nguyên trạng — caller dùng cùng helper resolve
// shop_id (24-hex ObjectId) + token từ session cookie.
export { createApiContext }
export type { ApiContext }

// ─── Segment CRUD ────────────────────────────────────────────────────────

export async function listSegments(
  ctx: ApiContext,
  opts: { page?: number; limit?: number; keyword?: string } = {},
): Promise<ApiSegmentListResponse> {
  const params = new URLSearchParams()
  params.set('page', String(opts.page ?? 1))
  params.set('limit', String(opts.limit ?? 250))
  if (opts.keyword) params.set('keyword', opts.keyword)
  return fetchCustomer<ApiSegmentListResponse>(`${shopBase(ctx.shopId)}/segments?${params}`, {
    method: 'GET',
    token: ctx.token,
  })
}

export async function getSegment(ctx: ApiContext, id: string): Promise<ApiCustomerSegment | null> {
  try {
    return await fetchCustomer<ApiCustomerSegment>(`${shopBase(ctx.shopId)}/segments/${encodeURIComponent(id)}`, {
      method: 'GET',
      token: ctx.token,
    })
  } catch (err: any) {
    if (err instanceof ProductApiError && err.status === 404) return null
    throw err
  }
}

export interface SegmentMutation {
  name: string
  description?: string
  rules: ApiSegmentRuleSet
}

export async function createSegment(ctx: ApiContext, body: SegmentMutation): Promise<ApiCustomerSegment> {
  return fetchCustomer<ApiCustomerSegment>(`${shopBase(ctx.shopId)}/segments`, {
    method: 'POST',
    body: JSON.stringify(body),
    token: ctx.token,
  })
}

export async function updateSegment(
  ctx: ApiContext,
  id: string,
  body: SegmentMutation,
): Promise<ApiCustomerSegment | null> {
  try {
    return await fetchCustomer<ApiCustomerSegment>(`${shopBase(ctx.shopId)}/segments/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
      token: ctx.token,
    })
  } catch (err: any) {
    if (err instanceof ProductApiError && err.status === 404) return null
    throw err
  }
}

export async function bulkDeleteSegments(ctx: ApiContext, ids: string[]): Promise<void> {
  if (!ids.length) return
  await fetchCustomer<unknown>(`${shopBase(ctx.shopId)}/segments`, {
    method: 'DELETE',
    body: JSON.stringify(ids),
    token: ctx.token,
  })
}

/**
 * Delete a single customer. BE only exposes bulk DELETE (`/api/{shop_id}` body=string[]),
 * so we wrap a single-element array to support delete-from-UI.
 */
export async function deleteCustomer(ctx: ApiContext, id: string): Promise<void> {
  if (!id) return
  await fetchCustomer<unknown>(`${shopBase(ctx.shopId)}`, {
    method: 'DELETE',
    body: JSON.stringify([id]),
    token: ctx.token,
  })
}

// ─── Preview / Apply / Summary ───────────────────────────────────────────

export async function previewSegment(
  ctx: ApiContext,
  ruleset: ApiSegmentRuleSet,
): Promise<ApiSegmentPreviewResponse> {
  return fetchCustomer<ApiSegmentPreviewResponse>(`${shopBase(ctx.shopId)}/segments/preview`, {
    method: 'POST',
    body: JSON.stringify(ruleset),
    token: ctx.token,
  })
}

/**
 * Apply ruleset INLINE (without saving as Segment). Paginated, used by
 * auto-segment filter (vip/repeat/at-risk...) trên customers list page.
 */
export async function applyInlineSegment(
  ctx: ApiContext,
  ruleset: ApiSegmentRuleSet,
  opts: { page?: number; limit?: number; include_stats?: boolean } = {},
): Promise<ApiSegmentApplyResponse> {
  const params = new URLSearchParams()
  params.set('page', String(opts.page ?? 1))
  params.set('limit', String(opts.limit ?? 50))
  if (opts.include_stats) params.set('include_stats', 'true')
  return fetchCustomer<ApiSegmentApplyResponse>(
    `${shopBase(ctx.shopId)}/segments/apply-inline?${params}`,
    { method: 'POST', body: JSON.stringify(ruleset), token: ctx.token },
  )
}

export async function applySegment(
  ctx: ApiContext,
  id: string,
  opts: { page?: number; limit?: number; include_stats?: boolean } = {},
): Promise<ApiSegmentApplyResponse> {
  const params = new URLSearchParams()
  params.set('page', String(opts.page ?? 1))
  params.set('limit', String(opts.limit ?? 50))
  if (opts.include_stats) params.set('include_stats', 'true')
  return fetchCustomer<ApiSegmentApplyResponse>(
    `${shopBase(ctx.shopId)}/segments/${encodeURIComponent(id)}/customers?${params}`,
    { method: 'GET', token: ctx.token },
  )
}

export async function segmentSummary(ctx: ApiContext): Promise<ApiSegmentSummary> {
  return fetchCustomer<ApiSegmentSummary>(`${shopBase(ctx.shopId)}/segments/summary`, {
    method: 'GET',
    token: ctx.token,
  })
}

// ─── CustomerStats (single) ──────────────────────────────────────────────

export async function getCustomerStats(ctx: ApiContext, customerId: string): Promise<ApiCustomerStats> {
  return fetchCustomer<ApiCustomerStats>(
    `${shopBase(ctx.shopId)}/customer-stats/${encodeURIComponent(customerId)}`,
    { method: 'GET', token: ctx.token },
  )
}

// ─── Customer detail / create (CustomerController) ──────────────────────

/**
 * GET /api/{shop_id}/{IdOrEmail} — AllowAnonymous on BE. Returns Customer
 * or null on 404. Used bởi customer-detail-api.ts.
 */
export async function getCustomerByIdOrEmail(ctx: ApiContext, idOrEmail: string): Promise<ApiCustomer | null> {
  try {
    const r = await fetchCustomer<ApiCustomer | null>(`${shopBase(ctx.shopId)}/${encodeURIComponent(idOrEmail)}`, {
      method: 'GET',
      token: ctx.token,
    })
    // BE trả 204 (no content) khi không tìm thấy → fetchJson return {} as T → check id.
    if (!r || !(r as any).id) return null
    return r
  } catch (err: any) {
    if (err?.status === 404) return null
    throw err
  }
}

/**
 * POST /api/{shop_id} — Create customer. AllowAnonymous on BE (signup-style).
 * Body shape khớp Customer model: first_name, last_name, email, phone,
 * address_1/2, city, province, zip, country_name/code, etc. (BE ignore unknown
 * fields qua [BsonIgnoreExtraElements]).
 */
export async function createCustomer(ctx: ApiContext, body: Partial<ApiCustomer>): Promise<ApiCustomer> {
  return fetchCustomer<ApiCustomer>(shopBase(ctx.shopId), {
    method: 'POST',
    body: JSON.stringify(body),
    token: ctx.token,
  })
}

// ─── Customer list (CustomerController.List) ─────────────────────────────

export interface CustomerListResponse {
  pagination?: { page?: number; limit?: number; count?: number }
  data?: ApiCustomer[]
}

export interface ListCustomersOpts {
  page?: number
  limit?: number
  keyword?: string
  sort_by?: string
  fields?: string
}

const DEFAULT_CUSTOMER_FIELDS =
  'id,shop_id,first_name,last_name,full_name,email,phone,city,country_code,country_name,created_at'

// ─── Order Service helpers (cross-domain — separate base URL) ───────────

const ORDER_BASE = (
  process.env.API_ORDER_BASE_URL || 'https://api-order.gbox.co'
).replace(/\/+$/, '')

function orderShopBase(shopId: string): string {
  return `${ORDER_BASE}/api/${encodeURIComponent(shopId)}`
}

const fetchOrder = <T>(url: string, init: Parameters<typeof fetchJson>[1]) =>
  fetchJson<T>(url, init, 'Order')

/**
 * Save a draft/temp order. BE: POST /api/{shop_id}/insert-temp (AllowAnonymous).
 */
export async function insertTempOrder(ctx: ApiContext, order: Record<string, any>): Promise<void> {
  await fetchOrder<unknown>(`${orderShopBase(ctx.shopId)}/insert-temp`, {
    method: 'POST', token: ctx.token, body: JSON.stringify(order),
  })
}

/**
 * Create real order (convert draft → real). BE: POST /api/{shop_id} (AllowAnonymous).
 */
export async function createOrder(ctx: ApiContext, order: Record<string, any>): Promise<any> {
  return fetchOrder<any>(orderShopBase(ctx.shopId), {
    method: 'POST', token: ctx.token, body: JSON.stringify(order),
  })
}

/**
 * Delete order. BE: DELETE /api/{shop_id}/{order_id}. Roles `owners,delete_order_edit`.
 */
export async function deleteOrder(ctx: ApiContext, orderId: string): Promise<void> {
  await fetchOrder<unknown>(`${orderShopBase(ctx.shopId)}/${encodeURIComponent(orderId)}`, {
    method: 'DELETE', token: ctx.token,
  })
}

/**
 * Update an order in full. BE: PUT /api/{shop_id}/{order_id}. Body = full Order object.
 */
export async function updateOrder(ctx: ApiContext, orderId: string, order: Record<string, any>): Promise<any> {
  return fetchOrder<any>(`${orderShopBase(ctx.shopId)}/${encodeURIComponent(orderId)}`, {
    method: 'PUT', token: ctx.token, body: JSON.stringify(order),
  })
}

/**
 * Fetch single order by id. BE: GET /api/{shop_id}/{order_id}. Roles `owners,read_orders`.
 * Returns null if BE responds 404.
 */
export async function getOrder(ctx: ApiContext, orderId: string): Promise<any | null> {
  try {
    return await fetchOrder<any>(`${orderShopBase(ctx.shopId)}/${encodeURIComponent(orderId)}`, {
      method: 'GET', token: ctx.token,
    })
  } catch (err: any) {
    const status = err?.status ?? err?.statusCode
    if (status === 404 || status === 204) return null
    throw err
  }
}

/**
 * List orders via BE filter. BE: POST /api/{shop_id}/list. Body=OrderFilter, query=page/limit/fields.
 * fields: comma-separated Order field names — BE does MongoDB projection to reduce payload.
 */
export async function listOrders(
  ctx: ApiContext,
  opts: {
    page?: number
    limit?: number
    tag?: string
    status?: string
    paymentStatus?: boolean
    fields?: string
  } = {},
): Promise<{ data: any[]; pagination?: { count?: number; page?: number; limit?: number } }> {
  const params = new URLSearchParams()
  params.set('page', String(opts.page ?? 1))
  params.set('limit', String(opts.limit ?? 25))
  if (opts.fields) params.set('fields', opts.fields)
  const body: Record<string, any> = {}
  if (opts.tag) body.tags = [opts.tag]
  if (opts.status) body.status = opts.status
  if (opts.paymentStatus !== undefined) body.payment_status = opts.paymentStatus
  return fetchOrder<{ data: any[]; pagination?: any }>(
    `${orderShopBase(ctx.shopId)}/list?${params}`,
    { method: 'POST', token: ctx.token, body: JSON.stringify(body) },
  )
}

// ─── Customer list ──────────────────────────────────────────────────────

/**
 * List customers — wraps BE GET /api/{shop_id} (root path).
 * KHÔNG có /list suffix vì BE [HttpGet] List action bound vào controller
 * route mặc định. /list suffix sẽ match [HttpGet("{IdOrEmail}")] Detail
 * action với IdOrEmail="list" → 204 No Content.
 */
export async function listCustomers(ctx: ApiContext, opts: ListCustomersOpts = {}): Promise<CustomerListResponse> {
  const params = new URLSearchParams()
  params.set('page', String(opts.page ?? 1))
  params.set('limit', String(opts.limit ?? 25))
  params.set('fields', opts.fields ?? DEFAULT_CUSTOMER_FIELDS)
  if (opts.keyword) params.set('keyword', opts.keyword)
  if (opts.sort_by) params.set('sort_by', opts.sort_by)
  return fetchCustomer<CustomerListResponse>(`${shopBase(ctx.shopId)}?${params}`, {
    method: 'GET',
    token: ctx.token,
  })
}
