/**
 * Lenful Catalog Sync (Phase F8)
 *
 * Pulls the full Lenful seller catalog into the local `lenful_catalog`
 * cache. Designed to run two ways:
 *
 *   1. On a cron every N hours (future work — Phase F8.2)
 *   2. On-demand via a "Sync now" button on the seller Products page
 *
 * The cache powers the "Lenful products" tab on the seller-side Products
 * listing page where merchants one-click import Lenful POD products as
 * brand-new Gbox draft products.
 *
 * Soft-delete policy
 * ------------------
 * We mark rows that disappear from Lenful as `is_active = false` rather
 * than hard-deleting. Existing `lenful_product_map` rows (and any
 * imported Gbox products) should keep working even if a catalog entry
 * is temporarily hidden. A full reconcile is run at the end of every
 * sync pass.
 *
 * Variant parsing
 * ---------------
 * Lenful's product endpoint embeds variants under several possible
 * field names (`variants`, `product_variants`, `options`, etc.) —
 * we probe all of them and emit a uniform shape:
 *
 *   {
 *     id: string
 *     sku: string
 *     title: string          // "Size / Color"
 *     options: { name: string, value: string }[]
 *     price: number | null
 *     thumbnail: string | null
 *   }
 *
 * Import-side code reads this to replay the variants into Gbox
 * `product_variants` 1:1, so a sellers draft is fully multi-variant
 * from the moment they click Import.
 */

import type { Kysely } from 'kysely'
import type { Database } from '../../../../../db/src/schema/tables.js'
import { LenfulClient } from './client.ts'
import type { LenfulCatalogProduct } from './types.ts'

export interface NormalizedVariant {
  readonly id: string
  readonly sku: string
  readonly title: string
  readonly options: ReadonlyArray<{ name: string; value: string }>
  readonly price: number | null
  readonly thumbnail: string | null
  readonly raw: unknown
}

export interface NormalizedOption {
  readonly name: string
  readonly values: ReadonlyArray<string>
}

export interface NormalizedCatalogEntry {
  readonly lenful_product_id: string
  readonly lenful_product_sku: string
  readonly title: string | null
  readonly description: string | null
  readonly category_slug: string | null
  readonly category_name: string | null
  readonly thumbnail_url: string | null
  readonly gallery_urls: ReadonlyArray<string>
  readonly base_price: number | null
  readonly currency: string
  readonly variants: ReadonlyArray<NormalizedVariant>
  readonly options: ReadonlyArray<NormalizedOption>
  readonly raw: unknown
}

export interface SyncResult {
  readonly fetched: number
  readonly upserted: number
  readonly deactivated: number
  readonly errors: ReadonlyArray<{ lenful_product_id?: string; message: string }>
}

// ─────────────────────────────────────────────────────────────
// Variant parsing — probes several shapes Lenful has used
// ─────────────────────────────────────────────────────────────

function asArray(value: unknown): ReadonlyArray<any> {
  if (Array.isArray(value)) return value
  return []
}

function pickFirstString(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim()
    if (typeof c === 'number') return String(c)
  }
  return null
}

function pickFirstNumber(...candidates: unknown[]): number | null {
  for (const c of candidates) {
    if (typeof c === 'number' && !Number.isNaN(c)) return c
    if (typeof c === 'string' && c.trim().length > 0) {
      const n = Number(c)
      if (!Number.isNaN(n)) return n
    }
  }
  return null
}

/**
 * Pull a variant list out of a Lenful raw product payload. Tries the
 * known field names in order; first non-empty array wins.
 */
function extractVariantList(raw: any): ReadonlyArray<any> {
  if (!raw || typeof raw !== 'object') return []
  const candidates = [
    raw.variants,
    raw.product_variants,
    raw.skus,
    raw.product_skus,
    raw.options_with_variant,
    raw.children,
  ]
  for (const c of candidates) {
    const arr = asArray(c)
    if (arr.length > 0) return arr
  }
  return []
}

