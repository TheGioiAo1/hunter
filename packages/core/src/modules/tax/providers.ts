/**
 * Phase 9 / PR2 — Tax rate provider layer.
 *
 * Parallel structure to `shipping/providers.ts`:
 *   - `TaxProvider` interface: a single `getRates(request)` call
 *     returning zero-or-more `TaxLine` objects.
 *   - `createStubProvider()` wraps the seed catalog — this is what
 *     every shop uses in v1.
 *   - `buildTaxProviderForShop({ use_live_rates, credentials_json })`
 *     throws `MissingTaxCredentialsError` when live is on + creds are
 *     absent, matching how shipping handles the same signal. We
 *     never silently fall back to the stub.
 *
 * B2B VAT reverse-charge is handled here, not at the DB layer:
 *   if destination country is in the EU, buyer has a valid VAT ID
 *   (non-empty `buyer.vat_id` for v1 — Phase 9.PR2b adds VIES
 *   validation), and seller's origin country is a *different* EU
 *   country, emit a zero-rated `kind: 'vat_reverse_charge'` tax line.
 *   Same-country B2B is always charged VAT. Non-EU buyers at EU sellers
 *   are exempt (already handled by the resolveJurisdiction fallthrough).
 */

import {
  TAX_RATE_SEED,
  EU_MEMBER_STATES,
  seedRowFor,
  resolveJurisdiction,
  isEuMember,
  type TaxSeedRow,
  type TaxKind,
} from './seed.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaxRequestAddress {
  country?: string | null
  country_code?: string | null
  province?: string | null
  province_code?: string | null
  state?: string | null
  vat_id?: string | null              // buyer's VAT number (B2B)
}

export interface TaxRequest {
  origin: TaxRequestAddress            // seller's origin (ships-from)
  destination: TaxRequestAddress       // buyer's ship-to
  subtotal: number                     // goods subtotal in shop currency
  shipping: number                     // shipping cost in shop currency
  currency: string
  /** When true, buyer is a business (VAT ID present + verified). */
  buyer_is_business?: boolean
  /** When true, shop's `tax_shipping` setting is on. Overrides per-rate flag. */
  tax_shipping?: boolean
}

export interface TaxLine {
  name: string                         // 'California State Tax', 'German VAT 19%'
  rate: number                         // 0.0725 (as decimal)
  amount: number                       // dollars (or equivalent shop currency)
  kind: string                         // 'sales' | 'vat' | 'gst' | 'vat_reverse_charge'
  jurisdiction_code: string            // 'US-CA' | 'DE' | ...
  applies_to_shipping: boolean
}

