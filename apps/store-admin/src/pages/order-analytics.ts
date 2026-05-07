/**
 * Store Admin — Order Analytics
 *
 * Dedicated order analytics page scoped to the current store.
 * Period selector (7d / 30d / 90d / all), summary KPIs,
 * daily order & revenue charts, fulfillment/payment breakdowns,
 * top products by order volume, repeat customer rate.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sql } from 'kysely'
import { sellerLayout, esc } from '../layouts/seller-layout.js'

// ─── Helpers ──────────────────────────────────────────────────────

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US')
}

function shortDate(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function pct(a: number, b: number): string {
  if (b === 0) return '0.0'
  return ((a / b) * 100).toFixed(1)
}

function periodDates(period: string): { startDate: Date | null; days: number; label: string } {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  switch (period) {
    case '7d':  { const s = new Date(today); s.setDate(s.getDate() - 7);  return { startDate: s, days: 7,  label: 'Last 7 days' } }
    case '90d': { const s = new Date(today); s.setDate(s.getDate() - 90); return { startDate: s, days: 90, label: 'Last 90 days' } }
    case 'all': return { startDate: null, days: 0, label: 'All time' }
    default:    { const s = new Date(today); s.setDate(s.getDate() - 30); return { startDate: s, days: 30, label: 'Last 30 days' } }
  }
}

function groupByDayCount(rows: Array<{ created_at: any }>): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows) {
    const day = new Date(r.created_at).toISOString().slice(0, 10)
    m.set(day, (m.get(day) || 0) + 1)
  }
  return m
}

function groupByDayRevenue(rows: Array<{ created_at: any; total_price: any }>): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows) {
    const day = new Date(r.created_at).toISOString().slice(0, 10)
    m.set(day, (m.get(day) || 0) + Number(r.total_price))
  }
  return m
}

function fillDays(
  byDay: Map<string, number>,
  startDate: Date,
  days: number,
): Array<{ label: string; value: number; date: string }> {
  const result: Array<{ label: string; value: number; date: string }> = []
  for (let i = 0; i < days; i++) {
    const d = new Date(startDate)
    d.setDate(d.getDate() + i)
    const key = d.toISOString().slice(0, 10)
    const label = days <= 7
      ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]
      : shortDate(d)
    result.push({ label, value: byDay.get(key) || 0, date: key })
  }
  return result
}

function buildBarChart(
  data: Array<{ label: string; value: number }>,
  maxVal: number,
  formatter: (v: number) => string = String,
): string {
  if (data.length === 0) return '<div class="empty-state"><div class="empty-state-text">No data for this period.</div></div>'
  return `
    <div class="bar-chart">
      ${data.map(d => `
        <div class="bar-col">
          <div class="bar-fill" style="height:${Math.max((d.value / (maxVal || 1)) * 100, 2)}%" title="${esc(formatter(d.value))}"></div>
          <div class="bar-label">${esc(d.label)}</div>
        </div>
      `).join('')}
    </div>
  `
}

function horizontalBar(label: string, count: number, maxCount: number, color: string): string {
  const w = maxCount > 0 ? Math.max((count / maxCount) * 100, 2) : 0
  return `
    <div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
        <span>${esc(label)}</span>
        <span style="font-weight:600">${fmtNum(count)}</span>
      </div>
      <div style="height:8px;border-radius:4px;background:var(--s-border);overflow:hidden">
        <div style="height:100%;width:${w}%;border-radius:4px;background:${color};transition:width .3s"></div>
      </div>
    </div>
  `
}

// ─── Main handler ─────────────────────────────────────────────────

export async function getOrderAnalytics(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`

  const period = (req.query.period as string) || '30d'
  const { startDate, days, label: periodLabel } = periodDates(period)

  try {
    // Build date filter helper
    const withDateFilter = <T extends { where: (...args: any[]) => T }>(q: T): T => {
      if (startDate) {
        return q.where('created_at', '>=', startDate.toISOString())
      }
      return q
    }

    const withOrderDateFilter = <T extends { where: (...args: any[]) => T }>(q: T, alias = 'o'): T => {
      if (startDate) {
        return q.where(`${alias}.created_at` as any, '>=', startDate.toISOString())
      }
      return q
    }

    // ─── Parallel queries ──────────────────────────────────────────
    const [
      summaryStats,
      fulfillmentBreakdown,
      paymentBreakdown,
      orderRows,
      topProducts,
      totalCustomers,
      repeatCustomers,
    ] = await Promise.all([
      // 1. Summary stats: total orders, avg order value, fulfilled count, refunded count
      (() => {
        let q = db.selectFrom('orders')
          .select([
            db.fn.count('id').as('total_orders'),
            db.fn.avg('total_price').as('avg_order_value'),
            db.fn.sum('total_price').as('total_revenue'),
            sql<number>`SUM(CASE WHEN fulfillment_status = 'fulfilled' THEN 1 ELSE 0 END)`.as('fulfilled_count'),
            sql<number>`SUM(CASE WHEN financial_status = 'refunded' THEN 1 ELSE 0 END)`.as('refunded_count'),
          ])
          .where('shop_id', '=', store.id)
        if (startDate) q = q.where('created_at', '>=', startDate.toISOString())
        return q.executeTakeFirst()
      })(),

      // 2. Fulfillment status breakdown
      (() => {
        let q = db.selectFrom('orders')
          .select([
            sql<string>`COALESCE(fulfillment_status, 'unfulfilled')`.as('status'),
            db.fn.count('id').as('count'),
          ])
          .where('shop_id', '=', store.id)
        if (startDate) q = q.where('created_at', '>=', startDate.toISOString())
        return q.groupBy(sql`COALESCE(fulfillment_status, 'unfulfilled')`).execute()
      })(),

      // 3. Payment status breakdown
      (() => {
        let q = db.selectFrom('orders')
          .select([
            sql<string>`COALESCE(financial_status, 'pending')`.as('status'),
            db.fn.count('id').as('count'),
          ])
          .where('shop_id', '=', store.id)
        if (startDate) q = q.where('created_at', '>=', startDate.toISOString())
        return q.groupBy(sql`COALESCE(financial_status, 'pending')`).execute()
      })(),

      // 4. Raw order rows for daily charts
      (() => {
        let q = db.selectFrom('orders')
          .select(['created_at', 'total_price'])
          .where('shop_id', '=', store.id)
        if (startDate) q = q.where('created_at', '>=', startDate.toISOString())
        return q.orderBy('created_at', 'asc').execute()
      })(),

      // 5. Top 10 products by order volume
      (() => {
        let q = db.selectFrom('order_line_items as oli')
          .innerJoin('products as p', 'p.id', 'oli.product_id')
          .innerJoin('orders as o', 'o.id', 'oli.order_id')
          .select([
            'p.id as product_id',
            'p.title',
            db.fn.sum('oli.quantity').as('units_sold'),
            db.fn.count('oli.order_id').as('order_count'),
            db.fn.sum('oli.price').as('revenue'),
          ])
          .where('o.shop_id', '=', store.id)
        if (startDate) q = q.where('o.created_at', '>=', startDate.toISOString())
        return q.groupBy(['p.id', 'p.title']).orderBy('order_count', 'desc').limit(10).execute()
      })(),

      // 6. Total unique customers with orders
      (() => {
        let q = db.selectFrom('orders')
          .select(sql<number>`COUNT(DISTINCT customer_id)`.as('count'))
          .where('shop_id', '=', store.id)
          .where('customer_id', 'is not', null)
        if (startDate) q = q.where('created_at', '>=', startDate.toISOString())
        return q.executeTakeFirst()
      })(),

      // 7. Repeat customers (>1 order)
      (() => {
        let inner = db.selectFrom('orders')
          .select(['customer_id', db.fn.count('id').as('order_count')])
          .where('shop_id', '=', store.id)
          .where('customer_id', 'is not', null)
        if (startDate) inner = inner.where('created_at', '>=', startDate.toISOString())
        return db.selectFrom(
          inner.groupBy('customer_id').as('sub'),
        )
          .select(db.fn.count('sub.customer_id').as('count'))
          .where('sub.order_count', '>', 1)
          .executeTakeFirst()
      })(),
    ])

    // ─── Compute values ────────────────────────────────────────────
    const totalOrders = Number(summaryStats?.total_orders ?? 0)
    const avgOrderValue = Number(summaryStats?.avg_order_value ?? 0)
    const totalRevenue = Number(summaryStats?.total_revenue ?? 0)
    const fulfilledCount = Number(summaryStats?.fulfilled_count ?? 0)
    const refundedCount = Number(summaryStats?.refunded_count ?? 0)
    const fulfillmentRate = totalOrders > 0 ? (fulfilledCount / totalOrders) * 100 : 0
    const refundRate = totalOrders > 0 ? (refundedCount / totalOrders) * 100 : 0

    const totalCust = Number(totalCustomers?.count ?? 0)
    const repeatCust = Number(repeatCustomers?.count ?? 0)
    const repeatRate = totalCust > 0 ? (repeatCust / totalCust) * 100 : 0

    // ─── Daily charts ──────────────────────────────────────────────
    const byDayCount = groupByDayCount(orderRows)
    const byDayRevenue = groupByDayRevenue(orderRows)

    // For "all time" we derive days from the data range
    let chartDays = days
    let chartStart = startDate
    if (!startDate && orderRows.length > 0) {
      const first = new Date(orderRows[0].created_at)
      const last = new Date(orderRows[orderRows.length - 1].created_at)
      chartStart = new Date(first.getFullYear(), first.getMonth(), first.getDate())
      const end = new Date(last.getFullYear(), last.getMonth(), last.getDate())
      chartDays = Math.max(Math.ceil((end.getTime() - chartStart.getTime()) / 86400000) + 1, 1)
      // Cap at 365 for readability
      if (chartDays > 365) {
        chartStart = new Date(end)
        chartStart.setDate(chartStart.getDate() - 365)
        chartDays = 365
      }
    }

    const orderChartData = chartStart ? fillDays(byDayCount, chartStart, chartDays) : []
    const revenueChartData = chartStart ? fillDays(byDayRevenue, chartStart, chartDays) : []
    const maxOrderCount = Math.max(...orderChartData.map(d => d.value), 1)
    const maxRevenue = Math.max(...revenueChartData.map(d => d.value), 1)

    // ─── Fulfillment breakdown ─────────────────────────────────────
    const fulfillMap = new Map<string, number>()
    for (const row of fulfillmentBreakdown) {
      fulfillMap.set(String(row.status), Number(row.count))
    }
    const fStatuses = ['unfulfilled', 'partially_fulfilled', 'fulfilled', 'cancelled']
    const fColors: Record<string, string> = {
      unfulfilled: 'var(--s-warning, #f59e0b)',
      partially_fulfilled: 'var(--s-info, #3b82f6)',
      fulfilled: 'var(--s-success, #22c55e)',
      cancelled: 'var(--s-danger, #ef4444)',
    }
    const fLabels: Record<string, string> = {
      unfulfilled: 'Unfulfilled',
      partially_fulfilled: 'Partially Fulfilled',
      fulfilled: 'Fulfilled',
      cancelled: 'Cancelled',
    }
    const maxFulfill = Math.max(...fStatuses.map(s => fulfillMap.get(s) || 0), 1)

    // ─── Payment breakdown ─────────────────────────────────────────
    const payMap = new Map<string, number>()
    for (const row of paymentBreakdown) {
      payMap.set(String(row.status), Number(row.count))
    }
    const pStatuses = ['pending', 'paid', 'refunded', 'voided']
    const pBadgeClass: Record<string, string> = {
      pending: 'badge-yellow',
      paid: 'badge-green',
      refunded: 'badge-red',
      voided: 'badge-gray',
    }
    const pLabels: Record<string, string> = {
      pending: 'Pending',
      paid: 'Paid',
      refunded: 'Refunded',
      voided: 'Voided',
    }

    // ─── Build HTML ────────────────────────────────────────────────
    const content = `
      <style>
        .period-tabs { display:flex; gap:2px; background:var(--s-card); border-radius:8px; border:1px solid var(--s-border); padding:2px; }
        .period-tab { padding:6px 14px; font-size:12px; border-radius:6px; text-decoration:none; color:var(--s-text-muted); transition:all .15s; cursor:pointer; }
        .period-tab:hover { color:var(--s-text); }
        .period-tab.active { background:var(--s-accent); color:#fff; }
        .bar-chart { display:flex; align-items:flex-end; gap:2px; height:160px; padding:8px 0; }
        .bar-col { flex:1; display:flex; flex-direction:column; align-items:center; min-width:0; }
        .bar-fill { width:100%; min-width:4px; max-width:32px; background:var(--s-accent); border-radius:3px 3px 0 0; transition:height .3s; cursor:pointer; }
        .bar-label { font-size:10px; color:var(--s-text-muted); margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; }
        .two-col { display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-bottom:20px; }
        .pay-grid { display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; }
        .repeat-box { display:flex; align-items:center; gap:24px; }
        .repeat-ring { position:relative; width:100px; height:100px; }
        .repeat-ring svg { transform:rotate(-90deg); }
        .repeat-ring-label { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); font-size:20px; font-weight:700; color:var(--s-text); }
        @media (max-width:768px) {
          .two-col { grid-template-columns:1fr; }
          .pay-grid { grid-template-columns:repeat(2, 1fr); }
        }
      </style>

      <div class="page-header">
        <div>
          <h1 class="page-title">Order Analytics</h1>
          <p style="color:var(--s-text-muted);margin:0;font-size:13px">${esc(periodLabel)} &mdash; ${esc(store.name)}</p>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <div class="period-tabs">
            ${['7d', '30d', '90d', 'all'].map(p => `
              <a href="${base}/orders/analytics?period=${p}" class="period-tab${period === p ? ' active' : ''}">${
                p === '7d' ? '7 days' : p === '30d' ? '30 days' : p === '90d' ? '90 days' : 'All time'
              }</a>
            `).join('')}
          </div>
        </div>
      </div>

      <!-- Summary Cards -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-value">${fmtNum(totalOrders)}</div>
          <div class="stat-label">Total Orders</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${fmtMoney(avgOrderValue)}</div>
          <div class="stat-label">Avg Order Value</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${fulfillmentRate.toFixed(1)}%</div>
          <div class="stat-label">Fulfillment Rate</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${refundRate.toFixed(1)}%</div>
          <div class="stat-label">Refund Rate</div>
        </div>
      </div>

      <!-- Orders by Day Chart -->
      <div class="card" style="margin-bottom:20px">
        <div class="card-header">
          <span>Orders by Day</span>
          <span style="font-size:12px;color:var(--s-text-dim)">${fmtNum(totalOrders)} total</span>
        </div>
        <div class="card-body">
          ${orderChartData.length > 0
            ? buildBarChart(orderChartData, maxOrderCount, v => `${v} orders`)
            : '<div class="empty-state"><div class="empty-state-text">No order data for this period.</div></div>'
          }
        </div>
      </div>

      <!-- Revenue by Day Chart -->
      <div class="card" style="margin-bottom:20px">
        <div class="card-header">
          <span>Revenue by Day</span>
          <span style="font-size:12px;color:var(--s-text-dim)">${fmtMoney(totalRevenue)} total</span>
        </div>
        <div class="card-body">
          ${revenueChartData.length > 0
            ? buildBarChart(revenueChartData, maxRevenue, fmtMoney)
            : '<div class="empty-state"><div class="empty-state-text">No revenue data for this period.</div></div>'
          }
        </div>
      </div>

      <div class="two-col">
        <!-- Fulfillment Status Breakdown -->
        <div class="card">
          <div class="card-header"><span>Fulfillment Status</span></div>
          <div class="card-body">
            ${fStatuses.map(s => horizontalBar(fLabels[s], fulfillMap.get(s) || 0, maxFulfill, fColors[s])).join('')}
          </div>
        </div>

        <!-- Payment Status Breakdown -->
        <div class="card">
          <div class="card-header"><span>Payment Status</span></div>
          <div class="card-body">
            <div class="pay-grid">
              ${pStatuses.map(s => `
                <div class="stat-card" style="text-align:center">
                  <div class="stat-value">${fmtNum(payMap.get(s) || 0)}</div>
                  <div class="stat-label"><span class="badge ${pBadgeClass[s]}">${esc(pLabels[s])}</span></div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>

      <div class="two-col">
        <!-- Top Products by Order Volume -->
        <div class="card">
          <div class="card-header"><span>Top Products by Order Volume</span></div>
          <div class="card-body" style="padding:0">
            ${topProducts.length > 0 ? `
              <div class="table-wrap">
                <table class="data-table">
                  <thead>
                    <tr><th>#</th><th>Product</th><th>Orders</th><th>Units</th><th>Revenue</th></tr>
                  </thead>
                  <tbody>
                    ${topProducts.map((p, i) => `
                      <tr>
                        <td style="color:var(--s-text-muted)">${i + 1}</td>
                        <td>
                          <a href="${base}/products/${(p as any).product_id}" style="color:var(--s-accent);text-decoration:none">${esc((p as any).title)}</a>
                        </td>
                        <td>${fmtNum(Number((p as any).order_count))}</td>
                        <td>${fmtNum(Number((p as any).units_sold))}</td>
                        <td style="font-weight:600;color:var(--s-success)">${fmtMoney(Number((p as any).revenue))}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            ` : '<div class="empty-state"><div class="empty-state-text">No product data for this period.</div></div>'}
          </div>
        </div>

        <!-- Repeat Customer Rate -->
        <div class="card">
          <div class="card-header"><span>Repeat Customer Rate</span></div>
          <div class="card-body">
            <div class="repeat-box">
              <div class="repeat-ring">
                <svg width="100" height="100" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="40" fill="none" stroke="var(--s-border)" stroke-width="10"/>
                  <circle cx="50" cy="50" r="40" fill="none" stroke="var(--s-accent)" stroke-width="10"
                    stroke-dasharray="${(repeatRate / 100) * 251.2} 251.2"
                    stroke-linecap="round"/>
                </svg>
                <div class="repeat-ring-label">${repeatRate.toFixed(0)}%</div>
              </div>
              <div>
                <div style="font-size:14px;margin-bottom:8px">
                  <strong>${fmtNum(repeatCust)}</strong>
                  <span style="color:var(--s-text-muted)"> repeat customers</span>
                </div>
                <div style="font-size:14px;margin-bottom:8px">
                  <strong>${fmtNum(totalCust)}</strong>
                  <span style="color:var(--s-text-muted)"> total customers</span>
                </div>
                <div style="font-size:14px">
                  <strong>${fmtNum(totalCust - repeatCust)}</strong>
                  <span style="color:var(--s-text-muted)"> one-time buyers</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `

    res.send(sellerLayout({
      title: 'Order Analytics',
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
  } catch (err) {
    console.error('[order-analytics] Error:', err)
    const content = `
      <div class="page-header">
        <h1 class="page-title">Order Analytics</h1>
      </div>
      <div class="card">
        <div class="card-body">
          <div class="empty-state">
            <div class="empty-state-title">Error loading analytics</div>
            <div class="empty-state-text">Something went wrong. Please try again later.</div>
          </div>
        </div>
      </div>
    `
    res.status(500).send(sellerLayout({
      title: 'Order Analytics',
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
}
