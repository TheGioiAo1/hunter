/**
 * Gbox Checkout — main 3-step page
 *
 *   Step 1 (info)    : email + shipping address
 *   Step 2 (shipping): shipping rate selection
 *   Step 3 (payment) : PayPal + Venmo buttons (via the storefront-loader SDK tag)
 *
 * Everything is server-rendered. The only browser JS is the single
 * bootstrap script at `/static/checkout-init.js` which loads the PayPal
 * SDK, mounts the buttons, and POSTs back the capture result. There is
 * NO merchant-controlled code, no SPA framework, and no inline scripts.
 *
 * Data flow:
 *   GET  /c/:checkoutId
 *     → platformApi('/api/checkout/:id') → { checkout, shop }
 *     → detect current step from checkout state
 *     → render that step + order summary
 *
 *   POST /c/:checkoutId/email
 *   POST /c/:checkoutId/shipping
 *   POST /c/:checkoutId/rate
 *     → re-fetch checkout to learn the shop slug
 *     → PUT /api/store/:slug/checkout/:id/...
 *     → 303 redirect back to GET /c/:id (Post/Redirect/Get)
 *
 * Why PRG after POST? Keeps refresh idempotent, avoids duplicate form
 * submissions on browser reload, and lets each step flow into the next
 * naturally as the checkout session gains fields.
 */

import type { Request, Response } from 'express'
import { platformApi, PlatformApiError } from '../lib/api-client.js'
import { renderLayout, esc } from '../components/layout.js'
// Phase 0 Step 0.4b: CSRF on the guest-checkout forms. This is a
// public flow without a session cookie, but the three POSTs
// (email, shipping address, shipping rate) all mutate the checkout
// server-side; we still want a same-origin form proof so a drive-by
// page can't stuff a buyer's address into an arbitrary checkout by
// guessing the id. One token per page render is enough because all
// three forms live in the same response and the user only submits
// one at a time.
import { createCsrfStore } from '@gbox/core/modules/auth/csrf-express.js'

// ---------------------------------------------------------------------------
// Module-level CSRF store
// ---------------------------------------------------------------------------

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_checkout' })

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

// ---------------------------------------------------------------------------
// Types (mirror the Platform API response; keep loose — the page should
// not care about every field the API may return in the future.)
// ---------------------------------------------------------------------------

export interface ApiCheckout {
  id: string
  shop_id: string
  email: string | null
  line_items: Array<{
    variant_id: string
    product_id: string
    title: string
    variant_title: string | null
    price: string
    quantity: number
    image_url: string | null
    requires_shipping: boolean
    taxable: boolean
  }>
  shipping_address: {
    first_name?: string | null
    last_name?: string | null
    address1?: string | null
    address2?: string | null
    city?: string | null
    province?: string | null
    country?: string | null
    country_code?: string | null
    zip?: string | null
    phone?: string | null
  } | null
  shipping_rate: {
    id: string
    name: string
    price: string
    type: string
  } | null
  /**
   * Phase 5 PR1 — whatever discount is applied to this checkout (buyer-entered
   * or automatically matched), null otherwise.
   *
   * PR3 widened `code` to `string | null` because an automatic discount
   * without a code is valid (the merchant may never have assigned one).
   * `is_automatic` is optional for back-compat with older Redis sessions
   * stamped before the flag existed — treat undefined as `false` in the UI.
   */
  discount: {
    code: string | null
    discount_id: string
    type: string
    value: string
    value_type: string
    amount: string
    is_automatic?: boolean
  } | null
  subtotal_price: string
  total_shipping: string
  total_tax: string
  total_discounts: string
  total_price: string
  currency: string
  completed_at: string | null
}

interface ApiShop {
  id: string
  slug: string
  name: string
  currency: string
  domain: string | null
}

interface CheckoutReadResponse {
  checkout: ApiCheckout
  shop: ApiShop
}

