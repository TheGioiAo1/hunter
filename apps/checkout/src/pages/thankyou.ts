/**
 * Gbox Checkout — thank-you page
 *
 * Renders the buyer's order confirmation after a successful PayPal
 * capture. The data pipeline is:
 *
 *   GET /c/:checkoutId/thankyou
 *     → platformApi('/api/checkout/:id/order')
 *        → checks Redis checkout.completed_at + order_id
 *        → SELECT from orders + order_line_items
 *     → { order, line_items, shop }
 *
 * State handling:
 *   - 410 checkout_expired  → the Redis session TTL passed. Show a soft
 *     "check your email" card instead of an error — the buyer still
 *     placed a real order, they just can't re-view it without logging in.
 *   - 409 checkout_not_completed → someone tried to load the thank-you
 *     page for an in-progress checkout. Redirect them back to /c/:id
 *     where the 3-step form will resume.
 *   - 404                   → unknown checkout id; show "not found".
 *   - 200                   → render the real confirmation.
 *
 * No inline scripts. No PII beyond what the buyer just typed in themselves.
 */

import type { Request, Response } from 'express'
import { platformApi, PlatformApiError } from '../lib/api-client.js'
import { renderLayout, esc } from '../components/layout.js'

// ---------------------------------------------------------------------------
// Types — mirror the API shape loosely so we don't couple to internals.
// ---------------------------------------------------------------------------

interface ApiOrder {
  id: string
  order_number: number
  email: string | null
  phone: string | null
  financial_status: string
  fulfillment_status: string
  currency: string
  subtotal_price: string
  total_discounts: string
  total_shipping: string
  total_tax: string
  total_price: string
  shipping_address: Record<string, any> | null
  billing_address: Record<string, any> | null
  created_at: string
}

interface ApiLineItem {
  id: string
  title: string
  variant_title: string | null
  sku: string | null
  quantity: number
  price: string
}

interface ApiShop {
  id: string
  slug: string
  name: string
  currency: string
  domain: string | null
  email: string | null
}

interface OrderLookupResponse {
  order: ApiOrder
  line_items: ApiLineItem[]
  shop: ApiShop
}

// ---------------------------------------------------------------------------
// Formatters
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

function fmtAddress(addr: Record<string, any> | null): string {
  if (!addr) return ''
  const parts = [
    [addr.first_name, addr.last_name].filter(Boolean).join(' '),
    addr.address1,
    addr.address2,
    [addr.city, addr.province, addr.zip].filter(Boolean).join(', '),
    addr.country_code || addr.country,
  ].filter((p) => p && String(p).trim().length > 0)
  return parts.map((p) => esc(String(p))).join('<br>')
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  } catch {
    return iso
  }
}

// ---------------------------------------------------------------------------
// Card fragments
// ---------------------------------------------------------------------------

function renderExpiredCard(checkoutId: string): string {
  return `
    <section class="card" style="grid-column: 1 / -1">
      <h1>Your order is on its way</h1>
      <p>This checkout session has expired, but your order was placed successfully.</p>
      <p>We\u2019ve sent a confirmation email with your order number, line items, and tracking information. Please check your inbox.</p>
      <p style="color: var(--muted); font-size: 13px">Reference: <code>${esc(checkoutId)}</code></p>
    </section>
  `
}

function renderNotFoundCard(checkoutId: string): string {
  return `
    <section class="card" style="grid-column: 1 / -1">
      <h1>Checkout not found</h1>
      <p>We couldn\u2019t find a checkout with that id. If you just completed a purchase, please check your email for the order confirmation.</p>
      <p style="color: var(--muted); font-size: 13px">Reference: <code>${esc(checkoutId)}</code></p>
    </section>
  `
}

function renderUnavailableCard(checkoutId: string, message: string): string {
  return `
    <section class="card" style="grid-column: 1 / -1">
      <h1>Order confirmation unavailable</h1>
      <p>We had trouble loading your order details. Don\u2019t worry — your payment was captured and the confirmation email is on its way.</p>
      <p style="color: var(--muted); font-size: 13px">${esc(message)}</p>
      <p style="color: var(--muted); font-size: 13px">Reference: <code>${esc(checkoutId)}</code></p>
    </section>
  `
}

