/**
 * Store Admin — Dashboard (Home)
 *
 * 6 KPI cards lấy từ BE Order Service (api-order.gbox.co) qua listOrders.
 * Sessions / conversion rate chưa có analytics API → fallback 0.
 *
 * Data flow per request:
 *   listOrders (paginate desc theo create_date) → filter range → reduce metrics
 *   curr = period hiện tại; prev = period trước đó (cùng độ dài) cho change %
 *
 * Errors (auth/network) → log + render với metrics = 0.
 */

import type { Request, Response } from 'express'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { createApiContext, listOrders } from '../lib/customer-api-client.js'

interface DashboardMetrics {
  totalSales: number
  totalOrders: number
  aov: number
  returningCustomerRate: number  // %
  sessions: number               // 0 — analytics API chưa có
  conversionRate: number         // 0 — analytics API chưa có
}

const ZERO_METRICS: DashboardMetrics = {
  totalSales: 0,
  totalOrders: 0,
  aov: 0,
  returningCustomerRate: 0,
  sessions: 0,
  conversionRate: 0,
}

/**
 * GET /admin/store/:slug
 */
export async function getDashboard(
  req: Request,
  res: Response,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'

  const period = (req.query.period as string) || '7d'
  const { sinceMs, untilMs, prevSinceMs } = getPeriodRange(period)
  const { periodLabel } = getPeriodDates(period)

  let curr = { ...ZERO_METRICS }
  let prev = { ...ZERO_METRICS }
  let currency = 'USD'
  let allOrders: any[] = []

  try {
    const ctx = createApiContext(req)
    allOrders = await fetchOrdersForDashboard(ctx, prevSinceMs)
    curr = computeMetrics(allOrders, sinceMs, untilMs)
    prev = computeMetrics(allOrders, prevSinceMs, sinceMs)
    const sample = allOrders.find((o) => o?.currency)
    if (sample?.currency) currency = String(sample.currency)
  } catch (err) {
    console.error('[dashboard] BE order metrics fetch failed:', err instanceof Error ? err.message : err)
    // metrics ở lại 0 — render bình thường, không throw page-broken
  }

  const salesSeries = computeSalesSeries(allOrders, untilMs, period)

  res.send(sellerLayout({
    title: 'Dashboard',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'home',
    theme: theme as 'dark' | 'light',
    content: renderHomeDashboardHtml({ curr, prev, currency, periodLabel, salesSeries, period, storeSlug: store.slug }),
  }))
}

// ─── Helpers ────────────────────────────────────────────────────

const periodLabels: Record<string, string> = {
  today: 'Today',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
}

function getPeriodDates(period: string) {
  return {
    periodLabel: periodLabels[period] || '7 days',
  }
}

function getPeriodRange(period: string) {
  const now = Date.now()
  const days = period === 'today' ? 1 : period === '30d' ? 30 : period === '90d' ? 90 : 7
  const ms = days * 86400_000
  const sinceMs = now - ms
  return {
    sinceMs,
    untilMs: now,
    prevSinceMs: sinceMs - ms,
  }
}

/**
 * Pagination cho đến khi gặp order cũ hơn `oldestMs` HOẶC chạm safety cap.
 * BE listOrders trả desc theo create_date nên dừng được sớm khi out-of-range.
 */
async function fetchOrdersForDashboard(
  ctx: ReturnType<typeof createApiContext>,
  oldestMs: number,
): Promise<any[]> {
  const all: any[] = []
  const fields = 'id,total_price,subtotal_price,line_items,create_date,customer_id,customer,tags,currency'
  const PAGE_LIMIT = 100
  for (let page = 1; page <= 50; page++) {
    const r = await listOrders(ctx, { page, limit: PAGE_LIMIT, fields })
    const data = r.data ?? []
    if (data.length === 0) break
    all.push(...data)
    const last = data[data.length - 1]
    const lastTs = parseDate(last?.create_date || last?.created_at)
    if (lastTs !== null && lastTs < oldestMs) break
    if (data.length < PAGE_LIMIT) break
  }
  return all
}

function parseDate(d: any): number | null {
  if (!d) return null
  const t = new Date(d).getTime()
  return Number.isFinite(t) ? t : null
}

