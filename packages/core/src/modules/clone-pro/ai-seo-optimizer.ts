/**
 * Clone Pro — AI SEO Optimizer (Stage 9)
 *
 * When a site is cloned, the imported products/pages/collections/posts
 * inherit whatever meta the source had — usually generic or missing.
 * This module calls the AI bridge to mint tuned `<title>` + meta
 * description for every item that doesn't already have an explicit
 * override, and writes the result to the corresponding `seo_title` +
 * `seo_description` columns (migrations 014 + 036).
 *
 * Design goals
 * ------------
 *
 *   1. Idempotent. Running a second time on the same shop only touches
 *      items that are still missing SEO — already-optimized rows and
 *      merchant-edited rows are left alone.
 *
 *   2. Non-fatal. An AI failure on one product never fails the whole
 *      stage. We log a warning and move on; the caller sees a
 *      `failed` count in the result.
 *
 *   3. Budget-respectful. Callers pass a hard `maxItems` per entity type
 *      (defaults to 100) so a runaway shop with 50,000 products can't
 *      empty the AI budget in one pipeline run. Subsequent clone runs
 *      or a dedicated "optimize remaining" job pick up where this left
 *      off.
 *
 *   4. Provider-agnostic. We call through the `AIBridge` interface —
 *      whichever provider the shop configured. The bridge itself goes
 *      through the new `AIRouter`, so fallback + cost tracking apply
 *      automatically.
 *
 * Persistence
 * -----------
 *
 * Each entity gets updated in-place:
 *
 *   UPDATE products    SET seo_title = ?, seo_description = ? WHERE id = ?
 *   UPDATE pages       SET seo_title = ?, seo_description = ? WHERE id = ?
 *   UPDATE collections SET seo_title = ?, seo_description = ? WHERE id = ?
 *   UPDATE blog_posts  SET seo_title = ?, seo_description = ? WHERE id = ?
 *
 * The generated values are character-capped (60 for title, 155 for
 * description) at write time — the AI sometimes drifts past these,
 * and Google doesn't render longer snippets anyway.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { AIBridge } from './ai-bridge.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SeoOptimizerInput {
  readonly db: Kysely<Database>
  readonly shopId: string
  readonly ai: AIBridge
  /**
   * Hard cap on items optimized per entity type in a single run.
   * Defaults to 100. Items with an existing `seo_title` value don't
   * count toward the cap — they are skipped outright.
   */
  readonly maxItemsPerEntity?: number
  /**
   * When true, the optimizer does everything except the final UPDATE.
   * Useful for previewing cost estimates. Defaults to false.
   */
  readonly dryRun?: boolean
  /**
   * Progress callback. Called before each AI call with the 1-based
   * index and the entity being optimized ("product:The Red Shoe").
   */
  readonly onProgress?: (
    done: number,
    total: number,
    label: string,
  ) => void
}

export interface SeoOptimizerResult {
  readonly productsOptimized: number
  readonly pagesOptimized: number
  readonly collectionsOptimized: number
  readonly blogPostsOptimized: number
  /** Items that already had a seo_title — skipped without calling AI. */
  readonly alreadyOptimized: number
  /** Items where the AI call or persistence raised. */
  readonly failed: number
  /** Per-entity sub-totals in case callers want a breakdown. */
  readonly byEntity: Readonly<Record<Entity, EntityStat>>
}

export type Entity = 'product' | 'page' | 'collection' | 'blog_post'

