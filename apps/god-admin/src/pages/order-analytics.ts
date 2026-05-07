/**
 * God Admin — Order Analytics
 *
 * GET /god-admin/orders/analytics — Order analytics dashboard
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

function fmtNum(val: number | string | null): string {
  return Number(val || 0).toLocaleString('en-US')
}

function shortDate(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ---------------------------------------------------------------------------
// GET /god-admin/orders/analytics
// ---------------------------------------------------------------------------

export async function getOrderAnalytics(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user

  const now = new Date()
  const thirtyDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30).toISOString()
  const sevenDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7).toISOString()
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString()
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59).toISOString()

  try {
    const [
      fulfillmentPipeline,
      paymentBreakdown,
      ordersOverTime,
      avgOrderThisMonth,
      avgOrderLastMonth,
      topStores,
      funnelPending,
      funnelPaid,
      funnelFulfilled,
    ] = await Promise.all([
      // Order Pipeline — count by fulfillment_status
      db.selectFrom('orders')
        .select([
          'fulfillment_status',
          db.fn.count<string>('id').as('count'),
        ])
        .groupBy('fulfillment_status')
        .execute(),

      // Payment Status Breakdown — count by financial_status
      db.selectFrom('orders')
        .select([
          'financial_status',
          db.fn.count<string>('id').as('count'),
        ])
        .groupBy('financial_status')
        .execute(),

      // Orders Over Time — last 30 days grouped by day
      db.selectFrom('orders')
        .where('created_at', '>=', thirtyDaysAgo)
        .groupBy(sql`date(created_at)`)
        .select([
          sql<string>`date(created_at)`.as('day'),
          db.fn.count<string>('id').as('count'),
          sql<string>`coalesce(sum(total_price::numeric), 0)`.as('revenue'),
        ])
        .orderBy(sql`date(created_at)`, 'asc')
        .execute(),

      // Average Order Value — this month
      db.selectFrom('orders')
        .where('financial_status', '=', 'paid')
        .where('created_at', '>=', thisMonthStart)
        .select(sql<string>`coalesce(avg(total_price::numeric), 0)`.as('avg_value'))
        .executeTakeFirst(),

      // Average Order Value — last month
      db.selectFrom('orders')
        .where('financial_status', '=', 'paid')
        .where('created_at', '>=', lastMonthStart)
        .where('created_at', '<=', lastMonthEnd)
        .select(sql<string>`coalesce(avg(total_price::numeric), 0)`.as('avg_value'))
        .executeTakeFirst(),

      // Top 10 Stores by Order Count
      db.selectFrom('orders as o')
        .innerJoin('shops as s', 's.id', 'o.shop_id')
        .groupBy(['s.id', 's.name'])
        .select([
          's.name as store_name',
          db.fn.count<string>('o.id').as('order_count'),
          sql<string>`coalesce(sum(o.total_price::numeric), 0)`.as('revenue'),
        ])
        .orderBy(db.fn.count('o.id'), 'desc')
        .limit(10)
        .execute(),

      // Conversion Funnel — pending orders last 7 days
      db.selectFrom('orders')
        .where('created_at', '>=', sevenDaysAgo)
        .where('financial_status', '=', 'pending')
        .select(db.fn.count<string>('id').as('count'))
        .executeTakeFirst(),

      // Conversion Funnel — paid orders last 7 days
      db.selectFrom('orders')
        .where('created_at', '>=', sevenDaysAgo)
        .where('financial_status', '=', 'paid')
        .select(db.fn.count<string>('id').as('count'))
        .executeTakeFirst(),

      // Conversion Funnel — fulfilled orders last 7 days
      db.selectFrom('orders')
        .where('created_at', '>=', sevenDaysAgo)
        .where('fulfillment_status', '=', 'fulfilled')
        .select(db.fn.count<string>('id').as('count'))
        .executeTakeFirst(),
    ])

    // -----------------------------------------------------------------------
    // Order Pipeline (horizontal bar chart)
    // -----------------------------------------------------------------------

    const pipelineStatuses = ['unfulfilled', 'partially_fulfilled', 'fulfilled', 'cancelled']
    const pipelineMap = new Map(fulfillmentPipeline.map(r => [r.fulfillment_status, Number(r.count)]))
    const pipelineMax = Math.max(...pipelineStatuses.map(s => pipelineMap.get(s) || 0), 1)

    const pipelineColors: Record<string, string> = {
      unfulfilled: '#f59e0b',
      partially_fulfilled: '#3b82f6',
      fulfilled: '#10b981',
      cancelled: '#ef4444',
    }

    const pipelineBars = pipelineStatuses.map(status => {
      const count = pipelineMap.get(status) || 0
      const pct = Math.round((count / pipelineMax) * 100)
      const color = pipelineColors[status] || '#6b7280'
      const label = status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      return `
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
          <span style="width:160px;font-size:13px;color:var(--gray-600);text-align:right;flex-shrink:0">${esc(label)}</span>
          <div style="flex:1;height:28px;background:var(--gray-100);border-radius:4px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:${color};border-radius:4px;min-width:2px"></div>
          </div>
          <span style="width:60px;font-size:13px;font-weight:600;color:var(--gray-700)">${fmtNum(count)}</span>
        </div>`
    }).join('')

    const pipelineHtml = `
      <div class="card">
        <div class="card-title" style="margin-bottom:16px">Order Pipeline</div>
        ${pipelineBars}
      </div>`

    // -----------------------------------------------------------------------
    // Payment Status Breakdown (stat cards)
    // -----------------------------------------------------------------------

    const paymentStatuses = ['pending', 'paid', 'refunded', 'voided']
    const paymentMap = new Map(paymentBreakdown.map(r => [r.financial_status, Number(r.count)]))

    const paymentBadgeClass: Record<string, string> = {
      pending: 'badge-yellow',
      paid: 'badge-green',
      refunded: 'badge-red',
      voided: 'badge-gray',
    }

    const paymentCards = paymentStatuses.map(status => {
      const count = paymentMap.get(status) || 0
      const badge = paymentBadgeClass[status] || 'badge-gray'
      const label = status.replace(/\b\w/g, c => c.toUpperCase())
      return `
        <div class="stat-card">
          <div class="stat-label"><span class="badge ${badge}">${esc(label)}</span></div>
          <div class="stat-value">${fmtNum(count)}</div>
        </div>`
    }).join('')

    const paymentHtml = `
      <div class="stats-grid">
        ${paymentCards}
      </div>`

    // -----------------------------------------------------------------------
    // Orders Over Time (last 30 days text bar chart)
    // -----------------------------------------------------------------------

    const maxOrders = Math.max(...ordersOverTime.map(d => Number(d.count)), 1)
    const timeChartRows = ordersOverTime.length > 0
      ? ordersOverTime.map(d => {
          const pct = Math.round((Number(d.count) / maxOrders) * 100)
          const dayLabel = new Date(d.day + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          return `
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">
              <span style="width:70px;font-size:11px;color:var(--gray-500);text-align:right;flex-shrink:0">${dayLabel}</span>
              <div style="flex:1;height:22px;background:var(--gray-100);border-radius:4px;overflow:hidden">
                <div style="width:${pct}%;height:100%;background:var(--blue);border-radius:4px;min-width:2px"></div>
              </div>
              <span style="width:50px;font-size:11px;font-weight:600;color:var(--gray-700);text-align:right">${fmtNum(d.count)}</span>
              <span style="width:80px;font-size:11px;color:var(--gray-400);text-align:right">${fmtMoney(d.revenue)}</span>
            </div>`
        }).join('')
      : '<p style="color:var(--gray-400);text-align:center;padding:24px">No order data for the past 30 days</p>'

    const timeChartHtml = `
      <div class="card">
        <div class="card-title" style="margin-bottom:16px">Orders Over Time (Last 30 Days)</div>
        ${timeChartRows}
      </div>`

    // -----------------------------------------------------------------------
    // Average Order Value comparison
    // -----------------------------------------------------------------------

    const aovThis = Number(avgOrderThisMonth?.avg_value ?? 0)
    const aovLast = Number(avgOrderLastMonth?.avg_value ?? 0)
    const aovDiff = aovLast > 0 ? ((aovThis - aovLast) / aovLast) * 100 : 0
    const aovArrow = aovDiff > 0 ? '&#9650;' : aovDiff < 0 ? '&#9660;' : '&#8212;'
    const aovColor = aovDiff > 0 ? '#10b981' : aovDiff < 0 ? '#ef4444' : 'var(--gray-500)'

    const aovHtml = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">AOV (This Month)</div>
          <div class="stat-value">${fmtMoney(aovThis)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">AOV (Last Month)</div>
          <div class="stat-value">${fmtMoney(aovLast)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Change</div>
          <div class="stat-value" style="color:${aovColor}">${aovArrow} ${Math.abs(aovDiff).toFixed(1)}%</div>
        </div>
      </div>`

    // -----------------------------------------------------------------------
    // Top Stores by Order Count
    // -----------------------------------------------------------------------

    const storeRows = topStores.length > 0
      ? topStores.map((s, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${esc(s.store_name)}</td>
          <td>${fmtNum(s.order_count)}</td>
          <td><strong>${fmtMoney(s.revenue)}</strong></td>
        </tr>`).join('')
      : '<tr><td colspan="4" style="text-align:center;color:var(--gray-400);padding:24px">No store data</td></tr>'

    const topStoresHtml = `
      <div class="card">
        <div class="card-title" style="margin-bottom:12px">Top Stores by Order Count</div>
        <table class="data-table">
          <thead><tr><th>#</th><th>Store</th><th>Orders</th><th>Revenue</th></tr></thead>
          <tbody>${storeRows}</tbody>
        </table>
      </div>`

    // -----------------------------------------------------------------------
    // Conversion Funnel (last 7 days)
    // -----------------------------------------------------------------------

    const funnelSteps = [
      { label: 'Pending', count: Number(funnelPending?.count ?? 0), color: '#f59e0b' },
      { label: 'Paid', count: Number(funnelPaid?.count ?? 0), color: '#3b82f6' },
      { label: 'Fulfilled', count: Number(funnelFulfilled?.count ?? 0), color: '#10b981' },
    ]
    const funnelTotal = Math.max(funnelSteps[0].count + funnelSteps[1].count + funnelSteps[2].count, 1)
    const funnelMax = Math.max(...funnelSteps.map(s => s.count), 1)

    const funnelBars = funnelSteps.map(step => {
      const pct = Math.round((step.count / funnelMax) * 100)
      return `
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
          <span style="width:80px;font-size:13px;font-weight:600;color:var(--gray-600);text-align:right;flex-shrink:0">${step.label}</span>
          <div style="flex:1;height:32px;background:var(--gray-100);border-radius:4px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:${step.color};border-radius:4px;min-width:2px;display:flex;align-items:center;padding-left:8px">
              <span style="font-size:12px;font-weight:600;color:#fff">${fmtNum(step.count)}</span>
            </div>
          </div>
        </div>`
    }).join('')

    const funnelHtml = `
      <div class="card">
        <div class="card-title" style="margin-bottom:16px">Conversion Funnel (Last 7 Days)</div>
        ${funnelBars}
        <div style="margin-top:12px;font-size:12px;color:var(--gray-400);text-align:center">
          Total orders in period: ${fmtNum(funnelTotal)}
        </div>
      </div>`

    // -----------------------------------------------------------------------
    // Page assembly
    // -----------------------------------------------------------------------

    const content = `
      <div class="page-header">
        <h1>Order Analytics</h1>
      </div>

      ${paymentHtml}
      ${aovHtml}
      ${pipelineHtml}
      ${timeChartHtml}
      ${funnelHtml}
      ${topStoresHtml}
    `

    res.send(godLayout({
      title: 'Order Analytics',
      userEmail: user.email,
      userName: user.name,
      activePath: '/god-admin/orders/analytics',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Order Analytics error:', err)
    res.status(500).send(godLayout({
      title: 'Order Analytics',
      userEmail: user.email,
      userName: user.name,
      activePath: '/god-admin/orders/analytics',
      content: `<div class="card"><p style="color:var(--red)">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}
