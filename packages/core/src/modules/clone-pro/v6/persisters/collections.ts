/**
 * Clone Pro v6 — collections persister (L17 provenance-aware)
 *
 * Persists CollectionDTO[] into collections + collection_products pivot.
 * The pivot is always delete-all-then-reinsert (collection_products has no
 * source column — confirmed by inspecting CollectionProductTable in tables.ts).
 *
 * Schema deviations from the task plan (schema wins):
 *   - collections.slug  (NOT `handle`) — sourceHandle maps to slug.
 *   - products dedup lookup uses products.slug (NOT products.handle).
 *   - collection_products has NO source column — simple delete+reinsert.
 */

import type { BucketPersister, PersistInput, PersistResult } from './types.js'
import type { CollectionDTO } from '../scrapers/types.js'
import { withSerializable } from '../../../db/transaction.js'
import { shouldOverwriteOnReclone } from './snapshot.js'

export const collectionsPersister: BucketPersister<CollectionDTO> = {
  bucketName: 'collections',

  async persist(input: PersistInput<CollectionDTO>): Promise<PersistResult> {
    const out: PersistResult = { inserted: 0, updated: 0, skippedEdited: 0, errors: [] }

    await withSerializable(input.db, async (trx) => {
      for (const dto of input.dtos) {
        try {
          const existing = await (trx as any)
            .selectFrom('collections')
            .where('shop_id', '=', input.shopId)
            .where('slug', '=', dto.sourceHandle)
            .select(['id', 'source'])
            .executeTakeFirst() as { id: string; source: string } | undefined

          let collectionId: string

          if (existing) {
            if (!shouldOverwriteOnReclone(existing)) {
              out.skippedEdited++
              continue
            }
            await (trx as any).updateTable('collections')
              .set({
                title: dto.title,
                body_html: dto.bodyHtml,
                source: 'clone',
              })
              .where('id', '=', existing.id)
              .execute()
            collectionId = existing.id
            out.updated++
          } else {
            const snapshotJson = JSON.stringify({
              title: dto.title,
              body_html: dto.bodyHtml,
            })
            const rows = await (trx as any).insertInto('collections')
              .values({
                shop_id: input.shopId,
                slug: dto.sourceHandle,
                title: dto.title,
                body_html: dto.bodyHtml,
                clone_job_id: input.jobId,
                source: 'clone',
                clone_snapshot: snapshotJson,
              })
              .returningAll()
              .execute() as any[]
            collectionId = rows[0].id
            out.inserted++
          }

          await rewritePivot(trx, input.shopId, collectionId, dto.productHandles)
        } catch (err) {
          out.errors.push({ sourceHandle: dto.sourceHandle, reason: (err as Error).message })
        }
      }
    })

    return out
  },
}

/**
 * Rewrite the collection_products pivot for a collection.
 *
 * Deletes all existing pivot rows for the collection, then re-inserts
 * only the handles that resolve to known products in this shop.
 * Position is 1-based, preserving DTO order.
 *
 * collection_products has NO source column (confirmed from schema) so
 * we use a plain delete-all strategy — no partial filter.
 */
async function rewritePivot(
  trx: any,
  shopId: string,
  collectionId: string,
  productHandles: string[],
): Promise<void> {
  // Clear all existing pivot rows for this collection
  await trx.deleteFrom('collection_products')
    .where('collection_id', '=', collectionId)
    .execute()

  if (productHandles.length === 0) return

  // Resolve handles → product ids (products.slug is the dedup key in v6)
  const products = await trx
    .selectFrom('products')
    .where('shop_id', '=', shopId)
    .where('slug', 'in', productHandles)
    .select(['id', 'slug'])
    .execute() as { id: string; slug: string }[]

  const idBySlug = new Map(products.map((p) => [p.slug, p.id]))

  let position = 1
  for (const handle of productHandles) {
    const productId = idBySlug.get(handle)
    if (!productId) continue   // unresolved handle — skip (fail-tolerance)
    await trx.insertInto('collection_products')
      .values({
        collection_id: collectionId,
        product_id: productId,
        position: position++,
      })
      .execute()
  }
}
