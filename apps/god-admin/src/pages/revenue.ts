/**
 * God Admin — Revenue Breakdown (Phase 6 / Option B)
 *
 * GET /god-admin/finance/revenue
 *
 * The "Total Revenue" drill-down target from the dashboard overview.
 * Answers the operator questions:
 *
 *   - Where did the money come from? (by store, by country, by currency)
 *   - Is the trend healthy? (daily time series + period-over-period delta)
 *   - Where is the risk? (refund ratio, concentration, zero-days)
 *   - What does the AI think? (embedded advisor panel, context='revenue')
 *
 * The page is pure read — it does not mutate order data. All charts
 * are hand-rolled SVG/CSS bars so we don't pull in a chart library
 * for a single page; the god-admin surface is server-rendered HTML
 * with small JS islands.
 *
 * Period picker:
 *   ?period=7d | 30d (default) | 90d | ytd
 *   ?shop_id=<uuid> to scope the whole board to one store
 *
 * The AI snapshot is built from the same aggregates the page
 * renders — so "what the operator sees" and "what the AI sees"
 * are always in sync by construction.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'
import {
  analyzeContext,
  isAiConfigured,
  type AdvisorContext,
} from '@gbox/core/modules/ai/index.js'
import { renderAiPanel, renderAiPanelUnconfigured } from '../lib/ai-panel.js'
import { aiPanelCsrf } from './ai-chat.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string | null | undefined): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fmtMoney(val: string | number | null | undefined, currency = 'USD'): string {
  const n = Number(val) || 0
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: 2,
    }).format(n)
  } catch {
    return '$' + n.toFixed(2)
  }
}

function fmtNum(val: number | string | null | undefined): string {
  return Number(val ?? 0).toLocaleString('en-US')
}

function fmtPct(val: number, digits = 1): string {
  if (!isFinite(val)) return '—'
  const sign = val > 0 ? '+' : ''
  return `${sign}${val.toFixed(digits)}%`
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

// ---------------------------------------------------------------------------
// Period resolver
// ---------------------------------------------------------------------------

type PeriodKey = '7d' | '30d' | '90d' | 'ytd'

interface PeriodRange {
  key: PeriodKey
  label: string
  /** ISO timestamp — inclusive lower bound. */
  from: string
  /** ISO timestamp — exclusive upper bound (now). */
  to: string
  /** Previous comparable window. */
  prevFrom: string
  prevTo: string
  /** Number of days in the window (for granularity / chart scale). */
  days: number
}

function resolvePeriod(key: string | undefined): PeriodRange {
  const now = new Date()
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  let days: number
  let label: string
  let resolvedKey: PeriodKey

  switch (key) {
    case '7d':
      days = 7
      label = 'Last 7 days'
      resolvedKey = '7d'
      break
    case '90d':
      days = 90
      label = 'Last 90 days'
      resolvedKey = '90d'
      break
    case 'ytd': {
      const yearStart = new Date(now.getFullYear(), 0, 1)
      const daysSinceStart = Math.max(
        1,
        Math.ceil((to.getTime() - yearStart.getTime()) / 86_400_000),
      )
      const prevYearStart = new Date(now.getFullYear() - 1, 0, 1)
      const prevYearEnd = new Date(
        prevYearStart.getTime() + daysSinceStart * 86_400_000,
      )
      return {
        key: 'ytd',
        label: 'Year to date',
        from: yearStart.toISOString(),
        to: to.toISOString(),
        prevFrom: prevYearStart.toISOString(),
        prevTo: prevYearEnd.toISOString(),
        days: daysSinceStart,
      }
    }
    case '30d':
    default:
      days = 30
      label = 'Last 30 days'
      resolvedKey = '30d'
      break
  }

  const from = new Date(to.getTime() - days * 86_400_000)
  const prevTo = from
  const prevFrom = new Date(from.getTime() - days * 86_400_000)

  return {
    key: resolvedKey,
    label,
    from: from.toISOString(),
    to: to.toISOString(),
    prevFrom: prevFrom.toISOString(),
    prevTo: prevTo.toISOString(),
    days,
  }
}

// ---------------------------------------------------------------------------
// Country extraction from shipping_address JSONB
// ---------------------------------------------------------------------------

interface ShippingAddressBlob {
  country?: string
  country_code?: string
}

