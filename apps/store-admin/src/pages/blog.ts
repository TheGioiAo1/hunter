/**
 * Store Admin — Blog Posts (API mode)
 *
 * Đã chuyển sang gọi Gbox-Page-Service thay vì Kysely trực tiếp.
 * Cấu trúc 2 tầng: Blog (container) → Article (bài viết).
 * blog_id được truyền qua query param (?blog_id=) và hidden form field.
 */

import type { Request, Response } from 'express'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { formatProductApiError } from '../lib/product-api-errors.js'
import {
  createApiContext,
  listBlogs,
  createBlog,
  listArticles,
  getArticle,
  createArticle,
  updateArticle,
  deleteArticles,
  bulkSetArticlePublished,
} from '../lib/blog-api-client.js'
import type { ApiBlog, ApiArticle } from '../lib/blog-api-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusBadge(published: boolean): string {
  return published
    ? '<span style="display:inline-block;padding:2px 10px;border-radius:9999px;font-size:11px;font-weight:600;background:rgba(34,197,94,.15);color:#22c55e">Published</span>'
    : '<span style="display:inline-block;padding:2px 10px;border-radius:9999px;font-size:11px;font-weight:600;background:rgba(234,179,8,.15);color:#eab308">Draft</span>'
}

function formatDate(d: string | null | undefined): string {
  if (!d) return '-'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function renderTags(tags: string[] | null | undefined): string {
  if (!tags || tags.length === 0) return '<span style="color:var(--s-text-secondary);font-size:12px">-</span>'
  return tags.map(t =>
    `<span style="display:inline-block;padding:1px 8px;border-radius:9999px;font-size:10px;font-weight:500;background:rgba(99,102,241,.12);color:var(--s-accent);margin-right:4px">${esc(t)}</span>`
  ).join('')
}

function parseTags(raw: string): string[] {
  return raw.split(',').map(t => t.trim()).filter(Boolean)
}

// ---------------------------------------------------------------------------
// Shared form
// ---------------------------------------------------------------------------

function blogForm(opts: {
  base: string
  action: string
  csrfField: string
  blogId: string
  blogs?: ApiBlog[]
  title?: string
  bodyHtml?: string
  excerpt?: string
  author?: string
  tags?: string[]
  imageUrl?: string
  published?: boolean
  seoTitle?: string
  seoDescription?: string
  isEdit?: boolean
  articleId?: string
}): string {
  const {
    base, action, csrfField, blogId, blogs = [],
    title = '', bodyHtml = '', excerpt = '', author = '',
    tags = [], imageUrl = '', published = false,
    seoTitle = '', seoDescription = '',
    isEdit = false, articleId = '',
  } = opts

  const blogSelector = blogs.length > 1
    ? `<div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-secondary)">Blog</label>
        <select name="blog_id" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg);color:var(--s-text);outline:none">
          ${blogs.map(b => `<option value="${esc(b.id ?? '')}" ${b.id === blogId ? 'selected' : ''}>${esc(b.title ?? b.slug ?? b.id ?? '')}</option>`).join('')}
        </select>
      </div>`
    : `<input type="hidden" name="blog_id" value="${esc(blogId)}">`

  return `
    <form method="POST" action="${action}" id="blog-form">
      ${csrfField}
      <div style="display:grid;grid-template-columns:1fr 320px;gap:20px;align-items:start">

        <!-- Main column -->
        <div style="display:flex;flex-direction:column;gap:20px">
          <div class="card">
            <div class="card-header"><h3 style="margin:0;font-size:14px;font-weight:600">Post content</h3></div>
            <div class="card-body" style="display:flex;flex-direction:column;gap:16px">
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-secondary)">Title</label>
                <input type="text" name="title" value="${esc(title)}" required
                  placeholder="e.g. How to choose the perfect gift"
                  style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg);color:var(--s-text);outline:none">
              </div>
              <div>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                  <label style="font-size:12px;font-weight:600;color:var(--s-text-secondary)">Content</label>
                  <button type="button" id="blog-fullscreen-btn" class="btn btn-outline btn-sm" title="Toggle fullscreen" style="font-size:11px;padding:2px 8px">⛶</button>
                </div>
                <div class="blog-editor-shell" style="border:1px solid var(--s-border);border-radius:8px;overflow:hidden;background:var(--s-input-bg)">
                  <div id="blog-editor-content"></div>
                </div>
                <input type="hidden" name="body_html" id="blog-content-input" value="${esc(bodyHtml)}">
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-secondary)">Excerpt</label>
                <textarea name="excerpt" rows="3"
                  placeholder="Short summary shown in blog listing and SEO..."
                  style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg);color:var(--s-text);outline:none;resize:vertical">${esc(excerpt)}</textarea>
              </div>
            </div>
          </div>

          <details class="card" style="margin-bottom:0" ${seoTitle || seoDescription ? 'open' : ''}>
            <summary class="card-header" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;list-style:none">
              <div>
                <h3 style="margin:0;font-size:14px;font-weight:600">Search engine listing</h3>
                <p style="margin:2px 0 0;font-size:12px;color:var(--s-text-secondary)">Override the title and description used by search engines.</p>
              </div>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="flex-shrink:0"><path d="M4 6l4 4 4-4"/></svg>
            </summary>
            <div class="card-body" style="display:flex;flex-direction:column;gap:14px">
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-secondary)">Meta title <span style="font-weight:400">(max 70 chars)</span></label>
                <input type="text" name="seo_title" value="${esc(seoTitle)}" maxlength="70"
                  placeholder="${esc(title) || 'Defaults to post title'}"
                  style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg);color:var(--s-text);outline:none">
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-secondary)">Meta description <span style="font-weight:400">(max 255 chars)</span></label>
                <textarea name="seo_description" rows="3" maxlength="255"
                  placeholder="Shown in Google / Facebook / Twitter previews."
                  style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg);color:var(--s-text);outline:none;resize:vertical">${esc(seoDescription)}</textarea>
              </div>
            </div>
          </details>
        </div>

        <!-- Sidebar -->
        <div style="display:flex;flex-direction:column;gap:20px">
          <div class="card">
            <div class="card-header"><h3 style="margin:0;font-size:14px;font-weight:600">Visibility</h3></div>
            <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
              <div style="display:flex;align-items:center;gap:8px">
                <input type="checkbox" name="published" id="published" value="true" ${published ? 'checked' : ''}
                  style="width:16px;height:16px;accent-color:var(--s-accent)">
                <label for="published" style="font-size:13px;font-weight:500;cursor:pointer">Published</label>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-header"><h3 style="margin:0;font-size:14px;font-weight:600">Organization</h3></div>
            <div class="card-body" style="display:flex;flex-direction:column;gap:14px">
              ${blogSelector}
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-secondary)">Author</label>
                <input type="text" name="author" value="${esc(author)}"
                  placeholder="Author name"
                  style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg);color:var(--s-text);outline:none">
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-secondary)">Tags</label>
                <div id="tag-chips-wrap"
                  data-initial='${esc(JSON.stringify(tags))}'
                  style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 8px;border:1px solid var(--s-border);border-radius:8px;background:var(--s-input-bg);min-height:38px;cursor:text"
                  onclick="document.getElementById('tag-chips-input').focus()">
                  <input type="text" id="tag-chips-input"
                    placeholder="${tags.length ? 'Add another…' : 'e.g. news, tips, updates'}"
                    autocomplete="off"
                    style="flex:1;min-width:120px;border:none;outline:none;background:transparent;color:var(--s-text);font-size:13px;padding:4px 2px">
                </div>
                <input type="hidden" name="tags" id="tag-chips-field" value="${esc(tags.join(', '))}">
                <p style="margin:4px 0 0;font-size:11px;color:var(--s-text-secondary)">Press Enter or comma to add.</p>
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-secondary)">Featured image URL</label>
                <input type="text" name="image_url" value="${esc(imageUrl)}"
                  placeholder="https://..."
                  style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg);color:var(--s-text);outline:none">
                ${imageUrl ? `<img src="${esc(imageUrl)}" alt="Preview" style="margin-top:8px;max-width:100%;border-radius:8px;border:1px solid var(--s-border)">` : ''}
              </div>
            </div>
          </div>

          ${isEdit ? `
          <div class="card" style="border-color:rgba(239,68,68,.3)">
            <div class="card-body">
              <button type="button" class="btn btn-outline" style="width:100%;color:var(--s-danger);border-color:var(--s-danger);justify-content:center"
                onclick="if(confirm('Delete this blog post permanently?')){document.getElementById('delete-form').submit()}">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4M12.67 4v9.33a1.33 1.33 0 01-1.34 1.34H4.67a1.33 1.33 0 01-1.34-1.34V4"/></svg>
                Delete post
              </button>
            </div>
          </div>
          ` : ''}
        </div>
      </div>

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px">
        <a href="${base}/blog${blogId ? '?blog_id=' + esc(blogId) : ''}" class="btn btn-outline">Cancel</a>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Create post'}</button>
      </div>
    </form>

    ${isEdit ? `<form id="delete-form" method="POST" action="${base}/blog/${esc(articleId)}/delete" style="display:none">
      ${csrfField}
      <input type="hidden" name="blog_id" value="${esc(blogId)}">
    </form>` : ''}

    <style>
      .blog-editor-shell .ck-editor__editable_inline { min-height:420px; max-height:70vh; overflow:auto; padding:14px 16px; }
      .blog-editor-shell .ck.ck-toolbar { border-radius:0; border:none; border-bottom:1px solid var(--s-border); background:var(--s-card-bg); }
      .blog-editor-shell .ck.ck-content { background:var(--s-input-bg); color:var(--s-text); }
      [data-theme="dark"] .blog-editor-shell .ck.ck-button { color:var(--s-text); }
      [data-theme="dark"] .blog-editor-shell .ck.ck-button:hover { background:var(--s-hover-bg); }
      .blog-editor-shell:fullscreen { background:var(--s-bg); padding:20px; }
      .blog-editor-shell:fullscreen .ck-editor__editable_inline { max-height:none; min-height:calc(100vh - 100px); }
    </style>
    <script src="https://cdn.ckeditor.com/ckeditor5/41.4.2/super-build/ckeditor.js"></script>
    <script>
    (function () {
      var contentInput = document.getElementById('blog-content-input')
      var host = document.getElementById('blog-editor-content')
      if (!host || !contentInput) return

      var ClassicEditor = (window.CKEDITOR && window.CKEDITOR.ClassicEditor) || window.ClassicEditor
      function fallback(reason) {
        if (reason) console.warn('[blog-editor]', reason)
        host.innerHTML = '<textarea id="blog-content-fallback" rows="20" style="width:100%;border:none;padding:14px;background:var(--s-input-bg);color:var(--s-text);font-size:13px;outline:none;resize:vertical;min-height:420px">' + (contentInput.value || '') + '</textarea>'
        host.querySelector('textarea').addEventListener('input', function (e) { contentInput.value = e.target.value })
      }

      if (!ClassicEditor) { fallback('CKEditor not loaded'); return }

      var REMOVE_PREMIUM = [
        'CKBox', 'CKFinder', 'CloudServices', 'EasyImage', 'CKBoxImageEdit',
        'CommentsRepository', 'Comments', 'CommentsArchive',
        'TrackChanges', 'TrackChangesData', 'TrackChangesPreview',
        'RevisionHistory',
        'RealTimeCollaborativeComments', 'RealTimeCollaborativeEditing',
        'RealTimeCollaborativeRevisionHistory', 'RealTimeCollaborativeTrackChanges',
        'PresenceList',
        'AIAssistant', 'OpenAITextAdapter', 'AzureOpenAITextAdapter',
        'WProofreader', 'MathType',
        'Template', 'DocumentOutline', 'FormatPainter', 'TableOfContents',
        'PasteFromOfficeEnhanced', 'CaseChange', 'SlashCommand',
        'Bookmark', 'MultiLevelList', 'ImportWord', 'ExportWord', 'ExportPdf',
        'Pagination', 'Mention', 'Title', 'WebSocketGateway',
      ]

      ClassicEditor.create(host, {
        licenseKey: 'GPL',
        removePlugins: REMOVE_PREMIUM,
        toolbar: {
          items: [
            'heading', '|',
            'fontFamily', 'fontSize', 'fontColor', 'fontBackgroundColor', '|',
            'bold', 'italic', 'underline', 'strikethrough', '|',
            'alignment', '|',
            'bulletedList', 'numberedList', '|',
            'outdent', 'indent', '|',
            'link', 'blockQuote', 'insertTable', 'imageUpload', 'mediaEmbed', '|',
            'sourceEditing', '|',
            'undo', 'redo'
          ],
          shouldNotGroupWhenFull: true
        },
        initialData: contentInput.value || '',
        placeholder: 'Write your blog post here...',
        image: {
          toolbar: ['imageTextAlternative', 'toggleImageCaption', 'imageStyle:inline', 'imageStyle:block', 'imageStyle:side']
        },
        table: {
          contentToolbar: ['tableColumn', 'tableRow', 'mergeTableCells', 'tableProperties', 'tableCellProperties']
        },
        simpleUpload: {
          uploadUrl: ${JSON.stringify(opts.base + '/files/upload')},
          withCredentials: true,
          headers: { Accept: 'application/json' }
        }
      }).then(function (editor) {
        window.__blogEditor = editor
        editor.model.document.on('change:data', function () {
          contentInput.value = editor.getData()
        })
        // Sync ngay trước khi submit để chắc chắn FE có data mới nhất
        var f = document.getElementById('blog-form')
        if (f) f.addEventListener('submit', function () { contentInput.value = editor.getData() })
      }).catch(function (err) {
        console.error('[blog-editor] CKEditor init failed:', err)
        fallback(null)
      })

      // Fullscreen toggle
      var fsBtn = document.getElementById('blog-fullscreen-btn')
      var shell = document.querySelector('.blog-editor-shell')
      if (fsBtn && shell) {
        fsBtn.addEventListener('click', function () {
          if (!document.fullscreenElement) shell.requestFullscreen && shell.requestFullscreen()
          else document.exitFullscreen && document.exitFullscreen()
        })
      }
    })()
    </script>

    <script>
    (function () {
      var wrap = document.getElementById('tag-chips-wrap')
      var input = document.getElementById('tag-chips-input')
      var field = document.getElementById('tag-chips-field')
      if (!wrap || !input || !field) return

      var tags = []
      try { var p = JSON.parse(wrap.getAttribute('data-initial') || '[]'); if (Array.isArray(p)) tags = p.slice() } catch (e) {}

      function syncField() { field.value = tags.join(', ') }

      function removeChip(i) { tags.splice(i, 1); render() }

      function addTag(raw) {
        var t = String(raw || '').trim()
        if (!t) return false
        var lc = t.toLowerCase()
        for (var i = 0; i < tags.length; i++) { if (String(tags[i]).toLowerCase() === lc) return false }
        tags.push(t); return true
      }

      function render() {
        var kids = Array.prototype.slice.call(wrap.children)
        for (var i = 0; i < kids.length; i++) { if (kids[i] !== input) wrap.removeChild(kids[i]) }
        for (var i = 0; i < tags.length; i++) {
          var chip = document.createElement('span')
          chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:3px 4px 3px 10px;border-radius:9999px;font-size:11px;font-weight:500;background:rgba(99,102,241,.15);color:var(--s-accent)'
          var label = document.createElement('span'); label.textContent = tags[i]; chip.appendChild(label)
          var btn = document.createElement('button')
          btn.type = 'button'
          btn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:none;border-radius:9999px;background:transparent;color:inherit;cursor:pointer;font-size:14px'
          btn.textContent = '×'
          ;(function(idx){ btn.addEventListener('click', function(e){ e.stopPropagation(); removeChip(idx) }) })(i)
          chip.appendChild(btn); wrap.insertBefore(chip, input)
        }
        input.placeholder = tags.length ? 'Add another…' : (input.getAttribute('data-ep') || input.placeholder)
        syncField()
      }

      input.setAttribute('data-ep', input.placeholder || '')

      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault()
          var chunks = input.value.split(','); var changed = false
          for (var i = 0; i < chunks.length; i++) { if (addTag(chunks[i])) changed = true }
          input.value = ''; if (changed) render()
        } else if (e.key === 'Backspace' && input.value === '' && tags.length > 0) {
          removeChip(tags.length - 1)
        }
      })
      input.addEventListener('blur', function() {
        if (input.value.trim()) {
          var chunks = input.value.split(','); var changed = false
          for (var i = 0; i < chunks.length; i++) { if (addTag(chunks[i])) changed = true }
          input.value = ''; if (changed) render()
        }
      })
      var form = document.getElementById('blog-form')
      if (form) { form.addEventListener('submit', function() { if (input.value.trim()) { addTag(input.value); input.value = '' } syncField() }) }
      render()
    })()
    </script>
  `
}

// ---------------------------------------------------------------------------
// No Data empty state
// ---------------------------------------------------------------------------

function noDataState(message: string, sub?: string, action?: { href: string; label: string }): string {
  return `
    <div style="text-align:center;padding:60px 20px">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--s-text-secondary)" stroke-width="1" style="margin-bottom:12px">
        <path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>
      </svg>
      <h3 style="margin:0 0 4px;font-size:15px;font-weight:600;color:var(--s-text)">${esc(message)}</h3>
      ${sub ? `<p style="margin:0 0 16px;font-size:13px;color:var(--s-text-secondary)">${esc(sub)}</p>` : ''}
      ${action ? `<a href="${action.href}" class="btn btn-primary">${esc(action.label)}</a>` : ''}
    </div>
  `
}

// ---------------------------------------------------------------------------
// GET /blog — Blog post listing
// ---------------------------------------------------------------------------

export async function getBlogPosts(
  req: Request,
  res: Response,
  _db: any,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${store.slug}/online-store`

  const page = Math.max(1, parseInt(String(req.query.page ?? '1')) || 1)
  const perPage = 20
  const search = String(req.query.q ?? '').trim()
  const tab = String(req.query.tab ?? 'all').toLowerCase()
  const selectedBlogId = String(req.query.blog_id ?? '').trim()

  let blogs: ApiBlog[] = []
  let articles: ApiArticle[] = []
  let totalArticles = 0
  let activeBlog: ApiBlog | null = null
  let errMsg: string | null = null

  try {
    const ctx = createApiContext(req)

    // 1. Load all blogs
    const blogsRes = await listBlogs(ctx, { limit: 50 })
    blogs = blogsRes.data ?? []

    if (blogs.length > 0) {
      // Pick selected blog or default to first
      activeBlog = blogs.find(b => b.id === selectedBlogId) ?? blogs[0]

      // 2. Load articles for active blog
      const publishedFilter = tab === 'published' ? true : tab === 'draft' ? false : undefined
      const articlesRes = await listArticles(ctx, activeBlog.id!, {
        page,
        limit: perPage,
        keyword: search || undefined,
        published: publishedFilter,
        sort_by: 'created_desc',
      })
      articles = articlesRes.data ?? []
      totalArticles = articlesRes.pagination?.count ?? articles.length
    }
  } catch (err) {
    errMsg = formatProductApiError(err)
  }

  const totalPages = Math.ceil(totalArticles / perPage) || 1
  const blogId = activeBlog?.id ?? ''

  function filterUrl(params: Record<string, string | undefined>): string {
    const p = new URLSearchParams()
    if (blogId) p.set('blog_id', blogId)
    if (params.tab && params.tab !== 'all') p.set('tab', params.tab)
    if (params.q) p.set('q', params.q)
    if (params.page && params.page !== '1') p.set('page', params.page)
    const qs = p.toString()
    return `${base}/blog${qs ? '?' + qs : ''}`
  }

  const tabClass = (t: string) => tab === t ? 'tab active' : 'tab'

  // Blog selector tabs
  const blogTabsHtml = blogs.length > 1
    ? `<div style="display:flex;gap:8px;align-items:center;margin-bottom:16px;flex-wrap:wrap">
        <span style="font-size:12px;color:var(--s-text-secondary);font-weight:500">Blog:</span>
        ${blogs.map(b => {
          const isActive = b.id === blogId
          return `<a href="${base}/blog?blog_id=${esc(b.id ?? '')}"
            style="padding:4px 12px;border-radius:6px;font-size:12px;font-weight:500;text-decoration:none;
              ${isActive
                ? 'background:rgba(99,102,241,.15);color:var(--s-accent);border:1px solid rgba(99,102,241,.3)'
                : 'color:var(--s-text-secondary);border:1px solid var(--s-border)'}"
          >${esc(b.title ?? b.slug ?? b.id ?? '')}</a>`
        }).join('')}
      </div>`
    : ''

  const paginationHtml = totalPages > 1 ? `
    <div style="display:flex;justify-content:center;align-items:center;gap:6px;padding:16px 0">
      ${page > 1 ? `<a href="${filterUrl({ tab, q: search, page: String(page - 1) })}" class="btn btn-outline btn-sm">&laquo; Prev</a>` : ''}
      ${Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
        const p = totalPages <= 7 ? i + 1 : page <= 4 ? i + 1 : page >= totalPages - 3 ? totalPages - 6 + i : page - 3 + i
        return `<a href="${filterUrl({ tab, q: search, page: String(p) })}" class="btn btn-sm ${p === page ? 'btn-primary' : 'btn-outline'}">${p}</a>`
      }).join('')}
      ${page < totalPages ? `<a href="${filterUrl({ tab, q: search, page: String(page + 1) })}" class="btn btn-outline btn-sm">Next &raquo;</a>` : ''}
    </div>
  ` : ''

  const flashSuccess = String(req.query.success ?? '').slice(0, 200)
  const flashError = String(req.query.error ?? '').slice(0, 200)

  const content = `
    ${flashSuccess ? `<div class="gbx-flash gbx-flash-success">${esc(flashSuccess)}</div>` : ''}
    ${flashError ? `<div class="gbx-flash gbx-flash-error">${esc(flashError)}</div>` : ''}
    ${errMsg ? `<div class="gbx-flash gbx-flash-error">${esc(errMsg)}</div>` : ''}

    <style>
      .gbx-flash { display:flex;align-items:center;gap:8px;padding:10px 14px;margin:0 0 16px;border-radius:8px;font-size:13px;font-weight:500 }
      .gbx-flash-success { color:#065f46;background:#d1fae5;border:1px solid #a7f3d0 }
      .gbx-flash-error { color:#991b1b;background:#fee2e2;border:1px solid #fecaca }
      [data-theme="dark"] .gbx-flash-success { color:#a7f3d0;background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.3) }
      [data-theme="dark"] .gbx-flash-error { color:#fecaca;background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.3) }
    </style>

    <div class="page-header">
      <div>
        <h3 class="page-title" style="margin:0">Blog Posts</h3>
        ${activeBlog ? `<p class="page-subtitle">${esc(activeBlog.title ?? '')} &middot; ${totalArticles} post${totalArticles !== 1 ? 's' : ''}</p>` : ''}
      </div>
      ${activeBlog ? `<a href="${base}/blog/new?blog_id=${esc(blogId)}" class="btn btn-primary">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v10M3 8h10"/></svg>
        Create post
      </a>` : ''}
    </div>

    ${blogs.length === 0 ? `
      <div class="card">
        <div class="card-body">
          ${noDataState('No Data', 'No blogs have been created yet. Create your first blog to start writing.', { href: `${base}/blog/new?create_blog=1`, label: 'Create your first blog' })}
        </div>
      </div>
    ` : `
      ${blogTabsHtml}

      <!-- Search -->
      <div class="card" style="margin-bottom:20px">
        <div class="card-body" style="padding:12px 20px">
          <form method="GET" action="${base}/blog" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
            <input type="hidden" name="blog_id" value="${esc(blogId)}">
            <div style="flex:1;min-width:200px;position:relative">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#6b7280" stroke-width="1.5" style="position:absolute;left:10px;top:50%;transform:translateY(-50%)"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
              <input type="text" name="q" value="${esc(search)}" placeholder="Search blog posts..."
                style="width:100%;padding:8px 12px 8px 34px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg);color:var(--s-text);outline:none">
            </div>
            ${tab !== 'all' ? `<input type="hidden" name="tab" value="${esc(tab)}">` : ''}
            <button type="submit" class="btn btn-outline btn-sm">Search</button>
            ${search ? `<a href="${filterUrl({ tab })}" class="btn btn-outline btn-sm" style="color:var(--s-danger)">Clear</a>` : ''}
          </form>
        </div>
      </div>

      <!-- Status tabs -->
      <div class="tabs">
        <a href="${filterUrl({ q: search, tab: 'all' })}" class="${tabClass('all')}">All</a>
        <a href="${filterUrl({ q: search, tab: 'published' })}" class="${tabClass('published')}">Published</a>
        <a href="${filterUrl({ q: search, tab: 'draft' })}" class="${tabClass('draft')}">Draft</a>
      </div>

      <!-- Articles table with bulk actions -->
      <form id="blog-bulk-form" method="POST" action="${base}/blog/bulk">
        ${csrfHiddenField(req.csrfToken!)}
        <input type="hidden" name="action" id="blog-bulk-action" value="">
        <input type="hidden" name="blog_id" value="${esc(blogId)}">

        <div id="blog-bulk-bar" style="display:none;align-items:center;gap:12px;padding:10px 14px;margin-bottom:12px;background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.3);border-radius:8px;font-size:13px">
          <span id="blog-bulk-count" style="font-weight:600;color:var(--s-accent)">0 selected</span>
          <button type="submit" class="btn btn-outline btn-sm" onclick="document.getElementById('blog-bulk-action').value='publish'">Publish</button>
          <button type="submit" class="btn btn-outline btn-sm" onclick="document.getElementById('blog-bulk-action').value='unpublish'">Unpublish</button>
          <button type="submit" class="btn btn-outline btn-sm" style="color:var(--s-danger);border-color:var(--s-danger)"
            onclick="if(!confirm('Delete selected posts?')){return false} document.getElementById('blog-bulk-action').value='delete'">Delete</button>
          <a href="#" id="blog-bulk-clear" style="margin-left:auto;font-size:12px;color:var(--s-text-secondary);text-decoration:underline">Clear</a>
        </div>

        <div class="card">
          <div class="card-body" style="padding:0">
            ${articles.length > 0 ? `
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style="width:32px"><input type="checkbox" id="blog-select-all" aria-label="Select all"></th>
                      <th style="width:35%">Title</th>
                      <th>Author</th>
                      <th>Status</th>
                      <th>Tags</th>
                      <th>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${articles.map(a => `
                      <tr>
                        <td><input type="checkbox" name="ids" value="${esc(a.id ?? '')}" class="blog-row-cb" aria-label="Select ${esc(a.title ?? '')}"></td>
                        <td>
                          <a href="${base}/blog/${esc(a.id ?? '')}?blog_id=${esc(blogId)}" style="color:var(--s-accent);text-decoration:none;font-weight:600">${esc(a.title ?? '')}</a>
                          <div style="font-size:11px;color:var(--s-text-secondary);margin-top:2px;font-family:monospace">${esc(a.slug ?? '')}</div>
                        </td>
                        <td style="font-size:12px;color:var(--s-text-secondary)">${esc(a.author ?? '-')}</td>
                        <td>${statusBadge(a.published ?? false)}</td>
                        <td>${renderTags(a.tags)}</td>
                        <td style="font-size:12px;color:var(--s-text-secondary)">${formatDate(a.published_at ?? a.created_at)}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
              ${paginationHtml}
            ` : `
              <div class="card-body">
                ${noDataState('No Data', search ? `No posts matching "${search}".` : 'No posts in this blog yet.', !search ? { href: `${base}/blog/new?blog_id=${esc(blogId)}`, label: 'Write your first post' } : undefined)}
              </div>
            `}
          </div>
        </div>
      </form>

      <script>
      (function() {
        var all = document.getElementById('blog-select-all')
        var bar = document.getElementById('blog-bulk-bar')
        var counter = document.getElementById('blog-bulk-count')
        var clearLink = document.getElementById('blog-bulk-clear')
        var rows = document.querySelectorAll('.blog-row-cb')
        if (!bar || !counter) return
        function sync() {
          var checked = 0; rows.forEach(function(cb){ if (cb.checked) checked++ })
          bar.style.display = checked > 0 ? 'flex' : 'none'
          counter.textContent = checked + ' selected'
          if (all) { all.checked = checked > 0 && checked === rows.length; all.indeterminate = checked > 0 && checked < rows.length }
        }
        if (all) { all.addEventListener('change', function(){ rows.forEach(function(cb){ cb.checked = all.checked }); sync() }) }
        rows.forEach(function(cb){ cb.addEventListener('change', sync) })
        if (clearLink) { clearLink.addEventListener('click', function(e){ e.preventDefault(); rows.forEach(function(cb){ cb.checked = false }); sync() }) }
      })()
      </script>
    `}
  `

  res.send(sellerLayout({
    title: 'Blog Posts',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'blog',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ---------------------------------------------------------------------------
// GET /blog/new — Create article form
// ---------------------------------------------------------------------------

export async function getCreateBlogPost(
  req: Request,
  res: Response,
  _db: any,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${store.slug}/online-store`
  const csrfField = csrfHiddenField(req.csrfToken!)

  let blogs: ApiBlog[] = []
  let selectedBlogId = String(req.query.blog_id ?? '').trim()
  let errMsg: string | null = null

  try {
    const ctx = createApiContext(req)
    const res2 = await listBlogs(ctx, { limit: 50 })
    blogs = res2.data ?? []
    if (!selectedBlogId && blogs.length > 0) {
      selectedBlogId = blogs[0].id ?? ''
    }
  } catch (err) {
    errMsg = formatProductApiError(err)
  }

  // Form luôn hiện. Khi không có blog → cho user nhập title blog mới,
  // POST handler sẽ tự tạo blog trước rồi tạo article.
  const needNewBlog = blogs.length === 0

  const content = `
    ${errMsg ? `<div class="gbx-flash gbx-flash-error" style="margin-bottom:16px">${esc(errMsg)}</div>
    <style>.gbx-flash{display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:8px;font-size:13px;font-weight:500}
    .gbx-flash-error{color:#991b1b;background:#fee2e2;border:1px solid #fecaca}
    [data-theme="dark"] .gbx-flash-error{color:#fecaca;background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.3)}</style>` : ''}
    <div class="page-header">
      <div>
        <a href="${base}/blog${selectedBlogId ? '?blog_id=' + esc(selectedBlogId) : ''}" style="color:var(--s-text-secondary);text-decoration:none;font-size:12px;display:flex;align-items:center;gap:4px;margin-bottom:4px">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 12L6 8l4-4"/></svg>
          Blog Posts
        </a>
        <h3 class="page-title" style="margin:0">Create blog post</h3>
      </div>
    </div>
    ${needNewBlog ? `
      <div class="card" style="margin-bottom:20px;border-color:rgba(99,102,241,.3);background:rgba(99,102,241,.05)">
        <div class="card-body" style="display:flex;align-items:center;gap:12px">
          <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="var(--s-accent)" stroke-width="1.5" style="flex-shrink:0"><circle cx="8" cy="8" r="7"/><path d="M8 5v3M8 11h.01"/></svg>
          <div style="font-size:13px;color:var(--s-text)">
            <strong>No blog yet.</strong> A new blog will be created when you save this post.
          </div>
        </div>
      </div>
    ` : ''}
    ${blogForm({
      base, csrfField,
      action: `${base}/blog`,
      blogId: selectedBlogId,
      blogs,
      author: user.name || user.email,
    })}
    ${needNewBlog ? `
      <script>
      (function(){
        var f = document.getElementById('blog-form')
        if (!f) return
        var hidden = document.createElement('input')
        hidden.type = 'hidden'
        hidden.name = 'create_new_blog'
        hidden.value = '1'
        f.appendChild(hidden)
      })()
      </script>
    ` : ''}
  `

  res.send(sellerLayout({
    title: 'Create Blog Post',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'blog',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ---------------------------------------------------------------------------
// GET /blog/:postId — Edit article form
// ---------------------------------------------------------------------------

export async function getBlogPostDetail(
  req: Request,
  res: Response,
  _db: any,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${store.slug}/online-store`
  const articleId = String(req.params.postId || '')
  const blogId = String(req.query.blog_id ?? '').trim()
  const csrfField = csrfHiddenField(req.csrfToken!)

  let article: ApiArticle | null = null
  let blogs: ApiBlog[] = []
  let errMsg: string | null = null

  try {
    const ctx = createApiContext(req)
    const [blogsRes, art] = await Promise.all([
      listBlogs(ctx, { limit: 50 }),
      blogId ? getArticle(ctx, blogId, articleId) : Promise.resolve(null),
    ])
    blogs = blogsRes.data ?? []
    article = art
  } catch (err) {
    errMsg = formatProductApiError(err)
  }

  if (!article && !errMsg) {
    res.status(404).send(sellerLayout({
      title: 'Post Not Found',
      storeName: store.name, storeSlug: store.slug,
      userName: user.name, userEmail: user.email,
      userRole: user.role, storeRole: user.storeRole,
      activePage: 'blog',
      content: `<div style="text-align:center;padding:80px 20px">
        <h3 style="margin:0 0 8px;font-size:18px;color:var(--s-text)">No Data</h3>
        <p style="margin:0 0 16px;font-size:13px;color:var(--s-text-secondary)">This post was not found. It may have been deleted.</p>
        <a href="${base}/blog" class="btn btn-primary">Back to Blog</a>
      </div>`,
      theme: theme as 'dark' | 'light',
    }))
    return
  }

  const effectiveBlogId = article?.blog_id ?? blogId

  const content = `
    ${errMsg ? `<div style="background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);border-radius:8px;padding:10px 14px;margin-bottom:16px;color:#fecaca;font-size:13px">${esc(errMsg)}</div>` : ''}
    <div class="page-header">
      <div>
        <a href="${base}/blog${effectiveBlogId ? '?blog_id=' + esc(effectiveBlogId) : ''}" style="color:var(--s-text-secondary);text-decoration:none;font-size:12px;display:flex;align-items:center;gap:4px;margin-bottom:4px">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 12L6 8l4-4"/></svg>
          Blog Posts
        </a>
        <h3 class="page-title" style="margin:0">${esc(article?.title ?? '')}</h3>
        <p style="margin:4px 0 0;font-size:12px;color:var(--s-text-secondary)">
          Created ${formatDate(article?.created_at)} &middot; Updated ${formatDate(article?.updated_at)}
        </p>
      </div>
      <div>${statusBadge(article?.published ?? false)}</div>
    </div>
    ${article ? blogForm({
      base, csrfField,
      action: `${base}/blog/${esc(articleId)}`,
      blogId: effectiveBlogId,
      blogs,
      title: article.title ?? '',
      bodyHtml: article.body_html ?? '',
      excerpt: article.summary_html ?? '',
      author: article.author ?? '',
      tags: article.tags ?? [],
      imageUrl: article.image_url ?? '',
      published: article.published ?? false,
      seoTitle: article.seo_title ?? '',
      seoDescription: article.seo_description ?? '',
      isEdit: true,
      articleId,
    }) : ''}
  `

  res.send(sellerLayout({
    title: article ? `Edit: ${article.title}` : 'Edit Post',
    storeName: store.name, storeSlug: store.slug,
    userName: user.name, userEmail: user.email,
    userRole: user.role, storeRole: user.storeRole,
    activePage: 'blog',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ---------------------------------------------------------------------------
// POST /blog — Create article
// ---------------------------------------------------------------------------

export async function postCreateBlogPost(
  req: Request,
  res: Response,
  _db: any,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}/online-store`

  let blogId = String(req.body.blog_id ?? '').trim()
  const createNewBlog = req.body.create_new_blog === '1'
  const title = String(req.body.title ?? '').trim()
  const bodyHtml = String(req.body.body_html ?? '').trim()
  const excerpt = String(req.body.excerpt ?? '').trim()
  const author = String(req.body.author ?? user.name ?? user.email ?? '').trim()
  const tagsRaw = String(req.body.tags ?? '').trim()
  const imageUrl = String(req.body.image_url ?? '').trim()
  const published = req.body.published === 'true'
  const seoTitle = String(req.body.seo_title ?? '').trim() || undefined
  const seoDescription = String(req.body.seo_description ?? '').trim() || undefined

  if (!title) {
    res.redirect(`${base}/blog/new?blog_id=${encodeURIComponent(blogId)}&error=Title+is+required`)
    return
  }

  try {
    const ctx = createApiContext(req)

    // Auto-create blog "News" nếu shop chưa có blog nào
    if (!blogId && createNewBlog) {
      const newBlog = await createBlog(ctx, { title: 'News' })
      blogId = newBlog.id ?? ''
    }
    if (!blogId) {
      res.redirect(`${base}/blog/new?error=Blog+is+required`)
      return
    }

    const article = await createArticle(ctx, blogId, {
      title,
      body_html: bodyHtml || undefined,
      summary_html: excerpt || undefined,
      author,
      tags: parseTags(tagsRaw),
      image_url: imageUrl || undefined,
      published,
      published_at: published ? new Date().toISOString() : undefined,
      seo_title: seoTitle,
      seo_description: seoDescription,
    })
    res.redirect(`${base}/blog/${encodeURIComponent(article.id!)}?blog_id=${encodeURIComponent(blogId)}`)
  } catch (err) {
    const msg = formatProductApiError(err)
    res.redirect(`${base}/blog/new?blog_id=${encodeURIComponent(blogId)}&error=${encodeURIComponent(msg)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /blog/:postId — Update article
// ---------------------------------------------------------------------------

export async function postUpdateBlogPost(
  req: Request,
  res: Response,
  _db: any,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}/online-store`
  const articleId = String(req.params.postId || '')

  const blogId = String(req.body.blog_id ?? '').trim()
  const title = String(req.body.title ?? '').trim()
  const bodyHtml = String(req.body.body_html ?? '').trim()
  const excerpt = String(req.body.excerpt ?? '').trim()
  const author = String(req.body.author ?? '').trim()
  const tagsRaw = String(req.body.tags ?? '').trim()
  const imageUrl = String(req.body.image_url ?? '').trim()
  const published = req.body.published === 'true'
  const seoTitle = String(req.body.seo_title ?? '').trim() || undefined
  const seoDescription = String(req.body.seo_description ?? '').trim() || undefined

  if (!title) {
    res.redirect(`${base}/blog/${articleId}?blog_id=${encodeURIComponent(blogId)}&error=Title+is+required`)
    return
  }
  if (!blogId) {
    res.redirect(`${base}/blog/${articleId}?error=Blog+ID+missing`)
    return
  }

  try {
    const ctx = createApiContext(req)
    await updateArticle(ctx, blogId, {
      id: articleId,
      title,
      body_html: bodyHtml || undefined,
      summary_html: excerpt || undefined,
      author,
      tags: parseTags(tagsRaw),
      image_url: imageUrl || undefined,
      published,
      seo_title: seoTitle,
      seo_description: seoDescription,
    })
    res.redirect(`${base}/blog/${articleId}?blog_id=${encodeURIComponent(blogId)}`)
  } catch (err) {
    const msg = formatProductApiError(err)
    res.redirect(`${base}/blog/${articleId}?blog_id=${encodeURIComponent(blogId)}&error=${encodeURIComponent(msg)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /blog/:postId/delete — Delete article
// ---------------------------------------------------------------------------

export async function postDeleteBlogPost(
  req: Request,
  res: Response,
  _db: any,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}/online-store`
  const articleId = String(req.params.postId || '')
  const blogId = String(req.body.blog_id ?? '').trim()

  if (!blogId) {
    res.redirect(`${base}/blog?error=Blog+ID+missing`)
    return
  }

  try {
    const ctx = createApiContext(req)
    await deleteArticles(ctx, blogId, [{ id: articleId }])
    res.redirect(`${base}/blog?blog_id=${encodeURIComponent(blogId)}`)
  } catch (err) {
    const msg = formatProductApiError(err)
    res.redirect(`${base}/blog/${articleId}?blog_id=${encodeURIComponent(blogId)}&error=${encodeURIComponent(msg)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /blog/bulk — Bulk publish / unpublish / delete
// ---------------------------------------------------------------------------

export async function postBulkBlogPosts(
  req: Request,
  res: Response,
  _db: any,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}/online-store`

  const blogId = String(req.body.blog_id ?? '').trim()
  const rawAction = String(req.body.action ?? '').trim()

  if (!blogId) {
    res.redirect(`${base}/blog?error=Blog+ID+missing`)
    return
  }
  if (rawAction !== 'publish' && rawAction !== 'unpublish' && rawAction !== 'delete') {
    res.redirect(`${base}/blog?blog_id=${encodeURIComponent(blogId)}&error=Invalid+action`)
    return
  }

  const raw = req.body.ids
  const ids: string[] = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : []

  if (ids.length === 0) {
    res.redirect(`${base}/blog?blog_id=${encodeURIComponent(blogId)}&error=Select+at+least+one+post`)
    return
  }

  try {
    const ctx = createApiContext(req)
    let affected = 0

    if (rawAction === 'delete') {
      await deleteArticles(ctx, blogId, ids.map(id => ({ id })))
      affected = ids.length
    } else {
      const r = await bulkSetArticlePublished(ctx, blogId, ids, rawAction === 'publish')
      affected = r.affected
    }

    const verb = rawAction === 'publish' ? 'published' : rawAction === 'unpublish' ? 'unpublished' : 'deleted'
    res.redirect(`${base}/blog?blog_id=${encodeURIComponent(blogId)}&success=${encodeURIComponent(`${affected} post(s) ${verb}`)}`)
  } catch (err) {
    const msg = formatProductApiError(err)
    res.redirect(`${base}/blog?blog_id=${encodeURIComponent(blogId)}&error=${encodeURIComponent(msg)}`)
  }
}
