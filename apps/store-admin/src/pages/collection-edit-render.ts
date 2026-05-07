/**
 * collection-edit-render.ts
 * Pure render function cho collection create + edit forms.
 * Dùng bởi getCreateCollection và getEditCollection trong collections.ts.
 */

import { esc } from '../layouts/seller-layout.js'
import type { Category } from '../lib/product-api-types.js'

export interface CollectionEditFormOptions {
  /** Form action URL */
  action: string
  /** CSRF hidden field HTML */
  csrfField: string
  /** Existing category data — null khi create */
  category: Category | null
  /** Back-link URL */
  backHref: string
  /** Back-link label */
  backLabel: string
  /** Inline validation errors keyed by field name */
  errors?: Record<string, string>
  /** Flash error message (from query param) */
  flashError?: string
  /** "create" | "edit" — controls title + submit button label */
  mode: 'create' | 'edit'
}

function fieldError(errors: Record<string, string> | undefined, field: string): string {
  const msg = errors?.[field]
  if (!msg) return ''
  return `<div role="alert" style="color:var(--s-danger);font-size:12px;margin-top:4px">${esc(msg)}</div>`
}

function borderStyle(errors: Record<string, string> | undefined, field: string): string {
  return errors?.[field] ? ';border-color:var(--s-danger)' : ''
}

/**
 * Returns HTML string for the collection create/edit form.
 * Does NOT wrap in sellerLayout — caller handles the layout wrapper.
 */
