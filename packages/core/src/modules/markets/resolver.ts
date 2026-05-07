/**
 * Gbox Platform — Market resolver (Phase 9 PR3).
 *
 * Given a shop + buyer country, pick the market that owns the country.
 * Resolution order:
 *
 *   1. Exact match — an active market whose `countries[]` contains the
 *      ISO-2 country code.
 *   2. Primary market — if the shop has declared one.
 *   3. "Rest of world" — the seeded catch-all with empty countries[].
 *   4. `null` if no fallback is configured (very new shop, no markets seeded).
 *
 * The resolver is pure: it takes a list of markets rather than hitting the
 * DB, so checkout can cache results per shop for the duration of a
 * request.
 */

import type { Kysely } from 'kysely'
import { listMarkets, type MarketRow } from './markets.js'
import { normaliseCountry } from './seed.js'

export interface ResolvedMarket {
  market: MarketRow | null
  reason: 'exact' | 'primary' | 'rest_of_world' | 'none'
}

/**
 * Pure in-memory resolver. Exposed separately so tests can hit it
 * without a Kysely instance.
 */
export function resolveMarketForCountryFromList(
  markets: readonly MarketRow[],
  countryCode: string | null | undefined,
): ResolvedMarket {
  const code = normaliseCountry(countryCode)

  // Active markets only. Inactive/draft markets don't claim countries.
  const active = markets.filter((m) => m.status === 'active')

  // Pass 1: exact match
  if (code) {
    const hit = active.find((m) => m.countries.includes(code))
    if (hit) return { market: hit, reason: 'exact' }
  }

  // Pass 2: primary
  const primary = active.find((m) => m.is_primary)
  if (primary) return { market: primary, reason: 'primary' }

  // Pass 3: rest-of-world (empty countries list = catch-all)
  const rest = active.find((m) => m.countries.length === 0)
  if (rest) return { market: rest, reason: 'rest_of_world' }

  return { market: null, reason: 'none' }
}

/**
 * DB-backed wrapper. Fetches markets for the shop and resolves.
 */
export async function resolveMarketForCountry(
  db: Kysely<any>,
  shopId: string,
  countryCode: string | null | undefined,
): Promise<ResolvedMarket> {
  const markets = await listMarkets(db, shopId)
  return resolveMarketForCountryFromList(markets, countryCode)
}

/**
 * Ship-to address convenience. Extracts country from the same address
 * shape used by `computeShippingRates` + `computeTaxForCart`.
 */
export async function resolveMarketForAddress(
  db: Kysely<any>,
  shopId: string,
  address: { country?: string | null } | null | undefined,
): Promise<ResolvedMarket> {
  return resolveMarketForCountry(db, shopId, address?.country ?? null)
}