function computeMetrics(orders: any[], sinceMs: number, untilMs: number): DashboardMetrics {
  const inRange = orders.filter((o) => {
    if (Array.isArray(o?.tags) && o.tags.includes('draft')) return false
    const ts = parseDate(o?.create_date || o?.created_at)
    if (ts === null) return false
    return ts >= sinceMs && ts < untilMs
  })

  const totalOrders = inRange.length
  let totalSales = 0
  for (const o of inRange) {
    const tp = Number(o?.total_price)
    if (Number.isFinite(tp) && tp > 0) {
      totalSales += tp
      continue
    }
    // Fallback giống orders-list-api: BE insert-temp đôi lúc strip total_price
    const items = Array.isArray(o?.line_items) ? o.line_items : []
    for (const li of items) {
      const price = Number(li?.variant?.price ?? li?.price ?? 0)
      const qty = Number(li?.quantity ?? 0)
      if (Number.isFinite(price) && Number.isFinite(qty)) totalSales += price * qty
    }
  }
  const aov = totalOrders > 0 ? totalSales / totalOrders : 0

  const counts = new Map<string, number>()
  for (const o of inRange) {
    const cid = String(o?.customer_id || o?.customer?._id || o?.customer?.id || '')
    if (!cid) continue
    counts.set(cid, (counts.get(cid) ?? 0) + 1)
  }
  const distinctCustomers = counts.size
  const returningCount = [...counts.values()].filter((c) => c >= 2).length
  const returningCustomerRate = distinctCustomers > 0 ? (returningCount / distinctCustomers) * 100 : 0

  return {
    totalSales,
    totalOrders,
    aov,
    returningCustomerRate,
    sessions: 0,
    conversionRate: 0,
  }
}

interface SalesBucket {
  label: string
  value: number
  showLabel: boolean  // false → ẩn label dưới chart (tránh chồng khi nhiều bucket)
}

function getSeriesBuckets(period: string): { count: number; ms: number; labelFn: (start: Date) => string; labelEvery: number } {
  if (period === 'today') {
    return {
      count: 24,
      ms: 3_600_000,
      labelFn: (s) => `${String(s.getHours()).padStart(2, '0')}h`,
      labelEvery: 4, // mỗi 4 giờ
    }
  }
  if (period === '30d') {
    return {
      count: 30,
      ms: 86_400_000,
      labelFn: (s) => `${s.getDate()}/${s.getMonth() + 1}`,
      labelEvery: 5,
    }
  }
  if (period === '90d') {
    return {
      count: 13, // 91 ngày / 7 ≈ 13 tuần
      ms: 7 * 86_400_000,
      labelFn: (s) => `${s.getDate()}/${s.getMonth() + 1}`,
      labelEvery: 2,
    }
  }
  // 7d default
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return {
    count: 7,
    ms: 86_400_000,
    labelFn: (s) => dayNames[s.getDay()],
    labelEvery: 1,
  }
}

function bucketSales(o: any): number {
  if (!o) return 0
  if (Array.isArray(o.tags) && o.tags.includes('draft')) return 0
  const tp = Number(o.total_price)
  if (Number.isFinite(tp) && tp > 0) return tp
  const items = Array.isArray(o.line_items) ? o.line_items : []
  let sum = 0
  for (const li of items) {
    const price = Number(li?.variant?.price ?? li?.price ?? 0)
    const qty = Number(li?.quantity ?? 0)
    if (Number.isFinite(price) && Number.isFinite(qty)) sum += price * qty
  }
  return sum
}

function computeSalesSeries(orders: any[], untilMs: number, period: string): SalesBucket[] {
  const { count, ms, labelFn, labelEvery } = getSeriesBuckets(period)
  const startMs = untilMs - count * ms
  const buckets: SalesBucket[] = []
  for (let i = 0; i < count; i++) {
    const bs = startMs + i * ms
    const be = bs + ms
    let value = 0
    for (const o of orders) {
      const ts = parseDate(o?.create_date || o?.created_at)
      if (ts === null || ts < bs || ts >= be) continue
      value += bucketSales(o)
    }
    buckets.push({
      label: labelFn(new Date(bs)),
      value,
      showLabel: i % labelEvery === 0 || i === count - 1,
    })
  }
  return buckets
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
    }).format(amount)
  } catch {
    return `$${amount.toFixed(2)}`
  }
}

function formatInt(n: number): string {
  return n.toLocaleString('en-US')
}

function formatPct(p: number): string {
  return `${p.toFixed(2)}%`
}

