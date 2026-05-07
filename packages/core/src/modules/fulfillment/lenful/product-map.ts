/**
 * Lenful product mapping service (Phase F1).
 *
 * A Gbox product (or variant) is mapped to a Lenful `product_sku` so that
 * when an order lands, push-order.ts can look up which Lenful SKU to send
 * via builder.ts. Mappings can be product-level (variant_id = NULL) or
 * variant-level (exact variant_id). Variant-level wins when both exist.
 *
 * The unique constraint is partial:
 *   UNIQUE (gbox_product_id, COALESCE(gbox_variant_id, '00000…'::uuid))
 * so upsert semantics are driven from application code (we delete+insert
 * on save to keep the logic readable).
 */

import type { Kysely } from 'kysely'
import type { Database } from '../../../../../db/src/schema/tables.js'

export interface LenfulMappingRow {
  readonly id: string
  readonly gbox_product_id: string
  readonly gbox_variant_id: string | null
  readonly lenful_product_id: string
  readonly lenful_product_sku: string
  readonly lenful_product_title: string | null
  readonly lenful_category_slug: string | null
  readonly default_shipping_priority: ReadonlyArray<number>
  readonly default_print_position: number
  readonly mapped_by: string | null
  readonly mapped_at: string
}

export interface MappingListParams {
  readonly search?: string
  readonly page?: number
  readonly limit?: number
  readonly unmappedOnly?: boolean
}

export interface MappingListRow {
  readonly gbox_product_id: string
  readonly gbox_product_title: string
  readonly gbox_product_handle: string | null
  readonly gbox_shop_id: string
  readonly gbox_shop_name: string | null
  readonly gbox_shop_slug: string | null
  readonly variant_count: number
  readonly mapping: LenfulMappingRow | null
}

/**
 * Product-level list of Gbox products with join to any existing
 * variant_id=NULL mapping. Pagination is cursor-less for simplicity —
 * god admin won't browse more than a few hundred products here.
 */
export async function listGboxProductsWithMapping(
  db: Kysely<Database>,
  params: MappingListParams = {},
): Promise<{ rows: ReadonlyArray<MappingListRow>; total: number }> {
  const limit = Math.max(1, Math.min(200, params.limit ?? 50))
  const page = Math.max(1, params.page ?? 1)
  const offset = (page - 1) * limit

  // Count total matching (unfiltered).
  let countQuery = db
    .selectFrom('products as p')
    .leftJoin('shops as s', 's.id', 'p.shop_id')
    .leftJoin('lenful_product_map as m', (j) =>
      j.onRef('m.gbox_product_id', '=', 'p.id').on('m.gbox_variant_id', 'is', null),
    )
    .select((eb) => eb.fn.countAll().as('n'))

  if (params.search) {
    const s = `%${params.search}%`
    countQuery = countQuery.where((eb) =>
      eb.or([
        eb('p.title', 'ilike', s),
        eb('p.slug', 'ilike', s),
        eb('s.name', 'ilike', s),
      ]),
    )
  }
  if (params.unmappedOnly) {
    countQuery = countQuery.where('m.id', 'is', null)
  }
  const countRow = await countQuery.executeTakeFirst()
  const total = Number(countRow?.n ?? 0)

  let q = db
    .selectFrom('products as p')
    .leftJoin('shops as s', 's.id', 'p.shop_id')
    .leftJoin('lenful_product_map as m', (j) =>
      j.onRef('m.gbox_product_id', '=', 'p.id').on('m.gbox_variant_id', 'is', null),
    )
    .select([
      'p.id as gbox_product_id',
      'p.title as gbox_product_title',
      'p.slug as gbox_product_handle',
      'p.shop_id as gbox_shop_id',
      's.name as gbox_shop_name',
      's.slug as gbox_shop_slug',
      'm.id as m_id',
      'm.gbox_product_id as m_gbox_product_id',
      'm.gbox_variant_id as m_gbox_variant_id',
      'm.lenful_product_id as m_lenful_product_id',
      'm.lenful_product_sku as m_lenful_product_sku',
      'm.lenful_product_title as m_lenful_product_title',
      'm.lenful_category_slug as m_lenful_category_slug',
      'm.default_shipping_priority as m_ssp',
      'm.default_print_position as m_dpp',
      'm.mapped_by as m_mapped_by',
      'm.mapped_at as m_mapped_at',
    ])
    .orderBy('p.created_at', 'desc')
    .limit(limit)
    .offset(offset)

  if (params.search) {
    const s = `%${params.search}%`
    q = q.where((eb) =>
      eb.or([
        eb('p.title', 'ilike', s),
        eb('p.slug', 'ilike', s),
        eb('s.name', 'ilike', s),
      ]),
    )
  }
  if (params.unmappedOnly) {
    q = q.where('m.id', 'is', null)
  }
  const rawRows = await q.execute()

  // Variant counts in a single query
  const productIds = rawRows.map((r) => r.gbox_product_id)
  const variantCounts = new Map<string, number>()
  if (productIds.length > 0) {
    const vc = await db
      .selectFrom('product_variants')
      .select(['product_id', (eb) => eb.fn.countAll<number>().as('n')])
      .where('product_id', 'in', productIds)
      .groupBy('product_id')
      .execute()
    for (const row of vc) {
      variantCounts.set(row.product_id, Number(row.n))
    }
  }

  const rows: MappingListRow[] = rawRows.map((r: any) => ({
    gbox_product_id: r.gbox_product_id,
    gbox_product_title: r.gbox_product_title ?? '(untitled)',
    gbox_product_handle: r.gbox_product_handle ?? null,
    gbox_shop_id: r.gbox_shop_id,
    gbox_shop_name: r.gbox_shop_name ?? null,
    gbox_shop_slug: r.gbox_shop_slug ?? null,
    variant_count: variantCounts.get(r.gbox_product_id) ?? 0,
    mapping: r.m_id
      ? {
          id: r.m_id,
          gbox_product_id: r.m_gbox_product_id,
          gbox_variant_id: r.m_gbox_variant_id,
          lenful_product_id: r.m_lenful_product_id,
          lenful_product_sku: r.m_lenful_product_sku,
          lenful_product_title: r.m_lenful_product_title,
          lenful_category_slug: r.m_lenful_category_slug,
          default_shipping_priority: (r.m_ssp as number[]) ?? [0, 1, 2],
          default_print_position: Number(r.m_dpp ?? 1),
          mapped_by: r.m_mapped_by ?? null,
          mapped_at: typeof r.m_mapped_at === 'string' ? r.m_mapped_at : String(r.m_mapped_at),
        }
      : null,
  }))

  return { rows, total }
}

