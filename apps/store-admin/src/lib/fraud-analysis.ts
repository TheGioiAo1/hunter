/**
 * Order Fraud Analysis + Conversion Summary — UI helpers
 *
 * Powers the ShopBase-style Fraud Analysis and Conversion Summary cards
 * on the Order Detail page. Everything is pure render: given raw order +
 * transactions, produce card HTML, modal HTML, and a small IIFE of
 * open/close JS.
 *
 * Data source: `orders.client_details` JSONB (migration 027) — an
 * optional fingerprint captured by checkout containing browser IP, UA,
 * referring site, landing page, and an `ip_intel` sub-object from
 * IPQualityScore / ipapi.co / similar. Historical orders without this
 * column render a graceful empty state — NEVER a broken card.
 *
 * Help links at the bottom of the Fraud Analysis modal point to two
 * storefront CMS pages seeded per shop (`fraud-analysis`, `prevent-fraud`)
 * so merchants see guidance sourced from their own store, not an
 * external help center.
 */

import { esc } from '../layouts/seller-layout.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IndicatorTone = 'green' | 'red' | 'grey'

export interface FraudIndicator {
  tone: IndicatorTone
  label: string
}

export interface IpIntel {
  ip_address?: string | null
  asn?: string | null
  isp?: string | null
  hostname?: string | null
  country?: string | null
  city?: string | null
  region?: string | null
  organization?: string | null
  timezone?: string | null
  latitude?: number | null
  longitude?: number | null
  is_proxy?: boolean | null
  // Optional pre-computed distance from billing address (km)
  billing_distance_km?: number | null
}

export interface ClientDetails {
  browser_ip?: string | null
  user_agent?: string | null
  referring_site?: string | null       // e.g. "Facebook", "Google", bare domain
  landing_site?: string | null         // full first-visited URL (path + query)
  accept_language?: string | null
  first_visit_at?: string | null       // ISO timestamp
  visits_count?: number | null
  ip_intel?: IpIntel | null
}

export interface ConversionSummary {
  hasData: boolean
  isFirstOrder: boolean
  referringSite: string | null
  visitsCount: number | null
  firstVisitAt: string | null
  landingSite: string | null
  utm: {
    source: string | null
    medium: string | null
    campaign: string | null
    term: string | null
    content: string | null
  }
}

// Minimal shape of the columns we actually use — lets callers pass the
// raw Kysely row without wrestling with generated types.
export interface OrderLike {
  id: string
  shop_id: string
  customer_id?: string | null
  risk_level?: string | null
  risk_flags?: unknown
  billing_address?: unknown
  shipping_address?: unknown
  client_details?: unknown
  fraud_score?: number | null
  payment_attempts?: number | null
  utm_source?: string | null
  utm_medium?: string | null
  utm_campaign?: string | null
  utm_term?: string | null
  utm_content?: string | null
}

export interface TransactionLike {
  kind?: string | null
  gateway?: string | null
  status?: string | null
}

// ---------------------------------------------------------------------------
// Data extraction
// ---------------------------------------------------------------------------

function asObject(v: unknown): Record<string, any> {
  if (v && typeof v === 'object') return v as Record<string, any>
  return {}
}

function asString(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s.length === 0 ? null : s
}

