/**
 * Store Admin — CMS Pages (About, Contact, FAQ, ...)
 *
 * Backend: Gbox-Page-Service (api-page.gbox.co). KHÔNG đụng SQLite local —
 * mọi CRUD đẩy thẳng qua Page Service. Editor 2-cột Shopify-style + Quill.
 *
 * Routes (giữ nguyên signature từ server.ts):
 *   GET   /online-store/pages                 — list
 *   GET   /online-store/pages/new             — create form
 *   POST  /online-store/pages                  — create handler
 *   GET   /online-store/pages/:pageId          — edit form
 *   POST  /online-store/pages/:pageId          — update handler
 *   POST  /online-store/pages/:pageId/delete   — delete handler
 *   POST  /online-store/pages/bulk             — bulk publish/unpublish/delete
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import {
  createApiContext,
  listPages,
  getPage,
  createPage,
  updatePage,
  deletePages,
  listPageTags,
  bulkSetPublished,
} from '../lib/page-api-client.js'
import { formatProductApiError, ProductApiError } from '../lib/product-api-errors.js'
import type { ApiPage } from '../lib/page-api-types.js'
import { pageEditorForm } from './pages-form-editor.js'

const PER_PAGE = 20

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function statusBadge(published: boolean): string {
  return published
    ? '<span style="display:inline-block;padding:2px 10px;border-radius:9999px;font-size:11px;font-weight:600;background:rgba(34,197,94,.15);color:#22c55e">Visible</span>'
    : '<span style="display:inline-block;padding:2px 10px;border-radius:9999px;font-size:11px;font-weight:600;background:rgba(148,163,184,.15);color:#94a3b8">Hidden</span>'
}

function formatDate(d: string | undefined | null): string {
  if (!d) return '-'
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return '-'
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function flashHtml(req: Request): string {
  const ok = String(req.query.success ?? '')
  const err = String(req.query.error ?? '')
  if (!ok && !err) return ''
  const style = ok
    ? 'background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3);color:#a7f3d0'
    : 'background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:#fecaca'
  return `<div style="${style};padding:10px 14px;border-radius:8px;margin-bottom:16px;font-size:13px">${esc(ok || err)}</div>`
}

function errorBanner(msg: string | null): string {
  if (!msg) return ''
  return `<div style="background:#7f1d1d;border:1px solid #f87171;border-radius:8px;padding:10px 14px;margin-bottom:16px;color:#fee2e2;font-size:13px">${esc(msg)}</div>`
}

// ---------------------------------------------------------------------------
// GET /pages — list
// ---------------------------------------------------------------------------

export async function getPages(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${store.slug}/online-store`

  const page = Math.max(1, parseInt(String(req.query.page ?? '1')) || 1)
  const search = String(req.query.q ?? '').trim()

  let pages: ApiPage[] = []
  let total = 0
  let errMsg: string | null = null

  try {
    const ctx = createApiContext(req)
    const r = await listPages(ctx, {
      page,
      limit: PER_PAGE,
      keyword: search || undefined,
    })
    pages = r.data ?? []
    total = r.pagination?.count ?? pages.length
  } catch (err) {
    errMsg = formatProductApiError(err)
    console.error('[pages] list failed:', errMsg)
  }

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE))

  function pageUrl(p: number): string {
    const params = new URLSearchParams()
    if (search) params.set('q', search)
    if (p > 1) params.set('page', String(p))
    const qs = params.toString()
    return `${base}/pages${qs ? '?' + qs : ''}`
  }

  const paginationHtml =
    totalPages > 1
      ? `<div style="display:flex;justify-content:center;align-items:center;gap:6px;padding:16px 0">
          ${page > 1 ? `<a href="${pageUrl(page - 1)}" class="btn btn-outline btn-sm">&laquo; Prev</a>` : ''}
          ${Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
            let p: number
            if (totalPages <= 7) p = i + 1
            else if (page <= 4) p = i + 1
            else if (page >= totalPages - 3) p = totalPages - 6 + i
            else p = page - 3 + i
            return `<a href="${pageUrl(p)}" class="btn btn-sm ${p === page ? 'btn-primary' : 'btn-outline'}">${p}</a>`
          }).join('')}
          ${page < totalPages ? `<a href="${pageUrl(page + 1)}" class="btn btn-outline btn-sm">Next &raquo;</a>` : ''}
        </div>`
      : ''

  const tableRows = pages
    .map(
      (p) => `
        <tr>
          <td><input type="checkbox" name="ids" value="${esc(p.id ?? '')}" class="pages-row-checkbox" style="accent-color:var(--s-accent)"></td>
          <td><a href="${base}/pages/${esc(p.id ?? '')}" style="color:var(--s-accent);text-decoration:none;font-weight:600">${esc(p.title ?? '(untitled)')}</a></td>
          <td style="font-size:12px;color:var(--s-text-secondary);font-family:monospace">${esc(p.slug ?? '')}</td>
          <td>${statusBadge(p.published ?? false)}</td>
          <td style="font-size:12px;color:var(--s-text-secondary)">${formatDate(p.updated_at)}</td>
        </tr>`,
    )
    .join('')

  const content = `
    ${flashHtml(req)}
    ${errorBanner(errMsg)}

    <div class="page-header">
      <div>
        <h2 class="page-title" style="margin:0">Pages</h2>
        <p class="page-subtitle">${total} page${total !== 1 ? 's' : ''}</p>
      </div>
      <a href="${base}/pages/new" class="btn btn-primary">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v10M3 8h10"/></svg>
        Add page
      </a>
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="card-body" style="padding:12px 20px">
        <form method="GET" action="${base}/pages" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <div style="flex:1;min-width:200px;position:relative">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#6b7280" stroke-width="1.5" style="position:absolute;left:10px;top:50%;transform:translateY(-50%)"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
            <input type="text" name="q" value="${esc(search)}" placeholder="Search pages..."
              style="width:100%;padding:8px 12px 8px 34px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg);color:var(--s-text);outline:none">
          </div>
          <button type="submit" class="btn btn-outline btn-sm">Search</button>
          ${search ? `<a href="${base}/pages" class="btn btn-outline btn-sm" style="color:var(--s-danger)">Clear</a>` : ''}
        </form>
      </div>
    </div>

    <form id="pages-bulk-form" method="POST" action="${base}/pages/bulk">
      ${csrfHiddenField(req.csrfToken!)}
      <div id="pages-bulk-bar" class="card" style="margin-bottom:12px;display:none">
        <div class="card-body" style="padding:10px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span id="pages-bulk-count" style="font-size:13px;font-weight:600">0 selected</span>
          <div style="flex:1"></div>
          <button type="submit" name="action" value="publish" class="btn btn-outline btn-sm">Make visible</button>
          <button type="submit" name="action" value="unpublish" class="btn btn-outline btn-sm">Hide</button>
          <button type="submit" name="action" value="delete" class="btn btn-outline btn-sm" style="color:var(--s-danger);border-color:var(--s-danger)"
            onclick="return confirm('Delete ' + document.querySelectorAll('input[name=&quot;ids&quot;]:checked').length + ' page(s)?')">Delete</button>
        </div>
      </div>
      <div class="card">
        <div class="card-body" style="padding:0">
          ${
            pages.length > 0
              ? `<div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th style="width:32px"><input type="checkbox" id="pages-select-all" style="accent-color:var(--s-accent)"></th>
                        <th style="width:40%">Title</th>
                        <th>Slug</th>
                        <th>Visibility</th>
                        <th>Last updated</th>
                      </tr>
                    </thead>
                    <tbody>${tableRows}</tbody>
                  </table>
                </div>
                ${paginationHtml}`
              : `<div style="text-align:center;padding:60px 20px">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--s-text-secondary)" stroke-width="1" style="margin-bottom:12px"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 7h10M7 12h10M7 17h6"/></svg>
                  <h3 style="margin:0 0 4px;font-size:15px;font-weight:600">No pages yet</h3>
                  <p style="margin:0 0 16px;font-size:13px;color:var(--s-text-secondary)">Create pages like About, Contact, FAQ for your storefront.</p>
                  <a href="${base}/pages/new" class="btn btn-primary">Add your first page</a>
                </div>`
          }
        </div>
      </div>
    </form>

    <script>
      (function () {
        var bar = document.getElementById('pages-bulk-bar');
        var countEl = document.getElementById('pages-bulk-count');
        var selectAll = document.getElementById('pages-select-all');
        var rows = document.querySelectorAll('input.pages-row-checkbox');
        function sync() {
          var n = 0;
          rows.forEach(function (cb) { if (cb.checked) n++; });
          countEl.textContent = n + ' selected';
          bar.style.display = n > 0 ? '' : 'none';
          if (selectAll) selectAll.checked = n > 0 && n === rows.length;
        }
        rows.forEach(function (cb) { cb.addEventListener('change', sync); });
        if (selectAll) {
          selectAll.addEventListener('change', function () {
            rows.forEach(function (cb) { cb.checked = selectAll.checked; });
            sync();
          });
        }
        sync();
      })();
    </script>
  `

  res.send(
    sellerLayout({
      title: 'Pages',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'pages',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

// ---------------------------------------------------------------------------
// GET /pages/new — create form
// ---------------------------------------------------------------------------

export async function getCreatePage(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${store.slug}/online-store`

  let tagSuggestions: string[] = []
  try {
    const ctx = createApiContext(req)
    tagSuggestions = await listPageTags(ctx)
  } catch {
    /* tags non-critical, swallow */
  }

  const content = `
    ${flashHtml(req)}
    <div class="page-header">
      <div>
        <a href="${base}/pages" style="color:var(--s-text-secondary);text-decoration:none;font-size:12px;display:flex;align-items:center;gap:4px;margin-bottom:4px">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 12L6 8l4-4"/></svg>
          Pages
        </a>
        <h2 class="page-title" style="margin:0">Add page</h2>
      </div>
    </div>
    ${pageEditorForm({
      base,
      csrfField: csrfHiddenField(req.csrfToken!),
      action: `${base}/pages`,
      isEdit: false,
      tagSuggestions,
    })}
  `

  res.send(
    sellerLayout({
      title: 'Add page',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'pages',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

// ---------------------------------------------------------------------------
// GET /pages/:pageId — edit form
// ---------------------------------------------------------------------------

export async function getPageDetail(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${store.slug}/online-store`
  const pageId = String(req.params.pageId || '')

  let page: ApiPage | null = null
  let tagSuggestions: string[] = []
  let errMsg: string | null = null

  try {
    const ctx = createApiContext(req)
    const [pageR, tagsR] = await Promise.all([
      getPage(ctx, pageId),
      listPageTags(ctx).catch(() => [] as string[]),
    ])
    page = pageR
    tagSuggestions = tagsR
  } catch (err) {
    errMsg = formatProductApiError(err)
  }

  if (!page) {
    res.status(404).send(
      sellerLayout({
        title: 'Page not found',
        storeName: store.name,
        storeSlug: store.slug,
        userName: user.name,
        userEmail: user.email,
        userRole: user.role,
        storeRole: user.storeRole,
        activePage: 'pages',
        content: `
          ${errorBanner(errMsg)}
          <div style="text-align:center;padding:80px 20px">
            <h2 style="margin:0 0 8px;font-size:18px">Page not found</h2>
            <p style="margin:0 0 16px;font-size:13px;color:var(--s-text-secondary)">Page có thể đã bị xóa hoặc không tồn tại.</p>
            <a href="${base}/pages" class="btn btn-primary">Back to Pages</a>
          </div>`,
        theme: theme as 'dark' | 'light',
      }),
    )
    return
  }

  const content = `
    ${flashHtml(req)}
    ${errorBanner(errMsg)}
    <div class="page-header">
      <div>
        <a href="${base}/pages" style="color:var(--s-text-secondary);text-decoration:none;font-size:12px;display:flex;align-items:center;gap:4px;margin-bottom:4px">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 12L6 8l4-4"/></svg>
          Pages
        </a>
        <h2 class="page-title" style="margin:0">${esc(page.title ?? '(untitled)')}</h2>
        <p style="margin:4px 0 0;font-size:12px;color:var(--s-text-secondary)">
          Created ${formatDate(page.created_at)} &middot; Updated ${formatDate(page.updated_at)}
        </p>
      </div>
      <div>${statusBadge(page.published ?? false)}</div>
    </div>
    ${pageEditorForm({
      base,
      csrfField: csrfHiddenField(req.csrfToken!),
      action: `${base}/pages/${esc(page.id ?? '')}`,
      isEdit: true,
      page,
      tagSuggestions,
    })}
  `

  res.send(
    sellerLayout({
      title: `Edit: ${page.title ?? 'page'}`,
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'pages',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

// ---------------------------------------------------------------------------
// Form parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse fields chung từ POST body. Trả về object hợp lệ để gửi BE — `null`
 * khi missing required (caller redirect about with error).
 */
function parsePageBody(body: any): {
  ok: true
  data: Partial<ApiPage>
} | { ok: false; error: string } {
  const title = String(body.title ?? '').trim()
  if (!title) return { ok: false, error: 'Title is required' }

  const content = String(body.content ?? '').trim()
  const template = String(body.template ?? '').trim()
  const seoTitle = String(body.seo_title ?? '').trim()
  const seoDescription = String(body.seo_description ?? '').trim()
  const imageUrl = String(body.image_url ?? '').trim()
  const publishedRaw = String(body.published ?? '')
  const published = publishedRaw === 'true'
  const tagsRaw = String(body.tags ?? '').trim()
  const tags = tagsRaw
    ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean)
    : []

  return {
    ok: true,
    data: {
      title,
      content: content || undefined,
      template: template || undefined,
      seo_title: seoTitle || undefined,
      seo_description: seoDescription || undefined,
      image_url: imageUrl || undefined,
      published,
      tags: tags.length ? tags : undefined,
    },
  }
}

// ---------------------------------------------------------------------------
// POST /pages — create handler
// ---------------------------------------------------------------------------

export async function postCreatePage(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}/online-store`

  const parsed = parsePageBody(req.body)
  if (!parsed.ok) {
    res.redirect(`${base}/pages/new?error=${encodeURIComponent(parsed.error)}`)
    return
  }

  try {
    const ctx = createApiContext(req)
    const created = await createPage(ctx, parsed.data)
    if (!created?.id) {
      res.redirect(`${base}/pages?error=${encodeURIComponent('Create failed: no id returned')}`)
      return
    }
    res.redirect(`${base}/pages/${created.id}?success=${encodeURIComponent('Page created')}`)
  } catch (err) {
    const msg = formatProductApiError(err)
    res.redirect(`${base}/pages/new?error=${encodeURIComponent(msg)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /pages/:pageId — update handler
// ---------------------------------------------------------------------------

export async function postUpdatePage(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}/online-store`
  const pageId = String(req.params.pageId || '')

  if (!pageId) {
    res.redirect(`${base}/pages?error=Missing+page+id`)
    return
  }

  const parsed = parsePageBody(req.body)
  if (!parsed.ok) {
    res.redirect(`${base}/pages/${pageId}?error=${encodeURIComponent(parsed.error)}`)
    return
  }

  try {
    const ctx = createApiContext(req)
    const updated = await updatePage(ctx, { ...parsed.data, id: pageId })
    if (!updated) {
      res.redirect(`${base}/pages/${pageId}?error=${encodeURIComponent('Page not found or update failed')}`)
      return
    }
    res.redirect(`${base}/pages/${pageId}?success=${encodeURIComponent('Page updated')}`)
  } catch (err) {
    const msg =
      err instanceof ProductApiError && err.status === 404
        ? 'Page not found'
        : formatProductApiError(err)
    res.redirect(`${base}/pages/${pageId}?error=${encodeURIComponent(msg)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /pages/:pageId/delete — single delete
// ---------------------------------------------------------------------------

export async function postDeletePage(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}/online-store`
  const pageId = String(req.params.pageId || '')

  if (!pageId) {
    res.redirect(`${base}/pages?error=Missing+page+id`)
    return
  }

  try {
    const ctx = createApiContext(req)
    // BE filter dùng id, slug chỉ để clear cache. Lookup slug trước để cache
    // sạch — nếu không có sẽ truyền id+shop_id thôi (BE vẫn delete được).
    const existing = await getPage(ctx, pageId)
    await deletePages(ctx, [
      { id: pageId, shop_id: store.id, slug: existing?.slug },
    ])
    res.redirect(`${base}/pages?success=${encodeURIComponent('Page deleted')}`)
  } catch (err) {
    const msg = formatProductApiError(err)
    res.redirect(`${base}/pages/${pageId}?error=${encodeURIComponent(msg)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /pages/bulk — bulk publish / unpublish / delete
// ---------------------------------------------------------------------------

export async function postBulkPages(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}/online-store`

  const action = String(req.body.action ?? '').trim()
  if (action !== 'publish' && action !== 'unpublish' && action !== 'delete') {
    res.redirect(`${base}/pages?error=Invalid+bulk+action`)
    return
  }

  const raw = req.body.ids
  const ids: string[] = Array.isArray(raw)
    ? raw.map(String)
    : raw
      ? [String(raw)]
      : []
  if (ids.length === 0) {
    res.redirect(`${base}/pages?error=Select+at+least+one+page`)
    return
  }

  try {
    const ctx = createApiContext(req)

    if (action === 'delete') {
      // BE muốn slug để clear cache — fetch song song (limit 5).
      const slugMap = new Map<string, string | undefined>()
      const queue = [...ids]
      const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
        while (queue.length) {
          const id = queue.shift()
          if (!id) break
          const p = await getPage(ctx, id).catch(() => null)
          slugMap.set(id, p?.slug)
        }
      })
      await Promise.all(workers)

      await deletePages(
        ctx,
        ids.map((id) => ({ id, shop_id: store.id, slug: slugMap.get(id) })),
      )
      res.redirect(
        `${base}/pages?success=${encodeURIComponent(`${ids.length} page(s) deleted`)}`,
      )
      return
    }

    // publish / unpublish
    const r = await bulkSetPublished(ctx, ids, action === 'publish')
    const verb = action === 'publish' ? 'made visible' : 'hidden'
    if (r.errors.length) {
      res.redirect(
        `${base}/pages?error=${encodeURIComponent(`${r.affected} ${verb}, ${r.errors.length} failed`)}`,
      )
    } else {
      res.redirect(
        `${base}/pages?success=${encodeURIComponent(`${r.affected} page(s) ${verb}`)}`,
      )
    }
  } catch (err) {
    const msg = formatProductApiError(err)
    res.redirect(`${base}/pages?error=${encodeURIComponent(msg)}`)
  }
}
