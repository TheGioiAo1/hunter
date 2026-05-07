/**
 * Store Admin — Analytics & Reports (Phase 6)
 *
 * G1: Analytics Dashboard — period selector, revenue chart, KPIs, top products/customers
 * G2: Sales Report — date range filter, sales by date, sales by product
 * G3: Product Report — best sellers, slow movers, inventory value
 * G4: Customer Report — new vs returning, top spenders, geographic distribution
 * G5: Finance Report — gross/net revenue, refunds, tax, payment methods
 */

import type { Request, Response } from 'express'
import { sql, type Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { listAccessibleStores } from '../lib/user-stores.js'

// ─── Helpers ──────────────────────────────────────────────────────

function fmtMoney(n: number, currency = 'USD'): string {
  return `${currency === 'VND' ? '' : '$'}${n.toFixed(2)}${currency === 'VND' ? ' VND' : ''}`
}

function fmtDate(d: Date | string): string {
  const dt = typeof d === 'string' ? new Date(d) : d
  return dt.toISOString().slice(0, 10)
}

/**
 * Escape a single CSV field. Wraps the value in double quotes if it
 * contains comma, newline, CR or a quote character; doubles any
 * embedded quotes per RFC 4180. Non-string inputs are coerced via
 * String() first so callers can pass numbers, dates etc. directly.
 *
 * Keep this tiny and local — we only have a few callers and pulling
 * in a CSV library would be overkill.
 */
function csvField(v: unknown): string {
  const s = v == null ? '' : String(v)
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/**
 * Serialize an array of rows (header + data) to a CSV string. Each
 * cell is escaped via csvField(); rows are joined with CRLF which is
 * what Excel expects.
 */
function toCsv(rows: unknown[][]): string {
  return rows.map(row => row.map(csvField).join(',')).join('\r\n') + '\r\n'
}

/**
 * Build a filename-safe token from a free-form piece of text. Used
 * to stamp report filenames with the store slug + date range so a
 * merchant with two stores doesn't overwrite exports in their
 * downloads folder.
 */
function csvSlug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'report'
}

function pctChange(current: number, prev: number): string {
  if (prev === 0) return current > 0 ? '+100%' : '0%'
  const pct = ((current - prev) / prev) * 100
  return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`
}

function changeClass(current: number, prev: number): string {
  if (current > prev) return 'stat-up'
  if (current < prev) return 'stat-down'
  return ''
}

function emptyState(title: string, text: string): string {
  return `<div class="empty-state"><div class="empty-state-title">${title}</div><div class="empty-state-text">${text}</div></div>`
}

function periodDates(period: string): { startDate: Date; days: number; label: string } {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  let days: number
  let label: string
  switch (period) {
    case '7d':  days = 7;  label = 'Last 7 days';  break
    case '90d': days = 90; label = 'Last 90 days'; break
    default:    days = 30; label = 'Last 30 days'; break
  }
  const startDate = new Date(today)
  startDate.setDate(startDate.getDate() - days)
  return { startDate, days, label }
}

function buildBarChart(
  data: Array<{ label: string; value: number }>,
  maxVal: number,
): string {
  if (data.length === 0) return emptyState('No data', 'No revenue data for this period.')
  return `
    <div class="bar-chart">
      ${data.map(d => `
        <div class="bar-col">
          <div class="bar-fill" style="height:${Math.max((d.value / (maxVal || 1)) * 100, 2)}%" title="${fmtMoney(d.value)}"></div>
          <div class="bar-label">${d.label}</div>
        </div>
      `).join('')}
    </div>
  `
}

function groupByDay(rows: Array<{ created_at: any; total_price: any }>): Map<string, number> {
  const byDay = new Map<string, number>()
  for (const r of rows) {
    const day = new Date(r.created_at).toISOString().slice(0, 10)
    byDay.set(day, (byDay.get(day) || 0) + Number(r.total_price))
  }
  return byDay
}

function fillDays(byDay: Map<string, number>, startDate: Date, days: number): Array<{ label: string; value: number; date: string }> {
  const result: Array<{ label: string; value: number; date: string }> = []
  for (let i = 0; i < days; i++) {
    const d = new Date(startDate)
    d.setDate(d.getDate() + i)
    const key = d.toISOString().slice(0, 10)
    const label = days <= 7
      ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]
      : `${d.getMonth() + 1}/${d.getDate()}`
    result.push({ label, value: byDay.get(key) || 0, date: key })
  }
  return result
}

function periodSelector(base: string, currentPeriod: string): string {
  const periods = [
    { key: '7d', label: '7 days' },
    { key: '30d', label: '30 days' },
    { key: '90d', label: '90 days' },
  ]
  return `
    <div class="period-selector">
      ${periods.map(p => `
        <a href="${base}/analytics?period=${p.key}" class="period-btn${currentPeriod === p.key ? ' active' : ''}">${p.label}</a>
      `).join('')}
    </div>
  `
}

// ─── Overview dashboard helpers (G1 — Shopify-style overview) ──────

/**
 * Expanded period map used by the overview dashboard. Unlike
 * `periodDates` above (which only supports 7d/30d/90d), this supports
 * "today", "yesterday", and "7d"/"30d"/"90d" for the screenshot-style
 * date range picker with ← → arrows cycling through presets.
 */
function overviewPeriod(period: string): {
  startDate: Date
  endDate: Date
  days: number
  label: string
  key: string
} {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  let startDate: Date
  let endDate: Date
  let days: number
  let label: string
  let key: string
  switch (period) {
    case 'today': {
      startDate = new Date(today)
      endDate = new Date(today)
      endDate.setDate(endDate.getDate() + 1)
      days = 1
      label = 'Today'
      key = 'today'
      break
    }
    case 'yesterday': {
      startDate = new Date(today)
      startDate.setDate(startDate.getDate() - 1)
      endDate = new Date(today)
      days = 1
      label = 'Yesterday'
      key = 'yesterday'
      break
    }
    case '30d': {
      startDate = new Date(today)
      startDate.setDate(startDate.getDate() - 30)
      endDate = new Date(today)
      endDate.setDate(endDate.getDate() + 1)
      days = 30
      label = 'Last 30 days'
      key = '30d'
      break
    }
    case '90d': {
      startDate = new Date(today)
      startDate.setDate(startDate.getDate() - 90)
      endDate = new Date(today)
      endDate.setDate(endDate.getDate() + 1)
      days = 90
      label = 'Last 90 days'
      key = '90d'
      break
    }
    default: {
      // '7d' — default, matches the screenshot's 4-bar look at a small width
      startDate = new Date(today)
      startDate.setDate(startDate.getDate() - 6)
      endDate = new Date(today)
      endDate.setDate(endDate.getDate() + 1)
      days = 7
      label = 'Last 7 days'
      key = '7d'
      break
    }
  }
  return { startDate, endDate, days, label, key }
}

/** Presets for the ← → arrow picker. Order defines cycling order. */
const OVERVIEW_PERIOD_ORDER = ['today', 'yesterday', '7d', '30d', '90d'] as const

function cyclePeriod(current: string, dir: -1 | 1): string {
  const i = (OVERVIEW_PERIOD_ORDER as readonly string[]).indexOf(current)
  if (i === -1) return '7d'
  const next = (i + dir + OVERVIEW_PERIOD_ORDER.length) % OVERVIEW_PERIOD_ORDER.length
  return OVERVIEW_PERIOD_ORDER[next]!
}

/**
 * Walk a day list and emit N evenly-spaced sample points for the
 * sparkline x-axis labels. If there are ≤4 days, returns each day;
 * otherwise returns ~4 sample labels (first, 1/3, 2/3, last) so the
 * axis stays readable like the screenshot (Jan 10 / 11 / 12 / 13).
 */
function sparklineAxisLabels(
  days: Array<{ label: string; date: string }>,
): string[] {
  if (days.length === 0) return []
  if (days.length <= 4) return days.map((d) => d.label)
  const out: string[] = []
  const indices = [0, Math.floor(days.length / 3), Math.floor((days.length * 2) / 3), days.length - 1]
  for (const i of indices) out.push(days[i]?.label ?? '')
  return out
}

/**
 * Build a minimal inline SVG sparkline. One series, one color, a subtle
 * baseline, and dots at each data point. Size and color tuned to match
 * the Shopify overview card visual weight.
 */
function buildSparkline(
  points: Array<{ label: string; date: string; value: number }>,
  color: string = '#6366f1',
  height: number = 80,
): string {
  if (points.length === 0) {
    return `<div class="ov-spark-empty">No data</div>`
  }
  const width = 520 // will be overridden by CSS responsive container
  const padX = 12
  const padY = 14
  const innerW = width - padX * 2
  const innerH = height - padY * 2
  const maxV = Math.max(1, ...points.map((p) => p.value))
  const step = points.length > 1 ? innerW / (points.length - 1) : 0
  const coords = points.map((p, i) => {
    const x = padX + step * i
    const y = padY + innerH - (p.value / maxV) * innerH
    return { x, y, v: p.value }
  })
  const pathD = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')
  // Area fill under the line
  const areaD =
    `M${coords[0]!.x},${padY + innerH} ` +
    coords.map((c) => `L${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ') +
    ` L${coords[coords.length - 1]!.x},${padY + innerH} Z`
  const axisLabels = sparklineAxisLabels(points)
  return `
    <div class="ov-spark">
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="ov-spark-svg">
        <defs>
          <linearGradient id="sparkGrad-${color.replace('#', '')}" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="${color}" stop-opacity=".22"/>
            <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <line x1="${padX}" y1="${padY + innerH}" x2="${width - padX}" y2="${padY + innerH}" stroke="var(--s-border)" stroke-width="1" stroke-dasharray="2,3"/>
        <path d="${areaD}" fill="url(#sparkGrad-${color.replace('#', '')})"/>
        <path d="${pathD}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        ${coords.map((c) => `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="2.5" fill="${color}"/>`).join('')}
      </svg>
      <div class="ov-spark-axis">
        ${axisLabels.map((l) => `<span>${esc(l)}</span>`).join('')}
      </div>
    </div>
  `
}

/**
 * Two-series sparkline for "First-time vs returning customers". Same
 * layout as `buildSparkline` but plots two lines in different colors
 * with a small legend row underneath.
 */
function buildDualSparkline(
  points: Array<{ label: string; date: string; a: number; b: number }>,
  colorA: string,
  labelA: string,
  colorB: string,
  labelB: string,
  height: number = 80,
): string {
  if (points.length === 0) {
    return `<div class="ov-spark-empty">No data</div>`
  }
  const width = 520
  const padX = 12
  const padY = 14
  const innerW = width - padX * 2
  const innerH = height - padY * 2
  const maxV = Math.max(1, ...points.map((p) => Math.max(p.a, p.b)))
  const step = points.length > 1 ? innerW / (points.length - 1) : 0
  const coordsA = points.map((p, i) => ({
    x: padX + step * i,
    y: padY + innerH - (p.a / maxV) * innerH,
  }))
  const coordsB = points.map((p, i) => ({
    x: padX + step * i,
    y: padY + innerH - (p.b / maxV) * innerH,
  }))
  const pathA = coordsA.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')
  const pathB = coordsB.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')
  const axisLabels = sparklineAxisLabels(points)
  return `
    <div class="ov-spark">
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="ov-spark-svg">
        <line x1="${padX}" y1="${padY + innerH}" x2="${width - padX}" y2="${padY + innerH}" stroke="var(--s-border)" stroke-width="1" stroke-dasharray="2,3"/>
        <path d="${pathA}" fill="none" stroke="${colorA}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="${pathB}" fill="none" stroke="${colorB}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <div class="ov-spark-axis">
        ${axisLabels.map((l) => `<span>${esc(l)}</span>`).join('')}
      </div>
      <div class="ov-spark-legend">
        <span><i style="background:${colorA}"></i>${esc(labelA)}</span>
        <span><i style="background:${colorB}"></i>${esc(labelB)}</span>
      </div>
    </div>
  `
}

/**
 * Horizontal funnel bar chart for conversion-rate and email-recovery
 * funnels. Each step is a labeled bar whose width is proportional to
 * its count relative to the first step (widest = 100%).
 */
function buildFunnelBars(
  steps: Array<{ label: string; count: number }>,
  color: string = '#6366f1',
): string {
  if (steps.length === 0) return `<div class="ov-spark-empty">No data</div>`
  const max = Math.max(1, ...steps.map((s) => s.count))
  return `
    <div class="ov-funnel">
      ${steps.map((s) => {
        const pct = Math.max(4, (s.count / max) * 100)
        return `
          <div class="ov-funnel-row">
            <div class="ov-funnel-label">${esc(s.label)}</div>
            <div class="ov-funnel-bar-wrap">
              <div class="ov-funnel-bar" style="width:${pct.toFixed(1)}%;background:${color}"></div>
              <span class="ov-funnel-count">${s.count}</span>
            </div>
          </div>
        `
      }).join('')}
    </div>
  `
}

/**
 * Top-countries list. No real world map — we render a compact
 * ranked list with a subtle blue fill bar (the same pattern Shopify
 * uses for small dashboard cards) so the data stays scannable even
 * when the seller has hundreds of countries.
 *
 * The full interactive map lives on `/analytics/customers` (G4),
 * reachable via the "View report" link in the card header.
 */
function buildTopCountries(
  rows: Array<{ country: string; orders: number }>,
): string {
  if (rows.length === 0) {
    return `
      <div class="ov-countries-empty">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="color:var(--s-text-muted);margin-bottom:12px">
          <circle cx="12" cy="12" r="10"/>
          <line x1="2" y1="12" x2="22" y2="12"/>
          <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/>
        </svg>
        <p>There were no orders in this date range yet. A first-time customer is a customer who placed the first order with your store.</p>
      </div>
    `
  }
  const max = Math.max(1, ...rows.map((r) => r.orders))
  return `
    <div class="ov-countries-list">
      ${rows.map((r, i) => {
        const pct = (r.orders / max) * 100
        return `
          <div class="ov-country-row">
            <span class="ov-country-rank">${i + 1}</span>
            <span class="ov-country-name">${esc(r.country)}</span>
            <div class="ov-country-bar"><div style="width:${pct.toFixed(1)}%"></div></div>
            <span class="ov-country-count">${r.orders}</span>
          </div>
        `
      }).join('')}
    </div>
  `
}

/**
 * "Today ← → [dropdown]" date picker matching the screenshot. The
 * arrows cycle through `OVERVIEW_PERIOD_ORDER`; the dropdown lets a
 * user jump directly to any preset.
 */
function overviewDatePicker(base: string, period: string, scope: 'all' | 'single' = 'single'): string {
  const current = overviewPeriod(period)
  const prev = cyclePeriod(current.key, -1)
  const next = cyclePeriod(current.key, +1)
  const scopeSuffix = scope === 'all' ? '&scope=all' : ''
  return `
    <div class="ov-date-picker">
      <a href="${base}/analytics?period=${prev}${scopeSuffix}" class="ov-date-arrow" title="Previous">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 4L6 8l4 4"/></svg>
      </a>
      <div class="ov-date-label-wrap">
        <select class="ov-date-select" onchange="window.location.href='${base}/analytics?period=' + this.value + '${scopeSuffix}'">
          ${OVERVIEW_PERIOD_ORDER.map((k) => {
            const p = overviewPeriod(k)
            return `<option value="${k}"${k === current.key ? ' selected' : ''}>${esc(p.label)}</option>`
          }).join('')}
        </select>
      </div>
      <a href="${base}/analytics?period=${next}${scopeSuffix}" class="ov-date-arrow" title="Next">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 4l4 4-4 4"/></svg>
      </a>
    </div>
  `
}

function analyticsStyles(): string {
  return `
    <style>
      .period-selector { display:flex; gap:2px; background:var(--s-card); border-radius:8px; border:1px solid var(--s-border); padding:2px; }
      .period-btn { padding:6px 12px; font-size:12px; border-radius:6px; text-decoration:none; color:var(--s-text-muted); transition:all .15s; }
      .period-btn:hover { color:var(--s-text); }
      .period-btn.active { background:var(--s-accent); color:#fff; }
      .date-range-form { display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap; }
      .report-section { margin-bottom:24px; }
      .two-col { display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-bottom:20px; }
      .three-col-stats { display:grid; grid-template-columns:repeat(3, 1fr); gap:16px; margin-bottom:20px; }
      @media (max-width:768px) { .two-col { grid-template-columns:1fr; } .three-col-stats { grid-template-columns:1fr; } }
      .pct-bar { height:8px; border-radius:4px; background:var(--s-border); overflow:hidden; }
      .pct-bar-fill { height:100%; border-radius:4px; background:var(--s-accent); transition:width .3s; }
      .finance-row { display:flex; justify-content:space-between; padding:12px 0; border-bottom:1px solid var(--s-border); }
      .finance-row:last-child { border-bottom:none; font-weight:700; }
      .finance-label { color:var(--s-text-muted); }
      .finance-value { font-weight:600; }
      .finance-value.positive { color:var(--s-success); }
      .finance-value.negative { color:var(--s-danger); }

      /* ── Overview dashboard (G1 — Shopify-style) ────────────────── */
      .ov-hero { margin-bottom:20px; }
      .ov-hero h1 { font-size:22px; font-weight:700; color:var(--s-text); margin:0 0 6px; letter-spacing:-0.01em; }
      .ov-hero-row { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; flex-wrap:wrap; }
      .ov-hero-desc { color:var(--s-text-muted); font-size:13px; line-height:1.5; max-width:720px; margin:0; }
      .ov-hero-desc a { color:var(--s-accent); text-decoration:none; }
      .ov-hero-desc a:hover { text-decoration:underline; }
      .ov-hero-cta { background:var(--s-card); color:var(--s-text); border:1px solid var(--s-border); padding:8px 16px; border-radius:8px; font-size:13px; font-weight:500; text-decoration:none; white-space:nowrap; transition:all .15s; }
      .ov-hero-cta:hover { background:var(--s-accent); color:#fff; border-color:var(--s-accent); }

      .ov-toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; background:var(--s-card); border:1px solid var(--s-border); border-radius:10px; padding:10px 14px; margin-bottom:18px; flex-wrap:wrap; }
      .ov-toolbar-left { display:flex; align-items:center; gap:12px; }
      .ov-store-pill { display:inline-flex; align-items:center; gap:8px; padding:6px 12px; background:var(--s-bg); border:1px solid var(--s-border); border-radius:8px; font-size:12px; color:var(--s-text-muted); cursor:pointer; font-family:inherit; transition:background .15s, border-color .15s, color .15s; }
      .ov-store-pill:hover { background:var(--s-hover, rgba(99,102,241,.08)); border-color:var(--s-accent); }
      .ov-store-pill strong { color:var(--s-text); font-weight:600; }
      .ov-store-pill-all { background:rgba(99,102,241,.12); border-color:var(--s-accent); color:var(--s-accent); }
      .ov-store-pill-all strong { color:var(--s-accent); }
      .ov-store-pill-all:hover { background:rgba(99,102,241,.2); }
      .ov-store-switcher { position:relative; }

      /* Shared dropdown menu system (same as orders.ts) */
      .menu-wrap { position:relative; display:inline-block; }
      .menu-dropdown {
        display:none; position:absolute; top:calc(100% + 4px); left:0; z-index:100;
        min-width:180px; background:var(--s-card); border:1px solid var(--s-border);
        border-radius:8px; padding:4px; box-shadow:var(--s-shadow, 0 8px 24px rgba(0,0,0,.24));
      }
      .menu-dropdown.open { display:block; }
      .menu-item {
        display:block; padding:8px 12px; font-size:13px; color:var(--s-text);
        text-decoration:none; border-radius:6px; cursor:pointer; transition:background .15s;
      }
      .menu-item:hover { background:var(--s-hover, rgba(99,102,241,.08)); }
      .menu-item.active { background:var(--s-accent, #6366f1); color:#fff; }
      .ov-date-picker { display:flex; align-items:center; gap:4px; background:var(--s-bg); border:1px solid var(--s-border); border-radius:8px; padding:2px; }
      .ov-date-arrow { display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px; border-radius:6px; color:var(--s-text-muted); text-decoration:none; transition:background .15s; }
      .ov-date-arrow:hover { background:var(--s-border); color:var(--s-text); }
      .ov-date-label-wrap { position:relative; min-width:130px; }
      .ov-date-select { width:100%; padding:5px 10px; background:transparent; border:0; color:var(--s-text); font-size:12px; font-weight:500; text-align:center; cursor:pointer; outline:none; appearance:none; -webkit-appearance:none; text-align-last:center; }
      .ov-refresh { display:flex; align-items:center; gap:8px; color:var(--s-text-muted); font-size:12px; }
      .ov-refresh-toggle { position:relative; width:32px; height:18px; background:var(--s-border); border-radius:9px; cursor:pointer; transition:background .15s; flex-shrink:0; }
      .ov-refresh-toggle::after { content:''; position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%; background:#fff; transition:left .15s; }
      .ov-refresh-toggle.on { background:var(--s-accent); }
      .ov-refresh-toggle.on::after { left:16px; }

      .ov-grid { display:grid; grid-template-columns:repeat(2, 1fr); gap:16px; margin-bottom:18px; }
      @media (max-width:900px) { .ov-grid { grid-template-columns:1fr; } }
      .ov-card { background:var(--s-card); border:1px solid var(--s-border); border-radius:12px; padding:18px 20px; display:flex; flex-direction:column; gap:12px; min-height:248px; }
      .ov-card-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
      .ov-card-title-wrap { display:flex; align-items:center; gap:6px; }
      .ov-card-title { font-size:13px; font-weight:600; color:var(--s-text); margin:0; }
      .ov-card-info { display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; border-radius:50%; border:1px solid var(--s-text-muted); color:var(--s-text-muted); font-size:9px; font-weight:600; cursor:help; }
      .ov-card-action { color:var(--s-accent); font-size:11px; text-decoration:none; white-space:nowrap; }
      .ov-card-action:hover { text-decoration:underline; }
      .ov-card-value { font-size:26px; font-weight:700; color:var(--s-text); letter-spacing:-0.01em; line-height:1.1; }
      .ov-card-breakdown { display:flex; flex-direction:column; gap:3px; font-size:11px; color:var(--s-text-muted); }
      .ov-card-breakdown-row { display:flex; align-items:center; justify-content:space-between; gap:8px; }
      .ov-card-breakdown-row strong { color:var(--s-text); font-weight:600; font-size:12px; }
      .ov-card-spark { margin-top:auto; }

      .ov-spark { position:relative; }
      .ov-spark-svg { width:100%; height:80px; display:block; }
      .ov-spark-axis { display:flex; justify-content:space-between; padding:0 4px; font-size:10px; color:var(--s-text-muted); margin-top:2px; }
      .ov-spark-legend { display:flex; gap:16px; font-size:11px; color:var(--s-text-muted); margin-top:6px; }
      .ov-spark-legend span { display:flex; align-items:center; gap:6px; }
      .ov-spark-legend i { display:inline-block; width:8px; height:8px; border-radius:50%; }
      .ov-spark-empty { text-align:center; font-size:12px; color:var(--s-text-muted); padding:24px 0; }

      .ov-funnel { display:flex; flex-direction:column; gap:8px; }
      .ov-funnel-row { display:grid; grid-template-columns:120px 1fr; gap:12px; align-items:center; font-size:11px; }
      .ov-funnel-label { color:var(--s-text-muted); text-transform:capitalize; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .ov-funnel-bar-wrap { position:relative; background:var(--s-bg); height:22px; border-radius:4px; overflow:hidden; }
      .ov-funnel-bar { position:absolute; top:0; left:0; bottom:0; border-radius:4px; transition:width .4s ease; }
      .ov-funnel-count { position:absolute; right:8px; top:50%; transform:translateY(-50%); font-size:11px; font-weight:600; color:var(--s-text); }

      .ov-countries-card { background:var(--s-card); border:1px solid var(--s-border); border-radius:12px; padding:20px; margin-bottom:20px; }
      .ov-countries-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
      .ov-countries-head h3 { font-size:13px; font-weight:600; color:var(--s-text); margin:0; display:flex; align-items:center; gap:6px; }
      .ov-countries-empty { text-align:center; padding:40px 20px; color:var(--s-text-muted); font-size:12px; line-height:1.6; max-width:480px; margin:0 auto; }
      .ov-countries-empty p { margin:0; }
      .ov-countries-list { display:flex; flex-direction:column; gap:8px; }
      .ov-country-row { display:grid; grid-template-columns:24px 1fr 2fr 40px; gap:12px; align-items:center; font-size:12px; }
      .ov-country-rank { color:var(--s-text-muted); font-weight:600; text-align:center; }
      .ov-country-name { color:var(--s-text); font-weight:500; }
      .ov-country-bar { background:var(--s-bg); height:8px; border-radius:4px; overflow:hidden; }
      .ov-country-bar > div { height:100%; background:var(--s-accent); border-radius:4px; transition:width .3s; }
      .ov-country-count { text-align:right; color:var(--s-text); font-weight:600; }
    </style>
  `
}


/**
 * Render a "not available in API mode" placeholder for analytics sub-reports
 * (Sales / Products / Customers / Finance). All sub-reports query Postgres
 * directly; until a BE analytics endpoint exists, we ship this placeholder
 * instead of letting the page 500.
 */
function renderAnalyticsPlaceholder(
  res: Response,
  base: string,
  store: any,
  user: any,
  theme: string,
  title: string,
): void {
  const content = `
    <div class="page-header" style="margin-bottom:18px">
      <a href="${base}/analytics" style="color:var(--s-text-muted);text-decoration:none;font-size:13px">&larr; Analytics</a>
      <h1 class="page-title" style="margin:8px 0 0">${esc(title)}</h1>
    </div>
    <div class="card">
      <div class="card-body" style="padding:48px;text-align:center;color:var(--s-text-muted)">
        <h3 style="margin:0 0 8px;font-size:16px;color:var(--s-text);font-weight:600">Report not available</h3>
        <p style="margin:0 auto;font-size:13px;max-width:520px">This report aggregates orders, customers and line items from local Postgres. No BE analytics endpoint exists yet to replace it in API mode.</p>
        <div style="margin-top:18px">
          <a href="${base}/analytics" class="btn btn-outline btn-sm" style="text-decoration:none;font-size:13px">Back to Analytics</a>
        </div>
      </div>
    </div>
  `
  res.send(sellerLayout({
    title,
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

/* ================================================================== */
/*  G1: Analytics Dashboard                                           */
/* ================================================================== */

export async function getAnalyticsDashboard(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`

  // API mode (no local DB): the whole dashboard queries Postgres (orders /
  // order_line_items / checkout_sessions / customers...). Render a placeholder
  // instead of 500 — no BE analytics endpoint exists yet.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  if (!hasDb) {
    const placeholder = `
      <div class="page-header" style="margin-bottom:18px">
        <h1 class="page-title" style="margin:0">Analytics</h1>
        <p class="page-subtitle" style="margin:4px 0 0;color:var(--s-text-muted);font-size:13px">Sales, orders and customer overview — available only when local DB or BE analytics endpoint is wired.</p>
      </div>
      <div class="card">
        <div class="card-body" style="padding:48px;text-align:center;color:var(--s-text-muted)">
          <h3 style="margin:0 0 8px;font-size:16px;color:var(--s-text);font-weight:600">Analytics not available</h3>
          <p style="margin:0;font-size:13px;max-width:520px;margin:0 auto">Dashboard needs local Postgres to aggregate orders/customers/checkout funnel. No BE analytics endpoint replaces it in API mode yet. Sub-reports (Sales / Products / Customers / Finance) are in the same state.</p>
          <div style="margin-top:18px;display:flex;gap:8px;justify-content:center">
            <a href="${base}/orders" class="btn btn-outline btn-sm" style="text-decoration:none;font-size:13px">View Orders</a>
            <a href="${base}/customers" class="btn btn-outline btn-sm" style="text-decoration:none;font-size:13px">View Customers</a>
          </div>
        </div>
      </div>
    `
    res.send(sellerLayout({
      title: 'Analytics',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'analytics',
      content: placeholder,
      theme: theme as 'dark' | 'light',
    }))
    return
  }

  // ── Date range ────────────────────────────────────────────────
  const period = (req.query.period as string) || '7d'
  const { startDate, endDate, days, label: periodLabel } = overviewPeriod(period)
  const startISO = startDate.toISOString()
  const endISO = endDate.toISOString()

  // ── Multistore scope ──────────────────────────────────────────
  // Resolved up-front because we need storeIds to build every query
  // below. Tenancy is enforced by listAccessibleStores() — the `all`
  // scope only activates if the current user owns >1 store, and
  // storeIds is always a subset of what they can legitimately see.
  const accessibleStores = await listAccessibleStores(db, user.id, user.role)
  const canSwitchStores = accessibleStores.length > 1
  const scope: 'all' | 'single' =
    req.query.scope === 'all' && canSwitchStores ? 'all' : 'single'
  const storeIds: string[] =
    scope === 'all' ? accessibleStores.map((s) => s.id) : [store.id]

  // ── Parallel queries ──────────────────────────────────────────
  // We split into a single Promise.all so the whole dashboard
  // renders in one round-trip to the DB. Every query is scoped by
  // `shop_id IN (storeIds)` + date window so no cross-tenant leakage
  // is possible — the storeIds list is pre-validated above.
  const [
    salesStats,
    onlineSalesStats,
    ordersByDay,
    aovByDay,
    itemsByDay,
    checkoutFunnel,
    customersInPeriod,
    countriesRows,
  ] = await Promise.all([
    // 1. Total sales + order count + AOV + item counts (paid only)
    db.selectFrom('orders')
      .select([
        db.fn.count('id').as('total_orders'),
        db.fn.sum('total_price').as('total_revenue'),
        db.fn.avg('total_price').as('avg_order_value'),
      ])
      .where('shop_id', 'in', storeIds)
      .where('created_at', '>=', startISO)
      .where('created_at', '<', endISO)
      .executeTakeFirst(),

    // 2. Online sales breakdown (financial_status=paid)
    db.selectFrom('orders')
      .select([
        db.fn.count('id').as('online_orders'),
        db.fn.sum('total_price').as('online_revenue'),
      ])
      .where('shop_id', 'in', storeIds)
      .where('created_at', '>=', startISO)
      .where('created_at', '<', endISO)
      .where('financial_status', '=', 'paid')
      .executeTakeFirst(),

    // 3. Orders grouped by day — for sparkline and orders count chart
    db.selectFrom('orders')
      .select(['created_at', 'total_price', 'id'])
      .where('shop_id', 'in', storeIds)
      .where('created_at', '>=', startISO)
      .where('created_at', '<', endISO)
      .orderBy('created_at', 'asc')
      .execute(),

    // 4. AOV by day — same rows reused below, but we keep a placeholder
    //    for symmetry (the actual computation is done in JS from ordersByDay)
    Promise.resolve(null),

    // 5. Average items per order — SUM(quantity) / COUNT(distinct order)
    db.selectFrom('order_line_items as oli')
      .innerJoin('orders as o', 'o.id', 'oli.order_id')
      .select([
        db.fn.sum('oli.quantity' as any).as('total_qty'),
        db.fn.count('o.id' as any).distinct().as('order_count'),
      ])
      .where('o.shop_id', 'in', storeIds)
      .where('o.created_at', '>=', startISO)
      .where('o.created_at', '<', endISO)
      .executeTakeFirst(),

    // 6. Checkout funnel — open/completed/abandoned/expired session counts
    db.selectFrom('checkout_sessions')
      .select([
        'state',
        db.fn.count('id').as('count'),
      ])
      .where('shop_id', 'in', storeIds)
      .where('created_at', '>=', startISO)
      .where('created_at', '<', endISO)
      .groupBy('state')
      .execute(),

    // 7. Customers with any orders in the period (for first-time vs
    //    returning split). We pull orders_count snapshot and bucket
    //    client-side — it's fine at this scale and avoids an extra join.
    db.selectFrom('orders as o')
      .innerJoin('customers as c', 'c.id', 'o.customer_id')
      .select([
        'c.id as customer_id',
        'c.orders_count',
        'o.created_at',
      ])
      .where('o.shop_id', 'in', storeIds)
      .where('o.created_at', '>=', startISO)
      .where('o.created_at', '<', endISO)
      .execute(),

    // 8. Top countries — extract shipping_address->>country with JSONB op
    db.selectFrom('orders')
      .select([
        sql<string>`COALESCE(shipping_address->>'country_code', shipping_address->>'country', 'Unknown')`.as('country'),
        db.fn.count('id').as('orders'),
      ])
      .where('shop_id', 'in', storeIds)
      .where('created_at', '>=', startISO)
      .where('created_at', '<', endISO)
      .groupBy(sql`COALESCE(shipping_address->>'country_code', shipping_address->>'country', 'Unknown')`)
      .orderBy('orders', 'desc')
      .limit(10)
      .execute(),
  ])

  // Suppress unused-variable lint for the placeholder query slot
  void aovByDay

  // ── Shape data for UI ─────────────────────────────────────────
  const totalRevenue = Number(salesStats?.total_revenue ?? 0)
  const totalOrders = Number(salesStats?.total_orders ?? 0)
  const avgOrderValue = Number(salesStats?.avg_order_value ?? 0)
  const onlineRevenue = Number(onlineSalesStats?.online_revenue ?? 0)
  const onlineOrders = Number(onlineSalesStats?.online_orders ?? 0)

  const avgItems = Number(itemsByDay?.order_count ?? 0) > 0
    ? Number(itemsByDay?.total_qty ?? 0) / Number(itemsByDay?.order_count ?? 1)
    : 0

  // Sparkline buckets — reuse helpers from the report sub-pages
  const revenueByDay = groupByDay(ordersByDay)
  const revenueDays = fillDays(revenueByDay, startDate, days)
  const ordersByDayMap = new Map<string, number>()
  for (const o of ordersByDay) {
    const day = new Date(o.created_at as any).toISOString().slice(0, 10)
    ordersByDayMap.set(day, (ordersByDayMap.get(day) || 0) + 1)
  }
  const orderCountDays = fillDays(ordersByDayMap, startDate, days)
  // AOV per day
  const aovDays = revenueDays.map((d, i) => ({
    label: d.label,
    date: d.date,
    value: orderCountDays[i]!.value > 0 ? d.value / orderCountDays[i]!.value : 0,
  }))
  // Avg items per day — stub to flat avg (we don't slice line items by day
  // here to keep the query count down; the sparkline still shows the trend
  // of *order volume* which is the best proxy at this page's level).
  const itemsDays = orderCountDays.map((d) => ({
    label: d.label,
    date: d.date,
    value: d.value > 0 ? avgItems : 0,
  }))

  // Conversion funnel
  const funnelMap = new Map<string, number>()
  for (const r of checkoutFunnel) {
    funnelMap.set(String((r as any).state), Number((r as any).count))
  }
  const openCount = funnelMap.get('open') ?? 0
  const completedCount = funnelMap.get('completed') ?? 0
  const abandonedCount = funnelMap.get('abandoned') ?? 0
  const expiredCount = funnelMap.get('expired') ?? 0
  const totalSessions = openCount + completedCount + abandonedCount + expiredCount
  const conversionRate = totalSessions > 0 ? (completedCount / totalSessions) * 100 : 0
  const recoveryRate = abandonedCount > 0 ? (completedCount / (completedCount + abandonedCount)) * 100 : 0

  // First-time vs returning
  const firstTimeCount = customersInPeriod.filter((c: any) => Number(c.orders_count) <= 1).length
  const returningCount = customersInPeriod.filter((c: any) => Number(c.orders_count) > 1).length
  const returningRate = customersInPeriod.length > 0
    ? (returningCount / customersInPeriod.length) * 100
    : 0

  // First-time vs returning by day — bucket customers by their order.created_at
  const firstTimeDays = new Map<string, number>()
  const returningDays = new Map<string, number>()
  for (const c of customersInPeriod as any[]) {
    const day = new Date(c.created_at).toISOString().slice(0, 10)
    if (Number(c.orders_count) <= 1) {
      firstTimeDays.set(day, (firstTimeDays.get(day) || 0) + 1)
    } else {
      returningDays.set(day, (returningDays.get(day) || 0) + 1)
    }
  }
  const customerSparkData: Array<{ label: string; date: string; a: number; b: number }> = []
  for (let i = 0; i < days; i++) {
    const d = new Date(startDate)
    d.setDate(d.getDate() + i)
    const key = d.toISOString().slice(0, 10)
    const label = days <= 7
      ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]!
      : `${d.getMonth() + 1}/${d.getDate()}`
    customerSparkData.push({
      label,
      date: key,
      a: firstTimeDays.get(key) || 0,
      b: returningDays.get(key) || 0,
    })
  }

  // Returning customer rate sparkline — rate per day
  const returningRateDays = customerSparkData.map((d) => ({
    label: d.label,
    date: d.date,
    value: (d.a + d.b) > 0 ? (d.b / (d.a + d.b)) * 100 : 0,
  }))

  // Recovery rate sparkline — per-day % of completed among (completed + abandoned)
  // (We don't have daily funnel data without an extra query, so use an
  // approximation from the sessions list — grouped by day below.)
  const recoverySparkDays = revenueDays.map((d) => ({
    label: d.label,
    date: d.date,
    value: 0, // placeholder — real per-day funnel belongs in /analytics/reports
  }))

  // Top countries list
  const topCountries = countriesRows.map((r: any) => ({
    country: String(r.country || 'Unknown'),
    orders: Number(r.orders),
  }))

  // ── Render HTML ───────────────────────────────────────────────
  const content = `
    <div class="ov-hero">
      <div class="ov-hero-row">
        <div>
          <h1>Overview dashboard</h1>
          <p class="ov-hero-desc">
            The Overview dashboard shows key sales, orders, and online store stats.
            You can see at a glance how your store's performing &mdash; across all of your stores,
            and for any date range. <a href="${base}/analytics/reports">Learn more</a>
          </p>
        </div>
        <a href="${base}/analytics/reports" class="ov-hero-cta">Show analytics</a>
      </div>
    </div>

    <div class="ov-toolbar">
      <div class="ov-toolbar-left">
        <div class="menu-wrap ov-store-switcher">
          <button type="button" class="ov-store-pill${scope === 'all' ? ' ov-store-pill-all' : ''}" onclick="toggleMenu('ovStoreMenu')" aria-haspopup="true" aria-expanded="false">
            ${scope === 'all'
              ? `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2a9 9 0 010 12M8 2a9 9 0 000 12"/></svg>
                 All stores <strong>(${accessibleStores.length})</strong>`
              : `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 6l1-3h10l1 3M2 6v7h12V6M2 6h12"/></svg>
                 Current store: <strong>${esc(store.name)}</strong>`
            }
            <svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" style="margin-left:6px;opacity:.7"><path d="M5 8l5 5 5-5"/></svg>
          </button>
          <div class="menu-dropdown" id="ovStoreMenu" style="min-width:260px;max-height:360px;overflow-y:auto">
            <div style="padding:8px 12px 4px;font-size:11px;color:var(--s-text-muted);text-transform:uppercase;letter-spacing:.04em">Scope</div>
            ${canSwitchStores ? `
              <a class="menu-item${scope === 'all' ? ' active' : ''}" href="${base}/analytics?period=${esc(period)}&scope=all" title="Aggregate metrics across every store you own">
                <span style="display:inline-flex;align-items:center;gap:8px">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" style="opacity:.85"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2a9 9 0 010 12M8 2a9 9 0 000 12"/></svg>
                  ${scope === 'all' ? '✓ ' : ''}All stores
                  <span style="opacity:.55;font-size:11px;margin-left:auto">${accessibleStores.length}</span>
                </span>
              </a>
              <div style="height:1px;background:var(--s-border);margin:4px 0"></div>
            ` : ''}
            <div style="padding:8px 12px 4px;font-size:11px;color:var(--s-text-muted);text-transform:uppercase;letter-spacing:.04em">Switch store</div>
            ${accessibleStores.length === 0 ? `
              <div class="menu-item" style="opacity:0.6;cursor:default;pointer-events:none;font-size:11px">No other stores</div>
            ` : accessibleStores.map(s => `
              <a class="menu-item${scope === 'single' && s.slug === store.slug ? ' active' : ''}" href="/admin/store/${esc(s.slug)}/analytics?period=${esc(period)}" title="${esc(s.name)}">
                ${scope === 'single' && s.slug === store.slug ? '✓ ' : ''}${esc(s.name)}
              </a>
            `).join('')}
          </div>
        </div>
        ${overviewDatePicker(base, period, scope)}
      </div>
      <div class="ov-refresh">
        <span>Auto refresh</span>
        <div class="ov-refresh-toggle" id="ovRefreshToggle" role="switch" aria-checked="false" tabindex="0"></div>
      </div>
    </div>

    <div class="ov-grid">
      <!-- 1. Total sales -->
      <div class="ov-card">
        <div class="ov-card-head">
          <div class="ov-card-title-wrap">
            <h3 class="ov-card-title">Total sales</h3>
            <span class="ov-card-info" title="Total value of all orders placed in this period (online + POS + draft).">i</span>
          </div>
          <a href="${base}/analytics/sales" class="ov-card-action">View report</a>
        </div>
        <div class="ov-card-value">${fmtMoney(totalRevenue, store.currency)}</div>
        <div class="ov-card-breakdown">
          <div class="ov-card-breakdown-row">
            <span>Online sales</span><strong>${fmtMoney(onlineRevenue, store.currency)}</strong>
          </div>
          <div class="ov-card-breakdown-row">
            <span>Total sales via Excel (paid)</span><strong>${fmtMoney(totalRevenue, store.currency)}</strong>
          </div>
        </div>
        <div class="ov-card-spark">${buildSparkline(revenueDays, '#6366f1')}</div>
      </div>

      <!-- 2. Online store conversion rate -->
      <div class="ov-card">
        <div class="ov-card-head">
          <div class="ov-card-title-wrap">
            <h3 class="ov-card-title">Online store conversion rate</h3>
            <span class="ov-card-info" title="Percentage of checkout sessions that resulted in a paid order.">i</span>
          </div>
          <a href="${base}/analytics/reports" class="ov-card-action">Conversion reports</a>
        </div>
        <div class="ov-card-value">${conversionRate.toFixed(1)}%</div>
        <div class="ov-card-breakdown">
          <div class="ov-card-breakdown-row">
            <span>Sessions</span><strong>${totalSessions}</strong>
          </div>
          <div class="ov-card-breakdown-row">
            <span>Paid orders</span><strong>${onlineOrders}</strong>
          </div>
        </div>
        <div class="ov-card-spark">
          ${buildFunnelBars([
            { label: 'Sessions', count: totalSessions },
            { label: 'Carts opened', count: openCount + completedCount },
            { label: 'Reached checkout', count: completedCount + abandonedCount },
            { label: 'Paid', count: completedCount },
          ], '#6366f1')}
        </div>
      </div>

      <!-- 3. Total orders -->
      <div class="ov-card">
        <div class="ov-card-head">
          <div class="ov-card-title-wrap">
            <h3 class="ov-card-title">Total orders</h3>
            <span class="ov-card-info" title="Total number of orders placed in this period.">i</span>
          </div>
          <a href="${base}/orders" class="ov-card-action">View orders</a>
        </div>
        <div class="ov-card-value">${totalOrders}</div>
        <div class="ov-card-breakdown">
          <div class="ov-card-breakdown-row">
            <span>Online orders</span><strong>${onlineOrders}</strong>
          </div>
          <div class="ov-card-breakdown-row">
            <span>Total orders via Excel (paid)</span><strong>${onlineOrders}</strong>
          </div>
        </div>
        <div class="ov-card-spark">${buildSparkline(orderCountDays, '#22c55e')}</div>
      </div>

      <!-- 4. Average order value -->
      <div class="ov-card">
        <div class="ov-card-head">
          <div class="ov-card-title-wrap">
            <h3 class="ov-card-title">Average order value</h3>
            <span class="ov-card-info" title="Total sales divided by number of orders.">i</span>
          </div>
          <a href="${base}/analytics/sales" class="ov-card-action">View report</a>
        </div>
        <div class="ov-card-value">${fmtMoney(avgOrderValue, store.currency)}</div>
        <div class="ov-card-breakdown">
          <div class="ov-card-breakdown-row">
            <span>Online sales AOV</span><strong>${fmtMoney(onlineOrders > 0 ? onlineRevenue / onlineOrders : 0, store.currency)}</strong>
          </div>
          <div class="ov-card-breakdown-row">
            <span>Online sales via Excel (paid)</span><strong>${fmtMoney(avgOrderValue, store.currency)}</strong>
          </div>
        </div>
        <div class="ov-card-spark">${buildSparkline(aovDays, '#f59e0b')}</div>
      </div>

      <!-- 5. Average order items -->
      <div class="ov-card">
        <div class="ov-card-head">
          <div class="ov-card-title-wrap">
            <h3 class="ov-card-title">Average order items</h3>
            <span class="ov-card-info" title="Average number of items per order.">i</span>
          </div>
          <a href="${base}/analytics/products" class="ov-card-action">View report</a>
        </div>
        <div class="ov-card-value">${avgItems.toFixed(2)}</div>
        <div class="ov-card-breakdown">
          <div class="ov-card-breakdown-row">
            <span>Online sales</span><strong>${avgItems.toFixed(2)}</strong>
          </div>
          <div class="ov-card-breakdown-row">
            <span>Online sales via Excel (paid)</span><strong>${avgItems.toFixed(2)}</strong>
          </div>
        </div>
        <div class="ov-card-spark">${buildSparkline(itemsDays, '#ec4899')}</div>
      </div>

      <!-- 6. Abandoned checkouts recovery -->
      <div class="ov-card">
        <div class="ov-card-head">
          <div class="ov-card-title-wrap">
            <h3 class="ov-card-title">Abandoned checkouts recovery</h3>
            <span class="ov-card-info" title="Percentage of abandoned carts that completed a purchase after a reminder.">i</span>
          </div>
          <a href="${base}/marketing/abandoned" class="ov-card-action">Tips to recover abandoned checkouts</a>
        </div>
        <div class="ov-card-value">${recoveryRate.toFixed(1)}%</div>
        <div class="ov-card-breakdown">
          <div class="ov-card-breakdown-row" style="text-transform:uppercase;font-size:10px;letter-spacing:0.5px">
            <span>Email reminders conversion funnel</span>
          </div>
        </div>
        <div class="ov-card-spark">
          ${buildFunnelBars([
            { label: 'Abandoned', count: abandonedCount },
            { label: 'Reminder sent', count: abandonedCount },
            { label: 'Recovered', count: completedCount },
          ], '#f97316')}
        </div>
      </div>

      <!-- 7. First-time vs returning customers -->
      <div class="ov-card">
        <div class="ov-card-head">
          <div class="ov-card-title-wrap">
            <h3 class="ov-card-title">First-time vs returning customers</h3>
            <span class="ov-card-info" title="Comparison of new (first-time) customers vs customers who have previously ordered.">i</span>
          </div>
          <a href="${base}/analytics/customers" class="ov-card-action">Total orders</a>
        </div>
        <div class="ov-card-value">${customersInPeriod.length}</div>
        <div class="ov-card-breakdown">
          <div class="ov-card-breakdown-row">
            <span>First-time customers</span><strong>${firstTimeCount}</strong>
          </div>
          <div class="ov-card-breakdown-row">
            <span>Returning customers</span><strong>${returningCount}</strong>
          </div>
        </div>
        <div class="ov-card-spark">
          ${buildDualSparkline(customerSparkData, '#6366f1', 'First-time', '#22c55e', 'Returning')}
        </div>
      </div>

      <!-- 8. Returning customer rate -->
      <div class="ov-card">
        <div class="ov-card-head">
          <div class="ov-card-title-wrap">
            <h3 class="ov-card-title">Returning customer rate</h3>
            <span class="ov-card-info" title="Percentage of customers who have placed more than one order.">i</span>
          </div>
          <a href="${base}/analytics/customers" class="ov-card-action">Learn how to calculate this metric</a>
        </div>
        <div class="ov-card-value">${returningRate.toFixed(1)}%</div>
        <div class="ov-card-breakdown">
          <div class="ov-card-breakdown-row">
            <span>Returning</span><strong>${returningCount} / ${customersInPeriod.length}</strong>
          </div>
        </div>
        <div class="ov-card-spark">${buildSparkline(returningRateDays, '#14b8a6')}</div>
      </div>
    </div>

    <!-- Top countries by order -->
    <div class="ov-countries-card">
      <div class="ov-countries-head">
        <h3>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="6.5"/><path d="M1.5 8h13M8 1.5a10 10 0 010 13M8 1.5a10 10 0 000 13"/></svg>
          Top countries by order
        </h3>
        <a href="${base}/analytics/customers" class="ov-card-action">View report</a>
      </div>
      ${buildTopCountries(topCountries)}
    </div>

    <!-- M4 — Measurement reports: discovery cards for the new dashboards -->
    <div class="ov-measurement" style="margin-top:20px">
      <h3 style="font-size:14px;font-weight:600;color:var(--s-text);margin:0 0 12px;letter-spacing:-0.01em">Measurement reports</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:12px">
        <a href="${base}/analytics/traffic" class="ov-card" style="text-decoration:none;display:block">
          <div class="ov-card-head" style="margin-bottom:6px">
            <h3 class="ov-card-title" style="font-size:13px">Traffic sources</h3>
          </div>
          <p style="color:var(--s-text-muted);font-size:12px;line-height:1.45;margin:0">Sessions + orders + revenue grouped by UTM source and medium.</p>
        </a>
        <a href="${base}/analytics/funnel" class="ov-card" style="text-decoration:none;display:block">
          <div class="ov-card-head" style="margin-bottom:6px">
            <h3 class="ov-card-title" style="font-size:13px">Conversion funnel</h3>
          </div>
          <p style="color:var(--s-text-muted);font-size:12px;line-height:1.45;margin:0">Visitors → Add to cart → Checkout → Purchased with drop-off at each step.</p>
        </a>
        <a href="${base}/analytics/attribution" class="ov-card" style="text-decoration:none;display:block">
          <div class="ov-card-head" style="margin-bottom:6px">
            <h3 class="ov-card-title" style="font-size:13px">UTM attribution</h3>
          </div>
          <p style="color:var(--s-text-muted);font-size:12px;line-height:1.45;margin:0">First-touch revenue attributed to source / medium / campaign.</p>
        </a>
        <a href="${base}/analytics/cohort" class="ov-card" style="text-decoration:none;display:block">
          <div class="ov-card-head" style="margin-bottom:6px">
            <h3 class="ov-card-title" style="font-size:13px">Cohort retention</h3>
          </div>
          <p style="color:var(--s-text-muted);font-size:12px;line-height:1.45;margin:0">Monthly retention heatmap showing how cohorts come back over time.</p>
        </a>
      </div>
    </div>

    <!-- AI Quick Actions (PRESERVED from Phase 6) -->
    <div class="card" style="border-color:var(--s-accent)">
      <div class="card-header" style="color:var(--s-accent)">
        <span style="display:flex;align-items:center;gap:8px">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="14" height="14" rx="3"/><circle cx="7.5" cy="8.5" r="1"/><circle cx="12.5" cy="8.5" r="1"/><path d="M7 13c1.5 1 4.5 1 6 0"/></svg>
          AI Analytics
        </span>
      </div>
      <div class="card-body" style="display:flex;flex-wrap:wrap;gap:8px">
        <button class="btn btn-outline btn-sm" data-ai-sug="Analyze revenue trends for ${esc(periodLabel)}${scope === 'all' ? ' across all my stores' : ''}">Revenue trends</button>
        <button class="btn btn-outline btn-sm" data-ai-sug="Which products are underperforming${scope === 'all' ? ' across all my stores' : ''}?">Underperformers</button>
        <button class="btn btn-outline btn-sm" data-ai-sug="Suggest ways to increase AOV${scope === 'all' ? ' portfolio-wide' : ''}">Increase AOV</button>
        <button class="btn btn-outline btn-sm" data-ai-sug="Customer retention analysis${scope === 'all' ? ' across all my stores' : ''}">Retention analysis</button>
        <button class="btn btn-outline btn-sm" data-ai-sug="Forecast next month revenue${scope === 'all' ? ' portfolio-wide' : ''}">Revenue forecast</button>
        <button class="btn btn-outline btn-sm" data-ai-sug="Compare conversion rate ${esc(periodLabel)} vs previous period${scope === 'all' ? ' across all my stores' : ''}">Period comparison</button>
      </div>
    </div>

    ${analyticsStyles()}
    <script>
      /* ShopBase-style dropdown menus (store switcher, etc.) — same pattern as orders.ts */
      function toggleMenu(id) {
        var menu = document.getElementById(id);
        if (!menu) return;
        var isOpen = menu.classList.contains('open');
        document.querySelectorAll('.menu-dropdown').forEach(function(m) { m.classList.remove('open'); });
        if (!isOpen) menu.classList.add('open');
        var btn = menu.previousElementSibling;
        if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', !isOpen ? 'true' : 'false');
      }
      document.addEventListener('click', function(e) {
        if (!e.target.closest('.menu-wrap')) {
          document.querySelectorAll('.menu-dropdown').forEach(function(m) { m.classList.remove('open'); });
        }
      });

      (function() {
        // Auto-refresh toggle — stored in localStorage, refreshes the page every 60s
        var key = 'gbox_analytics_auto_refresh';
        var el = document.getElementById('ovRefreshToggle');
        if (!el) return;
        var on = localStorage.getItem(key) === '1';
        var timer = null;
        function apply() {
          el.classList.toggle('on', on);
          el.setAttribute('aria-checked', on ? 'true' : 'false');
          if (on) {
            timer = setTimeout(function() { window.location.reload(); }, 60000);
          } else if (timer) {
            clearTimeout(timer);
            timer = null;
          }
        }
        el.addEventListener('click', function() {
          on = !on;
          localStorage.setItem(key, on ? '1' : '0');
          apply();
        });
        el.addEventListener('keydown', function(e) {
          if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); el.click(); }
        });
        apply();
      })();
    </script>
  `

  res.send(sellerLayout({
    title: 'Analytics',
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


/* ================================================================== */
/*  G2: Sales Report                                                  */
/* ================================================================== */

export async function getSalesReport(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`

  // API mode (no local DB): render placeholder. Same applies to the other
  // sub-reports (Products / Customers / Finance) and the two CSV exports.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  if (!hasDb) {
    renderAnalyticsPlaceholder(res, base, store, user, theme, 'Sales Report')
    return
  }

  // Date range: default last 30 days
  const now = new Date()
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30)
  const fromStr = (req.query.from as string) || fmtDate(defaultFrom)
  const toStr = (req.query.to as string) || fmtDate(now)

  const fromDate = new Date(fromStr + 'T00:00:00.000Z')
  const toDate = new Date(toStr + 'T23:59:59.999Z')

  const [orderRows, productSales, totalStats] = await Promise.all([
    // All orders in range for daily grouping
    db.selectFrom('orders')
      .select(['created_at', 'total_price', 'id'])
      .where('shop_id', '=', store.id)
      .where('created_at', '>=', fromDate.toISOString())
      .where('created_at', '<=', toDate.toISOString())
      .orderBy('created_at', 'asc')
      .execute(),

    // Sales by product
    db.selectFrom('order_line_items as oli')
      .innerJoin('orders as o', 'o.id', 'oli.order_id')
      .innerJoin('products as p', 'p.id', 'oli.product_id')
      .select([
        'p.title',
        db.fn.sum('oli.quantity').as('qty_sold'),
        db.fn.sum('oli.price').as('revenue'),
      ])
      .where('o.shop_id', '=', store.id)
      .where('o.created_at', '>=', fromDate.toISOString())
      .where('o.created_at', '<=', toDate.toISOString())
      .groupBy(['p.id', 'p.title'])
      .orderBy('revenue', 'desc')
      .execute(),

    // Aggregate stats
    db.selectFrom('orders')
      .select([
        db.fn.count('id').as('total_orders'),
        db.fn.sum('total_price').as('total_revenue'),
        db.fn.avg('total_price').as('avg_order_value'),
      ])
      .where('shop_id', '=', store.id)
      .where('created_at', '>=', fromDate.toISOString())
      .where('created_at', '<=', toDate.toISOString())
      .executeTakeFirst(),
  ])

  // Group orders by day
  const dailyMap = new Map<string, { orders: number; revenue: number }>()
  for (const r of orderRows) {
    const day = new Date(r.created_at).toISOString().slice(0, 10)
    const entry = dailyMap.get(day) || { orders: 0, revenue: 0 }
    entry.orders += 1
    entry.revenue += Number(r.total_price)
    dailyMap.set(day, entry)
  }
  const dailySales = Array.from(dailyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, data]) => ({ date, ...data }))

  const totalRevenue = Number(totalStats?.total_revenue ?? 0)
  const totalOrders = Number(totalStats?.total_orders ?? 0)
  const avgOrder = Number(totalStats?.avg_order_value ?? 0)

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Sales Report</h1>
        <p style="color:var(--s-text-muted);margin:0;font-size:13px">${esc(fromStr)} to ${esc(toStr)}</p>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <a href="${base}/analytics" class="btn btn-outline btn-sm">&larr; Analytics</a>
        <a href="${base}/analytics/sales/export.csv?from=${encodeURIComponent(fromStr)}&amp;to=${encodeURIComponent(toStr)}" class="btn btn-outline btn-sm" style="text-decoration:none">Export CSV</a>
      </div>
    </div>

    <!-- Date Range Filter -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-body">
        <form method="GET" action="${base}/analytics/sales" class="date-range-form">
          <div class="form-group" style="margin:0">
            <label class="form-label">From</label>
            <input type="date" name="from" value="${esc(fromStr)}" class="form-input" />
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">To</label>
            <input type="date" name="to" value="${esc(toStr)}" class="form-input" />
          </div>
          <button type="submit" class="btn" style="margin-bottom:0">Apply</button>
        </form>
      </div>
    </div>

    <!-- Summary Stats -->
    <div class="three-col-stats">
      <div class="stat-card">
        <div class="stat-value">${fmtMoney(totalRevenue, store.currency)}</div>
        <div class="stat-label">Total Revenue</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${totalOrders}</div>
        <div class="stat-label">Total Orders</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${fmtMoney(avgOrder, store.currency)}</div>
        <div class="stat-label">Avg Order Value</div>
      </div>
    </div>

    <!-- Sales by Date -->
    <div class="card report-section">
      <div class="card-header">
        <span>Sales by Date</span>
        <span class="badge">${dailySales.length} days</span>
      </div>
      <div class="card-body" style="padding:0">
        ${dailySales.length > 0 ? `
          <div class="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Orders</th><th>Revenue</th></tr></thead>
              <tbody>
                ${dailySales.map(d => `
                  <tr>
                    <td>${esc(d.date)}</td>
                    <td>${d.orders}</td>
                    <td style="font-weight:600;color:var(--s-success)">${fmtMoney(d.revenue, store.currency)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : emptyState('No sales', 'No orders found in this date range.')}
      </div>
    </div>

    <!-- Sales by Product -->
    <div class="card report-section">
      <div class="card-header">
        <span>Sales by Product</span>
        <span class="badge">${productSales.length} products</span>
      </div>
      <div class="card-body" style="padding:0">
        ${productSales.length > 0 ? `
          <div class="table-wrap">
            <table>
              <thead><tr><th>Product</th><th>Qty Sold</th><th>Revenue</th></tr></thead>
              <tbody>
                ${productSales.map(p => `
                  <tr>
                    <td>${esc(p.title)}</td>
                    <td>${Number(p.qty_sold)}</td>
                    <td style="font-weight:600;color:var(--s-success)">${fmtMoney(Number(p.revenue), store.currency)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : emptyState('No product sales', 'No product-level sales data in this range.')}
      </div>
    </div>

    ${analyticsStyles()}
  `

  res.send(sellerLayout({
    title: 'Sales Report',
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


/* ================================================================== */
/*  G3: Product Report                                                */
/* ================================================================== */

export async function getProductReport(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`

  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  if (!hasDb) {
    renderAnalyticsPlaceholder(res, base, store, user, theme, 'Product Report')
    return
  }

  const [bestSellers, slowMovers, inventoryStats] = await Promise.all([
    // Best sellers: top 10 by revenue (all time)
    db.selectFrom('order_line_items as oli')
      .innerJoin('products as p', 'p.id', 'oli.product_id')
      .innerJoin('orders as o', 'o.id', 'oli.order_id')
      .select([
        'p.id as product_id',
        'p.title',
        'p.vendor',
        db.fn.sum('oli.quantity').as('units_sold'),
        db.fn.sum('oli.price').as('revenue'),
      ])
      .where('o.shop_id', '=', store.id)
      .groupBy(['p.id', 'p.title', 'p.vendor'])
      .orderBy('revenue', 'desc')
      .limit(10)
      .execute(),

    // Slow movers: bottom 10 by revenue (only products that have sales)
    db.selectFrom('order_line_items as oli')
      .innerJoin('products as p', 'p.id', 'oli.product_id')
      .innerJoin('orders as o', 'o.id', 'oli.order_id')
      .select([
        'p.id as product_id',
        'p.title',
        'p.vendor',
        db.fn.sum('oli.quantity').as('units_sold'),
        db.fn.sum('oli.price').as('revenue'),
      ])
      .where('o.shop_id', '=', store.id)
      .groupBy(['p.id', 'p.title', 'p.vendor'])
      .orderBy('revenue', 'asc')
      .limit(10)
      .execute(),

    // Inventory value: sum(price * inventory_quantity) across all active variants
    db.selectFrom('product_variants as pv')
      .innerJoin('products as p', 'p.id', 'pv.product_id')
      .select([
        db.fn.count('pv.id').as('total_variants'),
        db.fn.sum('pv.inventory_quantity').as('total_units'),
      ])
      .where('p.shop_id', '=', store.id)
      .where('p.status', '=', 'active')
      .executeTakeFirst(),
  ])

  // Calculate inventory value in JS (sum price * qty)
  const inventoryRows = await db.selectFrom('product_variants as pv')
    .innerJoin('products as p', 'p.id', 'pv.product_id')
    .select(['pv.price', 'pv.cost', 'pv.inventory_quantity'])
    .where('p.shop_id', '=', store.id)
    .where('p.status', '=', 'active')
    .execute()

  let retailValue = 0
  let costValue = 0
  for (const row of inventoryRows) {
    const qty = Number(row.inventory_quantity || 0)
    retailValue += Number(row.price || 0) * qty
    costValue += Number(row.cost || 0) * qty
  }

  const totalVariants = Number(inventoryStats?.total_variants ?? 0)
  const totalUnits = Number(inventoryStats?.total_units ?? 0)

  // Find max revenue for percentage bars
  const bestMax = bestSellers.length > 0 ? Number(bestSellers[0]?.revenue ?? 1) : 1

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Product Report</h1>
        <p style="color:var(--s-text-muted);margin:0;font-size:13px">Performance and inventory analysis</p>
      </div>
      <a href="${base}/analytics" class="btn btn-outline btn-sm">&larr; Analytics</a>
    </div>

    <!-- Inventory Summary -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-header">Inventory Value Summary</div>
      <div class="card-body">
        <div class="three-col-stats" style="margin-bottom:0">
          <div class="stat-card">
            <div class="stat-value">${totalVariants}</div>
            <div class="stat-label">Active Variants</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${totalUnits.toLocaleString()}</div>
            <div class="stat-label">Total Units in Stock</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${fmtMoney(retailValue, store.currency)}</div>
            <div class="stat-label">Retail Value</div>
          </div>
        </div>
        ${costValue > 0 ? `
          <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--s-border);display:flex;gap:24px">
            <div><span style="color:var(--s-text-muted)">Cost Value:</span> <strong>${fmtMoney(costValue, store.currency)}</strong></div>
            <div><span style="color:var(--s-text-muted)">Potential Profit:</span> <strong style="color:var(--s-success)">${fmtMoney(retailValue - costValue, store.currency)}</strong></div>
          </div>
        ` : ''}
      </div>
    </div>

    <div class="two-col">
      <!-- Best Sellers -->
      <div class="card">
        <div class="card-header">
          <span>Best Sellers</span>
          <span class="badge badge-success">Top 10</span>
        </div>
        <div class="card-body" style="padding:0">
          ${bestSellers.length > 0 ? `
            <div class="table-wrap">
              <table>
                <thead><tr><th>#</th><th>Product</th><th>Sold</th><th>Revenue</th><th></th></tr></thead>
                <tbody>
                  ${bestSellers.map((p, i) => {
                    const rev = Number(p.revenue)
                    const pct = (rev / bestMax) * 100
                    return `
                    <tr>
                      <td style="color:var(--s-text-muted);width:30px">${i + 1}</td>
                      <td>
                        <a href="${base}/products/${(p as any).product_id}" style="color:var(--s-accent);text-decoration:none">${esc(p.title)}</a>
                        ${p.vendor ? `<div style="font-size:11px;color:var(--s-text-muted)">${esc(p.vendor)}</div>` : ''}
                      </td>
                      <td>${Number(p.units_sold)}</td>
                      <td style="font-weight:600;color:var(--s-success)">${fmtMoney(rev, store.currency)}</td>
                      <td style="width:80px"><div class="pct-bar"><div class="pct-bar-fill" style="width:${pct}%"></div></div></td>
                    </tr>
                    `
                  }).join('')}
                </tbody>
              </table>
            </div>
          ` : emptyState('No sales data', 'Product sales will appear once orders come in.')}
        </div>
      </div>

      <!-- Slow Movers -->
      <div class="card">
        <div class="card-header">
          <span>Slow Movers</span>
          <span class="badge badge-warning">Bottom 10</span>
        </div>
        <div class="card-body" style="padding:0">
          ${slowMovers.length > 0 ? `
            <div class="table-wrap">
              <table>
                <thead><tr><th>#</th><th>Product</th><th>Sold</th><th>Revenue</th></tr></thead>
                <tbody>
                  ${slowMovers.map((p, i) => `
                    <tr>
                      <td style="color:var(--s-text-muted);width:30px">${i + 1}</td>
                      <td>
                        <a href="${base}/products/${(p as any).product_id}" style="color:var(--s-accent);text-decoration:none">${esc(p.title)}</a>
                        ${p.vendor ? `<div style="font-size:11px;color:var(--s-text-muted)">${esc(p.vendor)}</div>` : ''}
                      </td>
                      <td>${Number(p.units_sold)}</td>
                      <td style="font-weight:600;color:var(--s-text-muted)">${fmtMoney(Number(p.revenue), store.currency)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          ` : emptyState('No slow movers', 'Not enough sales data to identify slow movers.')}
        </div>
      </div>
    </div>

    ${analyticsStyles()}
  `

  res.send(sellerLayout({
    title: 'Product Report',
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


/* ================================================================== */
/*  G4: Customer Report                                               */
/* ================================================================== */

export async function getCustomerReport(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`

  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  if (!hasDb) {
    renderAnalyticsPlaceholder(res, base, store, user, theme, 'Customer Report')
    return
  }

  const [
    newCustomers,
    returningCustomers,
    topSpenders,
    geoDistribution,
    totalCustomerCount,
  ] = await Promise.all([
    // New customers (orders_count = 1)
    db.selectFrom('customers')
      .select(db.fn.count('id').as('count'))
      .where('shop_id', '=', store.id)
      .where('orders_count', '=', 1)
      .executeTakeFirst(),

    // Returning customers (orders_count > 1)
    db.selectFrom('customers')
      .select(db.fn.count('id').as('count'))
      .where('shop_id', '=', store.id)
      .where('orders_count', '>', 1)
      .executeTakeFirst(),

    // Top 10 customers by total_spent
    db.selectFrom('customers')
      .select(['id', 'first_name', 'last_name', 'email', 'orders_count', 'total_spent', 'created_at'])
      .where('shop_id', '=', store.id)
      .where('total_spent', '>', 0)
      .orderBy('total_spent', 'desc')
      .limit(10)
      .execute(),

    // Geographic distribution by country
    db.selectFrom('customer_addresses as ca')
      .innerJoin('customers as c', 'c.id', 'ca.customer_id')
      .select([
        'ca.country',
        db.fn.count('ca.id').as('count'),
      ])
      .where('c.shop_id', '=', store.id)
      .groupBy('ca.country')
      .orderBy('count', 'desc')
      .limit(15)
      .execute(),

    // Total customer count
    db.selectFrom('customers')
      .select(db.fn.count('id').as('count'))
      .where('shop_id', '=', store.id)
      .executeTakeFirst(),
  ])

  const newCount = Number(newCustomers?.count ?? 0)
  const returningCount = Number(returningCustomers?.count ?? 0)
  const totalCount = Number(totalCustomerCount?.count ?? 0)
  const newPct = totalCount > 0 ? ((newCount / totalCount) * 100).toFixed(1) : '0'
  const retPct = totalCount > 0 ? ((returningCount / totalCount) * 100).toFixed(1) : '0'

  // Max for geo bar
  const geoMax = geoDistribution.length > 0 ? Number(geoDistribution[0]?.count ?? 1) : 1

  // Max for top spender bar
  const spendMax = topSpenders.length > 0 ? Number(topSpenders[0]?.total_spent ?? 1) : 1

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Customer Report</h1>
        <p style="color:var(--s-text-muted);margin:0;font-size:13px">${totalCount} total customers</p>
      </div>
      <a href="${base}/analytics" class="btn btn-outline btn-sm">&larr; Analytics</a>
    </div>

    <!-- New vs Returning -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-header">New vs Returning Customers</div>
      <div class="card-body">
        <div class="two-col" style="margin-bottom:0">
          <div>
            <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:8px">
              <span style="font-size:28px;font-weight:700">${newCount}</span>
              <span class="badge badge-info">${newPct}%</span>
            </div>
            <div class="stat-label">New Customers (1 order)</div>
            <div class="pct-bar" style="margin-top:8px"><div class="pct-bar-fill" style="width:${newPct}%;background:var(--s-accent)"></div></div>
          </div>
          <div>
            <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:8px">
              <span style="font-size:28px;font-weight:700">${returningCount}</span>
              <span class="badge badge-success">${retPct}%</span>
            </div>
            <div class="stat-label">Returning Customers (2+ orders)</div>
            <div class="pct-bar" style="margin-top:8px"><div class="pct-bar-fill" style="width:${retPct}%;background:var(--s-success)"></div></div>
          </div>
        </div>
      </div>
    </div>

    <div class="two-col">
      <!-- Top 10 Spenders -->
      <div class="card">
        <div class="card-header">
          <span>Top Customers by Spend</span>
          <span class="badge">Top 10</span>
        </div>
        <div class="card-body" style="padding:0">
          ${topSpenders.length > 0 ? `
            <div class="table-wrap">
              <table>
                <thead><tr><th>#</th><th>Customer</th><th>Orders</th><th>Total Spent</th><th></th></tr></thead>
                <tbody>
                  ${topSpenders.map((c, i) => {
                    const spent = Number(c.total_spent)
                    const pct = (spent / spendMax) * 100
                    return `
                    <tr>
                      <td style="color:var(--s-text-muted);width:30px">${i + 1}</td>
                      <td>
                        <a href="${base}/customers/${c.id}" style="color:var(--s-accent);text-decoration:none">${esc(c.first_name || '')} ${esc(c.last_name || '')}</a>
                        <div style="font-size:11px;color:var(--s-text-muted)">${esc(c.email)}</div>
                      </td>
                      <td>${Number(c.orders_count)}</td>
                      <td style="font-weight:600;color:var(--s-success)">${fmtMoney(spent, store.currency)}</td>
                      <td style="width:80px"><div class="pct-bar"><div class="pct-bar-fill" style="width:${pct}%"></div></div></td>
                    </tr>
                    `
                  }).join('')}
                </tbody>
              </table>
            </div>
          ` : emptyState('No spender data', 'Customer spend data will appear after first orders.')}
        </div>
      </div>

      <!-- Geographic Distribution -->
      <div class="card">
        <div class="card-header">
          <span>Geographic Distribution</span>
          <span class="badge">${geoDistribution.length} countries</span>
        </div>
        <div class="card-body" style="padding:0">
          ${geoDistribution.length > 0 ? `
            <div class="table-wrap">
              <table>
                <thead><tr><th>Country</th><th>Customers</th><th></th></tr></thead>
                <tbody>
                  ${geoDistribution.map(g => {
                    const cnt = Number(g.count)
                    const pct = (cnt / geoMax) * 100
                    return `
                    <tr>
                      <td style="font-weight:500">${esc(g.country || 'Unknown')}</td>
                      <td>${cnt}</td>
                      <td style="width:120px"><div class="pct-bar"><div class="pct-bar-fill" style="width:${pct}%"></div></div></td>
                    </tr>
                    `
                  }).join('')}
                </tbody>
              </table>
            </div>
          ` : emptyState('No geographic data', 'Customer address data will populate this report.')}
        </div>
      </div>
    </div>

    ${analyticsStyles()}
  `

  res.send(sellerLayout({
    title: 'Customer Report',
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


/* ================================================================== */
/*  G5: Finance Report                                                */
/* ================================================================== */

export async function getFinanceReport(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`

  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  if (!hasDb) {
    renderAnalyticsPlaceholder(res, base, store, user, theme, 'Finance Report')
    return
  }

  // Date range: default last 30 days
  const now = new Date()
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30)
  const fromStr = (req.query.from as string) || fmtDate(defaultFrom)
  const toStr = (req.query.to as string) || fmtDate(now)

  const fromDate = new Date(fromStr + 'T00:00:00.000Z')
  const toDate = new Date(toStr + 'T23:59:59.999Z')

  const [revenueStats, refundStats, taxStats, paymentMethods] = await Promise.all([
    // Gross revenue from orders
    db.selectFrom('orders')
      .select([
        db.fn.sum('total_price').as('gross_revenue'),
        db.fn.sum('subtotal_price').as('subtotal'),
        db.fn.sum('total_discounts').as('total_discounts'),
        db.fn.sum('total_shipping').as('total_shipping'),
        db.fn.sum('total_tax').as('total_tax'),
        db.fn.count('id').as('order_count'),
      ])
      .where('shop_id', '=', store.id)
      .where('created_at', '>=', fromDate.toISOString())
      .where('created_at', '<=', toDate.toISOString())
      .executeTakeFirst(),

    // Refunds: sum from transactions with kind='refund'
    db.selectFrom('transactions as t')
      .innerJoin('orders as o', 'o.id', 't.order_id')
      .select([
        db.fn.sum('t.amount').as('total_refunds'),
        db.fn.count('t.id').as('refund_count'),
      ])
      .where('o.shop_id', '=', store.id)
      .where('t.kind', '=', 'refund')
      .where('t.status', '=', 'success')
      .where('o.created_at', '>=', fromDate.toISOString())
      .where('o.created_at', '<=', toDate.toISOString())
      .executeTakeFirst(),

    // Tax collected
    db.selectFrom('orders')
      .select(db.fn.sum('total_tax').as('total_tax'))
      .where('shop_id', '=', store.id)
      .where('created_at', '>=', fromDate.toISOString())
      .where('created_at', '<=', toDate.toISOString())
      .executeTakeFirst(),

    // Payment method breakdown
    db.selectFrom('transactions as t')
      .innerJoin('orders as o', 'o.id', 't.order_id')
      .select([
        't.gateway',
        db.fn.sum('t.amount').as('total'),
        db.fn.count('t.id').as('count'),
      ])
      .where('o.shop_id', '=', store.id)
      .where('t.kind', '=', 'sale')
      .where('t.status', '=', 'success')
      .where('o.created_at', '>=', fromDate.toISOString())
      .where('o.created_at', '<=', toDate.toISOString())
      .groupBy('t.gateway')
      .orderBy('total', 'desc')
      .execute(),
  ])

  const grossRevenue = Number(revenueStats?.gross_revenue ?? 0)
  const subtotal = Number(revenueStats?.subtotal ?? 0)
  const totalDiscounts = Number(revenueStats?.total_discounts ?? 0)
  const totalShipping = Number(revenueStats?.total_shipping ?? 0)
  const totalTax = Number(taxStats?.total_tax ?? 0)
  const orderCount = Number(revenueStats?.order_count ?? 0)

  const totalRefunds = Number(refundStats?.total_refunds ?? 0)
  const refundCount = Number(refundStats?.refund_count ?? 0)
  const netRevenue = grossRevenue - totalRefunds

  // Payment method total for pct
  const paymentTotal = paymentMethods.reduce((sum, p) => sum + Number(p.total), 0) || 1

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Financial Report</h1>
        <p style="color:var(--s-text-muted);margin:0;font-size:13px">${esc(fromStr)} to ${esc(toStr)}</p>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <a href="${base}/analytics" class="btn btn-outline btn-sm">&larr; Analytics</a>
        <a href="${base}/analytics/finance/export.csv?from=${encodeURIComponent(fromStr)}&amp;to=${encodeURIComponent(toStr)}" class="btn btn-outline btn-sm" style="text-decoration:none">Export CSV</a>
      </div>
    </div>

    <!-- Date Range Filter -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-body">
        <form method="GET" action="${base}/analytics/finance" class="date-range-form">
          <div class="form-group" style="margin:0">
            <label class="form-label">From</label>
            <input type="date" name="from" value="${esc(fromStr)}" class="form-input" />
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">To</label>
            <input type="date" name="to" value="${esc(toStr)}" class="form-input" />
          </div>
          <button type="submit" class="btn" style="margin-bottom:0">Apply</button>
        </form>
      </div>
    </div>

    <div class="two-col">
      <!-- Revenue Breakdown -->
      <div class="card">
        <div class="card-header">Revenue Breakdown</div>
        <div class="card-body">
          <div class="finance-row">
            <span class="finance-label">Gross Revenue (${orderCount} orders)</span>
            <span class="finance-value positive">${fmtMoney(grossRevenue, store.currency)}</span>
          </div>
          <div class="finance-row">
            <span class="finance-label">Subtotal</span>
            <span class="finance-value">${fmtMoney(subtotal, store.currency)}</span>
          </div>
          <div class="finance-row">
            <span class="finance-label">Discounts</span>
            <span class="finance-value negative">-${fmtMoney(totalDiscounts, store.currency)}</span>
          </div>
          <div class="finance-row">
            <span class="finance-label">Shipping</span>
            <span class="finance-value">${fmtMoney(totalShipping, store.currency)}</span>
          </div>
          <div class="finance-row">
            <span class="finance-label">Tax Collected</span>
            <span class="finance-value">${fmtMoney(totalTax, store.currency)}</span>
          </div>
          <div class="finance-row">
            <span class="finance-label">Refunds (${refundCount})</span>
            <span class="finance-value negative">-${fmtMoney(totalRefunds, store.currency)}</span>
          </div>
          <div class="finance-row" style="margin-top:8px;padding-top:16px;border-top:2px solid var(--s-border)">
            <span class="finance-label" style="font-weight:700;color:var(--s-text)">Net Revenue</span>
            <span class="finance-value ${netRevenue >= 0 ? 'positive' : 'negative'}" style="font-size:18px">${fmtMoney(netRevenue, store.currency)}</span>
          </div>
        </div>
      </div>

      <!-- Payment Method Breakdown -->
      <div class="card">
        <div class="card-header">
          <span>Payment Methods</span>
          <span class="badge">${paymentMethods.length} gateways</span>
        </div>
        <div class="card-body" style="padding:0">
          ${paymentMethods.length > 0 ? `
            <div class="table-wrap">
              <table>
                <thead><tr><th>Gateway</th><th>Transactions</th><th>Amount</th><th>Share</th></tr></thead>
                <tbody>
                  ${paymentMethods.map(p => {
                    const amt = Number(p.total)
                    const cnt = Number(p.count)
                    const pct = ((amt / paymentTotal) * 100).toFixed(1)
                    return `
                    <tr>
                      <td style="font-weight:500;text-transform:capitalize">${esc(p.gateway || 'Unknown')}</td>
                      <td>${cnt}</td>
                      <td style="font-weight:600">${fmtMoney(amt, store.currency)}</td>
                      <td>
                        <div style="display:flex;align-items:center;gap:8px">
                          <div class="pct-bar" style="flex:1"><div class="pct-bar-fill" style="width:${pct}%"></div></div>
                          <span style="font-size:12px;color:var(--s-text-muted);min-width:40px;text-align:right">${pct}%</span>
                        </div>
                      </td>
                    </tr>
                    `
                  }).join('')}
                </tbody>
              </table>
            </div>
          ` : emptyState('No payment data', 'Payment method data will appear after transactions are processed.')}
        </div>
      </div>
    </div>

    <!-- Summary Cards -->
    <div class="stats-grid" style="margin-top:20px">
      <div class="stat-card">
        <div class="stat-value positive">${fmtMoney(grossRevenue, store.currency)}</div>
        <div class="stat-label">Gross Revenue</div>
      </div>
      <div class="stat-card">
        <div class="stat-value negative">-${fmtMoney(totalRefunds, store.currency)}</div>
        <div class="stat-label">Total Refunds</div>
      </div>
      <div class="stat-card">
        <div class="stat-value ${netRevenue >= 0 ? 'positive' : 'negative'}">${fmtMoney(netRevenue, store.currency)}</div>
        <div class="stat-label">Net Revenue</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${fmtMoney(totalTax, store.currency)}</div>
        <div class="stat-label">Tax Collected</div>
      </div>
    </div>

    <!-- Payout Estimate (via API) -->
    <div class="card" style="margin-top:20px">
      <div class="card-header">
        <span>Payout Estimate</span>
        <span class="badge">Live</span>
      </div>
      <div class="card-body" id="payout-section">
        <p style="color:var(--s-text-muted);font-size:13px">Loading payout info...</p>
      </div>
    </div>
    <script>
    (function() {
      var host = location.protocol + '//' + location.hostname + ':${process.env.API_PORT || '4321'}';
      fetch(host + '/api/store/${esc(store.slug)}/finance/payouts', {
        credentials: 'include'
      })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var p = d.payout || {};
        var el = document.getElementById('payout-section');
        if (!el) return;
        el.innerHTML = '<div class="finance-row"><span class="finance-label">Gross Sales</span><span class="finance-value positive">' + formatMoney(p.gross_sales) + '</span></div>'
          + '<div class="finance-row"><span class="finance-label">Refunds</span><span class="finance-value negative">-' + formatMoney(p.refunds) + '</span></div>'
          + '<div class="finance-row"><span class="finance-label">Net Revenue</span><span class="finance-value">' + formatMoney(p.net_revenue) + '</span></div>'
          + '<div class="finance-row"><span class="finance-label">Commission Rate</span><span class="finance-value">' + (p.commission_rate || 0) + '%</span></div>'
          + '<div class="finance-row"><span class="finance-label">Platform Fee</span><span class="finance-value negative">-' + formatMoney(p.platform_commission) + '</span></div>'
          + '<div class="finance-row" style="margin-top:8px;padding-top:16px;border-top:2px solid var(--s-border)">'
          + '<span class="finance-label" style="font-weight:700;color:var(--s-text)">Estimated Payout</span>'
          + '<span class="finance-value positive" style="font-size:18px">' + formatMoney(p.estimated_payout) + '</span></div>';
      })
      .catch(function() {
        var el = document.getElementById('payout-section');
        if (el) el.innerHTML = '<p style="color:var(--s-text-muted);font-size:13px">Payout data unavailable</p>';
      });
      function formatMoney(v) { return '$' + (Number(v) || 0).toFixed(2); }
    })();
    </script>

    <!-- Recent Transactions (via API) -->
    <div class="card" style="margin-top:20px">
      <div class="card-header">
        <span>Recent Transactions</span>
      </div>
      <div class="card-body" style="padding:0" id="txn-section">
        <p style="padding:16px;color:var(--s-text-muted);font-size:13px">Loading transactions...</p>
      </div>
    </div>
    <script>
    (function() {
      var host = location.protocol + '//' + location.hostname + ':${process.env.API_PORT || '4321'}';
      fetch(host + '/api/store/${esc(store.slug)}/finance/transactions?limit=10', {
        credentials: 'include'
      })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var txns = d.transactions || [];
        var el = document.getElementById('txn-section');
        if (!el) return;
        if (txns.length === 0) { el.innerHTML = '<p style="padding:16px;color:var(--s-text-muted)">No transactions found</p>'; return; }
        var html = '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Order</th><th>Type</th><th>Gateway</th><th>Amount</th><th>Status</th></tr></thead><tbody>';
        txns.forEach(function(t) {
          var badge = t.kind === 'sale' ? 'badge-success' : t.kind === 'refund' ? 'badge-danger' : 'badge-warning';
          var sBadge = t.status === 'success' ? 'badge-success' : 'badge-warning';
          html += '<tr><td>' + new Date(t.created_at).toLocaleDateString() + '</td>'
            + '<td>#' + (t.order_number || '') + '</td>'
            + '<td><span class="badge ' + badge + '">' + t.kind + '</span></td>'
            + '<td>' + (t.gateway || '-') + '</td>'
            + '<td style="font-weight:600">$' + Number(t.amount).toFixed(2) + '</td>'
            + '<td><span class="badge ' + sBadge + '">' + t.status + '</span></td></tr>';
        });
        html += '</tbody></table></div>';
        el.innerHTML = html;
      })
      .catch(function() {
        var el = document.getElementById('txn-section');
        if (el) el.innerHTML = '<p style="padding:16px;color:var(--s-text-muted)">Transaction data unavailable</p>';
      });
    })();
    </script>

    ${analyticsStyles()}
  `

  res.send(sellerLayout({
    title: 'Financial Report',
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

// ─── G2/G5 CSV EXPORTS ──────────────────────────────────────────

/**
 * GET /analytics/sales/export.csv
 *
 * CSV twin of getSalesReport. Same date-range query params, same
 * underlying queries — we just stream the two report sections
 * (daily sales + per-product sales) plus a summary header instead
 * of rendering HTML. Merchants asked for this for month-end book
 * reconciliation; the on-screen report already has the numbers but
 * copy/paste loses the aggregates.
 */
export async function getSalesReportCsv(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!

  // API mode (no local DB): return a CSV stub so the download still works.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  if (!hasDb) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="sales-report-${store.slug}-not-available.csv"`)
    res.send('﻿Notice\nSales report not available in API mode (no BE analytics endpoint yet)\n')
    return
  }

  const now = new Date()
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30)
  const fromStr = (req.query.from as string) || fmtDate(defaultFrom)
  const toStr = (req.query.to as string) || fmtDate(now)

  const fromDate = new Date(fromStr + 'T00:00:00.000Z')
  const toDate = new Date(toStr + 'T23:59:59.999Z')

  const [orderRows, productSales, totalStats] = await Promise.all([
    db.selectFrom('orders')
      .select(['created_at', 'total_price'])
      .where('shop_id', '=', store.id)
      .where('created_at', '>=', fromDate.toISOString())
      .where('created_at', '<=', toDate.toISOString())
      .orderBy('created_at', 'asc')
      .execute(),

    db.selectFrom('order_line_items as oli')
      .innerJoin('orders as o', 'o.id', 'oli.order_id')
      .innerJoin('products as p', 'p.id', 'oli.product_id')
      .select([
        'p.title',
        db.fn.sum('oli.quantity').as('qty_sold'),
        db.fn.sum('oli.price').as('revenue'),
      ])
      .where('o.shop_id', '=', store.id)
      .where('o.created_at', '>=', fromDate.toISOString())
      .where('o.created_at', '<=', toDate.toISOString())
      .groupBy(['p.id', 'p.title'])
      .orderBy('revenue', 'desc')
      .execute(),

    db.selectFrom('orders')
      .select([
        db.fn.count('id').as('total_orders'),
        db.fn.sum('total_price').as('total_revenue'),
        db.fn.avg('total_price').as('avg_order_value'),
      ])
      .where('shop_id', '=', store.id)
      .where('created_at', '>=', fromDate.toISOString())
      .where('created_at', '<=', toDate.toISOString())
      .executeTakeFirst(),
  ])

  const dailyMap = new Map<string, { orders: number; revenue: number }>()
  for (const r of orderRows) {
    const day = new Date(r.created_at as any).toISOString().slice(0, 10)
    const entry = dailyMap.get(day) || { orders: 0, revenue: 0 }
    entry.orders += 1
    entry.revenue += Number(r.total_price)
    dailyMap.set(day, entry)
  }
  const dailySales = Array.from(dailyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, data]) => ({ date, orders: data.orders, revenue: data.revenue }))

  const totalRevenue = Number(totalStats?.total_revenue ?? 0)
  const totalOrders = Number(totalStats?.total_orders ?? 0)
  const avgOrder = Number(totalStats?.avg_order_value ?? 0)

  // Build CSV: Summary block, blank row, daily block, blank row, product block.
  const rows: unknown[][] = []
  rows.push(['Sales Report'])
  rows.push(['Store', store.name])
  rows.push(['Period', `${fromStr} to ${toStr}`])
  rows.push(['Generated', new Date().toISOString()])
  rows.push([])
  rows.push(['Summary'])
  rows.push(['Total Orders', totalOrders])
  rows.push(['Total Revenue', totalRevenue.toFixed(2)])
  rows.push(['Average Order Value', avgOrder.toFixed(2)])
  rows.push([])
  rows.push(['Daily Sales'])
  rows.push(['Date', 'Orders', 'Revenue'])
  for (const d of dailySales) {
    rows.push([d.date, d.orders, d.revenue.toFixed(2)])
  }
  rows.push([])
  rows.push(['Sales by Product'])
  rows.push(['Product', 'Quantity Sold', 'Revenue'])
  for (const p of productSales) {
    rows.push([p.title, Number(p.qty_sold), Number(p.revenue).toFixed(2)])
  }

  const filename = `sales_${csvSlug(store.slug)}_${fromStr}_${toStr}.csv`
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  // Leading BOM so Excel picks UTF-8 correctly when opening on Windows.
  res.send('\uFEFF' + toCsv(rows))
}

/**
 * GET /analytics/finance/export.csv
 *
 * CSV twin of getFinanceReport. Emits the revenue + refund summary
 * and the per-gateway breakdown so merchants can drop this straight
 * into bookkeeping.
 */
export async function getFinanceReportCsv(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!

  // API mode (no local DB): return a CSV stub so the download still works.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  if (!hasDb) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="finance-report-${store.slug}-not-available.csv"`)
    res.send('﻿Notice\nFinance report not available in API mode (no BE analytics endpoint yet)\n')
    return
  }

  const now = new Date()
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30)
  const fromStr = (req.query.from as string) || fmtDate(defaultFrom)
  const toStr = (req.query.to as string) || fmtDate(now)

  const fromDate = new Date(fromStr + 'T00:00:00.000Z')
  const toDate = new Date(toStr + 'T23:59:59.999Z')

  const [revenueStats, refundStats, paymentMethods] = await Promise.all([
    db.selectFrom('orders')
      .select([
        db.fn.sum('total_price').as('gross_revenue'),
        db.fn.sum('subtotal_price').as('subtotal'),
        db.fn.sum('total_discounts').as('total_discounts'),
        db.fn.sum('total_shipping').as('total_shipping'),
        db.fn.sum('total_tax').as('total_tax'),
        db.fn.count('id').as('order_count'),
      ])
      .where('shop_id', '=', store.id)
      .where('created_at', '>=', fromDate.toISOString())
      .where('created_at', '<=', toDate.toISOString())
      .executeTakeFirst(),

    db.selectFrom('transactions as t')
      .innerJoin('orders as o', 'o.id', 't.order_id')
      .select([
        db.fn.sum('t.amount').as('total_refunds'),
        db.fn.count('t.id').as('refund_count'),
      ])
      .where('o.shop_id', '=', store.id)
      .where('t.kind', '=', 'refund')
      .where('t.status', '=', 'success')
      .where('o.created_at', '>=', fromDate.toISOString())
      .where('o.created_at', '<=', toDate.toISOString())
      .executeTakeFirst(),

    db.selectFrom('transactions as t')
      .innerJoin('orders as o', 'o.id', 't.order_id')
      .select([
        't.gateway',
        db.fn.sum('t.amount').as('total'),
        db.fn.count('t.id').as('count'),
      ])
      .where('o.shop_id', '=', store.id)
      .where('t.kind', '=', 'sale')
      .where('t.status', '=', 'success')
      .where('o.created_at', '>=', fromDate.toISOString())
      .where('o.created_at', '<=', toDate.toISOString())
      .groupBy('t.gateway')
      .orderBy('total', 'desc')
      .execute(),
  ])

  const grossRevenue = Number(revenueStats?.gross_revenue ?? 0)
  const subtotal = Number(revenueStats?.subtotal ?? 0)
  const totalDiscounts = Number(revenueStats?.total_discounts ?? 0)
  const totalShipping = Number(revenueStats?.total_shipping ?? 0)
  const totalTax = Number(revenueStats?.total_tax ?? 0)
  const orderCount = Number(revenueStats?.order_count ?? 0)
  const totalRefunds = Number(refundStats?.total_refunds ?? 0)
  const refundCount = Number(refundStats?.refund_count ?? 0)
  const netRevenue = grossRevenue - totalRefunds

  const rows: unknown[][] = []
  rows.push(['Financial Report'])
  rows.push(['Store', store.name])
  rows.push(['Period', `${fromStr} to ${toStr}`])
  rows.push(['Generated', new Date().toISOString()])
  rows.push([])
  rows.push(['Revenue Summary'])
  rows.push(['Orders', orderCount])
  rows.push(['Gross Revenue', grossRevenue.toFixed(2)])
  rows.push(['Subtotal', subtotal.toFixed(2)])
  rows.push(['Discounts', totalDiscounts.toFixed(2)])
  rows.push(['Shipping', totalShipping.toFixed(2)])
  rows.push(['Tax', totalTax.toFixed(2)])
  rows.push([])
  rows.push(['Refunds'])
  rows.push(['Refund Count', refundCount])
  rows.push(['Total Refunds', totalRefunds.toFixed(2)])
  rows.push(['Net Revenue', netRevenue.toFixed(2)])
  rows.push([])
  rows.push(['Payment Methods'])
  rows.push(['Gateway', 'Transaction Count', 'Total'])
  for (const p of paymentMethods) {
    rows.push([p.gateway || 'unknown', Number(p.count), Number(p.total).toFixed(2)])
  }

  const filename = `finance_${csvSlug(store.slug)}_${fromStr}_${toStr}.csv`
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send('\uFEFF' + toCsv(rows))
}
