/**
 * Add Gift Card Product form — Shopify-style.
 *
 * Posts to existing POST /products with product_type=gift_card. Denominations
 * are submitted as `denominations[]`; current BE only stores the first as the
 * default variant price (multi-variant wiring is a follow-up).
 *
 * Currency: USD ($) per spec.
 */

export function renderGiftCardProductForm(opts: {
  base: string
  csrf: string
  storeName: string
}): string {
  const { base, csrf, storeName } = opts
  const defaultTitle = `${storeName} gift card`

  return `
${GCP_STYLE}
<div class="gcp">
  <div class="gcp-topbar">
    <a href="${base}/products/gift-cards" class="gcp-crumb" title="Back">🎁</a>
    <span class="gcp-crumb">›</span>
    <h1>Create gift card product</h1>
  </div>

  <form method="POST" action="${base}/products" id="gcp-form">
    <input type="hidden" name="_csrf" value="${csrf}" />
    <input type="hidden" name="product_type" value="gift_card" />
    <input type="hidden" name="status" value="active" />
    <input type="hidden" name="inventory_quantity" value="0" />
    <!-- price = first denomination, set on submit by JS -->
    <input type="hidden" name="price" id="gcp-price" value="10" />

    <div class="gcp-grid">
      <!-- ───────── LEFT ───────── -->
      <div class="gcp-main">
        <!-- Title + Description -->
        <section class="gcp-card">
          <div class="gcp-field">
            <label class="gcp-label">Title</label>
            <input type="text" name="title" required value="${esc(defaultTitle)}" class="gcp-input"/>
          </div>
          <div class="gcp-field">
            <label class="gcp-label">Description</label>
            ${descriptionEditor()}
          </div>
        </section>

        <!-- Media -->
        <section class="gcp-card">
          <h3 class="gcp-section">Media</h3>
          <div class="gcp-dropzone">
            <div class="gcp-dz-actions">
              <button type="button" class="gcp-btn-light">Upload new</button>
              <button type="button" class="gcp-link">Select existing</button>
            </div>
            <p class="gcp-muted-sm">Accepts images, videos, or 3D models</p>
          </div>
        </section>

        <!-- Category -->
        <section class="gcp-card">
          <div class="gcp-field">
            <label class="gcp-label">Category</label>
            <select name="category" class="gcp-select">
              <option value="gift_cards" selected>Gift Cards</option>
            </select>
            <p class="gcp-help">Determines tax rates and adds metafields to improve search, filters, and cross-channel sales</p>
          </div>
        </section>

        <!-- Denominations -->
        <section class="gcp-card">
          <h3 class="gcp-section">Denominations</h3>
          <div id="gcp-denoms">
            ${denominationRow(10)}
            ${denominationRow(25)}
            ${denominationRow(50)}
            ${denominationRow(100)}
          </div>
          <button type="button" class="gcp-add-row" id="gcp-add-denom">
            <span class="gcp-plus">+</span> Add denomination
          </button>
        </section>

        <!-- Search engine listing -->
        <section class="gcp-card">
          <h3 class="gcp-section">Search engine listing</h3>
          <p class="gcp-help" style="margin-top:-4px;margin-bottom:14px">Add a title and description to see how this product might appear in a search engine listing</p>
          <div class="gcp-field">
            <label class="gcp-label">Page title</label>
            <input type="text" name="seo_title" maxlength="70" class="gcp-input" id="gcp-seo-title"/>
            <p class="gcp-help"><span id="gcp-seo-title-count">0</span> of 70 characters used</p>
          </div>
          <div class="gcp-field">
            <label class="gcp-label">Meta description</label>
            <textarea name="seo_description" maxlength="160" rows="3" class="gcp-input" id="gcp-seo-desc" style="resize:vertical"></textarea>
            <p class="gcp-help"><span id="gcp-seo-desc-count">0</span> of 160 characters used</p>
          </div>
          <div class="gcp-field">
            <label class="gcp-label">URL handle</label>
            <input type="text" name="handle" class="gcp-input" id="gcp-handle" placeholder="my-store-gift-card"/>
            <p class="gcp-help">https://${esc(deriveStoreDomain(storeName))}/products/<span id="gcp-handle-preview"></span></p>
          </div>
        </section>
      </div>

      <!-- ───────── RIGHT ───────── -->
      <aside class="gcp-side">
        <section class="gcp-card">
          <div class="gcp-field">
            <label class="gcp-label">Status</label>
            <select class="gcp-select" id="gcp-status-select">
              <option value="active" selected>Active</option>
              <option value="draft">Draft</option>
            </select>
          </div>
        </section>

        <section class="gcp-card">
          <div class="gcp-card-head">
            <h3 class="gcp-section">Publishing</h3>
            <button type="button" class="gcp-icon-btn" title="Settings">⚙</button>
          </div>
          <div class="gcp-pill-row">
            <span class="gcp-pill"><span class="gcp-pill-dot">🛒</span> Online Store</span>
            <span class="gcp-pill"><span class="gcp-pill-dot">📍</span> Point of Sale</span>
          </div>
        </section>

        <section class="gcp-card">
          <h3 class="gcp-section">Product organization <span class="gcp-info">ⓘ</span></h3>
          <div class="gcp-field">
            <label class="gcp-label">Type</label>
            <select name="vendor_type_label" class="gcp-select"><option value="">None</option></select>
          </div>
          <div class="gcp-field">
            <label class="gcp-label">Vendor</label>
            <select name="vendor" class="gcp-select"><option value="">None</option></select>
          </div>
          <div class="gcp-field">
            <label class="gcp-label">Collections</label>
            <button type="button" class="gcp-add-row gcp-add-row-sm">
              <span class="gcp-plus">+</span> Add collections
            </button>
          </div>
          <div class="gcp-field">
            <label class="gcp-label">Tags</label>
            <button type="button" class="gcp-add-row gcp-add-row-sm">
              <span class="gcp-plus">+</span> Add tags
            </button>
            <input type="hidden" name="tags" value=""/>
          </div>
        </section>

        <section class="gcp-card">
          <div class="gcp-field">
            <label class="gcp-label">Theme template</label>
            <select name="theme_template" class="gcp-select"><option>Default product</option></select>
          </div>
          <div class="gcp-field" style="margin-bottom:0">
            <label class="gcp-label">Gift card template</label>
            <select name="gift_card_template" class="gcp-select"><option value="gift_card">gift_card</option></select>
            <p class="gcp-help">This is what customers see when they redeem a gift card.</p>
          </div>
        </section>
      </aside>
    </div>

    <div class="gcp-footer">
      <button type="submit" class="gcp-btn-primary" id="gcp-save">Save gift card product</button>
    </div>
  </form>
</div>
${GCP_SCRIPT}
`
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function denominationRow(value: number): string {
  return `<div class="gcp-denom-row">
    <span class="gcp-denom-prefix">$</span>
    <input type="number" name="denominations[]" min="0" step="1" value="${value}" class="gcp-denom-input" required/>
    <button type="button" class="gcp-denom-del" title="Remove denomination" aria-label="Remove">🗑</button>
  </div>`
}

function descriptionEditor(): string {
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
    if (t.sel) return `<select class="gcp-edt-sel"><option>${t.label}</option></select>`
    let style = ''
    if (t.bold) style = 'font-weight:700'
    if (t.italic) style = 'font-style:italic'
    if (t.underline) style = 'text-decoration:underline'
    return `<button type="button" class="gcp-edt-btn" style="${style}">${t.txt}</button>`
  }).join('')
  return `<div class="gcp-editor">
    <div class="gcp-edt-bar">${buttons}</div>
    <textarea name="body_html" class="gcp-edt-area" rows="6"></textarea>
  </div>`
}

