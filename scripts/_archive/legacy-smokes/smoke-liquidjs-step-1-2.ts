/**
 * Smoke test — Decision #1 Step 1.2 liquidjs dependency install.
 *
 * Verifies:
 *   1. `liquidjs` is importable as an ESM module under the tsx runner.
 *   2. TypeScript type imports from `liquidjs` resolve at compile time
 *      (the `type` modifier is just a hint here — the real check is that
 *      tsx parses this file without a syntax error).
 *   3. The extracted `ShopData` type from Step 1.1's `shopify-types.ts`
 *      still imports cleanly.
 *   4. A basic parse+render cycle works with strict filters enabled —
 *      this is the same config the real engine will use in Step 1.4.
 *
 * This file is a one-off verification and is not part of the engine
 * itself. It can be safely deleted after Decision #1 is complete, but
 * we leave it in `scripts/` as a reproducible smoke test for anyone
 * wondering whether the liquidjs dep is actually wired up.
 *
 * Run:
 *   npx tsx scripts/smoke-liquidjs-step-1-2.ts
 */

import { Liquid, type TagToken as _TagToken, type TopLevelToken as _TopLevelToken } from 'liquidjs'
import type { ShopData } from '../packages/core/src/modules/themes/shopify-types.js'

// Reference the unused type imports so tsconfig `noUnusedLocals` would not
// complain. Pure compile-time assertion.
type _AssertTypesImport = _TagToken | _TopLevelToken

async function main() {
  const liquid = new Liquid({
    extname: '.liquid',
    strictFilters: true,
    strictVariables: false,
    cache: true,
  })

  // Shopify-style drop: use the real ShopData type from shopify-types.ts.
  const shop: ShopData = {
    id: 's_smoke_1_2',
    name: 'Gbox Smoke Shop',
    slug: 'gbox-smoke',
    email: 'smoke@gbox.co',
    domain: null,
    custom_domain: null,
    currency: 'USD',
    logo_url: null,
  }

  // Parse + render with strict filter lookup enabled.
  const html = await liquid.parseAndRender(
    `Welcome to {{ shop.name }} ({{ shop.currency | upcase }}) — {{ items | size }} items`,
    { shop, items: ['a', 'b', 'c'] },
  )

  console.log('PASS liquidjs parse/render:', html)

  // Test a condition tag — mirrors Dawn's {% if product.available %} pattern.
  const condHtml = await liquid.parseAndRender(
    `{% if shop.currency == "USD" %}USD store{% else %}Other{% endif %}`,
    { shop },
  )
  console.log('PASS liquidjs {% if %} tag:', condHtml)

  // Test a for loop — mirrors Dawn's section iteration pattern.
  const loopHtml = await liquid.parseAndRender(
    `{% for item in items %}{{ forloop.index }}:{{ item }} {% endfor %}`,
    { items: ['alpha', 'beta', 'gamma'] },
  )
  console.log('PASS liquidjs {% for %} tag:', loopHtml.trim())

  console.log('\nALL PASSED — Step 1.2 liquidjs dep is correctly installed and importable')
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  console.error(err.stack)
  process.exit(1)
})
