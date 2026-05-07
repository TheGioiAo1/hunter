/**
 * Gbox Platform — `{% form %}` tag tests
 *
 * Decision #1 Step 1.9. Cover:
 *
 *   1. Each form type in the dispatch table produces the right
 *      method/action/id/className and the right standard hidden
 *      inputs (form_type, utf8).
 *   2. CSRF token is read from ctx.environments.csrf_token and
 *      emitted as an authenticity_token hidden input.
 *   3. When CSRF is absent, the authenticity_token input is omitted
 *      (no crash, form still valid HTML).
 *   4. The body renders as normal Liquid inside the form.
 *   5. The `form` drop is injected into scope with id/errors/
 *      posted_successfully? fields pulled from form_state.
 *   6. form_state overrides: errors, posted_successfully, plus extra
 *      fields merged as drops.
 *   7. Dynamic forms: customer_address + product read the positional
 *      object arg to build action/id/hidden inputs.
 *   8. Parse errors: unknown type, missing type, bad quoting, missing
 *      endform.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { Liquid } from 'liquidjs'
import { registerFormTag, FORM_HANDLERS } from './form.js'

let liquid: Liquid

beforeAll(() => {
  liquid = new Liquid({
    strictFilters: true,
    strictVariables: false,
    outputEscape: undefined,
  })
  registerFormTag(liquid)
})

async function render(
  tpl: string,
  scope: Record<string, unknown> = {},
): Promise<string> {
  return liquid.parseAndRender(tpl, scope)
}

// ---------------------------------------------------------------------------
// Basic dispatch — static form types
// ---------------------------------------------------------------------------

describe('{% form %} — static dispatch', () => {
  it('contact form emits /contact#contact_form action + id', async () => {
    const out = await render("{% form 'contact' %}body{% endform %}")
    expect(out).toContain('method="post"')
    expect(out).toContain('action="/contact#contact_form"')
    expect(out).toContain('id="contact_form"')
    expect(out).toContain('accept-charset="UTF-8"')
    expect(out).toContain(
      '<input type="hidden" name="form_type" value="contact" />',
    )
    expect(out).toContain('<input type="hidden" name="utf8" value="\u2713" />')
    expect(out).toContain('body')
    expect(out).toMatch(/<\/form>$/)
  })

  it('customer_login form uses /account/login', async () => {
    const out = await render("{% form 'customer_login' %}x{% endform %}")
    expect(out).toContain('action="/account/login"')
    expect(out).toContain('id="customer_login"')
  })

  it('create_customer + customer_register both target /account', async () => {
    const a = await render("{% form 'create_customer' %}x{% endform %}")
    const b = await render("{% form 'customer_register' %}x{% endform %}")
    expect(a).toContain('action="/account"')
    expect(b).toContain('action="/account"')
    expect(a).toContain('id="create_customer"')
    expect(b).toContain('id="create_customer"')
  })

  it('customer form → /account, id=customer_form', async () => {
    const out = await render("{% form 'customer' %}x{% endform %}")
    expect(out).toContain('action="/account"')
    expect(out).toContain('id="customer_form"')
  })

  it('activate_customer_password → /account/activate', async () => {
    const out = await render(
      "{% form 'activate_customer_password' %}x{% endform %}",
    )
    expect(out).toContain('action="/account/activate"')
  })

  it('recover_customer_password → /account/recover', async () => {
    const out = await render(
      "{% form 'recover_customer_password' %}x{% endform %}",
    )
    expect(out).toContain('action="/account/recover"')
  })

  it('reset_customer_password → /account/reset', async () => {
    const out = await render(
      "{% form 'reset_customer_password' %}x{% endform %}",
    )
    expect(out).toContain('action="/account/reset"')
  })

  it('storefront_password → /password, id=login_form', async () => {
    const out = await render("{% form 'storefront_password' %}x{% endform %}")
    expect(out).toContain('action="/password"')
    expect(out).toContain('id="login_form"')
  })

  it('cart form → /cart, class=cart', async () => {
    const out = await render("{% form 'cart' %}x{% endform %}")
    expect(out).toContain('action="/cart"')
    expect(out).toContain('class="cart"')
  })

  it('localization form → /localization', async () => {
    const out = await render("{% form 'localization' %}x{% endform %}")
    expect(out).toContain('action="/localization"')
    expect(out).toContain('id="localization_form"')
    expect(out).toContain('class="shopify-localization-form"')
  })

  it('currency form aliases to /localization', async () => {
    const out = await render("{% form 'currency' %}x{% endform %}")
    expect(out).toContain('action="/localization"')
    expect(out).toContain('id="currency_form"')
  })
})

// ---------------------------------------------------------------------------
// Dynamic forms — positional object arg
// ---------------------------------------------------------------------------

describe('{% form %} — dynamic dispatch', () => {
  it('customer_address without object → new address endpoint', async () => {
    const out = await render(
      "{% form 'customer_address', address %}x{% endform %}",
      { address: null },
    )
    expect(out).toContain('action="/account/addresses"')
    expect(out).toContain('id="address_form_new"')
    // No _method hidden input for new address.
    expect(out).not.toContain('name="_method"')
  })

  it('customer_address with existing id → PUT + scoped URL', async () => {
    const out = await render(
      "{% form 'customer_address', address %}x{% endform %}",
      { address: { id: 42 } },
    )
    expect(out).toContain('action="/account/addresses/42"')
    expect(out).toContain('id="edit_address_42"')
    expect(out).toContain(
      '<input type="hidden" name="_method" value="put" />',
    )
  })

  it('product form uses selected variant id as hidden input', async () => {
    const out = await render(
      "{% form 'product', product %}x{% endform %}",
      {
        product: {
          id: 1001,
          selected_or_first_available_variant: { id: 9001 },
        },
      },
    )
    expect(out).toContain('action="/cart/add"')
    expect(out).toContain('id="product_form_1001"')
    expect(out).toContain('class="shopify-product-form"')
    expect(out).toContain('<input type="hidden" name="id" value="9001" />')
  })

  it('product form falls back to first variant when no selected', async () => {
    const out = await render(
      "{% form 'product', product %}x{% endform %}",
      { product: { id: 1, variants: [{ id: 101 }, { id: 102 }] } },
    )
    expect(out).toContain('<input type="hidden" name="id" value="101" />')
  })

  it('product form with no variants emits no id hidden input', async () => {
    const out = await render(
      "{% form 'product', product %}x{% endform %}",
      { product: { id: 5 } },
    )
    expect(out).not.toContain('name="id"')
    expect(out).toContain('id="product_form_5"')
  })

  it('new_comment uses article.url/id', async () => {
    const out = await render(
      "{% form 'new_comment', article %}x{% endform %}",
      { article: { id: 7, url: '/blogs/news/hello' } },
    )
    expect(out).toContain('action="/blogs/news/hello/comments"')
    expect(out).toContain('id="article-7-comment-form"')
  })
})

// ---------------------------------------------------------------------------
// CSRF handling
// ---------------------------------------------------------------------------

describe('{% form %} — CSRF + env hooks', () => {
  it('emits authenticity_token when csrf_token is in environments', async () => {
    // We can't set environments directly via parseAndRender, so use
    // parse + Context.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = new (await import('liquidjs')).Context(
      {},
      liquid.options,
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(ctx as any).environments.csrf_token = 'deadbeef'
    const tpls = liquid.parse("{% form 'contact' %}x{% endform %}")
    const out = await liquid.render(tpls, ctx)
    expect(out).toContain(
      '<input type="hidden" name="authenticity_token" value="deadbeef" />',
    )
  })

  it('omits authenticity_token when csrf_token is absent', async () => {
    const out = await render("{% form 'contact' %}x{% endform %}")
    expect(out).not.toContain('name="authenticity_token"')
  })

  it('HTML-escapes the CSRF token to prevent attribute injection', async () => {
    const { Context } = await import('liquidjs')
    const ctx = new Context({}, liquid.options)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(ctx as any).environments.csrf_token = 'a"b<c>'
    const tpls = liquid.parse("{% form 'contact' %}x{% endform %}")
    const out = await liquid.render(tpls, ctx)
    expect(out).toContain(
      '<input type="hidden" name="authenticity_token" value="a&quot;b&lt;c&gt;" />',
    )
  })
})

// ---------------------------------------------------------------------------
// form drop in body scope
// ---------------------------------------------------------------------------

describe('{% form %} — form drop in body', () => {
  it('form.id exposes the form id', async () => {
    const out = await render("{% form 'contact' %}[{{ form.id }}]{% endform %}")
    expect(out).toContain('[contact_form]')
  })

  it('form.errors defaults to empty (size=0)', async () => {
    const out = await render(
      "{% form 'contact' %}{{ form.errors.size }}{% endform %}",
    )
    expect(out).toContain('>0<')
  })

  it('form.errors is populated from ctx.environments.form_state', async () => {
    const { Context } = await import('liquidjs')
    const ctx = new Context({}, liquid.options)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(ctx as any).environments.form_state = {
      contact: { errors: ['email', 'body'] },
    }
    const tpls = liquid.parse(
      "{% form 'contact' %}[{% for e in form.errors %}{{ e }},{% endfor %}]{% endform %}",
    )
    const out = await liquid.render(tpls, ctx)
    expect(out).toContain('[email,body,]')
  })

  it('form.posted_successfully? reflects form_state flag', async () => {
    const { Context } = await import('liquidjs')
    const ctx = new Context({}, liquid.options)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(ctx as any).environments.form_state = {
      contact: { posted_successfully: true },
    }
    const tpls = liquid.parse(
      "{% form 'contact' %}{% if form.posted_successfully? %}YES{% else %}NO{% endif %}{% endform %}",
    )
    const out = await liquid.render(tpls, ctx)
    expect(out).toContain('YES')
  })

  it('form drop does NOT leak into parent scope after endform', async () => {
    const out = await render(
      "{% form 'contact' %}inside{% endform %}[{{ form.id }}]",
    )
    // `form` is undefined outside; strictVariables:false → empty
    expect(out).toMatch(/<\/form>\[\]$/)
  })
})

// ---------------------------------------------------------------------------
// Body rendering
// ---------------------------------------------------------------------------

describe('{% form %} — body rendering', () => {
  it('renders full Liquid inside the body', async () => {
    const out = await render(
      "{% form 'contact' %}<p>Hello {{ name }}</p>{% endform %}",
      { name: 'Thai' },
    )
    expect(out).toContain('<p>Hello Thai</p>')
  })

  it('body can render for loops and conditionals', async () => {
    const out = await render(
      "{% form 'contact' %}{% for x in items %}{{ x }},{% endfor %}{% endform %}",
      { items: [1, 2, 3] },
    )
    expect(out).toContain('1,2,3,')
  })
})

// ---------------------------------------------------------------------------
// Parse-time errors
// ---------------------------------------------------------------------------

describe('{% form %} — parse errors', () => {
  it('throws on unknown form type', () => {
    expect(() =>
      liquid.parse("{% form 'bogus' %}x{% endform %}"),
    ).toThrow(/unknown form type 'bogus'/)
  })

  it('throws on missing form type', () => {
    expect(() => liquid.parse('{% form %}x{% endform %}')).toThrow(
      /{% form %} args must be/,
    )
  })

  it('throws on unquoted form type', () => {
    expect(() =>
      liquid.parse('{% form contact %}x{% endform %}'),
    ).toThrow(/{% form %} args must be/)
  })

  it('throws when endform is missing', () => {
    expect(() => liquid.parse("{% form 'contact' %}x")).toThrow(
      /not closed/,
    )
  })
})

// ---------------------------------------------------------------------------
// FORM_HANDLERS structural check (guards against accidental removal)
// ---------------------------------------------------------------------------

describe('FORM_HANDLERS dispatch table', () => {
  it('exposes the 13 Shopify-supported form types', () => {
    const names = Object.keys(FORM_HANDLERS).sort()
    expect(names).toEqual(
      [
        'activate_customer_password',
        'cart',
        'contact',
        'create_customer',
        'currency',
        'customer',
        'customer_address',
        'customer_login',
        'customer_register',
        'localization',
        'new_comment',
        'product',
        'recover_customer_password',
        'reset_customer_password',
        'storefront_password',
      ].sort(),
    )
  })

  it('every handler has an action field', () => {
    for (const [name, h] of Object.entries(FORM_HANDLERS)) {
      expect(h.action, `${name} must define action`).toBeDefined()
    }
  })
})