interface ShippingRate {
  id: string
  name: string
  price: string
  type: string
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchCheckout(
  req: Request,
  checkoutId: string,
): Promise<CheckoutReadResponse | null> {
  try {
    return await platformApi<CheckoutReadResponse>(
      `/api/checkout/${encodeURIComponent(checkoutId)}`,
      { forwardFrom: req },
    )
  } catch (err) {
    if (err instanceof PlatformApiError && err.status === 404) return null
    throw err
  }
}

async function fetchShippingRates(
  req: Request,
  slug: string,
  checkoutId: string,
): Promise<ShippingRate[]> {
  try {
    const out = await platformApi<{ shipping_rates: ShippingRate[] }>(
      `/api/store/${encodeURIComponent(slug)}/checkout/${encodeURIComponent(checkoutId)}/shipping-rates`,
      { forwardFrom: req },
    )
    return out.shipping_rates ?? []
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Money formatting
// ---------------------------------------------------------------------------

function fmt(amount: string | number, currency: string): string {
  const n = typeof amount === 'string' ? parseFloat(amount) : amount
  if (!Number.isFinite(n)) return `${currency} 0.00`
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
    }).format(n)
  } catch {
    return `${currency} ${n.toFixed(2)}`
  }
}

// ---------------------------------------------------------------------------
// Current-step detection — the checkout session is a state machine,
// and the step is a derived projection of which fields are filled in.
// ---------------------------------------------------------------------------

export type Step = 'info' | 'shipping' | 'payment'

/**
 * Derive the current checkout step from the session state.
 *
 * Exported for unit-testing; the HTTP route uses this privately. Keep
 * this function pure — do not add fetches or side effects.
 */
export function currentStep(c: ApiCheckout): Step {
  if (!c.email) return 'info'
  const addr = c.shipping_address
  const needsShipping = c.line_items.some((li) => li.requires_shipping)
  if (needsShipping) {
    if (!addr || !addr.address1 || !addr.city || !addr.zip || !(addr.country_code || addr.country)) {
      return 'info'
    }
    if (!c.shipping_rate) return 'shipping'
  }
  return 'payment'
}

// ---------------------------------------------------------------------------
// Small render fragments
// ---------------------------------------------------------------------------

function renderStepsNav(step: Step): string {
  const cls = (name: Step) =>
    step === name
      ? 'active'
      : (['info', 'shipping', 'payment'] as Step[]).indexOf(step) >
          (['info', 'shipping', 'payment'] as Step[]).indexOf(name)
        ? 'done'
        : ''
  return `
    <ul class="steps" aria-label="Checkout progress">
      <li class="${cls('info')}">1. Information</li>
      <li class="${cls('shipping')}">2. Shipping</li>
      <li class="${cls('payment')}">3. Payment</li>
    </ul>
  `
}

/**
 * Render the discount code row in the order summary sidebar.
 *
 * Four visual states:
 *   - applied + automatic (is_automatic=true): green "Automatic" pill with
 *     the code (if any) or a generic "Auto-applied" label; no remove button
 *     because the service re-applies it at every recalc anyway. Pressing
 *     remove would just make it reappear on the next leg of the flow and
 *     confuse the buyer.
 *   - applied + code: dashed pill with code + remove "×" button
 *   - empty + error: inline input with red helper text below
 *   - empty + no error: plain input
 *
 * Kept CSRF-protected via the same `gbox_csrf_checkout` cookie every
 * other step uses. The remove form POSTs to a dedicated endpoint so we
 * don't overload the apply endpoint with a "mode" param.
 */
function renderDiscountRow(
  c: ApiCheckout,
  csrfToken: string,
  errorMessage: string | null,
): string {
  const csrfField = csrfStore.hiddenField(csrfToken)
  if (c.discount) {
    const isAuto = c.discount.is_automatic === true
    if (isAuto) {
      // Auto-applied discounts may or may not have a code. When there's
      // no code the merchant configured it as a pure silent promotion
      // (e.g. "automatic 10% off over $100") — show a generic label.
      const label = c.discount.code
        ? esc(c.discount.code)
        : 'Auto-applied promotion'
      return `
        <div class="discount-row applied auto" style="margin:12px 0;padding:10px;border:1px solid #10b98133;background:#10b9810d;border-radius:6px;display:flex;align-items:center;gap:8px">
          <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;background:#10b981;color:#fff;padding:2px 6px;border-radius:4px">Auto</span>
          <strong style="flex:1">${label}</strong>
          <span style="font-size:12px;color:var(--muted)" title="This promotion is applied automatically by the store and cannot be removed here.">Applied automatically</span>
        </div>
      `
    }
    // Code-based discount: buyer typed it in, so buyer can remove it.
    // `code` can technically still be null (older Redis sessions from
    // before PR3) — fall back to a label in that case.
    const label = c.discount.code ? esc(c.discount.code) : 'Discount'
    return `
      <div class="discount-row applied" style="margin:12px 0;padding:10px;border:1px dashed var(--border);border-radius:6px;display:flex;align-items:center;gap:8px">
        <span style="font-size:13px;color:var(--muted)">Code</span>
        <strong style="flex:1">${label}</strong>
        <form method="POST" action="/c/${esc(c.id)}/discount/remove" style="margin:0">
          ${csrfField}
          <button type="submit" class="btn-link" aria-label="Remove discount"
            style="background:none;border:0;color:var(--muted);cursor:pointer;font-size:18px;padding:0 4px">×</button>
        </form>
      </div>
    `
  }
  return `
    <form method="POST" action="/c/${esc(c.id)}/discount"
      class="discount-row" style="margin:12px 0;display:flex;gap:8px;align-items:flex-start">
      ${csrfField}
      <div style="flex:1;display:flex;flex-direction:column;gap:4px">
        <input type="text" name="code" placeholder="Discount code"
          maxlength="64" autocomplete="off" spellcheck="false"
          aria-label="Discount code"
          style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:14px"
          value="">
        ${errorMessage ? `<span style="color:#b91c1c;font-size:12px">${esc(errorMessage)}</span>` : ''}
      </div>
      <button type="submit" class="btn btn-secondary"
        style="padding:8px 14px;font-size:14px">Apply</button>
    </form>
  `
}

