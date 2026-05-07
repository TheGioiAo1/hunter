/**
 * Lenful `NormalizedCatalogEntry` → local v4 Gbox product (draft).
 *
 * Background
 * ----------
 * The original "Add to my store" handler (migration 033) pushed Lenful
 * catalog entries straight to the legacy .NET master shop via
 * `createLegacyProduct`. That path requires a god-admin-configured
 * `legacy_gbox_config` row, which isn't always present (e.g. fresh
 * install, god admin hasn't wired the master shop yet).
 *
 * This helper is the v4-local fallback: when there's no active legacy
 * config, the handler calls `copyCatalogEntryToLocalProduct` instead,
 * materializing the Lenful catalog entry as a DRAFT product owned by
 * the seller's own shop. The seller can then review, edit pricing, and
 * publish — same as any hand-created product — and eventually push to
 * a fulfillment backend if/when one is configured.
 *
 * Design notes
 * ------------
 * - Status is always 'draft' on creation. The seller must explicitly
 *   publish (Shopify parity — never auto-publish imported products).
 * - SKUs are prefixed with `LNF-<productSkuBase>-<suffix>` per the
 *   same pattern as `product-map.ts`. Every re-import generates a
 *   FRESH suffix — duplicate catalog entries yield distinct products
 *   by design (sellers use re-import for "same base, different
 *   design" listings).
 * - Slug is derived from title + the same short suffix, so the same
 *   catalog entry imported twice gets two distinct slugs without
 *   colliding on the `idx_products_shop_slug` unique index.
 * - Everything happens in a single transaction. If any step fails,
 *   the product and all its children roll back — we never leave a
 *   half-written row.
 * - The `lenful_product_map` row is what makes future order routing
 *   work: when an order contains a variant whose product has a map
 *   entry, the fulfillment pipeline knows to push the order to
 *   Lenful instead of treating it as self-fulfilled inventory.
 */

import type { Kysely } from 'kysely'
import type { Database } from '../../../../../db/src/schema/tables.js'
import type { NormalizedCatalogEntry } from './catalog-sync.ts'

// ─────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────

export interface CopyCatalogEntryInput {
  readonly shopId: string
  readonly entry: NormalizedCatalogEntry
  readonly userId?: string | null
}

export type CopyCatalogEntryResult =
  | {
      readonly ok: true
      readonly productId: string
      readonly slug: string
      readonly variantCount: number
      readonly imageCount: number
    }
  | {
      readonly ok: false
      readonly errorCode: string
      readonly errorMessage: string
    }

// ─────────────────────────────────────────────────────────────
// Helpers — intentionally duplicated from product-map.ts so the
// two mappers can evolve independently (legacy pushes may need
// different body-html / sku shape than local drafts someday).
// ─────────────────────────────────────────────────────────────

const SKU_PREFIX = 'LNF'

function shortRand(): string {
  // 6 base-36 chars — ~2B space, collision-resistant per re-import window.
  return Math.random().toString(36).slice(2, 8).toUpperCase()
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildBodyHtml(entry: NormalizedCatalogEntry): string {
  const hero = entry.description
    ? entry.description.trim()
    : `Premium ${entry.category_name || 'print-on-demand'} product, crafted on demand and shipped through the Gbox fulfillment partner network. Add your own design, your own price, and start selling today.`
  const optionRows = entry.options
    .map(
      (o) =>
        `<li><strong>${escHtml(o.name)}:</strong> ${o.values
          .map(escHtml)
          .join(' \u2022 ')}</li>`,
    )
    .join('')
  return [
    '<div class="gbox-product-description">',
    `  <p>${escHtml(hero)}</p>`,
    entry.options.length > 0
      ? `  <h3>Available options</h3>\n  <ul>\n    ${optionRows}\n  </ul>`
      : '',
    '  <h3>Why you\'ll love it</h3>',
    '  <ul>',
    '    <li><strong>Print-on-demand</strong> &mdash; no inventory risk, no upfront cost</li>',
    '    <li><strong>Ships worldwide</strong> &mdash; fulfilled through Gbox\'s global partner network</li>',
    '    <li><strong>Quality guaranteed</strong> &mdash; every order is inspected before it leaves the warehouse</li>',
    '    <li><strong>Custom designs welcome</strong> &mdash; upload your artwork and we\'ll handle the rest</li>',
    '  </ul>',
    '</div>',
  ]
    .filter(Boolean)
    .join('\n')
}

function buildSlug(title: string, suffix: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
  return base
    ? `${base}-${suffix.toLowerCase()}`
    : `lenful-${suffix.toLowerCase()}`
}

function buildTags(entry: NormalizedCatalogEntry): string[] {
  const raw = ['lenful', 'pod', entry.category_slug ?? '']
  return raw.filter(Boolean).filter((v, i, a) => a.indexOf(v) === i) as string[]
}

/** Build the deduplicated, ordered image URL list (thumbnail first). */
function buildImageUrls(entry: NormalizedCatalogEntry): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (url: string | null | undefined) => {
    if (!url) return
    const clean = url.trim()
    if (!clean || seen.has(clean)) return
    seen.add(clean)
    out.push(clean)
  }
  push(entry.thumbnail_url)
  for (const g of entry.gallery_urls) push(g)
  return out
}