function renderOrderCard(data: OrderLookupResponse): string {
  const { order, line_items, shop } = data
  const items = line_items
    .map(
      (li) => `
        <div class="line-item">
          <span class="qty">${li.quantity}</span>
          <span class="title">
            ${esc(li.title)}${li.variant_title ? ` <span style="color:var(--muted);font-size:12px">· ${esc(li.variant_title)}</span>` : ''}
            ${li.sku ? `<div style="color:var(--muted);font-size:12px">SKU: ${esc(li.sku)}</div>` : ''}
          </span>
          <span class="price">${esc(fmt(parseFloat(li.price) * li.quantity, order.currency))}</span>
        </div>
      `,
    )
    .join('')

  const shippingHtml = order.shipping_address
    ? `
        <div>
          <h3 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;color:var(--muted)">Shipping to</h3>
          <p style="margin:0;font-size:14px;line-height:1.5">${fmtAddress(order.shipping_address)}</p>
        </div>
      `
    : ''

  return `
    <section class="card">
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:8px">
        <div style="width:48px;height:48px;border-radius:50%;background:var(--accent);color:var(--accent-fg);display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:bold">\u2713</div>
        <div>
          <h1 style="margin:0">Thank you${order.shipping_address && (order.shipping_address as any).first_name ? ', ' + esc(String((order.shipping_address as any).first_name)) : ''}!</h1>
          <p style="margin:4px 0 0;color:var(--muted);font-size:14px">Order <strong>#${order.order_number}</strong> \u00b7 Placed ${esc(fmtDate(order.created_at))}</p>
        </div>
      </div>

      <p>Your order has been confirmed and we\u2019ve sent a receipt to <strong>${esc(order.email ?? 'your email')}</strong>. You\u2019ll get another email when your items ship.</p>

      <hr style="border:none;border-top:1px solid var(--border);margin:24px 0">

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
        <div>
          <h3 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;color:var(--muted)">Contact</h3>
          <p style="margin:0;font-size:14px">${esc(order.email ?? '')}</p>
          ${order.phone ? `<p style="margin:4px 0 0;font-size:14px">${esc(order.phone)}</p>` : ''}
        </div>
        ${shippingHtml}
      </div>

      <hr style="border:none;border-top:1px solid var(--border);margin:24px 0">

      <p style="color:var(--muted);font-size:13px">
        Need help? Contact
        ${shop.email ? `<a href="mailto:${esc(shop.email)}" class="btn-link">${esc(shop.email)}</a>` : `<strong>${esc(shop.name)}</strong>`}.
      </p>
    </section>

    <aside class="card" aria-label="Order summary">
      <h2>Order summary</h2>
      ${items}
      <div style="margin-top:16px">
        <div class="summary-line"><span>Subtotal</span><span>${esc(fmt(order.subtotal_price, order.currency))}</span></div>
        <div class="summary-line"><span>Shipping</span><span>${esc(fmt(order.total_shipping, order.currency))}</span></div>
        ${parseFloat(order.total_tax || '0') > 0 ? `<div class="summary-line"><span>Tax</span><span>${esc(fmt(order.total_tax, order.currency))}</span></div>` : ''}
        ${parseFloat(order.total_discounts || '0') > 0 ? `<div class="summary-line"><span>Discount</span><span>-${esc(fmt(order.total_discounts, order.currency))}</span></div>` : ''}
        <div class="summary-line total"><span>Total paid</span><span>${esc(fmt(order.total_price, order.currency))}</span></div>
      </div>
      <p style="margin-top:16px;color:var(--muted);font-size:12px;text-align:center">
        Payment status: <strong style="color:var(--accent);text-transform:capitalize">${esc(order.financial_status)}</strong>
      </p>
    </aside>
  `
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function getThankyouPage(
  req: Request,
  res: Response,
  ctx: { checkoutId: string },
): Promise<void> {
  let data: OrderLookupResponse
  try {
    data = await platformApi<OrderLookupResponse>(
      `/api/checkout/${encodeURIComponent(ctx.checkoutId)}/order`,
      { forwardFrom: req },
    )
  } catch (err) {
    if (err instanceof PlatformApiError) {
      if (err.status === 409) {
        // Buyer hit thank-you before completing payment — bounce them
        // back to the form.
        res.redirect(302, `/c/${encodeURIComponent(ctx.checkoutId)}`)
        return
      }
      if (err.status === 410) {
        res
          .status(200)
          .type('html')
          .send(
            renderLayout({
              title: 'Order confirmed',
              checkoutId: ctx.checkoutId,
              body: renderExpiredCard(ctx.checkoutId),
            }),
          )
        return
      }
      if (err.status === 404) {
        res
          .status(404)
          .type('html')
          .send(
            renderLayout({
              title: 'Checkout not found',
              checkoutId: ctx.checkoutId,
              body: renderNotFoundCard(ctx.checkoutId),
            }),
          )
        return
      }
    }
    const msg = err instanceof Error ? err.message : 'unknown error'
    res
      .status(502)
      .type('html')
      .send(
        renderLayout({
          title: 'Order confirmation unavailable',
          checkoutId: ctx.checkoutId,
          body: renderUnavailableCard(ctx.checkoutId, msg),
        }),
      )
    return
  }

  res
    .status(200)
    .type('html')
    .send(
      renderLayout({
        title: `Order #${data.order.order_number} confirmed`,
        checkoutId: ctx.checkoutId,
        shopName: data.shop.name,
        body: renderOrderCard(data),
      }),
    )
}
