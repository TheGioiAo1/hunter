/**
 * Clone Pro v6 — products persister (L17 provenance-aware)
 *
 * Persists ProductDTO[] into products + product_variants + product_options
 * + product_images. Respects L17: rows with source='edited' or source='manual'
 * are NEVER overwritten by a re-clone.
 *
 * Schema deviations from the task plan (schema wins):
 *   - products.slug  (NOT `handle`) — sourceHandle maps to slug.
 *   - products.tags  is text[] — pass array directly, NOT JSON.stringify.
 *   - product_variants has no `option_values` column — values split into
 *     option1/option2/option3 (aligned by OptionDTO.position order).
 *   - product_variants has no `available` boolean — inventory_quantity
 *     used as proxy: available=true → 1, false → 0 for fresh inserts.
 *   - product_options.values is text[] — pass array directly.
 *   - collection_products has no source column.
 *   - pages.body_html (NOT `body`) — see pages.ts.
 *   - pages.slug (NOT `handle`).
 */

import type { BucketPersister, PersistInput, PersistResult } from './types.js'
import type { ProductDTO } from '../scrapers/types.js'
import { withSerializable } from '../../../db/transaction.js'
import { shouldOverwriteOnReclone } from './snapshot.js'

export const productsPersister: BucketPersister<ProductDTO> = {
  bucketName: 'products',

  async persist(input: PersistInput<ProductDTO>): Promise<PersistResult> {
    const out: PersistResult = { inserted: 0, updated: 0, skippedEdited: 0, errors: [] }

    await withSerializable(input.db, async (trx) => {
      for (const dto of input.dtos) {
        try {
          const existing = await (trx as any)
            .selectFrom('products')
            .where('shop_id', '=', input.shopId)
            .where('slug', '=', dto.sourceHandle)
            .select(['id', 'source'])
            .executeTakeFirst() as { id: string; source: string } | undefined

          if (existing) {
            if (!shouldOverwriteOnReclone(existing)) {
              out.skippedEdited++
              continue
            }
            // UPDATE — reset source back to 'clone' (seller had not edited)
            await (trx as any).updateTable('products')
              .set({
                title: dto.title,
                body_html: dto.bodyHtml,
                vendor: dto.vendor,
                product_type: dto.productType,
                tags: dto.tags,
                source: 'clone',
                source_url: dto.sourceUrl,
              })
              .where('id', '=', existing.id)
              .execute()
            out.updated++
            await persistVariants(trx, existing.id, dto.variants)
            await persistOptions(trx, existing.id, dto.options)
            await persistImages(trx, existing.id, dto.images)
          } else {
            // INSERT with source='clone' + clone_snapshot
            const snapshotJson = JSON.stringify({
              title: dto.title,
              body_html: dto.bodyHtml,
              vendor: dto.vendor,
              product_type: dto.productType,
              tags: dto.tags,
            })
            const rows = await (trx as any).insertInto('products')
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
              .execute() as any[]
            out.inserted++
            const productId = rows[0].id
            await persistVariants(trx, productId, dto.variants)
            await persistOptions(trx, productId, dto.options)
            await persistImages(trx, productId, dto.images)
          }
        } catch (err) {
          out.errors.push({ sourceHandle: dto.sourceHandle, reason: (err as Error).message })
        }
      }
    })

    return out
  },
}

// ---------------------------------------------------------------------------
// Sub-entity helpers
// ---------------------------------------------------------------------------

async function persistVariants(
  trx: any,
  productId: string,
  variants: ProductDTO['variants'],
): Promise<void> {
  for (const v of variants) {
    // Dedup key: (product_id, sku) WHERE sku IS NOT NULL; plain insert otherwise
    const existing = v.sku
      ? await trx
          .selectFrom('product_variants')
          .where('product_id', '=', productId)
          .where('sku', '=', v.sku)
          .select(['id', 'source'])
          .executeTakeFirst() as { id: string; source: string } | undefined
      : undefined

    // Map optionValues record → option1/2/3 (positional, sorted by key)
    const optionKeys = Object.keys(v.optionValues).sort()
    const [opt1 = null, opt2 = null, opt3 = null] = optionKeys.map((k) => v.optionValues[k])

    const snapshotJson = JSON.stringify({ price: v.price, sku: v.sku, title: v.title })

    if (existing) {
      if (!shouldOverwriteOnReclone(existing)) continue
      await trx.updateTable('product_variants')
        .set({
          title: v.title,
          price: v.price,
          compare_at_price: v.compareAtPrice,
          option1: opt1,
          option2: opt2,
          option3: opt3,
          source: 'clone',
        })
        .where('id', '=', existing.id)
        .execute()
    } else {
      await trx.insertInto('product_variants')
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
}

async function persistOptions(
  trx: any,
  productId: string,
  options: ProductDTO['options'],
): Promise<void> {
  for (const o of options) {
    const existing = await trx
      .selectFrom('product_options')
      .where('product_id', '=', productId)
      .where('name', '=', o.name)
      .select(['id', 'source'])
      .executeTakeFirst() as { id: string; source: string } | undefined

    if (existing) {
      if (!shouldOverwriteOnReclone(existing)) continue
      await trx.updateTable('product_options')
        .set({ values: o.values, position: o.position, source: 'clone' })
        .where('id', '=', existing.id)
        .execute()
    } else {
      await trx.insertInto('product_options')
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
}

async function persistImages(
  trx: any,
  productId: string,
  images: ProductDTO['images'],
): Promise<void> {
  for (const img of images) {
    const existing = await trx
      .selectFrom('product_images')
      .where('product_id', '=', productId)
      .where('position', '=', img.position)
      .select(['id', 'source'])
      .executeTakeFirst() as { id: string; source: string } | undefined

    if (existing) {
      if (!shouldOverwriteOnReclone(existing)) continue
      await trx.updateTable('product_images')
        .set({ src: img.sourceUrl, alt: img.alt, source: 'clone' })
        .where('id', '=', existing.id)
        .execute()
    } else {
      await trx.insertInto('product_images')
        .values({
          product_id: productId,
          src: img.sourceUrl,
          alt: img.alt,
          position: img.position,
          source: 'clone',
          clone_snapshot: JSON.stringify({ src: img.sourceUrl, alt: img.alt, position: img.position }),
        })
        .execute()
    }
  }
}
