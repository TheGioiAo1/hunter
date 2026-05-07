/**
 * Store Admin — Settings > Taxes > Region detail (per-region tax config)
 *
 * Shopify-parity layout for individual region tax settings (e.g. Vietnam).
 * Visual-only — pending BE tax-policy endpoints (see BE gaps doc).
 *
 * BE TODO (xem plans/reports/be-gaps-260502-1003-payment-settings.md):
 *   GET  /api/{shop_id}/tax-region/{region_code}
 *     → { region: {code, name, flag}, base_rate: number,
 *         tax_service: 'manual'|'shopify'|'basic',
 *         active: bool, overrides: TaxOverride[] }
 *   PUT  /api/{shop_id}/tax-region/{region_code}
 *     → body: { base_rate, tax_service, active }
 *   POST /api/{shop_id}/tax-region/{region_code}/overrides
 *     → body: { product_collection_id?, country_code, rate }
 *   DELETE /api/{shop_id}/tax-region/{region_code}/overrides/{id}
 *
 * Pattern khi BE sẵn sàng: thay defaults + form action stub bằng API call.
 */

import type { Request, Response } from 'express'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import {
  createApiContext,
  findTaxSubfeeByRegion,
  upsertTaxSubfee,
  deleteSubfee,
} from '../lib/subfee-api-client.js'

// Static region registry — mirrors tax-settings.ts (single source of truth
// would be a shared module; keep duplicated here for surgical change).
const REGIONS: Record<string, { code: string; name: string; flag: string; taxService: string; defaultRate: number }> = {
  VN: { code: 'VN', name: 'Vietnam',         flag: '🇻🇳', taxService: 'Manual Tax', defaultRate: 10 },
  US: { code: 'US', name: 'United States',   flag: '🇺🇸', taxService: 'Shopify Tax', defaultRate: 0 },
  AU: { code: 'AU', name: 'Australia',       flag: '🇦🇺', taxService: 'Basic Tax',   defaultRate: 10 },
  CA: { code: 'CA', name: 'Canada',          flag: '🇨🇦', taxService: 'Basic Tax',   defaultRate: 5 },
  EU: { code: 'EU', name: 'European Union',  flag: '🇪🇺', taxService: 'Shopify Tax', defaultRate: 20 },
  HK: { code: 'HK', name: 'Hong Kong SAR',   flag: '🇭🇰', taxService: 'Manual Tax', defaultRate: 0 },
  IL: { code: 'IL', name: 'Israel',          flag: '🇮🇱', taxService: 'Manual Tax', defaultRate: 17 },
  JP: { code: 'JP', name: 'Japan',           flag: '🇯🇵', taxService: 'Manual Tax', defaultRate: 10 },
  MY: { code: 'MY', name: 'Malaysia',        flag: '🇲🇾', taxService: 'Manual Tax', defaultRate: 6 },
  NZ: { code: 'NZ', name: 'New Zealand',     flag: '🇳🇿', taxService: 'Basic Tax',   defaultRate: 15 },
  NO: { code: 'NO', name: 'Norway',          flag: '🇳🇴', taxService: 'Manual Tax', defaultRate: 25 },
  SG: { code: 'SG', name: 'Singapore',       flag: '🇸🇬', taxService: 'Manual Tax', defaultRate: 9 },
  KR: { code: 'KR', name: 'South Korea',     flag: '🇰🇷', taxService: 'Manual Tax', defaultRate: 10 },
  CH: { code: 'CH', name: 'Switzerland',     flag: '🇨🇭', taxService: 'Basic Tax',   defaultRate: 7.7 },
  AE: { code: 'AE', name: 'United Arab Emirates', flag: '🇦🇪', taxService: 'Manual Tax', defaultRate: 5 },
  UK: { code: 'UK', name: 'United Kingdom',  flag: '🇬🇧', taxService: 'Shopify Tax', defaultRate: 20 },
}

