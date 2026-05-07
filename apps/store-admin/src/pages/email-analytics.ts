/**
 * Store Admin — Email Analytics Report (Phase 14 PR4)
 *
 * One handler, one page, lives at
 *   GET /admin/store/:slug/reports/email-analytics
 *
 * Surfaces the tracking data collected by the pixel + redirect routes
 * (commits 3-5) through the analytics aggregator (commit 6):
 *
 *   • Six headline KPI cards (sent / delivered / opens / clicks /
 *     bounce rate / CTR)
 *   • 30-bar inline-SVG time-series chart (opens over time)
 *   • Template breakdown table with sort by sent / open rate / click
 *     rate
 *   • Period selector (7d / 30d / 90d)
 *
 * IRON RULE 5
 * -----------
 * `getEmailSummary` / `getTemplateBreakdown` only count rows where
 * `email_deliveries.shop_id = req.store.id`. Platform-level sends
 * (shop_id NULL) — which are where god-admin templates end up — can
 * never surface here by construction.
 *
 * No SVG/canvas library. The chart is hand-rolled inline SVG — small
 * enough (~60 lines) and the page wants nothing more sophisticated
 * than bar heights + hover tooltips.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import {
  getEmailSummary,
  getDailyEmailMetrics,
  getTemplateBreakdown,
  lastNDays,
  type DailyEmailMetric,
  type TemplateBreakdown,
} from '@gbox/core/modules/email/analytics.js'

// ---------------------------------------------------------------------------
// Period helpers
// ---------------------------------------------------------------------------

type PeriodKey = '7d' | '30d' | '90d'

function normalisePeriod(raw: unknown): PeriodKey {
  const s = typeof raw === 'string' ? raw : '7d'
  return s === '30d' || s === '90d' ? s : '7d'
}

function periodDays(key: PeriodKey): number {
  return key === '7d' ? 7 : key === '30d' ? 30 : 90
}

function periodLabel(key: PeriodKey): string {
  return key === '7d' ? 'Last 7 days' : key === '30d' ? 'Last 30 days' : 'Last 90 days'
}

// ---------------------------------------------------------------------------
// Small render helpers
// ---------------------------------------------------------------------------

function fmtInt(n: number): string {
  return n.toLocaleString('en-US')
}

function fmtPct(n: number): string {
  return `${n.toFixed(n >= 10 ? 1 : 2)}%`
}

function kpiCard(
  title: string,
  value: string,
  sub: string,
  tone: 'neutral' | 'good' | 'warn' = 'neutral',
): string {
  const toneColor =
    tone === 'good' ? '#22c55e' : tone === 'warn' ? '#f59e0b' : 'var(--text-primary)'
  return `
    <div class="card" style="min-height:110px">
      <div class="card-body">
        <div style="font-size:12px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.05em">${esc(title)}</div>
        <div style="font-size:28px;font-weight:700;color:${toneColor};margin-top:6px">${esc(value)}</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">${esc(sub)}</div>
      </div>
    </div>
  `
}

/**
 * Inline SVG bar chart for daily opens. We deliberately don't chart
 * multiple series on one canvas — a single dimension per chart reads
 * much cleaner in the dashboard header. If sellers want delivered /
 * clicks overlaid, the template breakdown table already has the
 * totals; no need to double-encode the same info in the chart.
 */
