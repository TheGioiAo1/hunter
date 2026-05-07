/**
 * Store Admin — Orders list (API mode)
 *
 * Renders /orders. Calls BE Order-Service POST /api/{shop_id}/list (line 256)
 * which requires Roles `owners,read_orders`. Browser passes JWT — works.
 *
 * Filters: keyword from ?q=. Excludes drafts (they live under /orders/drafts).
 */

import type { Request, Response } from 'express'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { createApiContext, listOrders, deleteOrder, getOrder, updateOrder } from '../lib/customer-api-client.js'
import { listProducts } from '../lib/product-api-client.js'
import { listShippings } from '../lib/shipping-api-client.js'
import { computeOrderTax } from '../lib/subfee-api-client.js'
import { codeOfName } from '../lib/country-data.js'

/**
 * POST /admin/store/:slug/orders/:id/delete — Delete an order via BE API.
 * Used by both /orders and /orders/drafts list pages (Actions column).
 */
export async function postOrderDeleteApi(req: Request, res: Response): Promise<void> {
  const store = req.store
  if (!store) { res.status(404).send('Store context missing'); return }
  const orderId = req.params.id || req.params.orderId
  const back = (typeof req.query.back === 'string' && req.query.back.startsWith('/admin/'))
    ? req.query.back
    : `/admin/store/${store.slug}/orders`
  try {
    const ctx = createApiContext(req)
    await deleteOrder(ctx, orderId)
    res.redirect(`${back}?success=${encodeURIComponent('Order deleted')}`)
  } catch (err: any) {
    console.error('[orders-delete-api] failed:', err?.message || err)
    res.redirect(`${back}?error=${encodeURIComponent(err?.message || 'Delete failed')}`)
  }
}

const PER_PAGE = 25

// Minimal fields for list view — excludes heavy sub-docs not shown in table
// (custom_fields, client_details, shop, subfee, discount, note, etc.)
const LIST_FIELDS = [
  'id', 'order_number', 'short_id',
  'billing_address', 'shipping_address',
  'total_price', 'total_items', 'currency',
  'payment_status',
  'fulfillments',
  'create_date', 'tags',
  'line_items',  // needed for lineSum fallback when total_price=0
].join(',')