/** Return every mapping (including variant-level) for a single Gbox product. */
export async function listMappingsForProduct(
  db: Kysely<Database>,
  gboxProductId: string,
): Promise<ReadonlyArray<LenfulMappingRow>> {
  const rows = await db
    .selectFrom('lenful_product_map')
    .selectAll()
    .where('gbox_product_id', '=', gboxProductId)
    .orderBy('gbox_variant_id', 'asc')
    .execute()
  return rows.map((r: any) => ({
    id: r.id,
    gbox_product_id: r.gbox_product_id,
    gbox_variant_id: r.gbox_variant_id,
    lenful_product_id: r.lenful_product_id,
    lenful_product_sku: r.lenful_product_sku,
    lenful_product_title: r.lenful_product_title,
    lenful_category_slug: r.lenful_category_slug,
    default_shipping_priority: (r.default_shipping_priority as number[]) ?? [0, 1, 2],
    default_print_position: Number(r.default_print_position ?? 1),
    mapped_by: r.mapped_by,
    mapped_at: typeof r.mapped_at === 'string' ? r.mapped_at : String(r.mapped_at),
  }))
}

export interface SaveMappingInput {
  readonly gboxProductId: string
  readonly gboxVariantId?: string | null
  readonly lenfulProductId: string
  readonly lenfulProductSku: string
  readonly lenfulProductTitle?: string
  readonly lenfulCategorySlug?: string
  readonly defaultShippingPriority?: ReadonlyArray<number>
  readonly defaultPrintPosition?: number
  readonly mappedBy?: string | null
}

/**
 * Delete-then-insert upsert keyed on (gbox_product_id, gbox_variant_id).
 * Transaction-wrapped so a partial failure can't leave duplicate rows.
 */
