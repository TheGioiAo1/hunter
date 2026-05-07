/**
 * Gbox Platform — Shipping Service
 *
 * Manage shipping zones and rates, and calculate applicable shipping
 * rates for a given address and cart.
 *
 * Phase 9 / PR1 extends this module with carrier-aware checkout
 * pricing via `computeShippingRates(shopId, address, cart)` which
 * merges the merchant's stored `shipping_rates` with live quotes from
 * any enabled `RateProvider`s. The original `calculateShippingRates`
 * (used by older code paths) stays intact for back-compat.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { CarrierKind, RegionCode } from './seed.js'
import {
  buildProvidersForShop,
  MissingCarrierCredentialsError,
  type RateQuote,
  type RateProvider,
  type ShopCarrierRow,
} from './providers.js'
import {
  resolveMarketForAddress,
  type ResolvedMarket,
} from '../markets/resolver.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateShippingZoneInput {
  name: string
  countries: string[] // ISO country codes
}

export interface UpdateShippingZoneInput {
  name?: string
  countries?: string[]
}

export interface CreateShippingRateInput {
  name: string
  price: string          // numeric string e.g. "9.99"
  type: 'flat' | 'price_based' | 'weight_based'
  min_value?: string | null
  max_value?: string | null
}

export interface UpdateShippingRateInput {
  name?: string
  price?: string
  type?: 'flat' | 'price_based' | 'weight_based'
  min_value?: string | null
  max_value?: string | null
}

export interface ShippingAddress {
  country?: string | null
  country_code?: string | null
  province?: string | null
  province_code?: string | null
  city?: string | null
  zip?: string | null
}

export interface CartItem {
  variant_id: string
  quantity: number
  price: string
  weight?: string | null
  requires_shipping?: boolean
}

export interface CalculatedShippingRate {
  rate_id: string
  zone_id: string
  zone_name: string
  name: string
  price: string
  type: string
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Get all shipping zones for a shop, including their rates.
 */
export async function getShippingZones(
  db: Kysely<Database>,
  shopId: string,
) {
  const zones = await db
    .selectFrom('shipping_zones')
    .selectAll()
    .where('shop_id', '=', shopId)
    .orderBy('created_at', 'asc')
    .execute()

  if (zones.length === 0) return []

  const zoneIds = zones.map((z) => z.id)
  const rates = await db
    .selectFrom('shipping_rates')
    .selectAll()
    .where('zone_id', 'in', zoneIds)
    .orderBy('created_at', 'asc')
    .execute()

  const ratesByZone = new Map<string, typeof rates>()
  for (const rate of rates) {
    const list = ratesByZone.get(rate.zone_id) ?? []
    list.push(rate)
    ratesByZone.set(rate.zone_id, list)
  }

  return zones.map((zone) => ({
    ...zone,
    shipping_rates: ratesByZone.get(zone.id) ?? [],
  }))
}

/**
 * Get a single shipping zone by ID.
 */
export async function getShippingZone(
  db: Kysely<Database>,
  zoneId: string,
) {
  const zone = await db
    .selectFrom('shipping_zones')
    .selectAll()
    .where('id', '=', zoneId)
    .executeTakeFirst()

  if (!zone) return null

  const rates = await db
    .selectFrom('shipping_rates')
    .selectAll()
    .where('zone_id', '=', zoneId)
    .orderBy('created_at', 'asc')
    .execute()

  return { ...zone, shipping_rates: rates }
}

/**
 * Create a new shipping zone.
 */