function extractCountry(blob: unknown): string {
  if (!blob || typeof blob !== 'object') return 'Unknown'
  const a = blob as ShippingAddressBlob
  return a.country_code || a.country || 'Unknown'
}

// ---------------------------------------------------------------------------
// GET /god-admin/finance/revenue
// ---------------------------------------------------------------------------

export async function getRevenue(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const user = req.godAdmin!.user
  const period = resolvePeriod(req.query.period as string | undefined)
  const shopFilter = ((req.query.shop_id as string) || '').trim()

  try {
    // ----- Base where predicates ------------------------------------------
    // We always filter to `financial_status='paid'` for the "revenue"
    // definition — pending and refunded orders are broken out
    // separately below so the operator can see churn vs raw GMV.

    const inPeriod = <T extends { where: Function }>(q: T, alias = 'o'): T =>
      q
        .where(`${alias}.created_at`, '>=', period.from)
        .where(`${alias}.created_at`, '<', period.to) as T

    const inPrevPeriod = <T extends { where: Function }>(q: T, alias = 'o'): T =>
      q
        .where(`${alias}.created_at`, '>=', period.prevFrom)
        .where(`${alias}.created_at`, '<', period.prevTo) as T

    const applyShopFilter = <T extends { where: Function }>(q: T, alias = 'o'): T => {
      return shopFilter ? (q.where(`${alias}.shop_id`, '=', shopFilter) as T) : q
    }

    // ----- Parallel aggregate queries -------------------------------------
    const [
      allShops,
      currentTotals,
      previousTotals,
      refundTotals,
      byDay,
      byStore,
      byCurrency,
      byGateway,
      rawOrdersForCountry,
    ] = await Promise.all([
      db.selectFrom('shops').select(['id', 'name', 'slug']).orderBy('name', 'asc').execute(),

      // Current period — paid orders only
      applyShopFilter(
        inPeriod(
          db.selectFrom('orders as o').where('o.financial_status', '=', 'paid'),
        ),
      )
        .select([
          sql<string>`coalesce(sum(o.total_price::numeric), 0)`.as('gross'),
          sql<string>`coalesce(sum(o.subtotal_price::numeric), 0)`.as('subtotal'),
          sql<string>`coalesce(sum(o.total_tax::numeric), 0)`.as('tax'),
          sql<string>`coalesce(sum(o.total_shipping::numeric), 0)`.as('shipping'),
          sql<string>`coalesce(sum(o.total_discounts::numeric), 0)`.as('discounts'),
          sql<string>`count(o.id)`.as('orders'),
          sql<string>`count(distinct o.customer_id)`.as('customers'),
        ])
        .executeTakeFirst(),

      // Previous period — for comparison delta
      applyShopFilter(
        inPrevPeriod(
          db.selectFrom('orders as o').where('o.financial_status', '=', 'paid'),
        ),
      )
        .select([
          sql<string>`coalesce(sum(o.total_price::numeric), 0)`.as('gross'),
          sql<string>`count(o.id)`.as('orders'),
        ])
        .executeTakeFirst(),

      // Refunds / partial refunds in the current period
      applyShopFilter(
        inPeriod(
          db
            .selectFrom('orders as o')
            .where('o.financial_status', 'in', ['refunded', 'partially_refunded']),
        ),
      )
        .select([
          sql<string>`coalesce(sum(o.total_price::numeric), 0)`.as('refunded'),
          sql<string>`count(o.id)`.as('count'),
        ])
        .executeTakeFirst(),

      // Daily time series
      applyShopFilter(
        inPeriod(
          db.selectFrom('orders as o').where('o.financial_status', '=', 'paid'),
        ),
      )
        .select([
          sql<string>`date_trunc('day', o.created_at)::date::text`.as('day'),
          sql<string>`coalesce(sum(o.total_price::numeric), 0)`.as('revenue'),
          sql<string>`count(o.id)`.as('orders'),
        ])
        .groupBy(sql`date_trunc('day', o.created_at)`)
        .orderBy(sql`date_trunc('day', o.created_at)`, 'asc')
        .execute(),

      // Breakdown by store
      applyShopFilter(
        inPeriod(
          db
            .selectFrom('orders as o')
            .innerJoin('shops as s', 's.id', 'o.shop_id')
            .where('o.financial_status', '=', 'paid'),
        ),
      )
        .select([
          's.id as shop_id',
          's.name as shop_name',
          's.slug as shop_slug',
          sql<string>`coalesce(sum(o.total_price::numeric), 0)`.as('revenue'),
          sql<string>`count(o.id)`.as('orders'),
          sql<string>`coalesce(avg(o.total_price::numeric), 0)`.as('aov'),
        ])
        .groupBy(['s.id', 's.name', 's.slug'])
        .orderBy(sql`sum(o.total_price::numeric)`, 'desc')
        .limit(20)
        .execute(),

      // Breakdown by currency (multi-currency merchants)
      applyShopFilter(
        inPeriod(
          db.selectFrom('orders as o').where('o.financial_status', '=', 'paid'),
        ),
      )
        .select([
          'o.currency',
          sql<string>`coalesce(sum(o.total_price::numeric), 0)`.as('revenue'),
          sql<string>`count(o.id)`.as('orders'),
        ])
        .groupBy('o.currency')
        .orderBy(sql`sum(o.total_price::numeric)`, 'desc')
        .execute(),

      // Payment gateway breakdown via transactions
      inPeriod(
        db
          .selectFrom('transactions as t')
          .innerJoin('orders as o', 'o.id', 't.order_id')
          .where('t.kind', 'in', ['sale', 'capture'])
          .where('t.status', '=', 'success')
          .$if(shopFilter.length > 0, (q) => q.where('o.shop_id', '=', shopFilter)),
        't',
      )
        .select([
          't.gateway',
          sql<string>`coalesce(sum(t.amount::numeric), 0)`.as('revenue'),
          sql<string>`count(t.id)`.as('txns'),
        ])
        .groupBy('t.gateway')
        .orderBy(sql`sum(t.amount::numeric)`, 'desc')
        .execute(),

      // Raw order rows needed to extract country from shipping_address
      // JSONB. We fetch the column, aggregate in JS, because the
      // address shape varies and SQL path extraction gets brittle.
      applyShopFilter(
        inPeriod(
          db.selectFrom('orders as o').where('o.financial_status', '=', 'paid'),
        ),
      )
        .select(['o.shipping_address', 'o.total_price', 'o.id'])
        .limit(5000) // hard cap for the country agg loop
        .execute(),
    ])

    // ----- JS-side country aggregation ------------------------------------
    const countryMap = new Map<string, { revenue: number; orders: number }>()
    for (const row of rawOrdersForCountry) {
      const country = extractCountry(row.shipping_address)
      const hit = countryMap.get(country) ?? { revenue: 0, orders: 0 }
      hit.revenue += Number(row.total_price) || 0
      hit.orders += 1
      countryMap.set(country, hit)
    }
    const byCountry = Array.from(countryMap.entries())
      .map(([country, v]) => ({ country, revenue: v.revenue, orders: v.orders }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 15)

    // ----- Derived metrics ------------------------------------------------
    const gross = Number(currentTotals?.gross ?? 0)
    const refunded = Number(refundTotals?.refunded ?? 0)
    const net = gross - refunded
    const orders = Number(currentTotals?.orders ?? 0)
    const customers = Number(currentTotals?.customers ?? 0)
    const aov = orders > 0 ? gross / orders : 0
    const prevGross = Number(previousTotals?.gross ?? 0)
    const prevOrders = Number(previousTotals?.orders ?? 0)
    const deltaGross = prevGross > 0 ? ((gross - prevGross) / prevGross) * 100 : 0
    const deltaOrders = prevOrders > 0 ? ((orders - prevOrders) / prevOrders) * 100 : 0
    const refundRatePct = gross > 0 ? (refunded / gross) * 100 : 0

    // Top store concentration — share of revenue held by #1 store
    const topStoreShare = byStore.length > 0 && gross > 0
      ? (Number(byStore[0].revenue) / gross) * 100
      : 0

    // Fill zero-days in the time series so the chart has a full window
    const dailyMap = new Map(byDay.map((d) => [d.day, d]))
    const daySeries: Array<{ day: string; revenue: number; orders: number }> = []
    const startDay = new Date(period.from)
    for (let i = 0; i < period.days; i++) {
      const d = new Date(startDay.getTime() + i * 86_400_000)
      const key = d.toISOString().slice(0, 10)
      const hit = dailyMap.get(key)
      daySeries.push({
        day: key,
        revenue: hit ? Number(hit.revenue) : 0,
        orders: hit ? Number(hit.orders) : 0,
      })
    }

    // ----- Build AI snapshot ---------------------------------------------
    const selectedShop = shopFilter ? allShops.find((s) => s.id === shopFilter) : null
    const boardTitle = selectedShop
      ? `Revenue — ${selectedShop.name} — ${period.label}`
      : `Revenue — All stores — ${period.label}`

    const snapshot: Record<string, unknown> = {
      period: { from: period.from, to: period.to, label: period.label, days: period.days },
      scope: selectedShop ? { shop_id: selectedShop.id, name: selectedShop.name } : { all_stores: true },
      totals: {
        gross,
        net,
        refunds: refunded,
        tax: Number(currentTotals?.tax ?? 0),
        shipping: Number(currentTotals?.shipping ?? 0),
        discounts: Number(currentTotals?.discounts ?? 0),
        orders,
        customers,
        aov,
        currency: byCurrency[0]?.currency ?? 'USD',
      },
      comparison: {
        previous_period_gross: prevGross,
        previous_period_orders: prevOrders,
        delta_pct_gross: deltaGross,
        delta_pct_orders: deltaOrders,
      },
      refund_rate_pct: refundRatePct,
      top_store_concentration_pct: topStoreShare,
      by_store: byStore.slice(0, 10).map((s) => ({
        shop_id: s.shop_id,
        name: s.shop_name,
        revenue: Number(s.revenue),
        orders: Number(s.orders),
        share_pct: gross > 0 ? (Number(s.revenue) / gross) * 100 : 0,
      })),
      by_day: daySeries.slice(-30),
      by_country: byCountry.slice(0, 10),
      by_currency: byCurrency.map((c) => ({
        currency: c.currency,
        revenue: Number(c.revenue),
        orders: Number(c.orders),
      })),
      by_gateway: byGateway.map((g) => ({
        gateway: g.gateway,
        revenue: Number(g.revenue),
        txns: Number(g.txns),
      })),
    }

    const advisorContext: AdvisorContext = {
      type: 'revenue',
      title: boardTitle,
      snapshot,
    }

    // ----- AI brief (in parallel with view rendering) ---------------------
    const aiReady = isAiConfigured()
    const briefPromise = aiReady
      ? analyzeContext(advisorContext).catch((err) => {
          console.error('[God Admin] Revenue AI brief error:', err)
          return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }
        })
      : Promise.resolve({ text: '', usage: { inputTokens: 0, outputTokens: 0 } })

    // ----- View builders --------------------------------------------------
    const periodOptions: Array<{ key: PeriodKey; label: string }> = [
      { key: '7d', label: '7 days' },
      { key: '30d', label: '30 days' },
      { key: '90d', label: '90 days' },
      { key: 'ytd', label: 'Year to date' },
    ]
    const periodTabs = periodOptions
      .map((opt) => {
        const active = opt.key === period.key
        const href = `/god-admin/finance/revenue?period=${opt.key}${shopFilter ? `&shop_id=${encodeURIComponent(shopFilter)}` : ''}`
        return `<a href="${esc(href)}" class="period-tab${active ? ' period-tab--active' : ''}">${opt.label}</a>`
      })
      .join('')

    const storeFilterOptions = allShops
      .map(
        (s) =>
          `<option value="${esc(s.id)}"${shopFilter === s.id ? ' selected' : ''}>${esc(s.name)}</option>`,
      )
      .join('')

    // KPI cards
    const deltaBadge = (delta: number): string => {
      if (!isFinite(delta) || delta === 0) return `<span class="delta delta--flat">${fmtPct(delta)}</span>`
      const cls = delta > 0 ? 'delta--up' : 'delta--down'
      const arrow = delta > 0 ? '&#9650;' : '&#9660;'
      return `<span class="delta ${cls}">${arrow} ${fmtPct(delta)}</span>`
    }

    const kpisHtml = `
      <div class="revenue-kpis">
        <div class="kpi-card kpi-card--hero">
          <div class="kpi-label">Gross Revenue</div>
          <div class="kpi-value">${fmtMoney(gross)}</div>
          <div class="kpi-meta">${deltaBadge(deltaGross)} vs previous ${period.label.toLowerCase()}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Net Revenue</div>
          <div class="kpi-value">${fmtMoney(net)}</div>
          <div class="kpi-meta">after ${fmtMoney(refunded)} refunds</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Orders</div>
          <div class="kpi-value">${fmtNum(orders)}</div>
          <div class="kpi-meta">${deltaBadge(deltaOrders)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Avg. Order Value</div>
          <div class="kpi-value">${fmtMoney(aov)}</div>
          <div class="kpi-meta">${fmtNum(customers)} unique customers</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Refund Rate</div>
          <div class="kpi-value">${refundRatePct.toFixed(1)}%</div>
          <div class="kpi-meta">${fmtNum(refundTotals?.count ?? 0)} refunded orders</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Top Store Share</div>
          <div class="kpi-value">${topStoreShare.toFixed(1)}%</div>
          <div class="kpi-meta">${byStore.length > 0 ? esc(byStore[0].shop_name) : '—'}</div>
        </div>
      </div>`

    // Daily revenue SVG line chart
    const chartHtml = renderDailyChart(daySeries)

    // By-store bar chart + table
    const storeMax = byStore.reduce((m, s) => Math.max(m, Number(s.revenue)), 0)
    const byStoreHtml =
      byStore.length > 0
        ? byStore
            .map((s) => {
              const pct = storeMax > 0 ? (Number(s.revenue) / storeMax) * 100 : 0
              const sharePct = gross > 0 ? (Number(s.revenue) / gross) * 100 : 0
              return `
            <tr>
              <td><a href="/god-admin/stores/${esc(s.shop_id)}">${esc(s.shop_name)}</a></td>
              <td>
                <div class="bar-wrap">
                  <div class="bar" style="width:${pct.toFixed(1)}%"></div>
                  <span class="bar-label">${fmtMoney(s.revenue)}</span>
                </div>
              </td>
              <td>${sharePct.toFixed(1)}%</td>
              <td><a href="/god-admin/orders?store=${esc(s.shop_id)}">${fmtNum(s.orders)}</a></td>
              <td>${fmtMoney(s.aov)}</td>
            </tr>`
            })
            .join('')
        : '<tr><td colspan="5" class="empty-cell">No revenue in this period</td></tr>'

    const byCountryHtml =
      byCountry.length > 0
        ? byCountry
            .map((c) => {
              const share = gross > 0 ? (c.revenue / gross) * 100 : 0
              return `<tr><td>${esc(c.country)}</td><td>${fmtMoney(c.revenue)}</td><td>${share.toFixed(1)}%</td><td>${fmtNum(c.orders)}</td></tr>`
            })
            .join('')
        : '<tr><td colspan="4" class="empty-cell">No country data in this period</td></tr>'

    const byCurrencyHtml =
      byCurrency.length > 0
        ? byCurrency
            .map(
              (c) =>
                `<tr><td class="mono">${esc(c.currency)}</td><td>${fmtMoney(c.revenue, c.currency)}</td><td>${fmtNum(c.orders)}</td></tr>`,
            )
            .join('')
        : '<tr><td colspan="3" class="empty-cell">No data</td></tr>'

    const byGatewayHtml =
      byGateway.length > 0
        ? byGateway
            .map(
              (g) =>
                `<tr><td>${esc(g.gateway)}</td><td>${fmtMoney(g.revenue)}</td><td>${fmtNum(g.txns)}</td></tr>`,
            )
            .join('')
        : '<tr><td colspan="3" class="empty-cell">No transactions in this period</td></tr>'

    // ----- AI panel -------------------------------------------------------
    const aiBrief = await briefPromise
    let aiPanelHtml: string
    if (!aiReady) {
      aiPanelHtml = renderAiPanelUnconfigured()
    } else {
      const csrfToken = await aiPanelCsrf.issue(res, isProduction())
      aiPanelHtml = renderAiPanel({
        context: advisorContext,
        initialInsight: aiBrief.text,
        csrfToken,
      })
    }

    // ----- Final HTML -----------------------------------------------------
    const content = `
      ${REVENUE_CSS}
      <div class="page-header">
        <h1>Revenue Breakdown ${selectedShop ? `— ${esc(selectedShop.name)}` : ''}</h1>
        <div class="action-group">
          <form method="get" action="/god-admin/finance/revenue" class="revenue-filter-form">
            <input type="hidden" name="period" value="${esc(period.key)}">
            <select name="shop_id" onchange="this.form.submit()" class="filter-select">
              <option value="">All stores</option>
              ${storeFilterOptions}
            </select>
          </form>
          <a href="/god-admin/finance" class="btn btn-secondary btn-sm">Back to Finance</a>
        </div>
      </div>

      <div class="period-tabs">${periodTabs}</div>

      <div class="revenue-grid">
        <div class="revenue-main">
          ${kpisHtml}

          <div class="card">
            <div class="card-title" style="margin-bottom:12px">Daily Revenue · ${esc(period.label)}</div>
            ${chartHtml}
          </div>

          <div class="card">
            <div class="card-title" style="margin-bottom:12px">Revenue by Store</div>
            <table class="data-table revenue-table">
              <thead>
                <tr><th>Store</th><th>Revenue</th><th>Share</th><th>Orders</th><th>AOV</th></tr>
              </thead>
              <tbody>${byStoreHtml}</tbody>
            </table>
          </div>

          <div class="two-col-tables">
            <div class="card">
              <div class="card-title" style="margin-bottom:12px">By Country</div>
              <table class="data-table">
                <thead><tr><th>Country</th><th>Revenue</th><th>Share</th><th>Orders</th></tr></thead>
                <tbody>${byCountryHtml}</tbody>
              </table>
            </div>
            <div class="card">
              <div class="card-title" style="margin-bottom:12px">By Currency</div>
              <table class="data-table">
                <thead><tr><th>Currency</th><th>Revenue</th><th>Orders</th></tr></thead>
                <tbody>${byCurrencyHtml}</tbody>
              </table>
            </div>
          </div>

          <div class="card">
            <div class="card-title" style="margin-bottom:12px">By Payment Gateway</div>
            <table class="data-table">
              <thead><tr><th>Gateway</th><th>Revenue</th><th>Successful transactions</th></tr></thead>
              <tbody>${byGatewayHtml}</tbody>
            </table>
          </div>
        </div>

        <aside class="revenue-side">
          ${aiPanelHtml}
        </aside>
      </div>
    `

    res.send(
      godLayout({
        title: 'Revenue Breakdown',
        userEmail: user.email,
        activePath: '/god-admin/finance',
        content,
      }),
    )
  } catch (err) {
    console.error('[God Admin] Revenue error:', err)
    res.status(500).send(
      godLayout({
        title: 'Revenue',
        userEmail: user.email,
        activePath: '/god-admin/finance',
        content: `<div class="card"><p style="color:var(--red)">Error loading revenue breakdown: ${esc(String(err))}</p><a href="/god-admin/finance" class="btn btn-secondary btn-sm" style="margin-top:12px">Back to Finance</a></div>`,
      }),
    )
  }
}