/** Extract an [{ name, value }] option list from a raw variant row. */
function extractVariantOptions(
  rawVariant: any,
): ReadonlyArray<{ name: string; value: string }> {
  if (!rawVariant || typeof rawVariant !== 'object') return []
  // Shape 1: variant.options = [{ name, value }]
  if (Array.isArray(rawVariant.options)) {
    const out: { name: string; value: string }[] = []
    for (const o of rawVariant.options) {
      if (o && typeof o === 'object') {
        const name = pickFirstString(o.name, o.option_name, o.key)
        const value = pickFirstString(o.value, o.option_value, o.val)
        if (name && value) out.push({ name, value })
      }
    }
    if (out.length > 0) return out
  }
  // Shape 2: flat size/color/material fields on the variant row
  const out: { name: string; value: string }[] = []
  const known = ['size', 'color', 'colour', 'material', 'style', 'fit']
  for (const key of known) {
    const v = rawVariant[key]
    if (typeof v === 'string' && v.trim().length > 0) {
      out.push({ name: key[0]!.toUpperCase() + key.slice(1), value: v.trim() })
    }
  }
  if (out.length > 0) return out
  // Shape 3: `title` with "/" separator like "L / Black"
  const title = pickFirstString(rawVariant.title, rawVariant.name)
  if (title && title.includes('/')) {
    const parts = title.split('/').map((p) => p.trim()).filter(Boolean)
    return parts.map((v, i) => ({ name: `Option ${i + 1}`, value: v }))
  }
  return []
}

function normalizeVariants(raw: any): ReadonlyArray<NormalizedVariant> {
  const rows = extractVariantList(raw)
  const out: NormalizedVariant[] = []
  for (const r of rows) {
    const id = pickFirstString(r?.id, r?.variant_id, r?.sku, r?.product_sku)
    const sku = pickFirstString(r?.sku, r?.product_sku, r?.variant_sku, id)
    if (!id || !sku) continue
    const options = extractVariantOptions(r)
    const titleFromOptions = options.map((o) => o.value).join(' / ')
    const title =
      pickFirstString(r?.title, r?.name, titleFromOptions) ?? titleFromOptions ?? sku
    const price = pickFirstNumber(r?.price, r?.base_price, r?.cost)
    const thumbnail = pickFirstString(
      r?.thumbnail,
      r?.image,
      r?.image_url,
      r?.preview_url,
    )
    out.push({
      id,
      sku,
      title,
      options,
      price,
      thumbnail,
      raw: r,
    })
  }
  return out
}

/** Collapse the variant list into an "Option axes" summary (Shopify-style). */
function deriveOptions(
  variants: ReadonlyArray<NormalizedVariant>,
): ReadonlyArray<NormalizedOption> {
  const byName = new Map<string, Set<string>>()
  for (const v of variants) {
    for (const o of v.options) {
      if (!byName.has(o.name)) byName.set(o.name, new Set())
      byName.get(o.name)!.add(o.value)
    }
  }
  return Array.from(byName.entries()).map(([name, values]) => ({
    name,
    values: Array.from(values),
  }))
}

/** Pull gallery images from the raw payload. */
function extractGalleryUrls(raw: any): ReadonlyArray<string> {
  if (!raw || typeof raw !== 'object') return []
  const candidates = [raw.images, raw.gallery, raw.photos, raw.mockups]
  for (const c of candidates) {
    if (Array.isArray(c)) {
      const urls: string[] = []
      for (const item of c) {
        if (typeof item === 'string') urls.push(item)
        else if (item && typeof item === 'object') {
          const u = pickFirstString(
            item.url,
            item.src,
            item.link,
            item.image,
            item.image_url,
          )
          if (u) urls.push(u)
        }
      }
      if (urls.length > 0) return urls
    }
  }
  return []
}

/**
 * Convert the Lenful client's normalized product + raw payload into
 * the shape we store in `lenful_catalog`. This is the single source of
 * truth for "what goes in the DB".
 */
