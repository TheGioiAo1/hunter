/**
 * Store Admin — Tax settings (route /settings/taxes).
 *
 * UI: bảng list các tax đã set ở trên + form thêm/sửa ở dưới.
 * Bám BE Subfee (Gbox-Order-Service /api/{shop_id}/subfee).
 *
 * Mỗi tax = 1 SubFee với:
 *  - name: "Tax — {regionName}"          ← marker filter
 *  - country_codes: [CC]                 ← region áp dụng
 *  - first_item_price + price: rate %
 *  - entity: 0, entities: null           ← apply cho tất cả product
 *
 * BE list (GET /subfee) AllowAnonymous nhưng cần country_code filter mới
 * trả data → list bằng cách iterate qua COUNTRIES + listSubfees từng cc,
 * lấy bản match TAX_NAME_PREFIX.
 */

import type { Request, Response } from 'express'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import {
  createApiContext,
  listSubfees,
  createSubfee,
  updateSubfee,
  deleteSubfee,
  getSubfee,
  TAX_NAME_PREFIX,
  type BeSubFee,
} from '../lib/subfee-api-client.js'

// 21 region phổ biến
const COUNTRIES: Array<{ code: string; name: string }> = [
  { code: 'VN', name: 'Vietnam' },
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'AU', name: 'Australia' },
  { code: 'CA', name: 'Canada' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'JP', name: 'Japan' },
  { code: 'SG', name: 'Singapore' },
  { code: 'TH', name: 'Thailand' },
  { code: 'MY', name: 'Malaysia' },
  { code: 'ID', name: 'Indonesia' },
  { code: 'PH', name: 'Philippines' },
  { code: 'CN', name: 'China' },
  { code: 'KR', name: 'South Korea' },
  { code: 'IN', name: 'India' },
  { code: 'BR', name: 'Brazil' },
  { code: 'MX', name: 'Mexico' },
  { code: 'IT', name: 'Italy' },
  { code: 'ES', name: 'Spain' },
  { code: 'NL', name: 'Netherlands' },
]

function lookupCountryName(code: string): string {
  const c = COUNTRIES.find(x => x.code.toLowerCase() === code.toLowerCase())
  return c ? c.name : code
}

// Tax subfee cho 1 region: list filter country_code, lọc theo prefix marker.
async function fetchTaxesForRegion(ctx: any, code: string): Promise<BeSubFee[]> {
  try {
    const r = await listSubfees(ctx, { country_code: code, limit: 50 })
    return (r.data || []).filter(f => typeof f.name === 'string' && f.name.startsWith(TAX_NAME_PREFIX))
  } catch (err: any) {
    console.warn(`[tax] list ${code} failed:`, err?.message)
    return []
  }
}

