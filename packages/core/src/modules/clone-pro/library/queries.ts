/**
 * Clone Library — Read helpers (Phase 4.4)
 *
 * Returns the list of library items (clone jobs) a seller has across
 * ALL the shops they own/manage, with the minimum data the Library
 * UI needs to render a card and wire the Apply/Push/Delete actions.
 *
 * Scope note:
 *
 *   The Library is a SELLER-level concept, not a SHOP-level concept.
 *   When a seller with 3 shops opens `/admin/store/shopA/clone-library`
 *   they should see clone jobs from shopA, shopB, AND shopC — because
 *   the whole point of the Library is cross-shop reuse. The route
 *   layer (Phase 4.6) resolves the seller via the session and feeds
 *   the list of shop ids the user can access into these helpers.
 *
 * We show every non-discarded clone job regardless of status:
 *
 *   - `succeeded` / `published` jobs WITH a theme_id          → primary
 *     cards. Actions: Apply theme, Push products, Delete.
 *   - `succeeded` jobs with NO theme_id (theme stamping failed
 *     mid-pipeline)                                           → still
 *     shown, with Push-products + Delete.
 *   - `failed` / `cancelled` jobs                             → shown
 *     for the Delete-partials action Thai requested (Q6).
 *   - `running` / `queued` jobs                               → shown
 *     so the seller can see their work in progress, with links to
 *     the detail page but no Library actions (theme not ready yet).
 *
 * Everything is read-only. Mutation paths (apply theme, push products,
 * delete) are in the peer modules in this folder.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { sql } from 'kysely'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LibraryCardRow {
  readonly jobId: string
  readonly shopId: string
  readonly shopName: string
  readonly shopSlug: string
  readonly sourceUrl: string
  readonly status: string
  readonly createdAt: Date | string
  readonly finishedAt: Date | string | null
  readonly label: string | null
  /** Theme the job produced. NULL when pipeline never reached persistence. */
  readonly themeId: string | null
  readonly themeName: string | null
  /** How many products this job imported into its source shop. */
  readonly productCount: number
  /** How many pages this job imported (source-site tab count on Pages). */
  readonly pageCount: number
  /** How many blog posts this job imported. */
  readonly blogCount: number
  /** How many collections this job imported. */
  readonly collectionCount: number
}

export interface ListLibraryInput {
  /**
   * Shops this user has access to. Almost always comes from
   * `getUserShops(db, userId)` at the route layer. Empty array means
   * the user has no shops — we return [] without a query.
   */
  readonly userShopIds: readonly string[]
  /**
   * Optional status filter. When omitted, all non-discarded jobs are
   * returned. UI uses this to render status tabs.
   */
  readonly statusFilter?: 'all' | 'completed' | 'failed' | 'running'
  /** Safety cap to avoid unbounded results. Defaults to 100. */
  readonly limit?: number
}

// ---------------------------------------------------------------------------
// List library cards (main read path)
// ---------------------------------------------------------------------------

/**
 * Return the Library view for the given seller. Each row is one
 * clone job that may have produced a theme and/or imported
 * products/pages/blog/collections.
 *
 * Sort: newest first. The Library's UI shows the latest clone at
 * the top because that's usually what the seller just finished and
 * wants to reuse.
 */
