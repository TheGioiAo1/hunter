/**
 * Gbox Platform — Smart-collection re-eval triggers (Phase C2)
 *
 * Thin helpers that handlers call after a mutation which could affect
 * smart-collection membership. These wrap the BullMQ enqueue so
 * callers don't have to know the job shape.
 *
 * Two entry points:
 *
 *   `enqueueSyncOne(collectionId, shopId, reason)` — used by the
 *       collection save handlers (create/update) so we only re-eval
 *       the one collection the merchant just touched.
 *
 *   `enqueueSyncShopSmart(db, shopId, reason)` — used by product
 *       mutation handlers. Fans out to every smart collection in the
 *       shop. Because each collection has its own jobId, duplicate
 *       triggers within ~1s collapse via BullMQ's idempotency.
 *
 * The helpers swallow errors — if Redis is down or the queue is
 * misconfigured, the merchant's request should still succeed; the
 * worker will catch up next time the collection is evaluated.
 */

import type { Kysely } from 'kysely'
import { enqueueCollectionSync } from '../queue/queues.js'
import { isRulesNonEmpty } from './smart-rules.js'

/**
 * Enqueue a sync for one specific collection. Safe to call on a
 * manual collection — the worker checks rules before doing work.
 */
export async function enqueueSyncOne(
  collectionId: string,
  shopId: string,
  reason?: string,
): Promise<void> {
  try {
    await enqueueCollectionSync({ collectionId, shopId, reason })
  } catch (err) {
    // Best-effort. Fail open so the admin request still succeeds.
    console.warn(
      `[collection-sync] enqueue failed for ${collectionId}: ${(err as Error).message}`,
    )
  }
}

/**
 * Enqueue sync for every SMART collection in a shop.
 *
 * Called by product handlers. We only fan out to collections whose
 * `rules` column looks non-empty to avoid waking the worker for
 * manual collections (which would immediately no-op but still cost
 * a Redis round-trip + a pg lookup).
 */
export async function enqueueSyncShopSmart(
  db: Kysely<any>,
  shopId: string,
  reason?: string,
): Promise<number> {
  try {
    const rows = await db
      .selectFrom('collections')
      .select(['id', 'rules'])
      .where('shop_id', '=', shopId)
      .execute()

    const smart = rows.filter((r: any) => isRulesNonEmpty(r.rules))
    for (const r of smart) {
      await enqueueCollectionSync({
        collectionId: r.id as string,
        shopId,
        reason,
      })
    }
    return smart.length
  } catch (err) {
    console.warn(
      `[collection-sync] shop fanout failed for ${shopId}: ${(err as Error).message}`,
    )
    return 0
  }
}
