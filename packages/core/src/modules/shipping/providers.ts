/**
 * Gbox Platform — Rate Provider Interface + Stub Adapters
 *
 * Phase 9 / PR1.
 *
 * The `RateProvider` abstraction is the seam between checkout
 * (`computeShippingRates(cart, address)`) and the carrier-specific
 * pricing implementation. We ship 12 stub providers at v1 — one per
 * carrier in the seed catalog — and plan to replace each with a
 * live-API adapter in a future PR without touching checkout code.
 *
 * A provider receives:
 *   - origin address (merchant shop address)
 *   - destination address (customer address)
 *   - total weight in pounds
 *   - total declared value in the shop currency
 *
 * and returns a list of `RateQuote` objects — one per service the
 * carrier supports for that origin/destination pair.
 *
 * Why stubs?
 *   When a merchant enables a carrier, they have two options:
 *     a) "Use published rates" (default) — the stub provider reads from
 *        `shipping_rate_seed` and returns prices matching the public
 *        2026 tariff. No external API calls, zero friction to ship.
 *     b) "Use live carrier rates" — provider hits the carrier's Rating
 *        API using `shipping_carriers.credentials_json`. Not in PR1.
 *
 * When b) is requested but credentials aren't wired we throw a typed
 * error with a clear message so the admin UI can say "Live rates need
 * your USPS API key" — never fall back to stub silently (merchants
 * would be surprised by the wrong price).
 */

import type {
  CarrierKind,
  RegionCode,
  SeedRate,
} from './seed.js'
import {
  CARRIERS_BY_KIND,
  pickSeedRate,
  rateCatalogForCarrier,
  servicesForCarrier,
} from './seed.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderAddress {
  country_code: string      // ISO-2, e.g. 'US'
  province_code?: string | null
  province?: string | null
  city?: string | null
  zip?: string | null
}

export interface ProviderRateRequest {
  origin: ProviderAddress
  destination: ProviderAddress
  weight_lb: number         // total parcel weight in pounds
  declared_value_usd: number
  /** Currency the merchant prices in; provider returns rate in the same currency. */
  currency: string
}

export interface RateQuote {
  carrier_kind: CarrierKind
  service_code: string
  service_name: string
  /** Final price in the requested currency. */
  rate: number
  currency: string
  transit_days_min: number | null
  transit_days_max: number | null
  /** For debugging / admin display — the seed bracket we matched. */
  matched_region?: RegionCode
  matched_weight_lb_min?: number
  matched_weight_lb_max?: number
}

export interface RateProvider {
  /** Carrier kind — matches `shipping_carriers.kind` in the DB. */
  readonly kind: CarrierKind
  /** Human-readable label for admin picker. */
  readonly display_name: string
  /**
   * Fetch quotes for a single parcel. Returns empty array when the
   * carrier doesn't service the destination country.
   *
   * Throws when credentials are required but missing (live mode only).
   */
  getRates(req: ProviderRateRequest): Promise<RateQuote[]>
}

/**
 * Typed error for the "live rates requested but no credentials" path.
 * The admin layer catches this and renders a targeted remediation
 * message ("Add your USPS API credentials to use live rates").
 */
export class MissingCarrierCredentialsError extends Error {
  constructor(public readonly kind: CarrierKind) {
    super(`Carrier '${kind}' is configured for live rates but has no credentials set`)
    this.name = 'MissingCarrierCredentialsError'
  }
}

// ---------------------------------------------------------------------------
// Region resolver — picks the right region_code for a (carrier, destination)
// ---------------------------------------------------------------------------

/**
 * Given a carrier and the customer's destination, pick which
 * `region_code` to look up in the seed catalog. Centralising here
 * means each stub provider is a one-liner wrapper.
 *
 * Rules of thumb:
 *   USPS/UPS/FedEx + US destination    → 'US'  (domestic)
 *   USPS/UPS/FedEx + non-US            → 'INT'
 *   DHL Express + EU destination       → 'EU'
 *   DHL Express + non-EU               → 'INT'
 *   DHL Paket + DE destination         → 'EU-DE' ; otherwise null
 *   Royal Mail + GB destination        → 'UK'   ; non-GB → 'INT'
 *   La Poste + FR destination          → 'EU-FR'; non-FR → 'INT'
 *   DPD + any EU destination           → 'EU'   ; non-EU → 'INT'
 *   PostNL + NL destination            → 'EU-NL'; non-NL → 'INT'
 *   GLS + any EU destination           → 'EU'
 *   Hermes + GB destination            → 'UK'   ; non-GB → null
 *   Bpost + BE destination             → 'EU-BE'; non-BE → 'INT'
 */
const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE',
  'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT',
  'RO', 'SK', 'SI', 'ES', 'SE',
])