export function normalizeCatalogEntry(
  p: LenfulCatalogProduct,
): NormalizedCatalogEntry | null {
  const raw: any = p.raw
  const lenful_product_id = pickFirstString(p.id, raw?.id, raw?.product_id)
  const lenful_product_sku = pickFirstString(
    p.product_sku,
    p.sku,
    raw?.product_sku,
    raw?.sku,
  )
  if (!lenful_product_id || !lenful_product_sku) return null

  const variants = normalizeVariants(raw)
  const options = deriveOptions(variants)

  const category_slug = pickFirstString(
    p.category,
    raw?.category_slug,
    raw?.category?.slug,
  )
  const category_name = pickFirstString(
    raw?.category_name,
    raw?.category?.name,
    p.category,
  )

  const base_price = pickFirstNumber(p.price, raw?.price, raw?.base_price)
  const currency = pickFirstString(raw?.currency) ?? 'USD'

  const description = pickFirstString(
    raw?.description,
    raw?.product_description,
    raw?.short_description,
  )

  return {
    lenful_product_id,
    lenful_product_sku,
    title: p.title ?? null,
    description,
    category_slug,
    category_name,
    thumbnail_url: p.thumbnail ?? null,
    gallery_urls: extractGalleryUrls(raw),
    base_price,
    currency,
    variants,
    options,
    raw: p.raw ?? null,
  }
}

// ─────────────────────────────────────────────────────────────
// DB upsert
// ─────────────────────────────────────────────────────────────

export async function upsertCatalogEntry(
  db: Kysely<Database>,
  e: NormalizedCatalogEntry,
): Promise<void> {
  const existing = await db
    .selectFrom('lenful_catalog')
    .select(['lenful_product_id'])
    .where('lenful_product_id', '=', e.lenful_product_id)
    .executeTakeFirst()

  const now = new Date().toISOString()
  if (existing) {
    await db
      .updateTable('lenful_catalog')
      .set({
        lenful_product_sku: e.lenful_product_sku,
        title: e.title,
        description: e.description,
        category_slug: e.category_slug,
        category_name: e.category_name,
        thumbnail_url: e.thumbnail_url,
        gallery_urls: JSON.stringify(e.gallery_urls) as any,
        base_price: e.base_price != null ? String(e.base_price) : null,
        currency: e.currency,
        variants_json: JSON.stringify(e.variants) as any,
        options_json: JSON.stringify(e.options) as any,
        raw_payload: e.raw ? (JSON.stringify(e.raw) as any) : null,
        is_active: true,
        last_synced_at: now,
      })
      .where('lenful_product_id', '=', e.lenful_product_id)
      .execute()
  } else {
    await db
      .insertInto('lenful_catalog')
      .values({
        lenful_product_id: e.lenful_product_id,
        lenful_product_sku: e.lenful_product_sku,
        title: e.title,
        description: e.description,
        category_slug: e.category_slug,
        category_name: e.category_name,
        thumbnail_url: e.thumbnail_url,
        gallery_urls: JSON.stringify(e.gallery_urls) as any,
        base_price: e.base_price != null ? String(e.base_price) : null,
        currency: e.currency,
        variants_json: JSON.stringify(e.variants) as any,
        options_json: JSON.stringify(e.options) as any,
        raw_payload: e.raw ? (JSON.stringify(e.raw) as any) : null,
        is_active: true,
        last_synced_at: now,
      })
      .execute()
  }
}

/**
 * Full sync from the live Lenful API. Walks pages until the API returns
 * an empty set or we've exceeded the safety cap, upserts each row, then
 * reconciles by marking anything not seen this pass as `is_active = false`.
 */
