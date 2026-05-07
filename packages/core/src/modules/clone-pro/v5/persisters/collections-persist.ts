/**
 * Clone Pro v5 — collections persister (phase ⑤, runs inside `withSerializable`)
 *
 * Upserts each `ScrapedCollection` + rebuilds the `collection_products` pivot
 * from resolved product ids. Runs AFTER `persistProducts` so the lookup join
 * sees the freshly-imported products.
 *
 * Schema deviations from the plan:
 *   - `collections.slug` (NOT `handle`). Upsert key (shop_id, slug).
 *   - `collections.body_html` (NOT `description_html`).
 *   - `collections.image_url` (NOT `image_src`).
 *   - DTO field `product_handles` is semantic — we resolve against
 *     `products.slug` (since `products.handle` no longer exists).
 *   - `collection_products` has a composite PK `(collection_id, product_id)`
 *     and no `id` column. We delete + re-insert the pivot rows on every
 *     clone (cheaper than diffing for PR1; PR2 can optimise).
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { ScrapedCollection } from '../types.js'

export interface PersistCollectionsResult {
  readonly inserted: number
  readonly updated: number
  readonly skipped: number
  readonly pivotLinks: number
}

export async function persistCollections(
  tx: Kysely<Database>,
  shopId: string,
  collections: readonly ScrapedCollection[],
): Promise<PersistCollectionsResult> {
  let inserted = 0
  let skipped = 0
  let pivotLinks = 0

  for (const c of collections) {
    // No per-collection try/catch — see products-persist.ts header.
    const row = await tx
      .insertInto('collections')
      .values({
        shop_id: shopId,
        slug: c.handle,
        title: c.title,
        body_html: c.body_html,
        image_url: c.image?.src ?? null,
      })
      .onConflict((oc) =>
        oc.columns(['shop_id', 'slug']).doUpdateSet({
          title: c.title,
          body_html: c.body_html,
          image_url: c.image?.src ?? null,
        }),
      )
      .returning('id')
      .executeTakeFirst()

    if (!row) {
      skipped++
      continue
    }
    const collectionId = row.id as string

    // Resolve DTO product_handles against products.slug for this shop.
    const handles = [...c.product_handles] as string[]
    const matches =
      handles.length === 0
        ? []
        : await tx
            .selectFrom('products')
            .select(['id', 'slug'])
            .where('shop_id', '=', shopId)
            .where('slug', 'in', handles)
            .execute()

    // Pivot rebuild: delete existing rows then re-insert. Cheap
    // enough for PR1 (small collections); PR2 can diff + only write
    // the delta if we start seeing perf issues.
    await tx.deleteFrom('collection_products').where('collection_id', '=', collectionId).execute()

    let position = 0
    for (const p of matches) {
      await tx
        .insertInto('collection_products')
        .values({
          collection_id: collectionId,
          product_id: p.id as string,
          position: position++,
        })
        .execute()
      pivotLinks++
    }

    inserted++
  }

  return { inserted, updated: 0, skipped, pivotLinks }
}