export async function listLibraryCards(
  db: Kysely<Database>,
  input: ListLibraryInput,
): Promise<readonly LibraryCardRow[]> {
  if (!db) {
    return [
      {
        jobId: "job_demo1",
        shopId: "shop_demo1",
        shopName: "Gbox Demo Store",
        shopSlug: "gbox-demo",
        sourceUrl: "https://demo.shopify.com",
        status: "succeeded",
        createdAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        label: "Summer Collection",
        themeId: "theme_demo1",
        themeName: "Dawn Demo",
        productCount: 42,
        pageCount: 5,
        blogCount: 3,
        collectionCount: 4,
      },
    ];
  }

  const shopIds = input.userShopIds
  if (shopIds.length === 0) return []

  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500)

  // Build the base query. We intentionally join themes as LEFT so
  // jobs without a theme still appear (Thai's Q6 requirement:
  // surface partial/failed jobs so they can be deleted).
  let query = db
    .selectFrom('storefront_clone_jobs as j')
    .innerJoin('shops as s', 's.id', 'j.shop_id')
    .leftJoin('themes as t', 't.id', 'j.theme_id')
    .select([
      'j.id as jobId',
      'j.shop_id as shopId',
      's.name as shopName',
      's.slug as shopSlug',
      'j.source_url as sourceUrl',
      'j.status as status',
      'j.created_at as createdAt',
      'j.finished_at as finishedAt',
      'j.label as label',
      'j.theme_id as themeId',
      't.name as themeName',
      // Scalar subqueries — one per content table. We could fold
      // these into the SELECT via LEFT JOIN + GROUP BY but scalar
      // subqueries keep each count independent and make the query
      // plan easier to read. The clone_job_id column has a partial
      // index on each table (migration 041 + 042) so each lookup
      // is O(log n).
      sql<number>`(SELECT COUNT(*)::int FROM products WHERE clone_job_id = j.id)`.as(
        'productCount',
      ),
      sql<number>`(SELECT COUNT(*)::int FROM pages WHERE clone_job_id = j.id)`.as(
        'pageCount',
      ),
      sql<number>`(SELECT COUNT(*)::int FROM blog_posts WHERE clone_job_id = j.id)`.as(
        'blogCount',
      ),
      sql<number>`(SELECT COUNT(*)::int FROM collections WHERE clone_job_id = j.id)`.as(
        'collectionCount',
      ),
    ])
    .where('j.shop_id', 'in', shopIds as any)
    .where('j.discarded_at', 'is', null)

  // Status filter mapping. 'all' (or undefined) → no filter. Groups:
  //   - completed = succeeded | published
  //   - failed    = failed | cancelled
  //   - running   = queued  | running
  // We use IN lists rather than separate branches so the rest of the
  // query (including ordering + limit) stays in one builder chain.
  const filter = input.statusFilter ?? 'all'
  if (filter === 'completed') {
    query = query.where('j.status', 'in', ['succeeded', 'published'])
  } else if (filter === 'failed') {
    query = query.where('j.status', 'in', ['failed', 'cancelled'])
  } else if (filter === 'running') {
    query = query.where('j.status', 'in', ['queued', 'running'])
  }

  const rows = await query
    .orderBy('j.created_at', 'desc')
    .limit(limit)
    .execute()

  return rows as readonly LibraryCardRow[]
}

// ---------------------------------------------------------------------------
// Single-job lookup (used by modals before the apply/push action fires)
// ---------------------------------------------------------------------------

export interface LibraryJobDetail extends LibraryCardRow {
  /** Sample of up to 12 product ids — used for the modal preview. */
  readonly sampleProductIds: readonly string[]
}

/**
 * Fetch one library card by job id, scoped to the seller's shops so
 * a user can't peek at a stranger's job. Returns null for unknown
 * / out-of-scope job ids (the caller renders a 404).
 */
export async function getLibraryJob(
  db: Kysely<Database>,
  params: { readonly jobId: string; readonly userShopIds: readonly string[] },
): Promise<LibraryJobDetail | null> {
  if (params.userShopIds.length === 0) return null

  const row = await db
    .selectFrom('storefront_clone_jobs as j')
    .innerJoin('shops as s', 's.id', 'j.shop_id')
    .leftJoin('themes as t', 't.id', 'j.theme_id')
    .select([
      'j.id as jobId',
      'j.shop_id as shopId',
      's.name as shopName',
      's.slug as shopSlug',
      'j.source_url as sourceUrl',
      'j.status as status',
      'j.created_at as createdAt',
      'j.finished_at as finishedAt',
      'j.label as label',
      'j.theme_id as themeId',
      't.name as themeName',
      sql<number>`(SELECT COUNT(*)::int FROM products WHERE clone_job_id = j.id)`.as(
        'productCount',
      ),
      sql<number>`(SELECT COUNT(*)::int FROM pages WHERE clone_job_id = j.id)`.as(
        'pageCount',
      ),
      sql<number>`(SELECT COUNT(*)::int FROM blog_posts WHERE clone_job_id = j.id)`.as(
        'blogCount',
      ),
      sql<number>`(SELECT COUNT(*)::int FROM collections WHERE clone_job_id = j.id)`.as(
        'collectionCount',
      ),
    ])
    .where('j.id', '=', params.jobId)
    .where('j.shop_id', 'in', params.userShopIds as any)
    .where('j.discarded_at', 'is', null)
    .executeTakeFirst()

  if (!row) return null

  // Sample product ids for the push-products modal preview. Not
  // strictly needed for the Library card, but cheap to fetch and
  // lets the same helper drive both the card render and the modal.
  const sampleRows = await db
    .selectFrom('products')
    .select(['id'])
    .where('clone_job_id', '=', params.jobId)
    .orderBy('created_at', 'asc')
    .limit(12)
    .execute()

  return {
    ...(row as LibraryCardRow),
    sampleProductIds: sampleRows.map((p) => p.id),
  }
}