function renderHomeDashboardHtml(args: {
  curr: DashboardMetrics
  prev: DashboardMetrics
  currency: string
  periodLabel: string
  salesSeries: SalesBucket[]
  period: string
  storeSlug: string
}): string {
  const { curr, prev, currency, periodLabel, salesSeries, storeSlug, period } = args
  const base = `/admin/store/${esc(storeSlug)}`
  const maxSales = Math.max(1, ...salesSeries.map((b) => b.value))
  const barsHtml = salesSeries.map((b) => {
    // height %: 0 → 4px min-bar so empty buckets vẫn nhìn thấy
    const pct = b.value > 0 ? Math.max(4, (b.value / maxSales) * 100) : 0
    const heightStyle = pct > 0 ? `height:${pct.toFixed(2)}%` : 'height:2px;opacity:.25'
    const tooltip = `${b.label}: ${formatMoney(b.value, currency)}`
    return `<div style="flex:1;background:var(--s-accent);${heightStyle};border-radius:4px 4px 0 0;min-height:2px" title="${esc(tooltip)}"></div>`
  }).join('')
  const labelsHtml = salesSeries.map((b) => {
    const text = b.showLabel ? esc(b.label) : ''
    return `<span style="flex:1;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${text}</span>`
  }).join('')
  return `
    <div class="page-header">
      <div>
        <h1 class="page-title">Home</h1>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <div class="period-selector" role="group" aria-label="Date range">
          ${['today', '7d', '30d', '90d'].map(p => `
            <a href="?period=${p}" class="period-btn${p === period ? ' active' : ''}" aria-current="${p === period ? 'page' : 'false'}">${periodLabels[p]}</a>
          `).join('')}
        </div>
      </div>
    </div>

    <div class="stats-grid-6">
      ${statCard('Total sales', formatMoney(curr.totalSales, currency), curr.totalSales, prev.totalSales)}
      ${statCard('Online store sessions', formatInt(curr.sessions), curr.sessions, prev.sessions)}
      ${statCard('Returning customer rate', formatPct(curr.returningCustomerRate), curr.returningCustomerRate, prev.returningCustomerRate)}
      ${statCard('Online store conversion rate', formatPct(curr.conversionRate), curr.conversionRate, prev.conversionRate)}
      ${statCard('Total orders', formatInt(curr.totalOrders), curr.totalOrders, prev.totalOrders)}
      ${statCard('Average order value', formatMoney(curr.aov, currency), curr.aov, prev.aov)}
    </div>

    <div style="display:grid;grid-template-columns:2fr 1fr;gap:20px;margin-bottom:20px">
      <div class="card">
        <div class="card-header">
          <span>Total sales — ${esc(periodLabel)}</span>
          <span style="float:right;font-size:13px;color:var(--s-text-dim)">${formatMoney(curr.totalSales, currency)}</span>
        </div>
        <div class="card-body">
          <div style="height: 200px; display: flex; align-items: flex-end; gap: 4px; padding: 20px 0;">
            ${barsHtml}
          </div>
          <div style="display: flex; gap: 4px; font-size: 11px; color: var(--s-text-dim);">
            ${labelsHtml}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">Quick actions</div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:8px">
          <a href="${base}/products" class="quick-action"><span class="qa-icon">+</span> Add product</a>
          <button type="button" class="quick-action" style="background:transparent;cursor:pointer;text-align:left;width:100%" onclick="alert('Unfulfilled orders — coming soon')"><span class="qa-icon qa-warn">!</span> Unfulfilled orders</button>
          <a href="${base}/discounts" class="quick-action"><span class="qa-icon">%</span> Create discount</a>
        </div>
      </div>
    </div>

    <style>
      .period-selector { display: inline-flex; align-items: center; border: 1px solid var(--s-border); border-radius: 8px; background: var(--s-card); overflow: hidden; }
      .period-btn { padding: 7px 14px; font-size: 13px; font-weight: 500; color: var(--s-text-dim); text-decoration: none; border-right: 1px solid var(--s-border); cursor: pointer; transition: background .15s, color .15s; line-height: 1; }
      .period-btn:last-child { border-right: 0; }
      .period-btn:hover { background: rgba(255,255,255,.04); color: var(--s-text); }
      .period-btn.active { background: var(--s-accent); color: #fff; font-weight: 600; }
      .period-btn:focus-visible { outline: 2px solid var(--s-accent); outline-offset: -2px; }
      .stats-grid-6 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px; }
      .stat-card { background: var(--s-card); border: 1px solid var(--s-border); padding: 16px; border-radius: 12px; }
      .stat-label { font-size: 12px; color: var(--s-text-dim); margin-bottom: 4px; }
      .stat-value { font-size: 20px; font-weight: 700; color: var(--s-text); }
      .stat-change { font-size: 11px; margin-top: 4px; }
      .stat-up { color: var(--s-success); }
      .stat-down { color: var(--s-danger); }
      .bar-chart { display: flex; align-items: flex-end; gap: 8px; height: 160px; padding: 10px 0; }
      .bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 8px; }
      .bar-fill { width: 100%; background: var(--s-accent); border-radius: 4px 4px 0 0; transition: height 0.3s ease; }
      .bar-label { font-size: 10px; color: var(--s-text-dim); }
      .quick-action { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; text-decoration: none; color: var(--s-text); font-size: 13px; border: 1px solid var(--s-border); }
      .qa-icon { width: 28px; height: 28px; border-radius: 6px; background: rgba(99,102,241,0.1); color: var(--s-accent); display: flex; align-items: center; justify-content: center; font-weight: 700; }
    </style>
  `
}

function statCard(label: string, displayValue: string, current: number, prev: number): string {
  const change = prev > 0 ? ((current - prev) / prev) * 100 : current > 0 ? 100 : 0
  const changeStr = change > 0 ? `+${change.toFixed(1)}%` : `${change.toFixed(1)}%`
  const changeClass = change > 0 ? 'stat-up' : change < 0 ? 'stat-down' : ''

  return `
    <div class="stat-card">
      <div class="stat-label">${label}</div>
      <div class="stat-value">${displayValue}</div>
      <div class="stat-change ${changeClass}">${changeStr} vs prev period</div>
    </div>
  `
}
