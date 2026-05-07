/**
 * Gbox Platform — Numeric filter tests
 *
 * Decision #1 Step 1.5 — Two concerns in this file:
 *
 *   1. LiquidJS ships Shopify numeric filters (plus, minus, times,
 *      modulo, round, ceil, floor, abs, at_least, at_most) out of the
 *      box. We don't register them — but we DO pin their behaviour
 *      with contract tests so a `npm update liquidjs` can't silently
 *      change semantics under our feet.
 *
 *   2. Our `registerNumericFilters()` override replaces LiquidJS's
 *      `divided_by` with a Shopify-accurate integer-division version.
 *      These tests prove the override works.
 *
 * Two separate `Liquid` instances are used so we can clearly isolate
 * "stock LiquidJS behaviour" from "our override". If a future
 * LiquidJS version starts doing integer division natively, the stock
 * test will fail — that's a signal to drop our override, not a
 * regression.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { Liquid } from 'liquidjs'
import { registerNumericFilters } from './numeric.js'

let stock: Liquid
let patched: Liquid

beforeAll(() => {
  stock = new Liquid({
    strictFilters: true,
    strictVariables: false,
    outputEscape: undefined,
  })
  patched = new Liquid({
    strictFilters: true,
    strictVariables: false,
    outputEscape: undefined,
  })
  registerNumericFilters(patched)
})

async function renderStock(tpl: string, ctx: Record<string, unknown> = {}): Promise<string> {
  return stock.parseAndRender(tpl, ctx)
}
async function renderPatched(tpl: string, ctx: Record<string, unknown> = {}): Promise<string> {
  return patched.parseAndRender(tpl, ctx)
}

// ---------------------------------------------------------------------------
// Stock LiquidJS — arithmetic filters we delegate to
// ---------------------------------------------------------------------------

describe('numeric filters — arithmetic (stock LiquidJS)', () => {
  it('plus adds two numbers', async () => {
    expect(await renderStock('{{ 4 | plus: 2 }}')).toBe('6')
  })
  it('plus coerces numeric strings', async () => {
    expect(await renderStock('{{ "10" | plus: 5 }}')).toBe('15')
  })
  it('minus subtracts', async () => {
    expect(await renderStock('{{ 10 | minus: 3 }}')).toBe('7')
  })
  it('times multiplies', async () => {
    expect(await renderStock('{{ 6 | times: 7 }}')).toBe('42')
  })
  it('modulo returns the remainder', async () => {
    expect(await renderStock('{{ 10 | modulo: 3 }}')).toBe('1')
  })
})

describe('numeric filters — rounding (stock LiquidJS)', () => {
  it('round with no arg rounds to nearest integer', async () => {
    expect(await renderStock('{{ 2.5 | round }}')).toBe('3')
  })
  it('round with arg keeps N decimals', async () => {
    expect(await renderStock('{{ 2.12345 | round: 2 }}')).toBe('2.12')
  })
  it('ceil rounds up', async () => {
    expect(await renderStock('{{ 1.2 | ceil }}')).toBe('2')
  })
  it('floor rounds down', async () => {
    expect(await renderStock('{{ 1.8 | floor }}')).toBe('1')
  })
  it('abs returns absolute value', async () => {
    expect(await renderStock('{{ -5 | abs }}')).toBe('5')
  })
})

describe('numeric filters — clamping (stock LiquidJS)', () => {
  it('at_least raises value to minimum', async () => {
    expect(await renderStock('{{ 4 | at_least: 5 }}')).toBe('5')
  })
  it('at_least leaves value above minimum untouched', async () => {
    expect(await renderStock('{{ 8 | at_least: 5 }}')).toBe('8')
  })
  it('at_most caps value to maximum', async () => {
    expect(await renderStock('{{ 10 | at_most: 5 }}')).toBe('5')
  })
  it('at_most leaves value below maximum untouched', async () => {
    expect(await renderStock('{{ 3 | at_most: 5 }}')).toBe('3')
  })
})

// ---------------------------------------------------------------------------
// Known LiquidJS / Shopify divergence — documented pin
// ---------------------------------------------------------------------------

describe('numeric filters — LiquidJS divergence (divided_by)', () => {
  it('stock LiquidJS does float division even for integer operands (divergence from Shopify)', async () => {
    // This test documents the bug we're patching in registerNumericFilters.
    // If LiquidJS ever fixes this natively, the test will fail — at which
    // point we can delete our override.
    expect(await renderStock('{{ 10 | divided_by: 3 }}')).toBe(
      '3.3333333333333335',
    )
  })
})

// ---------------------------------------------------------------------------
// Our patched divided_by — Shopify-accurate
// ---------------------------------------------------------------------------

describe('divided_by (patched for Shopify parity)', () => {
  it('integer / integer → integer (truncated toward -∞)', async () => {
    expect(await renderPatched('{{ 10 | divided_by: 3 }}')).toBe('3')
  })
  it('integer / integer with exact result', async () => {
    expect(await renderPatched('{{ 10 | divided_by: 5 }}')).toBe('2')
  })
  it('integer / integer rounding toward zero for positives', async () => {
    expect(await renderPatched('{{ 7 | divided_by: 2 }}')).toBe('3')
  })
  it('negative numerator uses floor division (Ruby semantics)', async () => {
    // -7 / 2 = -3.5 → floor → -4 (NOT -3 which would be trunc-to-zero)
    expect(await renderPatched('{{ -7 | divided_by: 2 }}')).toBe('-4')
  })
  it('fractional divisor falls through to float division', async () => {
    // 3 / 2.5 = 1.2 — proves we take the float path when either
    // operand has a fractional part.
    expect(await renderPatched('{{ 3 | divided_by: rate }}', { rate: 2.5 })).toBe('1.2')
  })
  it('fractional numerator falls through to float division', async () => {
    expect(await renderPatched('{{ n | divided_by: 2 }}', { n: 2.5 })).toBe('1.25')
  })
  it('division by zero returns 0 (no throw)', async () => {
    expect(await renderPatched('{{ 10 | divided_by: 0 }}')).toBe('0')
  })
  it('string-coerced operands still work', async () => {
    expect(await renderPatched('{{ "10" | divided_by: "3" }}')).toBe('3')
  })
})

// ---------------------------------------------------------------------------
// Chaining — realistic theme patterns
// ---------------------------------------------------------------------------

describe('numeric filters — chaining (patched)', () => {
  it('computes (price * qty) | minus: discount | at_least: 0', async () => {
    const out = await renderPatched(
      '{{ price | times: qty | minus: discount | at_least: 0 }}',
      { price: 1999, qty: 3, discount: 10000 },
    )
    // 1999 * 3 = 5997 ; 5997 - 10000 = -4003 ; clamp → 0
    expect(out).toBe('0')
  })

  it('integer percentage via divided_by', async () => {
    // 17 / 50 * 100 = 34. With integer division: 17*100 / 50 = 1700/50 = 34.
    const out = await renderPatched(
      '{{ done | times: 100 | divided_by: total }}',
      { done: 17, total: 50 },
    )
    expect(out).toBe('34')
  })

  it('items-per-row pattern: ceil(items / columns)', async () => {
    // 10 items across 3 columns → 4 rows (10/3 = 3.33 → ceil = 4)
    // But Shopify themes write this as: `items | divided_by: columns | ceil`
    // With integer division: 10/3 = 3 (not 3.33), ceil(3) = 3. Themes
    // that want the "real" answer have to use `divided_by: columns | plus: 1`
    // or similar — documenting this here.
    const out = await renderPatched(
      '{{ items | divided_by: columns | ceil }}',
      { items: 10, columns: 3 },
    )
    expect(out).toBe('3')
  })
})