/**
 * Build a numeric string for a `numeric(10,2)` column. Null/NaN → '0'.
 * We stringify because Postgres returns `numeric` as a string via pg,
 * and every other call site treats variant.price as a string.
 */
function toPriceString(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '0'
  // Clamp to 2 decimals to match the column scale — avoids Postgres
  // rounding surprises like 19.999 → 20.00.
  return (Math.round(n * 100) / 100).toFixed(2)
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

/**
 * Materialize a Lenful catalog entry as a local v4 DRAFT product.
 *
 * Writes (in one transaction):
 *   - products (status='draft')
 *   - product_variants (1 per normalized variant, or a single default)
 *   - product_images (thumbnail + gallery, deduped, positional)
 *   - lenful_product_map (links the product to the Lenful entry)
 *
 * Returns `{ ok: true, productId, slug, variantCount, imageCount }` or
 * a typed error. The caller redirects to the product detail page on
 * success so the seller can review + edit before publishing.
 */
export async function copyCatalogEntryToLocalProduct(
  db: Kysely<Database>,
  input: CopyCatalogEntryInput,
): Promise<CopyCatalogEntryResult> {
  const { shopId, entry } = input
  if (!shopId) {
    return {
      ok: false,
      errorCode: 'missing_shop',
      errorMessage: 'shopId is required',
    }
  }
  if (!entry || !entry.lenful_product_id) {
    return {
      ok: false,
      errorCode: 'missing_entry',
      errorMessage: 'Catalog entry is required',
    }
  }

  const title = (entry.title?.trim() || entry.lenful_product_sku).slice(0, 255)
  const skuSuffix = shortRand()
  const productSkuBase = (entry.lenful_product_sku || 'LENFUL')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .slice(0, 24)
  const productSkuPrefix = `${SKU_PREFIX}-${productSkuBase}-${skuSuffix}`
  const slug = buildSlug(title, skuSuffix)
  const tags = buildTags(entry)
  const bodyHtml = buildBodyHtml(entry)
  const imageUrls = buildImageUrls(entry)

  try {
    return await db.transaction().execute(async (trx) => {
      // 1. Insert the parent product row (draft, unpublished).
      const product = await trx
        .insertInto('products')
        .values({
          shop_id: shopId,
          title,
          slug,
          body_html: bodyHtml,
          vendor: 'Lenful POD',
          product_type: entry.category_name ?? null,
          status: 'draft',
          tags,
          template_suffix: null,
          published_at: null,
          seo_title: `${title} | Gbox`,
          seo_description:
            (entry.description ?? '').slice(0, 160) ||
            `Order ${title} on Gbox. Print-on-demand, ships worldwide.`,
        } as any)
        .returningAll()
        .executeTakeFirstOrThrow()

      const productId = String((product as any).id)

      // 2. Insert variants — 1:1 from Lenful, or a single default when
      //    the catalog entry is a single-SKU product.
      const variantRows =
        entry.variants.length === 0
          ? [
              {
                product_id: productId,
                title: 'Default',
                price: toPriceString(entry.base_price),
                sku: `${productSkuPrefix}-DEFAULT`,
                option1: 'Default',
                option2: null,
                option3: null,
                position: 1,
                inventory_quantity: 0,
                image_url: imageUrls[0] ?? null,
              },
            ]
          : (() => {
              const used = new Set<string>()
              return entry.variants.map((v, idx) => {
                const rawSku = (v.sku || `${productSkuPrefix}-V${idx + 1}`)
                  .toUpperCase()
                let sku = `${productSkuPrefix}-${rawSku}`
                let attempt = 1
                while (used.has(sku)) {
                  sku = `${productSkuPrefix}-${rawSku}-${attempt++}`
                }
                used.add(sku)
                const opts = v.options ?? []
                return {
                  product_id: productId,
                  title: v.title || v.sku || `Variant ${idx + 1}`,
                  price: toPriceString(v.price ?? entry.base_price),
                  sku,
                  option1: opts[0]?.value ?? null,
                  option2: opts[1]?.value ?? null,
                  option3: opts[2]?.value ?? null,
                  position: idx + 1,
                  inventory_quantity: 0,
                  image_url: v.thumbnail ?? imageUrls[0] ?? null,
                }
              })
            })()

      const insertedVariants = await trx
        .insertInto('product_variants')
        .values(variantRows as any)
        .returningAll()
        .execute()

      // 3. Insert images (thumbnail first, gallery follows, deduped).
      if (imageUrls.length > 0) {
        await trx
          .insertInto('product_images')
          .values(
            imageUrls.map((src, i) => ({
              product_id: productId,
              src,
              alt: title,
              position: i + 1,
              width: null,
              height: null,
            })) as any,
          )
          .execute()
      }

      // 4. Map Lenful → Gbox so the fulfillment pipeline can route
      //    orders back to Lenful later. One map row per variant is
      //    the cleanest model — order routing can pick the right
      //    Lenful SKU per line item without having to re-query the
      //    variant's sku. When we only have one variant (or the
      //    catalog entry doesn't carry per-variant SKUs), we still
      //    write a product-level row with `gbox_variant_id=null` so
      //    a legacy order routing that falls back to product-level
      //    resolution still finds a mapping.
      const mapRows: any[] = []
      if (entry.variants.length === 0) {
        mapRows.push({
          gbox_product_id: productId,
          gbox_variant_id: null,
          lenful_product_id: entry.lenful_product_id,
          lenful_product_sku: entry.lenful_product_sku,
          lenful_product_title: entry.title ?? null,
          lenful_category_slug: entry.category_slug ?? null,
          mapped_by: input.userId ?? null,
        })
      } else {
        for (let i = 0; i < entry.variants.length; i++) {
          const gboxVariant = insertedVariants[i] as any
          if (!gboxVariant) continue
          mapRows.push({
            gbox_product_id: productId,
            gbox_variant_id: String(gboxVariant.id),
            lenful_product_id: entry.lenful_product_id,
            lenful_product_sku:
              entry.variants[i]!.sku || entry.lenful_product_sku,
            lenful_product_title: entry.title ?? null,
            lenful_category_slug: entry.category_slug ?? null,
            mapped_by: input.userId ?? null,
          })
        }
      }

      if (mapRows.length > 0) {
        await trx
          .insertInto('lenful_product_map')
          .values(mapRows as any)
          .execute()
      }

      return {
        ok: true as const,
        productId,
        slug,
        variantCount: insertedVariants.length,
        imageCount: imageUrls.length,
      }
    })
  } catch (err: any) {
    // Surface unique-constraint collisions distinctly so the handler
    // can retry with a fresh suffix if it ever matters (extremely
    // unlikely given ~2B space, but defensive).
    const msg = err?.message ?? String(err)
    const code = /duplicate key|unique/i.test(msg)
      ? 'duplicate_slug'
      : 'insert_failed'
    return {
      ok: false,
      errorCode: code,
      errorMessage: msg.slice(0, 500),
    }
  }
}
