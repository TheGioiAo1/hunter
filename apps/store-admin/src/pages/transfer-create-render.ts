/**
 * transfer-create-render.ts
 * Render form tạo Transfer (move inventory giữa locations).
 * BE state: chưa có endpoint Transfer; form submit qua handler stub.
 *
 * Reuse picker với mode='variant-only' để user pick từng variant cần
 * chuyển — không add tất cả qua 1 click.
 */

import { esc } from '../layouts/seller-layout.js'
import { productPickerAssets } from '../components/purchase-order-product-picker.js'

export interface TransferLocation {
  id: string
  name: string
  is_primary?: boolean | null
}

export interface TransferFormData {
  formAction: string
  csrfField: string
  backHref: string
  productsSearchUrl: string
  locations: TransferLocation[]
  flashError?: string
  flashWarning?: string
  prefill?: {
    originLocationId?: string
    destinationLocationId?: string
    dateCreated?: string
    referenceName?: string
    tags?: string
    notes?: string
  }
}

export function renderTransferCreateForm(data: TransferFormData): string {
  const {
    formAction,
    csrfField,
    backHref,
    productsSearchUrl,
    locations,
    flashError,
    flashWarning,
    prefill = {},
  } = data

  const today = new Date().toISOString().slice(0, 10)
  const dateValue = prefill.dateCreated || today
  const refValue = prefill.referenceName ?? ''
  const tagsValue = prefill.tags ?? ''
  const notesValue = prefill.notes ?? ''

  const locationOptions = (selectedId: string | undefined) =>
    locations.length > 0
      ? `<option value="">Select…</option>` +
        locations
          .map((l) => `<option value="${esc(l.id)}"${selectedId === l.id ? ' selected' : ''}>${esc(l.name)}${l.is_primary ? ' (Primary)' : ''}</option>`)
          .join('')
      : '<option value="" disabled>No locations available</option>'

  const styles = `<style>
    .tr-page{max-width:1180px;margin:0 auto;padding:24px 20px}
    .tr-breadcrumb{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--gx-muted,#9aa0a6);margin-bottom:14px}
    .tr-breadcrumb a{color:var(--gx-muted,#9aa0a6);text-decoration:none;display:inline-flex;align-items:center;gap:6px}
    .tr-breadcrumb a:hover{color:var(--gx-text,#e8eaf0)}
    .tr-title{margin:0 0 22px;font-size:22px;font-weight:600;color:var(--gx-text,#e8eaf0);letter-spacing:-.01em}
    .tr-grid{display:grid;grid-template-columns:1.6fr 1fr;gap:14px}
    @media (max-width:880px){.tr-grid{grid-template-columns:1fr}}
    .tr-col{display:flex;flex-direction:column;gap:14px}
    .tr-card{background:var(--gx-surface,rgba(255,255,255,.02));border:1px solid var(--gx-border,rgba(255,255,255,.08));border-radius:12px;padding:18px 20px}
    .tr-card h2{margin:0 0 12px;font-size:13px;font-weight:600;color:var(--gx-text,#e8eaf0);display:flex;align-items:center;justify-content:space-between}
    .tr-info-icon{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:rgba(255,255,255,.08);color:var(--gx-muted);font-size:9px;font-weight:600;margin-left:5px;cursor:help;font-style:normal}
    .tr-2col{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    @media (max-width:540px){.tr-2col{grid-template-columns:1fr}}
    .tr-field{display:flex;flex-direction:column;gap:5px}
    .tr-label{font-size:12.5px;font-weight:500;color:var(--gx-muted,#9aa0a6);display:flex;align-items:center}
    .tr-input,.tr-select,.tr-textarea{width:100%;padding:8px 10px;background:var(--gx-bg,#13161c);border:1px solid var(--gx-border,rgba(255,255,255,.1));border-radius:7px;color:var(--gx-text,#e8eaf0);font-size:13.5px;box-sizing:border-box;outline:none;transition:.15s;font-family:inherit}
    .tr-input:focus,.tr-select:focus,.tr-textarea:focus{border-color:#5b6dff;box-shadow:0 0 0 3px rgba(91,109,255,.15)}
    .tr-textarea{resize:vertical;min-height:64px}
    .tr-products-row{display:flex;gap:10px;align-items:stretch}
    .tr-products-row .po-search{flex:1}
    .tr-btn-ghost{padding:8px 14px;border:1px solid var(--gx-border,rgba(255,255,255,.12));border-radius:7px;background:transparent;color:var(--gx-text,#e8eaf0);font-size:13px;cursor:pointer;white-space:nowrap}
    .tr-btn-ghost:hover{background:rgba(255,255,255,.04)}
    .tr-btn-icon{width:38px;display:inline-flex;align-items:center;justify-content:center;padding:8px}
    .tr-counter{font-size:11px;color:var(--gx-muted,#7a8089);text-align:right;margin-top:3px}
    .tr-notes-empty{font-size:13px;color:var(--gx-muted,#7a8089)}
    .tr-edit-btn{border:0;background:transparent;color:var(--gx-muted);cursor:pointer;padding:2px;border-radius:4px;display:inline-flex;align-items:center}
    .tr-edit-btn:hover{background:rgba(255,255,255,.06);color:var(--gx-text)}
    .tr-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}
    .tr-btn-primary{padding:9px 18px;border:0;border-radius:8px;background:linear-gradient(180deg,#5b6dff,#4854e0);color:#fff;font-size:13.5px;font-weight:600;cursor:pointer}
    .tr-btn-primary:hover{background:linear-gradient(180deg,#6577ff,#5260e8)}
    .tr-flash{padding:11px 14px;border-radius:8px;margin-bottom:14px;font-size:13.5px}
    .tr-flash-error{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);color:#fca5a5}
    .tr-flash-warn{background:rgba(234,179,8,.1);border:1px solid rgba(234,179,8,.25);color:#facc15}
    /* Reuse picker classes — picker styles come from productPickerAssets() */
    .po-empty-products{padding:14px;text-align:center;font-size:12.5px;color:var(--gx-muted,#7a8089);border:1px dashed var(--gx-border,rgba(255,255,255,.12));border-radius:8px;margin-top:12px}
    .po-empty-products{display:none}
  </style>`

  const flashHtml = flashError
    ? `<div class="tr-flash tr-flash-error" role="alert">${esc(flashError)}</div>`
    : flashWarning
      ? `<div class="tr-flash tr-flash-warn" role="status">${esc(flashWarning)}</div>`
      : ''

  // Inline notes textarea: simple single-state (no edit/view toggle to keep KISS).
  const notesCard = `
    <div class="tr-card">
      <h2>
        <span>Notes</span>
        <button type="button" class="tr-edit-btn" aria-label="Edit notes" title="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
      </h2>
      <textarea name="notes" class="tr-textarea" maxlength="2000" placeholder="No notes" rows="2">${esc(notesValue)}</textarea>
    </div>`

  const detailsCard = `
    <div class="tr-card">
      <h2>Transfer details</h2>
      <div class="tr-field" style="margin-bottom:12px">
        <label class="tr-label" for="tr-date">Date created</label>
        <input type="date" name="date_created" id="tr-date" class="tr-input" value="${esc(dateValue)}">
      </div>
      <div class="tr-field">
        <label class="tr-label" for="tr-ref">Reference name</label>
        <input type="text" name="reference_name" id="tr-ref" class="tr-input" maxlength="255" value="${esc(refValue)}">
        <div class="tr-counter"><span data-counter="reference_name">${refValue.length}</span>/255</div>
      </div>
    </div>`

  const tagsCard = `
    <div class="tr-card">
      <h2>Tags</h2>
      <input type="text" name="tags" class="tr-input" maxlength="40" placeholder="Comma-separated" value="${esc(tagsValue)}">
      <div class="tr-counter"><span data-counter="tags">${tagsValue.length}</span>/40</div>
    </div>`

  return `${styles}
  <div class="tr-page">
    <nav class="tr-breadcrumb">
      <a href="${esc(backHref)}" aria-label="Back to transfers">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
        Transfers
      </a>
    </nav>
    <h1 class="tr-title">Create transfer</h1>

    ${flashHtml}

    <form method="POST" action="${esc(formAction)}" novalidate>
      ${csrfField}
      <div class="tr-grid">
        <!-- LEFT column -->
        <div class="tr-col">
          <!-- Origin + Destination -->
          <div class="tr-card">
            <div class="tr-2col">
              <div class="tr-field">
                <label class="tr-label" for="tr-origin">Origin <i class="tr-info-icon" title="Where stock is moving from">i</i></label>
                <select name="origin_location_id" id="tr-origin" class="tr-select" required>
                  ${locationOptions(prefill.originLocationId)}
                </select>
              </div>
              <div class="tr-field">
                <label class="tr-label" for="tr-dest">Destination <i class="tr-info-icon" title="Where stock is moving to">i</i></label>
                <select name="destination_location_id" id="tr-dest" class="tr-select" required>
                  ${locationOptions(prefill.destinationLocationId)}
                </select>
              </div>
            </div>
          </div>

          <!-- Add products (variant-only picker) -->
          <div class="tr-card">
            <h2>Add products</h2>
            <div class="tr-products-row">
              <div class="po-search">
                <svg style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--gx-muted,#7a8089);pointer-events:none" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>
                <input type="search" class="tr-input po-search-input" placeholder="Search products" autocomplete="off" style="padding-left:34px">
                <div class="po-search-results" role="listbox"></div>
              </div>
              <button type="button" class="tr-btn-ghost po-browse-btn">Browse</button>
              <button type="button" class="tr-btn-ghost" disabled title="Coming soon">Import</button>
              <button type="button" class="tr-btn-ghost tr-btn-icon" disabled title="Scan barcode (coming soon)" aria-label="Scan barcode">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 5v14M7 5v14M11 5v14M15 5v14M19 5v14"/></svg>
              </button>
            </div>
            <div class="po-selected-products" role="list"></div>
            <div class="po-empty-products"></div>
          </div>
        </div>

        <!-- RIGHT column -->
        <div class="tr-col">
          ${notesCard}
          ${detailsCard}
          ${tagsCard}
        </div>
      </div>

      <div class="tr-actions">
        <a href="${esc(backHref)}" class="tr-btn-ghost">Cancel</a>
        <button type="submit" class="tr-btn-primary">Save</button>
      </div>
    </form>
  </div>
  ${productPickerAssets({ searchUrl: productsSearchUrl, mode: 'variant-only' })}
  <script>(function(){
    // Char counters
    document.querySelectorAll('input[name="reference_name"], input[name="tags"]').forEach(function(input){
      var name = input.getAttribute('name')
      var el = document.querySelector('[data-counter="'+name+'"]')
      if (!el) return
      input.addEventListener('input', function(){ el.textContent = String(input.value.length) })
    })
  })();</script>`
}
