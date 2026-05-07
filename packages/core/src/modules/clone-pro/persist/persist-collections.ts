/**
 * Clone Pro — Collection Persistence
 *
 * Persists scraped collections into the Gbox database.
 * Creates collection records and links products via
 * the collection_products junction table.
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { ScrapedCollection } from '../scrapers/collection-scraper.js'
import { sanitizeClonedHtml } from '../sanitize.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistCollectionsResult {
  readonly inserted: number
  readonly updated: number
  readonly productsLinked: number
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist scraped collections into the database.
 * Upserts by slug, then links products using a URL-to-product-ID map.
 *
 * @param db - Kysely database instance
 * @param shopId - Target shop UUID
 * @param collections - Array of ScrapedCollection
 * @param productUrlMap - Map of source product URL → Gbox product ID
 * @returns Count of inserted, updated collections and linked products
 */
export async function persistCloneCollections(
  db: Kysely<Database>,
  shopId: string,
  collections: ScrapedCollection[],
  productUrlMap: Map<string, string>,
  jobId: string | null = null,
): Promise<PersistCollectionsResult> {
  let inserted = 0
  let updated = 0
  let productsLinked = 0

  for (const coll of collections) {
    try {
      // Check if collection with same slug exists
      const existing = await db
        .selectFrom('collections')
        .select('id')
        .where('shop_id', '=', shopId)
        .where('slug', '=', coll.slug)
        .executeTakeFirst()

      let collectionId: string

      if (existing) {
        // Update existing — re-stamp clone_job_id on re-clone so the
        // tab mapping stays accurate (same rationale as persist-pages).
        // Phase 7.4 — sanitize description (stored as body_html).
        const set: Record<string, unknown> = {
          title: coll.title,
          body_html: coll.description
            ? sanitizeClonedHtml(coll.description)
            : null,
          image_url: coll.image_url || null,
          updated_at: new Date().toISOString(),
        }
        if (jobId) set.clone_job_id = jobId
        await db
          .updateTable('collections')
          .set(set as any)
          .where('id', '=', existing.id)
          .execute()
        collectionId = existing.id
        updated++
      } else {
        // Insert new collection — clone_job_id goes in on the INSERT
        // since we're not going through a shared createX() helper here.
        // Phase 7.4 — sanitize description.
        const values: Record<string, unknown> = {
          shop_id: shopId,
          title: coll.title,
          slug: coll.slug,
          body_html: coll.description
            ? sanitizeClonedHtml(coll.description)
            : null,
          image_url: coll.image_url || null,
          sort_order: 'manual',
          published: true,
        }
        if (jobId) values.clone_job_id = jobId
        const result = await db
          .insertInto('collections')
          .values(values as any)
          .returning('id')
          .executeTakeFirstOrThrow()
        collectionId = result.id
        inserted++
      }

      // Link products to collection
      if (coll.product_urls.length > 0) {
        // Remove existing links for this collection (re-clone scenario)
        await db
          .deleteFrom('collection_products')
          .where('collection_id', '=', collectionId)
          .execute()

        let position = 0
        for (const productUrl of coll.product_urls) {
          const productId = productUrlMap.get(productUrl)
          if (!productId) continue

          try {
            await db
              .insertInto('collection_products')
              .values({
                collection_id: collectionId,
                product_id: productId,
                position,
              } as any)
              .execute()
            productsLinked++
            position++
          } catch {
            // Skip duplicate or constraint violations
          }
        }
      }
    } catch (err) {
      console.warn(`[persist-collections] Failed to persist "${coll.slug}":`, (err as Error).message)
    }
  }

  return { inserted, updated, productsLinked }
}
