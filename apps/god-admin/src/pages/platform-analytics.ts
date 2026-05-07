/**
 * God Admin — Platform Analytics (Phase 6 PR5)
 *
 * GET /god-admin/analytics/platform
 *
 * The platform-wide answer to "how is the whole business doing?". Per
 * Iron Rule #2 this is gated on the `god_admin` role (handled upstream
 * by the god-auth middleware). Nothing on this page is shop-scoped —
 * every number aggregates across every active shop on the cluster.
 *
 *   • Overview cards: shops (total/active/suspended/new), customers
 *     (total/new), orders (period/prev/Δ%), revenue (period/prev/Δ%),
 *     refunds, average order value.
 *   • Time-series: daily orders + revenue bars for the selected period,
 *     reading from `daily_metrics` (the PR1 rollup) so we never scan
 *     `orders` for the chart.
 *   • Shop leaderboard: top 10 shops by revenue with orders / customers
 *     / new customers / AOV.
 *   • Biggest movers: top 10 shops by |Δ revenue| vs the previous
 *     period of equal span, tagged up / down / flat.
 *   • Health signals: zero-revenue active shops (w/ days since last
 *     order), at-risk shops (revenue dropped ≥ 30% vs prev period),
 *     suspended count, new shops this period.
 *
 * All queries come from `@gbox/core/modules/analytics/platform.ts`.
 * This file is purely a Presenter — no DB access, no business logic.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import {
  getPlatformOverview,
  getShopLeaderboard,
  getShopGrowth,
  getPlatformTimeSeries,
  getPlatformHealth,
  periodToRange,
  type ShopLeaderboardRow,
  type ShopGrowthRow,
  type TimeSeriesPoint,
  type HealthSignal,
} from '@gbox/core/modules/analytics/platform.js'
import { godLayout, readThemeFromRequest } from '../layouts/god-layout.js'

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function esc(s: string | null | undefined): string {
  if (!s) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmtMoney(val: string | number | null | undefined, currency = 'USD'): string {
  const n = Number(val) || 0
  const symbol = currency === 'VND' ? '₫' : currency === 'EUR' ? '€' : '$'
  return symbol + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtNum(val: number | string | null | undefined): string {
  return Number(val || 0).toLocaleString('en-US')
}

function fmtPctSigned(pct: number): string {
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(1)}%`
}

function pctArrow(pct: number): { arrow: string; color: string } {
  if (pct > 0) return { arrow: '&#9650;', color: 'var(--green)' }
  if (pct < 0) return { arrow: '&#9660;', color: 'var(--red)' }
  return { arrow: '&#8212;', color: 'var(--god-text-muted)' }
}

function dayLabel(iso: string): string {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

function shortAgo(days: number | null): string {
  if (days === null) return 'Never'
  if (days === 0) return 'Today'
  if (days === 1) return '1 day ago'
  if (days < 30) return `${days} days ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

// ---------------------------------------------------------------------------
// Page handler
// ---------------------------------------------------------------------------

export async function getPlatformAnalytics(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const user = req.godAdmin!.user
  const isDefaultAdmin = req.godAdmin!.isDefaultAdmin ?? false
  const theme = readThemeFromRequest(req)

  const periodParam = String(req.query.period ?? '30d')
  const range = periodToRange(periodParam)
  const periodLabel = range.label

  try {
    const [overview, leaderboard, growth, series, health] = await Promise.all([
      getPlatformOverview(db as any, range),
      getShopLeaderboard(db as any, range, { limit: 10, orderBy: 'revenue' }),
      getShopGrowth(db as any, range, { limit: 10 }),
      getPlatformTimeSeries(db as any, range),
      getPlatformHealth(db as any, range, {
        zeroRevLimit: 10,
        atRiskLimit: 10,
        atRiskDropPct: -30,
      }),
    ])

    const currency = overview.currency || 'USD'

    // -----------------------------------------------------------------------
    // Period selector
    // -----------------------------------------------------------------------

    const periodTabs = (['7d', '30d', '90d'] as const)
      .map((p) => {
        const label = p === '7d' ? '7 days' : p === '30d' ? '30 days' : '90 days'
        const active = periodParam === p ? ' active' : ''
        return `<a href="/god-admin/analytics/platform?period=${p}" class="period-tab${active}">${label}</a>`
      })
      .join('')

    // -----------------------------------------------------------------------
    // Overview cards
    // -----------------------------------------------------------------------

    const ordersArrow = pctArrow(overview.orders.change_percent)
    const revArrow = pctArrow(overview.revenue.change_percent)
    const aovArrow = pctArrow(overview.average_order_value.change_percent)

    const overviewHtml = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Total Shops</div>
          <div class="stat-value">${fmtNum(overview.shops.total)}</div>
          <div style="margin-top:6px;font-size:12px;color:var(--god-text-muted)">
            <span class="badge badge-green">${fmtNum(overview.shops.active)} active</span>
            ${
              overview.shops.suspended > 0
                ? `<span class="badge badge-red" style="margin-left:4px">${fmtNum(overview.shops.suspended)} suspended</span>`
                : ''
            }
          </div>
          <div class="stat-change up" style="margin-top:6px">+${fmtNum(overview.shops.new_this_period)} new this period</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Customers</div>
          <div class="stat-value">${fmtNum(overview.customers.total)}</div>
          <div class="stat-change up" style="margin-top:6px">+${fmtNum(overview.customers.new_this_period)} new this period</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Orders (${esc(periodLabel)})</div>
          <div class="stat-value">${fmtNum(overview.orders.this_period)}</div>
          <div style="margin-top:6px;font-size:12px;color:${ordersArrow.color};font-weight:600">
            ${ordersArrow.arrow} ${fmtPctSigned(overview.orders.change_percent)} vs previous
          </div>
          <div style="margin-top:2px;font-size:11px;color:var(--god-text-muted)">
            all-time total: ${fmtNum(overview.orders.total)}
          </div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Revenue (${esc(periodLabel)})</div>
          <div class="stat-value">${fmtMoney(overview.revenue.this_period, currency)}</div>
          <div style="margin-top:6px;font-size:12px;color:${revArrow.color};font-weight:600">
            ${revArrow.arrow} ${fmtPctSigned(overview.revenue.change_percent)} vs previous
          </div>
          <div style="margin-top:2px;font-size:11px;color:var(--god-text-muted)">
            prev: ${fmtMoney(overview.revenue.previous_period, currency)}
          </div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Avg. Order Value</div>
          <div class="stat-value">${fmtMoney(overview.average_order_value.this_period, currency)}</div>
          <div style="margin-top:6px;font-size:12px;color:${aovArrow.color};font-weight:600">
            ${aovArrow.arrow} ${fmtPctSigned(overview.average_order_value.change_percent)} vs previous
          </div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Refunds (${esc(periodLabel)})</div>
          <div class="stat-value">${fmtMoney(overview.refunds.this_period, currency)}</div>
          <div style="margin-top:6px;font-size:11px;color:var(--god-text-muted)">
            net revenue: <strong style="color:var(--god-text)">${fmtMoney(
              Number(overview.revenue.this_period) - Number(overview.refunds.this_period),
              currency,
            )}</strong>
          </div>
        </div>
      </div>
    `

    // -----------------------------------------------------------------------
    // Time series chart (daily orders + revenue)
    // -----------------------------------------------------------------------

    const maxOrders = Math.max(...series.map((p) => p.orders_count), 1)
    const maxRevenue = Math.max(...series.map((p) => Number(p.revenue)), 1)

    const seriesRows =
      series.length > 0
        ? series
            .map((p: TimeSeriesPoint) => {
              const ordersPct = Math.round((p.orders_count / maxOrders) * 100)
              const revenuePct = Math.round((Number(p.revenue) / maxRevenue) * 100)
              return `
              <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">
                <span style="width:70px;font-size:11px;color:var(--god-text-muted);text-align:right;flex-shrink:0">${dayLabel(p.date)}</span>
                <div style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:8px">
                  <div style="display:flex;align-items:center;gap:6px">
                    <div style="flex:1;height:18px;background:var(--god-bg-hover);border-radius:3px;overflow:hidden">
                      <div style="width:${ordersPct}%;height:100%;background:var(--blue);border-radius:3px;min-width:2px"></div>
                    </div>
                    <span style="width:40px;font-size:11px;color:var(--god-text-secondary);text-align:right">${fmtNum(p.orders_count)}</span>
                  </div>
                  <div style="display:flex;align-items:center;gap:6px">
                    <div style="flex:1;height:18px;background:var(--god-bg-hover);border-radius:3px;overflow:hidden">
                      <div style="width:${revenuePct}%;height:100%;background:var(--green);border-radius:3px;min-width:2px"></div>
                    </div>
                    <span style="width:80px;font-size:11px;color:var(--god-text-secondary);text-align:right">${fmtMoney(p.revenue, currency)}</span>
                  </div>
                </div>
                <span style="width:70px;font-size:11px;color:var(--god-text-muted);text-align:right">${fmtNum(p.shops_active)} shops</span>
              </div>
            `
            })
            .join('')
        : `<p style="color:var(--god-text-muted);text-align:center;padding:24px">
             No rollup data yet for this period. Run
             <code class="mono">scripts/backfill-daily-metrics.ts</code>
             to fill the gap, or wait for the <strong>rollup_daily_metrics</strong>
             cron to catch up tonight.
           </p>`

    const timeSeriesHtml = `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Platform Time Series — ${esc(periodLabel)}</div>
          <div style="font-size:11px;color:var(--god-text-muted)">
            <span style="display:inline-block;width:10px;height:10px;background:var(--blue);border-radius:2px;vertical-align:middle;margin-right:4px"></span>orders
            <span style="display:inline-block;width:10px;height:10px;background:var(--green);border-radius:2px;vertical-align:middle;margin:0 4px 0 12px"></span>revenue
          </div>
        </div>
        ${seriesRows}
        <div style="margin-top:12px;font-size:11px;color:var(--god-text-muted);text-align:center">
          Source: <code class="mono">daily_metrics</code> rollup (written nightly by the <code class="mono">rollup_daily_metrics</code> cron).
        </div>
      </div>
    `

    // -----------------------------------------------------------------------
    // Shop leaderboard (top 10 by revenue)
    // -----------------------------------------------------------------------

    const leaderboardRows =
      leaderboard.length > 0
        ? leaderboard
            .map((r: ShopLeaderboardRow, i: number) => {
              const statusBadge =
                r.shop_status === 'active'
                  ? 'badge-green'
                  : r.shop_status === 'suspended'
                    ? 'badge-red'
                    : 'badge-gray'
              return `
              <tr>
                <td>${i + 1}</td>
                <td>
                  <a href="/god-admin/stores/${esc(r.shop_id)}">${esc(r.shop_name)}</a>
                  <div style="font-size:11px;color:var(--god-text-muted);margin-top:2px">${esc(r.shop_slug)}</div>
                </td>
                <td><span class="badge ${statusBadge}">${esc(r.shop_status)}</span></td>
                <td>${fmtNum(r.orders_count)}</td>
                <td><strong>${fmtMoney(r.revenue, r.currency)}</strong></td>
                <td>${fmtMoney(r.avg_order_value, r.currency)}</td>
                <td>${fmtNum(r.customers_count)}</td>
                <td>${r.new_customers > 0 ? `+${fmtNum(r.new_customers)}` : '0'}</td>
              </tr>
            `
            })
            .join('')
        : '<tr><td colspan="8" style="text-align:center;color:var(--god-text-muted);padding:24px">No shops with activity in this period.</td></tr>'

    const leaderboardHtml = `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Top 10 Shops by Revenue</div>
          <div style="font-size:11px;color:var(--god-text-muted)">${esc(periodLabel)}</div>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Shop</th>
              <th>Status</th>
              <th>Orders</th>
              <th>Revenue</th>
              <th>AOV</th>
              <th>Customers</th>
              <th>New</th>
            </tr>
          </thead>
          <tbody>${leaderboardRows}</tbody>
        </table>
      </div>
    `

    // -----------------------------------------------------------------------
    // Biggest movers (growth / decline)
    // -----------------------------------------------------------------------

    const growthRows =
      growth.length > 0
        ? growth
            .map((r: ShopGrowthRow) => {
              const arrow = pctArrow(r.change_percent)
              const dirBadge =
                r.direction === 'up'
                  ? 'badge-green'
                  : r.direction === 'down'
                    ? 'badge-red'
                    : 'badge-gray'
              return `
              <tr>
                <td>
                  <a href="/god-admin/stores/${esc(r.shop_id)}">${esc(r.shop_name)}</a>
                  <div style="font-size:11px;color:var(--god-text-muted);margin-top:2px">${esc(r.shop_slug)}</div>
                </td>
                <td>${fmtMoney(r.current_revenue, currency)}</td>
                <td>${fmtMoney(r.previous_revenue, currency)}</td>
                <td style="color:${arrow.color};font-weight:600">${arrow.arrow} ${fmtPctSigned(r.change_percent)}</td>
                <td><span class="badge ${dirBadge}">${r.direction}</span></td>
              </tr>
            `
            })
            .join('')
        : '<tr><td colspan="5" style="text-align:center;color:var(--god-text-muted);padding:24px">No shops with period-over-period movement to show.</td></tr>'

    const growthHtml = `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Biggest Movers (Revenue Δ vs Previous Period)</div>
          <div style="font-size:11px;color:var(--god-text-muted)">flat window ±5%</div>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Shop</th>
              <th>Current</th>
              <th>Previous</th>
              <th>Change</th>
              <th>Direction</th>
            </tr>
          </thead>
          <tbody>${growthRows}</tbody>
        </table>
      </div>
    `

    // -----------------------------------------------------------------------
    // Health signals
    // -----------------------------------------------------------------------

    const zeroRevRows =
      health.zero_revenue_shops.length > 0
        ? health.zero_revenue_shops
            .map((h: HealthSignal) => `
              <tr>
                <td>
                  <a href="/god-admin/stores/${esc(h.shop_id)}">${esc(h.shop_name)}</a>
                  <div style="font-size:11px;color:var(--god-text-muted);margin-top:2px">${esc(h.shop_slug)}</div>
                </td>
                <td>${shortAgo(h.days_since_last_order)}</td>
                <td><span class="badge badge-gray">${esc(h.shop_status)}</span></td>
              </tr>
            `).join('')
        : '<tr><td colspan="3" style="text-align:center;color:var(--god-text-muted);padding:16px">Every active shop made revenue this period.</td></tr>'

    const atRiskRows =
      health.at_risk_shops.length > 0
        ? health.at_risk_shops
            .map((r: ShopGrowthRow) => `
              <tr>
                <td>
                  <a href="/god-admin/stores/${esc(r.shop_id)}">${esc(r.shop_name)}</a>
                  <div style="font-size:11px;color:var(--god-text-muted);margin-top:2px">${esc(r.shop_slug)}</div>
                </td>
                <td>${fmtMoney(r.previous_revenue, currency)}</td>
                <td>${fmtMoney(r.current_revenue, currency)}</td>
                <td style="color:var(--red);font-weight:600">${fmtPctSigned(r.change_percent)}</td>
              </tr>
            `).join('')
        : '<tr><td colspan="4" style="text-align:center;color:var(--god-text-muted);padding:16px">No shops dropped ≥ 30% vs previous period.</td></tr>'

    const healthHtml = `
      <div class="two-col">
        <div class="card">
          <div class="card-header">
            <div class="card-title">Zero-Revenue Active Shops</div>
            <div style="font-size:11px;color:var(--god-text-muted)">need attention</div>
          </div>
          <table class="data-table">
            <thead><tr><th>Shop</th><th>Last Order</th><th>Status</th></tr></thead>
            <tbody>${zeroRevRows}</tbody>
          </table>
        </div>

        <div class="card">
          <div class="card-header">
            <div class="card-title">At-Risk Shops (≥ 30% drop)</div>
            <div style="font-size:11px;color:var(--god-text-muted)">revenue erosion</div>
          </div>
          <table class="data-table">
            <thead><tr><th>Shop</th><th>Previous</th><th>Current</th><th>Δ</th></tr></thead>
            <tbody>${atRiskRows}</tbody>
          </table>
        </div>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Suspended Shops</div>
          <div class="stat-value" style="color:${health.suspended_shops > 0 ? 'var(--red)' : 'var(--god-text)'}">${fmtNum(health.suspended_shops)}</div>
          <div style="margin-top:6px;font-size:11px;color:var(--god-text-muted)">
            cumulative platform total
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-label">New Shops This Period</div>
          <div class="stat-value" style="color:var(--green)">${fmtNum(health.new_shops_this_period)}</div>
          <div style="margin-top:6px;font-size:11px;color:var(--god-text-muted)">
            ${esc(periodLabel)}
          </div>
        </div>
      </div>
    `

    // -----------------------------------------------------------------------
    // Page assembly
    // -----------------------------------------------------------------------

    const content = `
      <style>
        .period-tabs { display:flex; gap:2px; background:var(--god-bg-elevated); border-radius:8px; border:1px solid var(--god-border); padding:2px; }
        .period-tab { padding:6px 14px; font-size:12px; border-radius:6px; text-decoration:none; color:var(--god-text-muted); transition:all .15s; cursor:pointer; }
        .period-tab:hover { color:var(--god-text); }
        .period-tab.active { background:var(--god-accent); color:#fff; }
      </style>

      <div class="page-header">
        <div>
          <h1>Platform Analytics</h1>
          <p style="color:var(--god-text-muted);margin:4px 0 0;font-size:13px">
            ${esc(periodLabel)} &mdash; entire platform, every shop
          </p>
        </div>
        <div class="period-tabs">${periodTabs}</div>
      </div>

      ${overviewHtml}
      ${timeSeriesHtml}
      ${leaderboardHtml}
      ${growthHtml}
      ${healthHtml}
    `

    res.send(
      godLayout({
        title: 'Platform Analytics',
        userEmail: user.email,
        userName: user.name,
        isDefaultAdmin,
        activePath: '/god-admin/analytics/platform',
        content,
        theme,
      }),
    )
  } catch (err) {
    console.error('[God Admin] Platform Analytics error:', err)
    res.status(500).send(
      godLayout({
        title: 'Platform Analytics',
        userEmail: user.email,
        userName: user.name,
        isDefaultAdmin,
        activePath: '/god-admin/analytics/platform',
        content: `<div class="card"><p style="color:var(--red)">Error: ${esc(String(err))}</p></div>`,
        theme,
      }),
    )
  }
}
