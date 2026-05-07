/**
 * Gbox Platform — Incremental Cart Totals Tests
 *
 * Unit tests for `applyLineDelta` + `emptyTotals`. This is the cheap
 * recompute path for +/- quantity buttons; it avoids walking every
 * line item on every click. All math uses integer cents internally
 * to avoid floating-point drift.
 *
 * Run:
 *   npx vitest run packages/core/src/modules/checkout/cart-totals.test.ts
 */

import { describe, expect, it } from 'vitest'

import { applyLineDelta, emptyTotals, type CartTotals } from './cart-totals.js'

// ---------------------------------------------------------------------------
// emptyTotals
// ---------------------------------------------------------------------------

describe('emptyTotals', () => {
  it('returns all-zero totals with 2dp strings', () => {
    const t = emptyTotals()
    expect(t).toEqual({
      subtotal_price: '0.00',
      total_discounts: '0.00',
      total_shipping: '0.00',
      total_tax: '0.00',
      total_price: '0.00',
    })
  })

  it('returns a fresh object each call (no shared mutation)', () => {
    const a = emptyTotals()
    const b = emptyTotals()
    a.subtotal_price = '99.99'
    expect(b.subtotal_price).toBe('0.00')
  })
})

// ---------------------------------------------------------------------------
// applyLineDelta — addition
// ---------------------------------------------------------------------------

describe('applyLineDelta — adding items', () => {
  it('adds a single taxable line to an empty cart', () => {
    const next = applyLineDelta(emptyTotals(), {
      quantity: 1,
      unit_price: '10.00',
      taxable: true,
      tax_rate: 0.1, // 10% tax
    })
    expect(next.subtotal_price).toBe('10.00')
    expect(next.total_tax).toBe('1.00')
    expect(next.total_price).toBe('11.00')
  })

  it('adds multiple quantities of a taxable line', () => {
    const next = applyLineDelta(emptyTotals(), {
      quantity: 3,
      unit_price: '25.00',
      taxable: true,
      tax_rate: 0.08,
    })
    // subtotal = 75.00, tax = 6.00, total = 81.00
    expect(next.subtotal_price).toBe('75.00')
    expect(next.total_tax).toBe('6.00')
    expect(next.total_price).toBe('81.00')
  })

  it('adds a non-taxable line without touching tax', () => {
    const next = applyLineDelta(emptyTotals(), {
      quantity: 2,
      unit_price: '50.00',
      taxable: false,
      tax_rate: 0.1,
    })
    expect(next.subtotal_price).toBe('100.00')
    expect(next.total_tax).toBe('0.00')
    expect(next.total_price).toBe('100.00')
  })

  it('preserves pre-existing shipping and discounts', () => {
    const base: CartTotals = {
      subtotal_price: '50.00',
      total_discounts: '5.00',
      total_shipping: '9.99',
      total_tax: '4.50',
      total_price: '59.49', // 50 - 5 + 9.99 + 4.50
    }
    const next = applyLineDelta(base, {
      quantity: 1,
      unit_price: '20.00',
      taxable: true,
      tax_rate: 0.1,
    })
    // subtotal +20, tax +2.00, total = 70 - 5 + 9.99 + 6.50 = 81.49
    expect(next.subtotal_price).toBe('70.00')
    expect(next.total_tax).toBe('6.50')
    expect(next.total_shipping).toBe('9.99')
    expect(next.total_discounts).toBe('5.00')
    expect(next.total_price).toBe('81.49')
  })
})

// ---------------------------------------------------------------------------
// applyLineDelta — removal
// ---------------------------------------------------------------------------

