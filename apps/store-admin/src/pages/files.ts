/**
 * Store Admin — Files library.
 *
 * Phase 7 PR5. The seller-facing Shopify-style "Files" page:
 * upload → browse → rename/alt → delete. This module is the HTTP
 * handler glue — all validation / quota / storage lives in the
 * `@gbox/core/modules/files/service` module.
 *
 * Routes (wired in server.ts):
 *   GET  /admin/store/:slug/online-store/files             — list UI
 *   POST /admin/store/:slug/online-store/files/upload      — multipart upload
 *   POST /admin/store/:slug/online-store/files/:id/delete  — delete
 *   POST /admin/store/:slug/online-store/files/:id/update  — rename / alt
 *
 * Tenancy posture: every handler reads `req.store.id` and scopes every
 * query by it. Missing rows return `not_found` rather than 403 — the
 * same "never confirm the id exists in another shop" posture as the
 * rest of the admin.
 */
import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { notify, byActor } from '../lib/notify.js'
import {
  uploadFile,
  listFiles,
  getFile,
  deleteFile,
  updateFile,
  quotaFor,
  mimeCategory,
  type FileRow,
  type ListFilesOpts,
} from '@gbox/core/modules/files/service.js'
import { getPublicMediaStore } from '@gbox/core/modules/storage/index.js'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Format a byte count for display. Matches the header widget + per-row
 * size column so "0 B" / "128 KB" / "3.4 MB" all look the same.
 */
function formatBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/**
 * Format a timestamp the way sellers read it: "Apr 21, 2026" — the
 * same style as the themes / pages / blog tables so the Online Store
 * pages feel cohesive.
 */
