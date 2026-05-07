/**
 * Store Admin — Draft Orders list (API mode)
 *
 * Renders /orders/drafts. Calls BE Order-Service POST /api/{shop_id}/list with
 * tag filter `draft` (since drafts are created via insert-temp + tagged 'draft'
 * by the Express handler, or come back tagged from BE).
 *
 * Visual: simple list table with Draft #, Customer email, Items count, Total,
 * Created. Empty state when no drafts.
 */

import type { Request, Response } from 'express'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { createApiContext, listOrders } from '../lib/customer-api-client.js'

const PER_PAGE = 25

export async function renderDraftsListApi(req: Request, res: Response): Promise<void> {
  const store = req.store
  if (!store) { res.status(404).send('Store context missing'); return }
  const user = req.storeUser ?? { name: '', email: '', role: '', storeRole: '' } as any
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const successMsg = typeof req.query.success === 'string' ? req.query.success : ''
  const page = Math.max(1, parseInt(String(req.query.page ?? '1')) || 1)

  let drafts: any[] = []
  let total = 0
  let errorMsg: string | null = null

  try {
    const ctx = createApiContext(req)
    const r = await listOrders(ctx, { page, limit: PER_PAGE, tag: 'draft' })
    // Client-side filter: only orders that actually have 'draft' tag.
    // BE list may ignore the tag filter and return all orders, so we double-check.
    drafts = (r.data ?? []).filter((o: any) => Array.isArray(o.tags) && o.tags.includes('draft'))
    total = drafts.length
  } catch (err: any) {
    errorMsg = err?.message || 'unknown'
    console.error('[drafts-list-api] list failed:', errorMsg)
  }

  const isEmpty = total === 0
  const flash = successMsg
    ? `<div class="dl-banner-ok">✓ ${esc(successMsg)}</div>`
    : ''
  const errBanner = errorMsg
    ? `<div class="dl-banner-err">${esc(errorMsg)}</div>`
    : ''

  const content = `
${DRAFTS_LIST_STYLE}
<div class="dl">
  ${flash}${errBanner}
  <div class="dl-topbar">
    <h1>📝 Drafts</h1>
    <a href="${base}/orders/drafts/new" class="dl-btn-primary">Create draft order</a>
  </div>

  ${isEmpty ? renderEmpty(base) : renderList(base, drafts, total, page)}
</div>
`

  res.send(sellerLayout({
    title: 'Drafts',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'orders',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

function renderEmpty(base: string): string {
  return `<section class="dl-card dl-empty">
    <h2>No draft orders yet</h2>
    <p>Drafts let you build an order on behalf of a customer before charging them. Useful for phone or in-person sales.</p>
    <a href="${base}/orders/drafts/new" class="dl-btn-primary">Create draft order</a>
  </section>`
}

function renderList(base: string, drafts: any[], total: number, page: number): string {
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE))
  const rows = drafts.map(d => {
    const id = String(d.id || d._id || '')
    const orderName = d.order_number || d.name || `#D${id.slice(-4)}`
    const email = d.email || d.customer?.email || d.billing_address?.email || '—'
    const items = Array.isArray(d.line_items) ? d.line_items.length : (d.items?.length || 0)
    const total = d.total_price ?? d.total ?? 0
    const created = formatDate(d.created_at || d.create_date)
    return `<tr class="dl-row">
      <td><a href="${base}/orders/drafts/${esc(id)}" class="dl-name">${esc(orderName)}</a></td>
      <td>${esc(email)}</td>
      <td class="dl-num">${items}</td>
      <td class="dl-num">đ${Number(total).toLocaleString('en-US')}</td>
      <td class="dl-muted">${esc(created)}</td>
    </tr>`
  }).join('')

  const prev = `${base}/orders/drafts?page=${Math.max(1, page - 1)}`
  const next = `${base}/orders/drafts?page=${Math.min(totalPages, page + 1)}`

  return `
    <section class="dl-summary">
      <strong>${total} draft${total === 1 ? '' : 's'}</strong>
    </section>
    <section class="dl-card dl-list-card">
      <div class="dl-table-wrap">
        <table class="dl-table">
          <thead>
            <tr>
              <th>Draft</th>
              <th>Customer</th>
              <th class="dl-num">Items</th>
              <th class="dl-num">Total</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${totalPages > 1 ? `<div class="dl-pagination">
        <span>Page ${page} of ${totalPages}</span>
        <div class="dl-pag-btns">
          <a href="${prev}" class="dl-btn-light dl-btn-sm" ${page === 1 ? 'aria-disabled="true" style="pointer-events:none;opacity:.4"' : ''}>‹ Prev</a>
          <a href="${next}" class="dl-btn-light dl-btn-sm" ${page === totalPages ? 'aria-disabled="true" style="pointer-events:none;opacity:.4"' : ''}>Next ›</a>
        </div>
      </div>` : ''}
    </section>
  `
}

function formatDate(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const DRAFTS_LIST_STYLE = `<style>
.dl { color:var(--s-text); font-size:14px; max-width:1280px; margin:0 auto; padding-bottom:80px; }
.dl-topbar { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
.dl-topbar h1 { margin:0; font-size:20px; font-weight:600; color:var(--s-text); }
.dl-banner-ok { background:color-mix(in srgb, var(--s-success) 15%, var(--s-card)); border:1px solid var(--s-success); border-radius:8px; padding:10px 14px; margin-bottom:14px; font-size:13px; color:var(--s-text); }
.dl-banner-err { background:color-mix(in srgb, var(--s-danger) 15%, var(--s-card)); border:1px solid var(--s-danger); border-radius:8px; padding:10px 14px; margin-bottom:14px; font-size:13px; color:var(--s-text); }

.dl-card { background:var(--s-card); border:1px solid var(--s-border); border-radius:12px; padding:18px; box-shadow:var(--s-shadow); margin-bottom:14px; }
.dl-empty { text-align:center; padding:48px 24px; }
.dl-empty h2 { margin:0 0 8px; font-size:16px; font-weight:600; color:var(--s-text); }
.dl-empty p { margin:0 auto 18px; max-width:480px; font-size:13px; color:var(--s-text-muted); line-height:1.5; }

.dl-btn-light { padding:7px 14px; border:1px solid var(--s-border); background:var(--s-card); color:var(--s-text); border-radius:8px; font-size:13px; cursor:pointer; text-decoration:none; display:inline-block; }
.dl-btn-light:hover { background:var(--s-card-hover); }
.dl-btn-sm { padding:5px 10px; font-size:12px; }
.dl-btn-primary { padding:7px 14px; border:none; background:var(--s-accent); color:#fff; border-radius:8px; font-size:13px; font-weight:500; cursor:pointer; text-decoration:none; display:inline-block; }
.dl-btn-primary:hover { background:var(--s-accent-hover); }

.dl-summary { background:var(--s-card); border:1px solid var(--s-border); border-radius:12px; padding:14px 18px; margin-bottom:14px; box-shadow:var(--s-shadow); font-size:13px; color:var(--s-text); }

.dl-list-card { padding:0; overflow:hidden; }
.dl-table-wrap { overflow-x:auto; }
.dl-table { width:100%; border-collapse:collapse; font-size:13px; }
.dl-table thead th { text-align:left; padding:10px 14px; font-weight:500; color:var(--s-text-muted); font-size:12px; background:var(--s-card-hover); border-bottom:1px solid var(--s-border); }
.dl-table tbody td { padding:14px; border-bottom:1px solid var(--s-border); color:var(--s-text); }
.dl-table tbody tr:last-child td { border-bottom:none; }
.dl-row:hover td { background:var(--s-card-hover); }
.dl-num { text-align:right; }
.dl-muted { color:var(--s-text-muted); font-size:12px; }
.dl-name { color:var(--s-text); font-weight:500; text-decoration:none; }
.dl-name:hover { color:var(--s-accent); }

.dl-pagination { display:flex; justify-content:space-between; align-items:center; padding:12px 16px; border-top:1px solid var(--s-border); font-size:13px; color:var(--s-text-muted); }
.dl-pag-btns { display:flex; gap:6px; }
</style>`