export async function renderOrdersListApi(req: Request, res: Response): Promise<void> {
  const store = req.store
  if (!store) { res.status(404).send('Store context missing'); return }
  const user = req.storeUser ?? { name: '', email: '', role: '', storeRole: '' } as any
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const page = Math.max(1, parseInt(String(req.query.page ?? '1')) || 1)
  const successMsg = typeof req.query.success === 'string' ? req.query.success : ''

  let orders: any[] = []
  let total = 0
  let errorMsg: string | null = null
  const debug = req.query.debug === '1'

  try {
    const ctx = createApiContext(req)
    console.log('[orders-list-api] BE call:', { shopId: ctx.shopId, page, limit: PER_PAGE })
    const r = await listOrders(ctx, { page, limit: PER_PAGE, fields: LIST_FIELDS })
    orders = r.data ?? []
    total = r.pagination?.count ?? orders.length
    console.log('[orders-list-api] BE returned:', {
      count: orders.length,
      pagCount: r.pagination?.count,
      firstId: orders[0]?.id,
    })
    if (orders.length === 0) {
      console.warn('[orders-list-api] BE trả 0 records. Check: (1) shopId khớp DB? (2) JWT role có "owners"/"read_orders"? (3) BE Mongo có data shop_id="' + ctx.shopId + '"?')
    }
    if (debug && orders[0]) {
      console.log('[orders-list-api] DEBUG first order keys:', Object.keys(orders[0]))
      console.log('[orders-list-api] DEBUG first order full:', JSON.stringify(orders[0], null, 2).slice(0, 2000))
    }
  } catch (err: any) {
    errorMsg = err?.message || 'unknown'
    console.error('[orders-list-api] list failed:', errorMsg, err?.stack)
  }

  const errorParam = typeof req.query.error === 'string' ? req.query.error : ''
  const isEmpty = total === 0 && !errorMsg
  const flash = successMsg
    ? `<div class="ol-banner-ok">✓ ${esc(successMsg)}</div>` : ''
  const errBanner = (errorMsg || errorParam)
    ? `<div class="ol-banner-err">${esc(errorMsg || decodeURIComponent(errorParam))}</div>` : ''

  const debugBlock = debug && orders[0]
    ? `<details style="background:var(--s-card);border:1px solid var(--s-border);border-radius:8px;padding:12px;margin-bottom:14px;font-family:ui-monospace,monospace;font-size:11px"><summary style="cursor:pointer;color:var(--s-text);font-family:inherit;font-size:13px;font-weight:600">DEBUG: BE first order shape (top-level keys: ${Object.keys(orders[0]).join(', ')})</summary><pre style="white-space:pre-wrap;word-break:break-all;color:var(--s-text-muted);margin:8px 0 0">${esc(JSON.stringify(orders[0], null, 2).slice(0, 4000))}</pre></details>`
    : ''

  const content = `
${ORDERS_LIST_STYLE}
<div class="ol">
  ${flash}${errBanner}${debugBlock}
  <div class="ol-topbar">
    <h1>📦 Orders</h1>
    <div class="ol-actions">
      <button type="button" class="ol-btn-light" ${isEmpty ? 'disabled' : ''}>Export</button>
      <a href="${base}/orders/drafts/new" class="ol-btn-primary">Create order</a>
    </div>
  </div>
  ${isEmpty ? renderEmpty(base) : renderList(base, orders, total, page, String((req as any).csrfToken || ''))}
</div>
`

  res.send(sellerLayout({
    title: 'Orders',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'orders',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

function renderEmpty(base: string): string {
  return `<section class="ol-card ol-empty">
    <div class="ol-empty-icon">📦</div>
    <h2>No orders yet</h2>
    <p>When customers place orders, they'll appear here. You can also create draft orders to charge customers manually.</p>
    <a href="${base}/orders/drafts/new" class="ol-btn-primary">Create order</a>
  </section>`
}

function renderList(base: string, orders: any[], total: number, page: number, csrf: string): string {
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE))
  const rows = orders.map(o => {
    const id = String(o.id || o._id || '')
    // Display name: prefer order_number → short_id → fallback last-4 id
    const orderName = o.order_number || (o.short_id ? `#${o.short_id}` : `#${id.slice(-4)}`)
    // Email lives nested under billing_address / shipping_address (BE Order model)
    const customer = customerFromOrder(o)
    // Total: BE insert-temp strips total_price → fall back to summing
    // line_items[].total which BE preserves. Real orders (POST /api/{shop_id})
    // have total_price set by BE Calc service so prefer that when present.
    const lineSum = (Array.isArray(o.line_items) ? o.line_items : [])
      .reduce((s: number, it: any) => s + (Number(it?.total) || 0), 0)
    const totalPrice = Number(o.total_price) > 0 ? Number(o.total_price) : lineSum
    const currency = String(o.currency || 'VND')
    const paid = o.payment_status === true
    // Fulfillment: BE has fulfillments[] — empty/null = unfulfilled, all done = fulfilled
    const ful = computeFulfillmentLabel(o.fulfillments)
    // Date: BE uses create_date (NOT created_at)
    const created = formatDate(o.create_date || o.created_at)
    // Item count: prefer total_items (pre-computed by BE Calc), fallback to line_items.length
    const itemCount = Number(o.total_items) > 0
      ? Number(o.total_items)
      : (Array.isArray(o.line_items) ? o.line_items.length : 0)
    return `<tr class="ol-row">
      <td><a href="${base}/orders/${esc(id)}" class="ol-name">${esc(orderName)}</a></td>
      <td class="ol-muted">${esc(created)}</td>
      <td>${esc(customer)}</td>
      <td>${itemCount > 0 ? `${itemCount} item${itemCount === 1 ? '' : 's'}` : '—'}</td>
      <td>${formatMoney(totalPrice, currency)}</td>
      <td><span class="ol-badge ${paid ? 'ol-badge-success' : 'ol-badge-warn'}">${paid ? 'Paid' : 'Pending'}</span></td>
      <td><span class="ol-badge ${ful.className}">${esc(ful.label)}</span></td>
      <td class="ol-actions-cell">
        <a href="${base}/orders/${esc(id)}" class="ol-act-btn" title="View">View</a>
        <form method="POST" action="${base}/orders/${esc(id)}/delete?back=${encodeURIComponent(base + '/orders')}" style="display:inline" onsubmit="return confirm('Delete this order? This cannot be undone.')">
          <input type="hidden" name="_csrf" value="${esc(csrf)}"/>
          <button type="submit" class="ol-act-btn ol-act-del" title="Delete">Delete</button>
        </form>
      </td>
    </tr>`
  }).join('')

  const prev = `${base}/orders?page=${Math.max(1, page - 1)}`
  const next = `${base}/orders?page=${Math.min(totalPages, page + 1)}`

  return `
    <section class="ol-summary"><strong>${total} order${total === 1 ? '' : 's'}</strong></section>
    <section class="ol-card ol-list-card">
      <div class="ol-table-wrap">
        <table class="ol-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Date</th>
              <th>Customer</th>
              <th>Items</th>
              <th>Total</th>
              <th>Payment</th>
              <th>Fulfillment</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${totalPages > 1 ? `<div class="ol-pagination">
        <span>Page ${page} of ${totalPages}</span>
        <div class="ol-pag-btns">
          <a href="${prev}" class="ol-btn-light ol-btn-sm" ${page === 1 ? 'aria-disabled="true" style="pointer-events:none;opacity:.4"' : ''}>‹ Prev</a>
          <a href="${next}" class="ol-btn-light ol-btn-sm" ${page === totalPages ? 'aria-disabled="true" style="pointer-events:none;opacity:.4"' : ''}>Next ›</a>
        </div>
      </div>` : ''}
    </section>
  `
}

function formatDate(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatMoney(n: number, currency: string): string {
  if (!n || n === 0) return currency === 'USD' ? '$0' : 'đ0'
  const s = n.toLocaleString('en-US')
  return currency === 'USD' ? `$${s}` : `đ${s}`
}

// Email/name pulled from nested address (BE Order has no top-level email field)
function customerFromOrder(o: any): string {
  const addr = o.billing_address || o.shipping_address || {}
  const name = addr.full_name || [addr.first_name, addr.last_name].filter(Boolean).join(' ').trim()
  const email = addr.email || ''
  return name || email || '—'
}

function computeFulfillmentLabel(fulfillments: any): { label: string; className: string } {
  if (!Array.isArray(fulfillments) || fulfillments.length === 0) {
    return { label: 'Unfulfilled', className: 'ol-badge-warn' }
  }
  const allDone = fulfillments.every((f: any) => {
    const s = String(f?.status || '').toLowerCase()
    return s === 'success' || s === 'fulfilled' || s === 'delivered' || s === 'completed'
  })
  if (allDone) return { label: 'Fulfilled', className: 'ol-badge-success' }
  return { label: 'Partial', className: 'ol-badge-warn' }
}

const ORDERS_LIST_STYLE = `<style>
.ol { color:var(--s-text); font-size:14px; max-width:1280px; margin:0 auto; padding-bottom:80px; }
.ol-topbar { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
.ol-topbar h1 { margin:0; font-size:20px; font-weight:600; color:var(--s-text); }
.ol-actions { display:flex; gap:8px; }

.ol-banner-ok { background:color-mix(in srgb, var(--s-success) 15%, var(--s-card)); border:1px solid var(--s-success); border-radius:8px; padding:10px 14px; margin-bottom:14px; font-size:13px; color:var(--s-text); }
.ol-banner-err { background:color-mix(in srgb, var(--s-danger) 15%, var(--s-card)); border:1px solid var(--s-danger); border-radius:8px; padding:10px 14px; margin-bottom:14px; font-size:13px; color:var(--s-text); }

.ol-btn-light { padding:7px 14px; border:1px solid var(--s-border); background:var(--s-card); color:var(--s-text); border-radius:8px; font-size:13px; cursor:pointer; text-decoration:none; display:inline-block; }
.ol-btn-light:hover:not(:disabled):not([aria-disabled="true"]) { background:var(--s-card-hover); }
.ol-btn-light:disabled { opacity:.55; cursor:not-allowed; }
.ol-btn-sm { padding:5px 10px; font-size:12px; }
.ol-btn-primary { padding:7px 14px; border:none; background:var(--s-accent); color:#fff; border-radius:8px; font-size:13px; font-weight:500; cursor:pointer; text-decoration:none; display:inline-block; }
.ol-btn-primary:hover { background:var(--s-accent-hover); }

.ol-card { background:var(--s-card); border:1px solid var(--s-border); border-radius:12px; padding:18px; box-shadow:var(--s-shadow); margin-bottom:14px; }
.ol-empty { text-align:center; padding:48px 24px; }
.ol-empty-icon { font-size:48px; margin-bottom:14px; opacity:.6; }
.ol-empty h2 { margin:0 0 8px; font-size:16px; font-weight:600; color:var(--s-text); }
.ol-empty p { margin:0 auto 18px; max-width:480px; font-size:13px; color:var(--s-text-muted); line-height:1.5; }

.ol-summary { background:var(--s-card); border:1px solid var(--s-border); border-radius:12px; padding:14px 18px; margin-bottom:14px; box-shadow:var(--s-shadow); font-size:13px; color:var(--s-text); }

.ol-list-card { padding:0; overflow:hidden; }
.ol-table-wrap { overflow-x:auto; }
.ol-table { width:100%; border-collapse:collapse; font-size:13px; }
/* All columns center-aligned by default */
.ol-table thead th { text-align:center; padding:10px 14px; font-weight:500; color:var(--s-text-muted); font-size:12px; background:var(--s-card-hover); border-bottom:1px solid var(--s-border); }
.ol-table tbody td { padding:14px; border-bottom:1px solid var(--s-border); color:var(--s-text); text-align:center; vertical-align:middle; }
.ol-table tbody tr:last-child td { border-bottom:none; }
.ol-row:hover td { background:var(--s-card-hover); }
.ol-num { text-align:center; }
.ol-muted { color:var(--s-text-muted); font-size:12px; }
.ol-name { color:var(--s-text); font-weight:500; text-decoration:none; }
.ol-name:hover { color:var(--s-accent); }

/* Actions column */
.ol-actions-cell { white-space:nowrap; }
.ol-act-btn { display:inline-block; padding:5px 10px; margin:0 2px; border:1px solid var(--s-border); background:var(--s-card); color:var(--s-text); border-radius:6px; font-size:12px; cursor:pointer; text-decoration:none; font-family:inherit; }
.ol-act-btn:hover { background:var(--s-card-hover); }
.ol-act-del { color:var(--s-danger); border-color:color-mix(in srgb, var(--s-danger) 40%, transparent); }
.ol-act-del:hover { background:color-mix(in srgb, var(--s-danger) 10%, var(--s-card)); border-color:var(--s-danger); }

.ol-badge { display:inline-block; padding:2px 10px; border-radius:999px; font-size:11px; font-weight:500; }
.ol-badge-success { background:color-mix(in srgb, var(--s-success) 25%, transparent); color:var(--s-success); }
.ol-badge-warn { background:color-mix(in srgb, var(--s-warning, #f59e0b) 25%, transparent); color:var(--s-warning, #f59e0b); }
.ol-badge-muted { background:var(--s-card-hover); color:var(--s-text-muted); }

.ol-pagination { display:flex; justify-content:space-between; align-items:center; padding:12px 16px; border-top:1px solid var(--s-border); font-size:13px; color:var(--s-text-muted); }
.ol-pag-btns { display:flex; gap:6px; }
</style>`

// ─────────────────────────────────────────────────────────────────────────
// Order detail (API mode) — Shopify/ShopBase-style layout, Gbox tokens
// ─────────────────────────────────────────────────────────────────────────

// FX rates -> USD. Override per currency via env FX_TO_USD_<CCY> (e.g. FX_TO_USD_VND=25500).
const FX_TO_USD: Record<string, number> = {
  USD: 1,
  VND: Number(process.env.FX_TO_USD_VND) || 25500,
  EUR: Number(process.env.FX_TO_USD_EUR) || 0.92,
  GBP: Number(process.env.FX_TO_USD_GBP) || 0.78,
  JPY: Number(process.env.FX_TO_USD_JPY) || 155,
  CNY: Number(process.env.FX_TO_USD_CNY) || 7.2,
  AUD: Number(process.env.FX_TO_USD_AUD) || 1.5,
}
function toUsd(n: any, currency: string): number {
  const v = Number(n) || 0
  const cur = String(currency || 'USD').toUpperCase()
  const rate = FX_TO_USD[cur] ?? 1
  return cur === 'USD' ? v : v / rate
}
// All money displays normalized to USD per Thai's rule (2026-05-03).
function fmtMoney(n: any, currency: string): string {
  return '$' + toUsd(n, currency).toFixed(2)
}

/**
 * Enrich BE order.line_items with product image URLs. The Order Service stores
 * line items WITHOUT image fields (verified via debug dump: keys = id, short_id,
 * product_name, variant, quantity, ...). Product images live on the Product
 * Service so we look each item up by `product_name` and inject `image`/`image_url`
 * onto the row in-place. Render code already falls back through `li.image_url`.
 */
async function enrichLineItemsWithImages(ctx: any, lineItems: any[]): Promise<void> {
  const names = Array.from(new Set(
    lineItems
      .map(li => String(li.product_name || li.title || li.variant?.name || '').trim())
      .filter(Boolean),
  ))
  if (names.length === 0) return
  try {
    const { listProducts } = await import('../lib/product-api-client.js')
    const lookups = await Promise.allSettled(
      names.map(name => listProducts(ctx, { keyword: name, limit: 1, fields: 'id,name,images' as any })),
    )
    const nameToImage: Record<string, string> = {}
    lookups.forEach((res, i) => {
      if (res.status !== 'fulfilled') return
      const data = (res.value as any)?.data
      const first = Array.isArray(data) ? data[0] : null
      const url = first?.images?.[0]?.url || ''
      if (url) nameToImage[names[i].toLowerCase()] = url
    })
    for (const li of lineItems) {
      const key = String(li.product_name || li.title || li.variant?.name || '').trim().toLowerCase()
      if (!key) continue
      const url = nameToImage[key]
      if (url && !li.image && !li.image_url) {
        li.image = url
        li.image_url = url
      }
    }
  } catch (err: any) {
    console.warn('[order-image-enrich] lookup failed:', err?.message)
  }
}

/**
 * Find a shipping zone whose country_codes include the given ISO code
 * and return its first method's name + price. Mirrors computeOrderTax's
 * by-country lookup so order render/save flows can auto-apply the right
 * shipping rate when the customer's address resolves to a country that
 * has a matching zone configured under /settings/shipping.
 *
 * The /settings/shipping page itself is not modified — we only consume
 * existing shipping zones via listShippings(). Callers always have the
 * option to override via the explicit "Edit shipping fees" modal.
 */
async function findShippingForCountry(
  ctx: any,
  countryCode: string,
): Promise<{ method_name: string; price: number } | null> {
  if (!countryCode) return null
  try {
    const zones = await listShippings(ctx, {})
    const cc = countryCode.toLowerCase()
    const match = zones.find((z: any) => {
      const codes: string[] = (z.country_codes || []).map((c: string) => String(c).toLowerCase())
      const has = codes.includes(cc)
      return z.country_excluded ? !has : has
    })
    if (!match || !Array.isArray(match.shipping_methods) || match.shipping_methods.length === 0) return null
    const m = match.shipping_methods.find((mm: any) => Number(mm.price ?? mm.first_item_price ?? 0) > 0)
      || match.shipping_methods[0]
    if (!m) return null
    const price = Number(m.price ?? m.first_item_price ?? 0)
    const name = [match.name, m.name].filter(Boolean).join(' / ') || 'Shipping'
    return { method_name: name, price }
  } catch (err: any) {
    console.warn('[shipping-auto] lookup failed:', err?.message)
    return null
  }
}

function fmtAddr(a: any): string {
  if (!a || typeof a !== 'object') return ''
  const name = a.full_name || [a.first_name, a.last_name].filter(Boolean).join(' ')
  const cityLine = [a.city, a.province, a.zip].filter(Boolean).join(', ')
  const lines = [name, a.company, a.address_1 || a.address1, a.address_2 || a.address2, cityLine, a.country_name || a.country].filter(Boolean)
  if (!lines.length) return ''
  return lines.map(l => `<div style="font-size:13px;color:var(--s-text)">${esc(String(l))}</div>`).join('')
    + (a.phone ? `<div style="font-size:12px;color:var(--s-text-muted);margin-top:4px">Tel: ${esc(String(a.phone))}</div>` : '')
}

export async function renderOrderDetailApi(req: Request, res: Response): Promise<void> {
  const store = req.store
  if (!store) { res.status(404).send('Store context missing'); return }
  const user = req.storeUser ?? { name: '', email: '', role: '', storeRole: '' } as any
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const orderId = req.params.id || req.params.orderId
  const successMsg = typeof req.query.success === 'string' ? req.query.success : ''
  const errorMsg = typeof req.query.error === 'string' ? req.query.error : ''

  let order: any = null
  let fetchErr: string | null = null
  try {
    const ctx = createApiContext(req)
    order = await getOrder(ctx, orderId)
    if (order?.line_items?.length) {
      await enrichLineItemsWithImages(ctx, order.line_items)
    }
  } catch (err: any) {
    fetchErr = err?.message || 'Failed to fetch order'
  }

  if (!order) {
    res.status(fetchErr ? 502 : 404).send(sellerLayout({
      title: 'Order not found',
      storeName: store.name, storeSlug: store.slug,
      userName: user.name, userEmail: user.email, userRole: user.role, storeRole: user.storeRole,
      activePage: 'orders', theme: theme as 'dark' | 'light',
      content: `
        <div style="max-width:1100px;margin:0 auto">
          <div class="page-header"><div>
            <h1 class="page-title">Order not found</h1>
            <p class="page-subtitle">${fetchErr ? esc(fetchErr) : 'This order does not exist or belongs to another store.'}</p>
          </div></div>
          <a href="${base}/orders" class="btn btn-outline">&larr; Back to orders</a>
        </div>
      `,
    }))
    return
  }

  // ── Identity ──
  const orderNumber = order.order_number ?? order.short_id ?? order._id ?? order.id ?? ''
  const created = order.create_date || order.created_at || order.createdAt
  const dateStr = created
    ? new Date(created).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : ''

  // ── Payment status (BE: payment_status bool) ──
  // true → paid; false/null + total>0 → payment_pending; tags contain 'refunded' → refunded
  // null fallback: infer from payment_method.amount (older orders may not have payment_status set)
  const totalPrice = Number(order.total_price) || 0
  const isPaid = order.payment_status === true
    || (order.payment_status == null && totalPrice > 0 && Number(order.payment_method?.amount) >= totalPrice)
  const isRefunded = (Array.isArray(order.tags) && order.tags.some((t: string) => String(t).toLowerCase().includes('refund')))
    || String(order.status || '').toLowerCase() === 'refund'
  const payment: 'paid' | 'payment_pending' | 'refunded' = isRefunded ? 'refunded' : (isPaid ? 'paid' : 'payment_pending')
  const paymentLabel = payment === 'paid' ? 'Paid' : payment === 'refunded' ? 'Refunded' : 'Payment pending'
  const payBadge = payment === 'paid' ? 'badge-success' : payment === 'refunded' ? 'badge-danger' : 'badge-warning'

  // ── Fulfillment ──
  const fulfillments: any[] = Array.isArray(order.fulfillments) ? order.fulfillments : []
  const lineItems: any[] = Array.isArray(order.line_items) ? order.line_items : []
  const totalQty = lineItems.reduce((s, li) => s + (Number(li.quantity) || 0), 0)
  const totalFulfilled = lineItems.reduce((s, li) => s + (Number(li.fulfillment_quantity) || 0), 0)
  const fulfillment: 'fulfilled' | 'partially_fulfilled' | 'unfulfilled' | 'closed' =
    String(order.status || '').toLowerCase() === 'cancel' ? 'closed'
    : totalFulfilled >= totalQty && totalQty > 0 ? 'fulfilled'
    : totalFulfilled > 0 ? 'partially_fulfilled'
    : 'unfulfilled'
  const fulfillmentLabel = fulfillment === 'partially_fulfilled' ? 'Partially fulfilled' : fulfillment.charAt(0).toUpperCase() + fulfillment.slice(1)
  const fulBadge = fulfillment === 'fulfilled' ? 'badge-success' : fulfillment === 'closed' ? 'badge-muted' : 'badge-warning'

  // ── Money ──
  const currency = String(order.currency || 'USD').toUpperCase()
  const subtotal = Number(order.subtotal_price) || lineItems.reduce((s, li) => s + (Number(li.total) || (Number(li.variant?.price) || Number(li.price) || 0) * (Number(li.quantity) || 0)), 0)
  const totalDiscounts = Number(order.discount?.total_value || order.total_discounts) || 0
  let totalShipping = Number(order.shipping_method?.price || order.total_shipping || order.shipping_total) || 0
  // Tax: live-compute from current /settings/taxes config (FE convention:
  // first_item_price = rate %). Always reflects latest rate even if order.tax
  // was stored with old value. BE Order.Calc keeps order.tax as-is so this
  // lookup is also what FE writes on update.
  // Resolve shipping country: prefer country_code, fall back to country_name → ISO code.
  // BE Customer model has both fields but orders usually only store country_name (e.g. "Vietnam").
  const resolvedCc = (
    order.shipping_address?.country_code
    || order.billing_address?.country_code
    || codeOfName(order.shipping_address?.country_name)
    || codeOfName(order.billing_address?.country_name)
    || ''
  ).toString().toLowerCase()

  let totalTax = Number(order.tax || order.total_tax || order.tax_total) || 0
  try {
    if (resolvedCc && subtotal > 0) {
      const ctx2 = createApiContext(req)
      const r = await computeOrderTax(ctx2, resolvedCc, subtotal)
      totalTax = r.amount
    }
  } catch (e: any) { console.warn('[tax-compute] render failed:', e?.message) }

  // ── Shipping method ──
  // Auto-pick shipping zone matching the resolved shipping country (mirrors
  // tax flow). When the order has no shipping_method yet, OR the saved method
  // is generic (no name), look up a zone whose country_codes include the
  // resolved country and apply its first method's price/name. Manual edits
  // via the "Edit shipping fees" picker still win — postOrderUpdateApi
  // accepts an explicit `shipping` payload that overrides this lookup.
  let shipMethodName: string = order.shipping_method?.name || ''
  const shipMethodDesc: string = order.shipping_method?.description || ''
  if (resolvedCc) {
    try {
      const ctx3 = createApiContext(req)
      const auto = await findShippingForCountry(ctx3, resolvedCc)
      if (auto) {
        // Only override when there is no explicit method or the stored price is 0
        if (!order.shipping_method || totalShipping === 0) {
          totalShipping = auto.price
          if (!shipMethodName) shipMethodName = auto.method_name
        }
      }
    } catch (e: any) { console.warn('[shipping-auto] render lookup failed:', e?.message) }
  }
  const shipSectionTitle = shipMethodName || 'Shipping'

  const paidAmount = isPaid ? totalPrice : Number(order.payment_method?.amount) || 0
  const balance = Math.max(0, totalPrice - paidAmount)

  // ── Customer / addresses ──
  const shippingAddr = order.shipping_address || {}
  const billingAddr = order.billing_address || {}
  const tags: string[] = Array.isArray(order.tags) ? order.tags : []
  const custName = shippingAddr.full_name
    || [shippingAddr.first_name, shippingAddr.last_name].filter(Boolean).join(' ').trim()
    || billingAddr.full_name
    || [billingAddr.first_name, billingAddr.last_name].filter(Boolean).join(' ').trim()
    || (shippingAddr.email || billingAddr.email ? String(shippingAddr.email || billingAddr.email).split('@')[0] : 'Guest')
  const custEmail = order.email || shippingAddr.email || billingAddr.email || ''
  const custPhone = order.phone || shippingAddr.phone || billingAddr.phone || ''
  const customerId = order.customer_id || shippingAddr.id || billingAddr.id || order.customer?._id || order.customer?.id || null

  // Tax region label (e.g. "Vietnam VAT 10%")
  const taxRegionName = String(shippingAddr.country_name || billingAddr.country_name
    || shippingAddr.country_code || billingAddr.country_code || '').trim()

  // Helpers + derived data
  const isDraft = tags.includes('draft')
  const sourceLabel = isDraft ? 'Draft Orders' : (order.source_name || '')
  const subtitle = sourceLabel ? `${esc(dateStr)} from ${esc(String(sourceLabel))}` : esc(dateStr)
  const userInitials = (user.name || user.email || 'U').split(/[\s@]/).filter(Boolean).slice(0, 2).map((s: string) => s[0]?.toUpperCase()).join('') || 'U'
  // Pencil edit icon
  const pencil = `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 3l3 3-9 9H5v-3l9-9z"/></svg>`
  const checkIcon = `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 10l3 3 7-7"/></svg>`
  const truckIcon = `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 6h10v8H2z"/><path d="M12 9h4l2 3v2h-6"/><circle cx="6" cy="15" r="1.5"/><circle cx="15" cy="15" r="1.5"/></svg>`
  const pinIcon = `<svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 18s6-5.4 6-10A6 6 0 004 8c0 4.6 6 10 6 10z"/><circle cx="10" cy="8" r="2"/></svg>`
  const warnIcon = `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M10 3l8 14H2l8-14z"/><path d="M10 8v4M10 14v.5"/></svg>`
  const clockIcon = `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/></svg>`

  // ========== EDIT MODE branch — Shopify-style edit-order layout ==========
  if (req.query.edit === '1') {
    const editContent = `
      <div style="max-width:1100px;margin:0 auto">
        <!-- Breadcrumb header -->
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <a href="${base}/orders" style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;color:var(--s-text-muted);text-decoration:none" title="Orders">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7l3-3h8l3 3v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/><path d="M7 11h6"/></svg>
          </a>
          <a href="${base}/orders/${esc(String(orderId))}" style="color:var(--s-text-muted);font-size:13px;text-decoration:none">#${esc(String(orderNumber))}</a>
          <span style="color:var(--s-text-dim);font-size:13px">&rsaquo;</span>
          <h1 style="margin:0;font-size:18px;font-weight:600;color:var(--s-text)">Edit order</h1>
        </div>
        <p style="margin:0 0 18px;font-size:12px;color:var(--s-text-muted)">${subtitle}</p>

        <div style="display:grid;grid-template-columns:1fr 320px;gap:20px;align-items:start">
          <!-- LEFT COLUMN -->
          <div>
            <!-- Items / Add product card -->
            <div class="card">
              <div style="padding:14px 16px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
                <span class="badge ${fulBadge}" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:4px 10px;text-transform:capitalize">${truckIcon} ${esc(fulfillment)}</span>
                <div style="display:flex;gap:8px">
                  <button type="button" class="btn btn-outline" style="font-size:13px;display:inline-flex;align-items:center;gap:4px" onclick="gxOpenAddProducts()"><span style="font-size:14px;line-height:1">+</span> Add product</button>
                  <button type="button" class="btn btn-outline" style="font-size:13px;display:inline-flex;align-items:center;gap:4px" onclick="gxComingSoon('Add custom item')"><span style="font-size:14px;line-height:1">+</span> Add custom item</button>
                </div>
              </div>
              <div style="display:grid;grid-template-columns:1fr auto auto auto auto;gap:0 16px;padding:8px 16px;border-top:1px solid var(--s-border);border-bottom:1px solid var(--s-border);font-size:11px;color:var(--s-text-muted);text-transform:none;font-weight:500;align-items:center">
                <span>Product</span>
                <span style="text-align:right">Price</span>
                <span style="text-align:center">Quantity</span>
                <span style="text-align:right;min-width:90px">Total</span>
                <span style="width:18px"></span>
              </div>
              ${lineItems.length > 0 ? lineItems.map((li: any, idx: number) => {
                const liId = li.id || li.short_id || li._id || `idx${idx}`
                const title = li.product_name || li.title || li.name || (li.variant?.name) || 'Unknown product'
                const variantName = li.variant?.name && li.variant.name !== title ? li.variant.name : ''
                const sku = li.product_sku || li.variant?.sku || li.sku || ''
                const qty = Number(li.quantity) || 0
                const price = Number(li.variant?.price ?? li.price) || 0
                const stock = Number(li.variant?.inventory ?? li.inventory_quantity ?? li.stock ?? 0)
                const showWarn = stock <= 0
                const img = li.variant?.image?.url || li.variant?.image || li.image?.url || li.image || li.image_url || li.featured_image || ''
                const lineTotal = Number(li.total) || price * qty
                return `
                  ${showWarn ? `
                    <div style="margin:10px 16px 0;padding:10px 14px;background:color-mix(in srgb, var(--s-warning, #f59e0b) 12%, transparent);border:1px solid color-mix(in srgb, var(--s-warning, #f59e0b) 40%, transparent);border-radius:8px;display:flex;align-items:center;gap:10px;font-size:13px;color:var(--s-text)">
                      <span style="color:var(--s-warning, #f59e0b);display:inline-flex">${warnIcon}</span>
                      <span>This line item only has ${stock} units in stock</span>
                    </div>
                  ` : ''}
                  <div class="gx-li" data-line-id="${esc(String(liId))}" data-orig-qty="${qty}" data-price-usd="${(toUsd(price, currency)).toFixed(4)}" style="display:grid;grid-template-columns:1fr auto auto auto auto;gap:8px 16px;padding:14px 16px;align-items:center;${idx > 0 && !showWarn ? 'border-top:1px solid var(--s-border);' : ''}">
                    <div style="display:flex;align-items:center;gap:12px;min-width:0">
                      <div style="width:40px;height:40px;flex-shrink:0;border-radius:6px;background:var(--s-bg);border:1px solid var(--s-border);display:flex;align-items:center;justify-content:center;color:var(--s-text-dim);overflow:hidden">
                        ${img ? `<img src="${esc(String(img))}" alt="" style="width:100%;height:100%;object-fit:cover">` : `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="14" height="14" rx="2"/><circle cx="8" cy="8" r="2"/><path d="M3 14l4-4 3 3 2-2 5 5"/></svg>`}
                      </div>
                      <div style="min-width:0">
                        <div style="font-weight:500;font-size:13px;color:var(--s-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(String(title))}</div>
                        ${variantName ? `<div style="color:var(--s-text-muted);font-size:12px">${esc(String(variantName))}</div>` : ''}
                        ${sku ? `<div style="color:var(--s-text-muted);font-size:12px">${esc(String(sku))}</div>` : ''}
                      </div>
                    </div>
                    <a href="javascript:void(0)" onclick="gxComingSoon('Edit unit price')" style="text-align:right;font-size:13px;color:var(--s-accent);text-decoration:none;white-space:nowrap">${fmtMoney(price, currency)}</a>
                    <input type="number" class="gx-qty" value="${qty}" min="0" data-line-id="${esc(String(liId))}" style="width:60px;padding:6px 8px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-card);color:var(--s-text);font-size:13px;text-align:center" />
                    <span class="gx-li-total" style="text-align:right;font-size:13px;font-weight:500;color:var(--s-text);white-space:nowrap;min-width:90px">${fmtMoney(lineTotal, currency)}</span>
                    <button type="button" class="gx-remove" data-line-id="${esc(String(liId))}" title="Remove" style="border:none;background:transparent;color:var(--s-text-muted);cursor:pointer;padding:4px;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px">
                      <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 5l10 10M15 5L5 15"/></svg>
                    </button>
                  </div>
                `
              }).join('') : '<p style="color:var(--s-text-muted);font-size:13px;text-align:center;padding:20px;margin:0">No line items</p>'}
            </div>

            <!-- Payment card -->
            <div class="card" id="gx-pay-card"
                 data-tax-rate="${subtotal > 0 ? (totalTax / subtotal).toFixed(6) : '0'}"
                 data-paid-usd="${(toUsd(payment === 'paid' ? totalPrice : 0, currency)).toFixed(4)}"
                 style="margin-top:16px">
              <div style="padding:14px 16px 6px;font-size:13px;font-weight:600;color:var(--s-text)">Payment</div>
              <div style="padding:0 16px 14px">
                <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:10px 16px;font-size:13px;align-items:baseline;border-top:1px solid var(--s-border);padding-top:14px">
                  <span style="color:var(--s-text)">Subtotal</span>
                  <span id="gx-pay-sub-detail" style="color:var(--s-text-muted)">${lineItems.length} item${lineItems.length !== 1 ? 's' : ''}</span>
                  <span id="gx-pay-sub" style="text-align:right;color:var(--s-text);min-width:120px">${fmtMoney(subtotal, currency)}</span>

                  <span id="gx-pay-ship-cell" style="color:${totalShipping > 0 ? 'var(--s-text)' : 'var(--s-accent)'};${totalShipping > 0 ? '' : 'cursor:pointer'}" ${totalShipping > 0 ? '' : 'onclick="gxOpenAddShipping()"'}>${totalShipping > 0 ? '<a href="javascript:void(0)" onclick="gxOpenAddShipping()" style="color:var(--s-accent);text-decoration:none">Edit shipping fees</a>' : 'Add shipping fee'}</span>
                  <span id="gx-pay-ship-detail" style="color:var(--s-text-muted);font-size:12px">${totalShipping > 0 && shipMethodName ? esc(shipMethodName) : ''}</span>
                  <span id="gx-pay-ship-amt" style="text-align:right;color:var(--s-text);min-width:120px">${totalShipping > 0 ? fmtMoney(totalShipping, currency) : ''}</span>

                  <a href="${base}/settings/taxes" id="gx-pay-tax-edit" title="Edit tax rates in Settings → Taxes" style="color:var(--s-accent);text-decoration:none">Taxes</a>
                  <span id="gx-pay-tax-detail" style="color:var(--s-text-muted)">${taxRegionName ? esc(taxRegionName) + ' ' : ''}VAT ${subtotal > 0 ? Math.round(totalTax / subtotal * 100) : 0}%</span>
                  <span id="gx-pay-tax" style="text-align:right;color:var(--s-text);min-width:120px">${fmtMoney(totalTax, currency)}</span>

                  <span style="color:var(--s-text);font-weight:700">Total</span>
                  <span></span>
                  <span id="gx-pay-total" style="text-align:right;color:var(--s-text);font-weight:700;min-width:120px">${fmtMoney(totalPrice, currency)}</span>
                </div>
              </div>
              <div style="padding:14px 16px;border-top:1px solid var(--s-border);display:grid;grid-template-columns:1fr auto;gap:0 16px;font-size:13px;align-items:center">
                <span style="color:var(--s-text)">Paid</span>
                <span id="gx-pay-paid" style="text-align:right;color:var(--s-text);min-width:120px">${payment === 'paid' ? fmtMoney(totalPrice, currency) : fmtMoney(0, currency)}</span>
              </div>
              <div id="gx-pay-bal-row" style="padding:10px 16px 14px;display:none;grid-template-columns:1fr auto;gap:0 16px;font-size:13px;align-items:center;border-top:1px solid var(--s-border)">
                <span style="color:var(--s-text)">Balance</span>
                <span id="gx-pay-bal" style="text-align:right;color:var(--s-text);min-width:120px">$0.00</span>
              </div>
              <div style="padding:10px 16px;border-top:1px solid var(--s-border);background:var(--s-bg, #0f172a);font-size:12px;color:var(--s-text-muted);border-radius:0 0 8px 8px">Taxes are estimated until you update the order</div>
            </div>

            <!-- Reason for edit -->
            <div class="card" style="margin-top:16px">
              <div style="padding:14px 16px 8px;font-size:13px;font-weight:600;color:var(--s-text)">Reason for edit</div>
              <div style="padding:0 16px 14px">
                <input type="text" placeholder="" onfocus="gxComingSoon('Reason for edit')" style="width:100%;padding:8px 10px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-card);color:var(--s-text);font-size:13px;outline:none" />
                <p style="margin:6px 0 0;font-size:11px;color:var(--s-text-muted)">Only visible to staff</p>
              </div>
            </div>

            <p style="margin:24px 0;text-align:center;font-size:13px;color:var(--s-text-muted)">
              <a href="javascript:void(0)" onclick="gxComingSoon('Editing orders documentation')" style="color:var(--s-text);text-decoration:underline;font-weight:500">Learn more</a> about editing orders
            </p>
          </div>

          <!-- RIGHT SIDEBAR -->
          <div>
            <div class="card">
              <div style="padding:14px 16px 8px;font-size:13px;font-weight:600;color:var(--s-text)">Summary</div>
              <div id="gx-edit-summary" style="padding:0 16px 14px;font-size:13px;color:var(--s-text-muted)">No changes have been made</div>
              <div id="gx-edit-status" style="padding:0 16px 8px;font-size:12px;color:var(--s-text-muted);min-height:1em"></div>
              <div style="padding:0 16px 16px">
                <button type="button" id="gx-edit-update" disabled style="width:100%;padding:10px;background:var(--s-card-hover, var(--s-bg));color:var(--s-text-dim);border:1px solid var(--s-border);border-radius:8px;font-size:13px;font-weight:600;cursor:not-allowed">Update order</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Edit-mode change tracking + Update wiring -->
      <script>
        // Wait until full DOM parsed so shipping/products modal nodes (defined later
        // in the template) are available for the override below to find them.
        function gxEditWire(){
          var SHOP_SLUG = ${JSON.stringify(store.slug)};
          var ORDER_ID = ${JSON.stringify(String(orderId))};
          var ORIG_SHIPPING_USD = ${(toUsd(totalShipping, currency)).toFixed(4)};
          var ORIG_SHIPPING_NAME = ${JSON.stringify(shipMethodName || '')};
          var TAX_REGION_NAME = ${JSON.stringify(taxRegionName)};
          var changes = { qty: {}, removed: [], reason: '', shipping: null };
          var btn = document.getElementById('gx-edit-update');
          var sumEl = document.getElementById('gx-edit-summary');
          var statusEl = document.getElementById('gx-edit-status');
          var payCard = document.getElementById('gx-pay-card');
          var TAX_RATE = Number(payCard?.getAttribute('data-tax-rate')) || 0;
          var PAID_USD = Number(payCard?.getAttribute('data-paid-usd')) || 0;

          function fmtUsd(n){ return '$' + (Number(n) || 0).toFixed(2); }
          function escHtml(s){ return String(s==null?'':s).replace(/[<>&]/g,function(c){return {'<':'&lt;','>':'&gt;','&':'&amp;'}[c];}); }

          // Recompute Payment card live in USD based on current state of line items + chosen shipping
          function recompute(){
            // Sum subtotal from visible (non-removed) line items
            var subUsd = 0, itemCount = 0;
            document.querySelectorAll('.gx-li').forEach(function(li){
              var id = li.getAttribute('data-line-id');
              if (changes.removed.indexOf(id) !== -1) return;
              var priceUsd = Number(li.getAttribute('data-price-usd')) || 0;
              var qInput = li.querySelector('.gx-qty');
              var q = qInput ? (parseInt(qInput.value, 10) || 0) : 0;
              if (q <= 0) return;
              subUsd += priceUsd * q;
              itemCount++;
            });
            // Shipping
            var shipUsd = changes.shipping ? changes.shipping.price : ORIG_SHIPPING_USD;
            var shipName = changes.shipping ? changes.shipping.methodName : ORIG_SHIPPING_NAME;
            // Tax: rate × subtotal (rate from BE Calc / order.tax stored value)
            var taxUsd = subUsd * TAX_RATE;
            var totalUsd = subUsd + taxUsd + shipUsd;
            var balanceUsd = Math.max(0, totalUsd - PAID_USD);

            var $ = function(id){ return document.getElementById(id); };
            if ($('gx-pay-sub')) $('gx-pay-sub').textContent = fmtUsd(subUsd);
            if ($('gx-pay-sub-detail')) $('gx-pay-sub-detail').textContent = itemCount + ' item' + (itemCount === 1 ? '' : 's');
            if ($('gx-pay-tax')) $('gx-pay-tax').textContent = fmtUsd(taxUsd);
            if ($('gx-pay-tax-detail')) $('gx-pay-tax-detail').textContent = (TAX_REGION_NAME ? TAX_REGION_NAME + ' ' : '') + 'VAT ' + Math.round(TAX_RATE * 100) + '%';
            if ($('gx-pay-total')) $('gx-pay-total').textContent = fmtUsd(totalUsd);

            // Shipping row UI
            var cell = $('gx-pay-ship-cell');
            var detail = $('gx-pay-ship-detail');
            var amt = $('gx-pay-ship-amt');
            if (shipUsd > 0 && cell){
              cell.innerHTML = '<a href="javascript:void(0)" onclick="gxOpenAddShipping()" style="color:var(--s-accent);text-decoration:none">Edit shipping fees</a>';
              cell.style.color = 'var(--s-text)';
              cell.removeAttribute('onclick');
              cell.style.cursor = '';
              if (detail) detail.textContent = shipName || '';
              if (amt) amt.textContent = fmtUsd(shipUsd);
            } else if (cell){
              cell.textContent = 'Add shipping fee';
              cell.style.color = 'var(--s-accent)';
              cell.style.cursor = 'pointer';
              cell.setAttribute('onclick', 'gxOpenAddShipping()');
              if (detail) detail.textContent = '';
              if (amt) amt.textContent = '';
            }

            // Balance row (show only if positive AND not fully paid)
            var balRow = $('gx-pay-bal-row');
            var balSpan = $('gx-pay-bal');
            if (balRow && balSpan){
              if (balanceUsd > 0.005){
                balRow.style.display = 'grid';
                balSpan.textContent = fmtUsd(balanceUsd);
              } else {
                balRow.style.display = 'none';
              }
            }
          }

          function dirty(){
            return Object.keys(changes.qty).length > 0
              || changes.removed.length > 0
              || changes.shipping !== null;
          }
          function refresh(){
            var msgs = [];
            Object.keys(changes.qty).forEach(function(id){
              var li = document.querySelector('.gx-li[data-line-id="'+CSS.escape(id)+'"]');
              var label = li ? (li.querySelector('.gx-li > div:first-child > div:last-child > div:first-child')?.textContent || id) : id;
              var orig = li ? Number(li.getAttribute('data-orig-qty')) : 0;
              msgs.push('• Qty: '+label+' '+orig+' → '+changes.qty[id]);
            });
            changes.removed.forEach(function(id){
              var li = document.querySelector('.gx-li[data-line-id="'+CSS.escape(id)+'"]');
              var label = li ? (li.querySelector('.gx-li > div:first-child > div:last-child > div:first-child')?.textContent || id) : id;
              msgs.push('• Removed: '+label);
            });
            if (changes.shipping) msgs.push('• Shipping: '+changes.shipping.methodName+' ($'+changes.shipping.price.toFixed(2)+')');
            if (msgs.length){
              sumEl.innerHTML = msgs.map(function(m){ return '<div style="margin-bottom:4px;color:var(--s-text)">'+m.replace(/[<>&]/g,function(c){return {'<':'&lt;','>':'&gt;','&':'&amp;'}[c];})+'</div>'; }).join('');
              btn.disabled = false;
              btn.style.background = 'var(--s-text)';
              btn.style.color = 'var(--s-bg)';
              btn.style.cursor = 'pointer';
              btn.style.border = 'none';
            } else {
              sumEl.textContent = 'No changes have been made';
              btn.disabled = true;
              btn.style.background = 'var(--s-card-hover, var(--s-bg))';
              btn.style.color = 'var(--s-text-dim)';
              btn.style.cursor = 'not-allowed';
              btn.style.border = '1px solid var(--s-border)';
            }
          }

          // Quantity changes
          document.querySelectorAll('.gx-qty').forEach(function(inp){
            inp.addEventListener('input', function(){
              var id = inp.getAttribute('data-line-id');
              var li = inp.closest('.gx-li');
              var orig = Number(li.getAttribute('data-orig-qty')) || 0;
              var v = Math.max(0, parseInt(inp.value, 10) || 0);
              if (v === orig) delete changes.qty[id]; else changes.qty[id] = v;
              // Update line total live (USD)
              var priceUsd = Number(li.getAttribute('data-price-usd')) || 0;
              var totalEl = li.querySelector('.gx-li-total');
              if (totalEl) totalEl.textContent = '$' + (priceUsd * v).toFixed(2);
              recompute();
              refresh();
            });
          });
          // Remove
          document.querySelectorAll('.gx-remove').forEach(function(btnX){
            btnX.addEventListener('click', function(){
              var id = btnX.getAttribute('data-line-id');
              var li = document.querySelector('.gx-li[data-line-id="'+CSS.escape(id)+'"]');
              if (!li) return;
              if (changes.removed.indexOf(id) === -1) changes.removed.push(id);
              li.style.opacity = '.4';
              li.style.pointerEvents = 'none';
              var totalEl = li.querySelector('.gx-li-total');
              if (totalEl) totalEl.style.textDecoration = 'line-through';
              recompute();
              refresh();
            });
          });

          // Tax override removed — BE PUT auto-recomputes tax via SubFeeService.Calc,
          // so any FE override is overwritten on save. Tax rates configured at
          // /settings/taxes; click "Taxes" link in Payment card to navigate there.

          // Hook shipping picker — overwrite gxOpenAddShipping done-handler to track instead of toast
          var origDone = null;
          document.addEventListener('change', function(ev){
            if (ev.target && ev.target.matches('input[name="gx-method"]')){
              var r = ev.target;
              changes.shipping = {
                zoneId: r.getAttribute('data-zone'),
                zoneName: r.getAttribute('data-zone-name'),
                methodIdx: Number(r.getAttribute('data-method-idx')),
                methodName: r.getAttribute('data-method-name'),
                price: Number(r.getAttribute('data-price')) || 0,
              };
            }
          });
          // Override done button of shipping modal: don't toast — just close + recompute + refresh
          var shipDone = document.getElementById('gx-ship-done');
          if (shipDone){
            var clone = shipDone.cloneNode(true);
            shipDone.parentNode.replaceChild(clone, shipDone);
            clone.addEventListener('click', function(){
              if (!changes.shipping) return;
              document.getElementById('gx-ship-overlay').classList.remove('show');
              document.body.style.overflow = '';
              recompute();
              refresh();
            });
          }

          // Update order
          btn.addEventListener('click', function(){
            if (!dirty()) return;
            btn.disabled = true;
            statusEl.textContent = 'Updating...';
            statusEl.style.color = 'var(--s-text-muted)';
            var reasonInput = document.querySelector('input[placeholder=""]');
            // Pull reason from the explicit textbox (Reason for edit input)
            var reasonBox = document.querySelector('.card input[type=text]:not([id])');
            var payload = {
              line_items_qty: changes.qty,
              removed_line_ids: changes.removed,
              shipping: changes.shipping,
              reason: reasonBox ? (reasonBox.value || '') : '',
            };
            fetch('/admin/store/'+encodeURIComponent(SHOP_SLUG)+'/api/orders/'+encodeURIComponent(ORDER_ID)+'/update', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Accept':'application/json', 'Content-Type':'application/json' },
              body: JSON.stringify(payload),
            }).then(function(r){
              if (!r.ok) return r.text().then(function(t){ throw new Error('HTTP '+r.status+(t?': '+t.slice(0,200):'')); });
              return r.json();
            }).then(function(){
              statusEl.textContent = 'Updated. Reloading...';
              statusEl.style.color = 'var(--s-success)';
              setTimeout(function(){ window.location.href = '/admin/store/'+encodeURIComponent(SHOP_SLUG)+'/orders/'+encodeURIComponent(ORDER_ID)+'?success='+encodeURIComponent('Order updated'); }, 600);
            }).catch(function(err){
              statusEl.textContent = err.message || 'Update failed';
              statusEl.style.color = 'var(--s-danger)';
              btn.disabled = false;
            });
          });
        }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', gxEditWire);
        else gxEditWire();
      </script>

      <!-- Coming Soon toast (shared helper) -->
      <style>
        #gx-toast{position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none}
        #gx-toast .gx-toast-item{background:var(--s-card);color:var(--s-text);border:1px solid var(--s-border);border-radius:10px;padding:12px 16px;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.25);display:flex;align-items:center;gap:10px;min-width:240px;max-width:340px;opacity:0;transform:translateY(8px);transition:opacity .18s ease,transform .18s ease;pointer-events:auto}
        #gx-toast .gx-toast-item.show{opacity:1;transform:translateY(0)}
        #gx-toast .gx-toast-icon{width:28px;height:28px;border-radius:50%;background:color-mix(in srgb, var(--s-warning, #f59e0b) 20%, transparent);color:var(--s-warning, #f59e0b);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px;font-weight:700}
        #gx-toast .gx-toast-body{flex:1;min-width:0;line-height:1.35}
        #gx-toast .gx-toast-title{font-weight:600;font-size:13px;color:var(--s-text)}
        #gx-toast .gx-toast-sub{font-size:11px;color:var(--s-text-muted);margin-top:2px}
      </style>
      <script>
        (function(){
          if (window.gxComingSoon) return;
          var host = null;
          function ensureHost(){ if (!host){ host = document.createElement('div'); host.id='gx-toast'; document.body.appendChild(host);} return host; }
          window.gxComingSoon = function(label){
            var h = ensureHost();
            var el = document.createElement('div');
            el.className = 'gx-toast-item';
            el.innerHTML = '<div class="gx-toast-icon">!</div><div class="gx-toast-body"><div class="gx-toast-title">Coming soon</div><div class="gx-toast-sub">'+(label?String(label).replace(/[<>&]/g,function(c){return {'<':'&lt;','>':'&gt;','&':'&amp;'}[c]}):'Tính năng đang phát triển')+'</div></div>';
            h.appendChild(el);
            requestAnimationFrame(function(){ el.classList.add('show'); });
            setTimeout(function(){ el.classList.remove('show'); setTimeout(function(){ el.remove(); }, 220); }, 2400);
          };
        })();
      </script>

      <!-- ========== Add Shipping Fee Modal ========== -->
      <style>
        #gx-ship-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9991;display:none;align-items:flex-start;justify-content:center;padding:48px 16px;overflow-y:auto}
        #gx-ship-overlay.show{display:flex}
        #gx-ship-modal{background:var(--s-card);border:1px solid var(--s-border);border-radius:12px;width:100%;max-width:560px;max-height:calc(100vh - 96px);display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.4);overflow:hidden}
        #gx-ship-modal h3{margin:0;font-size:15px;font-weight:600;color:var(--s-text)}
        #gx-ship-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--s-border);background:var(--s-card-hover, var(--s-bg))}
        #gx-ship-close{border:none;background:transparent;color:var(--s-text-muted);cursor:pointer;padding:4px;display:inline-flex;border-radius:4px}
        #gx-ship-close:hover{background:var(--s-bg);color:var(--s-text)}
        #gx-ship-search{padding:14px 18px 8px}
        #gx-ship-search .gx-input{display:flex;align-items:center;gap:8px;border:1px solid var(--s-border);border-radius:8px;padding:7px 12px;background:var(--s-card)}
        #gx-ship-search input{flex:1;border:none;background:transparent;color:var(--s-text);font-size:13px;outline:none}
        #gx-ship-list{flex:1;overflow-y:auto;min-height:200px}
        #gx-ship-list .gx-zone{padding:10px 18px;border-top:1px solid var(--s-border)}
        #gx-ship-list .gx-zone:first-child{border-top:none}
        #gx-ship-list .gx-zone-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-bottom:6px}
        #gx-ship-list .gx-zone-name{font-size:13px;font-weight:600;color:var(--s-text)}
        #gx-ship-list .gx-zone-cc{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end;max-width:60%}
        #gx-ship-list .gx-cc-chip{font-size:10px;padding:2px 6px;border-radius:4px;background:var(--s-card-hover, var(--s-bg));color:var(--s-text-muted);border:1px solid var(--s-border)}
        #gx-ship-list .gx-method{display:grid;grid-template-columns:auto 1fr auto;gap:10px 12px;align-items:center;padding:10px 12px;border:1px solid var(--s-border);border-radius:8px;margin-top:6px;cursor:pointer;background:var(--s-card)}
        #gx-ship-list .gx-method:hover{background:var(--s-card-hover, var(--s-bg))}
        #gx-ship-list .gx-method input{accent-color:var(--s-accent);width:16px;height:16px}
        #gx-ship-list .gx-method-name{font-size:13px;color:var(--s-text);font-weight:500}
        #gx-ship-list .gx-method-desc{font-size:11px;color:var(--s-text-muted);margin-top:2px}
        #gx-ship-list .gx-method-price{font-size:13px;color:var(--s-text);font-weight:600;white-space:nowrap}
        #gx-ship-empty,#gx-ship-loading,#gx-ship-error{padding:40px 18px;text-align:center;color:var(--s-text-muted);font-size:13px}
        #gx-ship-error{color:var(--s-danger)}
        #gx-ship-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid var(--s-border);background:var(--s-card)}
        #gx-ship-done{padding:7px 16px;background:var(--s-text);color:var(--s-bg);border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}
        #gx-ship-done:disabled{opacity:.5;cursor:not-allowed}
      </style>
      <div id="gx-ship-overlay" role="dialog" aria-modal="true">
        <div id="gx-ship-modal">
          <div id="gx-ship-head">
            <h3>Add shipping fee</h3>
            <button id="gx-ship-close" type="button" title="Close">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 5l10 10M15 5L5 15"/></svg>
            </button>
          </div>
          <div id="gx-ship-search">
            <label class="gx-input">
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="var(--s-text-muted)" stroke-width="1.5"><circle cx="9" cy="9" r="6"/><path d="M14 14l4 4"/></svg>
              <input id="gx-ship-q" type="text" placeholder="Search shipping zone" autocomplete="off">
            </label>
          </div>
          <div id="gx-ship-list"><div id="gx-ship-loading">Loading...</div></div>
          <div id="gx-ship-foot">
            <button type="button" class="btn btn-outline" style="font-size:13px" id="gx-ship-cancel">Cancel</button>
            <button type="button" id="gx-ship-done" disabled>Done</button>
          </div>
        </div>
      </div>
      <script>
        (function(){
          var SHOP_SLUG = ${JSON.stringify(store.slug)};
          var picked = null; // {zoneId, zoneName, methodIdx, methodName, price, currency:'USD'}
          var debounceT = null, lastQuery = '';
          function $(id){ return document.getElementById(id); }
          function escHtml(s){ return String(s==null?'':s).replace(/[<>&"]/g, function(c){return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c];}); }
          function fmtUsd(n){ var v = Number(n)||0; return '$'+v.toFixed(2); }
          var ov = $('gx-ship-overlay');
          function open(){ ov.classList.add('show'); document.body.style.overflow='hidden'; setTimeout(function(){ $('gx-ship-q').focus(); }, 50); load(''); }
          function close(){ ov.classList.remove('show'); document.body.style.overflow=''; picked = null; $('gx-ship-done').disabled = true; }
          function render(zones){
            var list = $('gx-ship-list');
            if (!zones || !zones.length){ list.innerHTML = '<div id="gx-ship-empty">No shipping zones configured</div>'; return; }
            var html = '';
            zones.forEach(function(z){
              var ccChips = (z.country_codes || []).slice(0, 8).map(function(c){ return '<span class="gx-cc-chip">'+escHtml(c)+'</span>'; }).join('');
              if ((z.country_codes||[]).length > 8) ccChips += '<span class="gx-cc-chip">+'+((z.country_codes.length)-8)+'</span>';
              html += '<div class="gx-zone">'
                + '<div class="gx-zone-head"><div class="gx-zone-name">'+escHtml(z.name)+(z.country_excluded?' <span style="color:var(--s-text-muted);font-weight:400">(excluded)</span>':'')+'</div>'
                + '<div class="gx-zone-cc">'+ccChips+'</div></div>';
              if (!z.shipping_methods || !z.shipping_methods.length){
                html += '<div style="padding:6px 0 4px;color:var(--s-text-dim);font-size:12px">No methods in this zone</div>';
              } else {
                z.shipping_methods.forEach(function(m){
                  var key = z.id+':'+m.idx;
                  html += '<label class="gx-method">'
                    + '<input type="radio" name="gx-method" value="'+escHtml(key)+'" data-zone="'+escHtml(z.id)+'" data-zone-name="'+escHtml(z.name)+'" data-method-idx="'+escHtml(m.idx)+'" data-method-name="'+escHtml(m.name)+'" data-price="'+escHtml(m.price)+'">'
                    + '<div><div class="gx-method-name">'+escHtml(m.name)+'</div>'+(m.description?'<div class="gx-method-desc">'+escHtml(m.description)+'</div>':'')+'</div>'
                    + '<div class="gx-method-price">'+fmtUsd(m.price)+'</div>'
                    + '</label>';
                });
              }
              html += '</div>';
            });
            list.innerHTML = html;
            list.querySelectorAll('input[type=radio]').forEach(function(r){
              r.addEventListener('change', function(){
                picked = {
                  zoneId: r.getAttribute('data-zone'),
                  zoneName: r.getAttribute('data-zone-name'),
                  methodIdx: r.getAttribute('data-method-idx'),
                  methodName: r.getAttribute('data-method-name'),
                  price: Number(r.getAttribute('data-price')) || 0,
                };
                $('gx-ship-done').disabled = false;
              });
            });
          }
          function load(q){
            lastQuery = q;
            $('gx-ship-list').innerHTML = '<div id="gx-ship-loading">Loading...</div>';
            var url = '/admin/store/'+encodeURIComponent(SHOP_SLUG)+'/api/shipping-zones'+(q?'?q='+encodeURIComponent(q):'');
            fetch(url, { credentials:'same-origin', headers:{ 'Accept':'application/json' } })
              .then(function(r){ if (!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
              .then(function(j){ if (q !== lastQuery) return; render(j.data || []); })
              .catch(function(e){ $('gx-ship-list').innerHTML = '<div id="gx-ship-error">'+escHtml(e.message||'Failed to load shipping zones')+'</div>'; });
          }
          window.gxOpenAddShipping = open;
          $('gx-ship-close').addEventListener('click', close);
          $('gx-ship-cancel').addEventListener('click', close);
          ov.addEventListener('click', function(e){ if (e.target === ov) close(); });
          document.addEventListener('keydown', function(e){ if (e.key === 'Escape' && ov.classList.contains('show')) close(); });
          $('gx-ship-q').addEventListener('input', function(e){
            clearTimeout(debounceT);
            var v = e.target.value.trim();
            debounceT = setTimeout(function(){ load(v); }, 300);
          });
          $('gx-ship-done').addEventListener('click', function(){
            if (!picked) return;
            window.gxComingSoon && window.gxComingSoon('Apply '+picked.methodName+' ($'+picked.price.toFixed(2)+') to order');
            close();
          });
        })();
      </script>

      <!-- ========== Add Products Modal ========== -->
      <style>
        #gx-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9990;display:none;align-items:flex-start;justify-content:center;padding:48px 16px;overflow-y:auto}
        #gx-modal-overlay.show{display:flex}
        #gx-modal{background:var(--s-card);border:1px solid var(--s-border);border-radius:12px;width:100%;max-width:640px;max-height:calc(100vh - 96px);display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.4);overflow:hidden}
        #gx-modal-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--s-border);background:var(--s-card-hover, var(--s-bg))}
        #gx-modal-head h3{margin:0;font-size:15px;font-weight:600;color:var(--s-text)}
        #gx-modal-close{border:none;background:transparent;color:var(--s-text-muted);cursor:pointer;padding:4px;display:inline-flex;align-items:center;justify-content:center;border-radius:4px}
        #gx-modal-close:hover{background:var(--s-bg);color:var(--s-text)}
        #gx-modal-search{padding:14px 18px 8px;display:flex;gap:10px;flex-wrap:wrap}
        #gx-modal-search .gx-input{flex:1;min-width:240px;display:flex;align-items:center;gap:8px;border:1px solid var(--s-border);border-radius:8px;padding:7px 12px;background:var(--s-card)}
        #gx-modal-search .gx-input input{flex:1;border:none;background:transparent;color:var(--s-text);font-size:13px;outline:none}
        #gx-modal-search .gx-select{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:160px;border:1px solid var(--s-border);border-radius:8px;padding:7px 12px;background:var(--s-card);color:var(--s-text);font-size:13px;cursor:pointer}
        #gx-modal-filter{padding:0 18px 8px}
        #gx-modal-filter .gx-chip{display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border:1px dashed var(--s-border);border-radius:999px;background:transparent;color:var(--s-text);font-size:12px;cursor:pointer}
        #gx-modal-thead{display:grid;grid-template-columns:auto 1fr auto auto;gap:12px;padding:8px 18px;background:var(--s-card-hover, var(--s-bg));border-top:1px solid var(--s-border);border-bottom:1px solid var(--s-border);font-size:11px;color:var(--s-text-muted);font-weight:500}
        #gx-modal-list{flex:1;overflow-y:auto;min-height:200px}
        #gx-modal-list .gx-row{display:grid;grid-template-columns:auto 1fr auto auto;gap:12px;align-items:center;padding:10px 18px;border-bottom:1px solid var(--s-border);font-size:13px}
        #gx-modal-list .gx-row:hover{background:var(--s-card-hover, var(--s-bg))}
        #gx-modal-list .gx-row input[type=checkbox]{width:16px;height:16px;accent-color:var(--s-accent)}
        #gx-modal-list .gx-prod{display:flex;align-items:center;gap:10px;min-width:0}
        #gx-modal-list .gx-thumb{width:32px;height:32px;flex-shrink:0;border-radius:5px;background:var(--s-bg);border:1px solid var(--s-border);display:flex;align-items:center;justify-content:center;color:var(--s-text-dim);overflow:hidden}
        #gx-modal-list .gx-prod-info{min-width:0}
        #gx-modal-list .gx-prod-title{color:var(--s-text);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        #gx-modal-list .gx-prod-sub{color:var(--s-danger);font-size:11px;margin-top:2px}
        #gx-modal-list .gx-avail{display:inline-flex;align-items:center;gap:4px;color:var(--s-text-muted);font-size:13px;white-space:nowrap}
        #gx-modal-list .gx-avail .gx-warn{color:var(--s-warning, #f59e0b)}
        #gx-modal-list .gx-price{color:var(--s-text);text-align:right;white-space:nowrap;min-width:90px}
        #gx-modal-empty,#gx-modal-loading,#gx-modal-error{padding:40px 18px;text-align:center;color:var(--s-text-muted);font-size:13px}
        #gx-modal-error{color:var(--s-danger)}
        #gx-modal-foot{display:flex;align-items:center;justify-content:space-between;padding:12px 18px;border-top:1px solid var(--s-border);background:var(--s-card)}
        #gx-modal-count{font-size:13px;color:var(--s-text-muted)}
        #gx-modal-foot .gx-actions{display:flex;gap:8px}
        #gx-modal-done{padding:7px 16px;background:var(--s-text);color:var(--s-bg);border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}
        #gx-modal-done:disabled{opacity:.5;cursor:not-allowed}
      </style>
      <div id="gx-modal-overlay" role="dialog" aria-modal="true">
        <div id="gx-modal">
          <div id="gx-modal-head">
            <h3>Add products</h3>
            <button id="gx-modal-close" type="button" title="Close">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 5l10 10M15 5L5 15"/></svg>
            </button>
          </div>
          <div id="gx-modal-search">
            <label class="gx-input">
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="var(--s-text-muted)" stroke-width="1.5"><circle cx="9" cy="9" r="6"/><path d="M14 14l4 4"/></svg>
              <input id="gx-modal-q" type="text" placeholder="Search products" autocomplete="off">
            </label>
            <button type="button" class="gx-select" onclick="gxComingSoon('Search-by filter')">
              Search by All
              <svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 8l5 4 5-4M5 12l5 4 5-4"/></svg>
            </button>
          </div>
          <div id="gx-modal-filter">
            <button type="button" class="gx-chip" onclick="gxComingSoon('Add filter')">Add filter <span style="font-size:13px;line-height:1">+</span></button>
          </div>
          <div id="gx-modal-thead">
            <span style="width:16px"></span>
            <span>Product</span>
            <span>Available</span>
            <span style="text-align:right">Price</span>
          </div>
          <div id="gx-modal-list"><div id="gx-modal-loading">Loading...</div></div>
          <div id="gx-modal-foot">
            <span id="gx-modal-count">0 products selected</span>
            <div class="gx-actions">
              <button type="button" class="btn btn-outline" style="font-size:13px" id="gx-modal-cancel">Cancel</button>
              <button type="button" id="gx-modal-done" disabled>Done</button>
            </div>
          </div>
        </div>
      </div>
      <script>
        (function(){
          var SHOP_SLUG = ${JSON.stringify(store.slug)};
          var CURRENCY = ${JSON.stringify(currency)};
          var EXISTING_IDS = ${JSON.stringify(lineItems.map((li: any) => String(li.product_id || li.id || '')).filter(Boolean))};
          var existing = new Set(EXISTING_IDS);
          var selected = new Map();
          var lastQuery = '';
          var debounceT = null;

          var FX_TO_USD = { USD:1, VND:25500, EUR:0.92, GBP:0.78, JPY:155, CNY:7.2, AUD:1.5 };
          function fmtMoney(n, cur){ var v = Number(n)||0; var c = String(cur||'USD').toUpperCase(); var r = FX_TO_USD[c]; if (r==null) r = 1; var usd = c==='USD' ? v : v/r; return '$'+usd.toFixed(2); }
          function escHtml(s){ return String(s==null?'':s).replace(/[<>&"]/g, function(c){return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c];}); }

          function $(id){ return document.getElementById(id); }
          var ov = $('gx-modal-overlay');

          function open(){ ov.classList.add('show'); document.body.style.overflow='hidden'; setTimeout(function(){ $('gx-modal-q').focus(); }, 50); load(''); }
          function close(){ ov.classList.remove('show'); document.body.style.overflow=''; selected.clear(); updateCount(); }

          function updateCount(){ var n=selected.size; $('gx-modal-count').textContent = n+' product'+(n===1?'':'s')+' selected'; $('gx-modal-done').disabled = n===0; }

          function render(items){
            var list = $('gx-modal-list');
            if (!items || !items.length){ list.innerHTML = '<div id="gx-modal-empty">No products found</div>'; return; }
            var html = '';
            items.forEach(function(p){
              var isExisting = existing.has(String(p.id));
              var isSelected = selected.has(String(p.id));
              var stock = Number(p.available)||0;
              var stockHtml = stock > 0
                ? '<span class="gx-avail">'+stock+'</span>'
                : '<span class="gx-avail"><span class="gx-warn"><svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M10 3l8 14H2l8-14z"/><path d="M10 8v4M10 14v.5"/></svg></span> 0</span>';
              var imgHtml = p.image
                ? '<img src="'+escHtml(p.image)+'" alt="" style="width:100%;height:100%;object-fit:cover">'
                : '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="14" height="14" rx="2"/><circle cx="8" cy="8" r="2"/><path d="M3 14l4-4 3 3 2-2 5 5"/></svg>';
              html += '<label class="gx-row">'
                + '<input type="checkbox" data-id="'+escHtml(p.id)+'" data-title="'+escHtml(p.title)+'" data-price="'+escHtml(p.price)+'"' + (isSelected?' checked':'') + (isExisting?' disabled':'') + '>'
                + '<div class="gx-prod"><div class="gx-thumb">'+imgHtml+'</div><div class="gx-prod-info"><div class="gx-prod-title">'+escHtml(p.title)+'</div>'
                + (isExisting ? '<div class="gx-prod-sub">This item is already in the order</div>' : '')
                + '</div></div>'
                + stockHtml
                + '<span class="gx-price">'+escHtml(fmtMoney(p.price, p.currency || CURRENCY))+'</span>'
                + '</label>';
            });
            list.innerHTML = html;
            list.querySelectorAll('input[type=checkbox]').forEach(function(cb){
              cb.addEventListener('change', function(){
                var id = cb.getAttribute('data-id');
                if (cb.checked) selected.set(id, { id: id, title: cb.getAttribute('data-title'), price: cb.getAttribute('data-price') });
                else selected.delete(id);
                updateCount();
              });
            });
          }

          function load(q){
            lastQuery = q;
            $('gx-modal-list').innerHTML = '<div id="gx-modal-loading">Loading...</div>';
            var url = '/admin/store/'+encodeURIComponent(SHOP_SLUG)+'/api/products-search?limit=20'+(q?'&q='+encodeURIComponent(q):'');
            fetch(url, { credentials: 'same-origin', headers: { 'Accept':'application/json' } })
              .then(function(r){ if (!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
              .then(function(j){ if (q !== lastQuery) return; render(j.data || []); })
              .catch(function(e){ $('gx-modal-list').innerHTML = '<div id="gx-modal-error">'+escHtml(e.message||'Failed to load products')+'</div>'; });
          }

          // Wire events
          window.gxOpenAddProducts = open;
          $('gx-modal-close').addEventListener('click', close);
          $('gx-modal-cancel').addEventListener('click', close);
          ov.addEventListener('click', function(e){ if (e.target === ov) close(); });
          document.addEventListener('keydown', function(e){ if (e.key === 'Escape' && ov.classList.contains('show')) close(); });
          $('gx-modal-q').addEventListener('input', function(e){
            clearTimeout(debounceT);
            var v = e.target.value.trim();
            debounceT = setTimeout(function(){ load(v); }, 300);
          });
          $('gx-modal-done').addEventListener('click', function(){
            var arr = Array.from(selected.values());
            if (!arr.length) return;
            window.gxComingSoon && window.gxComingSoon('Add '+arr.length+' product'+(arr.length===1?'':'s')+' to order');
            close();
          });
        })();
      </script>
    `

    res.send(sellerLayout({
      title: `Edit order #${orderNumber}`,
      storeName: store.name, storeSlug: store.slug,
      userName: user.name, userEmail: user.email, userRole: user.role, storeRole: user.storeRole,
      activePage: 'orders', content: editContent, theme: theme as 'dark' | 'light',
    }))
    return
  }
  // ========== /EDIT MODE ==========

  const content = `
    <div style="max-width:1100px;margin:0 auto">
      ${successMsg ? `<div style="background:var(--s-success-bg,#065f46);color:#fff;padding:10px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">${esc(successMsg)}</div>` : ''}
      ${errorMsg ? `<div style="background:#7f1d1d;color:#fff;padding:10px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">${esc(decodeURIComponent(errorMsg))}</div>` : ''}

      <!-- ============== PAGE HEADER ============== -->
      <div class="page-header">
        <div style="display:flex;align-items:center;gap:12px">
          <a href="${base}/orders" style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;color:var(--s-text-muted);text-decoration:none" title="Back to orders" onmouseover="this.style.background='var(--s-card-hover, var(--s-bg))'" onmouseout="this.style.background='transparent'">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4l-6 6 6 6"/></svg>
          </a>
          <div>
            <h1 class="page-title" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:18px;margin:0">
              #${esc(String(orderNumber))}
              <span class="badge ${payBadge}" style="font-size:11px;padding:2px 10px;text-transform:capitalize">${esc(payment)}</span>
              <span class="badge ${fulBadge}" style="font-size:11px;padding:2px 10px;text-transform:capitalize">${esc(fulfillment)}</span>
            </h1>
            <p class="page-subtitle" style="margin:4px 0 0;font-size:12px;color:var(--s-text-muted)">${subtitle}</p>
          </div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          ${fulfillment === 'fulfilled' || fulfillment === 'closed'
            ? `<button type="button" class="btn btn-outline" style="font-size:13px" onclick="gxComingSoon('Restock')">Restock</button>`
            : `<button type="button" class="btn btn-outline" style="font-size:13px" onclick="gxComingSoon('Refund')">Refund</button>`}
          <a href="${base}/orders/${esc(String(orderId))}?edit=1" class="btn btn-outline" style="font-size:13px">Edit</a>
          <button type="button" class="btn btn-outline" style="font-size:13px;display:inline-flex;align-items:center;gap:4px" onclick="window.print()">Print <span style="font-size:9px">&#9660;</span></button>
          <details class="gx-menu" style="position:relative">
            <summary class="btn btn-outline" style="font-size:13px;list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:4px">More actions <span style="font-size:9px">&#9660;</span></summary>
            <div style="position:absolute;right:0;top:calc(100% + 4px);background:var(--s-card);border:1px solid var(--s-border);border-radius:8px;padding:6px;min-width:200px;z-index:30;box-shadow:0 6px 16px rgba(0,0,0,0.25)">
              <a href="javascript:void(0)" onclick="gxComingSoon('Create return')" style="display:block;padding:8px 12px;color:var(--s-text);text-decoration:none;font-size:13px;border-radius:6px" onmouseover="this.style.background='var(--s-bg)'" onmouseout="this.style.background='transparent'">Create return</a>
              <a href="javascript:void(0)" onclick="gxComingSoon('Duplicate order')" style="display:block;padding:8px 12px;color:var(--s-text);text-decoration:none;font-size:13px;border-radius:6px" onmouseover="this.style.background='var(--s-bg)'" onmouseout="this.style.background='transparent'">Duplicate</a>
              <a href="javascript:void(0)" onclick="gxComingSoon('Cancel order')" style="display:block;padding:8px 12px;color:var(--s-danger);text-decoration:none;font-size:13px;border-radius:6px" onmouseover="this.style.background='var(--s-bg)'" onmouseout="this.style.background='transparent'">Cancel order</a>
            </div>
          </details>
          <div style="display:inline-flex;border:1px solid var(--s-border);border-radius:6px;overflow:hidden;margin-left:6px">
            <button type="button" class="btn" disabled style="border:none;background:transparent;padding:6px 8px;color:var(--s-text-dim);cursor:not-allowed" title="Previous order">
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 8l-4 4-4-4" transform="rotate(90 10 10)"/></svg>
            </button>
            <button type="button" class="btn" disabled style="border:none;border-left:1px solid var(--s-border);background:transparent;padding:6px 8px;color:var(--s-text-dim);cursor:not-allowed" title="Next order">
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 8l-4 4-4-4" transform="rotate(-90 10 10)"/></svg>
            </button>
          </div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 360px;gap:20px;align-items:start">
        <!-- ============== LEFT COLUMN ============== -->
        <div>
          <!-- ITEMS / SHIPPING CARD -->
          <div class="card">
            <div style="padding:14px 16px;display:flex;flex-wrap:wrap;gap:8px;align-items:center">
              <span class="badge ${fulBadge}" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:4px 10px">
                ${truckIcon} ${esc(fulfillmentLabel)}
              </span>
              <span class="badge badge-muted" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:4px 10px">
                ${pinIcon} Shop location
              </span>
            </div>
            <div style="padding:10px 16px;border-top:1px solid var(--s-border);border-bottom:1px solid var(--s-border);display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--s-text)">
              ${truckIcon} ${esc(shipSectionTitle)}
            </div>
            <div style="padding:0">
              ${lineItems.length > 0 ? lineItems.map((li: any, idx: number) => {
                const title = li.product_name || li.title || li.name || (li.variant?.name) || 'Unknown product'
                const variantName = li.variant?.name && li.variant.name !== title ? li.variant.name : ''
                const sku = li.product_sku || li.variant?.sku || li.sku || ''
                const qty = Number(li.quantity) || 0
                const price = Number(li.variant?.price ?? li.price) || 0
                const lineTotal = Number(li.total) || price * qty
                const img = li.variant?.image?.url || li.variant?.image || li.image?.url || li.image || li.image_url || li.featured_image || ''
                return `
                  <div style="display:grid;grid-template-columns:1fr auto auto auto;gap:16px;align-items:center;padding:14px 16px;${idx > 0 ? 'border-top:1px solid var(--s-border);' : ''}">
                    <div style="display:flex;align-items:center;gap:12px;min-width:0">
                      <div style="width:40px;height:40px;flex-shrink:0;border-radius:6px;background:var(--s-bg);border:1px solid var(--s-border);display:flex;align-items:center;justify-content:center;color:var(--s-text-dim);overflow:hidden">
                        ${img ? `<img src="${esc(String(img))}" alt="" style="width:100%;height:100%;object-fit:cover">` : `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="14" height="14" rx="2"/><circle cx="8" cy="8" r="2"/><path d="M3 14l4-4 3 3 2-2 5 5"/></svg>`}
                      </div>
                      <div style="min-width:0">
                        <div style="font-weight:500;font-size:13px;color:var(--s-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(String(title))}</div>
                        ${variantName ? `<div style="color:var(--s-text-muted);font-size:12px">${esc(String(variantName))}</div>` : ''}
                        ${sku ? `<div style="color:var(--s-text-muted);font-size:12px">${esc(String(sku))}</div>` : ''}
                      </div>
                    </div>
                    <div style="font-size:13px;color:var(--s-text-muted);white-space:nowrap">${fmtMoney(price, currency)}</div>
                    <div style="font-size:13px;color:var(--s-text-muted);white-space:nowrap">&times; ${qty}</div>
                    <div style="font-size:13px;color:var(--s-text);font-weight:500;white-space:nowrap;min-width:90px;text-align:right">${fmtMoney(lineTotal, currency)}</div>
                  </div>
                `
              }).join('') : '<p style="color:var(--s-text-muted);font-size:13px;text-align:center;padding:20px;margin:0">No line items</p>'}
            </div>
            ${(fulfillment !== 'fulfilled' && fulfillment !== 'closed') ? `
              <div style="padding:12px 16px;border-top:1px solid var(--s-border);display:flex;justify-content:flex-end">
                <div style="display:inline-flex;border-radius:8px;overflow:hidden;background:var(--s-text)">
                  <button type="button" onclick="gxComingSoon('Mark as fulfilled')" style="border:none;padding:8px 14px;background:transparent;color:var(--s-bg);font-size:13px;font-weight:600;cursor:pointer">Mark as fulfilled</button>
                  <details style="position:relative">
                    <summary style="list-style:none;cursor:pointer;padding:8px 10px;color:var(--s-bg);border-left:1px solid color-mix(in srgb, var(--s-bg) 30%, transparent);display:inline-flex;align-items:center"><span style="font-size:9px">&#9660;</span></summary>
                    <div style="position:absolute;right:0;top:calc(100% + 4px);background:var(--s-card);border:1px solid var(--s-border);border-radius:8px;padding:6px;min-width:200px;z-index:20;box-shadow:0 6px 16px rgba(0,0,0,0.25)">
                      <a href="javascript:void(0)" onclick="gxComingSoon('Fulfill items partially')" style="display:block;padding:8px 12px;color:var(--s-text);text-decoration:none;font-size:13px;border-radius:6px" onmouseover="this.style.background='var(--s-bg)'" onmouseout="this.style.background='transparent'">Fulfill items partially</a>
                      <a href="javascript:void(0)" onclick="gxComingSoon('Print packing slip')" style="display:block;padding:8px 12px;color:var(--s-text);text-decoration:none;font-size:13px;border-radius:6px" onmouseover="this.style.background='var(--s-bg)'" onmouseout="this.style.background='transparent'">Print packing slip</a>
                    </div>
                  </details>
                </div>
              </div>
            ` : ''}
          </div>

          <!-- PAYMENT CARD -->
          <div class="card" style="margin-top:16px">
            <div style="padding:14px 16px;display:flex;justify-content:space-between;align-items:center">
              <span class="badge ${payBadge}" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:4px 10px">
                ${payment === 'paid' ? checkIcon : payment === 'refunded' ? warnIcon : clockIcon} ${esc(paymentLabel)}
              </span>
              <span style="color:var(--s-text-muted);font-size:18px;line-height:1;letter-spacing:1px;cursor:pointer" title="More" onclick="gxComingSoon('Payment actions menu')">&hellip;</span>
            </div>
            <div style="padding:0 16px 14px">
              <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:10px 16px;font-size:13px;align-items:baseline">
                <span style="color:var(--s-text)">Subtotal</span>
                <span style="color:var(--s-text-muted)">${lineItems.length} item${lineItems.length !== 1 ? 's' : ''}</span>
                <span style="text-align:right;color:var(--s-text);min-width:120px">${fmtMoney(subtotal, currency)}</span>

                ${totalDiscounts > 0 ? `
                  <span style="color:var(--s-text)">Discount</span>
                  <span></span>
                  <span style="text-align:right;color:var(--s-success);min-width:120px">-${fmtMoney(totalDiscounts, currency)}</span>
                ` : ''}

                ${totalShipping > 0 || shipMethodName ? `
                  <span style="color:var(--s-text)">Shipping</span>
                  <span style="color:var(--s-text-muted);font-size:12px">${shipMethodName ? esc(shipMethodName) : ''}${shipMethodDesc ? ' (' + esc(shipMethodDesc) + ')' : ''}</span>
                  <span style="text-align:right;color:var(--s-text);min-width:120px">${fmtMoney(totalShipping, currency)}</span>
                ` : ''}

                ${(totalTax > 0 || taxRegionName) ? `
                  <a href="${base}/settings/taxes" style="color:var(--s-accent);text-decoration:none" title="Edit tax rates in Settings → Taxes">Taxes</a>
                  <span style="color:var(--s-text-muted)">${taxRegionName ? esc(taxRegionName) + ' ' : ''}VAT ${subtotal > 0 ? Math.round(totalTax / subtotal * 100) : 0}%</span>
                  <span style="text-align:right;color:var(--s-text);min-width:120px">${fmtMoney(totalTax, currency)}</span>
                ` : ''}

                <span style="color:var(--s-text);font-weight:700">Total</span>
                <span></span>
                <span style="text-align:right;color:var(--s-text);font-weight:700;min-width:120px">${fmtMoney(totalPrice, currency)}</span>
              </div>
            </div>
            <div style="padding:12px 16px;border-top:1px solid var(--s-border);display:grid;grid-template-columns:1fr auto;gap:6px 16px;font-size:13px;align-items:center">
              <span style="color:var(--s-text)">Paid</span>
              <span style="text-align:right;color:var(--s-text);min-width:120px">${fmtMoney(paidAmount, currency)}</span>
              ${balance > 0 ? `
                <span style="color:var(--s-text)">Balance</span>
                <span style="display:flex;justify-content:space-between;gap:8px;align-items:baseline;grid-column:1 / -1">
                  <span style="color:var(--s-text-muted);font-size:12px">${tags.includes('draft') ? 'Payment due when invoice is sent' : 'Payment due'}</span>
                  <span style="color:var(--s-text);min-width:120px;text-align:right">${fmtMoney(balance, currency)}</span>
                </span>
              ` : ''}
            </div>
            ${!isPaid && balance > 0 ? `
              <div style="padding:12px 16px;border-top:1px solid var(--s-border);display:flex;justify-content:flex-end;gap:8px">
                <button type="button" class="btn btn-outline" style="font-size:13px" onclick="gxComingSoon('Send invoice')">Send invoice</button>
                <button type="button" style="background:var(--s-text);color:var(--s-bg);padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:none" onclick="gxComingSoon('Mark as paid')">Mark as paid</button>
              </div>
            ` : ''}
          </div>

          <!-- TIMELINE (no card wrapper, ShopBase style) -->
          <div style="margin-top:24px">
            <h2 style="font-size:14px;font-weight:600;margin:0 0 12px;color:var(--s-text)">Timeline</h2>

            <!-- Comment box -->
            <div style="display:flex;gap:10px;align-items:flex-start;padding:12px;background:var(--s-card);border:1px solid var(--s-border);border-radius:10px">
              <div style="width:32px;height:32px;flex-shrink:0;border-radius:6px;background:var(--s-success, #22c55e);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600">${esc(userInitials)}</div>
              <div style="flex:1;min-width:0">
                <input type="text" placeholder="Leave a comment..." onfocus="gxComingSoon('Order comments')" style="width:100%;border:none;background:transparent;color:var(--s-text);font-size:13px;padding:4px 0;outline:none">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
                  <div style="display:flex;gap:8px;color:var(--s-text-dim);font-size:14px">
                    <span title="Emoji" style="cursor:pointer" onclick="gxComingSoon('Emoji picker')">&#9786;</span>
                    <span title="Mention" style="cursor:pointer" onclick="gxComingSoon('Mention staff')">@</span>
                    <span title="Hashtag" style="cursor:pointer" onclick="gxComingSoon('Hashtag')">#</span>
                    <span title="Attach link" style="cursor:pointer" onclick="gxComingSoon('Attach link')">&#128279;</span>
                  </div>
                  <button type="button" class="btn btn-outline" style="font-size:12px;padding:4px 12px" onclick="gxComingSoon('Post comment')">Post</button>
                </div>
              </div>
            </div>
            <p style="margin:6px 4px 0;font-size:11px;color:var(--s-text-dim);text-align:right">Only you and other staff can see comments</p>

            <!-- Activity feed (placeholder when no events available from API) -->
            <div style="margin-top:18px;padding-left:16px;position:relative">
              <div style="position:absolute;left:5px;top:8px;bottom:8px;width:2px;background:var(--s-border)"></div>
              <div style="font-size:12px;color:var(--s-text-muted);font-weight:500;margin-bottom:10px">Yesterday</div>
              <div style="position:relative;padding-left:16px;padding-bottom:14px">
                <div style="position:absolute;left:-12px;top:4px;width:10px;height:10px;background:var(--s-text);border:2px solid var(--s-card);border-radius:50%"></div>
                <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
                  <span style="font-size:13px;color:var(--s-text)">Order #${esc(String(orderNumber))} created${created ? '' : ''}</span>
                  <span style="font-size:12px;color:var(--s-text-muted);white-space:nowrap">${created ? new Date(created).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- ============== RIGHT COLUMN (SIDEBAR) ============== -->
        <div>
          <!-- Notes -->
          <div class="card">
            <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
              <span>Notes</span>
              <a href="javascript:void(0)" onclick="gxComingSoon('Edit notes')" title="Edit notes" style="color:var(--s-text-muted);text-decoration:none">${pencil}</a>
            </div>
            <div class="card-body">
              ${order.note
                ? `<p style="font-size:13px;color:var(--s-text);white-space:pre-wrap;margin:0">${esc(String(order.note))}</p>`
                : '<p style="font-size:13px;color:var(--s-text-dim);margin:0">No notes from customer</p>'}
            </div>
          </div>

          <!-- Customer card (combined: customer + contact + shipping + billing) -->
          <div class="card" style="margin-top:14px">
            <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
              <span>Customer</span>
              <span style="color:var(--s-text-muted);font-size:18px;line-height:1;letter-spacing:1px;cursor:pointer" title="More" onclick="gxComingSoon('Customer actions menu')">&hellip;</span>
            </div>
            <div class="card-body" style="display:flex;flex-direction:column;gap:14px">
              <!-- Customer name + order count -->
              <div style="display:flex;flex-direction:column;gap:4px;font-size:13px">
                ${customerId
                  ? `<a href="${base}/customers/${esc(String(customerId))}" style="color:var(--s-accent);text-decoration:none;font-weight:600">${esc(custName.toUpperCase())}</a>
                     <a href="${base}/customers/${esc(String(customerId))}?tab=orders" style="color:var(--s-accent);text-decoration:none;font-size:12px">1 order</a>`
                  : `<span style="font-weight:600">${esc(custName)}</span><span style="color:var(--s-text-dim);font-size:12px">Guest checkout</span>`}
              </div>
              <!-- Contact information -->
              <div>
                <div style="font-size:13px;font-weight:600;color:var(--s-text);margin-bottom:6px">Contact information</div>
                <div style="display:flex;flex-direction:column;gap:4px;font-size:13px">
                  ${custEmail ? `<div style="color:var(--s-text);word-break:break-all">${esc(String(custEmail))}</div>` : '<div style="color:var(--s-text-dim)">No email provided</div>'}
                  ${custPhone ? `<div style="color:var(--s-text)">${esc(String(custPhone))}</div>` : '<div style="color:var(--s-text-dim)">No phone number</div>'}
                </div>
              </div>
              <!-- Shipping address -->
              <div>
                <div style="font-size:13px;font-weight:600;color:var(--s-text);margin-bottom:6px">Shipping address</div>
                ${fmtAddr(shippingAddr) || '<div style="color:var(--s-text-dim);font-size:13px">No shipping address provided</div>'}
              </div>
              <!-- Billing address -->
              <div>
                <div style="font-size:13px;font-weight:600;color:var(--s-text);margin-bottom:6px">Billing address</div>
                ${fmtAddr(billingAddr) || '<div style="color:var(--s-text-dim);font-size:13px">No billing address provided</div>'}
              </div>
            </div>
          </div>

          <!-- Conversion summary placeholder -->
          <div class="card" style="margin-top:14px">
            <div class="card-header"><span>Conversion summary</span></div>
            <div class="card-body">
              <p style="font-size:13px;color:var(--s-text-muted);margin:0 0 8px">There aren't any conversion details available for this order</p>
              <a href="javascript:void(0)" onclick="gxComingSoon('Conversion analytics')" style="font-size:12px;color:var(--s-accent);text-decoration:none">Learn more</a>
            </div>
          </div>

          <!-- Order risk placeholder -->
          <div class="card" style="margin-top:14px">
            <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
              <span>Order risk</span>
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="var(--s-text-muted)" stroke-width="1.5"><circle cx="9" cy="9" r="6"/><path d="M14 14l4 4"/></svg>
            </div>
            <div class="card-body">
              <p style="font-size:13px;color:var(--s-text-muted);margin:0">Analysis not available</p>
            </div>
          </div>

          <!-- Tags -->
          <div class="card" style="margin-top:14px">
            <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
              <span>Tags</span>
              <a href="javascript:void(0)" onclick="gxComingSoon('Edit tags')" title="Edit tags" style="color:var(--s-text-muted);text-decoration:none">${pencil}</a>
            </div>
            <div class="card-body">
              ${tags.length > 0
                ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${tags.map(t => `<span class="badge badge-muted" style="font-size:11px;padding:3px 8px">${esc(String(t))}</span>`).join('')}</div>`
                : `<div style="border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);min-height:40px"></div>`}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Gbox Coming Soon toast (global helper for unimplemented actions) -->
    <style>
      #gx-toast{position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none}
      #gx-toast .gx-toast-item{background:var(--s-card);color:var(--s-text);border:1px solid var(--s-border);border-radius:10px;padding:12px 16px;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.25);display:flex;align-items:center;gap:10px;min-width:240px;max-width:340px;opacity:0;transform:translateY(8px);transition:opacity .18s ease,transform .18s ease;pointer-events:auto}
      #gx-toast .gx-toast-item.show{opacity:1;transform:translateY(0)}
      #gx-toast .gx-toast-icon{width:28px;height:28px;border-radius:50%;background:color-mix(in srgb, var(--s-warning, #f59e0b) 20%, transparent);color:var(--s-warning, #f59e0b);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px;font-weight:700}
      #gx-toast .gx-toast-body{flex:1;min-width:0;line-height:1.35}
      #gx-toast .gx-toast-title{font-weight:600;font-size:13px;color:var(--s-text)}
      #gx-toast .gx-toast-sub{font-size:11px;color:var(--s-text-muted);margin-top:2px}
    </style>
    <script>
      (function(){
        if (window.gxComingSoon) return;
        var host = null;
        function ensureHost(){ if (!host){ host = document.createElement('div'); host.id='gx-toast'; document.body.appendChild(host);} return host; }
        window.gxComingSoon = function(label){
          var h = ensureHost();
          var el = document.createElement('div');
          el.className = 'gx-toast-item';
          el.innerHTML = '<div class="gx-toast-icon">!</div><div class="gx-toast-body"><div class="gx-toast-title">Coming soon</div><div class="gx-toast-sub">'+(label?String(label).replace(/[<>&]/g,function(c){return {'<':'&lt;','>':'&gt;','&':'&amp;'}[c]}):'Tính năng đang phát triển')+'</div></div>';
          h.appendChild(el);
          requestAnimationFrame(function(){ el.classList.add('show'); });
          setTimeout(function(){ el.classList.remove('show'); setTimeout(function(){ el.remove(); }, 220); }, 2400);
        };
      })();
    </script>
  `

  res.send(sellerLayout({
    title: `Order #${orderNumber}`,
    storeName: store.name, storeSlug: store.slug,
    userName: user.name, userEmail: user.email, userRole: user.role, storeRole: user.storeRole,
    activePage: 'orders', content, theme: theme as 'dark' | 'light',
  }))
}

