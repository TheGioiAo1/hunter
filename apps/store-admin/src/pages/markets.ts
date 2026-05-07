/**
 * Store Admin — Markets (Shopify-style)
 *
 * Markets ≈ Shipping zones (1-to-1). Mỗi shipping zone với country_codes
 * thành 1 market. Lấy data từ Shipping API (listShippings).
 */

import type { Request, Response } from 'express'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { createApiContext, listShippings, createShipping } from '../lib/shipping-api-client.js'
import { formatProductApiError } from '../lib/product-api-errors.js'
import type { ApiShipping } from '../lib/shipping-api-types.js'

// ─── Country flag map ─────

const FLAG: Record<string, string> = {
  US: '🇺🇸', VN: '🇻🇳', GB: '🇬🇧', UK: '🇬🇧', AU: '🇦🇺', CA: '🇨🇦',
  JP: '🇯🇵', KR: '🇰🇷', CN: '🇨🇳', HK: '🇭🇰', SG: '🇸🇬', MY: '🇲🇾',
  TH: '🇹🇭', ID: '🇮🇩', PH: '🇵🇭', IN: '🇮🇳', NZ: '🇳🇿',
  DE: '🇩🇪', FR: '🇫🇷', IT: '🇮🇹', ES: '🇪🇸', NL: '🇳🇱', BE: '🇧🇪',
  AT: '🇦🇹', SE: '🇸🇪', DK: '🇩🇰', FI: '🇫🇮', NO: '🇳🇴', CH: '🇨🇭',
  IE: '🇮🇪', PT: '🇵🇹', PL: '🇵🇱', CZ: '🇨🇿', GR: '🇬🇷', HU: '🇭🇺',
  AE: '🇦🇪', IL: '🇮🇱', SA: '🇸🇦', TR: '🇹🇷', BR: '🇧🇷', MX: '🇲🇽',
  AR: '🇦🇷', ZA: '🇿🇦',
}

const COUNTRY_NAME: Record<string, string> = {
  US: 'United States', VN: 'Vietnam', GB: 'United Kingdom', UK: 'United Kingdom',
  AU: 'Australia', CA: 'Canada', JP: 'Japan', KR: 'South Korea', CN: 'China',
  HK: 'Hong Kong', SG: 'Singapore', MY: 'Malaysia', TH: 'Thailand', ID: 'Indonesia',
  PH: 'Philippines', IN: 'India', NZ: 'New Zealand',
  DE: 'Germany', FR: 'France', IT: 'Italy', ES: 'Spain', NL: 'Netherlands',
  AE: 'United Arab Emirates', IL: 'Israel', BR: 'Brazil', MX: 'Mexico',
}

// EU member country codes — used to detect shippings that target EU as a region.
const EU_CODES = new Set(['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'])

// Suggested markets nếu shop chưa có shipping zone trong region.
const SUGGESTIONS = [
  { name: 'European Union', triggerCodes: Array.from(EU_CODES) },
  { name: 'Canada', triggerCodes: ['CA'] },
  { name: 'United States', triggerCodes: ['US'] },
  { name: 'United Kingdom', triggerCodes: ['GB'] },
  { name: 'Australia', triggerCodes: ['AU'] },
]

interface MarketRow {
  name: string
  flagEmoji: string
  countries: string[]
  countryNames: string[]
  hasCustomization: boolean
}

function shippingToMarket(s: ApiShipping): MarketRow {
  const codes = (s.country_codes ?? []).map(c => c.toUpperCase())
  const isEu = codes.length > 5 && codes.every(c => EU_CODES.has(c))
  const flag = isEu ? '🇪🇺' : (codes[0] ? FLAG[codes[0]] ?? '🌐' : '🌐')

  // Market column = Shipping.name. Fallback nếu BE trả null/empty:
  // dùng tên country (single) hoặc 'European Union' (EU multi).
  let name = s.name?.trim() || ''
  if (!name) {
    if (isEu) name = 'European Union'
    else if (codes.length === 1) name = COUNTRY_NAME[codes[0]] ?? codes[0]
    else if (codes.length === 0) name = 'All countries'
    else name = `${COUNTRY_NAME[codes[0]] ?? codes[0]} +${codes.length - 1}`
  }

  // Includes column = list tên quốc gia từ country_codes.
  const countryNames = isEu
    ? ['European Union']
    : codes.length === 0
      ? ['All countries']
      : codes.map(c => COUNTRY_NAME[c] ?? c)

  const hasCustomization = !!(s.shipping_methods ?? []).find(
    m => m.min_value != null || m.max_value != null,
  )

  return { name, flagEmoji: flag, countries: codes, countryNames, hasCustomization }
}

