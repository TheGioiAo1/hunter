/**
 * Smoke test — Decision #1 Step 1.4 LiquidJS engine + filter set 1.
 *
 * Verifies end-to-end that:
 *   1. createLiquidEngine() produces a working Liquid instance
 *   2. The TemplateLoader adapter serves files to {% render %}
 *   3. String filters (upcase, truncate, handle, escape, pluralize)
 *   4. URL filters (url_encode, link_to, within, asset_url stubs)
 *   5. The `t` i18n filter with three-tier fallback + interpolation
 *   6. strictFilters: true catches typos
 *   7. strictVariables: false renders missing vars as empty
 *   8. No auto-escape (Shopify-compatible raw output)
 *
 * Run:
 *   npx tsx scripts/smoke-liquid-step-1-4.ts
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createLiquidEngine,
  StaticLoader,
} from '../packages/core/src/modules/themes/engine/index.js'
import { MemoryI18nService } from '../packages/core/src/modules/i18n/index.js'

async function main() {
  // ----- Prepare a fake theme tree in tmp -----
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gbox-liquid-smoke-'))
  try {
    await fs.mkdir(path.join(tmp, 'snippets'), { recursive: true })
    await fs.writeFile(
      path.join(tmp, 'snippets/card.liquid'),
      '<div class="card"><h3>{{ title | escape }}</h3><p>{{ body | truncate: 20 }}</p></div>',
      'utf8',
    )

    // ----- Build engine -----
    const i18n = new MemoryI18nService({
      shop_smoke: {
        en: {
          'cart.title': 'Cart',
          'cart.line_count': 'You have {{ count }} items',
          'cart.checkout': 'Checkout',
        },
        vi: {
          'cart.title': 'Giỏ hàng',
        },
      },
    })
    const loader = new StaticLoader(tmp, { label: 'smoke' })
    const engine = createLiquidEngine({ loader, i18n })

    // ----- (1) Basic render + string filters -----
    const out1 = await engine.liquid.parseAndRender(
      'Hello {{ name | upcase }}! {{ items | size }} items.',
      { name: 'thai', items: ['a', 'b', 'c'] },
    )
    if (out1 !== 'Hello THAI! 3 items.') throw new Error(`(1) ${out1}`)
    console.log('PASS (1) upcase + size:', out1)

    // ----- (2) truncate, handle, pluralize -----
    const out2 = await engine.liquid.parseAndRender(
      '{{ "one two three four five" | truncate: 13 }} — {{ "Pro T-Shirt!" | handle }} — {{ n | pluralize: "item", "items" }}',
      { n: 1 },
    )
    if (out2 !== 'one two th... — pro-t-shirt — item') throw new Error(`(2) ${out2}`)
    console.log('PASS (2) truncate+handle+pluralize:', out2)

    // ----- (3) URL filters -----
    const out3 = await engine.liquid.parseAndRender(
      '{{ "hello world" | url_encode }} / {{ product | within: collection }} / {{ "theme.css" | asset_url }}',
      {
        product: { slug: 'cool-shirt' },
        collection: { slug: 'summer' },
      },
    )
    if (out3 !== 'hello%20world / /collections/summer/products/cool-shirt / /assets/theme.css') {
      throw new Error(`(3) ${out3}`)
    }
    console.log('PASS (3) url filters:', out3)

    // ----- (4) link_to with escape -----
    const out4 = await engine.liquid.parseAndRender(
      `{{ "Shop Now" | link_to: "/?a=1&b=2" }}`,
    )
    if (out4 !== '<a href="/?a=1&amp;b=2">Shop Now</a>') throw new Error(`(4) ${out4}`)
    console.log('PASS (4) link_to with escape:', out4)

    // ----- (5) Shopify-compatible no-auto-escape -----
    const out5 = await engine.liquid.parseAndRender('{{ html }}', { html: '<b>hi</b>' })
    if (out5 !== '<b>hi</b>') throw new Error(`(5) ${out5}`)
    console.log('PASS (5) no auto-escape (Shopify-compatible):', out5)

    // ----- (6) `t` filter — Tier 1 hit -----
    const globals = {
      shop: { id: 'shop_smoke', default_locale: 'en' },
      request: { locale: 'vi' },
    }
    const out6 = await engine.liquid.parseAndRender(`{{ 'cart.title' | t }}`, globals)
    if (out6 !== 'Giỏ hàng') throw new Error(`(6) ${out6}`)
    console.log('PASS (6) t filter Tier 1 (vi):', out6)

    // ----- (7) `t` filter — Tier 2 (vi missing, en fallback) -----
    const out7 = await engine.liquid.parseAndRender(`{{ 'cart.checkout' | t }}`, globals)
    if (out7 !== 'Checkout') throw new Error(`(7) ${out7}`)
    console.log('PASS (7) t filter Tier 2 (vi → en):', out7)

    // ----- (8) `t` filter — interpolation via named args -----
    const globalsEn = {
      shop: { id: 'shop_smoke', default_locale: 'en' },
      request: { locale: 'en' },
    }
    const out8 = await engine.liquid.parseAndRender(
      `{{ 'cart.line_count' | t: count: 5 }}`,
      globalsEn,
    )
    if (out8 !== 'You have 5 items') throw new Error(`(8) ${out8}`)
    console.log('PASS (8) t filter interpolation:', out8)

    // ----- (9) {% render %} via loader -----
    const out9 = await engine.liquid.parseAndRender(
      `{% render 'card', title: 'My Product', body: 'A really long description that definitely exceeds the truncate limit' %}`,
    )
    // truncate: 20 keeps (20 - 3) = 17 chars of body then appends '...'.
    // 'A really long description...' → 'A really long des' + '...'.
    if (!out9.includes('<h3>My Product</h3>') || !out9.includes('A really long des...')) {
      throw new Error(`(9) ${out9}`)
    }
    console.log('PASS (9) {% render %} via loader:', out9)

    // ----- (10) strictFilters: unknown filter throws -----
    let threw = false
    try {
      await engine.liquid.parseAndRender('{{ x | nopeFilter }}', { x: 'v' })
    } catch {
      threw = true
    }
    if (!threw) throw new Error('(10) expected strictFilters to throw')
    console.log('PASS (10) strictFilters catches typos')

    // ----- (11) strictVariables: false -----
    const out11 = await engine.liquid.parseAndRender('[{{ missing_var }}]')
    if (out11 !== '[]') throw new Error(`(11) ${out11}`)
    console.log('PASS (11) missing var → empty string')

    console.log('\nALL PASSED — Step 1.4 LiquidJS engine + filter set 1 correctly wired')
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  console.error(err.stack)
  process.exit(1)
})
