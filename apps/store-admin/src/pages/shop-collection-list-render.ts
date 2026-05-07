/**
 * shop-collection-list-render.ts
 * Render trang list Collections — sử dụng BE CollectionController.
 */

import type { Request } from 'express'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { pagination } from '../components/pagination.js'
import type { ShopCollection } from '../lib/collection-api-types.js'

export interface CollectionListPageData {
  req: Request
  collections: ShopCollection[]
  totalCount: number
  publishedCount: number
  draftCount: number
  page: number
  totalPages: number
  q: string
  status: string
  sort: string
  base: string
  flash?: { type: 'success' | 'error'; message: string }
}

function fmtDate(raw: string | null | undefined): string {
  if (!raw) return '—'
  try {
    return new Date(raw).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch { return esc(raw) }
}

function buildQs(extras: Record<string, string | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(extras)) if (v) p.set(k, v)
  const s = p.toString()
  return s ? `?${s}` : ''
}

export function renderShopCollectionListPage(data: CollectionListPageData): string {
  const { req, collections, totalCount, publishedCount, draftCount, page, totalPages, q, status, sort, base, flash } = data
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const csrfToken = typeof (req as any).csrfToken === 'function' ? (req as any).csrfToken() : ((req as any).csrfToken ?? '')

  const styles = `<style>
    .sc-page{max-width:1280px;margin:0 auto;padding:24px 28px}
    .sc-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;padding:8px 0 20px;margin-bottom:20px;border-bottom:1px solid var(--gx-border,rgba(255,255,255,.08));flex-wrap:wrap}
    .sc-hero h1{margin:0;font-size:26px;font-weight:600;letter-spacing:-.01em}
    .sc-hero p{margin:4px 0 0;font-size:13px;color:var(--gx-muted)}
    .sc-btn{display:inline-flex;align-items:center;gap:6px;padding:9px 16px;border-radius:8px;font-size:13.5px;font-weight:500;text-decoration:none;border:1px solid transparent;cursor:pointer}
    .sc-btn-primary{background:linear-gradient(180deg,#5b6dff,#4854e0);color:#fff}
    .sc-btn-primary:hover{background:linear-gradient(180deg,#6577ff,#5260e8)}
    .sc-btn-ghost{background:transparent;color:var(--gx-text);border-color:var(--gx-border,rgba(255,255,255,.12))}
    .sc-btn-ghost:hover{background:rgba(255,255,255,.04)}
    .sc-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px}
    .sc-stat{padding:14px 16px;background:var(--gx-surface,rgba(255,255,255,.03));border:1px solid var(--gx-border);border-radius:10px;display:flex;align-items:center;gap:12px}
    .sc-stat-icon{width:36px;height:36px;border-radius:9px;display:grid;place-items:center;font-size:16px;flex-shrink:0}
    .sc-stat-label{font-size:11px;color:var(--gx-muted);text-transform:uppercase;letter-spacing:.04em;font-weight:500}
    .sc-stat-val{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}
    .sc-toolbar{background:var(--gx-surface,rgba(255,255,255,.02));border:1px solid var(--gx-border);border-radius:12px 12px 0 0;border-bottom:0;padding:14px 16px;display:flex;flex-direction:column;gap:12px}
    .sc-tabs{display:flex;gap:4px;background:rgba(255,255,255,.04);border:1px solid var(--gx-border,rgba(255,255,255,.06));border-radius:9px;padding:3px;width:fit-content}
    .sc-tab{padding:7px 14px;border-radius:6px;font-size:13px;font-weight:500;color:var(--gx-muted);text-decoration:none;display:inline-flex;gap:7px}
    .sc-tab:hover{color:var(--gx-text)}
    .sc-tab-active{background:var(--gx-bg,#1a1d24);color:#fff;box-shadow:0 1px 2px rgba(0,0,0,.15)}
    .sc-tab-count{font-size:11px;background:rgba(255,255,255,.1);padding:1px 7px;border-radius:10px}
    .sc-search-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    .sc-search{position:relative;flex:1;min-width:240px}
    .sc-search input{width:100%;padding:9px 12px 9px 36px;background:var(--gx-bg,#13161c);border:1px solid var(--gx-border);border-radius:8px;font-size:13.5px;color:var(--gx-text);box-sizing:border-box;outline:none}
    .sc-search input:focus{border-color:#5b6dff;box-shadow:0 0 0 3px rgba(91,109,255,.15)}
    .sc-search-icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--gx-muted);pointer-events:none}
    .sc-sort{padding:9px 12px;background:var(--gx-bg,#13161c);border:1px solid var(--gx-border);border-radius:8px;color:var(--gx-text);font-size:13px;cursor:pointer}
    .sc-table-card{background:var(--gx-surface,rgba(255,255,255,.02));border:1px solid var(--gx-border);border-top:0;border-radius:0 0 12px 12px;overflow:hidden;margin-bottom:20px}
    .sc-table{width:100%;border-collapse:collapse}
    .sc-table thead th{text-align:left;padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--gx-muted);font-weight:600;border-bottom:1px solid var(--gx-border);background:rgba(255,255,255,.015)}
    .sc-table tbody tr{transition:.1s;border-bottom:1px solid var(--gx-border,rgba(255,255,255,.04))}
    .sc-table tbody tr:hover{background:rgba(91,109,255,.04)}
    .sc-table td{padding:14px 16px;vertical-align:middle;font-size:14px;color:var(--gx-text)}
    .sc-thumb{width:48px;height:48px;border-radius:8px;object-fit:cover;background:rgba(255,255,255,.04);border:1px solid var(--gx-border,rgba(255,255,255,.06))}
    .sc-thumb-empty{width:48px;height:48px;border-radius:8px;display:grid;place-items:center;background:linear-gradient(135deg,rgba(91,109,255,.08),rgba(91,109,255,.02));border:1px dashed rgba(91,109,255,.25);color:rgba(91,109,255,.6);font-size:20px}
    .sc-name{font-weight:500;color:var(--gx-text);text-decoration:none;display:block}
    .sc-name:hover{color:#7c8aff}
    .sc-slug{font-size:12px;color:var(--gx-muted);font-family:ui-monospace,Menlo,monospace;margin-top:3px}
    .sc-pill{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600;letter-spacing:.02em}
    .sc-pill-pub{background:rgba(34,197,94,.12);color:#4ade80}
    .sc-pill-draft{background:rgba(234,179,8,.12);color:#facc15}
    .sc-pill-dot{width:6px;height:6px;border-radius:50%;background:currentColor}
    .sc-products-cell{display:flex;flex-direction:column;gap:3px;font-size:13px}
    .sc-products-count{font-variant-numeric:tabular-nums;font-weight:500;color:var(--gx-text)}
    .sc-products-count.sc-zero{color:var(--gx-muted);font-weight:400}
    .sc-products-preview{font-size:11.5px;color:var(--gx-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px}
    .sc-action{padding:5px 10px;border-radius:6px;font-size:13px;color:var(--gx-muted);text-decoration:none}
    .sc-action:hover{background:rgba(255,255,255,.06);color:#fff}
    .sc-action-del{color:#fca5a5}
    .sc-action-del:hover{background:rgba(239,68,68,.12);color:#ef4444}
    .sc-flash{padding:11px 14px;border-radius:8px;margin-bottom:14px;font-size:13.5px}
    .sc-flash-success{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.25);color:#86efac}
    .sc-flash-error{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);color:#fca5a5}
    .sc-empty{text-align:center;padding:60px 24px}
    .sc-empty-art{font-size:52px;margin-bottom:10px;opacity:.6}
    .sc-checkbox{width:15px;height:15px;cursor:pointer;accent-color:#5b6dff}
  </style>`

  const flashHtml = flash
    ? `<div class="sc-flash sc-flash-${flash.type}" role="${flash.type === 'error' ? 'alert' : 'status'}">${esc(flash.message)}</div>`
    : ''

  const tabUrl = (s: string) => `${base}${buildQs({ q, sort, status: s || undefined, page: page > 1 ? String(page) : undefined })}`
  const tab = (val: string, label: string, count: number, active: boolean) =>
    `<a href="${esc(tabUrl(val))}" class="sc-tab${active ? ' sc-tab-active' : ''}">${esc(label)}<span class="sc-tab-count">${count.toLocaleString()}</span></a>`

  const sortOptions = [
    ['create_date_desc', 'Newest'],
    ['create_date_asc', 'Oldest'],
    ['name_asc', 'Name A→Z'],
    ['name_desc', 'Name Z→A'],
    ['update_date_desc', 'Updated'],
  ] as const

  const tableHtml = collections.length === 0
    ? `<div class="sc-table-card"><div class="sc-empty">
        <div class="sc-empty-art">${q || status ? '🔍' : '📂'}</div>
        <h3 style="margin:0 0 6px;font-size:18px;font-weight:600">${q || status ? 'No collections found' : 'No collections yet'}</h3>
        <p style="margin:0 0 18px;font-size:14px;color:var(--gx-muted);max-width:420px;margin-left:auto;margin-right:auto">${q || status ? 'Try adjusting your search or filter.' : 'Group products by theme, season, or category to help customers find them.'}</p>
        <a href="${esc(q || status ? base : `${base}/new`)}" class="sc-btn sc-btn-primary">${q || status ? 'Reset filters' : '+ Create collection'}</a>
      </div></div>`
    : `<div class="sc-table-card"><table class="sc-table">
        <thead><tr>
          <th style="width:40px"><input type="checkbox" id="sc-select-all" class="sc-checkbox" aria-label="Select all"></th>
          <th></th>
          <th>Title</th>
          <th>Status</th>
          <th>Products</th>
          <th>Updated</th>
          <th style="text-align:right;width:140px"></th>
        </tr></thead>
        <tbody>${collections.map((c) => {
          const id = String(c.id ?? '')
          const isPub = c.status === true
          const products = Array.isArray(c.products) ? c.products : []
          const productCount = products.length
          // Preview tên 2 product đầu — truncate nếu nhiều hơn để cột không quá dài.
          const previewNames = products
            .slice(0, 2)
            .map((p) => (p?.product_name ?? '').toString().trim())
            .filter(Boolean)
          const previewText = productCount === 0
            ? ''
            : productCount <= 2
              ? previewNames.join(', ')
              : `${previewNames.join(', ')}, +${productCount - 2} more`
          const thumb = c.image_url
            ? `<img src="${esc(c.image_url)}" class="sc-thumb" alt="" loading="lazy">`
            : `<div class="sc-thumb-empty">📁</div>`
          const displayName = (c.name && c.name.trim()) || (c.slug && c.slug.trim()) || `#${id.slice(-6)}`
          return `<tr>
            <td><input type="checkbox" name="ids[]" value="${esc(id)}" class="sc-checkbox sc-row-cb" form="sc-bulk-form" aria-label="Select ${esc(displayName)}"></td>
            <td style="width:64px">${thumb}</td>
            <td>
              <a href="${esc(base)}/${esc(id)}/edit" class="sc-name">${esc(displayName)}</a>
              ${c.slug ? `<div class="sc-slug">${esc(c.slug)}</div>` : ''}
            </td>
            <td><span class="sc-pill ${isPub ? 'sc-pill-pub' : 'sc-pill-draft'}"><span class="sc-pill-dot"></span>${isPub ? 'Active' : 'Draft'}</span></td>
            <td>
              <div class="sc-products-cell">
                <span class="sc-products-count${productCount === 0 ? ' sc-zero' : ''}">${productCount}</span>
                ${previewText ? `<span class="sc-products-preview" title="${esc(previewText)}">${esc(previewText)}</span>` : ''}
              </div>
            </td>
            <td style="color:var(--gx-muted);font-size:13px">${fmtDate(c.update_date ?? c.create_date)}</td>
            <td style="text-align:right">
              <a href="${esc(base)}/${esc(id)}/edit" class="sc-action">Edit</a>
              <form method="POST" action="${esc(base)}/${esc(id)}/delete" style="display:inline" onsubmit="return confirm('Delete &quot;${esc(displayName).replace(/"/g, '&quot;')}&quot;?')">
                <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
                <button type="submit" class="sc-action sc-action-del" style="border:0;background:transparent;cursor:pointer;font:inherit">Delete</button>
              </form>
            </td>
          </tr>`
        }).join('')}</tbody>
      </table></div>`

  const paginationHtml = pagination({
    page, totalPages, baseUrl: base,
    query: Object.fromEntries(
      [q ? ['q', q] : null, status ? ['status', status] : null, sort ? ['sort', sort] : null]
        .filter(Boolean) as [string, string][],
    ),
  })

  const bulkForm = `<form id="sc-bulk-form" method="POST" action="${esc(base)}/bulk" style="display:none"><input type="hidden" name="_csrf" value="${esc(csrfToken)}"></form>`

  const selectAllScript = `<script>(function(){
    var all=document.getElementById('sc-select-all'),boxes=document.querySelectorAll('.sc-row-cb');
    if(!all)return;
    all.addEventListener('change',function(){boxes.forEach(function(b){b.checked=all.checked});});
  })();</script>`

  const content = `${styles}
    <div class="sc-page">
      ${flashHtml}
      <header class="sc-hero">
        <div>
          <h1>Collections</h1>
          <p>Group products by theme, season, or category to help customers find them.</p>
        </div>
        <a href="${esc(base)}/new" class="sc-btn sc-btn-primary">+ Create collection</a>
      </header>

      <div class="sc-stats">
        <div class="sc-stat"><div class="sc-stat-icon" style="background:rgba(91,109,255,.12);color:#7c8aff">📚</div><div><div class="sc-stat-label">Total</div><div class="sc-stat-val">${totalCount.toLocaleString()}</div></div></div>
        <div class="sc-stat"><div class="sc-stat-icon" style="background:rgba(34,197,94,.12);color:#22c55e">✓</div><div><div class="sc-stat-label">Active</div><div class="sc-stat-val">${publishedCount.toLocaleString()}</div></div></div>
        <div class="sc-stat"><div class="sc-stat-icon" style="background:rgba(234,179,8,.12);color:#eab308">✎</div><div><div class="sc-stat-label">Draft</div><div class="sc-stat-val">${draftCount.toLocaleString()}</div></div></div>
      </div>

      <div class="sc-toolbar">
        <div class="sc-tabs" role="tablist" aria-label="Filter by status">
          ${tab('', 'All', totalCount, !status)}
          ${tab('active', 'Active', publishedCount, status === 'active')}
          ${tab('draft', 'Draft', draftCount, status === 'draft')}
        </div>
        <form method="get" action="${esc(base)}" class="sc-search-row">
          <div class="sc-search">
            <svg class="sc-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>
            <input type="search" name="q" value="${esc(q)}" placeholder="Search collections by name, slug, description…" autocomplete="off">
          </div>
          ${status ? `<input type="hidden" name="status" value="${esc(status)}">` : ''}
          <select name="sort" class="sc-sort" onchange="this.form.submit()">
            ${sortOptions.map(([v, l]) => `<option value="${v}"${sort === v ? ' selected' : ''}>${l}</option>`).join('')}
          </select>
          <button type="submit" class="sc-btn sc-btn-ghost">Apply</button>
        </form>
      </div>

      ${tableHtml}
      ${paginationHtml}
      ${bulkForm}
      ${selectAllScript}
    </div>`

  return sellerLayout({
    title: 'Collections',
    storeName: store.name, storeSlug: store.slug,
    userName: user.name, userEmail: user.email,
    userRole: user.role, storeRole: user.storeRole,
    activePage: 'collections', content,
    theme: theme as 'dark' | 'light',
  })
}
