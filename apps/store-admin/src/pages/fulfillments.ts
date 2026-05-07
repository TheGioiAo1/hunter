/**
 * Store Admin — Fulfillments Page
 *
 * GET  /admin/store/:slug/fulfillments                  — List orders needing fulfillment
 * GET  /admin/store/:slug/fulfillments/:orderId         — Fulfillment detail + POD upload
 * POST /admin/store/:slug/fulfillments/:orderId/pod-upload — POD file upload (multipart)
 *
 * POD (Print on Demand) file management lives here — merchants upload
 * PNG design files per line item, which are then visible in God Admin's
 * fulfillment center for printing/production.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { notify, byActor } from '../lib/notify.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtMoney(val: string | number | null | undefined, currency = 'USD'): string {
  const n = Number(val) || 0
  const sym = currency === 'VND' ? '' : '$'
  const suffix = currency === 'VND' ? ' VND' : ''
  return `${sym}${n.toFixed(2)}${suffix}`
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function statusBadge(status: string | null | undefined): string {
  const s = (status || 'unknown').toLowerCase()
  const map: Record<string, string> = {
    fulfilled: 'badge-success', shipped: 'badge-success', delivered: 'badge-success',
    paid: 'badge-success',
    pending: 'badge-warning', unfulfilled: 'badge-warning', partial: 'badge-warning',
    cancelled: 'badge-danger', returned: 'badge-danger', refunded: 'badge-danger',
  }
  return `<span class="badge ${map[s] || 'badge-muted'}">${esc(s)}</span>`
}

// ---------------------------------------------------------------------------
// GET /admin/store/:slug/fulfillments — List unfulfilled orders
// ---------------------------------------------------------------------------

export async function getFulfillments(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const theme = (req as any).theme || 'dark'

  const statusFilter = (req.query.status as string || 'unfulfilled').trim()
  const search = (req.query.q as string || '').trim()
  const page = Math.max(1, parseInt(req.query.page as string || '1', 10))
  const perPage = 25

  try {
    // Build query
    let query = db.selectFrom('orders')
      .selectAll()
      .where('shop_id', '=', store.id)
      // Exclude drafts
      .$call(q => (q as any).where((eb: any) =>
        eb.not(eb('tags', '@>', eb.val('{draft}')))
      ))

    // Status filter
    if (statusFilter === 'unfulfilled') {
      query = query.where(eb =>
        eb.or([
          eb('fulfillment_status', 'is', null),
          eb('fulfillment_status', '=', 'unfulfilled'),
          eb('fulfillment_status', '=', 'partial'),
        ])
      )
    } else if (statusFilter === 'fulfilled') {
      query = query.where('fulfillment_status', '=', 'fulfilled')
    }
    // 'all' = no fulfillment_status filter

    // Search by order number or email
    if (search) {
      query = query.where(eb =>
        eb.or([
          eb('email', 'ilike', `%${search}%`),
          eb('order_number', '=', parseInt(search, 10) || 0),
        ])
      )
    }

    // Count
    const countResult = await db.selectFrom('orders')
      .select(db.fn.count('id').as('count'))
      .where('shop_id', '=', store.id)
      .$call(q => (q as any).where((eb: any) =>
        eb.not(eb('tags', '@>', eb.val('{draft}')))
      ))
      .$call(q => {
        if (statusFilter === 'unfulfilled') {
          return q.where((eb: any) =>
            eb.or([
              eb('fulfillment_status', 'is', null),
              eb('fulfillment_status', '=', 'unfulfilled'),
              eb('fulfillment_status', '=', 'partial'),
            ])
          )
        }
        if (statusFilter === 'fulfilled') return q.where('fulfillment_status', '=', 'fulfilled')
        return q
      })
      .executeTakeFirst()
    const total = Number((countResult as any)?.count || 0)
    const totalPages = Math.ceil(total / perPage)

    const orders = await query
      .orderBy('created_at', 'desc')
      .offset((page - 1) * perPage)
      .limit(perPage)
      .execute()

    // Get line item counts per order for display
    const orderIds = orders.map(o => o.id)
    let lineItemCounts = new Map<string, number>()
    let podCounts = new Map<string, number>()

    if (orderIds.length > 0) {
      const liCounts = await db.selectFrom('order_line_items')
        .select(['order_id', db.fn.count('id').as('count')])
        .where('order_id', 'in', orderIds)
        .groupBy('order_id')
        .execute()
      for (const r of liCounts) lineItemCounts.set(r.order_id, Number(r.count))

      const podC = await db.selectFrom('pod_files')
        .select(['order_id', db.fn.count('id').as('count')])
        .where('order_id', 'in', orderIds)
        .groupBy('order_id')
        .execute()
      for (const r of podC) podCounts.set(r.order_id, Number(r.count))
    }

    // Build table rows
    const tableRows = orders.length > 0
      ? orders.map((o: any) => {
          const liCount = lineItemCounts.get(o.id) || 0
          const podCount = podCounts.get(o.id) || 0
          const podStatus = liCount > 0 && podCount >= liCount
            ? '<span class="badge badge-success" style="font-size:11px">All PODs</span>'
            : podCount > 0
              ? `<span class="badge badge-warning" style="font-size:11px">${podCount}/${liCount}</span>`
              : `<span class="badge badge-muted" style="font-size:11px">0/${liCount}</span>`
          return `
          <tr>
            <td><a href="${base}/fulfillments/${esc(o.id)}" style="color:var(--s-accent);text-decoration:none;font-weight:600">#${esc(String(o.order_number))}</a></td>
            <td>${shortDate(o.created_at)}</td>
            <td>${esc(o.email || '-')}</td>
            <td style="text-align:right">${fmtMoney(o.total_price, o.currency)}</td>
            <td style="text-align:center">${liCount} items</td>
            <td style="text-align:center">${statusBadge(o.fulfillment_status || 'unfulfilled')}</td>
            <td style="text-align:center">${podStatus}</td>
            <td>
              <a href="${base}/fulfillments/${esc(o.id)}" class="btn btn-primary" style="font-size:12px;padding:4px 12px">
                ${(o.fulfillment_status === 'fulfilled') ? 'View' : 'Fulfill'}
              </a>
            </td>
          </tr>`
        }).join('')
      : '<tr><td colspan="8" style="text-align:center;color:var(--s-text-muted);padding:32px">No orders found</td></tr>'

    // Pagination
    const paginationHtml = totalPages > 1 ? `
      <div style="display:flex;justify-content:center;gap:8px;margin-top:20px">
        ${page > 1 ? `<a href="${base}/fulfillments?status=${esc(statusFilter)}&q=${encodeURIComponent(search)}&page=${page - 1}" class="btn btn-outline" style="font-size:12px">&laquo; Prev</a>` : ''}
        <span style="padding:6px 12px;font-size:13px;color:var(--s-text-muted)">Page ${page} of ${totalPages}</span>
        ${page < totalPages ? `<a href="${base}/fulfillments?status=${esc(statusFilter)}&q=${encodeURIComponent(search)}&page=${page + 1}" class="btn btn-outline" style="font-size:12px">Next &raquo;</a>` : ''}
      </div>
    ` : ''

    const content = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Fulfillments</h1>
          <p class="page-subtitle">Manage order fulfillment and POD design uploads</p>
        </div>
      </div>

      <!-- Stats -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px">
        <div class="card" style="padding:20px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:var(--s-accent)">${total}</div>
          <div style="font-size:12px;color:var(--s-text-muted);margin-top:4px">
            ${statusFilter === 'unfulfilled' ? 'Unfulfilled' : statusFilter === 'fulfilled' ? 'Fulfilled' : 'Total'} Orders
          </div>
        </div>
      </div>

      <!-- Filters -->
      <div class="card" style="margin-bottom:20px">
        <div class="card-body" style="padding:12px 16px">
          <form method="get" action="${base}/fulfillments" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
            <select name="status" class="form-input" style="width:auto;min-width:160px">
              <option value="unfulfilled"${statusFilter === 'unfulfilled' ? ' selected' : ''}>Unfulfilled</option>
              <option value="fulfilled"${statusFilter === 'fulfilled' ? ' selected' : ''}>Fulfilled</option>
              <option value="all"${statusFilter === 'all' ? ' selected' : ''}>All Orders</option>
            </select>
            <input type="text" name="q" value="${esc(search)}" placeholder="Search by email or order #..."
              class="form-input" style="width:auto;min-width:240px" />
            <button type="submit" class="btn btn-primary" style="font-size:13px">Filter</button>
            ${search || statusFilter !== 'unfulfilled' ? `<a href="${base}/fulfillments" class="btn btn-outline" style="font-size:12px">Reset</a>` : ''}
          </form>
        </div>
      </div>

      <!-- Orders Table -->
      <div class="card">
        <div class="card-body" style="padding:0">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Date</th>
                  <th>Customer</th>
                  <th style="text-align:right">Total</th>
                  <th style="text-align:center">Items</th>
                  <th style="text-align:center">Status</th>
                  <th style="text-align:center">POD Files</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>${tableRows}</tbody>
            </table>
          </div>
        </div>
      </div>

      ${paginationHtml}
    `

    res.send(sellerLayout({
      title: 'Fulfillments',
      storeName: store.name, storeSlug: store.slug,
      userName: user.name, userEmail: user.email, userRole: user.role, storeRole: user.storeRole,
      activePage: 'fulfillments', content, theme: theme as 'dark' | 'light',
    }))
  } catch (err: any) {
    console.error('[Store Admin] Fulfillments error:', err)
    res.status(500).send(sellerLayout({
      title: 'Fulfillments',
      storeName: store.name, storeSlug: store.slug,
      userName: user.name, userEmail: user.email, userRole: user.role, storeRole: user.storeRole,
      activePage: 'fulfillments', theme: theme as 'dark' | 'light',
      content: `<div class="card"><div class="card-body"><p style="color:var(--s-danger)">Error loading fulfillments: ${esc(err.message)}</p></div></div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// GET /admin/store/:slug/fulfillments/:orderId — Fulfillment detail + POD
// ---------------------------------------------------------------------------

export async function getFulfillmentDetail(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const orderId = req.params.orderId
  const theme = (req as any).theme || 'dark'
  const csrfToken = (req as any).csrfToken || ''

  try {
    // Parallel fetch: order, line items, fulfillments, POD files
    const [order, lineItems, fulfillments, podFiles] = await Promise.all([
      db.selectFrom('orders')
        .selectAll()
        .where('id', '=', orderId)
        .where('shop_id', '=', store.id)
        .executeTakeFirst(),

      db.selectFrom('order_line_items')
        .selectAll()
        .where('order_id', '=', orderId)
        .orderBy('created_at', 'asc')
        .execute()
        .catch(() => [] as any[]),

      db.selectFrom('fulfillments')
        .selectAll()
        .where('order_id', '=', orderId)
        .orderBy('created_at', 'desc')
        .execute()
        .catch(() => [] as any[]),

      db.selectFrom('pod_files')
        .selectAll()
        .where('order_id', '=', orderId)
        .where('shop_id', '=', store.id)
        .execute()
        .catch(() => [] as any[]),
    ])

    if (!order) {
      res.status(404).send(sellerLayout({
        title: 'Fulfillment — Order not found',
        storeName: store.name, storeSlug: store.slug,
        userName: user.name, userEmail: user.email, userRole: user.role, storeRole: user.storeRole,
        activePage: 'fulfillments', theme: theme as 'dark' | 'light',
        content: `
          <div class="page-header"><div>
            <h1 class="page-title">Order not found</h1>
            <p class="page-subtitle">This order does not exist or belongs to another store.</p>
          </div></div>
          <a href="${base}/fulfillments" class="btn btn-outline">Back to fulfillments</a>
        `,
      }))
      return
    }

    const currency = String(order.currency || 'USD').toUpperCase()
    const fmt = (n: number | string) => fmtMoney(n, currency)
    const payment = order.financial_status || 'pending'
    const fulfillment = order.fulfillment_status || 'unfulfilled'
    const payBadge = payment === 'paid' ? 'badge-success' : payment === 'refunded' ? 'badge-danger' : 'badge-warning'
    const fulBadge = fulfillment === 'fulfilled' ? 'badge-success' : fulfillment === 'closed' ? 'badge-muted' : 'badge-warning'

    // POD file map
    const podMap = new Map<string, any>()
    for (const pf of podFiles) podMap.set(pf.line_item_id, pf)

    // Count stats
    const totalItems = lineItems.length
    const podCount = podFiles.length
    const allPodsDone = totalItems > 0 && podCount >= totalItems

    // Shipping address
    const sa = (order.shipping_address || {}) as any
    const shippingLines = sa.address1 ? [
      [sa.first_name, sa.last_name].filter(Boolean).join(' '),
      sa.company, sa.address1, sa.address2,
      [sa.city, sa.province, sa.zip].filter(Boolean).join(', '),
      sa.country,
    ].filter(Boolean) : []

    // Line items table with POD upload
    const lineItemRows = lineItems.map((li: any) => {
      const title = li.title || li.product_title || 'Unknown product'
      const variant = li.variant_title || li.pv_title || ''
      const sku = li.sku || '-'
      const price = Number(li.price)
      const qty = Number(li.quantity)
      const pod = podMap.get(li.id)
      return `
        <tr>
          <td>
            <div style="font-weight:500;font-size:13px">${esc(title)}</div>
            ${variant ? `<div style="color:var(--s-text-muted);font-size:12px">${esc(variant)}</div>` : ''}
          </td>
          <td style="font-family:monospace;font-size:12px;color:var(--s-text-muted)">${esc(sku)}</td>
          <td style="text-align:center">${qty}</td>
          <td style="text-align:right">${fmt(price)}</td>
          <td style="text-align:right;font-weight:600">${fmt(price * qty)}</td>
          <td style="text-align:center">
            ${pod ? `
              <div style="display:flex;flex-direction:column;align-items:center;gap:6px">
                <a href="${esc(pod.file_url)}" target="_blank" rel="noopener" style="display:block;border:2px solid var(--s-border);border-radius:8px;overflow:hidden;width:64px;height:64px">
                  <img src="${esc(pod.file_url)}" alt="POD" style="width:100%;height:100%;object-fit:cover" />
                </a>
                <div style="display:flex;gap:6px;align-items:center">
                  <a href="${esc(pod.file_url)}" target="_blank" download="${esc(pod.filename)}" style="color:var(--s-accent);text-decoration:none;font-size:11px">
                    Download
                  </a>
                  <span style="color:var(--s-text-dim)">|</span>
                  <label style="cursor:pointer;color:var(--s-warning);font-size:11px">
                    Replace
                    <input type="file" accept="image/png" data-line-item="${esc(li.id)}" style="display:none" onchange="uploadPodFile(this)" />
                  </label>
                </div>
                <div style="font-size:10px;color:var(--s-text-dim)">${esc(pod.filename)}</div>
              </div>
            ` : `
              <label style="cursor:pointer;display:inline-flex;flex-direction:column;align-items:center;gap:6px;border:2px dashed var(--s-border);border-radius:8px;padding:12px 16px;transition:border-color 0.2s" onmouseover="this.style.borderColor='var(--s-accent)'" onmouseout="this.style.borderColor='var(--s-border)'">
                <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="var(--s-accent)" stroke-width="1.5"><path d="M10 4v12M4 10h12"/></svg>
                <span style="color:var(--s-accent);font-size:12px;font-weight:500">Upload PNG</span>
                <span style="color:var(--s-text-dim);font-size:10px">Max 20MB</span>
                <input type="file" accept="image/png" data-line-item="${esc(li.id)}" style="display:none" onchange="uploadPodFile(this)" />
              </label>
            `}
          </td>
        </tr>
      `
    }).join('')

    // Existing fulfillments
    const fulfillmentCards = fulfillments.length > 0
      ? fulfillments.map((f: any, idx: number) => {
          const shippedDate = f.shipped_at ? shortDate(f.shipped_at) : null
          const fStatus = f.status || 'success'
          const fBadge = fStatus === 'success' ? 'badge-success' : fStatus === 'cancelled' || fStatus === 'failure' ? 'badge-danger' : 'badge-warning'
          return `
            <div style="border:1px solid var(--s-border);border-radius:8px;padding:12px 16px;${idx > 0 ? 'margin-top:12px;' : ''}font-size:13px">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <span style="font-weight:600">Fulfillment ${fulfillments.length > 1 ? '#' + (idx + 1) : ''}</span>
                <span class="badge ${fBadge}">${esc(fStatus)}</span>
              </div>
              <div style="display:grid;grid-template-columns:100px 1fr;gap:6px 12px">
                ${f.tracking_company ? `<span style="color:var(--s-text-muted)">Carrier</span><span style="font-weight:500">${esc(String(f.tracking_company))}</span>` : ''}
                ${f.tracking_number ? `
                  <span style="color:var(--s-text-muted)">Tracking</span>
                  <span>
                    <code style="font-size:12px;background:var(--s-bg);padding:2px 6px;border-radius:4px">${esc(String(f.tracking_number))}</code>
                    ${f.tracking_url ? ` <a href="${esc(String(f.tracking_url))}" target="_blank" rel="noopener" style="color:var(--s-accent);text-decoration:none;font-size:12px">Track &rarr;</a>` : ''}
                  </span>
                ` : ''}
                ${shippedDate ? `<span style="color:var(--s-text-muted)">Shipped</span><span>${shippedDate}</span>` : ''}
              </div>
            </div>
          `
        }).join('')
      : ''

    const content = `
      <!-- PAGE HEADER -->
      <div class="page-header">
        <div style="display:flex;align-items:center;gap:12px">
          <a href="${base}/fulfillments" style="color:var(--s-text-muted);text-decoration:none;font-size:20px" title="Back to fulfillments">&larr;</a>
          <div>
            <h1 class="page-title" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              Order #${esc(String(order.order_number))}
              <span class="badge ${payBadge}" style="font-size:12px">${esc(payment)}</span>
              <span class="badge ${fulBadge}" style="font-size:12px">${esc(fulfillment)}</span>
            </h1>
            <p class="page-subtitle">Fulfillment & POD management — ${shortDate(order.created_at as string)}</p>
          </div>
        </div>
        <div style="display:flex;gap:8px">
          <a href="${base}/orders/${orderId}" class="btn btn-outline" style="font-size:13px">View Order</a>
        </div>
      </div>

      <!-- Stats cards -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:24px">
        <div class="card" style="padding:16px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:var(--s-accent)">${fmt(order.total_price)}</div>
          <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Order Total</div>
        </div>
        <div class="card" style="padding:16px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:var(--s-accent)">${totalItems}</div>
          <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Line Items</div>
        </div>
        <div class="card" style="padding:16px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:${allPodsDone ? 'var(--s-success)' : podCount > 0 ? 'var(--s-warning)' : 'var(--s-text-dim)'}">${podCount}/${totalItems}</div>
          <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">POD Files</div>
        </div>
        <div class="card" style="padding:16px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:var(--s-accent)">${fulfillments.length}</div>
          <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Fulfillments</div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 340px;gap:20px">
        <!-- LEFT COLUMN: Line Items + POD Upload -->
        <div>
          <!-- POD DESIGN UPLOADS -->
          <div class="card">
            <div class="card-header">
              <span style="display:flex;align-items:center;gap:8px">
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="14" height="14" rx="2"/><circle cx="8" cy="8" r="2"/><path d="M3 14l4-4 3 3 2-2 5 5"/></svg>
                POD Design Files
              </span>
              <span class="badge ${allPodsDone ? 'badge-success' : 'badge-warning'}">${podCount}/${totalItems} uploaded</span>
            </div>
            <div class="card-body" style="padding:0">
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style="min-width:180px">Product</th>
                      <th>SKU</th>
                      <th style="text-align:center">Qty</th>
                      <th style="text-align:right">Price</th>
                      <th style="text-align:right">Total</th>
                      <th style="text-align:center;min-width:140px">POD Design</th>
                    </tr>
                  </thead>
                  <tbody>${lineItemRows}</tbody>
                </table>
              </div>
            </div>
          </div>

          <!-- FULFILLMENT STATUS -->
          <div class="card" style="margin-top:20px">
            <div class="card-header">
              <span>Fulfillment History</span>
              <span class="badge ${fulBadge}">${esc(fulfillment)}</span>
            </div>
            <div class="card-body">
              ${fulfillmentCards || `
                <div style="display:flex;align-items:center;gap:8px;color:var(--s-warning);font-size:13px">
                  <span style="font-size:16px">&#9203;</span>
                  <span>Awaiting fulfillment</span>
                </div>
                <p style="color:var(--s-text-muted);font-size:12px;margin-top:8px">
                  This order is pending fulfillment by the platform admin. Upload your POD designs above so production can begin.
                </p>
              `}
            </div>
          </div>
        </div>

        <!-- RIGHT COLUMN: Sidebar Info -->
        <div>
          <!-- Customer -->
          <div class="card">
            <div class="card-header"><span>Customer</span></div>
            <div class="card-body" style="font-size:13px">
              <div style="font-weight:600;margin-bottom:4px">${esc(order.email || '-')}</div>
              ${order.phone ? `<div style="color:var(--s-text-muted)">${esc(order.phone as string)}</div>` : ''}
            </div>
          </div>

          <!-- Shipping Address -->
          ${shippingLines.length > 0 ? `
            <div class="card" style="margin-top:16px">
              <div class="card-header"><span>Shipping Address</span></div>
              <div class="card-body" style="font-size:13px">
                ${shippingLines.map(l => `<div>${esc(String(l))}</div>`).join('')}
                ${sa.phone ? `<div style="color:var(--s-text-muted);margin-top:4px">Tel: ${esc(sa.phone)}</div>` : ''}
              </div>
            </div>
          ` : ''}

          <!-- Order Summary -->
          <div class="card" style="margin-top:16px">
            <div class="card-header"><span>Order Summary</span></div>
            <div class="card-body" style="font-size:13px">
              <div style="display:grid;grid-template-columns:1fr auto;gap:6px">
                <span style="color:var(--s-text-muted)">Subtotal</span>
                <span>${fmt(lineItems.reduce((s: number, li: any) => s + Number(li.price) * Number(li.quantity), 0))}</span>
                <span style="color:var(--s-text-muted)">Discount</span>
                <span>${Number(order.total_discounts) > 0 ? '-' + fmt(order.total_discounts) : fmt(0)}</span>
                <span style="color:var(--s-text-muted)">Shipping</span>
                <span>${fmt(order.total_shipping)}</span>
                <span style="color:var(--s-text-muted)">Tax</span>
                <span>${fmt(order.total_tax)}</span>
              </div>
              <div style="border-top:2px solid var(--s-border);padding-top:8px;margin-top:8px;display:flex;justify-content:space-between;font-weight:700;font-size:15px">
                <span>Total</span>
                <span>${fmt(order.total_price)}</span>
              </div>
            </div>
          </div>

          <!-- Notes -->
          ${order.note ? `
            <div class="card" style="margin-top:16px">
              <div class="card-header"><span>Notes</span></div>
              <div class="card-body" style="font-size:13px;color:var(--s-text-muted);white-space:pre-wrap">${esc(order.note as string)}</div>
            </div>
          ` : ''}

          <!-- Tags -->
          ${Array.isArray(order.tags) && order.tags.length > 0 ? `
            <div class="card" style="margin-top:16px">
              <div class="card-header"><span>Tags</span></div>
              <div class="card-body">
                <div style="display:flex;flex-wrap:wrap;gap:6px">
                  ${(order.tags as string[]).map(t => `<span class="badge badge-muted" style="font-size:11px">${esc(t)}</span>`).join('')}
                </div>
              </div>
            </div>
          ` : ''}
        </div>
      </div>

      <!-- POD Upload Script -->
      <script>
      function uploadPodFile(input) {
        if (!input.files || !input.files[0]) return;
        var file = input.files[0];
        if (file.type !== 'image/png') { alert('Only PNG files are allowed for POD designs.'); return; }
        if (file.size > 20 * 1024 * 1024) { alert('File too large. Max 20MB.'); return; }

        var lineItemId = input.dataset.lineItem;
        var formData = new FormData();
        formData.append('file', file);
        formData.append('line_item_id', lineItemId);

        // Show uploading state
        var container = input.closest('td') || input.parentElement;
        container.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;gap:6px;padding:12px"><div class="spinner" style="width:24px;height:24px;border:2px solid var(--s-border);border-top-color:var(--s-accent);border-radius:50%;animation:spin 0.6s linear infinite"></div><span style="color:var(--s-text-muted);font-size:12px">Uploading...</span></div>';

        fetch('${base}/fulfillments/${orderId}/pod-upload', {
          method: 'POST',
          body: formData,
          headers: { 'X-CSRF-Token': '${esc(csrfToken)}' }
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.ok) {
            location.reload();
          } else {
            alert(data.error || 'Upload failed');
            location.reload();
          }
        })
        .catch(function(err) {
          alert('Upload error: ' + err.message);
          location.reload();
        });
      }
      </script>
      <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
    `

    res.send(sellerLayout({
      title: `Fulfillment — Order #${order.order_number}`,
      storeName: store.name, storeSlug: store.slug,
      userName: user.name, userEmail: user.email, userRole: user.role, storeRole: user.storeRole,
      activePage: 'fulfillments', content, theme: theme as 'dark' | 'light',
    }))
  } catch (err: any) {
    console.error('[Store Admin] Fulfillment detail error:', err)
    res.status(500).send(sellerLayout({
      title: 'Fulfillment Detail',
      storeName: store.name, storeSlug: store.slug,
      userName: user.name, userEmail: user.email, userRole: user.role, storeRole: user.storeRole,
      activePage: 'fulfillments', theme: theme as 'dark' | 'light',
      content: `<div class="card"><div class="card-body"><p style="color:var(--s-danger)">Error: ${esc(err.message)}</p></div></div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/fulfillments/:orderId/pod-upload — POD file upload
// ---------------------------------------------------------------------------

export async function postPodUploadFulfillment(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const orderId = req.params.orderId

  try {
    const file = (req as any).file
    if (!file) {
      res.json({ ok: false, error: 'No file uploaded' })
      return
    }

    const lineItemId = req.body.line_item_id
    if (!lineItemId) {
      res.json({ ok: false, error: 'Missing line_item_id' })
      return
    }

    // Verify order + line item belong to this store
    const order = await db.selectFrom('orders').select(['id']).where('id', '=', orderId).where('shop_id', '=', store.id).executeTakeFirst()
    if (!order) {
      res.json({ ok: false, error: 'Order not found' })
      return
    }
    const lineItem = await db.selectFrom('order_line_items').select(['id']).where('id', '=', lineItemId).where('order_id', '=', orderId).executeTakeFirst()
    if (!lineItem) {
      res.json({ ok: false, error: 'Line item not found' })
      return
    }

    // Store file to R2
    const { getObjectStore } = await import('@gbox/core/modules/storage/index.js')
    const objectStore = getObjectStore()
    const fileKey = `shops/${store.id}/pod/${orderId}/${lineItemId}.png`
    const fileUrl = await objectStore.put(fileKey, file.buffer, {
      contentType: 'image/png',
      cacheControl: 'public, max-age=31536000, immutable',
    })

    // Upsert into pod_files
    const existing = await db.selectFrom('pod_files').select(['id']).where('order_id', '=', orderId).where('line_item_id', '=', lineItemId).executeTakeFirst()
    if (existing) {
      await db.updateTable('pod_files')
        .set({ file_key: fileKey, file_url: fileUrl, filename: file.originalname || 'design.png', mime_type: 'image/png', size: file.size, uploaded_by: user.id })
        .where('id', '=', existing.id)
        .execute()
    } else {
      await db.insertInto('pod_files')
        .values({
          shop_id: store.id,
          order_id: orderId,
          line_item_id: lineItemId,
          file_key: fileKey,
          file_url: fileUrl,
          filename: file.originalname || 'design.png',
          mime_type: 'image/png',
          size: file.size,
          uploaded_by: user.id,
        })
        .execute()
    }

    // Timeline event
    await db.insertInto('order_events')
      .values({
        shop_id: store.id,
        order_id: orderId,
        event_type: 'pod_uploaded',
        actor_type: 'user',
        actor_id: user.id,
        message: `POD design uploaded for "${file.originalname || 'design.png'}"`,
        data: JSON.stringify({ line_item_id: lineItemId, file_url: fileUrl }),
      })
      .execute()
      .catch(() => {})

    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'fulfillment_pod_uploaded',
      title: `POD file uploaded for order ${orderId}`,
      message: byActor((req as any).storeUser),
      resourceType: 'order',
      resourceId: orderId,
    })

    res.json({ ok: true, file_url: fileUrl })
  } catch (err: any) {
    console.error('[POD Upload Error]', err.message)
    res.json({ ok: false, error: 'Upload failed: ' + err.message })
  }
}
