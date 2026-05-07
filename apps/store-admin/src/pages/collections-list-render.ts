/**
 * collections-list-render.ts
 * Redesigned UI v2 — hero section, status pill-tabs, richer table rows,
 * generous whitespace, responsive grid stats. Shopify Polaris-inspired.
 */

import type { Request } from 'express'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { pagination } from '../components/pagination.js'
import { bulkActionBar } from '../components/bulk-action-bar.js'
import { emptyState } from '../components/empty-state.js'
import type { Category } from '../lib/product-api-types.js'

export interface CollectionsListPageData {
  req: Request
  categories: Category[]
  totalCount: number
  publishedCount: number
  draftCount: number
  page: number
  totalPages: number
  q: string
  status: string
  sort: string
  colBase: string
  flash?: { type: 'success' | 'error'; message: string }
}

function formatDate(raw: string | undefined | null): string {
  if (!raw) return '—'
  try {
    return new Date(raw).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })
  } catch {
    return esc(raw)
  }
}

/** BE trả `description` có thể chứa HTML — strip tag + truncate cho preview. */
function previewDescription(raw: string | undefined | null, max = 90): string {
  if (!raw) return ''
  const text = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return text.slice(0, max).trimEnd() + '…'
}

function buildQS(extras: Record<string, string | undefined>, exclude?: string): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(extras)) {
    if (k === exclude) continue
    if (v) params.set(k, v)
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

export function renderCollectionsListPage(data: CollectionsListPageData): string {
  const { req, categories, totalCount, publishedCount, draftCount, page, totalPages, q, status, sort, colBase, flash } = data

  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const csrfToken = typeof (req as any).csrfToken === 'function' ? (req as any).csrfToken() : ((req as any).csrfToken ?? '')

  const styles = `<style>
    .col-page{max-width:1280px;margin:0 auto;padding:24px 28px}
    .col-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;padding:8px 0 24px;border-bottom:1px solid var(--gx-border,rgba(255,255,255,.08));margin-bottom:24px;flex-wrap:wrap}
    .col-hero h1{margin:0;font-size:28px;font-weight:600;letter-spacing:-.01em;color:var(--gx-text,#e8eaf0)}
    .col-hero p{margin:6px 0 0;font-size:14px;color:var(--gx-muted,#9aa0a6)}
    .col-hero-cta{display:flex;gap:10px;align-items:center}
    .col-btn{display:inline-flex;align-items:center;gap:6px;padding:9px 16px;border-radius:8px;font-size:14px;font-weight:500;text-decoration:none;border:1px solid transparent;transition:.15s;cursor:pointer;line-height:1}
    .col-btn-primary{background:linear-gradient(180deg,#5b6dff,#4854e0);color:#fff;box-shadow:0 1px 0 rgba(255,255,255,.1) inset,0 1px 2px rgba(0,0,0,.2)}
    .col-btn-primary:hover{background:linear-gradient(180deg,#6577ff,#5260e8);transform:translateY(-1px)}
    .col-btn-ghost{background:transparent;color:var(--gx-text,#e8eaf0);border-color:var(--gx-border,rgba(255,255,255,.12))}
    .col-btn-ghost:hover{background:rgba(255,255,255,.04)}
    .col-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:28px}
    .col-stat{padding:16px 18px;background:var(--gx-surface,rgba(255,255,255,.03));border:1px solid var(--gx-border,rgba(255,255,255,.06));border-radius:10px;display:flex;align-items:center;gap:14px;transition:.15s}
    .col-stat:hover{border-color:rgba(91,109,255,.3)}
    .col-stat-icon{width:40px;height:40px;border-radius:10px;display:grid;place-items:center;font-size:20px;flex-shrink:0}
    .col-stat-icon-total{background:rgba(91,109,255,.12);color:#7c8aff}
    .col-stat-icon-pub{background:rgba(34,197,94,.12);color:#22c55e}
    .col-stat-icon-draft{background:rgba(234,179,8,.12);color:#eab308}
    .col-stat-label{font-size:12px;color:var(--gx-muted,#9aa0a6);text-transform:uppercase;letter-spacing:.04em;font-weight:500;margin:0 0 2px}
    .col-stat-value{font-size:22px;font-weight:600;color:var(--gx-text,#e8eaf0);margin:0;line-height:1.1}
    .col-toolbar{display:flex;gap:12px;align-items:center;margin-bottom:18px;flex-wrap:wrap}
    .col-search{position:relative;flex:1;min-width:240px;max-width:480px}
    .col-search input{width:100%;padding:10px 12px 10px 38px;background:var(--gx-surface,rgba(255,255,255,.04));border:1px solid var(--gx-border,rgba(255,255,255,.08));border-radius:9px;font-size:14px;color:var(--gx-text,#e8eaf0);transition:.15s;box-sizing:border-box}
    .col-search input:focus{outline:none;border-color:#5b6dff;box-shadow:0 0 0 3px rgba(91,109,255,.15)}
    .col-search input::placeholder{color:var(--gx-muted,#7a8089)}
    .col-search-icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--gx-muted,#7a8089);pointer-events:none}
    .col-tabs{display:flex;gap:4px;background:var(--gx-surface,rgba(255,255,255,.04));border:1px solid var(--gx-border,rgba(255,255,255,.06));border-radius:9px;padding:3px}
    .col-tab{padding:7px 14px;border-radius:6px;font-size:13px;font-weight:500;color:var(--gx-muted,#9aa0a6);text-decoration:none;transition:.15s;display:inline-flex;align-items:center;gap:6px;line-height:1}
    .col-tab:hover{color:var(--gx-text,#e8eaf0)}
    .col-tab-active{background:var(--gx-bg,#1a1d24);color:var(--gx-text,#fff);box-shadow:0 1px 2px rgba(0,0,0,.15)}
    .col-tab-count{font-size:11px;background:rgba(255,255,255,.1);padding:1px 6px;border-radius:10px;color:inherit;font-variant-numeric:tabular-nums}
    .col-sort{padding:9px 12px;background:var(--gx-surface,rgba(255,255,255,.04));border:1px solid var(--gx-border,rgba(255,255,255,.08));border-radius:9px;color:var(--gx-text,#e8eaf0);font-size:14px;cursor:pointer}
    .col-sort:focus{outline:none;border-color:#5b6dff}
    .col-table-card{background:var(--gx-surface,rgba(255,255,255,.02));border:1px solid var(--gx-border,rgba(255,255,255,.06));border-radius:12px;overflow:hidden;margin-bottom:18px}
    .col-table{width:100%;border-collapse:collapse}
    .col-table thead th{text-align:left;padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--gx-muted,#7a8089);font-weight:600;border-bottom:1px solid var(--gx-border,rgba(255,255,255,.06));background:rgba(255,255,255,.015)}
    .col-table tbody tr{transition:.1s;border-bottom:1px solid var(--gx-border,rgba(255,255,255,.04))}
    .col-table tbody tr:last-child{border-bottom:0}
    .col-table tbody tr:hover{background:rgba(91,109,255,.04)}
    .col-table td{padding:14px 16px;vertical-align:middle;font-size:14px;color:var(--gx-text,#dadde3)}
    .col-thumb{width:48px;height:48px;border-radius:8px;object-fit:cover;display:block;background:rgba(255,255,255,.04)}
    .col-thumb-empty{width:48px;height:48px;border-radius:8px;display:grid;place-items:center;font-size:20px;background:linear-gradient(135deg,rgba(91,109,255,.08),rgba(91,109,255,.02));border:1px dashed rgba(91,109,255,.25);color:rgba(91,109,255,.6)}
    .col-name{font-weight:500;color:var(--gx-text,#e8eaf0);text-decoration:none;display:block}
    .col-name:hover{color:#7c8aff}
    .col-slug{font-size:12px;color:var(--gx-muted,#7a8089);font-family:ui-monospace,Menlo,monospace;margin-top:3px}
    .col-desc{font-size:12.5px;color:var(--gx-muted,#a3a7ae);margin-top:4px;line-height:1.45;max-width:520px}
    .col-meta{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px}
    .col-mini-pill{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:10px;font-size:10.5px;font-weight:600;letter-spacing:.02em;line-height:1.4}
    .col-mini-pill-detail{background:rgba(91,109,255,.12);color:#a3aeff}
    .col-mini-pill-google{background:rgba(234,88,12,.12);color:#fdba74}
    .col-pill{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600;letter-spacing:.02em}
    .col-pill-pub{background:rgba(34,197,94,.12);color:#4ade80}
    .col-pill-draft{background:rgba(234,179,8,.12);color:#facc15}
    .col-pill-dot{width:6px;height:6px;border-radius:50%;background:currentColor}
    .col-row-action{padding:6px 10px;border-radius:6px;font-size:13px;color:var(--gx-muted,#9aa0a6);text-decoration:none;transition:.15s}
    .col-row-action:hover{background:rgba(255,255,255,.06);color:var(--gx-text,#fff)}
    .col-checkbox{width:16px;height:16px;accent-color:#5b6dff;cursor:pointer}
    .col-flash{padding:12px 16px;border-radius:9px;margin-bottom:16px;font-size:14px;display:flex;align-items:center;gap:10px}
    .col-flash-success{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.25);color:#86efac}
    .col-flash-error{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);color:#fca5a5}
    .col-empty{text-align:center;padding:64px 32px}
    .col-empty-art{font-size:56px;margin-bottom:12px;opacity:.7}
    .col-empty-title{font-size:18px;font-weight:600;color:var(--gx-text);margin:0 0 6px}
    .col-empty-desc{font-size:14px;color:var(--gx-muted,#9aa0a6);margin:0 0 18px;max-width:420px;margin-left:auto;margin-right:auto}
    @media (max-width:720px){.col-hero{flex-direction:column;align-items:stretch}.col-toolbar{flex-direction:column;align-items:stretch}.col-search{max-width:none}.col-tabs{justify-content:space-between}}
  </style>`

  // Build status tab URLs (preserve q + sort)
  const tabBase = (newStatus: string) => {
    const qs = buildQS({ q, sort, status: newStatus || undefined, page: page > 1 ? String(page) : undefined })
    return `${colBase}${qs}`
  }
  const tab = (val: string, label: string, count: number, active: boolean) =>
    `<a href="${esc(tabBase(val))}" class="col-tab${active ? ' col-tab-active' : ''}">${esc(label)}<span class="col-tab-count">${count.toLocaleString()}</span></a>`

  const statusTabs = `<div class="col-tabs" role="tablist" aria-label="Filter by status">
    ${tab('', 'All', totalCount, status === '' || status === 'all')}
    ${tab('published', 'Published', publishedCount, status === 'published')}
    ${tab('draft', 'Draft', draftCount, status === 'draft')}
  </div>`

  // Stats with icons
  const stats = `<div class="col-stats">
    <div class="col-stat"><div class="col-stat-icon col-stat-icon-total">📚</div><div><div class="col-stat-label">Total</div><div class="col-stat-value">${totalCount.toLocaleString()}</div></div></div>
    <div class="col-stat"><div class="col-stat-icon col-stat-icon-pub">✓</div><div><div class="col-stat-label">Published</div><div class="col-stat-value">${publishedCount.toLocaleString()}</div></div></div>
    <div class="col-stat"><div class="col-stat-icon col-stat-icon-draft">✎</div><div><div class="col-stat-label">Draft</div><div class="col-stat-value">${draftCount.toLocaleString()}</div></div></div>
  </div>`

  // Search + sort toolbar (search GET form preserves status + sort)
  const searchIcon = `<svg class="col-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>`
  const sortOptions = [
    { v: 'newest', l: 'Newest' },
    { v: 'oldest', l: 'Oldest' },
    { v: 'name', l: 'Name A→Z' },
    { v: 'products_desc', l: 'Most products' },
  ]
  const sortHtml = `<form method="get" action="${esc(colBase)}" style="display:contents">
    ${status ? `<input type="hidden" name="status" value="${esc(status)}">` : ''}
    <div class="col-search">${searchIcon}<input type="search" name="q" placeholder="Search collections by name…" value="${esc(q)}" autocomplete="off"></div>
    <select name="sort" class="col-sort" onchange="this.form.submit()">
      ${sortOptions.map((o) => `<option value="${o.v}"${sort === o.v ? ' selected' : ''}>${o.l}</option>`).join('')}
    </select>
    <button type="submit" class="col-btn col-btn-ghost">Apply</button>
  </form>`

  // Table or empty state
  const hasFilter = q.trim() !== '' || status !== ''
  let tableHtml: string
  if (categories.length === 0) {
    tableHtml = `<div class="col-table-card"><div class="col-empty">
      <div class="col-empty-art">${hasFilter ? '🔍' : '📂'}</div>
      <h3 class="col-empty-title">${hasFilter ? 'No collections found' : 'No collections yet'}</h3>
      <p class="col-empty-desc">${hasFilter ? 'Try adjusting your search or status filter.' : 'Create your first collection to group products by theme, season, or category…'}</p>
      <a href="${esc(hasFilter ? colBase : `${colBase}/new`)}" class="col-btn col-btn-primary">${hasFilter ? 'Reset filters' : '+ Create collection'}</a>
    </div></div>`
  } else {
    const rowsHtml = categories.map((c) => {
      const id = String(c.id ?? '')
      // Fallback chain: name → slug → id. BE lưu name="" hợp lệ (chưa rename),
      // `?? '—'` không fallback empty string nên cần `||`.
      const displayName = (c.name && c.name.trim()) || (c.slug && c.slug.trim()) || (id ? `#${id.slice(-6)}` : '—')
      const isPub = c.status === true || (c as any).status === 'published'
      const pillClass = isPub ? 'col-pill-pub' : 'col-pill-draft'
      const pillLabel = isPub ? 'Published' : 'Draft'
      const thumb = c.image_url
        ? `<img src="${esc(c.image_url)}" alt="" class="col-thumb" loading="lazy">`
        : `<div class="col-thumb-empty">📁</div>`
      // Cột "Cập nhật" ưu tiên update_date (BE set khi PUT category)
      const updatedRaw = c.update_date ?? c.create_date
      const updated = formatDate(updatedRaw)
      const desc = previewDescription(c.description)
      const descHtml = desc ? `<div class="col-desc">${esc(desc)}</div>` : ''
      const metaItems: string[] = []
      if (c.display_detail === true) {
        metaItems.push(`<span class="col-mini-pill col-mini-pill-detail" title="Display description/SEO on storefront">📖 Show detail</span>`)
      }
      if (c.google_product_category) {
        metaItems.push(`<span class="col-mini-pill col-mini-pill-google" title="Google Shopping category: ${esc(c.google_product_category)}">🛒 Google</span>`)
      }
      const metaHtml = metaItems.length ? `<div class="col-meta">${metaItems.join('')}</div>` : ''
      return `<tr>
        <td style="width:40px;padding-right:0"><input type="checkbox" name="ids[]" value="${esc(id)}" class="col-checkbox col-row-check" form="col-bulk-form" aria-label="Select ${esc(displayName)}"></td>
        <td style="width:64px">${thumb}</td>
        <td><a href="${esc(colBase)}/${esc(id)}" class="col-name">${esc(displayName)}</a><div class="col-slug">${esc(c.slug ?? '')}</div>${descHtml}${metaHtml}</td>
        <td><span class="col-pill ${pillClass}"><span class="col-pill-dot"></span>${pillLabel}</span></td>
        <td style="color:var(--gx-muted,#9aa0a6);font-size:13px">${esc(updated)}</td>
        <td style="text-align:right;width:140px"><a href="${esc(colBase)}/${esc(id)}/edit" class="col-row-action">Edit</a><a href="${esc(colBase)}/${esc(id)}" class="col-row-action">View</a></td>
      </tr>`
    }).join('')

    tableHtml = `<div class="col-table-card"><table class="col-table">
      <thead><tr>
        <th style="width:40px"><input type="checkbox" id="col-select-all" class="col-checkbox" aria-label="Select all"></th>
        <th></th>
        <th>Name</th>
        <th>Status</th>
        <th>Updated</th>
        <th></th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table></div>`
  }

  // Pagination (existing component)
  const paginationHtml = pagination({
    page,
    totalPages,
    baseUrl: colBase,
    query: Object.fromEntries(
      [q ? ['q', q] : null, status ? ['status', status] : null, sort ? ['sort', sort] : null].filter(Boolean) as [string, string][],
    ),
  })

  // Bulk action bar (kept separate, sticky-bottom)
  const bulkBar = bulkActionBar({
    formAction: `${colBase}/bulk`,
    csrfToken,
    actions: [
      { value: 'publish', label: 'Publish' },
      { value: 'unpublish', label: 'Unpublish' },
      { value: 'delete', label: 'Delete', destructive: true },
    ],
  })

  // Select-all + sync ids[] hidden form
  const selectAllScript = `<script>(function(){
    var all=document.getElementById('col-select-all'),boxes=document.querySelectorAll('.col-row-check');
    if(!all)return;
    all.addEventListener('change',function(){boxes.forEach(function(b){b.checked=all.checked;b.dispatchEvent(new Event('change',{bubbles:true}))});});
  })();</script>`

  // Bulk form (hidden, receives ids via form attribute on each checkbox)
  const bulkForm = `<form id="col-bulk-form" method="post" action="${esc(colBase)}/bulk" style="display:none">
    <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
  </form>`

  const flashHtml = flash
    ? `<div class="col-flash col-flash-${flash.type}" role="${flash.type === 'error' ? 'alert' : 'status'}">${esc(flash.message)}</div>`
    : ''

  const content = `${styles}
    <div class="col-page">
      ${flashHtml}
      <header class="col-hero">
        <div>
          <h1>Collections</h1>
          <p>Group products by theme, season, or category to help customers find them.</p>
        </div>
        <div class="col-hero-cta">
          <a href="${esc(colBase)}/new" class="col-btn col-btn-primary">+ Create collection</a>
        </div>
      </header>

      ${stats}

      <div class="col-toolbar">
        ${statusTabs}
        ${sortHtml}
      </div>

      ${tableHtml}
      ${paginationHtml}
      ${bulkForm}
      ${bulkBar}
      ${selectAllScript}
    </div>
  `

  return sellerLayout({
    title: 'Collections',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'collections',
    content,
    theme: theme as 'dark' | 'light',
  })
}

