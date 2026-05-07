/**
 * Smoke test — Decision #1 Step 1.12 JSON templates + `{% paginate %}`
 *
 * End-to-end test for:
 *
 *   1. `templates/<name>.json` resolution beats `.liquid` when both exist
 *   2. A full Shopify-shape JSON template with sections + blocks +
 *      wrapper + layout renders through the real pipeline
 *   3. Two sections of the same type under different ids keep their
 *      own `section.id` drops
 *   4. JSON `disabled: true` hides a section
 *   5. JSON `layout: false` skips the layout uniformly
 *   6. `{% paginate %}` full-path rebind works inside a JSON section
 *      (dotted path at depth 2 rebinds without mutating parent)
 *   7. `{% paginate %}` parts algorithm renders a navigation widget
 *      with ellipses around a mid-range current page
 *   8. Caller-supplied paginate option wires through renderPage
 *   9. Previous/next drops appear and disappear at page boundaries
 *  10. Stylesheet hoisting from a JSON section reaches content_for_header
 *  11. Missing section file inside a JSON template soft-fails to comment
 *  12. Fallback to classic `.liquid` template still works
 *  13. Realistic full product page (JSON + pagination of related products
 *      + hero section with schema defaults)
 *
 * Run:
 *   npx tsx scripts/smoke-liquid-step-1-12.ts
 */

import {
  createLiquidEngine,
  renderPage,
  type LoadResult,
  type LogicalPath,
  type TemplateLoader,
} from '../packages/core/src/modules/themes/engine/index.js'
import { MemoryI18nService } from '../packages/core/src/modules/i18n/index.js'

// ---------------------------------------------------------------------------
// In-memory loader
// ---------------------------------------------------------------------------

class MemoryLoader implements TemplateLoader {
  readonly name = 'memory-theme'
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
// Realistic mini theme
// ---------------------------------------------------------------------------

function fakeProducts(n: number): Array<{ id: number; title: string }> {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    title: `Product ${i + 1}`,
  }))
}

