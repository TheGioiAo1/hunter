/**
 * Gbox Platform — Money filter unit tests
 *
 * Decision #1 Step 1.5 — Verifies the Shopify-compatible money filters
 * register and produce the expected outputs across:
 *
 *   - default format (no shop context)
 *   - shop-provided money_format / money_with_currency_format
 *   - every Shopify `{{amount*}}` token
 *   - trailing-zero stripping on whole units
 *   - negative amounts
 *   - object-with-.amount inputs (Money-drop-like)
 *   - null / undefined / NaN / empty-string safety
 *   - weight_with_unit conversions
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { Liquid } from 'liquidjs'
import { registerMoneyFilters } from './money.js'

let liquid: Liquid

beforeAll(() => {
  liquid = new Liquid({
    strictFilters: true,
    strictVariables: false,
    outputEscape: undefined,
  })
  registerMoneyFilters(liquid)
})

async function render(tpl: string, ctx: Record<string, unknown> = {}): Promise<string> {
  return liquid.parseAndRender(tpl, ctx)
}

// ---------------------------------------------------------------------------
// Default format (no shop context)
// ---------------------------------------------------------------------------

describe('money — default format', () => {
  it('formats 1999 cents as $19.99', async () => {
    expect(await render('{{ 1999 | money }}')).toBe('$19.99')
  })
  it('formats 0 as $0.00', async () => {
    expect(await render('{{ 0 | money }}')).toBe('$0.00')
  })
  it('formats 100000 cents as $1,000.00 (thousands separator)', async () => {
    expect(await render('{{ 100000 | money }}')).toBe('$1,000.00')
  })
  it('formats 123456789 cents as $1,234,567.89', async () => {
    expect(await render('{{ 123456789 | money }}')).toBe('$1,234,567.89')
  })
  it('formats negative amount with leading minus', async () => {
    expect(await render('{{ -500 | money }}')).toBe('-$5.00')
  })
  it('coerces numeric string input', async () => {
    expect(await render('{{ "1999" | money }}')).toBe('$19.99')
  })
  it('treats null as $0.00', async () => {
    expect(await render('{{ nothing | money }}')).toBe('$0.00')
  })
  it('treats NaN / garbage string as $0.00', async () => {
    expect(await render('{{ "nope" | money }}')).toBe('$0.00')
  })
  it('reads .amount off an object input', async () => {
    expect(await render('{{ drop | money }}', { drop: { amount: 2500 } })).toBe('$25.00')
  })
  it('reads .price off an object input as fallback', async () => {
    expect(await render('{{ drop | money }}', { drop: { price: 750 } })).toBe('$7.50')
  })
  it('rounds fractional cents to the nearest integer', async () => {
    expect(await render('{{ 1999.4 | money }}')).toBe('$19.99')
    expect(await render('{{ 1999.6 | money }}')).toBe('$20.00')
  })
})

// ---------------------------------------------------------------------------
// money_with_currency — default
// ---------------------------------------------------------------------------

describe('money_with_currency — default format', () => {
  it('formats 1999 cents as $19.99 USD', async () => {
    expect(await render('{{ 1999 | money_with_currency }}')).toBe('$19.99 USD')
  })
})

// ---------------------------------------------------------------------------
// money_without_currency — always uses {{amount}}
// ---------------------------------------------------------------------------

describe('money_without_currency', () => {
  it('drops currency symbol regardless of shop format', async () => {
    const shop = { money_format: '€{{amount_with_comma_separator}}' }
    expect(await render('{{ 1999 | money_without_currency }}', { shop })).toBe('19.99')
  })
  it('uses dot+comma English format', async () => {
    expect(await render('{{ 100000 | money_without_currency }}')).toBe('1,000.00')
  })
})

// ---------------------------------------------------------------------------
// Shop-provided format
// ---------------------------------------------------------------------------

describe('money — shop money_format', () => {
  it('uses custom prefix + suffix from shop.money_format', async () => {
    const shop = { money_format: 'CAD ${{amount}}' }
    expect(await render('{{ 1999 | money }}', { shop })).toBe('CAD $19.99')
  })

  it('supports amount_with_comma_separator (EU)', async () => {
    const shop = { money_format: '€{{amount_with_comma_separator}}' }
    expect(await render('{{ 123456 | money }}', { shop })).toBe('€1.234,56')
  })

  it('supports amount_with_space_separator', async () => {
    const shop = { money_format: '{{amount_with_space_separator}} ₫' }
    expect(await render('{{ 100000000 | money }}', { shop })).toBe('1 000 000,00 ₫')
  })

  it('supports amount_with_apostrophe_separator (CH)', async () => {
    const shop = { money_format: "CHF {{amount_with_apostrophe_separator}}" }
    expect(await render('{{ 1234567 | money }}', { shop })).toBe("CHF 12'345.67")
  })

  it('supports amount_no_decimals (JP yen)', async () => {
    const shop = { money_format: '¥{{amount_no_decimals}}' }
    expect(await render('{{ 123456 | money }}', { shop })).toBe('¥1,235')
  })

  it('supports amount_no_decimals_with_comma_separator', async () => {
    const shop = { money_format: '{{amount_no_decimals_with_comma_separator}} Kr' }
    expect(await render('{{ 123456 | money }}', { shop })).toBe('1.235 Kr')
  })

  it('supports amount_no_decimals_with_space_separator', async () => {
    const shop = { money_format: '{{amount_no_decimals_with_space_separator}}' }
    expect(await render('{{ 123456 | money }}', { shop })).toBe('1 235')
  })

  it('leaves unknown tokens untouched', async () => {
    const shop = { money_format: '{{currency}} {{amount}}' }
    expect(await render('{{ 1999 | money }}', { shop })).toBe('{{currency}} 19.99')
  })
})

// ---------------------------------------------------------------------------
// money_without_trailing_zeros
// ---------------------------------------------------------------------------

describe('money_without_trailing_zeros', () => {
  it('strips .00 when amount is whole units', async () => {
    expect(await render('{{ 2000 | money_without_trailing_zeros }}')).toBe('$20')
  })
  it('keeps fractional amounts intact', async () => {
    expect(await render('{{ 1999 | money_without_trailing_zeros }}')).toBe('$19.99')
  })
  it('works with comma-separator format on whole units', async () => {
    const shop = { money_format: '€{{amount_with_comma_separator}}' }
    expect(await render('{{ 100000 | money_without_trailing_zeros }}', { shop })).toBe('€1.000')
  })
  it('works with space-separator format on whole units', async () => {
    const shop = { money_format: '{{amount_with_space_separator}}' }
    expect(await render('{{ 100000 | money_without_trailing_zeros }}', { shop })).toBe('1 000')
  })
  it('keeps fractional comma-separator intact', async () => {
    const shop = { money_format: '€{{amount_with_comma_separator}}' }
    expect(await render('{{ 123456 | money_without_trailing_zeros }}', { shop })).toBe(
      '€1.234,56',
    )
  })
  it('zero renders as whole', async () => {
    expect(await render('{{ 0 | money_without_trailing_zeros }}')).toBe('$0')
  })
})

// ---------------------------------------------------------------------------
// money_with_currency_without_trailing_zeros
// ---------------------------------------------------------------------------

describe('money_with_currency_without_trailing_zeros', () => {
  it('strips .00 but keeps currency suffix', async () => {
    expect(
      await render('{{ 2000 | money_with_currency_without_trailing_zeros }}'),
    ).toBe('$20 USD')
  })
  it('keeps decimals on fractional amounts', async () => {
    expect(
      await render('{{ 1999 | money_with_currency_without_trailing_zeros }}'),
    ).toBe('$19.99 USD')
  })
})

// ---------------------------------------------------------------------------
// weight_with_unit
// ---------------------------------------------------------------------------

describe('weight_with_unit', () => {
  it('defaults to grams when no unit specified', async () => {
    expect(await render('{{ 500 | weight_with_unit }}')).toBe('500 g')
  })
  it('converts to kilograms with decimal', async () => {
    expect(await render('{{ 1500 | weight_with_unit: "kg" }}')).toBe('1.5 kg')
  })
  it('converts to whole kilograms without decimals', async () => {
    expect(await render('{{ 1000 | weight_with_unit: "kg" }}')).toBe('1 kg')
  })
  it('converts to pounds with 2-decimal rounding', async () => {
    expect(await render('{{ 907 | weight_with_unit: "lb" }}')).toBe('2 lb')
  })
  it('converts to ounces', async () => {
    expect(await render('{{ 28 | weight_with_unit: "oz" }}')).toBe('0.99 oz')
  })
  it('handles 0', async () => {
    expect(await render('{{ 0 | weight_with_unit: "kg" }}')).toBe('0 kg')
  })
})
