/**
 * Smoke test — Decision #1 Step 1.10 render pipeline.
 *
 * This is the first test that renders a REALISTIC mini Shopify theme
 * end-to-end through `renderPage()`. It exercises every system built
 * in Steps 1.3 – 1.9 through the pipeline's public API:
 *
 *   1. renderPage with default 'theme' layout wrap
 *   2. renderPage with `{% layout 'alt' %}` page → alt layout used
 *   3. renderPage with `{% layout none %}` → no layout wrap
 *   4. renderPage skipLayout: true → no layout wrap
 *   5. Missing template → throws with helpful message
 *   6. Missing layout → throws with helpful message
 *   7. content_for_header hoists stylesheet + javascript from
 *      sections
 *   8. Multiple sections → accumulated in content_for_header in order
 *   9. csrfToken + formState flow into {% form %} inside a section
 *  10. i18n `t` filter reads shop.id + request.locale from env
 *  11. Top-level {% assign %} in page leaks into layout scope
 *  12. Full Shopify-ish product page: layout wraps section with
 *      schema + stylesheet + form + image filter + t filter + shop
 *      drop + request + cart
 *
 * Run:
 *   npx tsx scripts/smoke-liquid-step-1-10.ts
 */

import {
  createLiquidEngine,
  renderPage,
  DefaultAssetUrlBuilder,
  type LoadResult,
  type LogicalPath,
  type TemplateLoader,
} from '../packages/core/src/modules/themes/engine/index.js'
import { MemoryI18nService } from '../packages/core/src/modules/i18n/index.js'

// ---------------------------------------------------------------------------
// Mini Shopify-style theme, in-memory
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

const themeFiles: Record<string, string> = {
  // ----- Layouts ----------------------------------------------------------
  'layout/theme.liquid': [
    '<!DOCTYPE html>',
    '<html lang="{{ request.locale }}">',
    '<head>',
    '  <title>{{ page_title }} · {{ shop.name }}</title>',
    '  {{ content_for_header }}',
    '</head>',
    '<body class="{{ page_class }}">',
    '  <header>{{ shop.name }}</header>',
    '  <main>{{ content_for_layout }}</main>',
    '  <footer>{{ cart.item_count }} items in cart</footer>',
    '</body>',
    '</html>',
  ].join('\n'),

  'layout/alt.liquid': 'ALT_LAYOUT[{{ content_for_layout }}]',

  // ----- Sections ---------------------------------------------------------
  'sections/product-card.liquid': [
    '<article id="{{ section.id }}">',
    '  <h1>{{ product.title }}</h1>',
    "  {{ product.featured_image | img_url: 'medium' | img_tag: product.title, 'product-image' }}",
    "  {% form 'product', product %}",
    '    <button type="submit">{{ "cart.add_to_cart" | t }}</button>',
    '  {% endform %}',
    '</article>',
    '{% schema %}',
    '{"name":"Product card","settings":[]}',
    '{% endschema %}',
    '{% stylesheet %}',
    '.product-card { padding: 1rem; }',
    '{% endstylesheet %}',
    '{% javascript %}',
    'console.log("product-card mounted");',
    '{% endjavascript %}',
  ].join('\n'),

  'sections/footer-payment.liquid': [
    '<div class="payment-icons">',
    "  {{ 'visa' | payment_type_svg_tag }}",
    "  {{ 'mastercard' | payment_type_svg_tag }}",
    '</div>',
    '{% stylesheet %}',
    '.payment-icons svg { width: 40px; }',
    '{% endstylesheet %}',
  ].join('\n'),

  // ----- Templates --------------------------------------------------------
  'templates/index.liquid': '<h1>Home</h1>',

  'templates/product.liquid': [
    "{%- assign page_title = product.title -%}",
    "{%- assign page_class = 'tpl-product' -%}",
    "{% section 'product-card' %}",
    "{% section 'footer-payment' %}",
  ].join('\n'),

  'templates/page-alt.liquid': "{% layout 'alt' %}alt page body",
  'templates/page-none.liquid': '{% layout none %}bare body',
}

const i18n = new MemoryI18nService({
  shop_1: {
    en: { 'cart.add_to_cart': 'Add to cart' },
    vi: { 'cart.add_to_cart': 'Thêm vào giỏ' },
  },
})

