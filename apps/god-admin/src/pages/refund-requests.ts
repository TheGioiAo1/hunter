/**
 * God Admin — Refund Request Review
 *
 * GET  /god-admin/refund-requests          — List all refund requests
 * GET  /god-admin/refund-requests/:id      — Refund request detail
 * POST /god-admin/refund-requests/:id/approve — Approve refund
 * POST /god-admin/refund-requests/:id/reject  — Reject refund
 */

import type { Request, Response } from 'express'
import { godLayout } from '../layouts/god-layout.js'
// Phase 0 Step 0.4b: CSRF on refund approve/reject — financial actions
// that must not be replayable from a third-party site.
import { createCsrfStore } from '../../../../packages/core/src/modules/auth/csrf-express.js'

// ---------------------------------------------------------------------------
// Module-level CSRF store
// ---------------------------------------------------------------------------

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_god_refund_requests' })

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
    pending: 'badge-yellow',
    approved: 'badge-green',
    rejected: 'badge-red',
  }
  return `<span class="badge ${map[s] || 'badge-gray'}">${esc(s)}</span>`
}

function truncate(s: string | null | undefined, len: number): string {
  if (!s) return '-'
  return s.length > len ? s.slice(0, len) + '...' : s
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
// GET /god-admin/refund-requests
// ---------------------------------------------------------------------------

export async function getRefundRequests(req: Request, res: Response): Promise<void> {
  const user = req.godAdmin!.user
  const statusFilter = (req.query.status as string || '').trim()

  try {
    const queryStr = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : ''
    const data = await apiCall(req, `/api/god/refund-requests${queryStr}`)

    const requests: any[] = data.requests || []
    const stats = data.stats || {}
    const totalCount = stats.total ?? requests.length
    const pendingCount = stats.pending ?? 0
    const approvedCount = stats.approved ?? 0
    const rejectedCount = stats.rejected ?? 0

    // Tab filters
    const tabs = [
      { label: 'All', value: '', count: totalCount },
      { label: 'Pending', value: 'pending', count: pendingCount },
      { label: 'Approved', value: 'approved', count: approvedCount },
      { label: 'Rejected', value: 'rejected', count: rejectedCount },
    ]

    const tabsHtml = tabs.map(t => {
      const active = statusFilter === t.value
      return `<a href="/god-admin/refund-requests${t.value ? '?status=' + t.value : ''}"
        style="padding:8px 16px;border-radius:6px;font-size:13px;text-decoration:none;
        ${active ? 'background:#3b82f6;color:#fff' : 'background:#1e293b;color:#94a3b8'}">${esc(t.label)} (${t.count})</a>`
    }).join('')

    // Table rows
    const tableRows = requests.length > 0
      ? requests.map((r: any) => `
        <tr style="border-bottom:1px solid #1e293b">
          <td style="padding:10px 12px;font-size:13px">${esc(r.shop_name)}</td>
          <td style="padding:10px 12px;font-size:13px"><strong>#${esc(String(r.order_number))}</strong></td>
          <td style="padding:10px 12px;font-size:13px">${fmtMoney(r.amount)}</td>
          <td style="padding:10px 12px;font-size:13px;color:#94a3b8" title="${esc(r.reason)}">${esc(truncate(r.reason, 50))}</td>
          <td style="padding:10px 12px;font-size:13px">${statusBadge(r.status)}</td>
          <td style="padding:10px 12px;font-size:13px">${shortDate(r.created_at)}</td>
          <td style="padding:10px 12px;font-size:13px">
            ${r.status === 'pending'
              ? `<a href="/god-admin/refund-requests/${esc(r.id)}" style="display:inline-block;padding:6px 14px;background:#3b82f6;color:#fff;border-radius:6px;font-size:12px;text-decoration:none">Review</a>`
              : `<a href="/god-admin/refund-requests/${esc(r.id)}" style="display:inline-block;padding:6px 14px;background:#334155;color:#94a3b8;border-radius:6px;font-size:12px;text-decoration:none">View</a>`
            }
          </td>
        </tr>`).join('')
      : '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:24px">No refund requests found</td></tr>'

    const content = `
      <div class="page-header">
        <h1>Refund Requests</h1>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px">
        <div class="card" style="padding:20px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:#60a5fa">${totalCount}</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:4px">Total Requests</div>
        </div>
        <div class="card" style="padding:20px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:#eab308">${pendingCount}</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:4px">Pending Review</div>
        </div>
        <div class="card" style="padding:20px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:#22c55e">${approvedCount}</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:4px">Approved</div>
        </div>
        <div class="card" style="padding:20px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:#ef4444">${rejectedCount}</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:4px">Rejected</div>
        </div>
      </div>

      <div class="card">
        <div style="display:flex;gap:8px;margin-bottom:16px;padding:12px 0">
          ${tabsHtml}
        </div>

        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="border-bottom:1px solid #334155">
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Store</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Order</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Amount</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Reason</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Status</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Date</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Action</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>`

    res.send(godLayout({
      title: 'Refund Requests',
      userEmail: user.email,
      activePath: '/god-admin/refund-requests',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Refund requests error:', err)
    res.status(500).send(godLayout({
      title: 'Refund Requests',
      userEmail: user.email,
      activePath: '/god-admin/refund-requests',
      content: `<div class="card"><p style="color:#ef4444">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/refund-requests/:id
// ---------------------------------------------------------------------------

export async function getRefundRequestDetail(req: Request, res: Response): Promise<void> {
  const user = req.godAdmin!.user
  const id = req.params.id

  // Issue one token per page render; embedded in BOTH approve and
  // reject forms. The user can only submit one at a time — first
  // submit burns it, the redirect re-renders with a fresh token.
  const csrfToken = await csrfStore.issue(res, isProduction())
  const csrfField = csrfStore.hiddenField(csrfToken)

  try {
    const data = await apiCall(req, `/api/god/refund-requests/${encodeURIComponent(id)}`)

    const request = data.request || {}
    const lineItems: any[] = data.line_items || []

    // Line items table (if any)
    const lineItemsHtml = lineItems.length > 0
      ? `
        <h3 style="margin:16px 0 12px;font-size:15px;color:#e2e8f0">Related Line Items</h3>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="border-bottom:1px solid #334155">
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Item</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">SKU</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Qty</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Price</th>
            </tr>
          </thead>
          <tbody>
            ${lineItems.map((item: any) => `
              <tr style="border-bottom:1px solid #1e293b">
                <td style="padding:10px 12px;font-size:13px">${esc(item.title)}</td>
                <td style="padding:10px 12px;font-size:13px">${esc(item.sku || '-')}</td>
                <td style="padding:10px 12px;font-size:13px">${item.quantity}</td>
                <td style="padding:10px 12px;font-size:13px">${fmtMoney(item.price)}</td>
              </tr>`).join('')}
          </tbody>
        </table>`
      : ''

    // Review forms (only if pending)
    const reviewFormsHtml = request.status === 'pending'
      ? `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:24px">
          <div class="card" style="padding:20px;border:1px solid #22c55e33">
            <h3 style="margin:0 0 12px;font-size:15px;color:#22c55e">Approve Refund</h3>
            <form method="post" action="/god-admin/refund-requests/${esc(id)}/approve">
              ${csrfField}
              <div style="margin-bottom:12px">
                <label style="font-size:11px;color:#94a3b8;display:block;margin-bottom:4px">Note (optional)</label>
                <textarea name="note" rows="3" placeholder="Approval note..."
                  style="width:100%;padding:8px 12px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px;resize:vertical"></textarea>
              </div>
              <button type="submit" style="padding:8px 20px;background:#22c55e;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer">
                Approve Refund
              </button>
            </form>
          </div>

          <div class="card" style="padding:20px;border:1px solid #ef444433">
            <h3 style="margin:0 0 12px;font-size:15px;color:#ef4444">Reject Refund</h3>
            <form method="post" action="/god-admin/refund-requests/${esc(id)}/reject">
              ${csrfField}
              <div style="margin-bottom:12px">
                <label style="font-size:11px;color:#94a3b8;display:block;margin-bottom:4px">Reason for rejection (required)</label>
                <textarea name="note" rows="3" placeholder="Reason for rejection..." required
                  style="width:100%;padding:8px 12px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px;resize:vertical"></textarea>
              </div>
              <button type="submit" style="padding:8px 20px;background:#ef4444;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer">
                Reject Refund
              </button>
            </form>
          </div>
        </div>`
      : `
        <div class="card" style="padding:20px;margin-top:24px">
          <h3 style="margin:0 0 12px;font-size:15px;color:#e2e8f0">Review Decision</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px">
            <div><span style="color:#94a3b8">Status:</span> ${statusBadge(request.status)}</div>
            <div><span style="color:#94a3b8">Reviewed by:</span> ${esc(request.reviewer_email || request.reviewed_by || '-')}</div>
            <div><span style="color:#94a3b8">Reviewed at:</span> ${shortDate(request.reviewed_at)}</div>
            <div><span style="color:#94a3b8">Note:</span> ${esc(request.review_note || '-')}</div>
          </div>
        </div>`

    const content = `
      <div class="page-header">
        <h1>
          <a href="/god-admin/refund-requests" style="color:#94a3b8;text-decoration:none;font-size:14px">&larr; Back</a>
          &nbsp; Refund Request
        </h1>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px">
        <div class="card" style="padding:20px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:#60a5fa">${fmtMoney(request.amount)}</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:4px">Refund Amount</div>
        </div>
        <div class="card" style="padding:20px;text-align:center">
          <div style="font-size:28px;font-weight:700">${statusBadge(request.status)}</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:4px">Status</div>
        </div>
      </div>

      <div class="card" style="padding:20px;margin-bottom:24px">
        <h3 style="margin:0 0 12px;font-size:15px;color:#e2e8f0">Request Details</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px;margin-bottom:16px">
          <div><span style="color:#94a3b8">Store:</span> ${esc(request.shop_name)}</div>
          <div><span style="color:#94a3b8">Order:</span> #${esc(String(request.order_number))}</div>
          <div><span style="color:#94a3b8">Customer:</span> ${esc(request.customer_email)}</div>
          <div><span style="color:#94a3b8">Requested:</span> ${shortDate(request.created_at)}</div>
        </div>

        <h3 style="margin:16px 0 8px;font-size:15px;color:#e2e8f0">Reason</h3>
        <div style="padding:12px;background:#1e293b;border-radius:6px;font-size:13px;color:#e2e8f0;line-height:1.5">
          ${esc(request.reason || 'No reason provided')}
        </div>

        ${lineItemsHtml}
      </div>

      ${reviewFormsHtml}`

    res.send(godLayout({
      title: 'Refund Request Detail',
      userEmail: user.email,
      activePath: '/god-admin/refund-requests',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Refund request detail error:', err)
    res.status(500).send(godLayout({
      title: 'Refund Request Detail',
      userEmail: user.email,
      activePath: '/god-admin/refund-requests',
      content: `<div class="card"><p style="color:#ef4444">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/refund-requests/:id/approve
// ---------------------------------------------------------------------------

export async function postApproveRefund(req: Request, res: Response): Promise<void> {
  const user = req.godAdmin!.user
  const id = req.params.id

  // CSRF first: silent redirect to the detail page so the attacker
  // can't distinguish "token missing" from "id not found".
  if (!(await csrfStore.verify(req))) {
    res.redirect(`/god-admin/refund-requests/${encodeURIComponent(id)}`)
    return
  }

  try {
    const body = req.body || {}

    await apiCall(req, `/api/god/refund-requests/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      body: JSON.stringify({
        note: body.note || null,
      }),
    })

    res.redirect('/god-admin/refund-requests?success=approved')
  } catch (err) {
    console.error('[God Admin] Approve refund error:', err)
    res.status(500).send(godLayout({
      title: 'Approve Refund Error',
      userEmail: user.email,
      activePath: '/god-admin/refund-requests',
      content: `
        <div class="page-header"><h1>Approve Refund Error</h1></div>
        <div class="card" style="padding:20px">
          <p style="color:#ef4444;margin-bottom:16px">Error: ${esc(String(err))}</p>
          <a href="/god-admin/refund-requests/${esc(id)}" style="display:inline-block;padding:6px 14px;background:#3b82f6;color:#fff;border-radius:6px;font-size:12px;text-decoration:none">Back to Request</a>
        </div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/refund-requests/:id/reject
// ---------------------------------------------------------------------------

export async function postRejectRefund(req: Request, res: Response): Promise<void> {
  const user = req.godAdmin!.user
  const id = req.params.id

  // CSRF first: silent redirect on fail.
  if (!(await csrfStore.verify(req))) {
    res.redirect(`/god-admin/refund-requests/${encodeURIComponent(id)}`)
    return
  }

  try {
    const body = req.body || {}

    await apiCall(req, `/api/god/refund-requests/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: JSON.stringify({
        note: body.note || null,
      }),
    })

    res.redirect('/god-admin/refund-requests?success=rejected')
  } catch (err) {
    console.error('[God Admin] Reject refund error:', err)
    res.status(500).send(godLayout({
      title: 'Reject Refund Error',
      userEmail: user.email,
      activePath: '/god-admin/refund-requests',
      content: `
        <div class="page-header"><h1>Reject Refund Error</h1></div>
        <div class="card" style="padding:20px">
          <p style="color:#ef4444;margin-bottom:16px">Error: ${esc(String(err))}</p>
          <a href="/god-admin/refund-requests/${esc(id)}" style="display:inline-block;padding:6px 14px;background:#3b82f6;color:#fff;border-radius:6px;font-size:12px;text-decoration:none">Back to Request</a>
        </div>`,
    }))
  }
}