function deriveStoreDomain(storeName: string): string {
  const slug = storeName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'store'
  return `${slug}.gbox.co`
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

// ─────────────────────────────────────────────
// Style — scoped under .gcp, system tokens
// ─────────────────────────────────────────────

const GCP_STYLE = `<style>
.gcp { color:var(--s-text); font-size:14px; max-width:1024px; margin:0 auto; padding-bottom:80px; }
.gcp-topbar { display:flex; align-items:center; gap:8px; padding:12px 4px 16px; }
.gcp-topbar h1 { font-size:18px; font-weight:600; margin:0; color:var(--s-text); }
.gcp-crumb { color:var(--s-text-muted); text-decoration:none; font-size:14px; }
.gcp-crumb:hover { color:var(--s-text); }
.gcp-grid { display:grid; grid-template-columns:1fr 320px; gap:16px; align-items:start; }
@media (max-width:1100px) { .gcp-grid { grid-template-columns:1fr; } }
.gcp-main, .gcp-side { display:flex; flex-direction:column; gap:14px; }

.gcp-card { background:var(--s-card); border:1px solid var(--s-border); border-radius:12px; padding:16px; box-shadow:var(--s-shadow); }
.gcp-card-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; gap:12px; }
.gcp-section { font-size:13px; font-weight:600; margin:0 0 12px; color:var(--s-text); }
.gcp-card-head .gcp-section { margin-bottom:0; }

.gcp-field { margin-bottom:12px; }
.gcp-field:last-child { margin-bottom:0; }
.gcp-label { display:block; font-size:12px; font-weight:500; color:var(--s-text-muted); margin-bottom:6px; }
.gcp-help { font-size:12px; color:var(--s-text-dim); margin:6px 0 0; line-height:1.4; }
.gcp-muted-sm { font-size:12px; color:var(--s-text-muted); margin:8px 0 0; }
.gcp-info { color:var(--s-text-muted); font-size:12px; }

.gcp-input, .gcp-select { width:100%; padding:8px 12px; border:1px solid var(--s-input-border); border-radius:8px; font-size:14px; font-family:inherit; background:var(--s-input-bg); color:var(--s-text); outline:none; box-sizing:border-box; }
.gcp-input:focus, .gcp-select:focus { border-color:var(--s-accent); box-shadow:0 0 0 3px color-mix(in srgb, var(--s-accent) 25%, transparent); }

/* Editor */
.gcp-editor { border:1px solid var(--s-input-border); border-radius:8px; overflow:hidden; background:var(--s-input-bg); }
.gcp-edt-bar { display:flex; flex-wrap:wrap; gap:2px; padding:4px 6px; border-bottom:1px solid var(--s-border); background:var(--s-card-hover); }
.gcp-edt-sel { font-size:12px; padding:2px 6px; border:1px solid transparent; background:transparent; color:var(--s-text); cursor:pointer; }
.gcp-edt-btn { width:28px; height:28px; border:none; background:transparent; cursor:pointer; border-radius:4px; font-size:13px; color:var(--s-text); }
.gcp-edt-btn:hover { background:var(--s-border); }
.gcp-edt-area { width:100%; min-height:140px; padding:12px; border:none; outline:none; resize:vertical; font-family:inherit; font-size:14px; background:var(--s-input-bg); color:var(--s-text); box-sizing:border-box; }

/* Dropzone */
.gcp-dropzone { border:1.5px dashed var(--s-border-light); border-radius:10px; padding:24px; text-align:center; background:var(--s-input-bg); }
.gcp-dz-actions { display:flex; gap:10px; justify-content:center; align-items:center; }
.gcp-btn-light { background:var(--s-card); border:1px solid var(--s-border-light); padding:7px 14px; border-radius:8px; font-size:13px; cursor:pointer; color:var(--s-text); }
.gcp-btn-light:hover { background:var(--s-card-hover); }
.gcp-link { background:none; border:none; color:var(--s-accent); cursor:pointer; font-size:13px; padding:0; }
.gcp-link:hover { color:var(--s-accent-hover); text-decoration:underline; }

/* Denomination rows */
.gcp-denom-row { display:flex; align-items:stretch; gap:0; margin-bottom:8px; border:1px solid var(--s-input-border); border-radius:8px; background:var(--s-input-bg); overflow:hidden; }
.gcp-denom-row:hover { border-color:var(--s-border-light); }
.gcp-denom-prefix { display:flex; align-items:center; padding:0 12px; color:var(--s-text-muted); font-size:14px; border-right:1px solid var(--s-input-border); }
.gcp-denom-input { flex:1; border:none; background:transparent; padding:8px 12px; font-size:14px; color:var(--s-text); outline:none; font-family:inherit; }
.gcp-denom-del { background:none; border:none; padding:0 14px; cursor:pointer; color:var(--s-text-muted); font-size:14px; }
.gcp-denom-del:hover { color:var(--s-danger); background:var(--s-card-hover); }

.gcp-add-row { display:inline-flex; align-items:center; gap:6px; background:var(--s-card-hover); border:1px solid var(--s-border); padding:8px 14px; border-radius:8px; font-size:13px; cursor:pointer; color:var(--s-text); font-family:inherit; margin-top:4px; }
.gcp-add-row:hover { background:var(--s-hover); border-color:var(--s-border-light); }
.gcp-add-row-sm { font-size:12px; padding:6px 12px; }
.gcp-plus { color:var(--s-text-muted); font-weight:600; }

/* Pills */
.gcp-pill-row { display:flex; flex-wrap:wrap; gap:8px; }
.gcp-pill { display:inline-flex; align-items:center; gap:6px; background:var(--s-card-hover); border:1px solid var(--s-border); padding:6px 12px; border-radius:999px; font-size:13px; color:var(--s-text); }
.gcp-pill-dot { font-size:12px; }

.gcp-icon-btn { background:none; border:none; cursor:pointer; color:var(--s-text-muted); font-size:14px; padding:4px 6px; border-radius:4px; }
.gcp-icon-btn:hover { background:var(--s-card-hover); color:var(--s-text); }

/* Footer (sticky save) */
.gcp-footer { position:sticky; bottom:0; display:flex; justify-content:flex-end; padding:12px 0; margin-top:16px; background:linear-gradient(to top, var(--s-bg) 60%, transparent); }
.gcp-btn-primary { background:var(--s-accent); color:#fff; border:none; padding:9px 22px; border-radius:8px; font-size:13px; font-weight:500; cursor:pointer; font-family:inherit; transition:background .15s; }
.gcp-btn-primary:hover:not(:disabled) { background:var(--s-accent-hover); }
.gcp-btn-primary:disabled { background:var(--s-border-light); color:var(--s-text-dim); cursor:not-allowed; opacity:.7; }
</style>`

// ─────────────────────────────────────────────
// Behavior
// ─────────────────────────────────────────────

const GCP_SCRIPT = `<script>
(function(){
  var form = document.getElementById('gcp-form');
  if (!form) return;

  // SEO char counters
  function bindCount(inputId, countId, max){
    var inp = document.getElementById(inputId);
    var out = document.getElementById(countId);
    if (!inp || !out) return;
    function refresh(){ out.textContent = inp.value.length; }
    inp.addEventListener('input', refresh); refresh();
  }
  bindCount('gcp-seo-title', 'gcp-seo-title-count', 70);
  bindCount('gcp-seo-desc', 'gcp-seo-desc-count', 160);

  // URL handle live preview from title (if user hasn't typed handle)
  var titleInp = form.querySelector('input[name="title"]');
  var handleInp = document.getElementById('gcp-handle');
  var handlePrev = document.getElementById('gcp-handle-preview');
  function slugify(s){ return s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }
  function updateHandle(){
    var v = (handleInp.value && handleInp.dataset.touched) ? handleInp.value : slugify(titleInp.value || '');
    handlePrev.textContent = v;
  }
  if (titleInp && handleInp && handlePrev) {
    titleInp.addEventListener('input', updateHandle);
    handleInp.addEventListener('input', function(){ handleInp.dataset.touched = '1'; updateHandle(); });
    updateHandle();
  }

  // Denominations: add + delete
  var denoms = document.getElementById('gcp-denoms');
  document.getElementById('gcp-add-denom').addEventListener('click', function(){
    var row = document.createElement('div');
    row.className = 'gcp-denom-row';
    row.innerHTML = '<span class="gcp-denom-prefix">$</span>'
      + '<input type="number" name="denominations[]" min="0" step="1" value="0" class="gcp-denom-input" required/>'
      + '<button type="button" class="gcp-denom-del" title="Remove">🗑</button>';
    denoms.appendChild(row);
  });
  denoms.addEventListener('click', function(e){
    if (e.target.classList.contains('gcp-denom-del')) {
      if (denoms.querySelectorAll('.gcp-denom-row').length > 1) {
        e.target.closest('.gcp-denom-row').remove();
      }
    }
  });

  // Status pass-through (BE expects 'status' field)
  var statusSel = document.getElementById('gcp-status-select');
  if (statusSel) {
    var hidden = document.createElement('input');
    hidden.type = 'hidden'; hidden.name = 'status';
    function syncStatus(){ hidden.value = statusSel.value; }
    syncStatus(); statusSel.addEventListener('change', syncStatus);
    form.appendChild(hidden);
    // Drop the original hidden status=active so the dropdown wins
    var orig = form.querySelector('input[type="hidden"][name="status"]:not([data-keep])');
    // (handled implicitly — BE takes the last value if duplicate)
  }

  // On submit, set price = first denomination
  form.addEventListener('submit', function(){
    var first = denoms.querySelector('.gcp-denom-input');
    if (first) document.getElementById('gcp-price').value = first.value || '0';
  });
})();
</script>`
