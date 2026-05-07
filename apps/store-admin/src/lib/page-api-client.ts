/**
 * Page API client — wrapper raw fetch cho Gbox-Page-Service
 * (api-page.gbox.co). BE không có codegen sẵn nên gọi fetch trực tiếp,
 * pattern mirror customer-api-client.
 *
 * BASE URL: ENV `API_PAGE_BASE_URL` (default `https://api-page.gbox.co`).
 *
 * Routes (BE PageController, [Authorize] mặc định, GET có [AllowAnonymous]):
 *   POST   /api/{shop_id}                       — create (body=Page)
 *   PUT    /api/{shop_id}                       — update (body=Page có id)
 *   GET    /api/{shop_id}                       — list (page/limit/tags/keyword/fields/published/sort_by)
 *   DELETE /api/{shop_id}                       — bulk delete (body=List<Page> tối thiểu {id, shop_id, slug})
 *   GET    /api/{shop_id}/{IdOrSlug}            — detail (admin nên dùng id 24-hex để bypass cache)
 *   GET    /api/{shop_id}/tags                  — distinct tags
 *   PUT    /api/{shop_id}/{slug}/view_counter   — view counter (storefront, admin không dùng)
 */

import { ProductApiError } from './product-api-errors.js'
import { createApiContext, type ApiContext } from './product-api-client.js'
import { fetchJson } from './api-fetch-json.js'
import type {
  ApiPage,
  ApiPageListResponse,
  ListPagesOpts,
  DeletePageItem,
} from './page-api-types.js'

const PAGE_BASE = (
  process.env.API_PAGE_BASE_URL || 'https://api-page.gbox.co'
).replace(/\/+$/, '')

function shopBase(shopId: string): string {
  return `${PAGE_BASE}/api/${encodeURIComponent(shopId)}`
}

const fetchPage = <T>(url: string, init: Parameters<typeof fetchJson>[1]) =>
  fetchJson<T>(url, init, 'Page')

// Reuse cùng resolver shop_id + token với product/customer client.
export { createApiContext }
export type { ApiContext }

/**
 * Default field list cho list view — đủ render table mà không kéo `content`
 * (HTML body có thể vài MB). Detail handler tự lấy hết.
 */
const DEFAULT_LIST_FIELDS =
  'id,title,slug,published,template,image_url,tags,updated_at,created_at'

// ─── List ────────────────────────────────────────────────────────────────

export async function listPages(
  ctx: ApiContext,
  opts: ListPagesOpts = {},
): Promise<ApiPageListResponse> {
  const params = new URLSearchParams()
  params.set('page', String(opts.page ?? 1))
  params.set('limit', String(opts.limit ?? 20))
  params.set('fields', opts.fields ?? DEFAULT_LIST_FIELDS)
  params.set('sort_by', opts.sort_by ?? 'updated_at_desc')
  if (opts.keyword) params.set('keyword', opts.keyword)
  if (opts.tags) params.set('tags', opts.tags)
  if (typeof opts.published === 'boolean') params.set('published', String(opts.published))
  return fetchPage<ApiPageListResponse>(`${shopBase(ctx.shopId)}?${params}`, {
    method: 'GET',
    token: ctx.token,
  })
}

// ─── Detail ──────────────────────────────────────────────────────────────

/**
 * GET /api/{shop_id}/{IdOrSlug}. Admin nên truyền id 24-hex — BE bypass
 * Redis cache (slug-keyed) khi nhận ObjectId. 404/204 → null.
 */
export async function getPage(ctx: ApiContext, idOrSlug: string): Promise<ApiPage | null> {
  try {
    const r = await fetchPage<ApiPage | null>(
      `${shopBase(ctx.shopId)}/${encodeURIComponent(idOrSlug)}`,
      { method: 'GET', token: ctx.token },
    )
    if (!r || !(r as any).id) return null
    return r
  } catch (err: any) {
    if (err instanceof ProductApiError && err.status === 404) return null
    throw err
  }
}

// ─── Create ──────────────────────────────────────────────────────────────

/**
 * POST /api/{shop_id}. BE auto-generate slug từ title qua ToSlug + dedupe
 * trong cùng shop. Caller KHÔNG cần truyền slug.
 */
export async function createPage(ctx: ApiContext, body: Partial<ApiPage>): Promise<ApiPage> {
  return fetchPage<ApiPage>(shopBase(ctx.shopId), {
    method: 'POST',
    body: JSON.stringify(body),
    token: ctx.token,
  })
}

// ─── Update ──────────────────────────────────────────────────────────────

/**
 * PUT /api/{shop_id}. Body PHẢI có `id`. BE dùng filter shop_id+id, không
 * re-slug khi update — slug giữ nguyên trừ khi caller gửi trực tiếp.
 */
export async function updatePage(
  ctx: ApiContext,
  body: Partial<ApiPage> & { id: string },
): Promise<ApiPage | null> {
  try {
    return await fetchPage<ApiPage>(shopBase(ctx.shopId), {
      method: 'PUT',
      body: JSON.stringify(body),
      token: ctx.token,
    })
  } catch (err: any) {
    if (err instanceof ProductApiError && err.status === 404) return null
    throw err
  }
}

// ─── Delete (bulk) ───────────────────────────────────────────────────────

/**
 * DELETE /api/{shop_id} với body=List<Page>. BE chỉ dùng {id} để filter +
 * {shop_id, slug} để clear cache. Tối thiểu truyền 3 field này.
 */
export async function deletePages(ctx: ApiContext, items: DeletePageItem[]): Promise<void> {
  if (!items.length) return
  await fetchPage<unknown>(shopBase(ctx.shopId), {
    method: 'DELETE',
    body: JSON.stringify(items),
    token: ctx.token,
  })
}

// ─── Tags ────────────────────────────────────────────────────────────────

export async function listPageTags(ctx: ApiContext): Promise<string[]> {
  const r = await fetchPage<string[] | null>(`${shopBase(ctx.shopId)}/tags`, {
    method: 'GET',
    token: ctx.token,
  })
  return Array.isArray(r) ? r : []
}

// ─── Helpers cho FE ──────────────────────────────────────────────────────

/**
 * Đọc value `page_view` từ custom_fields[] (BE lưu counter ở đây).
 * Trả 0 nếu không có hoặc parse fail.
 */
export function readPageView(page: Pick<ApiPage, 'custom_fields'>): number {
  const cf = page.custom_fields?.find((x) => x.name?.toLowerCase() === 'page_view')
  const n = parseInt(cf?.value ?? '', 10)
  return Number.isFinite(n) ? n : 0
}

/**
 * Bulk publish/unpublish — BE chưa có endpoint bulk-update, loop PUT với
 * concurrency cap 5 để tránh quá tải. Trả số bản ghi affected.
 */
export async function bulkSetPublished(
  ctx: ApiContext,
  ids: string[],
  published: boolean,
): Promise<{ affected: number; errors: { id: string; message: string }[] }> {
  const errors: { id: string; message: string }[] = []
  let affected = 0
  const queue = [...ids]
  const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
    while (queue.length) {
      const id = queue.shift()
      if (!id) break
      try {
        const r = await updatePage(ctx, { id, published })
        if (r) affected++
        else errors.push({ id, message: 'not found' })
      } catch (err: any) {
        errors.push({ id, message: err?.message ?? 'unknown' })
      }
    }
  })
  await Promise.all(workers)
  return { affected, errors }
}
