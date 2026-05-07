/**
 * Checkout — Incremental cart totals (Phase 4.3.3)
 *
 * The existing `recalculateTotals` in checkout/service.ts walks every
 * line item on every mutation. That is fine for a small consumer cart
 * (< 10 items) but wasteful for:
 *
 *   - B2B reorder flows that load 50+ line items at once.
 *   - Bulk-edit admin views.
 *   - High-frequency quantity-adjust interactions (+/- buttons).
 *
 * These helpers apply a delta when a single line item changes so the
 * full recompute only runs on events that actually need it (shipping
 * address change, discount apply, currency switch).
 *
 * Rules of thumb:
 *   - Use `applyLineDelta` for +/- quantity / add / remove of a single line.
 *   - After ANY address or discount change, fall back to the full
 *     `recalculateTotals` — tax and free-shipping cutoffs depend on
 *     totals that are harder to compute incrementally.
 */

export interface CartTotals {
  subtotal_price: string
  total_discounts: string
  total_shipping: string
  total_tax: string
  total_price: string
}

export interface LineDelta {
  /** +N when adding, -N when removing. */
  quantity: number
  /** Unit price of the affected line. */
  unit_price: string
  /** Whether the line is taxable — affects tax delta. */
  taxable: boolean
  /** Tax rate to apply (0 if none). Typically already resolved from address. */
  tax_rate: number
}

// ---------------------------------------------------------------------------
// Internal decimal math — all via integer cents to avoid float drift.
// ---------------------------------------------------------------------------

function toCents(str: string): number {
  const [int, frac = ''] = str.split('.')
  return parseInt(int, 10) * 100 + parseInt((frac + '00').slice(0, 2), 10)
}

function fromCents(cents: number): string {
  const abs = Math.abs(Math.round(cents))
  const sign = cents < 0 ? '-' : ''
  return sign + Math.floor(abs / 100).toString() + '.' + (abs % 100).toString().padStart(2, '0')
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Apply a single line delta to running totals. Returns new totals.
 *
 * Does NOT recompute discounts — caller is responsible for re-evaluating
 * discount eligibility when appropriate (e.g. "spend $50 for free
 * shipping" thresholds).
 */
export function applyLineDelta(
  totals: CartTotals,
  delta: LineDelta,
): CartTotals {
  const lineDeltaCents = toCents(delta.unit_price) * delta.quantity
  const taxDeltaCents = delta.taxable
    ? Math.round(lineDeltaCents * delta.tax_rate)
    : 0

  const subtotalCents = toCents(totals.subtotal_price) + lineDeltaCents
  const taxCents = toCents(totals.total_tax) + taxDeltaCents
  const shippingCents = toCents(totals.total_shipping)
  const discountCents = toCents(totals.total_discounts)

  const totalCents = Math.max(0, subtotalCents - discountCents + shippingCents + taxCents)

  return {
    subtotal_price: fromCents(Math.max(0, subtotalCents)),
    total_discounts: fromCents(discountCents),
    total_shipping: fromCents(shippingCents),
    total_tax: fromCents(Math.max(0, taxCents)),
    total_price: fromCents(totalCents),
  }
}

/**
 * Zeroed totals — useful as the starting point for a brand-new cart.
 */
export function emptyTotals(): CartTotals {
  return {
    subtotal_price: '0.00',
    total_discounts: '0.00',
    total_shipping: '0.00',
    total_tax: '0.00',
    total_price: '0.00',
  }
}
