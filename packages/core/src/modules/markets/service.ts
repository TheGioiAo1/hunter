/**
 * Gbox Platform — Markets & International Commerce (Shopify Markets Equivalent)
 *
 * Manages geographic markets with country-specific pricing rules, currencies,
 * languages, duties/taxes, and domain targeting.
 *
 * Data stored in shop_settings under key 'markets_config'.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarketCountry {
  code: string          // ISO 3166-1 alpha-2 (US, VN, JP, etc.)
  name: string
  currency?: string     // Override currency for this country
  tax_rate?: number     // Override tax rate (e.g. 0.1 for 10%)
  duties_enabled?: boolean
}

export interface MarketPriceAdjustment {
  type: 'percentage' | 'fixed'
  value: number         // +10 = increase 10%, -5 = decrease 5% (percentage); or fixed delta
}

export interface Market {
  id: string
  name: string
  enabled: boolean
  primary: boolean                    // One market must be primary (domestic)
  countries: MarketCountry[]
  currency: string                    // Default currency for this market
  price_adjustment?: MarketPriceAdjustment
  domain?: string                     // Optional custom domain/subfolder (e.g. /en-us)
  languages: string[]                 // e.g. ['en', 'vi', 'ja']
  duties_enabled: boolean
  created_at: string
  updated_at: string
}

export interface MarketsConfig {
  markets: Market[]
}

// ---------------------------------------------------------------------------
// Shop settings helpers
// ---------------------------------------------------------------------------

const MARKETS_KEY = 'markets_config'

async function getMarketsConfig(db: Kysely<Database>, shopId: string): Promise<MarketsConfig> {
  const row = await db
    .selectFrom('shop_settings')
    .select('value')
    .where('shop_id', '=', shopId)
    .where('key', '=', MARKETS_KEY)
    .executeTakeFirst()

  if (!row) return { markets: [] }
  try {
    const val = typeof (row as any).value === 'string'
      ? JSON.parse((row as any).value)
      : (row as any).value
    return val as MarketsConfig
  } catch {
    return { markets: [] }
  }
}

async function saveMarketsConfig(db: Kysely<Database>, shopId: string, config: MarketsConfig): Promise<void> {
  const existing = await db
    .selectFrom('shop_settings')
    .select('id')
    .where('shop_id', '=', shopId)
    .where('key', '=', MARKETS_KEY)
    .executeTakeFirst()

  if (existing) {
    await db
      .updateTable('shop_settings')
      .set({ value: JSON.stringify(config), updated_at: new Date().toISOString() } as any)
      .where('shop_id', '=', shopId)
      .where('key', '=', MARKETS_KEY)
      .execute()
  } else {
    await db
      .insertInto('shop_settings')
      .values({ shop_id: shopId, key: MARKETS_KEY, value: JSON.stringify(config) } as any)
      .execute()
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listMarkets(db: Kysely<Database>, shopId: string): Promise<Market[]> {
  const config = await getMarketsConfig(db, shopId)
  return config.markets
}

export async function getMarket(db: Kysely<Database>, shopId: string, marketId: string): Promise<Market | null> {
  const config = await getMarketsConfig(db, shopId)
  return config.markets.find(m => m.id === marketId) ?? null
}

export async function createMarket(
  db: Kysely<Database>,
  shopId: string,
  input: {
    name: string
    countries: MarketCountry[]
    currency: string
    price_adjustment?: MarketPriceAdjustment
    domain?: string
    languages?: string[]
    duties_enabled?: boolean
    primary?: boolean
  },
): Promise<Market> {
  const config = await getMarketsConfig(db, shopId)
  const now = new Date().toISOString()

  const market: Market = {
    id: generateId(),
    name: input.name,
    enabled: true,
    primary: input.primary ?? false,
    countries: input.countries,
    currency: input.currency,
    price_adjustment: input.price_adjustment,
    domain: input.domain,
    languages: input.languages ?? ['en'],
    duties_enabled: input.duties_enabled ?? false,
    created_at: now,
    updated_at: now,
  }

  // If this is primary, demote all others
  if (market.primary) {
    config.markets.forEach(m => { m.primary = false })
  }

  config.markets.push(market)
  await saveMarketsConfig(db, shopId, config)
  return market
}

export async function updateMarket(
  db: Kysely<Database>,
  shopId: string,
  marketId: string,
  updates: Partial<Pick<Market, 'name' | 'enabled' | 'countries' | 'currency' | 'price_adjustment' | 'domain' | 'languages' | 'duties_enabled' | 'primary'>>,
): Promise<Market | null> {
  const config = await getMarketsConfig(db, shopId)
  const idx = config.markets.findIndex(m => m.id === marketId)
  if (idx === -1) return null

  // If setting as primary, demote all others
  if (updates.primary) {
    config.markets.forEach(m => { m.primary = false })
  }

  const updated: Market = {
    ...config.markets[idx],
    ...updates,
    updated_at: new Date().toISOString(),
  }
  config.markets[idx] = updated
  await saveMarketsConfig(db, shopId, config)
  return updated
}

export async function deleteMarket(
  db: Kysely<Database>,
  shopId: string,
  marketId: string,
): Promise<boolean> {
  const config = await getMarketsConfig(db, shopId)
  const filtered = config.markets.filter(m => m.id !== marketId)
  if (filtered.length === config.markets.length) return false
  config.markets = filtered
  await saveMarketsConfig(db, shopId, config)
  return true
}

// ---------------------------------------------------------------------------
// Price resolution
// ---------------------------------------------------------------------------

/**
 * Given a base price and a buyer's country code, resolve the adjusted price
 * for their market (currency conversion + market price adjustments).
 */
