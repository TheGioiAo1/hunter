/**
 * Orders Filter Sidebar — UI rendering
 *
 * Returns HTML for the slide-in filter panel (right drawer) with 24 sections.
 * Works purely from OrderFilters state + current store context.
 */

import type { OrderFilters } from './order-filters.js'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/* ------------------------------------------------------------------ */
/*  Section builders                                                  */
/* ------------------------------------------------------------------ */

interface CheckboxGroup {
  value: string
  label: string
}

function sectionWrap(title: string, body: string, open = true): string {
  return `
    <div class="flt-section${open ? ' open' : ''}">
      <button type="button" class="flt-section-head" onclick="this.parentElement.classList.toggle('open')">
        <span>${esc(title)}</span>
        <svg class="flt-chev" width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8l5 5 5-5"/></svg>
      </button>
      <div class="flt-section-body">${body}</div>
    </div>
  `
}

function checkboxGroup(name: string, options: CheckboxGroup[], selected: string[]): string {
  const items = options.map(o => `
    <label class="flt-check">
      <input type="checkbox" name="${esc(name)}" value="${esc(o.value)}"${selected.includes(o.value) ? ' checked' : ''}>
      <span>${esc(o.label)}</span>
    </label>
  `).join('')
  const clearLink = selected.length > 0
    ? `<button type="button" class="flt-clear" onclick="clearFilterGroup('${esc(name)}')">Clear</button>`
    : ''
  return items + clearLink
}

function textField(name: string, value: string, placeholder: string): string {
  return `
    <input type="text" name="${esc(name)}" value="${esc(value)}" placeholder="${esc(placeholder)}" class="flt-input">
    ${value ? `<button type="button" class="flt-clear" onclick="document.querySelector('[name=&quot;${esc(name)}&quot;]').value=''">Clear</button>` : ''}
  `
}

function yesNoRadio(name: string, value: string): string {
  return `
    <label class="flt-check"><input type="radio" name="${esc(name)}" value="yes"${value === 'yes' ? ' checked' : ''}><span>Yes</span></label>
    <label class="flt-check"><input type="radio" name="${esc(name)}" value="no"${value === 'no' ? ' checked' : ''}><span>No</span></label>
    ${value ? `<button type="button" class="flt-clear" onclick="document.querySelectorAll('[name=&quot;${esc(name)}&quot;]').forEach(e=>e.checked=false)">Clear</button>` : ''}
  `
}

function containsNot(nameHas: string, nameNot: string, valueHas: string, valueNot: string, placeholder: string): string {
  return `
    <label class="flt-field-label">Contains</label>
    <input type="text" name="${esc(nameHas)}" value="${esc(valueHas)}" placeholder="${esc(placeholder)}" class="flt-input">
    <label class="flt-field-label" style="margin-top:8px">Doesn't contain</label>
    <input type="text" name="${esc(nameNot)}" value="${esc(valueNot)}" placeholder="${esc(placeholder)}" class="flt-input">
    ${(valueHas || valueNot) ? `<button type="button" class="flt-clear" onclick="document.querySelector('[name=&quot;${esc(nameHas)}&quot;]').value='';document.querySelector('[name=&quot;${esc(nameNot)}&quot;]').value=''">Clear</button>` : ''}
  `
}

function dateRange(nameFrom: string, nameTo: string, valueFrom: string, valueTo: string): string {
  return `
    <div class="flt-daterange">
      <input type="date" name="${esc(nameFrom)}" value="${esc(valueFrom)}" class="flt-input">
      <span style="font-size:12px;color:var(--s-text-muted)">to</span>
      <input type="date" name="${esc(nameTo)}" value="${esc(valueTo)}" class="flt-input">
    </div>
    ${(valueFrom || valueTo) ? `<button type="button" class="flt-clear" onclick="document.querySelector('[name=&quot;${esc(nameFrom)}&quot;]').value='';document.querySelector('[name=&quot;${esc(nameTo)}&quot;]').value=''">Clear</button>` : ''}
  `
}

/* ------------------------------------------------------------------ */
/*  Country list (common subset)                                      */
/* ------------------------------------------------------------------ */

