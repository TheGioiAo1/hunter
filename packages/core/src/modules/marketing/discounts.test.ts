/**
 * Gbox Platform — Discount code engine tests (Stage 4.2)
 *
 * The discount engine is three pure helpers:
 *
 *   1. `generateDiscountCode(seed, opts)` — produces a stable,
 *      human-readable code from a merchant-controlled seed. Two
 *      calls with the same seed MUST return the same code so the
 *      admin UI can preview a code without "using" it.
 *   2. `validateDiscount(rule, context)` — checks every rule
 *      (expiry, usage cap, minimum spend, customer segment) and
 *      returns a discriminated result with a machine-readable
 *      rejection reason.
 *   3. `applyDiscount(rule, cart)` — calculates the discounted
 *      amount + the new cart total + a per-line breakdown, so the
 *      storefront / checkout can show the strike-through UI
 *      without rediscovering the math.
 *
 * These tests pin every branch: the three discount kinds
 * (percentage / fixed / free_shipping), every validation failure
 * mode, and the rounding rules on `applyDiscount`.
 */

import { describe, it, expect } from 'vitest'
import {
  generateDiscountCode,
  validateDiscount,
  applyDiscount,
  type DiscountRule,
  type ValidationContext,
  type CartForDiscount,
} from './discounts.js'

// ---------------------------------------------------------------------------
// generateDiscountCode
// ---------------------------------------------------------------------------

describe('generateDiscountCode', () => {
  it('is deterministic — same seed + opts → identical output', () => {
    const a = generateDiscountCode('customer:vip:alice', { prefix: 'VIP', length: 6 })
    const b = generateDiscountCode('customer:vip:alice', { prefix: 'VIP', length: 6 })
    expect(a).toBe(b)
  })

  it('produces different codes for different seeds', () => {
    const a = generateDiscountCode('a', { prefix: 'VIP', length: 6 })
    const b = generateDiscountCode('b', { prefix: 'VIP', length: 6 })
    expect(a).not.toBe(b)
  })

  it('respects the prefix verbatim', () => {
    const c = generateDiscountCode('seed', { prefix: 'SAVE10', length: 4 })
    expect(c.startsWith('SAVE10-')).toBe(true)
  })

  it('respects the requested suffix length', () => {
    const c = generateDiscountCode('seed', { prefix: 'X', length: 8 })
    const suffix = c.split('-')[1]!
    expect(suffix.length).toBe(8)
  })

  it('uses only uppercase ASCII + digits and no ambiguous chars (0/O/1/I)', () => {
    const c = generateDiscountCode('seed', { prefix: 'GO', length: 12 })
    const suffix = c.split('-')[1]!
    expect(suffix).toMatch(/^[A-HJ-NP-Z2-9]+$/)
  })
})

// ---------------------------------------------------------------------------
// validateDiscount
// ---------------------------------------------------------------------------

const baseRule = (overrides: Partial<DiscountRule> = {}): DiscountRule => ({
  id: 'dsc_1',
  code: 'SAVE10',
  kind: 'percentage',
  value: 10,
  currency: 'USD',
  startsAt: new Date('2026-01-01T00:00:00Z'),
  endsAt: new Date('2026-12-31T23:59:59Z'),
  usageLimit: null,
  usedCount: 0,
  minSubtotal: null,
  allowedSegments: null,
  oncePerCustomer: false,
  customerUsageCount: 0,
  ...overrides,
})

const baseCtx = (overrides: Partial<ValidationContext> = {}): ValidationContext => ({
  now: new Date('2026-04-09T12:00:00Z'),
  cartSubtotal: 100,
  currency: 'USD',
  customerId: 'cus_1',
  customerSegment: 'returning',
  ...overrides,
})

