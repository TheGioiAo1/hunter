/**
 * Phase 9 / PR2 — Tax rate seed catalog.
 *
 * Public 2026 statutory rates covering Gbox's three primary markets:
 *
 *   - US: state-level sales tax for all 50 states + DC. Sub-state
 *     (county/city/district) rates are NOT seeded — merchants who need
 *     sub-state accuracy hand-enter them as custom `tax_rates` rows,
 *     or (Phase 9.PR2b) wire a live provider like TaxJar / Avalara.
 *     Five states have 0% state sales tax (AK, DE, MT, NH, OR); they
 *     are still seeded so merchants see them in the jurisdiction picker.
 *
 *   - EU: standard VAT rate per country for all 27 member states + UK.
 *     Reduced-rate categories (books, food, childcare) are not modelled
 *     in PR2 — sellers of those goods can add custom reduced-rate rows
 *     in the admin. Full reduced-rate support lands when product
 *     taxonomy / categories ship (Phase 10).
 *
 *   - VN: 10% standard VAT (Thuế GTGT). Reduced 5% / 0% rates exist for
 *     certain categories but, per US+EU approach, merchants customize.
 *
 * Sources: each rate in the table below cites the 2026 public rate from
 * the tax authority's website or the EU Commission's VAT rates PDF.
 * Keep the catalog small and readable — this is NOT an exhaustive
 * tax-law database. It exists to bootstrap new merchants with
 * sensible defaults so they don't start at zero.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JurisdictionKind = 'us_state' | 'eu_country' | 'country'
export type TaxKind = 'sales' | 'vat' | 'gst'

export interface TaxSeedRow {
  jurisdiction_kind: JurisdictionKind
  jurisdiction_code: string          // 'US-CA' | 'DE' | 'VN' | 'GB'
  name: string                        // 'California', 'Germany', 'Vietnam'
  rate: number                        // 0.0625, 0.19, 0.10
  kind: TaxKind
  applies_to_shipping: boolean        // true in most EU; false in many US states
}

// ---------------------------------------------------------------------------
// US — all 50 states + DC (state-level sales tax only, 2026 statutory)
// ---------------------------------------------------------------------------

const US_STATES: ReadonlyArray<[string, string, number]> = [
  // [postal-code, name, rate]
  ['AL', 'Alabama',        0.040],
  ['AK', 'Alaska',         0.000], // no state sales tax (local up to 7.5%)
  ['AZ', 'Arizona',        0.056],
  ['AR', 'Arkansas',       0.065],
  ['CA', 'California',     0.0725],
  ['CO', 'Colorado',       0.029],
  ['CT', 'Connecticut',    0.0635],
  ['DE', 'Delaware',       0.000], // no state sales tax
  ['DC', 'District of Columbia', 0.060],
  ['FL', 'Florida',        0.060],
  ['GA', 'Georgia',        0.040],
  ['HI', 'Hawaii',         0.040], // technically GET not sales tax
  ['ID', 'Idaho',          0.060],
  ['IL', 'Illinois',       0.0625],
  ['IN', 'Indiana',        0.070],
  ['IA', 'Iowa',           0.060],
  ['KS', 'Kansas',         0.065],
  ['KY', 'Kentucky',       0.060],
  ['LA', 'Louisiana',      0.0445],
  ['ME', 'Maine',          0.055],
  ['MD', 'Maryland',       0.060],
  ['MA', 'Massachusetts',  0.0625],
  ['MI', 'Michigan',       0.060],
  ['MN', 'Minnesota',      0.06875],
  ['MS', 'Mississippi',    0.070],
  ['MO', 'Missouri',       0.04225],
  ['MT', 'Montana',        0.000], // no state sales tax
  ['NE', 'Nebraska',       0.055],
  ['NV', 'Nevada',         0.0685],
  ['NH', 'New Hampshire',  0.000], // no state sales tax
  ['NJ', 'New Jersey',     0.06625],
  ['NM', 'New Mexico',     0.04875],
  ['NY', 'New York',       0.040],
  ['NC', 'North Carolina', 0.0475],
  ['ND', 'North Dakota',   0.050],
  ['OH', 'Ohio',           0.0575],
  ['OK', 'Oklahoma',       0.045],
  ['OR', 'Oregon',         0.000], // no state sales tax
  ['PA', 'Pennsylvania',   0.060],
  ['RI', 'Rhode Island',   0.070],
  ['SC', 'South Carolina', 0.060],
  ['SD', 'South Dakota',   0.042],
  ['TN', 'Tennessee',      0.070],
  ['TX', 'Texas',          0.0625],
  ['UT', 'Utah',           0.0485],
  ['VT', 'Vermont',        0.060],
  ['VA', 'Virginia',       0.053],
  ['WA', 'Washington',     0.065],
  ['WV', 'West Virginia',  0.060],
  ['WI', 'Wisconsin',      0.050],
  ['WY', 'Wyoming',        0.040],
]

// ---------------------------------------------------------------------------
// EU 27 + UK — standard VAT rate per country (2026)
// ---------------------------------------------------------------------------

const EU_COUNTRIES: ReadonlyArray<[string, string, number]> = [
  ['AT', 'Austria',        0.20],
  ['BE', 'Belgium',        0.21],
  ['BG', 'Bulgaria',       0.20],
  ['HR', 'Croatia',        0.25],
  ['CY', 'Cyprus',         0.19],
  ['CZ', 'Czechia',        0.21],
  ['DK', 'Denmark',        0.25],
  ['EE', 'Estonia',        0.22],
  ['FI', 'Finland',        0.255],
  ['FR', 'France',         0.20],
  ['DE', 'Germany',        0.19],
  ['GR', 'Greece',         0.24],
  ['HU', 'Hungary',        0.27],
  ['IE', 'Ireland',        0.23],
  ['IT', 'Italy',          0.22],
  ['LV', 'Latvia',         0.21],
  ['LT', 'Lithuania',      0.21],
  ['LU', 'Luxembourg',     0.17],
  ['MT', 'Malta',          0.18],
  ['NL', 'Netherlands',    0.21],
  ['PL', 'Poland',         0.23],
  ['PT', 'Portugal',       0.23],
  ['RO', 'Romania',        0.21], // raised from 19% in 2025
  ['SK', 'Slovakia',       0.23],
  ['SI', 'Slovenia',       0.22],
  ['ES', 'Spain',          0.21],
  ['SE', 'Sweden',         0.25],
]

const UK_AND_NEIGHBOURS: ReadonlyArray<[string, string, number]> = [
  ['GB', 'United Kingdom', 0.20],
  ['NO', 'Norway',         0.25],
  ['CH', 'Switzerland',    0.081],
]

// ---------------------------------------------------------------------------
// Rest of world seed entries (just enough to cover Gbox's current markets)
// ---------------------------------------------------------------------------

const OTHER_COUNTRIES: ReadonlyArray<[string, string, number, TaxKind]> = [
  ['VN', 'Vietnam',       0.10, 'vat'],
  ['AU', 'Australia',     0.10, 'gst'],
  ['NZ', 'New Zealand',   0.15, 'gst'],
  ['CA', 'Canada',        0.05, 'gst'], // federal GST only; provincial varies
  ['JP', 'Japan',         0.10, 'sales'],
  ['SG', 'Singapore',     0.09, 'gst'],
]

// US states that tax shipping. This is a simplified binary view — real
// rules are nuanced (some states tax shipping only when the goods are
// taxable, others always tax). Merchants can toggle per-rate.
// Source: multiple state DOR websites 2026.
const US_STATES_TAXING_SHIPPING: ReadonlySet<string> = new Set([
  'AR', 'CT', 'DC', 'GA', 'HI', 'KS', 'KY', 'MI', 'MN', 'MS', 'NE',
  'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'PA', 'RI', 'SC', 'SD', 'TN',
  'TX', 'VT', 'WA', 'WV', 'WI',
])

// ---------------------------------------------------------------------------
// Assembled catalog
// ---------------------------------------------------------------------------

export const TAX_RATE_SEED: readonly TaxSeedRow[] = [
  ...US_STATES.map<TaxSeedRow>(([code, name, rate]) => ({
    jurisdiction_kind: 'us_state',
    jurisdiction_code: `US-${code}`,
    name,
    rate,
    kind: 'sales',
    applies_to_shipping: US_STATES_TAXING_SHIPPING.has(code),
  })),
  ...EU_COUNTRIES.map<TaxSeedRow>(([code, name, rate]) => ({
    jurisdiction_kind: 'eu_country',
    jurisdiction_code: code,
    name,
    rate,
    kind: 'vat',
    applies_to_shipping: true, // standard EU rule
  })),
  ...UK_AND_NEIGHBOURS.map<TaxSeedRow>(([code, name, rate]) => ({
    jurisdiction_kind: 'country',
    jurisdiction_code: code,
    name,
    rate,
    kind: 'vat',
    applies_to_shipping: true,
  })),
  ...OTHER_COUNTRIES.map<TaxSeedRow>(([code, name, rate, kind]) => ({
    jurisdiction_kind: 'country',
    jurisdiction_code: code,
    name,
    rate,
    kind,
    applies_to_shipping: kind === 'vat' || kind === 'gst',
  })),
]

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/**
 * Find the standard seed row for a destination jurisdiction code.
 * Returns null if the jurisdiction isn't in the catalog.
 */
