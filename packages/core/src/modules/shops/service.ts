/**
 * Gbox Platform — Shop Service
 *
 * Shopify-equivalent shop management: CRUD, domain lookup, settings.
 */

import type { Kysely } from 'kysely'
import type { Database, ShopTable } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

type Selectable<T> = { [K in keyof T]: T[K] extends import('kysely').ColumnType<infer S, any, any> ? S : T[K] }

export type Shop = Selectable<ShopTable>

export interface CreateShopInput {
  name: string
  slug: string
  email: string
  domain?: string | null
  custom_domain?: string | null
  phone?: string | null
  address?: string | null
  city?: string | null
  province?: string | null
  country?: string | null
  zip?: string | null
  currency?: string
  timezone?: string
  plan?: string | null
  logo_url?: string | null
}

export interface UpdateShopInput {
  name?: string
  slug?: string
  email?: string
  domain?: string | null
  custom_domain?: string | null
  phone?: string | null
  address?: string | null
  city?: string | null
  province?: string | null
  country?: string | null
  zip?: string | null
  currency?: string
  timezone?: string
  plan?: string | null
  status?: string
  logo_url?: string | null
}

export interface ShopFilters {
  status?: string
  plan?: string
  search?: string
}

export interface Pagination {
  limit?: number
  offset?: number
}

export interface ShopWithSettings extends Shop {
  settings: Array<{ key: string; value: unknown }>
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Create a new shop.
 */
export async function createShop(
  db: Kysely<Database>,
  data: CreateShopInput,
): Promise<Shop> {
  const row = await db
    .insertInto('shops')
    .values({
      name: data.name,
      slug: data.slug,
      email: data.email,
      domain: data.domain ?? null,
      custom_domain: data.custom_domain ?? null,
      phone: data.phone ?? null,
      address: data.address ?? null,
      city: data.city ?? null,
      province: data.province ?? null,
      country: data.country ?? null,
      zip: data.zip ?? null,
      currency: data.currency,
      timezone: data.timezone,
      plan: data.plan ?? null,
      logo_url: data.logo_url ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return row as Shop
}

/**
 * Get a shop by ID, including its settings.
 */
export async function getShop(
  db: Kysely<Database>,
  id: string,
): Promise<ShopWithSettings | null> {
  const shop = await db
    .selectFrom('shops')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()

  if (!shop) return null

  const settings = await db
    .selectFrom('shop_settings')
    .select(['key', 'value'])
    .where('shop_id', '=', id)
    .execute()

  return {
    ...(shop as Shop),
    settings: settings.map((s) => ({ key: s.key, value: s.value })),
  }
}

/**
 * Find a shop by its primary domain (the `domain` column) or by a
 * verified custom domain in the `shop_domains` table.
 */
export async function getShopByDomain(
  db: Kysely<Database>,
  domain: string,
): Promise<Shop | null> {
  // Try the main domain column first
  const byMain = await db
    .selectFrom('shops')
    .selectAll()
    .where('domain', '=', domain)
    .executeTakeFirst()

  if (byMain) return byMain as Shop

  // Try custom_domain
  const byCustom = await db
    .selectFrom('shops')
    .selectAll()
    .where('custom_domain', '=', domain)
    .executeTakeFirst()

  if (byCustom) return byCustom as Shop

  // Try the shop_domains lookup table
  const domainRow = await db
    .selectFrom('shop_domains')
    .select('shop_id')
    .where('domain', '=', domain)
    .where('verified', '=', true)
    .executeTakeFirst()

  if (!domainRow) return null

  const shop = await db
    .selectFrom('shops')
    .selectAll()
    .where('id', '=', domainRow.shop_id)
    .executeTakeFirst()

  return (shop as Shop) ?? null
}

/**
 * Update a shop.
 */
export async function updateShop(
  db: Kysely<Database>,
  id: string,
  data: UpdateShopInput,
): Promise<Shop> {
  const row = await db
    .updateTable('shops')
    .set({ ...data, updated_at: new Date().toISOString() } as any)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow()

  return row as Shop
}

/**
 * Soft-delete a shop by setting status to 'closed'.
 */
export async function deleteShop(
  db: Kysely<Database>,
  id: string,
): Promise<void> {
  await db
    .updateTable('shops')
    .set({ status: 'closed', updated_at: new Date().toISOString() } as any)
    .where('id', '=', id)
    .execute()
}

/**
 * List shops with optional filters and pagination.
 */
export async function listShops(
  db: Kysely<Database>,
  filters: ShopFilters = {},
  pagination: Pagination = {},
): Promise<{ shops: Shop[]; total: number }> {
  const { limit = 50, offset = 0 } = pagination

  let query = db.selectFrom('shops').selectAll()
  let countQuery = db.selectFrom('shops').select(db.fn.countAll<number>().as('count'))

  if (filters.status) {
    query = query.where('status', '=', filters.status)
    countQuery = countQuery.where('status', '=', filters.status)
  }

  if (filters.plan) {
    query = query.where('plan', '=', filters.plan)
    countQuery = countQuery.where('plan', '=', filters.plan)
  }

  if (filters.search) {
    const pattern = `%${filters.search}%`
    query = query.where((eb) =>
      eb.or([eb('name', 'ilike', pattern), eb('email', 'ilike', pattern)]),
    )
    countQuery = countQuery.where((eb) =>
      eb.or([eb('name', 'ilike', pattern), eb('email', 'ilike', pattern)]),
    )
  }

  const [rows, countRow] = await Promise.all([
    query.orderBy('created_at', 'desc').limit(limit).offset(offset).execute(),
    countQuery.executeTakeFirstOrThrow(),
  ])

  return {
    shops: rows as Shop[],
    total: Number(countRow.count),
  }
}