export async function getTaxRegionDetail(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const code = String(req.params.code || '').toUpperCase()

  const region = REGIONS[code]
  if (!region) {
    res.status(404).send(`<a href="${base}/settings/taxes">‹ Back to Taxes</a> · Unknown region: ${esc(code)}`)
    return
  }
  console.log('[tax-region-detail] GET csrfToken set?=', typeof req.csrfToken, 'len=', (req.csrfToken || '').length)

  // Fetch existing tax subfee from BE Order Service (subfee = tax in BE convention).
  // 1 region = 1 subfee with name prefix "Tax — " marker.
  let existingFee: any = null
  let baseRate = region.defaultRate
  let beError: string | null = null
  try {
    const ctx = createApiContext(req)
    existingFee = await findTaxSubfeeByRegion(ctx, code)
    console.log('[tax-region-detail] GET region=' + code + ' existingFee=', JSON.stringify(existingFee))
    if (existingFee) {
      // Defensive: BE may return price as `price`, `Price`, or string. Pick first finite number.
      const candidates = [existingFee.price, existingFee.Price, existingFee.amount, existingFee.rate]
      const found = candidates
        .map(v => (typeof v === 'string' ? parseFloat(v) : Number(v)))
        .find(n => Number.isFinite(n))
      baseRate = found != null ? found : region.defaultRate
    }
  } catch (err: any) {
    beError = err?.message || 'BE fetch failed'
    console.warn('[tax-region-detail] subfee fetch failed:', beError)
  }
  const isCollecting = !!existingFee
  // Tax overrides not modeled yet — would require sub-resource on subfee or
  // separate endpoint. Visual-only for now.
  const taxOverrides: Array<{ id: string; label: string; rate: number }> = []
  const successMsg = typeof req.query.success === 'string' ? req.query.success : ''
  const errorMsg = typeof req.query.error === 'string' ? req.query.error : (beError || '')

  const flashHtml = successMsg
    ? `<div class="trd-banner-ok">✓ ${esc(successMsg)}</div>`
    : ''
  const errorHtml = errorMsg
    ? `<div class="trd-banner-err">${esc(decodeURIComponent(errorMsg))}</div>`
    : ''

  const content = `
${TAX_REGION_STYLE}
<div class="trd">
  ${flashHtml}${errorHtml}
  <div class="trd-topbar">
    <a href="${base}/settings/taxes" class="trd-crumb" title="Back to Taxes">💰</a>
    <span class="trd-crumb-sep">›</span>
    <h1>${esc(region.name)}</h1>
  </div>

  <form method="POST" action="${base}/settings/taxes/regions/${esc(code)}" id="trd-form">
    ${csrfHiddenField(req.csrfToken!)}

    <!-- ─── Tax service ─── -->
    <section class="trd-card">
      <h3 class="trd-card-title">Tax service</h3>
      <div class="trd-service">
        <span class="trd-service-icon">🛍️</span>
        <div class="trd-service-info">
          <div class="trd-service-name">${esc(region.taxService)} ${isCollecting ? '<span class="trd-badge trd-badge-active"><span class="trd-dot"></span> Active</span>' : '<span class="trd-badge trd-badge-inactive">Not configured</span>'}</div>
          <div class="trd-service-meta">${isCollecting ? `Subfee ID: <code>${esc(existingFee?.id || '')}</code>` : 'Save the form to activate tax for this region'}</div>
        </div>
      </div>
    </section>

    <!-- ─── Base taxes ─── -->
    <section class="trd-card">
      <h3 class="trd-card-title">Base taxes</h3>
      <div class="trd-base-card">
        <div class="trd-base-head">
          <span style="font-weight:600;font-size:13px">Regions</span>
          <button type="button" class="trd-btn-light" id="trd-reset" data-default="${baseRate}">Reset to default tax rates</button>
        </div>
        <div class="trd-base-row">
          <span class="trd-base-name">${esc(region.name)}</span>
          <div class="trd-rate-input">
            <input type="number" name="base_rate" value="${baseRate}" min="0" max="100" step="0.01" id="trd-rate"/>
            <span class="trd-rate-suffix">%</span>
          </div>
        </div>
        <div class="trd-base-foot">
          <button type="button" class="trd-nav-btn" disabled>‹</button>
          <button type="button" class="trd-nav-btn" disabled>›</button>
        </div>
      </div>
    </section>

    <!-- ─── Tax rates and exemptions ─── -->
    <h2 class="trd-section-title">Tax rates and exemptions</h2>
    <section class="trd-card">
      <h3 class="trd-card-title">Tax overrides</h3>
      ${taxOverrides.length === 0 ? `
        <button type="button" class="trd-add-row" id="trd-add-override">
          <span class="trd-plus">⊕</span> Add override
        </button>
      ` : `
        <table class="trd-overrides-table">
          <tbody>
            ${taxOverrides.map(o => `<tr>
              <td>${esc(o.label)}</td>
              <td class="trd-num">${o.rate}%</td>
              <td><button type="button" class="trd-icon-btn" data-del="${esc(o.id)}">×</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
        <button type="button" class="trd-add-row" id="trd-add-override" style="margin-top:10px">
          <span class="trd-plus">⊕</span> Add override
        </button>
      `}
    </section>

    <div class="trd-actions">
      ${isCollecting ? `<button type="submit" name="action" value="delete" class="trd-btn-danger" onclick="return confirm('Stop collecting tax for ${esc(region.name)}? Subfee will be deleted.')">Stop collecting</button>` : ''}
      <button type="submit" name="action" value="save" class="trd-btn-primary">${isCollecting ? 'Save changes' : 'Activate tax'}</button>
    </div>

    <p class="trd-foot-link">
      <a href="https://help.gbox.co/taxes" target="_blank" rel="noopener">Learn more about sales tax</a>
    </p>
  </form>
</div>

<script>
(function(){
  // Reset to default tax rate
  var resetBtn = document.getElementById('trd-reset');
  var rateInput = document.getElementById('trd-rate');
  if (resetBtn && rateInput) {
    resetBtn.addEventListener('click', function(){
      rateInput.value = resetBtn.dataset.default || '0';
    });
  }
  // Add override (visual stub — TODO BE)
  var addBtn = document.getElementById('trd-add-override');
  if (addBtn) {
    addBtn.addEventListener('click', function(){
      alert('Add tax override — pending BE endpoint POST /api/{shop_id}/tax-region/{region_code}/overrides');
    });
  }
})();
</script>
`

  res.send(sellerLayout({
    title: `${region.name} tax`,
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

/**
 * POST handler — upsert/delete tax subfee in BE Order Service.
 * Action 'save' = upsert subfee with marker name "Tax — {region}".
 * Action 'delete' = delete the existing subfee for this region.
 */
export async function postTaxRegionDetail(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const code = String(req.params.code || '').toUpperCase()
  const base = `/admin/store/${store.slug}`
  console.log('[tax-region-detail] POST body keys=', Object.keys(req.body || {}), '_csrf?=', !!req.body?._csrf, 'rate=', req.body?.base_rate)
  const region = REGIONS[code]
  if (!region) {
    return res.redirect(`${base}/settings/taxes?error=${encodeURIComponent('Unknown region: ' + code)}`)
  }

  try {
    const ctx = createApiContext(req)
    const action = String(req.body?.action || 'save')

    if (action === 'delete') {
      const existing = await findTaxSubfeeByRegion(ctx, code)
      if (existing?.id) {
        await deleteSubfee(ctx, existing.id)
      }
      return res.redirect(`${base}/settings/taxes/regions/${encodeURIComponent(code)}?success=${encodeURIComponent('Stopped collecting tax for ' + region.name)}`)
    }

    // Save: upsert with current rate
    const rate = Number(req.body?.base_rate)
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      return res.redirect(`${base}/settings/taxes/regions/${encodeURIComponent(code)}?error=${encodeURIComponent('Invalid rate (must be 0-100)')}`)
    }
    const saved = await upsertTaxSubfee(ctx, {
      regionCode: code,
      regionName: region.name,
      rate,
    })
    console.log('[tax-region-detail] POST region=' + code + ' rate=' + rate + ' saved=', JSON.stringify(saved))
    res.redirect(`${base}/settings/taxes/regions/${encodeURIComponent(code)}?success=${encodeURIComponent('Tax saved for ' + region.name)}`)
  } catch (err: any) {
    console.error('[tax-region-detail] save failed:', err?.message || err)
    res.redirect(`${base}/settings/taxes/regions/${encodeURIComponent(code)}?error=${encodeURIComponent(err?.message || 'Save failed')}`)
  }
}

const TAX_REGION_STYLE = `<style>
.trd { color:var(--s-text); font-size:14px; max-width:820px; margin:0 auto; padding-bottom:80px; }
.trd-banner { background:rgba(245,158,11,.08); border:1px solid rgba(245,158,11,.4); border-radius:8px; padding:10px 14px; margin-bottom:18px; color:var(--s-text); font-size:12px; line-height:1.5; }
.trd-banner-ok { background:color-mix(in srgb, var(--s-success) 15%, var(--s-card)); border:1px solid var(--s-success); border-radius:8px; padding:10px 14px; margin-bottom:14px; color:var(--s-text); font-size:13px; }
.trd-banner-err { background:color-mix(in srgb, var(--s-danger) 15%, var(--s-card)); border:1px solid var(--s-danger); border-radius:8px; padding:10px 14px; margin-bottom:14px; color:var(--s-text); font-size:13px; }
.trd-badge-inactive { background:var(--s-card-hover); color:var(--s-text-muted); }
.trd-actions { display:flex; justify-content:flex-end; gap:10px; margin-top:18px; }
.trd-btn-primary { background:var(--s-accent); color:#fff; border:none; padding:9px 22px; border-radius:8px; font-size:13px; font-weight:500; cursor:pointer; font-family:inherit; }
.trd-btn-primary:hover { background:var(--s-accent-hover); }
.trd-btn-danger { background:var(--s-card); color:var(--s-danger); border:1px solid var(--s-danger); padding:9px 18px; border-radius:8px; font-size:13px; cursor:pointer; font-family:inherit; }
.trd-btn-danger:hover { background:color-mix(in srgb, var(--s-danger) 10%, var(--s-card)); }

.trd-topbar { display:flex; align-items:center; gap:8px; padding:8px 4px 16px; }
.trd-topbar h1 { margin:0; font-size:20px; font-weight:600; color:var(--s-text); }
.trd-crumb { color:var(--s-text-muted); text-decoration:none; font-size:18px; padding:4px 6px; border-radius:6px; }
.trd-crumb:hover { background:var(--s-card-hover); }
.trd-crumb-sep { color:var(--s-text-muted); }

.trd-card { background:var(--s-card); border:1px solid var(--s-border); border-radius:12px; padding:18px; box-shadow:var(--s-shadow); margin-bottom:14px; }
.trd-card-title { font-size:13px; font-weight:600; margin:0 0 14px; color:var(--s-text); }
.trd-section-title { font-size:14px; font-weight:600; margin:24px 0 10px 4px; color:var(--s-text); }

/* Tax service block */
.trd-service { display:flex; gap:12px; align-items:center; padding:14px; border:1px solid var(--s-border); border-radius:10px; background:var(--s-input-bg); }
.trd-service-icon { font-size:24px; }
.trd-service-info { flex:1; }
.trd-service-name { font-weight:600; font-size:13px; color:var(--s-text); display:flex; align-items:center; gap:8px; }
.trd-service-meta { font-size:12px; color:var(--s-text-muted); margin-top:2px; }
.trd-badge { display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:500; }
.trd-badge-active { background:color-mix(in srgb, var(--s-success) 25%, transparent); color:var(--s-success); }
.trd-dot { width:6px; height:6px; border-radius:50%; background:var(--s-success); }

/* Base taxes table */
.trd-base-card { border:1px solid var(--s-border); border-radius:8px; overflow:hidden; }
.trd-base-head { display:flex; align-items:center; justify-content:space-between; padding:10px 14px; background:var(--s-card-hover); border-bottom:1px solid var(--s-border); }
.trd-base-row { display:grid; grid-template-columns:1fr 200px; gap:16px; align-items:center; padding:14px; border-bottom:1px solid var(--s-border); }
.trd-base-name { font-weight:500; font-size:13px; color:var(--s-text); }
.trd-rate-input { display:flex; align-items:center; gap:0; border:1px solid var(--s-input-border); border-radius:8px; background:var(--s-input-bg); padding:0 12px 0 12px; }
.trd-rate-input input { width:100%; border:none; background:transparent; padding:8px 0; color:var(--s-text); font-size:13px; outline:none; font-family:inherit; }
.trd-rate-suffix { color:var(--s-text-muted); font-size:13px; }
.trd-base-foot { display:flex; justify-content:center; gap:6px; padding:10px; }

.trd-btn-light { padding:5px 12px; border:1px solid var(--s-border); background:var(--s-card); color:var(--s-text); border-radius:6px; font-size:12px; cursor:pointer; font-family:inherit; }
.trd-btn-light:hover { background:var(--s-card-hover); }
.trd-nav-btn { width:24px; height:24px; padding:0; border:1px solid var(--s-border); background:var(--s-card); color:var(--s-text-muted); border-radius:4px; cursor:pointer; }
.trd-nav-btn:disabled { opacity:.4; cursor:not-allowed; }

/* Tax overrides */
.trd-add-row { display:inline-flex; align-items:center; gap:6px; background:var(--s-card-hover); border:1px solid var(--s-border); padding:8px 14px; border-radius:8px; font-size:13px; cursor:pointer; color:var(--s-text); font-family:inherit; }
.trd-add-row:hover { background:var(--s-hover); border-color:var(--s-border-light); }
.trd-plus { color:var(--s-text-muted); font-weight:600; font-size:14px; }
.trd-overrides-table { width:100%; border-collapse:collapse; font-size:13px; }
.trd-overrides-table td { padding:10px; border-bottom:1px solid var(--s-border); }
.trd-num { text-align:right; }
.trd-icon-btn { background:none; border:none; cursor:pointer; color:var(--s-text-muted); font-size:14px; padding:2px 6px; border-radius:4px; }
.trd-icon-btn:hover { color:var(--s-danger); background:var(--s-card-hover); }

/* Footer */
.trd-foot-link { text-align:center; margin:24px 0 0; font-size:12px; color:var(--s-text-muted); }
.trd-foot-link a { color:var(--s-text-muted); text-decoration:underline; }
</style>`
