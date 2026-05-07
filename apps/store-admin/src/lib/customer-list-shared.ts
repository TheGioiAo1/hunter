/**
 * Shared render fragments cho 2 customer list pages
 * (customer-segment-customers.ts, customers-api-list.ts).
 *
 * Cùng pattern Polaris-style: 32px avatar circle + name link + email +
 * pagination footer + money formatter. Tách module để fix style 1 chỗ
 * apply cả 2 trang.
 */

import { esc } from '../layouts/seller-layout.js'
import { formatCurrency } from '@gbox/core/modules/admin-i18n/format.js'
import type { ApiCustomer } from './customer-api-types.js'

/**
 * Avatar (initial) + name link + email block — `<td>` content,
 * caller wrap trong `<td>` của row.
 */
export function renderAvatarNameCell(c: ApiCustomer, base: string): string {
  const id = String(c.id ?? '')
  const fullName =
    c.full_name ||
    [c.first_name, c.last_name].filter(Boolean).join(' ').trim() ||
    '(no name)'
  const initial = (fullName.charAt(0) || '?').toUpperCase()
  const email = c.email ?? ''
  const detailHref = id ? `${base}/customers/${esc(id)}` : ''

  const nameInner = detailHref
    ? `<a href="${detailHref}" style="font-weight:600;color:var(--s-text-primary);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(fullName)}</a>`
    : `<span style="font-weight:600;color:var(--s-text-primary)">${esc(fullName)}</span>`

  return `
    <div style="display:flex;align-items:center;gap:10px">
      <div style="width:32px;height:32px;border-radius:50%;background:var(--s-accent,#6366f1);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-weight:600;font-size:13px">${esc(initial)}</div>
      <div style="min-width:0">
        ${nameInner}
        <div style="color:var(--s-text-dim);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(email)}</div>
      </div>
    </div>
  `
}

/**
 * Render pagination footer — Prev/Next với disable state.
 * `hrefBuilder(page)` để caller control URL shape (giữ filter params).
 */
export function renderPaginationFooter(opts: {
  page: number
  totalPages: number
  hrefBuilder: (page: number) => string
}): string {
  if (opts.totalPages <= 1) return ''
  const prev = Math.max(1, opts.page - 1)
  const next = Math.min(opts.totalPages, opts.page + 1)
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-top:1px solid var(--s-border);font-size:13px">
      <div style="color:var(--s-text-dim)">Page ${opts.page} of ${opts.totalPages}</div>
      <div style="display:flex;gap:6px">
        <a href="${opts.hrefBuilder(prev)}" class="btn btn-outline btn-sm" style="${opts.page === 1 ? 'pointer-events:none;opacity:.4' : ''}">&laquo; Prev</a>
        <a href="${opts.hrefBuilder(next)}" class="btn btn-outline btn-sm" style="${opts.page === opts.totalPages ? 'pointer-events:none;opacity:.4' : ''}">Next &raquo;</a>
      </div>
    </div>
  `
}

/**
 * Money formatter dùng @gbox/core/admin-i18n. Locale hard-code 'en-US'
 * tới khi store-admin có resolver locale per-shop.
 */
export function formatMoney(amount: number, currency = 'USD'): string {
  try {
    return formatCurrency('en-US', amount, currency)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

/**
 * Render ngày ISO an toàn — BE có thể trả null/invalid.
 */
export function renderIsoDate(raw: string | undefined | null): string {
  if (!raw) return '—'
  try {
    const d = new Date(raw)
    if (isNaN(d.getTime())) return '—'
    return d.toISOString().slice(0, 10)
  } catch {
    return '—'
  }
}
