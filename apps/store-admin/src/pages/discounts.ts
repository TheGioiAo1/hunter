/**
 * Store Admin — Discounts (API mode, bám sát Gbox-Order-Service).
 *
 * Routes mounted in server.ts:
 *   GET  /admin/store/:slug/discounts                        → getDiscounts (list)
 *   GET  /admin/store/:slug/discounts/new                    → getCreateDiscount (form)
 *   POST /admin/store/:slug/discounts                        → postCreateDiscount
 *   GET  /admin/store/:slug/discounts/:discountId            → getDiscountDetail (edit form)
 *   POST /admin/store/:slug/discounts/:discountId/update     → postUpdateDiscount
 *   POST /admin/store/:slug/discounts/:discountId/delete     → postDeleteDiscount
 *
 * BE Discount fields & enum: xem discount-api-client.ts.
 * UI giống Shopify (list + 2-column form), dữ liệu khớp BE 1-1.
 */

import type { Request, Response } from 'express'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { formatProductApiError } from '../lib/product-api-errors.js'
import {
  createApiContext,
  listDiscounts,
  getDiscount,
  createDiscount,
  updateDiscount,
  deleteDiscount,
  discountTypeLabel,
  discountStatus,
  type BeDiscount,
  type DiscountType,
  type RangeType,
  type DiscountEntityKind,
} from '../lib/discount-api-client.js'
import { renderDiscountForm } from './discount-form.js'

// ─── Helpers ─────

function num(v: unknown): number | undefined {
  if (v == null || v === '') return undefined
  const n = parseFloat(String(v))
  return Number.isFinite(n) ? n : undefined
}
function intNum(v: unknown): number | undefined {
  if (v == null || v === '') return undefined
  const n = parseInt(String(v), 10)
  return Number.isFinite(n) ? n : undefined
}
function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  const d = new Date(s)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function fmtValue(d: BeDiscount): string {
  const v = d.discount_value ?? 0
  return d.discount_type === 1 ? `${v.toFixed(2)} fix` : `${v}%`
}
function statusBadge(s: string): string {
  const map: Record<string, [string, string]> = {
    active:    ['#16a34a', 'rgba(34,197,94,.15)'],
    scheduled: ['#d97706', 'rgba(245,158,11,.15)'],
    expired:   ['var(--s-text-secondary)', 'rgba(107,114,128,.15)'],
    disabled:  ['#ef4444', 'rgba(239,68,68,.15)'],
  }
  const [color, bg] = map[s] ?? map.disabled
  return `<span style="display:inline-block;padding:2px 10px;border-radius:9999px;background:${bg};color:${color};font-size:11px;font-weight:600;text-transform:capitalize">${s}</span>`
}

// ISO datetime input parse (datetime-local trả "YYYY-MM-DDTHH:mm")
function parseDateInput(v: unknown): string | undefined {
  const s = String(v ?? '').trim()
  if (!s) return undefined
  const d = new Date(s)
  if (isNaN(d.getTime())) return undefined
  return d.toISOString()
}

function flashStyles(): string {
  return `<style>
    .gbx-flash{display:flex;align-items:center;gap:8px;padding:10px 14px;margin:0 0 16px;border-radius:8px;font-size:13px;font-weight:500}
    .gbx-flash-success{color:#065f46;background:#d1fae5;border:1px solid #a7f3d0}
    .gbx-flash-error{color:#991b1b;background:#fee2e2;border:1px solid #fecaca}
    [data-theme="dark"] .gbx-flash-success{color:#a7f3d0;background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.3)}
    [data-theme="dark"] .gbx-flash-error{color:#fecaca;background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.3)}
  </style>`
}

// ─── GET /discounts — list ─────

