/**
 * Store Admin — Currencies Settings (Phase 9 PR3 Feature B).
 *
 * Manages shop-level currency settings added by migration 068:
 *   - shop.primary_currency       (ISO-4217, accounting currency)
 *   - shop.presentment_currencies (JSONB array of currencies the storefront
 *                                  may display)
 *
 * Per-market presentment currency lives on `markets.currency_code` and is
 * managed on /settings/markets. This page is the shop-wide default that
 * applies when no market matches.
 *
 * Iron-rule-5 compliant: error surfaces say "Please contact Gbox support",
 * no god-admin paths leaked.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { logSellerAction } from '../middleware/store-auth.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { notify, byActor } from '../lib/notify.js'
import { listMarkets } from '@gbox/core/modules/markets/markets.js'

// ---------------------------------------------------------------------------
// Supported currencies (same list as markets-settings.ts)
// ---------------------------------------------------------------------------

const CURRENCY_CATALOG: Array<{ code: string; name: string; symbol: string }> = [
  { code: 'USD', name: 'US Dollar', symbol: '$' },
  { code: 'EUR', name: 'Euro', symbol: '€' },
  { code: 'GBP', name: 'British Pound', symbol: '£' },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$' },
  { code: 'AUD', name: 'Australian Dollar', symbol: 'A$' },
  { code: 'NZD', name: 'New Zealand Dollar', symbol: 'NZ$' },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥' },
  { code: 'KRW', name: 'South Korean Won', symbol: '₩' },
  { code: 'CNY', name: 'Chinese Yuan', symbol: '¥' },
  { code: 'VND', name: 'Vietnamese Dong', symbol: '₫' },
  { code: 'SGD', name: 'Singapore Dollar', symbol: 'S$' },
  { code: 'HKD', name: 'Hong Kong Dollar', symbol: 'HK$' },
  { code: 'TWD', name: 'Taiwan Dollar', symbol: 'NT$' },
  { code: 'THB', name: 'Thai Baht', symbol: '฿' },
  { code: 'IDR', name: 'Indonesian Rupiah', symbol: 'Rp' },
  { code: 'MYR', name: 'Malaysian Ringgit', symbol: 'RM' },
  { code: 'PHP', name: 'Philippine Peso', symbol: '₱' },
  { code: 'INR', name: 'Indian Rupee', symbol: '₹' },
  { code: 'CHF', name: 'Swiss Franc', symbol: 'CHF' },
  { code: 'NOK', name: 'Norwegian Krone', symbol: 'kr' },
  { code: 'SEK', name: 'Swedish Krona', symbol: 'kr' },
  { code: 'DKK', name: 'Danish Krone', symbol: 'kr' },
  { code: 'PLN', name: 'Polish Złoty', symbol: 'zł' },
  { code: 'CZK', name: 'Czech Koruna', symbol: 'Kč' },
  { code: 'HUF', name: 'Hungarian Forint', symbol: 'Ft' },
  { code: 'RON', name: 'Romanian Leu', symbol: 'lei' },
  { code: 'BGN', name: 'Bulgarian Lev', symbol: 'лв' },
  { code: 'MXN', name: 'Mexican Peso', symbol: '$' },
  { code: 'BRL', name: 'Brazilian Real', symbol: 'R$' },
  { code: 'ARS', name: 'Argentine Peso', symbol: '$' },
  { code: 'CLP', name: 'Chilean Peso', symbol: '$' },
  { code: 'COP', name: 'Colombian Peso', symbol: '$' },
  { code: 'PEN', name: 'Peruvian Sol', symbol: 'S/' },
  { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ' },
  { code: 'SAR', name: 'Saudi Riyal', symbol: 'ر.س' },
  { code: 'ILS', name: 'Israeli Shekel', symbol: '₪' },
  { code: 'ZAR', name: 'South African Rand', symbol: 'R' },
  { code: 'TRY', name: 'Turkish Lira', symbol: '₺' },
]

const CURRENCY_CODES = CURRENCY_CATALOG.map((c) => c.code)

function parseCurrencyList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x).toUpperCase())
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.map((x) => String(x).toUpperCase()) : []
    } catch {
      return []
    }
  }
  return []
}

function normaliseCurrencyList(list: string[]): string[] {
  const seen = new Set<string>()
  for (const raw of list) {
    const c = String(raw).trim().toUpperCase()
    if (c && CURRENCY_CODES.includes(c)) seen.add(c)
  }
  return Array.from(seen).sort()
}

// ---------------------------------------------------------------------------
// GET /settings/currencies
// ---------------------------------------------------------------------------

export async function getCurrenciesSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const saved = req.query.saved === '1'
  const errMsg = typeof req.query.err === 'string' ? req.query.err : ''

  const csrfToken = req.csrfToken!
  const csrfField = csrfHiddenField(csrfToken)

  // API mode (no local DB): render with defaults from store object, no persist.
  // Markets list = [] because /settings/markets also requires local DB.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  let primary = 'USD'
  let presentment = new Set<string>()
  let markets: Array<{ id: string; name: string; currency_code: string; is_primary?: boolean }> = []

  if (hasDb) {
    try {
      const shopRow = await (db as any)
        .selectFrom('shops')
        .select(['primary_currency', 'presentment_currencies', 'currency'])
        .where('id', '=', store.id)
        .executeTakeFirstOrThrow()
      primary = String(shopRow.primary_currency ?? shopRow.currency ?? 'USD').toUpperCase()
      presentment = new Set(parseCurrencyList(shopRow.presentment_currencies))
      markets = (await listMarkets(db as any, store.id)) as any
    } catch (e: any) {
      console.warn('[currencies-settings] DB query failed, fallback defaults:', e?.message)
    }
  } else {
    primary = String((store as any).currency ?? 'USD').toUpperCase()
  }
  // Primary is always included in the presentment list.
  presentment.add(primary)
  const marketCurrencies = new Set(markets.map((m) => m.currency_code))

  const primaryOptions = CURRENCY_CATALOG
    .map((c) => `<option value="${c.code}" ${c.code === primary ? 'selected' : ''}>${esc(c.code)} — ${esc(c.name)}</option>`)
    .join('')

  const currencyCheckboxes = CURRENCY_CATALOG.map((c) => {
    const isPrimary = c.code === primary
    const isEnabled = presentment.has(c.code)
    const usedByMarket = marketCurrencies.has(c.code)
    return `
      <label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--s-border);border-radius:6px;cursor:${isPrimary ? 'not-allowed' : 'pointer'};opacity:${isPrimary ? 0.7 : 1}">
        <input type="checkbox" name="presentment" value="${c.code}" ${isEnabled ? 'checked' : ''} ${isPrimary ? 'disabled' : ''}
          style="width:16px;height:16px;accent-color:var(--s-accent)">
        <div style="display:flex;flex-direction:column;gap:2px;flex:1">
          <div style="font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px">
            <span>${esc(c.code)}</span>
            <span style="color:var(--s-text-dim);font-weight:400">${esc(c.symbol)}</span>
            ${isPrimary ? '<span class="badge" style="background:rgba(59,130,246,.12);color:#60a5fa;border:1px solid rgba(59,130,246,.3);padding:1px 6px;border-radius:4px;font-size:10px">PRIMARY</span>' : ''}
            ${usedByMarket && !isPrimary ? '<span class="badge" style="background:rgba(16,185,129,.12);color:#10b981;border:1px solid rgba(16,185,129,.3);padding:1px 6px;border-radius:4px;font-size:10px">USED BY MARKET</span>' : ''}
          </div>
          <div style="font-size:11px;color:var(--s-text-dim)">${esc(c.name)}</div>
        </div>
      </label>
    `
  }).join('')

  const content = `
    <div class="page-header">
      <div>
        <a href="${base}/settings" style="color:var(--s-text-dim);text-decoration:none;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px">
          &larr; Settings
        </a>
        <h1 class="page-title">Currencies</h1>
        <p class="page-subtitle">Pick your accounting currency and the currencies your storefront may display. Per-market currency is set on <a href="${base}/settings/markets" style="color:var(--s-accent)">Markets</a>.</p>
      </div>
    </div>

    ${saved ? `<div style="background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);border-radius:8px;padding:12px 16px;margin-bottom:20px;color:var(--s-success);font-size:13px">Currencies saved.</div>` : ''}
    ${errMsg ? `<div style="background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);border-radius:8px;padding:12px 16px;margin-bottom:20px;color:var(--s-danger,#ef4444);font-size:13px">${esc(errMsg)}</div>` : ''}

    <form method="POST" action="${base}/settings/currencies" style="max-width:920px">
      ${csrfField}

      <!-- PRIMARY -->
      <div class="card" style="margin-bottom:20px">
        <div class="card-header">Accounting currency</div>
        <div class="card-body">
          <div style="display:flex;flex-direction:column;gap:10px">
            <label style="display:flex;flex-direction:column;gap:4px;max-width:460px">
              <span style="font-weight:600;font-size:13px">Primary currency</span>
              <select name="primary_currency"
                style="background:var(--s-bg-input);border:1px solid var(--s-border);border-radius:6px;padding:8px 10px;color:var(--s-text);font-size:13px">
                ${primaryOptions}
              </select>
              <span style="font-size:11px;color:var(--s-text-dim)">Used for bookkeeping, reports, order totals, and tax remittance. Changing this after orders exist does not convert historical totals.</span>
            </label>
          </div>
        </div>
      </div>

      <!-- PRESENTMENT CURRENCIES -->
      <div class="card" style="margin-bottom:20px">
        <div class="card-header">
          <span>Storefront currencies</span>
          <span class="badge badge-neutral">${presentment.size} enabled</span>
        </div>
        <div class="card-body">
          <p style="font-size:13px;color:var(--s-text-dim);margin:0 0 16px">
            Tick each currency your storefront may display to buyers. The primary currency is always included. Markets can pin a specific display currency for their countries on the <a href="${base}/settings/markets" style="color:var(--s-accent)">Markets page</a>.
          </p>

          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px">
            ${currencyCheckboxes}
          </div>
        </div>
      </div>

      <div style="display:flex;gap:8px">
        <button type="submit" class="btn btn-primary">Save currencies</button>
        <a href="${base}/settings" class="btn btn-secondary">Cancel</a>
      </div>
    </form>

    <!-- MARKET CURRENCY SUMMARY -->
    <div class="card" style="margin-top:20px">
      <div class="card-header">
        <span>Market currency overrides</span>
        <span class="badge badge-neutral">${markets.length} market${markets.length === 1 ? '' : 's'}</span>
      </div>
      <div class="card-body">
        ${markets.length === 0 ? `
          <div style="color:var(--s-text-dim);font-size:13px">No markets configured. <a href="${base}/settings/markets" style="color:var(--s-accent)">Create a market</a> to pin a presentment currency per region.</div>
        ` : `
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="border-bottom:1px solid var(--s-border);text-align:left">
                <th style="padding:8px 4px;font-size:12px;color:var(--s-text-dim);font-weight:600">Market</th>
                <th style="padding:8px 4px;font-size:12px;color:var(--s-text-dim);font-weight:600">Currency</th>
                <th style="padding:8px 4px;font-size:12px;color:var(--s-text-dim);font-weight:600;text-align:right">Edit</th>
              </tr>
            </thead>
            <tbody>
              ${markets.map((m) => `
                <tr style="border-bottom:1px solid var(--s-border)">
                  <td style="padding:10px 4px;font-size:13px">
                    <div style="font-weight:600">${esc(m.name)}${m.is_primary ? ' <span class="badge" style="background:rgba(59,130,246,.12);color:#60a5fa;border:1px solid rgba(59,130,246,.3);padding:1px 6px;border-radius:4px;font-size:10px">PRIMARY</span>' : ''}</div>
                  </td>
                  <td style="padding:10px 4px;font-size:13px">${esc(m.currency_code)}</td>
                  <td style="padding:10px 4px;text-align:right">
                    <a href="${base}/settings/markets?edit=${esc(m.id)}" class="btn btn-secondary btn-sm">Edit market</a>
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
    title: 'Currencies',
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

// ---------------------------------------------------------------------------
// POST /settings/currencies
// ---------------------------------------------------------------------------

export async function postCurrenciesSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!

  const primary = String(req.body.primary_currency ?? 'USD').toUpperCase().trim()
  if (!CURRENCY_CODES.includes(primary)) {
    res.redirect(`/admin/store/${store.slug}/settings/currencies?err=${encodeURIComponent('Primary currency is not supported. Please contact Gbox support.')}`)
    return
  }

  // Multi-checkbox posts as string | string[]. Normalize.
  let checked = req.body.presentment
  if (checked === undefined) checked = []
  else if (!Array.isArray(checked)) checked = [String(checked)]

  const presentment = normaliseCurrencyList([primary, ...checked.map((x: any) => String(x))])

  // API mode: no BE endpoint exists yet to persist shop-level currency settings.
  // Show a banner instead of 500.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  if (!hasDb) {
    res.redirect(`/admin/store/${store.slug}/settings/currencies?err=${encodeURIComponent('Saving currencies requires local DB or a BE endpoint - not supported in API mode.')}`)
    return
  }

  try {
    await (db as any)
      .updateTable('shops')
      .set({
        primary_currency: primary,
        presentment_currencies: JSON.stringify(presentment),
        // Keep legacy `shops.currency` in sync so older callers still see
        // the same value; this column was the pre-068 single-currency source.
        currency: primary,
        updated_at: new Date(),
      })
      .where('id', '=', store.id)
      .execute()

    await logSellerAction(db, req, 'update', 'currencies_settings', store.id, {
      primary_currency: primary,
      presentment_count: presentment.length,
    })

    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'currencies_updated',
      title: `Currencies updated (primary: ${primary})`,
      message: byActor((req as any).storeUser),
      resourceType: null,
      resourceId: null,
    })

    res.redirect(`/admin/store/${store.slug}/settings/currencies?saved=1`)
  } catch (err) {
    console.error('[currencies-settings] save failed', err)
    res.redirect(`/admin/store/${store.slug}/settings/currencies?err=${encodeURIComponent('Could not save currencies. Please contact Gbox support.')}`)
  }
}

export { CURRENCY_CATALOG, CURRENCY_CODES, normaliseCurrencyList as _normaliseCurrencyList, parseCurrencyList as _parseCurrencyList }