const COUNTRIES: Array<{ code: string; name: string }> = [
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'IT', name: 'Italy' },
  { code: 'ES', name: 'Spain' },
  { code: 'JP', name: 'Japan' },
  { code: 'VN', name: 'Vietnam' },
  { code: 'SG', name: 'Singapore' },
  { code: 'HK', name: 'Hong Kong' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'SE', name: 'Sweden' },
  { code: 'NO', name: 'Norway' },
  { code: 'DK', name: 'Denmark' },
  { code: 'FI', name: 'Finland' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'IE', name: 'Ireland' },
  { code: 'BE', name: 'Belgium' },
  { code: 'AT', name: 'Austria' },
  { code: 'CH', name: 'Switzerland' },
]

/* ------------------------------------------------------------------ */
/*  Main render                                                       */
/* ------------------------------------------------------------------ */

export interface RenderFilterPanelOpts {
  f: OrderFilters
  formAction: string
  preservedParams: Record<string, string>   // tab, q, field, per to keep on apply
}

export function renderFilterPanel({ f, formAction, preservedParams }: RenderFilterPanelOpts): string {
  const sections: string[] = []

  // 1. Status
  sections.push(sectionWrap('Status', checkboxGroup('f_status', [
    { value: 'open', label: 'Open' },
    { value: 'archived', label: 'Archived' },
    { value: 'cancelled', label: 'Cancelled' },
    { value: 'on_hold', label: 'On hold' },
  ], f.status)))

  // 2. Payment status
  sections.push(sectionWrap('Payment status', checkboxGroup('f_payment', [
    { value: 'pending', label: 'Pending' },
    { value: 'authorized', label: 'Authorized' },
    { value: 'refunded', label: 'Refunded' },
    { value: 'partially_refunded', label: 'Partially refunded' },
    { value: 'paid', label: 'Paid' },
    { value: 'payment_in_process', label: 'Payment in process' },
    { value: 'voided', label: 'Voided' },
    { value: 'partially_paid', label: 'Partially paid' },
  ], f.payment)))

  // 3. Sales channel
  sections.push(sectionWrap('Sales channel', checkboxGroup('f_channel', [
    { value: 'web', label: 'Online store' },
    { value: 'shopify', label: 'Shopify' },
    { value: 'amazon', label: 'Amazon' },
    { value: 'tiktok', label: 'TikTok' },
    { value: 'etsy', label: 'Etsy' },
    { value: 'ebay', label: 'eBay' },
    { value: 'imported', label: 'Imported orders' },
  ], f.channel), false))

  // 4. Tracking number
  sections.push(sectionWrap('Tracking number', textField('f_tracking', f.tracking, 'Search by tracking number'), false))

  // 5. Have tracking number
  sections.push(sectionWrap('Have tracking number', yesNoRadio('f_has_tracking', f.hasTracking), false))

  // 6. Fulfillment status
  sections.push(sectionWrap('Fulfillment status', checkboxGroup('f_fulfillment', [
    { value: 'unfulfilled', label: 'Unfulfilled' },
    { value: 'partial', label: 'Partially Fulfilled' },
    { value: 'fulfilled', label: 'Fulfilled' },
    { value: 'processing', label: 'Processing' },
    { value: 'partial_processing', label: 'Partially Processing' },
    { value: 'awaiting_stock', label: 'Awaiting Stock' },
  ], f.fulfillment), false))

  // 7. Product type
  sections.push(sectionWrap('Product type', containsNot('f_ptype_has', 'f_ptype_not', f.productTypeHas, f.productTypeNot, 'e.g. T-shirt'), false))

  // 8. Product vendor
  sections.push(sectionWrap('Product vendor', containsNot('f_vendor_has', 'f_vendor_not', f.vendorHas, f.vendorNot, 'Vendor name'), false))

  // 9. Lineitem products
  sections.push(sectionWrap('Lineitem products', containsNot('f_line_name_has', 'f_line_name_not', f.lineNameHas, f.lineNameNot, 'Product name'), false))

  // 10. Lineitem SKU
  sections.push(sectionWrap('Lineitem SKU', containsNot('f_line_sku_has', 'f_line_sku_not', f.lineSkuHas, f.lineSkuNot, 'SKU'), false))

  // 11. Order date
  sections.push(sectionWrap('Order date', dateRange('f_order_date_from', 'f_order_date_to', f.orderDateFrom, f.orderDateTo), false))

  // 12. Refund date
  sections.push(sectionWrap('Refund date', dateRange('f_refund_date_from', 'f_refund_date_to', f.refundDateFrom, f.refundDateTo), false))

  // 13. Fulfillment date
  sections.push(sectionWrap('Fulfillment date', dateRange('f_fulfill_date_from', 'f_fulfill_date_to', f.fulfillDateFrom, f.fulfillDateTo), false))

  // 14. Custom option
  sections.push(sectionWrap('Custom option', yesNoRadio('f_custom', f.custom), false))

  // 15. Order country
  const countryOpts = COUNTRIES.map(c =>
    `<option value="${esc(c.code)}"${f.country === c.code ? ' selected' : ''}>${esc(c.name)}</option>`,
  ).join('')
  sections.push(sectionWrap('Order country', `
    <select name="f_country" class="flt-input">
      <option value="">Any</option>
      ${countryOpts}
    </select>
    ${f.country ? `<button type="button" class="flt-clear" onclick="document.querySelector('[name=&quot;f_country&quot;]').value=''">Clear</button>` : ''}
  `, false))

  // 16. Tag
  sections.push(sectionWrap('Tag', textField('f_tag', f.tag, 'Search by tag'), false))

  // 17. Customer
  sections.push(sectionWrap('Customer', textField('f_customer', f.customer, 'Name or email'), false))

  // --- Sprint 2b extensions (UTM + POD + Risk) ---

  // 18. UTM Source
  sections.push(sectionWrap('Source', textField('f_utm_source', f.utmSource, 'Search by source'), false))

  // 19. UTM Medium
  sections.push(sectionWrap('Medium', textField('f_utm_medium', f.utmMedium, 'Search by medium'), false))

  // 20. UTM Campaign
  sections.push(sectionWrap('Campaign', textField('f_utm_campaign', f.utmCampaign, 'Search by campaign'), false))

  // 21. UTM Content
  sections.push(sectionWrap('Content', textField('f_utm_content', f.utmContent, 'Search by content'), false))

  // 22. UTM Term
  sections.push(sectionWrap('Term', textField('f_utm_term', f.utmTerm, 'Search by term'), false))

  // 23. Print file status
  sections.push(sectionWrap('Print file status', `
    <label class="flt-check"><input type="radio" name="f_print_status" value="any_generating"${f.printFileStatus === 'any_generating' ? ' checked' : ''}><span>Any item is generating</span></label>
    <label class="flt-check"><input type="radio" name="f_print_status" value="all_generated"${f.printFileStatus === 'all_generated' ? ' checked' : ''}><span>All items are generated</span></label>
    ${f.printFileStatus ? `<button type="button" class="flt-clear" onclick="document.querySelectorAll('[name=&quot;f_print_status&quot;]').forEach(e=>e.checked=false)">Clear</button>` : ''}
  `, false))

  // 24. Order risk
  sections.push(sectionWrap('Order risk', `
    <label class="flt-check"><input type="checkbox" name="f_risk" value="yes"${f.riskHigh === 'yes' ? ' checked' : ''}><span>Orders have high risk or fraud</span></label>
    ${f.riskHigh ? `<button type="button" class="flt-clear" onclick="document.querySelector('[name=&quot;f_risk&quot;]').checked=false">Clear</button>` : ''}
  `, false))

  // Hidden preserved params (tab, q, field, per)
  const hiddenInputs = Object.entries(preservedParams).map(([k, v]) =>
    `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`,
  ).join('')

  return `
    <div class="flt-overlay" id="fltOverlay" onclick="closeFilterPanel()"></div>
    <div class="flt-panel" id="fltPanel">
      <form method="get" action="${esc(formAction)}" id="fltForm">
        ${hiddenInputs}
        <div class="flt-head">
          <h3 style="margin:0;font-size:16px">Filters</h3>
          <button type="button" class="flt-close" onclick="closeFilterPanel()" aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 5l10 10M15 5L5 15"/></svg>
          </button>
        </div>
        <div class="flt-body">
          ${sections.join('')}
        </div>
        <div class="flt-foot">
          <button type="button" class="btn btn-outline" onclick="clearAllFilters()">Clear all filters</button>
          <button type="submit" class="btn btn-primary">Apply</button>
        </div>
      </form>
    </div>
  `
}

