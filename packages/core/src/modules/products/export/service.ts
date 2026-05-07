/**
 * Products Export Service
 *
 * One-call entry point that fetches products + variants + images +
 * options + optional metafields from Postgres and hands off to the pure
 * `exportProductsCsv` / `exportProductsJson` formatters in
 * `./csv-exporter.ts`.
 *
 * Split from the HTTP handler so the REST API and the store-admin
 * dashboard share a single source of truth — "include cost column" or
 * "add gift card detection" only changes in one place.
 *
 * Design notes:
 *   - All queries are shop-scoped (shop_id = :shopId). Nothing else may
 *     pierce the tenant boundary.
 *   - Metafield column discovery runs via a single DISTINCT query over
 *     the products + variants in scope, so the header is deterministic
 *     per export.
 *   - Limits are enforced at the base products query (default 10_000 —
 *     same ceiling as orders export). Above that we truncate silently;
 *     a future streaming variant will remove the ceiling.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import {
  exportProductsCsv,
  exportProductsJson,
  discoverMetafieldColumns,
  type ExportImage,
  type ExportOption,
  type ExportOptions,
  type ExportProduct,
  type ExportVariant,
  type MetafieldColumn,
} from './csv-exporter.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProductExportScope =
  | 'all'
  | 'active'
  | 'draft'
  | 'archived'
  | 'collection'
  | 'selected'

export interface FetchExportProductsParams {
  scope?: ProductExportScope
  /** When scope='collection'. */
  collection_id?: string
  /** When scope='selected'. */
  ids?: string[]
  /** Safety cap — silently truncated above. */
  limit?: number
  /** Filter by vendor (case-insensitive substring). */
  vendor?: string
  /** Filter by product_type (exact match). */
  product_type?: string
  /** Include product + variant metafields in the output (default: true). */
  includeMetafields?: boolean
}

export interface ProductExportResult {
  data: string
  contentType: string
  filename: string
  /** Number of *products* included (not rows — a product with N variants emits N rows). */
  productCount: number
  /** Number of metafield columns in the header (0 when includeMetafields=false). */
  metafieldColumnCount: number
}

// ---------------------------------------------------------------------------
// Weight conversion (kg ⇒ grams) used by the exporter. Kept here so the
// pure module doesn't need to know about the DB's weight_unit string.
// ---------------------------------------------------------------------------

function toGrams(weight: string | null, unit: string): number {
  if (!weight) return 0
  const n = Number(weight)
  if (!Number.isFinite(n)) return 0
  const u = (unit || 'kg').toLowerCase()
  switch (u) {
    case 'kg':
      return Math.round(n * 1000)
    case 'g':
      return Math.round(n)
    case 'lb':
      return Math.round(n * 453.59237)
    case 'oz':
      return Math.round(n * 28.3495231)
    default:
      return Math.round(n)
  }
}

// ---------------------------------------------------------------------------
// Core: fetch ExportProduct[] from the DB
// ---------------------------------------------------------------------------

/**
 * Load products (plus variants / images / options / metafields) into the
 * shape the formatter expects. Ordering: position on variants/images, then
 * `created_at DESC` on products — matches what sellers see in the admin
 * list, which keeps export diffs readable.
 */
