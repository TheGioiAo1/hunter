/**
 * God Admin — Fulfillment Center
 *
 * GET  /god-admin/fulfillments                      — List unfulfilled orders
 * GET  /god-admin/fulfillments/:orderId             — Order fulfillment detail
 * POST /god-admin/fulfillments/:orderId/fulfill     — Create fulfillment
 * POST /god-admin/fulfillments/:fulfillmentId/tracking — Update tracking
 */

import type { Request, Response } from 'express'
import { godLayout } from '../layouts/god-layout.js'
// Phase 0 Step 0.4b: CSRF on fulfillment forms. Creating fulfillments
// and updating tracking are both write actions that call the
// platform API, so they get one-time tokens.
import { createCsrfStore } from '../../../../packages/core/src/modules/auth/csrf-express.js'

// ---------------------------------------------------------------------------
// Module-level CSRF store
// ---------------------------------------------------------------------------

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_god_fulfillments' })

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string | null | undefined): string {
  if (!s) return ''
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function fmtMoney(val: string | number | null | undefined): string {
  const n = Number(val) || 0
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function statusBadge(status: string | null | undefined): string {
  const s = status || 'unknown'
  const map: Record<string, string> = {
    fulfilled: 'badge-green', shipped: 'badge-green', delivered: 'badge-green',
    pending: 'badge-yellow', unfulfilled: 'badge-yellow', partial: 'badge-yellow',
    cancelled: 'badge-red', returned: 'badge-red',
  }
  return `<span class="badge ${map[s] || 'badge-gray'}">${esc(s)}</span>`
}

// ---------------------------------------------------------------------------
// API Call Helper
// ---------------------------------------------------------------------------

async function apiCall(req: Request, path: string, options?: any): Promise<any> {
  const base = `http://localhost:${process.env.API_PORT || '4321'}`
  const resp = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Cookie: req.headers.cookie || '', ...(options?.headers || {}) },
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error(data.message || `API error ${resp.status}`)
  return data
}

// ---------------------------------------------------------------------------
// GET /god-admin/fulfillments
// ---------------------------------------------------------------------------

export async function getFulfillments(req: Request, res: Response): Promise<void> {
  const user = req.godAdmin!.user
  const shopId = (req.query.shop_id as string || '').trim()

  try {
    const queryStr = shopId ? `?shop_id=${encodeURIComponent(shopId)}` : ''
    const data = await apiCall(req, `/api/god/fulfillments${queryStr}`)

    const orders: any[] = data.orders || []
    const stores: any[] = data.stores || []
    const unfulfilledCount = data.unfulfilled_count ?? orders.length

    // Store filter dropdown
    const storeOptions = stores.map((s: any) =>
      `<option value="${esc(s.id)}"${shopId === s.id ? ' selected' : ''}>${esc(s.name)}</option>`
    ).join('')

    // Table rows
    const tableRows = orders.length > 0
      ? orders.map((o: any) => `
        <tr style="border-bottom:1px solid #1e293b">
          <td style="padding:10px 12px;font-size:13px"><strong>#${esc(String(o.order_number))}</strong></td>
          <td style="padding:10px 12px;font-size:13px">${esc(o.shop_name)}</td>
          <td style="padding:10px 12px;font-size:13px">${esc(o.email)}</td>
          <td style="padding:10px 12px;font-size:13px">${fmtMoney(o.total_price)}</td>
          <td style="padding:10px 12px;font-size:13px">${statusBadge(o.fulfillment_status)}</td>
          <td style="padding:10px 12px;font-size:13px">${shortDate(o.created_at)}</td>
          <td style="padding:10px 12px;font-size:13px">
            <a href="/god-admin/fulfillments/${esc(o.id)}" style="display:inline-block;padding:6px 14px;background:#3b82f6;color:#fff;border-radius:6px;font-size:12px;text-decoration:none">Fulfill</a>
          </td>
        </tr>`).join('')
      : '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:24px">No unfulfilled orders found</td></tr>'

    const content = `
      <div class="page-header">
        <h1>Fulfillment Center</h1>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px">
        <div class="card" style="padding:20px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:#60a5fa">${unfulfilledCount}</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:4px">Unfulfilled Orders</div>
        </div>
      </div>

      <div class="card">
        <form method="get" action="/god-admin/fulfillments" style="display:flex;gap:12px;align-items:center;margin-bottom:16px;padding:12px 0">
          <select name="shop_id" style="padding:8px 12px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px">
            <option value="">All Stores</option>
            ${storeOptions}
          </select>
          <button type="submit" style="padding:8px 16px;background:#3b82f6;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer">Filter</button>
        </form>

        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="border-bottom:1px solid #334155">
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Order</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Store</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Customer</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Total</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Status</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Date</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Action</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>`

    res.send(godLayout({
      title: 'Fulfillment Center',
      userEmail: user.email,
      activePath: '/god-admin/fulfillments',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Fulfillments error:', err)
    res.status(500).send(godLayout({
      title: 'Fulfillment Center',
      userEmail: user.email,
      activePath: '/god-admin/fulfillments',
      content: `<div class="card"><p style="color:#ef4444">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/fulfillments/:orderId
// ---------------------------------------------------------------------------

export async function getFulfillmentDetail(req: Request, res: Response): Promise<void> {
  const user = req.godAdmin!.user
  const orderId = req.params.orderId

  // Issue one token for this page — the create-fulfillment form and
  // every per-fulfillment tracking-update form embed the same field.
  // First submit burns it, the redirect re-renders with a fresh one.
  const csrfToken = await csrfStore.issue(res, isProduction())
  const csrfField = csrfStore.hiddenField(csrfToken)

  try {
    const data = await apiCall(req, `/api/god/fulfillments/${encodeURIComponent(orderId)}`)

    const order = data.order || {}
    const lineItems: any[] = data.line_items || []
    const fulfillments: any[] = data.fulfillments || []
    const podFiles: any[] = data.pod_files || []

    // Build POD file lookup: line_item_id -> pod file
    const podMap = new Map<string, any>()
    for (const pf of podFiles) podMap.set(pf.line_item_id, pf)

    // Line items table with checkboxes + POD file column
    const lineItemRows = lineItems.map((item: any) => {
      const pod = podMap.get(item.id)
      return `
      <tr style="border-bottom:1px solid #1e293b">
        <td style="padding:10px 12px;font-size:13px">
          <input type="checkbox" name="line_item_ids" value="${esc(item.id)}" ${item.fulfilled ? 'disabled' : 'checked'}
            style="accent-color:#3b82f6" />
        </td>
        <td style="padding:10px 12px;font-size:13px">${esc(item.title)}</td>
        <td style="padding:10px 12px;font-size:13px">${esc(item.sku || '-')}</td>
        <td style="padding:10px 12px;font-size:13px">${item.quantity}</td>
        <td style="padding:10px 12px;font-size:13px">${fmtMoney(item.price)}</td>
        <td style="padding:10px 12px;font-size:13px">${item.fulfilled ? statusBadge('fulfilled') : statusBadge('unfulfilled')}</td>
        <td style="padding:10px 12px;font-size:13px">${pod
          ? `<a href="${esc(pod.file_url)}" target="_blank" download="${esc(pod.filename)}" style="color:#60a5fa;text-decoration:none;display:inline-flex;align-items:center;gap:4px;font-size:12px">
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="14" height="14" rx="2"/><circle cx="8" cy="8" r="2"/><path d="M3 14l4-4 3 3 2-2 5 5"/></svg>
              ${esc(pod.filename)}
            </a>`
          : '<span style="color:#64748b;font-size:12px">No POD file</span>'
        }</td>
      </tr>`
    }).join('')

    // Existing fulfillments
    const fulfillmentCards = fulfillments.length > 0
      ? fulfillments.map((f: any) => `
        <div class="card" style="padding:16px;margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <strong style="font-size:14px">Fulfillment #${esc(f.id?.slice(0, 8) || '-')}</strong>
            ${statusBadge(f.status)}
          </div>
          <div style="font-size:13px;color:#94a3b8;margin-bottom:4px">
            Carrier: ${esc(f.tracking_company || 'N/A')}
          </div>
          <div style="font-size:13px;color:#94a3b8;margin-bottom:4px">
            Tracking: ${f.tracking_url
              ? `<a href="${esc(f.tracking_url)}" target="_blank" style="color:#60a5fa">${esc(f.tracking_number || 'Link')}</a>`
              : esc(f.tracking_number || 'N/A')}
          </div>
          <div style="font-size:12px;color:#64748b">Created: ${shortDate(f.created_at)}</div>
          <form method="post" action="/god-admin/fulfillments/${esc(f.id)}/tracking" style="margin-top:12px;display:flex;gap:8px;align-items:end">
            ${csrfField}
            <div style="flex:1">
              <label style="font-size:11px;color:#94a3b8;display:block;margin-bottom:4px">Update Tracking</label>
              <input type="text" name="tracking_company" placeholder="Carrier" value="${esc(f.tracking_company)}"
                style="width:100%;padding:8px 12px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px" />
            </div>
            <div style="flex:1">
              <input type="text" name="tracking_number" placeholder="Tracking Number" value="${esc(f.tracking_number)}"
                style="width:100%;padding:8px 12px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px" />
            </div>
            <div style="flex:1">
              <input type="text" name="tracking_url" placeholder="Tracking URL" value="${esc(f.tracking_url)}"
                style="width:100%;padding:8px 12px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px" />
            </div>
            <button type="submit" style="padding:8px 16px;background:#3b82f6;color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer;white-space:nowrap">Update</button>
          </form>
        </div>`).join('')
      : '<p style="color:#94a3b8;font-size:13px">No fulfillments created yet.</p>'

    const content = `
      <div class="page-header">
        <h1>
          <a href="/god-admin/fulfillments" style="color:#94a3b8;text-decoration:none;font-size:14px">&larr; Back</a>
          &nbsp; Order #${esc(String(order.order_number))}
        </h1>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px">
        <div class="card" style="padding:20px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:#60a5fa">${fmtMoney(order.total_price)}</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:4px">Order Total</div>
        </div>
        <div class="card" style="padding:20px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:#60a5fa">${lineItems.length}</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:4px">Line Items</div>
        </div>
        <div class="card" style="padding:20px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:#60a5fa">${fulfillments.length}</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:4px">Fulfillments</div>
        </div>
      </div>

      <div class="card" style="padding:20px;margin-bottom:24px">
        <h3 style="margin:0 0 12px;font-size:15px;color:#e2e8f0">Customer Information</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px">
          <div><span style="color:#94a3b8">Email:</span> ${esc(order.email || '-')}</div>
          <div><span style="color:#94a3b8">Store:</span> ${esc(order.shop_name)}</div>
          <div><span style="color:#94a3b8">Phone:</span> ${esc(order.phone || '-')}</div>
          <div><span style="color:#94a3b8">Date:</span> ${shortDate(order.created_at)}</div>
          <div><span style="color:#94a3b8">Payment:</span> ${statusBadge(order.financial_status)}</div>
          <div><span style="color:#94a3b8">Fulfillment:</span> ${statusBadge(order.fulfillment_status)}</div>
        </div>
        ${(() => {
          const sa = order.shipping_address as any
          if (!sa || !sa.address1) return ''
          const lines = [
            [sa.first_name, sa.last_name].filter(Boolean).join(' '),
            sa.address1, sa.address2,
            [sa.city, sa.province, sa.zip].filter(Boolean).join(', '),
            sa.country
          ].filter(Boolean)
          return `
            <div style="margin-top:12px;padding-top:12px;border-top:1px solid #1e293b">
              <h4 style="font-size:12px;text-transform:uppercase;color:#94a3b8;margin:0 0 6px">Shipping Address</h4>
              <div style="font-size:13px;color:#e2e8f0">${lines.map(l => esc(String(l))).join('<br/>')}</div>
              ${sa.phone ? `<div style="font-size:12px;color:#94a3b8;margin-top:4px">Tel: ${esc(sa.phone)}</div>` : ''}
            </div>
          `
        })()}
      </div>

      <div class="card" style="padding:20px;margin-bottom:24px">
        <h3 style="margin:0 0 12px;font-size:15px;color:#e2e8f0">Line Items</h3>
        <form method="post" action="/god-admin/fulfillments/${esc(orderId)}/fulfill">
          ${csrfField}
          <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
            <thead>
              <tr style="border-bottom:1px solid #334155">
                <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Select</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Item</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">SKU</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Qty</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Price</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Status</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">POD Design</th>
              </tr>
            </thead>
            <tbody>${lineItemRows}</tbody>
          </table>

          <h3 style="margin:16px 0 12px;font-size:15px;color:#e2e8f0">Create Fulfillment</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px">
            <div>
              <label style="font-size:11px;color:#94a3b8;display:block;margin-bottom:4px">Shipping Carrier</label>
              <input type="text" name="tracking_company" placeholder="e.g. USPS, FedEx, UPS"
                style="width:100%;padding:8px 12px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px" />
            </div>
            <div>
              <label style="font-size:11px;color:#94a3b8;display:block;margin-bottom:4px">Tracking Number</label>
              <input type="text" name="tracking_number" placeholder="Tracking Number"
                style="width:100%;padding:8px 12px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px" />
            </div>
            <div>
              <label style="font-size:11px;color:#94a3b8;display:block;margin-bottom:4px">Tracking URL</label>
              <input type="text" name="tracking_url" placeholder="https://..."
                style="width:100%;padding:8px 12px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px" />
            </div>
          </div>
          <button type="submit" style="padding:8px 20px;background:#3b82f6;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer">
            Create Fulfillment
          </button>
        </form>
      </div>

      <div class="card" style="padding:20px">
        <h3 style="margin:0 0 12px;font-size:15px;color:#e2e8f0">Existing Fulfillments</h3>
        ${fulfillmentCards}
      </div>`

    res.send(godLayout({
      title: `Order #${order.order_number || orderId} — Fulfillment`,
      userEmail: user.email,
      activePath: '/god-admin/fulfillments',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Fulfillment detail error:', err)
    res.status(500).send(godLayout({
      title: 'Fulfillment Detail',
      userEmail: user.email,
      activePath: '/god-admin/fulfillments',
      content: `<div class="card"><p style="color:#ef4444">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/fulfillments/:orderId/fulfill
// ---------------------------------------------------------------------------

export async function postFulfillOrder(req: Request, res: Response): Promise<void> {
  const user = req.godAdmin!.user
  const orderId = req.params.orderId

  if (!(await csrfStore.verify(req))) {
    res.redirect(`/god-admin/fulfillments/${encodeURIComponent(orderId)}`)
    return
  }

  try {
    const body = req.body || {}

    // Normalize line_item_ids to array
    let lineItemIds: string[] = []
    if (Array.isArray(body.line_item_ids)) {
      lineItemIds = body.line_item_ids
    } else if (body.line_item_ids) {
      lineItemIds = [body.line_item_ids]
    }

    await apiCall(req, `/api/god/fulfillments/${encodeURIComponent(orderId)}/fulfill`, {
      method: 'POST',
      body: JSON.stringify({
        tracking_company: body.tracking_company || null,
        tracking_number: body.tracking_number || null,
        tracking_url: body.tracking_url || null,
        line_item_ids: lineItemIds,
      }),
    })

    res.redirect('/god-admin/fulfillments?success=fulfilled')
  } catch (err) {
    console.error('[God Admin] Fulfill order error:', err)
    res.status(500).send(godLayout({
      title: 'Fulfillment Error',
      userEmail: user.email,
      activePath: '/god-admin/fulfillments',
      content: `
        <div class="page-header"><h1>Fulfillment Error</h1></div>
        <div class="card" style="padding:20px">
          <p style="color:#ef4444;margin-bottom:16px">Error: ${esc(String(err))}</p>
          <a href="/god-admin/fulfillments/${esc(orderId)}" style="display:inline-block;padding:6px 14px;background:#3b82f6;color:#fff;border-radius:6px;font-size:12px;text-decoration:none">Back to Order</a>
        </div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/fulfillments/:fulfillmentId/tracking
// ---------------------------------------------------------------------------

export async function postUpdateTracking(req: Request, res: Response): Promise<void> {
  const user = req.godAdmin!.user
  const fulfillmentId = req.params.fulfillmentId

  if (!(await csrfStore.verify(req))) {
    const referer = req.headers.referer || '/god-admin/fulfillments'
    res.redirect(referer)
    return
  }

  try {
    const body = req.body || {}

    await apiCall(req, `/api/god/fulfillments/${encodeURIComponent(fulfillmentId)}/tracking`, {
      method: 'PUT',
      body: JSON.stringify({
        tracking_company: body.tracking_company || null,
        tracking_number: body.tracking_number || null,
        tracking_url: body.tracking_url || null,
      }),
    })

    // Redirect back — use referer if available, otherwise fulfillments list
    const referer = req.headers.referer || '/god-admin/fulfillments'
    res.redirect(referer)
  } catch (err) {
    console.error('[God Admin] Update tracking error:', err)
    res.status(500).send(godLayout({
      title: 'Tracking Update Error',
      userEmail: user.email,
      activePath: '/god-admin/fulfillments',
      content: `
        <div class="page-header"><h1>Tracking Update Error</h1></div>
        <div class="card" style="padding:20px">
          <p style="color:#ef4444;margin-bottom:16px">Error: ${esc(String(err))}</p>
          <a href="/god-admin/fulfillments" style="display:inline-block;padding:6px 14px;background:#3b82f6;color:#fff;border-radius:6px;font-size:12px;text-decoration:none">Back to Fulfillments</a>
        </div>`,
    }))
  }
}