export async function getDiscounts(req: Request, res: Response, _db: any): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const csrfField = csrfHiddenField(req.csrfToken!)

  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1)
  const limit = 20
  const keyword = String(req.query.q ?? '').trim()
  const tab = String(req.query.tab ?? 'all').toLowerCase() as 'all' | 'code' | 'auto'

  let discounts: BeDiscount[] = []
  let total = 0
  let errMsg: string | null = null

  try {
    const ctx = createApiContext(req)
    const r = await listDiscounts(ctx, {
      page,
      limit,
      keyword: keyword || undefined,
      is_auto: tab === 'auto' ? true : tab === 'code' ? false : undefined,
    })
    discounts = r.data ?? []
    total = r.pagination?.count ?? discounts.length
  } catch (err) {
    errMsg = formatProductApiError(err)
  }
  const totalPages = Math.max(1, Math.ceil(total / limit))

  const flashSuccess = String(req.query.success ?? '').slice(0, 200)
  const flashError = String(req.query.error ?? '').slice(0, 200)

  function tabUrl(t: string): string {
    const p = new URLSearchParams()
    if (t !== 'all') p.set('tab', t)
    if (keyword) p.set('q', keyword)
    return `${base}/discounts${p.toString() ? '?' + p : ''}`
  }
  const tabClass = (t: string) => tab === t ? 'tab active' : 'tab'

  const rowsHtml = discounts.length === 0
    ? `<tr><td colspan="6" style="text-align:center;padding:60px 20px;color:var(--s-text-secondary)">
         <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="margin-bottom:12px;opacity:.5"><path d="M20 12V8H4v4M20 12v4a2 2 0 01-2 2H6a2 2 0 01-2-2v-4M20 12H4"/><path d="M12 8v4"/></svg>
         <h3 style="margin:0 0 4px;font-size:15px;font-weight:600;color:var(--s-text)">No discounts ${keyword ? 'matching your search' : 'yet'}</h3>
         <p style="margin:0 0 16px;font-size:13px">Create a discount code or automatic discount to encourage purchases.</p>
         <a href="${base}/discounts/new" class="btn btn-primary">Create discount</a>
       </td></tr>`
    : discounts.map(d => {
        const status = discountStatus(d)
        const usesText = d.usage_limit ? `0 / ${d.usage_limit}` : '0 used'  // BE chưa expose used count
        return `<tr>
          <td>
            <a href="${base}/discounts/${esc(d.id ?? '')}" style="color:var(--s-accent);text-decoration:none;font-weight:600">${esc(d.name ?? '(unnamed)')}</a>
            ${d.code ? `<div style="font-size:11px;color:var(--s-text-secondary);font-family:monospace;margin-top:2px">${esc(d.code)}</div>` : '<div style="font-size:11px;color:var(--s-text-secondary);font-style:italic;margin-top:2px">Automatic</div>'}
          </td>
          <td style="font-size:12px">${esc(discountTypeLabel(d.discount_type))}</td>
          <td style="font-family:monospace;font-weight:600">${fmtValue(d)}</td>
          <td>${statusBadge(status)}</td>
          <td style="font-size:12px;color:var(--s-text-secondary)">${usesText}</td>
          <td style="font-size:12px;color:var(--s-text-secondary);white-space:nowrap">${fmtDate(d.created_at)}</td>
        </tr>`
      }).join('')

  const content = `
    ${flashStyles()}
    ${flashSuccess ? `<div class="gbx-flash gbx-flash-success">${esc(flashSuccess)}</div>` : ''}
    ${flashError ? `<div class="gbx-flash gbx-flash-error">${esc(flashError)}</div>` : ''}
    ${errMsg ? `<div class="gbx-flash gbx-flash-error">${esc(errMsg)}</div>` : ''}

    <div class="page-header">
      <div>
        <h3 class="page-title" style="margin:0">Discounts</h3>
        <p class="page-subtitle">${total} ${total === 1 ? 'discount' : 'discounts'}</p>
      </div>
      <a href="${base}/discounts/new" class="btn btn-primary">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v10M3 8h10"/></svg>
        Create discount
      </a>
    </div>

    <!-- Search -->
    <div class="card" style="margin-bottom:16px">
      <div class="card-body" style="padding:12px 16px">
        <form method="GET" action="${base}/discounts" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          ${tab !== 'all' ? `<input type="hidden" name="tab" value="${esc(tab)}">` : ''}
          <input type="text" name="q" value="${esc(keyword)}" placeholder="Search by code or name…" style="flex:1;min-width:200px;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;background:var(--s-input-bg);color:var(--s-text);font-size:13px;outline:none">
          <button type="submit" class="btn btn-outline btn-sm">Search</button>
          ${keyword ? `<a href="${tabUrl(tab)}" class="btn btn-outline btn-sm" style="color:var(--s-danger)">Clear</a>` : ''}
        </form>
      </div>
    </div>

    <!-- Tabs: All / Code / Automatic -->
    <div class="tabs">
      <a href="${tabUrl('all')}" class="${tabClass('all')}">All</a>
      <a href="${tabUrl('code')}" class="${tabClass('code')}">Code</a>
      <a href="${tabUrl('auto')}" class="${tabClass('auto')}">Automatic</a>
    </div>

    <div class="card">
      <div class="card-body" style="padding:0">
        <div class="table-wrap"><table>
          <thead><tr>
            <th style="width:30%">Discount</th>
            <th>Type</th>
            <th>Value</th>
            <th>Status</th>
            <th>Used</th>
            <th>Created</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table></div>
      </div>
      ${totalPages > 1 ? `
        <div style="display:flex;justify-content:center;gap:6px;padding:12px;border-top:1px solid var(--s-border)">
          ${page > 1 ? `<a href="${base}/discounts?page=${page - 1}${tab !== 'all' ? '&tab=' + tab : ''}${keyword ? '&q=' + encodeURIComponent(keyword) : ''}" class="btn btn-outline btn-sm">&laquo; Prev</a>` : ''}
          <span style="font-size:12px;color:var(--s-text-secondary);align-self:center">Page ${page} of ${totalPages}</span>
          ${page < totalPages ? `<a href="${base}/discounts?page=${page + 1}${tab !== 'all' ? '&tab=' + tab : ''}${keyword ? '&q=' + encodeURIComponent(keyword) : ''}" class="btn btn-outline btn-sm">Next &raquo;</a>` : ''}
        </div>
      ` : ''}
    </div>
  `

  res.send(sellerLayout({
    title: 'Discounts',
    storeName: store.name, storeSlug: store.slug,
    userName: user.name, userEmail: user.email,
    userRole: user.role, storeRole: user.storeRole,
    activePage: 'discounts',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ─── GET /discounts/new — create form ─────

export async function getCreateDiscount(req: Request, res: Response, _db: any): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const csrfField = csrfHiddenField(req.csrfToken!)
  const flashError = String(req.query.error ?? '').slice(0, 200)

  const content = `
    ${flashStyles()}
    ${flashError ? `<div class="gbx-flash gbx-flash-error">${esc(flashError)}</div>` : ''}
    <div class="page-header">
      <div>
        <a href="${base}/discounts" style="color:var(--s-text-secondary);text-decoration:none;font-size:12px;display:flex;align-items:center;gap:4px;margin-bottom:4px">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 12L6 8l4-4"/></svg>
          Discounts
        </a>
        <h3 class="page-title" style="margin:0">Create discount</h3>
      </div>
    </div>
    ${renderDiscountForm({ base, csrfField, action: `${base}/discounts` })}
  `

  res.send(sellerLayout({
    title: 'Create Discount',
    storeName: store.name, storeSlug: store.slug,
    userName: user.name, userEmail: user.email,
    userRole: user.role, storeRole: user.storeRole,
    activePage: 'discounts',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ─── GET /discounts/:id — edit form ─────

export async function getDiscountDetail(req: Request, res: Response, _db: any): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const csrfField = csrfHiddenField(req.csrfToken!)
  const id = String(req.params.discountId || '')

  let discount: BeDiscount | null = null
  let errMsg: string | null = null
  try {
    const ctx = createApiContext(req)
    discount = await getDiscount(ctx, id)
  } catch (err) {
    errMsg = formatProductApiError(err)
  }

  if (!discount && !errMsg) {
    res.status(404).send(sellerLayout({
      title: 'Discount not found',
      storeName: store.name, storeSlug: store.slug,
      userName: user.name, userEmail: user.email,
      userRole: user.role, storeRole: user.storeRole,
      activePage: 'discounts',
      content: `<div style="text-align:center;padding:80px 20px">
        <h3 style="margin:0 0 8px;font-size:18px">Discount not found</h3>
        <p style="margin:0 0 16px;font-size:13px;color:var(--s-text-secondary)">This discount may have been deleted.</p>
        <a href="${base}/discounts" class="btn btn-primary">Back to Discounts</a>
      </div>`,
      theme: theme as 'dark' | 'light',
    }))
    return
  }

  const flashSuccess = String(req.query.success ?? '').slice(0, 200)
  const flashError = String(req.query.error ?? '').slice(0, 200)

  const content = `
    ${flashStyles()}
    ${flashSuccess ? `<div class="gbx-flash gbx-flash-success">${esc(flashSuccess)}</div>` : ''}
    ${flashError ? `<div class="gbx-flash gbx-flash-error">${esc(flashError)}</div>` : ''}
    ${errMsg ? `<div class="gbx-flash gbx-flash-error">${esc(errMsg)}</div>` : ''}

    <div class="page-header">
      <div>
        <a href="${base}/discounts" style="color:var(--s-text-secondary);text-decoration:none;font-size:12px;display:flex;align-items:center;gap:4px;margin-bottom:4px">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 12L6 8l4-4"/></svg>
          Discounts
        </a>
        <h3 class="page-title" style="margin:0">${esc(discount?.name ?? '')}</h3>
        <p style="margin:4px 0 0;font-size:12px;color:var(--s-text-secondary)">
          ${discount?.code ? `Code: <code style="background:var(--s-input-bg);padding:1px 6px;border-radius:4px">${esc(discount.code)}</code>` : 'Automatic discount'}
          ${discount?.created_at ? ` &middot; Created ${fmtDate(discount.created_at)}` : ''}
        </p>
      </div>
      <form method="POST" action="${base}/discounts/${esc(id)}/delete" onsubmit="return confirm('Delete this discount permanently?')" style="margin-right:8px">
        ${csrfField}
        <button type="submit" class="btn btn-outline" style="color:var(--s-danger);border-color:var(--s-danger)">Delete</button>
      </form>
    </div>

    ${discount ? renderDiscountForm({
      base, csrfField,
      action: `${base}/discounts/${esc(id)}/update`,
      isEdit: true,
      discount,
    }) : ''}
  `

  res.send(sellerLayout({
    title: discount?.name ? `Edit: ${discount.name}` : 'Edit Discount',
    storeName: store.name, storeSlug: store.slug,
    userName: user.name, userEmail: user.email,
    userRole: user.role, storeRole: user.storeRole,
    activePage: 'discounts',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ─── Body → BE Discount payload ─────

function buildPayload(body: any): BeDiscount {
  const method = String(body.method ?? 'code').trim()
  const isAuto = method === 'auto'

  const dt = parseInt(String(body.discount_type ?? '0'), 10)
  const discount_type: DiscountType = (dt === 1 ? 1 : 0) as DiscountType

  const rt = String(body.range_type ?? '').trim()
  const range_type: RangeType | undefined = rt === '0' ? 0 : rt === '1' ? 1 : undefined

  // Entity scope: 'all' | 'category' | 'product'
  const scope = String(body.entity_scope ?? 'all').trim()
  const entityIdsRaw = String(body.entity_ids_raw ?? '').trim()
  const entityIds = scope === 'all'
    ? []
    : entityIdsRaw.split(/[\s,;\n]+/).map(s => s.trim()).filter(Boolean)
  const entityKind: DiscountEntityKind | undefined = scope === 'category' ? 0 : scope === 'product' ? 1 : undefined

  // Customer emails — newline/comma separated
  const emailsRaw = String(body.customer_emails_raw ?? '').trim()
  const emails = emailsRaw.split(/[\s,;\n]+/).map(s => s.trim()).filter(Boolean)

  return {
    name: String(body.name ?? '').trim() || undefined,
    code: isAuto ? undefined : (String(body.code ?? '').trim().toUpperCase() || undefined),
    is_auto: isAuto,
    discount_type,
    discount_value: num(body.discount_value),
    start_date: parseDateInput(body.start_date),
    end_date: parseDateInput(body.end_date),
    range_type,
    min_value: range_type != null ? num(body.min_value) : undefined,
    max_value: range_type != null ? num(body.max_value) : undefined,
    ids: entityIds.length > 0 ? entityIds : undefined,
    entities: entityIds.length > 0
      ? entityIds.map(id => ({ entity_id: id, entity_name: id }))  // FE chỉ gửi id; BE auto-resolve hoặc giữ nguyên
      : undefined,
    entity: entityKind,
    entity_excluded: entityIds.length > 0 ? body.entity_excluded === 'true' : undefined,
    individual_use: body.individual_use === 'true',
    excluded_sale_items: body.excluded_sale_items === 'true',
    customer_emails: emails.length > 0 ? emails : undefined,
    status: body.status === 'true',
    usage_limit: intNum(body.usage_limit),
    usage_limit_per_user: intNum(body.usage_limit_per_user),
  }
}

// ─── POST /discounts — create ─────

export async function postCreateDiscount(req: Request, res: Response, _db: any): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`

  const payload = buildPayload(req.body)
  if (!payload.name) {
    res.redirect(`${base}/discounts/new?error=Name+is+required`)
    return
  }
  if (payload.discount_value == null || payload.discount_value <= 0) {
    res.redirect(`${base}/discounts/new?error=Discount+value+must+be+greater+than+0`)
    return
  }

  try {
    const ctx = createApiContext(req)
    const created = await createDiscount(ctx, payload)
    console.log('[discounts] created:', created.id, created.name, created.code ?? '(auto)')
    res.redirect(`${base}/discounts/${encodeURIComponent(created.id ?? '')}?success=Discount+created`)
  } catch (err) {
    console.error('[discounts] create failed:', err)
    res.redirect(`${base}/discounts/new?error=${encodeURIComponent(formatProductApiError(err))}`)
  }
}

// ─── POST /discounts/:id/update — update ─────

export async function postUpdateDiscount(req: Request, res: Response, _db: any): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const id = String(req.params.discountId || '')

  const payload = buildPayload(req.body)
  if (!payload.name) {
    res.redirect(`${base}/discounts/${encodeURIComponent(id)}?error=Name+is+required`)
    return
  }

  try {
    const ctx = createApiContext(req)
    await updateDiscount(ctx, id, payload)
    res.redirect(`${base}/discounts/${encodeURIComponent(id)}?success=Discount+updated`)
  } catch (err) {
    console.error('[discounts] update failed:', err)
    res.redirect(`${base}/discounts/${encodeURIComponent(id)}?error=${encodeURIComponent(formatProductApiError(err))}`)
  }
}

// ─── POST /discounts/:id/delete — delete ─────

export async function postDeleteDiscount(req: Request, res: Response, _db: any): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const id = String(req.params.discountId || '')

  try {
    const ctx = createApiContext(req)
    await deleteDiscount(ctx, id)
    res.redirect(`${base}/discounts?success=Discount+deleted`)
  } catch (err) {
    console.error('[discounts] delete failed:', err)
    res.redirect(`${base}/discounts/${encodeURIComponent(id)}?error=${encodeURIComponent(formatProductApiError(err))}`)
  }
}