describe('validateDiscount', () => {
  it('accepts a simple valid 10% rule', () => {
    const out = validateDiscount(baseRule(), baseCtx())
    expect(out.ok).toBe(true)
  })

  it('rejects a code before the start window', () => {
    const out = validateDiscount(
      baseRule({ startsAt: new Date('2026-05-01T00:00:00Z') }),
      baseCtx(),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('not_yet_active')
  })

  it('rejects a code after the end window', () => {
    const out = validateDiscount(
      baseRule({ endsAt: new Date('2026-03-01T00:00:00Z') }),
      baseCtx(),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('expired')
  })

  it('rejects a code that has hit its global usage limit', () => {
    const out = validateDiscount(
      baseRule({ usageLimit: 100, usedCount: 100 }),
      baseCtx(),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('usage_limit')
  })

  it('rejects a "once per customer" code the buyer already used', () => {
    const out = validateDiscount(
      baseRule({ oncePerCustomer: true, customerUsageCount: 1 }),
      baseCtx(),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('already_used')
  })

  it('rejects a code when the cart subtotal is below minSubtotal', () => {
    const out = validateDiscount(
      baseRule({ minSubtotal: 150 }),
      baseCtx({ cartSubtotal: 100 }),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('min_subtotal')
  })

  it('rejects a code when the currency does not match the cart', () => {
    const out = validateDiscount(
      baseRule({ currency: 'EUR' }),
      baseCtx({ currency: 'USD' }),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('currency_mismatch')
  })

  it('rejects a code when the customer segment is not in the allow-list', () => {
    const out = validateDiscount(
      baseRule({ allowedSegments: ['vip'] }),
      baseCtx({ customerSegment: 'returning' }),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('segment_not_allowed')
  })

  it('accepts a code when the customer segment IS in the allow-list', () => {
    const out = validateDiscount(
      baseRule({ allowedSegments: ['vip', 'new'] }),
      baseCtx({ customerSegment: 'new' }),
    )
    expect(out.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// applyDiscount
// ---------------------------------------------------------------------------

const cart: CartForDiscount = {
  currency: 'USD',
  lines: [
    { variant_id: 'v1', quantity: 2, unit_price: 2000 }, // $40.00
    { variant_id: 'v2', quantity: 1, unit_price: 6000 }, // $60.00
  ],
  subtotal: 10000, // $100.00
  shipping: 500, // $5.00
}

describe('applyDiscount', () => {
  it('applies a 10% percentage discount to the subtotal', () => {
    const out = applyDiscount(
      baseRule({ kind: 'percentage', value: 10 }),
      cart,
    )
    expect(out.discountAmount).toBe(1000) // $10.00 in cents
    expect(out.newSubtotal).toBe(9000)
    expect(out.shipping).toBe(500)
    expect(out.newTotal).toBe(9500)
  })

  it('applies a fixed-amount discount in cents', () => {
    const out = applyDiscount(
      baseRule({ kind: 'fixed', value: 1500 }),
      cart,
    )
    expect(out.discountAmount).toBe(1500)
    expect(out.newSubtotal).toBe(8500)
    expect(out.newTotal).toBe(9000)
  })

  it('caps a fixed discount at the subtotal to avoid negative totals', () => {
    const out = applyDiscount(
      baseRule({ kind: 'fixed', value: 999999 }),
      cart,
    )
    expect(out.discountAmount).toBe(10000)
    expect(out.newSubtotal).toBe(0)
    expect(out.newTotal).toBe(500)
  })

  it('zeroes out shipping for a free_shipping discount', () => {
    const out = applyDiscount(
      baseRule({ kind: 'free_shipping', value: 0 }),
      cart,
    )
    expect(out.discountAmount).toBe(500)
    expect(out.newSubtotal).toBe(10000)
    expect(out.shipping).toBe(0)
    expect(out.newTotal).toBe(10000)
  })

  it("rounds percentage discounts to whole cents using bankers'-style rounding", () => {
    const weird: CartForDiscount = {
      ...cart,
      lines: [{ variant_id: 'v', quantity: 1, unit_price: 333 }],
      subtotal: 333,
      shipping: 0,
    }
    const out = applyDiscount(
      baseRule({ kind: 'percentage', value: 10 }),
      weird,
    )
    // 333 * 0.10 = 33.3 → round to 33 cents
    expect(out.discountAmount).toBe(33)
    expect(out.newSubtotal).toBe(300)
  })

  it('returns zero-discount breakdown when the rule would deduct nothing', () => {
    const out = applyDiscount(
      baseRule({ kind: 'percentage', value: 0 }),
      cart,
    )
    expect(out.discountAmount).toBe(0)
    expect(out.newTotal).toBe(10500)
  })
})