export async function saveMapping(
  db: Kysely<Database>,
  input: SaveMappingInput,
): Promise<string> {
  if (!input.lenfulProductSku || !input.lenfulProductId) {
    throw new Error('lenful_product_id and lenful_product_sku are required')
  }
  const priority =
    input.defaultShippingPriority && input.defaultShippingPriority.length > 0
      ? Array.from(input.defaultShippingPriority)
      : [0, 1, 2]
  const position =
    typeof input.defaultPrintPosition === 'number' ? input.defaultPrintPosition : 1

  return await db.transaction().execute(async (tx) => {
    let del = tx
      .deleteFrom('lenful_product_map')
      .where('gbox_product_id', '=', input.gboxProductId)
    if (input.gboxVariantId) {
      del = del.where('gbox_variant_id', '=', input.gboxVariantId)
    } else {
      del = del.where('gbox_variant_id', 'is', null)
    }
    await del.execute()

    const row = await tx
      .insertInto('lenful_product_map')
      .values({
        gbox_product_id: input.gboxProductId,
        gbox_variant_id: input.gboxVariantId ?? null,
        lenful_product_id: input.lenfulProductId,
        lenful_product_sku: input.lenfulProductSku,
        lenful_product_title: input.lenfulProductTitle ?? null,
        lenful_category_slug: input.lenfulCategorySlug ?? null,
        default_shipping_priority: priority as any,
        default_print_position: position,
        mapped_by: input.mappedBy ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return row.id
  })
}

export async function deleteMapping(
  db: Kysely<Database>,
  mappingId: string,
): Promise<void> {
  await db
    .deleteFrom('lenful_product_map')
    .where('id', '=', mappingId)
    .execute()
}

export interface DesignLibraryRow {
  readonly lenful_design_id: string
  readonly lenful_design_sku: string
  readonly title: string | null
  readonly preview_url: string | null
  readonly front_link: string | null
  readonly back_link: string | null
  readonly linked_gbox_product_id: string | null
  readonly last_synced_at: string
}

export async function listDesignLibrary(
  db: Kysely<Database>,
  params: { search?: string; limit?: number; page?: number } = {},
): Promise<{ rows: ReadonlyArray<DesignLibraryRow>; total: number }> {
  const limit = Math.max(1, Math.min(200, params.limit ?? 50))
  const page = Math.max(1, params.page ?? 1)
  const offset = (page - 1) * limit

  let q = db
    .selectFrom('lenful_design_library')
    .select([
      'lenful_design_id',
      'lenful_design_sku',
      'title',
      'preview_url',
      'front_link',
      'back_link',
      'linked_gbox_product_id',
      'last_synced_at',
    ])
    .orderBy('last_synced_at', 'desc')
    .limit(limit)
    .offset(offset)
  let countQ = db
    .selectFrom('lenful_design_library')
    .select((eb) => eb.fn.countAll().as('n'))

  if (params.search) {
    const s = `%${params.search}%`
    q = q.where((eb) =>
      eb.or([eb('title', 'ilike', s), eb('lenful_design_sku', 'ilike', s)]),
    )
    countQ = countQ.where((eb) =>
      eb.or([eb('title', 'ilike', s), eb('lenful_design_sku', 'ilike', s)]),
    )
  }
  const [rawRows, countRow] = await Promise.all([q.execute(), countQ.executeTakeFirst()])
  const rows = rawRows.map((r: any) => ({
    lenful_design_id: r.lenful_design_id,
    lenful_design_sku: r.lenful_design_sku,
    title: r.title,
    preview_url: r.preview_url,
    front_link: r.front_link,
    back_link: r.back_link,
    linked_gbox_product_id: r.linked_gbox_product_id,
    last_synced_at: typeof r.last_synced_at === 'string' ? r.last_synced_at : String(r.last_synced_at),
  }))
  return { rows, total: Number(countRow?.n ?? 0) }
}

/** Upsert a design library row from a Lenful /api/design listing. */
export async function upsertDesignRow(
  db: Kysely<Database>,
  d: {
    lenful_design_id: string
    lenful_design_sku: string
    title?: string | null
    preview_url?: string | null
    front_link?: string | null
    back_link?: string | null
    left_chest_link?: string | null
    right_chest_link?: string | null
    left_sleeve_link?: string | null
    right_sleeve_link?: string | null
    neck_link?: string | null
    raw?: unknown
    linked_gbox_product_id?: string | null
  },
): Promise<void> {
  const existing = await db
    .selectFrom('lenful_design_library')
    .select(['lenful_design_id'])
    .where('lenful_design_id', '=', d.lenful_design_id)
    .executeTakeFirst()
  const now = new Date().toISOString()
  if (existing) {
    await db
      .updateTable('lenful_design_library')
      .set({
        lenful_design_sku: d.lenful_design_sku,
        title: d.title ?? null,
        preview_url: d.preview_url ?? null,
        front_link: d.front_link ?? null,
        back_link: d.back_link ?? null,
        left_chest_link: d.left_chest_link ?? null,
        right_chest_link: d.right_chest_link ?? null,
        left_sleeve_link: d.left_sleeve_link ?? null,
        right_sleeve_link: d.right_sleeve_link ?? null,
        neck_link: d.neck_link ?? null,
        raw_payload: d.raw ? (JSON.stringify(d.raw) as any) : null,
        linked_gbox_product_id: d.linked_gbox_product_id ?? null,
        last_synced_at: now,
      })
      .where('lenful_design_id', '=', d.lenful_design_id)
      .execute()
  } else {
    await db
      .insertInto('lenful_design_library')
      .values({
        lenful_design_id: d.lenful_design_id,
        lenful_design_sku: d.lenful_design_sku,
        title: d.title ?? null,
        preview_url: d.preview_url ?? null,
        front_link: d.front_link ?? null,
        back_link: d.back_link ?? null,
        left_chest_link: d.left_chest_link ?? null,
        right_chest_link: d.right_chest_link ?? null,
        left_sleeve_link: d.left_sleeve_link ?? null,
        right_sleeve_link: d.right_sleeve_link ?? null,
        neck_link: d.neck_link ?? null,
        raw_payload: d.raw ? (JSON.stringify(d.raw) as any) : null,
        linked_gbox_product_id: d.linked_gbox_product_id ?? null,
        last_synced_at: now,
      })
      .execute()
  }
}