/* ------------------------------------------------------------------ */
/*  CSS (injected once per page)                                      */
/* ------------------------------------------------------------------ */

export const FILTER_PANEL_CSS = `
  .flt-overlay {
    position:fixed; inset:0; background:rgba(0,0,0,.4); z-index:1000;
    opacity:0; pointer-events:none; transition:opacity .2s ease;
  }
  .flt-overlay.open { opacity:1; pointer-events:auto; }

  .flt-panel {
    position:fixed; top:0; right:0; bottom:0; width:360px; max-width:92vw;
    background:var(--s-card); border-left:1px solid var(--s-border);
    z-index:1001; display:flex; flex-direction:column;
    transform:translateX(100%); transition:transform .25s cubic-bezier(.4,0,.2,1);
    box-shadow:-8px 0 32px rgba(0,0,0,.35);
  }
  .flt-panel.open { transform:translateX(0); }

  .flt-head {
    display:flex; align-items:center; justify-content:space-between;
    padding:16px 20px; border-bottom:1px solid var(--s-border);
  }
  .flt-close {
    background:none; border:none; color:var(--s-text-muted); cursor:pointer;
    padding:4px; border-radius:4px; display:flex;
  }
  .flt-close:hover { background:rgba(255,255,255,.06); color:var(--s-text); }

  .flt-body {
    flex:1; overflow-y:auto; padding:8px 4px;
  }

  .flt-section { border-bottom:1px solid var(--s-border); padding:0 16px; }
  .flt-section-head {
    display:flex; align-items:center; justify-content:space-between;
    width:100%; padding:12px 0; background:none; border:none; cursor:pointer;
    color:var(--s-text); font-size:13px; font-weight:600; text-align:left;
  }
  .flt-section-head:hover { color:var(--s-accent, #6366f1); }
  .flt-chev { transition:transform .2s ease; color:var(--s-text-muted); }
  .flt-section.open .flt-chev { transform:rotate(180deg); }
  .flt-section-body { display:none; padding:0 0 12px 0; }
  .flt-section.open .flt-section-body { display:block; }

  .flt-check {
    display:flex; align-items:center; gap:8px; padding:6px 0;
    font-size:13px; color:var(--s-text); cursor:pointer;
  }
  .flt-check input[type=checkbox],
  .flt-check input[type=radio] {
    width:14px; height:14px; accent-color:var(--s-accent, #6366f1); cursor:pointer;
  }

  .flt-input {
    width:100%; padding:6px 10px; font-size:13px;
    background:var(--s-bg, #0f1016); color:var(--s-text);
    border:1px solid var(--s-border); border-radius:6px; outline:none;
  }
  .flt-input:focus { border-color:var(--s-accent, #6366f1); }

  .flt-field-label {
    display:block; font-size:11px; color:var(--s-text-muted);
    margin-bottom:4px; font-weight:500;
  }

  .flt-daterange { display:flex; align-items:center; gap:8px; }
  .flt-daterange .flt-input { flex:1; }

  .flt-clear {
    margin-top:6px; padding:0; background:none; border:none;
    color:var(--s-accent, #6366f1); font-size:12px; cursor:pointer;
  }
  .flt-clear:hover { text-decoration:underline; }

  .flt-foot {
    display:flex; gap:8px; justify-content:space-between;
    padding:16px 20px; border-top:1px solid var(--s-border);
  }
  .flt-foot .btn { flex:1; }

  /* Active filter chips below tabs */
  .flt-chips {
    display:flex; flex-wrap:wrap; gap:6px; padding:8px 16px;
    border-top:1px solid var(--s-border);
  }
  .flt-chip {
    display:inline-flex; align-items:center; gap:6px;
    padding:4px 10px; background:rgba(99,102,241,.12);
    border:1px solid rgba(99,102,241,.35); border-radius:999px;
    font-size:12px; color:var(--s-accent, #6366f1);
  }
  .flt-chip a {
    color:inherit; text-decoration:none; opacity:0.7; cursor:pointer;
    display:inline-flex; align-items:center;
  }
  .flt-chip a:hover { opacity:1; }
`

export const FILTER_PANEL_JS = `
  function openFilterPanel() {
    document.getElementById('fltPanel').classList.add('open');
    document.getElementById('fltOverlay').classList.add('open');
  }
  function closeFilterPanel() {
    document.getElementById('fltPanel').classList.remove('open');
    document.getElementById('fltOverlay').classList.remove('open');
  }
  function clearFilterGroup(name) {
    document.querySelectorAll('[name="' + name + '"]').forEach(el => {
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = false;
      else el.value = '';
    });
  }
  function clearAllFilters() {
    const form = document.getElementById('fltForm');
    // Reset all f_* inputs
    form.querySelectorAll('input, select').forEach(el => {
      if (el.name && el.name.startsWith('f_')) {
        if (el.type === 'checkbox' || el.type === 'radio') el.checked = false;
        else el.value = '';
      }
    });
    form.submit();
  }
`
