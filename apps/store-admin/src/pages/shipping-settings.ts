/**
 * Store Admin — Shipping Settings (lean, BE-aligned)
 *
 * Đã bỏ Profile concept + các section stub (Packages, Labels, Carriers,
 * Documents, Local delivery, Pickup, Delivery customizations, Custom
 * fulfillment) để khớp 100% với những gì BE Shipping API hỗ trợ.
 *
 * Trang giờ tập trung vào Shipping Zones với editor đầy đủ field BE:
 *   - Zone: name + country_codes[] + country_excluded (allow/deny mode)
 *   - Method: name + type (fix/freeship) + range_type/min/max +
 *     first_item_price + second_item_price
 *
 * Carrier handlers (Enable/Toggle/LiveToggle/SeedRates/RemoveRates) giữ
 * exports stub để server.ts không vỡ — BE API mới không có catalog.
 */

import type { Request, Response } from 'express'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { formatProductApiError } from '../lib/product-api-errors.js'
import {
  createApiContext,
  listShippings,
  getShipping,
  createShipping,
  updateShipping,
  deleteShipping,
} from '../lib/shipping-api-client.js'
import type { ApiShipping, ApiShippingMethod } from '../lib/shipping-api-types.js'
import {
  createApiContext as createProductCtx,
  listCategories,
  listProducts,
} from '../lib/product-api-client.js'
import { COUNTRY_FLAG, COUNTRY_NAME, flagOf, nameOf } from '../lib/country-data.js'

// ─── Helpers ─────

function parseCountryCodes(raw: string): string[] {
  return raw.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean)
}

function methodCount(s: ApiShipping): number {
  return Array.isArray(s.shipping_methods) ? s.shipping_methods.length : 0
}

function num(v: unknown): number | undefined {
  if (v == null || v === '') return undefined
  const n = parseFloat(String(v))
  return Number.isFinite(n) ? n : undefined
}

/**
 * Encode JSON cho nhúng vào <script> tag — escape `<` để tránh
 * `</script>` injection khi data có chứa các ký tự đặc biệt.
 */