/**
 * Phase 10 PR2 — Gift card row in the order summary sidebar.
 *
 * The buyer types a code and clicks "Check". We POST to the checkout
 * app which proxies to the Platform API's validate endpoint. On
 * success we show a green banner with the applicable amount; on
 * failure we paint a one-line error under the input.
 *
 * This is a read-only preview (the actual redemption fires during
 * order completion when the orders module wires in the balance
 * deduction). The inline UI ensures the buyer can sanity-check the
 * code before reaching the pay button.
 */
function renderGiftCardRow(
  c: ApiCheckout,
  csrfToken: string,
  errorMessage: string | null,
  appliedMessage: string | null,
): string {
  const csrfField = csrfStore.hiddenField(csrfToken)
  return `
    <form method="POST" action="/c/${esc(c.id)}/gift-card"
      class="gift-card-row" style="margin:12px 0;display:flex;gap:8px;align-items:flex-start">
      ${csrfField}
      <div style="flex:1;display:flex;flex-direction:column;gap:4px">
        <input type="text" name="code" placeholder="Gift card code"
          maxlength="32" autocomplete="off" spellcheck="false"
          aria-label="Gift card code"
          style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:14px;font-family:monospace;letter-spacing:1px"
          value="">
        ${errorMessage ? `<span style="color:#b91c1c;font-size:12px">${esc(errorMessage)}</span>` : ''}
        ${appliedMessage ? `<span style="color:#059669;font-size:12px">${esc(appliedMessage)}</span>` : ''}
      </div>
      <button type="submit" class="btn btn-secondary"
        style="padding:8px 14px;font-size:14px">Check</button>
    </form>
  `
}

function renderOrderSummary(
  c: ApiCheckout,
  csrfToken: string,
  discountError: string | null,
  giftCardError: string | null,
  giftCardApplied: string | null,
): string {
  const items = c.line_items
    .map(
      (li) => `
        <div class="line-item">
          <span class="qty">${li.quantity}</span>
          <span class="title">
            ${esc(li.title)}${li.variant_title ? ` <span style="color:var(--muted);font-size:12px">· ${esc(li.variant_title)}</span>` : ''}
          </span>
          <span class="price">${esc(fmt(parseFloat(li.price) * li.quantity, c.currency))}</span>
        </div>
      `,
    )
    .join('')

  return `
    <aside class="card" aria-label="Order summary">
      <h2>Order summary</h2>
      ${items || '<p style="color:var(--muted);font-size:14px">Your cart is empty.</p>'}
      ${renderDiscountRow(c, csrfToken, discountError)}
      ${renderGiftCardRow(c, csrfToken, giftCardError, giftCardApplied)}
      <div style="margin-top:16px">
        <div class="summary-line"><span>Subtotal</span><span>${esc(fmt(c.subtotal_price, c.currency))}</span></div>
        <div class="summary-line"><span>Shipping</span><span>${c.shipping_rate ? esc(fmt(c.total_shipping, c.currency)) : '<span style="color:var(--muted)">Calculated at next step</span>'}</span></div>
        ${parseFloat(c.total_tax || '0') > 0 ? `<div class="summary-line"><span>Tax</span><span>${esc(fmt(c.total_tax, c.currency))}</span></div>` : ''}
        ${(() => {
          if (!(parseFloat(c.total_discounts || '0') > 0)) return ''
          // Discount line label: prefer the code, fall back to "Automatic"
          // for codeless automatic promotions, then generic "Discount".
          let label = 'Discount'
          if (c.discount?.code) {
            label = `Discount (${esc(c.discount.code)})`
          } else if (c.discount?.is_automatic) {
            label = 'Discount (automatic)'
          }
          return `<div class="summary-line"><span>${label}</span><span>-${esc(fmt(c.total_discounts, c.currency))}</span></div>`
        })()}
        <div class="summary-line total"><span>Total</span><span>${esc(fmt(c.total_price, c.currency))}</span></div>
      </div>
    </aside>
  `
}

