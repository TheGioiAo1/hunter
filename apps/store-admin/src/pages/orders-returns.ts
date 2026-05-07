/**
 * Store Admin — Returns & Refunds Management
 *
 * GET  /admin/store/:slug/orders/:orderId/return         — Create return form
 * POST /admin/store/:slug/orders/:orderId/return         — Submit return request
 * GET  /admin/store/:slug/returns                        — List all returns
 * GET  /admin/store/:slug/returns/:returnId              — Return detail
 * POST /admin/store/:slug/returns/:returnId/approve      — Approve return
 * POST /admin/store/:slug/returns/:returnId/receive      — Mark items received
 * POST /admin/store/:slug/returns/:returnId/refund       — Process refund
 * POST /admin/store/:slug/returns/:returnId/cancel       — Cancel return
 *
 * Full return flow: requested → approved → received → refunded → closed
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { notify, byActor } from '../lib/notify.js'
import {
  createReturn as coreCreateReturn,
  transitionReturn as coreTransitionReturn,
  type ReturnStatus,
} from '../../../../packages/core/src/modules/orders/returns.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(val: string | number): string {
  return '$' + Number(val || 0).toFixed(2)
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function returnStatusBadge(status: string): string {
  const map: Record<string, string> = {
    requested: 'badge-warning',
    approved: 'badge-info',
    received: 'badge-info',
    refunded: 'badge-success',
    closed: 'badge-muted',
    cancelled: 'badge-danger',
    declined: 'badge-danger',
  }
  return `<span class="badge ${map[status] || 'badge-muted'}">${esc(status)}</span>`
}

function generateRma(): string {
  const prefix = 'RMA'
  const timestamp = Date.now().toString(36).toUpperCase()
  const random = Math.random().toString(36).substring(2, 6).toUpperCase()
  return `${prefix}-${timestamp}-${random}`
}

const RETURN_REASONS = [
  { value: 'defective', label: 'Defective / Damaged' },
  { value: 'wrong_item', label: 'Wrong item received' },
  { value: 'not_as_described', label: 'Not as described' },
  { value: 'changed_mind', label: 'Changed mind' },
  { value: 'too_late', label: 'Arrived too late' },
  { value: 'better_price', label: 'Found better price' },
  { value: 'other', label: 'Other' },
]

// ---------------------------------------------------------------------------
// GET /admin/store/:slug/orders/:orderId/return — Create return form
// ---------------------------------------------------------------------------

export async function getCreateReturn(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const theme = (req as any).theme || 'dark'
  const csrfToken = (req as any).csrfToken || ''
  const orderId = req.params.orderId

  const [order, lineItems] = await Promise.all([
    db.selectFrom('orders')
      .selectAll()
      .where('id', '=', orderId)
      .where('shop_id', '=', store.id)
      .executeTakeFirst(),
    db.selectFrom('order_line_items')
      .selectAll()
      .where('order_id', '=', orderId)
      .execute(),
  ])

  if (!order) {
    const content = `<div class="page-header"><h1 class="page-title">Order not found</h1></div>`
    res.status(404).send(sellerLayout({ title: 'Return', storeName: store.name, storeSlug: store.slug, userName: user.name, userEmail: user.email, userRole: user.role, storeRole: user.storeRole, activePage: 'orders', content, theme: theme as 'dark' | 'light' }))
    return
  }

  const reasonOptions = RETURN_REASONS.map(r =>
    `<option value="${esc(r.value)}">${esc(r.label)}</option>`
  ).join('')

  const content = `
    <div class="page-header">
      <div style="display:flex;align-items:center;gap:12px">
        <a href="${base}/orders/${orderId}" style="color:var(--s-text-muted);text-decoration:none;font-size:20px">&larr;</a>
        <div>
          <h1 class="page-title">Create Return — Order #${esc(String(order.order_number))}</h1>
          <p class="page-subtitle">Select items to return and process refund</p>
        </div>
      </div>
    </div>

    <form method="post" action="${base}/orders/${orderId}/return">
      <input type="hidden" name="_csrf" value="${esc(csrfToken)}" />

      <div style="display:grid;grid-template-columns:1fr 380px;gap:20px">
        <!-- Left: Items -->
        <div>
          <div class="card">
            <div class="card-header"><span>Select Items to Return</span></div>
            <div class="card-body" style="padding:0">
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style="width:40px">Select</th>
                      <th>Product</th>
                      <th>SKU</th>
                      <th style="text-align:center">Ordered</th>
                      <th style="text-align:center">Return Qty</th>
                      <th style="text-align:right">Price</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${lineItems.map(li => `
                      <tr>
                        <td style="text-align:center">
                          <input type="checkbox" name="items" value="${esc(li.id)}" style="accent-color:var(--s-accent)" onchange="toggleReturnItem(this)" />
                        </td>
                        <td>
                          <div style="font-weight:500;font-size:13px">${esc(li.title)}</div>
                          ${li.variant_title ? `<div style="color:var(--s-text-muted);font-size:12px">${esc(li.variant_title)}</div>` : ''}
                        </td>
                        <td style="font-family:monospace;font-size:12px;color:var(--s-text-muted)">${esc(li.sku || '-')}</td>
                        <td style="text-align:center">${li.quantity}</td>
                        <td style="text-align:center">
                          <input type="number" name="qty_${esc(li.id)}" min="1" max="${li.quantity}" value="${li.quantity}" disabled
                            class="form-input" style="width:60px;text-align:center;font-size:12px;padding:4px" />
                        </td>
                        <td style="text-align:right;font-weight:600">${fmt(li.price)}</td>
                        <td>
                          <select name="reason_${esc(li.id)}" disabled class="form-input" style="font-size:12px;padding:4px 8px;min-width:140px">
                            ${reasonOptions}
                          </select>
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <!-- Refund Options -->
          <div class="card" style="margin-top:20px">
            <div class="card-header"><span>Refund Options</span></div>
            <div class="card-body">
              <div style="display:flex;flex-direction:column;gap:12px">
                <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px">
                  <input type="checkbox" name="refund_shipping" value="1" style="accent-color:var(--s-accent)" />
                  <div>
                    <div style="font-weight:500">Refund shipping cost</div>
                    <div style="font-size:11px;color:var(--s-text-muted)">Return the ${fmt(order.total_shipping)} shipping fee</div>
                  </div>
                </label>
                <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px">
                  <input type="checkbox" name="restock" value="1" checked style="accent-color:var(--s-accent)" />
                  <div>
                    <div style="font-weight:500">Restock returned items</div>
                    <div style="font-size:11px;color:var(--s-text-muted)">Automatically add returned quantities back to inventory</div>
                  </div>
                </label>
              </div>
            </div>
          </div>
        </div>

        <!-- Right: Summary -->
        <div>
          <div class="card">
            <div class="card-header"><span>Return Summary</span></div>
            <div class="card-body">
              <div id="returnSummary" style="font-size:13px;color:var(--s-text-muted)">
                Select items to see return summary
              </div>
            </div>
          </div>

          <div class="card" style="margin-top:16px">
            <div class="card-header"><span>Note</span></div>
            <div class="card-body">
              <textarea name="note" rows="3" class="form-input" style="width:100%;resize:vertical"
                placeholder="Optional note about this return..."></textarea>
            </div>
          </div>

          <div class="card" style="margin-top:16px">
            <div class="card-header"><span>Return Tracking (Optional)</span></div>
            <div class="card-body" style="display:flex;flex-direction:column;gap:10px">
              <input type="text" name="tracking_company" class="form-input" placeholder="Carrier (e.g. USPS, FedEx)" />
              <input type="text" name="tracking_number" class="form-input" placeholder="Tracking number" />
            </div>
          </div>

          <button type="submit" class="btn btn-primary" style="width:100%;margin-top:16px;font-size:14px;padding:12px">
            Create Return Request
          </button>
        </div>
      </div>
    </form>

    <script>
    function toggleReturnItem(checkbox) {
      var row = checkbox.closest('tr');
      var qtyInput = row.querySelector('input[type="number"]');
      var reasonSelect = row.querySelector('select');
      qtyInput.disabled = !checkbox.checked;
      reasonSelect.disabled = !checkbox.checked;
      updateSummary();
    }

    function updateSummary() {
      var checked = document.querySelectorAll('input[name="items"]:checked');
      var summary = document.getElementById('returnSummary');
      if (checked.length === 0) {
        summary.innerHTML = '<span style="color:var(--s-text-muted)">Select items to see return summary</span>';
        return;
      }
      var total = 0;
      var items = [];
      checked.forEach(function(cb) {
        var row = cb.closest('tr');
        var qty = parseInt(row.querySelector('input[type="number"]').value) || 0;
        var priceCell = row.querySelectorAll('td')[5];
        var price = parseFloat(priceCell.textContent.replace('$', '')) || 0;
        total += price * qty;
        items.push(qty + 'x ' + row.querySelectorAll('td')[1].querySelector('div').textContent);
      });
      summary.innerHTML =
        '<div style="display:flex;flex-direction:column;gap:6px">' +
        items.map(function(i) { return '<div>' + i + '</div>'; }).join('') +
        '<div style="border-top:2px solid var(--s-border);padding-top:8px;margin-top:8px;font-weight:700;font-size:15px;display:flex;justify-content:space-between"><span>Refund Total</span><span>$' + total.toFixed(2) + '</span></div>' +
        '</div>';
    }
    </script>
  `

  res.send(sellerLayout({
    title: `Create Return — Order #${order.order_number}`,
    storeName: store.name, storeSlug: store.slug,
    userName: user.name, userEmail: user.email, userRole: user.role, storeRole: user.storeRole,
    activePage: 'orders', content, theme: theme as 'dark' | 'light',
  }))
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/orders/:orderId/return — Submit return
// ---------------------------------------------------------------------------

export async function postCreateReturn(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const orderId = req.params.orderId
  const body = req.body || {}

  try {
    // Normalize selected items
    let selectedItems: string[] = []
    if (Array.isArray(body.items)) selectedItems = body.items
    else if (body.items) selectedItems = [body.items]

    if (selectedItems.length === 0) {
      res.redirect(`${base}/orders/${orderId}/return?error=no_items`)
      return
    }

    const lineItems = selectedItems.map((liId: string) => ({
      lineItemId: liId,
      quantity: parseInt(body[`qty_${liId}`], 10) || 1,
      reason: body[`reason_${liId}`] || 'other',
    }))

    // Delegate to shared core service — DB writes, timeline event,
    // order.return_status sync all happen inside.
    const result = await coreCreateReturn(db, {
      shopId: store.id,
      orderId,
      requestedBy: user.id,
      note: body.note || null,
      trackingNumber: body.tracking_number || null,
      trackingCompany: body.tracking_company || null,
      refundShipping: body.refund_shipping === '1',
      restock: body.restock === '1',
      lineItems,
    })

    notify(db, {
      shopId: store.id,
      userId: user.id,
      type: 'return_created',
      title: `Return requested: ${lineItems.length} item${lineItems.length === 1 ? '' : 's'}`,
      message: byActor(user),
      resourceType: 'return',
      resourceId: result.id,
    })

    res.redirect(`${base}/returns/${result.id}?success=created`)
  } catch (err: any) {
    console.error('[Returns] Create error:', err)
    res.redirect(`${base}/orders/${orderId}/return?error=${encodeURIComponent(err.message)}`)
  }
}

// ---------------------------------------------------------------------------
// GET /admin/store/:slug/returns — List all returns
// ---------------------------------------------------------------------------

export async function getReturns(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const theme = (req as any).theme || 'dark'
  const statusFilter = (req.query.status as string || 'all').trim()

  let query = db.selectFrom('returns' as any)
    .selectAll()
    .where('shop_id', '=', store.id)

  if (statusFilter !== 'all') {
    query = query.where('status', '=', statusFilter)
  }

  const returns = await query.orderBy('created_at', 'desc').limit(100).execute() as any[]

  // Get order numbers for display
  const orderIds = returns.map((r: any) => r.order_id)
  let orderMap = new Map<string, number>()
  if (orderIds.length > 0) {
    const orders = await db.selectFrom('orders')
      .select(['id', 'order_number'])
      .where('id', 'in', orderIds)
      .execute()
    for (const o of orders) orderMap.set(o.id, Number(o.order_number))
  }

  const statusTabs = ['all', 'requested', 'approved', 'received', 'refunded', 'closed', 'cancelled']

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Returns</h1>
        <p class="page-subtitle">Manage return requests and refunds</p>
      </div>
    </div>

    <!-- Status Tabs -->
    <div style="display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap">
      ${statusTabs.map(s => `
        <a href="${base}/returns${s !== 'all' ? '?status=' + s : ''}"
          class="btn ${statusFilter === s ? 'btn-primary' : 'btn-outline'}" style="font-size:12px;padding:6px 14px">
          ${s.charAt(0).toUpperCase() + s.slice(1)}
        </a>
      `).join('')}
    </div>

    <!-- Returns Table -->
    <div class="card">
      <div class="card-body" style="padding:0">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>RMA #</th>
                <th>Order</th>
                <th>Reason</th>
                <th style="text-align:right">Refund Amount</th>
                <th>Status</th>
                <th>Date</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${returns.length > 0 ? returns.map((r: any) => `
                <tr>
                  <td style="font-family:monospace;font-size:12px;font-weight:600">${esc(r.rma_number || '-')}</td>
                  <td><a href="${base}/orders/${esc(r.order_id)}" style="color:var(--s-accent);text-decoration:none">#${orderMap.get(r.order_id) || '-'}</a></td>
                  <td style="font-size:12px">${esc(RETURN_REASONS.find(rr => rr.value === r.reason)?.label || r.reason || '-')}</td>
                  <td style="text-align:right;font-weight:600">${fmt(r.refund_amount)}</td>
                  <td>${returnStatusBadge(r.status)}</td>
                  <td style="font-size:12px">${shortDate(r.created_at)}</td>
                  <td><a href="${base}/returns/${esc(r.id)}" class="btn btn-outline" style="font-size:11px;padding:4px 10px">View</a></td>
                </tr>
              `).join('') : '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--s-text-muted)">No returns found</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `

  res.send(sellerLayout({
    title: 'Returns',
    storeName: store.name, storeSlug: store.slug,
    userName: user.name, userEmail: user.email, userRole: user.role, storeRole: user.storeRole,
    activePage: 'orders', content, theme: theme as 'dark' | 'light',
  }))
}

// ---------------------------------------------------------------------------
// GET /admin/store/:slug/returns/:returnId — Return detail
// ---------------------------------------------------------------------------

export async function getReturnDetail(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const theme = (req as any).theme || 'dark'
  const csrfToken = (req as any).csrfToken || ''
  const returnId = req.params.returnId
  const success = req.query.success as string || ''

  const returnRecord = await db.selectFrom('returns' as any)
    .selectAll()
    .where('id', '=', returnId)
    .where('shop_id', '=', store.id)
    .executeTakeFirst() as any

  if (!returnRecord) {
    res.status(404).send(sellerLayout({
      title: 'Return not found', storeName: store.name, storeSlug: store.slug,
      userName: user.name, userEmail: user.email, userRole: user.role, storeRole: user.storeRole,
      activePage: 'orders', theme: theme as 'dark' | 'light',
      content: `<div class="page-header"><h1 class="page-title">Return not found</h1></div><a href="${base}/returns" class="btn btn-outline">Back to returns</a>`,
    }))
    return
  }

  const [order, returnLineItems] = await Promise.all([
    db.selectFrom('orders').selectAll().where('id', '=', returnRecord.order_id).executeTakeFirst(),
    db.selectFrom('return_line_items' as any).selectAll().where('return_id', '=', returnId).execute() as Promise<any[]>,
  ])

  // Get line item details
  const lineItemIds = returnLineItems.map((rli: any) => rli.line_item_id)
  let lineItems: any[] = []
  if (lineItemIds.length > 0) {
    lineItems = await db.selectFrom('order_line_items').selectAll().where('id', 'in', lineItemIds).execute()
  }
  const liMap = new Map<string, any>()
  for (const li of lineItems) liMap.set(li.id, li)

  // Status flow buttons
  const status = returnRecord.status
  const canApprove = status === 'requested'
  const canReceive = status === 'approved'
  const canRefund = status === 'received'
  const canCancel = status === 'requested' || status === 'approved'

  const content = `
    <div class="page-header">
      <div style="display:flex;align-items:center;gap:12px">
        <a href="${base}/returns" style="color:var(--s-text-muted);text-decoration:none;font-size:20px">&larr;</a>
        <div>
          <h1 class="page-title" style="display:flex;align-items:center;gap:10px">
            Return ${esc(returnRecord.rma_number || '')}
            ${returnStatusBadge(status)}
          </h1>
          <p class="page-subtitle">Order #${esc(String(order?.order_number || '-'))} — ${shortDate(returnRecord.created_at)}</p>
        </div>
      </div>
    </div>

    ${success ? `<div style="background:var(--s-success-bg,#065f46);color:#fff;padding:10px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">${esc(success === 'created' ? 'Return request created successfully.' : success)}</div>` : ''}

    <div style="display:grid;grid-template-columns:1fr 340px;gap:20px">
      <!-- Left -->
      <div>
        <!-- Return Items -->
        <div class="card">
          <div class="card-header"><span>Return Items</span></div>
          <div class="card-body" style="padding:0">
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>SKU</th>
                    <th style="text-align:center">Return Qty</th>
                    <th style="text-align:right">Price</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  ${returnLineItems.map((rli: any) => {
                    const li = liMap.get(rli.line_item_id)
                    return `
                      <tr>
                        <td style="font-weight:500;font-size:13px">${esc(li?.title || 'Unknown')}</td>
                        <td style="font-family:monospace;font-size:12px;color:var(--s-text-muted)">${esc(li?.sku || '-')}</td>
                        <td style="text-align:center">${rli.quantity}</td>
                        <td style="text-align:right;font-weight:600">${fmt(Number(li?.price || 0) * rli.quantity)}</td>
                        <td style="font-size:12px">${esc(RETURN_REASONS.find(r => r.value === rli.reason)?.label || rli.reason || '-')}</td>
                      </tr>
                    `
                  }).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- Status Flow -->
        <div class="card" style="margin-top:20px">
          <div class="card-header"><span>Return Status Flow</span></div>
          <div class="card-body">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px">
              ${['requested', 'approved', 'received', 'refunded', 'closed'].map((s, idx) => {
                const isActive = s === status
                const isPast = ['requested', 'approved', 'received', 'refunded', 'closed'].indexOf(status) >= idx
                return `
                  ${idx > 0 ? '<span style="color:var(--s-text-dim)">→</span>' : ''}
                  <span style="padding:4px 10px;border-radius:12px;font-weight:${isActive ? '700' : '400'};${isPast ? 'background:var(--s-accent);color:#fff' : 'background:var(--s-bg);color:var(--s-text-muted)'}">${s}</span>
                `
              }).join('')}
            </div>

            <!-- Action buttons -->
            <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
              ${canApprove ? `
                <form method="post" action="${base}/returns/${returnId}/approve" style="display:inline">
                  <input type="hidden" name="_csrf" value="${esc(csrfToken)}" />
                  <button type="submit" class="btn btn-primary" style="font-size:13px">Approve Return</button>
                </form>
              ` : ''}
              ${canReceive ? `
                <form method="post" action="${base}/returns/${returnId}/receive" style="display:inline">
                  <input type="hidden" name="_csrf" value="${esc(csrfToken)}" />
                  <button type="submit" class="btn btn-primary" style="font-size:13px">Mark Items Received</button>
                </form>
              ` : ''}
              ${canRefund ? `
                <form method="post" action="${base}/returns/${returnId}/refund" style="display:inline">
                  <input type="hidden" name="_csrf" value="${esc(csrfToken)}" />
                  <button type="submit" class="btn btn-primary" style="font-size:13px;background:var(--s-success)">Process Refund (${fmt(returnRecord.refund_amount)})</button>
                </form>
              ` : ''}
              ${canCancel ? `
                <form method="post" action="${base}/returns/${returnId}/cancel" style="display:inline">
                  <input type="hidden" name="_csrf" value="${esc(csrfToken)}" />
                  <button type="submit" class="btn btn-outline" style="font-size:13px;color:var(--s-danger);border-color:var(--s-danger)">Cancel Return</button>
                </form>
              ` : ''}
            </div>
          </div>
        </div>
      </div>

      <!-- Right: Summary -->
      <div>
        <div class="card">
          <div class="card-header"><span>Return Summary</span></div>
          <div class="card-body" style="font-size:13px">
            <div style="display:grid;grid-template-columns:1fr auto;gap:6px">
              <span style="color:var(--s-text-muted)">RMA Number</span>
              <span style="font-family:monospace;font-weight:600">${esc(returnRecord.rma_number)}</span>
              <span style="color:var(--s-text-muted)">Status</span>
              <span>${returnStatusBadge(status)}</span>
              <span style="color:var(--s-text-muted)">Reason</span>
              <span>${esc(RETURN_REASONS.find(r => r.value === returnRecord.reason)?.label || returnRecord.reason || '-')}</span>
              <span style="color:var(--s-text-muted)">Refund Shipping</span>
              <span>${returnRecord.refund_shipping ? 'Yes' : 'No'}</span>
              <span style="color:var(--s-text-muted)">Restock Items</span>
              <span>${returnRecord.restock ? 'Yes' : 'No'}</span>
            </div>
            <div style="border-top:2px solid var(--s-border);padding-top:8px;margin-top:8px;display:flex;justify-content:space-between;font-weight:700;font-size:15px">
              <span>Refund Amount</span>
              <span>${fmt(returnRecord.refund_amount)}</span>
            </div>
          </div>
        </div>

        ${returnRecord.tracking_number ? `
          <div class="card" style="margin-top:16px">
            <div class="card-header"><span>Return Tracking</span></div>
            <div class="card-body" style="font-size:13px">
              ${returnRecord.tracking_company ? `<div style="color:var(--s-text-muted)">Carrier: ${esc(returnRecord.tracking_company)}</div>` : ''}
              <div style="font-family:monospace;font-weight:600;margin-top:4px">${esc(returnRecord.tracking_number)}</div>
            </div>
          </div>
        ` : ''}

        ${returnRecord.note ? `
          <div class="card" style="margin-top:16px">
            <div class="card-header"><span>Note</span></div>
            <div class="card-body" style="font-size:13px;color:var(--s-text-muted);white-space:pre-wrap">${esc(returnRecord.note)}</div>
          </div>
        ` : ''}

        <a href="${base}/orders/${esc(returnRecord.order_id)}" class="btn btn-outline" style="width:100%;margin-top:16px;font-size:13px">View Order</a>
      </div>
    </div>
  `

  res.send(sellerLayout({
    title: `Return ${returnRecord.rma_number}`,
    storeName: store.name, storeSlug: store.slug,
    userName: user.name, userEmail: user.email, userRole: user.role, storeRole: user.storeRole,
    activePage: 'orders', content, theme: theme as 'dark' | 'light',
  }))
}

// ---------------------------------------------------------------------------
// POST Actions: approve, receive, refund, cancel
//
// All four handlers delegate to `coreTransitionReturn`, which enforces the
// state machine (requested → approved → received → refunded → closed,
// plus rejected/cancelled terminal states), creates the refund row and
// restocks inventory on `refunded`, clears order.return_status on
// `cancelled`/`rejected`, and writes the timeline event. Keeping this
// logic in one place means the REST API and store-admin UI agree on
// behavior.
// ---------------------------------------------------------------------------

async function transitionReturnHandler(
  req: Request,
  res: Response,
  db: Kysely<Database>,
  newStatus: ReturnStatus,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const returnId = req.params.returnId

  try {
    await coreTransitionReturn(db, {
      shopId: store.id,
      returnId,
      newStatus,
      actorId: user.id,
    })
    notify(db, {
      shopId: store.id,
      userId: user.id,
      type: `return_${newStatus}`,
      title: `Return ${newStatus}`,
      message: byActor(user),
      resourceType: 'return',
      resourceId: returnId,
    })
    res.redirect(`${base}/returns/${returnId}?success=${newStatus}`)
  } catch (err: any) {
    console.error(`[Returns] ${newStatus} error:`, err)
    res.redirect(`${base}/returns/${returnId}?error=${encodeURIComponent(err.message)}`)
  }
}

export async function postApproveReturn(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  await transitionReturnHandler(req, res, db, 'approved')
}

export async function postReceiveReturn(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  await transitionReturnHandler(req, res, db, 'received')
}

export async function postRefundReturn(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  await transitionReturnHandler(req, res, db, 'refunded')
}

export async function postCancelReturn(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  await transitionReturnHandler(req, res, db, 'cancelled')
}