function jsonForScript(v: unknown): string {
  return JSON.stringify(v ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}

function flashStyles(): string {
  return `<style>
    .gbx-flash{display:flex;align-items:center;gap:8px;padding:10px 14px;margin:0 0 16px;border-radius:8px;font-size:13px;font-weight:500}
    .gbx-flash-success{color:#065f46;background:#d1fae5;border:1px solid #a7f3d0}
    .gbx-flash-error{color:#991b1b;background:#fee2e2;border:1px solid #fecaca}
    [data-theme="dark"] .gbx-flash-success{color:#a7f3d0;background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.3)}
    [data-theme="dark"] .gbx-flash-error{color:#fecaca;background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.3)}
    .ss-input{width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg);color:var(--s-text);outline:none}
    .ss-input:focus{border-color:var(--s-accent);box-shadow:0 0 0 2px rgba(99,102,241,.15)}
    .ss-label{display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-secondary)}
    .ss-help{margin:4px 0 0;font-size:11px;color:var(--s-text-secondary)}
    .ss-card{background:var(--s-card-bg);border:1px solid var(--s-border);border-radius:12px;margin-bottom:16px;overflow:hidden}
    .ss-card-head{padding:14px 18px;border-bottom:1px solid var(--s-border);display:flex;justify-content:space-between;align-items:center;gap:12px}
    .ss-card-head h3{margin:0;font-size:14px;font-weight:600;color:var(--s-text)}
    .ss-card-body{padding:14px 18px}
    /* Picker dropdown — solid background opaque, không phụ thuộc theme token */
    .ss-dd{position:absolute;left:0;right:0;top:38px;border:1px solid #d1d5db;border-radius:8px;max-height:260px;overflow:auto;z-index:50;box-shadow:0 8px 24px rgba(0,0,0,.18);background:#ffffff;color:#0f172a}
    [data-theme="dark"] .ss-dd{background:#1e293b;border-color:#334155;color:#f1f5f9;box-shadow:0 8px 24px rgba(0,0,0,.5)}
    .ss-dd-row{padding:9px 12px;cursor:pointer;font-size:13px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #e5e7eb}
    .ss-dd-row:last-child{border-bottom:none}
    .ss-dd-row:hover,.ss-dd-row.active{background:#eef2ff;color:#0f172a}
    [data-theme="dark"] .ss-dd-row{border-bottom-color:#334155}
    [data-theme="dark"] .ss-dd-row:hover,[data-theme="dark"] .ss-dd-row.active{background:#312e81;color:#f1f5f9}
    .ss-dd-empty{padding:12px;color:#6b7280;font-size:12px;text-align:center}
    [data-theme="dark"] .ss-dd-empty{color:#94a3b8}
  </style>`
}

// ─── GET /settings/shipping ─────

export async function getShippingSettingsPage(
  req: Request,
  res: Response,
  _db: any,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const csrfField = csrfHiddenField(req.csrfToken!)

  const showNew = req.query.new === '1'
  const editId = String(req.query.edit ?? '').trim()
  const isFormView = showNew || !!editId

  let shippings: ApiShipping[] = []
  let editing: ApiShipping | null = null
  let errMsg: string | null = null

  try {
    const ctx = createApiContext(req)
    if (editId) {
      editing = await getShipping(ctx, editId)
    } else {
      shippings = await listShippings(ctx)
    }
  } catch (err) {
    errMsg = formatProductApiError(err)
  }

  const flashSuccess = String(req.query.success ?? '').slice(0, 200)
  const flashError = String(req.query.error ?? '').slice(0, 200)

  const content = `
    ${flashStyles()}
    ${flashSuccess ? `<div class="gbx-flash gbx-flash-success">${esc(flashSuccess)}</div>` : ''}
    ${flashError ? `<div class="gbx-flash gbx-flash-error">${esc(flashError)}</div>` : ''}
    ${errMsg ? `<div class="gbx-flash gbx-flash-error">${esc(errMsg)}</div>` : ''}

    <div class="page-header">
      <div>
        ${isFormView ? `<a href="${base}/settings/shipping" style="color:var(--s-text-secondary);text-decoration:none;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px">&larr; Shipping zones</a>` : ''}
        <h1 class="page-title" style="margin:0;display:flex;align-items:center;gap:8px">
          <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 6h10v6H1z"/><path d="M11 8h3l1 2v2h-4"/><circle cx="4" cy="13" r="1.5"/><circle cx="12" cy="13" r="1.5"/></svg>
          ${isFormView ? (editing ? 'Edit shipping zone' : 'New shipping zone') : 'Shipping zones'}
        </h1>
        ${!isFormView ? `<p class="page-subtitle">Define which countries you ship to and how much you charge.</p>` : ''}
      </div>
      ${!isFormView ? `<a href="${base}/settings/shipping?new=1" class="btn btn-primary">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v10M3 8h10"/></svg>
        Create zone
      </a>` : ''}
    </div>

    ${isFormView
      ? renderZoneForm(base, csrfField, editing)
      : renderZonesTable(base, csrfField, shippings)}
  `

  res.send(sellerLayout({
    title: 'Shipping zones',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'settings',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ─── List view ─────

function renderZonesTable(base: string, csrfField: string, shippings: ApiShipping[]): string {
  if (shippings.length === 0) {
    return `<div class="ss-card"><div class="ss-card-body" style="text-align:center;padding:60px 20px">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--s-text-secondary)" stroke-width="1" style="margin-bottom:12px"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>
      <h3 style="margin:0 0 4px;font-size:15px;font-weight:600">No shipping zones</h3>
      <p style="margin:0 0 16px;font-size:13px;color:var(--s-text-secondary)">Create your first zone to charge shipping at checkout.</p>
      <a href="${base}/settings/shipping?new=1" class="btn btn-primary">Create shipping zone</a>
    </div></div>`
  }

  return `<div class="ss-card">
    <div class="card-body" style="padding:0">
      <div class="table-wrap"><table>
        <thead><tr>
          <th style="width:30%">Zone name</th>
          <th>Countries</th>
          <th style="text-align:center">Methods</th>
          <th>Updated</th>
          <th style="width:160px;text-align:right">Actions</th>
        </tr></thead>
        <tbody>
          ${shippings.map(s => `<tr>
            <td>
              <a href="${base}/settings/shipping?edit=${encodeURIComponent(s.id ?? '')}" style="color:var(--s-accent);text-decoration:none;font-weight:600">${esc(s.name ?? '(unnamed)')}</a>
            </td>
            <td style="font-size:12px;color:var(--s-text-secondary)">
              ${s.country_excluded ? '<span style="color:#ef4444">Excludes:</span> ' : ''}
              ${(s.country_codes && s.country_codes.length > 0)
                ? esc(s.country_codes.slice(0, 6).join(', ')) + (s.country_codes.length > 6 ? ` +${s.country_codes.length - 6}` : '')
                : '<em>All countries</em>'}
            </td>
            <td style="text-align:center"><span style="display:inline-block;padding:2px 8px;border-radius:9999px;font-size:11px;background:rgba(99,102,241,.12);color:var(--s-accent)">${methodCount(s)}</span></td>
            <td style="font-size:12px;color:var(--s-text-secondary)">${esc(s.update_date?.slice(0, 10) ?? s.create_date?.slice(0, 10) ?? '-')}</td>
            <td style="text-align:right;white-space:nowrap">
              <a href="${base}/settings/shipping?edit=${encodeURIComponent(s.id ?? '')}" class="btn btn-outline btn-sm">Edit</a>
              <form method="POST" action="${base}/settings/shipping/delete-zone" style="display:inline" onsubmit="return confirm('Delete this zone permanently?')">
                ${csrfField}
                <input type="hidden" name="zone_id" value="${esc(s.id ?? '')}">
                <button type="submit" class="btn btn-outline btn-sm" style="color:var(--s-danger);border-color:var(--s-danger)">Delete</button>
              </form>
            </td>
          </tr>`).join('')}
        </tbody>
      </table></div>
    </div>
  </div>`
}

// ─── Zone form (rich, BE-aligned) ─────

// BE Shipping.cs line 122: [ValidValues("fix", "freeship", "flat")]
// - "flat":     1 giá cố định cho cả order, không tính theo item
// - "fix":      Item-tier pricing — first_item_price cho item 1, second_item_price cho items 2+
// - "freeship": Miễn phí nếu order trong khoảng [min_value, max_value] theo range_type
const METHOD_TYPES: { value: string; label: string; hint: string }[] = [
  { value: 'fix',      label: 'Fixed per item', hint: 'Different price for the first item vs additional items.' },
  { value: 'freeship', label: 'Free shipping',  hint: 'Free when order meets a min/max condition (price or item count).' },
]

// BE Shipping.cs line 144: [ValidValues("order_price", "item_number")]
const RANGE_TYPES: { value: string; label: string }[] = [
  { value: '',            label: 'No range (always applies)' },
  { value: 'order_price', label: 'Based on order subtotal' },
  { value: 'item_number', label: 'Based on number of items' },
]

function renderZoneForm(base: string, csrfField: string, shipping: ApiShipping | null): string {
  const isEdit = !!shipping
  const id = shipping?.id ?? ''
  const name = shipping?.name ?? ''
  const countryCodes = (shipping?.country_codes ?? []).map(c => c.toUpperCase())
  const excluded = !!shipping?.country_excluded
  const methods = shipping?.shipping_methods ?? []

  // Entity (category/product) hiện trạng từ BE — entity:0=category, 1=product.
  const entityNum = shipping?.entity
  const entities = shipping?.entities ?? []
  const entityExcluded = !!shipping?.entity_excluded
  const applyMode = entities.length > 0
    ? (entityNum === 1 ? 'product' : 'category')
    : 'all'
  const initialEntities = entities.map(e => ({
    id: e.entity_id ?? '',
    name: e.entity_name ?? '(unnamed)',
    image_url: e.entity_image ?? '',
  })).filter(e => e.id)

  // Country catalog cho picker (sort theo tên).
  const countryCatalog = Object.keys(COUNTRY_NAME)
    .filter(c => c !== 'UK') // UK trùng GB, ưu tiên GB
    .map(c => ({ code: c, name: COUNTRY_NAME[c], flag: COUNTRY_FLAG[c] ?? '🌐' }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const initialCountries = countryCodes.map(c => ({ code: c, name: nameOf(c), flag: flagOf(c) }))

  return `
    <form method="POST" action="${base}/settings/shipping/create-zone" id="ss-zone-form">
      ${csrfField}
      ${isEdit ? `<input type="hidden" name="zone_id" value="${esc(id)}">` : ''}

      <!-- Zone basics -->
      <div class="ss-card">
        <div class="ss-card-head"><h3>Zone</h3></div>
        <div class="ss-card-body" style="display:flex;flex-direction:column;gap:14px">
          <div>
            <label class="ss-label">Zone name</label>
            <input type="text" name="name" value="${esc(name)}" required placeholder="e.g. Domestic, Asia, Europe" class="ss-input">
          </div>
          <div>
            <label class="ss-label">Countries</label>
            <div id="ss-country-picker" style="width:100%;border:1px solid var(--s-border);border-radius:8px;background:var(--s-input-bg);padding:10px 12px;min-height:48px">
              <div id="ss-country-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px"></div>
              <div style="position:relative;width:100%">
                <input type="text" id="ss-country-search" placeholder="Search countries…" class="ss-input" style="width:100%;border:1px solid var(--s-border);background:var(--s-card-bg);padding:8px 12px" autocomplete="off">
                <div id="ss-country-results" class="ss-dd" style="display:none;top:42px;min-width:320px"></div>
              </div>
            </div>
            <p class="ss-help">Start typing a country name to search. Leave empty = applies to all countries.</p>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <input type="checkbox" name="country_excluded" id="ss-excl" value="true" ${excluded ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--s-accent)">
            <label for="ss-excl" style="font-size:13px;cursor:pointer">
              <strong>Exclude these countries</strong> instead of include them
            </label>
          </div>
          <p class="ss-help" style="margin-top:-6px">When checked, the zone applies to <em>all countries except</em> those listed above.</p>
        </div>
      </div>

      <!-- Apply to (entity) — BE: entity={category|product} + entities[]+ entity_excluded -->
      <div class="ss-card">
        <div class="ss-card-head"><h3>Apply to</h3></div>
        <div class="ss-card-body" style="display:flex;flex-direction:column;gap:14px">
          <div>
            <label class="ss-label">Scope</label>
            <select id="ss-apply-mode" name="apply_mode" class="ss-input" style="max-width:280px">
              <option value="all" ${applyMode === 'all' ? 'selected' : ''}>All products in shop</option>
              <option value="category" ${applyMode === 'category' ? 'selected' : ''}>Specific categories</option>
              <option value="product" ${applyMode === 'product' ? 'selected' : ''}>Specific products</option>
            </select>
          </div>

          <div id="ss-entity-picker" style="${applyMode === 'all' ? 'display:none;' : ''}border:1px solid var(--s-border);border-radius:10px;padding:14px;background:var(--s-input-bg)">
            <!-- Search input ON TOP — dropdown rơi xuống dưới search nhưng vẫn không che chips bên dưới vì chips hiện ở khu riêng -->
            <label class="ss-label" id="ss-entity-search-label">${applyMode === 'product' ? 'Search products' : 'Search categories'}</label>
            <div style="position:relative;margin-bottom:14px">
              <input type="text" id="ss-entity-search" placeholder="Type a name to search…" class="ss-input" autocomplete="off">
              <div id="ss-entity-results" class="ss-dd" style="display:none"></div>
            </div>

            <div id="ss-entity-flash" style="display:none;padding:6px 10px;margin-bottom:10px;border-radius:6px;background:rgba(34,197,94,.15);color:#16a34a;font-size:12px;font-weight:600;border:1px solid rgba(34,197,94,.3)"></div>

            <!-- Selected box rõ rệt: header + box riêng có background khác -->
            <label class="ss-label" id="ss-entity-label" style="display:flex;align-items:center;gap:8px;margin-top:4px">
              <span>${applyMode === 'product' ? 'Selected products' : 'Selected categories'}</span>
              <span id="ss-entity-count" style="display:inline-block;padding:2px 8px;border-radius:9999px;background:var(--s-accent);color:#fff;font-size:11px;font-weight:600;min-width:20px;text-align:center">0</span>
            </label>
            <div id="ss-entity-chips" style="display:flex;flex-wrap:wrap;gap:8px;min-height:60px;padding:10px;border:2px dashed var(--s-border);border-radius:10px;background:var(--s-card-bg);align-items:flex-start"></div>
            <p class="ss-help" id="ss-entity-empty" style="margin:6px 0 0;font-style:italic;color:var(--s-text-secondary)">Search above and click a result to add it here. Items appear as chips.</p>

            <div style="display:flex;align-items:flex-start;gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid var(--s-border)">
              <input type="checkbox" name="entity_excluded" id="ss-ent-excl" value="true" ${entityExcluded ? 'checked' : ''} style="margin-top:2px;width:16px;height:16px;accent-color:var(--s-accent);flex-shrink:0">
              <label for="ss-ent-excl" style="font-size:13px;cursor:pointer">
                <strong>Exclude these items</strong>
                <p class="ss-help" style="margin-top:2px">Apply zone to all items <em>except</em> the ones selected.</p>
              </label>
            </div>
          </div>
        </div>
      </div>

      <script>
        // ─── Country picker (multi-select chip với search) ───
        ;(function(){
          var catalog = ${jsonForScript(countryCatalog)};
          var initial = ${jsonForScript(initialCountries)};
          var picker = document.getElementById('ss-country-picker')
          var searchEl = document.getElementById('ss-country-search')
          var resultsEl = document.getElementById('ss-country-results')
          var chipsEl = document.getElementById('ss-country-chips')
          var form = document.getElementById('ss-zone-form')
          if (!picker || !searchEl || !chipsEl || !form) return

          var chips = initial.slice()

          function escapeHtml(s){ return String(s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]) }) }

          function syncHidden(){
            form.querySelectorAll('input[name="country_codes"]').forEach(function(el){ el.remove() })
            chips.forEach(function(c){
              var inp = document.createElement('input')
              inp.type = 'hidden'; inp.name = 'country_codes'; inp.value = c.code
              form.appendChild(inp)
            })
          }

          function renderChips(){
            chipsEl.innerHTML = ''
            chips.forEach(function(c, i){
              var chip = document.createElement('span')
              chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 8px 4px 10px;border-radius:9999px;background:rgba(99,102,241,.12);color:var(--s-accent);font-size:12px;font-weight:500'
              chip.innerHTML = '<span style="font-size:14px">' + c.flag + '</span><span>' + escapeHtml(c.name) + '</span>'
              var btn = document.createElement('button')
              btn.type = 'button'; btn.textContent = '×'
              btn.setAttribute('aria-label', 'Remove ' + c.name)
              btn.style.cssText = 'border:none;background:transparent;color:inherit;cursor:pointer;font-size:14px;line-height:1;padding:0;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;border-radius:50%'
              btn.addEventListener('click', function(){ chips.splice(i,1); renderChips() })
              chip.appendChild(btn)
              chipsEl.appendChild(chip)
            })
            syncHidden()
          }

          function renderResults(q){
            var picked = new Set(chips.map(function(c){ return c.code }))
            var matches = catalog.filter(function(c){
              if (picked.has(c.code)) return false
              if (!q) return true
              var qq = q.toLowerCase()
              return c.name.toLowerCase().indexOf(qq) !== -1 || c.code.toLowerCase().indexOf(qq) !== -1
            }).slice(0, 30)
            resultsEl.innerHTML = ''
            if (matches.length === 0) {
              resultsEl.innerHTML = '<div class="ss-dd-empty">No matches</div>'
            } else {
              matches.forEach(function(it){
                var row = document.createElement('div')
                row.className = 'ss-dd-row'
                row.innerHTML = '<span style="font-size:16px">' + it.flag + '</span><span style="flex:1">' + escapeHtml(it.name) + '</span><span style="font-size:11px;opacity:.6">' + it.code + '</span>'
                // Dùng mousedown thay vì click để tránh blur input đóng dropdown trước khi click trigger.
                row.addEventListener('mousedown', function(e){
                  e.preventDefault()
                  chips.push(it); renderChips()
                  searchEl.value = ''
                  renderResults('')
                  setTimeout(function(){ searchEl.focus() }, 0)
                })
                resultsEl.appendChild(row)
              })
            }
            resultsEl.style.display = 'block'
          }

          searchEl.addEventListener('input', function(){ renderResults(searchEl.value.trim()) })
          searchEl.addEventListener('focus', function(){ renderResults(searchEl.value.trim()) })
          // Chặn Enter trong search input — tránh submit form ngoài ý muốn.
          searchEl.addEventListener('keydown', function(e){ if (e.key === 'Enter') e.preventDefault() })
          document.addEventListener('click', function(e){ if (!picker.contains(e.target)) resultsEl.style.display = 'none' })

          renderChips()
        })()

        // ─── Entity picker (AJAX product/category search, reset on mode change) ───
        ;(function(){
          var pickerUrl = ${jsonForScript(base + '/settings/shipping/entity-picker')};
          var picker = document.getElementById('ss-entity-picker')
          var modeSelect = document.getElementById('ss-apply-mode')
          var searchEl = document.getElementById('ss-entity-search')
          var resultsEl = document.getElementById('ss-entity-results')
          var chipsEl = document.getElementById('ss-entity-chips')
          var emptyEl = document.getElementById('ss-entity-empty')
          var labelEl = document.getElementById('ss-entity-label')
          var form = document.getElementById('ss-zone-form')
          if (!picker || !modeSelect || !searchEl || !chipsEl || !form) return

          var initial = ${jsonForScript(initialEntities)};
          var initialMode = ${jsonForScript(applyMode)};
          // Chips chỉ giữ initial khi mode khớp với initial mode (tránh leak entities cũ).
          var chips = (modeSelect.value === initialMode && initialMode !== 'all') ? initial.slice() : []
          var debounceId = null

          function escapeHtml(s){ return String(s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]) }) }

          function addHidden(name, val){
            var x = document.createElement('input');
            x.type = 'hidden';
            x.name = name;
            x.value = val == null ? '' : String(val);
            form.appendChild(x);
          }
          function syncHidden(){
            var sel = 'input[name="entity"], input[name="entity_ids"], input[name="entity_names"], input[name="entity_images"]';
            var olds = form.querySelectorAll(sel);
            for (var i = 0; i < olds.length; i++) olds[i].remove();
            var mode = modeSelect.value;
            if (mode === 'all' || chips.length === 0) return;
            var entityNum = mode === 'product' ? 1 : 0;
            addHidden('entity', String(entityNum));
            for (var j = 0; j < chips.length; j++) {
              var c = chips[j];
              addHidden('entity_ids', c.id);
              addHidden('entity_names', c.name);
              addHidden('entity_images', c.image_url || '');
            }
          }

          var countEl = document.getElementById('ss-entity-count');
          var flashEl = document.getElementById('ss-entity-flash');
          var flashTimer = null;
          function showFlash(msg){
            if (!flashEl) return;
            flashEl.textContent = '✓ ' + msg;
            flashEl.style.display = 'block';
            clearTimeout(flashTimer);
            flashTimer = setTimeout(function(){ flashEl.style.display = 'none'; }, 1800);
          }
          function renderChips(){
            chipsEl.innerHTML = ''
            chips.forEach(function(c, i){
              var chip = document.createElement('span')
              chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 8px 4px 6px;border-radius:8px;background:rgba(99,102,241,.15);color:var(--s-accent);font-size:12px;font-weight:500;border:1px solid rgba(99,102,241,.3)'
              var img = c.image_url ? '<img src="'+escapeHtml(c.image_url)+'" style="width:20px;height:20px;border-radius:3px;object-fit:cover" onerror="this.remove()">' : '<span style="width:20px;height:20px;background:var(--s-border);border-radius:3px;display:inline-block"></span>'
              chip.innerHTML = img + '<span>' + escapeHtml(c.name) + '</span>'
              var btn = document.createElement('button')
              btn.type = 'button'; btn.textContent = '×'
              btn.setAttribute('aria-label', 'Remove ' + c.name)
              btn.style.cssText = 'border:none;background:transparent;color:inherit;cursor:pointer;font-size:16px;line-height:1;padding:0;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;margin-left:2px'
              btn.addEventListener('click', function(){ chips.splice(i,1); renderChips() })
              chip.appendChild(btn)
              chipsEl.appendChild(chip)
            })
            emptyEl.style.display = chips.length === 0 ? 'block' : 'none'
            if (countEl) countEl.textContent = String(chips.length);
            syncHidden()
          }

          function fetchResults(q){
            var mode = modeSelect.value
            if (mode === 'all') return
            resultsEl.innerHTML = '<div class="ss-dd-empty">Searching…</div>'
            resultsEl.style.display = 'block'
            fetch(pickerUrl + '?type=' + mode + '&q=' + encodeURIComponent(q), { credentials: 'same-origin', headers: { Accept: 'application/json' }})
              .then(function(r){ return r.json() })
              .then(function(data){
                var items = (data && data.items) || []
                var picked = new Set(chips.map(function(c){ return c.id }))
                items = items.filter(function(it){ return !picked.has(it.id) })
                resultsEl.innerHTML = ''
                if (items.length === 0) {
                  resultsEl.innerHTML = '<div class="ss-dd-empty">' + (q ? 'No matches for "'+escapeHtml(q)+'"' : 'No items') + '</div>'
                } else {
                  items.forEach(function(it){
                    var row = document.createElement('div')
                    row.className = 'ss-dd-row'
                    var img = it.image_url ? '<img src="'+escapeHtml(it.image_url)+'" style="width:28px;height:28px;border-radius:4px;object-fit:cover" onerror="this.remove()">' : '<span style="width:28px;height:28px;background:#e5e7eb;border-radius:4px;display:inline-block;flex-shrink:0"></span>'
                    row.innerHTML = img + '<span>' + escapeHtml(it.name) + '</span>'
                    // mousedown thay click → chạy trước blur, tránh dropdown đóng trước khi click.
                    row.addEventListener('mousedown', function(e){
                      e.preventDefault()
                      chips.push(it); renderChips()
                      showFlash('Added "' + it.name + '"')
                      // ĐÓNG dropdown ngay sau khi chọn → user thấy chip mới thêm
                      searchEl.value = ''
                      resultsEl.style.display = 'none'
                      resultsEl.innerHTML = ''
                      searchEl.blur()
                    })
                    resultsEl.appendChild(row)
                  })
                }
              })
              .catch(function(err){
                console.error('[entity-picker]', err)
                resultsEl.innerHTML = '<div class="ss-dd-empty" style="color:var(--s-danger)">Search failed</div>'
              })
          }

          searchEl.addEventListener('input', function(){
            clearTimeout(debounceId)
            debounceId = setTimeout(function(){ fetchResults(searchEl.value.trim()) }, 300)
          })
          searchEl.addEventListener('focus', function(){ fetchResults(searchEl.value.trim()) })
          // Chặn Enter trong entity search — tránh submit form khi user đang chọn.
          searchEl.addEventListener('keydown', function(e){ if (e.key === 'Enter') e.preventDefault() })
          document.addEventListener('click', function(e){
            if (!picker.contains(e.target)) resultsEl.style.display = 'none'
          })

          // FIX: khi đổi mode → reset chips, đổi label, ẩn/hiện picker, clear search.
          modeSelect.addEventListener('change', function(){
            var mode = modeSelect.value
            picker.style.display = mode === 'all' ? 'none' : ''
            chips = []  // ← reset chips khi đổi từ category sang product (hoặc ngược lại)
            searchEl.value = ''
            resultsEl.style.display = 'none'
            resultsEl.innerHTML = ''
            if (labelEl) labelEl.textContent = mode === 'product' ? 'Products' : (mode === 'category' ? 'Categories' : '')
            renderChips()
          })

          renderChips()
        })()
      </script>

      ${isEdit ? `
        <!-- Existing methods -->
        <div class="ss-card">
          <div class="ss-card-head">
            <h3>Shipping methods</h3>
            <span style="font-size:11px;color:var(--s-text-secondary)">${methods.length} method${methods.length === 1 ? '' : 's'}</span>
          </div>
          <div class="ss-card-body" style="padding:0">
            ${methods.length === 0
              ? `<div style="padding:30px 20px;text-align:center;color:var(--s-text-secondary);font-size:13px">No methods yet. Add one below.</div>`
              : `<div class="table-wrap"><table>
                  <thead><tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th style="text-align:right">Price</th>
                    <th>Range</th>
                    <th>1st item</th>
                    <th>2nd+ item</th>
                    <th style="width:80px"></th>
                  </tr></thead>
                  <tbody>
                    ${methods.map((m, i) => `<tr>
                      <td><strong>${esc(m.name ?? '-')}</strong>${m.description ? `<div style="font-size:11px;color:var(--s-text-secondary)">${esc(m.description)}</div>` : ''}</td>
                      <td style="font-size:12px">${esc(METHOD_TYPES.find(t => t.value === m.type)?.label ?? m.type ?? '-')}</td>
                      <td style="text-align:right;font-family:monospace">${m.type === 'freeship' ? 'free' : (m.price ?? 0).toFixed(2)}</td>
                      <td style="font-size:12px;color:var(--s-text-secondary)">
                        ${m.range_type
                          ? `${esc(m.range_type === 'order_price' ? 'price' : 'items')}: ${m.min_value ?? 0}–${m.max_value ?? '∞'}`
                          : '—'}
                      </td>
                      <td style="font-size:12px;font-family:monospace">${m.first_item_price != null ? (m.first_item_price).toFixed(2) : '-'}</td>
                      <td style="font-size:12px;font-family:monospace">${m.second_item_price != null ? (m.second_item_price).toFixed(2) : '-'}</td>
                      <td style="text-align:right">
                        <!-- onclick refresh CSRF token trước, sau đó submit form ngoài bằng HTML5 form attr -->
                        <button type="button" data-del-method="${i}" class="btn btn-outline btn-sm ss-del-method-btn" style="color:var(--s-danger);border-color:var(--s-danger);padding:2px 8px;font-size:11px">Remove</button>
                      </td>
                    </tr>`).join('')}
                  </tbody>
                </table></div>`}
          </div>
        </div>

        <!-- Add new method -->
        <!-- Pending methods preview — hiện chỉ khi user đã add ít nhất 1 method.
             Sẽ submit kèm Save zone qua hidden input pending_methods (JSON). -->
        <div class="ss-card" id="ss-pending-card" style="display:none">
          <div class="ss-card-head">
            <h3>Pending methods <span style="font-size:11px;font-weight:500;color:var(--s-text-secondary);margin-left:4px">— will be saved when you click Save</span></h3>
            <span id="ss-pending-count" style="font-size:11px;color:var(--s-text-secondary)"></span>
          </div>
          <div class="ss-card-body" style="padding:0">
            <table style="width:100%">
              <thead><tr>
                <th>Name</th><th>Type</th><th style="text-align:right">Price / Range</th><th style="width:80px"></th>
              </tr></thead>
              <tbody id="ss-pending-tbody"></tbody>
            </table>
          </div>
        </div>
        <input type="hidden" name="pending_methods" id="ss-pending-input" value="[]">

        <!-- Add method form (buffer — không submit từng field, chỉ qua "Add to list") -->
        <div class="ss-card">
          <div class="ss-card-head"><h3>Add shipping method</h3></div>
          <div class="ss-card-body" style="display:flex;flex-direction:column;gap:14px">
            <div style="display:grid;grid-template-columns:2fr 1fr;gap:12px">
              <div>
                <label class="ss-label">Method name</label>
                <input type="text" id="ss-buf-name" placeholder="e.g. Standard shipping" class="ss-input">
              </div>
              <div>
                <label class="ss-label">Pricing type</label>
                <select id="ss-mtype" class="ss-input">
                  ${METHOD_TYPES.map(t => `<option value="${t.value}">${esc(t.label)}</option>`).join('')}
                </select>
                <p class="ss-help" id="ss-mtype-hint">${esc(METHOD_TYPES[0].hint)}</p>
              </div>
            </div>

            <div>
              <label class="ss-label">Description (optional)</label>
              <input type="text" id="ss-buf-desc" placeholder="Shown to customer at checkout" class="ss-input">
            </div>

            <!-- FIX: item-tier price -->
            <div id="ss-fields-fix" class="ss-type-fields">
              <p class="ss-help" style="margin:0 0 8px">BE tính giá theo công thức: <code>price = first_item_price + second_item_price × (qty − 1)</code></p>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                <div>
                  <label class="ss-label">1st item price</label>
                  <input type="number" id="ss-buf-1st" step="0.01" min="0" placeholder="0.00" class="ss-input">
                </div>
                <div>
                  <label class="ss-label">2nd+ item price</label>
                  <input type="number" id="ss-buf-2nd" step="0.01" min="0" placeholder="0.00" class="ss-input">
                </div>
              </div>
            </div>

            <!-- FREESHIP: range condition -->
            <div id="ss-fields-freeship" class="ss-type-fields" style="display:none">
              <p class="ss-help" style="margin:0 0 8px">BE: free khi <code>min_value ≤ value ≤ max_value</code> (value lấy theo range type).</p>
              <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px">
                <div>
                  <label class="ss-label">Range type</label>
                  <select id="ss-buf-range" class="ss-input">
                    ${RANGE_TYPES.filter(t => t.value).map(t => `<option value="${t.value}">${esc(t.label)}</option>`).join('')}
                  </select>
                </div>
                <div>
                  <label class="ss-label">Min value</label>
                  <input type="number" id="ss-buf-min" step="0.01" min="0" placeholder="0" class="ss-input">
                </div>
                <div>
                  <label class="ss-label">Max value (∞ if blank)</label>
                  <input type="number" id="ss-buf-max" step="0.01" min="0" placeholder="∞" class="ss-input">
                </div>
              </div>
            </div>

            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px">
              <button type="button" id="ss-add-method-btn" class="btn btn-primary" style="padding:8px 16px;font-size:13px">
                + Add to list
              </button>
            </div>

            <div id="ss-add-error" style="display:none;color:#ef4444;font-size:12px;font-weight:500"></div>

            <script>
              ;(function(){
                var sel = document.getElementById('ss-mtype')
                var hint = document.getElementById('ss-mtype-hint')
                var hints = ${jsonForScript(Object.fromEntries(METHOD_TYPES.map(t => [t.value, t.hint])))};
                var typeLabels = ${jsonForScript(Object.fromEntries(METHOD_TYPES.map(t => [t.value, t.label])))};
                function refresh(){
                  var v = sel.value
                  document.querySelectorAll('.ss-type-fields').forEach(function(el){ el.style.display = 'none' })
                  var box = document.getElementById('ss-fields-' + v)
                  if (box) box.style.display = ''
                  if (hint) hint.textContent = hints[v] || ''
                }
                sel.addEventListener('change', refresh)
                refresh()

                // ── Pending methods state — buffer trước khi user Save zone.
                var pending = []
                var pendingInput = document.getElementById('ss-pending-input')
                var pendingCard = document.getElementById('ss-pending-card')
                var pendingBody = document.getElementById('ss-pending-tbody')
                var pendingCount = document.getElementById('ss-pending-count')
                var errEl = document.getElementById('ss-add-error')

                function showErr(msg){ errEl.textContent = msg; errEl.style.display = msg ? 'block' : 'none' }
                function fmt(n){ return Number(n||0).toFixed(2) }

                function syncPending(){
                  pendingInput.value = JSON.stringify(pending)
                  pendingCount.textContent = pending.length + ' method' + (pending.length === 1 ? '' : 's')
                  pendingCard.style.display = pending.length === 0 ? 'none' : ''
                  pendingBody.innerHTML = pending.map(function(m, i){
                    var detail = m.type === 'freeship'
                      ? 'free · ' + (m.range_type === 'order_price' ? 'price' : 'items') + ' ' + (m.min_value || 0) + '–' + (m.max_value == null ? '∞' : m.max_value)
                      : fmt(m.first_item_price) + ' / ' + fmt(m.second_item_price)
                    return '<tr>' +
                      '<td><strong>' + escapeHtml(m.name) + '</strong>' + (m.description ? '<div style="font-size:11px;color:var(--s-text-secondary)">' + escapeHtml(m.description) + '</div>' : '') + '</td>' +
                      '<td style="font-size:12px">' + escapeHtml(typeLabels[m.type] || m.type) + '</td>' +
                      '<td style="text-align:right;font-family:monospace;font-size:12px">' + detail + '</td>' +
                      '<td style="text-align:right"><button type="button" class="btn btn-outline btn-sm" data-i="' + i + '" style="color:var(--s-danger);border-color:var(--s-danger);padding:2px 8px;font-size:11px">Remove</button></td>' +
                      '</tr>'
                  }).join('')
                }
                function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]) }) }

                pendingBody.addEventListener('click', function(e){
                  var b = e.target.closest('button[data-i]')
                  if (!b) return
                  pending.splice(parseInt(b.dataset.i, 10), 1)
                  syncPending()
                })

                document.getElementById('ss-add-method-btn').addEventListener('click', function(){
                  showErr('')
                  var name = (document.getElementById('ss-buf-name').value || '').trim()
                  if (!name) { showErr('Method name is required.'); return }
                  var type = sel.value
                  var desc = (document.getElementById('ss-buf-desc').value || '').trim() || undefined
                  var m = { name: name, description: desc, type: type }
                  if (type === 'fix') {
                    var p1 = parseFloat(document.getElementById('ss-buf-1st').value)
                    var p2 = parseFloat(document.getElementById('ss-buf-2nd').value)
                    if (!Number.isFinite(p1) || p1 < 0) { showErr('1st item price required (≥ 0).'); return }
                    m.first_item_price = p1
                    m.second_item_price = Number.isFinite(p2) ? p2 : p1
                  } else if (type === 'freeship') {
                    m.range_type = document.getElementById('ss-buf-range').value
                    var mn = parseFloat(document.getElementById('ss-buf-min').value)
                    var mx = parseFloat(document.getElementById('ss-buf-max').value)
                    m.min_value = Number.isFinite(mn) ? mn : 0
                    if (Number.isFinite(mx)) m.max_value = mx
                  }
                  pending.push(m)
                  syncPending()
                  // Reset buffer fields
                  document.getElementById('ss-buf-name').value = ''
                  document.getElementById('ss-buf-desc').value = ''
                  document.getElementById('ss-buf-1st').value = ''
                  document.getElementById('ss-buf-2nd').value = ''
                  document.getElementById('ss-buf-min').value = ''
                  document.getElementById('ss-buf-max').value = ''
                  document.getElementById('ss-buf-name').focus()
                })

                syncPending()
              })()
            </script>
          </div>
        </div>
      ` : `
        <div class="ss-card" style="background:rgba(59,130,246,.06);border-color:rgba(59,130,246,.25)">
          <div class="ss-card-body" style="display:flex;align-items:center;gap:10px;font-size:13px">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#2563eb" stroke-width="1.5" style="flex-shrink:0"><circle cx="8" cy="8" r="7"/><path d="M8 5v3M8 11h.01"/></svg>
            <span>Save the zone first, then add shipping methods on the edit page.</span>
          </div>
        </div>
      `}

      <div style="display:flex;gap:8px;justify-content:flex-end">
        <a href="${base}/settings/shipping" class="btn btn-outline">Cancel</a>
        <button type="submit" class="btn btn-primary" id="ss-save-btn">${isEdit ? 'Save changes' : 'Create zone'}</button>
      </div>
    </form>

    ${isEdit ? methods.map((_m, i) => `
      <!-- Form delete-method render OUTSIDE main form — tránh nested forms (HTML5 invalid).
           Các button Remove trong table dùng attribute form="ss-del-method-N" để trigger. -->
      <form id="ss-del-method-${i}" method="POST" action="${base}/settings/shipping/delete-method" style="display:none">
        ${csrfField}
        <input type="hidden" name="zone_id" value="${esc(id)}">
        <input type="hidden" name="method_index" value="${i}">
      </form>
    `).join('') : ''}

    <script>
      // Anti-double-submit + CSRF token refresh trước khi submit (chống case
      // backend secret bị reissue khi form đang mở → form _csrf cũ → 403).
      ;(function(){
        var f = document.getElementById('ss-zone-form')
        var b = document.getElementById('ss-save-btn')
        if (!f || !b) return
        var origLabel = b.textContent
        var csrfRefreshUrl = ${jsonForScript(base + '/csrf-refresh')};
        var refreshing = false

        function resetBtn(){
          b.dataset.busy = ''
          b.disabled = false
          b.textContent = origLabel
        }
        function setCsrfToken(token){
          // Update _csrf hidden input của tất cả form trong page (main + delete-method).
          document.querySelectorAll('input[name="_csrf"]').forEach(function(inp){ inp.value = token })
        }

        f.addEventListener('submit', function(e){
          if (b.dataset.busy === '1') { e.preventDefault(); return }
          if (refreshing) { e.preventDefault(); return }
          // Refresh CSRF token đồng bộ trước submit. Chặn submit, fetch token, set, re-submit.
          if (!f.dataset.tokenRefreshed) {
            e.preventDefault()
            refreshing = true
            b.textContent = 'Saving…'
            fetch(csrfRefreshUrl, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
              .then(function(r){ return r.json() })
              .then(function(data){
                if (data && data.token) setCsrfToken(data.token)
                f.dataset.tokenRefreshed = '1'
                refreshing = false
                f.requestSubmit ? f.requestSubmit(b) : f.submit()
              })
              .catch(function(err){
                console.error('[csrf-refresh]', err)
                refreshing = false
                resetBtn()
                alert('Could not refresh session. Please reload the page and try again.')
              })
            return
          }
          // Token đã refresh — submit bình thường, set busy.
          b.dataset.busy = '1'
          setTimeout(function(){ b.disabled = true; b.textContent = 'Saving…' }, 0)
          setTimeout(resetBtn, 15000)
        })

        window.addEventListener('pageshow', function(ev){
          if (ev.persisted) { resetBtn(); f.dataset.tokenRefreshed = '' }
        })

        // Delete-method buttons: confirm + refresh CSRF + submit external form.
        document.addEventListener('click', function(e){
          var btn = e.target.closest && e.target.closest('.ss-del-method-btn')
          if (!btn) return
          e.preventDefault()
          if (!confirm('Remove this method?')) return
          var idx = btn.getAttribute('data-del-method')
          var delForm = document.getElementById('ss-del-method-' + idx)
          if (!delForm) return
          btn.disabled = true; btn.textContent = '…'
          fetch(csrfRefreshUrl, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
            .then(function(r){ return r.json() })
            .then(function(data){
              if (data && data.token) setCsrfToken(data.token)
              delForm.submit()
            })
            .catch(function(){
              btn.disabled = false; btn.textContent = 'Remove'
              alert('Could not refresh session. Please reload the page.')
            })
        })
      })()
    </script>
  `
}

// ─── POST: Create / Update zone ─────

export async function postCreateZone(req: Request, res: Response, _db: any): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const zoneId = String(req.body.zone_id ?? '').trim()
  const name = String(req.body.name ?? '').trim()
  const countriesRaw = String(req.body.country_codes ?? '').trim()
  const countries = parseCountryCodes(countriesRaw)
  const countryExcluded = req.body.country_excluded === 'true'

  // Apply-to (entity): radio "all" | "category" | "product".
  // entity field BE: 0=category, 1=product. Skip nếu mode=all.
  const applyMode = String(req.body.apply_mode ?? 'all').trim()
  const entityExcluded = req.body.entity_excluded === 'true'
  const entityIdsRaw = req.body.entity_ids
  const entityNamesRaw = req.body.entity_names
  const entityImagesRaw = req.body.entity_images
  const toArr = (v: any): string[] => Array.isArray(v) ? v.map(String) : v != null && v !== '' ? [String(v)] : []
  const entityIds = toArr(entityIdsRaw)
  const entityNames = toArr(entityNamesRaw)
  const entityImages = toArr(entityImagesRaw)

  let entityNum: number | undefined
  let entitiesPayload: { entity_id?: string; entity_name?: string; entity_image?: string }[] | undefined
  let idsPayload: string[] | undefined

  if (applyMode === 'category' || applyMode === 'product') {
    entityNum = applyMode === 'product' ? 1 : 0
    entitiesPayload = entityIds.map((id, i) => ({
      entity_id: id,
      entity_name: entityNames[i] || id,
      entity_image: entityImages[i] || undefined,
    }))
    idsPayload = entityIds
  }

  if (!name) {
    res.redirect(`${base}/settings/shipping?error=Zone+name+required`)
    return
  }

  // FE đã batch nhiều methods qua JS thành JSON pending_methods (xem
  // ss-add-method-btn). Parse + sanitize, whitelist enum theo BE
  // (Shipping.cs ValidValues).
  const ALLOWED_TYPES = ['fix', 'freeship']
  const ALLOWED_RANGE = ['order_price', 'item_number']
  let newMethods: ApiShippingMethod[] = []
  try {
    const raw = String(req.body.pending_methods ?? '[]')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      newMethods = parsed
        .filter((m: any) => m && typeof m.name === 'string' && m.name.trim().length > 0)
        .map((m: any): ApiShippingMethod => {
          const type = ALLOWED_TYPES.includes(m.type) ? m.type : 'fix'
          const range_type = ALLOWED_RANGE.includes(m.range_type) ? m.range_type : undefined
          return {
            name: String(m.name).trim(),
            description: typeof m.description === 'string' && m.description.trim() ? m.description.trim() : undefined,
            type,
            range_type: type === 'freeship' ? range_type : undefined,
            min_value: type === 'freeship' ? num(m.min_value) : undefined,
            max_value: type === 'freeship' ? num(m.max_value) : undefined,
            first_item_price: type === 'fix' ? num(m.first_item_price) : undefined,
            second_item_price: type === 'fix' ? num(m.second_item_price) : undefined,
          }
        })
    }
  } catch {
    // bad JSON → treat as no pending methods
  }

  try {
    const ctx = createApiContext(req)

    if (zoneId) {
      const existing = await getShipping(ctx, zoneId)
      const existingMethods = existing?.shipping_methods ?? []
      const merged = [...existingMethods, ...newMethods]

      const updated = await updateShipping(ctx, zoneId, {
        id: zoneId,
        shop_id: ctx.shopId,
        name,
        country_codes: countries,
        country_excluded: countryExcluded,
        entity: entityNum,
        entities: entitiesPayload,
        ids: idsPayload,
        entity_excluded: entitiesPayload ? entityExcluded : false,
        shipping_methods: merged,
      })
      console.log('[shipping] update zone:', zoneId, '→', updated?.id ? 'OK' : 'NULL', 'methods=', merged.length, '(+' + newMethods.length + ' new)')
      res.redirect(`${base}/settings/shipping?edit=${encodeURIComponent(zoneId)}&success=Zone+saved`)
    } else {
      const created = await createShipping(ctx, {
        shop_id: ctx.shopId,
        name,
        country_codes: countries,
        country_excluded: countryExcluded,
        entity: entityNum,
        entities: entitiesPayload,
        ids: idsPayload,
        entity_excluded: entitiesPayload ? entityExcluded : false,
        shipping_methods: newMethods,
      })
      console.log('[shipping] create zone:', created?.id, name, countries, 'methods=', newMethods.length)
      res.redirect(`${base}/settings/shipping?success=Zone+created`)
    }
  } catch (err) {
    console.error('[shipping] save failed:', err)
    res.redirect(`${base}/settings/shipping?error=${encodeURIComponent(formatProductApiError(err))}`)
  }
}

