/**
 * Store Admin — Customers list (API mode)
 *
 * Render khi `customers.ts` `hasDb=false` — gọi BE Gbox-Customer-Service.
 * Layout Shopify-style: header với Export/Import/Add customer, stats card,
 * search bar có columns toggle, table 5 cột (Customer name / Email subscription
 * / Location / Orders / Amount spent), footer Learn more link.
 *
 * Data path:
 *  - autoRules (?segment=...) → applyInlineSegment ruleset + include_stats
 *  - keyword (?q=...)         → listCustomers (no stats, Orders/Amount = —)
 *  - default                  → applyInlineSegment {} + include_stats để có stats
 *    (fallback listCustomers nếu BE reject empty ruleset)
 */

import type { Request, Response } from 'express'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import {
  createApiContext,
  listCustomers,
  applyInlineSegment,
  getCustomerStats,
  type ApiContext,
} from '../lib/customer-api-client.js'
import { formatProductApiError } from '../lib/product-api-errors.js'
import type { ApiCustomer, ApiCustomerStats } from '../lib/customer-api-types.js'
import { renderAvatarNameCell, renderPaginationFooter, formatMoney } from '../lib/customer-list-shared.js'
import { buildAutoSegmentRules, AUTO_SEGMENT_LABELS } from '../lib/auto-segment-rules.js'

const PER_PAGE = 25

