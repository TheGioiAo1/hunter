/**
 * Store Admin — Analytics Measurement Reports (M4 — Dashboards v2)
 *
 * Four new report pages backed by the `page_views` + `orders` +
 * `events` tables via `@gbox/core/modules/analytics/measurement-queries`.
 *
 *   - /analytics/traffic      getTrafficSourcesReport
 *   - /analytics/funnel       getConversionFunnelReport
 *   - /analytics/attribution  getAttributionReport
 *   - /analytics/cohort       getCohortReport
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { listAccessibleStores } from '../lib/user-stores.js'
import {
  getTrafficSources,
  getConversionFunnel,
  getUtmAttribution,
  getCohortRetention,
  type TrafficSourceRow,
  type FunnelRow,
  type AttributionRow,
  type CohortReport,
} from '@gbox/core/modules/analytics/measurement-queries.js'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function fmtMoney(n: number, currency = 'USD'): string {
  return `${currency === 'VND' ? '' : '$'}${n.toFixed(2)}${currency === 'VND' ? ' VND' : ''}`
}

function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

type MeasurementPeriod = '7d' | '30d' | '90d' | '12m'

function resolvePeriod(raw: string | undefined): {
  key: MeasurementPeriod
  label: string
  sinceIso: string
  untilIso: string
} {
  const now = new Date()
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const key = (raw === '30d' || raw === '90d' || raw === '12m' ? raw : '7d') as MeasurementPeriod
  let sinceDate: Date
  let label: string
  switch (key) {
    case '30d':
      sinceDate = new Date(endOfToday)
      sinceDate.setDate(sinceDate.getDate() - 30)
      label = 'Last 30 days'
      break
    case '90d':
      sinceDate = new Date(endOfToday)
      sinceDate.setDate(sinceDate.getDate() - 90)
      label = 'Last 90 days'
      break
    case '12m':
      sinceDate = new Date(endOfToday)
      sinceDate.setMonth(sinceDate.getMonth() - 12)
      label = 'Last 12 months'
      break
    default:
      sinceDate = new Date(endOfToday)
      sinceDate.setDate(sinceDate.getDate() - 7)
      label = 'Last 7 days'
      break
  }
  return {
    key,
    label,
    sinceIso: sinceDate.toISOString(),
    untilIso: endOfToday.toISOString(),
  }
}

function periodTabs(base: string, sub: string, current: MeasurementPeriod): string {
  const items: Array<{ key: MeasurementPeriod; label: string }> = [
    { key: '7d', label: '7d' },
    { key: '30d', label: '30d' },
    { key: '90d', label: '90d' },
    { key: '12m', label: '12 months' },
  ]
  return `
    <div class="m4-period">
      ${items
        .map(
          (i) =>
            `<a href="${base}/analytics/${esc(sub)}?period=${i.key}" class="m4-period-btn${i.key === current ? ' active' : ''}">${esc(i.label)}</a>`,
        )
        .join('')}
    </div>
  `
}

async function resolveScope(
  db: Kysely<Database>,
  req: Request,
): Promise<{ storeIds: string[]; scope: 'all' | 'single'; canSwitch: boolean; accessibleCount: number }> {
  const user = req.storeUser!
  const store = req.store!
  const accessibleStores = await listAccessibleStores(db, user.id, user.role)
  const canSwitch = accessibleStores.length > 1
  const scope: 'all' | 'single' = req.query.scope === 'all' && canSwitch ? 'all' : 'single'
  const storeIds = scope === 'all' ? accessibleStores.map((s) => s.id) : [store.id]
  return { storeIds, scope, canSwitch, accessibleCount: accessibleStores.length }
}

function measurementStyles(): string {
  return `
    <style>
      .m4-toolbar { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:20px; }
      .m4-period { display:flex; gap:2px; background:var(--s-card); border-radius:8px; border:1px solid var(--s-border); padding:2px; }
      .m4-period-btn { padding:6px 14px; font-size:12px; border-radius:6px; text-decoration:none; color:var(--s-text-muted); transition:all .15s; }
      .m4-period-btn:hover { color:var(--s-text); }
      .m4-period-btn.active { background:var(--s-accent); color:#fff; }
      .m4-scope-pill { display:inline-flex; align-items:center; gap:6px; padding:6px 12px; border-radius:999px; border:1px solid var(--s-border); background:var(--s-card); font-size:12px; color:var(--s-text-muted); text-decoration:none; }
      .m4-scope-pill.active { color:var(--s-text); border-color:var(--s-accent); }
      .m4-hero { margin-bottom:18px; }
      .m4-hero h1 { font-size:22px; font-weight:700; margin:0 0 6px; letter-spacing:-0.01em; }
      .m4-hero p { color:var(--s-text-muted); font-size:13px; margin:0; max-width:760px; line-height:1.5; }
      .m4-kpis { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px; margin-bottom:20px; }
      .m4-kpi { background:var(--s-card); border:1px solid var(--s-border); border-radius:10px; padding:16px; }
      .m4-kpi-label { font-size:11px; color:var(--s-text-muted); text-transform:uppercase; letter-spacing:.04em; margin-bottom:6px; }
      .m4-kpi-value { font-size:22px; font-weight:700; color:var(--s-text); }
      .m4-kpi-sub { font-size:11px; color:var(--s-text-muted); margin-top:4px; }
      .m4-empty { background:var(--s-card); border:1px dashed var(--s-border); border-radius:10px; padding:32px; text-align:center; color:var(--s-text-muted); font-size:13px; }
      .m4-empty strong { display:block; color:var(--s-text); font-size:15px; font-weight:600; margin-bottom:4px; }

      /* Traffic sources table */
      .m4-table-wrap { background:var(--s-card); border:1px solid var(--s-border); border-radius:10px; overflow:hidden; }
      .m4-table { width:100%; border-collapse:collapse; font-size:13px; }
      .m4-table th { text-align:left; padding:10px 14px; background:var(--s-card); color:var(--s-text-muted); font-weight:500; font-size:11px; text-transform:uppercase; letter-spacing:.04em; border-bottom:1px solid var(--s-border); }
      .m4-table td { padding:10px 14px; border-bottom:1px solid var(--s-border); color:var(--s-text); }
      .m4-table tr:last-child td { border-bottom:none; }
      .m4-table .num { text-align:right; font-variant-numeric:tabular-nums; }
      .m4-source-dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--s-accent); margin-right:8px; vertical-align:middle; }

      /* Funnel visual */
      .m4-funnel { background:var(--s-card); border:1px solid var(--s-border); border-radius:10px; padding:24px; }
      .m4-funnel-row { display:flex; align-items:center; gap:16px; padding:8px 0; }
      .m4-funnel-label { width:160px; font-size:13px; color:var(--s-text); font-weight:500; }
      .m4-funnel-bar-wrap { flex:1; background:var(--s-border); border-radius:6px; height:28px; overflow:hidden; position:relative; }
      .m4-funnel-bar { height:100%; background:linear-gradient(90deg, var(--s-accent), #6366f1); transition:width .4s; }
      .m4-funnel-count { position:absolute; top:6px; left:12px; color:#fff; font-weight:600; font-size:12px; text-shadow:0 1px 2px rgba(0,0,0,.3); }
      .m4-funnel-drop { width:90px; font-size:12px; color:var(--s-text-muted); font-variant-numeric:tabular-nums; text-align:right; }
      .m4-funnel-drop.positive { color:var(--s-success); }
      .m4-funnel-drop.negative { color:var(--s-danger); }

      /* Cohort grid */
      .m4-cohort-wrap { background:var(--s-card); border:1px solid var(--s-border); border-radius:10px; overflow:auto; }
      .m4-cohort-table { border-collapse:collapse; font-size:11px; width:100%; }
      .m4-cohort-table th, .m4-cohort-table td { padding:8px 10px; border-bottom:1px solid var(--s-border); border-right:1px solid var(--s-border); white-space:nowrap; }
      .m4-cohort-table th { background:var(--s-card); color:var(--s-text-muted); font-weight:500; text-transform:uppercase; letter-spacing:.04em; font-size:10px; position:sticky; top:0; }
      .m4-cohort-table th:first-child, .m4-cohort-table td:first-child { position:sticky; left:0; background:var(--s-card); z-index:1; }
      .m4-cohort-cell { text-align:center; font-variant-numeric:tabular-nums; color:#fff; font-weight:500; }
      .m4-cohort-size { text-align:right; color:var(--s-text-muted); font-variant-numeric:tabular-nums; }
    </style>
  `
}

/** Color scale for cohort cells — deeper blue = higher retention rate. */
function cohortColor(rate: number): string {
  if (rate <= 0) return 'transparent'
  // HSL: keep hue at 234 (indigo), lightness 20→50 as rate goes 1→0.
  const lightness = 50 - Math.round(rate * 30)  // 20 (dark) to 50 (light)
  const alpha = 0.15 + rate * 0.75              // 0.15 to 0.9
  return `hsla(234, 70%, ${lightness}%, ${alpha.toFixed(2)})`
}

// ---------------------------------------------------------------------------
// M4.1 — Traffic Sources
// ---------------------------------------------------------------------------

export async function getTrafficSourcesReport(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const period = resolvePeriod(req.query.period as string | undefined)
  const { storeIds, scope, canSwitch, accessibleCount } = await resolveScope(db, req)

  // API mode (no local DB): page_views + orders are Postgres-only.
  // Fallback to empty rows so KPIs show 0 and the empty-state card renders.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  let rows: TrafficSourceRow[] = []
  if (hasDb) {
    try {
      rows = await getTrafficSources(db, storeIds, {
        sinceIso: period.sinceIso,
        untilIso: period.untilIso,
      })
    } catch (e: any) {
      console.warn('[traffic-sources] DB read failed:', e?.message)
    }
  }

  const totalSessions = rows.reduce((a, r) => a + r.sessions, 0)
  const totalOrders = rows.reduce((a, r) => a + r.orders, 0)
  const totalRevenue = rows.reduce((a, r) => a + r.revenue, 0)
  const overallCR = totalSessions > 0 ? totalOrders / totalSessions : 0

  const body = rows.length === 0
    ? `<div class="m4-empty"><strong>No traffic yet</strong>Once visitors land on your storefront, the source + medium breakdown will appear here. Make sure your UTM tags are set on ad campaigns.</div>`
    : `
      <div class="m4-table-wrap">
        <table class="m4-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Medium</th>
              <th class="num">Sessions</th>
              <th class="num">Pageviews</th>
              <th class="num">Orders</th>
              <th class="num">Revenue</th>
              <th class="num">CR</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td><span class="m4-source-dot"></span>${esc(r.source)}</td>
                <td>${esc(r.medium)}</td>
                <td class="num">${r.sessions}</td>
                <td class="num">${r.pageviews}</td>
                <td class="num">${r.orders}</td>
                <td class="num">${fmtMoney(r.revenue, store.currency)}</td>
                <td class="num">${fmtPct(r.conversionRate)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `

  const content = `
    <div class="m4-hero">
      <h1>Traffic sources</h1>
      <p>Where your shoppers come from — broken down by UTM source and medium. Conversion rate is orders divided by unique sessions in the same period.</p>
    </div>

    <div class="m4-toolbar">
      ${periodTabs(base, 'traffic', period.key)}
      ${canSwitch ? `
        <div style="display:flex;gap:8px;align-items:center">
          <a href="${base}/analytics/traffic?period=${period.key}" class="m4-scope-pill${scope === 'single' ? ' active' : ''}">This store</a>
          <a href="${base}/analytics/traffic?period=${period.key}&scope=all" class="m4-scope-pill${scope === 'all' ? ' active' : ''}">All stores (${accessibleCount})</a>
        </div>
      ` : ''}
    </div>

    <div class="m4-kpis">
      <div class="m4-kpi"><div class="m4-kpi-label">Sessions</div><div class="m4-kpi-value">${totalSessions}</div><div class="m4-kpi-sub">${esc(period.label)}</div></div>
      <div class="m4-kpi"><div class="m4-kpi-label">Orders</div><div class="m4-kpi-value">${totalOrders}</div><div class="m4-kpi-sub">${esc(period.label)}</div></div>
      <div class="m4-kpi"><div class="m4-kpi-label">Revenue</div><div class="m4-kpi-value">${fmtMoney(totalRevenue, store.currency)}</div><div class="m4-kpi-sub">${esc(period.label)}</div></div>
      <div class="m4-kpi"><div class="m4-kpi-label">Overall CR</div><div class="m4-kpi-value">${fmtPct(overallCR)}</div><div class="m4-kpi-sub">orders / sessions</div></div>
    </div>

    ${body}

    ${measurementStyles()}
  `

  res.send(sellerLayout({
    title: 'Traffic sources',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'analytics',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ---------------------------------------------------------------------------
// M4.2 — Conversion Funnel
// ---------------------------------------------------------------------------

export async function getConversionFunnelReport(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const period = resolvePeriod(req.query.period as string | undefined)
  const { storeIds, scope, canSwitch, accessibleCount } = await resolveScope(db, req)

  // API mode (no local DB): page_views + checkout_sessions are Postgres-only.
  // Fallback to empty rows so the empty-state card renders.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  let rows: readonly FunnelRow[] = []
  if (hasDb) {
    try {
      rows = await getConversionFunnel(db, storeIds, {
        sinceIso: period.sinceIso,
        untilIso: period.untilIso,
      })
    } catch (e: any) {
      console.warn('[conversion-funnel] DB read failed:', e?.message)
    }
  }

  const top = rows[0]?.count ?? 0
  const purchases = rows[rows.length - 1]?.count ?? 0
  const overallCR = top > 0 ? purchases / top : 0

  const body = top === 0
    ? `<div class="m4-empty"><strong>No visitors tracked yet</strong>The funnel uses the dedicated <code>page_views</code> table for visitors and the storefront events stream for cart/checkout stages. Start receiving storefront traffic to populate it.</div>`
    : `
      <div class="m4-funnel">
        ${rows.map((r, i) => {
          const widthPct = Math.max(2, r.pctOfTop * 100)
          const dropLabel = i === 0 ? '—' : fmtPct(r.pctOfPrior)
          const dropCls = i === 0 ? '' : r.pctOfPrior >= 0.5 ? 'positive' : r.pctOfPrior >= 0.2 ? '' : 'negative'
          return `
            <div class="m4-funnel-row">
              <div class="m4-funnel-label">${esc(r.label)}</div>
              <div class="m4-funnel-bar-wrap">
                <div class="m4-funnel-bar" style="width:${widthPct.toFixed(1)}%"></div>
                <span class="m4-funnel-count">${r.count}</span>
              </div>
              <div class="m4-funnel-drop ${dropCls}">${dropLabel}</div>
            </div>
          `
        }).join('')}
      </div>
    `

  const content = `
    <div class="m4-hero">
      <h1>Conversion funnel</h1>
      <p>Visitors → Add to cart → Reached checkout → Purchased. Each row shows how many shoppers made it to that stage and what percent of the previous stage they represent.</p>
    </div>

    <div class="m4-toolbar">
      ${periodTabs(base, 'funnel', period.key)}
      ${canSwitch ? `
        <div style="display:flex;gap:8px;align-items:center">
          <a href="${base}/analytics/funnel?period=${period.key}" class="m4-scope-pill${scope === 'single' ? ' active' : ''}">This store</a>
          <a href="${base}/analytics/funnel?period=${period.key}&scope=all" class="m4-scope-pill${scope === 'all' ? ' active' : ''}">All stores (${accessibleCount})</a>
        </div>
      ` : ''}
    </div>

    <div class="m4-kpis">
      <div class="m4-kpi"><div class="m4-kpi-label">Visitors</div><div class="m4-kpi-value">${top}</div><div class="m4-kpi-sub">${esc(period.label)}</div></div>
      <div class="m4-kpi"><div class="m4-kpi-label">Purchases</div><div class="m4-kpi-value">${purchases}</div><div class="m4-kpi-sub">${esc(period.label)}</div></div>
      <div class="m4-kpi"><div class="m4-kpi-label">End-to-end CR</div><div class="m4-kpi-value">${fmtPct(overallCR)}</div><div class="m4-kpi-sub">purchase / visitor</div></div>
    </div>

    ${body}

    ${measurementStyles()}
  `

  res.send(sellerLayout({
    title: 'Conversion funnel',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'analytics',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ---------------------------------------------------------------------------
// M4.3 — UTM Attribution (first-touch)
// ---------------------------------------------------------------------------

export async function getAttributionReport(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const period = resolvePeriod(req.query.period as string | undefined)
  const { storeIds, scope, canSwitch, accessibleCount } = await resolveScope(db, req)

  // API mode (no local DB): UTM attribution joins orders + the gbox_utm cookie
  // table, both Postgres-only. Fallback to empty rows so empty-state renders.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  let rows: AttributionRow[] = []
  if (hasDb) {
    try {
      rows = await getUtmAttribution(db, storeIds, {
        sinceIso: period.sinceIso,
        untilIso: period.untilIso,
      })
    } catch (e: any) {
      console.warn('[utm-attribution] DB read failed:', e?.message)
    }
  }

  const totalOrders = rows.reduce((a, r) => a + r.orders, 0)
  const totalRevenue = rows.reduce((a, r) => a + r.revenue, 0)
  const topCampaign = rows[0] ?? null

  const body = rows.length === 0
    ? `<div class="m4-empty"><strong>No attributed orders yet</strong>Orders are tagged with UTM source/medium/campaign from the 30-day first-touch cookie. Add UTM params to your ad URLs to start attributing revenue.</div>`
    : `
      <div class="m4-table-wrap">
        <table class="m4-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Medium</th>
              <th>Campaign</th>
              <th class="num">Orders</th>
              <th class="num">Revenue</th>
              <th class="num">AOV</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td><span class="m4-source-dot"></span>${esc(r.source)}</td>
                <td>${esc(r.medium)}</td>
                <td>${esc(r.campaign ?? '(no campaign)')}</td>
                <td class="num">${r.orders}</td>
                <td class="num">${fmtMoney(r.revenue, store.currency)}</td>
                <td class="num">${fmtMoney(r.avgOrderValue, store.currency)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `

  const content = `
    <div class="m4-hero">
      <h1>UTM attribution</h1>
      <p>
        First-touch attribution: every order is credited to the UTM source / medium / campaign that first brought the shopper to your store.
        Powered by the 30-day <code>gbox_utm</code> cookie stamped on first visit and read at checkout completion.
      </p>
    </div>

    <div class="m4-toolbar">
      ${periodTabs(base, 'attribution', period.key)}
      ${canSwitch ? `
        <div style="display:flex;gap:8px;align-items:center">
          <a href="${base}/analytics/attribution?period=${period.key}" class="m4-scope-pill${scope === 'single' ? ' active' : ''}">This store</a>
          <a href="${base}/analytics/attribution?period=${period.key}&scope=all" class="m4-scope-pill${scope === 'all' ? ' active' : ''}">All stores (${accessibleCount})</a>
        </div>
      ` : ''}
    </div>

    <div class="m4-kpis">
      <div class="m4-kpi"><div class="m4-kpi-label">Attributed orders</div><div class="m4-kpi-value">${totalOrders}</div><div class="m4-kpi-sub">${esc(period.label)}</div></div>
      <div class="m4-kpi"><div class="m4-kpi-label">Attributed revenue</div><div class="m4-kpi-value">${fmtMoney(totalRevenue, store.currency)}</div><div class="m4-kpi-sub">${esc(period.label)}</div></div>
      <div class="m4-kpi"><div class="m4-kpi-label">Top source</div><div class="m4-kpi-value" style="font-size:16px">${topCampaign ? esc(topCampaign.source) : '—'}</div><div class="m4-kpi-sub">${topCampaign ? fmtMoney(topCampaign.revenue, store.currency) : 'no data yet'}</div></div>
    </div>

    ${body}

    ${measurementStyles()}
  `

  res.send(sellerLayout({
    title: 'UTM attribution',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'analytics',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ---------------------------------------------------------------------------
// M4.4 — Cohort Retention
// ---------------------------------------------------------------------------

export async function getCohortReportPage(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const { storeIds, scope, canSwitch, accessibleCount } = await resolveScope(db, req)

  // Cohorts use their own "months back" picker — default 12 months, 12 offsets.
  const monthsBack = req.query.months === '6' ? 6 : req.query.months === '24' ? 24 : 12

  // API mode (no local DB): cohort retention queries orders + customers
  // Postgres tables. Fallback to an empty report so the empty-state renders.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  let report: CohortReport = { cohorts: [], maxOffset: monthsBack } as CohortReport
  if (hasDb) {
    try {
      report = await getCohortRetention(db, storeIds, {
        maxCohortMonths: monthsBack,
        maxOffset: monthsBack,
      })
    } catch (e: any) {
      console.warn('[cohort-retention] DB read failed:', e?.message)
    }
  }

  const totalCohortCustomers = report.cohorts.reduce((a, c) => a + c.size, 0)
  const month1Retained = report.cohorts.reduce((a, c) => a + (c.retention[1]?.customers ?? 0), 0)
  const month1Rate = totalCohortCustomers > 0 ? month1Retained / totalCohortCustomers : 0
  const month3Retained = report.cohorts.reduce((a, c) => a + (c.retention[3]?.customers ?? 0), 0)
  const month3Rate = totalCohortCustomers > 0 ? month3Retained / totalCohortCustomers : 0

  const offsetHeaders: string[] = []
  for (let i = 0; i <= report.maxOffset; i++) {
    offsetHeaders.push(i === 0 ? 'Month 0' : `M+${i}`)
  }

  const body = report.cohorts.length === 0
    ? `<div class="m4-empty"><strong>No cohorts to show</strong>Cohorts are built from customers' first-order month. Once you have at least one paid order tied to a customer, they'll appear here.</div>`
    : `
      <div class="m4-cohort-wrap">
        <table class="m4-cohort-table">
          <thead>
            <tr>
              <th>Cohort</th>
              <th style="text-align:right">Size</th>
              ${offsetHeaders.map(h => `<th style="text-align:center">${esc(h)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${report.cohorts.map(c => `
              <tr>
                <td><strong>${esc(c.month.slice(0, 7))}</strong></td>
                <td class="m4-cohort-size">${c.size}</td>
                ${c.retention.map(r => {
                  if (r.customers === 0) {
                    return `<td></td>`
                  }
                  return `<td class="m4-cohort-cell" style="background:${cohortColor(r.rate)}">${fmtPct(r.rate)}</td>`
                }).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `

  const monthsPicker = `
    <div class="m4-period">
      ${([6, 12, 24] as const).map(m => `
        <a href="${base}/analytics/cohort?months=${m}${scope === 'all' ? '&scope=all' : ''}" class="m4-period-btn${monthsBack === m ? ' active' : ''}">${m} months</a>
      `).join('')}
    </div>
  `

  const content = `
    <div class="m4-hero">
      <h1>Cohort retention</h1>
      <p>Each row is a group of customers who placed their <strong>first order</strong> in that month. Columns show how many came back N months later. Darker cells = stronger retention.</p>
    </div>

    <div class="m4-toolbar">
      ${monthsPicker}
      ${canSwitch ? `
        <div style="display:flex;gap:8px;align-items:center">
          <a href="${base}/analytics/cohort?months=${monthsBack}" class="m4-scope-pill${scope === 'single' ? ' active' : ''}">This store</a>
          <a href="${base}/analytics/cohort?months=${monthsBack}&scope=all" class="m4-scope-pill${scope === 'all' ? ' active' : ''}">All stores (${accessibleCount})</a>
        </div>
      ` : ''}
    </div>

    <div class="m4-kpis">
      <div class="m4-kpi"><div class="m4-kpi-label">Cohort customers</div><div class="m4-kpi-value">${totalCohortCustomers}</div><div class="m4-kpi-sub">last ${monthsBack} months</div></div>
      <div class="m4-kpi"><div class="m4-kpi-label">M+1 retention</div><div class="m4-kpi-value">${fmtPct(month1Rate)}</div><div class="m4-kpi-sub">came back in month 1</div></div>
      <div class="m4-kpi"><div class="m4-kpi-label">M+3 retention</div><div class="m4-kpi-value">${fmtPct(month3Rate)}</div><div class="m4-kpi-sub">came back in month 3</div></div>
    </div>

    ${body}

    ${measurementStyles()}
  `

  res.send(sellerLayout({
    title: 'Cohort retention',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'analytics',
    content,
    theme: theme as 'dark' | 'light',
  }))
}
