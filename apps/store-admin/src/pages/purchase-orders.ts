/**
 * Store Admin — Purchase Orders & Transfers
 *
 * Inventory management: purchase orders from suppliers and
 * stock transfers between locations.
 * Uses inventory_levels + locations tables for data.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { listLocations } from '@gbox/core/modules/locations/service.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { renderPurchaseOrderCreateForm } from './purchase-order-create-render.js'
import { renderTransferCreateForm } from './transfer-create-render.js'
import { listProducts, createApiContext, ProductApiError } from '../lib/product-api-client.js'
import { listOrders } from '../lib/customer-api-client.js'

// ---------------------------------------------------------------------------
// GET /products/purchase-orders
// ---------------------------------------------------------------------------

const PO_PER_PAGE = 25

export async function getPurchaseOrders(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const page = Math.max(1, parseInt(String(req.query.page ?? '1')) || 1)

  let orders: any[] = []
  let total = 0
  let errorMsg: string | null = null

  try {
    const ctx = createApiContext(req)
    const r = await listOrders(ctx, { page, limit: PO_PER_PAGE, paymentStatus: true })
    orders = r.data ?? []
    total = r.pagination?.count ?? orders.length
  } catch (err: any) {
    errorMsg = err?.message || 'Failed to load orders'
    console.error('[purchase-orders] list failed:', errorMsg)
  }

  const content = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
      <div>
        <h1 style="margin:0;font-size:22px;font-weight:700">Purchase Orders</h1>
        <p style="margin:4px 0 0;color:var(--s-text-secondary);font-size:13px">Paid orders for this store</p>
      </div>
    </div>

    ${errorMsg ? `<div style="background:var(--s-danger-bg,#fee);border:1px solid var(--s-danger,#c33);border-radius:8px;padding:12px 16px;margin-bottom:16px;color:var(--s-danger,#c33);font-size:13px">${esc(errorMsg)}</div>` : ''}

    ${orders.length === 0 && !errorMsg ? renderPOEmpty() : renderPOTable(base, orders, total, page)}
  `

  res.send(
    sellerLayout({
      title: 'Purchase Orders',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'products',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

function renderPOEmpty(): string {
  return `
    <div style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:48px 24px;text-align:center">
      <div style="font-weight:600;font-size:16px;color:var(--s-text-primary);margin-bottom:6px">No paid orders found</div>
      <div style="font-size:13px;color:var(--s-text-secondary)">Orders with payment_status = true will appear here.</div>
    </div>`
}

function renderPOTable(base: string, orders: any[], total: number, page: number): string {
  const totalPages = Math.max(1, Math.ceil(total / PO_PER_PAGE))
  const rows = orders.map((o: any) => {
    const id = String(o.id || o._id || '')
    const orderName = o.order_number || (o.short_id ? `#${o.short_id}` : `#${id.slice(-4)}`)
    const email = o.billing_address?.email || o.shipping_address?.email || o.customer?.email || '—'
    const lineSum = (Array.isArray(o.line_items) ? o.line_items : [])
      .reduce((s: number, it: any) => s + (Number(it?.total) || 0), 0)
    const totalPrice = Number(o.total_price) > 0 ? Number(o.total_price) : lineSum
    const currency = String(o.currency || 'VND')
    const created = o.create_date ? new Date(o.create_date).toLocaleDateString('en-GB') : '—'
    const itemCount = Array.isArray(o.line_items) ? o.line_items.length : 0
    return `<tr style="border-bottom:1px solid var(--s-border)">
      <td style="padding:10px 12px"><a href="${base}/orders/${esc(id)}" style="color:var(--s-primary);text-decoration:none;font-weight:600">${esc(orderName)}</a></td>
      <td style="padding:10px 12px;color:var(--s-text-secondary);font-size:13px">${esc(created)}</td>
      <td style="padding:10px 12px;font-size:13px">${esc(email)}</td>
      <td style="padding:10px 12px;font-size:13px;text-align:center">${itemCount || '—'}</td>
      <td style="padding:10px 12px;font-size:13px;font-weight:600">${formatPOMoney(totalPrice, currency)}</td>
      <td style="padding:10px 12px"><span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:#d1fae5;color:#065f46">Paid</span></td>
    </tr>`
  }).join('')

  const prevUrl = `${base}/products/purchase-orders?page=${Math.max(1, page - 1)}`
  const nextUrl = `${base}/products/purchase-orders?page=${Math.min(totalPages, page + 1)}`

  return `
    <div style="margin-bottom:12px;font-size:13px;color:var(--s-text-secondary)">${total} order${total === 1 ? '' : 's'}</div>
    <div style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;overflow:hidden">
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="border-bottom:1px solid var(--s-border);background:var(--s-bg)">
              <th style="padding:10px 12px;text-align:left;font-size:12px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.5px">Order</th>
              <th style="padding:10px 12px;text-align:left;font-size:12px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.5px">Date</th>
              <th style="padding:10px 12px;text-align:left;font-size:12px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.5px">Customer</th>
              <th style="padding:10px 12px;text-align:center;font-size:12px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.5px">Items</th>
              <th style="padding:10px 12px;text-align:left;font-size:12px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.5px">Total</th>
              <th style="padding:10px 12px;text-align:left;font-size:12px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.5px">Payment</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${totalPages > 1 ? `<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-top:1px solid var(--s-border)">
        <span style="font-size:13px;color:var(--s-text-secondary)">Page ${page} of ${totalPages}</span>
        <div style="display:flex;gap:8px">
          <a href="${prevUrl}" style="padding:6px 12px;border:1px solid var(--s-border);border-radius:6px;font-size:13px;text-decoration:none;color:var(--s-text-primary);${page === 1 ? 'opacity:.4;pointer-events:none' : ''}">‹ Prev</a>
          <a href="${nextUrl}" style="padding:6px 12px;border:1px solid var(--s-border);border-radius:6px;font-size:13px;text-decoration:none;color:var(--s-text-primary);${page === totalPages ? 'opacity:.4;pointer-events:none' : ''}">Next ›</a>
        </div>
      </div>` : ''}
    </div>`
}

function formatPOMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount)
  } catch {
    return `${currency} ${amount.toLocaleString()}`
  }
}

// ---------------------------------------------------------------------------
// GET /products/transfers
// ---------------------------------------------------------------------------

export async function getTransfers(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'

  let locations: any[] = []
  try {
    const result = await listLocations(db, store.id)
    locations = Array.isArray(result) ? result : (result as any).locations || []
  } catch { /* graceful */ }

  const content = `
    <div class="page-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
      <div>
        <h1 style="margin:0;font-size:22px;font-weight:700">Transfers</h1>
        <p style="margin:4px 0 0;color:var(--s-text-secondary);font-size:13px">Move inventory between locations</p>
      </div>
      <a href="/admin/store/${esc(store.slug)}/products/transfers/new" class="btn btn-primary" style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>
        Create Transfer
      </a>
    </div>

    <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:48px 24px;text-align:center;margin-bottom:24px">
      <div style="margin-bottom:12px">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:.3;color:var(--s-text-secondary)">
          <polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/>
        </svg>
      </div>
      <div style="font-weight:600;font-size:16px;color:var(--s-text-primary);margin-bottom:6px">No transfers</div>
      <div style="font-size:13px;color:var(--s-text-secondary);max-width:400px;margin:0 auto">
        ${locations.length < 2
          ? 'You need at least 2 locations to create inventory transfers. Currently you have ' + locations.length + ' location' + (locations.length !== 1 ? 's' : '') + '.'
          : 'Transfers let you move inventory between your ' + locations.length + ' locations. Create your first transfer to get started.'}
      </div>
    </div>
  `

  res.send(
    sellerLayout({
      title: 'Transfers',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'products',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

// ---------------------------------------------------------------------------
// GET /products/purchase-orders/new — Render create form
// BE state: Order Service (Gbox-Order-Service) chưa expose endpoint
// PurchaseOrder. Khi BE thêm (e.g. POST /api/{shop_id}/purchase-orders),
// chỉ cần wire ở postCreatePurchaseOrder; render giữ nguyên.
// ---------------------------------------------------------------------------

export async function getCreatePurchaseOrder(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const csrfToken = (req as any).csrfToken
  const csrfTokenStr = typeof csrfToken === 'function' ? csrfToken() : (csrfToken ?? '')
  const base = `/admin/store/${store.slug}`
  const self = `${base}/products/purchase-orders`

  let locations: any[] = []
  try {
    const result = await listLocations(db, store.id)
    locations = Array.isArray(result) ? result : (result as any).locations || []
  } catch { /* graceful */ }

  const flashWarning = typeof req.query.warn === 'string' ? req.query.warn : ''
  const flashError = typeof req.query.error === 'string' ? req.query.error : ''

  const content = renderPurchaseOrderCreateForm({
    formAction: self,
    csrfField: csrfHiddenField(csrfTokenStr),
    backHref: self,
    productsSearchUrl: `${self}/products-search`,
    locations,
    flashError: flashError || undefined,
    flashWarning: flashWarning || undefined,
  })

  res.send(
    sellerLayout({
      title: 'Create Purchase Order',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'products',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

// ---------------------------------------------------------------------------
// POST /products/purchase-orders — Create handler (BE pending)
// Hiện BE Order Service không có endpoint Purchase Order. Form submit redirect
// về list với flash warning. Khi BE sẵn sàng, thay block placeholder bằng
// fetch tới `${apiBase}/api/{shop_id}/purchase-orders` và xử lý response.
// ---------------------------------------------------------------------------

export async function postCreatePurchaseOrder(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const self = `${base}/products/purchase-orders`

  // TODO: khi BE Order Service expose POST /api/{shop_id}/purchase-orders,
  // build payload từ req.body (supplier, destination_location_id, payment_terms,
  // currency, estimated_arrival, shipping_carrier, tracking_number,
  // reference_number, note, tags, items[]) rồi gọi api-order.gbox.co.
  const msg = 'Purchase Order API chưa được triển khai trên BE. Form đã sẵn sàng, sẽ kết nối khi BE có endpoint POST /api/{shop_id}/purchase-orders.'
  res.redirect(`${self}/new?warn=${encodeURIComponent(msg)}`)
}

// ---------------------------------------------------------------------------
// GET /products/purchase-orders/products-search?q=&limit=
// JSON endpoint cho autocomplete + modal picker trên form Purchase Order.
// Proxy tới BE Product Service POST /api/{shop_id}/list (đã hỗ trợ keyword).
// ---------------------------------------------------------------------------

function slugifyName(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export async function getPurchaseOrderProductsSearch(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const q = ((req.query.q as string) ?? '').trim()
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200)

  let ctx
  try {
    ctx = createApiContext(req)
  } catch {
    res.status(401).json({ error: 'auth' })
    return
  }

  try {
    const resp = await listProducts(ctx, {
      keyword: q || undefined,
      page: 1,
      limit,
      isCache: true,
      // Truyền fields explicit (BE singleton _FieldsDefault bug — xem
      // product-api-client.ts comment). Subset đủ cho picker.
      fields: 'id,name,slug,images,variant_default,variants,published',
    })
    const raw = (Array.isArray((resp as any)?.data) ? (resp as any).data : []) as any[]
    const products = raw.map((p) => {
      const firstImg = Array.isArray(p.images) && p.images.length > 0
        ? (p.images.find((i: any) => i?.position === 0 || i?.position == null)?.url ?? p.images[0]?.url ?? '')
        : (p.variant_default?.image_url ?? '')
      // BE comment Product.cs:179: variant_default là biến thể fallback khi
      // product không có option. Có thì variants chứa list đầy đủ.
      const rawVariants = Array.isArray(p.variants) && p.variants.length > 0
        ? p.variants
        : (p.variant_default ? [p.variant_default] : [])
      const variants = rawVariants.map((v: any) => ({
        // BE comment Product.cs:336: slug auto-gen từ name nếu null.
        id: v.id ?? '',
        slug: v.slug ?? slugifyName(v.name ?? ''),
        name: v.name ?? 'Default',
        sku: v.sku ?? '',
        image_url: v.image_url ?? '',
        price: Number(v.price ?? 0),
        inventory: Number(v.inventory ?? 0),
      }))
      const totalInv = variants.reduce((s: number, v: any) => s + v.inventory, 0)
      return {
        id: p.id || p.slug,
        name: p.name || p.slug || 'Unnamed',
        slug: p.slug || '',
        image_url: firstImg,
        // BE chưa có concept "available at destination" (multi-location).
        // Tạm: cả 2 dùng tổng inventory; khi BE có inventory_levels per location,
        // available_at_destination = sum theo destination_location_id.
        available: totalInv,
        available_at_destination: totalInv,
        variants,
      }
    })
    res.json({ products })
  } catch (err) {
    if (err instanceof ProductApiError && err.kind === 'auth') {
      res.status(401).json({ error: 'auth' })
      return
    }
    res.status(500).json({ error: 'fetch_failed', message: err instanceof Error ? err.message : 'Unknown' })
  }
}

// ---------------------------------------------------------------------------
// GET /products/transfers/new — Render create form
// BE state: chưa có endpoint Transfer. Form submit qua handler stub bên dưới.
// ---------------------------------------------------------------------------

export async function getCreateTransfer(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const csrfToken = (req as any).csrfToken
  const csrfTokenStr = typeof csrfToken === 'function' ? csrfToken() : (csrfToken ?? '')
  const base = `/admin/store/${store.slug}`
  const self = `${base}/products/transfers`

  let locations: any[] = []
  try {
    const result = await listLocations(db, store.id)
    locations = Array.isArray(result) ? result : (result as any).locations || []
  } catch { /* graceful */ }

  const flashWarning = typeof req.query.warn === 'string' ? req.query.warn : ''
  const flashError = typeof req.query.error === 'string' ? req.query.error : ''
  const lowLocationsWarn = locations.length < 2
    ? 'Bạn cần ít nhất 2 locations để tạo transfer. Thêm location thứ 2 trong Settings → Locations.'
    : ''

  const content = renderTransferCreateForm({
    formAction: self,
    csrfField: csrfHiddenField(csrfTokenStr),
    backHref: self,
    productsSearchUrl: `${self}/products-search`,
    locations,
    flashError: flashError || undefined,
    flashWarning: flashWarning || lowLocationsWarn || undefined,
  })

  res.send(
    sellerLayout({
      title: 'Create Transfer',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'products',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

// ---------------------------------------------------------------------------
// POST /products/transfers — Create handler (BE pending)
// BE Order Service chưa có Transfer endpoint. Khi BE thêm
// (e.g. POST /api/{shop_id}/transfers), thay block redirect bằng fetch.
// ---------------------------------------------------------------------------

export async function postCreateTransfer(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const self = `${base}/products/transfers`

  const origin = ((req.body.origin_location_id as string) || '').trim()
  const dest = ((req.body.destination_location_id as string) || '').trim()
  if (!origin || !dest) {
    res.redirect(`${self}/new?error=${encodeURIComponent('Origin và Destination là bắt buộc')}`)
    return
  }
  if (origin === dest) {
    res.redirect(`${self}/new?error=${encodeURIComponent('Origin và Destination không được trùng')}`)
    return
  }

  // TODO: khi BE Order Service expose POST /api/{shop_id}/transfers, build
  // payload từ req.body (origin/destination/items[]/notes/reference_name/tags
  // /date_created) rồi gọi api-order.gbox.co.
  const msg = 'Transfer API chưa được triển khai trên BE. Form đã sẵn sàng, sẽ kết nối khi BE có endpoint POST /api/{shop_id}/transfers.'
  res.redirect(`${self}/new?warn=${encodeURIComponent(msg)}`)
}