export function resolveRegion(
  kind: CarrierKind,
  destinationCountry: string,
): RegionCode | null {
  const c = destinationCountry.toUpperCase()
  switch (kind) {
    case 'usps':
    case 'ups':
    case 'fedex':
      return c === 'US' ? 'US' : 'INT'
    case 'dhl_express':
      if (EU_COUNTRIES.has(c) || c === 'GB') return 'EU'
      return 'INT'
    case 'dhl_paket':
      return c === 'DE' ? 'EU-DE' : null
    case 'royal_mail':
      return c === 'GB' ? 'UK' : 'INT'
    case 'la_poste':
      return c === 'FR' ? 'EU-FR' : 'INT'
    case 'dpd':
      if (EU_COUNTRIES.has(c) || c === 'GB') return 'EU'
      return 'INT'
    case 'postnl':
      return c === 'NL' ? 'EU-NL' : 'INT'
    case 'gls':
      if (EU_COUNTRIES.has(c) || c === 'GB') return 'EU'
      return null
    case 'hermes':
      return c === 'GB' ? 'UK' : null
    case 'bpost':
      return c === 'BE' ? 'EU-BE' : 'INT'
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Stub provider — builds RateQuote rows from the seed catalog
// ---------------------------------------------------------------------------

export interface StubProviderOpts {
  /** Shop's display currency — rate is converted 1:1 from the seed USD value. */
  currency?: string
  /** Conversion rate from USD to the target currency. Default: 1. */
  usd_to_currency?: number
}

export function createStubProvider(
  kind: CarrierKind,
  opts: StubProviderOpts = {},
): RateProvider {
  const meta = CARRIERS_BY_KIND[kind]
  if (!meta) {
    throw new Error(`Unknown carrier kind: ${kind}`)
  }
  const currency = opts.currency ?? 'USD'
  const conv = opts.usd_to_currency ?? 1

  return {
    kind,
    display_name: meta.display_name,

    async getRates(req) {
      const region = resolveRegion(kind, req.destination.country_code)
      if (region === null) return [] // carrier does not service this country

      const services = servicesForCarrier(kind)
      const quotes: RateQuote[] = []

      for (const serviceCode of services) {
        const seed = pickSeedRate(kind, serviceCode, region, req.weight_lb)
        if (!seed) continue
        quotes.push({
          carrier_kind: kind,
          service_code: seed.service_code,
          service_name: seed.service_name,
          rate: roundMoney(seed.rate_usd * conv),
          currency,
          transit_days_min: seed.transit_days_min,
          transit_days_max: seed.transit_days_max,
          matched_region: seed.region_code,
          matched_weight_lb_min: seed.weight_min_lb,
          matched_weight_lb_max: seed.weight_max_lb,
        })
      }

      quotes.sort((a, b) => a.rate - b.rate)
      return quotes
    },
  }
}

function roundMoney(n: number): number {
  // Round to cents, avoiding float drift (0.1 + 0.2 → 0.30000000001).
  return Math.round(n * 100) / 100
}

// ---------------------------------------------------------------------------
// Factory — build a provider for a shop's carrier row
// ---------------------------------------------------------------------------

export interface ShopCarrierRow {
  kind: string
  enabled: boolean
  use_live_rates: boolean
  credentials_json: Record<string, unknown> | null
}

/**
 * Build a provider for a per-shop carrier row.
 *
 * Today every enabled+not-live carrier yields a stub. Live mode throws
 * `MissingCarrierCredentialsError` unless credentials exist — future
 * PR replaces this branch with real API adapters (one per carrier
 * kind).
 */
export function buildProviderForShopCarrier(
  row: ShopCarrierRow,
  opts: StubProviderOpts = {},
): RateProvider | null {
  if (!row.enabled) return null

  const kind = row.kind as CarrierKind
  if (!CARRIERS_BY_KIND[kind]) return null

  if (row.use_live_rates) {
    if (!row.credentials_json || Object.keys(row.credentials_json).length === 0) {
      throw new MissingCarrierCredentialsError(kind)
    }
    // TODO(Phase 9 PR1b): live-API adapters.
    // For now, we refuse silently rather than returning stub data that
    // the merchant explicitly opted out of.
    throw new Error(
      `Live-rate adapter for '${kind}' is not implemented yet. ` +
      `Uncheck "Use live rates" to fall back to the 2026 published catalog.`,
    )
  }

  return createStubProvider(kind, opts)
}

// ---------------------------------------------------------------------------
// Convenience — build all providers for a shop
// ---------------------------------------------------------------------------

/**
 * Build providers for every enabled carrier row. Carriers with
 * `use_live_rates=true` but missing credentials are skipped and
 * reported back in the `errors` array — the caller (checkout) logs
 * these but keeps serving whichever carriers DID initialise.
 */
export function buildProvidersForShop(
  rows: ShopCarrierRow[],
  opts: StubProviderOpts = {},
): { providers: RateProvider[]; errors: { kind: string; message: string }[] } {
  const providers: RateProvider[] = []
  const errors: { kind: string; message: string }[] = []

  for (const row of rows) {
    if (!row.enabled) continue
    try {
      const p = buildProviderForShopCarrier(row, opts)
      if (p) providers.push(p)
    } catch (err: any) {
      errors.push({
        kind: row.kind,
        message: err?.message ?? String(err),
      })
    }
  }

  return { providers, errors }
}

// ---------------------------------------------------------------------------
// Export the seed-based helpers so admin code can list services before
// the provider is actually built (e.g. "this carrier offers 5 services
// in your region" copy in the enable dialog).
// ---------------------------------------------------------------------------

export { rateCatalogForCarrier, servicesForCarrier }
export type { CarrierKind, RegionCode, SeedRate }
