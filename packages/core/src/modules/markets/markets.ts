/**
 * Gbox Platform — Markets CRUD (Phase 9 PR3, migration 068).
 *
 * Table-backed replacement for the legacy shop_settings-based markets
 * service. This module operates on the `markets` table directly and
 * also manages the `market_id` FK on `shipping_zones` + `tax_registrations`.
 *
 * The older `./service.ts` continues to work against `shop_settings.markets_config`
 * for the v3 legacy server; it's untouched by this PR.
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import {
  MARKET_TEMPLATES,
  templateByKey,
  normaliseCountryList,
  normaliseCountry,
} from './seed.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MarketStatus = 'active' | 'inactive' | 'draft'

export interface MarketRow {
  id: string
  shop_id: string
  name: string
  status: MarketStatus
  countries: string[]
  is_primary: boolean
  currency_code: string
  language_code: string
  created_at: Date
  updated_at: Date
}

export interface MarketWithLinks extends MarketRow {
  shipping_zone_count: number
  tax_registration_count: number
}

export interface CreateMarketInput {
  name: string
  status?: MarketStatus
  countries?: readonly string[]
  is_primary?: boolean
  currency_code?: string
  language_code?: string
}

export interface UpdateMarketInput {
  name?: string
  status?: MarketStatus
  countries?: readonly string[]
  is_primary?: boolean
  currency_code?: string
  language_code?: string
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MarketNotFoundError extends Error {
  constructor(id: string) {
    super(`Market ${id} not found`)
    this.name = 'MarketNotFoundError'
  }
}

export class DuplicateMarketNameError extends Error {
  constructor(name: string) {
    super(`A market named "${name}" already exists for this shop.`)
    this.name = 'DuplicateMarketNameError'
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCountries(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x))
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.map((x) => String(x)) : []
    } catch {
      return []
    }
  }
  return []
}

function rowToMarket(row: any): MarketRow {
  return {
    id: String(row.id),
    shop_id: String(row.shop_id),
    name: String(row.name),
    status: String(row.status ?? 'active') as MarketStatus,
    countries: parseCountries(row.countries),
    is_primary: Boolean(row.is_primary),
    currency_code: String(row.currency_code ?? 'USD'),
    language_code: String(row.language_code ?? 'en'),
    created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updated_at: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listMarkets(
  db: Kysely<any>,
  shopId: string,
): Promise<MarketRow[]> {
  const rows = await (db as any)
    .selectFrom('markets')
    .selectAll()
    .where('shop_id', '=', shopId)
    .orderBy('is_primary', 'desc')
    .orderBy('name', 'asc')
    .execute()
  return rows.map(rowToMarket)
}

export async function listMarketsWithLinks(
  db: Kysely<any>,
  shopId: string,
): Promise<MarketWithLinks[]> {
  const markets = await listMarkets(db, shopId)
  if (markets.length === 0) return []

  // Count shipping zones + tax registrations per market (2 lightweight queries).
  const ids = markets.map((m) => m.id)

  const zoneCounts = await (db as any)
    .selectFrom('shipping_zones')
    .select(['market_id', sql<string>`COUNT(*)`.as('n')])
    .where('shop_id', '=', shopId)
    .where('market_id', 'in', ids)
    .groupBy('market_id')
    .execute()

  const taxCounts = await (db as any)
    .selectFrom('tax_registrations')
    .select(['market_id', sql<string>`COUNT(*)`.as('n')])
    .where('shop_id', '=', shopId)
    .where('market_id', 'in', ids)
    .groupBy('market_id')
    .execute()

  const zoneMap = new Map<string, number>()
  for (const r of zoneCounts) zoneMap.set(String(r.market_id), Number(r.n))

  const taxMap = new Map<string, number>()
  for (const r of taxCounts) taxMap.set(String(r.market_id), Number(r.n))

  return markets.map((m) => ({
    ...m,
    shipping_zone_count: zoneMap.get(m.id) ?? 0,
    tax_registration_count: taxMap.get(m.id) ?? 0,
  }))
}

export async function getMarket(
  db: Kysely<any>,
  shopId: string,
  marketId: string,
): Promise<MarketRow | null> {
  const row = await (db as any)
    .selectFrom('markets')
    .selectAll()
    .where('shop_id', '=', shopId)
    .where('id', '=', marketId)
    .executeTakeFirst()
  return row ? rowToMarket(row) : null
}

export async function getPrimaryMarket(
  db: Kysely<any>,
  shopId: string,
): Promise<MarketRow | null> {
  const row = await (db as any)
    .selectFrom('markets')
    .selectAll()
    .where('shop_id', '=', shopId)
    .where('is_primary', '=', true)
    .executeTakeFirst()
  return row ? rowToMarket(row) : null
}

export async function createMarket(
  db: Kysely<any>,
  shopId: string,
  input: CreateMarketInput,
): Promise<MarketRow> {
  const name = String(input.name ?? '').trim()
  if (!name) throw new Error('Market name is required')

  // Check dup name
  const existing = await (db as any)
    .selectFrom('markets')
    .select('id')
    .where('shop_id', '=', shopId)
    .where('name', '=', name)
    .executeTakeFirst()
  if (existing) throw new DuplicateMarketNameError(name)

  // If caller asks is_primary=true, demote any current primary.
  if (input.is_primary) {
    await (db as any)
      .updateTable('markets')
      .set({ is_primary: false })
      .where('shop_id', '=', shopId)
      .where('is_primary', '=', true)
      .execute()
  }

  const countries = normaliseCountryList(input.countries ?? [])
  const row = await (db as any)
    .insertInto('markets')
    .values({
      shop_id: shopId,
      name,
      status: input.status ?? 'active',
      countries: JSON.stringify(countries),
      is_primary: Boolean(input.is_primary),
      currency_code: (input.currency_code ?? 'USD').toUpperCase(),
      language_code: (input.language_code ?? 'en').toLowerCase(),
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return rowToMarket(row)
}

/**
 * Create a market pre-populated from a known template. Caller may pass
 * `nameOverride` to rename; otherwise the template's default name is used.
 */
