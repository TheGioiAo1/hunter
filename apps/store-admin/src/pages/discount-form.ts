/**
 * Discount form (create/edit) — Shopify-style 2-column layout.
 * Bám sát BE Discount.cs fields. Helpers chỉ render HTML, không gọi API.
 */

import { esc } from '../layouts/seller-layout.js'
import type { BeDiscount } from '../lib/discount-api-client.js'

export interface DiscountFormOpts {
  base: string
  csrfField: string
  action: string
  isEdit?: boolean
  discount?: BeDiscount
}

function fmtDateTimeLocal(iso: string | null | undefined): string {
  if (!iso) return ''
  // BE trả "2026-05-04T12:00:00Z" → datetime-local cần "YYYY-MM-DDTHH:mm"
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function renderDiscountForm(opts: DiscountFormOpts): string {
  const { base, csrfField, action, isEdit = false, discount = {} } = opts
  const d = discount
  const isAuto = !d.code
  const dtype = d.discount_type ?? 0  // default percent
  const rtype = d.range_type
  const ekind = d.entity ?? 1         // default product
  const status = d.status !== false   // default active
  const emails = (d.customer_emails ?? []).join('\n')

  return `
    <style>
      .df-grid{display:grid;grid-template-columns:1fr 320px;gap:20px;align-items:start}
      .df-card{background:var(--s-card-bg);border:1px solid var(--s-border);border-radius:12px;margin-bottom:16px;overflow:hidden}
      .df-card-head{padding:14px 18px;border-bottom:1px solid var(--s-border)}
      .df-card-head h3{margin:0;font-size:14px;font-weight:700;color:var(--s-text)}
      .df-card-body{padding:16px 18px;display:flex;flex-direction:column;gap:14px}
      .df-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
      .df-label{display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-secondary)}
      .df-input{width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg);color:var(--s-text);outline:none}
      .df-input:focus{border-color:var(--s-accent);box-shadow:0 0 0 2px rgba(99,102,241,.15)}
      .df-help{margin:4px 0 0;font-size:11px;color:var(--s-text-secondary)}
      .df-radio-group{display:flex;gap:8px}
      .df-radio-card{flex:1;padding:10px 12px;border:1px solid var(--s-border);border-radius:8px;cursor:pointer;font-size:13px;display:flex;align-items:center;gap:8px;background:var(--s-input-bg)}
      .df-radio-card input{accent-color:var(--s-accent)}
      .df-radio-card.active{border-color:var(--s-accent);background:rgba(99,102,241,.08)}
      .df-checkbox{display:flex;align-items:flex-start;gap:8px;font-size:13px;cursor:pointer}
      .df-checkbox input{margin-top:2px;width:16px;height:16px;accent-color:var(--s-accent)}
      .df-toggle{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:9999px;background:rgba(34,197,94,.12);color:#16a34a;font-weight:600;font-size:12px}
      .df-toggle.off{background:rgba(107,114,128,.15);color:var(--s-text-secondary)}
      .df-section-toggle{display:flex;align-items:center;justify-content:space-between;padding:10px 0;cursor:pointer}
      .df-divider{height:1px;background:var(--s-border);margin:4px 0}
    </style>

    <form method="POST" action="${action}" id="df-form">
      ${csrfField}

      <div class="df-grid">
        <!-- LEFT column -->
        <div>
          <!-- Discount kind: Code vs Auto -->
          <div class="df-card">
            <div class="df-card-head">
              <h3>Method</h3>
            </div>
            <div class="df-card-body">
              <div class="df-radio-group">
                <label class="df-radio-card ${!isAuto ? 'active' : ''}" data-method="code">
                  <input type="radio" name="method" value="code" ${!isAuto ? 'checked' : ''}>
                  <div>
                    <div style="font-weight:600">Discount code</div>
                    <div class="df-help" style="margin:0">Customer enters at checkout</div>
                  </div>
                </label>
                <label class="df-radio-card ${isAuto ? 'active' : ''}" data-method="auto">
                  <input type="radio" name="method" value="auto" ${isAuto ? 'checked' : ''}>
                  <div>
                    <div style="font-weight:600">Automatic discount</div>
                    <div class="df-help" style="margin:0">Auto-apply to eligible orders</div>
                  </div>
                </label>
              </div>

              <div id="df-code-row">
                <label class="df-label">Discount code</label>
                <div style="display:flex;gap:8px">
                  <input type="text" name="code" id="df-code" value="${esc(d.code ?? '')}" placeholder="SUMMER20" class="df-input" style="text-transform:uppercase;font-family:monospace">
                  <button type="button" class="btn btn-outline" id="df-gen-code">Generate</button>
                </div>
                <p class="df-help">Customers must enter this code at checkout. BE auto-uppercases.</p>
              </div>

              <div>
                <label class="df-label">Internal name (required)</label>
                <input type="text" name="name" value="${esc(d.name ?? '')}" required placeholder="Summer sale 2026" class="df-input">
                <p class="df-help">Internal label only. BE auto-uppercases.</p>
              </div>
            </div>
          </div>

          <!-- Discount value -->
          <div class="df-card">
            <div class="df-card-head"><h3>Value</h3></div>
            <div class="df-card-body">
              <div class="df-radio-group">
                <label class="df-radio-card ${dtype === 0 ? 'active' : ''}" data-type="0">
                  <input type="radio" name="discount_type" value="0" ${dtype === 0 ? 'checked' : ''}>
                  <span>Percentage</span>
                </label>
                <label class="df-radio-card ${dtype === 1 ? 'active' : ''}" data-type="1">
                  <input type="radio" name="discount_type" value="1" ${dtype === 1 ? 'checked' : ''}>
                  <span>Fixed amount</span>
                </label>
              </div>
              <div>
                <label class="df-label">Discount value</label>
                <div style="display:flex;gap:6px;align-items:center">
                  <input type="number" name="discount_value" value="${d.discount_value ?? ''}" step="0.01" min="0" required placeholder="10" class="df-input" style="max-width:200px">
                  <span id="df-val-suffix" style="font-weight:600;color:var(--s-text-secondary)">${dtype === 0 ? '%' : 'currency'}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Applies to (entity) -->
          <div class="df-card">
            <div class="df-card-head"><h3>Applies to</h3></div>
            <div class="df-card-body">
              <div>
                <label class="df-label">Scope</label>
                <select name="entity_scope" id="df-entity-scope" class="df-input" style="max-width:280px">
                  <option value="all" ${(d.entities ?? []).length === 0 ? 'selected' : ''}>All products</option>
                  <option value="category" ${ekind === 0 && (d.entities ?? []).length > 0 ? 'selected' : ''}>Specific categories</option>
                  <option value="product" ${ekind === 1 && (d.entities ?? []).length > 0 ? 'selected' : ''}>Specific products</option>
                </select>
              </div>

              <div id="df-entity-pick" style="display:${(d.entities ?? []).length > 0 ? 'block' : 'none'}">
                <label class="df-label" id="df-entity-label">Items</label>
                <p class="df-help" style="margin-bottom:6px">Use the <a href="${base}/products" style="color:var(--s-accent)">Products</a> page IDs (24-char ObjectId), one per line.</p>
                <textarea name="entity_ids_raw" id="df-entity-ids" rows="3" class="df-input" style="font-family:monospace;font-size:12px" placeholder="64119a58de72f16862ae831d">${esc((d.entities ?? []).map(e => e.entity_id ?? '').filter(Boolean).join('\n'))}</textarea>
                <label class="df-checkbox" style="margin-top:8px">
                  <input type="checkbox" name="entity_excluded" value="true" ${d.entity_excluded ? 'checked' : ''}>
                  <span><strong>Exclude</strong> these items instead of include</span>
                </label>
              </div>
            </div>
          </div>

          <!-- Conditions -->
          <div class="df-card">
            <div class="df-card-head"><h3>Minimum requirements</h3></div>
            <div class="df-card-body">
              <div>
                <label class="df-label">Requirement type</label>
                <select name="range_type" id="df-range-type" class="df-input" style="max-width:280px">
                  <option value="" ${rtype == null ? 'selected' : ''}>None</option>
                  <option value="0" ${rtype === 0 ? 'selected' : ''}>Minimum order subtotal</option>
                  <option value="1" ${rtype === 1 ? 'selected' : ''}>Minimum item count</option>
                </select>
              </div>
              <div id="df-range-fields" style="display:${rtype != null ? 'grid' : 'none'};grid-template-columns:1fr 1fr;gap:12px">
                <div>
                  <label class="df-label">Minimum value</label>
                  <input type="number" name="min_value" value="${d.min_value ?? ''}" step="0.01" min="0" placeholder="0" class="df-input">
                </div>
                <div>
                  <label class="df-label">Maximum value (optional)</label>
                  <input type="number" name="max_value" value="${d.max_value ?? ''}" step="0.01" min="0" placeholder="∞" class="df-input">
                </div>
              </div>
            </div>
          </div>

          <!-- Customer eligibility -->
          <div class="df-card">
            <div class="df-card-head"><h3>Customer eligibility</h3></div>
            <div class="df-card-body">
              <div>
                <label class="df-label">Limit to specific emails (optional)</label>
                <textarea name="customer_emails_raw" rows="3" class="df-input" placeholder="user1@example.com&#10;user2@example.com" style="font-family:monospace;font-size:12px">${esc(emails)}</textarea>
                <p class="df-help">One email per line. Empty = all customers.</p>
              </div>
            </div>
          </div>

          <!-- Usage limits + flags -->
          <div class="df-card">
            <div class="df-card-head"><h3>Usage limits</h3></div>
            <div class="df-card-body">
              <div class="df-row">
                <div>
                  <label class="df-label">Total uses (optional)</label>
                  <input type="number" name="usage_limit" value="${d.usage_limit ?? ''}" min="0" step="1" placeholder="Unlimited" class="df-input">
                </div>
                <div>
                  <label class="df-label">Per customer (optional)</label>
                  <input type="number" name="usage_limit_per_user" value="${d.usage_limit_per_user ?? ''}" min="0" step="1" placeholder="Unlimited" class="df-input">
                </div>
              </div>
              <label class="df-checkbox">
                <input type="checkbox" name="individual_use" value="true" ${d.individual_use ? 'checked' : ''}>
                <span>Cannot be combined with other discount codes</span>
              </label>
              <label class="df-checkbox">
                <input type="checkbox" name="excluded_sale_items" value="true" ${d.excluded_sale_items ? 'checked' : ''}>
                <span>Cannot apply to items already on sale</span>
              </label>
            </div>
          </div>

          <!-- Active dates -->
          <div class="df-card">
            <div class="df-card-head"><h3>Active dates</h3></div>
            <div class="df-card-body">
              <div class="df-row">
                <div>
                  <label class="df-label">Start date</label>
                  <input type="datetime-local" name="start_date" value="${fmtDateTimeLocal(d.start_date)}" class="df-input">
                </div>
                <div>
                  <label class="df-label">End date (optional)</label>
                  <input type="datetime-local" name="end_date" value="${fmtDateTimeLocal(d.end_date)}" class="df-input">
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- RIGHT sidebar -->
        <aside>
          <div class="df-card">
            <div class="df-card-head"><h3>Status</h3></div>
            <div class="df-card-body">
              <label class="df-checkbox" style="font-weight:600">
                <input type="checkbox" name="status" value="true" ${status ? 'checked' : ''} id="df-status">
                <span id="df-status-label">${status ? 'Active' : 'Disabled'}</span>
              </label>
              <p class="df-help">Disabled discounts won't apply at checkout.</p>
            </div>
          </div>

          <div class="df-card" style="background:rgba(59,130,246,.06);border-color:rgba(59,130,246,.25)">
            <div class="df-card-body" style="font-size:12px;color:var(--s-text)">
              <strong style="display:block;margin-bottom:6px">💡 BE notes</strong>
              <ul style="margin:0;padding-left:16px;line-height:1.6">
                <li>Name + code auto-uppercase</li>
                <li>Empty code = automatic discount</li>
                <li>Percent: value × subtotal/100</li>
                <li>Fix: value × quantity</li>
              </ul>
            </div>
          </div>
        </aside>
      </div>

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
        <a href="${base}/discounts" class="btn btn-outline">Cancel</a>
        <button type="submit" class="btn btn-primary" id="df-save">${isEdit ? 'Save changes' : 'Create discount'}</button>
      </div>
    </form>

    <script>
      ;(function(){
        // Method radio (code vs auto) → toggle code input visibility
        var codeRow = document.getElementById('df-code-row')
        var codeInp = document.getElementById('df-code')
        document.querySelectorAll('input[name="method"]').forEach(function(r){
          r.addEventListener('change', function(){
            var isAuto = r.value === 'auto' && r.checked
            codeRow.style.display = isAuto ? 'none' : ''
            if (isAuto) codeInp.value = ''
            // refresh active class
            document.querySelectorAll('.df-radio-card[data-method]').forEach(function(c){
              var input = c.querySelector('input')
              c.classList.toggle('active', input && input.checked)
            })
          })
        })
        // Init code row visibility
        var initMethod = document.querySelector('input[name="method"]:checked')
        if (initMethod) codeRow.style.display = initMethod.value === 'auto' ? 'none' : ''

        // Generate code
        document.getElementById('df-gen-code').addEventListener('click', function(){
          var s = ''
          for (var i = 0; i < 8; i++) s += 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.charAt(Math.floor(Math.random() * 32))
          codeInp.value = s
        })

        // Discount type radio → suffix label
        var suffix = document.getElementById('df-val-suffix')
        document.querySelectorAll('input[name="discount_type"]').forEach(function(r){
          r.addEventListener('change', function(){
            if (r.checked) suffix.textContent = r.value === '0' ? '%' : 'currency'
            document.querySelectorAll('.df-radio-card[data-type]').forEach(function(c){
              var input = c.querySelector('input')
              c.classList.toggle('active', input && input.checked)
            })
          })
        })

        // Entity scope → toggle picker
        var entitySel = document.getElementById('df-entity-scope')
        var entityPick = document.getElementById('df-entity-pick')
        var entityLabel = document.getElementById('df-entity-label')
        entitySel.addEventListener('change', function(){
          var v = entitySel.value
          entityPick.style.display = v === 'all' ? 'none' : 'block'
          if (entityLabel) entityLabel.textContent = v === 'product' ? 'Product IDs' : v === 'category' ? 'Category IDs' : 'Items'
        })

        // Range type → toggle min/max
        var rangeSel = document.getElementById('df-range-type')
        var rangeFields = document.getElementById('df-range-fields')
        rangeSel.addEventListener('change', function(){
          rangeFields.style.display = rangeSel.value === '' ? 'none' : 'grid'
        })

        // Status checkbox label
        var statusCb = document.getElementById('df-status')
        var statusLabel = document.getElementById('df-status-label')
        statusCb.addEventListener('change', function(){
          statusLabel.textContent = statusCb.checked ? 'Active' : 'Disabled'
        })

        // Anti-double-submit
        var form = document.getElementById('df-form')
        var saveBtn = document.getElementById('df-save')
        var origLabel = saveBtn.textContent
        function resetBtn(){ saveBtn.disabled = false; saveBtn.dataset.busy = ''; saveBtn.textContent = origLabel }
        form.addEventListener('submit', function(e){
          if (saveBtn.dataset.busy === '1') { e.preventDefault(); return }
          saveBtn.dataset.busy = '1'
          setTimeout(function(){ saveBtn.disabled = true; saveBtn.textContent = 'Saving…' }, 0)
          setTimeout(resetBtn, 15000)
        })
        window.addEventListener('pageshow', function(ev){ if (ev.persisted) resetBtn() })
      })()
    </script>
  `
}
