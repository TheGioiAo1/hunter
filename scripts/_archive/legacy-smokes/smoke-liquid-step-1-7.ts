/**
 * Smoke test — Decision #1 Step 1.7 Shopify tag set 1.
 *
 * Exercises the full tag suite registered by `createLiquidEngine`:
 *
 *   1. `{% render 'snippet' %}`            — stock LiquidJS (Shopify-compatible)
 *   2. `{% render 'snippet', key: 'v' %}`  — hash args
 *   3. `{% render 'snippet' with obj %}`   — Shopify `with` syntax
 *   4. `{% render 'snippet' for list as item %}` — Shopify `for` syntax
 *   5. `{% include 'snippet' %}`           — legacy Shopify include (parent scope)
 *   6. `{% section 'name' %}`              — Gbox custom tag
 *   7. Sections can `{% render %}` snippets
 *   8. `{% schema %}` capture
 *   9. `{% stylesheet %}` + `{% javascript %}` capture and accumulate
 *  10. `{% layout 'theme' %}` metadata record
 *  11. `{% layout none %}` metadata record
 *  12. Full theme-like template with layout + section + snippet + schema
 *
 * Uses the in-memory MemoryLoader so this runs on any dev box without
 * a DB or filesystem dependency.
 *
 * Run:
 *   npx tsx scripts/smoke-liquid-step-1-7.ts
 */

import { Context } from 'liquidjs'
import {
  createLiquidEngine,
  GBOX_LAYOUT_REGISTER_KEY,
  GBOX_LAYOUT_NONE,
  GBOX_META_REGISTER_KEY,
  type GboxLayoutRegister,
  type GboxMetaRegister,
  type LoadResult,
  type LogicalPath,
  type TemplateLoader,
} from '../packages/core/src/modules/themes/engine/index.js'
import { MemoryI18nService } from '../packages/core/src/modules/i18n/index.js'

// ---------------------------------------------------------------------------
// In-memory loader
// ---------------------------------------------------------------------------

class MemoryLoader implements TemplateLoader {
  readonly name = 'memory'
  constructor(private readonly files: Record<string, string>) {}
  async load(p: LogicalPath): Promise<string | null> {
    return this.files[p] ?? null
  }
  async loadWithMeta(p: LogicalPath): Promise<LoadResult | null> {
    const src = this.files[p]
    return src === undefined ? null : { source: src }
  }
  async exists(p: LogicalPath): Promise<boolean> {
    return p in this.files
  }
  async list(prefix = ''): Promise<LogicalPath[]> {
    return Object.keys(this.files).filter((k) => k.startsWith(prefix))
  }
}

// ---------------------------------------------------------------------------
// Fixture — a mini Shopify-ish theme
// ---------------------------------------------------------------------------

const files: Record<string, string> = {
  // Snippets (for {% render %} / {% include %})
  'snippets/greeting.liquid': 'Hi, {{ name | upcase }}!',
  'snippets/card.liquid':
    '<div class="card">{{ card.title }} — {{ card.price }}</div>',
  'snippets/badge.liquid': '[{{ label }}]',

  // Sections
  'sections/header.liquid':
    '<header id="{{ section.id }}">{{ shop.name }}{% render "badge", label: "new" %}</header>',
  'sections/product.liquid': [
    '<div class="product">',
    '  <h2>{{ product.title }}</h2>',
    "  {% render 'card', card: product %}",
    '</div>',
    '{% schema %}',
    '{',
    '  "name": "Product",',
    '  "settings": [',
    '    { "type": "text", "id": "heading", "default": "Default heading" }',
    '  ]',
    '}',
    '{% endschema %}',
    '{% stylesheet %}',
    '.product { padding: 8px; }',
    '{% endstylesheet %}',
    '{% javascript %}',
    'console.log("product mounted");',
    '{% endjavascript %}',
  ].join('\n'),
}