export async function renderCustomersApiList(req: Request, res: Response): Promise<void> {
  const store = req.store
  if (!store) {
    res.status(404).send('Store context missing')
    return
  }
  const user = req.storeUser ?? { name: '', email: '', role: '', storeRole: '' } as any
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`

  const page = Math.max(1, parseInt(String(req.query.page ?? '1')) || 1)
  const keyword = (typeof req.query.q === 'string' ? req.query.q : '').trim()
  const segmentParam = typeof req.query.segment === 'string' ? req.query.segment : ''

  let customers: ApiCustomer[] = []
  let total = 0
  let errorMsg: string | null = null
  let hasStats = false

  let ctx: ApiContext | undefined
  try { ctx = createApiContext(req) } catch (err) {
    errorMsg = formatProductApiError(err)
  }

  const autoRules = segmentParam ? buildAutoSegmentRules(segmentParam) : null

  if (ctx) {
    try {
      if (autoRules) {
        // Auto-segment: BE đã embed _stats khi include_stats=true.
        const r = await applyInlineSegment(ctx, autoRules, { page, limit: PER_PAGE, include_stats: true })
        customers = r.data ?? []
        total = r.pagination?.count ?? customers.length
        hasStats = true
      } else {
        // Default + search: dùng listCustomers rồi enrich _stats per-customer.
        // BE chưa có endpoint batch nên song song N call (page = 25 → ~25 req).
        const r = await listCustomers(ctx, { page, limit: PER_PAGE, keyword: keyword || undefined })
        customers = r.data ?? []
        total = r.pagination?.count ?? customers.length
        await enrichCustomersWithStats(ctx, customers)
        hasStats = customers.length > 0
      }
    } catch (err) {
      errorMsg = formatProductApiError(err)
      console.error('[customers-api] list failed:', errorMsg)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE))
  const segmentLabel = segmentParam && AUTO_SEGMENT_LABELS[segmentParam]
  const segmentBanner = segmentLabel && segmentParam !== 'all'
    ? `<div style="background:color-mix(in srgb, var(--s-accent) 14%, transparent);border:1px solid color-mix(in srgb, var(--s-accent) 40%, transparent);border-radius:8px;padding:8px 12px;margin-bottom:12px;color:var(--s-text);font-size:13px">
         Filtered by auto segment <strong>${esc(segmentLabel)}</strong> · <a href="${base}/customers" style="color:var(--s-accent);text-decoration:underline">clear</a>
       </div>`
    : ''
  const errorBanner = errorMsg
    ? `<div style="background:color-mix(in srgb, var(--s-danger,#ef4444) 14%, transparent);border:1px solid color-mix(in srgb, var(--s-danger,#ef4444) 40%, transparent);border-radius:8px;padding:10px 14px;margin-bottom:12px;color:var(--s-text);font-size:13px">${esc(errorMsg)}</div>`
    : ''

  const queryAppend = keyword ? `&q=${encodeURIComponent(keyword)}` : ''
  const segmentAppend = segmentParam ? `&segment=${encodeURIComponent(segmentParam)}` : ''

  const tableBody = customers.length === 0
    ? `<tr><td colspan="6" style="text-align:center;padding:48px 12px;color:var(--s-text-muted)">
         <div style="font-weight:600;font-size:14px;color:var(--s-text);margin-bottom:4px">No customers</div>
         <div style="font-size:13px">${keyword ? `No matches for "${esc(keyword)}".` : 'Customers will appear here once they sign up or place orders.'}</div>
       </td></tr>`
    : customers.map((c) => renderRow(c, base, hasStats)).join('')

  // ── Stats summary ──
  const totalLabel = `${total} customer${total === 1 ? '' : 's'}`
  const baseLabel = total > 0 ? '100% of your customer base' : 'No data yet'

  const userIcon = `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="7" r="3"/><path d="M3.5 17c.8-3.6 3.5-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/></svg>`
  const searchIcon = `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="9" r="6"/><path d="M14 14l3.5 3.5"/></svg>`
  const colsIcon = `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="14" height="14" rx="2"/><path d="M8.5 3v14M13 3v14"/></svg>`
  const chevronIcon = `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8l5 5 5-5"/></svg>`

  const content = `
    <div style="max-width:1200px;margin:0 auto">
      <!-- Header -->
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px">
        <h1 style="margin:0;display:inline-flex;align-items:center;gap:8px;font-size:20px;font-weight:600;color:var(--s-text)">
          <span style="color:var(--s-text-muted)">${userIcon}</span> Customers
        </h1>
        <div style="display:flex;gap:8px">
          <a href="${base}/customers/export" class="btn btn-outline" style="font-size:13px;padding:7px 14px">Export</a>
          <a href="${base}/customers/import" class="btn btn-outline" style="font-size:13px;padding:7px 14px">Import</a>
          <a href="${base}/customers/new" style="background:var(--s-text);color:var(--s-bg);font-size:13px;padding:7px 14px;border-radius:8px;text-decoration:none;font-weight:600;border:1px solid var(--s-text)">Add customer</a>
        </div>
      </div>

      ${segmentBanner}
      ${errorBanner}

      <!-- Stats summary card -->
      <div class="card" style="margin-bottom:10px">
        <div style="padding:14px 18px;display:flex;align-items:center;gap:24px;font-size:13px">
          <span style="color:var(--s-text);font-weight:500">${totalLabel}</span>
          <span style="color:var(--s-text-muted)">${baseLabel}</span>
          <button type="button" title="Show details" onclick="gxComingSoon('Stats breakdown')"
                  style="margin-left:auto;background:none;border:none;color:var(--s-text-muted);cursor:pointer;display:inline-flex;align-items:center;padding:4px;border-radius:6px"
                  onmouseover="this.style.background='var(--s-card-hover, var(--s-bg))'"
                  onmouseout="this.style.background='none'">${chevronIcon}</button>
        </div>
      </div>

      <!-- Table card with search bar inline -->
      <div class="card" style="overflow:hidden">
        <form method="GET" action="${base}/customers" style="margin:0">
          <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--s-border)">
            <span style="color:var(--s-text-muted);display:inline-flex">${searchIcon}</span>
            <input type="text" name="q" value="${esc(keyword)}" placeholder="Search customers"
                   style="flex:1;border:none;background:transparent;color:var(--s-text);font-size:13px;outline:none" />
            ${segmentParam ? `<input type="hidden" name="segment" value="${esc(segmentParam)}" />` : ''}
            <button type="button" title="Edit columns" onclick="gxComingSoon('Column visibility')"
                    style="background:none;border:none;color:var(--s-text-muted);cursor:pointer;display:inline-flex;align-items:center;padding:4px;border-radius:6px"
                    onmouseover="this.style.background='var(--s-card-hover, var(--s-bg))'"
                    onmouseout="this.style.background='none'">${colsIcon}</button>
          </div>
        </form>

        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="border-bottom:1px solid var(--s-border);background:color-mix(in srgb, var(--s-card-hover, var(--s-bg)) 50%, transparent)">
                <th style="padding:10px 14px;width:34px"><input type="checkbox" disabled title="Select all (coming soon)" /></th>
                <th style="text-align:left;padding:10px 14px;font-weight:500;color:var(--s-text-muted);font-size:12px">Customer name</th>
                <th style="text-align:left;padding:10px 14px;font-weight:500;color:var(--s-text-muted);font-size:12px">Email subscription</th>
                <th style="text-align:left;padding:10px 14px;font-weight:500;color:var(--s-text-muted);font-size:12px">Location</th>
                <th style="text-align:right;padding:10px 14px;font-weight:500;color:var(--s-text-muted);font-size:12px">Orders</th>
                <th style="text-align:right;padding:10px 14px;font-weight:500;color:var(--s-text-muted);font-size:12px">Amount spent</th>
              </tr>
            </thead>
            <tbody>${tableBody}</tbody>
          </table>
        </div>
        ${renderPaginationFooter({
          page,
          totalPages,
          hrefBuilder: (n) => `${base}/customers?page=${n}${queryAppend}${segmentAppend}`,
        })}
      </div>

      <p style="text-align:center;margin:18px 0 8px;font-size:13px;color:var(--s-text-muted)">
        <a href="javascript:void(0)" onclick="gxComingSoon('Customers documentation')" style="color:var(--s-text);text-decoration:underline;font-weight:500">Learn more</a> about customers
      </p>
    </div>
  `

  res.send(
    sellerLayout({
      title: 'Customers',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'customers',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

/**
 * Enrich từng customer với _stats qua GET /customer-stats/{id}. Promise.allSettled
 * để 1 call fail không phá cả page. Mutate in-place trong mảng customers.
 */
async function enrichCustomersWithStats(ctx: ApiContext, customers: ApiCustomer[]): Promise<void> {
  if (customers.length === 0) return
  const results = await Promise.allSettled(
    customers.map(c => {
      const id = c.id ? String(c.id) : ''
      if (!id) return Promise.resolve(null)
      return getCustomerStats(ctx, id).catch(() => null)
    }),
  )
  for (let i = 0; i < customers.length; i++) {
    const r = results[i]
    if (r && r.status === 'fulfilled' && r.value) {
      customers[i]._stats = r.value
    }
  }
}

function renderRow(c: ApiCustomer, base: string, hasStats: boolean): string {
  const stats: ApiCustomerStats = (c._stats as ApiCustomerStats) || {}
  const subscribed = stats.accepts_marketing
  const location = [c.city, c.country_name || c.country_code].filter(Boolean).join(', ') || '—'
  const orders = hasStats ? (stats.orders_count ?? 0) : null
  const spent = hasStats ? (stats.total_spent ?? 0) : null
  const currency = stats.currency || 'USD'

  const subPill = subscribed === true
    ? `<span style="display:inline-flex;align-items:center;background:color-mix(in srgb, var(--s-success,#22c55e) 22%, transparent);color:var(--s-success,#22c55e);padding:3px 12px;border-radius:999px;font-size:12px;font-weight:500">Subscribed</span>`
    : subscribed === false
      ? `<span style="color:var(--s-text-muted);font-size:13px">Not subscribed</span>`
      : `<span style="color:var(--s-text-muted)">—</span>`

  return `
    <tr style="border-bottom:1px solid var(--s-border);transition:background .12s ease"
        onmouseover="this.style.background='var(--s-card-hover, var(--s-bg))'"
        onmouseout="this.style.background=''">
      <td style="padding:12px 14px"><input type="checkbox" disabled title="Bulk select (coming soon)" /></td>
      <td style="padding:12px 14px">${renderAvatarNameCell(c, base)}</td>
      <td style="padding:12px 14px">${subPill}</td>
      <td style="padding:12px 14px;color:var(--s-text-muted)">${esc(location)}</td>
      <td style="padding:12px 14px;color:var(--s-text);text-align:right">${orders == null ? '—' : orders}</td>
      <td style="padding:12px 14px;color:var(--s-text);text-align:right">${spent == null ? '—' : esc(formatMoney(spent, currency))}</td>
    </tr>
  `
}
