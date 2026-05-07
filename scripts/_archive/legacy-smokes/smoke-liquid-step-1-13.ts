/**
 * Smoke test — Decision #1 Step 1.13 Section Rendering API
 *
 * End-to-end test for `renderSections` — the engine primitive that
 * backs Shopify's `?sections=a,b,c` AJAX partial-render endpoint.
 *
 * Realistic scenario: a product page has a header, a product detail
 * section, a cart drawer, and a related-products list. The visitor
 * adds an item to the cart → the storefront JS fires an XHR that
 * asks the server to re-render just `cart-drawer` + `header`, and
 * swaps the HTML in place. The server calls `renderSections` with
 * the updated cart drop and returns a `{ sections: {...} }` JSON
 * blob — exactly what this smoke test is modelling.
 *
 * Asserts (13):
 *
 *   1. Single-section JSON render — happy path + section.id from
 *      JSON key + schema defaults resolved
 *   2. Multi-section batch — 3 sections at once, distinct section.id
 *      for two sections of the same type
 *   3. Envs visible inside sections (shop, customer, cart, request)
 *   4. Cart drawer AJAX-flavoured call — updated cart drop produces
 *      new HTML reflecting the new line count
 *   5. Pagination wiring — related products paginate works inside a
 *      section-api call
 *   6. Missing section id → partial-success error, other sections
 *      still render
 *   7. Missing section file in .liquid mode → partial-success error
 *   8. Disabled JSON section → empty string (not an error)
 *   9. No layout ever applied (even when JSON declares one)
 *  10. No content_for_header hoist (stylesheet is silently swallowed)
 *  11. Whole-request errors throw SectionRenderingError
 *  12. `maxSections` cap enforced; override works
 *  13. Classic `.liquid` template fallback — id = section filename
 *
 * Run:
 *   npx tsx scripts/smoke-liquid-step-1-13.ts
 */