// ---------------------------------------------------------------------------
// Step 1 — Information (email + shipping address)
// ---------------------------------------------------------------------------

function renderStepInfo(c: ApiCheckout, csrfToken: string): string {
  const addr = c.shipping_address ?? {}
  const v = (k: keyof NonNullable<ApiCheckout['shipping_address']>) =>
    esc((addr as any)[k] ?? '')
  const csrfField = csrfStore.hiddenField(csrfToken)
  return `
    <section class="card">
      ${renderStepsNav('info')}
      <h1>Contact & shipping</h1>
      <form method="POST" action="/c/${esc(c.id)}/email" autocomplete="on">
        ${csrfField}
        <div class="field">
          <label for="email">Email</label>
          <input type="email" name="email" id="email" required
            value="${esc(c.email ?? '')}" autocomplete="email" placeholder="you@example.com">
        </div>
        <button type="submit" class="btn">Save email</button>
      </form>

      <hr style="border:none;border-top:1px solid var(--border);margin:24px 0">

      <form method="POST" action="/c/${esc(c.id)}/shipping" autocomplete="on">
        ${csrfField}
        <h2>Shipping address</h2>
        <div class="row">
          <div class="field">
            <label for="first_name">First name</label>
            <input type="text" name="first_name" id="first_name" required
              value="${v('first_name')}" autocomplete="given-name">
          </div>
          <div class="field">
            <label for="last_name">Last name</label>
            <input type="text" name="last_name" id="last_name" required
              value="${v('last_name')}" autocomplete="family-name">
          </div>
        </div>
        <div class="field">
          <label for="address1">Address</label>
          <input type="text" name="address1" id="address1" required
            value="${v('address1')}" autocomplete="address-line1">
        </div>
        <div class="field">
          <label for="address2">Apartment, suite, etc. (optional)</label>
          <input type="text" name="address2" id="address2"
            value="${v('address2')}" autocomplete="address-line2">
        </div>
        <div class="row">
          <div class="field">
            <label for="city">City</label>
            <input type="text" name="city" id="city" required
              value="${v('city')}" autocomplete="address-level2">
          </div>
          <div class="field">
            <label for="province">State / Province</label>
            <input type="text" name="province" id="province"
              value="${v('province')}" autocomplete="address-level1">
          </div>
          <div class="field">
            <label for="zip">ZIP / Postal code</label>
            <input type="text" name="zip" id="zip" required
              value="${v('zip')}" autocomplete="postal-code">
          </div>
        </div>
        <div class="row">
          <div class="field">
            <label for="country_code">Country</label>
            <input type="text" name="country_code" id="country_code" required
              value="${v('country_code') || 'US'}" maxlength="2"
              autocomplete="country" placeholder="US">
          </div>
          <div class="field">
            <label for="phone">Phone (optional)</label>
            <input type="text" name="phone" id="phone"
              value="${v('phone')}" autocomplete="tel">
          </div>
        </div>
        <button type="submit" class="btn">Continue to shipping</button>
      </form>
    </section>
  `
}

// ---------------------------------------------------------------------------
// Step 2 — Shipping rate selection
// ---------------------------------------------------------------------------

