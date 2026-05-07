/**
 * shop-collection-edit-render.ts
 * Render form Create / Edit collection — 2 column Polaris-inspired.
 * Reuse purchase-order-product-picker với mode='product' để pick products.
 */

import { esc } from '../layouts/seller-layout.js'
import { productPickerAssets } from '../components/purchase-order-product-picker.js'
import type { ShopCollection } from '../lib/collection-api-types.js'

export interface CollectionEditFormData {
  mode: 'create' | 'edit'
  formAction: string
  csrfField: string
  backHref: string
  productsSearchUrl: string
  slugCheckUrl: string
  collection?: ShopCollection
  flashError?: string
}

const SORT_ORDER_OPTIONS: [string, string][] = [
  ['manual', 'Manually'],
  ['best_selling', 'Best selling'],
  ['alpha_asc', 'Alphabetically: A–Z'],
  ['alpha_desc', 'Alphabetically: Z–A'],
  ['price_asc', 'Price: low to high'],
  ['price_desc', 'Price: high to low'],
  ['created_desc', 'Newest'],
  ['created_asc', 'Oldest'],
]

export function renderShopCollectionEditForm(data: CollectionEditFormData): string {
  const { mode, formAction, csrfField, backHref, productsSearchUrl, slugCheckUrl, collection, flashError } = data
  const c = collection ?? ({} as ShopCollection)
  const tagsStr = Array.isArray(c.tags) ? c.tags.join(', ') : ''
  const isPublished = c.status !== false
  const sortOrder = c.sort_order ?? 'manual'
  const editId = c.id ?? ''

  const styles = `<style>
    .sc-page{max-width:1180px;margin:0 auto;padding:24px 20px}
    .sc-breadcrumb{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--gx-muted);margin-bottom:14px}
    .sc-breadcrumb a{color:var(--gx-muted);text-decoration:none;display:inline-flex;align-items:center;gap:6px}
    .sc-breadcrumb a:hover{color:var(--gx-text)}
    .sc-title{margin:0 0 22px;font-size:22px;font-weight:600;letter-spacing:-.01em}
    .sc-grid{display:grid;grid-template-columns:1.7fr 1fr;gap:14px}
    @media (max-width:880px){.sc-grid{grid-template-columns:1fr}}
    .sc-col{display:flex;flex-direction:column;gap:14px}
    .sc-card{background:var(--gx-surface,rgba(255,255,255,.02));border:1px solid var(--gx-border);border-radius:12px;padding:18px 20px}
    .sc-card h2{margin:0 0 12px;font-size:13px;font-weight:600}
    .sc-field{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}
    .sc-field:last-child{margin-bottom:0}
    .sc-label{font-size:12.5px;font-weight:500;color:var(--gx-muted)}
    .sc-input,.sc-select,.sc-textarea{width:100%;padding:8px 10px;background:var(--gx-bg,#13161c);border:1px solid var(--gx-border);border-radius:7px;color:var(--gx-text);font-size:13.5px;box-sizing:border-box;outline:none;font-family:inherit}
    .sc-input:focus,.sc-select:focus,.sc-textarea:focus{border-color:#5b6dff;box-shadow:0 0 0 3px rgba(91,109,255,.15)}
    .sc-textarea{resize:vertical;min-height:80px}
    .sc-help{font-size:11.5px;color:var(--gx-muted);margin-top:3px}
    .sc-help-ok{color:#4ade80}
    .sc-help-err{color:#fca5a5}
    .sc-2col{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .sc-toggle{display:inline-flex;align-items:center;gap:8px;cursor:pointer}
    .sc-toggle input{accent-color:#5b6dff;width:16px;height:16px}
    .sc-products-row{display:flex;gap:10px;align-items:stretch}
    .sc-products-row .po-search{flex:1}
    .sc-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:8px;font-size:13.5px;font-weight:500;text-decoration:none;border:1px solid transparent;cursor:pointer}
    .sc-btn-primary{background:linear-gradient(180deg,#5b6dff,#4854e0);color:#fff}
    .sc-btn-primary:hover{background:linear-gradient(180deg,#6577ff,#5260e8)}
    .sc-btn-ghost{background:transparent;color:var(--gx-text);border-color:var(--gx-border,rgba(255,255,255,.12))}
    .sc-btn-ghost:hover{background:rgba(255,255,255,.04)}
    .sc-btn-danger{background:transparent;color:#fca5a5;border-color:rgba(239,68,68,.25)}
    .sc-btn-danger:hover{background:rgba(239,68,68,.12);border-color:#ef4444}
    .sc-actions{display:flex;justify-content:space-between;gap:10px;margin-top:18px}
    .sc-flash{padding:11px 14px;border-radius:8px;margin-bottom:14px;font-size:13.5px}
    .sc-flash-error{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);color:#fca5a5}
    .po-empty-products{display:none}
  </style>`

  const flashHtml = flashError
    ? `<div class="sc-flash sc-flash-error" role="alert">${esc(flashError)}</div>`
    : ''

  const deleteFormHtml = mode === 'edit' && editId
    ? `<form method="POST" action="${esc(formAction).replace(/\/update$/, '/delete')}" onsubmit="return confirm('Delete this collection?')" style="display:inline">
        ${csrfField}
        <button type="submit" class="sc-btn sc-btn-danger">Delete</button>
      </form>`
    : ''

  return `${styles}
  <div class="sc-page">
    <nav class="sc-breadcrumb">
      <a href="${esc(backHref)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>Collections</a>
    </nav>
    <h1 class="sc-title">${mode === 'create' ? 'Create collection' : 'Edit collection'}</h1>
    ${flashHtml}

    <form method="POST" action="${esc(formAction)}" novalidate>
      ${csrfField}
      ${editId ? `<input type="hidden" name="id" value="${esc(editId)}">` : ''}

      <div class="sc-grid">
        <!-- LEFT: Title, Description, Products, SEO -->
        <div class="sc-col">
          <div class="sc-card">
            <div class="sc-field">
              <label class="sc-label" for="sc-name">Title *</label>
              <input type="text" name="name" id="sc-name" class="sc-input" maxlength="255" required value="${esc(c.name ?? '')}" placeholder="e.g. Summer 2026">
            </div>
            <div class="sc-field">
              <label class="sc-label" for="sc-slug">URL handle (slug)</label>
              <input type="text" name="slug" id="sc-slug" class="sc-input" maxlength="255" value="${esc(c.slug ?? '')}" placeholder="auto-generated from title">
              <div class="sc-help" id="sc-slug-help">Lowercase letters, numbers, hyphens. Auto-generated if blank.</div>
            </div>
            <div class="sc-field">
              <label class="sc-label" for="sc-desc">Description</label>
              <textarea name="description" id="sc-desc" class="sc-textarea" maxlength="2000" rows="3" placeholder="Short summary shown on storefront…">${esc(c.description ?? '')}</textarea>
            </div>
            <div class="sc-field" style="margin-bottom:0">
              <label class="sc-label" for="sc-body">Body (rich text HTML)</label>
              <textarea name="body_html" id="sc-body" class="sc-textarea" rows="6" placeholder="&lt;p&gt;Long form content…&lt;/p&gt;">${esc(c.body_html ?? '')}</textarea>
            </div>
          </div>

          <div class="sc-card">
            <h2>Products</h2>
            <div class="sc-products-row">
              <div class="po-search" style="position:relative">
                <svg style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--gx-muted);pointer-events:none" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>
                <input type="search" class="sc-input po-search-input" placeholder="Search products" autocomplete="off" style="padding-left:34px">
                <div class="po-search-results" role="listbox"></div>
              </div>
              <button type="button" class="sc-btn sc-btn-ghost po-browse-btn">Browse</button>
            </div>
            <div class="po-selected-products" role="list">${
              (c.products || []).map((p) => {
                const pid = p.product_id ?? ''
                const key = pid + '|product'
                const img = p.product_image
                  ? `<img class="po-selected-img" src="${esc(p.product_image)}" alt="">`
                  : `<div class="po-selected-img-empty">📦</div>`
                return `<div class="po-selected-row" data-key="${esc(key)}">
                  ${img}
                  <div class="po-selected-info">
                    <div class="po-selected-name">${esc(p.product_name ?? pid)}</div>
                    <div class="po-selected-sub">Product</div>
                  </div>
                  <button type="button" class="po-remove-btn" data-remove>Remove</button>
                  <input type="hidden" name="items[${esc(key)}][product_id]" value="${esc(pid)}">
                  <input type="hidden" name="items[${esc(key)}][variant_id]" value="">
                  <input type="hidden" name="items[${esc(key)}][variant_slug]" value="product">
                  <input type="hidden" name="items[${esc(key)}][variant_name]" value="${esc(p.product_name ?? '')}">
                  <input type="hidden" name="items[${esc(key)}][sku]" value="">
                  <input type="hidden" name="items[${esc(key)}][price]" value="0">
                  <input type="hidden" name="items[${esc(key)}][qty]" value="1" data-hidden-qty>
                </div>`
              }).join('')
            }</div>
            <div class="po-empty-products"></div>
          </div>

          <div class="sc-card">
            <h2>Search engine listing</h2>
            <div class="sc-field">
              <label class="sc-label" for="sc-seo-title">SEO title</label>
              <input type="text" name="seo_title" id="sc-seo-title" class="sc-input" maxlength="70" value="${esc(c.seo_title ?? '')}">
              <div class="sc-help">Recommended ≤ 70 characters.</div>
            </div>
            <div class="sc-field" style="margin-bottom:0">
              <label class="sc-label" for="sc-seo-desc">Meta description</label>
              <textarea name="seo_description" id="sc-seo-desc" class="sc-textarea" maxlength="320" rows="2">${esc(c.seo_description ?? '')}</textarea>
              <div class="sc-help">Recommended ≤ 160 characters.</div>
            </div>
          </div>
        </div>

        <!-- RIGHT: Status, Image, Sort, Tags -->
        <div class="sc-col">
          <div class="sc-card">
            <h2>Status</h2>
            <label class="sc-toggle">
              <input type="checkbox" name="status" value="true" ${isPublished ? 'checked' : ''}>
              <span>Published (visible on storefront)</span>
            </label>
          </div>

          <div class="sc-card">
            <h2>Image</h2>
            <div class="sc-field">
              <label class="sc-label" for="sc-img">Image URL</label>
              <input type="url" name="image_url" id="sc-img" class="sc-input" value="${esc(c.image_url ?? '')}" placeholder="https://…">
              <div class="sc-help">Native upload coming soon — paste URL for now.</div>
            </div>
          </div>

          <div class="sc-card">
            <h2>Sort order on storefront</h2>
            <select name="sort_order" class="sc-select">
              ${SORT_ORDER_OPTIONS.map(([v, l]) => `<option value="${v}"${sortOrder === v ? ' selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>

          <div class="sc-card">
            <h2>Tags</h2>
            <input type="text" name="tags" class="sc-input" value="${esc(tagsStr)}" placeholder="Comma-separated">
          </div>
        </div>
      </div>

      <div class="sc-actions">
        <div>${deleteFormHtml}</div>
        <div style="display:flex;gap:10px">
          <a href="${esc(backHref)}" class="sc-btn sc-btn-ghost">Cancel</a>
          <button type="submit" class="sc-btn sc-btn-primary">${mode === 'create' ? 'Create' : 'Save'}</button>
        </div>
      </div>
    </form>
  </div>
  ${productPickerAssets({ searchUrl: productsSearchUrl, mode: 'product' })}
  <script>(function(){
    // Realtime slug uniqueness check
    var SLUG_URL = ${JSON.stringify(slugCheckUrl)};
    var EXCLUDE_ID = ${JSON.stringify(editId)};
    var slugInput = document.getElementById('sc-slug')
    var nameInput = document.getElementById('sc-name')
    var help = document.getElementById('sc-slug-help')
    var debounce = null
    function check(value){
      if (!value) {
        help.textContent = 'Lowercase letters, numbers, hyphens. Auto-generated if blank.'
        help.className = 'sc-help'
        return
      }
      help.textContent = 'Checking…'; help.className = 'sc-help'
      var url = SLUG_URL + '?slug=' + encodeURIComponent(value) + (EXCLUDE_ID ? '&exclude_id='+encodeURIComponent(EXCLUDE_ID) : '')
      fetch(url, {credentials:'same-origin', headers:{accept:'application/json'}})
        .then(function(r){return r.ok ? r.json() : null})
        .then(function(d){
          if (!d) { help.textContent = 'Check failed'; return }
          if (d.available) {
            help.textContent = '✓ Slug "' + d.slug + '" is available'
            help.className = 'sc-help sc-help-ok'
          } else {
            help.textContent = '✗ Slug already used by another collection'
            help.className = 'sc-help sc-help-err'
          }
        })
    }
    if (slugInput) {
      slugInput.addEventListener('input', function(){
        clearTimeout(debounce)
        debounce = setTimeout(function(){ check(slugInput.value.trim()) }, 400)
      })
    }
    // Auto-fill slug from name khi user chưa nhập slug
    if (nameInput && slugInput) {
      var slugTouched = !!slugInput.value
      slugInput.addEventListener('input', function(){ slugTouched = true })
      nameInput.addEventListener('input', function(){
        if (slugTouched) return
        var slugified = nameInput.value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/đ/g,'d').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')
        slugInput.value = slugified
      })
    }
  })();</script>`
}
