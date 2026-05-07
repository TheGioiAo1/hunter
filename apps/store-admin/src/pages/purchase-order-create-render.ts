/**
 * purchase-order-create-render.ts
 * Render form tạo Purchase Order — Polaris-inspired layout 2-column cards.
 *
 * BE state: Order Service Swagger chưa có endpoint Purchase Order; form này
 * submit qua local handler stub. Khi BE có endpoint mới (e.g.
 * POST /api/{shop_id}/purchase-orders), chỉ cần wire ở handler — render giữ.
 */

import { esc } from '../layouts/seller-layout.js'
import { productPickerAssets } from '../components/purchase-order-product-picker.js'

export interface PurchaseOrderLocation {
  id: string
  name: string
  is_primary?: boolean | null
}

export interface PurchaseOrderFormData {
  formAction: string
  csrfField: string
  backHref: string
  /** JSON endpoint để fetch products cho autocomplete + modal */
  productsSearchUrl: string
  locations: PurchaseOrderLocation[]
  flashError?: string
  flashWarning?: string
  /** Pre-fill khi 422 / re-render */
  prefill?: {
    supplier?: string
    destinationLocationId?: string
    paymentTerms?: string
    currency?: string
    estimatedArrival?: string
    shippingCarrier?: string
    trackingNumber?: string
    referenceNumber?: string
    note?: string
    tags?: string
  }
}

const PAYMENT_TERMS = ['None', 'On receipt', 'Net 7', 'Net 15', 'Net 30', 'Net 45', 'Net 60', 'Net 90']
const CURRENCIES = ['USD', 'VND', 'EUR', 'GBP', 'JPY', 'CNY', 'AUD', 'CAD']
const SHIPPING_CARRIERS = ['USPS', 'UPS', 'FedEx', 'DHL', 'TNT', 'Aramex', 'Vietnam Post', 'GHN', 'GHTK', 'J&T Express', 'Other']