export async function syncCatalogFromLive(
  db: Kysely<Database>,
  opts: {
    credentialId: string
    triggeredBy?: string
    userId?: string | null
    /**
     * Max pages to walk as a safety cap. The loop also breaks naturally
     * when Lenful returns an empty page or a partial page, so this cap
     * is purely a runaway-protection ceiling — raise it freely when
     * pulling a real seller catalog that might exceed early-dev estimates.
     *
     * Default 500 pages × 100 per page = 50,000 products — comfortable
     * headroom for any realistic Lenful seller. At 2 req/s rate limit
     * the worst-case wall-clock for 500 pages is ~4.2 minutes.
     */
    maxPages?: number
    pageSize?: number
  },
): Promise<SyncResult> {
  const client = new LenfulClient({
    db,
    credentialId: opts.credentialId,
    triggeredBy: opts.triggeredBy ?? 'seller-sync',
    userId: opts.userId ?? null,
  })

  const maxPages = opts.maxPages ?? 500
  const pageSize = opts.pageSize ?? 100
  const seenIds = new Set<string>()
  const errors: { lenful_product_id?: string; message: string }[] = []
  let fetched = 0
  let upserted = 0

  for (let page = 1; page <= maxPages; page++) {
    let resp: Awaited<ReturnType<LenfulClient['listProducts']>> | null = null
    try {
      resp = await client.listProducts({ page, limit: pageSize })
    } catch (err: any) {
      errors.push({ message: `page ${page}: ${err?.message ?? String(err)}` })
      break
    }
    if (!resp || resp.items.length === 0) break
    fetched += resp.items.length

    for (const item of resp.items) {
      const normalized = normalizeCatalogEntry(item)
      if (!normalized) {
        errors.push({
          message: `skipped (missing id/sku): ${JSON.stringify(item).slice(0, 160)}`,
        })
        continue
      }
      try {
        await upsertCatalogEntry(db, normalized)
        seenIds.add(normalized.lenful_product_id)
        upserted++
      } catch (err: any) {
        errors.push({
          lenful_product_id: normalized.lenful_product_id,
          message: err?.message ?? String(err),
        })
      }
    }

    // If we got less than a full page, there's no next page.
    if (resp.items.length < pageSize) break
  }

  // Soft-delete reconcile: anything previously active that wasn't seen.
  let deactivated = 0
  if (seenIds.size > 0) {
    const stale = await db
      .selectFrom('lenful_catalog')
      .select(['lenful_product_id'])
      .where('is_active', '=', true)
      .where('lenful_product_id', 'not in', Array.from(seenIds))
      .execute()
    if (stale.length > 0) {
      await db
        .updateTable('lenful_catalog')
        .set({ is_active: false, last_synced_at: new Date().toISOString() })
        .where(
          'lenful_product_id',
          'in',
          stale.map((r) => r.lenful_product_id),
        )
        .execute()
      deactivated = stale.length
    }
  }

  return { fetched, upserted, deactivated, errors }
}

// ─────────────────────────────────────────────────────────────
// Read path (used by the seller Products page)
// ─────────────────────────────────────────────────────────────

export interface CatalogListParams {
  readonly search?: string
  readonly category?: string
  readonly page?: number
  readonly limit?: number
  readonly includeInactive?: boolean
}

export interface CatalogListRow {
  readonly lenful_product_id: string
  readonly lenful_product_sku: string
  readonly title: string | null
  readonly category_slug: string | null
  readonly category_name: string | null
  readonly thumbnail_url: string | null
  readonly base_price: string | null
  readonly currency: string
  readonly variant_count: number
  readonly is_active: boolean
  readonly last_synced_at: string
}

