/**
 * Review API client — wrapper raw fetch cho ReviewController
 * (Gbox-Product-Service-V2). Codegen api-client KHÔNG có ReviewService nên
 * gọi fetch trực tiếp, theo pattern shop-collections trong product-api-client.ts.
 *
 * Routes (BE):
 *   GET    api/{shop_id}/review                 — list (filter rating/type/status/keyword + page/limit/sort_by/fields)
 *   GET    api/{shop_id}/review/{id}            — detail
 *   POST   api/{shop_id}/review                  — create
 *   PUT    api/{shop_id}/review/{id}            — update (full Review)
 *   DELETE api/{shop_id}/review/{id}            — delete 1
 *   DELETE api/{shop_id}/review (body string[]) — bulk delete
 *   PUT    api/{shop_id}/review/approve?status=N (body string[]) — bulk approve/refuse
 */

import { OpenAPI } from '../../../../packages/api-client/src/product/index.js'
import type { ApiContext } from './product-api-client.js'
import { fetchJson } from './api-fetch-json.js'
import {
  STATUS_DISPLAY_TO_API,
  STATUS_INT,
  TYPE_INT,
  type ApiListReviewResponse,
  type ApiReview,
  type ApiReviewType,
  type DisplayReviewStatus,
} from './review-api-types.js'

const DEFAULT_REVIEW_LIST_FIELDS =
  'id,shop_id,name,email,rating,title,content,images,type,type_value,status,status_value,create_date,products,replies'

function reviewBase(shopId: string): string {
  return `${OpenAPI.BASE}/api/${encodeURIComponent(shopId)}/review`
}

const fetchReview = <T>(url: string, init: Parameters<typeof fetchJson>[1]) =>
  fetchJson<T>(url, init, 'Review')

export interface ListReviewsFilter {
  page?: number
  limit?: number
  rating?: number
  type?: ApiReviewType
  status?: DisplayReviewStatus
  product_ids?: string[]
  category_ids?: string[]
  keyword?: string
  sort_by?: string
  fields?: string
}

export async function listReviews(
  ctx: ApiContext,
  filter: ListReviewsFilter = {},
): Promise<ApiListReviewResponse> {
  const params = new URLSearchParams()
  params.set('page', String(filter.page ?? 1))
  params.set('limit', String(filter.limit ?? 25))
  // Luôn pass explicit fields — bypass singleton _FieldsDefault pollution
  // (memory: project-product-service-cache-and-fields.md).
  params.set('fields', filter.fields ?? DEFAULT_REVIEW_LIST_FIELDS)
  if (filter.rating != null) params.set('rating', String(filter.rating))
  if (filter.type) params.set('type', String(TYPE_INT[filter.type]))
  if (filter.status) {
    params.set('status', String(STATUS_INT[STATUS_DISPLAY_TO_API[filter.status]]))
  }
  if (filter.product_ids?.length) params.set('product_ids', filter.product_ids.join(','))
  if (filter.category_ids?.length) params.set('category_ids', filter.category_ids.join(','))
  if (filter.keyword) params.set('keyword', filter.keyword)
  if (filter.sort_by) params.set('sort_by', filter.sort_by)
  return fetchReview<ApiListReviewResponse>(`${reviewBase(ctx.shopId)}?${params}`, {
    method: 'GET',
    token: ctx.token,
  })
}

export async function getReview(ctx: ApiContext, reviewId: string): Promise<ApiReview> {
  return fetchReview<ApiReview>(`${reviewBase(ctx.shopId)}/${encodeURIComponent(reviewId)}`, {
    method: 'GET',
    token: ctx.token,
  })
}

/**
 * Bulk approve/refuse. Single-id case dùng cùng endpoint với mảng 1 phần tử.
 * BE signature: Approve(Review.Status status, List<string> ids).
 * `status` đi qua query string; `ids` là body JSON (ASP.NET default cho complex
 * type không attribute → bind từ body khi method có body).
 */
export async function bulkApproveReviews(
  ctx: ApiContext,
  reviewIds: string[],
  status: DisplayReviewStatus,
): Promise<void> {
  if (!reviewIds.length) return
  const statusCode = STATUS_INT[STATUS_DISPLAY_TO_API[status]]
  await fetchReview<unknown>(`${reviewBase(ctx.shopId)}/approve?status=${statusCode}`, {
    method: 'PUT',
    body: JSON.stringify(reviewIds),
    token: ctx.token,
  })
}

export async function deleteReview(ctx: ApiContext, reviewId: string): Promise<void> {
  await fetchReview<unknown>(`${reviewBase(ctx.shopId)}/${encodeURIComponent(reviewId)}`, {
    method: 'DELETE',
    token: ctx.token,
  })
}

export async function bulkDeleteReviews(ctx: ApiContext, reviewIds: string[]): Promise<void> {
  if (!reviewIds.length) return
  await fetchReview<unknown>(reviewBase(ctx.shopId), {
    method: 'DELETE',
    body: JSON.stringify(reviewIds),
    token: ctx.token,
  })
}

/**
 * Reply: BE không có endpoint dedicated → GET full review, push vào replies[],
 * PUT lại object Review. Race nhỏ giữa GET và PUT — chấp nhận vì admin moderation
 * ít concurrent edit cùng 1 review.
 */
export async function addReplyToReview(
  ctx: ApiContext,
  reviewId: string,
  reply: { name: string; content: string },
): Promise<ApiReview> {
  const existing = await getReview(ctx, reviewId)
  const replies = Array.isArray(existing.replies) ? [...existing.replies] : []
  replies.push({
    name: reply.name,
    content: reply.content,
    create_date: new Date().toISOString(),
  })
  return fetchReview<ApiReview>(
    `${reviewBase(ctx.shopId)}/${encodeURIComponent(reviewId)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ ...existing, replies }),
      token: ctx.token,
    },
  )
}

/**
 * Clear reply cuối. UI cũ (DB mode) chỉ có 1 reply scalar nên "clear" = xóa hết.
 * Ở API mode (replies[] array) tương đương = xóa reply mới nhất.
 */
export async function clearLastReplyFromReview(
  ctx: ApiContext,
  reviewId: string,
): Promise<ApiReview> {
  const existing = await getReview(ctx, reviewId)
  const replies = Array.isArray(existing.replies) ? existing.replies.slice(0, -1) : []
  return fetchReview<ApiReview>(
    `${reviewBase(ctx.shopId)}/${encodeURIComponent(reviewId)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ ...existing, replies }),
      token: ctx.token,
    },
  )
}
