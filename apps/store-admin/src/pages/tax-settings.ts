/**
 * Store Admin — Taxes and duties (Shopify-style UI)
 *
 * BE Shop Service không có tax fields riêng → render với defaults +
 * regions list tĩnh (16 vùng chính: VN, US, AU, CA, EU, HK, IL, JP, MY,
 * NZ, NO, SG, KR, CH, AE, UK). Collecting status đọc từ shipping zones
 * (nếu shop có shipping zone với country_code đó → đánh dấu Collecting).
 */

import type { Request, Response } from 'express'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { createApiContext, listShippings } from '../lib/shipping-api-client.js'
import { listSubfees, TAX_NAME_PREFIX, type BeSubFee } from '../lib/subfee-api-client.js'
import { formatProductApiError } from '../lib/product-api-errors.js'

// ─── Region catalog (Shopify parity + United States added per request) ─────

interface RegionRow {
  code: string         // ISO-2 hoặc multi (EU)
  countryCodes: string[] // codes để match với shipping zones
  name: string
  flag: string         // emoji flag
  taxService: 'Manual Tax' | 'Basic Tax' | 'Shopify Tax'
}

const REGIONS: RegionRow[] = [
  { code: 'VN', countryCodes: ['VN'], name: 'Vietnam',         flag: '🇻🇳', taxService: 'Manual Tax' },
  { code: 'US', countryCodes: ['US'], name: 'United States',   flag: '🇺🇸', taxService: 'Shopify Tax' },
  { code: 'AU', countryCodes: ['AU'], name: 'Australia',       flag: '🇦🇺', taxService: 'Basic Tax' },
  { code: 'CA', countryCodes: ['CA'], name: 'Canada',          flag: '🇨🇦', taxService: 'Basic Tax' },
  { code: 'EU', countryCodes: ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'], name: 'European Union', flag: '🇪🇺', taxService: 'Shopify Tax' },
  { code: 'HK', countryCodes: ['HK'], name: 'Hong Kong SAR',   flag: '🇭🇰', taxService: 'Manual Tax' },
  { code: 'IL', countryCodes: ['IL'], name: 'Israel',          flag: '🇮🇱', taxService: 'Manual Tax' },
  { code: 'JP', countryCodes: ['JP'], name: 'Japan',           flag: '🇯🇵', taxService: 'Manual Tax' },
  { code: 'MY', countryCodes: ['MY'], name: 'Malaysia',        flag: '🇲🇾', taxService: 'Manual Tax' },
  { code: 'NZ', countryCodes: ['NZ'], name: 'New Zealand',     flag: '🇳🇿', taxService: 'Basic Tax' },
  { code: 'NO', countryCodes: ['NO'], name: 'Norway',          flag: '🇳🇴', taxService: 'Manual Tax' },
  { code: 'SG', countryCodes: ['SG'], name: 'Singapore',       flag: '🇸🇬', taxService: 'Manual Tax' },
  { code: 'KR', countryCodes: ['KR'], name: 'South Korea',     flag: '🇰🇷', taxService: 'Manual Tax' },
  { code: 'CH', countryCodes: ['CH'], name: 'Switzerland',     flag: '🇨🇭', taxService: 'Basic Tax' },
  { code: 'AE', countryCodes: ['AE'], name: 'United Arab Emirates', flag: '🇦🇪', taxService: 'Manual Tax' },
  { code: 'UK', countryCodes: ['GB'], name: 'United Kingdom',  flag: '🇬🇧', taxService: 'Shopify Tax' },
]

function notAvailableRedirect(req: Request, res: Response): void {
  const store = req.store!
  res.redirect(
    `/admin/store/${store.slug}/settings/taxes?error=${encodeURIComponent(
      'Tax management API is being migrated. Please contact Gbox support.',
    )}`,
  )
}

function taxServiceColor(svc: string): string {
  if (svc === 'Shopify Tax') return '#2563eb'
  if (svc === 'Basic Tax') return 'var(--s-text-secondary)'
  return 'var(--s-text-secondary)'
}

// ─── GET ─────

export async function getTaxSettingsPage(
  req: Request,
  res: Response,
  _db: any,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const csrfField = csrfHiddenField(req.csrfToken!)

  const flashSuccess = String(req.query.success ?? '').slice(0, 200)
  const flashError = String(req.query.error ?? '').slice(0, 200)

  // Pagination cho tax list. BE List endpoint default page=1 limit=10.
  const taxPage = Math.max(1, parseInt(String(req.query.tax_page ?? '1'), 10) || 1)
  const taxLimit = 20

  // Lấy shipping zones + tax list từ BE Order Service /subfee endpoint.
  // Bám sát SubfeeController.List(shop_id, country_code?, page, limit).
  const collectingCodes = new Set<string>()
  let taxes: BeSubFee[] = []
  let taxTotal = 0
  let apiErr: string | null = null
  try {
    const ctx = createApiContext(req)
    const [shippings, taxRes] = await Promise.all([
      listShippings(ctx),
      listSubfees(ctx, { page: taxPage, limit: taxLimit })
        .catch(() => ({ data: [] as BeSubFee[], pagination: { count: 0, page: 1, limit: taxLimit } })),
    ])
    for (const s of shippings) {
      for (const c of s.country_codes ?? []) collectingCodes.add(c.toUpperCase())
    }
    taxes = taxRes.data ?? []
    taxTotal = taxRes.pagination?.count ?? taxes.length
  } catch (err) {
    apiErr = formatProductApiError(err)
  }
  const taxTotalPages = Math.max(1, Math.ceil(taxTotal / taxLimit))

  // Group taxes theo country_code → để region table hiển thị "N taxes".
  const taxesByCountry = new Map<string, BeSubFee[]>()
  for (const sf of taxes) {
    const codes = (sf.country_codes ?? []).map(c => c.toUpperCase())
    if (codes.length === 0) {
      const arr = taxesByCountry.get('*') ?? []
      arr.push(sf)
      taxesByCountry.set('*', arr)
    } else {
      for (const c of codes) {
        const arr = taxesByCountry.get(c) ?? []
        arr.push(sf)
        taxesByCountry.set(c, arr)
      }
    }
  }

  function isCollecting(r: RegionRow): boolean {
    if (r.countryCodes.some(c => taxesByCountry.has(c))) return true
    if (taxesByCountry.has('*')) return true
    return r.countryCodes.some(c => collectingCodes.has(c))
  }

  function taxesForRegion(r: RegionRow): BeSubFee[] {
    const list: BeSubFee[] = []
    const seen = new Set<string>()
    for (const c of r.countryCodes) {
      for (const sf of taxesByCountry.get(c) ?? []) {
        if (sf.id && !seen.has(sf.id)) { list.push(sf); seen.add(sf.id) }
      }
    }
    for (const sf of taxesByCountry.get('*') ?? []) {
      if (sf.id && !seen.has(sf.id)) { list.push(sf); seen.add(sf.id) }
    }
    return list
  }

  function fmtNum(v: number | null | undefined): string {
    return v == null ? '—' : v.toFixed(2)
  }
  function fmtDate(s: string | null | undefined): string {
    if (!s) return '—'
    return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  // Default global settings (BE chưa có endpoint riêng).
  const incTaxInPrice = false
  const taxOnShipping = false
  const taxDigitalGoods = false

  const content = `
    <style>
      .gbx-flash{display:flex;align-items:center;gap:8px;padding:10px 14px;margin:0 0 16px;border-radius:8px;font-size:13px;font-weight:500}
      .gbx-flash-success{color:#065f46;background:#d1fae5;border:1px solid #a7f3d0}
      .gbx-flash-error{color:#991b1b;background:#fee2e2;border:1px solid #fecaca}
      [data-theme="dark"] .gbx-flash-success{color:#a7f3d0;background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.3)}
      [data-theme="dark"] .gbx-flash-error{color:#fecaca;background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.3)}

      .tax-card{background:var(--s-card-bg);border:1px solid var(--s-border);border-radius:12px;margin-bottom:16px;overflow:hidden}
      .tax-card-head{padding:14px 18px;border-bottom:1px solid var(--s-border);display:flex;justify-content:space-between;align-items:center;gap:12px}
      .tax-card-head h2{margin:0;font-size:14px;font-weight:700;display:flex;align-items:center;gap:6px}
      .tax-card-body{padding:14px 18px}
      .tax-help{font-size:12px;color:var(--s-text-secondary);margin:6px 0 0;line-height:1.5}
      .tax-link{color:#2563eb;text-decoration:none;font-weight:500}
      .tax-link:hover{text-decoration:underline}

      .tax-service-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--s-border);border-radius:10px;background:var(--s-input-bg)}
      .tax-service-icon{width:32px;height:32px;border-radius:8px;background:#22c55e;display:flex;align-items:center;justify-content:center;font-size:18px;color:#fff;flex-shrink:0}
      .tax-status-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block;margin-right:5px}

      .tax-region-table{width:100%;border-collapse:collapse;font-size:13px}
      .tax-region-table thead th{padding:10px 12px;text-align:left;font-size:11px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.5px;background:var(--s-input-bg);border-top:1px solid var(--s-border);border-bottom:1px solid var(--s-border)}
      .tax-region-table tbody td{padding:10px 12px;border-bottom:1px solid var(--s-border)}
      .tax-region-table tbody tr:last-child td{border-bottom:none}
      .tax-region-table tbody tr:hover{background:var(--s-hover-bg, rgba(0,0,0,.03))}
      .tax-region-flag{display:inline-block;font-size:18px;margin-right:8px;vertical-align:middle}
      .tax-region-name{color:#2563eb;font-weight:500}
      .tax-collecting-badge{display:inline-block;padding:3px 10px;border-radius:6px;background:rgba(99,102,241,.12);color:var(--s-accent);font-size:11px;font-weight:600}
      .tax-dash{color:var(--s-text-secondary)}

      .tax-toolbar{display:flex;justify-content:flex-end;gap:6px;padding:8px 12px;background:var(--s-input-bg);border-top:1px solid var(--s-border);border-bottom:1px solid var(--s-border)}
      .tax-toolbar-btn{width:30px;height:30px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--s-text-secondary)}
      .tax-toolbar-btn:hover{background:var(--s-hover-bg, rgba(0,0,0,.05))}

      .tax-pager{padding:8px 12px;display:flex;justify-content:center;gap:6px;background:var(--s-input-bg);border-top:1px solid var(--s-border)}
      .tax-pager button{width:28px;height:24px;border:1px solid var(--s-border);background:var(--s-bg);border-radius:4px;cursor:pointer;font-size:12px;color:var(--s-text-secondary)}
      .tax-pager button:disabled{opacity:.4;cursor:not-allowed}

      .tax-link-row{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;cursor:pointer}
      .tax-link-row:hover{background:var(--s-hover-bg, rgba(0,0,0,.03))}
      .tax-link-row svg{color:var(--s-text-secondary)}

      .tax-info-banner{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.25);font-size:13px;color:var(--s-text);margin-top:12px}
      [data-theme="dark"] .tax-info-banner{background:rgba(59,130,246,.12);border-color:rgba(59,130,246,.3)}

      .tax-customs-row{display:flex;justify-content:space-between;align-items:flex-start;padding:14px 0;border-bottom:1px solid var(--s-border)}
      .tax-customs-row:last-child{border-bottom:none}
      .tax-customs-row strong{font-size:13px;display:block;margin-bottom:2px}
      .tax-customs-row span{font-size:12px;color:var(--s-text-secondary)}

      .tax-checkbox-row{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid var(--s-border)}
      .tax-checkbox-row:last-child{border-bottom:none}
      .tax-checkbox-row input[type="checkbox"]{margin-top:2px;width:16px;height:16px;accent-color:var(--s-accent);flex-shrink:0}
      .tax-checkbox-row label{font-size:13px;font-weight:500;color:var(--s-text);cursor:pointer;display:block}
      .tax-checkbox-row .tax-help{margin:2px 0 0}

      .btn-secondary-outline{padding:6px 14px;border:1px solid var(--s-border);background:var(--s-bg);color:var(--s-text);border-radius:8px;font-size:13px;font-weight:500;cursor:pointer}
      .btn-secondary-outline:hover{background:var(--s-hover-bg, rgba(0,0,0,.04))}
    </style>

    <div class="page-header">
      <div>
        <a href="${base}/settings" style="color:var(--s-text-secondary);text-decoration:none;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px">&larr; Settings</a>
        <h1 class="page-title" style="display:flex;align-items:center;gap:8px">
          <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4h12v9a1 1 0 01-1 1H3a1 1 0 01-1-1z"/><path d="M2 4l1-2h10l1 2"/><path d="M5 8h6M5 11h4"/></svg>
          Taxes and duties
        </h1>
      </div>
    </div>

    ${flashSuccess ? `<div class="gbx-flash gbx-flash-success">${esc(flashSuccess)}</div>` : ''}
    ${flashError ? `<div class="gbx-flash gbx-flash-error">${esc(flashError)}</div>` : ''}
    ${apiErr ? `<div class="gbx-flash gbx-flash-error">${esc(apiErr)}</div>` : ''}

    <!-- Quick stats — số tax theo region (collapsible) -->
    ${(() => {
      const regionsWithTax = REGIONS.map(r => ({ r, list: taxesForRegion(r) })).filter(x => x.list.length > 0)
      if (regionsWithTax.length === 0) return ''
      return `
      <details class="tax-card" style="margin-bottom:16px">
        <summary style="padding:14px 18px;cursor:pointer;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;list-style:none;color:var(--s-text)">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6l4 4 4-4"/></svg>
          Coverage by region
          <span style="font-weight:500;color:var(--s-text-secondary);font-size:12px;margin-left:auto">${regionsWithTax.length} region${regionsWithTax.length === 1 ? '' : 's'}</span>
        </summary>
        <div style="padding:0 18px 14px;display:flex;flex-wrap:wrap;gap:8px">
          ${regionsWithTax.map(({ r, list }) => `
            <span style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid var(--s-border);border-radius:9999px;font-size:12px;background:var(--s-input-bg)">
              <span style="font-size:14px">${r.flag}</span>
              <span>${esc(r.name)}</span>
              <span style="padding:1px 7px;border-radius:9999px;background:var(--s-accent);color:#fff;font-weight:600;font-size:10px">${list.length}</span>
            </span>
          `).join('')}
        </div>
      </details>`
    })()}

    <!-- Tax list — bám sát BE Order Service /subfee (SubfeeController.List). -->
    <div class="tax-card">
      <div class="tax-card-head">
        <h2>
          Tax
          <span style="font-size:11px;font-weight:500;color:var(--s-text-secondary);margin-left:6px">${taxTotal} ${taxTotal === 1 ? 'record' : 'records'}</span>
        </h2>
        ${taxTotalPages > 1 ? `<span style="font-size:12px;color:var(--s-text-secondary)">Page ${taxPage} of ${taxTotalPages}</span>` : ''}
      </div>

      ${taxes.length === 0 ? `
        <div class="tax-card-body" style="text-align:center;padding:60px 20px;color:var(--s-text-secondary)">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="margin-bottom:12px"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M7 10h10M7 14h6"/></svg>
          <h3 style="margin:0 0 4px;font-size:15px;font-weight:600;color:var(--s-text)">No tax rules yet</h3>
          <p style="margin:0;font-size:13px">Tax records are managed by Gbox support.</p>
        </div>
      ` : `
        <table class="tax-region-table">
          <thead>
            <tr>
              <th style="width:35%">Tax</th>
              <th style="width:35%">Applies to</th>
              <th style="width:15%;text-align:right">Per-item amount</th>
              <th style="width:15%">Updated</th>
            </tr>
          </thead>
          <tbody>
            ${taxes.map(sf => {
              const codes = (sf.country_codes ?? []).map(c => c.toUpperCase())
              const ents = sf.entities ?? []
              // Cell "Applies to" — gộp country + entity vào 2 dòng readable
              const countryLine = codes.length === 0
                ? `<span style="color:var(--s-text-secondary)">All countries</span>`
                : `${sf.country_excluded ? '<span style="color:#ef4444;font-weight:600;font-size:11px;margin-right:4px">Except</span>' : ''}${esc(codes.slice(0, 5).join(', '))}${codes.length > 5 ? ` <span style="color:var(--s-text-secondary)">+${codes.length - 5}</span>` : ''}`
              const entityLine = ents.length === 0
                ? `<span style="color:var(--s-text-secondary)">All items</span>`
                : `${sf.entity_excluded ? '<span style="color:#ef4444;font-weight:600;font-size:11px;margin-right:4px">Except</span>' : ''}<span style="color:var(--s-text-secondary)">${sf.entity === 1 ? 'Products' : 'Categories'}:</span> ${ents.slice(0, 2).map(e => esc(e.entity_name ?? e.entity_id ?? '?')).join(', ')}${ents.length > 2 ? ` <span style="color:var(--s-text-secondary)">+${ents.length - 2}</span>` : ''}`

              // Cell "Per-item amount" — chỉ hiện 1st (+ 2nd nếu khác)
              const p1 = sf.first_item_price ?? 0
              const p2 = sf.second_item_price
              const amountCell = p2 != null && p2 !== p1
                ? `<div style="font-weight:700;font-size:13px;font-family:monospace">${p1.toFixed(2)}</div><div style="font-size:11px;color:var(--s-text-secondary);font-family:monospace">+ ${p2.toFixed(2)} per next</div>`
                : `<div style="font-weight:700;font-size:13px;font-family:monospace">${p1.toFixed(2)}</div><div style="font-size:11px;color:var(--s-text-secondary)">flat per item</div>`

              return `<tr>
                <td>
                  <div style="font-weight:600;font-size:13px;color:var(--s-text)">${esc(sf.name || '(unnamed)')}</div>
                  ${sf.description ? `<div style="font-size:11px;color:var(--s-text-secondary);margin-top:2px;line-height:1.4">${esc(sf.description)}</div>` : ''}
                </td>
                <td style="font-size:12px">
                  <div>${countryLine}</div>
                  <div style="margin-top:3px">${entityLine}</div>
                </td>
                <td style="text-align:right">${amountCell}</td>
                <td style="font-size:12px;color:var(--s-text-secondary);white-space:nowrap">${fmtDate(sf.update_date)}</td>
              </tr>`
            }).join('')}
          </tbody>
        </table>

        ${taxTotalPages > 1 ? `
          <div style="display:flex;justify-content:center;align-items:center;gap:8px;padding:12px;border-top:1px solid var(--s-border)">
            ${taxPage > 1 ? `<a href="${base}/settings/taxes?tax_page=${taxPage - 1}" class="btn btn-outline btn-sm">&lsaquo; Prev</a>` : '<button class="btn btn-outline btn-sm" disabled>&lsaquo; Prev</button>'}
            <span style="font-size:12px;color:var(--s-text-secondary)">Page ${taxPage} of ${taxTotalPages} · ${taxTotal} total</span>
            ${taxPage < taxTotalPages ? `<a href="${base}/settings/taxes?tax_page=${taxPage + 1}" class="btn btn-outline btn-sm">Next &rsaquo;</a>` : '<button class="btn btn-outline btn-sm" disabled>Next &rsaquo;</button>'}
          </div>
        ` : ''}
      `}
    </div>

    <p style="text-align:center;font-size:11px;color:var(--s-text-secondary);margin-top:16px">
      Tax amount per item = <strong>1st × 1 + 2nd × (qty − 1)</strong>
    </p>

  `

  res.send(sellerLayout({
    title: 'Taxes and duties',
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

// ─── POST stubs (BE chưa có API tax dedicated) ─────

export async function postTaxSettingsForm(req: Request, res: Response, _db: any): Promise<void> {
  notAvailableRedirect(req, res)
}
export async function postTaxRegistrationAdd(req: Request, res: Response, _db: any): Promise<void> {
  notAvailableRedirect(req, res)
}
export async function postTaxRegistrationToggle(req: Request, res: Response, _db: any): Promise<void> {
  notAvailableRedirect(req, res)
}
export async function postTaxRegistrationDelete(req: Request, res: Response, _db: any): Promise<void> {
  notAvailableRedirect(req, res)
}
export async function postTaxRateSeed(req: Request, res: Response, _db: any): Promise<void> {
  notAvailableRedirect(req, res)
}
export async function postTaxRateDelete(req: Request, res: Response, _db: any): Promise<void> {
  notAvailableRedirect(req, res)
}
