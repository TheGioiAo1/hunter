/**
 * God Admin — Orders (Category D)
 *
 * GET /god-admin/orders — All orders across all stores
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string | null): string {
  if (!s) return ''
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function fmtMoney(val: string | number | null): string {
  const n = Number(val) || 0
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function shortDate(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function statusBadge(status: string | null): string {
  const s = status || 'unknown'
  const map: Record<string, string> = {
    active: 'badge-green', paid: 'badge-green', fulfilled: 'badge-green',
    pending: 'badge-yellow', unfulfilled: 'badge-yellow', partial: 'badge-yellow',
    refunded: 'badge-red', voided: 'badge-red', cancelled: 'badge-red',
  }
  return `<span class="badge ${map[s] || 'badge-gray'}">${esc(s)}</span>`
}

// ---------------------------------------------------------------------------
// GET /god-admin/orders
// ---------------------------------------------------------------------------

export async function getOrders(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user
  const search = (req.query.search as string || '').trim()
  const storeFilter = (req.query.store as string || '').trim()
  const paymentFilter = (req.query.payment as string || '').trim()
  const fulfillmentFilter = (req.query.fulfillment as string || '').trim()

  try {
    // Get stores for filter dropdown
    const allStores = await db.selectFrom('shops')
      .select(['id', 'name'])
      .orderBy('name', 'asc')
      .execute()

    let query = db.selectFrom('orders as o')
      .leftJoin('shops as s', 's.id', 'o.shop_id')
      .select([
        'o.id', 'o.order_number', 's.name as shop_name',
        'o.email', 'o.total_price', 'o.financial_status',
        'o.fulfillment_status', 'o.created_at',
      ])

    if (search) {
      query = query.where((eb) =>
        eb.or([
          eb('o.email', 'ilike', `%${search}%`),
          eb(sql`o.order_number::text`, 'like', `%${search}%`),
        ])
      )
    }

    if (storeFilter) {
      query = query.where('o.shop_id', '=', storeFilter)
    }

    if (paymentFilter) {
      query = query.where('o.financial_status', '=', paymentFilter)
    }

    if (fulfillmentFilter) {
      query = query.where('o.fulfillment_status', '=', fulfillmentFilter)
    }

    const orders = await query.orderBy('o.created_at', 'desc').limit(100).execute()

    // Build store options
    const storeOptions = allStores.map(s =>
      `<option value="${esc(s.id)}"${storeFilter === s.id ? ' selected' : ''}>${esc(s.name)}</option>`
    ).join('')

    // Phase 2.2 — wire order number → order detail drill-down.
    const tableRows = orders.length > 0
      ? orders.map(o => `
        <tr>
          <td><a href="/god-admin/orders/${esc(o.id)}"><strong>#${o.order_number}</strong></a></td>
          <td>${esc(o.shop_name)}</td>
          <td>${esc(o.email)}</td>
          <td>${fmtMoney(o.total_price)}</td>
          <td>${statusBadge(o.financial_status)}</td>
          <td>${statusBadge(o.fulfillment_status)}</td>
          <td>${shortDate(o.created_at)}</td>
        </tr>`).join('')
      : '<tr><td colspan="7" style="text-align:center;color:var(--gray-400);padding:24px">No orders found</td></tr>'

    const content = `
      <div class="page-header">
        <h1>All Orders</h1>
        <div class="action-group">
          <a href="/god-admin/orders?export=csv" class="btn btn-secondary btn-sm">Export CSV</a>
        </div>
      </div>

      <div class="card">
        <form method="get" action="/god-admin/orders" class="toolbar">
          <input type="text" name="search" class="search-input" placeholder="Search by email or order#..." value="${esc(search)}">
          <select name="store" class="filter-select">
            <option value="">All Stores</option>
            ${storeOptions}
          </select>
          <select name="payment" class="filter-select">
            <option value="">Payment Status</option>
            <option value="paid"${paymentFilter === 'paid' ? ' selected' : ''}>Paid</option>
            <option value="pending"${paymentFilter === 'pending' ? ' selected' : ''}>Pending</option>
            <option value="refunded"${paymentFilter === 'refunded' ? ' selected' : ''}>Refunded</option>
            <option value="voided"${paymentFilter === 'voided' ? ' selected' : ''}>Voided</option>
          </select>
          <select name="fulfillment" class="filter-select">
            <option value="">Fulfillment</option>
            <option value="unfulfilled"${fulfillmentFilter === 'unfulfilled' ? ' selected' : ''}>Unfulfilled</option>
            <option value="partial"${fulfillmentFilter === 'partial' ? ' selected' : ''}>Partial</option>
            <option value="fulfilled"${fulfillmentFilter === 'fulfilled' ? ' selected' : ''}>Fulfilled</option>
          </select>
          <button type="submit" class="btn btn-primary btn-sm">Filter</button>
        </form>

        <table class="data-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Store</th>
              <th>Customer</th>
              <th>Total</th>
              <th>Payment</th>
              <th>Fulfillment</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>`

    // Handle CSV export
    if (req.query.export === 'csv') {
      const csvHeader = 'Order#,Store,Customer,Total,Payment,Fulfillment,Date\n'
      const csvRows = orders.map(o =>
        `${o.order_number},"${o.shop_name || ''}","${o.email || ''}",${o.total_price},${o.financial_status},${o.fulfillment_status},${o.created_at}`
      ).join('\n')
      res.setHeader('Content-Type', 'text/csv')
      res.setHeader('Content-Disposition', 'attachment; filename=gbox-orders-export.csv')
      res.send(csvHeader + csvRows)
      return
    }

    res.send(godLayout({
      title: 'Orders',
      userEmail: user.email,
      activePath: '/god-admin/orders',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Orders error:', err)
    res.status(500).send(godLayout({
      title: 'Orders',
      userEmail: user.email,
      activePath: '/god-admin/orders',
      content: `<div class="card"><p style="color:var(--red)">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}
