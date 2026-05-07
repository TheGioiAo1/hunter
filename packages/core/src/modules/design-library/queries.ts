/**
 * Design Library — read helpers (Phase D1).
 *
 * The two primary entry points drive the /design-library UI:
 *
 *   - `listGallery(db, {category?, limit?})` — SEED cards only (public,
 *     every merchant sees the same list). Filtered by category chip,
 *     sorted alphabetically so the grid is stable across refreshes.
 *
 *   - `listMyClones(db, {shopId, limit?})` — CLONE cards only, scoped
 *     to one shop. Sorted newest-first because the "My Clones" tab is
 *     basically a changelog — the seller just finished a clone and
 *     wants to see it at the top.
 *
 * The single-entry reads (`getEntryBySlug`, `getEntryById`) are used
 * by the preview modal and the Copy/Clone action handlers — they
 * return the full `DesignLibraryEntry` including the heavy preview
 * HTML and DESIGN.md body.
 *
 * All list helpers return the narrow `DesignLibraryCard` shape (no
 * big TEXT columns) so the grid render stays under 1 MB even with 58
 * seed cards plus a shop's clones.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import {
  DESIGN_LIBRARY_CATEGORIES,
  type DesignLibraryCard,
  type DesignLibraryCategory,
  type DesignLibraryEntry,
  type DesignLibrarySource,
  type DesignLibraryStorageTier,
} from './types.js'

// ---------------------------------------------------------------------------
// List — gallery (seed)
// ---------------------------------------------------------------------------

export interface ListGalleryInput {
  /** Category chip filter. Omit for "All". */
  readonly category?: DesignLibraryCategory
  /** Safety cap. Upstream has 58 brands, so 200 is very generous. */
  readonly limit?: number
}

/**
 * Return every SEED entry, optionally filtered by category. The gallery
 * is public by design — Thai locked Q1 to Option A (day-1 public), so
 * no shopId scoping here.
 *
 * Sort: alphabetical by title. Seed brands are well-known ("Airbnb",
 * "Stripe") so alphabetical is the most discoverable order for the
 * end user. Category filter uses the partial index on `category`
 * (migration 049 `idx_design_library_category`) for O(log n) lookup.
 */
export async function listGallery(
  db: Kysely<Database>,
  input: ListGalleryInput = {},
): Promise<readonly DesignLibraryCard[]> {
  const limit = clampLimit(input.limit, 200)

  // Short-circuit BEFORE touching the builder. Callers occasionally
  // forward a raw querystring value that doesn't match any bucket —
  // no need to hit the DB just to return 0 rows.
  if (input.category && !DESIGN_LIBRARY_CATEGORIES.includes(input.category)) {
    return []
  }

  let q = db
    .selectFrom('design_library_entries')
    .select([
      'id',
      'slug',
      'source',
      'shop_id as shopId',
      'title',
      'summary',
      'category',
      'thumbnail_url as thumbnailUrl',
      'storage_tier as storageTier',
      'created_at as createdAt',
      'updated_at as updatedAt',
    ])
    .where('source', '=', 'seed')

  if (input.category) {
    q = q.where('category', '=', input.category)
  }

  const rows = await q
    .orderBy('title', 'asc')
    .limit(limit)
    .execute()

  return rows.map(toCard)
}

// ---------------------------------------------------------------------------
// List — my clones (per-shop)
// ---------------------------------------------------------------------------

export interface ListMyClonesInput {
  readonly shopId: string
  readonly limit?: number
}

/**
 * Return CLONE entries for one shop, newest first. The "My Clones" tab
 * is basically a changelog of every successful clone-pro job that
 * emitted a library row (D2 pipeline hook stamps one per run).
 *
 * The partial unique index `(shop_id, slug) WHERE source = 'clone'`
 * (migration 049 `idx_design_library_clone_slug`) guarantees a shop
 * can't have two rows with the same clone slug — so ORDER BY
 * created_at DESC is stable.
 */
