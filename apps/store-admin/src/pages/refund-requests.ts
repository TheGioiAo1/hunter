/**
 * Store Admin — Refund Requests
 *
 * Listing: table of refund requests with status badges
 * Create: form to submit a new refund request for an order
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc as escLayout } from '../layouts/seller-layout.js'
// CSRF: centralized in server.ts; pages use req.csrfToken + csrfHiddenField.
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { notify, byActor } from '../lib/notify.js'

/* ------------------------------------------------------------------ */
/*  API helper                                                         */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  GET /refund-requests — List all refund requests                    */
/* ------------------------------------------------------------------ */

export async function getRefundRequests(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  let refundRequests: any[] = []
  let errorMsg = ''

  try {
    const data = await apiCall(req, `/api/store/${store.slug}/refund-requests`)
    refundRequests = data.refundRequests || data.refund_requests || data.data || data || []
    if (!Array.isArray(refundRequests)) refundRequests = []
  } catch (err: any) {
    // Fallback: query directly from DB
    try {
      refundRequests = await db.selectFrom('refund_requests as rr')
        .innerJoin('orders as o', 'o.id', 'rr.order_id')
        .select([
          'rr.id',
          'rr.order_id',
          'rr.amount',
          'rr.reason',
          'rr.status',
          'rr.review_note',
          'rr.created_at',
          'o.order_number',
        ])
        .where('o.shop_id', '=', store.id)
        .orderBy('rr.created_at', 'desc')
        .execute()
    } catch {
      errorMsg = err.message || 'Failed to load refund requests'
    }
  }

  const statusBadge = (status: string) => {
    if (status === 'approved') return 'badge-success'
    if (status === 'rejected') return 'badge-danger'
    return 'badge-warning'
  }

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Refund Requests</h1>
        <p class="page-subtitle">${refundRequests.length} request${refundRequests.length !== 1 ? 's' : ''}</p>
      </div>
      <div>
        <a href="${base}/orders" class="btn btn-outline">Back to Orders</a>
      </div>
    </div>

    ${errorMsg ? `
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 16px;margin-bottom:16px;color:#991b1b;font-size:13px">
        ${esc(errorMsg)}
      </div>
    ` : ''}

    <div class="card">
      <div class="card-header">
        <span>All Refund Requests</span>
      </div>
      <div class="card-body" style="padding:0">
        ${refundRequests.length > 0 ? `
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th style="text-align:right">Amount</th>
                  <th>Reason</th>
                  <th>Status</th>
                  <th>Date</th>
                  <th>Review Note</th>
                </tr>
              </thead>
              <tbody>
                ${refundRequests.map((rr: any) => {
                  const date = new Date(rr.created_at as string)
                  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                  const status = rr.status || 'pending'
                  const reason = String(rr.reason || '')
                  const truncatedReason = reason.length > 60 ? reason.substring(0, 60) + '...' : reason
                  const orderNum = rr.order_number ? `#${rr.order_number}` : rr.order_id?.substring(0, 8) || 'N/A'
                  const reviewNote = rr.review_note || '-'

                  return `
                    <tr>
                      <td>
                        <a href="${base}/orders/${esc(String(rr.order_id))}" style="color:#2c6ecb;text-decoration:none;font-weight:600">${esc(orderNum)}</a>
                      </td>
                      <td style="text-align:right;font-weight:600">$${Number(rr.amount).toFixed(2)}</td>
                      <td style="color:#6b7280;font-size:13px" title="${esc(reason)}">${esc(truncatedReason)}</td>
                      <td><span class="badge ${statusBadge(status)}">${esc(status)}</span></td>
                      <td style="color:#6b7280;font-size:13px">${dateStr}</td>
                      <td style="color:#6b7280;font-size:13px">${esc(String(reviewNote).length > 40 ? String(reviewNote).substring(0, 40) + '...' : String(reviewNote))}</td>
                    </tr>
                  `
                }).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <p style="color:#6b7280;font-size:13px;text-align:center;padding:40px">
            No refund requests yet. You can create one from an order's detail page.
          </p>
        `}
      </div>
    </div>
  `

  const theme = (req as any).theme || 'dark'
  res.send(sellerLayout({
    title: 'Refund Requests',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    theme: theme as 'dark' | 'light',
    activePage: 'orders',
    content,
  }))
}

