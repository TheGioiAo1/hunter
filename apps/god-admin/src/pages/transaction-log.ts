/**
 * God Admin — Transaction Log
 *
 * GET /god-admin/finance/transactions — Full transaction log with filters & pagination
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string | null | undefined): string {
  if (!s) return ''
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function fmtMoney(val: string | number | null): string {
  const n = Number(val) || 0
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtNum(val: number | string | null): string {
  return Number(val || 0).toLocaleString('en-US')
}

function shortDate(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function statusBadge(status: string | null): string {
  const s = status || 'unknown'
  const map: Record<string, string> = {
    success: 'badge-green', pending: 'badge-yellow', failure: 'badge-red', error: 'badge-red',
    sale: 'badge-green', capture: 'badge-green', refund: 'badge-red', void: 'badge-gray',
  }
  return `<span class="badge ${map[s] || 'badge-gray'}">${esc(s)}</span>`
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PER_PAGE = 50
const VALID_KINDS = ['sale', 'capture', 'refund', 'void']
const VALID_STATUSES = ['success', 'pending', 'failure']

// ---------------------------------------------------------------------------
// GET /god-admin/finance/transactions
// ---------------------------------------------------------------------------

export async function getTransactionLog(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user

  // Parse query params
  const kindFilter = VALID_KINDS.includes(req.query.kind as string) ? (req.query.kind as string) : ''
  const statusFilter = VALID_STATUSES.includes(req.query.status as string) ? (req.query.status as string) : ''
  const gatewayFilter = (req.query.gateway as string || '').trim()
  const shopFilter = (req.query.shop as string || '').trim()
  const orderSearch = (req.query.order as string || '').trim()
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1)
  const offset = (page - 1) * PER_PAGE

  try {
    // Build base where conditions for reuse
    function applyFilters(qb: any): any {
      let q = qb
      if (kindFilter) q = q.where('t.kind', '=', kindFilter)
      if (statusFilter) q = q.where('t.status', '=', statusFilter)
      if (gatewayFilter) q = q.where('t.gateway', '=', gatewayFilter)
      if (shopFilter) q = q.where('o.shop_id', '=', shopFilter)
      if (orderSearch) q = q.where(sql`o.order_number::text`, 'like', `%${orderSearch}%`)
      return q
    }

    // Parallel queries: summary stats + filtered data + gateway list + shop list
    const [
      totalCountResult,
      totalAmountResult,
      successRateResult,
      refundTotalResult,
      transactions,
      gateways,
      shops,
    ] = await Promise.all([
      // Total transactions count (filtered)
      applyFilters(
        db.selectFrom('transactions as t')
          .leftJoin('orders as o', 'o.id', 't.order_id')
      )
        .select(sql<string>`count(t.id)`.as('count'))
        .executeTakeFirst(),

      // Total amount sum (filtered)
      applyFilters(
        db.selectFrom('transactions as t')
          .leftJoin('orders as o', 'o.id', 't.order_id')
      )
        .select(sql<string>`coalesce(sum(t.amount::numeric), 0)`.as('total'))
        .executeTakeFirst(),

      // Success rate (filtered)
      applyFilters(
        db.selectFrom('transactions as t')
          .leftJoin('orders as o', 'o.id', 't.order_id')
      )
        .select([
          sql<string>`count(t.id)`.as('total'),
          sql<string>`count(case when t.status = 'success' then 1 end)`.as('success_count'),
        ])
        .executeTakeFirst(),

      // Refund total (filtered)
      applyFilters(
        db.selectFrom('transactions as t')
          .leftJoin('orders as o', 'o.id', 't.order_id')
      )
        .where('t.kind', '=', 'refund')
        .select(sql<string>`coalesce(sum(t.amount::numeric), 0)`.as('total'))
        .executeTakeFirst(),

      // Transaction rows (filtered + paginated)
      applyFilters(
        db.selectFrom('transactions as t')
          .leftJoin('orders as o', 'o.id', 't.order_id')
          .leftJoin('shops as s', 's.id', 'o.shop_id')
      )
        .select([
          't.id', 't.created_at', 't.kind', 't.gateway', 't.amount', 't.currency',
          't.status', 's.name as shop_name', 'o.id as order_id', 'o.order_number',
        ])
        .orderBy('t.created_at', 'desc')
        .limit(PER_PAGE)
        .offset(offset)
        .execute(),

      // Distinct gateways for filter dropdown
      db.selectFrom('transactions')
        .select('gateway')
        .distinct()
        .where('gateway', 'is not', null)
        .orderBy('gateway', 'asc')
        .execute(),

      // Shops for filter dropdown
      db.selectFrom('shops')
        .select(['id', 'name'])
        .orderBy('name', 'asc')
        .execute(),
    ])

    // Compute summary values
    const totalCount = Number(totalCountResult?.count ?? 0)
    const totalAmount = totalAmountResult?.total ?? 0
    const successCount = Number(successRateResult?.success_count ?? 0)
    const rateTotal = Number(successRateResult?.total ?? 0)
    const successRate = rateTotal > 0 ? ((successCount / rateTotal) * 100).toFixed(1) : '0.0'
    const refundTotal = refundTotalResult?.total ?? 0
    const totalPages = Math.max(1, Math.ceil(totalCount / PER_PAGE))

    // Build query string for pagination links (preserving filters)
    function buildQs(p: number): string {
      const parts: string[] = [`page=${p}`]
      if (kindFilter) parts.push(`kind=${encodeURIComponent(kindFilter)}`)
      if (statusFilter) parts.push(`status=${encodeURIComponent(statusFilter)}`)
      if (gatewayFilter) parts.push(`gateway=${encodeURIComponent(gatewayFilter)}`)
      if (shopFilter) parts.push(`shop=${encodeURIComponent(shopFilter)}`)
      if (orderSearch) parts.push(`order=${encodeURIComponent(orderSearch)}`)
      return parts.join('&')
    }

    // --- Summary Cards ---
    const summaryHtml = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Total Transactions</div>
          <div class="stat-value">${fmtNum(totalCount)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Amount</div>
          <div class="stat-value">${fmtMoney(totalAmount)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Success Rate</div>
          <div class="stat-value">${successRate}%</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Refund Total</div>
          <div class="stat-value" style="color:var(--red,#ef4444)">${fmtMoney(refundTotal)}</div>
        </div>
      </div>`

    // --- Filter Bar ---
    const kindOptions = VALID_KINDS.map(k =>
      `<option value="${k}"${kindFilter === k ? ' selected' : ''}>${k.charAt(0).toUpperCase() + k.slice(1)}</option>`
    ).join('')

    const statusOptions = VALID_STATUSES.map(s =>
      `<option value="${s}"${statusFilter === s ? ' selected' : ''}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`
    ).join('')

    const gatewayOptions = gateways.map(g =>
      `<option value="${esc(g.gateway)}"${gatewayFilter === g.gateway ? ' selected' : ''}>${esc(g.gateway)}</option>`
    ).join('')

    const shopOptions = shops.map(s =>
      `<option value="${esc(s.id)}"${shopFilter === s.id ? ' selected' : ''}>${esc(s.name)}</option>`
    ).join('')

    const filterBarHtml = `
      <div class="card" style="margin-bottom:16px">
        <form method="GET" action="/god-admin/finance/transactions" style="display:flex;flex-wrap:wrap;gap:12px;align-items:end">
          <div>
            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--gray-500,#6b7280)">Kind</label>
            <select name="kind" class="form-input" style="min-width:120px;padding:6px 10px;border:1px solid var(--gray-300,#d1d5db);border-radius:6px;font-size:13px">
              <option value="">All Kinds</option>
              ${kindOptions}
            </select>
          </div>
          <div>
            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--gray-500,#6b7280)">Status</label>
            <select name="status" class="form-input" style="min-width:120px;padding:6px 10px;border:1px solid var(--gray-300,#d1d5db);border-radius:6px;font-size:13px">
              <option value="">All Statuses</option>
              ${statusOptions}
            </select>
          </div>
          <div>
            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--gray-500,#6b7280)">Gateway</label>
            <select name="gateway" class="form-input" style="min-width:140px;padding:6px 10px;border:1px solid var(--gray-300,#d1d5db);border-radius:6px;font-size:13px">
              <option value="">All Gateways</option>
              ${gatewayOptions}
            </select>
          </div>
          <div>
            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--gray-500,#6b7280)">Store</label>
            <select name="shop" class="form-input" style="min-width:160px;padding:6px 10px;border:1px solid var(--gray-300,#d1d5db);border-radius:6px;font-size:13px">
              <option value="">All Stores</option>
              ${shopOptions}
            </select>
          </div>
          <div>
            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--gray-500,#6b7280)">Order #</label>
            <input type="text" name="order" value="${esc(orderSearch)}" placeholder="Search order number" class="form-input" style="min-width:160px;padding:6px 10px;border:1px solid var(--gray-300,#d1d5db);border-radius:6px;font-size:13px" />
          </div>
          <div>
            <button type="submit" style="padding:6px 16px;background:var(--blue,#3b82f6);color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">Filter</button>
            <a href="/god-admin/finance/transactions" style="margin-left:8px;font-size:12px;color:var(--gray-500,#6b7280);text-decoration:underline">Reset</a>
          </div>
        </form>
      </div>`

    // --- Transaction Table ---
    const txRows = transactions.length > 0
      ? transactions.map(t => `
        <tr>
          <td class="mono" style="font-size:11px">${esc(t.id?.slice(0, 8))}...</td>
          <td>${shortDate(t.created_at)}</td>
          <td>${statusBadge(t.kind)}</td>
          <td>${esc(t.gateway)}</td>
          <td>${fmtMoney(t.amount)} ${esc(t.currency)}</td>
          <td>${statusBadge(t.status)}</td>
          <td>${esc(t.shop_name) || '-'}</td>
          <td>${t.order_number && t.order_id ? `<a href="/god-admin/orders/${esc(t.order_id)}">#${t.order_number}</a>` : '-'}</td>
        </tr>`).join('')
      : '<tr><td colspan="8" style="text-align:center;color:var(--gray-400,#9ca3af);padding:24px">No transactions found</td></tr>'

    // --- Pagination ---
    const prevDisabled = page <= 1
    const nextDisabled = page >= totalPages
    const paginationHtml = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;font-size:13px">
        <span style="color:var(--gray-500,#6b7280)">
          Showing ${totalCount > 0 ? offset + 1 : 0}–${Math.min(offset + PER_PAGE, totalCount)} of ${fmtNum(totalCount)} transactions
          ${totalPages > 1 ? `(Page ${page} of ${totalPages})` : ''}
        </span>
        <div style="display:flex;gap:8px">
          ${prevDisabled
            ? '<span style="padding:6px 12px;border:1px solid var(--gray-200,#e5e7eb);border-radius:6px;color:var(--gray-300,#d1d5db);cursor:default">&laquo; Prev</span>'
            : `<a href="?${buildQs(page - 1)}" style="padding:6px 12px;border:1px solid var(--gray-300,#d1d5db);border-radius:6px;color:var(--blue,#3b82f6);text-decoration:none">&laquo; Prev</a>`
          }
          ${nextDisabled
            ? '<span style="padding:6px 12px;border:1px solid var(--gray-200,#e5e7eb);border-radius:6px;color:var(--gray-300,#d1d5db);cursor:default">Next &raquo;</span>'
            : `<a href="?${buildQs(page + 1)}" style="padding:6px 12px;border:1px solid var(--gray-300,#d1d5db);border-radius:6px;color:var(--blue,#3b82f6);text-decoration:none">Next &raquo;</a>`
          }
        </div>
      </div>`

    const tableHtml = `
      <div class="card">
        <div class="card-title" style="margin-bottom:12px">Transaction Log</div>
        <table class="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Date</th>
              <th>Kind</th>
              <th>Gateway</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Store</th>
              <th>Order #</th>
            </tr>
          </thead>
          <tbody>${txRows}</tbody>
        </table>
        ${paginationHtml}
      </div>`

    // --- Assemble page ---
    const content = `
      <div class="page-header">
        <h1>Transaction Log</h1>
      </div>
      ${summaryHtml}
      ${filterBarHtml}
      ${tableHtml}
    `

    res.send(godLayout({
      title: 'Transaction Log',
      userEmail: req.godAdmin!.user.email,
      activePath: '/god-admin/finance/transactions',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Transaction Log error:', err)
    res.status(500).send(godLayout({
      title: 'Transaction Log',
      userEmail: req.godAdmin!.user.email,
      activePath: '/god-admin/finance/transactions',
      content: `<div class="card"><p style="color:var(--red,#ef4444)">Error loading transactions: ${esc(String(err))}</p></div>`,
    }))
  }
}
