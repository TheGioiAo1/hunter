/**
 * Clone Pro v5 — products persister (phase ⑤, runs inside `withSerializable`)
 *
 * Takes `ScrapedProduct[]` and upserts each one plus its options, variants,
 * and images. Schema deviations from the plan (plan was written before I
 * inspected the real schema — schema wins):
 *
 *   - `products.slug` (NOT `handle`). Upsert key `(shop_id, slug)`.
 *   - `products.body_html` (NOT `description_html`).
 *   - `products.tags` is `text[]` — the DTO's `readonly string[]` passes
 *     through as an array literal.
 *   - `product_variants` has no `source_id` column. We use `sku` as the
 *     dedup key when present; variants without a sku INSERT plain and
 *     may duplicate on re-clone (acceptable trade-off — the alternative
 *     was adding a `source_id` column we'd otherwise never read).
 *   - `product_variants.option1/2/3` replace the DTO's `option_values[]`
 *     (aligned by index — first value → option1 etc).
 *   - `product_options` upserts on `(product_id, name)`.
 *   - `product_images` upserts on `(product_id, position)`.
 *
 * Inserted vs updated distinction is best-effort — Postgres' `RETURNING`
 * doesn't surface which path was taken. We lump both into `inserted`.
 * Callers needing stricter accounting can compute it via `xmax` post-hoc.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { ScrapedProduct } from '../types.js'

export interface PersistProductsResult {
  readonly inserted: number
  readonly updated: number
  readonly skipped: number
}

export async function persistProducts(
  tx: Kysely<Database>,
  shopId: string,
  products: readonly ScrapedProduct[],
): Promise<PersistProductsResult> {
  let inserted = 0
  const updated = 0
  let skipped = 0

  for (const p of products) {
    // No per-product try/catch: we're inside a Postgres transaction
    // (wrapped by runCloneImport → withSerializable). Any caught error
    // would leave the transaction in `25P02 aborted` state, masking the
    // true failure on the next query. Let errors propagate — the outer
    // withSerializable retries transient conflicts (40001/40P01), and
    // non-retryable errors should fail the whole clone cleanly.
    const row = await tx
      .insertInto('products')
      .values({
        shop_id: shopId,
        slug: p.handle,
        title: p.title,
        body_html: p.body_html,
        vendor: p.vendor,
        product_type: p.product_type,
        tags: [...p.tags] as string[],
        status: 'draft',
      })
      .onConflict((oc) =>
        oc.columns(['shop_id', 'slug']).doUpdateSet({
          title: p.title,
          body_html: p.body_html,
          vendor: p.vendor,
          product_type: p.product_type,
          tags: [...p.tags] as string[],
        }),
      )
      .returning('id')
      .executeTakeFirst()

    if (!row) {
      skipped++
      continue
    }
    const productId = row.id as string

    // Options — upsert by (product_id, name).
    for (const opt of p.options) {
      await tx
        .insertInto('product_options')
        .values({
          product_id: productId,
          name: opt.name,
          position: opt.position,
          values: [...opt.values] as string[],
        })
        .onConflict((oc) =>
          oc.columns(['product_id', 'name']).doUpdateSet({
            position: opt.position,
            values: [...opt.values] as string[],
          }),
        )
        .returning('id')
        .executeTakeFirst()
    }

    // Variants — sku-branched upsert (sku is nullable; the partial
    // UNIQUE index from 091b covers the non-null case, and no dedup
    // exists otherwise).
    for (const v of p.variants) {
      const [opt1 = null, opt2 = null, opt3 = null] = v.option_values
      const values = {
        product_id: productId,
        title: v.title,
        price: v.price,
        compare_at_price: v.compare_at_price,
        sku: v.sku,
        inventory_quantity: v.inventory_quantity ?? 0,
        option1: opt1,
        option2: opt2,
        option3: opt3,
        weight: v.weight as number | null,
        weight_unit: v.weight_unit ?? 'kg',
      }

      if (v.sku) {
        // idx_product_variants_product_sku from 091b is a PARTIAL unique
        // index (`WHERE sku IS NOT NULL`). Postgres won't infer a
        // partial arbiter unless the ON CONFLICT clause restates the
        // predicate — otherwise it errors with `42P10 no unique or
        // exclusion constraint matching the ON CONFLICT specification`.
        // `.where('sku', 'is not', null)` is how Kysely emits the
        // matching `ON CONFLICT (product_id, sku) WHERE (sku IS NOT NULL)`.
        await tx
          .insertInto('product_variants')
          .values(values as any)
          .onConflict((oc) =>
            oc
              .columns(['product_id', 'sku'])
              .where('sku', 'is not', null)
              .doUpdateSet({
                title: v.title,
                price: v.price,
                compare_at_price: v.compare_at_price,
                inventory_quantity: v.inventory_quantity ?? 0,
                option1: opt1,
                option2: opt2,
                option3: opt3,
              }),
          )
          .returning('id')
          .executeTakeFirst()
      } else {
        // No sku → plain insert. On re-clone this can produce
        // duplicate rows; that's deliberate (see header comment).
        await tx
          .insertInto('product_variants')
          .values(values as any)
          .execute()
      }
    }

    // Images — upsert by (product_id, position).
    for (const img of p.images) {
      await tx
        .insertInto('product_images')
        .values({
          product_id: productId,
          position: img.position,
          src: img.src,
          alt: img.alt,
        })
        .onConflict((oc) =>
          oc.columns(['product_id', 'position']).doUpdateSet({
            src: img.src,
            alt: img.alt,
          }),
        )
        .returning('id')
        .executeTakeFirst()
    }

    inserted++
  }

  return { inserted, updated, skipped }
}
