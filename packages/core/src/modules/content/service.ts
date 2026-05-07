/**
 * Gbox Platform — Content (CMS) Service
 *
 * Pages, blog posts, menus, menu items, and file uploads.
 */

import { PageApi } from '@gbox/api-client'

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export type Page = any // TODO: Map to PageApi.Page
export type BlogPost = any // TODO: Map to PageApi.BlogPost
export type Menu = any // TODO: Map to PageApi.Menu
export type MenuItem = any // TODO: Map to PageApi.MenuItem
export type File = any // TODO: Map to PageApi.File

export interface Pagination {
  limit?: number
  offset?: number
}

export interface CreatePageInput {
  title: string
  slug: string
  body_html?: string | null
  author?: string | null
  template_suffix?: string | null
  published?: boolean
  // Migration 036 — SEO override fields. NULL means "fall back to title /
  // first paragraph of body at render time". Blank strings from forms are
  // coerced to NULL by createPage / updatePage so the renderer always sees
  // NULL-vs-value, never empty string.
  seo_title?: string | null
  seo_description?: string | null
}

export interface UpdatePageInput {
  title?: string
  slug?: string
  body_html?: string | null
  author?: string | null
  template_suffix?: string | null
  published?: boolean
  seo_title?: string | null
  seo_description?: string | null
}

export interface CreateBlogPostInput {
  title: string
  slug: string
  body_html?: string | null
  excerpt?: string | null
  author?: string | null
  tags?: string[] | null
  image_url?: string | null
  published?: boolean
  published_at?: string | null
  // Migration 036 — SEO override fields (same semantics as pages).
  seo_title?: string | null
  seo_description?: string | null
}

export interface UpdateBlogPostInput {
  title?: string
  slug?: string
  body_html?: string | null
  excerpt?: string | null
  author?: string | null
  tags?: string[] | null
  image_url?: string | null
  published?: boolean
  published_at?: string | null
  seo_title?: string | null
  seo_description?: string | null
}

/**
 * Bulk actions supported by `bulkUpdatePages` / `bulkUpdateBlogPosts`.
 *
 * - `publish` / `unpublish` — set `published` to true/false; for blog also
 *   stamps `published_at` to now on publish, nulls it on unpublish.
 * - `delete` — hard delete (pages+blog have no `deleted_at` column in the
 *   current schema; if soft-delete is ever added the semantics change).
 */
export type BulkContentAction = 'publish' | 'unpublish' | 'delete'

export interface BulkResult {
  /** How many rows the DB reported as affected. */
  affected: number
  /** The action that ran. */
  action: BulkContentAction
}

export interface BlogPostFilters {
  published?: boolean
  tag?: string
  search?: string
}

export interface CreateMenuInput {
  title: string
  slug: string
}

export interface UpdateMenuInput {
  title?: string
  slug?: string
}

export interface AddMenuItemInput {
  parent_id?: string | null
  title: string
  url?: string | null
  resource_type?: string | null
  resource_id?: string | null
  position?: number
}

export interface MenuWithItems extends Menu {
  items: MenuItem[]
}

export interface CreateFileInput {
  filename: string
  mime_type?: string | null
  size?: number | null
  url: string
  alt?: string | null
}

// ---------------------------------------------------------------------------
// Helpers — input normalisation
// ---------------------------------------------------------------------------

/**
 * Coerce a string-from-form to NULL when blank/whitespace-only, else trim
 * and return it. The SEO columns are nullable in the DB and the storefront
 * renderer treats NULL as "fall back to defaults" — empty-string would
 * short-circuit that fallback, which is not what the merchant intended when
 * they just didn't type anything.
 */
function blankToNull(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null
  const trimmed = v.trim()
  return trimmed.length === 0 ? null : trimmed
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/**
 * Create a new page.
 */
export async function createPage(
  _db: any,
  shopId: string,
  data: CreatePageInput,
): Promise<Page> {
  const row = await PageApi.PageService.postApi({
    shopId,
    requestBody: {
      title: data.title,
      slug: data.slug,
      content: data.body_html ?? null,
      // author: data.author ?? null, // TODO: Map to API
      // template_suffix: data.template_suffix ?? null, // TODO: Map to API
      is_active: data.published ?? false,
      // seo_title: blankToNull(data.seo_title),
      // seo_description: blankToNull(data.seo_description),
    } as any,
  })

  return row as Page
}

/**
 * Get a page by slug.
 */
export async function getPage(
  _db: any,
  shopId: string,
  slug: string,
): Promise<Page | null> {
  const row = await PageApi.PageService.getApi1({
    shopId,
    idOrSlug: slug,
  })

  return (row as Page) ?? null
}

/**
 * Update a page by ID. Blank SEO fields from a form POST are coerced to
 * NULL so the storefront renderer's fallback path kicks in.
 */
export async function updatePage(
  _db: any,
  shopId: string,
  pageId: string,
  data: UpdatePageInput,
): Promise<Page> {
  const patch: any = { ...data, id: pageId }
  
  const row = await PageApi.PageService.putApi({
    shopId,
    requestBody: patch,
  })

  return row as Page
}

/**
 * Apply a bulk action to a set of pages owned by `shopId`.
 *
 * Contract:
 * - Empty `ids` short-circuits to `{ affected: 0 }` (no DB round-trip).
 * - Every mutation is scoped by `shop_id = shopId` so a caller who tries
 *   to smuggle in an id from another shop simply gets zero rows affected.
 * - `publish` / `unpublish` stamp `updated_at` so the admin list re-sorts
 *   correctly.
 * - `delete` is a hard delete (pages have no soft-delete column yet).
 *
 * The action is represented as a plain string on the wire so admin POST
 * handlers can dispatch without importing the type union.
 */
export async function bulkUpdatePages(
  _db: any,
  shopId: string,
  ids: string[],
  action: BulkContentAction,
): Promise<BulkResult> {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { affected: 0, action }
  }

  if (action === 'delete') {
    await PageApi.PageService.deleteApi({
      shopId,
      requestBody: ids.map(id => ({ id } as any)),
    })
    return { affected: ids.length, action }
  }

  // TODO: Map to API [PageService.bulkUpdate]
  return { affected: 0, action }
}