// ---------------------------------------------------------------------------
// SVG daily line chart
// ---------------------------------------------------------------------------

function renderDailyChart(series: Array<{ day: string; revenue: number; orders: number }>): string {
  if (series.length === 0) {
    return '<p class="empty-cell" style="padding:24px 0">No data in this period</p>'
  }
  const width = 900
  const height = 220
  const padL = 60
  const padR = 20
  const padT = 16
  const padB = 40
  const innerW = width - padL - padR
  const innerH = height - padT - padB

  const max = Math.max(1, ...series.map((d) => d.revenue))
  const stepX = series.length > 1 ? innerW / (series.length - 1) : 0

  const points = series
    .map((d, i) => {
      const x = padL + i * stepX
      const y = padT + innerH - (d.revenue / max) * innerH
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  // Area polygon (close the loop at the bottom)
  const area = series.length > 1
    ? `${padL},${padT + innerH} ${points} ${padL + (series.length - 1) * stepX},${padT + innerH}`
    : ''

  // Y-axis grid lines (4 steps)
  const gridLines: string[] = []
  const yLabels: string[] = []
  for (let i = 0; i <= 4; i++) {
    const y = padT + (innerH * i) / 4
    const val = max * (1 - i / 4)
    gridLines.push(
      `<line x1="${padL}" x2="${width - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--border, #e2e8f0)" stroke-dasharray="2 4" />`,
    )
    yLabels.push(
      `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--text-secondary, #64748b)">${fmtMoney(val).replace('.00', '')}</text>`,
    )
  }

  // X-axis labels (max 8)
  const labelStep = Math.max(1, Math.ceil(series.length / 8))
  const xLabels: string[] = []
  series.forEach((d, i) => {
    if (i % labelStep !== 0 && i !== series.length - 1) return
    const x = padL + i * stepX
    xLabels.push(
      `<text x="${x.toFixed(1)}" y="${height - padB + 18}" text-anchor="middle" font-size="10" fill="var(--text-secondary, #64748b)">${esc(shortDate(d.day))}</text>`,
    )
  })

  // Hover dots
  const dots = series
    .map((d, i) => {
      const x = padL + i * stepX
      const y = padT + innerH - (d.revenue / max) * innerH
      const tooltip = `${shortDate(d.day)}: ${fmtMoney(d.revenue)} (${d.orders} orders)`
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="var(--primary, #3b82f6)"><title>${esc(tooltip)}</title></circle>`
    })
    .join('')

  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMidYMid meet" class="revenue-chart" role="img" aria-label="Daily revenue chart">
      ${gridLines.join('')}
      ${area ? `<polygon points="${area}" fill="rgba(59, 130, 246, 0.12)" />` : ''}
      <polyline points="${points}" fill="none" stroke="var(--primary, #3b82f6)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      ${dots}
      ${yLabels.join('')}
      ${xLabels.join('')}
    </svg>`
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const REVENUE_CSS = `<style>
  .revenue-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 340px;
    gap: 20px;
    align-items: start;
  }
  .revenue-main { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
  .revenue-side { display: flex; flex-direction: column; gap: 20px; position: sticky; top: 76px; }
  @media (max-width: 1200px) {
    .revenue-grid { grid-template-columns: 1fr; }
    .revenue-side { position: static; }
  }

  .period-tabs {
    display: inline-flex;
    gap: 4px;
    padding: 4px;
    background: var(--surface-hover, #f1f5f9);
    border: 1px solid var(--border, #e2e8f0);
    border-radius: 10px;
    margin-bottom: 16px;
  }
  .period-tab {
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-secondary, #64748b);
    text-decoration: none;
    transition: all 0.15s;
  }
  .period-tab:hover { color: var(--text-primary, #0f172a); }
  .period-tab--active {
    background: var(--surface, #ffffff);
    color: var(--text-primary, #0f172a);
    box-shadow: 0 1px 2px rgba(0,0,0,0.08);
  }

  .revenue-kpis {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 14px;
  }
  .kpi-card {
    background: var(--surface, #ffffff);
    border: 1px solid var(--border, #e2e8f0);
    border-radius: 12px;
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .kpi-card--hero {
    border-color: var(--primary, #3b82f6);
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.08);
  }
  .kpi-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-secondary, #64748b);
  }
  .kpi-value {
    font-size: 22px;
    font-weight: 700;
    color: var(--text-primary, #0f172a);
    line-height: 1.1;
  }
  .kpi-card--hero .kpi-value { font-size: 26px; color: var(--primary, #3b82f6); }
  .kpi-meta {
    font-size: 11px;
    color: var(--text-secondary, #64748b);
  }

  .delta {
    display: inline-block;
    font-weight: 600;
    margin-right: 4px;
  }
  .delta--up { color: #059669; }
  .delta--down { color: #dc2626; }
  .delta--flat { color: var(--text-secondary, #64748b); }

  .revenue-chart { display: block; max-width: 100%; }

  .revenue-table .bar-wrap {
    position: relative;
    height: 20px;
    background: var(--surface-hover, #f1f5f9);
    border-radius: 4px;
    overflow: hidden;
    min-width: 140px;
  }
  .revenue-table .bar {
    height: 100%;
    background: var(--primary, #3b82f6);
    border-radius: 4px;
    transition: width 0.25s ease;
  }
  .revenue-table .bar-label {
    position: absolute;
    left: 8px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 11px;
    font-weight: 600;
    color: var(--text-primary, #0f172a);
    mix-blend-mode: difference;
    color: #ffffff;
  }

  .two-col-tables {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }
  @media (max-width: 900px) {
    .two-col-tables { grid-template-columns: 1fr; }
  }

  .empty-cell {
    text-align: center;
    padding: 20px !important;
    color: var(--text-secondary, #64748b);
  }

  .revenue-filter-form {
    display: inline-block;
  }
  .revenue-filter-form .filter-select {
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid var(--border, #e2e8f0);
    background: var(--surface, #ffffff);
    color: var(--text-primary, #0f172a);
    font-size: 13px;
  }
</style>`