function makeEngine() {
  return createLiquidEngine({
    loader: new MemoryLoader(files),
    i18n: new MemoryI18nService(),
  })
}

// ---------------------------------------------------------------------------
// Peek helper — reads both the output and a fresh ctx's registers.
// ---------------------------------------------------------------------------

async function renderWithCtx(
  tpl: string,
  scope: Record<string, unknown> = {},
): Promise<{
  out: string
  layout: GboxLayoutRegister
  meta: GboxMetaRegister
}> {
  const engine = makeEngine()
  const ctx = new Context(scope, engine.liquid.options)
  const templates = engine.liquid.parse(tpl)
  const out = await engine.liquid.render(templates, ctx)
  const layout = ctx.getRegister(GBOX_LAYOUT_REGISTER_KEY) as GboxLayoutRegister
  const meta = ctx.getRegister(GBOX_META_REGISTER_KEY) as GboxMetaRegister
  return { out, layout, meta }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const engine = makeEngine()

  // ----- (1) Stock render ---------------------------------------------------
  {
    const out = await engine.liquid.parseAndRender(
      "{% render 'greeting', name: 'thai' %}",
    )
    if (out !== 'Hi, THAI!') throw new Error(`(1) ${out}`)
    console.log('PASS (1) {% render %} with hash args:', out)
  }

  // ----- (2) render with obj --------------------------------------------
  {
    const out = await engine.liquid.parseAndRender(
      "{% render 'card' with p as card %}",
      { p: { title: 'T-Shirt', price: '$10' } },
    )
    if (out !== '<div class="card">T-Shirt — $10</div>')
      throw new Error(`(2) ${out}`)
    console.log('PASS (2) {% render %} with `with...as` syntax')
  }

  // ----- (3) render for collection -----------------------------------------
  {
    const out = await engine.liquid.parseAndRender(
      "{% render 'badge' for labels as label %}",
      { labels: ['a', 'b', 'c'] },
    )
    if (out !== '[a][b][c]') throw new Error(`(3) ${out}`)
    console.log('PASS (3) {% render %} for collection:', out)
  }

  // ----- (4) include (legacy Shopify include) ------------------------------
  {
    // Legacy include uses parent scope; `name` comes from the caller's
    // environment directly.
    const out = await engine.liquid.parseAndRender("{% include 'greeting' %}", {
      name: 'alice',
    })
    if (out !== 'Hi, ALICE!') throw new Error(`(4) ${out}`)
    console.log('PASS (4) {% include %} with parent scope:', out)
  }

  // ----- (5) section tag ---------------------------------------------------
  {
    const out = await engine.liquid.parseAndRender("{% section 'header' %}", {
      shop: { name: 'Gbox' },
    })
    if (out !== '<header id="header">Gbox[new]</header>')
      throw new Error(`(5) ${out}`)
    console.log('PASS (5) {% section %} with nested render + drop:', out)
  }

  // ----- (6) schema captured -----------------------------------------------
  {
    const { meta } = await renderWithCtx(
      "{% section 'product' %}",
      { product: { title: 'Widget' } },
    )
    if (!meta.schema || !meta.schema.includes('"name": "Product"')) {
      throw new Error(`(6) schema not captured: ${meta.schema}`)
    }
    // Raw capture preserves whitespace — the body includes the
    // newlines between `{% stylesheet %}` and the CSS content.
    if (
      !meta.stylesheet ||
      !meta.stylesheet[0].includes('.product { padding: 8px; }')
    ) {
      throw new Error(`(6) stylesheet not captured: ${JSON.stringify(meta.stylesheet)}`)
    }
    if (
      !meta.javascript ||
      !meta.javascript[0].includes('console.log("product mounted");')
    ) {
      throw new Error(`(6) javascript not captured: ${JSON.stringify(meta.javascript)}`)
    }
    console.log('PASS (6) {% schema %} + {% stylesheet %} + {% javascript %} captured')
  }

  // ----- (7) stylesheet + javascript accumulate across sections ------------
  {
    // Two section invocations — stylesheet/javascript arrays should grow.
    const { meta } = await renderWithCtx(
      "{% section 'product' %}{% section 'product' %}",
      { product: { title: 'Widget' } },
    )
    if (!meta.stylesheet || meta.stylesheet.length !== 2) {
      throw new Error(`(7) stylesheet length: ${meta.stylesheet?.length}`)
    }
    if (!meta.javascript || meta.javascript.length !== 2) {
      throw new Error(`(7) javascript length: ${meta.javascript?.length}`)
    }
    console.log('PASS (7) stylesheet/javascript accumulate across sections')
  }

  // ----- (8) layout 'theme' ------------------------------------------------
  {
    const { out, layout } = await renderWithCtx("{% layout 'theme' %}body")
    if (out !== 'body') throw new Error(`(8) ${out}`)
    if (layout.name !== 'theme' || layout.seen !== true) {
      throw new Error(`(8) layout register: ${JSON.stringify(layout)}`)
    }
    console.log('PASS (8) {% layout %} records name=theme, seen=true')
  }

  // ----- (9) layout none ---------------------------------------------------
  {
    const { layout } = await renderWithCtx('{% layout none %}')
    if (layout.name !== GBOX_LAYOUT_NONE || layout.seen !== true) {
      throw new Error(`(9) layout register: ${JSON.stringify(layout)}`)
    }
    console.log('PASS (9) {% layout none %} records name=null')
  }

  // ----- (10) no layout tag -> seen undefined -------------------------------
  {
    const { layout } = await renderWithCtx('hello')
    if (layout.seen !== undefined) {
      throw new Error(`(10) layout.seen should be undefined: ${layout.seen}`)
    }
    console.log('PASS (10) no {% layout %} tag → seen undefined (pipeline default)')
  }

  // ----- (11) end-to-end theme-like render ---------------------------------
  {
    const { out, layout, meta } = await renderWithCtx(
      [
        "{% layout 'theme' %}",
        '<main>',
        "  {% section 'header' %}",
        "  {% section 'product' %}",
        '</main>',
      ].join('\n'),
      {
        shop: { name: 'Gbox' },
        product: { title: 'Widget Pro' },
      },
    )
    if (!out.includes('<header id="header">Gbox')) {
      throw new Error(`(11) missing header: ${out}`)
    }
    if (!out.includes('<h2>Widget Pro</h2>')) {
      throw new Error(`(11) missing product title: ${out}`)
    }
    if (!out.includes('<div class="card">Widget Pro')) {
      throw new Error(`(11) missing nested card render: ${out}`)
    }
    if (layout.name !== 'theme') {
      throw new Error(`(11) layout name: ${layout.name}`)
    }
    if (!meta.schema || !meta.schema.includes('"name": "Product"')) {
      throw new Error(`(11) schema not captured`)
    }
    console.log('PASS (11) end-to-end theme render captured layout + meta')
  }

  // ----- (12) parse-time errors --------------------------------------------
  {
    let threw = false
    try {
      engine.liquid.parse('{% section %}')
    } catch {
      threw = true
    }
    if (!threw) throw new Error('(12) empty section should throw at parse')

    threw = false
    try {
      engine.liquid.parse('{% layout foo %}')
    } catch {
      threw = true
    }
    if (!threw) throw new Error('(12) variable layout should throw at parse')

    threw = false
    try {
      engine.liquid.parse('{% schema %}{ "x": 1 }')
    } catch {
      threw = true
    }
    if (!threw) throw new Error('(12) unclosed schema should throw at parse')

    console.log('PASS (12) parse-time errors fire on malformed tags')
  }

  console.log('\nALL PASSED — Step 1.7 Shopify tag set 1 correctly wired')
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  console.error(err.stack)
  process.exit(1)
})