/**
 * Delete a page by ID.
 */
export async function deletePage(
  _db: any,
  shopId: string,
  pageId: string,
): Promise<void> {
  await PageApi.PageService.deleteApi({
    shopId,
    requestBody: [{ id: pageId } as any],
  })
}

/**
 * List pages for a shop with pagination.
 */
export async function listPages(
  _db: any,
  shopId: string,
  pagination: Pagination = {},
): Promise<{ pages: Page[]; total: number }> {
  const { limit = 50, offset = 0 } = pagination

  const res = await PageApi.PageService.getApi({
    shopId,
    limit,
    page: Math.floor(offset / limit) + 1,
  })

  return {
    pages: res.items as Page[],
    total: res.total ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Blog Posts
// ---------------------------------------------------------------------------

/**
 * Normalise an array of tags: trim, drop blanks, dedup case-insensitively
 * while preserving the original case of the first occurrence. Returns
 * `null` if the resulting set is empty, so storing "no tags" matches the
 * DB's NULL default rather than an empty array.
 */
export function normaliseTags(tags: string[] | null | undefined): string[] | null {
  if (!Array.isArray(tags)) return null
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out.length === 0 ? null : out
}

/**
 * Create a new blog post.
 */
export async function createBlogPost(
  _db: any,
  shopId: string,
  data: CreateBlogPostInput,
): Promise<BlogPost> {
  // TODO: Map to API [BlogPostService.create]
  return {} as any
}

/**
 * Get a blog post by slug.
 */
export async function getBlogPost(
  _db: any,
  shopId: string,
  slug: string,
): Promise<BlogPost | null> {
  // TODO: Map to API [BlogPostService.get]
  return null
}

/**
 * Update a blog post by ID. SEO blanks → NULL, tags are normalised
 * (trim + dedup) before write.
 */
export async function updateBlogPost(
  _db: any,
  shopId: string,
  postId: string,
  data: UpdateBlogPostInput,
): Promise<BlogPost> {
  // TODO: Map to API [BlogPostService.update]
  return {} as any
}

/**
 * Apply a bulk action to a set of blog posts owned by `shopId`.
 *
 * `publish` stamps `published_at = now()` if it isn't already set so the
 * post's "first published at" sort key is real, not just `updated_at`.
 * `unpublish` nulls `published_at` so a subsequent re-publish gets a
 * fresh stamp — matches Shopify behaviour.
 */
export async function bulkUpdateBlogPosts(
  _db: any,
  shopId: string,
  ids: string[],
  action: BulkContentAction,
): Promise<BulkResult> {
  // TODO: Map to API [BlogPostService.bulkUpdate]
  return { affected: 0, action }
}

/**
 * Delete a blog post by ID.
 */
export async function deleteBlogPost(
  _db: any,
  shopId: string,
  postId: string,
): Promise<void> {
  // TODO: Map to API [BlogPostService.delete]
}

/**
 * List blog posts with optional filters and pagination.
 */
export async function listBlogPosts(
  _db: any,
  shopId: string,
  filters: BlogPostFilters = {},
  pagination: Pagination = {},
): Promise<{ posts: BlogPost[]; total: number }> {
  // TODO: Map to API [BlogPostService.list]
  return { posts: [], total: 0 }
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

/**
 * Create a new menu.
 */
export async function createMenu(
  _db: any,
  shopId: string,
  data: CreateMenuInput,
): Promise<Menu> {
  // TODO: Map to API [MenuService.create]
  return {} as any
}

/**
 * Get a menu by slug, including all menu items sorted by position.
 */
export async function getMenu(
  _db: any,
  shopId: string,
  slug: string,
): Promise<MenuWithItems | null> {
  // TODO: Map to API [MenuService.get]
  return null
}

/**
 * Update a menu by ID.
 */
export async function updateMenu(
  _db: any,
  shopId: string,
  menuId: string,
  data: UpdateMenuInput,
): Promise<Menu> {
  // TODO: Map to API [MenuService.update]
  return {} as any
}

/**
 * Add a menu item to a menu.
 */
export async function addMenuItem(
  _db: any,
  menuId: string,
  data: AddMenuItemInput,
): Promise<MenuItem> {
  // TODO: Map to API [MenuService.addItem]
  return {} as any
}

/**
 * Reorder menu items by setting the position for each item ID in the given order.
 */
export async function reorderMenuItems(
  _db: any,
  menuId: string,
  itemIds: string[],
): Promise<void> {
  // TODO: Map to API [MenuService.reorderItems]
}

/**
 * Delete a menu item.
 */
export async function deleteMenuItem(
  _db: any,
  itemId: string,
): Promise<void> {
  // TODO: Map to API [MenuService.deleteItem]
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Create a file record.
 */
export async function uploadFile(
  _db: any,
  shopId: string,
  data: CreateFileInput,
): Promise<File> {
  // TODO: Map to API [FileService.upload]
  return {} as any
}

/**
 * List all files for a shop.
 */
export async function listFiles(
  _db: any,
  shopId: string,
): Promise<File[]> {
  // TODO: Map to API [FileService.list]
  return []
}

