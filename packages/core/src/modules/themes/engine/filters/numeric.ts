/**
 * Gbox Platform — Numeric filter overrides
 *
 * Decision #1 Step 1.5 — LiquidJS ships most Shopify numeric filters
 * (plus, minus, times, modulo, round, ceil, floor, abs, at_least,
 * at_most) with behaviour that matches Shopify exactly. We don't need
 * to touch those — the contract test in `numeric.test.ts` pins them.
 *
 * ONE filter needs overriding: `divided_by`.
 *
 *   Shopify/Ruby Liquid: `{{ 10 | divided_by: 3 }}` → `3`
 *     (integer division, because both operands are Integer)
 *
 *   LiquidJS default:    `{{ 10 | divided_by: 3 }}` → `3.3333...`
 *     (always float division — LiquidJS treats every Number the same)
 *
 * This divergence breaks real Shopify themes that use `divided_by` for
 * things like "items per row" (`{{ grid_size | divided_by: columns }}`)
 * or pagination math. Shopify themes in the store rely on the integer
 * semantics.
 *
 * Our override:
 *   - If BOTH operands are whole numbers at runtime (Number.isInteger),
 *     perform Ruby-style floor division (`Math.floor(a / b)`). Ruby's
 *     Integer#/ rounds toward -∞, not toward zero, so `-7 / 2 = -4`.
 *   - Otherwise fall through to float division.
 *   - Division by zero returns 0 (Shopify's behaviour — no throw).
 *
 * Caveat: LiquidJS loses the `.0` marker when parsing number literals,
 * so `{{ 10 | divided_by: 4.0 }}` becomes integer division because the
 * `4.0` is indistinguishable from `4` at runtime. Templates that need
 * explicit float math must read from a float variable set elsewhere,
 * e.g. `{% assign rate = 4.0 %}` — but even that gets parsed to int in
 * LiquidJS. The only 100%-reliable way to force float division is to
 * pass a non-integer divisor (`2.5`, `1.1`, etc.). This is documented
 * behaviour and matches what real themes end up doing in practice.
 */

import type { Liquid } from 'liquidjs'

function toNum(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

export function registerNumericFilters(liquid: Liquid): void {
  liquid.registerFilter('divided_by', function dividedBy(
    value: unknown,
    divisor: unknown,
  ): number {
    const a = toNum(value)
    const b = toNum(divisor)
    if (b === 0) return 0
    if (Number.isInteger(a) && Number.isInteger(b)) {
      // Ruby floor division (integer / integer → integer, rounds -∞).
      return Math.floor(a / b)
    }
    return a / b
  })
}