export async function listMyClones(
  db: Kysely<Database>,
  input: ListMyClonesInput,
): Promise<readonly DesignLibraryCard[]> {
  const limit = clampLimit(input.limit, 200)

  const rows = await db
    .selectFrom('design_library_entries')
    .select([
      'id',
      'slug',
      'source',
      'shop_id as shopId',
      'title',
      'summary',
      'category',
      'thumbnail_url as thumbnailUrl',
      'storage_tier as storageTier',
      'created_at as createdAt',
      'updated_at as updatedAt',
    ])
    .where('source', '=', 'clone')
    .where('shop_id', '=', input.shopId)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute()

  return rows.map(toCard)
}

// ---------------------------------------------------------------------------
// Single-entry reads
// ---------------------------------------------------------------------------

export interface GetEntryBySlugInput {
  readonly slug: string
  /**
   * Required for clone lookups (partial unique index is per-shop).
   * Pass undefined for seed lookups — seeds are globally unique.
   */
  readonly shopId?: string
  /** Defaults to 'seed' since the gallery is the most-hit entry point. */
  readonly source?: DesignLibrarySource
}

/**
 * Fetch one full entry by slug. Returns null if not found. This is the
 * helper the preview modal and Copy/Clone action handlers use — it
 * pulls the full DESIGN.md + both preview HTML blobs.
 *
 * Because the UNIQUE constraints are partial (per-source), the caller
 * MUST tell us which source they're looking up or we risk returning
 * the wrong row. Default is 'seed' (the gallery is the hot path).
 */
export async function getEntryBySlug(
  db: Kysely<Database>,
  input: GetEntryBySlugInput,
): Promise<DesignLibraryEntry | null> {
  const source = input.source ?? 'seed'

  // Short-circuit BEFORE touching the builder — clone slugs are shop-
  // scoped and a missing shopId would silently leak another merchant's
  // row. Caller error → null, no DB round-trip.
  if (source === 'clone' && !input.shopId) {
    return null
  }

  let q = db
    .selectFrom('design_library_entries')
    .selectAll()
    .where('slug', '=', input.slug)
    .where('source', '=', source)

  if (source === 'clone') {
    // Narrowed above — shopId is guaranteed defined here.
    q = q.where('shop_id', '=', input.shopId as string)
  } else {
    // Seeds are global — shop_id MUST be null by the check constraint.
    q = q.where('shop_id', 'is', null)
  }

  const row = await q.executeTakeFirst()
  return row ? toEntry(row) : null
}

/**
 * Fetch one full entry by its uuid. Used by the Clone action when the
 * UI already has the row id from the gallery render.
 */
export async function getEntryById(
  db: Kysely<Database>,
  id: string,
): Promise<DesignLibraryEntry | null> {
  const row = await db
    .selectFrom('design_library_entries')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()

  return row ? toEntry(row) : null
}

// ---------------------------------------------------------------------------
// List — featured picks (onboarding Tab 2 hero row)
// ---------------------------------------------------------------------------

export interface ListFeaturedSeedsInput {
  /**
   * Safety cap. The onboarding wizard shows 3-4 picks in practice;
   * default caps at 4 so a well-meaning future curator who bumps the
   * featured set can't accidentally flood the welcome page.
   */
  readonly limit?: number
}

/**
 * Return the curated featured seed entries for the onboarding wizard's
 * Theme Library tab.
 *
 * Query:
 *
 *   SELECT ...
 *   FROM design_library_entries
 *   WHERE source = 'seed' AND featured_rank IS NOT NULL
 *   ORDER BY featured_rank ASC, slug ASC
 *   LIMIT :limit (default 4)
 *
 * The partial index `idx_design_library_featured_rank` (migration 051)
 * makes this an index-only scan — ~4 rows touched. When `featured_rank`
 * is un-seeded (fresh DB before migration 051's seed UPDATEs run, or
 * every pick slug was renamed upstream) the query returns `[]` and the
 * welcome component falls through to its "Theme Library coming soon"
 * empty state.
 *
 * Ties in `featured_rank` are broken by `slug ASC` so the grid layout
 * stays deterministic across page loads.
 */