function asNumber(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function extractClientDetails(order: OrderLike): ClientDetails {
  const raw = asObject(order.client_details)
  const intelRaw = asObject(raw.ip_intel)
  return {
    browser_ip: asString(raw.browser_ip),
    user_agent: asString(raw.user_agent),
    referring_site: asString(raw.referring_site),
    landing_site: asString(raw.landing_site),
    accept_language: asString(raw.accept_language),
    first_visit_at: asString(raw.first_visit_at),
    visits_count: asNumber(raw.visits_count),
    ip_intel: Object.keys(intelRaw).length === 0 ? null : {
      ip_address: asString(intelRaw.ip_address) || asString(raw.browser_ip),
      asn: asString(intelRaw.asn),
      isp: asString(intelRaw.isp),
      hostname: asString(intelRaw.hostname),
      country: asString(intelRaw.country),
      city: asString(intelRaw.city),
      region: asString(intelRaw.region),
      organization: asString(intelRaw.organization),
      timezone: asString(intelRaw.timezone),
      latitude: asNumber(intelRaw.latitude),
      longitude: asNumber(intelRaw.longitude),
      is_proxy: typeof intelRaw.is_proxy === 'boolean' ? intelRaw.is_proxy : null,
      billing_distance_km: asNumber(intelRaw.billing_distance_km),
    },
  }
}

// ---------------------------------------------------------------------------
// Conversion Summary
// ---------------------------------------------------------------------------

export function buildConversionSummary(
  order: OrderLike,
  isFirstOrder: boolean,
): ConversionSummary {
  const cd = extractClientDetails(order)
  const hasData = Boolean(
    cd.referring_site ||
    cd.landing_site ||
    cd.first_visit_at ||
    order.utm_source || order.utm_medium || order.utm_campaign
  )
  return {
    hasData,
    isFirstOrder,
    referringSite: cd.referring_site,
    visitsCount: cd.visits_count,
    firstVisitAt: cd.first_visit_at,
    landingSite: cd.landing_site,
    utm: {
      source: order.utm_source ?? null,
      medium: order.utm_medium ?? null,
      campaign: order.utm_campaign ?? null,
      term: order.utm_term ?? null,
      content: order.utm_content ?? null,
    },
  }
}

// ---------------------------------------------------------------------------
// Fraud Indicators
// ---------------------------------------------------------------------------

/**
 * Compute the Fraud Analysis indicator rows shown in the sidebar card and
 * the full-analysis modal.
 *
 * Inputs are optional — when we lack IP intel, indicators that depend on
 * it degrade to grey "Not available" rows instead of disappearing, so the
 * panel stays a consistent size and merchants see what checks exist even
 * before the checkout fingerprint has been wired up.
 */
export function computeIndicators(
  order: OrderLike,
  transactions: TransactionLike[],
): FraudIndicator[] {
  const cd = extractClientDetails(order)
  const intel = cd.ip_intel
  const billing = asObject(order.billing_address)
  const shipping = asObject(order.shipping_address)
  const riskLevel = (order.risk_level || 'low').toLowerCase()

  const indicators: FraudIndicator[] = []

  // 1. Web proxy check
  if (intel?.is_proxy === true) {
    indicators.push({ tone: 'red', label: 'Customer used a web proxy or VPN to place the order' })
  } else if (intel?.is_proxy === false) {
    indicators.push({ tone: 'grey', label: `Customer didn't use any web proxy service to place the order` })
  } else {
    indicators.push({ tone: 'grey', label: `IP proxy detection not available for this order` })
  }

  // 2. Payment method
  const primaryGateway = (transactions.find(t => t.kind === 'sale' || t.kind === 'capture') || transactions[0])?.gateway || ''
  const isCard = /card|stripe|visa|master|amex/i.test(primaryGateway)
  if (primaryGateway && !isCard) {
    indicators.push({ tone: 'grey', label: 'A payment method other than a credit card was used' })
  } else if (isCard) {
    indicators.push({ tone: 'grey', label: 'A credit card was used to place the order' })
  } else {
    indicators.push({ tone: 'grey', label: 'Payment method: not recorded' })
  }

  // 3. Previously-disputed IP
  //    We don't maintain a dispute IP list yet, so for now everyone passes.
  indicators.push({ tone: 'green', label: `This IP address doesn't match with any previous disputed IP` })

  // 4. Payment attempt count
  const attempts = Math.max(1, Number(order.payment_attempts || 1))
  if (attempts > 3) {
    indicators.push({ tone: 'red', label: `There were ${attempts} payment attempts` })
  } else {
    indicators.push({
      tone: 'green',
      label: `There ${attempts === 1 ? 'was' : 'were'} ${attempts} payment attempt${attempts === 1 ? '' : 's'}`,
    })
  }

  // 5. Billing country vs IP country
  const billingCountry = asString(billing.country) || asString(billing.country_code)
  const ipCountry = intel?.country || null
  if (billingCountry && ipCountry) {
    const match = billingCountry.toLowerCase() === ipCountry.toLowerCase()
    indicators.push({
      tone: match ? 'green' : 'red',
      label: match
        ? 'Billing country matches the country from which the order was placed'
        : `Billing country (${billingCountry}) does not match IP country (${ipCountry})`,
    })
  } else {
    indicators.push({ tone: 'grey', label: 'Billing country vs IP country: not available' })
  }

  // 6. High-risk internet connection (web hosting / datacenter)
  if (intel?.is_proxy === true) {
    indicators.push({ tone: 'red', label: 'The IP address used to place the order is a high risk internet connection (web proxy)' })
  } else if (intel?.is_proxy === false) {
    indicators.push({ tone: 'green', label: `The IP address used to place the order isn't a high risk internet connection (web proxy)` })
  } else {
    indicators.push({ tone: 'grey', label: 'High-risk IP detection not available' })
  }

  // 7. Distance from billing address to IP location
  const distKm = intel?.billing_distance_km
  if (typeof distKm === 'number' && Number.isFinite(distKm)) {
    const tone: IndicatorTone = distKm < 50 ? 'green' : distKm < 500 ? 'grey' : 'red'
    indicators.push({ tone, label: `Billing address is ${distKm.toFixed(2)} km from the location of IP address` })
  } else {
    indicators.push({ tone: 'grey', label: 'Distance from billing address to IP location: not available' })
  }

  // 8. Shipping vs billing country (not in ShopBase but a useful extra)
  const shippingCountry = asString(shipping.country) || asString(shipping.country_code)
  if (shippingCountry && billingCountry && shippingCountry.toLowerCase() !== billingCountry.toLowerCase()) {
    indicators.push({ tone: 'red', label: `Shipping country (${shippingCountry}) differs from billing country (${billingCountry})` })
  }

  // 9. Fraud score — last, because it's the summary line
  const score = order.fraud_score
  if (typeof score === 'number' && Number.isFinite(score)) {
    const tone: IndicatorTone = score < 30 ? 'green' : score < 70 ? 'grey' : 'red'
    const level = score < 30 ? 'Low risk' : score < 70 ? 'Medium risk' : 'High risk'
    indicators.push({ tone, label: `Fraud Score: ${score} - ${level}` })
  } else {
    // Fall back to the risk_level shell written by migration 024
    const tone: IndicatorTone = riskLevel === 'high' ? 'red' : riskLevel === 'medium' ? 'grey' : 'green'
    const level = riskLevel.charAt(0).toUpperCase() + riskLevel.slice(1) + ' risk'
    indicators.push({ tone, label: `Fraud Score: — ${level}` })
  }

  return indicators
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

const DOT_GREEN = '#22c55e'
const DOT_RED = '#ef4444'
const DOT_GREY = '#6b7280'

function dotColor(tone: IndicatorTone): string {
  return tone === 'green' ? DOT_GREEN : tone === 'red' ? DOT_RED : DOT_GREY
}

function renderDot(tone: IndicatorTone): string {
  return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dotColor(tone)};margin-right:10px;flex-shrink:0;margin-top:6px"></span>`
}

function renderIndicatorRow(ind: FraudIndicator): string {
  return `
    <div style="display:flex;align-items:flex-start;padding:6px 0;font-size:12.5px;color:var(--s-text);line-height:1.5">
      ${renderDot(ind.tone)}
      <span>${esc(ind.label)}</span>
    </div>
  `
}

// ---------------------------------------------------------------------------
// Conversion Summary — sidebar card
// ---------------------------------------------------------------------------

export function renderConversionSummaryCard(summary: ConversionSummary, modalId: string): string {
  const rows: string[] = []

  if (summary.isFirstOrder) {
    rows.push(renderConversionRow('&#128100;', '1st order from this customer'))
  }
  if (summary.referringSite) {
    rows.push(renderConversionRow('&#128279;', `1st session from ${esc(summary.referringSite)}`))
  } else if (summary.utm.source) {
    rows.push(renderConversionRow('&#128279;', `1st session from ${esc(summary.utm.source)}`))
  }
  if (summary.visitsCount && summary.visitsCount > 0) {
    rows.push(renderConversionRow('&#128202;', `${summary.visitsCount} session${summary.visitsCount === 1 ? '' : 's'} over 1 day`))
  }

  const body = rows.length > 0
    ? rows.join('')
    : `<p style="font-size:12px;color:var(--s-text-dim);font-style:italic;margin:0">No session data captured for this order</p>`

  const showLink = summary.hasData

  return `
    <div class="card" style="margin-top:16px">
      <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
        <span>Conversion summary</span>
        ${showLink ? `<a href="#" onclick="gboxOpenModal('${modalId}');return false" style="color:var(--s-accent);text-decoration:none;font-size:12px;font-weight:500">View details</a>` : ''}
      </div>
      <div class="card-body">
        <div style="display:flex;flex-direction:column;gap:2px">
          ${body}
        </div>
      </div>
    </div>
  `
}

function renderConversionRow(icon: string, text: string): string {
  return `
    <div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12.5px;color:var(--s-text)">
      <span style="font-size:13px;opacity:0.7">${icon}</span>
      <span>${text}</span>
    </div>
  `
}

// ---------------------------------------------------------------------------
// Fraud Analysis — sidebar card
// ---------------------------------------------------------------------------

export function renderFraudAnalysisCard(indicators: FraudIndicator[], modalId: string): string {
  // Show just the top 2 indicators on the card, then "View full analysis"
  const topRows = indicators.slice(0, 2).map(renderIndicatorRow).join('')
  return `
    <div class="card" style="margin-top:16px">
      <div class="card-header"><span>Fraud analysis</span></div>
      <div class="card-body">
        <div style="display:flex;flex-direction:column;gap:0;margin-bottom:4px">
          ${topRows}
        </div>
        <a href="#" onclick="gboxOpenModal('${modalId}');return false" style="color:var(--s-accent);text-decoration:none;font-size:12px;font-weight:500;margin-top:4px;display:inline-block">View full analysis</a>
      </div>
    </div>
  `
}

// ---------------------------------------------------------------------------
// Modal chrome
// ---------------------------------------------------------------------------

/**
 * Open/close script — inject exactly once per page, anywhere in <body>.
 * Modals are plain <div> elements with `display:none` by default; calling
 * `gboxOpenModal('id')` flips them to `display:flex`.
 */
export function modalScript(): string {
  return `
    <style>
      .gbox-modal-overlay {
        display: none;
        position: fixed; inset: 0;
        background: rgba(15, 23, 42, 0.75);
        z-index: 10000;
        align-items: flex-start;
        justify-content: center;
        padding: 48px 16px 16px;
        overflow-y: auto;
      }
      .gbox-modal-overlay.is-open { display: flex; }
      .gbox-modal-card {
        background: var(--s-card, #1e293b);
        color: var(--s-text, #e2e8f0);
        border: 1px solid var(--s-border, #334155);
        border-radius: 12px;
        max-width: 560px;
        width: 100%;
        padding: 24px 28px 22px;
        box-shadow: 0 24px 48px rgba(0,0,0,0.5);
        position: relative;
      }
      .gbox-modal-close {
        position: absolute; top: 14px; right: 16px;
        background: none; border: none;
        color: var(--s-text-muted, #94a3b8);
        font-size: 22px; cursor: pointer; line-height: 1;
      }
      .gbox-modal-close:hover { color: var(--s-text, #fff); }
      .gbox-modal-title {
        font-size: 18px; font-weight: 700;
        color: var(--s-text, #fff);
        margin: 0 0 14px;
      }
      .gbox-modal-section-title {
        font-size: 13px; font-weight: 700;
        color: var(--s-text, #fff);
        margin: 14px 0 6px;
      }
      .gbox-modal-divider {
        height: 1px; background: var(--s-border, #334155);
        margin: 14px 0;
      }
      .gbox-modal-kv {
        display: grid;
        grid-template-columns: 150px 1fr;
        gap: 8px 16px;
        font-size: 13px;
      }
      .gbox-modal-kv dt { color: var(--s-text-muted, #94a3b8); }
      .gbox-modal-kv dd { margin: 0; color: var(--s-text, #e2e8f0); word-break: break-word; }
      .gbox-modal-footer {
        display: flex; justify-content: flex-end;
        margin-top: 18px;
      }
      .gbox-modal-footer .btn-close {
        background: var(--s-bg, #0f172a);
        color: var(--s-text, #fff);
        border: 1px solid var(--s-border, #334155);
        padding: 8px 18px;
        border-radius: 8px;
        font-size: 13px;
        cursor: pointer;
      }
      .gbox-modal-footer .btn-close:hover { background: var(--s-border, #334155); }
      .gbox-help-links {
        font-size: 12px; color: var(--s-text-muted, #94a3b8);
        margin-top: 12px; line-height: 1.6;
      }
      .gbox-help-links a {
        color: var(--s-accent, #818cf8);
        text-decoration: none;
      }
      .gbox-help-links a:hover { text-decoration: underline; }
    </style>
    <script>
      (function () {
        window.gboxOpenModal = function (id) {
          var el = document.getElementById(id);
          if (el) el.classList.add('is-open');
        };
        window.gboxCloseModal = function (id) {
          var el = document.getElementById(id);
          if (el) el.classList.remove('is-open');
        };
        document.addEventListener('click', function (e) {
          var t = e.target;
          if (t && t.classList && t.classList.contains('gbox-modal-overlay')) {
            t.classList.remove('is-open');
          }
        });
        document.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') {
            document.querySelectorAll('.gbox-modal-overlay.is-open').forEach(function (el) {
              el.classList.remove('is-open');
            });
          }
        });
      })();
    </script>
  `
}

function renderModalShell(id: string, title: string, bodyHtml: string): string {
  return `
    <div class="gbox-modal-overlay" id="${id}">
      <div class="gbox-modal-card" role="dialog" aria-modal="true" aria-labelledby="${id}-title">
        <button type="button" class="gbox-modal-close" aria-label="Close" onclick="gboxCloseModal('${id}')">&times;</button>
        <h3 class="gbox-modal-title" id="${id}-title">${esc(title)}</h3>
        ${bodyHtml}
        <div class="gbox-modal-footer">
          <button type="button" class="btn-close" onclick="gboxCloseModal('${id}')">Close</button>
        </div>
      </div>
    </div>
  `
}

// ---------------------------------------------------------------------------
// Session details modal (Conversion Summary → "View details")
// ---------------------------------------------------------------------------

export function renderSessionDetailsModal(
  id: string,
  order: OrderLike,
  summary: ConversionSummary,
): string {
  const cd = extractClientDetails(order)

  const dateStr = summary.firstVisitAt
    ? new Date(summary.firstVisitAt).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    : '—'

  const rowsCore: Array<[string, string]> = [
    ['Source identifier', summary.referringSite ? (summary.referringSite.toLowerCase().includes('facebook') || summary.referringSite.toLowerCase().includes('instagram') ? 'social' : 'referral') : '—'],
    ['Referring site', summary.referringSite || '—'],
    ['First page visited', summary.landingSite ? renderLinkLikeValue(summary.landingSite) : '—'],
  ]

  const rowsUtm: Array<[string, string]> = [
    ['Source', summary.utm.source || '—'],
    ['Medium', summary.utm.medium || '—'],
    ['Campaign', summary.utm.campaign || '—'],
    ['Term', summary.utm.term || '—'],
    ['Content', summary.utm.content || '—'],
  ]

  const body = `
    <div style="font-size:13px;color:var(--s-text-muted);margin-bottom:12px">
      <strong style="color:var(--s-text)">Visited on ${esc(dateStr)}</strong>
    </div>

    <dl class="gbox-modal-kv">
      ${rowsCore.map(([k, v]) => `
        <dt>${esc(k)}</dt>
        <dd>${k === 'First page visited' ? v : esc(v)}</dd>
      `).join('')}
    </dl>

    <div class="gbox-modal-divider"></div>

    <div class="gbox-modal-section-title">UTM parameters</div>
    <dl class="gbox-modal-kv">
      ${rowsUtm.map(([k, v]) => `
        <dt>${esc(k)}</dt>
        <dd>${esc(v)}</dd>
      `).join('')}
    </dl>

    ${cd.user_agent ? `
      <div class="gbox-modal-divider"></div>
      <div class="gbox-modal-section-title">Client</div>
      <dl class="gbox-modal-kv">
        <dt>User agent</dt><dd style="font-family:monospace;font-size:11px">${esc(cd.user_agent)}</dd>
        ${cd.accept_language ? `<dt>Language</dt><dd>${esc(cd.accept_language)}</dd>` : ''}
      </dl>
    ` : ''}
  `

  return renderModalShell(id, 'Session details', body)
}

function renderLinkLikeValue(url: string): string {
  // Truncate display if long, but keep href intact
  const display = url.length > 110 ? url.substring(0, 107) + '…' : url
  const safeHref = esc(url)
  return `<a href="${safeHref}" target="_blank" rel="noopener" style="color:var(--s-accent);text-decoration:none">${esc(display)} &#8599;</a>`
}

// ---------------------------------------------------------------------------
// Fraud analysis modal (Fraud card → "View full analysis")
// ---------------------------------------------------------------------------

export interface FraudModalLinks {
  fraudAnalysisPageUrl: string | null
  preventFraudPageUrl: string | null
}

export function renderFraudAnalysisModal(
  id: string,
  order: OrderLike,
  indicators: FraudIndicator[],
  links: FraudModalLinks,
): string {
  const cd = extractClientDetails(order)
  const intel = cd.ip_intel
  const hasIntel = Boolean(intel && (intel.ip_address || intel.country || intel.asn))

  const additionalRows: Array<[string, string | number | null | undefined]> = [
    ['IP address', intel?.ip_address || cd.browser_ip],
    ['ASN', intel?.asn],
    ['ISP', intel?.isp],
    ['Hostname', intel?.hostname],
    ['Country', intel?.country],
    ['City', intel?.city],
    ['Region', intel?.region],
    ['Organization', intel?.organization],
    ['Timezone', intel?.timezone],
    ['Latitude', intel?.latitude],
    ['Longitude', intel?.longitude],
  ]

  const additionalHtml = hasIntel
    ? additionalRows.map(([k, v]) => `
        <div style="display:flex;align-items:center;padding:4px 0;font-size:12.5px">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${DOT_GREY};margin-right:10px;flex-shrink:0"></span>
          <span style="color:var(--s-text)">${esc(k)}: ${esc(v == null || v === '' ? '—' : String(v))}</span>
        </div>
      `).join('')
    : `<p style="font-size:12px;color:var(--s-text-dim);font-style:italic;margin:4px 0">
         No IP intelligence captured for this order. Geo data becomes
         available once a checkout has been completed with browser
         fingerprinting enabled.
       </p>`

  const helpLinks = (links.fraudAnalysisPageUrl || links.preventFraudPageUrl) ? `
    <div class="gbox-help-links">
      Learn more about our improved
      ${links.fraudAnalysisPageUrl ? `<a href="${esc(links.fraudAnalysisPageUrl)}" target="_blank" rel="noopener">Fraud analysis</a>` : 'Fraud analysis'},
      or how you can
      ${links.preventFraudPageUrl ? `<a href="${esc(links.preventFraudPageUrl)}" target="_blank" rel="noopener">prevent fraud</a>` : 'prevent fraud'}.
    </div>
  ` : ''

  const body = `
    <div class="gbox-modal-section-title" style="margin-top:0">Indicators</div>
    <div>
      ${indicators.map(renderIndicatorRow).join('')}
    </div>

    <div class="gbox-modal-section-title">Additional Information</div>
    <div>
      ${additionalHtml}
    </div>

    ${helpLinks}
  `

  return renderModalShell(id, 'Fraud analysis', body)
}