export interface EntityStat {
  readonly optimized: number
  readonly alreadyOptimized: number
  readonly failed: number
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const MAX_TITLE_CHARS = 60
const MAX_DESCRIPTION_CHARS = 155
const DEFAULT_MAX_ITEMS = 100

/**
 * Walk every imported entity type that's missing SEO meta, call the AI
 * bridge to generate it, and persist the result. See module docstring
 * for semantics.
 */
export async function optimizeSeoForShop(
  input: SeoOptimizerInput,
): Promise<SeoOptimizerResult> {
  const limit = input.maxItemsPerEntity ?? DEFAULT_MAX_ITEMS

  // Fetch all candidates up-front so we can report a proper `total`
  // to the progress callback. This is fine for the default limit
  // (400 rows across 4 entity types); if a future pipeline wants to
  // optimize 10,000 products, it should stream rows instead.
  const products = await fetchProductsMissingSeo(input.db, input.shopId, limit)
  const pages = await fetchPagesMissingSeo(input.db, input.shopId, limit)
  const collections = await fetchCollectionsMissingSeo(input.db, input.shopId, limit)
  const blogPosts = await fetchBlogPostsMissingSeo(input.db, input.shopId, limit)

  const totalCandidates =
    products.length + pages.length + collections.length + blogPosts.length

  const byEntity: Record<Entity, { optimized: number; alreadyOptimized: number; failed: number }> = {
    product: { optimized: 0, alreadyOptimized: 0, failed: 0 },
    page: { optimized: 0, alreadyOptimized: 0, failed: 0 },
    collection: { optimized: 0, alreadyOptimized: 0, failed: 0 },
    blog_post: { optimized: 0, alreadyOptimized: 0, failed: 0 },
  }

  let done = 0

  // Helper that handles progress + try/catch for a single item.
  async function optimize(
    entity: Entity,
    id: string,
    title: string,
    body: string,
    persist: (title: string, description: string) => Promise<void>,
  ): Promise<void> {
    done += 1
    input.onProgress?.(done, totalCandidates, `${entity}:${title}`)

    try {
      const meta = await input.ai.generateSeoMeta(title, body)
      const seoTitle = truncate(meta.title || title, MAX_TITLE_CHARS)
      const seoDescription = truncate(meta.description, MAX_DESCRIPTION_CHARS)

      if (!seoTitle || !seoDescription) {
        // AI returned empty — treat as a failure so counts are honest.
        byEntity[entity].failed += 1
        return
      }

      if (!input.dryRun) {
        await persist(seoTitle, seoDescription)
      }
      byEntity[entity].optimized += 1
    } catch (err) {
      byEntity[entity].failed += 1
      // Non-fatal: log once per item for diagnostics, keep going.
      // eslint-disable-next-line no-console
      console.warn(
        `[ai-seo-optimizer] ${entity}:${id} failed:`,
        (err as Error).message,
      )
    }
  }

  for (const p of products) {
    await optimize('product', p.id, p.title, p.body_html ?? '', (t, d) =>
      updateProductSeo(input.db, p.id, t, d),
    )
  }
  for (const p of pages) {
    await optimize('page', p.id, p.title, p.body_html ?? '', (t, d) =>
      updatePageSeo(input.db, p.id, t, d),
    )
  }
  for (const c of collections) {
    await optimize('collection', c.id, c.title, c.body_html ?? '', (t, d) =>
      updateCollectionSeo(input.db, c.id, t, d),
    )
  }
  for (const b of blogPosts) {
    await optimize(
      'blog_post',
      b.id,
      b.title,
      b.body_html ?? b.excerpt ?? '',
      (t, d) => updateBlogPostSeo(input.db, b.id, t, d),
    )
  }

  return {
    productsOptimized: byEntity.product.optimized,
    pagesOptimized: byEntity.page.optimized,
    collectionsOptimized: byEntity.collection.optimized,
    blogPostsOptimized: byEntity.blog_post.optimized,
    alreadyOptimized:
      byEntity.product.alreadyOptimized +
      byEntity.page.alreadyOptimized +
      byEntity.collection.alreadyOptimized +
      byEntity.blog_post.alreadyOptimized,
    failed:
      byEntity.product.failed +
      byEntity.page.failed +
      byEntity.collection.failed +
      byEntity.blog_post.failed,
    byEntity,
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

async function fetchProductsMissingSeo(
  db: Kysely<Database>,
  shopId: string,
  limit: number,
): Promise<Array<{ id: string; title: string; body_html: string | null }>> {
  return db
    .selectFrom('products')
    .select(['id', 'title', 'body_html'])
    .where('shop_id', '=', shopId)
    .where((eb) =>
      eb.or([eb('seo_title', 'is', null), eb('seo_description', 'is', null)]),
    )
    .limit(limit)
    .execute()
}

async function fetchPagesMissingSeo(
  db: Kysely<Database>,
  shopId: string,
  limit: number,
): Promise<Array<{ id: string; title: string; body_html: string | null }>> {
  return db
    .selectFrom('pages')
    .select(['id', 'title', 'body_html'])
    .where('shop_id', '=', shopId)
    .where((eb) =>
      eb.or([eb('seo_title', 'is', null), eb('seo_description', 'is', null)]),
    )
    .limit(limit)
    .execute()
}

async function fetchCollectionsMissingSeo(
  db: Kysely<Database>,
  shopId: string,
  limit: number,
): Promise<Array<{ id: string; title: string; body_html: string | null }>> {
  return db
    .selectFrom('collections')
    .select(['id', 'title', 'body_html'])
    .where('shop_id', '=', shopId)
    .where((eb) =>
      eb.or([eb('seo_title', 'is', null), eb('seo_description', 'is', null)]),
    )
    .limit(limit)
    .execute()
}

async function fetchBlogPostsMissingSeo(
  db: Kysely<Database>,
  shopId: string,
  limit: number,
): Promise<Array<{ id: string; title: string; body_html: string | null; excerpt: string | null }>> {
  return db
    .selectFrom('blog_posts')
    .select(['id', 'title', 'body_html', 'excerpt'])
    .where('shop_id', '=', shopId)
    .where((eb) =>
      eb.or([eb('seo_title', 'is', null), eb('seo_description', 'is', null)]),
    )
    .limit(limit)
    .execute()
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

async function updateProductSeo(
  db: Kysely<Database>,
  id: string,
  seoTitle: string,
  seoDescription: string,
): Promise<void> {
  await db
    .updateTable('products')
    .set({
      seo_title: seoTitle,
      seo_description: seoDescription,
      updated_at: new Date().toISOString(),
    } as any)
    .where('id', '=', id)
    .execute()
}

async function updatePageSeo(
  db: Kysely<Database>,
  id: string,
  seoTitle: string,
  seoDescription: string,
): Promise<void> {
  await db
    .updateTable('pages')
    .set({
      seo_title: seoTitle,
      seo_description: seoDescription,
      updated_at: new Date().toISOString(),
    } as any)
    .where('id', '=', id)
    .execute()
}

async function updateCollectionSeo(
  db: Kysely<Database>,
  id: string,
  seoTitle: string,
  seoDescription: string,
): Promise<void> {
  await db
    .updateTable('collections')
    .set({
      seo_title: seoTitle,
      seo_description: seoDescription,
      updated_at: new Date().toISOString(),
    } as any)
    .where('id', '=', id)
    .execute()
}

async function updateBlogPostSeo(
  db: Kysely<Database>,
  id: string,
  seoTitle: string,
  seoDescription: string,
): Promise<void> {
  await db
    .updateTable('blog_posts')
    .set({
      seo_title: seoTitle,
      seo_description: seoDescription,
      updated_at: new Date().toISOString(),
    } as any)
    .where('id', '=', id)
    .execute()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Cap a string to `limit` characters without slicing mid-word when
 * possible. Appends an ellipsis if we actually clipped something.
 */
function truncate(value: string, limit: number): string {
  if (!value) return ''
  if (value.length <= limit) return value
  // Find the last space within the limit and cut there to avoid
  // breaking a word. Keep the trailing ellipsis inside the limit.
  const head = value.slice(0, limit - 1)
  const lastSpace = head.lastIndexOf(' ')
  const cutAt = lastSpace > Math.floor(limit * 0.6) ? lastSpace : limit - 1
  return head.slice(0, cutAt).trimEnd() + '…'
}
