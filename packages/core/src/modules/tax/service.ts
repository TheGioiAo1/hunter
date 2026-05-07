/**
 * Gbox Platform — Tax computation at checkout.
 *
 * Phase 9 / PR2. This module is the checkout-entry function for tax:
 * `computeTaxForCart(db, shopId, address, cart, opts)`.
 *
 * Shape of the result
 * -------------------
 *   {
 *     tax_lines: [                  // one entry per applied tax
 *       { name, rate, amount, kind, jurisdiction_code, applies_to_shipping }
 *     ],
 *     total_tax: number,            // sum of tax_lines.amount (shop currency)
 *     subtotal_ex_tax: number,      // goods subtotal net of tax (for inclusive pricing)
 *     subtotal_inc_tax: number,     // goods subtotal gross of tax
 *     errors: [                     // soft-failed providers (shouldn't break checkout)
 *       { provider: string, message: string }
 *     ]
 *   }
 *
 * Source of truth priority:
 *   1. Shop-defined `tax_rates` rows for the destination jurisdiction
 *      (these always win — merchants have opted to manage their own).
 *   2. Stub provider fallback from the seed catalog (if no shop rates
 *      exist for the destination, and `use_live_rates` is off).
 *   3. Live provider (Phase 9.PR2b — throws "not implemented" for v1).
 *
 * Tax-inclusive vs exclusive pricing:
 *   - `shops.tax_inclusive_pricing = true` (EU-style): cart prices are
 *     assumed to already include VAT; we back-solve to separate the
 *     ex-tax subtotal and the tax amount.
 *   - `shops.tax_inclusive_pricing = false` (US-style, default):
 *     cart prices are ex-tax; we add tax on top.
 *
 * B2B reverse-charge:
 *   Handled by `providers.shouldReverseCharge`. When triggered, returns
 *   a single zero-rated tax_line with `kind = 'vat_reverse_charge'` so
 *   the invoice carries the required audit trail.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import {
  createStubProvider,
  MissingTaxCredentialsError,
  shouldReverseCharge,
  buildTaxProviderForShop,
  type TaxLine,
  type TaxRequest,
  type TaxRequestAddress,
} from './providers.js'
import { resolveJurisdiction } from './seed.js'
import {
  resolveMarketForAddress,
  type ResolvedMarket,
} from '../markets/resolver.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaxCartItem {
  variant_id?: string | null
  product_id?: string | null
  title?: string | null
  quantity: number
  price: string | number               // line price (per unit, shop currency)
  taxable?: boolean                    // default true
  requires_shipping?: boolean
}

export interface ComputeTaxOpts {
  /** When true, skip the stub provider fallback entirely. */
  custom_rates_only?: boolean
  /** When true, skip the custom rates and use the stub provider only. */
  stub_only?: boolean
  /** Shipping amount in shop currency. Default 0. */
  shipping?: number
  /** Buyer's VAT ID (for B2B reverse-charge classification). */
  buyer_vat_id?: string | null
  /** When true, treat the buyer as a business (forces reverse-charge path if EU-to-EU). */
  buyer_is_business?: boolean
  /** Shop-level overrides read from `shops` or a context. */
  shop?: {
    tax_inclusive_pricing?: boolean
    tax_shipping?: boolean
    origin_country?: string | null
    use_live_rates?: boolean
    credentials_json?: Record<string, unknown> | null
  }
}

