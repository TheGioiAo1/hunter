/**
 * Pages — editor 2-cột Shopify style cho create + edit.
 *
 * Layout:
 *   ┌──────────────────────────────┬─────────────────┐
 *   │ Title + Slug preview          │  Visibility     │
 *   │ Content (Quill rich text)     │  Online store   │
 *   │ Search engine listing         │  Tags           │
 *   │                               │  Featured image │
 *   │                               │  Custom fields  │
 *   └──────────────────────────────┴─────────────────┘
 *
 * Quill 2.0 từ jsdelivr CDN (CSP cho phép — theme-editor cũng dùng cdnjs).
 * Image upload qua POST /online-store/files/upload với Accept: application/json
 * (handler trả JSON khi gặp accept header này — xem files.ts).
 */

import { esc } from '../layouts/seller-layout.js'
import type { ApiPage } from '../lib/page-api-types.js'

export interface PageEditorFormOpts {
  /** Base URL `/admin/store/{slug}/online-store`. */
  base: string
  /** Hidden input <input type="hidden" name="_csrf" value="..."> markup. */
  csrfField: string
  /** Form action URL — POST tạo mới hoặc update. */
  action: string
  /** True khi đang edit (hiển thị Delete button + populate fields). */
  isEdit?: boolean
  /** Page hiện tại (chỉ dùng khi isEdit). */
  page?: ApiPage
  /** Tag list autocomplete từ BE GET /tags. */
  tagSuggestions?: string[]
}

function slugifyJs(): string {
  // Đồng bộ với BE ToSlug — strip dấu, lowercase, gạch nối. Tạm thời approximate
  // (đủ cho preview FE; BE quyết định slug thật khi create).
  return `function slugify(s){
    return (s||'').toLowerCase().trim()
      .normalize('NFD').replace(/[\\u0300-\\u036f]/g,'')
      .replace(/đ/g,'d').replace(/[^\\w\\s-]/g,'')
      .replace(/[\\s_]+/g,'-').replace(/^-+|-+$/g,'');
  }`
}

