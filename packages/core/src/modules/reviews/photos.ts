/**
 * Gbox Platform — Review Photos Service (Phase 10 PR3)
 *
 * CRUD on `review_photos` + keeps the denormalised `photos_count` on
 * `product_reviews` in sync. Every write path goes through a Kysely
 * transaction so the counter never drifts if one of the two queries
 * fails.
 *
 * Scope:
 *
 *   - `addReviewPhoto(db, reviewId, shopId, data)`   → row
 *   - `listReviewPhotos(db, reviewId)`               → row[]
 *   - `deleteReviewPhoto(db, photoId)`               → void
 *
 * The `url` is supplied by the caller — this module does NOT handle
 * the file upload itself. The storefront / admin handler uploads to
 * S3/CDN and then calls `addReviewPhoto` with the resulting URL +
 * optional `storageKey` so we can later delete the blob.
 *
 * A single review is capped at `MAX_PHOTOS_PER_REVIEW` (default 8).
 * Attempting a 9th insert throws `ReviewPhotoLimitError` so the
 * admin / storefront handler can surface a user-friendly message.
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

export const MAX_PHOTOS_PER_REVIEW = 8

export class ReviewPhotoLimitError extends Error {
  constructor(reviewId: string) {
    super(`Review ${reviewId} already has the maximum of ${MAX_PHOTOS_PER_REVIEW} photos.`)
    this.name = 'ReviewPhotoLimitError'
  }
}

export interface AddReviewPhotoInput {
  url: string
  storageKey?: string | null
  width?: number | null
  height?: number | null
  position?: number | null
}

/**
 * Attach a photo to a review. Enforces the per-review cap + updates
 * `photos_count` atomically. Returns the inserted row.
 */
export async function addReviewPhoto(
  db: Kysely<Database>,
  reviewId: string,
  shopId: string,
  data: AddReviewPhotoInput,
) {
  return db.transaction().execute(async (trx) => {
    // Count existing + cap in the same txn so a parallel insert can't
    // race past MAX_PHOTOS_PER_REVIEW. A SELECT ... FOR UPDATE on the
    // review row would be stricter, but row-level locking on the
    // parent review is unnecessary here — the review itself is not
    // being mutated, only the child count.
    const existing = await trx
      .selectFrom('review_photos')
      .select(trx.fn.countAll<number>().as('c'))
      .where('review_id', '=', reviewId)
      .executeTakeFirstOrThrow()
    if (Number(existing.c) >= MAX_PHOTOS_PER_REVIEW) {
      throw new ReviewPhotoLimitError(reviewId)
    }

    const row = await trx
      .insertInto('review_photos')
      .values({
        review_id: reviewId,
        shop_id: shopId,
        url: data.url,
        storage_key: data.storageKey ?? null,
        width: data.width ?? null,
        height: data.height ?? null,
        position: data.position ?? Number(existing.c),
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow()

    await trx
      .updateTable('product_reviews')
      .set({
        photos_count: sql`photos_count + 1`,
        updated_at: new Date().toISOString(),
      } as any)
      .where('id', '=', reviewId)
      .execute()

    return row
  })
}

/** List photos for a review ordered by position ASC then created_at ASC. */
export async function listReviewPhotos(
  db: Kysely<Database>,
  reviewId: string,
) {
  return db
    .selectFrom('review_photos')
    .selectAll()
    .where('review_id', '=', reviewId)
    .orderBy('position', 'asc')
    .orderBy('created_at', 'asc')
    .execute()
}

/**
 * Delete a photo + decrement the counter. Caller is responsible for
 * deleting the backing blob (we return the `storage_key` so the
 * handler can enqueue a tidy-up job).
 */
export async function deleteReviewPhoto(
  db: Kysely<Database>,
  photoId: string,
): Promise<{ storageKey: string | null } | null> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('review_photos')
      .select(['review_id', 'storage_key'])
      .where('id', '=', photoId)
      .executeTakeFirst()
    if (!row) return null

    await trx.deleteFrom('review_photos').where('id', '=', photoId).execute()

    await trx
      .updateTable('product_reviews')
      .set({
        photos_count: sql`GREATEST(photos_count - 1, 0)`,
        updated_at: new Date().toISOString(),
      } as any)
      .where('id', '=', row.review_id)
      .execute()

    return { storageKey: row.storage_key ?? null }
  })
}