// ─── GET ────────────────────────────────────────────────────────────────
export async function getSurchargesPage(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const successMsg = typeof req.query.success === 'string' ? req.query.success : ''
  const errorMsg = typeof req.query.error === 'string' ? req.query.error : ''
  const csrfField = csrfHiddenField((req as any).csrfToken || '')

  // Fetch tax subfees per country (BE GET /subfee yêu cầu country_code filter
  // mới trả data — anon list không có cc trả rỗng).
  let taxes: BeSubFee[] = []
  let fetchErr: string | null = null
  try {
    const ctx = createApiContext(req)
    const results = await Promise.all(COUNTRIES.map(c => fetchTaxesForRegion(ctx, c.code)))
    taxes = results.flat()
    // Dedupe by id
    const seen = new Set<string>()
    taxes = taxes.filter(t => {
      const id = String(t.id || '')
      if (!id || seen.has(id)) return false
      seen.add(id)
      return true
    })
  } catch (err: any) {
    fetchErr = err?.message || 'Failed to load tax rates'
  }

  taxes.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))

  const FLAGS: Record<string, string> = {
    VN: '🇻🇳', US: '🇺🇸', GB: '🇬🇧', AU: '🇦🇺', CA: '🇨🇦', JP: '🇯🇵',
    KR: '🇰🇷', CN: '🇨🇳', HK: '🇭🇰', SG: '🇸🇬', MY: '🇲🇾', TH: '🇹🇭',
    ID: '🇮🇩', PH: '🇵🇭', IN: '🇮🇳', NZ: '🇳🇿', DE: '🇩🇪', FR: '🇫🇷',
    IT: '🇮🇹', ES: '🇪🇸', NL: '🇳🇱', AE: '🇦🇪', IL: '🇮🇱', BR: '🇧🇷', MX: '🇲🇽',
  }
  const rowsHtml = taxes.length === 0
    ? `<tr><td colspan="3" style="text-align:center;padding:60px 20px;color:var(--s-text-muted)">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="margin-bottom:12px;opacity:.4"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M7 10h10M7 14h6"/></svg>
        <div style="font-size:14px;font-weight:600;color:var(--s-text);margin-bottom:4px">No tax rates yet</div>
        <div style="font-size:12px">Add your first rate using the form below.</div>
      </td></tr>`
    : taxes.map(t => {
        const region = (t.country_codes && t.country_codes[0]) || '—'
        const regionName = String(t.name || '').replace(TAX_NAME_PREFIX, '') || lookupCountryName(region)
        const rate = Number(t.first_item_price ?? t.price ?? 0)
        const flag = FLAGS[region] ?? '🌐'
        return `
          <tr style="border-top:1px solid var(--s-border)">
            <td style="padding:12px 16px">
              <div style="display:flex;align-items:center;gap:10px">
                <span style="font-size:20px;line-height:1">${flag}</span>
                <div>
                  <div style="font-weight:600;font-size:13px;color:var(--s-text)">${esc(regionName)}</div>
                  <div style="font-size:11px;color:var(--s-text-muted);font-family:monospace;margin-top:2px">${esc(region)}</div>
                </div>
              </div>
            </td>
            <td style="padding:12px 16px;text-align:right">
              <span style="display:inline-block;padding:4px 12px;border-radius:6px;background:rgba(99,102,241,.12);color:var(--s-accent);font-weight:700;font-size:14px;font-family:monospace">${rate.toFixed(2)}%</span>
            </td>
            <td style="padding:12px 16px;text-align:right;white-space:nowrap">
              <button type="button" class="btn btn-outline" style="font-size:12px;padding:5px 14px"
                      onclick='gxEditTax(${JSON.stringify({ id: t.id, code: region, name: regionName, rate })})'>Edit</button>
              <form method="POST" action="${base}/settings/taxes/${esc(String(t.id || ''))}/delete" style="display:inline" onsubmit="return confirm('Delete tax rate for ${esc(regionName)}?')">
                ${csrfField}
                <button type="submit" class="btn btn-outline" style="font-size:12px;padding:5px 14px;color:var(--s-danger);border-color:color-mix(in srgb, var(--s-danger) 40%, transparent)">Delete</button>
              </form>
            </td>
          </tr>
        `
      }).join('')

  const countryOptions = COUNTRIES.map(c =>
    `<option value="${esc(c.code)}">${esc(c.name)} (${esc(c.code)})</option>`,
  ).join('')

  const content = `
    <div style="max-width:960px;margin:0 auto">
      ${successMsg ? `<div style="background:var(--s-success-bg,#065f46);color:#fff;padding:10px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">${esc(successMsg)}</div>` : ''}
      ${errorMsg ? `<div style="background:#7f1d1d;color:#fff;padding:10px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">${esc(errorMsg)}</div>` : ''}
      ${fetchErr ? `<div style="background:#7f1d1d;color:#fff;padding:10px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">Failed to load: ${esc(fetchErr)}</div>` : ''}

      <div class="page-header">
        <div>
          <h1 class="page-title" style="display:flex;align-items:center;gap:10px">
            <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4h12v9a1 1 0 01-1 1H3a1 1 0 01-1-1z"/><path d="M2 4l1-2h10l1 2"/><path d="M5 8h6M5 11h4"/></svg>
            Taxes
          </h1>
          <p class="page-subtitle">Set tax rate for each region. Applied to every product at checkout.</p>
        </div>
        <button type="button" id="gx-tax-add-btn" class="btn btn-primary" style="padding:9px 18px;font-size:13px;font-weight:600">
          + Add tax rate
        </button>
      </div>

      <!-- Add/Edit form (collapsed by default, expand khi click "Add" hoặc "Edit") -->
      <div id="gx-tax-form-card" class="card" style="margin-bottom:16px;display:none;border:2px solid var(--s-accent)">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
          <span id="gx-tax-form-title" style="font-weight:700">Add tax rate</span>
          <button type="button" id="gx-tax-close" class="btn btn-outline" style="font-size:12px;padding:4px 10px">×</button>
        </div>
        <div class="card-body">
          <form id="gx-tax-form" method="POST" action="${base}/settings/taxes" style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
            ${csrfField}
            <input type="hidden" name="region_name" id="gx-tax-region-name" value="">
            <div style="flex:2;min-width:240px">
              <label style="display:block;font-size:12px;color:var(--s-text-muted);font-weight:600;margin-bottom:4px">Region</label>
              <select name="region_code" id="gx-tax-region" required style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;background:var(--s-card);color:var(--s-text);font-size:13px">
                <option value="">— Select country —</option>
                ${countryOptions}
              </select>
            </div>
            <div style="flex:1;min-width:140px">
              <label style="display:block;font-size:12px;color:var(--s-text-muted);font-weight:600;margin-bottom:4px">Rate (%)</label>
              <input type="number" name="rate" id="gx-tax-rate" step="0.01" min="0" max="100" required placeholder="10.00" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;background:var(--s-card);color:var(--s-text);font-size:13px;font-family:monospace" />
            </div>
            <div style="display:flex;gap:8px">
              <button type="submit" class="btn btn-primary" style="padding:9px 18px;font-size:13px;font-weight:600">Save</button>
              <button type="button" id="gx-tax-cancel" class="btn btn-outline" style="font-size:13px;padding:9px 18px">Cancel</button>
            </div>
          </form>
          <p style="margin:10px 0 0;font-size:12px;color:var(--s-text-muted)">💡 Saving an existing region overwrites its rate. Editing applies immediately.</p>
        </div>
      </div>

      <!-- Tax rates table — main content -->
      <div class="card">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
          <span>Tax rates by region</span>
          <span class="badge badge-muted">${taxes.length} region${taxes.length === 1 ? '' : 's'}</span>
        </div>
        <div class="card-body" style="padding:0">
          <div class="table-wrap">
            <table style="width:100%;border-collapse:collapse">
              <thead>
                <tr style="background:var(--s-bg-input,rgba(0,0,0,.02))">
                  <th style="text-align:left;padding:10px 16px;font-size:11px;color:var(--s-text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.4px">Region</th>
                  <th style="text-align:right;padding:10px 16px;font-size:11px;color:var(--s-text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.4px">Tax rate</th>
                  <th style="text-align:right;padding:10px 16px;font-size:11px;color:var(--s-text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.4px;width:180px">Actions</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        </div>
      </div>

      <p style="text-align:center;font-size:11px;color:var(--s-text-muted);margin-top:16px">
        Powered by BE Order Service · <code style="background:var(--s-input-bg,rgba(0,0,0,.04));padding:1px 6px;border-radius:4px;font-size:11px">/api/{shop_id}/subfee</code>
      </p>
    </div>

    <script>
      ;(function(){
        var card = document.getElementById('gx-tax-form-card');
        var form = document.getElementById('gx-tax-form');
        var sel = document.getElementById('gx-tax-region');
        var nameField = document.getElementById('gx-tax-region-name');
        var rate = document.getElementById('gx-tax-rate');
        var title = document.getElementById('gx-tax-form-title');
        var cancel = document.getElementById('gx-tax-cancel');
        var closeBtn = document.getElementById('gx-tax-close');
        var addBtn = document.getElementById('gx-tax-add-btn');
        var ACTION_BASE = ${JSON.stringify(`${base}/settings/taxes`)};

        function openForm(mode){
          card.style.display = '';
          if (mode === 'add') {
            form.action = ACTION_BASE;
            sel.value = ''; nameField.value = ''; rate.value = '';
            title.textContent = 'Add tax rate';
          }
          window.scrollTo({ top: card.getBoundingClientRect().top + window.scrollY - 80, behavior: 'smooth' });
        }
        function closeForm(){
          card.style.display = 'none';
          form.action = ACTION_BASE;
          sel.value = ''; nameField.value = ''; rate.value = '';
          title.textContent = 'Add tax rate';
        }

        sel.addEventListener('change', function(){
          var opt = sel.options[sel.selectedIndex];
          nameField.value = opt ? (opt.text.replace(/\\s*\\([A-Z]+\\)$/, '')) : '';
        });

        addBtn.addEventListener('click', function(){ openForm('add'); });
        cancel.addEventListener('click', closeForm);
        closeBtn.addEventListener('click', closeForm);

        window.gxEditTax = function(t){
          openForm('edit');
          form.action = ACTION_BASE + '/' + encodeURIComponent(t.id);
          sel.value = t.code;
          nameField.value = t.name;
          rate.value = t.rate;
          title.textContent = 'Edit tax for ' + t.name;
        };
      })();
    </script>
  `

  res.send(sellerLayout({
    title: 'Taxes',
    storeName: store.name, storeSlug: store.slug,
    userName: user.name, userEmail: user.email, userRole: user.role, storeRole: user.storeRole,
    activePage: 'settings', content, theme: theme as 'dark' | 'light',
  }))
}