export function seedRowFor(jurisdictionCode: string): TaxSeedRow | null {
  const hit = TAX_RATE_SEED.find(
    (r) => r.jurisdiction_code === jurisdictionCode.toUpperCase(),
  )
  return hit ?? null
}

/**
 * Return every US state row. Convenience for the admin jurisdiction picker.
 */
export function usStateRows(): TaxSeedRow[] {
  return TAX_RATE_SEED.filter((r) => r.jurisdiction_kind === 'us_state')
}

/**
 * Return every EU country row. Convenience for the admin jurisdiction picker.
 */
export function euCountryRows(): TaxSeedRow[] {
  return TAX_RATE_SEED.filter((r) => r.jurisdiction_kind === 'eu_country')
}

/**
 * Return all rows by jurisdiction_kind. Convenience for the admin.
 */
export function rowsByKind(kind: JurisdictionKind): TaxSeedRow[] {
  return TAX_RATE_SEED.filter((r) => r.jurisdiction_kind === kind)
}

/**
 * EU member-state codes — used by the reverse-charge classifier in
 * `service.ts` to decide if cross-border B2B should be zero-rated.
 * Excludes UK (post-Brexit).
 */
export const EU_MEMBER_STATES: ReadonlySet<string> = new Set(
  EU_COUNTRIES.map(([code]) => code),
)

/**
 * Determine if a country code is an EU member state.
 */
export function isEuMember(countryCode: string): boolean {
  return EU_MEMBER_STATES.has(countryCode.toUpperCase())
}

/**
 * Map a destination ship-to address to a jurisdiction_code usable
 * by the tax engine. Falls back to country code for non-US destinations.
 *
 *   US + CA province → 'US-CA'
 *   DE + null        → 'DE'
 *   VN + null        → 'VN'
 */
export function resolveJurisdiction(address: {
  country?: string | null
  country_code?: string | null
  province?: string | null
  province_code?: string | null
  state?: string | null
}): string | null {
  const country = (address.country_code ?? address.country ?? '').toUpperCase()
  if (!country) return null
  if (country === 'US') {
    const state = (
      address.province_code
      ?? address.state
      ?? address.province
      ?? ''
    ).toUpperCase()
    if (!state || state.length !== 2) return null
    return `US-${state}`
  }
  return country
}