function makeEngine() {
  return createLiquidEngine({
    loader: new MemoryLoader(themeFiles),
    i18n,
    assetUrlBuilder: new DefaultAssetUrlBuilder({
      themeAssetBase: 'https://cdn.gbox.co/shop_1/assets',
      fileBase: 'https://cdn.gbox.co/shop_1/files',
      globalAssetBase: 'https://cdn.gbox.co/global',
      cacheBustToken: '2026-04-09',
    }),
  })
}

// ---------------------------------------------------------------------------

async function main() {
  const engine = makeEngine()

  // ----- (1) Default theme layout wrap ------------------------------------
  {
    const { html, layoutUsed } = await renderPage(engine, {
      template: 'index',
      shop: { id: 'shop_1', name: 'Gbox Demo', default_locale: 'en' },
      locale: 'en',
      cart: { item_count: 0 },
    })
    if (layoutUsed !== 'theme') throw new Error(`(1) layoutUsed: ${layoutUsed}`)
    if (!html.includes('<!DOCTYPE html>')) throw new Error(`(1) no doctype`)
    if (!html.includes('<h1>Home</h1>')) throw new Error(`(1) page missing`)
    if (!html.includes('· Gbox Demo')) throw new Error(`(1) shop name missing`)
    console.log('PASS (1) default theme layout wrap')
  }

  // ----- (2) {% layout 'alt' %} --------------------------------------------
  {
    const { html, layoutUsed } = await renderPage(engine, {
      template: 'page-alt',
    })
    if (layoutUsed !== 'alt') throw new Error(`(2) layoutUsed: ${layoutUsed}`)
    if (html !== 'ALT_LAYOUT[alt page body]') throw new Error(`(2) ${html}`)
    console.log('PASS (2) {% layout \'alt\' %} selects alt layout')
  }

  // ----- (3) {% layout none %} ---------------------------------------------
  {
    const { html, layoutUsed } = await renderPage(engine, {
      template: 'page-none',
    })
    if (layoutUsed !== null) throw new Error(`(3) layoutUsed: ${layoutUsed}`)
    if (html !== 'bare body') throw new Error(`(3) ${html}`)
    console.log('PASS (3) {% layout none %} skips layout')
  }

  // ----- (4) skipLayout option ---------------------------------------------
  {
    const { html, layoutUsed } = await renderPage(engine, {
      template: 'page-alt', // has {% layout 'alt' %}
      skipLayout: true,
    })
    if (layoutUsed !== null) throw new Error(`(4) layoutUsed: ${layoutUsed}`)
    if (html !== 'alt page body') throw new Error(`(4) ${html}`)
    console.log('PASS (4) skipLayout overrides {% layout %} tag')
  }

  // ----- (5) Missing template ----------------------------------------------
  {
    let threw = false
    try {
      await renderPage(engine, { template: 'ghost' })
    } catch (err) {
      threw = true
      if (!(err as Error).message.includes('templates/ghost.liquid')) {
        throw new Error(
          `(5) wrong error: ${(err as Error).message}`,
        )
      }
    }
    if (!threw) throw new Error('(5) missing template should throw')
    console.log('PASS (5) missing template throws helpful error')
  }

  // ----- (6) Missing layout ------------------------------------------------
  {
    const engine2 = createLiquidEngine({
      loader: new MemoryLoader({ 'templates/x.liquid': "{% layout 'missing' %}hi" }),
      i18n,
    })
    let threw = false
    try {
      await renderPage(engine2, { template: 'x' })
    } catch (err) {
      threw = true
      if (!(err as Error).message.includes('layout/missing.liquid')) {
        throw new Error(
          `(6) wrong error: ${(err as Error).message}`,
        )
      }
    }
    if (!threw) throw new Error('(6) missing layout should throw')
    console.log('PASS (6) missing layout throws helpful error')
  }

  // ----- (7) + (8) content_for_header hoist from multiple sections --------
  {
    const { html, meta } = await renderPage(engine, {
      template: 'product',
      shop: { id: 'shop_1', name: 'Gbox Demo', default_locale: 'en' },
      locale: 'en',
      cart: { item_count: 3 },
      pageDrop: {
        product: {
          id: 42,
          title: 'Super Widget',
          featured_image: { src: '/cdn/files/widget.jpg' },
          selected_or_first_available_variant: { id: 101 },
        },
      },
    })
    // Two sections → two stylesheet entries, one javascript entry.
    if ((meta.stylesheet ?? []).length !== 2) {
      throw new Error(
        `(7) stylesheet count: ${meta.stylesheet?.length}`,
      )
    }
    if ((meta.javascript ?? []).length !== 1) {
      throw new Error(
        `(7) javascript count: ${meta.javascript?.length}`,
      )
    }
    // Bodies are captured verbatim with surrounding newlines from the
    // source, so we check for the wrapper + CSS separately.
    if (!html.includes('<style data-gbox-section>')) {
      throw new Error(`(7) <style> wrapper missing`)
    }
    if (!html.includes('.product-card { padding: 1rem; }')) {
      throw new Error(`(7) product-card css not hoisted`)
    }
    if (!html.includes('.payment-icons svg { width: 40px; }')) {
      throw new Error(`(7) payment-icons css not hoisted`)
    }
    if (!html.includes('<script data-gbox-section>')) {
      throw new Error(`(7) <script> wrapper missing`)
    }
    if (!html.includes('console.log("product-card mounted");')) {
      throw new Error(`(7) js not hoisted`)
    }
    console.log('PASS (7+8) content_for_header hoists 2 sections (2 css + 1 js)')
  }

  // ----- (9) CSRF + form inside a section ----------------------------------
  {
    const { html } = await renderPage(engine, {
      template: 'product',
      shop: { id: 'shop_1', name: 'Gbox Demo', default_locale: 'en' },
      locale: 'en',
      cart: { item_count: 1 },
      pageDrop: {
        product: {
          id: 42,
          title: 'Super Widget',
          featured_image: { src: '/cdn/files/widget.jpg' },
          selected_or_first_available_variant: { id: 101 },
        },
      },
      csrfToken: 'csrf-xyz',
      formState: { product: {} },
    })
    if (!html.includes('action="/cart/add"'))
      throw new Error(`(9) product form action missing`)
    if (!html.includes('id="product_form_42"'))
      throw new Error(`(9) product form id missing`)
    if (!html.includes('name="id" value="101"'))
      throw new Error(`(9) variant hidden missing`)
    if (!html.includes('name="authenticity_token" value="csrf-xyz"'))
      throw new Error(`(9) CSRF hidden missing`)
    console.log('PASS (9) csrfToken + form inside section wired')
  }

  // ----- (10) i18n t filter reads env --------------------------------------
  {
    const en = await renderPage(engine, {
      template: 'product',
      shop: { id: 'shop_1', name: 'Shop', default_locale: 'en' },
      locale: 'en',
      cart: { item_count: 0 },
      pageDrop: {
        product: {
          id: 1,
          title: 'X',
          featured_image: { src: '/x.jpg' },
          selected_or_first_available_variant: { id: 1 },
        },
      },
    })
    if (!en.html.includes('>Add to cart<')) {
      throw new Error(`(10 en) translation missing: ${en.html.slice(0, 200)}`)
    }
    const vi = await renderPage(engine, {
      template: 'product',
      shop: { id: 'shop_1', name: 'Shop', default_locale: 'en' },
      locale: 'vi',
      cart: { item_count: 0 },
      pageDrop: {
        product: {
          id: 1,
          title: 'X',
          featured_image: { src: '/x.jpg' },
          selected_or_first_available_variant: { id: 1 },
        },
      },
    })
    if (!vi.html.includes('>Thêm vào giỏ<')) {
      throw new Error(`(10 vi) translation missing: ${vi.html.slice(0, 200)}`)
    }
    console.log('PASS (10) i18n t filter picks locale from renderPage opts')
  }

  // ----- (11) page assigns leak into layout --------------------------------
  {
    const { html } = await renderPage(engine, {
      template: 'product',
      shop: { id: 'shop_1', name: 'Gbox Demo', default_locale: 'en' },
      locale: 'en',
      cart: { item_count: 0 },
      pageDrop: {
        product: {
          id: 1,
          title: 'Leaked Title',
          featured_image: { src: '/x.jpg' },
          selected_or_first_available_variant: { id: 1 },
        },
      },
    })
    // product.liquid assigns page_title = product.title; layout reads it.
    if (!html.includes('<title>Leaked Title · Gbox Demo</title>')) {
      throw new Error(
        `(11) page_title did not leak into layout: ${
          /<title>[^<]*<\/title>/.exec(html)?.[0]
        }`,
      )
    }
    if (!html.includes('class="tpl-product"')) {
      throw new Error(`(11) page_class did not leak into layout`)
    }
    console.log('PASS (11) page-level {% assign %} leaks into layout scope')
  }

  // ----- (12) full realistic Shopify product page --------------------------
  {
    const { html, meta, layoutUsed, renderMs } = await renderPage(engine, {
      template: 'product',
      shop: {
        id: 'shop_1',
        name: 'Gbox Demo',
        default_locale: 'en',
      },
      locale: 'vi',
      request: { path: '/products/super-widget', host: 'demo.gbox.co' },
      customer: null,
      cart: { item_count: 7 },
      csrfToken: 'prod-csrf-token',
      formState: { product: {} },
      pageDrop: {
        product: {
          id: 1001,
          title: 'Super Widget Pro',
          featured_image: { src: '/cdn/files/widget.jpg' },
          selected_or_first_available_variant: { id: 2001 },
        },
      },
    })

    // Structural checks
    if (layoutUsed !== 'theme') throw new Error(`(12) layoutUsed: ${layoutUsed}`)
    if (!html.startsWith('<!DOCTYPE html>')) throw new Error(`(12) doctype`)
    if (!html.includes('<title>Super Widget Pro · Gbox Demo</title>'))
      throw new Error(`(12) title`)
    if (!html.includes('<header>Gbox Demo</header>'))
      throw new Error(`(12) shop header`)
    if (!html.includes('<footer>7 items in cart</footer>'))
      throw new Error(`(12) cart footer`)
    if (!html.includes('<article id="product-card">'))
      throw new Error(`(12) section id`)
    if (!html.includes('<h1>Super Widget Pro</h1>'))
      throw new Error(`(12) product title`)
    // img_url + img_tag chain with CDN builder — the featured_image
    // source is `/cdn/files/widget.jpg`, `medium` maps to 240x240,
    // cache-bust token grafts `?v=2026-04-09` on.
    if (!html.includes('src="/cdn/files/widget_240x240.jpg?v=2026-04-09"'))
      throw new Error(
        `(12) img src missing: ${/src="[^"]*widget[^"]*"/.exec(html)?.[0]}`,
      )
    if (!html.includes('alt="Super Widget Pro"'))
      throw new Error(`(12) img alt missing`)
    if (!html.includes('class="product-image"'))
      throw new Error(`(12) img class missing`)
    // Form tag
    if (!html.includes('action="/cart/add"'))
      throw new Error(`(12) form action`)
    if (!html.includes('name="authenticity_token" value="prod-csrf-token"'))
      throw new Error(`(12) csrf`)
    if (!html.includes('name="id" value="2001"'))
      throw new Error(`(12) variant hidden`)
    // Vietnamese i18n
    if (!html.includes('>Thêm vào giỏ<'))
      throw new Error(`(12) vi translation`)
    // Payment icons in footer section
    if (!html.includes('payment-icon--visa'))
      throw new Error(`(12) visa icon`)
    if (!html.includes('payment-icon--mastercard'))
      throw new Error(`(12) mastercard icon`)
    // Schema captured
    if (!meta.schema || !meta.schema.includes('"Product card"'))
      throw new Error(`(12) schema capture`)
    // Both sections hoisted styles
    if ((meta.stylesheet ?? []).length !== 2)
      throw new Error(`(12) stylesheet count: ${meta.stylesheet?.length}`)
    // Timing sane
    if (renderMs < 0 || renderMs > 5000)
      throw new Error(`(12) renderMs: ${renderMs}`)

    console.log(
      `PASS (12) full realistic product page (${renderMs}ms, ${html.length} bytes)`,
    )
  }

  console.log('\nALL PASSED — Step 1.10 render pipeline is the real deal')
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  console.error(err.stack)
  process.exit(1)
})