// ─── GET /markets ─────

export async function getMarkets(req: Request, res: Response, _db: any): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`

  let shippings: ApiShipping[] = []
  let errMsg: string | null = null

  try {
    const ctx = createApiContext(req)
    shippings = await listShippings(ctx)
    console.log('[markets] listShippings count=', shippings.length, 'shop=', ctx.shopId)
  } catch (err) {
    errMsg = formatProductApiError(err)
    console.error('[markets] list failed:', errMsg)
  }

  const markets = shippings.map(shippingToMarket)
  const coveredCodes = new Set(markets.flatMap(m => m.countries))
  const visibleSuggestions = SUGGESTIONS.filter(
    s => !s.triggerCodes.every(c => coveredCodes.has(c)),
  ).slice(0, 3)

  const flashError = String(req.query.error ?? '').slice(0, 200)
  const flashSuccess = String(req.query.success ?? '').slice(0, 200)

  const content = `
    <style>
      .mk-flash{display:flex;align-items:center;gap:8px;padding:10px 14px;margin:0 0 16px;border-radius:8px;font-size:13px;font-weight:500;color:#991b1b;background:#fee2e2;border:1px solid #fecaca}
      .mk-flash-ok{color:#065f46;background:#d1fae5;border:1px solid #a7f3d0}
      [data-theme="dark"] .mk-flash{color:#fecaca;background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.3)}
      [data-theme="dark"] .mk-flash-ok{color:#a7f3d0;background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.3)}

      .mk-page{display:grid;grid-template-columns:200px 1fr;gap:16px;align-items:start}

      /* Sidebar */
      .mk-side{background:var(--s-card-bg);border:1px solid var(--s-border);border-radius:12px;padding:8px}
      .mk-side-item{display:flex;align-items:center;gap:8px;padding:8px 10px;font-size:13px;color:var(--s-text);text-decoration:none;border-radius:8px}
      .mk-side-item:hover{background:var(--s-hover-bg, rgba(0,0,0,.03))}
      .mk-side-item.active{background:var(--s-input-bg);font-weight:600}
      .mk-side-folder{display:flex;align-items:center;gap:6px;padding:8px 10px;font-size:13px;color:var(--s-text-secondary);cursor:pointer;border-radius:8px;user-select:none}
      .mk-side-folder:hover{background:var(--s-hover-bg, rgba(0,0,0,.03));color:var(--s-text)}
      .mk-side-folder .mk-caret{margin-left:auto;transition:transform .15s;color:var(--s-text-secondary)}
      .mk-side-folder[data-open="true"] .mk-caret{transform:rotate(90deg)}
      .mk-side-children{list-style:none;margin:0;padding:0 0 4px 22px;display:none}
      .mk-side-folder[data-open="true"] + .mk-side-children{display:block}
      .mk-side-children .mk-side-item{padding:6px 10px;font-size:12px}
      .mk-side-children .mk-side-empty{padding:6px 10px;font-size:12px;color:var(--s-text-secondary);font-style:italic}
      @keyframes mk-flash-anim{0%{background:color-mix(in srgb,var(--s-accent) 25%,transparent)}100%{background:transparent}}
      .mk-flash{animation:mk-flash-anim 1.2s ease-out}

      /* Main */
      .mk-main{background:var(--s-card-bg);border:1px solid var(--s-border);border-radius:12px;overflow:hidden}

      .mk-toolbar{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--s-border);background:var(--s-bg)}
      .mk-toolbar-back{width:30px;height:30px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);display:flex;align-items:center;justify-content:center;color:var(--s-text-secondary);cursor:pointer}
      .mk-search{flex:1;position:relative}
      .mk-search input{width:100%;padding:7px 10px 7px 32px;border:1px solid var(--s-border);border-radius:6px;font-size:13px;background:var(--s-bg);color:var(--s-text);outline:none}
      .mk-search svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--s-text-secondary)}
      .mk-toolbar-icon{width:30px;height:30px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);display:flex;align-items:center;justify-content:center;color:var(--s-text-secondary);cursor:pointer}

      .mk-table{width:100%;border-collapse:collapse;font-size:13px}
      .mk-table thead th{padding:10px 14px;text-align:left;font-size:11px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid var(--s-border);background:var(--s-input-bg)}
      .mk-table tbody td{padding:12px 14px;border-bottom:1px solid var(--s-border)}
      .mk-table tbody tr:hover{background:var(--s-hover-bg, rgba(0,0,0,.02))}
      .mk-table tbody tr:last-child td{border-bottom:none}

      .mk-name{display:flex;align-items:center;gap:8px;color:var(--s-text);font-weight:500}
      .mk-name svg{color:var(--s-text-secondary)}
      .mk-flag{font-size:18px;line-height:1}
      .mk-active{display:inline-block;padding:3px 10px;border-radius:9999px;background:rgba(34,197,94,.15);color:#16a34a;font-size:11px;font-weight:600}
      .mk-includes{display:flex;align-items:center;gap:6px;color:var(--s-text)}
      .mk-cust-icon{color:var(--s-text-secondary)}

      .mk-suggest-row{padding:11px 14px;background:rgba(124,58,237,.06);border-bottom:1px solid var(--s-border);display:flex;align-items:center;justify-content:space-between;gap:10px}
      .mk-suggest-row:last-child{border-bottom:none}
      .mk-suggest-link{display:flex;align-items:center;gap:8px;color:#7c3aed;font-size:13px;font-weight:500;text-decoration:none}
      .mk-suggest-link:hover{text-decoration:underline}
      .mk-suggest-add{width:18px;height:18px;border-radius:50%;border:1px solid #c4b5fd;color:#7c3aed;display:inline-flex;align-items:center;justify-content:center;background:transparent;cursor:pointer}
      .mk-suggest-close{background:transparent;border:none;color:var(--s-text-secondary);cursor:pointer;font-size:14px;padding:2px 6px;border-radius:4px}
      .mk-suggest-close:hover{background:var(--s-hover-bg, rgba(0,0,0,.05))}

      .mk-footer{text-align:center;padding:18px 0;color:var(--s-text-secondary);font-size:13px}
      .mk-footer a{color:var(--s-text);text-decoration:none;font-weight:500}
      .mk-footer a:hover{text-decoration:underline}

      .mk-empty{padding:40px 20px;text-align:center;color:var(--s-text-secondary)}
    </style>

    ${flashSuccess ? `<div class="mk-flash mk-flash-ok">${esc(flashSuccess)}</div>` : ''}
    ${flashError ? `<div class="mk-flash">${esc(flashError)}</div>` : ''}
    ${errMsg ? `<div class="mk-flash">${esc(errMsg)}</div>` : ''}

    <div class="page-header">
      <div>
        <h1 class="page-title" style="margin:0;display:flex;align-items:center;gap:8px">
          <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="7"/><path d="M2 8h12M8 1c2 2 2 12 0 14M8 1c-2 2-2 12 0 14"/></svg>
          Markets
        </h1>
      </div>
      <div style="display:flex;gap:8px">
        <button type="button" class="btn btn-outline" onclick="alert('Graph view coming soon')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="vertical-align:middle;margin-right:4px"><path d="M2 14V2M14 14H2M5 11l3-4 3 2 3-5"/></svg>
          Graph view
        </button>
        <a href="${base}/markets/new" class="btn btn-primary">Create market</a>
      </div>
    </div>

    <div class="mk-page">
      <!-- Sidebar -->
      <aside class="mk-side">
        <a href="${base}/markets" class="mk-side-item active">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 7l6-5 6 5v7H2z"/></svg>
          Store default
        </a>
        <div class="mk-side-folder" data-open="false" onclick="this.dataset.open = this.dataset.open === 'true' ? 'false' : 'true'">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 5a1 1 0 011-1h3l1 2h6a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1z"/></svg>
          <span>Regions</span>
          <span class="mk-count" style="color:var(--s-text-secondary);font-size:11px">(${markets.length})</span>
          <svg class="mk-caret" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 4l4 4-4 4"/></svg>
        </div>
        <ul class="mk-side-children">
          ${markets.length === 0
            ? `<li class="mk-side-empty">Chưa có market nào</li>`
            : markets.map((m, i) => `<li>
                <a href="#mk-row-${i}" class="mk-side-item" onclick="var r=document.getElementById('mk-row-${i}');if(r){r.scrollIntoView({behavior:'smooth',block:'center'});r.classList.add('mk-flash')}">
                  <span class="mk-flag">${m.flagEmoji}</span>
                  <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.name)}</span>
                  <span style="color:var(--s-success);font-size:10px">●</span>
                </a>
              </li>`).join('')
          }
        </ul>
      </aside>

      <!-- Main -->
      <section class="mk-main">
        <div class="mk-toolbar">
          <button type="button" class="mk-toolbar-back" title="Collapse sidebar">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 4l-4 4 4 4M3 4v8"/></svg>
          </button>
          <div class="mk-search">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
            <input type="text" placeholder="Search in all markets" id="mk-search-input">
          </div>
          <button type="button" class="mk-toolbar-icon" title="Filter"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3h12l-4.5 6v4l-3 1V9z"/></svg></button>
          <button type="button" class="mk-toolbar-icon" title="Sort"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 3v10M2 6l3-3 3 3M11 13V3M14 10l-3 3-3-3"/></svg></button>
        </div>

        ${markets.length === 0 ? `
          <div class="mk-empty">
            <h3 style="margin:0 0 4px;font-size:14px;font-weight:600;color:var(--s-text)">No markets yet</h3>
            <p style="margin:0 0 14px;font-size:13px">Create a market to start selling in a new region.</p>
            <a href="${base}/markets/new" class="btn btn-primary">Create your first market</a>
          </div>
        ` : `
          <table class="mk-table">
            <thead>
              <tr>
                <th style="width:35%">Market <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" style="display:inline-block;margin-left:2px"><path d="M5 6l3-3 3 3M5 10l3 3 3-3"/></svg></th>
                <th>Status</th>
                <th>Includes</th>
                <th>Customizations</th>
              </tr>
            </thead>
            <tbody>
              ${markets.map((m, i) => `
                <tr id="mk-row-${i}">
                  <td>
                    <div class="mk-name">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 12 0 12M8 2c-2 2-2 12 0 12"/></svg>
                      ${esc(m.name)}
                    </div>
                  </td>
                  <td><span class="mk-active">Active</span></td>
                  <td>
                    <div class="mk-includes" style="flex-wrap:wrap;gap:8px">
                      ${m.countries.length === 0
                        ? `<span class="mk-flag">${m.flagEmoji}</span><span>${esc(m.countryNames[0] ?? 'All countries')}</span>`
                        : m.countries.length <= 3
                          ? m.countries.map((c, i) => `<span style="display:inline-flex;align-items:center;gap:4px"><span class="mk-flag">${FLAG[c] ?? '🌐'}</span><span>${esc(m.countryNames[i] ?? c)}</span></span>`).join('')
                          : `<span class="mk-flag">${m.flagEmoji}</span><span>${esc(m.countryNames[0])}</span><span style="color:var(--s-text-secondary);font-size:12px">+${m.countries.length - 1} more</span>`
                      }
                    </div>
                  </td>
                  <td>${m.hasCustomization ? '<span class="mk-cust-icon" title="Has price-range methods"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 5h10M3 5l3-3M3 5l3 3M13 11H3M13 11l-3-3M13 11l-3 3"/></svg></span>' : ''}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>

          ${visibleSuggestions.map(s => `
            <div class="mk-suggest-row">
              <a href="${base}/markets/new" class="mk-suggest-link">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1l1.5 5L15 8l-5.5 1.5L8 15l-1.5-5.5L1 8l5.5-1.5z"/></svg>
                Create ${esc(s.name)} Market
                <span class="mk-suggest-add">+</span>
              </a>
              <button type="button" class="mk-suggest-close" onclick="this.parentElement.style.display='none'">×</button>
            </div>
          `).join('')}
        `}
      </section>
    </div>

    <div class="mk-footer">
      <a href="#" onclick="alert('Markets help docs coming soon');return false">Learn more about markets</a>
    </div>

    <script>
      (function(){
        var s = document.getElementById('mk-search-input')
        if (!s) return
        s.addEventListener('input', function(){
          var q = s.value.trim().toLowerCase()
          var rows = document.querySelectorAll('.mk-table tbody tr')
          rows.forEach(function(r){
            r.style.display = !q || r.textContent.toLowerCase().indexOf(q) !== -1 ? '' : 'none'
          })
        })
      })()
    </script>
  `

  res.send(sellerLayout({
    title: 'Markets',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'markets',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ─── GET /markets/new — Create market form ─────

const COUNTRY_CATALOG: { code: string; name: string }[] = [
  { code: 'US', name: 'United States' }, { code: 'VN', name: 'Vietnam' },
  { code: 'GB', name: 'United Kingdom' }, { code: 'AU', name: 'Australia' },
  { code: 'CA', name: 'Canada' }, { code: 'JP', name: 'Japan' },
  { code: 'KR', name: 'South Korea' }, { code: 'CN', name: 'China' },
  { code: 'HK', name: 'Hong Kong' }, { code: 'SG', name: 'Singapore' },
  { code: 'MY', name: 'Malaysia' }, { code: 'TH', name: 'Thailand' },
  { code: 'ID', name: 'Indonesia' }, { code: 'PH', name: 'Philippines' },
  { code: 'IN', name: 'India' }, { code: 'NZ', name: 'New Zealand' },
  { code: 'DE', name: 'Germany' }, { code: 'FR', name: 'France' },
  { code: 'IT', name: 'Italy' }, { code: 'ES', name: 'Spain' },
  { code: 'NL', name: 'Netherlands' }, { code: 'BE', name: 'Belgium' },
  { code: 'AT', name: 'Austria' }, { code: 'SE', name: 'Sweden' },
  { code: 'DK', name: 'Denmark' }, { code: 'FI', name: 'Finland' },
  { code: 'NO', name: 'Norway' }, { code: 'CH', name: 'Switzerland' },
  { code: 'IE', name: 'Ireland' }, { code: 'PT', name: 'Portugal' },
  { code: 'PL', name: 'Poland' }, { code: 'AE', name: 'United Arab Emirates' },
  { code: 'IL', name: 'Israel' }, { code: 'BR', name: 'Brazil' },
  { code: 'MX', name: 'Mexico' }, { code: 'ZA', name: 'South Africa' },
]

export async function getCreateMarket(req: Request, res: Response, _db: any): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const csrfField = csrfHiddenField(req.csrfToken!)
  const flashError = String(req.query.error ?? '').slice(0, 200)

  const optionsHtml = COUNTRY_CATALOG.map(c =>
    `<option value="${c.code}">${esc(c.name)} (${c.code})</option>`
  ).join('')

  const content = renderCreateMarketForm({ base, csrfField, optionsHtml, store, flashError })

  res.send(sellerLayout({
    title: 'New market',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'markets',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ─── POST /markets — Create market (= Shipping zone) ─────

export async function postCreateMarket(req: Request, res: Response, _db: any): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const name = String(req.body.name ?? '').trim()
  const codesRaw = req.body.country_codes
  const codes: string[] = Array.isArray(codesRaw)
    ? codesRaw.map(String).map(s => s.trim().toUpperCase()).filter(Boolean)
    : codesRaw ? String(codesRaw).split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean) : []

  if (!name) {
    res.redirect(`${base}/markets/new?error=Name+is+required`)
    return
  }
  if (codes.length === 0) {
    res.redirect(`${base}/markets/new?error=Add+at+least+one+country+to+include`)
    return
  }

  try {
    const ctx = createApiContext(req)
    // Truyền shop_id explicit vào body — BE Shipping model có field shop_id
    // và một số instance BE filter mongo theo shop_id trong body, không
    // chỉ dựa URL path. An toàn hơn khi gửi cả 2.
    const created = await createShipping(ctx, {
      shop_id: ctx.shopId,
      name,
      country_codes: codes,
      shipping_methods: [],
    })
    console.log('[markets] created shipping:', created?.id, name, codes)
    res.redirect(`${base}/markets?success=${encodeURIComponent(`Market "${name}" created`)}`)
  } catch (err) {
    console.error('[markets] create failed:', err)
    res.redirect(`${base}/markets/new?error=${encodeURIComponent(formatProductApiError(err))}`)
  }
}

function renderCreateMarketForm(opts: {
  base: string
  csrfField: string
  optionsHtml: string
  store: { slug: string; name: string }
  flashError: string
}): string {
  const { base, csrfField, optionsHtml, store, flashError } = opts
  return `
    <style>
      .nm-flash{display:flex;align-items:center;gap:8px;padding:10px 14px;margin:0 0 16px;border-radius:8px;font-size:13px;font-weight:500;color:#991b1b;background:#fee2e2;border:1px solid #fecaca}
      [data-theme="dark"] .nm-flash{color:#fecaca;background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.3)}
      .nm-grid{display:grid;grid-template-columns:1fr 320px;gap:16px;align-items:start}
      .nm-card{background:var(--s-card-bg);border:1px solid var(--s-border);border-radius:12px;padding:18px;margin-bottom:16px}
      .nm-row{display:flex;gap:10px;align-items:flex-start;margin-bottom:14px}
      .nm-input{width:100%;padding:9px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg);color:var(--s-text);outline:none}
      .nm-input:focus{border-color:var(--s-accent);box-shadow:0 0 0 2px rgba(99,102,241,.15)}
      .nm-status{padding:7px 10px;border:1px solid var(--s-border);border-radius:8px;background:var(--s-input-bg);font-size:13px;color:var(--s-text);min-width:110px}
      .nm-label{display:block;font-size:12px;font-weight:600;margin-bottom:6px;color:var(--s-text-secondary)}
      .nm-includes-box{border:1px solid var(--s-border);border-radius:10px;background:var(--s-input-bg);overflow:hidden}
      .nm-includes-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px}
      .nm-includes-head strong{font-size:13px;font-weight:600;color:var(--s-text)}
      .nm-add-cond{display:inline-flex;align-items:center;gap:6px;color:#2563eb;font-size:13px;font-weight:500;background:transparent;border:none;cursor:pointer}
      .nm-add-cond:hover{text-decoration:underline}
      .nm-cond-list{padding:0 14px 12px;display:none;flex-direction:column;gap:8px}
      .nm-cond-list.open{display:flex}
      .nm-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 8px 4px 10px;border-radius:9999px;background:rgba(99,102,241,.12);color:var(--s-accent);font-size:12px;font-weight:500}
      .nm-chip button{border:none;background:transparent;color:inherit;cursor:pointer;font-size:14px;line-height:1;padding:0;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;border-radius:50%}
      .nm-chip button:hover{background:rgba(0,0,0,.1)}
      .nm-cond-empty{padding:10px 14px;font-size:12px;color:var(--s-text-secondary);font-style:italic;background:var(--s-bg);border-top:1px solid var(--s-border)}
      .nm-customized{padding:18px;background:var(--s-card-bg);border:1px solid var(--s-border);border-radius:12px;margin-bottom:8px}
      .nm-customized h3{margin:0 0 4px;font-size:13px;font-weight:700;color:var(--s-text)}
      .nm-customized p{margin:0;font-size:12px;color:var(--s-text-secondary)}
      .nm-inh-label{font-size:11px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.4px;margin:14px 0 8px;padding:0 4px}
      .nm-inh-row{display:flex;align-items:center;gap:14px;padding:10px 4px;font-size:13px}
      .nm-inh-icon{flex-shrink:0;color:var(--s-text-secondary)}
      .nm-inh-name{flex-shrink:0;font-weight:600;width:160px;color:var(--s-text)}
      .nm-inh-mid{display:flex;align-items:center;gap:6px;flex:1;color:var(--s-text);font-size:13px}
      .nm-inh-mid svg{color:var(--s-text-secondary)}
      .nm-inh-add{flex-shrink:0;width:22px;height:22px;border:1px solid var(--s-border);border-radius:50%;background:var(--s-bg);color:var(--s-text-secondary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
      .nm-inh-add:hover{background:var(--s-hover-bg, rgba(0,0,0,.05));color:var(--s-text)}
      .nm-preview{background:var(--s-card-bg);border:1px solid var(--s-border);border-radius:12px;padding:18px;text-align:center}
      .nm-preview-img{height:90px;display:flex;align-items:center;justify-content:center;color:var(--s-text-secondary)}
      .nm-preview-help{margin-top:14px;font-size:12px;color:var(--s-text-secondary);display:flex;align-items:center;justify-content:center;gap:6px}
      .nm-add-row{display:flex;gap:8px;margin-top:8px}
      .nm-add-row select{flex:1}
    </style>

    ${flashError ? `<div class="nm-flash">${esc(flashError)}</div>` : ''}

    <div class="page-header">
      <div>
        <h1 class="page-title" style="margin:0;display:flex;align-items:center;gap:8px;font-size:18px">
          <a href="${base}/markets" style="color:var(--s-text-secondary);display:inline-flex">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="7"/><path d="M2 8h12M8 1c2 2 2 14 0 14M8 1c-2 2-2 14 0 14"/></svg>
          </a>
          <span style="color:var(--s-text-secondary)">&rsaquo;</span>
          <span>New market</span>
          <span style="display:inline-block;padding:2px 10px;border-radius:9999px;background:rgba(34,197,94,.15);color:#16a34a;font-size:11px;font-weight:600">Active</span>
        </h1>
      </div>
      <div style="display:flex;gap:8px">
        <a href="${base}/markets" class="btn btn-outline">Discard</a>
        <button form="market-form" type="submit" class="btn btn-primary">Save</button>
      </div>
    </div>

    <form id="market-form" method="POST" action="${base}/markets">
      ${csrfField}
      <div class="nm-grid">
        <div>
          <div class="nm-card">
            <div class="nm-row">
              <div style="flex:1">
                <label class="nm-label">Name</label>
                <input type="text" name="name" required placeholder="e.g. Vietnam, North America" class="nm-input" autofocus>
              </div>
              <div style="padding-top:21px">
                <select class="nm-status" disabled>
                  <option>Active</option>
                </select>
              </div>
            </div>
            <div class="nm-includes-box">
              <div class="nm-includes-head">
                <strong>Includes</strong>
                <button type="button" class="nm-add-cond" onclick="document.getElementById('nm-cond-list').classList.toggle('open')">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="7"/><path d="M8 5v6M5 8h6"/></svg>
                  Add condition
                </button>
              </div>
              <div id="nm-cond-list" class="nm-cond-list">
                <div id="nm-chips" style="display:flex;flex-wrap:wrap;gap:6px;min-height:24px"></div>
                <div class="nm-add-row">
                  <select id="nm-country-select" class="nm-input">
                    <option value="">Select a country…</option>
                    ${optionsHtml}
                  </select>
                  <button type="button" class="btn btn-outline btn-sm" onclick="window.__addNmCountry()">Add</button>
                </div>
              </div>
              <div id="nm-cond-empty" class="nm-cond-empty">No conditions added. Add at least one country.</div>
            </div>
          </div>

          <div class="nm-customized">
            <h3>Customized</h3>
            <p>Create unique configurations for customers in this market</p>
          </div>

          <div class="nm-inh-label">Inherited</div>

          <div class="nm-inh-row">
            <span class="nm-inh-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 6h6M5 10h6M3 4l2-2M11 12l2 2M3 12l2 2M11 4l2-2"/></svg></span>
            <span class="nm-inh-name">Currency</span>
            <span class="nm-inh-mid"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 7l6-5 6 5v7H2z"/></svg> <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 4l4 4-4 4"/></svg> Vietnamese Dong (VND ₫)</span>
            <button type="button" class="nm-inh-add" onclick="alert('Per-market currency override coming soon')">+</button>
          </div>

          <div class="nm-inh-row">
            <span class="nm-inh-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M5 6h6M5 9h6M5 12h4"/></svg></span>
            <span class="nm-inh-name">Catalogs</span>
            <span class="nm-inh-mid"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 7l6-5 6 5v7H2z"/></svg> <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 4l4 4-4 4"/></svg> All products</span>
            <button type="button" class="nm-inh-add" onclick="alert('Per-market catalog coming soon')">+</button>
          </div>

          <div class="nm-inh-row">
            <span class="nm-inh-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="9" rx="1"/><path d="M5 14h6"/></svg></span>
            <span class="nm-inh-name">Domain / language</span>
            <span class="nm-inh-mid"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 7l6-5 6 5v7H2z"/></svg> <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 4l4 4-4 4"/></svg> ${esc(store.slug)}.gbox.co • English</span>
            <button type="button" class="nm-inh-add" onclick="alert('Per-market domain coming soon')">+</button>
          </div>

          <div class="nm-inh-row">
            <span class="nm-inh-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 6l1.5-3h9L14 6M2 6h12v8H2z"/><path d="M6 9h4"/></svg></span>
            <span class="nm-inh-name">Online Store</span>
            <span class="nm-inh-mid"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 7l6-5 6 5v7H2z"/></svg> <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 4l4 4-4 4"/></svg> Default theme</span>
          </div>

          <div class="nm-inh-row">
            <span class="nm-inh-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6" cy="13" r="1.3"/><circle cx="12" cy="13" r="1.3"/><path d="M2 3h2l1.5 8h7L14 5H5"/></svg></span>
            <span class="nm-inh-name">Checkout and accounts</span>
            <span class="nm-inh-mid"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 7l6-5 6 5v7H2z"/></svg> <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 4l4 4-4 4"/></svg> ${esc(store.name)} configuration</span>
          </div>
        </div>

        <aside>
          <div class="nm-preview">
            <div class="nm-preview-img">
              <svg width="80" height="50" viewBox="0 0 80 50" fill="none" stroke="currentColor" stroke-width="1.4">
                <rect x="6" y="20" width="14" height="14" rx="2"/>
                <circle cx="62" cy="27" r="8"/>
                <path d="M55 27h-15M40 22h-2M40 32h-2"/>
              </svg>
            </div>
            <div class="nm-preview-help">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="7"/><path d="M8 6.5v3.5M8 4h.01"/></svg>
              Save to show market hierarchy
            </div>
          </div>
        </aside>
      </div>
    </form>

    <script>
      (function(){
        var chips = []
        var sel = document.getElementById('nm-country-select')
        var wrap = document.getElementById('nm-chips')
        var emptyMsg = document.getElementById('nm-cond-empty')
        var form = document.getElementById('market-form')

        function render(){
          wrap.innerHTML = ''
          chips.forEach(function(c, i){
            var span = document.createElement('span')
            span.className = 'nm-chip'
            span.innerHTML = c.label + ' <button type="button" data-i="'+i+'">×</button>'
            wrap.appendChild(span)
          })
          emptyMsg.style.display = chips.length === 0 ? 'block' : 'none'
          form.querySelectorAll('input[name="country_codes"]').forEach(function(el){ el.remove() })
          chips.forEach(function(c){
            var hidden = document.createElement('input')
            hidden.type = 'hidden'
            hidden.name = 'country_codes'
            hidden.value = c.code
            form.appendChild(hidden)
          })
        }

        window.__addNmCountry = function(){
          var v = sel.value
          if (!v) return
          if (chips.find(function(c){ return c.code === v })) return
          var label = sel.options[sel.selectedIndex].text
          chips.push({ code: v, label: label })
          sel.value = ''
          document.getElementById('nm-cond-list').classList.add('open')
          render()
        }

        wrap.addEventListener('click', function(e){
          var t = e.target
          if (t.tagName === 'BUTTON' && t.dataset.i != null) {
            chips.splice(parseInt(t.dataset.i, 10), 1)
            render()
          }
        })

        render()
      })()
    </script>
  `
}