function renderStepShipping(
  c: ApiCheckout,
  rates: ShippingRate[],
  csrfToken: string,
): string {
  const rows =
    rates.length === 0
      ? `<p class="error">No shipping rates available for the address you entered. Please go back and check the country / ZIP.</p>`
      : rates
          .map(
            (r, i) => `
        <label class="field" style="display:flex;gap:12px;align-items:center;padding:12px;border:1px solid var(--border);border-radius:6px;cursor:pointer;margin-bottom:8px">
          <input type="radio" name="rate_id" value="${esc(r.id)}" ${i === 0 ? 'checked' : ''} required>
          <span style="flex:1">
            <strong>${esc(r.name)}</strong>
            <input type="hidden" name="name_${esc(r.id)}" value="${esc(r.name)}">
          </span>
          <span>${esc(fmt(r.price, c.currency))}</span>
          <input type="hidden" name="price_${esc(r.id)}" value="${esc(r.price)}">
          <input type="hidden" name="type_${esc(r.id)}" value="${esc(r.type)}">
        </label>
      `,
          )
          .join('')

  return `
    <section class="card">
      ${renderStepsNav('shipping')}
      <h1>Shipping method</h1>
      <p style="color:var(--muted);font-size:13px;margin-top:-12px;margin-bottom:20px">
        Shipping to ${esc([
          c.shipping_address?.address1,
          c.shipping_address?.city,
          c.shipping_address?.province,
          c.shipping_address?.zip,
          c.shipping_address?.country_code ?? c.shipping_address?.country,
        ].filter(Boolean).join(', '))}
        · <a href="/c/${esc(c.id)}" class="btn-link">Change</a>
      </p>
      <form method="POST" action="/c/${esc(c.id)}/rate">
        ${csrfStore.hiddenField(csrfToken)}
        ${rows}
        ${rates.length > 0 ? '<button type="submit" class="btn">Continue to payment</button>' : ''}
      </form>
    </section>
  `
}

// ---------------------------------------------------------------------------
// Step 3 — Payment (PayPal + Venmo buttons)
// ---------------------------------------------------------------------------

function renderStepPayment(c: ApiCheckout, shop: ApiShop): string {
  return `
    <section class="card">
      ${renderStepsNav('payment')}
      <h1>Payment</h1>
      <p style="color:var(--muted);font-size:13px;margin-top:-12px;margin-bottom:20px">
        ${c.email ? `Paying as <strong>${esc(c.email)}</strong>` : ''}
        · <a href="/c/${esc(c.id)}" class="btn-link">Change</a>
      </p>

      <div id="gbox-checkout-meta"
           data-checkout-id="${esc(c.id)}"
           data-shop-slug="${esc(shop.slug)}"
           data-currency="${esc(c.currency || shop.currency || 'USD')}"
           data-country="${esc(c.shipping_address?.country_code || 'US')}"
           data-total="${esc(c.total_price)}"
           data-thankyou-url="/c/${esc(c.id)}/thankyou"
           data-paypal-sdk-url="/api/store/${esc(shop.slug)}/payments/paypal-partner/sdk-tag"
           data-paypal-create-url="/api/checkout/${esc(c.id)}/paypal/create"
           data-paypal-capture-url="/api/checkout/${esc(c.id)}/paypal/capture"
           hidden></div>

      <div id="gbox-paypal-buttons" role="region" aria-label="PayPal and Venmo buttons"></div>
      <div id="gbox-pay-status" class="pay-block-status">Loading secure payment…</div>
    </section>
  `
}

// ---------------------------------------------------------------------------
// GET /c/:checkoutId — main entry point
// ---------------------------------------------------------------------------