// ─── POST: Add rate (legacy alias — uses postCreateZone path) ─────

export async function postCreateRate(req: Request, res: Response, _db: any): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const zoneId = String(req.body.zone_id ?? '').trim()
  const name = String(req.body.name ?? '').trim()

  if (!zoneId || !name) {
    res.redirect(`${base}/settings/shipping?error=Zone+and+rate+name+required`)
    return
  }

  try {
    const ctx = createApiContext(req)
    const existing = await getShipping(ctx, zoneId)
    if (!existing) {
      res.redirect(`${base}/settings/shipping?error=Zone+not+found`)
      return
    }
    // Legacy alias — chỉ accept 'fix' | 'freeship' theo BE enum.
    const rawT = String(req.body.type ?? 'fix')
    const t = (rawT === 'freeship' ? 'freeship' : 'fix')
    const methods = [...(existing.shipping_methods ?? []), {
      name,
      type: t,
      first_item_price: t === 'fix' ? (num(req.body.price) ?? 0) : undefined,
    }]
    await updateShipping(ctx, zoneId, { id: zoneId, shipping_methods: methods })
    res.redirect(`${base}/settings/shipping?edit=${encodeURIComponent(zoneId)}&success=Rate+added`)
  } catch (err) {
    res.redirect(`${base}/settings/shipping?error=${encodeURIComponent(formatProductApiError(err))}`)
  }
}

