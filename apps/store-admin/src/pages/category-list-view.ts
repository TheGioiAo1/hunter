/**
 * /products?source=category — flat list of shop's product categories.
 *
 * BE Category model is FLAT (no parent_id). Tree view is deferred until
 * BE adds a parent reference or we wire google_product_category mapping.
 * For now this is a plain searchable + paginated list.
 */

import type { Request, Response } from 'express'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import {
  createApiContext,
  listCategories,
  listProducts,
  ProductApiError,
  type ApiContext,
} from '../lib/product-api-client.js'
import type { Category } from '../lib/product-api-types.js'

// BE chưa có count endpoint riêng cho category. Cách duy nhất: với mỗi
// category fire 1 listProducts(limit=1, fields=id) và đọc pagination.count.
// 25 calls/page chạy parallel — BE rate limit 120 req/s + isCache=true.
async function fetchProductCount(ctx: ApiContext, categoryId: string): Promise<number> {
  try {
    const resp = await listProducts(ctx, {
      categoryIds: categoryId,
      limit: 1,
      fields: 'id',
      isCache: true,
    })
    return Number(resp?.pagination?.count ?? 0)
  } catch {
    return -1 // sentinel: unknown
  }
}

export async function renderCategoryListView(
  req: Request,
  res: Response,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  const page = Math.max(1, parseInt(req.query.page as string) || 1)
  const perPage = 25
  const search = ((req.query.q as string) || '').trim()

  let categories: Category[] = []
  let totalCount = 0
  let totalPages = 1
  let errorMsg = ''
  // categoryId → product count (-1 = unknown / fetch failed)
  const productCounts: Record<string, number> = {}

  try {
    const ctx = createApiContext(req)
    const resp = await listCategories(ctx, {
      page,
      limit: perPage,
      keyword: search || undefined,
    })
    categories = Array.isArray(resp?.data) ? resp.data : []
    totalCount = Number(resp?.pagination?.count ?? categories.length)
    totalPages = Math.max(1, Math.ceil(totalCount / perPage))

    // Parallel fan-out — N=25 max per page, BE cache + rate limit 120/s.
    const withId = categories.filter((c) => !!c.id)
    const counts = await Promise.all(withId.map((c) => fetchProductCount(ctx, c.id!)))
    withId.forEach((c, i) => {
      productCounts[c.id!] = counts[i]
    })
  } catch (err) {
    if (err instanceof ProductApiError) {
      errorMsg = `${err.kind}: ${err.message}`
    } else {
      errorMsg = String((err as any)?.message || err)
    }
    console.error('[Categories] list error:', errorMsg)
  }

  function pageUrl(p: number): string {
    const q = new URLSearchParams()
    q.set('source', 'category')
    if (search) q.set('q', search)
    if (p > 1) q.set('page', String(p))
    return `${base}/products?${q.toString()}`
  }

  const tabsHtml = `
    <div class="source-tabs">
      <a href="${base}/products" class="source-tab">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 4l6-2 6 2v8l-6 2-6-2V4zM2 4l6 2 6-2M8 6v8"/></svg>
        My products
      </a>
      <a href="${base}/products?source=lenful" class="source-tab">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="6"/><path d="M8 2v12M2 8h12"/></svg>
        Lenful products
        <span class="source-tab-pill">POD</span>
      </a>
      <a href="${base}/products?source=category" class="source-tab active">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 3h5v5H2zM9 3h5v5H9zM2 10h5v4H2zM9 10h5v4H9z"/></svg>
        List Category
      </a>
    </div>
  `

  const errorBanner = errorMsg
    ? `<div role="alert" style="margin-bottom:16px;padding:12px 14px;border:1px solid rgba(239,68,68,.35);background:rgba(239,68,68,.08);border-radius:8px;color:#f87171;font-size:13.5px">Failed to load categories — ${esc(errorMsg)}</div>`
    : ''

  const rowsHtml =
    categories.length === 0
      ? `<tr><td colspan="5" style="text-align:center;padding:48px 16px;color:var(--s-text-muted,#9aa0a6)">${
          search ? `No categories match "${esc(search)}"` : 'No categories yet.'
        }</td></tr>`
      : categories
          .map((c) => {
            const status =
              c.status === false
                ? '<span class="badge badge-warning">Inactive</span>'
                : '<span class="badge badge-success">Active</span>'
            const img = c.image_url
              ? `<img src="${esc(c.image_url)}" alt="" style="width:36px;height:36px;border-radius:6px;object-fit:cover;background:rgba(255,255,255,.04)">`
              : `<div style="width:36px;height:36px;border-radius:6px;background:rgba(255,255,255,.04);display:inline-grid;place-items:center;color:var(--s-text-muted,#7a8089);font-size:11px">—</div>`
            // Click count → drill into Products list filtered by this category.
            const cnt = c.id != null ? productCounts[c.id] : undefined
            const cntCell =
              cnt === undefined || cnt < 0
                ? `<span style="color:var(--s-text-muted,#7a8089)">—</span>`
                : cnt === 0
                  ? `<span style="color:var(--s-text-muted,#9aa0a6);font-variant-numeric:tabular-nums">0</span>`
                  : `<a href="${base}/products?categoryIds=${encodeURIComponent(c.id!)}" style="font-weight:500;color:var(--s-text,#e8eaf0);font-variant-numeric:tabular-nums;text-decoration:none">${cnt.toLocaleString()}</a>`
            return `
              <tr>
                <td>${img}</td>
                <td>
                  <div style="font-weight:500;color:var(--s-text,#e8eaf0)">${esc(c.name ?? '—')}</div>
                  ${c.description ? `<div style="font-size:12px;color:var(--s-text-muted,#9aa0a6);margin-top:2px">${esc(String(c.description).slice(0, 80))}${String(c.description).length > 80 ? '…' : ''}</div>` : ''}
                </td>
                <td style="font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--s-text-muted,#9aa0a6)">${esc(c.slug ?? '')}</td>
                <td>${cntCell}</td>
                <td>${status}</td>
              </tr>
            `
          })
          .join('')

  let paginationHtml = ''
  if (totalPages > 1) {
    const prev = page > 1 ? `<a href="${pageUrl(page - 1)}" class="btn btn-outline btn-sm">‹ Prev</a>` : ''
    const next =
      page < totalPages ? `<a href="${pageUrl(page + 1)}" class="btn btn-outline btn-sm">Next ›</a>` : ''
    paginationHtml = `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 0">
        <span style="font-size:13px;color:var(--gx-muted,#9aa0a6)">Page ${page} of ${totalPages} — ${totalCount} categories</span>
        <div style="display:flex;gap:8px">${prev}${next}</div>
      </div>
    `
  }

  const content = `
    ${errorBanner}
    <div class="page-header">
      <div>
        <h1 class="page-title">Categories</h1>
        <p class="page-subtitle">${totalCount} categor${totalCount === 1 ? 'y' : 'ies'} found</p>
      </div>
    </div>

    <style>
      /* Source tabs — same shape as /products page */
      .source-tabs{display:flex;gap:4px;margin:0 0 20px;border-bottom:1px solid var(--s-border,rgba(255,255,255,.08));padding-bottom:0}
      .source-tab{display:inline-flex;align-items:center;gap:8px;padding:10px 18px;border-radius:8px 8px 0 0;font-size:14px;font-weight:600;color:var(--s-text-muted,#9aa0a6);text-decoration:none;border:1px solid transparent;border-bottom:none;margin-bottom:-1px;transition:background .12s,color .12s}
      .source-tab:hover{color:var(--s-text,#e8eaf0);background:rgba(99,102,241,.05)}
      .source-tab.active{color:var(--s-accent,#6366f1);background:var(--s-card,#13161c);border-color:var(--s-border,rgba(255,255,255,.08));border-bottom:1px solid var(--s-card,#13161c)}
      .source-tab svg{opacity:.75}
      .source-tab.active svg{opacity:1}
      .source-tab-pill{display:inline-block;padding:1px 8px;border-radius:10px;background:linear-gradient(135deg,#8b5cf6,#6366f1);color:#fff;font-size:10px;font-weight:700;letter-spacing:.4px}

      /* Toolbar + search */
      .cl-toolbar{background:var(--s-card,rgba(255,255,255,.02));border:1px solid var(--s-border,rgba(255,255,255,.08));border-radius:12px 12px 0 0;border-bottom:0;padding:14px 16px}
      .cl-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
      .cl-search{position:relative;flex:1;min-width:240px}
      .cl-search input{width:100%;padding:9px 12px 9px 36px;background:var(--s-bg,#13161c);border:1px solid var(--s-border,rgba(255,255,255,.08));border-radius:8px;font-size:13.5px;color:var(--s-text,#e8eaf0);box-sizing:border-box;outline:none}
      .cl-search input:focus{border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.15)}
      .cl-search-icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--s-text-muted,#7a8089);pointer-events:none}
      .cl-clear{padding:6px 10px;font-size:12px;color:var(--s-text-muted,#9aa0a6);text-decoration:none;border-radius:6px;border:1px solid var(--s-border,rgba(255,255,255,.08))}
      .cl-clear:hover{color:var(--s-text,#fff);background:rgba(255,255,255,.04)}

      /* Table — center-aligned columns */
      .cl-table{width:100%;border-collapse:collapse;table-layout:auto}
      .cl-table thead tr{background:rgba(255,255,255,.02);border-bottom:1px solid var(--s-border,rgba(255,255,255,.08))}
      .cl-table th{text-align:center;padding:10px 14px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--s-text-muted,#9aa0a6);font-weight:500}
      .cl-table tbody tr{border-bottom:1px solid var(--s-border,rgba(255,255,255,.06));transition:background .12s}
      .cl-table tbody tr:hover{background:rgba(99,102,241,.04)}
      .cl-table tbody tr:last-child{border-bottom:none}
      .cl-table td{padding:12px 14px;vertical-align:middle;text-align:center}
      [data-theme="light"] .source-tab.active{background:#fff;border-bottom-color:#fff}
      [data-theme="light"] .cl-search input{background:#fff}
    </style>

    ${tabsHtml}

    <div class="cl-toolbar">
      <form method="GET" action="${base}/products" class="cl-row">
        <input type="hidden" name="source" value="category">
        <div class="cl-search">
          <svg class="cl-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>
          <input type="search" name="q" value="${esc(search)}" placeholder="Search categories by name…" autocomplete="off">
        </div>
        ${search ? `<a href="${base}/products?source=category" class="cl-clear">Clear</a>` : ''}
      </form>
    </div>

    <div class="card" style="border-radius:0 0 12px 12px;padding:0;overflow:hidden;border-top:0">
      <table class="cl-table">
        <thead>
          <tr>
            <th style="width:60px">&nbsp;</th>
            <th>Name</th>
            <th>Slug</th>
            <th>Products</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>

    ${paginationHtml}
  `

  res.send(
    sellerLayout({
      title: 'Categories',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'products',
      content,
      cookieHeader: req.headers.cookie ?? null,
    }),
  )
}