// ─────────────────────────────────────────────────────────────────────────
// Orders JSON proxy — for quick lookup / debug
// GET /admin/store/:slug/api/orders-search?q=&page=&limit=
// ─────────────────────────────────────────────────────────────────────────
export async function searchOrdersApi(req: Request, res: Response): Promise<void> {
  const store = req.store
  if (!store) { res.status(404).json({ error: 'Store context missing' }); return }
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : ''
  const page = Math.max(1, parseInt(String(req.query.page ?? '1')) || 1)
  const limit = Math.min(100, Math.max(5, parseInt(String(req.query.limit ?? '50')) || 50))
  try {
    const ctx = createApiContext(req)
    const r: any = await listOrders(ctx, { page, limit })
    let data: any[] = (r?.data ?? [])
    if (q) {
      data = data.filter((o: any) => {
        const s = (o.shipping_address || {}) as any
        const b = (o.billing_address || {}) as any
        const haystack = [
          o.order_number, o.short_id, o._id, o.id, o.email, o.phone,
          s.full_name, s.first_name, s.last_name, s.phone, s.email,
          b.full_name, b.first_name, b.last_name, b.phone, b.email,
          ...(Array.isArray(o.line_items) ? o.line_items.map((li: any) => li.product_name || li.name) : []),
        ].filter(Boolean).map((x: any) => String(x).toLowerCase()).join(' | ')
        return haystack.includes(q)
      })
    }
    const trimmed = data.map((o: any) => ({
      _id: o._id || o.id,
      order_number: o.order_number || o.short_id,
      status: o.status,
      payment_status: o.payment_status,
      currency: o.currency,
      total_price: o.total_price,
      email: o.email || o.shipping_address?.email || o.billing_address?.email,
      customer: o.shipping_address?.full_name || o.billing_address?.full_name
        || [o.shipping_address?.first_name, o.shipping_address?.last_name].filter(Boolean).join(' ')
        || [o.billing_address?.first_name, o.billing_address?.last_name].filter(Boolean).join(' '),
      create_date: o.create_date || o.created_at,
      tags: o.tags,
      line_items: (o.line_items || []).map((li: any) => ({ name: li.product_name || li.name, qty: li.quantity, price: li.variant?.price ?? li.price })),
    }))
    res.json({ matched: trimmed.length, total_in_page: data.length, data: trimmed })
  } catch (err: any) {
    res.status(502).json({ error: err?.message || 'Order search failed' })
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Update order — apply qty / removed-items / shipping changes from edit page
// POST /admin/store/:slug/api/orders/:orderId/update
// Body: { line_items_qty:{liId:number}, removed_line_ids:string[], shipping:{methodName,price,zoneId,methodIdx}|null, reason?:string }
// Strategy: GET current order from BE → patch line_items + shipping_method →
// recompute totals via Calc semantics → PUT /api/{shop_id}/{order_id}.
// ─────────────────────────────────────────────────────────────────────────
export async function postOrderUpdateApi(req: Request, res: Response): Promise<void> {
  const store = req.store
  if (!store) { res.status(404).json({ error: 'Store context missing' }); return }
  const orderId = req.params.id || req.params.orderId
  if (!orderId) { res.status(400).json({ error: 'orderId required' }); return }
  const body = req.body || {}
  const qtyChanges: Record<string, number> = body.line_items_qty || {}
  const removed: string[] = Array.isArray(body.removed_line_ids) ? body.removed_line_ids : []
  const shipping = body.shipping || null
  const reason = typeof body.reason === 'string' ? body.reason : ''

  try {
    const ctx = createApiContext(req)
    const order = await getOrder(ctx, orderId)
    if (!order) { res.status(404).json({ error: 'Order not found' }); return }

    const lineItems: any[] = Array.isArray(order.line_items) ? order.line_items : []
    // Apply removals + qty changes
    const next = lineItems
      .filter((li: any) => {
        const liId = String(li.id || li.short_id || li._id || '')
        return !removed.includes(liId)
      })
      .map((li: any) => {
        const liId = String(li.id || li.short_id || li._id || '')
        const newQty = qtyChanges[liId]
        if (typeof newQty === 'number' && newQty >= 0) {
          const price = Number(li.variant?.price ?? li.price) || 0
          return { ...li, quantity: newQty, total: price * newQty }
        }
        return li
      })
      .filter((li: any) => Number(li.quantity) > 0) // also drop items set to qty=0

    // Recompute totals (matches BE Order.Calc semantics)
    const totalItems = next.reduce((s, li) => s + (Number(li.quantity) || 0), 0)
    const subtotal = next.reduce((s, li) => s + (Number(li.total) || 0), 0)

    const updated: any = {
      ...order,
      line_items: next,
      total_items: totalItems,
      subtotal_price: Math.round(subtotal * 100) / 100,
      update_date: new Date().toISOString(),
    }

    if (shipping && typeof shipping === 'object') {
      // Explicit override from the "Edit shipping fees" picker — this wins
      // over the country auto-lookup below.
      updated.shipping_method = {
        ...(order.shipping_method || {}),
        name: shipping.methodName || shipping.name || 'Shipping',
        price: Number(shipping.price) || 0,
        description: shipping.description || (order.shipping_method?.description) || '',
      }
    }

    // Tax: compute via /settings/taxes config (FE convention). BE Order.Calc
    // keeps order.tax as-is on PUT, so the value we send persists. order.subfee
    // (separate field) is what BE recomputes via SubFeeService.Calc — leave it.
    const cc = (
      order.shipping_address?.country_code
      || order.billing_address?.country_code
      || codeOfName(order.shipping_address?.country_name)
      || codeOfName(order.billing_address?.country_name)
      || ''
    ).toString().toLowerCase()

    // Shipping auto-pick by country: only fires when caller didn't pass an
    // explicit `shipping` and the order doesn't already have a priced method.
    // Mirrors the render-time lookup in renderOrderDetailApi so saved totals
    // match what the user just saw on screen.
    if (!shipping && cc) {
      const currentShipPrice = Number(updated.shipping_method?.price) || 0
      if (!updated.shipping_method || currentShipPrice === 0) {
        try {
          const auto = await findShippingForCountry(ctx, cc)
          if (auto && auto.price > 0) {
            updated.shipping_method = {
              ...(order.shipping_method || {}),
              name: auto.method_name,
              price: auto.price,
            }
          }
        } catch (e: any) {
          console.warn('[order-update] shipping auto-pick failed:', e?.message)
        }
      }
    }

    const shipPrice = Number(updated.shipping_method?.price) || 0
    let newTax = 0
    if (cc && subtotal > 0) {
      try {
        const { computeOrderTax: ct } = await import('../lib/subfee-api-client.js')
        const r = await ct(ctx, cc, subtotal)
        newTax = r.amount
      } catch (e: any) {
        console.warn('[order-update] tax compute failed', e?.message)
      }
    }
    updated.tax = newTax
    updated.total_price = Math.round((subtotal + newTax + shipPrice) * 100) / 100
    updated.total_transaction = updated.total_price

    if (reason) {
      const tags: string[] = Array.isArray(order.tags) ? order.tags.slice() : []
      // Append reason to a special note (preserve existing note)
      updated.note = (order.note ? order.note + '\n' : '') + '[edit] ' + reason
      updated.tags = tags
    }

    const result = await updateOrder(ctx, orderId, updated)
    res.json({ ok: true, order: result })
  } catch (err: any) {
    res.status(502).json({ error: err?.message || 'Update failed' })
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Shipping zones JSON proxy — for edit-order "Add shipping fee" modal
// GET /admin/store/:slug/api/shipping-zones?q=
// Returns flat list of zones with their methods.
// ─────────────────────────────────────────────────────────────────────────
export async function listShippingZonesApi(req: Request, res: Response): Promise<void> {
  const store = req.store
  if (!store) { res.status(404).json({ error: 'Store context missing' }); return }
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : ''
  try {
    const ctx = createApiContext(req)
    const zones = await listShippings(ctx, q ? { keyword: q } : {})
    const data = (zones || []).map((z: any) => ({
      id: z.id || z._id,
      name: z.name || '(unnamed zone)',
      country_codes: Array.isArray(z.country_codes) ? z.country_codes : [],
      country_excluded: !!z.country_excluded,
      shipping_methods: (Array.isArray(z.shipping_methods) ? z.shipping_methods : []).map((m: any, idx: number) => ({
        idx,
        name: m.name || 'Method',
        description: m.description || '',
        price: m.price ?? m.first_item_price ?? 0,
        type: m.type || '',
      })),
    }))
    res.json({ count: data.length, data })
  } catch (err: any) {
    res.status(502).json({ error: err?.message || 'Shipping zones lookup failed' })
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Product picker JSON proxy — used by edit-order "Add product" modal
// GET /admin/store/:slug/api/products-search?q=&page=&limit=
// ─────────────────────────────────────────────────────────────────────────
export async function searchProductsApi(req: Request, res: Response): Promise<void> {
  const store = req.store
  if (!store) { res.status(404).json({ error: 'Store context missing' }); return }
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
  const page = Math.max(1, parseInt(String(req.query.page ?? '1')) || 1)
  const limit = Math.min(50, Math.max(5, parseInt(String(req.query.limit ?? '20')) || 20))
  try {
    const ctx = createApiContext(req)
    const r: any = await listProducts(ctx, { page, limit, keyword: q || undefined } as any)
    const data = (r?.data ?? []).map((p: any) => {
      const variant = p.variant_default || (Array.isArray(p.variants) ? p.variants[0] : null) || {}
      const img = (Array.isArray(p.images) && p.images[0])
        ? (typeof p.images[0] === 'string' ? p.images[0] : (p.images[0].src || p.images[0].url || ''))
        : ''
      return {
        id: p.id || p._id,
        title: p.name || p.title || '',
        price: variant.price ?? p.price ?? 0,
        currency: variant.currency || p.currency || 'VND',
        image: img,
        available: variant.inventory_quantity ?? variant.stock ?? p.stock ?? 0,
        sku: variant.sku || p.sku || '',
      }
    })
    res.json({ data, pagination: r?.pagination ?? { page, limit, count: data.length } })
  } catch (err: any) {
    res.status(502).json({ error: err?.message || 'Product search failed' })
  }
}
