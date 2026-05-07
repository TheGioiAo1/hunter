/**
 * Gbox Platform — Markets preset catalog (Phase 9 PR3).
 *
 * A market groups countries that share a presentment currency, language,
 * and (in future) a price-adjustment rule. The admin UI offers these
 * templates in the "Create from template" menu so merchants don't have
 * to hand-assemble a country list for common patterns.
 *
 * No DB rows are seeded from this file. Templates are runtime constants
 * the service layer consults when the admin hits POST /markets/from-template.
 */

export interface MarketTemplate {
  /** Stable slug — referenced by admin UI + service */
  key: string
  /** Default human name; admin can rename at create-time */
  name: string
  /** ISO-2 country codes this market owns by default */
  countries: string[]
  /** Presentment currency for buyers in this market */
  currency_code: string
  /** Default storefront language for this market */
  language_code: string
  /** Short description shown in the template picker */
  description: string
}

// ---------------------------------------------------------------------------
// Country groups — reused across templates
// ---------------------------------------------------------------------------

/**
 * EU-27 member states (post-Brexit). UK is handled in its own template
 * because post-Brexit VAT + currency rules diverge.
 */
export const EU_COUNTRIES: string[] = [
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI',
  'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT',
  'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
]

/** APAC commerce-friendly countries Gbox serves today. */
export const APAC_COUNTRIES: string[] = [
  'VN', 'SG', 'JP', 'KR', 'TH', 'ID', 'MY', 'PH', 'TW', 'HK', 'AU', 'NZ',
]

/** North America (USD-denominated; Canada uses CAD in its own template). */
export const NORTH_AMERICA_USD: string[] = ['US']

/** LATAM countries Gbox lists at launch — no default currency; merchant picks. */
export const LATAM_COUNTRIES: string[] = ['MX', 'BR', 'AR', 'CL', 'CO', 'PE']

// ---------------------------------------------------------------------------
// Templates — admin-facing "Create market from template"
// ---------------------------------------------------------------------------

export const MARKET_TEMPLATES: MarketTemplate[] = [
  {
    key: 'us_only',
    name: 'United States',
    countries: ['US'],
    currency_code: 'USD',
    language_code: 'en',
    description: 'USD pricing, English, 50 states + DC.',
  },
  {
    key: 'canada',
    name: 'Canada',
    countries: ['CA'],
    currency_code: 'CAD',
    language_code: 'en',
    description: 'CAD pricing, English + French-CA ready.',
  },
  {
    key: 'eu',
    name: 'European Union',
    countries: EU_COUNTRIES,
    currency_code: 'EUR',
    language_code: 'en',
    description: '27 EU member states, EUR pricing, tax-inclusive ready.',
  },
  {
    key: 'uk',
    name: 'United Kingdom',
    countries: ['GB'],
    currency_code: 'GBP',
    language_code: 'en',
    description: 'GBP pricing, post-Brexit VAT rules.',
  },
  {
    key: 'apac',
    name: 'Asia Pacific',
    countries: APAC_COUNTRIES,
    currency_code: 'USD',
    language_code: 'en',
    description: 'Vietnam, Japan, Singapore, Australia + APAC. USD default; set per-country later.',
  },
  {
    key: 'vietnam',
    name: 'Vietnam',
    countries: ['VN'],
    currency_code: 'VND',
    language_code: 'vi',
    description: 'VND pricing, Vietnamese storefront.',
  },
  {
    key: 'rest_of_world',
    name: 'Rest of world',
    countries: [],
    currency_code: 'USD',
    language_code: 'en',
    description:
      'Catch-all for countries not matched by any other market. Empty country list = wildcard.',
  },
]

/**
 * Look up a template by key. Case-sensitive — admin POSTs the canonical slug.
 */
export function templateByKey(key: string): MarketTemplate | undefined {
  return MARKET_TEMPLATES.find((t) => t.key === key)
}

/**
 * Normalise ISO-2 country code. Accepts "us", "US ", " gb" etc.
 * Returns uppercased, trimmed code; empty string on invalid input.
 */
export function normaliseCountry(code: string | null | undefined): string {
  if (!code) return ''
  const trimmed = String(code).trim().toUpperCase()
  return trimmed.length === 2 ? trimmed : ''
}

/**
 * Deduplicate + normalise a list of country codes. Drops invalid/empty rows.
 * Used when creating a market so the JSONB array is canonical.
 */
export function normaliseCountryList(codes: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const raw of codes) {
    const n = normaliseCountry(raw)
    if (n) seen.add(n)
  }
  return Array.from(seen).sort()
}

/**
 * List all country codes known to the template catalog (union of all
 * templates' country lists + common extras). Used by the admin UI
 * country-picker to surface a deduplicated options list.
 */
export function knownCountryCodes(): string[] {
  const all = new Set<string>()
  for (const t of MARKET_TEMPLATES) {
    for (const c of t.countries) all.add(c)
  }
  // Plus a handful of common extras not in any default template:
  for (const c of ['CH', 'NO', 'IS', 'LI', 'UA', 'IL', 'ZA', 'AE', 'SA', 'IN', 'TR']) {
    all.add(c)
  }
  return Array.from(all).sort()
}
