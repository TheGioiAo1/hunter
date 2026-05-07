/**
 * Store Admin — Live View (Real-time activity, ShopBase-style)
 *
 * Rebuilt April 2026 to match the ShopBase layout exactly:
 *  - Header: "Live View" + as-of timestamp
 *  - 4 KPI cards: Visitors right now · Total sessions · Total sales · Total orders
 *  - World map with country-centroid order markers, legend, "Last 10 mins" tag,
 *    and zoom +/- buttons
 *  - Pageviews-per-minute line chart (last 10 min)
 *  - Customer behavior bars (Browsing · Active carts · Checking out · Purchased)
 *  - Top pages panel (top 10 paths by page view count)
 *  - Traffic sources panel (top 5 utm_source values)
 *
 * M2 upgrade (2026-04-16):
 *  - "Visitors right now" now uses `page_views` table (M1 migration 032)
 *    instead of open checkout_sessions — real storefront visitors, not
 *    just visitors who started a cart.
 *  - Pageviews chart now reads from `page_views` (real page views).
 *  - New "Browsing" bar = visitors with page views but no cart session.
 *  - New "Top pages" + "Traffic sources" panels.
 *
 * Data sources:
 *  - page_views.created_at          → visitors right now (≤5 min)
 *  - page_views.created_at          → pageviews-per-minute chart
 *  - page_views.path                → top pages panel
 *  - page_views.utm_source          → traffic sources panel
 *  - checkout_sessions.created_at   → total sessions
 *  - checkout_sessions.state        → customer behavior bars
 *  - orders.created_at              → total sales / total orders
 *  - orders.shipping_address JSONB  → map markers (country centroids)
 */

