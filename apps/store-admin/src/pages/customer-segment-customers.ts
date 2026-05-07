/**
 * Store Admin — Customers in a Segment (Shopify-style list)
 *
 * Route: GET /admin/store/:slug/customers/segments/:segmentId/customers
 *
 * URL giữ slug (consistency với routes admin khác) NHƯNG internal filter
 * dùng shop_id (24-hex ObjectId) qua createApiContext — BE filter Customer
 * theo shop_id ObjectId, không hiểu slug.
 *
 * BE call: GET /api/{shop_id}/segments/{id}/customers?include_stats=true
 * → trả {pagination, data: ApiCustomer[]} với _stats nhúng (CustomerStats).
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import {
  createApiContext,
  getSegment as apiGetSegment,
  applySegment as apiApplySegment,
  type ApiContext,
} from '../lib/customer-api-client.js'
import { formatProductApiError } from '../lib/product-api-errors.js'
import type { ApiCustomer, ApiCustomerStats } from '../lib/customer-api-types.js'
import { renderAvatarNameCell, renderPaginationFooter, formatMoney, renderIsoDate } from '../lib/customer-list-shared.js'

const PER_PAGE = 50

export async function getCustomerSegmentCustomers(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  console.log('[segment-customers] hit', req.params)
  const store = req.store
  if (!store) {
    res.status(404).send('Store context missing')
    return
  }
  const user = req.storeUser ?? { name: '', email: '', role: '', storeRole: '' } as any
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const segmentId = String(req.params.segmentId ?? '')
  const page = Math.max(1, parseInt(String(req.query.page ?? '1')) || 1)

  let segmentName = '(segment)'
  let customers: ApiCustomer[] = []
  let total = 0
  let errorMsg: string | null = null

  let ctx: ApiContext | undefined
  try { ctx = createApiContext(req) } catch (err) {
    errorMsg = formatProductApiError(err)
  }

  if (ctx) {
    // allSettled — 1 call fail không kill render.
    const [segResult, listResult] = await Promise.allSettled([
      apiGetSegment(ctx, segmentId),
      apiApplySegment(ctx, segmentId, { page, limit: PER_PAGE, include_stats: true }),
    ])
    if (segResult.status === 'fulfilled' && segResult.value) {
      segmentName = segResult.value.name ?? '(no name)'
    } else if (segResult.status === 'fulfilled' && !segResult.value) {
      // 404 hợp lệ — segment không tồn tại → redirect, không render trống.
      res.redirect(`${base}/customers/segments?error=${encodeURIComponent('Segment not found')}`)
      return
    } else if (segResult.status === 'rejected') {
      errorMsg = formatProductApiError(segResult.reason)
    }
    if (listResult.status === 'fulfilled') {
      customers = listResult.value.data ?? []
      total = listResult.value.pagination?.count ?? customers.length
    } else {
      const m = formatProductApiError(listResult.reason)
      if (!errorMsg) errorMsg = m
      console.error('[segment-customers] apply failed:', m)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE))
  const content = renderPage({
    base,
    segmentId,
    segmentName,
    customers,
    total,
    page,
    totalPages,
    errorMsg,
  })

  res.send(
    sellerLayout({
      title: `Customers in ${segmentName}`,
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

// ─── Render ──────────────────────────────────────────────────────────────

interface PageProps {
  base: string
  segmentId: string
  segmentName: string
  customers: ApiCustomer[]
  total: number
  page: number
  totalPages: number
  errorMsg: string | null
}

function renderPage(p: PageProps): string {
  const errorBanner = p.errorMsg
    ? `<div style="background:#7f1d1d;border:1px solid #f87171;border-radius:8px;padding:10px 14px;margin-bottom:16px;color:#fee2e2;font-size:13px">${esc(p.errorMsg)}</div>`
    : ''

  const headerRow = `
    <div class="page-header" style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:24px">
      <div>
        <a href="${p.base}/customers/segments" style="color:var(--s-text-dim);text-decoration:none;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px">
          &larr; Segments
        </a>
        <h1 class="page-title" style="margin:0">${esc(p.segmentName)}</h1>
        <p class="page-subtitle" style="margin:4px 0 0;color:var(--s-text-dim);font-size:13px">
          ${p.total} customer${p.total === 1 ? '' : 's'} match this segment
        </p>
      </div>
      <div style="display:flex;gap:8px">
        <a href="${p.base}/customers/segments/${esc(p.segmentId)}" class="btn btn-outline">Edit segment</a>
      </div>
    </div>
  `

  const tableBody =
    p.customers.length === 0
      ? `<tr><td colspan="6" style="text-align:center;padding:48px 12px;color:var(--s-text-dim)">
           <div style="font-weight:600;font-size:14px;color:var(--s-text-primary);margin-bottom:4px">No customers match yet</div>
           <div style="font-size:13px">Adjust the segment rules or wait for Order Service to push CustomerStats.</div>
         </td></tr>`
      : p.customers.map((c) => renderRow(c, p.base)).join('')

  const pagination = renderPaginationFooter({
    page: p.page,
    totalPages: p.totalPages,
    hrefBuilder: (n) => `${p.base}/customers/segments/${esc(p.segmentId)}/customers?page=${n}`,
  })

  return `
    ${errorBanner}
    ${headerRow}

    <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;overflow:hidden">
      <div class="data-table" style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="border-bottom:1px solid var(--s-border)">
              <th style="text-align:left;padding:12px 16px;font-weight:600;color:var(--s-text-dim);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Customer</th>
              <th style="text-align:left;padding:12px 16px;font-weight:600;color:var(--s-text-dim);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Location</th>
              <th style="text-align:right;padding:12px 16px;font-weight:600;color:var(--s-text-dim);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Orders</th>
              <th style="text-align:right;padding:12px 16px;font-weight:600;color:var(--s-text-dim);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Amount spent</th>
              <th style="text-align:left;padding:12px 16px;font-weight:600;color:var(--s-text-dim);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Last order</th>
              <th style="text-align:left;padding:12px 16px;font-weight:600;color:var(--s-text-dim);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Marketing</th>
            </tr>
          </thead>
          <tbody>${tableBody}</tbody>
        </table>
      </div>
      ${pagination}
    </div>
  `
}

function renderRow(c: ApiCustomer, base: string): string {
  const stats: ApiCustomerStats | undefined = c._stats
  const location = [c.city, c.country_code].filter(Boolean).join(', ') || '—'
  const ordersCount = stats?.orders_count ?? 0
  const totalSpent = stats?.total_spent ?? 0
  const currency = stats?.currency || 'USD'
  const lastOrder = renderIsoDate(stats?.last_order_at)
  const marketing = stats?.accepts_marketing
    ? '<span class="badge badge-success" style="font-size:11px">Subscribed</span>'
    : '<span class="badge" style="font-size:11px;background:var(--s-bg);border:1px solid var(--s-border);color:var(--s-text-dim)">Not subscribed</span>'

  return `
    <tr style="border-bottom:1px solid var(--s-border)" onmouseover="this.style.background='var(--s-bg)'" onmouseout="this.style.background=''">
      <td style="padding:12px 16px">${renderAvatarNameCell(c, base)}</td>
      <td style="padding:12px 16px;color:var(--s-text-dim);font-size:13px">${esc(location)}</td>
      <td style="padding:12px 16px;text-align:right;font-variant-numeric:tabular-nums">${ordersCount}</td>
      <td style="padding:12px 16px;text-align:right;font-weight:500;font-variant-numeric:tabular-nums">${esc(formatMoney(totalSpent, currency))}</td>
      <td style="padding:12px 16px;color:var(--s-text-dim)">${esc(lastOrder)}</td>
      <td style="padding:12px 16px">${marketing}</td>
    </tr>
  `
}
