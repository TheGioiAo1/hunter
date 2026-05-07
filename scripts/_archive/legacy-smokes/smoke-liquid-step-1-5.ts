/**
 * Smoke test — Decision #1 Step 1.5 money + numeric filter set.
 *
 * Verifies end-to-end that:
 *   1. `| money` reads shop.money_format from the render context
 *   2. `| money_with_currency` reads shop.money_with_currency_format
 *   3. `| money_without_currency` ignores shop format
 *   4. `| money_without_trailing_zeros` strips .00 on whole units
 *   5. EU comma-separator format works end-to-end
 *   6. Negative amounts produce `-$X.YY` (minus outside symbol)
 *   7. Object inputs with `.amount` coerce correctly
 *   8. LiquidJS built-in numeric filters (plus/minus/times/…) work
 *   9. weight_with_unit converts grams → kg
 *  10. Money filters compose with string filters
 *
 * Run:
 *   npx tsx scripts/smoke-liquid-step-1-5.ts
 */

import {
  createLiquidEngine,
  StaticLoader,
} from '../packages/core/src/modules/themes/engine/index.js'
import { MemoryI18nService } from '../packages/core/src/modules/i18n/index.js'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

async function main() {
  // ----- Minimal theme tree (money filters don't need templates, but
  //       we wire the full engine to match production usage) -----
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gbox-liquid-money-'))
  try {
    const loader = new StaticLoader(tmp, { label: 'smoke-money' })
    const engine = createLiquidEngine({ loader, i18n: new MemoryI18nService() })

    // ----- (1) Default money format -----
    const out1 = await engine.liquid.parseAndRender('{{ 1999 | money }}')
    if (out1 !== '$19.99') throw new Error(`(1) ${out1}`)
    console.log('PASS (1) default money:', out1)

    // ----- (2) Shop-provided money format (CAD) -----
    const shopCAD = { shop: { money_format: 'CAD ${{amount}}' } }
    const out2 = await engine.liquid.parseAndRender('{{ 1999 | money }}', shopCAD)
    if (out2 !== 'CAD $19.99') throw new Error(`(2) ${out2}`)
    console.log('PASS (2) shop money_format:', out2)

    // ----- (3) money_with_currency default -----
    const out3 = await engine.liquid.parseAndRender('{{ 1999 | money_with_currency }}')
    if (out3 !== '$19.99 USD') throw new Error(`(3) ${out3}`)
    console.log('PASS (3) money_with_currency:', out3)

    // ----- (4) money_without_currency ignores shop format -----
    const shopEUR = { shop: { money_format: '€{{amount_with_comma_separator}}' } }
    const out4 = await engine.liquid.parseAndRender(
      '{{ 1999 | money_without_currency }}',
      shopEUR,
    )
    if (out4 !== '19.99') throw new Error(`(4) ${out4}`)
    console.log('PASS (4) money_without_currency:', out4)

    // ----- (5) EU comma-separator format end-to-end -----
    const out5 = await engine.liquid.parseAndRender('{{ 123456 | money }}', shopEUR)
    if (out5 !== '€1.234,56') throw new Error(`(5) ${out5}`)
    console.log('PASS (5) EU comma separator:', out5)

    // ----- (6) money_without_trailing_zeros on whole units -----
    const out6 = await engine.liquid.parseAndRender(
      '{{ 2000 | money_without_trailing_zeros }}',
    )
    if (out6 !== '$20') throw new Error(`(6a) ${out6}`)
    const out6b = await engine.liquid.parseAndRender(
      '{{ 1999 | money_without_trailing_zeros }}',
    )
    if (out6b !== '$19.99') throw new Error(`(6b) ${out6b}`)
    console.log('PASS (6) money_without_trailing_zeros:', out6, '/', out6b)

    // ----- (7) Negative amount → minus outside currency symbol -----
    const out7 = await engine.liquid.parseAndRender('{{ -500 | money }}')
    if (out7 !== '-$5.00') throw new Error(`(7) ${out7}`)
    console.log('PASS (7) negative money:', out7)

    // ----- (8) Object input via .amount -----
    const out8 = await engine.liquid.parseAndRender('{{ drop | money }}', {
      drop: { amount: 2500 },
    })
    if (out8 !== '$25.00') throw new Error(`(8) ${out8}`)
    console.log('PASS (8) object.amount input:', out8)

    // ----- (9) Numeric filters chained -----
    const out9 = await engine.liquid.parseAndRender(
      '{{ price | times: qty | minus: discount | at_least: 0 | money }}',
      { price: 1999, qty: 3, discount: 10000 },
    )
    // 1999 * 3 - 10000 = -4003 → clamp 0 → money → $0.00
    if (out9 !== '$0.00') throw new Error(`(9a) ${out9}`)

    const out9b = await engine.liquid.parseAndRender(
      '{{ price | times: qty | money }}',
      { price: 1999, qty: 3 },
    )
    // 1999 * 3 = 5997 → $59.97
    if (out9b !== '$59.97') throw new Error(`(9b) ${out9b}`)
    console.log('PASS (9) numeric chain + money:', out9, '/', out9b)

    // ----- (10) weight_with_unit -----
    const out10 = await engine.liquid.parseAndRender(
      '{{ 1500 | weight_with_unit: "kg" }}',
    )
    if (out10 !== '1.5 kg') throw new Error(`(10) ${out10}`)
    console.log('PASS (10) weight_with_unit:', out10)

    // ----- (11) Compose with string filters (append currency name) -----
    const out11 = await engine.liquid.parseAndRender(
      `{{ 1999 | money | append: " (tax incl.)" }}`,
    )
    if (out11 !== '$19.99 (tax incl.)') throw new Error(`(11) ${out11}`)
    console.log('PASS (11) money + string compose:', out11)

    // ----- (12) VND space-separator no-decimals pattern -----
    const shopVND = {
      shop: { money_format: '{{amount_no_decimals_with_space_separator}} ₫' },
    }
    const out12 = await engine.liquid.parseAndRender(
      '{{ 100000000 | money }}',
      shopVND,
    )
    // 100000000 cents ≈ 1,000,000 ₫ (rounding: 100000000 / 100 = 1000000)
    if (out12 !== '1 000 000 ₫') throw new Error(`(12) ${out12}`)
    console.log('PASS (12) VND no-decimals space:', out12)

    console.log('\nALL PASSED — Step 1.5 money + numeric filter set correctly wired')
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  console.error(err.stack)
  process.exit(1)
})
