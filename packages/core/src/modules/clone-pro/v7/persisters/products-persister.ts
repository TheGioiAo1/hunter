/**
 * Clone Pro v7 — products persister with OVERWRITE re-clone semantics.
 *
 * Sprint 5 Task 5.6 (spec §5.2 + Q4 decision). Wraps the v6 product
 * persist logic with a single new prelude: invoke
 * `clone_pro_overwrite_products(shop_id)` (migration 103) before
 * inserting any fresh DTO.
 *
 * Sequence inside one `withSerializable` tx:
 *
 *   1. SELECT clone_pro_overwrite_products($shopId)
 *      • UPDATE products SET status='archived' WHERE has orders   (FK-safe)
 *      • DELETE products WHERE no orders                          (cascade)
 *   2. For each DTO: INSERT fresh products + variants + options + images
 *
 * Atomicity: all three phases (archive + delete + insert) live in the
 * same SERIALIZABLE transaction. If any INSERT fails, the whole tx
 * rolls back and the next attempt starts from a clean slate.
 *
 * Fail-tolerance per DTO: a single product's INSERT failure (e.g.
 * unique-constraint violation on slug) records to `errors[]` and the
 * loop continues — the v6 design carried over.
 *
 * Iron Rule 5: error.message is captured into `errors[]` for the
 * orchestrator's audit log; the seller-facing channel (job_log) goes
 * through `safeMessage` at the worker boundary, not here.
 */

import { sql } from 'kysely'
import type { BucketPersister, PersistInput, PersistResult } from '../../v6/persisters/types.js'
import type { ProductDTO } from '../../v6/scrapers/types.js'
import { withSerializable } from '../../../db/transaction.js'

export const productsPersisterV7: BucketPersister<ProductDTO> = {
  bucketName: 'products',

  async persist(input: PersistInput<ProductDTO>): Promise<PersistResult> {
    const out: PersistResult = { inserted: 0, updated: 0, skippedEdited: 0, errors: [] }

    await withSerializable(input.db, async (trx) => {
      // ---- Phase 1: OVERWRITE existing products for this shop --------
      // Migration 103 ships clone_pro_overwrite_products(p_shop_id UUID)
      // returning (deleted INT, archived INT). We don't need the count
      // here (the orchestrator already audits via clone_run_metrics);
      // we just need the side-effect.
      // Use the kysely raw-sql template; calling `.execute(trx)` works
      // with both the production handle and any mock that implements
      // `executeQuery({ sql, parameters })`. The `clone_pro_overwrite_products`
      // SQL function (migration 103) is idempotent w.r.t. fresh clones.
      const overwriteSql = sql<{ deleted: number; archived: number }>`
        SELECT * FROM clone_pro_overwrite_products(${input.shopId}::uuid)
      `
      await overwriteSql.execute(trx)

      // ---- Phase 2: INSERT fresh DTOs (no existing-row check needed
      // because Phase 1 wiped the slate). We still wrap each row in
      // try/catch for unique-violation tolerance.
      for (const dto of input.dtos) {
        try {
          const snapshotJson = JSON.stringify({
            title: dto.title,
            body_html: dto.bodyHtml,
            vendor: dto.vendor,
            product_type: dto.productType,
            tags: dto.tags,
          })
          const rows = (await (trx as any)
            .insertInto('products')
            .values({
              shop_id: input.shopId,
              slug: dto.sourceHandle,
              title: dto.title,
              body_html: dto.bodyHtml,
              vendor: dto.vendor,
              product_type: dto.productType,
              tags: dto.tags,
              status: 'draft',
              source_url: dto.sourceUrl,
              clone_job_id: input.jobId,
              source: 'clone',
              clone_snapshot: snapshotJson,
            })
            .returningAll()
            .execute()) as Array<{ id: string }>
          const productId = rows[0].id
          out.inserted++
          await persistVariants(trx, productId, dto.variants)
          await persistOptions(trx, productId, dto.options)
          await persistImages(trx, productId, dto.images)
        } catch (err) {
          out.errors.push({
            sourceHandle: dto.sourceHandle,
            reason: (err as Error).message,
          })
        }
      }
    })

    return out
  },
}

// ---------------------------------------------------------------------------
// Sub-entity helpers (port of v6 with the existing-row check stripped —
// OVERWRITE wiped the table, so we always INSERT)
// ---------------------------------------------------------------------------

async function persistVariants(
  trx: any,
  productId: string,
  variants: ProductDTO['variants'],
): Promise<void> {
  for (const v of variants) {
    const optionKeys = Object.keys(v.optionValues).sort()
    const [opt1 = null, opt2 = null, opt3 = null] = optionKeys.map((k) => v.optionValues[k])
    const snapshotJson = JSON.stringify({ price: v.price, sku: v.sku, title: v.title })
    await trx
      .insertInto('product_variants')
      .values({
        product_id: productId,
        title: v.title,
        price: v.price,
        compare_at_price: v.compareAtPrice,
        sku: v.sku,
        inventory_quantity: v.available ? 1 : 0,
        option1: opt1,
        option2: opt2,
        option3: opt3,
        source: 'clone',
        clone_snapshot: snapshotJson,
      })
      .execute()
  }
}

async function persistOptions(
  trx: any,
  productId: string,
  options: ProductDTO['options'],
): Promise<void> {
  for (const o of options) {
    await trx
      .insertInto('product_options')
      .values({
        product_id: productId,
        name: o.name,
        position: o.position,
        values: o.values,
        source: 'clone',
        clone_snapshot: JSON.stringify({ name: o.name, values: o.values }),
      })
      .execute()
  }
}

async function persistImages(
  trx: any,
  productId: string,
  images: ProductDTO['images'],
): Promise<void> {
  for (const img of images) {
    await trx
      .insertInto('product_images')
      .values({
        product_id: productId,
        src: img.sourceUrl,
        alt: img.alt,
        position: img.position,
        source: 'clone',
        clone_snapshot: JSON.stringify({
          src: img.sourceUrl,
          alt: img.alt,
          position: img.position,
        }),
      })
      .execute()
  }
}