const files: Record<string, string> = {
  // ----- Layouts ----------------------------------------------------------
  'layout/theme.liquid':
    '<!doctype html><html><head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>',
  'layout/minimal.liquid': 'MIN[{{ content_for_layout }}]',

  // ----- JSON templates ---------------------------------------------------
  'templates/index.json': JSON.stringify({
    sections: {
      hero_top: { type: 'hero', settings: { heading: 'Welcome' } },
      // Second hero under a different id → section.id must differ
      hero_bottom: { type: 'hero', settings: { heading: 'See ya' } },
      hidden: { type: 'hero', settings: { heading: 'Invisible' }, disabled: true },
    },
    order: ['hero_top', 'hero_bottom', 'hidden'],
    wrapper: 'main',
  }),

  // JSON template WITH a .liquid sibling to prove priority
  'templates/both.json': JSON.stringify({
    sections: { main: { type: 'hero', settings: { heading: 'JSON-wins' } } },
    order: ['main'],
  }),
  'templates/both.liquid': '[SHOULD-NEVER-RENDER]',

  // JSON template with layout: false
  'templates/bare.json': JSON.stringify({
    sections: { main: { type: 'hero', settings: { heading: 'Bare' } } },
    order: ['main'],
    layout: false,
  }),

  // JSON template with explicit layout override
  'templates/alt.json': JSON.stringify({
    sections: { main: { type: 'hero', settings: { heading: 'AltLayout' } } },
    order: ['main'],
    layout: 'minimal',
  }),

  // JSON template with a missing section file
  'templates/broken.json': JSON.stringify({
    sections: { main: { type: 'ghost-section' } },
    order: ['main'],
  }),

  // Classic .liquid template (prove fallback still works)
  'templates/classic.liquid': '<classic>{{ page_title }}</classic>',

  // JSON template with paginated listing section
  'templates/collection.json': JSON.stringify({
    sections: {
      main: {
        type: 'product-list',
        settings: { per_page: 3, heading: 'All Products' },
      },
    },
    order: ['main'],
  }),

  // Realistic product JSON template combining hero + paginated related
  'templates/product.json': JSON.stringify({
    sections: {
      header: { type: 'hero', settings: { heading: 'Big Product' } },
      main_product: { type: 'product-detail' },
      related: { type: 'product-list', settings: { per_page: 2, heading: 'You may also like' } },
    },
    order: ['header', 'main_product', 'related'],
  }),

  // ----- Sections ---------------------------------------------------------
  'sections/hero.liquid': [
    '<section id="{{ section.id }}" class="hero">',
    '<h1>{{ section.settings.heading }}</h1>',
    '</section>',
    '{% schema %}',
    JSON.stringify({
      name: 'Hero',
      settings: [
        { id: 'heading', type: 'text', default: 'Default Heading' },
      ],
    }),
    '{% endschema %}',
  ].join(''),

  'sections/product-detail.liquid':
    '<article class="pd">{{ product.title }}</article>',

  // The real star of Step 1.12: a section that uses {% paginate %}
  // with a depth-2 dotted path. Proves the full-path rebind works
  // inside a JSON template section.
  'sections/product-list.liquid': [
    '<div class="plist" data-section="{{ section.id }}">',
    '<h2>{{ section.settings.heading }}</h2>',
    '{% paginate collection.products by section.settings.per_page %}',
    '<ul>',
    '{% for p in collection.products %}',
    '<li data-id="{{ p.id }}">{{ p.title }}</li>',
    '{% endfor %}',
    '</ul>',
    '<nav class="pagination">',
    '{% if paginate.previous %}<a class="prev" href="{{ paginate.previous.url }}">{{ paginate.previous.title }}</a>{% endif %}',
    '{% for part in paginate.parts %}',
    '{% if part.is_link %}<a href="{{ part.url }}">{{ part.title }}</a>{% else %}<span class="current">{{ part.title }}</span>{% endif %}',
    '{% endfor %}',
    '{% if paginate.next %}<a class="next" href="{{ paginate.next.url }}">{{ paginate.next.title }}</a>{% endif %}',
    '</nav>',
    '{% endpaginate %}',
    '{% stylesheet %}.plist { padding: 1rem; }{% endstylesheet %}',
    '</div>',
    '{% schema %}',
    JSON.stringify({
      name: 'Product List',
      settings: [
        { id: 'heading', type: 'text', default: 'Products' },
        { id: 'per_page', type: 'number', default: 12 },
      ],
    }),
    '{% endschema %}',
  ].join(''),
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const engine = createLiquidEngine({
    loader: new MemoryLoader(files),
    i18n: new MemoryI18nService(),
  })

  // ----- (1) JSON priority over .liquid ----------------------------------
  {
    const { html } = await renderPage(engine, { template: 'both' })
    if (html.includes('SHOULD-NEVER-RENDER'))
      throw new Error('(1) .liquid leaked through — JSON must win')
    if (!html.includes('<h1>JSON-wins</h1>'))
      throw new Error(`(1) JSON content missing: ${html}`)
    console.log('PASS (1) .json beats .liquid when both exist')
  }

  // ----- (2) Full JSON template with sections + wrapper ------------------
  {
    const { html } = await renderPage(engine, { template: 'index' })
    if (!html.includes('<main>'))
      throw new Error(`(2) wrapper <main> missing: ${html}`)
    if (!html.includes('</main>'))
      throw new Error(`(2) wrapper </main> missing: ${html}`)
    if (!html.includes('<h1>Welcome</h1>'))
      throw new Error('(2) top hero heading missing')
    if (!html.includes('<h1>See ya</h1>'))
      throw new Error('(2) bottom hero heading missing')
    console.log('PASS (2) JSON template with wrapper + multiple sections')
  }

  // ----- (3) section.id comes from JSON key, not filename ----------------
  {
    const { html } = await renderPage(engine, { template: 'index' })
    if (!html.includes('id="hero_top"'))
      throw new Error('(3) hero_top id missing')
    if (!html.includes('id="hero_bottom"'))
      throw new Error('(3) hero_bottom id missing')
    console.log('PASS (3) same section type under different ids gets distinct section.id')
  }

  // ----- (4) disabled: true hides a section ------------------------------
  {
    const { html } = await renderPage(engine, { template: 'index' })
    if (html.includes('Invisible'))
      throw new Error('(4) disabled section rendered — should be hidden')
    console.log('PASS (4) disabled JSON section is skipped')
  }

  // ----- (5) layout: false in JSON skips layout --------------------------
  {
    const { html, layoutUsed } = await renderPage(engine, { template: 'bare' })
    if (layoutUsed !== null)
      throw new Error(`(5) layout should be null, got ${layoutUsed}`)
    if (html.includes('<!doctype html>'))
      throw new Error('(5) default layout leaked through layout:false')
    if (!html.includes('<h1>Bare</h1>'))
      throw new Error('(5) bare hero content missing')
    console.log('PASS (5) JSON "layout: false" skips the layout')
  }

  // ----- (6) Paginate full-path rebind inside a JSON section -------------
  {
    const { html } = await renderPage(engine, {
      template: 'collection',
      extraGlobals: {
        collection: {
          title: 'All Products',
          products: fakeProducts(10),
        },
      },
      paginate: { 'collection.products': { page: 2 } },
      request: { path: '/collections/all' },
    })
    // Page 2, per_page 3 → products 4, 5, 6
    if (!html.includes('data-id="4"') || !html.includes('data-id="5"') || !html.includes('data-id="6"'))
      throw new Error(`(6) page-2 slice wrong: ${html.substring(0, 400)}`)
    // Should NOT contain page-1 items on the slice
    if (html.includes('data-id="1"') || html.includes('data-id="2"') || html.includes('data-id="3"'))
      throw new Error('(6) page-1 products leaked into page-2 output')
    console.log('PASS (6) {% paginate %} full-path rebind works inside JSON section')
  }

  // ----- (7) Pagination widget parts --------------------------------------
  {
    const { html } = await renderPage(engine, {
      template: 'collection',
      extraGlobals: {
        collection: { title: 'All', products: fakeProducts(10) },
      },
      paginate: { 'collection.products': { page: 2 } },
      request: { path: '/collections/all' },
    })
    // 10 products, per_page 3 → 4 pages; current 2, window ±2 → shows 1..4
    // Every page number should appear
    for (const n of [1, 2, 3, 4]) {
      if (!html.includes(`>${n}<`))
        throw new Error(`(7) page number ${n} missing from widget`)
    }
    // Current page 2 is a span, not an anchor
    if (!html.includes('<span class="current">2</span>'))
      throw new Error('(7) current-page <span> missing for page 2')
    // Each non-current link should use the base path + query
    if (!html.includes('href="/collections/all?page=1"'))
      throw new Error('(7) page=1 link missing')
    if (!html.includes('href="/collections/all?page=3"'))
      throw new Error('(7) page=3 link missing')
    console.log('PASS (7) pagination parts widget renders with proper URLs')
  }

  // ----- (8) Previous/next boundary behavior -----------------------------
  {
    const p1 = await renderPage(engine, {
      template: 'collection',
      extraGlobals: { collection: { products: fakeProducts(10) } },
      paginate: { 'collection.products': { page: 1 } },
      request: { path: '/col' },
    })
    if (p1.html.includes('class="prev"'))
      throw new Error('(8) previous rendered on page 1')
    if (!p1.html.includes('class="next"'))
      throw new Error('(8) next missing on page 1')

    // Last page (4): no next
    const pLast = await renderPage(engine, {
      template: 'collection',
      extraGlobals: { collection: { products: fakeProducts(10) } },
      paginate: { 'collection.products': { page: 4 } },
      request: { path: '/col' },
    })
    if (pLast.html.includes('class="next"'))
      throw new Error('(8) next rendered on last page')
    if (!pLast.html.includes('class="prev"'))
      throw new Error('(8) previous missing on last page')
    console.log('PASS (8) previous/next drops obey page boundaries')
  }

  // ----- (9) Stylesheet hoisting from JSON section -----------------------
  {
    const { html } = await renderPage(engine, {
      template: 'collection',
      extraGlobals: { collection: { products: fakeProducts(5) } },
    })
    if (!html.includes('<style data-gbox-section>.plist { padding: 1rem; }</style>'))
      throw new Error(`(9) hoisted stylesheet missing in <head>`)
    // And the page body should still have the content
    if (!html.includes('data-section="main"'))
      throw new Error('(9) section body missing')
    console.log('PASS (9) stylesheet from JSON-section hoists into content_for_header')
  }

  // ----- (10) Missing section in JSON → placeholder comment ---------------
  {
    const { html } = await renderPage(engine, { template: 'broken' })
    if (!html.includes("<!-- Liquid error: section 'ghost-section' not found -->"))
      throw new Error(`(10) missing section didn't soft-fail: ${html}`)
    console.log('PASS (10) missing section in JSON template soft-fails')
  }

  // ----- (11) Fallback to .liquid still works ----------------------------
  {
    const { html } = await renderPage(engine, {
      template: 'classic',
      extraGlobals: { page_title: 'Hello' },
    })
    if (!html.includes('<classic>Hello</classic>'))
      throw new Error(`(11) classic .liquid template failed: ${html}`)
    console.log('PASS (11) classic .liquid template fallback still works')
  }

  // ----- (12) JSON layout override ---------------------------------------
  {
    const { html, layoutUsed } = await renderPage(engine, { template: 'alt' })
    if (layoutUsed !== 'minimal')
      throw new Error(`(12) layoutUsed should be "minimal", got ${layoutUsed}`)
    if (!html.startsWith('MIN['))
      throw new Error(`(12) minimal layout not applied: ${html}`)
    console.log('PASS (12) JSON "layout" field routes to alternate layout file')
  }

  // ----- (13) Realistic product page: hero + paginated related -----------
  {
    const { html, layoutUsed, meta, renderMs } = await renderPage(engine, {
      template: 'product',
      extraGlobals: {
        product: { title: 'Gbox Camera Pro' },
        collection: { products: fakeProducts(7) },
      },
      paginate: { 'collection.products': { page: 1 } },
      request: { path: '/products/gbox-camera-pro' },
    })
    if (layoutUsed !== 'theme')
      throw new Error(`(13) expected default 'theme' layout, got ${layoutUsed}`)
    // hero with schema-default heading override
    if (!html.includes('<h1>Big Product</h1>'))
      throw new Error('(13) hero heading missing')
    // product detail article
    if (!html.includes('<article class="pd">Gbox Camera Pro</article>'))
      throw new Error('(13) product-detail missing')
    // related products: page 1, per_page 2 → products 1, 2
    if (!html.includes('data-id="1"') || !html.includes('data-id="2"'))
      throw new Error('(13) related products page 1 slice wrong')
    if (html.includes('data-id="3"'))
      throw new Error('(13) related products leaked into page-1 output')
    // hoisted stylesheet from the product-list section
    if (!meta.stylesheet || meta.stylesheet.length === 0)
      throw new Error('(13) stylesheet register empty')
    if (!html.includes('<style data-gbox-section>.plist { padding: 1rem; }</style>'))
      throw new Error('(13) hoisted stylesheet missing from rendered layout')
    if (renderMs < 0 || renderMs > 5000)
      throw new Error(`(13) renderMs suspect: ${renderMs}`)
    console.log(
      `PASS (13) realistic product page (${renderMs}ms, ${html.length} bytes)`,
    )
  }

  console.log('\nALL PASSED — Step 1.12 JSON templates + paginate is the real deal')
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  console.error(err.stack)
  process.exit(1)
})
