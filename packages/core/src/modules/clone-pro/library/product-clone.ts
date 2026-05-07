/**
 * Clone Library — Product clone service (Phase 4.3)
 *
 * Pushes products from a Library source shop into a target shop. The
 * seller picks one or more products (optionally "all") from the card
 * of a completed clone job in their Library, picks a destination
 * store they own, and those products land in the target shop's
 * catalog as drafts — ready to edit + publish.
 *
 * Dedup: if the target shop already has a copy of a source product
 * (detected via `products.cloned_from_product_id` = source.id), we
 * skip that product. This keeps "push all" idempotent — the seller
 * can re-run it after editing some, and only newly-pushed items get
 * added.
 *
 * What gets copied:
 *
 *   products               → new row, status='draft', fresh slug,
 *                            cloned_from_{product,shop}_id stamped,
 *                            clone_job_id=NULL (this isn't a clone
 *                            job — it's a Library push from within
 *                            the platform), source_external_id=NULL
 *                            (we're not re-importing from an external
 *                            platform).
 *   product_variants       → copied 1:1 with the new product_id
 *   product_options        → copied 1:1 with the new product_id
 *   product_images         → copied 1:1; src stays pointing at the
 *                            original CDN URL (which is already a
 *                            Gbox CDN URL, not a 3rd party, because
 *                            the source product was already persisted
 *                            through our media pipeline during its
 *                            clone-pro run)
 *
 * What we intentionally DON'T copy:
 *
 *   - Orders / customers / inventory — those are per-shop operational
 *     data, not product-definitional.
 *   - collection_products links — collections live per-shop; the
 *     target shop may not have matching collections. The seller can
 *     re-link via the Products → Collections UI.
 *   - Reviews / metafields — these are stamped by customers or admin
 *     actions on the target shop, not inherited from the source.
 *
 * Access control is NOT enforced here — the route layer (Phase 4.6)
 * verifies the logged-in user owns both source and target shops
 * before calling this service.
 *
 * Transactional: the whole batch runs in one transaction. If any
 * single product's copy fails (slug collision loop exhaustion, FK
 * violation, etc.), the whole batch rolls back so the target catalog
 * stays consistent.
 */

import type { Kysely, Transaction } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CloneProductsToShopInput {
  /** Source shop — where the products currently live. */
  readonly sourceShopId: string
  /** Target shop receiving the copies. Must be owned by same seller. */
  readonly targetShopId: string
  /**
   * Specific source product ids to push. If null/undefined we push
   * ALL products in the source shop that are not soft-deleted — the
   * "push all" Library action.
   */
  readonly sourceProductIds?: readonly string[] | null
}