export async function createShippingZone(
  db: Kysely<Database>,
  shopId: string,
  data: CreateShippingZoneInput,
) {
  if (!data.countries || data.countries.length === 0) {
    throw new Error('At least one country is required')
  }

  const zone = await db
    .insertInto('shipping_zones')
    .values({
      shop_id: shopId,
      name: data.name,
      countries: JSON.stringify(
        data.countries.map((c) => c.toUpperCase()),
      ),
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return { ...zone, shipping_rates: [] }
}

/**
 * Update a shipping zone.
 */
export async function updateShippingZone(
  db: Kysely<Database>,
  zoneId: string,
  data: UpdateShippingZoneInput,
) {
  const updateData: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }

  if (data.name !== undefined) {
    updateData.name = data.name
  }
  if (data.countries !== undefined) {
    updateData.countries = JSON.stringify(
      data.countries.map((c) => c.toUpperCase()),
    )
  }

  const zone = await db
    .updateTable('shipping_zones')
    .set(updateData as any)
    .where('id', '=', zoneId)
    .returningAll()
    .executeTakeFirstOrThrow()

  return zone
}

/**
 * Delete a shipping zone and all its rates.
 */
export async function deleteShippingZone(
  db: Kysely<Database>,
  zoneId: string,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom('shipping_rates')
      .where('zone_id', '=', zoneId)
      .execute()

    await trx
      .deleteFrom('shipping_zones')
      .where('id', '=', zoneId)
      .execute()
  })
}

/**
 * Add a shipping rate to a zone.
 */