export function renderPurchaseOrderCreateForm(data: PurchaseOrderFormData): string {
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

  const locationOptions = locations.length > 0
    ? locations.map((l) => `<option value="${esc(l.id)}"${prefill.destinationLocationId === l.id ? ' selected' : ''}>${esc(l.name)}${l.is_primary ? ' (Primary)' : ''}</option>`).join('')
    : '<option value="" disabled>No locations available</option>'

  const paymentOptions = PAYMENT_TERMS
    .map((t) => `<option value="${esc(t)}"${(prefill.paymentTerms ?? 'None') === t ? ' selected' : ''}>${esc(t)}</option>`)
    .join('')

  const currencyOptions = CURRENCIES
    .map((c) => `<option value="${esc(c)}"${(prefill.currency ?? 'USD') === c ? ' selected' : ''}>${esc(c)}</option>`)
    .join('')

  const carrierOptions = ['<option value="">Select carrier…</option>']
    .concat(SHIPPING_CARRIERS.map((c) => `<option value="${esc(c)}"${prefill.shippingCarrier === c ? ' selected' : ''}>${esc(c)}</option>`))
    .join('')

  const styles = `<style>
    .po-page{max-width:1100px;margin:0 auto;padding:24px 20px}
    .po-breadcrumb{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--gx-muted,#9aa0a6);margin-bottom:14px}
    .po-breadcrumb a{color:var(--gx-muted,#9aa0a6);text-decoration:none;display:inline-flex;align-items:center;gap:6px}
    .po-breadcrumb a:hover{color:var(--gx-text,#e8eaf0)}
    .po-title{margin:0 0 22px;font-size:22px;font-weight:600;color:var(--gx-text,#e8eaf0);letter-spacing:-.01em}
    .po-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
    @media (max-width:760px){.po-grid{grid-template-columns:1fr}}
    .po-card{background:var(--gx-surface,rgba(255,255,255,.02));border:1px solid var(--gx-border,rgba(255,255,255,.08));border-radius:12px;padding:18px 20px}
    .po-card h2{margin:0 0 14px;font-size:13px;font-weight:600;color:var(--gx-text,#e8eaf0);letter-spacing:.01em}
    .po-card-2col{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    @media (max-width:540px){.po-card-2col{grid-template-columns:1fr}}
    .po-card-3col{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}
    @media (max-width:760px){.po-card-3col{grid-template-columns:1fr}}
    .po-field{display:flex;flex-direction:column;gap:5px}
    .po-label{font-size:12.5px;font-weight:500;color:var(--gx-muted,#9aa0a6)}
    .po-input,.po-select,.po-textarea{width:100%;padding:8px 10px;background:var(--gx-bg,#13161c);border:1px solid var(--gx-border,rgba(255,255,255,.1));border-radius:7px;color:var(--gx-text,#e8eaf0);font-size:13.5px;box-sizing:border-box;outline:none;transition:.15s;font-family:inherit}
    .po-input:focus,.po-select:focus,.po-textarea:focus{border-color:#5b6dff;box-shadow:0 0 0 3px rgba(91,109,255,.15)}
    .po-input::placeholder,.po-textarea::placeholder{color:var(--gx-muted,#7a8089)}
    .po-textarea{resize:vertical;min-height:80px;font-family:inherit}
    .po-search{position:relative}
    .po-search input{padding-left:34px}
    .po-search-icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--gx-muted,#7a8089);pointer-events:none}
    .po-products-row{display:flex;gap:10px;align-items:stretch}
    .po-products-row .po-search{flex:1}
    .po-btn-ghost{padding:8px 16px;border:1px solid var(--gx-border,rgba(255,255,255,.12));border-radius:7px;background:transparent;color:var(--gx-text,#e8eaf0);font-size:13px;cursor:pointer;white-space:nowrap}
    .po-btn-ghost:hover{background:rgba(255,255,255,.04)}
    .po-cost{display:flex;flex-direction:column;gap:10px}
    .po-cost-row{display:flex;justify-content:space-between;align-items:flex-start;font-size:13.5px}
    .po-cost-row .po-cost-label{color:var(--gx-muted,#9aa0a6)}
    .po-cost-row.po-cost-strong{font-weight:600;color:var(--gx-text,#e8eaf0)}
    .po-cost-sub{font-size:12px;color:var(--gx-muted,#7a8089);margin-top:2px}
    .po-cost-divider{height:1px;background:var(--gx-border,rgba(255,255,255,.08));margin:6px 0}
    .po-cost-total{font-size:15px;font-weight:700;color:var(--gx-text,#e8eaf0)}
    .po-cost-converted{display:flex;justify-content:space-between;align-items:center;font-size:12.5px;color:var(--gx-muted,#9aa0a6);padding-top:10px;border-top:1px dashed var(--gx-border,rgba(255,255,255,.08))}
    .po-cost-manage{font-size:12.5px;color:#7c8aff;text-decoration:none;margin-bottom:10px;display:inline-block}
    .po-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}
    .po-btn-primary{padding:9px 18px;border:0;border-radius:8px;background:linear-gradient(180deg,#5b6dff,#4854e0);color:#fff;font-size:13.5px;font-weight:600;cursor:pointer}
    .po-btn-primary:hover{background:linear-gradient(180deg,#6577ff,#5260e8)}
    .po-flash{padding:11px 14px;border-radius:8px;margin-bottom:14px;font-size:13.5px}
    .po-flash-error{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);color:#fca5a5}
    .po-flash-warn{background:rgba(234,179,8,.1);border:1px solid rgba(234,179,8,.25);color:#facc15}
    .po-empty-products{padding:18px;text-align:center;font-size:12.5px;color:var(--gx-muted,#7a8089);border:1px dashed var(--gx-border,rgba(255,255,255,.12));border-radius:8px;margin-top:12px}
  </style>`

  const flashHtml = flashError
    ? `<div class="po-flash po-flash-error" role="alert">${esc(flashError)}</div>`
    : flashWarning
      ? `<div class="po-flash po-flash-warn" role="status">${esc(flashWarning)}</div>`
      : ''

  return `${styles}
  <div class="po-page">
    <nav class="po-breadcrumb">
      <a href="${esc(backHref)}" aria-label="Back to purchase orders">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
        Purchase orders
      </a>
    </nav>
    <h1 class="po-title">Create purchase order</h1>

    ${flashHtml}

    <form method="POST" action="${esc(formAction)}" novalidate>
      ${csrfField}

      <!-- Supplier + Destination -->
      <div class="po-card">
        <div class="po-card-2col">
          <div class="po-field">
            <label class="po-label" for="po-supplier">Supplier</label>
            <select name="supplier" id="po-supplier" class="po-select">
              <option value="">Select supplier…</option>
              ${prefill.supplier ? `<option value="${esc(prefill.supplier)}" selected>${esc(prefill.supplier)}</option>` : ''}
            </select>
          </div>
          <div class="po-field">
            <label class="po-label" for="po-destination">Destination</label>
            <select name="destination_location_id" id="po-destination" class="po-select" required>
              ${locationOptions}
            </select>
          </div>
        </div>
        <div class="po-card-2col" style="margin-top:14px">
          <div class="po-field">
            <label class="po-label" for="po-payment">Payment terms (optional)</label>
            <select name="payment_terms" id="po-payment" class="po-select">${paymentOptions}</select>
          </div>
          <div class="po-field">
            <label class="po-label" for="po-currency">Supplier currency</label>
            <select name="currency" id="po-currency" class="po-select">${currencyOptions}</select>
          </div>
        </div>
      </div>

      <div style="height:14px"></div>

      <!-- Shipment details -->
      <div class="po-card">
        <h2>Shipment details</h2>
        <div class="po-card-3col">
          <div class="po-field">
            <label class="po-label" for="po-eta">Estimated arrival</label>
            <input type="date" name="estimated_arrival" id="po-eta" class="po-input" value="${esc(prefill.estimatedArrival ?? '')}" placeholder="YYYY-MM-DD">
          </div>
          <div class="po-field">
            <label class="po-label" for="po-carrier">Shipping carrier</label>
            <select name="shipping_carrier" id="po-carrier" class="po-select">${carrierOptions}</select>
          </div>
          <div class="po-field">
            <label class="po-label" for="po-tracking">Tracking number</label>
            <input type="text" name="tracking_number" id="po-tracking" class="po-input" maxlength="64" value="${esc(prefill.trackingNumber ?? '')}">
          </div>
        </div>
      </div>

      <div style="height:14px"></div>

      <!-- Add products -->
      <div class="po-card">
        <h2>Add products</h2>
        <div class="po-products-row">
          <div class="po-search">
            <svg class="po-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>
            <input type="search" class="po-input po-search-input" placeholder="Search products…" autocomplete="off">
            <div class="po-search-results" role="listbox" aria-label="Product search suggestions"></div>
          </div>
          <button type="button" class="po-btn-ghost po-browse-btn">Browse</button>
        </div>
        <div class="po-selected-products" role="list" aria-label="Selected products"></div>
        <div class="po-empty-products">No products added yet. Use search or Browse to pick products from your catalog.</div>
      </div>

      <div style="height:14px"></div>

      <!-- Additional details + Cost summary -->
      <div class="po-grid">
        <div class="po-card">
          <h2>Additional details</h2>
          <div class="po-field" style="margin-bottom:12px">
            <label class="po-label" for="po-ref">Reference number</label>
            <input type="text" name="reference_number" id="po-ref" class="po-input" maxlength="64" value="${esc(prefill.referenceNumber ?? '')}">
          </div>
          <div class="po-field" style="margin-bottom:12px">
            <label class="po-label" for="po-note">Note to supplier</label>
            <textarea name="note" id="po-note" class="po-textarea" maxlength="5000" rows="4">${esc(prefill.note ?? '')}</textarea>
            <div style="font-size:11px;color:var(--gx-muted,#7a8089);text-align:right;margin-top:2px">${esc(String(prefill.note?.length ?? 0))}/5000</div>
          </div>
          <div class="po-field">
            <label class="po-label" for="po-tags">Tags</label>
            <input type="text" name="tags" id="po-tags" class="po-input" placeholder="Comma-separated" value="${esc(prefill.tags ?? '')}">
          </div>
        </div>

        <div class="po-card">
          <h2>Cost summary</h2>
          <a href="#" class="po-cost-manage" onclick="event.preventDefault()">Manage</a>
          <div class="po-cost">
            <div class="po-cost-row">
              <span class="po-cost-label">Taxes (Included)</span>
              <span>$0.00 ${esc(prefill.currency ?? 'USD')}</span>
            </div>
            <div class="po-cost-row po-cost-strong">
              <div>
                <div>Subtotal</div>
                <div class="po-cost-sub">0 items</div>
              </div>
              <span>$0.00 ${esc(prefill.currency ?? 'USD')}</span>
            </div>
            <div class="po-cost-divider"></div>
            <div class="po-cost-row po-cost-strong">Cost adjustments</div>
            <div class="po-cost-row">
              <span class="po-cost-label">Shipping</span>
              <span>$0.00 ${esc(prefill.currency ?? 'USD')}</span>
            </div>
            <div class="po-cost-divider"></div>
            <div class="po-cost-row po-cost-total">
              <span>Total</span>
              <span>$0.00 ${esc(prefill.currency ?? 'USD')}</span>
            </div>
            <div class="po-cost-converted">
              <span>Converted total <span title="Total in shop currency" style="opacity:.7">ⓘ</span></span>
              <span>₫0</span>
            </div>
          </div>
        </div>
      </div>

      <div class="po-actions">
        <a href="${esc(backHref)}" class="po-btn-ghost">Cancel</a>
        <button type="submit" class="po-btn-primary">Save as draft</button>
      </div>
    </form>
  </div>
  ${productPickerAssets({ searchUrl: productsSearchUrl })}`
}