import type { Request, Response } from 'express'
import { sql, type Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { listAccessibleStores } from '../lib/user-stores.js'
import { WORLD_MAP_PATHS } from './live-view-world-paths.js'

// ─── Country centroid lookup ───────────────────────────────────────
//
// ISO-3166-1 alpha-2 → approximate country centroid (lat, lng) for the
// top 55-ish e-commerce markets. Anything outside this list silently
// drops from the map (it still counts in the KPI cards). Centroids are
// from Natural Earth; lat/lng are deliberately rough — ±1 degree is
// plenty when projected into a 1000×500 viewBox.

const COUNTRY_CENTROIDS: Record<string, { lat: number; lng: number; name: string }> = {
  US: { lat: 39, lng: -98, name: 'United States' },
  CA: { lat: 56, lng: -106, name: 'Canada' },
  MX: { lat: 23, lng: -102, name: 'Mexico' },
  BR: { lat: -14, lng: -51, name: 'Brazil' },
  AR: { lat: -38, lng: -63, name: 'Argentina' },
  CL: { lat: -35, lng: -71, name: 'Chile' },
  CO: { lat: 4, lng: -72, name: 'Colombia' },
  PE: { lat: -9, lng: -75, name: 'Peru' },
  VE: { lat: 8, lng: -66, name: 'Venezuela' },
  GB: { lat: 55, lng: -3, name: 'United Kingdom' },
  UK: { lat: 55, lng: -3, name: 'United Kingdom' },
  IE: { lat: 53, lng: -8, name: 'Ireland' },
  FR: { lat: 46, lng: 2, name: 'France' },
  DE: { lat: 51, lng: 10, name: 'Germany' },
  IT: { lat: 43, lng: 12, name: 'Italy' },
  ES: { lat: 40, lng: -3, name: 'Spain' },
  PT: { lat: 39, lng: -8, name: 'Portugal' },
  NL: { lat: 52, lng: 5, name: 'Netherlands' },
  BE: { lat: 51, lng: 4, name: 'Belgium' },
  CH: { lat: 47, lng: 8, name: 'Switzerland' },
  AT: { lat: 47, lng: 14, name: 'Austria' },
  SE: { lat: 60, lng: 18, name: 'Sweden' },
  NO: { lat: 62, lng: 8, name: 'Norway' },
  DK: { lat: 56, lng: 10, name: 'Denmark' },
  FI: { lat: 62, lng: 25, name: 'Finland' },
  PL: { lat: 52, lng: 19, name: 'Poland' },
  CZ: { lat: 50, lng: 15, name: 'Czech Republic' },
  HU: { lat: 47, lng: 19, name: 'Hungary' },
  RO: { lat: 46, lng: 25, name: 'Romania' },
  RU: { lat: 61, lng: 105, name: 'Russia' },
  UA: { lat: 49, lng: 31, name: 'Ukraine' },
  TR: { lat: 39, lng: 35, name: 'Turkey' },
  GR: { lat: 39, lng: 22, name: 'Greece' },
  EG: { lat: 26, lng: 30, name: 'Egypt' },
  ZA: { lat: -30, lng: 25, name: 'South Africa' },
  NG: { lat: 9, lng: 8, name: 'Nigeria' },
  KE: { lat: 1, lng: 38, name: 'Kenya' },
  MA: { lat: 31, lng: -7, name: 'Morocco' },
  DZ: { lat: 28, lng: 2, name: 'Algeria' },
  SA: { lat: 23, lng: 45, name: 'Saudi Arabia' },
  AE: { lat: 24, lng: 54, name: 'United Arab Emirates' },
  IL: { lat: 31, lng: 34, name: 'Israel' },
  IN: { lat: 20, lng: 77, name: 'India' },
  PK: { lat: 30, lng: 70, name: 'Pakistan' },
  BD: { lat: 24, lng: 90, name: 'Bangladesh' },
  CN: { lat: 35, lng: 104, name: 'China' },
  JP: { lat: 36, lng: 138, name: 'Japan' },
  KR: { lat: 36, lng: 127, name: 'South Korea' },
  TW: { lat: 24, lng: 121, name: 'Taiwan' },
  HK: { lat: 22, lng: 114, name: 'Hong Kong' },
  VN: { lat: 14, lng: 108, name: 'Vietnam' },
  TH: { lat: 15, lng: 100, name: 'Thailand' },
  MY: { lat: 4, lng: 102, name: 'Malaysia' },
  SG: { lat: 1, lng: 103, name: 'Singapore' },
  ID: { lat: -0.8, lng: 113, name: 'Indonesia' },
  PH: { lat: 13, lng: 122, name: 'Philippines' },
  AU: { lat: -27, lng: 133, name: 'Australia' },
  NZ: { lat: -40, lng: 174, name: 'New Zealand' },
}

interface OrderMarker {
  code: string
  name: string
  count: number
  x: number
  y: number
}

// ─── Small helpers ─────────────────────────────────────────────────

function fmtMoney(n: number, currency = 'USD'): string {
  if (currency === 'VND') return `${n.toFixed(0)} VND`
  return `$${n.toFixed(2)}`
}

/**
 * Format "Apr 15, 2026 02:18 PM" exactly matching the screenshot. We
 * don't rely on `toLocaleString` because its output varies per Node
 * version and ICU locale — this hand-formats the pieces instead.
 */
function fmtAsOf(d: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const month = months[d.getMonth()]
  const day = d.getDate()
  const year = d.getFullYear()
  let hours = d.getHours()
  const mins = String(d.getMinutes()).padStart(2, '0')
  const ampm = hours >= 12 ? 'PM' : 'AM'
  hours = hours % 12 || 12
  const hourStr = String(hours).padStart(2, '0')
  return `${month} ${day}, ${year} ${hourStr}:${mins} ${ampm}`
}

/**
 * Equirectangular projection: (lat, lng) → (x, y) within a 1000×500
 * viewBox. Used by the world map marker layer below.
 */
function projectLatLng(lat: number, lng: number): { x: number; y: number } {
  const x = ((lng + 180) / 360) * 1000
  const y = ((90 - lat) / 180) * 500
  return { x, y }
}

/**
 * Translate a country code → marker. Returns null for unknown codes
 * (e.g. bogus 3-letter codes) so the caller can silently skip them.
 */
function countryMarker(code: string, count: number): OrderMarker | null {
  const norm = code.toUpperCase().slice(0, 2)
  const centroid = COUNTRY_CENTROIDS[norm]
  if (!centroid) return null
  const { x, y } = projectLatLng(centroid.lat, centroid.lng)
  return { code: norm, name: centroid.name, count, x, y }
}

// ─── Widgets ───────────────────────────────────────────────────────

/**
 * Inline world map SVG — real country polygons from Natural Earth 1:110m
 * (via world-atlas@2/countries-110m.json), pre-projected to an
 * equirectangular 1000×500 viewBox by
 * `apps/store-admin/scripts/build-world-map-svg.mjs`. See
 * `./live-view-world-paths.ts` for the generated output (~143 KB, 177
 * countries). To regenerate after updating the source TopoJSON, re-run
 * the build script.
 *
 * Marker radius uses sqrt(count/maxCount) so a 10× difference in count
 * doesn't map to 10× radius; the ring-of-fire halo is purely visual.
 *
 * Layout choices:
 *  - viewBox 0 0 1000 500 = equirectangular (matches projectLatLng)
 *  - Light gray ocean + slightly darker gray countries → works in both
 *    dark and light themes via CSS vars
 *  - Zoom buttons are decorative (no pan/zoom JS yet); `lvZoom()` in
 *    the page script stubs the interaction so clicking still feels
 *    responsive without the full pan/zoom footprint.
 */
function buildWorldMap(markers: OrderMarker[]): string {
  const continents = `
    <rect width="1000" height="500" fill="var(--lv-ocean)" />
    <g class="lv-countries" fill="var(--lv-land)" stroke="var(--lv-land-stroke)" stroke-width="0.4" stroke-linejoin="round" stroke-linecap="round">
      ${WORLD_MAP_PATHS}
    </g>
  `

  const maxCount = Math.max(1, ...markers.map((m) => m.count))
  const markerLayer =
    markers.length === 0
      ? ''
      : markers
          .map((m) => {
            const r = 4 + Math.sqrt(m.count / maxCount) * 12
            return `
              <g class="lv-marker" transform="translate(${m.x.toFixed(1)} ${m.y.toFixed(1)})">
                <circle r="${r.toFixed(1)}" fill="#6366f1" fill-opacity="0.22"/>
                <circle r="${(r * 0.45).toFixed(1)}" fill="#6366f1"/>
                <title>${esc(m.name)} (${esc(m.code)}) · ${m.count} order${m.count === 1 ? '' : 's'}</title>
              </g>`
          })
          .join('')

  return `
    <div class="lv-map-wrap">
      <div class="lv-map-range">Last 10 mins</div>
      <div class="lv-map-zoom">
        <button type="button" class="lv-zoom-btn" onclick="lvZoom(1)" aria-label="Zoom in">+</button>
        <button type="button" class="lv-zoom-btn" onclick="lvZoom(-1)" aria-label="Zoom out">−</button>
      </div>
      <svg viewBox="0 0 1000 500" preserveAspectRatio="xMidYMid meet" class="lv-map-svg" id="lvMapSvg">
        <g id="lvMapViewport">
          ${continents}
          ${markerLayer}
        </g>
      </svg>
      <div class="lv-map-legend">
        <span class="lv-legend-item"><i class="lv-legend-order"></i>Order</span>
        <span class="lv-legend-item"><i class="lv-legend-visitor"></i>Visitor</span>
      </div>
    </div>
  `
}

/**
 * Pageviews-per-minute line chart. 10 buckets fixed — one per minute
 * over the last 10 minutes, oldest on the left, "now" on the right.
 * The y-axis auto-scales to max(points, 1) so an empty chart still
 * renders a visible baseline.
 */
function buildPageviewsChart(points: number[]): string {
  const width = 600
  const height = 160
  const padX = 36
  const padY = 20
  const innerW = width - padX * 2
  const innerH = height - padY * 2
  const max = Math.max(1, ...points)
  const step = points.length > 1 ? innerW / (points.length - 1) : 0
  const coords = points.map((v, i) => ({
    x: padX + step * i,
    y: padY + innerH - (v / max) * innerH,
    v,
  }))
  const pathD = coords
    .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(' ')
  const areaD =
    coords.length > 0
      ? `M${coords[0]!.x.toFixed(1)},${(padY + innerH).toFixed(1)} ` +
        coords.map((c) => `L${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ') +
        ` L${coords[coords.length - 1]!.x.toFixed(1)},${(padY + innerH).toFixed(1)} Z`
      : ''

  // Three y-axis ticks: 0, max/2, max
  const midY = padY + innerH / 2
  const bottomY = padY + innerH

  return `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="lv-chart-svg" aria-label="Pageviews per minute">
      <defs>
        <linearGradient id="lvPvGrad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="#6366f1" stop-opacity=".28"/>
          <stop offset="100%" stop-color="#6366f1" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <!-- Y grid -->
      <line x1="${padX}" y1="${padY}" x2="${width - padX}" y2="${padY}" stroke="var(--s-border)" stroke-width="1" stroke-dasharray="2,3"/>
      <line x1="${padX}" y1="${midY}" x2="${width - padX}" y2="${midY}" stroke="var(--s-border)" stroke-width="1" stroke-dasharray="2,3"/>
      <line x1="${padX}" y1="${bottomY}" x2="${width - padX}" y2="${bottomY}" stroke="var(--s-border)" stroke-width="1"/>
      <!-- Y labels -->
      <text x="${padX - 8}" y="${padY + 4}" fill="var(--s-text-muted)" font-size="10" text-anchor="end">${max}</text>
      <text x="${padX - 8}" y="${midY + 4}" fill="var(--s-text-muted)" font-size="10" text-anchor="end">${Math.round(max / 2)}</text>
      <text x="${padX - 8}" y="${bottomY + 4}" fill="var(--s-text-muted)" font-size="10" text-anchor="end">0</text>
      <!-- Area + line -->
      ${areaD ? `<path d="${areaD}" fill="url(#lvPvGrad)"/>` : ''}
      <path d="${pathD}" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <!-- Data dots -->
      ${coords
        .map(
          (c) =>
            `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3" fill="#6366f1"><title>${c.v} pageview${c.v === 1 ? '' : 's'}</title></circle>`,
        )
        .join('')}
    </svg>
    <div class="lv-chart-xaxis">
      <span>10 mins ago</span>
      <span>5 mins ago</span>
      <span>now</span>
    </div>
  `
}

/**
 * Horizontal bar chart for customer behavior. Three stages, scale
 * relative to the largest stage so the shortest bar is always at
 * least 2% wide for visibility.
 */
function buildBehaviorBars(browsing: number, activeCarts: number, checkingOut: number, purchased: number): string {
  const stages = [
    { label: 'Browsing', count: browsing, color: '#94a3b8' },
    { label: 'Active carts', count: activeCarts, color: '#8b5cf6' },
    { label: 'Checking out', count: checkingOut, color: '#06b6d4' },
    { label: 'Purchased', count: purchased, color: '#22c55e' },
  ]
  const max = Math.max(1, ...stages.map((s) => s.count))
  return `
    <div class="lv-behavior">
      ${stages
        .map((s) => {
          const pct = (s.count / max) * 100
          return `
            <div class="lv-behavior-row">
              <div class="lv-behavior-label">
                <i style="background:${s.color}"></i>${esc(s.label)}
              </div>
              <div class="lv-behavior-bar-wrap">
                <div class="lv-behavior-bar" style="width:${Math.max(pct, 2).toFixed(1)}%;background:${s.color}"></div>
              </div>
              <div class="lv-behavior-count">${s.count}</div>
            </div>
          `
        })
        .join('')}
    </div>
  `
}

/**
 * KPI card renderer. Matches the screenshot: small uppercase title,
 * tiny info ⓘ bubble, big value row. Color is reserved for the value
 * so the card body stays quiet.
 */
function buildKpiCard(
  title: string,
  value: string,
  info: string,
  valueColor = 'var(--s-text)',
): string {
  return `
    <div class="lv-kpi">
      <div class="lv-kpi-head">
        <span class="lv-kpi-title">${esc(title)}</span>
        <span class="lv-kpi-info" title="${esc(info)}">i</span>
      </div>
      <div class="lv-kpi-value" style="color:${valueColor}">${value}</div>
    </div>
  `
}

/**
 * Top pages table — top 10 paths by page-view count in the last 10 min.
 */
function buildTopPagesTable(pages: Array<{ path: string; views: number }>): string {
  if (pages.length === 0) {
    return '<div style="padding:12px 0;font-size:12px;color:var(--s-text-muted)">No page views in the last 10 minutes.</div>'
  }
  const maxViews = Math.max(1, ...pages.map(p => p.views))
  return `
    <div class="lv-top-list">
      ${pages.map((p, i) => {
        const pct = (p.views / maxViews) * 100
        return `
          <div class="lv-top-row">
            <span class="lv-top-rank">${i + 1}</span>
            <span class="lv-top-path" title="${esc(p.path)}">${esc(p.path)}</span>
            <div class="lv-top-bar-wrap">
              <div class="lv-top-bar" style="width:${Math.max(pct, 4).toFixed(1)}%"></div>
            </div>
            <span class="lv-top-count">${p.views}</span>
          </div>`
      }).join('')}
    </div>
  `
}

/**
 * Traffic sources mini bar chart — top 5 utm_source values (or "(direct)").
 */
function buildTrafficSourcesChart(sources: Array<{ source: string; views: number }>): string {
  if (sources.length === 0) {
    return '<div style="padding:12px 0;font-size:12px;color:var(--s-text-muted)">No traffic data in the last 10 minutes.</div>'
  }
  const maxViews = Math.max(1, ...sources.map(s => s.views))
  const colors = ['#6366f1', '#06b6d4', '#f59e0b', '#ec4899', '#22c55e']
  return `
    <div class="lv-behavior">
      ${sources.map((s, i) => {
        const pct = (s.views / maxViews) * 100
        const color = colors[i % colors.length]
        return `
          <div class="lv-behavior-row">
            <div class="lv-behavior-label">
              <i style="background:${color}"></i>${esc(s.source)}
            </div>
            <div class="lv-behavior-bar-wrap">
              <div class="lv-behavior-bar" style="width:${Math.max(pct, 2).toFixed(1)}%;background:${color}"></div>
            </div>
            <div class="lv-behavior-count">${s.views}</div>
          </div>`
      }).join('')}
    </div>
  `
}

// ─── Styles ────────────────────────────────────────────────────────

function liveViewStyles(): string {
  return `
    <style>
      /* ── Theme vars ─────────────────────────────────────────── */
      :root {
        --lv-ocean: #e8eef5;
        --lv-land: #cfd8e3;
        --lv-land-stroke: #b4c0cf;
      }
      [data-theme="dark"], .theme-dark {
        --lv-ocean: #0f1620;
        --lv-land: #242e3a;
        --lv-land-stroke: #2f3b49;
      }

      /* ── Header + toolbar ─────────────────────────────────── */
      .lv-header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:18px; flex-wrap:wrap; }
      .lv-header h1 { font-size:22px; font-weight:700; color:var(--s-text); margin:0; letter-spacing:-0.01em; display:flex; align-items:center; gap:10px; }
      .lv-live-dot { display:inline-block; width:10px; height:10px; border-radius:50%; background:#22c55e; box-shadow:0 0 0 0 rgba(34,197,94,.6); animation:lvPulse 1.6s infinite ease-in-out; }
      @keyframes lvPulse { 0%, 100% { box-shadow:0 0 0 0 rgba(34,197,94,.6); } 50% { box-shadow:0 0 0 6px rgba(34,197,94,0); } }
      .lv-asof { font-size:12px; color:var(--s-text-muted); }

      .lv-toolbar { display:flex; align-items:center; gap:12px; background:var(--s-card); border:1px solid var(--s-border); border-radius:10px; padding:10px 14px; margin-bottom:18px; flex-wrap:wrap; }
      .lv-toolbar-left { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
      .lv-store-pill { display:inline-flex; align-items:center; gap:8px; padding:6px 12px; background:var(--s-bg); border:1px solid var(--s-border); border-radius:8px; font-size:12px; color:var(--s-text-muted); cursor:pointer; font-family:inherit; transition:background .15s, border-color .15s, color .15s; }
      .lv-store-pill:hover { background:var(--s-hover, rgba(99,102,241,.08)); border-color:var(--s-accent); }
      .lv-store-pill strong { color:var(--s-text); font-weight:600; }
      .lv-store-pill-all { background:rgba(99,102,241,.12); border-color:var(--s-accent); color:var(--s-accent); }
      .lv-store-pill-all strong { color:var(--s-accent); }
      .lv-store-pill-all:hover { background:rgba(99,102,241,.2); }
      .lv-refresh { margin-left:auto; display:flex; align-items:center; gap:8px; color:var(--s-text-muted); font-size:12px; }
      .lv-refresh-dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:#22c55e; box-shadow:0 0 0 2px rgba(34,197,94,.2); }

      /* Shared dropdown menu system (mirrors analytics.ts + orders.ts) */
      .menu-wrap { position:relative; display:inline-block; }
      .menu-dropdown {
        display:none; position:absolute; top:calc(100% + 4px); left:0; z-index:100;
        min-width:220px; background:var(--s-card); border:1px solid var(--s-border);
        border-radius:8px; padding:4px; box-shadow:var(--s-shadow, 0 8px 24px rgba(0,0,0,.24));
      }
      .menu-dropdown.open { display:block; }
      .menu-item {
        display:block; padding:8px 12px; font-size:13px; color:var(--s-text);
        text-decoration:none; border-radius:6px; cursor:pointer; transition:background .15s;
      }
      .menu-item:hover { background:var(--s-hover, rgba(99,102,241,.08)); }
      .menu-item.active { background:var(--s-accent, #6366f1); color:#fff; }

      /* ── KPI cards row ─────────────────────────────────────── */
      .lv-kpi-grid { display:grid; grid-template-columns:repeat(4, 1fr); gap:16px; margin-bottom:18px; }
      @media (max-width: 1024px) { .lv-kpi-grid { grid-template-columns:repeat(2, 1fr); } }
      @media (max-width: 600px)  { .lv-kpi-grid { grid-template-columns:1fr; } }
      .lv-kpi { background:var(--s-card); border:1px solid var(--s-border); border-radius:12px; padding:18px 20px; display:flex; flex-direction:column; gap:10px; min-height:96px; }
      .lv-kpi-head { display:flex; align-items:center; gap:6px; }
      .lv-kpi-title { font-size:12px; font-weight:600; color:var(--s-text-muted); text-transform:uppercase; letter-spacing:.04em; }
      .lv-kpi-info { display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; border-radius:50%; border:1px solid var(--s-text-muted); color:var(--s-text-muted); font-size:9px; font-weight:600; cursor:help; }
      .lv-kpi-value { font-size:32px; font-weight:700; letter-spacing:-0.01em; line-height:1.1; }

      /* ── World map ─────────────────────────────────────────── */
      .lv-section { background:var(--s-card); border:1px solid var(--s-border); border-radius:12px; padding:18px 20px; margin-bottom:18px; }
      .lv-section-head { display:flex; align-items:center; gap:6px; margin-bottom:12px; }
      .lv-section-title { font-size:13px; font-weight:600; color:var(--s-text); margin:0; }
      .lv-section-info { display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; border-radius:50%; border:1px solid var(--s-text-muted); color:var(--s-text-muted); font-size:9px; font-weight:600; cursor:help; }

      .lv-map-wrap { position:relative; width:100%; min-height:360px; background:var(--lv-ocean); border-radius:10px; overflow:hidden; }
      .lv-map-svg { width:100%; height:auto; display:block; }
      #lvMapViewport { transform-origin:500px 250px; transition:transform .25s ease; }

      .lv-map-range { position:absolute; top:12px; left:12px; background:var(--s-card); border:1px solid var(--s-border); border-radius:999px; padding:4px 10px; font-size:11px; color:var(--s-text); font-weight:500; box-shadow:0 2px 6px rgba(0,0,0,.08); }
      .lv-map-zoom { position:absolute; top:12px; right:12px; display:flex; flex-direction:column; gap:4px; background:var(--s-card); border:1px solid var(--s-border); border-radius:6px; overflow:hidden; box-shadow:0 2px 6px rgba(0,0,0,.08); }
      .lv-zoom-btn { width:28px; height:28px; background:transparent; border:0; color:var(--s-text); font-size:16px; line-height:1; cursor:pointer; font-family:inherit; padding:0; }
      .lv-zoom-btn:hover { background:var(--s-hover, rgba(99,102,241,.08)); }
      .lv-zoom-btn + .lv-zoom-btn { border-top:1px solid var(--s-border); }

      .lv-map-legend { position:absolute; bottom:12px; left:12px; display:flex; gap:16px; background:var(--s-card); border:1px solid var(--s-border); border-radius:999px; padding:6px 14px; font-size:11px; color:var(--s-text-muted); box-shadow:0 2px 6px rgba(0,0,0,.08); }
      .lv-legend-item { display:inline-flex; align-items:center; gap:6px; }
      .lv-legend-item i { display:inline-block; width:10px; height:10px; border-radius:50%; }
      .lv-legend-order { background:#6366f1; }
      .lv-legend-visitor { background:#06b6d4; }

      /* ── Charts row ───────────────────────────────────────── */
      .lv-charts-grid { display:grid; grid-template-columns:1.4fr 1fr; gap:16px; margin-bottom:18px; }
      @media (max-width: 1024px) { .lv-charts-grid { grid-template-columns:1fr; } }
      .lv-chart-svg { width:100%; height:180px; display:block; }
      .lv-chart-xaxis { display:flex; justify-content:space-between; padding:0 10px; font-size:11px; color:var(--s-text-muted); margin-top:6px; }

      .lv-behavior { display:flex; flex-direction:column; gap:14px; padding-top:6px; }
      .lv-behavior-row { display:grid; grid-template-columns:120px 1fr 46px; gap:12px; align-items:center; font-size:12px; }
      .lv-behavior-label { display:flex; align-items:center; gap:8px; color:var(--s-text); }
      .lv-behavior-label i { display:inline-block; width:8px; height:8px; border-radius:50%; flex-shrink:0; }
      .lv-behavior-bar-wrap { background:var(--s-bg); height:14px; border-radius:7px; overflow:hidden; }
      .lv-behavior-bar { height:100%; border-radius:7px; transition:width .4s ease; }
      .lv-behavior-count { text-align:right; font-weight:700; color:var(--s-text); font-size:14px; }

      /* ── Top pages list (M2) ──────────────────────────────── */
      .lv-top-list { display:flex; flex-direction:column; gap:6px; padding-top:4px; }
      .lv-top-row { display:grid; grid-template-columns:24px 1fr 120px 46px; gap:8px; align-items:center; font-size:12px; padding:4px 0; }
      .lv-top-rank { color:var(--s-text-muted); font-weight:600; text-align:center; font-size:11px; }
      .lv-top-path { color:var(--s-text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500; }
      .lv-top-bar-wrap { background:var(--s-bg); height:14px; border-radius:7px; overflow:hidden; }
      .lv-top-bar { height:100%; border-radius:7px; background:#6366f1; transition:width .4s ease; }
      .lv-top-count { text-align:right; font-weight:700; color:var(--s-text); font-size:13px; }
    </style>
  `
}

// ─── GET /admin/store/:slug/analytics/live ─────────────────────────

export async function getLiveView(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`

  // ── Multistore scope ─────────────────────────────────────────
  // Same pattern as the overview dashboard: pre-fetch the accessible
  // store list, let ?scope=all activate the multi-store aggregation.
  const accessibleStores = await listAccessibleStores(db, user.id, user.role)
  const canSwitchStores = accessibleStores.length > 1
  const scope: 'all' | 'single' =
    req.query.scope === 'all' && canSwitchStores ? 'all' : 'single'
  const storeIds: string[] =
    scope === 'all' && accessibleStores.length > 0
      ? accessibleStores.map((s) => s.id)
      : [store.id]

  // ── Time windows ─────────────────────────────────────────────
  const now = new Date()
  const tenMinsAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString()
  const fiveMinsAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString()
  const twoMinsAgo = new Date(now.getTime() - 2 * 60 * 1000).toISOString()

  // ── Parallel queries ────────────────────────────────────────
  // Eight queries in a single round-trip. Every one is scoped by
  // `shop_id IN (storeIds)` + time window; no cross-tenant leakage.
  // API mode (no local DB): page_views, checkout_sessions, orders are
  // Postgres-only. Render the page with all metrics at zero so the UI
  // (KPI cards, world map, sparkline, top pages/sources) still loads.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  let visitorsNowRow: any = null
  let sessionsLast10Row: any = null
  let ordersLast10Row: any = null
  let behaviorRows: any[] = []
  let pageviewsByMinuteRows: any[] = []
  let orderCountryRows: any[] = []
  let topPagesRows: any[] = []
  let topSourcesRows: any[] = []
  if (hasDb) try {
    ;[
      visitorsNowRow,
      sessionsLast10Row,
      ordersLast10Row,
      behaviorRows,
      pageviewsByMinuteRows,
      orderCountryRows,
      topPagesRows,
      topSourcesRows,
    ] = await Promise.all([
    // 1. Visitors right now = distinct sessions in page_views last 5 min
    //    (M2: replaces checkout_sessions proxy with real page-view data)
    db
      .selectFrom('page_views')
      .select(sql<number>`COUNT(DISTINCT session_id)`.as('count'))
      .where('shop_id', 'in', storeIds)
      .where('created_at', '>', sql<string>`NOW() - INTERVAL '5 minutes'`)
      .executeTakeFirst(),

    // 2. Total sessions (any state) created in the last 10 minutes
    db
      .selectFrom('checkout_sessions')
      .select(db.fn.count('id').as('count'))
      .where('shop_id', 'in', storeIds)
      .where('created_at', '>=', tenMinsAgo as any)
      .executeTakeFirst(),

    // 3. Orders + sales in the last 10 minutes (paid + pending)
    db
      .selectFrom('orders')
      .select([
        db.fn.count('id').as('order_count'),
        db.fn.sum('total_price').as('sales_total'),
      ])
      .where('shop_id', 'in', storeIds)
      .where('created_at', '>=', tenMinsAgo as any)
      .where('financial_status', '!=', 'voided')
      .executeTakeFirst(),

    // 4. Customer behavior: state + updated_at over the last 10 min.
    //    We bucket in JS so we can split "open recent" → checking out
    //    vs "open older" → active carts.
    db
      .selectFrom('checkout_sessions')
      .select(['state', 'updated_at'])
      .where('shop_id', 'in', storeIds)
      .where('updated_at', '>=', tenMinsAgo as any)
      .execute(),

    // 5. Pageviews-per-minute buckets from page_views table (M2).
    //    Missing minutes are zero-filled client-side.
    db
      .selectFrom('page_views')
      .select([
        sql<string>`date_trunc('minute', created_at)`.as('minute'),
        sql<number>`COUNT(*)`.as('count'),
      ])
      .where('shop_id', 'in', storeIds)
      .where('created_at', '>', sql<string>`NOW() - INTERVAL '10 minutes'`)
      .groupBy(sql`date_trunc('minute', created_at)`)
      .orderBy(sql`date_trunc('minute', created_at)`, 'asc')
      .execute(),

    // 6. Orders grouped by country (last 10 min) for map markers
    db
      .selectFrom('orders')
      .select([
        sql<string>`COALESCE(shipping_address->>'country_code', shipping_address->>'country', 'Unknown')`.as('country'),
        db.fn.count('id').as('count'),
      ])
      .where('shop_id', 'in', storeIds)
      .where('created_at', '>=', tenMinsAgo as any)
      .groupBy(sql`COALESCE(shipping_address->>'country_code', shipping_address->>'country', 'Unknown')`)
      .orderBy('count', 'desc')
      .execute(),

    // 7. Top pages by view count (last 10 min) — M2
    db
      .selectFrom('page_views')
      .select([
        'path',
        sql<number>`COUNT(*)`.as('views'),
      ])
      .where('shop_id', 'in', storeIds)
      .where('created_at', '>', sql<string>`NOW() - INTERVAL '10 minutes'`)
      .groupBy('path')
      .orderBy(sql`COUNT(*)`, 'desc')
      .limit(10)
      .execute(),

    // 8. Traffic sources by view count (last 10 min) — M2
    db
      .selectFrom('page_views')
      .select([
        sql<string>`COALESCE(utm_source, '(direct)')`.as('source'),
        sql<number>`COUNT(*)`.as('views'),
      ])
      .where('shop_id', 'in', storeIds)
      .where('created_at', '>', sql<string>`NOW() - INTERVAL '10 minutes'`)
      .groupBy(sql`COALESCE(utm_source, '(direct)')`)
      .orderBy(sql`COUNT(*)`, 'desc')
      .limit(5)
      .execute(),
    ])
  } catch (e: any) {
    console.warn('[live-view] DB read failed:', e?.message)
  }

  // Suppress unused var warnings — kept for future SQL-side filters.
  void fiveMinsAgo
  void twoMinsAgo

  // ── Shape data ──────────────────────────────────────────────
  const visitorsNow = Number((visitorsNowRow as any)?.count ?? 0)
  const sessionsLast10 = Number((sessionsLast10Row as any)?.count ?? 0)
  const ordersLast10 = Number((ordersLast10Row as any)?.order_count ?? 0)
  const salesTotal = Number((ordersLast10Row as any)?.sales_total ?? 0)

  // Customer behavior split (in JS so we can keep behaviorRows small):
  //   - "Purchased"    → state = completed
  //   - "Checking out" → state = open, updated in last 2 minutes
  //   - "Active carts" → state = open, updated >2 min ago
  let activeCarts = 0
  let checkingOut = 0
  let purchased = 0
  const twoMinsAgoMs = now.getTime() - 2 * 60 * 1000
  for (const r of behaviorRows as any[]) {
    const state = String(r.state)
    const updatedMs = new Date(r.updated_at).getTime()
    if (state === 'completed') {
      purchased++
    } else if (state === 'open') {
      if (updatedMs >= twoMinsAgoMs) checkingOut++
      else activeCarts++
    }
  }

  // Browsing = visitors with page views but no cart session (M2).
  // Clamp to 0 — can go negative if page_views deduplication drops
  // entries but checkout_sessions are still open.
  const browsing = Math.max(0, visitorsNow - (activeCarts + checkingOut))

  // Pageviews per minute — zero-fill exactly 10 buckets (M2: from page_views)
  const pageviewBuckets = new Map<string, number>()
  for (const row of pageviewsByMinuteRows as any[]) {
    const minuteKey = new Date(row.minute).toISOString().slice(0, 16)
    pageviewBuckets.set(minuteKey, Number(row.count))
  }
  const pageviewPoints: number[] = []
  for (let i = 9; i >= 0; i--) {
    const t = new Date(now.getTime() - i * 60 * 1000)
    t.setSeconds(0, 0)
    t.setMilliseconds(0)
    const key = t.toISOString().slice(0, 16)
    pageviewPoints.push(pageviewBuckets.get(key) || 0)
  }

  // Top pages (M2)
  const topPagesList = (topPagesRows as any[]).map(r => ({
    path: String(r.path),
    views: Number(r.views),
  }))

  // Traffic sources (M2)
  const trafficSources = (topSourcesRows as any[]).map(r => ({
    source: String(r.source),
    views: Number(r.views),
  }))

  // Map markers
  const markers: OrderMarker[] = []
  for (const row of orderCountryRows as any[]) {
    const code = String(row.country || '')
    const m = countryMarker(code, Number(row.count))
    if (m) markers.push(m)
  }

  const currency = (store as any).currency || 'USD'
  const asOf = fmtAsOf(now)
  const scopeSuffix = scope === 'all' ? '&scope=all' : ''

  // ── Render HTML ─────────────────────────────────────────────
  const content = `
    <div class="lv-header">
      <div>
        <h1><span class="lv-live-dot"></span>Live View</h1>
      </div>
      <div class="lv-asof" id="lvAsOf">${esc(asOf)}</div>
    </div>

    <div class="lv-toolbar">
      <div class="lv-toolbar-left">
        <div class="menu-wrap lv-store-switcher">
          <button type="button" class="lv-store-pill${scope === 'all' ? ' lv-store-pill-all' : ''}" onclick="toggleMenu('lvStoreMenu')" aria-haspopup="true" aria-expanded="false">
            ${
              scope === 'all'
                ? `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2a9 9 0 010 12M8 2a9 9 0 000 12"/></svg>
                   All stores <strong>(${accessibleStores.length})</strong>`
                : `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 6l1-3h10l1 3M2 6v7h12V6M2 6h12"/></svg>
                   Current store: <strong>${esc(store.name)}</strong>`
            }
            <svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" style="margin-left:6px;opacity:.7"><path d="M5 8l5 5 5-5"/></svg>
          </button>
          <div class="menu-dropdown" id="lvStoreMenu" style="min-width:260px;max-height:360px;overflow-y:auto">
            <div style="padding:8px 12px 4px;font-size:11px;color:var(--s-text-muted);text-transform:uppercase;letter-spacing:.04em">Scope</div>
            ${
              canSwitchStores
                ? `
              <a class="menu-item${scope === 'all' ? ' active' : ''}" href="${base}/analytics/live?scope=all" title="Aggregate metrics across every store you own">
                <span style="display:inline-flex;align-items:center;gap:8px">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" style="opacity:.85"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2a9 9 0 010 12M8 2a9 9 0 000 12"/></svg>
                  ${scope === 'all' ? '✓ ' : ''}All stores
                  <span style="opacity:.55;font-size:11px;margin-left:auto">${accessibleStores.length}</span>
                </span>
              </a>
              <div style="height:1px;background:var(--s-border);margin:4px 0"></div>
            `
                : ''
            }
            <div style="padding:8px 12px 4px;font-size:11px;color:var(--s-text-muted);text-transform:uppercase;letter-spacing:.04em">Switch store</div>
            ${
              accessibleStores.length === 0
                ? `<div class="menu-item" style="opacity:0.6;cursor:default;pointer-events:none;font-size:11px">No other stores</div>`
                : accessibleStores
                    .map(
                      (s) => `
              <a class="menu-item${scope === 'single' && s.slug === store.slug ? ' active' : ''}" href="/admin/store/${esc(s.slug)}/analytics/live" title="${esc(s.name)}">
                ${scope === 'single' && s.slug === store.slug ? '✓ ' : ''}${esc(s.name)}
              </a>
            `,
                    )
                    .join('')
            }
          </div>
        </div>
      </div>
      <div class="lv-refresh">
        <span class="lv-refresh-dot"></span>
        <span id="lvRefreshLabel">Auto-refreshing every 10s</span>
      </div>
    </div>

    <!-- KPI cards -->
    <div class="lv-kpi-grid" id="lvKpiGrid">
      ${buildKpiCard(
        'Visitors right now',
        String(visitorsNow),
        'Unique visitors (distinct sessions) with page views in the last 5 minutes.',
      )}
      ${buildKpiCard(
        'Total sessions',
        String(sessionsLast10),
        'Total checkout sessions created in the last 10 minutes.',
      )}
      ${buildKpiCard(
        'Total sales',
        fmtMoney(salesTotal, currency),
        'Sum of order totals (excluding voided) in the last 10 minutes.',
        '#22c55e',
      )}
      ${buildKpiCard(
        'Total orders',
        String(ordersLast10),
        'Number of orders placed in the last 10 minutes.',
      )}
    </div>

    <!-- World map -->
    <div class="lv-section">
      ${buildWorldMap(markers)}
    </div>

    <!-- Charts row -->
    <div class="lv-charts-grid">
      <div class="lv-section">
        <div class="lv-section-head">
          <h3 class="lv-section-title">Pageviews</h3>
          <span class="lv-section-info" title="Page views per minute from storefront traffic, last 10 minutes.">i</span>
        </div>
        <div style="font-size:11px;color:var(--s-text-muted);margin-bottom:8px">Per minute · Last 10 mins</div>
        <div id="lvPageviewsChart">
          ${buildPageviewsChart(pageviewPoints)}
        </div>
      </div>
      <div class="lv-section">
        <div class="lv-section-head">
          <h3 class="lv-section-title">Customer behavior</h3>
          <span class="lv-section-info" title="Breakdown of visitors by where they are in the checkout journey, last 10 minutes.">i</span>
        </div>
        <div id="lvBehavior">
          ${buildBehaviorBars(browsing, activeCarts, checkingOut, purchased)}
        </div>
      </div>
    </div>

    <!-- Top pages + Traffic sources row (M2) -->
    <div class="lv-charts-grid">
      <div class="lv-section">
        <div class="lv-section-head">
          <h3 class="lv-section-title">Top pages</h3>
          <span class="lv-section-info" title="Most viewed pages by storefront visitors in the last 10 minutes.">i</span>
        </div>
        <div id="lvTopPages">
          ${buildTopPagesTable(topPagesList)}
        </div>
      </div>
      <div class="lv-section">
        <div class="lv-section-head">
          <h3 class="lv-section-title">Traffic sources</h3>
          <span class="lv-section-info" title="Where visitors came from (utm_source), last 10 minutes. Direct = no UTM tag.">i</span>
        </div>
        <div id="lvTrafficSources">
          ${buildTrafficSourcesChart(trafficSources)}
        </div>
      </div>
    </div>

    ${liveViewStyles()}
    <script>
      /* ── ShopBase-style dropdown menus (same pattern as orders/analytics) */
      function toggleMenu(id) {
        var menu = document.getElementById(id);
        if (!menu) return;
        var isOpen = menu.classList.contains('open');
        document.querySelectorAll('.menu-dropdown').forEach(function(m) { m.classList.remove('open'); });
        if (!isOpen) menu.classList.add('open');
        var btn = menu.previousElementSibling;
        if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', !isOpen ? 'true' : 'false');
      }
      document.addEventListener('click', function(e) {
        if (!e.target.closest('.menu-wrap')) {
          document.querySelectorAll('.menu-dropdown').forEach(function(m) { m.classList.remove('open'); });
        }
      });

      /* ── Map zoom (decorative — scales the viewport group) */
      (function() {
        var zoom = 1;
        window.lvZoom = function(dir) {
          zoom = Math.max(1, Math.min(3, zoom + dir * 0.35));
          var vp = document.getElementById('lvMapViewport');
          if (vp) vp.setAttribute('transform', 'scale(' + zoom.toFixed(2) + ')');
        };
      })();

      /* ── Auto-refresh via SSE + polling fallback */
      (function() {
        var sseUrl = '/admin/store/${esc(store.slug)}/analytics/live/stream${scopeSuffix ? '?' + scopeSuffix.slice(1) : ''}';
        var es = null;
        var pollTimer = null;

        function updateAsOf() {
          var el = document.getElementById('lvAsOf');
          if (!el) return;
          var d = new Date();
          var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
          var h = d.getHours(), ampm = h >= 12 ? 'PM' : 'AM';
          h = h % 12 || 12;
          var pad = function(n) { return n < 10 ? '0' + n : String(n); };
          el.textContent = months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() + ' ' + pad(h) + ':' + pad(d.getMinutes()) + ' ' + ampm;
        }

        function updateKpis(data) {
          var grid = document.getElementById('lvKpiGrid');
          if (!grid) return;
          var vals = grid.querySelectorAll('.lv-kpi-value');
          if (vals[0]) vals[0].textContent = data.visitors_now || '0';
          if (vals[1]) vals[1].textContent = data.sessions_10 || '0';
          if (vals[2]) vals[2].textContent = (data.sales_currency || '$') + (data.sales_10 || '0.00');
          if (vals[3]) vals[3].textContent = data.orders_10 || '0';
        }

        try {
          es = new EventSource(sseUrl);
          es.addEventListener('stats', function(e) {
            try {
              var data = JSON.parse(e.data);
              updateKpis(data);
              updateAsOf();
            } catch (err) {}
          });
          es.onerror = function() {
            if (es) { es.close(); es = null; }
            startPolling();
          };
        } catch (err) {
          startPolling();
        }

        function startPolling() {
          if (pollTimer) return;
          pollTimer = setInterval(function() { window.location.reload(); }, 15000);
          var lbl = document.getElementById('lvRefreshLabel');
          if (lbl) lbl.textContent = 'Auto-refresh (polling every 15s)';
        }
      })();
    </script>
  `

  res.send(
    sellerLayout({
      title: 'Live View',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'analytics',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}