function formatDate(ts: string | Date | null | undefined): string {
  if (!ts) return '—'
  const d = typeof ts === 'string' ? new Date(ts) : ts
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function iconForMime(mime: string | null | undefined): string {
  const cat = mimeCategory(mime ?? null)
  if (cat === 'image') {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`
  }
  if (cat === 'video') {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`
  }
  if (cat === 'audio') {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`
  }
  if (cat === 'document') {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`
  }
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#eab308" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`
}

/**
 * Turn the FLASH query params (?uploaded=hero.jpg, ?err=too_large)
 * into a banner. We use query params so the redirect-after-POST
 * pattern survives a full page reload and doesn't mix into the form
 * body.
 */
function renderBanner(req: Request): string {
  const q = req.query
  if (typeof q.err === 'string') {
    const message = errMessage(q.err)
    return `<div style="margin-bottom:16px;padding:12px 16px;border-radius:8px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.4);color:#fca5a5;font-size:13px">${esc(message)}</div>`
  }
  if (typeof q.uploaded === 'string') {
    return `<div style="margin-bottom:16px;padding:12px 16px;border-radius:8px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.4);color:#86efac;font-size:13px">Uploaded <strong>${esc(q.uploaded)}</strong>.</div>`
  }
  if (typeof q.deleted === 'string') {
    return `<div style="margin-bottom:16px;padding:12px 16px;border-radius:8px;background:rgba(148,163,184,.1);border:1px solid rgba(148,163,184,.3);color:#cbd5e1;font-size:13px">Deleted <strong>${esc(q.deleted)}</strong>.</div>`
  }
  if (typeof q.updated === 'string') {
    return `<div style="margin-bottom:16px;padding:12px 16px;border-radius:8px;background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.4);color:#a5b4fc;font-size:13px">Updated <strong>${esc(q.updated)}</strong>.</div>`
  }
  return ''
}

function errMessage(code: string): string {
  switch (code) {
    case 'filename_required': return 'Please pick a file with a name before uploading.'
    case 'mime_not_allowed':  return 'That file type is not allowed. Try an image, video, audio, PDF, text, or font file.'
    case 'too_large':         return 'That file is larger than the 20 MB per-upload limit.'
    case 'quota_exceeded':    return 'Your shop is out of storage space. Delete some files or upgrade your plan.'
    case 'upload_failed':     return 'The upload failed. Please try again.'
    case 'no_file':           return 'No file was attached to the request.'
    case 'not_found':         return 'That file no longer exists.'
    default:                  return 'Something went wrong. Please try again.'
  }
}

// ---------------------------------------------------------------------------
// GET /online-store/files — the browser page
// ---------------------------------------------------------------------------

/**
 * Render the Files library UI:
 *   - Header widget: total files / bytes used / quota / plan
 *   - Upload dropzone (multipart POST to /upload)
 *   - Search + type filter (query-param round-trip — no JS needed)
 *   - Grid of files with image thumbnails + inline rename / delete / copy-url
 *
 * The JSX-like HTML is hand-rolled to match the rest of the store-admin
 * pages (no React); escape every user-supplied string via `esc`.
 */
export async function getFilesPage(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  try {
    const store = req.store!
    const user = req.storeUser!
    const themeName = (req as any).theme || 'dark'
    const base = `/admin/store/${store.slug}`
    const csrf = (req as any).csrfToken || ''

    // Filters come from the URL so pagination + reload don't blow them
    // away. `type` is a Shopify-style broad mime bucket.
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    const typeRaw = typeof req.query.type === 'string' ? req.query.type : 'all'
    const type: ListFilesOpts['type'] =
      typeRaw === 'image' || typeRaw === 'video' || typeRaw === 'document' || typeRaw === 'other'
        ? typeRaw
        : 'all'
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1)
    const pageSize = 24
    const offset = (page - 1) * pageSize

    // Pull shop plan to display quota + enforce per-upload cap
    const shop = await (db as any)
      .selectFrom('shops')
      .select(['plan'])
      .where('id', '=', store.id)
      .executeTakeFirst()
    const plan = (shop?.plan as string | undefined) ?? 'free'
    const quotaBytes = quotaFor(plan)

    const { rows, total, usedBytes } = await listFiles(db, store.id, {
      search: q || undefined,
      type,
      limit: pageSize,
      offset,
    })

    const pages = Math.max(1, Math.ceil(total / pageSize))
    const banner = renderBanner(req)

    const typeTabs: Array<{ key: ListFilesOpts['type']; label: string }> = [
      { key: 'all', label: 'All' },
      { key: 'image', label: 'Images' },
      { key: 'video', label: 'Videos' },
      { key: 'document', label: 'Documents' },
      { key: 'other', label: 'Other' },
    ]

    const renderTab = (t: { key: ListFilesOpts['type']; label: string }) => {
      const active = (type ?? 'all') === t.key
      const qs = new URLSearchParams()
      if (q) qs.set('q', q)
      if (t.key && t.key !== 'all') qs.set('type', t.key)
      const href = `${base}/online-store/files${qs.toString() ? '?' + qs.toString() : ''}`
      return `<a href="${href}" style="padding:6px 12px;border-radius:7px;font-size:12px;font-weight:600;text-decoration:none;${active ? 'background:var(--s-accent);color:#fff' : 'background:var(--s-card-bg);color:var(--s-text);border:1px solid var(--s-border)'}">${esc(t.label)}</a>`
    }

    const renderCard = (f: FileRow) => {
      const cat = mimeCategory(f.mime_type ?? null)
      const thumb =
        cat === 'image'
          ? `<img src="${esc(f.url)}" alt="${esc(f.alt ?? f.filename)}" loading="lazy" style="width:100%;height:140px;object-fit:cover;background:#0f172a" />`
          : `<div style="width:100%;height:140px;display:flex;align-items:center;justify-content:center;background:#1e293b;color:#94a3b8">${iconForMime(f.mime_type ?? null)}</div>`
      return `
        <div class="file-card" style="border:1px solid var(--s-border);border-radius:10px;overflow:hidden;background:var(--s-card-bg);display:flex;flex-direction:column">
          ${thumb}
          <div style="padding:10px 12px;display:flex;flex-direction:column;gap:6px;flex:1">
            <div style="font-size:12px;font-weight:600;color:var(--s-text);word-break:break-all;line-height:1.35">${esc(f.filename)}</div>
            <div style="font-size:11px;color:var(--s-text-secondary)">${esc(f.mime_type ?? 'unknown')} · ${formatBytes(f.size)} · ${formatDate(f.created_at as any)}</div>
            <div style="display:flex;gap:6px;margin-top:auto;padding-top:6px">
              <button type="button" class="btn btn-outline btn-sm" style="flex:1;font-size:11px;padding:4px 8px" onclick="navigator.clipboard.writeText(${JSON.stringify(f.url)}).then(()=>this.textContent='Copied!')">Copy URL</button>
              <button type="button" class="btn btn-outline btn-sm" style="font-size:11px;padding:4px 8px" onclick="window.__openRename(${JSON.stringify(f.id)}, ${JSON.stringify(f.filename)}, ${JSON.stringify(f.alt ?? '')})">Edit</button>
              <form method="post" action="${base}/online-store/files/${esc(f.id)}/delete" onsubmit="return confirm('Delete &quot;${esc(f.filename)}&quot;? This cannot be undone.')" style="margin:0">
                <input type="hidden" name="_csrf" value="${esc(csrf)}" />
                <button type="submit" class="btn btn-outline btn-sm" style="font-size:11px;padding:4px 8px;color:#ef4444;border-color:rgba(239,68,68,.4)">Delete</button>
              </form>
            </div>
          </div>
        </div>
      `
    }

    const grid = rows.length
      ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px">${rows.map(renderCard).join('')}</div>`
      : `<div style="padding:48px 16px;text-align:center;color:var(--s-text-secondary);font-size:13px">
           <div style="margin-bottom:8px">
             <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:.4"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
           </div>
           No files match these filters yet.
         </div>`

    const pager = pages > 1
      ? `<div style="display:flex;gap:8px;justify-content:center;margin-top:24px">${
          Array.from({ length: pages }, (_, i) => i + 1).map((p) => {
            const qs = new URLSearchParams()
            if (q) qs.set('q', q)
            if (type !== 'all') qs.set('type', String(type))
            if (p !== 1) qs.set('page', String(p))
            const href = `${base}/online-store/files${qs.toString() ? '?' + qs.toString() : ''}`
            const active = p === page
            return `<a href="${href}" style="padding:6px 12px;border-radius:6px;font-size:12px;text-decoration:none;${active ? 'background:var(--s-accent);color:#fff' : 'background:var(--s-card-bg);color:var(--s-text);border:1px solid var(--s-border)'}">${p}</a>`
          }).join('')
        }</div>`
      : ''

    const quotaPct = quotaBytes ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : 0
    const quotaLabel = quotaBytes ? formatBytes(quotaBytes) : 'Unlimited'

    const content = `
      ${banner}

      <div style="margin-bottom:24px;display:flex;align-items:flex-start;justify-content:space-between;gap:16px">
        <div>
          <h1 style="font-size:20px;font-weight:700;margin:0 0 4px">Files</h1>
          <p style="color:var(--s-text-secondary);font-size:13px;margin:0">Upload and manage your store's assets and media files.</p>
        </div>
        <a href="${base}/online-store" class="btn btn-outline btn-sm" style="font-size:12px;text-decoration:none">Back to Online Store</a>
      </div>

      <!-- Storage summary -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px">
        <div style="padding:20px;border-radius:10px;background:var(--s-card-bg);border:1px solid var(--s-border)">
          <div style="font-size:11px;font-weight:600;color:var(--s-text-secondary);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">Total Files</div>
          <div style="font-size:28px;font-weight:800;color:var(--s-text)">${total}</div>
        </div>
        <div style="padding:20px;border-radius:10px;background:var(--s-card-bg);border:1px solid var(--s-border)">
          <div style="font-size:11px;font-weight:600;color:var(--s-text-secondary);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">Storage Used</div>
          <div style="font-size:28px;font-weight:800;color:var(--s-text)">${formatBytes(usedBytes)}</div>
          ${quotaBytes ? `<div style="height:6px;background:rgba(148,163,184,.15);border-radius:3px;margin-top:8px;overflow:hidden"><div style="height:100%;width:${quotaPct}%;background:${quotaPct > 85 ? '#ef4444' : 'var(--s-accent)'};transition:width .25s"></div></div>` : ''}
        </div>
        <div style="padding:20px;border-radius:10px;background:var(--s-card-bg);border:1px solid var(--s-border)">
          <div style="font-size:11px;font-weight:600;color:var(--s-text-secondary);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">Storage Quota</div>
          <div style="font-size:28px;font-weight:800;color:var(--s-accent)">${esc(quotaLabel)}</div>
          <div style="font-size:11px;color:var(--s-text-secondary);margin-top:4px">${esc(plan.charAt(0).toUpperCase() + plan.slice(1))} plan</div>
        </div>
      </div>

      <!-- Upload form -->
      <div class="card" style="margin-bottom:24px">
        <div class="card-header"><h3 class="card-title" style="margin:0;font-size:14px;font-weight:600">Upload a file</h3></div>
        <div class="card-body">
          <form id="file-upload-form" method="post" enctype="multipart/form-data" action="${base}/online-store/files/upload" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            <input type="hidden" name="_csrf" value="${esc(csrf)}" />
            <label for="file-upload-input" class="btn btn-primary btn-sm" style="font-size:12px;cursor:pointer">Choose file</label>
            <input id="file-upload-input" type="file" name="file" style="position:absolute;left:-9999px" onchange="document.getElementById('file-upload-name').textContent = this.files[0] ? this.files[0].name : 'No file chosen'; document.getElementById('file-upload-submit').disabled = !this.files[0];" />
            <div id="file-upload-name" style="font-size:12px;color:var(--s-text-secondary);flex:1">No file chosen</div>
            <input type="text" name="alt" placeholder="Alt text (optional, for images)" style="flex:1;min-width:200px;padding:6px 10px;border-radius:6px;border:1px solid var(--s-border);background:var(--s-card-bg);color:var(--s-text);font-size:12px" />
            <button id="file-upload-submit" type="submit" class="btn btn-primary btn-sm" style="font-size:12px" disabled>Upload</button>
          </form>
          <div style="font-size:11px;color:var(--s-text-secondary);margin-top:12px">Max 20 MB per file. Supported: images, video, audio, PDF, plain text, JSON, fonts.</div>
        </div>
      </div>

      <!-- Filters + grid -->
      <div class="card" style="margin-bottom:24px">
        <div class="card-header" style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between">
          <div style="display:flex;gap:6px;flex-wrap:wrap">${typeTabs.map(renderTab).join('')}</div>
          <form method="get" action="${base}/online-store/files" style="display:flex;gap:6px">
            ${type !== 'all' ? `<input type="hidden" name="type" value="${esc(String(type))}" />` : ''}
            <input type="search" name="q" value="${esc(q)}" placeholder="Search filename…" style="min-width:220px;padding:6px 10px;border-radius:6px;border:1px solid var(--s-border);background:var(--s-card-bg);color:var(--s-text);font-size:12px" />
            <button type="submit" class="btn btn-outline btn-sm" style="font-size:12px">Search</button>
          </form>
        </div>
        <div class="card-body">
          ${grid}
          ${pager}
        </div>
      </div>

      <!-- Rename modal -->
      <div id="rename-modal" style="display:none;position:fixed;inset:0;z-index:100;background:rgba(15,23,42,.6);align-items:center;justify-content:center;padding:24px">
        <div style="width:100%;max-width:440px;background:var(--s-card-bg);border:1px solid var(--s-border);border-radius:12px;padding:20px">
          <h3 style="margin:0 0 12px;font-size:15px;font-weight:700">Edit file</h3>
          <form id="rename-form" method="post" action="">
            <input type="hidden" name="_csrf" value="${esc(csrf)}" />
            <label style="display:block;font-size:11px;font-weight:600;color:var(--s-text-secondary);margin-bottom:4px">Filename</label>
            <input type="text" name="filename" id="rename-filename" required style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--s-border);background:var(--s-bg);color:var(--s-text);font-size:13px;margin-bottom:12px" />
            <label style="display:block;font-size:11px;font-weight:600;color:var(--s-text-secondary);margin-bottom:4px">Alt text</label>
            <input type="text" name="alt" id="rename-alt" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--s-border);background:var(--s-bg);color:var(--s-text);font-size:13px;margin-bottom:16px" />
            <div style="display:flex;gap:8px;justify-content:flex-end">
              <button type="button" class="btn btn-outline btn-sm" style="font-size:12px" onclick="document.getElementById('rename-modal').style.display='none'">Cancel</button>
              <button type="submit" class="btn btn-primary btn-sm" style="font-size:12px">Save</button>
            </div>
          </form>
        </div>
      </div>

      <script>
        window.__openRename = function (id, filename, alt) {
          var modal = document.getElementById('rename-modal')
          var form = document.getElementById('rename-form')
          form.action = ${JSON.stringify(base + '/online-store/files/')} + encodeURIComponent(id) + '/update'
          document.getElementById('rename-filename').value = filename
          document.getElementById('rename-alt').value = alt || ''
          modal.style.display = 'flex'
        }
        // Close on click outside the modal body.
        document.getElementById('rename-modal').addEventListener('click', function (e) {
          if (e.target === this) this.style.display = 'none'
        })
      </script>
    `

    res.send(sellerLayout({
      title: 'Files',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'online-store',
      theme: themeName,
      content,
    }))
  } catch (err) {
    console.error('getFilesPage error:', err)
    res.status(500).send('Internal server error')
  }
}

