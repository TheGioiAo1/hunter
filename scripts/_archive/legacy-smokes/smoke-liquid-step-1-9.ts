/**
 * Smoke test — Decision #1 Step 1.9 form tag + payment filters.
 *
 * Exercises the full form tag + payment filter suite:
 *
 *   1. `{% form 'contact' %}` — basic static dispatch + body
 *   2. `{% form 'customer_login' %}` — id + action
 *   3. `{% form 'product', product %}` — dynamic hidden input for variant
 *   4. `{% form 'customer_address', address %}` — existing id → PUT
 *   5. `{% form 'new_comment', article %}` — article.url interpolated
 *   6. CSRF token emitted when `ctx.environments.csrf_token` is set
 *   7. `form.errors` populated from `ctx.environments.form_state`
 *   8. `form.posted_successfully?` from `form_state`
 *   9. payment_type_img_url — default + CDN
 *  10. payment_type_svg_tag — default + CDN
 *  11. End-to-end: contact form with errors list + submit
 *  12. End-to-end: product form inside a section, with variant + CSRF
 *
 * Run:
 *   npx tsx scripts/smoke-liquid-step-1-9.ts
 */

import { Context } from 'liquidjs'
import {
  createLiquidEngine,
  DefaultAssetUrlBuilder,
  type LoadResult,
  type LogicalPath,
  type TemplateLoader,
} from '../packages/core/src/modules/themes/engine/index.js'
import { MemoryI18nService } from '../packages/core/src/modules/i18n/index.js'

// ---------------------------------------------------------------------------
// In-memory loader (sections/snippets used by case 12)
// ---------------------------------------------------------------------------

