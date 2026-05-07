/**
 * God Admin — Order Detail page (Phase 2.4)
 *
 * GET /god-admin/orders/:id
 *
 * The drill-down target for every order link in the dashboard,
 * orders list, fulfillment center, and store detail pages. Renders
 * a 6-card investigation surface plus an embedded AI advisor:
 *
 *   1. Header card        — order #, created_at, status badges, totals
 *   2. Store card         — which shop this order belongs to (link)
 *   3. Customer card      — customer profile summary (link)
 *   4. Line items card    — all products/variants/qty/price
 *   5. Fulfillment card   — fulfillments + tracking per shipment
 *   6. Transactions card  — payment captures/refunds/voids
 *   +  Timeline card      — audit-log events filtered by this order id
 *   +  AI Advisor panel   — analyzeContext('order', snapshot) briefing
 *                          plus follow-up chat via /god-admin/ai/chat
 *
 * The AI advisor is wired via the shared `renderAiPanel` component.
 * When `isAiConfigured()` returns false, the panel falls back to
 * the "not configured" stub so the rest of the page still renders.
 *
 * Cross-link map (every blue element is a link back into the graph):
 *
 *   Store name           → /god-admin/stores/:shop_id
 *   Customer email       → /god-admin/customers/:customer_id    (Phase 5)
 *   Fulfillment status   → /god-admin/fulfillments/:order_id
 *   Back to Orders       → /god-admin/orders?shop_id=:shop_id
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'
import {
  analyzeContext,
  isAiConfigured,
  type AdvisorContext,
} from '@gbox/core/modules/ai/index.js'
import { renderAiPanel, renderAiPanelUnconfigured } from '../lib/ai-panel.js'
import { aiPanelCsrf } from './ai-chat.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string | null | undefined): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fmtMoney(val: string | number | null | undefined, currency = 'USD'): string {
  const n = Number(val) || 0
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
    }).format(n)
  } catch {
    return '$' + n.toFixed(2)
  }
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function statusBadge(status: string | null | undefined): string {
  const s = (status || 'unknown').toLowerCase()
  const map: Record<string, string> = {
    paid: 'badge-green',
    fulfilled: 'badge-green',
    success: 'badge-green',
    active: 'badge-green',
    pending: 'badge-yellow',
    unfulfilled: 'badge-yellow',
    partial: 'badge-yellow',
    open: 'badge-yellow',
    authorization: 'badge-yellow',
    refunded: 'badge-red',
    voided: 'badge-red',
    cancelled: 'badge-red',
    failure: 'badge-red',
    error: 'badge-red',
  }
  return `<span class="badge ${map[s] || 'badge-gray'}">${esc(s)}</span>`
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

// ---------------------------------------------------------------------------
// Shipping address renderer
// ---------------------------------------------------------------------------

interface ShippingAddressBlob {
  first_name?: string
  last_name?: string
  company?: string
  address1?: string
  address2?: string
  city?: string
  province?: string
  country?: string
  zip?: string
  phone?: string
}

function renderAddress(blob: unknown): string {
  if (!blob || typeof blob !== 'object') return '<em style="color:var(--text-secondary)">No address</em>'
  const a = blob as ShippingAddressBlob
  const parts: string[] = []
  const name = [a.first_name, a.last_name].filter(Boolean).join(' ').trim()
  if (name) parts.push(esc(name))
  if (a.company) parts.push(esc(a.company))
  if (a.address1) parts.push(esc(a.address1))
  if (a.address2) parts.push(esc(a.address2))
  const cityLine = [a.city, a.province, a.zip].filter(Boolean).join(', ')
  if (cityLine) parts.push(esc(cityLine))
  if (a.country) parts.push(esc(a.country))
  if (a.phone) parts.push(`<span class="mono">${esc(a.phone)}</span>`)
  if (parts.length === 0) return '<em style="color:var(--text-secondary)">No address</em>'
  return parts.join('<br>')
}

// ---------------------------------------------------------------------------
// GET /god-admin/orders/:id
// ---------------------------------------------------------------------------

export async function getOrderDetail(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const user = req.godAdmin!.user
  const orderId = req.params.id

  try {
    // ----- Root entity ----------------------------------------------------
    const order = await db
      .selectFrom('orders')
      .where('id', '=', orderId)
      .selectAll()
      .executeTakeFirst()

    if (!order) {
      res.status(404).send(
        godLayout({
          title: 'Order Not Found',
          userEmail: user.email,
          activePath: '/god-admin/orders',
          content:
            '<div class="card"><p style="color:var(--red)">Order not found.</p><a href="/god-admin/orders" class="btn btn-secondary btn-sm" style="margin-top:12px">Back to Orders</a></div>',
        }),
      )
      return
    }

    // ----- Parallel sub-queries -------------------------------------------
    const [shop, customer, lineItems, fulfillments, transactions, timeline] = await Promise.all([
      db
        .selectFrom('shops')
        .where('id', '=', order.shop_id)
        .select(['id', 'name', 'slug', 'status'])
        .executeTakeFirst(),
      order.customer_id
        ? db
            .selectFrom('customers')
            .where('id', '=', order.customer_id)
            .select([
              'id',
              'email',
              'first_name',
              'last_name',
              'phone',
              'orders_count',
              'total_spent',
              'created_at',
            ])
            .executeTakeFirst()
        : Promise.resolve(undefined),
      db
        .selectFrom('order_line_items')
        .where('order_id', '=', orderId)
        .select([
          'id',
          'title',
          'variant_title',
          'sku',
          'quantity',
          'price',
          'total_discount',
          'fulfillment_status',
        ])
        .orderBy('created_at', 'asc')
        .execute(),
      db
        .selectFrom('fulfillments')
        .where('order_id', '=', orderId)
        .select([
          'id',
          'status',
          'tracking_company',
          'tracking_number',
          'tracking_url',
          'shipped_at',
          'created_at',
          'updated_at',
        ])
        .orderBy('created_at', 'desc')
        .execute(),
      db
        .selectFrom('transactions')
        .where('order_id', '=', orderId)
        .select([
          'id',
          'kind',
          'gateway',
          'amount',
          'currency',
          'status',
          'gateway_transaction_id',
          'message',
          'created_at',
        ])
        .orderBy('created_at', 'desc')
        .execute(),
      db
        .selectFrom('audit_logs')
        .where('resource_type', '=', 'order')
        .where('resource_id', '=', orderId)
        .select(['id', 'action', 'user_id', 'details', 'ip_address', 'created_at'])
        .orderBy('created_at', 'desc')
        .limit(50)
        .execute(),
    ])

    // Look up audit-log actor emails in a second round-trip so we
    // can label timeline rows with a human-readable name.
    const actorIds = Array.from(
      new Set(timeline.map((t) => t.user_id).filter((v): v is string => !!v)),
    )
    const actors = actorIds.length
      ? await db
          .selectFrom('users')
          .where('id', 'in', actorIds)
          .select(['id', 'email', 'name'])
          .execute()
      : []
    const actorMap = new Map(actors.map((a) => [a.id, a]))

    // ----- Build AI snapshot ---------------------------------------------
    // Kept narrow — we send only what the model needs to reason
    // about "is this order healthy?". Big blobs (raw addresses,
    // full audit detail JSON) are dropped to stay under ~3kB.
    const snapshot: Record<string, unknown> = {
      order: {
        id: order.id,
        number: order.order_number,
        created_at: order.created_at,
        financial_status: order.financial_status,
        fulfillment_status: order.fulfillment_status,
        currency: order.currency,
        subtotal: order.subtotal_price,
        discounts: order.total_discounts,
        shipping: order.total_shipping,
        tax: order.total_tax,
        total: order.total_price,
        cancel_reason: order.cancel_reason,
        cancelled_at: order.cancelled_at,
      },
      store: shop
        ? { id: shop.id, name: shop.name, slug: shop.slug, status: shop.status }
        : null,
      customer: customer
        ? {
            id: customer.id,
            email: customer.email,
            name: [customer.first_name, customer.last_name].filter(Boolean).join(' '),
            orders_count: customer.orders_count,
            total_spent: customer.total_spent,
            since: customer.created_at,
          }
        : { guest: true, email: order.email },
      line_items: lineItems.map((li) => ({
        title: li.title,
        variant: li.variant_title,
        sku: li.sku,
        quantity: li.quantity,
        price: li.price,
        fulfillment_status: li.fulfillment_status,
      })),
      fulfillments: fulfillments.map((f) => ({
        status: f.status,
        carrier: f.tracking_company,
        tracking: f.tracking_number,
        shipped_at: f.shipped_at,
        updated_at: f.updated_at,
      })),
      transactions: transactions.map((t) => ({
        kind: t.kind,
        gateway: t.gateway,
        amount: t.amount,
        status: t.status,
        created_at: t.created_at,
      })),
      timeline: timeline.slice(0, 20).map((t) => ({
        at: t.created_at,
        action: t.action,
        actor: t.user_id ? actorMap.get(t.user_id)?.email ?? 'user' : 'system',
      })),
    }

    const advisorContext: AdvisorContext = {
      type: 'order',
      title: `Order #${order.order_number}`,
      snapshot,
    }

    // ----- Kick off AI brief in parallel with the HTML render -------------
    const aiReady = isAiConfigured()
    const briefPromise = aiReady
      ? analyzeContext(advisorContext).catch((err) => {
          console.error('[God Admin] AI brief error:', err)
          return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }
        })
      : Promise.resolve({ text: '', usage: { inputTokens: 0, outputTokens: 0 } })

    // ----- Row builders ---------------------------------------------------
    const lineItemRows =
      lineItems.length > 0
        ? lineItems
            .map(
              (li) => `
        <tr>
          <td>
            <div><strong>${esc(li.title)}</strong></div>
            ${li.variant_title ? `<div style="font-size:12px;color:var(--text-secondary)">${esc(li.variant_title)}</div>` : ''}
            ${li.sku ? `<div class="mono" style="font-size:11px;color:var(--text-secondary)">SKU: ${esc(li.sku)}</div>` : ''}
          </td>
          <td>${li.quantity}</td>
          <td>${fmtMoney(li.price, order.currency)}</td>
          <td>${fmtMoney(Number(li.price) * li.quantity - Number(li.total_discount || 0), order.currency)}</td>
          <td>${statusBadge(li.fulfillment_status)}</td>
        </tr>`,
            )
            .join('')
        : '<tr><td colspan="5" style="text-align:center;color:var(--text-secondary);padding:16px">No line items</td></tr>'

    const fulfillmentRows =
      fulfillments.length > 0
        ? fulfillments
            .map(
              (f) => `
        <tr>
          <td>${statusBadge(f.status)}</td>
          <td>${esc(f.tracking_company) || '-'}</td>
          <td>
            ${
              f.tracking_number
                ? f.tracking_url
                  ? `<a href="${esc(f.tracking_url)}" target="_blank" rel="noopener" class="mono">${esc(f.tracking_number)}</a>`
                  : `<span class="mono">${esc(f.tracking_number)}</span>`
                : '-'
            }
          </td>
          <td>${fmtDateTime(f.shipped_at)}</td>
          <td>${fmtDateTime(f.updated_at)}</td>
        </tr>`,
            )
            .join('')
        : '<tr><td colspan="5" style="text-align:center;color:var(--text-secondary);padding:16px">No fulfillments yet</td></tr>'

    const transactionRows =
      transactions.length > 0
        ? transactions
            .map(
              (t) => `
        <tr>
          <td>${esc(t.kind)}</td>
          <td>${esc(t.gateway)}</td>
          <td>${fmtMoney(t.amount, t.currency)}</td>
          <td>${statusBadge(t.status)}</td>
          <td class="mono" style="font-size:11px">${esc(t.gateway_transaction_id) || '-'}</td>
          <td>${fmtDateTime(t.created_at)}</td>
        </tr>`,
            )
            .join('')
        : '<tr><td colspan="6" style="text-align:center;color:var(--text-secondary);padding:16px">No transactions</td></tr>'

    const timelineRows =
      timeline.length > 0
        ? timeline
            .map((t) => {
              const actor = t.user_id
                ? actorMap.get(t.user_id)?.email ?? 'user'
                : 'system'
              return `
          <li class="timeline-row">
            <div class="timeline-dot"></div>
            <div class="timeline-body">
              <div class="timeline-action"><strong>${esc(t.action)}</strong> <span style="color:var(--text-secondary)">by ${esc(actor)}</span></div>
              <div class="timeline-meta">${fmtDateTime(t.created_at)}${t.ip_address ? ` · <span class="mono">${esc(t.ip_address)}</span>` : ''}</div>
            </div>
          </li>`
            })
            .join('')
        : '<li style="color:var(--text-secondary);padding:12px 0">No audit events recorded for this order yet.</li>'

    // Customer detail link placeholder — Phase 5 creates the real route.
    const customerLink = customer
      ? `<a href="/god-admin/customers/${esc(customer.id)}">${esc(customer.email) || '(no email)'}</a>`
      : `<span style="color:var(--text-secondary)">Guest checkout</span>`

    // ----- AI panel -------------------------------------------------------
    const aiBrief = await briefPromise
    let aiPanelHtml: string
    if (!aiReady) {
      aiPanelHtml = renderAiPanelUnconfigured()
    } else {
      const csrfToken = await aiPanelCsrf.issue(res, isProduction())
      aiPanelHtml = renderAiPanel({
        context: advisorContext,
        initialInsight: aiBrief.text,
        csrfToken,
      })
    }

    // ----- Final HTML -----------------------------------------------------
    const content = `
      ${ORDER_DETAIL_CSS}
      <div class="page-header">
        <h1>
          Order #${order.order_number}
          <span style="margin-left:12px">${statusBadge(order.financial_status)} ${statusBadge(order.fulfillment_status)}</span>
        </h1>
        <div class="action-group">
          <a href="/god-admin/orders${shop ? `?store=${esc(order.shop_id)}` : ''}" class="btn btn-secondary btn-sm">Back to Orders</a>
          <a href="/god-admin/fulfillments/${esc(order.id)}" class="btn btn-secondary btn-sm">Fulfillment Center</a>
        </div>
      </div>

      <div class="order-detail-grid">
        <div class="order-detail-main">
          <!-- 1. Summary card -->
          <div class="card">
            <div class="card-title" style="margin-bottom:12px">Order Summary</div>
            <div class="info-row"><span class="info-label">Order ID</span><span class="info-value mono">${esc(order.id)}</span></div>
            <div class="info-row"><span class="info-label">Created</span><span class="info-value">${fmtDateTime(order.created_at)}</span></div>
            <div class="info-row"><span class="info-label">Updated</span><span class="info-value">${fmtDateTime(order.updated_at)}</span></div>
            <div class="info-row"><span class="info-label">Currency</span><span class="info-value">${esc(order.currency)}</span></div>
            <div class="info-row"><span class="info-label">Subtotal</span><span class="info-value">${fmtMoney(order.subtotal_price, order.currency)}</span></div>
            <div class="info-row"><span class="info-label">Discounts</span><span class="info-value">-${fmtMoney(order.total_discounts, order.currency)}</span></div>
            <div class="info-row"><span class="info-label">Shipping</span><span class="info-value">${fmtMoney(order.total_shipping, order.currency)}</span></div>
            <div class="info-row"><span class="info-label">Tax</span><span class="info-value">${fmtMoney(order.total_tax, order.currency)}</span></div>
            <div class="info-row info-row--total"><span class="info-label"><strong>Total</strong></span><span class="info-value"><strong>${fmtMoney(order.total_price, order.currency)}</strong></span></div>
            ${order.cancelled_at ? `<div class="info-row"><span class="info-label">Cancelled</span><span class="info-value" style="color:var(--red,#b91c1c)">${fmtDateTime(order.cancelled_at)}${order.cancel_reason ? ` · ${esc(order.cancel_reason)}` : ''}</span></div>` : ''}
            ${order.note ? `<div class="info-row"><span class="info-label">Note</span><span class="info-value">${esc(order.note)}</span></div>` : ''}
          </div>

          <!-- 4. Line items -->
          <div class="card">
            <div class="card-title" style="margin-bottom:12px">Line Items (${lineItems.length})</div>
            <table class="data-table">
              <thead>
                <tr><th>Product</th><th>Qty</th><th>Price</th><th>Total</th><th>Status</th></tr>
              </thead>
              <tbody>${lineItemRows}</tbody>
            </table>
          </div>

          <!-- 5. Fulfillments -->
          <div class="card">
            <div class="card-title" style="margin-bottom:12px">Fulfillments (${fulfillments.length})</div>
            <table class="data-table">
              <thead>
                <tr><th>Status</th><th>Carrier</th><th>Tracking</th><th>Shipped</th><th>Updated</th></tr>
              </thead>
              <tbody>${fulfillmentRows}</tbody>
            </table>
          </div>

          <!-- 6. Transactions -->
          <div class="card">
            <div class="card-title" style="margin-bottom:12px">Transactions (${transactions.length})</div>
            <table class="data-table">
              <thead>
                <tr><th>Kind</th><th>Gateway</th><th>Amount</th><th>Status</th><th>Gateway Txn ID</th><th>Created</th></tr>
              </thead>
              <tbody>${transactionRows}</tbody>
            </table>
          </div>

          <!-- Timeline -->
          <div class="card">
            <div class="card-title" style="margin-bottom:12px">Timeline (${timeline.length})</div>
            <ul class="timeline-list">${timelineRows}</ul>
          </div>
        </div>

        <aside class="order-detail-side">
          <!-- 2. Store card -->
          <div class="card">
            <div class="card-title" style="margin-bottom:12px">Store</div>
            ${
              shop
                ? `
              <div class="info-row"><span class="info-label">Name</span><span class="info-value"><a href="/god-admin/stores/${esc(shop.id)}">${esc(shop.name)}</a></span></div>
              <div class="info-row"><span class="info-label">Slug</span><span class="info-value mono">${esc(shop.slug)}</span></div>
              <div class="info-row"><span class="info-label">Status</span><span class="info-value">${statusBadge(shop.status)}</span></div>
              <div style="margin-top:12px"><a href="/god-admin/orders?store=${esc(shop.id)}" class="btn btn-secondary btn-sm">All orders in this store</a></div>
            `
                : `<p style="color:var(--text-secondary)">Store not found.</p>`
            }
          </div>

          <!-- 3. Customer card -->
          <div class="card">
            <div class="card-title" style="margin-bottom:12px">Customer</div>
            ${
              customer
                ? `
              <div class="info-row"><span class="info-label">Email</span><span class="info-value">${customerLink}</span></div>
              <div class="info-row"><span class="info-label">Name</span><span class="info-value">${esc([customer.first_name, customer.last_name].filter(Boolean).join(' ')) || '-'}</span></div>
              <div class="info-row"><span class="info-label">Phone</span><span class="info-value">${esc(customer.phone) || '-'}</span></div>
              <div class="info-row"><span class="info-label">Total orders</span><span class="info-value">${customer.orders_count}</span></div>
              <div class="info-row"><span class="info-label">Lifetime spend</span><span class="info-value">${fmtMoney(customer.total_spent, order.currency)}</span></div>
              <div class="info-row"><span class="info-label">Customer since</span><span class="info-value">${fmtDateTime(customer.created_at)}</span></div>
            `
                : `
              <p style="color:var(--text-secondary);margin:0 0 8px 0">Guest checkout</p>
              ${order.email ? `<div class="info-row"><span class="info-label">Email</span><span class="info-value">${esc(order.email)}</span></div>` : ''}
              ${order.phone ? `<div class="info-row"><span class="info-label">Phone</span><span class="info-value">${esc(order.phone)}</span></div>` : ''}
            `
            }
          </div>

          <!-- Shipping address -->
          <div class="card">
            <div class="card-title" style="margin-bottom:12px">Shipping Address</div>
            <div style="font-size:13px;line-height:1.5">${renderAddress(order.shipping_address)}</div>
          </div>

          <!-- Billing address -->
          <div class="card">
            <div class="card-title" style="margin-bottom:12px">Billing Address</div>
            <div style="font-size:13px;line-height:1.5">${renderAddress(order.billing_address)}</div>
          </div>

          <!-- AI Advisor -->
          ${aiPanelHtml}
        </aside>
      </div>
    `

    res.send(
      godLayout({
        title: `Order #${order.order_number}`,
        userEmail: user.email,
        activePath: '/god-admin/orders',
        content,
      }),
    )
  } catch (err) {
    console.error('[God Admin] Order detail error:', err)
    res.status(500).send(
      godLayout({
        title: 'Order',
        userEmail: user.email,
        activePath: '/god-admin/orders',
        content: `<div class="card"><p style="color:var(--red)">Error loading order: ${esc(String(err))}</p><a href="/god-admin/orders" class="btn btn-secondary btn-sm" style="margin-top:12px">Back to Orders</a></div>`,
      }),
    )
  }
}

// ---------------------------------------------------------------------------
// Page-specific CSS
// ---------------------------------------------------------------------------

const ORDER_DETAIL_CSS = `<style>
  .order-detail-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 340px;
    gap: 20px;
    align-items: start;
  }
  .order-detail-main { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
  .order-detail-side { display: flex; flex-direction: column; gap: 20px; position: sticky; top: 76px; }
  @media (max-width: 1100px) {
    .order-detail-grid { grid-template-columns: 1fr; }
    .order-detail-side { position: static; }
  }

  .info-row--total {
    border-top: 1px solid var(--border, #e2e8f0);
    padding-top: 8px;
    margin-top: 4px;
    font-size: 15px;
  }

  .timeline-list {
    list-style: none;
    padding: 0;
    margin: 0;
    position: relative;
  }
  .timeline-list::before {
    content: '';
    position: absolute;
    left: 6px;
    top: 6px;
    bottom: 6px;
    width: 2px;
    background: var(--border, #e2e8f0);
  }
  .timeline-row {
    position: relative;
    padding: 6px 0 14px 22px;
    font-size: 13px;
  }
  .timeline-dot {
    position: absolute;
    left: 0;
    top: 10px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--primary, #3b82f6);
    border: 3px solid var(--surface, #ffffff);
  }
  .timeline-action { color: var(--text-primary, #0f172a); }
  .timeline-meta {
    color: var(--text-secondary, #64748b);
    font-size: 11px;
    margin-top: 2px;
  }
</style>`