// ─── POST: Delete a single method from a zone ─────

export async function postDeleteMethod(req: Request, res: Response, _db: any): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const zoneId = String(req.body.zone_id ?? '').trim()
  const idx = parseInt(String(req.body.method_index ?? '-1'), 10)

  if (!zoneId || isNaN(idx) || idx < 0) {
    res.redirect(`${base}/settings/shipping?error=Invalid+method+reference`)
    return
  }

  try {
    const ctx = createApiContext(req)
    const existing = await getShipping(ctx, zoneId)
    if (!existing) {
      res.redirect(`${base}/settings/shipping?error=Zone+not+found`)
      return
    }
    const methods = (existing.shipping_methods ?? []).filter((_, i) => i !== idx)
    await updateShipping(ctx, zoneId, { id: zoneId, shipping_methods: methods })
    res.redirect(`${base}/settings/shipping?edit=${encodeURIComponent(zoneId)}&success=Method+removed`)
  } catch (err) {
    res.redirect(`${base}/settings/shipping?edit=${encodeURIComponent(zoneId)}&error=${encodeURIComponent(formatProductApiError(err))}`)
  }
}

// ─── POST: Delete zone ─────

export async function postDeleteZone(req: Request, res: Response, _db: any): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const zoneId = String(req.body.zone_id ?? '').trim()

  if (!zoneId) {
    res.redirect(`${base}/settings/shipping?error=Zone+ID+missing`)
    return
  }

  try {
    const ctx = createApiContext(req)
    await deleteShipping(ctx, zoneId)
    res.redirect(`${base}/settings/shipping?success=Zone+deleted`)
  } catch (err) {
    res.redirect(`${base}/settings/shipping?error=${encodeURIComponent(formatProductApiError(err))}`)
  }
}