export async function fetchProductsForExport(
  db: Kysely<Database>,
  shopId: string,
  params: FetchExportProductsParams = {},
): Promise<{ products: ExportProduct[]; metafieldColumns: MetafieldColumn[] }> {
  const {
    scope = 'all',
    collection_id,
    ids,
    limit = 10_000,
    vendor,
    product_type,
    includeMetafields = true,
  } = params

  // ── Products ────────────────────────────────────────────────────────────
  let q = db
    .selectFrom('products')
    .selectAll()
    .where('shop_id', '=', shopId)

  if (scope === 'active') q = q.where('status', '=', 'active')
  else if (scope === 'draft') q = q.where('status', '=', 'draft')
  else if (scope === 'archived') q = q.where('status', '=', 'archived')
  else if (scope === 'selected' && ids && ids.length > 0) {
    q = q.where('id', 'in', ids)
  }

  if (vendor) q = q.where('vendor', 'ilike', `%${vendor}%`)
  if (product_type) q = q.where('product_type', '=', product_type)

  // Collection scope uses an IN-subquery to stay shop-safe (collections
  // table is also shop_id-scoped, so a product_id leak via a mismatched
  // collection_id is impossible).
  if (scope === 'collection' && collection_id) {
    q = q.where(
      'id',
      'in',
      db
        .selectFrom('collection_products')
        .innerJoin('collections', 'collections.id', 'collection_products.collection_id')
        .select('collection_products.product_id')
        .where('collections.shop_id', '=', shopId)
        .where('collection_products.collection_id', '=', collection_id),
    )
  }

  const productRows = await q.orderBy('created_at', 'desc').limit(limit).execute()
  if (productRows.length === 0) {
    return { products: [], metafieldColumns: [] }
  }

  const productIds = productRows.map((p) => p.id)

  // ── Variants / images / options (parallel) ─────────────────────────────
  const [variantRows, imageRows, optionRows] = await Promise.all([
    db
      .selectFrom('product_variants')
      .selectAll()
      .where('product_id', 'in', productIds)
      .orderBy('position', 'asc')
      .execute(),
    db
      .selectFrom('product_images')
      .selectAll()
      .where('product_id', 'in', productIds)
      .orderBy('position', 'asc')
      .execute(),
    db
      .selectFrom('product_options')
      .selectAll()
      .where('product_id', 'in', productIds)
      .orderBy('position', 'asc')
      .execute(),
  ])

  const variantIds = variantRows.map((v) => v.id as string)
  const variantsByProduct = groupBy(variantRows, 'product_id')
  const imagesByProduct = groupBy(imageRows, 'product_id')
  const optionsByProduct = groupBy(optionRows, 'product_id')

  // ── Metafields + column discovery ─────────────────────────────────────
  let productMetafieldsByOwner = new Map<string, Map<string, RawMetafield>>()
  let variantMetafieldsByOwner = new Map<string, Map<string, RawMetafield>>()
  let metafieldColumns: MetafieldColumn[] = []

  if (includeMetafields) {
    const [productMfs, variantMfs] = await Promise.all([
      db
        .selectFrom('metafields')
        .select(['id', 'owner_id', 'namespace', 'key', 'value', 'value_type'])
        .where('shop_id', '=', shopId)
        .where('owner_type', '=', 'product')
        .where('owner_id', 'in', productIds)
        .execute()
        .catch(() => [] as RawMetafield[]),
      variantIds.length > 0
        ? db
            .selectFrom('metafields')
            .select(['id', 'owner_id', 'namespace', 'key', 'value', 'value_type'])
            .where('shop_id', '=', shopId)
            .where('owner_type', '=', 'variant')
            .where('owner_id', 'in', variantIds)
            .execute()
            .catch(() => [] as RawMetafield[])
        : Promise.resolve([] as RawMetafield[]),
    ])

    productMetafieldsByOwner = indexMetafields(productMfs as RawMetafield[])
    variantMetafieldsByOwner = indexMetafields(variantMfs as RawMetafield[])

    metafieldColumns = discoverMetafieldColumns([
      ...(productMfs as RawMetafield[]).map((r) => ({
        owner_type: 'product',
        namespace: r.namespace,
        key: r.key,
        value_type: r.value_type,
      })),
      ...(variantMfs as RawMetafield[]).map((r) => ({
        owner_type: 'variant',
        namespace: r.namespace,
        key: r.key,
        value_type: r.value_type,
      })),
    ])
  }

  // ── Shape each product ────────────────────────────────────────────────
  const products: ExportProduct[] = productRows.map((p) => {
    const vRows = variantsByProduct.get(p.id) || []
    const iRows = imagesByProduct.get(p.id) || []
    const oRows = optionsByProduct.get(p.id) || []

    const variants: ExportVariant[] = vRows.map((v: any) => ({
      id: v.id,
      sku: v.sku ?? null,
      barcode: v.barcode ?? null,
      price: String(v.price ?? '0'),
      compare_at_price: v.compare_at_price != null ? String(v.compare_at_price) : null,
      cost: v.cost != null ? String(v.cost) : null,
      grams: toGrams(v.weight ?? null, v.weight_unit ?? 'kg'),
      weight: v.weight != null ? String(v.weight) : null,
      weight_unit: v.weight_unit || 'kg',
      inventory_quantity: Number(v.inventory_quantity) || 0,
      // Migration 054 — read real DB columns. Falls back to legacy
      // defaults when the column is missing (pre-053 test fixtures
      // and in-memory fake DB builders don't always materialize it).
      inventory_policy: v.inventory_policy === 'continue' ? 'continue' : 'deny',
      // inventory_management=null means "not tracked" → Shopify-style
      // empty string; any non-null value means tracked → 'shopify'.
      inventory_tracker: v.inventory_management ? 'shopify' : '',
      fulfillment_service: v.fulfillment_service || 'manual',
      requires_shipping: v.requires_shipping !== false,
      taxable: v.taxable !== false,
      option1: v.option1 ?? null,
      option2: v.option2 ?? null,
      option3: v.option3 ?? null,
      image_url: v.image_url ?? null,
      hs_code: v.hs_code ?? null,
      country_of_origin: v.country_of_origin ?? null,
      metafields: cellsForOwner(variantMetafieldsByOwner, v.id),
    }))

    const images: ExportImage[] = iRows.map((i: any) => ({
      src: i.src,
      alt: i.alt ?? null,
      position: Number(i.position) || 0,
    }))

    const options: ExportOption[] = oRows.map((o: any) => ({
      name: o.name,
      position: Number(o.position) || 0,
    }))

    return {
      id: p.id,
      handle: p.slug,
      title: p.title,
      body_html: p.body_html,
      vendor: p.vendor,
      product_type: p.product_type,
      tags: (p.tags as string[] | null) ?? null,
      status: p.status,
      published_at: p.published_at ? String(p.published_at) : null,
      seo_title: p.seo_title ?? null,
      seo_description: p.seo_description ?? null,
      variants,
      images,
      options,
      metafields: cellsForOwner(productMetafieldsByOwner, p.id),
    }
  })

  return { products, metafieldColumns }
}