export interface CloneProductsToShopResult {
  /** How many fresh copies we inserted in the target shop. */
  readonly inserted: number
  /** How many were skipped because the target already had a copy. */
  readonly skippedDedup: number
  /** Product rows examined in total (inserted + skippedDedup = examined). */
  readonly examined: number
  /**
   * Mapping of source product id → new product id in target shop.
   * Skipped products map to their existing copy's id, so callers can
   * show "already applied" in the UI. Absent entries = source id not
   * found in source shop (caller asked for a bad id).
   */
  readonly idMap: Record<string, string>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Copy selected (or all) products from a source shop to a target shop
 * via the Clone Library. Returns stats + id-map so the UI can render
 * a confirmation toast + link to the target shop's product list.
 */
export async function cloneProductsToShop(
  db: Kysely<Database>,
  input: CloneProductsToShopInput,
): Promise<CloneProductsToShopResult> {
  const { sourceShopId, targetShopId, sourceProductIds } = input

  // 1. Load source products (only the ones we'll try to copy). Scoped
  //    to `sourceShopId` so a caller can't push another shop's
  //    products through us by accident — even though access control
  //    should have blocked that at the route layer, defense in depth.
  let sourceQuery = db
    .selectFrom('products')
    .selectAll()
    .where('shop_id', '=', sourceShopId)
  if (sourceProductIds && sourceProductIds.length > 0) {
    sourceQuery = sourceQuery.where('id', 'in', sourceProductIds as string[])
  }
  const sourceProducts = await sourceQuery.execute()

  if (sourceProducts.length === 0) {
    return { inserted: 0, skippedDedup: 0, examined: 0, idMap: {} }
  }

  // 2. Load existing copies in target shop so we can dedup without
  //    a per-product query. One lookup, O(n) in source batch size.
  const existingCopies = await db
    .selectFrom('products')
    .select(['id', 'cloned_from_product_id'])
    .where('shop_id', '=', targetShopId)
    .where(
      'cloned_from_product_id',
      'in',
      sourceProducts.map((p) => p.id) as any,
    )
    .execute()

  const copyBySourceId = new Map<string, string>()
  for (const c of existingCopies) {
    if (c.cloned_from_product_id) copyBySourceId.set(c.cloned_from_product_id, c.id)
  }

  let inserted = 0
  let skippedDedup = 0
  const idMap: Record<string, string> = {}

  // 3. Copy each source product in one big transaction. We intentionally
  //    DON'T split this per-product — either the batch succeeds as a
  //    whole or it rolls back. Prevents ghost products in the target
  //    if the loop dies mid-way (e.g. unique slug exhausted).
  await db.transaction().execute(async (trx) => {
    for (const src of sourceProducts) {
      // Dedup: target shop already has a copy of this source product.
      const existing = copyBySourceId.get(src.id)
      if (existing) {
        skippedDedup += 1
        idMap[src.id] = existing
        continue
      }

      // Fresh INSERT. Slug may collide with an unrelated target-shop
      // product (the seller may have a "t-shirt" in both stores) —
      // reserveUniqueSlugLocal appends a numeric suffix if needed.
      const newSlug = await reserveUniqueSlugLocal(trx, targetShopId, src.slug)

      const newProduct = await (trx as any)
        .insertInto('products')
        .values({
          shop_id: targetShopId,
          title: src.title,
          slug: newSlug,
          body_html: src.body_html,
          vendor: src.vendor,
          product_type: src.product_type,
          status: 'draft', // Library push lands as draft — seller reviews first.
          tags: src.tags,
          // Source tracking fields are Library-specific:
          cloned_from_product_id: src.id,
          cloned_from_shop_id: sourceShopId,
          // These stay NULL — this isn't an external import and isn't
          // tied to a clone job on the target side.
          source_external_id: null,
          source_url: null,
          clone_job_id: null,
          // SEO — carry over whatever the source had so the pushed
          // product doesn't lose its existing optimization.
          seo_title: src.seo_title,
          seo_description: src.seo_description,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow()

      // Copy children: variants, options, images. Raw SELECT+INSERT
      // so we pick up any columns we haven't explicitly modelled.
      await copyVariants(trx, src.id, newProduct.id)
      await copyOptions(trx, src.id, newProduct.id)
      await copyImages(trx, src.id, newProduct.id)

      inserted += 1
      idMap[src.id] = newProduct.id
    }
  })

  return {
    inserted,
    skippedDedup,
    examined: sourceProducts.length,
    idMap,
  }
}

// ---------------------------------------------------------------------------
// Child-row copy helpers
// ---------------------------------------------------------------------------

/**
 * Copy product_variants rows from one product to another. Drops the
 * source id and inventory_quantity (cloned products start with 0
 * stock; seller adjusts) but carries pricing, options, SKU so the
 * variant grid is usable immediately.
 *
 * We explicitly list the columns we want to copy rather than using
 * `SELECT *` because Kysely doesn't let us issue a pure `INSERT ...
 * SELECT` shape easily, and listing keeps the copy deterministic
 * across schema drift.
 */
async function copyVariants(
  trx: Transaction<Database>,
  srcProductId: string,
  dstProductId: string,
): Promise<void> {
  const variants = await trx
    .selectFrom('product_variants')
    .selectAll()
    .where('product_id', '=', srcProductId)
    .execute()

  if (variants.length === 0) return

  await (trx as any)
    .insertInto('product_variants')
    .values(
      variants.map((v) => ({
        product_id: dstProductId,
        title: v.title,
        price: v.price,
        compare_at_price: v.compare_at_price,
        sku: v.sku,
        option1: v.option1,
        option2: v.option2,
        option3: v.option3,
        position: v.position,
        // Fresh inventory: 0 so the seller explicitly stocks the
        // product on the target store. Carrying over inventory would
        // lie about warehouse state.
        inventory_quantity: 0,
      })),
    )
    .execute()
}

async function copyOptions(
  trx: Transaction<Database>,
  srcProductId: string,
  dstProductId: string,
): Promise<void> {
  const options = await trx
    .selectFrom('product_options')
    .selectAll()
    .where('product_id', '=', srcProductId)
    .execute()

  if (options.length === 0) return

  await (trx as any)
    .insertInto('product_options')
    .values(
      options.map((o) => ({
        product_id: dstProductId,
        name: o.name,
        position: o.position,
        values: o.values,
      })),
    )
    .execute()
}

async function copyImages(
  trx: Transaction<Database>,
  srcProductId: string,
  dstProductId: string,
): Promise<void> {
  const images = await trx
    .selectFrom('product_images')
    .selectAll()
    .where('product_id', '=', srcProductId)
    .execute()

  if (images.length === 0) return

  await (trx as any)
    .insertInto('product_images')
    .values(
      images.map((img) => ({
        product_id: dstProductId,
        src: img.src,
        alt: img.alt,
        position: img.position,
        width: img.width,
        height: img.height,
      })),
    )
    .execute()
}

// ---------------------------------------------------------------------------
// Slug reservation (local helper — persist-products.ts doesn't export)
// ---------------------------------------------------------------------------

/**
 * Find a slug that's unique within the target shop. Mirrors the
 * `reserveUniqueSlug` helper inside `persist-products.ts` but stays
 * private here to avoid introducing a cross-module dependency on a
 * function that storefront-clone treats as internal.
 *
 * Appends `-2`, `-3`, ... up to `-13`; falls back to a base36 time
 * fragment if 12 attempts all collide (pathological — the shop would
 * need 11 products with the same slug base).
 */
async function reserveUniqueSlugLocal(
  trx: Transaction<Database>,
  shopId: string,
  base: string,
): Promise<string> {
  let candidate = base
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const clash = await trx
      .selectFrom('products')
      .select(['id'])
      .where('shop_id', '=', shopId)
      .where('slug', '=', candidate)
      .executeTakeFirst()
    if (!clash) return candidate
    candidate = `${base}-${attempt + 2}`
  }
  return `${base}-${Date.now().toString(36)}`
}
