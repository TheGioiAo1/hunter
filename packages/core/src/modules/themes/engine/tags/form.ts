/**
 * Gbox Platform — `{% form 'type', object %}` tag
 *
 * Decision #1 Step 1.9 — Shopify-flavored `{% form %}` block tag.
 *
 * Shopify themes wrap every front-end form in `{% form %}`:
 *
 *   {% form 'contact' %}
 *     <input type="email" name="contact[email]">
 *     <textarea name="contact[body]"></textarea>
 *     <button type="submit">Send</button>
 *   {% endform %}
 *
 * The tag expands to a `<form>` element with:
 *   - method="post"
 *   - action="..."                  (dispatch table, per form type)
 *   - accept-charset="UTF-8"        (Shopify default; legacy but harmless)
 *   - optional id="..." + class="..."
 *   - hidden inputs: form_type, utf8, authenticity_token, plus any
 *     type-specific hiddens (e.g. product variant id, address _method).
 *
 * Inside the block, a `form` drop is injected into scope so themes
 * can render error messages and re-populate fields on POST-back:
 *
 *   {% form 'contact' %}
 *     {% if form.errors %}
 *       <ul>{% for f in form.errors %}<li>{{ form.errors.messages[f] }}</li>{% endfor %}</ul>
 *     {% endif %}
 *     {% if form.posted_successfully? %} Thanks! {% endif %}
 *   {% endform %}
 *
 * Supported form types (13) — matches Shopify's built-in set:
 *
 *   contact, customer_login, create_customer, customer_register
 *   (alias), customer_address, customer, activate_customer_password,
 *   recover_customer_password, reset_customer_password,
 *   storefront_password, product, cart, new_comment, localization,
 *   currency (alias of localization).
 *
 * Runtime state injection:
 *
 *   CSRF token is read from `ctx.environments.csrf_token`. If unset
 *   (dev/tests), the `authenticity_token` hidden input is omitted —
 *   it's not fatal because the render pipeline (Step 1.10) will add
 *   the real token before the response reaches the client. Sites
 *   running locally without the pipeline simply get an inert form.
 *
 *   Form post-back state (errors, posted_successfully, re-populated
 *   fields) is read from `ctx.environments.form_state[type]`. The
 *   storefront route handler stuffs this into environments after a
 *   validation failure or a successful POST so the same template can
 *   re-render with the merchant-facing error UI. Absent = fresh form.
 *
 *   Both hooks are environment-based (not register-based) because
 *   they're INPUTS from the outer controller, not captures from the
 *   template body — same policy as `shop`, `cart`, `request`, etc.
 *
 * Parse-time strictness:
 *
 *   We accept exactly one form type (quoted string literal) plus one
 *   optional positional object expression. We do NOT accept hash args
 *   (`{% form 'customer_address', address, id: 'x' %}`) in this step
 *   — Shopify accepts them but they're used by <1% of themes; adding
 *   support is cheap in a later step. Raising a clear parse error is
 *   better than silently ignoring.
 *
 * Missing form type → parse error (not runtime). Same rationale as
 * `{% layout %}`: errors at parse time beat errors at production
 * traffic time.
 */

import {
  Tag,
  Value,
  type Liquid,
  type Context,
  type Emitter,
  type Parser,
  type Template,
  type TagToken,
  type TopLevelToken,
} from 'liquidjs'

// ---------------------------------------------------------------------------
// Dispatch table — form type → action, id, hidden inputs
// ---------------------------------------------------------------------------

/**
 * One entry per Shopify-supported form type. `action`/`id` may be
 * either a static string or a function that derives the value from
 * the positional object arg (address, product, article…).
 *
 * `hiddenInputs` returns additional `<input type="hidden">` pairs
 * specific to the form type. `className` is written into the form's
 * class attribute (Shopify uses this for e.g. product forms).
 */