export async function createMarketFromTemplate(
  db: Kysely<any>,
  shopId: string,
  templateKey: string,
  nameOverride?: string,
): Promise<MarketRow> {
  const tmpl = templateByKey(templateKey)
  if (!tmpl) throw new Error(`Unknown market template "${templateKey}"`)
  return createMarket(db, shopId, {
    name: nameOverride?.trim() || tmpl.name,
    status: 'active',
    countries: tmpl.countries,
    currency_code: tmpl.currency_code,
    language_code: tmpl.language_code,
    is_primary: false,
  })
}

export async function updateMarket(
  db: Kysely<any>,
  shopId: string,
  marketId: string,
  input: UpdateMarketInput,
): Promise<MarketRow> {
  const existing = await getMarket(db, shopId, marketId)
  if (!existing) throw new MarketNotFoundError(marketId)

  const patch: Record<string, unknown> = {}

  if (input.name !== undefined) {
    const name = String(input.name).trim()
    if (!name) throw new Error('Market name cannot be empty')
    if (name !== existing.name) {
      const dup = await (db as any)
        .selectFrom('markets')
        .select('id')
        .where('shop_id', '=', shopId)
        .where('name', '=', name)
        .where('id', '!=', marketId)
        .executeTakeFirst()
      if (dup) throw new DuplicateMarketNameError(name)
      patch.name = name
    }
  }

  if (input.status !== undefined) patch.status = input.status
  if (input.countries !== undefined) {
    patch.countries = JSON.stringify(normaliseCountryList(input.countries))
  }
  if (input.currency_code !== undefined) {
    patch.currency_code = String(input.currency_code).toUpperCase()
  }
  if (input.language_code !== undefined) {
    patch.language_code = String(input.language_code).toLowerCase()
  }

  if (input.is_primary !== undefined) {
    // Promote: demote any other primary first.
    if (input.is_primary && !existing.is_primary) {
      await (db as any)
        .updateTable('markets')
        .set({ is_primary: false })
        .where('shop_id', '=', shopId)
        .where('is_primary', '=', true)
        .where('id', '!=', marketId)
        .execute()
    }
    patch.is_primary = Boolean(input.is_primary)
  }

  if (Object.keys(patch).length === 0) return existing

  patch.updated_at = new Date()

  const row = await (db as any)
    .updateTable('markets')
    .set(patch)
    .where('shop_id', '=', shopId)
    .where('id', '=', marketId)
    .returningAll()
    .executeTakeFirstOrThrow()

  return rowToMarket(row)
}

export async function deleteMarket(
  db: Kysely<any>,
  shopId: string,
  marketId: string,
): Promise<void> {
  const existing = await getMarket(db, shopId, marketId)
  if (!existing) throw new MarketNotFoundError(marketId)
  if (existing.is_primary) {
    throw new Error(
      'Cannot delete the primary market. Promote another market first.',
    )
  }
  await (db as any)
    .deleteFrom('markets')
    .where('shop_id', '=', shopId)
    .where('id', '=', marketId)
    .execute()
  // FK is SET NULL on shipping_zones / tax_registrations, so those rows
  // simply go back to "unassigned". No manual cascade needed.
}

// ---------------------------------------------------------------------------
// Linking shipping zones / tax registrations to markets
// ---------------------------------------------------------------------------

export async function linkShippingZoneToMarket(
  db: Kysely<any>,
  shopId: string,
  zoneId: string,
  marketId: string | null,
): Promise<void> {
  // Cross-tenant guards.
  const zone = await (db as any)
    .selectFrom('shipping_zones')
    .select(['id', 'shop_id'])
    .where('id', '=', zoneId)
    .executeTakeFirst()
  if (!zone || String(zone.shop_id) !== shopId) {
    throw new Error('Shipping zone not found for this shop')
  }
  if (marketId) {
    const market = await getMarket(db, shopId, marketId)
    if (!market) throw new MarketNotFoundError(marketId)
  }

  await (db as any)
    .updateTable('shipping_zones')
    .set({ market_id: marketId })
    .where('id', '=', zoneId)
    .execute()
}

export async function linkTaxRegistrationToMarket(
  db: Kysely<any>,
  shopId: string,
  registrationId: string,
  marketId: string | null,
): Promise<void> {
  const reg = await (db as any)
    .selectFrom('tax_registrations')
    .select(['id', 'shop_id'])
    .where('id', '=', registrationId)
    .executeTakeFirst()
  if (!reg || String(reg.shop_id) !== shopId) {
    throw new Error('Tax registration not found for this shop')
  }
  if (marketId) {
    const market = await getMarket(db, shopId, marketId)
    if (!market) throw new MarketNotFoundError(marketId)
  }

  await (db as any)
    .updateTable('tax_registrations')
    .set({ market_id: marketId })
    .where('id', '=', registrationId)
    .execute()
}

// Re-export templates so admin UI + tests can consume without a second import.
export { MARKET_TEMPLATES }
