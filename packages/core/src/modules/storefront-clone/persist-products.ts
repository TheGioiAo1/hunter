/**
 * Gbox Platform — Storefront Clone: product persistence.
 *
 * Maps CloneProductDTOs (from `@gbox/core/clone-shopify`) into the
 * Gbox `products` / `product_variants` / `product_options` /
 * `product_images` tables using a full-overwrite upsert keyed on
 * `(shop_id, source_external_id)`.
 *
 * Re-clone policy (locked Q6): full overwrite. If a product with the
 * same `(shop_id, source_external_id)` already exists we:
 *
 *   1. UPDATE the products row in place
 *   2. DELETE child variants / options / images
 *   3. Re-INSERT children from the fresh DTO
 *
 * This keeps the product's primary key stable (so URLs / wishlist
 * entries don't break) while still giving us a clean slate for
 * the subsidiary data. Manually-created products (NULL
 * source_external_id) are untouched — the unique index is partial
 * on `source_external_id IS NOT NULL` so they can coexist.
 *
 * Media URLs are stored as the SOURCE URL at this stage. Phase 3.B
 * runs a follow-up media pipeline that downloads each image via
 * safeFetch, streams to S3, and rewrites `product_images.src` to
 * the Gbox CDN URL.
 */

import type { Kysely, Transaction } from 'kysely';
import type { Database } from '@gbox/db/schema/tables.js';
import type { CloneProductDTO } from '../clone-shopify/index.js';

export interface PersistProductsInput {
  readonly shopId: string;
  /**
   * `storefront_clone_jobs.id` to stamp on every imported product
   * (and its variants/options/images via cascade). FK-checked at
   * insert time — passing a UUID that isn't in `storefront_clone_jobs`
   * fails the FK `fk_products_clone_job_id`.
   *
   * Pass `null` for non-job imports (tests, manual seeds) — the
   * column is nullable. Production callers should pass the live
   * job id; runner.ts threads `CloneProConfig.jobId` through here.
   */
  readonly cloneJobId: string | null;
  readonly sourceBaseUrl: string;
  readonly products: readonly CloneProductDTO[];
}

export interface PersistProductsResult {
  readonly inserted: number;
  readonly updated: number;
  readonly imagesWritten: number;
  readonly variantsWritten: number;
}

/**
 * Persist a batch of cloned products into the shop's catalog.
 * Runs inside a single transaction so a partial failure leaves
 * the catalog consistent.
 */
export async function persistCloneProducts(
  db: Kysely<Database>,
  input: PersistProductsInput,
): Promise<PersistProductsResult> {
  let inserted = 0;
  let updated = 0;
  let imagesWritten = 0;
  let variantsWritten = 0;

  await db.transaction().execute(async (trx) => {
    for (const product of input.products) {
      const outcome = await upsertOneProduct(trx, input, product);
      if (outcome.created) inserted += 1;
      else updated += 1;
      imagesWritten += outcome.imagesWritten;
      variantsWritten += outcome.variantsWritten;
    }
  });

  return { inserted, updated, imagesWritten, variantsWritten };
}

interface UpsertOutcome {
  readonly created: boolean;
  readonly imagesWritten: number;
  readonly variantsWritten: number;
}