// ─── POST create ────────────────────────────────────────────────────────
export async function postSurchargeCreate(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}/settings/taxes`
  const code = String(req.body?.region_code || '').trim().toUpperCase()
  const name = String(req.body?.region_name || '').trim() || lookupCountryName(code)
  const rate = parseFloat(String(req.body?.rate || '0'))

  if (!code) return res.redirect(`${base}?error=${encodeURIComponent('Region is required')}`)
  if (!isFinite(rate) || rate < 0 || rate > 100) return res.redirect(`${base}?error=${encodeURIComponent('Rate must be between 0 and 100')}`)

  try {
    const ctx = createApiContext(req)
    const body: BeSubFee = {
      // BE Create không tự gán shop_id từ URL param — chỉ đọc từ body.
      // Bỏ qua → record lưu với shop_id=null → list filter loại bỏ.
      shop_id: store.id,
      name: `${TAX_NAME_PREFIX}${name}`,
      description: `Tax rate ${rate}% for ${name}`,
      country_codes: [code],
      country_excluded: false,
      price: rate,
      first_item_price: rate,
      entity: 0,
      entities: null,
      entity_excluded: false,
    }
    const created = await createSubfee(ctx, body)
    console.log('[tax-create] OK', code, rate + '%', '→ id=' + (created?.id || '?'))
    return res.redirect(`${base}?success=${encodeURIComponent('Tax rate added')}`)
  } catch (err: any) {
    console.error('[tax-create] FAIL', code, rate + '%', err?.status, '|', err?.message)
    return res.redirect(`${base}?error=${encodeURIComponent('Create failed: ' + (err?.message || 'unknown'))}`)
  }
}

// ─── POST update ────────────────────────────────────────────────────────
export async function postSurchargeUpdate(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}/settings/taxes`
  const id = String(req.params.id || '').trim()
  const code = String(req.body?.region_code || '').trim().toUpperCase()
  const name = String(req.body?.region_name || '').trim() || lookupCountryName(code)
  const rate = parseFloat(String(req.body?.rate || '0'))

  if (!id) return res.redirect(`${base}?error=${encodeURIComponent('Missing id')}`)
  if (!code) return res.redirect(`${base}?error=${encodeURIComponent('Region is required')}`)
  if (!isFinite(rate) || rate < 0 || rate > 100) return res.redirect(`${base}?error=${encodeURIComponent('Rate must be between 0 and 100')}`)

  try {
    const ctx = createApiContext(req)
    const existing = await getSubfee(ctx, id)
    if (!existing) return res.redirect(`${base}?error=${encodeURIComponent('Tax rate not found')}`)
    const merged: BeSubFee = {
      ...existing,
      name: `${TAX_NAME_PREFIX}${name}`,
      description: `Tax rate ${rate}% for ${name}`,
      country_codes: [code],
      country_excluded: false,
      price: rate,
      first_item_price: rate,
      entity: 0,
      entities: null,
      entity_excluded: false,
    }
    await updateSubfee(ctx, id, merged)
    console.log('[tax-update] OK', id, code, rate + '%')
    return res.redirect(`${base}?success=${encodeURIComponent('Tax rate updated')}`)
  } catch (err: any) {
    console.error('[tax-update] FAIL', id, err?.status, '|', err?.message)
    return res.redirect(`${base}?error=${encodeURIComponent('Update failed: ' + (err?.message || 'unknown'))}`)
  }
}

// ─── POST delete ────────────────────────────────────────────────────────
export async function postSurchargeDelete(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}/settings/taxes`
  const id = String(req.params.id || '').trim()
  if (!id) return res.redirect(`${base}?error=${encodeURIComponent('Missing id')}`)
  try {
    const ctx = createApiContext(req)
    await deleteSubfee(ctx, id)
    console.log('[tax-delete] OK', id)
    return res.redirect(`${base}?success=${encodeURIComponent('Tax rate deleted')}`)
  } catch (err: any) {
    console.error('[tax-delete] FAIL', id, err?.status, '|', err?.message)
    return res.redirect(`${base}?error=${encodeURIComponent('Delete failed: ' + (err?.message || 'unknown'))}`)
  }
}
