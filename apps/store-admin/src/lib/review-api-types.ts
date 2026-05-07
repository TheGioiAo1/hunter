/**
 * Review types — bám sát BE Gbox-Product-Service-V2/Models/Lencam/Review.cs
 * + ReviewController (route api/{shop_id}/review).
 *
 * BE wire-format quirks:
 *  - Status enum string: pending | approcess (sic — typo BE = "approved") | refuse
 *    → DisplayReviewStatus dùng spelling chuẩn EN. Map qua STATUS_*.
 *  - Status int: 0 | 1 | 2 (Pending | approcess | refuse). Số param query/path
 *    của ReviewController.Get + Approve.
 *  - Type enum: review | question (int 0 | 1).
 *  - replies[]: array embed; BE không có endpoint dedicated → reply mới = PUT
 *    toàn bộ Review object kèm replies extended.
 */

export type ApiReviewStatus = 'pending' | 'approcess' | 'refuse'
export type DisplayReviewStatus = 'pending' | 'approved' | 'rejected'

export const STATUS_API_TO_DISPLAY: Record<ApiReviewStatus, DisplayReviewStatus> = {
  pending: 'pending',
  approcess: 'approved',
  refuse: 'rejected',
}

export const STATUS_DISPLAY_TO_API: Record<DisplayReviewStatus, ApiReviewStatus> = {
  pending: 'pending',
  approved: 'approcess',
  rejected: 'refuse',
}

export const STATUS_INT: Record<ApiReviewStatus, number> = {
  pending: 0,
  approcess: 1,
  refuse: 2,
}

const STATUS_INT_TO_API: Record<number, ApiReviewStatus> = {
  0: 'pending',
  1: 'approcess',
  2: 'refuse',
}

export type ApiReviewType = 'review' | 'question'
export const TYPE_INT: Record<ApiReviewType, number> = { review: 0, question: 1 }

export interface ApiReply {
  name?: string
  content?: string
  create_date?: string
}

export interface ApiReviewProduct {
  id?: string
  name?: string
  slug?: string
  thumbnail?: string
  [k: string]: unknown
}

export interface ApiReview {
  id?: string
  shop_id?: string
  name?: string
  email?: string
  rating?: number
  title?: string
  content?: string
  images?: (string | null)[]
  type?: ApiReviewType | number
  type_value?: string
  status?: ApiReviewStatus | number
  status_value?: string
  create_date?: string
  collection_ids?: string[]
  products?: ApiReviewProduct[]
  replies?: ApiReply[]
}

export interface ApiListReviewResponse {
  pagination?: { page?: number; limit?: number; count?: number }
  data?: ApiReview[]
}

function normalizeApiStatus(raw: unknown): ApiReviewStatus {
  if (typeof raw === 'string') {
    if (raw === 'pending' || raw === 'approcess' || raw === 'refuse') return raw
  }
  if (typeof raw === 'number' && raw in STATUS_INT_TO_API) return STATUS_INT_TO_API[raw]
  return 'pending'
}

/**
 * Shape mà reviews.ts list table đã expect (giả lập DB row schema cũ).
 * Giữ field name khớp DB Kysely để table rendering không phải đụng.
 * BE-only fields (profanity_hits, helpful_count, ...) trả 0 → meta strip ẩn.
 */
export interface DisplayReview {
  id: string
  rating: number
  title: string
  body: string
  author_name: string
  author_email: string
  status: DisplayReviewStatus
  product_id: string | null
  product_name: string | null
  created_at: string
  reply_body: string | null
  reply_author: string | null
  replied_at: string | null
  profanity_hits: number
  photos_count: number
  helpful_count: number
  unhelpful_count: number
  images: string[]
  shop_id: string
}

export function apiToDisplayReview(r: ApiReview): DisplayReview {
  const status = STATUS_API_TO_DISPLAY[normalizeApiStatus(r.status)]
  // Lấy reply mới nhất hiển thị inline. Edge case: replies[] trống → null.
  const lastReply = r.replies && r.replies.length > 0 ? r.replies[r.replies.length - 1] : null
  const firstProduct = r.products && r.products.length > 0 ? r.products[0] : null
  const cleanImages = Array.isArray(r.images) ? r.images.filter((s): s is string => !!s) : []
  return {
    id: r.id ?? '',
    rating: typeof r.rating === 'number' ? r.rating : 0,
    title: r.title ?? '',
    body: r.content ?? '',
    author_name: r.name ?? 'Anonymous',
    author_email: r.email ?? '',
    status,
    product_id: firstProduct?.id ?? null,
    product_name: firstProduct?.name ?? null,
    created_at: r.create_date ?? '',
    reply_body: lastReply?.content ?? null,
    reply_author: lastReply?.name ?? null,
    replied_at: lastReply?.create_date ?? null,
    profanity_hits: 0,
    photos_count: cleanImages.length,
    helpful_count: 0,
    unhelpful_count: 0,
    images: cleanImages,
    shop_id: r.shop_id ?? '',
  }
}