async function upsertOneProduct(
  trx: Transaction<Database>,
  input: PersistProductsInput,
  product: CloneProductDTO,
): Promise<UpsertOutcome> {
  const slug = safeSlug(product.handle) || safeSlug(product.title) || product.sourceProductId;
  const sourceUrl = buildSourceUrl(input.sourceBaseUrl, product.handle);

  // Find existing row by (shop_id, source_external_id). This is the
  // partial unique index from migration 012.
  const existing = await trx
    .selectFrom('products')
    .select(['id'])
    .where('shop_id', '=', input.shopId)
    .where('source_external_id', '=', product.sourceProductId)
    .executeTakeFirst();

  let productId: string;
  let created: boolean;

  if (existing) {
    productId = existing.id;
    created = false;
    await trx
      .updateTable('products')
      .set({
        title: product.title,
        slug,
        body_html: product.descriptionHtml || null,
        vendor: product.vendor,
        product_type: product.productType,
        tags: product.tags.length > 0 ? [...product.tags] : null,
        source_url: sourceUrl,
        clone_job_id: input.cloneJobId,
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', productId)
      .execute();

    // Full overwrite — wipe children, re-insert from DTO.
    await trx.deleteFrom('product_variants').where('product_id', '=', productId).execute();
    await trx.deleteFrom('product_options').where('product_id', '=', productId).execute();
    await trx.deleteFrom('product_images').where('product_id', '=', productId).execute();
  } else {
    const row = await trx
      .insertInto('products')
      .values({
        shop_id: input.shopId,
        title: product.title,
        slug: await reserveUniqueSlug(trx, input.shopId, slug),
        body_html: product.descriptionHtml || null,
        vendor: product.vendor,
        product_type: product.productType,
        status: 'draft', // cloned products land as drafts — merchant reviews before publishing
        tags: product.tags.length > 0 ? [...product.tags] : null,
        source_external_id: product.sourceProductId,
        source_url: sourceUrl,
        clone_job_id: input.cloneJobId,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    productId = row.id;
    created = true;
  }

  // Variants — always at least one so the storefront has a buy button.
  const variantRows =
    product.variants.length > 0
      ? product.variants.map((v, i) => ({
          product_id: productId,
          title: v.title,
          price: normalisePrice(v.price),
          compare_at_price: v.compareAtPrice ? normalisePrice(v.compareAtPrice) : null,
          sku: v.sku,
          option1: v.optionValues[0] ?? null,
          option2: v.optionValues[1] ?? null,
          option3: v.optionValues[2] ?? null,
          position: i,
          inventory_quantity: v.available ? 1 : 0,
        }))
      : [
          {
            product_id: productId,
            title: 'Default Title',
            price: '0',
            option1: 'Default Title',
            position: 0,
            inventory_quantity: 0,
          },
        ];

  await trx.insertInto('product_variants').values(variantRows).execute();

  // Product options — derived from variant option positions if the
  // source didn't ship an explicit options array. Shopify's
  // /products.json does carry options but our CloneProductDTO
  // intentionally dropped them (we only need the values). Re-derive.
  const options = deriveOptions(product);
  if (options.length > 0) {
    await trx
      .insertInto('product_options')
      .values(
        options.map((o, i) => ({
          product_id: productId,
          name: o.name,
          position: i,
          values: o.values,
        })),
      )
      .execute();
  }

  // Images — store source URL; Phase 3.B rewrites to CDN.
  if (product.images.length > 0) {
    await trx
      .insertInto('product_images')
      .values(
        product.images.map((img, i) => ({
          product_id: productId,
          src: img.sourceUrl,
          alt: img.altText,
          position: i,
          width: img.width,
          height: img.height,
        })),
      )
      .execute();
  }

  return {
    created,
    imagesWritten: product.images.length,
    variantsWritten: variantRows.length,
  };
}

/**
 * Gather unique values seen per option slot (1..3) and produce
 * `{ name, values }` entries. Shopify's schema is fixed at 3 option
 * slots; if a slot never has a value, we skip it. Names default to
 * "Option 1" etc. because the raw crawler DTO doesn't carry them.
 */
function deriveOptions(
  product: CloneProductDTO,
): readonly { readonly name: string; readonly values: string[] }[] {
  const slots: Array<Set<string>> = [new Set(), new Set(), new Set()];
  for (const v of product.variants) {
    v.optionValues.forEach((val, i) => {
      if (i < 3 && typeof val === 'string' && val.length > 0) {
        slots[i]!.add(val);
      }
    });
  }
  const out: Array<{ name: string; values: string[] }> = [];
  slots.forEach((set, i) => {
    if (set.size > 0) {
      out.push({ name: `Option ${i + 1}`, values: Array.from(set) });
    }
  });
  return out;
}

/**
 * Resolve a slug collision against the same shop by appending a
 * short numeric suffix. Called only on INSERT path (existing rows
 * keep their slug).
 */
async function reserveUniqueSlug(
  trx: Transaction<Database>,
  shopId: string,
  base: string,
): Promise<string> {
  let candidate = base;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const clash = await trx
      .selectFrom('products')
      .select(['id'])
      .where('shop_id', '=', shopId)
      .where('slug', '=', candidate)
      .executeTakeFirst();
    if (!clash) return candidate;
    candidate = `${base}-${attempt + 2}`;
  }
  // Give up cleanly — append a timestamp fragment so the INSERT
  // still succeeds rather than hanging the whole clone run.
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Strip Unicode, non-URL-safe characters and collapse runs of
 * hyphens. Keeps the slug under 80 chars so it doesn't blow the
 * Postgres btree index key length budget.
 */
export function safeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Shopify prices are already decimal strings ("19.99"). Normalise
 * to match our numeric(10,2) column: reject anything non-numeric,
 * clamp to 2 decimal places.
 */
export function normalisePrice(raw: string): string {
  const num = Number.parseFloat(raw);
  if (!Number.isFinite(num) || num < 0) return '0';
  return num.toFixed(2);
}

function buildSourceUrl(baseUrl: string, handle: string): string {
  try {
    const u = new URL(baseUrl);
    u.pathname = `/products/${handle}`;
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return `${baseUrl.replace(/\/$/, '')}/products/${handle}`;
  }
}