export interface TaxProvider {
  kind: string                         // 'stub' | 'taxjar' | 'avalara' (future)
  getRates(req: TaxRequest): Promise<TaxLine[]>
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a shop flips `use_live_rates = true` without wiring
 * credentials. Same pattern as `MissingCarrierCredentialsError` in
 * shipping. Surfaces to the checkout as a swallowed error bucket so
 * one misconfigured shop doesn't break everyone's checkout.
 *
 * Seller-facing copy is iron-rule-5 compliant — "Please contact
 * Gbox support" wording lives in the admin UI layer, not here.
 */
export class MissingTaxCredentialsError extends Error {
  readonly code = 'MISSING_TAX_CREDENTIALS'
  constructor(kind: string) {
    super(`${kind} tax provider requires credentials to be configured.`)
    this.name = 'MissingTaxCredentialsError'
  }
}

// ---------------------------------------------------------------------------
// Stub provider
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Is the cross-EU-border B2B reverse-charge rule triggered?
 *
 * Conditions (all must be true):
 *   - Destination country is in the EU (not UK, which left in 2020).
 *   - Origin country is in the EU.
 *   - Destination country !== origin country.
 *   - Buyer is a business (has a VAT ID).
 *
 * When these hold, the invoice is zero-rated and the buyer accounts
 * for VAT via their local return. See EU Directive 2006/112/EC
 * Art. 196.
 */
export function shouldReverseCharge(req: TaxRequest): boolean {
  const destCountry = (
    req.destination.country_code ?? req.destination.country ?? ''
  ).toUpperCase()
  const originCountry = (
    req.origin.country_code ?? req.origin.country ?? ''
  ).toUpperCase()
  if (!destCountry || !originCountry) return false
  if (!isEuMember(destCountry) || !isEuMember(originCountry)) return false
  if (destCountry === originCountry) return false
  const hasVat = Boolean(
    req.buyer_is_business
    || (req.destination.vat_id && req.destination.vat_id.trim().length > 0),
  )
  return hasVat
}

/**
 * The stub provider — wraps the seed catalog. Returns zero-or-more tax
 * lines; merchants who enable custom per-shop `tax_rates` rows get those
 * merged on top by the service layer.
 */
export function createStubProvider(): TaxProvider {
  return {
    kind: 'stub',
    async getRates(req: TaxRequest): Promise<TaxLine[]> {
      // B2B reverse-charge → zero-rated line for audit clarity.
      if (shouldReverseCharge(req)) {
        const destCountry = (
          req.destination.country_code ?? req.destination.country ?? ''
        ).toUpperCase()
        return [{
          name: `EU VAT reverse-charge (${destCountry})`,
          rate: 0,
          amount: 0,
          kind: 'vat_reverse_charge',
          jurisdiction_code: destCountry,
          applies_to_shipping: false,
        }]
      }

      const jurisdiction = resolveJurisdiction(req.destination)
      if (!jurisdiction) return []
      const seed = seedRowFor(jurisdiction)
      if (!seed) return []
      if (seed.rate === 0) return [] // zero-rate states like OR / NH

      const shippingTaxable =
        (req.tax_shipping === true) && seed.applies_to_shipping
      const taxableAmount = req.subtotal + (shippingTaxable ? req.shipping : 0)
      const taxAmount = round2(taxableAmount * seed.rate)

      return [{
        name: nameForSeed(seed),
        rate: seed.rate,
        amount: taxAmount,
        kind: seed.kind,
        jurisdiction_code: seed.jurisdiction_code,
        applies_to_shipping: shippingTaxable,
      }]
    },
  }
}

function nameForSeed(seed: TaxSeedRow): string {
  const pct = (seed.rate * 100).toFixed(
    Number.isInteger(seed.rate * 100) ? 0 : 1,
  )
  switch (seed.kind) {
    case 'sales': return `${seed.name} Sales Tax (${pct}%)`
    case 'vat':   return `${seed.name} VAT (${pct}%)`
    case 'gst':   return `${seed.name} GST (${pct}%)`
    default:      return `${seed.name} Tax (${pct}%)`
  }
}

// ---------------------------------------------------------------------------
// Provider builders (for per-shop config)
// ---------------------------------------------------------------------------

export interface ShopTaxProviderRow {
  use_live_rates?: boolean | null
  credentials_json?: Record<string, unknown> | null
}

/**
 * Build a tax provider for a shop. For v1:
 *   - `use_live_rates = false` (default) → stub provider backed by seed.
 *   - `use_live_rates = true` + no creds → throws MissingTaxCredentialsError.
 *   - `use_live_rates = true` + creds    → throws "not implemented"; live
 *     adapters land in Phase 9.PR2b.
 */
export function buildTaxProviderForShop(
  row: ShopTaxProviderRow = {},
): TaxProvider {
  const live = Boolean(row.use_live_rates)
  if (!live) return createStubProvider()

  const creds = row.credentials_json
  const hasCreds = creds && Object.keys(creds).length > 0
  if (!hasCreds) {
    throw new MissingTaxCredentialsError('Live')
  }
  throw new Error(
    'Live tax provider is not yet implemented in this release. '
    + 'Please contact Gbox support to enable live rates.',
  )
}

// ---------------------------------------------------------------------------
// Re-exports for consumers
// ---------------------------------------------------------------------------

export { TAX_RATE_SEED, EU_MEMBER_STATES, isEuMember }
export type { TaxSeedRow, TaxKind }