export async function listFeaturedSeeds(
  db: Kysely<Database>,
  input: ListFeaturedSeedsInput = {},
): Promise<readonly DesignLibraryCard[]> {
  const limit = clampLimit(input.limit, 4)

  const rows = await db
    .selectFrom('design_library_entries')
    .select([
      'id',
      'slug',
      'source',
      'shop_id as shopId',
      'title',
      'summary',
      'category',
      'thumbnail_url as thumbnailUrl',
      'storage_tier as storageTier',
      'created_at as createdAt',
      'updated_at as updatedAt',
    ])
    .where('source', '=', 'seed')
    .where('featured_rank', 'is not', null)
    .orderBy('featured_rank', 'asc')
    .orderBy('slug', 'asc')
    .limit(limit)
    .execute()

  return rows.map(toCard)
}

// ---------------------------------------------------------------------------
// Count helpers (gallery header badges — "Showing 58 brands")
// ---------------------------------------------------------------------------

/** Total seed entries — the gallery header shows this as a badge. */
export async function countSeedEntries(db: Kysely<Database>): Promise<number> {
  const row = await db
    .selectFrom('design_library_entries')
    .select((eb) => eb.fn.countAll<number>().as('c'))
    .where('source', '=', 'seed')
    .executeTakeFirst()
  return Number(row?.c ?? 0)
}

/** Seed entries per category — feeds the category chip counts. */
export async function countSeedEntriesByCategory(
  db: Kysely<Database>,
): Promise<Readonly<Record<DesignLibraryCategory, number>>> {
  const rows = await db
    .selectFrom('design_library_entries')
    .select(['category', (eb) => eb.fn.countAll<number>().as('c')])
    .where('source', '=', 'seed')
    .where('category', 'is not', null)
    .groupBy('category')
    .execute()

  const out: Record<DesignLibraryCategory, number> = {
    ecom: 0,
    ai: 0,
    devtool: 0,
    saas: 0,
    media: 0,
    finance: 0,
    social: 0,
    travel: 0,
    lifestyle: 0,
  }
  for (const r of rows) {
    const c = r.category as DesignLibraryCategory | null
    if (c && c in out) out[c] = Number(r.c)
  }
  return out
}

// ---------------------------------------------------------------------------
// Row → domain conversion
// ---------------------------------------------------------------------------

function toCard(row: {
  id: string
  slug: string
  source: string
  shopId: string | null
  title: string
  summary: string | null
  category: string | null
  thumbnailUrl: string | null
  storageTier: string
  createdAt: string | Date
  updatedAt: string | Date
}): DesignLibraryCard {
  return {
    id: row.id,
    slug: row.slug,
    source: row.source as DesignLibrarySource,
    shopId: row.shopId,
    title: row.title,
    summary: row.summary,
    category: (row.category as DesignLibraryCategory | null) ?? null,
    thumbnailUrl: row.thumbnailUrl,
    storageTier: row.storageTier as DesignLibraryStorageTier,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  }
}

function toEntry(row: Record<string, unknown>): DesignLibraryEntry {
  return {
    id: String(row.id),
    slug: String(row.slug),
    source: row.source as DesignLibrarySource,
    shopId: (row.shop_id as string | null) ?? null,
    title: String(row.title),
    summary: (row.summary as string | null) ?? null,
    category: (row.category as DesignLibraryCategory | null) ?? null,
    designMd: String(row.design_md ?? ''),
    previewHtml: (row.preview_html as string | null) ?? null,
    previewDarkHtml: (row.preview_dark_html as string | null) ?? null,
    previewHtmlUrl: (row.preview_html_url as string | null) ?? null,
    previewDarkHtmlUrl: (row.preview_dark_html_url as string | null) ?? null,
    thumbnailUrl: (row.thumbnail_url as string | null) ?? null,
    storageTier: (row.storage_tier as DesignLibraryStorageTier) ?? 'hot',
    sourceThemeId: (row.source_theme_id as string | null) ?? null,
    sourceCloneJobId: (row.source_clone_job_id as string | null) ?? null,
    upstreamSha: (row.upstream_sha as string | null) ?? null,
    createdAt: toIso(row.created_at as string | Date),
    updatedAt: toIso(row.updated_at as string | Date),
  }
}

function toIso(v: string | Date): string {
  if (v instanceof Date) return v.toISOString()
  return v
}

function clampLimit(raw: number | undefined, max: number): number {
  if (raw === undefined) return max
  if (!Number.isFinite(raw) || raw <= 0) return max
  return Math.min(Math.floor(raw), max)
}