// ---------------------------------------------------------------------------
// POST /online-store/files/upload — multipart upload
// ---------------------------------------------------------------------------

/**
 * Handle a multipart upload. Multer (wired at route level in server.ts)
 * has already parsed the body into `req.file`. We translate the service
 * result into a redirect with a flash code so the browser lands back on
 * the grid with a success/error banner.
 *
 * NB: the 20 MB hard cap is enforced by multer before we see the
 * request — files over 20 MB trigger `MulterError: File too large`
 * which is mapped to the `too_large` flash code in the express error
 * handler below (registered by server.ts).
 */
export async function postUploadFile(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  // AJAX-style callers (Quill image handler / page editor picker) gửi
  // `Accept: application/json` → trả JSON, không redirect. Form upload mặc
  // định vẫn redirect như cũ.
  const wantsJson = String(req.headers.accept || '').toLowerCase().includes('application/json')
  const redirectBack = (flash: string) => res.redirect(`${base}/online-store/files?${flash}`)
  const errJson = (status: number, error: string): void => {
    res.status(status).json({ ok: false, error })
  }

  try {
    const file = (req as any).file as
      | { originalname: string; mimetype: string; size: number; buffer: Buffer }
      | undefined
    if (!file) {
      if (wantsJson) return errJson(400, 'no_file')
      return redirectBack('err=no_file')
    }

    // Pull plan → quota on every upload. Cheap enough (indexed PK
    // lookup) and keeps the quota fresh when Thai bumps a seller's plan
    // in god-admin mid-session.
    const shop = await (db as any)
      .selectFrom('shops')
      .select(['plan'])
      .where('id', '=', store.id)
      .executeTakeFirst()
    const plan = (shop?.plan as string | undefined) ?? 'free'
    const maxShopBytes = quotaFor(plan)

    const result = await uploadFile(
      db,
      {
        shopId: store.id,
        filename: file.originalname,
        mimeType: file.mimetype,
        body: file.buffer,
        alt: typeof req.body?.alt === 'string' ? req.body.alt : null,
      },
      {
        objectStore: getPublicMediaStore(),
        // 20 MB per upload — the multer limit is the hard ceiling; the
        // service also checks defensively in case of a route-level
        // misconfiguration.
        maxFileSize: 20 * 1024 * 1024,
        maxShopBytes: maxShopBytes ?? null,
      },
    )

    if (!result.ok) {
      if (wantsJson) return errJson(400, result.error)
      return redirectBack(`err=${encodeURIComponent(result.error)}`)
    }

    notify(db, {
      shopId: store.id,
      userId: user.id,
      type: 'file_uploaded',
      title: `File uploaded: ${result.file.filename}`,
      message: byActor(user),
      resourceType: 'file',
      resourceId: result.file.id,
    })

    if (wantsJson) {
      res.json({
        ok: true,
        id: result.file.id,
        url: result.file.url,
        filename: result.file.filename,
        mime_type: result.file.mime_type,
        size: result.file.size,
      })
      return
    }
    res.redirect(`${base}/online-store/files?uploaded=${encodeURIComponent(result.file.filename)}`)
  } catch (err: any) {
    console.error('postUploadFile error:', err)
    // Multer surface errors (e.g. LIMIT_FILE_SIZE) land here.
    const code = err?.code === 'LIMIT_FILE_SIZE' ? 'too_large' : 'upload_failed'
    if (wantsJson) {
      errJson(code === 'too_large' ? 413 : 500, code)
      return
    }
    redirectBack(`err=${code}`)
  }
}