export async function getCheckoutPage(
  req: Request,
  res: Response,
  ctx: { checkoutId: string },
): Promise<void> {
  let data: CheckoutReadResponse | null
  try {
    data = await fetchCheckout(req, ctx.checkoutId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    res
      .status(502)
      .type('html')
      .send(
        renderLayout({
          title: 'Checkout unavailable',
          checkoutId: ctx.checkoutId,
          body: `<section class="card" style="grid-column:1/-1">
            <h1>Checkout unavailable</h1>
            <p>We can\u2019t reach the Gbox Platform API right now. Please try again in a moment.</p>
            <p style="color:var(--muted);font-size:13px">${esc(msg)}</p>
          </section>`,
        }),
      )
    return
  }

  if (!data) {
    res
      .status(404)
      .type('html')
      .send(
        renderLayout({
          title: 'Checkout not found',
          checkoutId: ctx.checkoutId,
          body: `<section class="card" style="grid-column:1/-1">
            <h1>Checkout not found</h1>
            <p>We couldn\u2019t load this checkout session. It may have expired (sessions are kept for 1 hour). Return to the store and add your items to the cart again.</p>
          </section>`,
        }),
      )
    return
  }

  const { checkout, shop } = data

  // Already paid? Bounce to the thank-you page.
  if (checkout.completed_at) {
    res.redirect(302, `/c/${encodeURIComponent(ctx.checkoutId)}/thankyou`)
    return
  }

  const step = currentStep(checkout)

  // Issue a single CSRF token for whichever step is about to render.
  // The payment step has no POST form (PayPal SDK handles capture),
  // so it doesn't need a token, but issuing one is harmless and keeps
  // the page render path simple.
  const csrfToken = await csrfStore.issue(res, isProduction())

  let stepHtml: string
  if (step === 'info') {
    stepHtml = renderStepInfo(checkout, csrfToken)
  } else if (step === 'shipping') {
    const rates = await fetchShippingRates(req, shop.slug, checkout.id)
    stepHtml = renderStepShipping(checkout, rates, csrfToken)
  } else {
    stepHtml = renderStepPayment(checkout, shop)
  }

  // On the payment step we need three things injected into <head>:
  //   1. The bootstrap script (defer so the body renders first).
  //   2. A <meta name="gbox-api-base"> tag so the script knows where to
  //      POST the create/capture calls. In production the host-based
  //      fallback (`checkout.<x>` → `api.<x>`) works, but dev/staging
  //      need an explicit override.
  const apiBase = process.env.PLATFORM_API_BASE_URL ?? ''
  const headScripts =
    step === 'payment'
      ? '<script src="/static/checkout-init.js" defer></script>'
      : ''
  const headLinks =
    step === 'payment' && apiBase
      ? `<meta name="gbox-api-base" content="${esc(apiBase)}">`
      : ''

  // Phase 5 PR1 — render inline discount error if the previous POST
  // bounced us back with `?discount_error=...`. We clamp the length so a
  // very long URL-stuffed message can't blow up the page layout.
  const discountErrorRaw =
    typeof req.query.discount_error === 'string'
      ? req.query.discount_error
      : null
  const discountError = discountErrorRaw
    ? discountErrorRaw.slice(0, 200)
    : null

  // Phase 10 PR2 — mirror the discount pattern for gift cards.
  const giftCardErrorRaw =
    typeof req.query.gift_card_error === 'string'
      ? req.query.gift_card_error
      : null
  const giftCardError = giftCardErrorRaw
    ? giftCardErrorRaw.slice(0, 200)
    : null
  const giftCardAppliedRaw =
    typeof req.query.gift_card_applied === 'string'
      ? req.query.gift_card_applied
      : null
  const giftCardApplied = giftCardAppliedRaw
    ? giftCardAppliedRaw.slice(0, 200)
    : null

  res
    .status(200)
    .type('html')
    .send(
      renderLayout({
        title: 'Secure checkout',
        checkoutId: checkout.id,
        shopName: shop.name,
        headScripts,
        headLinks,
        body: `
          ${stepHtml}
          ${renderOrderSummary(checkout, csrfToken, discountError, giftCardError, giftCardApplied)}
        `,
      }),
    )
}

// ---------------------------------------------------------------------------
// POST handlers — server-side proxies to the Platform API.
//
// Each handler:
//   1. re-fetches the checkout so we can learn the shop slug (which the
//      browser URL doesn't carry)
//   2. forwards the form body to the matching PUT on the API
//   3. 303-redirects back to GET /c/:id so the next step renders
//
// Errors render an inline error page; on success we always PRG so the
// buyer can safely refresh.
// ---------------------------------------------------------------------------

async function proxyAndRedirect(
  req: Request,
  res: Response,
  checkoutId: string,
  build: (slug: string) => { path: string; body: unknown },
): Promise<void> {
  const data = await fetchCheckout(req, checkoutId)
  if (!data) {
    res.redirect(303, `/c/${encodeURIComponent(checkoutId)}`)
    return
  }
  const { path, body } = build(data.shop.slug)
  try {
    await platformApi(path, { method: 'PUT', body, forwardFrom: req })
  } catch (err) {
    const msg = err instanceof PlatformApiError ? err.message : 'Unknown error'
    res
      .status(400)
      .type('html')
      .send(
        renderLayout({
          title: 'Checkout error',
          checkoutId,
          body: `<section class="card" style="grid-column:1/-1">
            <h1>We couldn\u2019t save that</h1>
            <p>${esc(msg)}</p>
            <p><a class="btn-link" href="/c/${esc(checkoutId)}">Go back</a></p>
          </section>`,
        }),
      )
    return
  }
  res.redirect(303, `/c/${encodeURIComponent(checkoutId)}`)
}

export async function postCheckoutEmail(
  req: Request,
  res: Response,
  ctx: { checkoutId: string },
): Promise<void> {
  // CSRF first — on failure just PRG back to GET which will re-render
  // with a fresh token. We deliberately don't show a 403 page because
  // the buyer flow should self-heal on reload.
  if (!(await csrfStore.verify(req))) {
    res.redirect(303, `/c/${encodeURIComponent(ctx.checkoutId)}`)
    return
  }
  const email = String(req.body?.email ?? '').trim()
  if (!email) {
    res.redirect(303, `/c/${encodeURIComponent(ctx.checkoutId)}`)
    return
  }
  await proxyAndRedirect(req, res, ctx.checkoutId, (slug) => ({
    path: `/api/store/${encodeURIComponent(slug)}/checkout/${encodeURIComponent(ctx.checkoutId)}/email`,
    body: { email },
  }))
}

export async function postCheckoutShipping(
  req: Request,
  res: Response,
  ctx: { checkoutId: string },
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect(303, `/c/${encodeURIComponent(ctx.checkoutId)}`)
    return
  }
  const b = req.body ?? {}
  const address = {
    first_name: String(b.first_name ?? '').trim() || null,
    last_name: String(b.last_name ?? '').trim() || null,
    address1: String(b.address1 ?? '').trim() || null,
    address2: String(b.address2 ?? '').trim() || null,
    city: String(b.city ?? '').trim() || null,
    province: String(b.province ?? '').trim() || null,
    country: String(b.country_code ?? '').trim().toUpperCase() || null,
    country_code: String(b.country_code ?? '').trim().toUpperCase() || null,
    zip: String(b.zip ?? '').trim() || null,
    phone: String(b.phone ?? '').trim() || null,
  }
  await proxyAndRedirect(req, res, ctx.checkoutId, (slug) => ({
    path: `/api/store/${encodeURIComponent(slug)}/checkout/${encodeURIComponent(ctx.checkoutId)}/shipping`,
    body: address,
  }))
}