interface FormHandler {
  action: string | ((obj: FormObject) => string)
  id?: string | ((obj: FormObject) => string)
  className?: string
  hiddenInputs?: (obj: FormObject) => Array<readonly [string, string]>
}

/** Loosely typed form object — just enough shape for the handlers. */
interface FormObject {
  id?: string | number
  handle?: string
  url?: string
  variants?: Array<{ id?: string | number }>
  selected_or_first_available_variant?: { id?: string | number }
  [key: string]: unknown
}

function str(v: unknown): string {
  if (v === null || v === undefined) return ''
  return String(v)
}

/**
 * The full dispatch table. Exported for tests so contributors can
 * assert exact URLs without black-box parsing.
 */
export const FORM_HANDLERS: Readonly<Record<string, FormHandler>> = Object.freeze({
  contact: {
    action: '/contact#contact_form',
    id: 'contact_form',
  },

  customer_login: {
    action: '/account/login',
    id: 'customer_login',
  },

  create_customer: {
    action: '/account',
    id: 'create_customer',
  },
  // Older theme docs use `customer_register` — alias.
  customer_register: {
    action: '/account',
    id: 'create_customer',
  },

  customer: {
    action: '/account',
    id: 'customer_form',
  },

  customer_address: {
    action: (obj: FormObject): string => {
      const id = obj && obj.id !== undefined ? str(obj.id) : ''
      return id ? `/account/addresses/${id}` : '/account/addresses'
    },
    id: (obj: FormObject): string => {
      const id = obj && obj.id !== undefined ? str(obj.id) : ''
      return id ? `edit_address_${id}` : 'address_form_new'
    },
    // Editing an existing address uses HTTP PUT, which HTML forms
    // can't emit natively; Shopify follows the Rails convention of
    // a `_method=put` hidden input that the server-side parses.
    hiddenInputs: (obj: FormObject) => {
      const id = obj && obj.id !== undefined ? str(obj.id) : ''
      return id ? [['_method', 'put'] as const] : []
    },
  },

  activate_customer_password: {
    action: '/account/activate',
    id: 'activate_customer_password',
  },

  recover_customer_password: {
    action: '/account/recover',
    id: 'recover_customer_password',
  },

  reset_customer_password: {
    action: '/account/reset',
    id: 'reset_customer_password',
  },

  storefront_password: {
    action: '/password',
    id: 'login_form',
  },

  product: {
    action: '/cart/add',
    className: 'shopify-product-form',
    id: (obj: FormObject): string => {
      const id = obj && obj.id !== undefined ? str(obj.id) : ''
      return id ? `product_form_${id}` : 'product_form'
    },
    hiddenInputs: (obj: FormObject) => {
      // Priority 1: explicitly selected variant (Shopify's modern
      // product object has `.selected_or_first_available_variant`).
      const sel = obj?.selected_or_first_available_variant?.id
      if (sel !== undefined) return [['id', str(sel)] as const]
      // Priority 2: first variant in the list (legacy themes).
      const first = obj?.variants?.[0]?.id
      if (first !== undefined) return [['id', str(first)] as const]
      return []
    },
  },

  cart: {
    action: '/cart',
    id: 'cart',
    className: 'cart',
  },

  new_comment: {
    // `/blogs/<blog>/<article>/comments` — Shopify's article.url is
    // already the full article path, so we append `/comments`.
    action: (obj: FormObject): string => {
      const url = obj && typeof obj.url === 'string' ? obj.url : ''
      return url ? `${url}/comments` : '/comments'
    },
    id: (obj: FormObject): string => {
      const id = obj && obj.id !== undefined ? str(obj.id) : ''
      return id ? `article-${id}-comment-form` : 'comment_form'
    },
  },

  localization: {
    action: '/localization',
    id: 'localization_form',
    className: 'shopify-localization-form',
  },
  // Shopify also ships `{% form 'currency' %}` which hits the same
  // endpoint; we alias it.
  currency: {
    action: '/localization',
    id: 'currency_form',
    className: 'shopify-currency-form',
  },
})