export async function resolveMarketPrice(
  db: Kysely<Database>,
  shopId: string,
  basePriceCents: number,
  baseCurrency: string,
  buyerCountryCode: string,
): Promise<{ price: number; currency: string; market_id: string | null; duties_enabled: boolean }> {
  const config = await getMarketsConfig(db, shopId)
  const countryUpper = buyerCountryCode.toUpperCase()

  // Find market for this country
  const market = config.markets.find(m =>
    m.enabled && m.countries.some(c => c.code.toUpperCase() === countryUpper),
  )

  if (!market) {
    // No market configured — return base price as-is
    return { price: basePriceCents, currency: baseCurrency, market_id: null, duties_enabled: false }
  }

  let adjustedPrice = basePriceCents

  // Apply market-level price adjustment
  if (market.price_adjustment) {
    if (market.price_adjustment.type === 'percentage') {
      adjustedPrice = Math.round(adjustedPrice * (1 + market.price_adjustment.value / 100))
    } else {
      adjustedPrice = adjustedPrice + Math.round(market.price_adjustment.value * 100)
    }
  }

  // Apply country-specific tax override
  const country = market.countries.find(c => c.code.toUpperCase() === countryUpper)
  const taxRate = country?.tax_rate

  return {
    price: adjustedPrice,
    currency: country?.currency || market.currency || baseCurrency,
    market_id: market.id,
    duties_enabled: country?.duties_enabled ?? market.duties_enabled,
  }
}

/**
 * Detect market from request (country header, query param, or Accept-Language).
 */
export function detectCountryFromRequest(req: {
  headers: Record<string, string | string[] | undefined>
  query: Record<string, any>
}): string | null {
  // 1. Explicit query param ?country=US
  if (req.query.country && typeof req.query.country === 'string') {
    return req.query.country.toUpperCase()
  }
  // 2. CF-IPCountry header (Cloudflare)
  const cfCountry = req.headers['cf-ipcountry']
  if (cfCountry && typeof cfCountry === 'string' && cfCountry !== 'XX') {
    return cfCountry.toUpperCase()
  }
  // 3. X-Country header (custom proxy)
  const xCountry = req.headers['x-country']
  if (xCountry && typeof xCountry === 'string') {
    return xCountry.toUpperCase()
  }
  return null
}

// ---------------------------------------------------------------------------
// ID generator
// ---------------------------------------------------------------------------

function generateId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const segments = [8, 4, 4]
  return 'mkt-' + segments
    .map(len => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join(''))
    .join('-')
}
