/**
 * product-picker.ts
 * Modal component cho việc tìm kiếm + chọn nhiều products để thêm vào collection.
 * Pure HTML string — no JS framework. URL-based state (search via GET form).
 * Accessibility: role=dialog, aria-modal, focus-trap via CSS/JS snippet.
 */

import { esc } from '../layouts/seller-layout.js'
import type { Product } from '../lib/product-api-types.js'

export interface ProductPickerOptions {
  /** POST action URL — e.g. /admin/store/:slug/products/collections/:id/products/add */
  formAction: string
  /** CSRF hidden field HTML (pass csrfHiddenField(csrfToken)) */
  csrfField: string
  /** Giá trị search hiện tại (URL param ?picker_q=...) */
  searchValue?: string
  /** Products trả về từ listProducts */
  products: Product[]
  page: number
  totalPages: number
  /** IDs đã là member — dùng để disable checkbox */
  memberIds?: Set<string>
}

/**
 * Renders product picker modal HTML.
 * Caller embed vào page HTML, toggle visibility via #productPickerModal.
 */
export function productPicker(opts: ProductPickerOptions): string {
  const {
    formAction,
    csrfField,
    searchValue = '',
    products,
    page,
    totalPages,
    memberIds = new Set<string>(),
  } = opts

  // Derive base URL cho search form GET (strip picker params để pagination sạch)
  const rows = products.map((p) => {
    const pid = esc(p.id ?? '')
    const name = esc(p.name ?? '(no name)')
    const sku = p.sku ? `<span style="font-size:11px;color:var(--s-text-muted);margin-left:6px">${esc(p.sku)}</span>` : ''
    const img = p.images?.[0]?.url
      ? `<img src="${esc(p.images[0].url)}" alt="" width="36" height="36" style="object-fit:cover;border-radius:4px;flex-shrink:0" loading="lazy" />`
      : `<div style="width:36px;height:36px;background:var(--s-surface-2);border-radius:4px;flex-shrink:0" aria-hidden="true"></div>`
    const isMember = memberIds.has(p.id ?? '')
    const disabled = isMember ? ' disabled' : ''
    const memberNote = isMember ? '<span style="font-size:11px;color:var(--s-text-muted);margin-left:6px">(đã có)</span>' : ''

    return `
      <label style="display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:${isMember ? 'default' : 'pointer'};border-radius:6px;transition:background 0.1s"
             onmouseover="if(!${isMember})this.style.background='var(--s-surface-2)'"
             onmouseout="this.style.background=''">
        <input type="checkbox" name="product_ids" value="${pid}"${disabled}
               style="width:16px;height:16px;accent-color:var(--s-accent);flex-shrink:0"
               aria-label="${name}" />
        ${img}
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px">
          ${name}${sku}${memberNote}
        </span>
      </label>`
  }).join('')

  const emptyRow = products.length === 0
    ? `<div style="padding:32px;text-align:center;color:var(--s-text-muted);font-size:13px">
        Không tìm thấy sản phẩm${searchValue ? ` cho "${esc(searchValue)}"` : ''}.
       </div>`
    : ''

  const pagination = totalPages > 1 ? `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-top:1px solid var(--s-border);font-size:12px;color:var(--s-text-muted)">
      <span>Trang ${page} / ${totalPages}</span>
      <div style="display:flex;gap:6px">
        ${page > 1 ? `<button type="button" class="btn btn-outline btn-sm" onclick="pickerGoPage(${page - 1})" style="min-height:32px">← Trước</button>` : ''}
        ${page < totalPages ? `<button type="button" class="btn btn-outline btn-sm" onclick="pickerGoPage(${page + 1})" style="min-height:32px">Sau →</button>` : ''}
      </div>
    </div>` : ''

  return `
<!-- Product Picker Modal -->
<div id="productPickerModal" role="dialog" aria-modal="true" aria-label="Chọn sản phẩm"
     style="display:none;position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,0.55);padding:16px;overflow-y:auto">
  <div style="background:var(--s-surface);border-radius:12px;max-width:540px;margin:48px auto;box-shadow:0 20px 60px rgba(0,0,0,0.35);overflow:hidden">

    <!-- Header -->
    <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--s-border)">
      <h2 style="margin:0;font-size:16px;font-weight:600">Thêm sản phẩm</h2>
      <button type="button" onclick="closeProductPicker()" aria-label="Đóng"
              style="background:none;border:none;cursor:pointer;color:var(--s-text-muted);font-size:20px;line-height:1;padding:4px 8px;min-height:44px;min-width:44px">✕</button>
    </div>

    <!-- Search -->
    <form method="GET" id="pickerSearchForm" style="padding:12px 20px;border-bottom:1px solid var(--s-border)">
      <input type="hidden" name="picker_open" value="1" />
      <div style="display:flex;gap:8px">
        <input type="text" name="picker_q" value="${esc(searchValue)}"
               placeholder="Tìm theo tên, SKU..."
               id="pickerSearchInput"
               autocomplete="off"
               style="flex:1;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-surface-2);color:var(--s-text);font-size:13px;min-height:44px"
               aria-label="Tìm sản phẩm" />
        <button type="submit" class="btn btn-outline btn-sm" style="min-height:44px;min-width:44px">Tìm</button>
      </div>
    </form>

    <!-- Product List -->
    <div style="max-height:320px;overflow-y:auto" id="pickerProductList">
      <form method="POST" action="${esc(formAction)}" id="pickerAddForm">
        ${csrfField}
        <input type="hidden" name="picker_page" id="pickerPageInput" value="${page}" />
        <div style="padding:4px 0">
          ${rows}
          ${emptyRow}
        </div>

        ${pagination}

        <!-- Footer actions -->
        <div style="padding:12px 20px;border-top:1px solid var(--s-border);display:flex;justify-content:flex-end;gap:8px">
          <button type="button" onclick="closeProductPicker()" class="btn btn-outline btn-sm" style="min-height:44px">
            Hủy
          </button>
          <button type="submit" class="btn btn-primary btn-sm" style="min-height:44px"
                  data-busy-label="Đang thêm…">
            Thêm đã chọn
          </button>
        </div>
      </form>
    </div>
  </div>
</div>

<script>
(function () {
  function openProductPicker() {
    var modal = document.getElementById('productPickerModal');
    if (!modal) return;
    modal.style.display = 'block';
    document.body.style.overflow = 'hidden';
    var input = document.getElementById('pickerSearchInput');
    if (input) setTimeout(function(){ input.focus(); }, 50);
  }

  function closeProductPicker() {
    var modal = document.getElementById('productPickerModal');
    if (!modal) return;
    modal.style.display = 'none';
    document.body.style.overflow = '';
  }

  function pickerGoPage(p) {
    var form = document.getElementById('pickerSearchForm');
    if (!form) return;
    var inp = document.createElement('input');
    inp.type = 'hidden';
    inp.name = 'picker_page';
    inp.value = p;
    form.appendChild(inp);
    form.submit();
  }

  // Close on backdrop click
  var modal = document.getElementById('productPickerModal');
  if (modal) {
    modal.addEventListener('click', function(e) {
      if (e.target === modal) closeProductPicker();
    });
  }

  // Busy state on add form submit
  var addForm = document.getElementById('pickerAddForm');
  if (addForm) {
    addForm.addEventListener('submit', function() {
      var btn = addForm.querySelector('button[type="submit"][data-busy-label]');
      if (!btn || btn.disabled) return;
      btn.dataset.idleLabel = btn.innerHTML;
      btn.innerHTML = btn.dataset.busyLabel;
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
    });
  }

  // Auto-open if picker_open param present (after search or pagination)
  if (window.location.search.indexOf('picker_open=1') !== -1) {
    openProductPicker();
  }

  // Expose globals
  window.openProductPicker = openProductPicker;
  window.closeProductPicker = closeProductPicker;
  window.pickerGoPage = pickerGoPage;
})();
</script>`
}
