/**
 * Blog API client — wrapper fetch cho Gbox-Page-Service blog/article endpoints.
 *
 * BASE URL: ENV `API_PAGE_BASE_URL` (default `https://api-page.gbox.co`).
 * Blog service nằm cùng Page service, dùng chung base URL.
 *
 * Routes:
 *   GET    /api/{shop_id}/blogs                                  — list blogs
 *   POST   /api/{shop_id}/blogs                                  — create blog
 *   PUT    /api/{shop_id}/blogs                                  — update blog (body có id)
 *   DELETE /api/{shop_id}/blogs                                  — bulk delete blogs (body=[{id}])
 *   GET    /api/{shop_id}/blogs/{blog_id}/articles               — list articles
 *   GET    /api/{shop_id}/blogs/{blog_id}/articles/{IdOrSlug}    — article detail
 *   POST   /api/{shop_id}/blogs/{blog_id}/articles               — create article
 *   PUT    /api/{shop_id}/blogs/{blog_id}/articles               — update article (body có id)
 *   DELETE /api/{shop_id}/blogs/{blog_id}/articles               — bulk delete articles
 *   GET    /api/{shop_id}/blogs/{blog_id}/articles/tags          — distinct tags
 */

import { ProductApiError } from './product-api-errors.js'
import { createApiContext, type ApiContext } from './product-api-client.js'
import { fetchJson } from './api-fetch-json.js'
import type {
  ApiBlog,
  ApiArticle,
  ApiBlogListResponse,
  ApiArticleListResponse,
  ListArticlesOpts,
} from './blog-api-types.js'

const BLOG_BASE = (
  process.env.API_PAGE_BASE_URL || 'https://api-page.gbox.co'
).replace(/\/+$/, '')

function shopBase(shopId: string): string {
  return `${BLOG_BASE}/api/${encodeURIComponent(shopId)}`
}

function articlesBase(shopId: string, blogId: string): string {
  return `${shopBase(shopId)}/blogs/${encodeURIComponent(blogId)}/articles`
}

const fetch$ = <T>(url: string, init: Parameters<typeof fetchJson>[1]) =>
  fetchJson<T>(url, init, 'Blog')

export { createApiContext }
export type { ApiContext }

// ─── Blog CRUD ────────────────────────────────────────────────────────────

export async function listBlogs(
  ctx: ApiContext,
  opts: { page?: number; limit?: number } = {},
): Promise<ApiBlogListResponse> {
  const params = new URLSearchParams()
  params.set('page', String(opts.page ?? 1))
  params.set('limit', String(opts.limit ?? 50))
  return fetch$<ApiBlogListResponse>(`${shopBase(ctx.shopId)}/blogs?${params}`, {
    method: 'GET',
    token: ctx.token,
  })
}

export async function createBlog(
  ctx: ApiContext,
  body: Partial<ApiBlog>,
): Promise<ApiBlog> {
  return fetch$<ApiBlog>(`${shopBase(ctx.shopId)}/blogs`, {
    method: 'POST',
    body: JSON.stringify(body),
    token: ctx.token,
  })
}

export async function updateBlog(
  ctx: ApiContext,
  body: Partial<ApiBlog> & { id: string },
): Promise<ApiBlog | null> {
  try {
    return await fetch$<ApiBlog>(`${shopBase(ctx.shopId)}/blogs`, {
      method: 'PUT',
      body: JSON.stringify(body),
      token: ctx.token,
    })
  } catch (err: any) {
    if (err instanceof ProductApiError && err.status === 404) return null
    throw err
  }
}

export async function deleteBlogs(
  ctx: ApiContext,
  items: { id: string }[],
): Promise<void> {
  if (!items.length) return
  await fetch$<unknown>(`${shopBase(ctx.shopId)}/blogs`, {
    method: 'DELETE',
    body: JSON.stringify(items),
    token: ctx.token,
  })
}

// ─── Article CRUD ─────────────────────────────────────────────────────────

export async function listArticles(
  ctx: ApiContext,
  blogId: string,
  opts: ListArticlesOpts = {},
): Promise<ApiArticleListResponse> {
  const params = new URLSearchParams()
  params.set('page', String(opts.page ?? 1))
  params.set('limit', String(opts.limit ?? 20))
  if (opts.keyword) params.set('keyword', opts.keyword)
  if (opts.tags) params.set('tags', opts.tags)
  if (typeof opts.published === 'boolean') params.set('published', String(opts.published))
  if (opts.sort_by) params.set('sort_by', opts.sort_by)
  if (opts.fields) params.set('fields', opts.fields)
  return fetch$<ApiArticleListResponse>(`${articlesBase(ctx.shopId, blogId)}?${params}`, {
    method: 'GET',
    token: ctx.token,
  })
}

export async function getArticle(
  ctx: ApiContext,
  blogId: string,
  articleId: string,
): Promise<ApiArticle | null> {
  try {
    const r = await fetch$<ApiArticle | null>(
      `${articlesBase(ctx.shopId, blogId)}/${encodeURIComponent(articleId)}`,
      { method: 'GET', token: ctx.token },
    )
    if (!r || !(r as any).id) return null
    return r
  } catch (err: any) {
    if (err instanceof ProductApiError && err.status === 404) return null
    throw err
  }
}

export async function createArticle(
  ctx: ApiContext,
  blogId: string,
  body: Partial<ApiArticle>,
): Promise<ApiArticle> {
  return fetch$<ApiArticle>(articlesBase(ctx.shopId, blogId), {
    method: 'POST',
    body: JSON.stringify(body),
    token: ctx.token,
  })
}

export async function updateArticle(
  ctx: ApiContext,
  blogId: string,
  body: Partial<ApiArticle> & { id: string },
): Promise<ApiArticle | null> {
  try {
    return await fetch$<ApiArticle>(articlesBase(ctx.shopId, blogId), {
      method: 'PUT',
      body: JSON.stringify(body),
      token: ctx.token,
    })
  } catch (err: any) {
    if (err instanceof ProductApiError && err.status === 404) return null
    throw err
  }
}

export async function deleteArticles(
  ctx: ApiContext,
  blogId: string,
  items: { id: string }[],
): Promise<void> {
  if (!items.length) return
  await fetch$<unknown>(articlesBase(ctx.shopId, blogId), {
    method: 'DELETE',
    body: JSON.stringify(items),
    token: ctx.token,
  })
}

export async function listArticleTags(
  ctx: ApiContext,
  blogId: string,
): Promise<string[]> {
  const r = await fetch$<string[] | null>(
    `${articlesBase(ctx.shopId, blogId)}/tags`,
    { method: 'GET', token: ctx.token },
  )
  return Array.isArray(r) ? r : []
}

// ─── Bulk helpers ─────────────────────────────────────────────────────────

/**
 * Bulk publish/unpublish — loop PUT với concurrency 5.
 */
export async function bulkSetArticlePublished(
  ctx: ApiContext,
  blogId: string,
  ids: string[],
  published: boolean,
): Promise<{ affected: number }> {
  let affected = 0
  const queue = [...ids]
  const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
    while (queue.length) {
      const id = queue.shift()
      if (!id) break
      try {
        const r = await updateArticle(ctx, blogId, { id, published })
        if (r) affected++
      } catch {
        // skip failed items — caller gets reduced count
      }
    }
  })
  await Promise.all(workers)
  return { affected }
}