// ─── GET /settings/shipping/entity-picker — JSON search products/categories ─────

/**
 * Walk through nested response shapes from BE Product/Category services to
 * find the array of items. BE đã thay đổi response wrapper qua nhiều version
 * — phải fallback nhiều cấp (`data.products` / `data.data` / `data` /
 * `data.items` / root array).
 */
function extractItems(raw: any): any[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  const candidates = [
    raw.data?.products,
    raw.data?.data,
    raw.data?.items,
    raw.data,
    raw.products,
    raw.items,
    raw.results,
  ]
  for (const c of candidates) if (Array.isArray(c)) return c
  return []
}

export async function getEntityPicker(req: Request, res: Response, _db: any): Promise<void> {
  const type = String(req.query.type ?? 'product').trim()
  const q = String(req.query.q ?? '').trim().slice(0, 100)
  const limit = Math.min(50, parseInt(String(req.query.limit ?? '20'), 10) || 20)

  try {
    const ctx = createProductCtx(req)

    if (type === 'category') {
      const raw: any = await listCategories(ctx, {
        keyword: q || undefined,
        page: 1,
        limit,
        // Bỏ field filter — BE có thể strip image_url nếu không liệt kê đúng tên.
        // Để BE trả default fields, FE map field bằng nameOf hoặc fallback.
      })
      const cats = extractItems(raw)
      if (cats.length === 0) {
        console.log('[shipping] category picker q=', q, 'EMPTY — raw keys:',
          raw && typeof raw === 'object' ? Object.keys(raw) : typeof raw,
          'data keys:', raw?.data && typeof raw.data === 'object' ? Object.keys(raw.data) : typeof raw?.data)
      } else {
        console.log('[shipping] category picker q=', q, 'returned', cats.length)
      }
      res.json({
        items: cats.map((c: any) => ({
          id: c.id ?? c._id,
          name: c.name ?? c.title ?? '(no name)',
          image_url: c.image_url ?? c.image ?? c.thumbnail,
        })).filter((x: any) => x.id),
      })
      return
    }

    // default = product
    const raw: any = await listProducts(ctx, {
      keyword: q || undefined,
      page: 1,
      limit,
      isCache: false,
    })
    const products = extractItems(raw)
    if (products.length === 0) {
      console.log('[shipping] product picker q=', q, 'EMPTY — raw keys:',
        raw && typeof raw === 'object' ? Object.keys(raw) : typeof raw,
        'data keys:', raw?.data && typeof raw.data === 'object' ? Object.keys(raw.data) : typeof raw?.data)
    } else {
      console.log('[shipping] product picker q=', q, 'returned', products.length)
    }
    res.json({
      items: products.map((p: any) => {
        let img: string | undefined
        if (Array.isArray(p.images) && p.images[0]) {
          img = p.images[0].url ?? p.images[0].src ?? (typeof p.images[0] === 'string' ? p.images[0] : undefined)
        }
        if (!img) img = p.image_url ?? p.thumbnail ?? p.image ?? undefined
        return {
          id: p.id ?? p._id,
          name: p.name ?? p.title ?? '(no name)',
          image_url: img,
        }
      }).filter((x: any) => x.id),
    })
  } catch (err) {
    console.error('[shipping] entity-picker failed:', err)
    res.status(500).json({ error: formatProductApiError(err), items: [] })
  }
}

// ─── Carrier handlers (stubs — BE Shipping API không có carrier catalog) ─────

function carrierStub(req: Request, res: Response): void {
  const store = req.store!
  res.redirect(`/admin/store/${store.slug}/settings/shipping?error=${encodeURIComponent('Carrier integration not available in this API version')}`)
}

export async function postEnableCarrier(req: Request, res: Response, _db: any): Promise<void> { carrierStub(req, res) }
export async function postCarrierToggle(req: Request, res: Response, _db: any): Promise<void> { carrierStub(req, res) }
export async function postCarrierLiveToggle(req: Request, res: Response, _db: any): Promise<void> { carrierStub(req, res) }
export async function postSeedRates(req: Request, res: Response, _db: any): Promise<void> { carrierStub(req, res) }
export async function postRemoveCarrierRates(req: Request, res: Response, _db: any): Promise<void> { carrierStub(req, res) }
