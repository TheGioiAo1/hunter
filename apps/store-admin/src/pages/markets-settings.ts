/**
 * Store Admin — Markets Settings (Phase 9 PR3 full rewrite).
 *
 * Replaces the old shop_settings JSONB placeholder with a table-backed
 * Shopify-style markets UI. Powered by migration 068 + the
 * `@gbox/core/modules/markets` package.
 *
 * Features:
 *   - List markets (with shipping zone + tax registration counts)
 *   - Create from template (7 presets: US, CA, EU, UK, APAC, VN, ROW)
 *   - Create from scratch
 *   - Edit: name, countries, currency, language, status, primary toggle
 *   - Delete (guards: cannot delete primary market)
 *   - Link shipping zones + tax registrations to markets
 *
 * Iron-rule-5 compliant: any friction surfaces as "Please contact Gbox support"
 * — no god-admin paths or internal plumbing leaked to sellers.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { logSellerAction } from '../middleware/store-auth.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { notify, byActor } from '../lib/notify.js'
import {
  listMarketsWithLinks,
  getMarket,
  createMarket,
  createMarketFromTemplate,
  updateMarket,
  deleteMarket,
  linkShippingZoneToMarket,
  linkTaxRegistrationToMarket,
  MARKET_TEMPLATES,
  MarketNotFoundError,
  DuplicateMarketNameError,
} from '@gbox/core/modules/markets/markets.js'
import { knownCountryCodes, normaliseCountryList } from '@gbox/core/modules/markets/seed.js'

// ---------------------------------------------------------------------------
// Currency + language pick-lists
// ---------------------------------------------------------------------------

const CURRENCY_CHOICES = [
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY', 'KRW', 'CNY',
  'VND', 'SGD', 'HKD', 'TWD', 'THB', 'IDR', 'MYR', 'PHP', 'INR',
  'CHF', 'NOK', 'SEK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'BGN',
  'MXN', 'BRL', 'ARS', 'CLP', 'COP', 'PEN',
  'AED', 'SAR', 'ILS', 'ZAR', 'TRY',
]

const LANGUAGE_CHOICES = [
  { code: 'en', name: 'English' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'de', name: 'German' },
  { code: 'fr', name: 'French' },
  { code: 'es', name: 'Spanish' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'nl', name: 'Dutch' },
  { code: 'pl', name: 'Polish' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh', name: 'Chinese' },
  { code: 'th', name: 'Thai' },
  { code: 'id', name: 'Indonesian' },
  { code: 'ar', name: 'Arabic' },
]

const COUNTRY_CHOICES = knownCountryCodes()

// ---------------------------------------------------------------------------
// GET /settings/markets
// ---------------------------------------------------------------------------

export async function getMarketsSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const saved = req.query.saved === '1'
  const removed = req.query.removed === '1'
  const errMsg = typeof req.query.err === 'string' ? req.query.err : ''

  const csrfToken = req.csrfToken!
  const csrfField = csrfHiddenField(csrfToken)

  const editId = typeof req.query.edit === 'string' ? req.query.edit : ''
  const editMarket = editId ? await getMarket(db as any, store.id, editId) : null

  const markets = await listMarketsWithLinks(db as any, store.id)

  // Shipping zones + tax registrations for the link dropdowns.
  const zones = await (db as any)
    .selectFrom('shipping_zones')
    .select(['id', 'name', 'market_id'])
    .where('shop_id', '=', store.id)
    .orderBy('name', 'asc')
    .execute()

  const registrations = await (db as any)
    .selectFrom('tax_registrations')
    .select(['id', 'display_name', 'jurisdiction_code', 'market_id'])
    .where('shop_id', '=', store.id)
    .orderBy('display_name', 'asc')
    .execute()

  const marketOptions = markets.map((m: any) => ({
    id: m.id,
    label: `${m.name}${m.is_primary ? ' (primary)' : ''}`,
  }))

  // Pre-render currency + language + country <option>s
  const currencyOpts = (selected: string) => CURRENCY_CHOICES
    .map((c) => `<option value="${c}" ${c === selected ? 'selected' : ''}>${c}</option>`)
    .join('')
  const languageOpts = (selected: string) => LANGUAGE_CHOICES
    .map((l) => `<option value="${l.code}" ${l.code === selected ? 'selected' : ''}>${esc(l.name)} (${l.code})</option>`)
    .join('')

  const templateOptions = MARKET_TEMPLATES
    .map((t) => `<option value="${esc(t.key)}">${esc(t.name)} — ${esc(t.description)}</option>`)
    .join('')

  const content = `
    <div class="page-header">
      <div>
        <a href="${base}/settings" style="color:var(--s-text-dim);text-decoration:none;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px">
          &larr; Settings
        </a>
        <h1 class="page-title">Markets</h1>
        <p class="page-subtitle">Group countries into markets. Each market gets its own currency, language, shipping zones, and tax rules.</p>
      </div>
    </div>

    ${saved ? `<div style="background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);border-radius:8px;padding:12px 16px;margin-bottom:20px;color:var(--s-success);font-size:13px">Market saved.</div>` : ''}
    ${removed ? `<div style="background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);border-radius:8px;padding:12px 16px;margin-bottom:20px;color:var(--s-success);font-size:13px">Market removed.</div>` : ''}
    ${errMsg ? `<div style="background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);border-radius:8px;padding:12px 16px;margin-bottom:20px;color:var(--s-danger,#ef4444);font-size:13px">${esc(errMsg)}</div>` : ''}

    <!-- MARKETS LIST -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-header">
        <span>Your markets</span>
        <span class="badge badge-neutral">${markets.length} market${markets.length === 1 ? '' : 's'}</span>
      </div>
      <div class="card-body">
        ${markets.length === 0 ? `
          <div style="text-align:center;padding:24px;color:var(--s-text-dim)">
            <div style="font-size:14px;margin-bottom:4px">No markets yet.</div>
            <div style="font-size:12px">Create your first market below — start with a template.</div>
          </div>
        ` : `
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="border-bottom:1px solid var(--s-border);text-align:left">
                <th style="padding:8px 4px;font-size:12px;color:var(--s-text-dim);font-weight:600">Name</th>
                <th style="padding:8px 4px;font-size:12px;color:var(--s-text-dim);font-weight:600">Countries</th>
                <th style="padding:8px 4px;font-size:12px;color:var(--s-text-dim);font-weight:600">Currency</th>
                <th style="padding:8px 4px;font-size:12px;color:var(--s-text-dim);font-weight:600">Status</th>
                <th style="padding:8px 4px;font-size:12px;color:var(--s-text-dim);font-weight:600">Linked</th>
                <th style="padding:8px 4px;font-size:12px;color:var(--s-text-dim);font-weight:600;text-align:right">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${markets.map((m: any) => `
                <tr style="border-bottom:1px solid var(--s-border)">
                  <td style="padding:10px 4px;font-size:13px">
                    <div style="font-weight:600;display:flex;align-items:center;gap:6px">
                      ${esc(m.name)}
                      ${m.is_primary ? '<span class="badge badge-primary" style="background:rgba(59,130,246,.12);color:#60a5fa;border:1px solid rgba(59,130,246,.3);padding:1px 6px;border-radius:4px;font-size:10px">PRIMARY</span>' : ''}
                    </div>
                    <div style="font-size:11px;color:var(--s-text-dim)">${esc(m.language_code)}</div>
                  </td>
                  <td style="padding:10px 4px;font-size:13px;color:var(--s-text-dim)">
                    ${m.countries.length === 0
                      ? '<em>All others (rest of world)</em>'
                      : m.countries.length > 6
                        ? `${esc(m.countries.slice(0, 6).join(', '))} <span style="color:var(--s-text-dim);font-size:11px">+ ${m.countries.length - 6} more</span>`
                        : esc(m.countries.join(', '))}
                  </td>
                  <td style="padding:10px 4px;font-size:13px">${esc(m.currency_code)}</td>
                  <td style="padding:10px 4px">
                    <span class="badge ${m.status === 'active' ? 'badge-success' : 'badge-neutral'}">${esc(m.status)}</span>
                  </td>
                  <td style="padding:10px 4px;font-size:12px;color:var(--s-text-dim)">
                    ${m.shipping_zone_count} zone${m.shipping_zone_count === 1 ? '' : 's'} &middot; ${m.tax_registration_count} reg${m.tax_registration_count === 1 ? '' : 's'}
                  </td>
                  <td style="padding:10px 4px;text-align:right">
                    <a href="${base}/settings/markets?edit=${esc(m.id)}" class="btn btn-secondary btn-sm">Edit</a>
                    ${m.is_primary ? '' : `
                      <form method="POST" action="${base}/settings/markets/delete" style="display:inline" onsubmit="return confirm('Delete this market? Shipping zones and tax registrations linked to it will become unassigned.')">
                        ${csrfField}
                        <input type="hidden" name="id" value="${esc(m.id)}">
                        <button type="submit" class="btn btn-danger btn-sm">Delete</button>
                      </form>
                    `}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `}
      </div>
    </div>

    ${editMarket ? renderEditForm(editMarket, base, csrfField, currencyOpts, languageOpts) : ''}

    <!-- CREATE FROM TEMPLATE -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-header">Create market from template</div>
      <div class="card-body">
        <form method="POST" action="${base}/settings/markets/from-template"
          style="display:grid;grid-template-columns:1fr 1fr auto;gap:12px;align-items:end">
          ${csrfField}
          <label style="display:flex;flex-direction:column;gap:4px">
            <span style="font-weight:600;font-size:13px">Template</span>
            <select name="template_key" required
              style="background:var(--s-bg-input);border:1px solid var(--s-border);border-radius:6px;padding:8px 10px;color:var(--s-text);font-size:13px">
              ${templateOptions}
            </select>
          </label>
          <label style="display:flex;flex-direction:column;gap:4px">
            <span style="font-weight:600;font-size:13px">Custom name (optional)</span>
            <input type="text" name="name" placeholder="Defaults to template name"
              style="background:var(--s-bg-input);border:1px solid var(--s-border);border-radius:6px;padding:8px 10px;color:var(--s-text);font-size:13px">
          </label>
          <button type="submit" class="btn btn-primary">Create from template</button>
        </form>
      </div>
    </div>

    <!-- CREATE FROM SCRATCH -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-header">Create market from scratch</div>
      <div class="card-body">
        <form method="POST" action="${base}/settings/markets/create"
          style="display:flex;flex-direction:column;gap:12px">
          ${csrfField}
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
            <label style="display:flex;flex-direction:column;gap:4px">
              <span style="font-weight:600;font-size:13px">Name</span>
              <input type="text" name="name" required placeholder="e.g. Nordics"
                style="background:var(--s-bg-input);border:1px solid var(--s-border);border-radius:6px;padding:8px 10px;color:var(--s-text);font-size:13px">
            </label>
            <label style="display:flex;flex-direction:column;gap:4px">
              <span style="font-weight:600;font-size:13px">Currency</span>
              <select name="currency_code"
                style="background:var(--s-bg-input);border:1px solid var(--s-border);border-radius:6px;padding:8px 10px;color:var(--s-text);font-size:13px">
                ${currencyOpts('USD')}
              </select>
            </label>
            <label style="display:flex;flex-direction:column;gap:4px">
              <span style="font-weight:600;font-size:13px">Language</span>
              <select name="language_code"
                style="background:var(--s-bg-input);border:1px solid var(--s-border);border-radius:6px;padding:8px 10px;color:var(--s-text);font-size:13px">
                ${languageOpts('en')}
              </select>
            </label>
          </div>
          <label style="display:flex;flex-direction:column;gap:4px">
            <span style="font-weight:600;font-size:13px">Countries (ISO-2, comma-separated)</span>
            <input type="text" name="countries" placeholder="e.g. SE, NO, DK, FI"
              style="background:var(--s-bg-input);border:1px solid var(--s-border);border-radius:6px;padding:8px 10px;color:var(--s-text);font-size:13px">
            <span style="font-size:11px;color:var(--s-text-dim)">Leave empty to create a "rest of world" catch-all.</span>
          </label>
          <button type="submit" class="btn btn-primary" style="align-self:flex-start">Create market</button>
        </form>
      </div>
    </div>

    <!-- LINK SHIPPING ZONES -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-header">
        <span>Link shipping zones to markets</span>
        <span class="badge badge-neutral">${zones.length} zone${zones.length === 1 ? '' : 's'}</span>
      </div>
      <div class="card-body">
        ${zones.length === 0 ? `
          <div style="color:var(--s-text-dim);font-size:13px">No shipping zones yet. Create zones in <a href="${base}/settings/shipping" style="color:var(--s-accent)">Shipping settings</a> first.</div>
        ` : `
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="border-bottom:1px solid var(--s-border);text-align:left">
                <th style="padding:8px 4px;font-size:12px;color:var(--s-text-dim);font-weight:600">Zone</th>
                <th style="padding:8px 4px;font-size:12px;color:var(--s-text-dim);font-weight:600">Linked market</th>
                <th style="padding:8px 4px;font-size:12px;color:var(--s-text-dim);font-weight:600;text-align:right">Action</th>
              </tr>
            </thead>
            <tbody>
              ${zones.map((z: any) => `
                <tr style="border-bottom:1px solid var(--s-border)">
                  <td style="padding:10px 4px;font-size:13px">${esc(z.name)}</td>
                  <td style="padding:10px 4px">
                    <form method="POST" action="${base}/settings/markets/link-zone" style="display:flex;gap:8px;align-items:center">
                      ${csrfField}
                      <input type="hidden" name="zone_id" value="${esc(z.id)}">
                      <select name="market_id"
                        style="background:var(--s-bg-input);border:1px solid var(--s-border);border-radius:6px;padding:6px 8px;color:var(--s-text);font-size:12px;min-width:180px">
                        <option value="">— Unassigned (applies globally) —</option>
                        ${marketOptions.map((o) => `<option value="${esc(o.id)}" ${z.market_id === o.id ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
                      </select>
                      <button type="submit" class="btn btn-secondary btn-sm">Save</button>
                    </form>
                  </td>
                  <td style="padding:10px 4px;text-align:right;font-size:11px;color:var(--s-text-dim)">
                    ${z.market_id ? 'Only applies in that market' : 'Applies in every market'}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `}
      </div>
    </div>

    <!-- LINK TAX REGISTRATIONS -->
    <div class="card">
      <div class="card-header">
        <span>Link tax registrations to markets</span>
        <span class="badge badge-neutral">${registrations.length} registration${registrations.length === 1 ? '' : 's'}</span>
      </div>
      <div class="card-body">
        ${registrations.length === 0 ? `
          <div style="color:var(--s-text-dim);font-size:13px">No tax registrations yet. Add them in <a href="${base}/settings/taxes" style="color:var(--s-accent)">Tax settings</a> first.</div>
        ` : `
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="border-bottom:1px solid var(--s-border);text-align:left">
                <th style="padding:8px 4px;font-size:12px;color:var(--s-text-dim);font-weight:600">Registration</th>
                <th style="padding:8px 4px;font-size:12px;color:var(--s-text-dim);font-weight:600">Linked market</th>
                <th style="padding:8px 4px;font-size:12px;color:var(--s-text-dim);font-weight:600;text-align:right">Action</th>
              </tr>
            </thead>
            <tbody>
              ${registrations.map((r: any) => `
                <tr style="border-bottom:1px solid var(--s-border)">
                  <td style="padding:10px 4px;font-size:13px">
                    <div style="font-weight:600">${esc(r.display_name)}</div>
                    <div style="font-size:11px;color:var(--s-text-dim)">${esc(r.jurisdiction_code)}</div>
                  </td>
                  <td style="padding:10px 4px">
                    <form method="POST" action="${base}/settings/markets/link-registration" style="display:flex;gap:8px;align-items:center">
                      ${csrfField}
                      <input type="hidden" name="registration_id" value="${esc(r.id)}">
                      <select name="market_id"
                        style="background:var(--s-bg-input);border:1px solid var(--s-border);border-radius:6px;padding:6px 8px;color:var(--s-text);font-size:12px;min-width:180px">
                        <option value="">— Unassigned (applies globally) —</option>
                        ${marketOptions.map((o) => `<option value="${esc(o.id)}" ${r.market_id === o.id ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
                      </select>
                      <button type="submit" class="btn btn-secondary btn-sm">Save</button>
                    </form>
                  </td>
                  <td style="padding:10px 4px;text-align:right;font-size:11px;color:var(--s-text-dim)">
                    ${r.market_id ? 'Only applies in that market' : 'Applies in every market'}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `}
      </div>
    </div>
  `

  res.send(sellerLayout({
    title: 'Markets',
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

function renderEditForm(
  m: { id: string; name: string; status: string; countries: string[]; is_primary: boolean; currency_code: string; language_code: string },
  base: string,
  csrfField: string,
  currencyOpts: (selected: string) => string,
  languageOpts: (selected: string) => string,
): string {
  const statusOpts = ['active', 'inactive', 'draft']
    .map((s) => `<option value="${s}" ${s === m.status ? 'selected' : ''}>${s}</option>`)
    .join('')
  return `
    <div class="card" style="margin-bottom:20px;border:1px solid var(--s-accent,#3b82f6)">
      <div class="card-header">
        <span>Edit market: ${esc(m.name)}</span>
        <a href="${base}/settings/markets" style="color:var(--s-text-dim);text-decoration:none;font-size:12px">Close ✕</a>
      </div>
      <div class="card-body">
        <form method="POST" action="${base}/settings/markets/update" style="display:flex;flex-direction:column;gap:12px">
          ${csrfField}
          <input type="hidden" name="id" value="${esc(m.id)}">
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px">
            <label style="display:flex;flex-direction:column;gap:4px">
              <span style="font-weight:600;font-size:13px">Name</span>
              <input type="text" name="name" value="${esc(m.name)}" required
                style="background:var(--s-bg-input);border:1px solid var(--s-border);border-radius:6px;padding:8px 10px;color:var(--s-text);font-size:13px">
            </label>
            <label style="display:flex;flex-direction:column;gap:4px">
              <span style="font-weight:600;font-size:13px">Currency</span>
              <select name="currency_code"
                style="background:var(--s-bg-input);border:1px solid var(--s-border);border-radius:6px;padding:8px 10px;color:var(--s-text);font-size:13px">
                ${currencyOpts(m.currency_code)}
              </select>
            </label>
            <label style="display:flex;flex-direction:column;gap:4px">
              <span style="font-weight:600;font-size:13px">Language</span>
              <select name="language_code"
                style="background:var(--s-bg-input);border:1px solid var(--s-border);border-radius:6px;padding:8px 10px;color:var(--s-text);font-size:13px">
                ${languageOpts(m.language_code)}
              </select>
            </label>
            <label style="display:flex;flex-direction:column;gap:4px">
              <span style="font-weight:600;font-size:13px">Status</span>
              <select name="status"
                style="background:var(--s-bg-input);border:1px solid var(--s-border);border-radius:6px;padding:8px 10px;color:var(--s-text);font-size:13px">
                ${statusOpts}
              </select>
            </label>
          </div>
          <label style="display:flex;flex-direction:column;gap:4px">
            <span style="font-weight:600;font-size:13px">Countries (ISO-2, comma-separated)</span>
            <input type="text" name="countries" value="${esc(m.countries.join(', '))}"
              style="background:var(--s-bg-input);border:1px solid var(--s-border);border-radius:6px;padding:8px 10px;color:var(--s-text);font-size:13px">
            <span style="font-size:11px;color:var(--s-text-dim)">Leave empty to make this a "rest of world" catch-all.</span>
          </label>
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer">
            <input type="checkbox" name="is_primary" value="true" ${m.is_primary ? 'checked' : ''}
              style="width:16px;height:16px;accent-color:var(--s-accent)">
            <div>
              <div style="font-weight:600;font-size:13px">Primary market</div>
              <div style="font-size:11px;color:var(--s-text-dim)">Used as fallback when the buyer's country doesn't match any market. Only one market can be primary per shop.</div>
            </div>
          </label>
          <div style="display:flex;gap:8px">
            <button type="submit" class="btn btn-primary">Save changes</button>
            <a href="${base}/settings/markets" class="btn btn-secondary">Cancel</a>
          </div>
        </form>
      </div>
    </div>
  `
}

// ---------------------------------------------------------------------------
// Legacy placeholder — kept so the server.ts import line keeps compiling.
// Internally now redirects to the rich page. Sellers never hit this.
// ---------------------------------------------------------------------------

export async function postMarketsSettings(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  // Nothing to persist on the root URL anymore; each action has its own route.
  res.redirect(`/admin/store/${store.slug}/settings/markets`)
}

// ---------------------------------------------------------------------------
// POST /settings/markets/from-template
// ---------------------------------------------------------------------------

export async function postMarketFromTemplate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const templateKey = String(req.body.template_key ?? '').trim()
  const name = String(req.body.name ?? '').trim() || undefined

  if (!templateKey) {
    res.redirect(`/admin/store/${store.slug}/settings/markets?err=${encodeURIComponent('Template is required')}`)
    return
  }

  try {
    const market = await createMarketFromTemplate(db as any, store.id, templateKey, name)
    await logSellerAction(db, req, 'create', 'market', market.id, {
      template: templateKey,
      name: market.name,
      countries: market.countries.length,
    })
    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'market_created',
      title: `Market created: ${market.name}`,
      message: byActor((req as any).storeUser),
      resourceType: 'market',
      resourceId: market.id,
    })
    res.redirect(`/admin/store/${store.slug}/settings/markets?saved=1`)
  } catch (err: any) {
    console.error('[markets-settings] from-template failed', err)
    const msg = err instanceof DuplicateMarketNameError
      ? err.message
      : 'Could not create market. Please contact Gbox support.'
    res.redirect(`/admin/store/${store.slug}/settings/markets?err=${encodeURIComponent(msg)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /settings/markets/create
// ---------------------------------------------------------------------------

export async function postMarketCreate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!

  const name = String(req.body.name ?? '').trim()
  const currency = String(req.body.currency_code ?? 'USD').toUpperCase().trim()
  const language = String(req.body.language_code ?? 'en').toLowerCase().trim()
  const countriesRaw = String(req.body.countries ?? '')

  if (!name) {
    res.redirect(`/admin/store/${store.slug}/settings/markets?err=${encodeURIComponent('Market name is required')}`)
    return
  }

  const countries = normaliseCountryList(
    countriesRaw.split(',').map((c) => c.trim()).filter(Boolean),
  )

  try {
    const market = await createMarket(db as any, store.id, {
      name,
      status: 'active',
      countries,
      currency_code: currency,
      language_code: language,
    })
    await logSellerAction(db, req, 'create', 'market', market.id, {
      name: market.name,
      countries: market.countries.length,
      currency: market.currency_code,
    })
    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'market_created',
      title: `Market created: ${market.name}`,
      message: byActor((req as any).storeUser),
      resourceType: 'market',
      resourceId: market.id,
    })
    res.redirect(`/admin/store/${store.slug}/settings/markets?saved=1`)
  } catch (err: any) {
    console.error('[markets-settings] create failed', err)
    const msg = err instanceof DuplicateMarketNameError
      ? err.message
      : (err?.message ?? 'Could not create market. Please contact Gbox support.')
    res.redirect(`/admin/store/${store.slug}/settings/markets?err=${encodeURIComponent(msg)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /settings/markets/update
// ---------------------------------------------------------------------------

export async function postMarketUpdate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!

  const id = String(req.body.id ?? '')
  const name = String(req.body.name ?? '').trim()
  const status = String(req.body.status ?? 'active') as 'active' | 'inactive' | 'draft'
  const currency = String(req.body.currency_code ?? 'USD').toUpperCase().trim()
  const language = String(req.body.language_code ?? 'en').toLowerCase().trim()
  const isPrimary = req.body.is_primary === 'true'
  const countriesRaw = String(req.body.countries ?? '')

  if (!id) {
    res.redirect(`/admin/store/${store.slug}/settings/markets?err=${encodeURIComponent('Missing market id')}`)
    return
  }
  if (!name) {
    res.redirect(`/admin/store/${store.slug}/settings/markets?edit=${encodeURIComponent(id)}&err=${encodeURIComponent('Market name is required')}`)
    return
  }

  const countries = normaliseCountryList(
    countriesRaw.split(',').map((c) => c.trim()).filter(Boolean),
  )

  try {
    const market = await updateMarket(db as any, store.id, id, {
      name,
      status,
      countries,
      currency_code: currency,
      language_code: language,
      is_primary: isPrimary,
    })
    await logSellerAction(db, req, 'update', 'market', market.id, {
      name: market.name,
      status: market.status,
      is_primary: market.is_primary,
      countries: market.countries.length,
    })
    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'market_updated',
      title: `Market updated: ${market.name}`,
      message: byActor((req as any).storeUser),
      resourceType: 'market',
      resourceId: market.id,
    })
    res.redirect(`/admin/store/${store.slug}/settings/markets?saved=1`)
  } catch (err: any) {
    console.error('[markets-settings] update failed', err)
    const msg = err instanceof MarketNotFoundError || err instanceof DuplicateMarketNameError
      ? err.message
      : (err?.message ?? 'Could not update market. Please contact Gbox support.')
    res.redirect(`/admin/store/${store.slug}/settings/markets?edit=${encodeURIComponent(id)}&err=${encodeURIComponent(msg)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /settings/markets/delete
// ---------------------------------------------------------------------------

export async function postMarketDelete(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const id = String(req.body.id ?? '')
  if (!id) {
    res.redirect(`/admin/store/${store.slug}/settings/markets`)
    return
  }

  try {
    await deleteMarket(db as any, store.id, id)
    await logSellerAction(db, req, 'delete', 'market', id, {})
    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'market_deleted',
      title: 'Market deleted',
      message: byActor((req as any).storeUser),
      resourceType: 'market',
      resourceId: id,
    })
    res.redirect(`/admin/store/${store.slug}/settings/markets?removed=1`)
  } catch (err: any) {
    console.error('[markets-settings] delete failed', err)
    const msg = err instanceof MarketNotFoundError
      ? err.message
      : (err?.message ?? 'Could not delete market. Please contact Gbox support.')
    res.redirect(`/admin/store/${store.slug}/settings/markets?err=${encodeURIComponent(msg)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /settings/markets/link-zone
// ---------------------------------------------------------------------------

export async function postMarketLinkZone(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const zoneId = String(req.body.zone_id ?? '')
  const marketIdRaw = String(req.body.market_id ?? '').trim()
  const marketId = marketIdRaw === '' ? null : marketIdRaw

  if (!zoneId) {
    res.redirect(`/admin/store/${store.slug}/settings/markets`)
    return
  }

  try {
    await linkShippingZoneToMarket(db as any, store.id, zoneId, marketId)
    await logSellerAction(db, req, 'update', 'shipping_zone', zoneId, {
      action: 'link_market',
      market_id: marketId,
    })
    res.redirect(`/admin/store/${store.slug}/settings/markets?saved=1`)
  } catch (err: any) {
    console.error('[markets-settings] link-zone failed', err)
    res.redirect(`/admin/store/${store.slug}/settings/markets?err=${encodeURIComponent('Could not link zone. Please contact Gbox support.')}`)
  }
}

// ---------------------------------------------------------------------------
// POST /settings/markets/link-registration
// ---------------------------------------------------------------------------

export async function postMarketLinkRegistration(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const registrationId = String(req.body.registration_id ?? '')
  const marketIdRaw = String(req.body.market_id ?? '').trim()
  const marketId = marketIdRaw === '' ? null : marketIdRaw

  if (!registrationId) {
    res.redirect(`/admin/store/${store.slug}/settings/markets`)
    return
  }

  try {
    await linkTaxRegistrationToMarket(db as any, store.id, registrationId, marketId)
    await logSellerAction(db, req, 'update', 'tax_registration', registrationId, {
      action: 'link_market',
      market_id: marketId,
    })
    res.redirect(`/admin/store/${store.slug}/settings/markets?saved=1`)
  } catch (err: any) {
    console.error('[markets-settings] link-registration failed', err)
    res.redirect(`/admin/store/${store.slug}/settings/markets?err=${encodeURIComponent('Could not link registration. Please contact Gbox support.')}`)
  }
}

// Keep COUNTRY_CHOICES exported for future use by a country-picker component.
export { COUNTRY_CHOICES }