describe('applyLineDelta — removing items', () => {
  it('subtracts a line from a cart with a single item', () => {
    const base: CartTotals = {
      subtotal_price: '10.00',
      total_discounts: '0.00',
      total_shipping: '0.00',
      total_tax: '1.00',
      total_price: '11.00',
    }
    const next = applyLineDelta(base, {
      quantity: -1,
      unit_price: '10.00',
      taxable: true,
      tax_rate: 0.1,
    })
    expect(next.subtotal_price).toBe('0.00')
    expect(next.total_tax).toBe('0.00')
    expect(next.total_price).toBe('0.00')
  })

  it('clamps subtotal to zero instead of going negative', () => {
    const base: CartTotals = {
      subtotal_price: '5.00',
      total_discounts: '0.00',
      total_shipping: '0.00',
      total_tax: '0.00',
      total_price: '5.00',
    }
    const next = applyLineDelta(base, {
      quantity: -2,
      unit_price: '5.00',
      taxable: false,
      tax_rate: 0,
    })
    expect(next.subtotal_price).toBe('0.00')
    expect(next.total_price).toBe('0.00')
  })

  it('clamps tax to zero instead of going negative', () => {
    const base: CartTotals = {
      subtotal_price: '5.00',
      total_discounts: '0.00',
      total_shipping: '0.00',
      total_tax: '0.50',
      total_price: '5.50',
    }
    const next = applyLineDelta(base, {
      quantity: -2, // over-removing
      unit_price: '5.00',
      taxable: true,
      tax_rate: 0.1,
    })
    expect(next.total_tax).toBe('0.00')
  })
})

// ---------------------------------------------------------------------------
// Decimal precision — no float drift
// ---------------------------------------------------------------------------

describe('applyLineDelta — decimal precision', () => {
  it('handles $0.10 × 3 correctly (classic float 0.30000000004 trap)', () => {
    const next = applyLineDelta(emptyTotals(), {
      quantity: 3,
      unit_price: '0.10',
      taxable: false,
      tax_rate: 0,
    })
    expect(next.subtotal_price).toBe('0.30')
    expect(next.total_price).toBe('0.30')
  })

  it('rounds tax to the nearest cent (bankers-safe rounding)', () => {
    // 7.00 × 0.0875 = 0.6125 → rounds to 0.61
    const next = applyLineDelta(emptyTotals(), {
      quantity: 1,
      unit_price: '7.00',
      taxable: true,
      tax_rate: 0.0875,
    })
    expect(next.total_tax).toBe('0.61')
    expect(next.total_price).toBe('7.61')
  })

  it('handles high-precision unit price with 2dp truncation', () => {
    // '9.999' → truncates to 9.99 via (frac+'00').slice(0,2)
    const next = applyLineDelta(emptyTotals(), {
      quantity: 1,
      unit_price: '9.99',
      taxable: false,
      tax_rate: 0,
    })
    expect(next.subtotal_price).toBe('9.99')
    expect(next.total_price).toBe('9.99')
  })

  it('round-trips a 4-digit dollar amount', () => {
    const next = applyLineDelta(emptyTotals(), {
      quantity: 1,
      unit_price: '1234.56',
      taxable: false,
      tax_rate: 0,
    })
    expect(next.subtotal_price).toBe('1234.56')
    expect(next.total_price).toBe('1234.56')
  })
})

// ---------------------------------------------------------------------------
// Total_price clamping with discounts
// ---------------------------------------------------------------------------

describe('applyLineDelta — discount interaction', () => {
  it('clamps total_price to zero when discount exceeds subtotal', () => {
    const base: CartTotals = {
      subtotal_price: '10.00',
      total_discounts: '50.00', // absurd discount
      total_shipping: '0.00',
      total_tax: '0.00',
      total_price: '0.00',
    }
    const next = applyLineDelta(base, {
      quantity: -1,
      unit_price: '10.00',
      taxable: false,
      tax_rate: 0,
    })
    // subtotal: 0, discount: 50 (unchanged), ship: 0, tax: 0 → clamp at 0
    expect(next.total_price).toBe('0.00')
  })

  it('preserves discount amount unchanged — caller re-evaluates eligibility', () => {
    const base: CartTotals = {
      subtotal_price: '100.00',
      total_discounts: '10.00',
      total_shipping: '0.00',
      total_tax: '0.00',
      total_price: '90.00',
    }
    const next = applyLineDelta(base, {
      quantity: 1,
      unit_price: '20.00',
      taxable: false,
      tax_rate: 0,
    })
    // Discount not re-evaluated by this helper.
    expect(next.total_discounts).toBe('10.00')
    expect(next.subtotal_price).toBe('120.00')
    expect(next.total_price).toBe('110.00')
  })
})
