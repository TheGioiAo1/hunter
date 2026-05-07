/**
 * Theme Customizer — Picker Search
 *
 * Sprint 8 PR-D: lightweight resource lookups for the right-panel
 * picker inputs (product / collection / page / blog / article).
 *
 * Each picker hits ONE of these endpoints with `?q=<term>&limit=20`
 * and gets back a uniform `{ items: PickerItem[] }` shape so the
 * client renderer can stay generic. Cross-shop probe defence is the
 * caller's job — we only return rows scoped to `shopId`.
 *
 * Why a separate module vs. reusing listProducts/listCollections etc?
 *   • The picker only needs id + handle + title + thumb. Returning
 *     the full row is wasteful (a typical product is 5-15 KB).
 *   • The pickers want a STABLE shape across resource types. The
 *     existing list services have idiosyncratic shapes — adapting
 *     them in the route handlers would scatter the mapping logic.
 *
 * Iron Rule 5: throws native Error; caller wraps via safeMessage.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'

export interface PickerItem {
  id: string
  /** URL-safe handle (slug) — what gets persisted into settings_json. */
  handle: string
  /** Human-readable title for the dropdown row. */
  title: string
  /** Optional 80x80 thumbnail URL (products + collections + articles). */
  thumb?: string | null
  /** Resource-specific metadata for the row's secondary line. */
  meta?: string
}

export interface PickerResult {
  items: PickerItem[]
}

const MAX_LIMIT = 50

function clampLimit(raw: unknown, fallback: number = 20): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)))
}

function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&')
}

function mkPattern(q: string): string {
  return `%${escapeLike(q)}%`
}

// ─── Products ───────────────────────────────────────────────────────────

export async function searchProducts(
  db: Kysely<Database>,
  shopId: string,
  q: string,
  limit: number = 20,
): Promise<PickerResult> {
  let qb = (db as any)
    .selectFrom('products')
    .select(['id', 'handle', 'title', 'status'])
    .where('shop_id', '=', shopId)
    .where('status', '=', 'active')
  if (q) qb = qb.where('title', 'ilike', mkPattern(q))
  const rows = (await qb.orderBy('title', 'asc').limit(clampLimit(limit)).execute()) as Array<{
    id: string
    handle: string
    title: string
    status: string
  }>
  return {
    items: rows.map((r) => ({
      id: r.id,
      handle: r.handle,
      title: r.title,
      meta: r.status,
    })),
  }
}

// ─── Collections ────────────────────────────────────────────────────────

export async function searchCollections(
  db: Kysely<Database>,
  shopId: string,
  q: string,
  limit: number = 20,
): Promise<PickerResult> {
  let qb = (db as any)
    .selectFrom('collections')
    .select(['id', 'handle', 'title'])
    .where('shop_id', '=', shopId)
  if (q) qb = qb.where('title', 'ilike', mkPattern(q))
  const rows = (await qb.orderBy('title', 'asc').limit(clampLimit(limit)).execute()) as Array<{
    id: string
    handle: string
    title: string
  }>
  return {
    items: rows.map((r) => ({ id: r.id, handle: r.handle, title: r.title })),
  }
}

// ─── Pages ──────────────────────────────────────────────────────────────

export async function searchPages(
  db: Kysely<Database>,
  shopId: string,
  q: string,
  limit: number = 20,
): Promise<PickerResult> {
  let qb = (db as any)
    .selectFrom('pages')
    .select(['id', 'handle', 'title'])
    .where('shop_id', '=', shopId)
  if (q) qb = qb.where('title', 'ilike', mkPattern(q))
  const rows = (await qb.orderBy('title', 'asc').limit(clampLimit(limit)).execute()) as Array<{
    id: string
    handle: string
    title: string
  }>
  return {
    items: rows.map((r) => ({ id: r.id, handle: r.handle, title: r.title })),
  }
}

// ─── Blogs ──────────────────────────────────────────────────────────────

export async function searchBlogs(
  db: Kysely<Database>,
  shopId: string,
  q: string,
  limit: number = 20,
): Promise<PickerResult> {
  let qb = (db as any)
    .selectFrom('blogs')
    .select(['id', 'handle', 'title'])
    .where('shop_id', '=', shopId)
  if (q) qb = qb.where('title', 'ilike', mkPattern(q))
  const rows = (await qb.orderBy('title', 'asc').limit(clampLimit(limit)).execute()) as Array<{
    id: string
    handle: string
    title: string
  }>
  return {
    items: rows.map((r) => ({ id: r.id, handle: r.handle, title: r.title })),
  }
}

// ─── Articles (blog posts) ──────────────────────────────────────────────

export async function searchArticles(
  db: Kysely<Database>,
  shopId: string,
  q: string,
  limit: number = 20,
): Promise<PickerResult> {
  let qb = (db as any)
    .selectFrom('blog_posts as bp')
    .leftJoin('blogs as b', 'b.id', 'bp.blog_id')
    .select(['bp.id as id', 'bp.handle as handle', 'bp.title as title', 'b.title as blog_title'])
    .where('bp.shop_id', '=', shopId)
  if (q) qb = qb.where('bp.title', 'ilike', mkPattern(q))
  const rows = (await qb.orderBy('bp.title', 'asc').limit(clampLimit(limit)).execute()) as Array<{
    id: string
    handle: string
    title: string
    blog_title: string | null
  }>
  return {
    items: rows.map((r) => ({
      id: r.id,
      handle: r.handle,
      title: r.title,
      meta: r.blog_title ?? undefined,
    })),
  }
}

// Internal helpers exported for tests.
export const __test = { clampLimit, escapeLike, mkPattern }