// ---------------------------------------------------------------------------
// One-call wrapper that returns an ExportResult ready for HTTP
// ---------------------------------------------------------------------------

/**
 * One-call wrapper used by the dashboard POST handler and the REST API
 * to stream back a CSV / JSON export with the correct content type +
 * filename.
 *
 * BOM prefix is added for CSV so Excel opens UTF-8 files correctly.
 */
export async function generateProductsExport(
  db: Kysely<Database>,
  shopId: string,
  params: FetchExportProductsParams & {
    format: 'csv' | 'json'
    storeSlug?: string
    options?: Omit<ExportOptions, 'metafieldColumns'>
  },
): Promise<ProductExportResult> {
  const { products, metafieldColumns } = await fetchProductsForExport(db, shopId, params)
  const timestamp = new Date().toISOString().slice(0, 10)
  const storeName = params.storeSlug || 'store'

  if (params.format === 'json') {
    return {
      data: exportProductsJson(products),
      contentType: 'application/json',
      filename: `products-${storeName}-${timestamp}.json`,
      productCount: products.length,
      metafieldColumnCount: metafieldColumns.length,
    }
  }

  const csv = exportProductsCsv(products, {
    ...(params.options ?? {}),
    metafieldColumns,
  })
  return {
    data: '\ufeff' + csv,
    contentType: 'text/csv; charset=utf-8',
    filename: `products-${storeName}-${timestamp}.csv`,
    productCount: products.length,
    metafieldColumnCount: metafieldColumns.length,
  }
}

// ---------------------------------------------------------------------------
// Helpers (module-private)
// ---------------------------------------------------------------------------

interface RawMetafield {
  id: string
  owner_id: string
  namespace: string
  key: string
  value: string
  value_type: string
}

/**
 * Build a nested Map[owner_id → Map[namespace.key → RawMetafield]] so the
 * final shaping pass does O(1) lookups instead of a re-scan per variant.
 */
function indexMetafields(rows: RawMetafield[]): Map<string, Map<string, RawMetafield>> {
  const out = new Map<string, Map<string, RawMetafield>>()
  for (const r of rows) {
    let inner = out.get(r.owner_id)
    if (!inner) {
      inner = new Map()
      out.set(r.owner_id, inner)
    }
    inner.set(`${r.namespace}.${r.key}`, r)
  }
  return out
}

function cellsForOwner(
  index: Map<string, Map<string, RawMetafield>>,
  ownerId: string,
): ExportProduct['metafields'] {
  const inner = index.get(ownerId)
  if (!inner) return {}
  const out: ExportProduct['metafields'] = {}
  for (const [cacheKey, row] of inner) {
    out[cacheKey] = {
      namespace: row.namespace,
      key: row.key,
      value_type: row.value_type,
      // `metafields.value` is JSONB — Postgres driver decodes it into a
      // JS value (string, number, object, …). The exporter expects a
      // string cell, and round-tripping through JSON.stringify keeps the
      // "[type]"-tagged columns re-importable by Shopify (which expects
      // JSON-encoded values for non-text types). Strings come back
      // double-quoted which is what Shopify's importer also writes.
      value: serializeMetafieldValue(row.value),
    }
  }
  return out
}

/**
 * Stringify a JSONB value for CSV output. A string cell already coming
 * back from the driver as `"foo"` (already JSON-encoded) is preserved;
 * raw strings get re-encoded.
 */
function serializeMetafieldValue(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  if (typeof raw === 'string') {
    // If the DB gave us a JSON string like `"cotton"` or `42`, it's
    // already a literal. Otherwise wrap.
    const t = raw.trim()
    if (
      (t.startsWith('"') && t.endsWith('"')) ||
      t === 'true' ||
      t === 'false' ||
      t === 'null' ||
      /^-?\d+(\.\d+)?$/.test(t) ||
      t.startsWith('{') ||
      t.startsWith('[')
    ) {
      return raw
    }
    return JSON.stringify(raw)
  }
  try {
    return JSON.stringify(raw)
  } catch {
    return ''
  }
}

function groupBy<T extends Record<string, any>>(
  rows: T[],
  key: keyof T,
): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    const k = String(row[key])
    const list = map.get(k) || []
    list.push(row)
    map.set(k, list)
  }
  return map
}