/* ------------------------------------------------------------------ */
/*  GET /refund-requests/new?orderId=xxx — Create refund request form  */
/* ------------------------------------------------------------------ */

export async function getCreateRefundRequest(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const orderId = req.query.orderId as string

  if (!orderId) {
    const theme = (req as any).theme || 'dark'
    res.status(400).send(sellerLayout({
      title: 'Create Refund Request',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      theme: theme as 'dark' | 'light',
      activePage: 'orders',
      content: `
        <div class="page-header">
          <div>
            <h1 class="page-title">Create Refund Request</h1>
            <p class="page-subtitle">Missing order ID.</p>
          </div>
        </div>
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 16px;margin-bottom:16px;color:#991b1b;font-size:13px">
          No order ID was provided. Please go back to the order and click "Request Refund".
        </div>
        <a href="${base}/orders" class="btn btn-outline">Back to Orders</a>
      `,
    }))
    return
  }

  // Load order from DB
  const order = await db.selectFrom('orders')
    .selectAll()
    .where('id', '=', orderId)
    .where('shop_id', '=', store.id)
    .executeTakeFirst()

  if (!order) {
    const theme = (req as any).theme || 'dark'
    res.status(404).send(sellerLayout({
      title: 'Order not found',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      theme: theme as 'dark' | 'light',
      activePage: 'orders',
      content: `
        <div class="page-header">
          <div>
            <h1 class="page-title">Order not found</h1>
            <p class="page-subtitle">This order does not exist or belongs to another store.</p>
          </div>
        </div>
        <a href="${base}/orders" class="btn btn-outline">Back to Orders</a>
      `,
    }))
    return
  }

  // Check existing refund requests to calculate remaining refundable amount
  const existingRefunds = await db.selectFrom('refund_requests')
    .select(db.fn.sum('amount').as('total_requested'))
    .where('order_id', '=', orderId)
    .where('status', '!=', 'rejected')
    .executeTakeFirst()

  const totalRequested = Number(existingRefunds?.total_requested ?? 0)
  const maxRefund = Math.max(0, Number(order.total_price) - totalRequested)

  const orderDate = new Date(order.created_at as string)
  const dateStr = orderDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  const errorParam = req.query.error as string || ''

  const csrfToken = req.csrfToken!
  const csrfField = csrfHiddenField(csrfToken)

  const content = `
    <div class="page-header">
      <div style="display:flex;align-items:center;gap:12px">
        <a href="${base}/orders/${orderId}" style="color:#6b7280;text-decoration:none;font-size:20px" title="Back to order">&larr;</a>
        <div>
          <h1 class="page-title">Request Refund</h1>
          <p class="page-subtitle">Order #${esc(String(order.order_number))} &mdash; ${dateStr}</p>
        </div>
      </div>
    </div>

    ${errorParam ? `
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 16px;margin-bottom:16px;color:#991b1b;font-size:13px">
        ${esc(errorParam)}
      </div>
    ` : ''}

    <!-- ORDER SUMMARY -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-header">
        <span>Order Summary</span>
      </div>
      <div class="card-body">
        <div style="display:flex;flex-direction:column;gap:8px;font-size:13px">
          <div style="display:flex;justify-content:space-between">
            <span style="color:#6b7280">Order</span>
            <span style="font-weight:600">#${esc(String(order.order_number))}</span>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="color:#6b7280">Customer</span>
            <span>${esc(order.email || 'Guest')}</span>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="color:#6b7280">Order Total</span>
            <span style="font-weight:700">$${Number(order.total_price).toFixed(2)}</span>
          </div>
          ${totalRequested > 0 ? `
            <div style="display:flex;justify-content:space-between">
              <span style="color:#6b7280">Already Requested (pending/approved)</span>
              <span style="color:#b91c1c;font-weight:500">$${totalRequested.toFixed(2)}</span>
            </div>
          ` : ''}
          <div style="display:flex;justify-content:space-between;border-top:1px solid #e5e7eb;padding-top:8px;margin-top:4px">
            <span style="color:#6b7280">Max Refundable</span>
            <span style="font-weight:700;color:#059669">$${maxRefund.toFixed(2)}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- REFUND REQUEST FORM -->
    <div class="card">
      <div class="card-header">
        <span>Refund Details</span>
      </div>
      <div class="card-body">
        <form method="post" action="${base}/refund-requests/new?orderId=${esc(orderId)}">
          ${csrfField}
          <div style="display:flex;flex-direction:column;gap:16px">
            <div>
              <label for="amount" style="display:block;font-size:13px;font-weight:500;color:#374151;margin-bottom:4px">
                Refund Amount ($)
              </label>
              <input
                type="number"
                id="amount"
                name="amount"
                step="0.01"
                min="0.01"
                max="${maxRefund.toFixed(2)}"
                value="${maxRefund.toFixed(2)}"
                required
                class="input"
                style="max-width:240px"
              >
              <p style="font-size:12px;color:#6b7280;margin-top:4px">Maximum: $${maxRefund.toFixed(2)}</p>
            </div>

            <div>
              <label for="reason" style="display:block;font-size:13px;font-weight:500;color:#374151;margin-bottom:4px">
                Reason for Refund
              </label>
              <textarea
                id="reason"
                name="reason"
                rows="4"
                required
                class="input"
                style="resize:vertical;min-height:80px"
                placeholder="Explain why this order needs a refund..."
              ></textarea>
            </div>

            <div style="display:flex;gap:8px;padding-top:8px">
              <button type="submit" class="btn btn-primary" ${maxRefund <= 0 ? 'disabled' : ''}>Submit Refund Request</button>
              <a href="${base}/orders/${orderId}" class="btn btn-outline">Cancel</a>
            </div>

            ${maxRefund <= 0 ? `
              <p style="color:#b91c1c;font-size:13px">
                The full order amount has already been requested for refund. No further requests can be made.
              </p>
            ` : ''}
          </div>
        </form>
      </div>
    </div>
  `

  const theme = (req as any).theme || 'dark'
  res.send(sellerLayout({
    title: 'Request Refund',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    theme: theme as 'dark' | 'light',
    activePage: 'orders',
    content,
  }))
}