export async function postCheckoutRate(
  req: Request,
  res: Response,
  ctx: { checkoutId: string },
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect(303, `/c/${encodeURIComponent(ctx.checkoutId)}`)
    return
  }
  const rateId = String(req.body?.rate_id ?? '')
  if (!rateId) {
    res.redirect(303, `/c/${encodeURIComponent(ctx.checkoutId)}`)
    return
  }
  // The form encodes the name/price/type of each rate as `name_<id>` etc.
  // so the server can PUT the full rate payload without re-fetching rates.
  const name = String(req.body?.[`name_${rateId}`] ?? 'Standard')
  const price = String(req.body?.[`price_${rateId}`] ?? '0.00')
  const type = String(req.body?.[`type_${rateId}`] ?? 'flat')
  await proxyAndRedirect(req, res, ctx.checkoutId, (slug) => ({
    path: `/api/store/${encodeURIComponent(slug)}/checkout/${encodeURIComponent(ctx.checkoutId)}/shipping-rate`,
    body: { rate_id: rateId, name, price, type },
  }))
}

// ---------------------------------------------------------------------------
// Phase 5 PR1 — discount code apply + remove
// ---------------------------------------------------------------------------

/**
 * Apply a discount code from the order-summary sidebar. The platform
 * API validates (status, date window, usage cap, minimum, once-per-
 * customer); on failure we surface the API error message inline via a
 * `?discount_error=...` query parameter so the PRG reload paints it
 * under the input box.
 *
 * Why a query param instead of flash/session? The checkout app is
 * sessionless by design — no cookies survive the POST round-trip other
 * than the CSRF cookie. A short query param is survivable, idempotent
 * on refresh (the browser re-issues GET not POST), and doesn't grow
 * server state per buyer.
 */