// ---------------------------------------------------------------------------
// Argument parsing — regex approach
// ---------------------------------------------------------------------------

/**
 * Parse the raw `{% form ... %}` args string into
 * `{ formType, objectExpression }`. Uses a single regex rather than
 * walking the tokenizer because form args are always exactly
 * `'type'` or `'type', expr` — there's no hash support in this
 * step, so a regex is clearer and has fewer failure modes.
 *
 * Accepts single OR double quotes around the form type. Rejects
 * unquoted / missing type. Trailing expression is captured verbatim
 * and handed to `new Value()` for lazy evaluation at render time.
 */
function parseFormArgs(
  argsText: string,
): { formType: string; objectExpression?: string } {
  const trimmed = argsText.trim()
  const match = /^(['"])([^'"]+)\1(?:\s*,\s*(.+?))?\s*$/.exec(trimmed)
  if (!match) {
    throw new Error(
      `[gbox-engine] {% form %} args must be "'type'" or "'type', object"; got: ${argsText}`,
    )
  }
  const formType = match[2]
  const objectExpression = match[3]?.trim()
  return objectExpression
    ? { formType, objectExpression }
    : { formType }
}

// ---------------------------------------------------------------------------
// HTML escape — shared with other tag files
// ---------------------------------------------------------------------------

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

/**
 * Pull the CSRF token out of the render environment. The render
 * pipeline (Step 1.10) stashes it there per-request. Absent in tests
 * and in the default `parseAndRender()` call, so this returns `''`
 * and the form tag skips the hidden input — still produces valid
 * HTML, just not session-bound.
 */
function csrfTokenFrom(ctx: Context): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env = ctx.environments as any
  const val = env?.csrf_token ?? env?.authenticity_token
  return typeof val === 'string' ? val : ''
}

/**
 * Pull the form post-back state for `formType` out of the render
 * environment. Returns an empty object when absent (fresh form).
 */
function formStateFrom(
  ctx: Context,
  formType: string,
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env = ctx.environments as any
  const byType = env?.form_state
  if (!byType || typeof byType !== 'object') return {}
  const state = byType[formType]
  return state && typeof state === 'object' ? state : {}
}

// ---------------------------------------------------------------------------
// Tag registration
// ---------------------------------------------------------------------------

export function registerFormTag(liquid: Liquid): void {
  class FormTag extends Tag {
    private readonly formType: string
    private readonly objectValue?: Value
    private readonly templates: Template[] = []

    constructor(
      tagToken: TagToken,
      remainTokens: TopLevelToken[],
      liquidInstance: Liquid,
      parser: Parser,
    ) {
      super(tagToken, remainTokens, liquidInstance)

      // Parse the header args (form type + optional positional object).
      const parsed = parseFormArgs(tagToken.args)
      if (!FORM_HANDLERS[parsed.formType]) {
        throw new Error(
          `[gbox-engine] {% form %} unknown form type '${parsed.formType}'. ` +
            `Known types: ${Object.keys(FORM_HANDLERS).join(', ')}`,
        )
      }
      this.formType = parsed.formType
      if (parsed.objectExpression) {
        // `Value` accepts a raw expression string and lazily evaluates
        // it against the render-time Context.
        this.objectValue = new Value(parsed.objectExpression, liquidInstance)
      }

      // Walk body tokens until we find `{% endform %}`, collecting
      // parsed templates. Mirrors LiquidJS's built-in for/if tags.
      const tpls = this.templates
      const stream = parser
        .parseStream(remainTokens)
        .on('template', (tpl: Template) => {
          tpls.push(tpl)
        })
        .on('tag:endform', function (this: { stop(): void }) {
          this.stop()
        })
        .on('end', () => {
          throw new Error(
            `[gbox-engine] {% form %} not closed (expected {% endform %})`,
          )
        })
      stream.start()
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    *render(ctx: Context, emitter: Emitter): Generator<unknown, void, any> {
      const handler = FORM_HANDLERS[this.formType]!

      // Evaluate the optional object expression (product, address, ...).
      // `Value.value()` is a generator — yielding defers to LiquidJS's
      // async evaluator, which handles async drops and filter chains.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawObj: unknown = this.objectValue
        ? yield this.objectValue.value(ctx)
        : undefined
      const obj: FormObject = (
        rawObj && typeof rawObj === 'object' ? rawObj : {}
      ) as FormObject

      // Resolve dispatch-table bits against the object.
      const action =
        typeof handler.action === 'function' ? handler.action(obj) : handler.action
      const id =
        typeof handler.id === 'function' ? handler.id(obj) : handler.id
      const className = handler.className
      const extraHiddens = handler.hiddenInputs ? handler.hiddenInputs(obj) : []

      // --- Open tag -------------------------------------------------------
      let open = `<form method="post" action="${htmlEscape(action)}"`
      if (id) open += ` id="${htmlEscape(id)}"`
      if (className) open += ` class="${htmlEscape(className)}"`
      open += ' accept-charset="UTF-8">'
      emitter.write(open)

      // --- Hidden inputs --------------------------------------------------
      // `form_type` is how Shopify's server-side routes the POST; the
      // URL alone is ambiguous (e.g. /account handles both customer
      // update AND create_customer).
      emitter.write(
        `<input type="hidden" name="form_type" value="${htmlEscape(
          this.formType,
        )}" />`,
      )
      // `utf8=✓` is a Rails-era sentinel that tells the server the
      // browser submitted UTF-8. Shopify still emits it for back-compat
      // with older merchant integrations, so we match.
      emitter.write(`<input type="hidden" name="utf8" value="\u2713" />`)
      // CSRF: only emit if the render pipeline set one. Absent = dev
      // mode, tag stays inert rather than failing.
      const csrf = csrfTokenFrom(ctx)
      if (csrf) {
        emitter.write(
          `<input type="hidden" name="authenticity_token" value="${htmlEscape(
            csrf,
          )}" />`,
        )
      }
      // Type-specific hiddens (variant id for product, _method=put for
      // address edit, …).
      for (const [name, value] of extraHiddens) {
        emitter.write(
          `<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(
            value,
          )}" />`,
        )
      }

      // --- Inner body -----------------------------------------------------
      // Build the `form` drop from post-back state and push it onto a
      // new scope frame, so the body sees `{{ form.errors }}` etc.
      // without leaking the drop into the parent scope.
      const state = formStateFrom(ctx, this.formType)
      const formDrop: Record<string, unknown> = {
        id: id ?? '',
        errors: state.errors ?? [],
        // Shopify uses Liquid's `?` suffix convention for booleans.
        // LiquidJS passes property names through unchanged, so a
        // template-side `{% if form.posted_successfully? %}` maps to
        // this literal key.
        'posted_successfully?': state.posted_successfully ?? false,
        // Merge type-specific fields from post-back state (email,
        // body, name, message, …). Spread LAST so `state` can override
        // our defaults where needed — but `id` and `errors` are still
        // pinned by the explicit assigns above.
        ...state,
      }
      // Re-pin the three canonical fields in case `state` overwrote
      // them with the wrong shapes.
      formDrop.id = id ?? state.id ?? ''
      formDrop.errors = state.errors ?? []
      formDrop['posted_successfully?'] = state.posted_successfully ?? false

      ctx.push({ form: formDrop })
      try {
        yield this.liquid.renderer.renderTemplates(this.templates, ctx, emitter)
      } finally {
        ctx.pop()
      }

      // --- Close tag ------------------------------------------------------
      emitter.write('</form>')
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  liquid.registerTag('form', FormTag as any)
}