class MemoryLoader implements TemplateLoader {
  readonly name = 'memory'
  constructor(private readonly files: Record<string, string> = {}) {}
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

const files: Record<string, string> = {
  'sections/product-form.liquid': [
    '<section>',
    "  {% form 'product', product %}",
    '    <button type="submit">Add to cart</button>',
    '  {% endform %}',
    '</section>',
  ].join('\n'),
}

function makeDev() {
  return createLiquidEngine({
    loader: new MemoryLoader(files),
    i18n: new MemoryI18nService(),
  })
}

function makeCdn() {
  return createLiquidEngine({
    loader: new MemoryLoader(files),
    i18n: new MemoryI18nService(),
    assetUrlBuilder: new DefaultAssetUrlBuilder({
      globalAssetBase: 'https://cdn.gbox.co/global',
      themeAssetBase: 'https://cdn.gbox.co/shop_1/assets',
      fileBase: 'https://cdn.gbox.co/shop_1/files',
      cacheBustToken: '2026-04-09',
    }),
  })
}

// ---------------------------------------------------------------------------

async function main() {
  const dev = makeDev()
  const cdn = makeCdn()

  // ----- (1) contact form ---------------------------------------------------
  {
    const out = await dev.liquid.parseAndRender(
      "{% form 'contact' %}<p>Hi</p>{% endform %}",
    )
    if (!out.includes('action="/contact#contact_form"'))
      throw new Error(`(1) missing contact action: ${out}`)
    if (!out.includes('name="form_type" value="contact"'))
      throw new Error(`(1) missing form_type hidden: ${out}`)
    if (!out.includes('<p>Hi</p>'))
      throw new Error(`(1) body not rendered: ${out}`)
    console.log('PASS (1) contact form dispatch + body')
  }

  // ----- (2) customer_login -------------------------------------------------
  {
    const out = await dev.liquid.parseAndRender(
      "{% form 'customer_login' %}x{% endform %}",
    )
    if (!out.includes('id="customer_login"')) throw new Error(`(2) ${out}`)
    if (!out.includes('action="/account/login"')) throw new Error(`(2) ${out}`)
    console.log('PASS (2) customer_login dispatch')
  }

  // ----- (3) product form with selected variant ----------------------------
  {
    const out = await dev.liquid.parseAndRender(
      "{% form 'product', product %}buy{% endform %}",
      {
        product: {
          id: 42,
          selected_or_first_available_variant: { id: 9001 },
        },
      },
    )
    if (!out.includes('action="/cart/add"')) throw new Error(`(3) ${out}`)
    if (!out.includes('id="product_form_42"')) throw new Error(`(3) ${out}`)
    if (!out.includes('name="id" value="9001"'))
      throw new Error(`(3) missing variant id hidden: ${out}`)
    console.log('PASS (3) product form with selected variant')
  }

  // ----- (4) customer_address PUT edit -------------------------------------
  {
    const out = await dev.liquid.parseAndRender(
      "{% form 'customer_address', address %}x{% endform %}",
      { address: { id: 7 } },
    )
    if (!out.includes('action="/account/addresses/7"'))
      throw new Error(`(4) ${out}`)
    if (!out.includes('id="edit_address_7"')) throw new Error(`(4) ${out}`)
    if (!out.includes('name="_method" value="put"'))
      throw new Error(`(4) missing _method hidden: ${out}`)
    console.log('PASS (4) customer_address edit → PUT')
  }

  // ----- (5) new_comment with article URL interpolation --------------------
  {
    const out = await dev.liquid.parseAndRender(
      "{% form 'new_comment', article %}c{% endform %}",
      { article: { id: 99, url: '/blogs/news/hello' } },
    )
    if (!out.includes('action="/blogs/news/hello/comments"'))
      throw new Error(`(5) ${out}`)
    if (!out.includes('id="article-99-comment-form"'))
      throw new Error(`(5) ${out}`)
    console.log('PASS (5) new_comment with article url')
  }

  // ----- (6) CSRF token via environments -----------------------------------
  {
    const ctx = new Context({}, dev.liquid.options)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(ctx as any).environments.csrf_token = 'tkn-abc-123'
    const tpls = dev.liquid.parse("{% form 'contact' %}x{% endform %}")
    const out = await dev.liquid.render(tpls, ctx)
    if (!out.includes('name="authenticity_token" value="tkn-abc-123"'))
      throw new Error(`(6) CSRF hidden missing: ${out}`)
    console.log('PASS (6) CSRF token injected from environments')
  }

  // ----- (7) form.errors from form_state -----------------------------------
  {
    const ctx = new Context({}, dev.liquid.options)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(ctx as any).environments.form_state = {
      contact: { errors: ['email', 'body'] },
    }
    const tpls = dev.liquid.parse(
      "{% form 'contact' %}{% for e in form.errors %}[{{ e }}]{% endfor %}{% endform %}",
    )
    const out = await dev.liquid.render(tpls, ctx)
    if (!out.includes('[email][body]'))
      throw new Error(`(7) form.errors not populated: ${out}`)
    console.log('PASS (7) form.errors populated from form_state')
  }

  // ----- (8) form.posted_successfully? -------------------------------------
  {
    const ctx = new Context({}, dev.liquid.options)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(ctx as any).environments.form_state = {
      contact: { posted_successfully: true },
    }
    const tpls = dev.liquid.parse(
      "{% form 'contact' %}{% if form.posted_successfully? %}OK{% else %}NO{% endif %}{% endform %}",
    )
    const out = await dev.liquid.render(tpls, ctx)
    if (!out.includes('OK') || out.includes('NO'))
      throw new Error(`(8) posted_successfully? not reflected: ${out}`)
    console.log('PASS (8) form.posted_successfully? reflected')
  }

  // ----- (9) payment_type_img_url (dev + CDN) -----------------------------
  {
    const devOut = await dev.liquid.parseAndRender(
      '{{ "visa" | payment_type_img_url }}',
    )
    if (devOut !== '/global/payment_icons/visa.svg')
      throw new Error(`(9 dev) ${devOut}`)
    const cdnOut = await cdn.liquid.parseAndRender(
      '{{ "mastercard" | payment_type_img_url }}',
    )
    if (
      cdnOut !==
      'https://cdn.gbox.co/global/payment_icons/mastercard.svg?v=2026-04-09'
    )
      throw new Error(`(9 cdn) ${cdnOut}`)
    console.log('PASS (9) payment_type_img_url dev + CDN')
  }

  // ----- (10) payment_type_svg_tag ----------------------------------------
  {
    const out = await dev.liquid.parseAndRender(
      '{{ "American Express" | payment_type_svg_tag }}',
    )
    if (!out.includes('payment-icon--american_express'))
      throw new Error(`(10) class slug missing: ${out}`)
    if (!out.includes('aria-label="American Express"'))
      throw new Error(`(10) aria-label missing: ${out}`)
    if (!out.includes('american_express.svg#american_express'))
      throw new Error(`(10) use href missing: ${out}`)
    console.log('PASS (10) payment_type_svg_tag')
  }

  // ----- (11) end-to-end contact form with errors --------------------------
  {
    const ctx = new Context({}, dev.liquid.options)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(ctx as any).environments.csrf_token = 'X123'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(ctx as any).environments.form_state = {
      contact: { errors: ['email'] },
    }
    const tpls = dev.liquid.parse(
      [
        "{% form 'contact' %}",
        '{% if form.errors.size > 0 %}',
        '  <div class="err">{{ form.errors.size }} error(s)</div>',
        '{% endif %}',
        '<input type="email" name="contact[email]" />',
        '<button>Send</button>',
        '{% endform %}',
      ].join('\n'),
    )
    const out = await dev.liquid.render(tpls, ctx)
    if (!out.includes('name="authenticity_token" value="X123"'))
      throw new Error(`(11) CSRF missing: ${out}`)
    if (!out.includes('1 error(s)'))
      throw new Error(`(11) error count wrong: ${out}`)
    if (!out.includes('<button>Send</button>'))
      throw new Error(`(11) submit button missing: ${out}`)
    console.log('PASS (11) end-to-end contact form with errors + CSRF')
  }

  // ----- (12) product form inside a section --------------------------------
  {
    const ctx = new Context(
      {
        product: {
          id: 1,
          selected_or_first_available_variant: { id: 555 },
        },
      },
      dev.liquid.options,
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(ctx as any).environments.csrf_token = 'PROD-CSRF'
    const tpls = dev.liquid.parse("{% section 'product-form' %}")
    const out = await dev.liquid.render(tpls, ctx)
    if (!out.includes('<section>'))
      throw new Error(`(12) outer wrapper missing: ${out}`)
    if (!out.includes('action="/cart/add"'))
      throw new Error(`(12) form action missing: ${out}`)
    if (!out.includes('name="id" value="555"'))
      throw new Error(`(12) variant id missing: ${out}`)
    if (!out.includes('name="authenticity_token" value="PROD-CSRF"'))
      throw new Error(`(12) CSRF missing: ${out}`)
    if (!out.includes('<button type="submit">Add to cart</button>'))
      throw new Error(`(12) body not rendered: ${out}`)
    console.log('PASS (12) product form inside a section with CSRF')
  }

  console.log('\nALL PASSED — Step 1.9 form tag + payment filters wired')
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  console.error(err.stack)
  process.exit(1)
})