export async function postCheckoutDiscount(
  req: Request,
  res: Response,
  ctx: { checkoutId: string },
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect(303, `/c/${encodeURIComponent(ctx.checkoutId)}`)
    return
  }
  const code = String(req.body?.code ?? '').trim().slice(0, 64)
  if (!code) {
    res.redirect(
      303,
      `/c/${encodeURIComponent(ctx.checkoutId)}?discount_error=${encodeURIComponent(
        'Please enter a discount code.',
      )}`,
    )
    return
  }

  // Need the shop slug so the API path can be built. Re-fetch rather
  // than stashing it on the form; server-side proxy only.
  const data = await fetchCheckout(req, ctx.checkoutId)
  if (!data) {
    res.redirect(303, `/c/${encodeURIComponent(ctx.checkoutId)}`)
    return
  }

  try {
    await platformApi(
      `/api/store/${encodeURIComponent(data.shop.slug)}/checkout/${encodeURIComponent(ctx.checkoutId)}/discount`,
      { method: 'POST', body: { code }, forwardFrom: req },
    )
    res.redirect(303, `/c/${encodeURIComponent(ctx.checkoutId)}`)
  } catch (err) {
    const msg =
      err instanceof PlatformApiError
        ? err.message
        : 'We couldn\u2019t apply that code. Please try again.'
    res.redirect(
      303,
      `/c/${encodeURIComponent(ctx.checkoutId)}?discount_error=${encodeURIComponent(msg)}`,
    )
  }
}

/**
 * Remove whatever discount is currently on the checkout. The API
 * endpoint is a DELETE — we proxy with method DELETE. Failure here is
 * best-effort; if the API balks we still PRG to the checkout page so
 * the buyer isn't stranded on an error screen for a trivial UI action.
 */
export async function postCheckoutDiscountRemove(
  req: Request,
  res: Response,
  ctx: { checkoutId: string },
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect(303, `/c/${encodeURIComponent(ctx.checkoutId)}`)
    return
  }

  const data = await fetchCheckout(req, ctx.checkoutId)
  if (!data) {
    res.redirect(303, `/c/${encodeURIComponent(ctx.checkoutId)}`)
    return
  }

  try {
    await platformApi(
      `/api/store/${encodeURIComponent(data.shop.slug)}/checkout/${encodeURIComponent(ctx.checkoutId)}/discount`,
      { method: 'DELETE', forwardFrom: req },
    )
  } catch {
    // Silent — stranded removed-discount state shows back on the page anyway.
  }
  res.redirect(303, `/c/${encodeURIComponent(ctx.checkoutId)}`)
}

// ---------------------------------------------------------------------------
// Phase 10 PR2 — gift card validation preview
// ---------------------------------------------------------------------------

/**
 * Validate a gift card code the buyer typed into the order summary.
 * The API returns a typed result — we translate it into a success or
 * error flash query param so the PRG reload paints the outcome inline.
 *
 * This is preview-only: the actual balance deduction fires during order
 * completion once the orders module wires in the redemption hook. The
 * inline check lets the buyer confirm their code is valid before
 * reaching the pay button.
 */
export async function postCheckoutGiftCard(
  req: Request,
  res: Response,
  ctx: { checkoutId: string },
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect(303, `/c/${encodeURIComponent(ctx.checkoutId)}`)
    return
  }
  const code = String(req.body?.code ?? '').trim().slice(0, 32)
  if (!code) {
    res.redirect(
      303,
      `/c/${encodeURIComponent(ctx.checkoutId)}?gift_card_error=${encodeURIComponent(
        'Please enter a gift card code.',
      )}`,
    )
    return
  }

  const data = await fetchCheckout(req, ctx.checkoutId)
  if (!data) {
    res.redirect(303, `/c/${encodeURIComponent(ctx.checkoutId)}`)
    return
  }

  try {
    const result = await platformApi<{
      ok: boolean
      message?: string
      applicable?: string
      giftCard?: { currency: string }
    }>(
      `/api/store/${encodeURIComponent(data.shop.slug)}/checkout/${encodeURIComponent(ctx.checkoutId)}/gift-card`,
      { method: 'POST', body: { code }, forwardFrom: req },
    )
    if (result.ok && result.applicable) {
      const currency = result.giftCard?.currency ?? data.checkout.currency
      res.redirect(
        303,
        `/c/${encodeURIComponent(ctx.checkoutId)}?gift_card_applied=${encodeURIComponent(
          `Gift card is valid. ${currency} ${result.applicable} will apply at checkout.`,
        )}`,
      )
      return
    }
    // ok:false branch
    const msg = result.message ?? 'Gift card could not be validated.'
    res.redirect(
      303,
      `/c/${encodeURIComponent(ctx.checkoutId)}?gift_card_error=${encodeURIComponent(msg)}`,
    )
  } catch (err) {
    const msg =
      err instanceof PlatformApiError
        ? err.message
        : 'We couldn\u2019t validate that gift card. Please try again.'
    res.redirect(
      303,
      `/c/${encodeURIComponent(ctx.checkoutId)}?gift_card_error=${encodeURIComponent(msg)}`,
    )
  }
}