// ---------------------------------------------------------------------------
// POST /online-store/files/:id/delete — delete a file
// ---------------------------------------------------------------------------

export async function postDeleteFile(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const fileId = String(req.params.id || '')

  try {
    // Peek the filename for the success banner + notification.
    const existing = await getFile(db, store.id, fileId)
    if (!existing) {
      res.redirect(`${base}/online-store/files?err=not_found`)
      return
    }

    const result = await deleteFile(db, store.id, fileId, {
      objectStore: getPublicMediaStore(),
    })
    if (!result.ok) {
      res.redirect(`${base}/online-store/files?err=${encodeURIComponent(result.error ?? 'not_found')}`)
      return
    }

    notify(db, {
      shopId: store.id,
      userId: user.id,
      type: 'file_deleted',
      title: `File deleted: ${existing.filename}`,
      message: byActor(user),
      resourceType: 'file',
      resourceId: fileId,
    })

    res.redirect(`${base}/online-store/files?deleted=${encodeURIComponent(existing.filename)}`)
  } catch (err) {
    console.error('postDeleteFile error:', err)
    res.redirect(`${base}/online-store/files?err=delete_failed`)
  }
}

// ---------------------------------------------------------------------------
// POST /online-store/files/:id/update — rename + alt
// ---------------------------------------------------------------------------

export async function postUpdateFile(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const fileId = String(req.params.id || '')
  const filename = typeof req.body?.filename === 'string' ? req.body.filename : undefined
  const alt = typeof req.body?.alt === 'string' ? req.body.alt : undefined

  try {
    const updated = await updateFile(db, store.id, fileId, {
      filename,
      alt: alt === undefined ? undefined : alt || null,
    })
    if (!updated) {
      res.redirect(`${base}/online-store/files?err=not_found`)
      return
    }

    notify(db, {
      shopId: store.id,
      userId: user.id,
      type: 'file_updated',
      title: `File updated: ${updated.filename}`,
      message: byActor(user),
      resourceType: 'file',
      resourceId: fileId,
    })

    res.redirect(`${base}/online-store/files?updated=${encodeURIComponent(updated.filename)}`)
  } catch (err) {
    console.error('postUpdateFile error:', err)
    res.redirect(`${base}/online-store/files?err=update_failed`)
  }
}