/* ------------------------------------------------------------------ */
/*  POST /refund-requests/new?orderId=xxx — Handle form submission     */
/* ------------------------------------------------------------------ */

export async function postCreateRefundRequest(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const orderId = req.query.orderId as string || req.body.orderId

  // CSRF validated by centralized middleware in server.ts.

  if (!orderId) {
    res.redirect(`${base}/refund-requests`)
    return
  }

  const amount = req.body.amount
  const reason = req.body.reason

  if (!amount || !reason) {
    res.redirect(`${base}/refund-requests/new?orderId=${orderId}&error=${encodeURIComponent('Amount and reason are required.')}`)
    return
  }

  try {
    await apiCall(req, `/api/store/${store.slug}/orders/${orderId}/refund-request`, {
      method: 'POST',
      body: JSON.stringify({ amount: parseFloat(amount), reason }),
    })
    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'refund_request_created',
      title: `Refund request created for order ${orderId}`,
      message: byActor((req as any).storeUser),
      resourceType: 'order',
      resourceId: orderId,
    })
    res.redirect(`${base}/refund-requests`)
  } catch (err: any) {
    const errorMsg = err.message || 'Failed to create refund request'
    res.redirect(`${base}/refund-requests/new?orderId=${orderId}&error=${encodeURIComponent(errorMsg)}`)
  }
}

/* ------------------------------------------------------------------ */
/*  Utility                                                            */
/* ------------------------------------------------------------------ */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