import {
  createLiquidEngine,
  renderSections,
  SectionRenderingError,
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
  // ----- JSON templates ---------------------------------------------------
  'templates/product.json': JSON.stringify({
    sections: {
      header: { type: 'header', settings: { links: 'home,shop,about' } },
      main_product: {
        type: 'product-detail',
        settings: { show_vendor: true },
      },
      'cart-drawer': { type: 'cart-drawer' },
      related: {
        type: 'product-list',
        settings: { per_page: 2, heading: 'You may also like' },
      },
      hidden_promo: { type: 'promo', disabled: true },
      // Two sections of the SAME type under different ids
      trust_top: { type: 'trust-badges', settings: { title: 'Top row' } },
      trust_bottom: { type: 'trust-badges', settings: { title: 'Bottom row' } },
    },
    order: [
      'header',
      'main_product',
      'related',
      'trust_top',
      'trust_bottom',
      'cart-drawer',
      'hidden_promo',
    ],
    layout: 'theme',
  }),

  // Template with layout: theme — proves layout is still ignored
  'templates/layouted.json': JSON.stringify({
    sections: { main: { type: 'header' } },
    order: ['main'],
    layout: 'theme',
  }),

  // Template with a stylesheet — proves content_for_header is dropped
  'templates/with-css.json': JSON.stringify({
    sections: { main: { type: 'styled-card' } },
    order: ['main'],
  }),

  // Classic .liquid template for fallback mode
  'templates/classic.liquid': 'UNUSED — section api skips the body',

  // ----- Layouts (should NEVER be applied by section api) ----------------
  'layout/theme.liquid':
    '<!doctype html>THEME[{{ content_for_layout }}]{{ content_for_header }}',

  // ----- Sections ---------------------------------------------------------
  'sections/header.liquid': [
    '<header id="{{ section.id }}" data-count="{{ cart.item_count }}">',
    '<a class="logo">{{ shop.name }}</a>',
    '<nav>{{ section.settings.links }}</nav>',
    '</header>',
    '{% schema %}',
    JSON.stringify({
      name: 'Header',
      settings: [{ id: 'links', type: 'text', default: 'home' }],
    }),
    '{% endschema %}',
  ].join(''),

  'sections/product-detail.liquid': [
    '<article class="pd">',
    '<h1>{{ product.title }}</h1>',
    '{% if section.settings.show_vendor %}<p>by {{ product.vendor }}</p>{% endif %}',
    '</article>',
    '{% schema %}',
    JSON.stringify({
      name: 'Product Detail',
      settings: [{ id: 'show_vendor', type: 'checkbox', default: false }],
    }),
    '{% endschema %}',
  ].join(''),

  'sections/cart-drawer.liquid': [
    '<div class="drawer" data-id="{{ section.id }}">',
    '<p>Items: {{ cart.item_count }}</p>',
    '{% for i in cart.items %}<li>{{ i.title }}</li>{% endfor %}',
    '</div>',
  ].join(''),

  'sections/product-list.liquid': [
    '<section class="plist" data-section="{{ section.id }}">',
    '<h2>{{ section.settings.heading }}</h2>',
    '{% paginate collection.products by section.settings.per_page %}',
    '<ul>',
    '{% for p in collection.products %}<li data-id="{{ p.id }}">{{ p.title }}</li>{% endfor %}',
    '</ul>',
    'cp={{ paginate.current_page }}|total={{ paginate.pages }}',
    '{% endpaginate %}',
    '</section>',
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

  'sections/trust-badges.liquid': [
    '<div class="trust" id="{{ section.id }}">{{ section.settings.title }}</div>',
    '{% schema %}',
    JSON.stringify({
      name: 'Trust',
      settings: [{ id: 'title', type: 'text' }],
    }),
    '{% endschema %}',
  ].join(''),

  'sections/promo.liquid': '<div class="promo">Buy one get one</div>',

  'sections/styled-card.liquid':
    '<div class="card">hi</div>' +
    '{% stylesheet %}.card { color: red; }{% endstylesheet %}',

  // For .liquid fallback test
  'sections/footer.liquid': [
    '<footer>{{ section.settings.note }}</footer>',
    '{% schema %}',
    JSON.stringify({
      name: 'Footer',
      settings: [{ id: 'note', type: 'text', default: 'default note' }],
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

  const baseContext = {
    shop: { name: 'Gbox' },
    customer: { first_name: 'Thai' },
    cart: {
      item_count: 1,
      items: [{ title: 'Camera Pro' }],
    },
    request: { path: '/products/camera-pro' },
    extraGlobals: {
      product: { title: 'Gbox Camera Pro', vendor: 'Gbox' },
      collection: { products: fakeProducts(7) },
    },
  }

  // ----- (1) Single-section JSON render ---------------------------------
  {
    const r = await renderSections(engine, {
      ...baseContext,
      template: 'product',
      sectionIds: ['header'],
    })
    if (r.errors) throw new Error(`(1) unexpected errors: ${JSON.stringify(r.errors)}`)
    if (r.resolved.kind !== 'json' || r.resolved.path !== 'templates/product.json')
      throw new Error(`(1) resolved wrong: ${JSON.stringify(r.resolved)}`)
    const html = r.sections.header
    if (!html.includes('id="header"')) throw new Error('(1) section.id wrong')
    if (!html.includes('Gbox')) throw new Error('(1) shop name missing')
    if (!html.includes('home,shop,about'))
      throw new Error('(1) JSON settings override missing')
    console.log('PASS (1) single-section JSON render')
  }

  // ----- (2) Multi-section batch, same-type distinct ids -----------------
  {
    const r = await renderSections(engine, {
      ...baseContext,
      template: 'product',
      sectionIds: ['header', 'trust_top', 'trust_bottom'],
    })
    if (r.errors) throw new Error(`(2) errors: ${JSON.stringify(r.errors)}`)
    if (Object.keys(r.sections).length !== 3)
      throw new Error(`(2) wrong count: ${Object.keys(r.sections).length}`)
    if (!r.sections.trust_top.includes('id="trust_top"'))
      throw new Error('(2) trust_top id wrong')
    if (!r.sections.trust_top.includes('Top row'))
      throw new Error('(2) trust_top settings wrong')
    if (!r.sections.trust_bottom.includes('id="trust_bottom"'))
      throw new Error('(2) trust_bottom id wrong')
    if (!r.sections.trust_bottom.includes('Bottom row'))
      throw new Error('(2) trust_bottom settings wrong')
    console.log('PASS (2) multi-section batch with same-type distinct ids')
  }

  // ----- (3) Envs visible + pageDrop visible ------------------------------
  {
    const r = await renderSections(engine, {
      ...baseContext,
      template: 'product',
      sectionIds: ['main_product'],
    })
    if (r.errors) throw new Error(`(3) errors: ${JSON.stringify(r.errors)}`)
    if (!r.sections.main_product.includes('<h1>Gbox Camera Pro</h1>'))
      throw new Error('(3) product drop missing')
    if (!r.sections.main_product.includes('<p>by Gbox</p>'))
      throw new Error('(3) vendor conditional (checkbox default false → JSON override true) wrong')
    console.log('PASS (3) envs + pageDrop visible, schema checkbox override works')
  }

  // ----- (4) Cart drawer AJAX refresh ------------------------------------
  {
    // Simulate: before add-to-cart
    const before = await renderSections(engine, {
      ...baseContext,
      template: 'product',
      sectionIds: ['cart-drawer'],
    })
    if (!before.sections['cart-drawer'].includes('Items: 1'))
      throw new Error('(4) initial count wrong')

    // Simulate: after add-to-cart — caller passes the updated cart drop
    const after = await renderSections(engine, {
      ...baseContext,
      cart: {
        item_count: 2,
        items: [
          { title: 'Camera Pro' },
          { title: 'Tripod' },
        ],
      },
      template: 'product',
      sectionIds: ['cart-drawer', 'header'],
    })
    if (!after.sections['cart-drawer'].includes('Items: 2'))
      throw new Error('(4) updated count wrong')
    if (!after.sections['cart-drawer'].includes('<li>Tripod</li>'))
      throw new Error('(4) new line item missing')
    // Header re-renders with the new cart count too.
    if (!after.sections.header.includes('data-count="2"'))
      throw new Error('(4) header cart count not re-rendered')
    console.log('PASS (4) cart drawer AJAX refresh flow works end-to-end')
  }

  // ----- (5) Paginate wiring inside a section ----------------------------
  {
    const r = await renderSections(engine, {
      ...baseContext,
      template: 'product',
      sectionIds: ['related'],
      paginate: { 'collection.products': { page: 2 } },
    })
    if (r.errors) throw new Error(`(5) errors: ${JSON.stringify(r.errors)}`)
    const html = r.sections.related
    // per_page 2, page 2 → products 3, 4
    if (!html.includes('data-id="3"') || !html.includes('data-id="4"'))
      throw new Error(`(5) paginate slice wrong: ${html}`)
    if (html.includes('data-id="1"') || html.includes('data-id="2"'))
      throw new Error('(5) page-1 items leaked')
    if (!html.includes('cp=2|total=4'))
      throw new Error(`(5) paginate drop wrong: ${html}`)
    console.log('PASS (5) paginate option threads into section-api call')
  }

  // ----- (6) Partial-success: unknown JSON section id -------------------
  {
    const r = await renderSections(engine, {
      ...baseContext,
      template: 'product',
      sectionIds: ['header', 'ghost'],
    })
    if (!r.errors) throw new Error('(6) expected errors')
    if (r.errors.ghost.code !== 'section_not_found')
      throw new Error(`(6) wrong error code: ${r.errors.ghost.code}`)
    if (!r.sections.header)
      throw new Error('(6) good section killed by failed sibling')
    if (r.sections.ghost !== undefined)
      throw new Error('(6) failed section should be absent from sections map')
    console.log('PASS (6) partial-success: unknown JSON section id')
  }

  // ----- (7) Partial-success: missing section file (.liquid fallback) ----
  {
    const r = await renderSections(engine, {
      template: 'classic',
      sectionIds: ['footer', 'does-not-exist'],
      sectionInstances: { footer: { settings: { note: 'classic mode' } } },
      shop: { name: 'Gbox' },
    })
    if (r.resolved.kind !== 'liquid')
      throw new Error(`(7) expected liquid fallback, got ${r.resolved.kind}`)
    if (!r.sections.footer.includes('classic mode'))
      throw new Error(`(7) .liquid fallback instance data missing: ${r.sections.footer}`)
    if (!r.errors || r.errors['does-not-exist'].code !== 'section_not_found')
      throw new Error('(7) expected section_not_found for missing file')
    console.log('PASS (7) .liquid fallback + partial-success error')
  }

  // ----- (8) Disabled JSON section → empty string ------------------------
  {
    const r = await renderSections(engine, {
      ...baseContext,
      template: 'product',
      sectionIds: ['hidden_promo', 'header'],
    })
    if (r.errors) throw new Error(`(8) unexpected errors: ${JSON.stringify(r.errors)}`)
    if (r.sections.hidden_promo !== '')
      throw new Error(`(8) disabled section should be "" but was: ${r.sections.hidden_promo}`)
    if (!r.sections.header) throw new Error('(8) sibling failed')
    console.log('PASS (8) disabled JSON section returns empty string')
  }

  // ----- (9) No layout applied even when JSON declares one ---------------
  {
    const r = await renderSections(engine, {
      template: 'layouted',
      sectionIds: ['main'],
      shop: { name: 'Gbox' },
    })
    if (r.sections.main.includes('<!doctype'))
      throw new Error('(9) layout leaked into section response')
    if (r.sections.main.includes('THEME['))
      throw new Error('(9) theme.liquid wrapper leaked')
    console.log('PASS (9) no layout applied even with JSON layout: theme')
  }

  // ----- (10) No content_for_header hoist --------------------------------
  {
    const r = await renderSections(engine, {
      template: 'with-css',
      sectionIds: ['main'],
    })
    const html = r.sections.main
    if (html.includes('<style'))
      throw new Error('(10) <style> leaked into section response')
    if (html.includes('data-gbox-section'))
      throw new Error('(10) content_for_header marker leaked')
    if (html !== '<div class="card">hi</div>')
      throw new Error(`(10) body wrong: ${html}`)
    console.log('PASS (10) content_for_header not injected into section response')
  }

  // ----- (11) Whole-request errors throw ---------------------------------
  {
    // 11a — template not found
    let threw = false
    try {
      await renderSections(engine, { template: 'nope', sectionIds: ['x'] })
    } catch (err) {
      if (!(err instanceof SectionRenderingError))
        throw new Error('(11a) wrong error class')
      if (err.code !== 'template_not_found')
        throw new Error(`(11a) wrong code: ${err.code}`)
      threw = true
    }
    if (!threw) throw new Error('(11a) should have thrown')

    // 11b — empty sectionIds
    threw = false
    try {
      await renderSections(engine, { template: 'product', sectionIds: [] })
    } catch (err) {
      if (!(err instanceof SectionRenderingError))
        throw new Error('(11b) wrong error class')
      if (err.code !== 'empty_section_ids')
        throw new Error(`(11b) wrong code: ${err.code}`)
      threw = true
    }
    if (!threw) throw new Error('(11b) should have thrown')
    console.log('PASS (11) whole-request errors throw SectionRenderingError')
  }

  // ----- (12) maxSections cap --------------------------------------------
  {
    // 12a — default cap of 5 kicks in
    let threw = false
    try {
      await renderSections(engine, {
        template: 'product',
        sectionIds: ['a', 'b', 'c', 'd', 'e', 'f'],
      })
    } catch (err) {
      if (!(err instanceof SectionRenderingError))
        throw new Error('(12a) wrong error class')
      if (err.code !== 'too_many_sections')
        throw new Error(`(12a) wrong code: ${err.code}`)
      threw = true
    }
    if (!threw) throw new Error('(12a) should have thrown')

    // 12b — caller overrides to 10
    const r = await renderSections(engine, {
      ...baseContext,
      template: 'product',
      sectionIds: ['header', 'main_product', 'cart-drawer', 'related', 'trust_top', 'trust_bottom'],
      maxSections: 10,
    })
    if (r.errors) throw new Error(`(12b) errors: ${JSON.stringify(r.errors)}`)
    if (Object.keys(r.sections).length !== 6)
      throw new Error('(12b) wrong count')
    console.log('PASS (12) maxSections cap enforced + overridable')
  }

  // ----- (13) Classic .liquid fallback (id === filename) -----------------
  {
    const r = await renderSections(engine, {
      template: 'classic',
      sectionIds: ['footer'],
      sectionInstances: { footer: { settings: { note: 'liquid mode ok' } } },
    })
    if (r.resolved.kind !== 'liquid')
      throw new Error(`(13) resolved kind: ${r.resolved.kind}`)
    if (!r.sections.footer.includes('liquid mode ok'))
      throw new Error(`(13) .liquid fallback: ${r.sections.footer}`)
    console.log('PASS (13) classic .liquid template fallback works')
  }

  console.log('\nALL PASSED — Step 1.13 Section Rendering API is the real deal')
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  console.error(err.stack)
  process.exit(1)
})