function renderDailyChart(days: DailyEmailMetric[], metric: 'opens' | 'delivered' = 'opens'): string {
  if (days.length === 0) {
    return `<div class="card"><div class="card-body" style="color:var(--text-secondary);text-align:center;padding:40px">No activity in this period.</div></div>`
  }

  const width = 800
  const height = 160
  const padding = 24
  const barGap = 2
  const usableW = width - padding * 2
  const usableH = height - padding * 2
  const barW = Math.max(2, usableW / days.length - barGap)

  const values = days.map((d) => (metric === 'opens' ? d.opens : d.delivered))
  const maxV = Math.max(1, ...values)

  const bars = days
    .map((d, i) => {
      const v = values[i]
      const h = (v / maxV) * usableH
      const x = padding + i * (barW + barGap)
      const y = padding + (usableH - h)
      const label = `${d.date}: ${fmtInt(v)} ${metric === 'opens' ? 'opens' : 'delivered'}`
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="#2563eb" opacity="0.85"><title>${esc(label)}</title></rect>`
    })
    .join('')

  // Y-axis gridline at max value, labelled.
  const gridY = padding
  const axis = `
    <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="var(--border)" stroke-width="1" />
    <line x1="${padding}" y1="${gridY}" x2="${width - padding}" y2="${gridY}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2,2" opacity="0.4" />
    <text x="${padding + 4}" y="${gridY + 10}" font-size="10" fill="var(--text-secondary)">${fmtInt(maxV)}</text>
    <text x="${width - padding}" y="${height - padding + 14}" font-size="10" fill="var(--text-secondary)" text-anchor="end">${esc(days[days.length - 1].date)}</text>
    <text x="${padding}" y="${height - padding + 14}" font-size="10" fill="var(--text-secondary)">${esc(days[0].date)}</text>
  `

  return `
    <div class="card">
      <div class="card-body">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div style="font-weight:600">Daily ${metric === 'opens' ? 'opens' : 'deliveries'}</div>
        </div>
        <svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto;display:block">
          ${axis}
          ${bars}
        </svg>
      </div>
    </div>
  `
}

/**
 * Template breakdown table. Sortable by query param (`sortBy`). Empty
 * state shows a helpful hint pointing at the template editor instead
 * of a boring "no data" placeholder.
 */
function renderBreakdownTable(
  rows: TemplateBreakdown[],
  base: string,
  period: PeriodKey,
  sortBy: 'sent' | 'open_rate' | 'click_rate',
): string {
  if (rows.length === 0) {
    return `
      <div class="card">
        <div class="card-body" style="text-align:center;padding:32px;color:var(--text-secondary)">
          <div style="font-size:15px;margin-bottom:4px">No emails sent in this period.</div>
          <div style="font-size:13px">Customize templates via <a href="${esc(base)}/settings/email-templates" style="color:#2563eb">Notifications → Email templates</a>.</div>
        </div>
      </div>
    `
  }

  const col = (key: 'sent' | 'open_rate' | 'click_rate', label: string): string => {
    const isActive = sortBy === key
    const href = `${base}/reports/email-analytics?period=${period}&sortBy=${key}`
    return `<a href="${esc(href)}" style="color:${isActive ? '#2563eb' : 'var(--text-secondary)'};text-decoration:none;font-weight:${isActive ? '600' : '400'}">${esc(label)}${isActive ? ' ↓' : ''}</a>`
  }

  return `
    <div class="card">
      <div class="card-body" style="padding:0">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="border-bottom:1px solid var(--border);background:var(--bg-secondary)">
              <th style="text-align:left;padding:10px 14px;font-weight:600">Template</th>
              <th style="text-align:right;padding:10px 14px;font-weight:600">${col('sent', 'Sent')}</th>
              <th style="text-align:right;padding:10px 14px;font-weight:600">Delivered</th>
              <th style="text-align:right;padding:10px 14px;font-weight:600">Opens</th>
              <th style="text-align:right;padding:10px 14px;font-weight:600">Clicks</th>
              <th style="text-align:right;padding:10px 14px;font-weight:600">${col('open_rate', 'Open rate')}</th>
              <th style="text-align:right;padding:10px 14px;font-weight:600">${col('click_rate', 'Click rate')}</th>
              <th style="text-align:right;padding:10px 14px;font-weight:600">Bounce rate</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (r, i) => `
              <tr style="border-bottom:1px solid var(--border);${i % 2 === 1 ? 'background:var(--bg-secondary)' : ''}">
                <td style="padding:10px 14px;font-family:monospace;font-size:12px">${esc(r.templateKey)}</td>
                <td style="padding:10px 14px;text-align:right">${fmtInt(r.sent)}</td>
                <td style="padding:10px 14px;text-align:right">${fmtInt(r.delivered)}</td>
                <td style="padding:10px 14px;text-align:right">${fmtInt(r.opens)} <span style="color:var(--text-secondary)">(${fmtInt(r.uniqueOpens)})</span></td>
                <td style="padding:10px 14px;text-align:right">${fmtInt(r.clicks)} <span style="color:var(--text-secondary)">(${fmtInt(r.uniqueClicks)})</span></td>
                <td style="padding:10px 14px;text-align:right">${fmtPct(r.openRate)}</td>
                <td style="padding:10px 14px;text-align:right">${fmtPct(r.clickRate)}</td>
                <td style="padding:10px 14px;text-align:right;color:${r.bounceRate > 5 ? '#f59e0b' : 'var(--text-primary)'}">${fmtPct(r.bounceRate)}</td>
              </tr>
            `,
              )
              .join('')}
          </tbody>
        </table>
        <div style="padding:10px 14px;font-size:11px;color:var(--text-secondary);border-top:1px solid var(--border)">
          Opens/clicks show total hits with unique recipients in parentheses. Bounces are zero until bounce webhooks ship (PR4.B).
        </div>
      </div>
    </div>
  `
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function getEmailAnalyticsPage(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`

  const period = normalisePeriod(req.query.period)
  const sortBy: 'sent' | 'open_rate' | 'click_rate' =
    req.query.sortBy === 'open_rate' || req.query.sortBy === 'click_rate'
      ? req.query.sortBy
      : 'sent'

  const range = lastNDays(periodDays(period))

  // One parallel round-trip for all three aggregations.
  // API mode (no local DB): email_events is Postgres-only. Render KPIs at 0,
  // empty chart and empty template breakdown so the page still loads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbx = db as any
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  const emptySummary = {
    sent: 0, delivered: 0, opens: 0, uniqueOpens: 0,
    clicks: 0, uniqueClicks: 0, bounces: 0, complaints: 0,
    openRate: 0, clickRate: 0, bounceRate: 0,
  }
  let summary: Awaited<ReturnType<typeof getEmailSummary>> = emptySummary as any
  let daily: DailyEmailMetric[] = []
  let templates: TemplateBreakdown[] = []
  if (hasDb) {
    try {
      ;[summary, daily, templates] = await Promise.all([
        getEmailSummary(dbx, store.id, range),
        getDailyEmailMetrics(dbx, store.id, range),
        getTemplateBreakdown(dbx, store.id, range, { orderBy: sortBy, limit: 50 }),
      ])
    } catch (e: any) {
      console.warn('[email-analytics] DB read failed:', e?.message)
    }
  }

  const periodBtn = (key: PeriodKey, label: string): string => {
    const active = key === period
    return `<a href="${base}/reports/email-analytics?period=${key}" class="period-btn${active ? ' active' : ''}" style="padding:6px 12px;border:1px solid var(--border);border-radius:6px;text-decoration:none;color:${active ? '#fff' : 'var(--text-primary)'};background:${active ? '#2563eb' : 'transparent'};font-size:13px">${esc(label)}</a>`
  }

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Email analytics</h1>
        <p class="page-subtitle">${esc(periodLabel(period))} · ${esc(range.since)} → ${esc(range.until)}</p>
      </div>
      <div style="display:flex;gap:6px">
        ${periodBtn('7d', '7 days')}
        ${periodBtn('30d', '30 days')}
        ${periodBtn('90d', '90 days')}
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px">
      ${kpiCard('Sent', fmtInt(summary.sent), `${fmtInt(summary.delivered)} delivered`)}
      ${kpiCard('Unique opens', fmtInt(summary.uniqueOpens), `${fmtInt(summary.opens)} total hits`)}
      ${kpiCard('Unique clicks', fmtInt(summary.uniqueClicks), `${fmtInt(summary.clicks)} total hits`)}
      ${kpiCard('Open rate', fmtPct(summary.openRate), 'opens / delivered', summary.openRate >= 20 ? 'good' : 'neutral')}
      ${kpiCard('Click rate', fmtPct(summary.clickRate), 'clicks / delivered', summary.clickRate >= 3 ? 'good' : 'neutral')}
      ${kpiCard('Bounce rate', fmtPct(summary.bounceRate), summary.bounceRate > 5 ? 'above healthy threshold' : 'bounces / sent', summary.bounceRate > 5 ? 'warn' : 'neutral')}
    </div>

    <div style="margin-bottom:20px">
      ${renderDailyChart(daily, 'opens')}
    </div>

    <h2 style="font-size:16px;font-weight:600;margin:24px 0 12px">By template</h2>
    ${renderBreakdownTable(templates, base, period, sortBy)}

    <p style="font-size:12px;color:var(--text-secondary);margin-top:16px">
      Tracking only applies to marketing, lifecycle, and reviews emails. Transactional emails (password reset, order confirmation, shipping updates) are never tracked.
    </p>
  `

  res.send(
    sellerLayout({
      title: 'Email analytics',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      theme: theme as 'dark' | 'light',
      activePage: 'analytics',
      content,
    }),
  )
}
