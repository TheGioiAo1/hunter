/**
 * God Admin — Plan Change Requests
 *
 * Flow:
 *   1. Merchant clicks "Upgrade" / "Downgrade" on Store Admin > Settings > Plan
 *   2. A plan_change_request is created in shop_settings (status: pending)
 *   3. God Admin sees it here → can Approve or Reject
 *   4. On Approve: shop.plan updated, billing history recorded
 *   5. On Reject: merchant sees rejection reason
 *
 * Future: step 2.5 — integrate payment gateway (Stripe/PayPal) so
 *   merchant pays BEFORE the request reaches God Admin.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { godLayout } from '../layouts/god-layout.js'
import { createCsrfStore } from '@gbox/core/modules/auth/csrf-express.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_god_plan' })

/** Safely parse jsonb value (may already be parsed by pg driver). */
function parseVal<T = any>(val: unknown): T {
  if (val == null) return null as T
  if (typeof val === 'string') {
    try { return JSON.parse(val) as T } catch { return val as T }
  }
  return val as T
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: any): string {
  if (s == null) return ''
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function shortDate(d: any): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatCents(cents: number): string {
  if (cents === 0) return '$0'
  return `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`
}

interface PlanRequest {
  id: string
  shop_id: string
  shop_name?: string
  shop_slug?: string
  shop_email?: string
  current_plan: string
  requested_plan: string
  billing_cycle: 'monthly' | 'annual'
  status: 'pending' | 'approved' | 'rejected'
  requested_at: string
  reviewed_at?: string
  reviewed_by?: string
  rejection_reason?: string
  amount_cents: number
}

// Plan pricing lookup
const PLAN_PRICES: Record<string, { monthly: number; annual: number; name: string }> = {
  free:       { monthly: 0,     annual: 0,     name: 'Starter' },
  basic:      { monthly: 2900,  annual: 2400,  name: 'Basic' },
  pro:        { monthly: 7900,  annual: 6600,  name: 'Professional' },
  advanced:   { monthly: 29900, annual: 24900, name: 'Advanced' },
  enterprise: { monthly: 0,     annual: 0,     name: 'Enterprise' },
}

function planName(id: string): string {
  return PLAN_PRICES[id]?.name || id
}

function planPrice(id: string, cycle: string): number {
  const p = PLAN_PRICES[id]
  if (!p) return 0
  return cycle === 'annual' ? p.annual : p.monthly
}

// ---------------------------------------------------------------------------
// GET /god-admin/plan-requests — List all plan change requests
// ---------------------------------------------------------------------------

export async function getPlanRequests(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const flash = typeof req.query.msg === 'string' ? req.query.msg : ''
  const flashErr = typeof req.query.err === 'string' ? req.query.err : ''
  const filterStatus = typeof req.query.status === 'string' ? req.query.status : 'all'

  // Issue CSRF token
  const csrfToken = await csrfStore.issue(res, process.env.NODE_ENV === 'production')

  // Read all plan_change_requests from shop_settings across all shops
  const allRows = await db.selectFrom('shop_settings')
    .innerJoin('shops', 'shops.id', 'shop_settings.shop_id')
    .select([
      'shop_settings.value',
      'shop_settings.shop_id',
      'shops.name as shop_name',
      'shops.slug as shop_slug',
      'shops.email as shop_email',
      'shops.plan as current_plan',
    ])
    .where('shop_settings.key', '=', 'plan_change_requests')
    .execute()

  // Parse all requests
  let requests: PlanRequest[] = []
  for (const row of allRows) {
    try {
      const reqs: PlanRequest[] = parseVal(row.value)
      for (const r of reqs) {
        r.shop_name = row.shop_name
        r.shop_slug = row.shop_slug
        r.shop_email = row.shop_email
        r.current_plan = row.current_plan || 'free'
      }
      requests.push(...reqs)
    } catch {}
  }

  // Sort: pending first, then by date desc
  requests.sort((a, b) => {
    if (a.status === 'pending' && b.status !== 'pending') return -1
    if (b.status === 'pending' && a.status !== 'pending') return 1
    return new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime()
  })

  // Filter
  if (filterStatus !== 'all') {
    requests = requests.filter(r => r.status === filterStatus)
  }

  const pendingCount = requests.filter(r => r.status === 'pending').length

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Plan Change Requests</h1>
        <p class="page-subtitle">${pendingCount} pending request${pendingCount !== 1 ? 's' : ''}</p>
      </div>
    </div>

    ${flash ? `<div style="margin-bottom:16px;padding:12px 16px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);border-radius:8px;color:#22c55e;font-size:13px">${esc(flash)}</div>` : ''}
    ${flashErr ? `<div style="margin-bottom:16px;padding:12px 16px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:8px;color:#ef4444;font-size:13px">${esc(flashErr)}</div>` : ''}

    <!-- Filter tabs -->
    <div style="display:flex;gap:8px;margin-bottom:20px">
      ${['all', 'pending', 'approved', 'rejected'].map(s => `
        <a href="/god-admin/plan-requests?status=${s}" style="padding:6px 14px;border-radius:6px;font-size:12px;font-weight:600;text-decoration:none;${filterStatus === s ? 'background:var(--g-accent);color:#fff' : 'background:var(--g-surface);color:var(--g-text-dim);border:1px solid var(--g-border)'}">
          ${s.charAt(0).toUpperCase() + s.slice(1)}${s === 'pending' ? ` (${pendingCount})` : ''}
        </a>
      `).join('')}
    </div>

    ${requests.length === 0 ? `
      <div class="card" style="padding:48px;text-align:center">
        <div style="font-size:48px;margin-bottom:12px">&#128203;</div>
        <div style="font-size:16px;font-weight:600;margin-bottom:4px">No plan requests</div>
        <div style="font-size:13px;color:var(--g-text-dim)">When merchants request plan upgrades or downgrades, they'll appear here for your review.</div>
      </div>
    ` : `
      <div class="card" style="padding:0;overflow:hidden">
        <table class="data-table" style="width:100%">
          <thead>
            <tr>
              <th style="width:180px">Store</th>
              <th>Current</th>
              <th>&#8594;</th>
              <th>Requested</th>
              <th>Cycle</th>
              <th>Amount</th>
              <th>Date</th>
              <th>Status</th>
              <th style="width:200px">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${requests.map(r => `
              <tr>
                <td>
                  <a href="/god-admin/stores/${esc(r.shop_id)}" style="color:var(--g-accent);text-decoration:none;font-weight:600">${esc(r.shop_name)}</a>
                  <div style="font-size:11px;color:var(--g-text-dim)">${esc(r.shop_slug)}</div>
                </td>
                <td><span class="badge badge-neutral" style="font-size:11px">${esc(planName(r.current_plan))}</span></td>
                <td style="color:var(--g-text-dim);font-size:16px">&#8594;</td>
                <td><span class="badge ${r.requested_plan === 'free' ? 'badge-warning' : 'badge-info'}" style="font-size:11px">${esc(planName(r.requested_plan))}</span></td>
                <td style="font-size:12px;text-transform:capitalize">${esc(r.billing_cycle)}</td>
                <td style="font-weight:600">${formatCents(r.amount_cents)}${r.amount_cents > 0 ? '/mo' : ''}</td>
                <td style="font-size:12px;color:var(--g-text-dim)">${shortDate(r.requested_at)}</td>
                <td>
                  <span class="badge ${r.status === 'pending' ? 'badge-warning' : r.status === 'approved' ? 'badge-success' : 'badge-error'}" style="font-size:11px">${esc(r.status)}</span>
                </td>
                <td>
                  ${r.status === 'pending' ? `
                    <div style="display:flex;gap:6px">
                      <form method="POST" action="/god-admin/plan-requests/${esc(r.id)}/approve" style="margin:0">
                        ${csrfHiddenField(csrfToken)}
                        <input type="hidden" name="shop_id" value="${esc(r.shop_id)}">
                        <button type="submit" class="btn btn-primary btn-sm" style="font-size:11px;padding:4px 10px" onclick="return confirm('Approve plan change to ${esc(planName(r.requested_plan))} for ${esc(r.shop_name)}?')">Approve</button>
                      </form>
                      <form method="POST" action="/god-admin/plan-requests/${esc(r.id)}/reject" style="margin:0">
                        ${csrfHiddenField(csrfToken)}
                        <input type="hidden" name="shop_id" value="${esc(r.shop_id)}">
                        <button type="submit" class="btn btn-sm" style="font-size:11px;padding:4px 10px;background:rgba(239,68,68,.1);color:#ef4444;border:1px solid rgba(239,68,68,.3)" onclick="return confirm('Reject this plan request?')">Reject</button>
                      </form>
                    </div>
                  ` : `
                    <span style="font-size:11px;color:var(--g-text-dim)">
                      ${r.reviewed_at ? shortDate(r.reviewed_at) : '—'}
                      ${r.rejection_reason ? `<br><em>${esc(r.rejection_reason)}</em>` : ''}
                    </span>
                  `}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `}
  `

  res.send(godLayout({
    title: 'Plan Requests',
    activePage: 'plan-requests',
    content,
  }))
}

// ---------------------------------------------------------------------------
// POST /god-admin/plan-requests/:requestId/approve
// ---------------------------------------------------------------------------

export async function postApprovePlanRequest(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const requestId = req.params.requestId || req.params.id
  const shopId = req.body.shop_id

  // Verify CSRF
  const valid = await csrfStore.verify(req)
  if (!valid) {
    res.redirect('/god-admin/plan-requests?err=Invalid form submission')
    return
  }

  if (!shopId) {
    res.redirect('/god-admin/plan-requests?err=Missing shop ID')
    return
  }

  try {
    // Read the requests
    const row = await db.selectFrom('shop_settings')
      .select('value')
      .where('shop_id', '=', shopId)
      .where('key', '=', 'plan_change_requests')
      .executeTakeFirst()

    if (!row) {
      res.redirect('/god-admin/plan-requests?err=Request not found')
      return
    }

    const requests: PlanRequest[] = parseVal(row.value)
    const request = requests.find(r => r.id === requestId)

    if (!request || request.status !== 'pending') {
      res.redirect('/god-admin/plan-requests?err=Request not found or already processed')
      return
    }

    // Mark as approved
    request.status = 'approved'
    request.reviewed_at = new Date().toISOString()
    request.reviewed_by = 'god-admin'

    // Update the request list
    await db.updateTable('shop_settings')
      .set({ value: JSON.stringify(requests), updated_at: new Date() })
      .where('shop_id', '=', shopId)
      .where('key', '=', 'plan_change_requests')
      .execute()

    // Actually change the shop's plan
    await db.updateTable('shops')
      .set({ plan: request.requested_plan, updated_at: new Date() })
      .where('id', '=', shopId)
      .execute()

    // Update plan_meta
    const metaRow = await db.selectFrom('shop_settings')
      .select('value')
      .where('shop_id', '=', shopId)
      .where('key', '=', 'plan_meta')
      .executeTakeFirst()

    const meta = metaRow ? parseVal(metaRow.value) : {}
    meta.billing_cycle = request.billing_cycle
    meta.plan_started_at = new Date().toISOString()
    meta.cancelled_at = null
    meta.cancel_reason = null

    // Set next billing date
    const nextBilling = new Date()
    nextBilling.setDate(nextBilling.getDate() + (request.billing_cycle === 'annual' ? 365 : 30))
    meta.next_billing_date = nextBilling.toISOString()

    // Set trial for free→paid upgrades
    if (request.current_plan === 'free' && request.requested_plan !== 'free') {
      const trialEnd = new Date()
      trialEnd.setDate(trialEnd.getDate() + 14)
      meta.trial_ends_at = trialEnd.toISOString()
    }

    if (metaRow) {
      await db.updateTable('shop_settings')
        .set({ value: JSON.stringify(meta), updated_at: new Date() })
        .where('shop_id', '=', shopId)
        .where('key', '=', 'plan_meta')
        .execute()
    } else {
      await db.insertInto('shop_settings')
        .values({
          id: crypto.randomUUID(),
          shop_id: shopId,
          key: 'plan_meta',
          value: JSON.stringify(meta),
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute()
    }

    // Append billing history
    const historyRow = await db.selectFrom('shop_settings')
      .select('value')
      .where('shop_id', '=', shopId)
      .where('key', '=', 'billing_history')
      .executeTakeFirst()

    const history = historyRow ? parseVal(historyRow.value) : []
    history.unshift({
      date: new Date().toISOString(),
      description: `Plan upgraded to ${planName(request.requested_plan)} (${request.billing_cycle}) — approved by God Admin`,
      amount: request.amount_cents,
      status: 'paid',
    })
    if (history.length > 100) history.length = 100

    if (historyRow) {
      await db.updateTable('shop_settings')
        .set({ value: JSON.stringify(history), updated_at: new Date() })
        .where('shop_id', '=', shopId)
        .where('key', '=', 'billing_history')
        .execute()
    } else {
      await db.insertInto('shop_settings')
        .values({
          id: crypto.randomUUID(),
          shop_id: shopId,
          key: 'billing_history',
          value: JSON.stringify(history),
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute()
    }

    const shop = await db.selectFrom('shops').select('name').where('id', '=', shopId).executeTakeFirst()
    res.redirect(`/god-admin/plan-requests?msg=${encodeURIComponent(`Approved: ${shop?.name || 'Store'} upgraded to ${planName(request.requested_plan)}`)}`)
  } catch (err: any) {
    console.error('[god-admin] plan approve error:', err)
    res.redirect(`/god-admin/plan-requests?err=${encodeURIComponent('Failed to approve: ' + err.message)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/plan-requests/:requestId/reject
// ---------------------------------------------------------------------------

export async function postRejectPlanRequest(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const requestId = req.params.requestId || req.params.id
  const shopId = req.body.shop_id
  const reason = (req.body.reason || 'Rejected by admin').trim()

  // Verify CSRF
  const valid = await csrfStore.verify(req)
  if (!valid) {
    res.redirect('/god-admin/plan-requests?err=Invalid form submission')
    return
  }

  if (!shopId) {
    res.redirect('/god-admin/plan-requests?err=Missing shop ID')
    return
  }

  try {
    const row = await db.selectFrom('shop_settings')
      .select('value')
      .where('shop_id', '=', shopId)
      .where('key', '=', 'plan_change_requests')
      .executeTakeFirst()

    if (!row) {
      res.redirect('/god-admin/plan-requests?err=Request not found')
      return
    }

    const requests: PlanRequest[] = parseVal(row.value)
    const request = requests.find(r => r.id === requestId)

    if (!request || request.status !== 'pending') {
      res.redirect('/god-admin/plan-requests?err=Request not found or already processed')
      return
    }

    request.status = 'rejected'
    request.reviewed_at = new Date().toISOString()
    request.reviewed_by = 'god-admin'
    request.rejection_reason = reason

    await db.updateTable('shop_settings')
      .set({ value: JSON.stringify(requests), updated_at: new Date() })
      .where('shop_id', '=', shopId)
      .where('key', '=', 'plan_change_requests')
      .execute()

    const shop = await db.selectFrom('shops').select('name').where('id', '=', shopId).executeTakeFirst()
    res.redirect(`/god-admin/plan-requests?msg=${encodeURIComponent(`Rejected plan request from ${shop?.name || 'Store'}`)}`)
  } catch (err: any) {
    console.error('[god-admin] plan reject error:', err)
    res.redirect(`/god-admin/plan-requests?err=${encodeURIComponent('Failed to reject: ' + err.message)}`)
  }
}