export function pageEditorForm(opts: PageEditorFormOpts): string {
  const { base, csrfField, action, isEdit = false, page = {}, tagSuggestions = [] } = opts

  const title = page.title ?? ''
  const slug = page.slug ?? ''
  const content = page.content ?? ''
  const seoTitle = page.seo_title ?? ''
  const seoDescription = page.seo_description ?? ''
  const published = page.published ?? false
  const template = page.template ?? ''
  const imageUrl = page.image_url ?? ''
  const tags = page.tags ?? []
  const customFields = page.custom_fields ?? []
  const pageId = page.id ?? ''

  const pageView =
    customFields.find((c) => (c.name ?? '').toLowerCase() === 'page_view')?.value ?? '0'

  const tagDatalist = tagSuggestions
    .map((t) => `<option value="${esc(t)}">`)
    .join('')

  // Custom fields readonly (loại trừ page_view vì đã hiển thị riêng)
  const otherCustomFields = customFields.filter(
    (c) => (c.name ?? '').toLowerCase() !== 'page_view',
  )

  return `
    <style>
      .pe-grid { display:grid; grid-template-columns: 1fr 320px; gap: 24px; align-items: start; }
      @media (max-width: 1024px) { .pe-grid { grid-template-columns: 1fr; } }
      .pe-side { position: sticky; top: 16px; display:flex; flex-direction:column; gap:16px; }
      .pe-card { background: var(--s-card-bg); border: 1px solid var(--s-border); border-radius: 10px; }
      .pe-card-header { padding: 12px 16px; border-bottom: 1px solid var(--s-border); display:flex; justify-content:space-between; align-items:center; gap:12px; }
      .pe-card-header h3 { margin:0; font-size:13px; font-weight:600; color:var(--s-text); }
      .pe-card-body { padding: 14px 16px; display:flex; flex-direction:column; gap:12px; }
      .pe-label { display:block; font-size:12px; font-weight:600; color: var(--s-text-secondary); margin-bottom:4px; }
      .pe-input, .pe-textarea { width:100%; padding:8px 12px; border:1px solid var(--s-border); border-radius:8px; font-size:13px; background:var(--s-input-bg); color:var(--s-text); outline:none; font-family: inherit; }
      .pe-textarea { resize: vertical; line-height: 1.5; }
      .pe-help { margin:4px 0 0; font-size:11px; color:var(--s-text-secondary); }

      /* ── Editor chrome (CKEditor 5) ───────────────────────────────── */
      .pe-editor-shell { position: relative; border:1px solid var(--s-border); border-radius:10px; overflow:hidden; background:var(--s-input-bg); }
      .pe-editor-tabs { display:flex; align-items:center; gap:4px; padding:6px 8px; border-bottom:1px solid var(--s-border); background:var(--s-card-bg); }
      .pe-tab { padding:5px 12px; font-size:12px; font-weight:600; color:var(--s-text-secondary); background:transparent; border:1px solid transparent; border-radius:6px; cursor:pointer; }
      .pe-tab:hover { color:var(--s-text); background:var(--s-input-bg); }
      .pe-tab.active { color:var(--s-text); background:var(--s-input-bg); border-color:var(--s-border); }
      .pe-tab-spacer { flex:1; }
      .pe-tab-meta { font-size:11px; color:var(--s-text-secondary); display:flex; align-items:center; gap:8px; }
      .pe-saved { color:#22c55e; }
      .pe-saving { color:#eab308; }

      /* CKEditor 5 root container */
      .ck.ck-editor { border:none !important; }
      .ck.ck-editor__main > .ck-editor__editable { min-height: 420px; max-height: 70vh; overflow-y: auto; background: var(--s-input-bg) !important; color: var(--s-text) !important; padding: 18px 22px !important; font-size: 14px; line-height: 1.7; border:none !important; box-shadow: none !important; }
      .ck.ck-toolbar { background: var(--s-card-bg) !important; border:none !important; border-bottom: 1px solid var(--s-border) !important; padding: 6px 8px !important; flex-wrap: wrap; position: sticky; top: 0; z-index: 5; }
      [data-theme="dark"] .ck.ck-button { color: var(--s-text) !important; }
      [data-theme="dark"] .ck.ck-button:hover { background: var(--s-input-bg) !important; }
      [data-theme="dark"] .ck.ck-button.ck-on { background: var(--s-input-bg) !important; color: var(--s-accent) !important; }
      [data-theme="dark"] .ck.ck-toolbar__separator { background: var(--s-border) !important; }
      [data-theme="dark"] .ck.ck-list { background: var(--s-card-bg) !important; border-color: var(--s-border) !important; }
      [data-theme="dark"] .ck.ck-list__item .ck-button { color: var(--s-text) !important; }
      [data-theme="dark"] .ck.ck-list__item .ck-button:hover { background: var(--s-input-bg) !important; }
      [data-theme="dark"] .ck.ck-dropdown__panel { background: var(--s-card-bg) !important; border-color: var(--s-border) !important; }
      [data-theme="dark"] .ck.ck-input { background: var(--s-input-bg) !important; color: var(--s-text) !important; border-color: var(--s-border) !important; }
      [data-theme="dark"] .ck.ck-balloon-panel { background: var(--s-card-bg) !important; border-color: var(--s-border) !important; box-shadow: 0 6px 20px rgba(0,0,0,.5) !important; }
      [data-theme="dark"] .ck-content { background: var(--s-input-bg) !important; }
      .ck-content blockquote { border-left: 3px solid var(--s-accent); padding-left: 12px; opacity: .85; }
      .ck-content pre { background: rgba(0,0,0,.25); padding: 10px 12px; border-radius: 6px; }
      .ck-content table { border-collapse: collapse; }
      .ck-content table td, .ck-content table th { border: 1px solid var(--s-border); padding: 6px 10px; }
      .ck-source-editing-area textarea { background: var(--s-input-bg) !important; color: var(--s-text) !important; min-height: 420px !important; }

      .pe-editor-footer { display:flex; align-items:center; justify-content:space-between; padding: 6px 14px; border-top: 1px solid var(--s-border); background: var(--s-card-bg); font-size: 11px; color: var(--s-text-secondary); }
      .pe-editor-footer .pe-counters > span { margin-right: 12px; }
      .pe-editor-footer kbd { font-family: ui-monospace, monospace; padding: 1px 5px; border-radius: 4px; border:1px solid var(--s-border); background: var(--s-input-bg); font-size: 10px; }

      .pe-tags-chips { display:flex; flex-wrap:wrap; gap:6px; min-height: 28px; }
      .pe-chip { display:inline-flex; align-items:center; gap:6px; padding:3px 8px; border-radius:12px; background:rgba(99,102,241,.15); color:var(--s-accent); font-size:12px; font-weight:500; }
      .pe-chip button { background: none; border: none; color: inherit; cursor: pointer; font-size: 14px; line-height: 1; padding: 0; }
      .pe-thumb { width:100%; aspect-ratio: 16/9; border-radius:8px; object-fit:cover; background:#0f172a; border:1px solid var(--s-border); }
      .pe-row { display:flex; align-items:center; gap:8px; }
      .pe-radio-row { display:flex; align-items:center; gap:8px; padding:6px 0; cursor:pointer; }
      .pe-radio-row input { accent-color: var(--s-accent); }
      .pe-meta { display:flex; justify-content:space-between; font-size:11px; color:var(--s-text-secondary); padding-top:6px; border-top:1px dashed var(--s-border); }
    </style>

    <form method="POST" action="${action}" id="pe-form" novalidate>
      ${csrfField}
      ${isEdit && pageId ? `<input type="hidden" name="id" value="${esc(pageId)}" />` : ''}

      <div class="pe-grid">

        <!-- LEFT: main column -->
        <div style="display:flex;flex-direction:column;gap:16px">

          <!-- Title + Slug -->
          <div class="pe-card">
            <div class="pe-card-body">
              <div>
                <label class="pe-label">Title</label>
                <input type="text" name="title" id="pe-title" required class="pe-input"
                  value="${esc(title)}" placeholder="e.g. About us, Contact, FAQ" />
              </div>
              <div>
                <label class="pe-label">Slug
                  <span style="font-weight:400;color:var(--s-accent);margin-left:8px" id="pe-slug-preview">${esc(slug)}</span>
                </label>
                <p class="pe-help">${isEdit ? 'BE giữ slug khi update — đổi title không tự đổi slug.' : 'BE auto-generate slug từ title khi tạo mới.'}</p>
              </div>
            </div>
          </div>

          <!-- Content (CKEditor 5 super-build — full WYSIWYG) -->
          <div class="pe-card">
            <div id="pe-draft-banner" style="display:none;background:rgba(234,179,8,.12);border-bottom:1px solid rgba(234,179,8,.3);padding:8px 14px;font-size:12px;color:#eab308;align-items:center;gap:10px">
              <span>📝 Phát hiện bản nháp chưa lưu <span id="pe-draft-age"></span>.</span>
              <button type="button" class="pe-tab" id="pe-draft-restore">Restore</button>
              <button type="button" class="pe-tab" id="pe-draft-discard">Discard</button>
            </div>
            <div class="pe-editor-shell">
              <div class="pe-editor-tabs">
                <button type="button" class="pe-tab" id="pe-ai-btn" title="Generate content with AI"><span style="margin-right:4px">✨</span>AI</button>
                <div class="pe-tab-spacer"></div>
                <div class="pe-tab-meta">
                  <span id="pe-autosave-status" class="pe-saved">Idle</span>
                  <button type="button" class="pe-tab" id="pe-fullscreen-btn" title="Toggle fullscreen">⛶</button>
                </div>
              </div>
              <div id="pe-editor-content"></div>
              <div class="pe-editor-footer">
                <div class="pe-counters">
                  <span id="pe-count-words">0 words</span>
                  <span id="pe-count-chars">0 chars</span>
                </div>
                <div>
                  <kbd>Ctrl</kbd>+<kbd>B</kbd> bold &middot; <kbd>Ctrl</kbd>+<kbd>K</kbd> link &middot; <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo &middot; drop image to upload
                </div>
              </div>
            </div>

            <!-- AI dialog -->
            <div id="pe-ai-dialog" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;align-items:center;justify-content:center;padding:20px">
              <div style="background:var(--s-card-bg);border:1px solid var(--s-border);border-radius:12px;max-width:520px;width:100%;padding:20px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
                  <h3 style="margin:0;font-size:15px">✨ Generate page content with AI</h3>
                  <button type="button" id="pe-ai-close" class="pe-tab" style="font-size:18px;line-height:1">×</button>
                </div>
                <div style="display:flex;flex-direction:column;gap:10px">
                  <div>
                    <label class="pe-label">Topic / title</label>
                    <input type="text" id="pe-ai-topic" class="pe-input" placeholder="VD: About us, Chính sách đổi trả..." />
                  </div>
                  <div>
                    <label class="pe-label">Tone</label>
                    <select id="pe-ai-tone" class="pe-input">
                      <option value="friendly">Friendly</option>
                      <option value="professional">Professional</option>
                      <option value="casual">Casual</option>
                      <option value="luxury">Luxury</option>
                      <option value="playful">Playful</option>
                    </select>
                  </div>
                  <div>
                    <label class="pe-label">Keywords (comma-separated, optional)</label>
                    <input type="text" id="pe-ai-keywords" class="pe-input" placeholder="customer service, delivery..." />
                  </div>
                  <div>
                    <label class="pe-label">Language</label>
                    <select id="pe-ai-locale" class="pe-input">
                      <option value="vi">Tiếng Việt</option>
                      <option value="en">English</option>
                    </select>
                  </div>
                  <div id="pe-ai-status" class="pe-help"></div>
                  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
                    <button type="button" class="btn btn-outline" id="pe-ai-cancel">Cancel</button>
                    <button type="button" class="btn btn-primary" id="pe-ai-go">Generate</button>
                  </div>
                </div>
              </div>
            </div>

            <input type="hidden" name="content" id="pe-content-input" value="${esc(content)}" />
          </div>

          <!-- Search engine listing -->
          <details class="pe-card" ${seoTitle || seoDescription ? 'open' : ''}>
            <summary class="pe-card-header" style="cursor:pointer; list-style:none; display:flex; justify-content:space-between; align-items:center;">
              <h3>Search engine listing</h3>
              <span style="font-size:11px;color:var(--s-text-secondary)">Hiển thị trên Google</span>
            </summary>
            <div class="pe-card-body">
              <div>
                <label class="pe-label">Page title</label>
                <input type="text" name="seo_title" maxlength="70" class="pe-input"
                  value="${esc(seoTitle)}" placeholder="${esc(title) || 'Falls back to title'}" />
                <p class="pe-help">0–70 ký tự khuyến nghị</p>
              </div>
              <div>
                <label class="pe-label">Meta description</label>
                <textarea name="seo_description" rows="3" maxlength="255" class="pe-textarea"
                  placeholder="Mô tả ngắn cho Google. Tốt nhất 150–160 ký tự.">${esc(seoDescription)}</textarea>
              </div>
            </div>
          </details>
        </div>

        <!-- RIGHT: sidebar -->
        <div class="pe-side">

          <!-- Visibility -->
          <div class="pe-card">
            <div class="pe-card-header"><h3>Visibility</h3></div>
            <div class="pe-card-body">
              <label class="pe-radio-row">
                <input type="radio" name="published" value="true" ${published ? 'checked' : ''} />
                <span style="font-size:13px;font-weight:500">Visible</span>
              </label>
              <label class="pe-radio-row">
                <input type="radio" name="published" value="false" ${!published ? 'checked' : ''} />
                <span style="font-size:13px;font-weight:500">Hidden</span>
              </label>
            </div>
          </div>

          <!-- Online store template -->
          <div class="pe-card">
            <div class="pe-card-header"><h3>Online store</h3></div>
            <div class="pe-card-body">
              <div>
                <label class="pe-label">Template</label>
                <input type="text" name="template" class="pe-input"
                  value="${esc(template)}" placeholder="page" />
                <p class="pe-help">Suffix theme dùng để render. Để trống = default.</p>
              </div>
            </div>
          </div>

          <!-- Tags -->
          <div class="pe-card">
            <div class="pe-card-header"><h3>Tags</h3></div>
            <div class="pe-card-body">
              <div class="pe-tags-chips" id="pe-tags-chips"></div>
              <input type="text" id="pe-tags-input" class="pe-input" list="pe-tags-suggest"
                placeholder="Nhập tag rồi Enter / dấu phẩy" />
              <datalist id="pe-tags-suggest">${tagDatalist}</datalist>
              <input type="hidden" name="tags" id="pe-tags-hidden" value="${esc(tags.join(','))}" />
            </div>
          </div>

          <!-- Featured image -->
          <div class="pe-card">
            <div class="pe-card-header"><h3>Featured image</h3></div>
            <div class="pe-card-body">
              <img id="pe-image-preview" class="pe-thumb"
                src="${imageUrl ? esc(imageUrl) : 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MCAzMCI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjMwIiBmaWxsPSIjMGYxNzJhIi8+PC9zdmc+'}"
                alt="" style="display:${imageUrl ? 'block' : 'none'}" />
              <div class="pe-row">
                <input type="text" name="image_url" id="pe-image-url" class="pe-input"
                  value="${esc(imageUrl)}" placeholder="URL ảnh" />
              </div>
              <div class="pe-row" style="gap:6px">
                <input type="file" id="pe-image-file" accept="image/*" style="display:none" />
                <button type="button" class="btn btn-outline btn-sm" id="pe-image-upload-btn" style="flex:1">Upload</button>
                <a href="${base}/files" target="_blank" class="btn btn-outline btn-sm" style="flex:1;text-align:center">Browse Files</a>
              </div>
              <p class="pe-help" id="pe-image-status"></p>
            </div>
          </div>

          ${
            otherCustomFields.length > 0 || pageView !== '0'
              ? `
          <!-- Custom fields readonly -->
          <div class="pe-card">
            <div class="pe-card-header"><h3>Stats</h3></div>
            <div class="pe-card-body" style="gap:6px">
              <div class="pe-meta"><span>page_view</span><strong>${esc(pageView)}</strong></div>
              ${otherCustomFields
                .map(
                  (c) =>
                    `<div class="pe-meta"><span>${esc(c.name ?? '')}</span><strong>${esc(c.value ?? '')}</strong></div>`,
                )
                .join('')}
            </div>
          </div>`
              : ''
          }

        </div>
      </div>

      <!-- Action bar -->
      <div style="display:flex;gap:8px;justify-content:space-between;margin-top:24px">
        <div>
          ${
            isEdit
              ? `<button type="button" class="btn btn-outline" style="color:var(--s-danger);border-color:var(--s-danger)"
                  onclick="if(confirm('Delete page?')) document.getElementById('pe-delete-form').submit()">Delete page</button>`
              : ''
          }
        </div>
        <div style="display:flex;gap:8px">
          <a href="${base}/pages" class="btn btn-outline">Cancel</a>
          <button type="submit" class="btn btn-primary">${isEdit ? 'Save' : 'Create'}</button>
        </div>
      </div>
    </form>

    ${
      isEdit
        ? `<form id="pe-delete-form" method="POST" action="${base}/pages/${esc(pageId)}/delete" style="display:none">${csrfField}</form>`
        : ''
    }

    <script src="https://cdn.ckeditor.com/ckeditor5/41.4.2/super-build/ckeditor.js"></script>
    <script>
      window.addEventListener('error', function (e) {
        console.error('[page-editor]', e.message, e.error);
      });
      (function () {
        ${slugifyJs()}

        // ─── Slug live preview ─────────────────────────────────────────
        var titleEl = document.getElementById('pe-title');
        var slugEl = document.getElementById('pe-slug-preview');
        var initialSlug = ${JSON.stringify(slug)};
        if (titleEl && slugEl) {
          titleEl.addEventListener('input', function () {
            var s = slugify(titleEl.value);
            slugEl.textContent = ${isEdit ? 'initialSlug || s' : 's'};
          });
        }

        // ─── Sidebar handlers bind TRƯỚC CKEditor ──────────────────────
        // Tách phần không phụ thuộc editor để giữ UX còn dùng được nếu
        // CKEditor CDN fail / runtime throw.

        // Shared: upload 1 file → POST /files/upload với Accept: json → URL
        function uploadFileToLibrary(file, cb) {
          var fd = new FormData();
          fd.append('file', file);
          fetch(${JSON.stringify(base + '/files/upload')}, {
            method: 'POST',
            headers: { Accept: 'application/json' },
            body: fd,
            credentials: 'same-origin',
          })
            .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
            .then(function (res) {
              if (!res.ok || !res.j || res.j.ok === false) {
                return cb(null, (res.j && res.j.error) || 'unknown');
              }
              cb(res.j.url);
            })
            .catch(function (e) { cb(null, e.message || 'network'); });
        }

        // Featured image picker
        var imageUrlEl = document.getElementById('pe-image-url');
        var imagePreviewEl = document.getElementById('pe-image-preview');
        var imageStatusEl = document.getElementById('pe-image-status');
        var uploadBtn = document.getElementById('pe-image-upload-btn');
        var fileInput = document.getElementById('pe-image-file');
        function syncImagePreview(url) {
          if (url) { imagePreviewEl.src = url; imagePreviewEl.style.display = 'block'; }
          else { imagePreviewEl.style.display = 'none'; }
        }
        imageUrlEl.addEventListener('input', function () { syncImagePreview(imageUrlEl.value); });
        uploadBtn.addEventListener('click', function () { fileInput.click(); });
        fileInput.addEventListener('change', function () {
          if (!fileInput.files || !fileInput.files[0]) return;
          uploadFileToLibrary(fileInput.files[0], function (url, err) {
            if (err) { imageStatusEl.style.color = 'var(--s-danger)'; imageStatusEl.textContent = 'Upload failed: ' + err; return; }
            imageStatusEl.style.color = 'var(--s-text-secondary)';
            imageStatusEl.textContent = 'Uploaded';
            imageUrlEl.value = url;
            syncImagePreview(url);
          });
        });

        // Tags chip input
        var tagsHidden = document.getElementById('pe-tags-hidden');
        var tagsChipsEl = document.getElementById('pe-tags-chips');
        var tagsInputEl = document.getElementById('pe-tags-input');
        var tagSet = new Set(${JSON.stringify(tags)});
        function renderChips() {
          tagsChipsEl.innerHTML = '';
          tagSet.forEach(function (t) {
            var chip = document.createElement('span');
            chip.className = 'pe-chip';
            chip.innerHTML = '<span></span><button type="button" aria-label="Remove">×</button>';
            chip.firstChild.textContent = t;
            chip.querySelector('button').addEventListener('click', function () {
              tagSet.delete(t); renderChips();
            });
            tagsChipsEl.appendChild(chip);
          });
          tagsHidden.value = Array.from(tagSet).join(',');
        }
        function addTag(raw) {
          var t = (raw || '').trim();
          if (!t) return;
          tagSet.add(t); renderChips();
        }
        tagsInputEl.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            addTag(tagsInputEl.value);
            tagsInputEl.value = '';
          }
        });
        tagsInputEl.addEventListener('blur', function () {
          if (tagsInputEl.value.trim()) { addTag(tagsInputEl.value); tagsInputEl.value = ''; }
        });
        renderChips();

        // ─── CKEditor 5 super-build (full WYSIWYG) ─────────────────────
        // Toolbar đầy đủ: heading, font (family/size/color/bg), B/I/U/S,
        // alignment, list, indent, link, blockquote, table, image upload,
        // media embed, source code view. Image upload via SimpleUploadAdapter
        // → POST /files/upload (BE auto detect Accept:json → trả {url}).
        var contentInput = document.getElementById('pe-content-input');
        var wordsEl = document.getElementById('pe-count-words');
        var charsEl = document.getElementById('pe-count-chars');
        var savedEl = document.getElementById('pe-autosave-status');
        var savedTimer = null;
        function markChanged() {
          savedEl.textContent = 'Editing…';
          savedEl.className = 'pe-saving';
          if (savedTimer) clearTimeout(savedTimer);
          savedTimer = setTimeout(function () {
            savedEl.textContent = 'Draft kept locally';
            savedEl.className = 'pe-saved';
          }, 1200);
        }
        var editor = null;
        // Super-build expose window.CKEDITOR.{ClassicEditor,InlineEditor,...}
        // Standalone classic build expose window.ClassicEditor trực tiếp.
        var ClassicEditor = (window.CKEDITOR && window.CKEDITOR.ClassicEditor) || window.ClassicEditor;
        function renderFallbackTextarea(reason) {
          if (reason) console.warn('[page-editor]', reason);
          var host = document.getElementById('pe-editor-content');
          if (!host) return;
          host.innerHTML = '<textarea id="pe-content-fallback" rows="20" style="width:100%;border:none;padding:14px;background:var(--s-input-bg);color:var(--s-text);font-size:13px;outline:none;resize:vertical;min-height:420px">' + (contentInput.value || '') + '</textarea>';
          host.querySelector('textarea').addEventListener('input', function (e) { contentInput.value = e.target.value; });
        }
        if (ClassicEditor) {
          // Super-build bundle Comments/TrackChanges/RealTimeCollab/CKBox/
          // CKFinder/EasyImage/CloudServices premium plugins — yêu cầu
          // license key + channelId. Disable hết qua removePlugins để
          // chạy free. licenseKey GPL enable free tier (CKEditor v38+).
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
          ];
          ClassicEditor.create(document.querySelector('#pe-editor-content'), {
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
            placeholder: 'Bắt đầu viết nội dung trang...',
            image: {
              toolbar: ['imageTextAlternative', 'toggleImageCaption', 'imageStyle:inline', 'imageStyle:block', 'imageStyle:side']
            },
            table: {
              contentToolbar: ['tableColumn', 'tableRow', 'mergeTableCells', 'tableProperties', 'tableCellProperties']
            },
            simpleUpload: {
              uploadUrl: ${JSON.stringify(base + '/files/upload')},
              withCredentials: true,
              headers: { Accept: 'application/json' }
            },
            wordCount: {
              onUpdate: function (stats) {
                wordsEl.textContent = stats.words + ' word' + (stats.words === 1 ? '' : 's');
                charsEl.textContent = stats.characters + ' char' + (stats.characters === 1 ? '' : 's');
              }
            }
          })
            .then(function (e) {
              editor = e;
              window.__pageEditor = editor;
              editor.model.document.on('change:data', function () {
                contentInput.value = editor.getData();
                markChanged();
              });
            })
            .catch(function (err) {
              console.error('[page-editor] CKEditor init failed:', err);
              renderFallbackTextarea(null);
            });
        } else {
          renderFallbackTextarea('CKEditor global not loaded — using textarea fallback. window.CKEDITOR=' + typeof window.CKEDITOR);
        }

        // ─── Fullscreen toggle ─────────────────────────────────────────
        var fsBtn = document.getElementById('pe-fullscreen-btn');
        var shell = document.querySelector('.pe-editor-shell');
        fsBtn.addEventListener('click', function () {
          if (!document.fullscreenElement) shell.requestFullscreen?.();
          else document.exitFullscreen?.();
        });

        // ─── AI generate dialog ────────────────────────────────────────
        // Reuse /api/ai/product-description endpoint (đã rate-limit + log).
        // productTitle = page topic, keywords = tags. Dialog FE-only.
        var aiBtn = document.getElementById('pe-ai-btn');
        var aiDlg = document.getElementById('pe-ai-dialog');
        var aiTopic = document.getElementById('pe-ai-topic');
        var aiTone = document.getElementById('pe-ai-tone');
        var aiKeywords = document.getElementById('pe-ai-keywords');
        var aiLocale = document.getElementById('pe-ai-locale');
        var aiStatus = document.getElementById('pe-ai-status');
        var aiGo = document.getElementById('pe-ai-go');
        function openAi() {
          aiTopic.value = (titleEl.value || '').trim();
          aiKeywords.value = (document.getElementById('pe-tags-hidden').value || '').trim();
          aiStatus.textContent = '';
          aiDlg.style.display = 'flex';
        }
        function closeAi() { aiDlg.style.display = 'none'; }
        aiBtn.addEventListener('click', openAi);
        document.getElementById('pe-ai-close').addEventListener('click', closeAi);
        document.getElementById('pe-ai-cancel').addEventListener('click', closeAi);
        aiDlg.addEventListener('click', function (e) { if (e.target === aiDlg) closeAi(); });

        aiGo.addEventListener('click', function () {
          var topic = (aiTopic.value || '').trim();
          if (!topic) { aiStatus.textContent = 'Topic is required'; aiStatus.style.color = 'var(--s-danger)'; return; }
          aiGo.disabled = true; aiStatus.style.color = 'var(--s-text-secondary)'; aiStatus.textContent = 'Đang tạo nội dung...';
          fetch(${JSON.stringify(base.replace('/online-store', '') + '/api/ai/product-description')}, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
              productTitle: topic,
              tone: aiTone.value || 'friendly',
              keywords: (aiKeywords.value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 10),
              locale: aiLocale.value || 'vi',
            }),
          })
            .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
            .then(function (res) {
              aiGo.disabled = false;
              if (!res.ok || !res.j || res.j.ok === false) {
                aiStatus.textContent = (res.j && (res.j.error || res.j.message)) || 'AI generate failed';
                aiStatus.style.color = 'var(--s-danger)';
                return;
              }
              var variants = (res.j.variants || []);
              if (!variants.length) { aiStatus.textContent = 'No variant returned'; return; }
              var html = '<p>' + String(variants[0]).replace(/\\n+/g, '</p><p>') + '</p>';
              if (editor) {
                // CKEditor: convert HTML → model fragment → insert ở selection
                try {
                  var viewFrag = editor.data.processor.toView(html);
                  var modelFrag = editor.data.toModel(viewFrag);
                  editor.model.change(function (writer) {
                    editor.model.insertContent(modelFrag, editor.model.document.selection);
                  });
                } catch (e) {
                  // Fallback: append vào data
                  editor.setData(editor.getData() + html);
                }
              } else {
                var fb = document.getElementById('pe-content-fallback');
                if (fb) { fb.value = (fb.value || '') + html; contentInput.value = fb.value; }
              }
              closeAi();
            })
            .catch(function (e) { aiGo.disabled = false; aiStatus.textContent = e.message || 'Network error'; aiStatus.style.color = 'var(--s-danger)'; });
        });

        // ─── localStorage draft (FE-only autosave) ─────────────────────
        var DRAFT_KEY = 'gbox-page-draft:' + ${JSON.stringify(opts.base)} + ':' + ${JSON.stringify(pageId || 'new')};
        var initialContent = ${JSON.stringify(content)};
        var draftTimer = null;
        function saveDraft() {
          if (!editor) return;
          try {
            var html = editor.getData();
            if (html === initialContent) { localStorage.removeItem(DRAFT_KEY); return; }
            localStorage.setItem(DRAFT_KEY, JSON.stringify({ html: html, t: Date.now() }));
            savedEl.textContent = 'Draft saved'; savedEl.className = 'pe-saved';
          } catch (e) { /* quota / disabled — ignore */ }
        }
        // CKEditor init là async (Promise) — bind draft sau khi editor sẵn sàng.
        // Dùng polling ngắn vì createPromise không expose ra IIFE scope.
        var draftBindAttempts = 0;
        var draftBindTimer = setInterval(function () {
          draftBindAttempts++;
          if (editor) {
            clearInterval(draftBindTimer);
            editor.model.document.on('change:data', function () {
              if (draftTimer) clearTimeout(draftTimer);
              draftTimer = setTimeout(saveDraft, 1000);
            });
            // Restore prompt
            try {
              var raw = localStorage.getItem(DRAFT_KEY);
              if (raw) {
                var d = JSON.parse(raw);
                if (d && d.html && d.html !== initialContent) {
                  var ageMs = Date.now() - (d.t || 0);
                  var ageMin = Math.floor(ageMs / 60000);
                  var ageStr = ageMin < 1 ? 'vừa xong' : (ageMin + ' phút trước');
                  var banner = document.getElementById('pe-draft-banner');
                  banner.style.display = 'flex';
                  document.getElementById('pe-draft-age').textContent = '(' + ageStr + ')';
                  document.getElementById('pe-draft-restore').addEventListener('click', function () {
                    editor.setData(d.html);
                    banner.style.display = 'none';
                  });
                  document.getElementById('pe-draft-discard').addEventListener('click', function () {
                    localStorage.removeItem(DRAFT_KEY);
                    banner.style.display = 'none';
                  });
                }
              }
            } catch (e) { /* corrupt JSON → ignore */ }
          } else if (draftBindAttempts > 50) {
            // 50 × 100ms = 5s timeout — CKEditor không init được
            clearInterval(draftBindTimer);
          }
        }, 100);

        // ─── Sync hidden inputs trên submit ────────────────────────────
        // CKEditor: editor.getData() trả HTML hiện tại (đã sync mỗi
        // change:data nhưng read 1 lần nữa khi submit cho chắc).
        // Clear localStorage draft cùng lúc.
        document.getElementById('pe-form').addEventListener('submit', function () {
          if (editor) {
            contentInput.value = editor.getData();
          } else {
            var fb = document.getElementById('pe-content-fallback');
            if (fb) contentInput.value = fb.value;
          }
          try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
        });
      })();
    </script>
  `
}