export async function addShippingRate(
  db: Kysely<Database>,
  zoneId: string,
  data: CreateShippingRateInput,
) {
  // Validate zone exists
  const zone = await db
    .selectFrom('shipping_zones')
    .select('id')
    .where('id', '=', zoneId)
    .executeTakeFirst()

  if (!zone) throw new Error('Shipping zone not found')

  const rate = await db
    .insertInto('shipping_rates')
    .values({
      zone_id: zoneId,
      name: data.name,
      price: data.price,
      type: data.type,
      min_value: data.min_value ?? null,
      max_value: data.max_value ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return rate
}

/**
 * Update a shipping rate.
 */
export async function updateShippingRate(
  db: Kysely<Database>,
  rateId: string,
  data: UpdateShippingRateInput,
) {
  const rate = await db
    .updateTable('shipping_rates')
    .set(data as any)
    .where('id', '=', rateId)
    .returningAll()
    .executeTakeFirstOrThrow()

  return rate
}

/**
 * Delete a shipping rate.
 */
export async function deleteShippingRate(
  db: Kysely<Database>,
  rateId: string,
): Promise<void> {
  await db
    .deleteFrom('shipping_rates')
    .where('id', '=', rateId)
    .execute()
}

/**
 * Calculate applicable shipping rates for a given address and cart.
 *
 * 1. Find all shipping zones whose countries list includes the address country.
 * 2. For each zone, filter rates by type constraints (price/weight thresholds).
 * 3. Return a flat list of applicable rates sorted by price ascending.
 */
export async function calculateShippingRates(
  db: Kysely<Database>,
  shopId: string,
  address: ShippingAddress,
  cartItems: CartItem[],
): Promise<CalculatedShippingRate[]> {
  const country = (address.country_code ?? address.country ?? '').toUpperCase()
  if (!country) {
    throw new Error('Shipping address must include a country')
  }

  // Only consider items that require shipping
  const shippableItems = cartItems.filter(
    (ci) => ci.requires_shipping !== false,
  )
  if (shippableItems.length === 0) {
    return [] // nothing to ship
  }

  // Compute cart subtotal and total weight for rate filtering
  let cartSubtotal = 0
  let cartWeight = 0
  for (const item of shippableItems) {
    cartSubtotal += parseFloat(item.price) * item.quantity
    cartWeight += parseFloat(item.weight ?? '0') * item.quantity
  }

  // Fetch all zones for this shop
  const zones = await db
    .selectFrom('shipping_zones')
    .selectAll()
    .where('shop_id', '=', shopId)
    .execute()

  // Find zones matching the destination country
  const matchingZones = zones.filter((zone) => {
    const countries = zone.countries as string[]
    return (
      countries &&
      countries.some((c: string) => c.toUpperCase() === country)
    )
  })

  if (matchingZones.length === 0) return []

  const matchingZoneIds = matchingZones.map((z) => z.id)

  // Fetch all rates for matching zones
  const rates = await db
    .selectFrom('shipping_rates')
    .selectAll()
    .where('zone_id', 'in', matchingZoneIds)
    .execute()

  // Build zone name lookup
  const zoneMap = new Map(matchingZones.map((z) => [z.id, z]))

  // Filter rates by type constraints
  const applicable: CalculatedShippingRate[] = []

  for (const rate of rates) {
    let matches = false

    if (rate.type === 'flat') {
      matches = true
    } else if (rate.type === 'price_based') {
      const min = parseFloat(rate.min_value ?? '0')
      const max = rate.max_value ? parseFloat(rate.max_value) : Infinity
      matches = cartSubtotal >= min && cartSubtotal <= max
    } else if (rate.type === 'weight_based') {
      const min = parseFloat(rate.min_value ?? '0')
      const max = rate.max_value ? parseFloat(rate.max_value) : Infinity
      matches = cartWeight >= min && cartWeight <= max
    }

    if (matches) {
      const zone = zoneMap.get(rate.zone_id)!
      applicable.push({
        rate_id: rate.id,
        zone_id: rate.zone_id,
        zone_name: zone.name,
        name: rate.name,
        price: rate.price,
        type: rate.type,
      })
    }
  }

  // Sort by price ascending
  applicable.sort(
    (a, b) => parseFloat(a.price) - parseFloat(b.price),
  )

  return applicable
}

// ===========================================================================
// Phase 9 PR1 — carrier-aware checkout entry
// ===========================================================================

/**
 * A rate offer rendered in checkout. Unifies the two sources
 * (merchant-stored `shipping_rates` row + live provider `RateQuote`)
 * so the frontend renders one list with a consistent shape.
 */
export interface ShippingOffer {
  source: 'stored' | 'provider'
  /** Stable id — for 'stored' it's shipping_rates.id; for 'provider' it's a synthetic key. */
  id: string
  zone_id: string | null
  zone_name: string | null
  name: string
  price: number
  currency: string
  carrier_kind: CarrierKind | null
  service_code: string | null
  transit_days_min: number | null
  transit_days_max: number | null
}

export interface ComputeShippingRatesOpts {
  /** Shop currency — default 'USD'. Used as fallback when a stored row has NULL currency. */
  currency?: string
  /**
   * If true, only return carrier-backed offers (skip pre-066 custom
   * rates). Default false — merchants with both shouldn't lose their
   * custom rates.
   */
  carriers_only?: boolean
  /**
   * When a provider raises `MissingCarrierCredentialsError`, include
   * it in `errors` rather than throwing. Default true — checkout
   * should not hard-fail because one carrier is misconfigured.
   */
  swallow_provider_errors?: boolean
}

export interface ComputeShippingRatesResult {
  offers: ShippingOffer[]
  errors: { carrier: string; message: string }[]
  /**
   * Phase 9 PR3 — the market that owns the destination country (or
   * primary / rest-of-world fallback). `null` when no markets are
   * configured for the shop yet. `reason` explains which resolver
   * pass matched; 'none' means neither exact match, primary, nor
   * rest-of-world catch-all was available.
   */
  market: {
    id: string | null
    name: string | null
    currency_code: string | null
    reason: ResolvedMarket['reason']
  }
}

/**
 * Checkout entry — compute shipping offers for a shop+address+cart.
 *
 * Strategy:
 *   1. Resolve zones matching the destination country.
 *   2. For each matching zone, fetch stored rates filtered by
 *      weight/price brackets (same logic as calculateShippingRates).
 *   3. For each enabled shipping_carriers row, build a provider and
 *      ask for live quotes at the parcel weight.
 *   4. Merge + sort by price ascending.
 */
export async function computeShippingRates(
  db: Kysely<Database>,
  shopId: string,
  address: ShippingAddress,
  cartItems: CartItem[],
  opts: ComputeShippingRatesOpts = {},
): Promise<ComputeShippingRatesResult> {
  const country = (address.country_code ?? address.country ?? '').toUpperCase()
  if (!country) {
    throw new Error('Shipping address must include a country')
  }

  // PR3 — resolve the market that owns this destination country. We do
  // this early so the empty-cart short-circuit below still carries market
  // metadata for the caller (useful for currency hinting on an empty UI).
  const resolved = await resolveMarketForAddress(db, shopId, { country })
  const marketInfo = {
    id: resolved.market?.id ?? null,
    name: resolved.market?.name ?? null,
    currency_code: resolved.market?.currency_code ?? null,
    reason: resolved.reason,
  }

  const shippable = cartItems.filter((ci) => ci.requires_shipping !== false)
  if (shippable.length === 0) {
    return { offers: [], errors: [], market: marketInfo }
  }

  let subtotal = 0
  let weightLb = 0
  for (const item of shippable) {
    subtotal += parseFloat(item.price) * item.quantity
    weightLb += parseFloat(item.weight ?? '0') * item.quantity
  }

  const defaultCurrency = opts.currency ?? 'USD'

  // --- 1+2. Stored rates (existing path) -------------------------------
  // Phase 9 PR3 — pass the resolved market_id so zones attached to a
  // different market are filtered out. Unassigned (market_id=NULL) zones
  // remain in the candidate set (back-compat).
  const resolvedMarketId = resolved.market?.id ?? null
  let storedOffers: ShippingOffer[] = []
  if (!opts.carriers_only) {
    storedOffers = await loadStoredOffers(
      db, shopId, country, subtotal, weightLb, defaultCurrency, resolvedMarketId,
    )
  } else {
    // carriers_only still wants to honour manual-carrier rates that
    // the admin seeded from the catalog.
    const all = await loadStoredOffers(
      db, shopId, country, subtotal, weightLb, defaultCurrency, resolvedMarketId,
    )
    storedOffers = all.filter((o) => o.carrier_kind !== null)
  }

  // --- 3. Provider rates (live or stub) --------------------------------
  const carrierRows = await db
    .selectFrom('shipping_carriers')
    .select(['kind', 'enabled', 'use_live_rates', 'credentials_json'])
    .where('shop_id', '=', shopId)
    .where('enabled', '=', true)
    .execute()

  const shopRows: ShopCarrierRow[] = carrierRows.map((r) => ({
    kind: r.kind,
    enabled: r.enabled,
    use_live_rates: r.use_live_rates,
    credentials_json: r.credentials_json as Record<string, unknown> | null,
  }))

  const { providers, errors: buildErrors } = buildProvidersForShop(shopRows, {
    currency: defaultCurrency,
  })

  const providerOffers: ShippingOffer[] = []
  const errors: { carrier: string; message: string }[] = buildErrors.map((e) => ({
    carrier: e.kind, message: e.message,
  }))

  for (const provider of providers) {
    try {
      const quotes = await provider.getRates({
        origin: {
          country_code: 'US', // PR1: origin assumed from shop; future PR threads shop address
        },
        destination: {
          country_code: country,
          province_code: address.province_code ?? null,
          province: address.province ?? null,
          city: address.city ?? null,
          zip: address.zip ?? null,
        },
        weight_lb: weightLb,
        declared_value_usd: subtotal,
        currency: defaultCurrency,
      })

      for (const q of quotes) {
        providerOffers.push(quoteToOffer(q, provider))
      }
    } catch (err: any) {
      if (!opts.swallow_provider_errors && !(err instanceof MissingCarrierCredentialsError)) {
        throw err
      }
      errors.push({ carrier: provider.kind, message: err?.message ?? String(err) })
    }
  }

  // --- 4. Merge + sort -------------------------------------------------
  const offers = [...storedOffers, ...providerOffers].sort(
    (a, b) => a.price - b.price,
  )

  return { offers, errors, market: marketInfo }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadStoredOffers(
  db: Kysely<Database>,
  shopId: string,
  country: string,
  subtotal: number,
  weightLb: number,
  defaultCurrency: string,
  resolvedMarketId: string | null,
): Promise<ShippingOffer[]> {
  const zones = await db
    .selectFrom('shipping_zones')
    .selectAll()
    .where('shop_id', '=', shopId)
    .execute()

  const matchingZones = zones.filter((zone) => {
    const countries = zone.countries as unknown as string[] | null
    const countryOk =
      Array.isArray(countries) &&
      countries.some((c: string) => c.toUpperCase() === country)
    if (!countryOk) return false
    // PR3 — market filter. A zone pinned to a different market is
    // excluded. Zones with market_id=NULL (unassigned) remain visible.
    if (resolvedMarketId != null && zone.market_id != null) {
      return zone.market_id === resolvedMarketId
    }
    return true
  })

  if (matchingZones.length === 0) return []

  const rates = await db
    .selectFrom('shipping_rates')
    .selectAll()
    .where('zone_id', 'in', matchingZones.map((z) => z.id))
    .execute()

  const zoneMap = new Map(matchingZones.map((z) => [z.id, z]))
  const offers: ShippingOffer[] = []

  for (const rate of rates) {
    // Match by weight_min_lb / weight_max_lb first (carrier rows from
    // migration 066), fall back to min_value / max_value for legacy rows.
    let matches = false
    if (rate.weight_min_lb != null || rate.weight_max_lb != null) {
      const min = parseFloat(rate.weight_min_lb ?? '0')
      const max = rate.weight_max_lb ? parseFloat(rate.weight_max_lb) : Infinity
      matches = weightLb >= min && weightLb <= max
    } else if (rate.type === 'flat') {
      matches = true
    } else if (rate.type === 'price_based') {
      const min = parseFloat(rate.min_value ?? '0')
      const max = rate.max_value ? parseFloat(rate.max_value) : Infinity
      matches = subtotal >= min && subtotal <= max
    } else if (rate.type === 'weight_based') {
      const min = parseFloat(rate.min_value ?? '0')
      const max = rate.max_value ? parseFloat(rate.max_value) : Infinity
      matches = weightLb >= min && weightLb <= max
    }

    if (!matches) continue

    const zone = zoneMap.get(rate.zone_id)!
    offers.push({
      source: 'stored',
      id: rate.id,
      zone_id: rate.zone_id,
      zone_name: zone.name,
      name: rate.name,
      price: parseFloat(rate.price),
      currency: rate.currency || defaultCurrency,
      carrier_kind: (rate.carrier_kind as CarrierKind | null) ?? null,
      service_code: rate.service_code ?? null,
      transit_days_min: rate.transit_days_min ?? null,
      transit_days_max: rate.transit_days_max ?? null,
    })
  }

  return offers
}

function quoteToOffer(q: RateQuote, provider: RateProvider): ShippingOffer {
  return {
    source: 'provider',
    id: `${provider.kind}:${q.service_code}:${q.matched_region ?? ''}:${q.matched_weight_lb_min ?? 0}-${q.matched_weight_lb_max ?? 0}`,
    zone_id: null,
    zone_name: null,
    name: q.service_name,
    price: q.rate,
    currency: q.currency,
    carrier_kind: q.carrier_kind,
    service_code: q.service_code,
    transit_days_min: q.transit_days_min,
    transit_days_max: q.transit_days_max,
  }
}

// Re-export providers module so the admin handler can import
// buildProvidersForShop via @gbox/core/modules/shipping/service.js
// without a second require path.
export { buildProvidersForShop, MissingCarrierCredentialsError }
export type { CarrierKind, RegionCode, RateQuote, RateProvider }
