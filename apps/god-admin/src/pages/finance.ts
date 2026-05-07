/**
 * God Admin — Finance (Category F)
 *
 * GET /god-admin/finance — Financial overview
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

function statusBadge(status: string | null): string {
  const s = status || 'unknown'
  const map: Record<string, string> = {
    success: 'badge-green', pending: 'badge-yellow', failure: 'badge-red', error: 'badge-red',
    sale: 'badge-green', capture: 'badge-green', refund: 'badge-red', void: 'badge-gray',
  }
  return `<span class="badge ${map[s] || 'badge-gray'}">${esc(s)}</span>`
}

// ---------------------------------------------------------------------------
// GET /god-admin/finance
// ---------------------------------------------------------------------------

export async function getFinance(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user

  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7).toISOString()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

  try {
    const [
      gmvAllTime,
      gmvMonth,
      gmvWeek,
      gmvToday,
      revenueByStore,
      recentTransactions,
      dailyRevenue,
    ] = await Promise.all([
      // All time GMV
      db.selectFrom('orders')
        .where('financial_status', '=', 'paid')
        .select(sql<string>`coalesce(sum(total_price::numeric), 0)`.as('total'))
        .executeTakeFirst(),

      // This month
      db.selectFrom('orders')
        .where('financial_status', '=', 'paid')
        .where('created_at', '>=', monthStart)
        .select(sql<string>`coalesce(sum(total_price::numeric), 0)`.as('total'))
        .executeTakeFirst(),

      // This week
      db.selectFrom('orders')
        .where('financial_status', '=', 'paid')
        .where('created_at', '>=', weekStart)
        .select(sql<string>`coalesce(sum(total_price::numeric), 0)`.as('total'))
        .executeTakeFirst(),

      // Today
      db.selectFrom('orders')
        .where('financial_status', '=', 'paid')
        .where('created_at', '>=', todayStart)
        .select(sql<string>`coalesce(sum(total_price::numeric), 0)`.as('total'))
        .executeTakeFirst(),

      // Revenue by store
      db.selectFrom('orders as o')
        .innerJoin('shops as s', 's.id', 'o.shop_id')
        .where('o.financial_status', '=', 'paid')
        .groupBy(['s.id', 's.name', 's.slug'])
        .select([
          's.name', 's.slug',
          sql<string>`coalesce(sum(o.total_price::numeric), 0)`.as('revenue'),
          sql<string>`count(o.id)`.as('order_count'),
        ])
        .orderBy(sql`sum(o.total_price::numeric)`, 'desc')
        .limit(20)
        .execute(),

      // Recent transactions
      db.selectFrom('transactions as t')
        .leftJoin('orders as o', 'o.id', 't.order_id')
        .leftJoin('shops as s', 's.id', 'o.shop_id')
        .select([
          't.id', 't.kind', 't.gateway', 't.amount', 't.currency', 't.status',
          't.created_at', 's.name as shop_name', 'o.id as order_id', 'o.order_number',
        ])
        .orderBy('t.created_at', 'desc')
        .limit(20)
        .execute(),

      // Daily revenue for last 7 days (text chart)
      db.selectFrom('orders')
        .where('financial_status', '=', 'paid')
        .where('created_at', '>=', weekStart)
        .groupBy(sql`date(created_at)`)
        .select([
          sql<string>`date(created_at)`.as('day'),
          sql<string>`coalesce(sum(total_price::numeric), 0)`.as('total'),
        ])
        .orderBy(sql`date(created_at)`, 'asc')
        .execute(),
    ])

    // GMV cards
    const gmvHtml = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">GMV (All Time)</div>
          <div class="stat-value">${fmtMoney(gmvAllTime?.total ?? 0)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">GMV (This Month)</div>
          <div class="stat-value">${fmtMoney(gmvMonth?.total ?? 0)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">GMV (This Week)</div>
          <div class="stat-value">${fmtMoney(gmvWeek?.total ?? 0)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">GMV (Today)</div>
          <div class="stat-value">${fmtMoney(gmvToday?.total ?? 0)}</div>
        </div>
      </div>`

    // Revenue by store table
    const storeRows = revenueByStore.length > 0
      ? revenueByStore.map((s, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${esc(s.name)}</td>
          <td class="mono">${esc(s.slug)}</td>
          <td>${fmtNum(s.order_count)}</td>
          <td><strong>${fmtMoney(s.revenue)}</strong></td>
        </tr>`).join('')
      : '<tr><td colspan="5" style="text-align:center;color:var(--gray-400);padding:24px">No revenue data</td></tr>'

    const revenueByStoreHtml = `
      <div class="card">
        <div class="card-title" style="margin-bottom:12px">Revenue by Store</div>
        <table class="data-table">
          <thead><tr><th>#</th><th>Store</th><th>Slug</th><th>Orders</th><th>Revenue</th></tr></thead>
          <tbody>${storeRows}</tbody>
        </table>
      </div>`

    // Transaction log
    const txRows = recentTransactions.length > 0
      ? recentTransactions.map(t => `
        <tr>
          <td class="mono" style="font-size:11px">${esc(t.id.slice(0, 8))}...</td>
          <td>${statusBadge(t.kind)}</td>
          <td>${esc(t.gateway)}</td>
          <td>${fmtMoney(t.amount)} ${esc(t.currency)}</td>
          <td>${statusBadge(t.status)}</td>
          <td>${esc(t.shop_name) || '-'}</td>
          <td>${t.order_number && t.order_id ? `<a href="/god-admin/orders/${esc(t.order_id)}">#${t.order_number}</a>` : '-'}</td>
          <td>${shortDate(t.created_at)}</td>
        </tr>`).join('')
      : '<tr><td colspan="8" style="text-align:center;color:var(--gray-400);padding:24px">No transactions</td></tr>'

    const transactionsHtml = `
      <div class="card">
        <div class="card-title" style="margin-bottom:12px">Recent Transactions</div>
        <table class="data-table">
          <thead><tr><th>ID</th><th>Kind</th><th>Gateway</th><th>Amount</th><th>Status</th><th>Store</th><th>Order</th><th>Date</th></tr></thead>
          <tbody>${txRows}</tbody>
        </table>
      </div>`

    // Daily revenue text chart
    const maxRevenue = Math.max(...dailyRevenue.map(d => Number(d.total)), 1)
    const chartRows = dailyRevenue.length > 0
      ? dailyRevenue.map(d => {
          const pct = Math.round((Number(d.total) / maxRevenue) * 100)
          const dayLabel = new Date(d.day + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
          return `
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
              <span style="width:100px;font-size:12px;color:var(--gray-500);text-align:right;flex-shrink:0">${dayLabel}</span>
              <div style="flex:1;height:24px;background:var(--gray-100);border-radius:4px;overflow:hidden">
                <div style="width:${pct}%;height:100%;background:var(--blue);border-radius:4px;min-width:2px"></div>
              </div>
              <span style="width:90px;font-size:12px;font-weight:600;color:var(--gray-700)">${fmtMoney(d.total)}</span>
            </div>`
        }).join('')
      : '<p style="color:var(--gray-400);text-align:center;padding:24px">No revenue data for the past 7 days</p>'

    const chartHtml = `
      <div class="card">
        <div class="card-title" style="margin-bottom:16px">Revenue Trend (Last 7 Days)</div>
        ${chartRows}
      </div>`

    // Payout & Commission section (client-side fetch to Platform API)
    const payoutHtml = `
      <div class="card" id="payout-section">
        <div class="card-title" style="margin-bottom:16px">Payout Summary by Store</div>
        <div id="payout-loading" style="text-align:center;padding:24px;color:var(--god-text-muted)">Loading payout data...</div>
        <div id="payout-content" style="display:none"></div>
      </div>
      <script>
      (function() {
        const host = location.hostname;
        fetch('http://' + host + ':4321/api/god/finance/payouts', { credentials: 'include' })
          .then(r => r.json())
          .then(data => {
            document.getElementById('payout-loading').style.display = 'none';
            const el = document.getElementById('payout-content');
            el.style.display = 'block';
            if (!data.payouts || data.payouts.length === 0) {
              el.innerHTML = '<p style="text-align:center;color:var(--god-text-muted);padding:24px">No payout data available</p>';
              return;
            }
            // Summary cards
            const totalGmv = data.payouts.reduce((s, p) => s + Number(p.total_revenue || 0), 0);
            const totalCommission = data.payouts.reduce((s, p) => s + Number(p.platform_commission || 0), 0);
            const totalPayout = data.payouts.reduce((s, p) => s + Number(p.seller_payout || 0), 0);
            const fmt = (v) => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

            let html = '<div class="stats-grid" style="margin-bottom:16px">';
            html += '<div class="stat-card"><div class="stat-label">Total Revenue (Paid)</div><div class="stat-value">' + fmt(totalGmv) + '</div></div>';
            html += '<div class="stat-card"><div class="stat-label">Platform Commission</div><div class="stat-value" style="color:#f59e0b">' + fmt(totalCommission) + '</div></div>';
            html += '<div class="stat-card"><div class="stat-label">Seller Payouts Due</div><div class="stat-value" style="color:#10b981">' + fmt(totalPayout) + '</div></div>';
            html += '</div>';

            // Per-store breakdown table
            html += '<table class="data-table"><thead><tr><th>Store</th><th>Orders</th><th>Revenue</th><th>Commission (' + (data.commission_rate || '10') + '%)</th><th>Seller Payout</th></tr></thead><tbody>';
            data.payouts.forEach(function(p) {
              html += '<tr>';
              html += '<td>' + (p.store_name || p.shop_id || '-') + '</td>';
              html += '<td>' + Number(p.order_count || 0).toLocaleString() + '</td>';
              html += '<td>' + fmt(p.total_revenue) + '</td>';
              html += '<td style="color:#f59e0b">' + fmt(p.platform_commission) + '</td>';
              html += '<td style="color:#10b981;font-weight:600">' + fmt(p.seller_payout) + '</td>';
              html += '</tr>';
            });
            html += '</tbody></table>';
            el.innerHTML = html;
          })
          .catch(function(err) {
            document.getElementById('payout-loading').style.display = 'none';
            document.getElementById('payout-content').style.display = 'block';
            document.getElementById('payout-content').innerHTML = '<p style="color:var(--god-text-muted);text-align:center;padding:16px">Payout API not available — commission data will appear once orders flow through the platform.</p>';
          });
      })();
      </script>`

    const content = `
      <div class="page-header">
        <h1>Financial Overview</h1>
      </div>
      ${gmvHtml}
      ${chartHtml}
      ${revenueByStoreHtml}
      ${payoutHtml}
      ${transactionsHtml}
    `

    res.send(godLayout({
      title: 'Finance',
      userEmail: user.email,
      activePath: '/god-admin/finance',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Finance error:', err)
    res.status(500).send(godLayout({
      title: 'Finance',
      userEmail: user.email,
      activePath: '/god-admin/finance',
      content: `<div class="card"><p style="color:var(--red)">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}