export async function listCatalog(
  db: Kysely<Database>,
  params: CatalogListParams = {},
): Promise<{ rows: ReadonlyArray<CatalogListRow>; total: number }> {
  // Default bumped 24 → 48 (Apr 2026, Thai feedback): the Lenful catalog
  // tab was showing only ~16–24 products at a time which made the page
  // feel sparse even for accounts with hundreds of products. 48 fits two
  // viewport heights of cards on a 1440px screen and stays well under the
  // 200 hard cap that protects DB latency.
  const limit = Math.max(1, Math.min(200, params.limit ?? 48))
  const page = Math.max(1, params.page ?? 1)
  const offset = (page - 1) * limit

  let base = db.selectFrom('lenful_catalog')
  if (!params.includeInactive) base = base.where('is_active', '=', true) as any
  if (params.category) base = base.where('category_slug', '=', params.category) as any
  if (params.search) {
    const s = `%${params.search}%`
    base = base.where((eb) =>
      eb.or([
        eb('title', 'ilike', s),
        eb('lenful_product_sku', 'ilike', s),
        eb('category_name', 'ilike', s),
      ]),
    ) as any
  }

  const countRow = await base
    .select((eb) => eb.fn.countAll().as('n'))
    .executeTakeFirst()
  const total = Number(countRow?.n ?? 0)

  const rawRows = await base
    .select([
      'lenful_product_id',
      'lenful_product_sku',
      'title',
      'category_slug',
      'category_name',
      'thumbnail_url',
      'base_price',
      'currency',
      'variants_json',
      'is_active',
      'last_synced_at',
    ])
    .orderBy('last_synced_at', 'desc')
    .limit(limit)
    .offset(offset)
    .execute()

  const rows: CatalogListRow[] = rawRows.map((r: any) => {
    const variants = Array.isArray(r.variants_json)
      ? r.variants_json
      : typeof r.variants_json === 'string'
      ? safeJsonArray(r.variants_json)
      : []
    return {
      lenful_product_id: r.lenful_product_id,
      lenful_product_sku: r.lenful_product_sku,
      title: r.title,
      category_slug: r.category_slug,
      category_name: r.category_name,
      thumbnail_url: r.thumbnail_url,
      base_price: r.base_price != null ? String(r.base_price) : null,
      currency: r.currency,
      variant_count: variants.length,
      is_active: r.is_active === true,
      last_synced_at:
        typeof r.last_synced_at === 'string' ? r.last_synced_at : String(r.last_synced_at),
    }
  })

  return { rows, total }
}

export async function getCatalogEntry(
  db: Kysely<Database>,
  lenfulProductId: string,
): Promise<NormalizedCatalogEntry | null> {
  const row: any = await db
    .selectFrom('lenful_catalog')
    .selectAll()
    .where('lenful_product_id', '=', lenfulProductId)
    .executeTakeFirst()
  if (!row) return null
  const variants = Array.isArray(row.variants_json)
    ? row.variants_json
    : typeof row.variants_json === 'string'
    ? safeJsonArray(row.variants_json)
    : []
  const options = Array.isArray(row.options_json)
    ? row.options_json
    : typeof row.options_json === 'string'
    ? safeJsonArray(row.options_json)
    : []
  const gallery = Array.isArray(row.gallery_urls)
    ? row.gallery_urls
    : typeof row.gallery_urls === 'string'
    ? safeJsonArray(row.gallery_urls)
    : []
  return {
    lenful_product_id: row.lenful_product_id,
    lenful_product_sku: row.lenful_product_sku,
    title: row.title,
    description: row.description,
    category_slug: row.category_slug,
    category_name: row.category_name,
    thumbnail_url: row.thumbnail_url,
    gallery_urls: gallery as string[],
    base_price: row.base_price != null ? Number(row.base_price) : null,
    currency: row.currency ?? 'USD',
    variants: variants as NormalizedVariant[],
    options: options as NormalizedOption[],
    raw: row.raw_payload ?? null,
  }
}

function safeJsonArray(str: string): unknown[] {
  try {
    const v = JSON.parse(str)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** List distinct active category slugs for the Lenful tab filter UI. */
export async function listCatalogCategories(
  db: Kysely<Database>,
): Promise<ReadonlyArray<{ slug: string; name: string; count: number }>> {
  const rows = await db
    .selectFrom('lenful_catalog')
    .select([
      'category_slug',
      'category_name',
      (eb) => eb.fn.countAll<number>().as('n'),
    ])
    .where('is_active', '=', true)
    .where('category_slug', 'is not', null)
    .groupBy(['category_slug', 'category_name'])
    .orderBy('category_slug', 'asc')
    .execute()
  return rows
    .filter((r: any) => !!r.category_slug)
    .map((r: any) => ({
      slug: r.category_slug,
      name: r.category_name ?? r.category_slug,
      count: Number(r.n),
    }))
}