export function renderCollectionEditForm(opts: CollectionEditFormOptions): string {
  const { action, csrfField, category, backHref, backLabel, errors, flashError, mode } = opts
  const c = category ?? {}

  const title = mode === 'create' ? 'Tạo Collection mới' : 'Chỉnh sửa Collection'
  const submitLabel = mode === 'create' ? 'Tạo collection' : 'Lưu thay đổi'
  const busyLabel = mode === 'create' ? 'Đang tạo…' : 'Đang lưu…'

  return `
    <div class="page-header">
      <div>
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:4px">
          <a href="${esc(backHref)}" style="color:var(--s-text-muted);text-decoration:none;font-size:13px">&larr; ${esc(backLabel)}</a>
        </div>
        <h1 class="page-title">${title}</h1>
      </div>
    </div>

    ${flashError ? `
      <div class="card" style="margin-bottom:16px;border-left:3px solid var(--s-danger)" role="alert">
        <div class="card-body" style="color:var(--s-danger);font-size:14px">${esc(flashError)}</div>
      </div>
    ` : ''}

    <form method="POST" action="${esc(action)}" id="colEditForm" novalidate>
      ${csrfField}

      <!-- Collection Details -->
      <div class="card" style="margin-bottom:24px">
        <div class="card-header"><span style="font-weight:600">Thông tin Collection</span></div>
        <div class="card-body">

          <!-- Name -->
          <div class="form-group">
            <label class="form-label" for="col_name">Tên *</label>
            <input type="text" id="col_name" name="name" class="form-input" required
                   maxlength="200"
                   value="${esc(c.name ?? '')}"
                   placeholder="VD: Bộ sưu tập mùa hè 2026"
                   style="min-height:44px${borderStyle(errors, 'name')}"
                   aria-describedby="${errors?.name ? 'col_name_err' : ''}" />
            ${errors?.name ? `<div id="col_name_err" role="alert" style="color:var(--s-danger);font-size:12px;margin-top:4px">${esc(errors.name)}</div>` : ''}
          </div>

          <!-- Slug -->
          <div class="form-group">
            <label class="form-label" for="col_slug">Slug <span style="font-weight:400;color:var(--s-text-muted);font-size:12px">(tự động nếu để trống)</span></label>
            <input type="text" id="col_slug" name="slug" class="form-input"
                   maxlength="100"
                   value="${esc(c.slug ?? '')}"
                   placeholder="vd: bo-suu-tap-mua-he"
                   style="font-family:monospace;min-height:44px${borderStyle(errors, 'slug')}"
                   aria-describedby="${errors?.slug ? 'col_slug_err' : 'col_slug_help'}" />
            ${errors?.slug ? `<div id="col_slug_err" role="alert" style="color:var(--s-danger);font-size:12px;margin-top:4px">${esc(errors.slug)}</div>` : ''}
            <div id="col_slug_help" class="form-help" style="font-size:12px;color:var(--s-text-muted);margin-top:4px">
              Dùng trong URL storefront. Chỉ a-z, 0-9, dấu gạch ngang.
            </div>
          </div>

          <!-- Description -->
          <div class="form-group">
            <label class="form-label" for="col_description">Mô tả</label>
            <textarea id="col_description" name="description" class="form-textarea" rows="4"
                      maxlength="5000"
                      placeholder="Mô tả ngắn về collection này..."
                      style="min-height:88px${borderStyle(errors, 'description')}">${esc(c.description ?? '')}</textarea>
            ${fieldError(errors, 'description')}
          </div>

          <!-- Image URL + Status in 2-col grid -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
            <div class="form-group">
              <label class="form-label" for="col_image_url">Image URL</label>
              <input type="url" id="col_image_url" name="image_url" class="form-input"
                     value="${esc(c.image_url ?? '')}"
                     placeholder="https://..."
                     style="min-height:44px${borderStyle(errors, 'image_url')}" />
              ${fieldError(errors, 'image_url')}
            </div>

            <div class="form-group" style="display:flex;flex-direction:column;justify-content:flex-end">
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;min-height:44px">
                <input type="checkbox" name="status" value="true"
                       ${(c.status !== false) ? 'checked' : ''}
                       id="col_status"
                       style="width:18px;height:18px;accent-color:var(--s-accent);flex-shrink:0" />
                <span class="form-label" style="margin:0">Công khai (Published)</span>
              </label>
            </div>
          </div>

          ${c.image_url ? `
            <div style="margin-top:12px">
              <img src="${esc(c.image_url)}" alt="Ảnh collection" loading="lazy"
                   style="max-width:120px;border-radius:8px;border:1px solid var(--s-border)" />
            </div>
          ` : ''}

        </div>
      </div>

      <!-- SEO -->
      <div class="card" style="margin-bottom:24px">
        <div class="card-header"><span style="font-weight:600">SEO</span></div>
        <div class="card-body">
          <div class="form-group">
            <label class="form-label" for="col_seo_title">Page title</label>
            <input type="text" id="col_seo_title" name="seo_title" class="form-input"
                   maxlength="200"
                   value="${esc(c.seo_title ?? '')}"
                   placeholder="Mặc định là tên collection"
                   style="min-height:44px" />
            <div class="form-help" style="font-size:12px;color:var(--s-text-muted);margin-top:4px">Hiển thị trên tab trình duyệt và kết quả tìm kiếm.</div>
          </div>
          <div class="form-group">
            <label class="form-label" for="col_seo_description">Meta description</label>
            <textarea id="col_seo_description" name="seo_description" class="form-textarea" rows="3"
                      maxlength="320"
                      placeholder="Tóm tắt ngắn (150-160 ký tự tốt nhất)..."
                      style="min-height:72px">${esc(c.seo_description ?? '')}</textarea>
          </div>
        </div>
      </div>

      <!-- Actions -->
      <div style="display:flex;gap:12px;justify-content:flex-end;margin-bottom:32px">
        <a href="${esc(backHref)}" class="btn btn-outline btn-sm" style="min-height:44px;display:flex;align-items:center">Hủy</a>
        <button type="submit" class="btn btn-primary btn-sm" style="min-height:44px"
                data-busy-label="${busyLabel}">${submitLabel}</button>
      </div>
    </form>

    <script>
    (function () {
      // Form busy state — disable submit on in-flight POST
      var form = document.getElementById('colEditForm');
      if (!form) return;
      form.addEventListener('submit', function () {
        var btn = form.querySelector('button[type="submit"][data-busy-label]');
        if (!btn || btn.disabled) return;
        btn.dataset.idleLabel = btn.innerHTML;
        btn.innerHTML = btn.dataset.busyLabel;
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
      });

      // Auto-generate slug from name if slug field is empty
      var nameInput = document.getElementById('col_name');
      var slugInput = document.getElementById('col_slug');
      if (nameInput && slugInput && !slugInput.value) {
        nameInput.addEventListener('input', function () {
          if (slugInput.dataset.userEdited) return;
          slugInput.value = nameInput.value
            .toLowerCase()
            .replace(/[^a-z0-9\\u00C0-\\u024F\\s-]/gi, '')
            .replace(/\\s+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 100);
        });
        slugInput.addEventListener('input', function () {
          slugInput.dataset.userEdited = '1';
        });
      }
    })();
    </script>
  `
}
