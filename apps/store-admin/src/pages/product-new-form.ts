/**
 * Add Product form — Shopify-style layout matching the reference screenshot.
 *
 * Wired to existing POST /products handler in products.ts.
 * Required form fields (must keep names): title, body_html, vendor,
 * product_type, tags, status, price, compare_at_price, sku, inventory_quantity.
 *
 * Visual-only fields (Category, Charge tax, Cost per item, Inventory tracked,
 * Sell when out of stock, Physical product, Package, Product weight, Country
 * of origin, HS Code, Collections, Theme template, Online Store, Point of Sale)
 * render as decorative chips/toggles for now — wire them when BE supports it.
 */

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function renderProductNewForm(
  base: string,
  csrfField: string,
  categories: Array<{ id: string; name: string }> = [],
  flash: { type: 'error' | 'success'; message: string } | null = null,
): string {
  const categoryOptions = categories.length === 0
    ? '<option value="" disabled>No categories — create one in Products → Categories</option>'
    : categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')

  // Banner trên đầu form — khi handler redirect /products/new?error=... user
  // bí mất feedback → tưởng "không có gì xảy ra". Banner hiện rõ message.
  const flashHtml = flash
    ? `<div class="pn-flash pn-flash-${flash.type}" role="${flash.type === 'error' ? 'alert' : 'status'}">${esc(flash.message)}</div>`
    : ''
  return `
${PRODUCT_NEW_STYLE}
<div class="pn">
  <div class="pn-topbar">
    <a href="${base}/products" class="pn-back" title="Back to products">&larr;</a>
    <h1>Add product</h1>
  </div>

  ${flashHtml}
  <form method="POST" action="${base}/products" id="pn-form" enctype="multipart/form-data">
    ${csrfField}
    <div class="pn-grid">
      <!-- ───────── LEFT ───────── -->
      <div class="pn-main">
        <!-- Title -->
        <section class="pn-card">
          <div class="pn-field">
            <label class="pn-label">Title</label>
            <input type="text" name="title" required placeholder="Short sleeve t-shirt" class="pn-input"/>
          </div>
          <div class="pn-field">
            <label class="pn-label">Description</label>
            ${descriptionEditor()}
          </div>
        </section>

        <!-- Media — files attached to form, uploaded BE Shop S3 trước khi
             create product (atomic: skip files fail, không block create). -->
        <section class="pn-card">
          <h3 class="pn-section-title">Media</h3>
          <input type="file" name="media" id="pn-media-input" multiple accept="image/*,video/*" style="display:none"/>
          <div class="pn-dropzone" id="pn-dropzone">
            <div class="pn-dropzone-actions">
              <button type="button" class="pn-btn-light" id="pn-media-pick">Upload new</button>
            </div>
            <p class="pn-muted-sm" id="pn-media-status">Accepts images / videos. Max 10 files, 20MB each.</p>
            <div id="pn-media-preview" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px"></div>
          </div>
        </section>

        <!-- Category — BE REQUIRES categories array. BE đọc category.name (không
             phải id) để CheckExistsAndCreate. Hidden category_name sync từ
             selected option.text khi đổi select. -->
        <section class="pn-card">
          <div class="pn-field">
            <label class="pn-label">Category <code style="color:var(--s-danger)">*</code></label>
            <select class="pn-select" name="category_id" id="pn-category" required>
              <option value="">Choose a product category</option>
              ${categoryOptions}
            </select>
            <input type="hidden" name="category_name" id="pn-category-name" value=""/>
            <p class="pn-help">Required. BE uses category name to lookup-or-create.</p>
          </div>
        </section>

        <!-- Price -->
        <section class="pn-card">
          <div class="pn-field">
            <label class="pn-label">Price</label>
            <div class="pn-input-group">
              <span class="pn-prefix">$</span>
              <input type="number" name="price" required min="0" step="0.01" value="0" class="pn-input pn-input-with-prefix"/>
            </div>
          </div>
          <div class="pn-chip-row">
            ${chip('Compare at', 'pn-toggle-compare', `<input type="number" name="compare_at_price" min="0" step="0.01" placeholder="0.00" class="pn-input pn-input-sm"/>`)}
            ${chip('Unit price')}
            ${chip('Charge tax', null, null, 'Yes')}
            ${chip('Cost per item')}
          </div>
        </section>

        <!-- Inventory -->
        <section class="pn-card">
          <div class="pn-card-head">
            <h3 class="pn-section-title">Inventory</h3>
            <label class="pn-toggle">
              <input type="checkbox" name="inventory_tracked" value="1" checked/>
              <span class="pn-toggle-track"><span class="pn-toggle-knob"></span></span>
              <span class="pn-toggle-label">Inventory tracked</span>
            </label>
          </div>
          <div class="pn-qty-head"><span>Quantity</span><span>Quantity</span></div>
          <div class="pn-qty-row">
            <a href="#" class="pn-link">Shop location</a>
            <input type="number" name="inventory_quantity" min="0" value="0" class="pn-input pn-input-sm pn-input-right"/>
          </div>
          <div class="pn-chip-row">
            ${chip('SKU', null, `<input type="text" name="sku" placeholder="" class="pn-input pn-input-sm"/>`)}
            ${chip('Barcode')}
            ${chip('Sell when out of stock', null, null, 'Off')}
          </div>
        </section>

        <!-- Shipping -->
        <section class="pn-card">
          <div class="pn-card-head">
            <h3 class="pn-section-title">Shipping</h3>
            <label class="pn-toggle">
              <input type="checkbox" name="physical_product" value="1" checked/>
              <span class="pn-toggle-track"><span class="pn-toggle-knob"></span></span>
              <span class="pn-toggle-label">Physical product</span>
            </label>
          </div>
          <div class="pn-row-2">
            <div class="pn-field">
              <div class="pn-package">
                <span class="pn-pkg-icon">📦</span>
                <div class="pn-pkg-text">
                  <strong>Store default</strong> · Sample box · 22 × 13.7 × 4.2 cm, 0 kg
                </div>
                <span class="pn-chev">▾</span>
              </div>
            </div>
            <div class="pn-field">
              <label class="pn-label">Product weight</label>
              <div class="pn-input-group pn-input-suffix-group">
                <input type="number" name="weight" min="0" step="0.1" value="0.0" class="pn-input"/>
                <select class="pn-suffix-select"><option>kg</option><option>g</option><option>lb</option></select>
              </div>
            </div>
          </div>
          <div class="pn-chip-row">
            ${chip('Country of origin')}
            ${chip('HS Code')}
          </div>
        </section>

        <!-- Variants — quick-pick templates (Size, Color, Type) + Custom.
             Mỗi option block: editable name + chip list values (click X xóa,
             input Add value để thêm). State sync vào hidden options_json. -->
        <section class="pn-card">
          <h3 class="pn-section-title">Variants</h3>
          <div id="pn-options-list"></div>
          <div class="pn-variants-actions">
            <button type="button" class="pn-add-row pn-add-row-sm" data-template="size"><span class="pn-plus">+</span> Size</button>
            <button type="button" class="pn-add-row pn-add-row-sm" data-template="color"><span class="pn-plus">+</span> Color</button>
            <button type="button" class="pn-add-row pn-add-row-sm" data-template="type"><span class="pn-plus">+</span> Type</button>
            <button type="button" class="pn-add-row pn-add-row-sm" data-template="custom"><span class="pn-plus">+</span> Custom option</button>
          </div>
          <input type="hidden" name="options_json" id="pn-options-json" value="[]"/>
        </section>

        <!-- Search engine listing -->
        <section class="pn-card">
          <div class="pn-card-head">
            <h3 class="pn-section-title">Search engine listing</h3>
            <button type="button" class="pn-icon-btn" title="Edit">✎</button>
          </div>
          <p class="pn-help">Add a title and description to see how this product might appear in a search engine listing</p>
        </section>
      </div>

      <!-- ───────── RIGHT ───────── -->
      <aside class="pn-side">
        <section class="pn-card">
          <div class="pn-field">
            <label class="pn-label">Status</label>
            <select name="status" class="pn-select">
              <option value="active" selected>Active</option>
              <option value="draft">Draft</option>
            </select>
          </div>
        </section>

        <section class="pn-card">
          <div class="pn-card-head">
            <h3 class="pn-section-title">Publishing</h3>
            <button type="button" class="pn-icon-btn" title="Settings">⚙</button>
          </div>
          <div class="pn-pill-row">
            <span class="pn-pill"><span class="pn-pill-dot">🛒</span> Online Store</span>
            <span class="pn-pill"><span class="pn-pill-dot">📍</span> Point of Sale</span>
          </div>
        </section>

        <section class="pn-card">
          <h3 class="pn-section-title">Product organization <span class="pn-info">ⓘ</span></h3>
          <div class="pn-field">
            <label class="pn-label">Type</label>
            <select name="product_type" class="pn-select"><option value="">None</option></select>
          </div>
          <div class="pn-field">
            <label class="pn-label">Vendor</label>
            <select name="vendor" class="pn-select"><option value="">None</option></select>
          </div>
          <div class="pn-field">
            <label class="pn-label">Collections</label>
            <button type="button" class="pn-add-row pn-add-row-sm">
              <span class="pn-plus">+</span> Add collections
            </button>
          </div>
          <div class="pn-field">
            <label class="pn-label">Tags</label>
            <button type="button" class="pn-add-row pn-add-row-sm">
              <span class="pn-plus">+</span> Add tags
            </button>
            <input type="hidden" name="tags" value=""/>
          </div>
        </section>

        <section class="pn-card">
          <div class="pn-field">
            <label class="pn-label">Theme template</label>
            <select name="theme_template" class="pn-select">
              <option>Default product</option>
            </select>
          </div>
        </section>
      </aside>
    </div>

    <div class="pn-footer">
      <button type="submit" class="pn-btn-primary" id="pn-save" disabled>Save</button>
    </div>
  </form>
</div>
${PRODUCT_NEW_SCRIPT}
`
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function chip(label: string, dataAttr: string | null = null, expandedHTML: string | null = null, valueRight: string | null = null): string {
  const attr = dataAttr ? ` data-chip="${dataAttr}"` : ''
  const right = valueRight ? `<span class="pn-chip-val">${valueRight}</span>` : ''
  const expanded = expandedHTML ? `<div class="pn-chip-expand">${expandedHTML}</div>` : ''
  return `<div class="pn-chip-wrap">
    <button type="button" class="pn-chip"${attr}>
      <span class="pn-chip-label">${label}</span>${right}
    </button>
    ${expanded}
  </div>`
}

function descriptionEditor(): string {
  // Visual toolbar only — textarea stores the value
  const tools = [
    { sel: true, label: 'Paragraph' },
    { txt: 'B', bold: true },
    { txt: 'I', italic: true },
    { txt: 'U', underline: true },
    { txt: 'A' },
    { txt: '☰' },
    { txt: '⋮⋮' },
    { txt: '🔗' },
    { txt: '🖼' },
    { txt: '⊞' },
    { txt: '…' },
    { txt: '</>' },
  ]
  const buttons = tools.map(t => {
    if (t.sel) return `<select class="pn-edt-sel"><option>${t.label}</option></select>`
    let style = ''
    if (t.bold) style = 'font-weight:700'
    if (t.italic) style = 'font-style:italic'
    if (t.underline) style = 'text-decoration:underline'
    return `<button type="button" class="pn-edt-btn" style="${style}">${t.txt}</button>`
  }).join('')
  return `<div class="pn-editor">
    <div class="pn-edt-bar">${buttons}</div>
    <textarea name="body_html" class="pn-edt-area" rows="6"></textarea>
  </div>`
}

// ─────────────────────────────────────────────
// Style — scoped under .pn
// ─────────────────────────────────────────────

const PRODUCT_NEW_STYLE = `<style>
/* Scoped to .pn — uses system --s-* tokens so it inherits dark/light theme */
.pn { color:var(--s-text); font-size:14px; max-width:900px; margin:0 auto; padding-bottom:80px; }
.pn-topbar { display:flex; align-items:center; gap:12px; padding:12px 4px 16px; }
.pn-topbar h1 { font-size:18px; font-weight:600; margin:0; color:var(--s-text); }
.pn-back { color:var(--s-text-muted); text-decoration:none; font-size:18px; padding:4px 8px; border-radius:6px; }
.pn-back:hover { background:var(--s-card-hover); color:var(--s-text); }
.pn-grid { display:grid; grid-template-columns:1fr 320px; gap:16px; align-items:start; }
@media (max-width: 1100px) { .pn-grid { grid-template-columns:1fr; } }
.pn-main, .pn-side { display:flex; flex-direction:column; gap:14px; }

.pn-card { background:var(--s-card); border:1px solid var(--s-border); border-radius:12px; padding:16px; box-shadow:var(--s-shadow); }
.pn-card-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; gap:12px; }
.pn-section-title { font-size:13px; font-weight:600; margin:0 0 12px; color:var(--s-text); }
.pn-card-head .pn-section-title { margin-bottom:0; }

.pn-field { margin-bottom:12px; }
.pn-field:last-child { margin-bottom:0; }
.pn-label { display:block; font-size:12px; font-weight:500; color:var(--s-text-muted); margin-bottom:6px; }
.pn-help { font-size:12px; color:var(--s-text-dim); margin:6px 0 0; line-height:1.4; }
.pn-muted-sm { font-size:12px; color:var(--s-text-muted); margin:8px 0 0; }

.pn-input, .pn-select { width:100%; padding:8px 12px; border:1px solid var(--s-input-border); border-radius:8px; font-size:14px; font-family:inherit; background:var(--s-input-bg); color:var(--s-text); outline:none; box-sizing:border-box; }
.pn-input:focus, .pn-select:focus { border-color:var(--s-accent); box-shadow:0 0 0 3px color-mix(in srgb, var(--s-accent) 25%, transparent); }
.pn-input-sm { padding:6px 10px; font-size:13px; }
.pn-input-right { text-align:right; max-width:100px; }
.pn-input-group { position:relative; display:flex; align-items:stretch; }
.pn-prefix { position:absolute; left:12px; top:50%; transform:translateY(-50%); color:var(--s-text-muted); font-size:14px; pointer-events:none; }
.pn-input-with-prefix { padding-left:26px; max-width:200px; }
.pn-input-suffix-group .pn-input { border-top-right-radius:0; border-bottom-right-radius:0; max-width:120px; }
.pn-suffix-select { border:1px solid var(--s-input-border); border-left:none; border-top-right-radius:8px; border-bottom-right-radius:8px; padding:0 8px; background:var(--s-input-bg); color:var(--s-text); font-size:13px; cursor:pointer; }

.pn-row-2 { display:grid; grid-template-columns:1fr 200px; gap:12px; align-items:end; margin-bottom:8px; }

/* Editor */
.pn-editor { border:1px solid var(--s-input-border); border-radius:8px; overflow:hidden; background:var(--s-input-bg); }
.pn-edt-bar { display:flex; flex-wrap:wrap; gap:2px; padding:4px 6px; border-bottom:1px solid var(--s-border); background:var(--s-card-hover); }
.pn-edt-sel { font-size:12px; padding:2px 6px; border:1px solid transparent; background:transparent; color:var(--s-text); cursor:pointer; }
.pn-edt-btn { width:28px; height:28px; border:none; background:transparent; cursor:pointer; border-radius:4px; font-size:13px; color:var(--s-text); }
.pn-edt-btn:hover { background:var(--s-border); }
.pn-edt-area { width:100%; min-height:140px; padding:12px; border:none; outline:none; resize:vertical; font-family:inherit; font-size:14px; background:var(--s-input-bg); color:var(--s-text); box-sizing:border-box; }

/* Dropzone */
.pn-dropzone { border:1.5px dashed var(--s-border-light); border-radius:10px; padding:24px; text-align:center; background:var(--s-input-bg); }
.pn-dropzone-actions { display:flex; gap:10px; justify-content:center; align-items:center; }
.pn-btn-light { background:var(--s-card); border:1px solid var(--s-border-light); padding:7px 14px; border-radius:8px; font-size:13px; cursor:pointer; color:var(--s-text); }
.pn-btn-light:hover { background:var(--s-card-hover); }
.pn-link { background:none; border:none; color:var(--s-accent); cursor:pointer; font-size:13px; padding:0; }
.pn-link:hover { color:var(--s-accent-hover); text-decoration:underline; }

/* Chips (expandable) */
.pn-chip-row { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
.pn-chip-wrap { display:inline-flex; flex-direction:column; }
.pn-chip { display:inline-flex; align-items:center; gap:6px; background:var(--s-card-hover); border:1px solid var(--s-border); padding:6px 12px; border-radius:999px; font-size:13px; cursor:pointer; color:var(--s-text); font-family:inherit; }
.pn-chip:hover { background:var(--s-hover); border-color:var(--s-border-light); }
.pn-chip-val { color:var(--s-text-muted); font-size:12px; }
.pn-chip-expand { display:none; padding:8px 0 0; }
.pn-chip-wrap.open .pn-chip { background:var(--s-hover); border-color:var(--s-accent); }
.pn-chip-wrap.open .pn-chip-expand { display:block; }

/* Toggle switch */
.pn-toggle { display:inline-flex; align-items:center; gap:8px; cursor:pointer; user-select:none; }
.pn-toggle input { position:absolute; opacity:0; pointer-events:none; }
.pn-toggle-track { width:34px; height:20px; background:var(--s-border-light); border-radius:999px; position:relative; transition:background .15s; flex-shrink:0; }
.pn-toggle-knob { position:absolute; top:2px; left:2px; width:16px; height:16px; background:#fff; border-radius:50%; transition:left .15s; box-shadow:0 1px 2px rgba(0,0,0,.3); }
.pn-toggle input:checked + .pn-toggle-track { background:var(--s-accent); }
.pn-toggle input:checked + .pn-toggle-track .pn-toggle-knob { left:16px; }
.pn-toggle-label { font-size:12px; color:var(--s-text-muted); font-weight:500; }

/* Inventory rows */
.pn-qty-head { display:flex; justify-content:space-between; padding:6px 0; font-size:11px; color:var(--s-text-dim); border-bottom:1px solid var(--s-border); }
.pn-qty-row { display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid var(--s-border); }
.pn-qty-row:last-child { border-bottom:none; }

/* Shipping package selector */
.pn-package { display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--s-border); border-radius:8px; background:var(--s-input-bg); cursor:pointer; }
.pn-package:hover { background:var(--s-card-hover); border-color:var(--s-border-light); }
.pn-pkg-icon { font-size:18px; }
.pn-pkg-text { flex:1; font-size:13px; color:var(--s-text); }
.pn-chev { color:var(--s-text-muted); }

/* Add row buttons */
.pn-add-row { display:inline-flex; align-items:center; gap:6px; background:var(--s-card-hover); border:1px solid var(--s-border); padding:8px 14px; border-radius:8px; font-size:13px; cursor:pointer; color:var(--s-text); font-family:inherit; }
.pn-add-row:hover { background:var(--s-hover); border-color:var(--s-border-light); }
.pn-add-row-sm { font-size:12px; padding:6px 12px; }
.pn-plus { color:var(--s-text-muted); font-weight:600; }

/* Flash banner trên top form */
.pn-flash { padding:11px 14px; border-radius:8px; margin-bottom:14px; font-size:13.5px; line-height:1.4; }
.pn-flash-error   { background:rgba(239,68,68,.1); border:1px solid rgba(239,68,68,.25); color:#fca5a5; }
.pn-flash-success { background:rgba(34,197,94,.1); border:1px solid rgba(34,197,94,.25); color:#86efac; }

/* Variant option blocks */
.pn-variants-actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
.pn-variant-opt { background:var(--s-card-hover); border:1px solid var(--s-border); border-radius:8px; padding:10px 12px; margin-bottom:8px; }
.pn-variant-opt-head { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
.pn-variant-opt-name { flex:1; padding:6px 10px; border:1px solid var(--s-input-border); border-radius:6px; background:var(--s-input-bg); color:var(--s-text); font-size:13px; outline:none; }
.pn-variant-opt-name:focus { border-color:var(--s-accent); }
.pn-variant-opt-remove { background:none; border:none; color:var(--s-text-muted); font-size:18px; cursor:pointer; padding:4px 8px; border-radius:4px; line-height:1; }
.pn-variant-opt-remove:hover { background:rgba(239,68,68,.12); color:var(--s-danger); }
.pn-variant-values { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.pn-variant-chip { background:var(--s-card); border:1px solid var(--s-border); padding:4px 10px; border-radius:14px; font-size:12px; cursor:pointer; display:inline-flex; align-items:center; gap:6px; color:var(--s-text); user-select:none; }
.pn-variant-chip:hover { border-color:var(--s-accent); }
.pn-variant-chip-x { color:var(--s-text-muted); font-weight:600; font-size:14px; line-height:1; }
.pn-variant-chip:hover .pn-variant-chip-x { color:var(--s-danger); }
.pn-variant-add-input { padding:4px 10px; border:1px dashed var(--s-border-light); border-radius:14px; background:transparent; font-size:12px; color:var(--s-text); outline:none; min-width:140px; }
.pn-variant-add-input:focus { border-color:var(--s-accent); border-style:solid; }

/* Pills (Publishing) */
.pn-pill-row { display:flex; flex-wrap:wrap; gap:8px; }
.pn-pill { display:inline-flex; align-items:center; gap:6px; background:var(--s-card-hover); border:1px solid var(--s-border); padding:6px 12px; border-radius:999px; font-size:13px; color:var(--s-text); }
.pn-pill-dot { font-size:12px; }

/* Misc */
.pn-info { color:var(--s-text-muted); font-size:12px; }
.pn-icon-btn { background:none; border:none; cursor:pointer; color:var(--s-text-muted); font-size:14px; padding:4px 6px; border-radius:4px; }
.pn-icon-btn:hover { background:var(--s-card-hover); color:var(--s-text); }

/* Footer (sticky save) */
.pn-footer { position:sticky; bottom:0; display:flex; justify-content:flex-end; padding:12px 0; margin-top:16px; background:linear-gradient(to top, var(--s-bg) 60%, transparent); }
.pn-btn-primary { background:var(--s-accent); color:#fff; border:none; padding:9px 22px; border-radius:8px; font-size:13px; font-weight:500; cursor:pointer; min-width:80px; font-family:inherit; transition:background .15s; }
.pn-btn-primary:hover:not(:disabled) { background:var(--s-accent-hover); }
.pn-btn-primary:disabled { background:var(--s-border-light); color:var(--s-text-dim); cursor:not-allowed; opacity:.7; }
</style>`

// ─────────────────────────────────────────────
// Behavior — chip expand + enable Save when title filled
// ─────────────────────────────────────────────

const PRODUCT_NEW_SCRIPT = `<script>
(function(){
  // Chip expand/collapse on click. Pre-existing bug: chips không có
  // expandedHTML không render '.pn-chip-expand' div → querySelector null →
  // .children.length throw TypeError → script abort → media picker handler
  // bên dưới không bao giờ bind. Null-guard fix.
  document.querySelectorAll('.pn-chip-wrap .pn-chip').forEach(function(btn){
    var wrap = btn.parentElement;
    if (!wrap) return;
    var expand = wrap.querySelector('.pn-chip-expand');
    if (!expand || !expand.children.length) return;
    btn.addEventListener('click', function(){ wrap.classList.toggle('open'); });
  });
  // Enable Save when title has value
  var form = document.getElementById('pn-form');
  var save = document.getElementById('pn-save');
  var title = form && form.querySelector('input[name="title"]');
  function refresh(){ if (save && title) save.disabled = !title.value.trim(); }
  if (title) { title.addEventListener('input', refresh); refresh(); }

  // ─── Category — sync hidden category_name từ selected option text ───
  var catSel = document.getElementById('pn-category');
  var catNameHidden = document.getElementById('pn-category-name');
  function syncCatName(){
    if (!catSel || !catNameHidden) return;
    var opt = catSel.selectedOptions && catSel.selectedOptions[0];
    catNameHidden.value = (opt && opt.value) ? (opt.text || '') : '';
  }
  if (catSel) {
    catSel.addEventListener('change', syncCatName);
    syncCatName();
  }

  // ─── Variants — template buttons + chip editor ───
  var TEMPLATES = {
    size:   { name: 'Size',  values: ['S','M','L','XL','2XL','3XL','4XL','5XL'] },
    color:  { name: 'Color', values: ['Black','White','Red','Navy','Heather Gray'] },
    type:   { name: 'Type',  values: ['T-shirt','Hoodie','Sweatshirt'] },
    custom: { name: '',      values: [] }
  };
  var optsState = [];
  var optsList = document.getElementById('pn-options-list');
  var optsJson = document.getElementById('pn-options-json');
  function escHtml(s){ return String(s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  function syncJson(){
    if (!optsJson) return;
    optsJson.value = JSON.stringify(optsState
      .map(function(o){ return { name: (o.name || '').trim(), values: o.values.slice() }; })
      .filter(function(o){ return o.name && o.values.length > 0; }));
  }
  function renderOpts(){
    if (!optsList) return;
    optsList.innerHTML = '';
    optsState.forEach(function(opt, idx){
      var chips = opt.values.map(function(v, vi){
        return '<span class="pn-variant-chip" data-idx="'+idx+'" data-vi="'+vi+'">'+escHtml(v)+'<span class="pn-variant-chip-x">×</span></span>';
      }).join('');
      var div = document.createElement('div');
      div.className = 'pn-variant-opt';
      div.innerHTML =
        '<div class="pn-variant-opt-head">'
        + '<input type="text" class="pn-variant-opt-name" placeholder="Option name" value="'+escHtml(opt.name)+'" data-idx="'+idx+'" />'
        + '<button type="button" class="pn-variant-opt-remove" data-idx="'+idx+'" aria-label="Remove option">×</button>'
        + '</div>'
        + '<div class="pn-variant-values">'
        + chips
        + '<input type="text" class="pn-variant-add-input" placeholder="Add value, press Enter" data-idx="'+idx+'" />'
        + '</div>';
      optsList.appendChild(div);
    });
    syncJson();
  }
  document.querySelectorAll('[data-template]').forEach(function(b){
    b.addEventListener('click', function(){
      var t = b.getAttribute('data-template');
      var tpl = TEMPLATES[t] || TEMPLATES.custom;
      optsState.push({ name: tpl.name, values: tpl.values.slice() });
      renderOpts();
    });
  });
  if (optsList) {
    optsList.addEventListener('click', function(e){
      var chip = e.target.closest('.pn-variant-chip');
      if (chip) {
        var idx = +chip.getAttribute('data-idx');
        var vi = +chip.getAttribute('data-vi');
        optsState[idx].values.splice(vi, 1);
        renderOpts();
        return;
      }
      var rm = e.target.closest('.pn-variant-opt-remove');
      if (rm) {
        var ridx = +rm.getAttribute('data-idx');
        optsState.splice(ridx, 1);
        renderOpts();
      }
    });
    optsList.addEventListener('input', function(e){
      if (e.target.classList.contains('pn-variant-opt-name')) {
        var ni = +e.target.getAttribute('data-idx');
        optsState[ni].name = e.target.value;
        syncJson();
      }
    });
    optsList.addEventListener('keydown', function(e){
      if (e.key === 'Enter' && e.target.classList.contains('pn-variant-add-input')) {
        e.preventDefault();
        var v = e.target.value.trim();
        if (!v) return;
        var ai = +e.target.getAttribute('data-idx');
        if (optsState[ai].values.indexOf(v) === -1) optsState[ai].values.push(v);
        renderOpts();
      }
    });
  }

  // Media picker — open file dialog + render preview thumbs / file names
  var pick = document.getElementById('pn-media-pick');
  var input = document.getElementById('pn-media-input');
  var preview = document.getElementById('pn-media-preview');
  var status = document.getElementById('pn-media-status');
  if (pick && input) {
    pick.addEventListener('click', function(){ input.click(); });
    input.addEventListener('change', function(){
      var files = Array.prototype.slice.call(input.files || []);
      if (preview) preview.innerHTML = '';
      if (files.length === 0) {
        if (status) status.textContent = 'Accepts images / videos. Max 10 files, 20MB each.';
        return;
      }
      if (status) status.textContent = files.length + ' file(s) selected — will upload on Save';
      files.forEach(function(f){
        var el;
        if (f.type && f.type.indexOf('image/') === 0) {
          el = document.createElement('img');
          el.src = URL.createObjectURL(f);
          el.style.cssText = 'width:80px;height:80px;border-radius:6px;object-fit:cover;border:1px solid var(--s-border)';
        } else {
          el = document.createElement('div');
          el.style.cssText = 'width:80px;height:80px;border-radius:6px;background:var(--s-card-hover);border:1px solid var(--s-border);display:flex;align-items:center;justify-content:center;text-align:center;font-size:11px;padding:4px;color:var(--s-text-muted);overflow:hidden';
          el.textContent = f.name;
        }
        if (preview) preview.appendChild(el);
      });
    });
  }
})();
</script>`