export interface ComputeTaxResult {
  tax_lines: TaxLine[]
  total_tax: number
  subtotal_ex_tax: number
  subtotal_inc_tax: number
  shipping_tax: number
  errors: Array<{ provider: string; message: string }>
  /**
   * Phase 9 PR3 — the market that owns the destination country (or
   * primary / rest-of-world fallback). Emitted alongside the existing
   * fields so the storefront/checkout can surface market currency +
   * scope the visible tax registrations without a second DB round-trip.
   */
  market: {
    id: string | null
    name: string | null
    currency_code: string | null
    reason: ResolvedMarket['reason']
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function toNumber(v: string | number | null | undefined): number {
  if (v == null) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Compute tax for a cart at checkout.
 *
 * Never throws on normal conditions — missing jurisdictions, unserviced
 * destinations, and provider credential errors all produce an empty
 * `tax_lines` + populated `errors`. Throws only when the input itself is
 * invalid (no destination country, malformed cart items).
 */
export async function computeTaxForCart(
  db: Kysely<Database>,
  shopId: string,
  address: TaxRequestAddress,
  cart: TaxCartItem[],
  opts: ComputeTaxOpts = {},
): Promise<ComputeTaxResult> {
  const country = (
    address.country_code ?? address.country ?? ''
  ).toUpperCase()
  if (!country) {
    throw new Error('computeTaxForCart: destination country is required')
  }

  const taxInclusive = opts.shop?.tax_inclusive_pricing ?? false
  const taxShipping = opts.shop?.tax_shipping ?? false
  const shipping = opts.shipping ?? 0

  // Phase 9 PR3 — resolve the market for this destination. Emitted on
  // the result so callers (checkout, storefront) don't have to fetch
  // markets twice. Also passed to resolveCustomRates so registrations
  // attached to a different market are excluded (null/unassigned still
  // apply — back-compat).
  const resolvedMarket = await resolveMarketForAddress(db, shopId, { country })
  const marketInfo = {
    id: resolvedMarket.market?.id ?? null,
    name: resolvedMarket.market?.name ?? null,
    currency_code: resolvedMarket.market?.currency_code ?? null,
    reason: resolvedMarket.reason,
  }

  // Sum taxable subtotal (skip `taxable: false` and zero-quantity rows).
  let subtotalInc = 0
  for (const item of cart) {
    if (item.taxable === false) continue
    const qty = Number(item.quantity) || 0
    if (qty <= 0) continue
    subtotalInc += toNumber(item.price) * qty
  }
  subtotalInc = round2(subtotalInc)

  const jurisdiction = resolveJurisdiction(address)

  // -------------------------------------------------------------------------
  // Shop-defined rates first (unless stub_only)
  // -------------------------------------------------------------------------
  const errors: Array<{ provider: string; message: string }> = []
  let customLines: TaxLine[] = []
  if (!opts.stub_only && jurisdiction) {
    try {
      customLines = await resolveCustomRates(
        db, shopId, jurisdiction, {
          subtotal: subtotalInc,
          shipping,
          tax_shipping: taxShipping,
          tax_inclusive: taxInclusive,
          market_id: marketInfo.id,
        },
      )
    } catch (err: any) {
      errors.push({
        provider: 'custom_rates',
        message: err?.message ?? String(err),
      })
    }
  }

  // -------------------------------------------------------------------------
  // Stub provider fallback (only if no custom rates hit, and not custom_only)
  // -------------------------------------------------------------------------
  let stubLines: TaxLine[] = []
  if (!opts.custom_rates_only && customLines.length === 0) {
    try {
      const provider = buildTaxProviderForShop({
        use_live_rates: opts.shop?.use_live_rates ?? false,
        credentials_json: opts.shop?.credentials_json ?? null,
      })
      const req: TaxRequest = {
        origin: { country_code: opts.shop?.origin_country ?? null },
        destination: {
          country_code: country,
          province_code: (address.province_code ?? address.state ?? address.province) || null,
          vat_id: opts.buyer_vat_id ?? address.vat_id ?? null,
        },
        subtotal: subtotalInc,
        shipping,
        currency: 'USD',  // placeholder — caller is free to tag lines after
        buyer_is_business: opts.buyer_is_business,
        tax_shipping: taxShipping,
      }
      stubLines = await provider.getRates(req)
    } catch (err: any) {
      // MissingTaxCredentialsError + "not implemented" from live path
      // are swallowed here so one misconfig doesn't break the whole cart.
      const isCreds = err instanceof MissingTaxCredentialsError
        || /credentials|not implemented/i.test(err?.message ?? '')
      errors.push({
        provider: 'stub',
        message: isCreds
          ? (err?.message ?? 'Tax provider misconfigured')
          : (err?.message ?? String(err)),
      })
    }
  }

  // -------------------------------------------------------------------------
  // Merge + compute totals
  // -------------------------------------------------------------------------
  const taxLines = [...customLines, ...stubLines]
  const totalTax = round2(taxLines.reduce((sum, l) => sum + l.amount, 0))
  const shippingTaxApplied = taxLines
    .filter((l) => l.applies_to_shipping)
    .reduce((sum, l) => sum + (taxShipping ? shipping * l.rate : 0), 0)

  // Pricing modes:
  //   - tax_inclusive: subtotalInc is gross → ex-tax = gross - tax
  //   - tax_exclusive: subtotalInc is net → inc-tax = net + tax
  let subtotalExTax: number
  let subtotalIncTax: number
  if (taxInclusive) {
    subtotalIncTax = subtotalInc
    subtotalExTax = round2(subtotalInc - totalTax)
  } else {
    subtotalExTax = subtotalInc
    subtotalIncTax = round2(subtotalInc + totalTax)
  }

  return {
    tax_lines: taxLines,
    total_tax: totalTax,
    subtotal_ex_tax: subtotalExTax,
    subtotal_inc_tax: subtotalIncTax,
    shipping_tax: round2(shippingTaxApplied),
    errors,
    market: marketInfo,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CustomRateContext {
  subtotal: number
  shipping: number
  tax_shipping: boolean
  tax_inclusive: boolean
  /**
   * Phase 9 PR3 — the resolved market for the destination. When set,
   * tax rates belonging to a registration pinned to a different market
   * are excluded. `null` means "no market resolved / unassigned" and
   * the filter is relaxed (back-compat with pre-068 shops).
   */
  market_id: string | null
}

/**
 * Resolve shop-defined `tax_rates` for a jurisdiction and turn them
 * into TaxLine objects. Multiple rates can stack (e.g. federal GST +
 * provincial PST); compounded rates are applied to the post-previous-tax
 * base. Priority orders evaluation — higher runs first.
 */
async function resolveCustomRates(
  db: Kysely<Database>,
  shopId: string,
  jurisdictionCode: string,
  ctx: CustomRateContext,
): Promise<TaxLine[]> {
  const rows = await db
    .selectFrom('tax_rates')
    .selectAll()
    .where('shop_id', '=', shopId)
    .where('jurisdiction_code', '=', jurisdictionCode)
    .orderBy('priority', 'desc')
    .execute()

  if (rows.length === 0) return []

  // Phase 9 PR3 — optional market filter. If the cart resolved to a
  // market, look up each rate's parent registration and drop rates
  // whose registration belongs to a different market. Registrations
  // with `market_id=NULL` (unassigned / legacy) always apply.
  let filtered = rows
  if (ctx.market_id) {
    const regIds = Array.from(
      new Set(
        rows
          .map((r) => r.registration_id)
          .filter((id): id is string => typeof id === 'string'),
      ),
    )
    if (regIds.length > 0) {
      const regs = await db
        .selectFrom('tax_registrations')
        .select(['id', 'market_id'])
        .where('id', 'in', regIds)
        .execute()
      const regMarket = new Map(
        regs.map((r) => [r.id, r.market_id ?? null]),
      )
      filtered = rows.filter((r) => {
        if (!r.registration_id) return true // custom rate, no parent reg
        const m = regMarket.get(r.registration_id) ?? null
        if (m == null) return true           // reg not scoped to a market
        return m === ctx.market_id
      })
    }
  }
  if (filtered.length === 0) return []

  const lines: TaxLine[] = []
  let runningBase = ctx.subtotal
  const shippingBase = ctx.tax_shipping ? ctx.shipping : 0

  for (const row of filtered) {
    const rate = Number(row.rate)
    if (!Number.isFinite(rate) || rate <= 0) continue
    const base = row.compounded ? runningBase : ctx.subtotal
    const goodsAmount = base * rate
    const shippingAmount = row.applies_to_shipping ? shippingBase * rate : 0
    const amount = round2(goodsAmount + shippingAmount)

    lines.push({
      name: row.name,
      rate,
      amount,
      kind: row.kind,
      jurisdiction_code: row.jurisdiction_code,
      applies_to_shipping: row.applies_to_shipping,
    })

    if (row.compounded) {
      runningBase = runningBase + goodsAmount + shippingAmount
    }
  }
  return lines
}

// ---------------------------------------------------------------------------
// Re-exports for callers
// ---------------------------------------------------------------------------

export {
  buildTaxProviderForShop,
  createStubProvider,
  MissingTaxCredentialsError,
  shouldReverseCharge,
}
export type { TaxLine, TaxRequest, TaxRequestAddress }
