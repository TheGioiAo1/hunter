/**
 * Phase 9 / PR2 — Tax Seed Catalog Tests
 *
 * Pure-module tests over the tax seed catalog. No DB access.
 * Ensures the statutory rates are sane, the jurisdiction resolver
 * handles US + EU + rest-of-world correctly, and the EU-membership
 * classifier excludes the UK.
 */

import { describe, it, expect } from 'vitest'
import {
  TAX_RATE_SEED,
  EU_MEMBER_STATES,
  isEuMember,
  seedRowFor,
  usStateRows,
  euCountryRows,
  rowsByKind,
  resolveJurisdiction,
} from './seed.js'

describe('TAX_RATE_SEED shape', () => {
  it('includes 51 US state rows (50 states + DC)', () => {
    const us = TAX_RATE_SEED.filter((r) => r.jurisdiction_kind === 'us_state')
    expect(us.length).toBe(51)
  })

  it('includes 27 EU country rows', () => {
    const eu = TAX_RATE_SEED.filter((r) => r.jurisdiction_kind === 'eu_country')
    expect(eu.length).toBe(27)
  })

  it('includes UK, Norway, Switzerland as non-EU countries', () => {
    const gb = seedRowFor('GB')!
    expect(gb.jurisdiction_kind).toBe('country')
    expect(gb.rate).toBe(0.20)
    expect(seedRowFor('NO')).not.toBeNull()
    expect(seedRowFor('CH')).not.toBeNull()
  })

  it('includes Vietnam at 10% VAT', () => {
    const vn = seedRowFor('VN')!
    expect(vn.rate).toBe(0.10)
    expect(vn.kind).toBe('vat')
    expect(vn.applies_to_shipping).toBe(true)
  })

  it('every row has rate >= 0 and <= 0.3', () => {
    for (const row of TAX_RATE_SEED) {
      expect(row.rate).toBeGreaterThanOrEqual(0)
      expect(row.rate).toBeLessThanOrEqual(0.3)
    }
  })

  it('every US state row is kind=sales', () => {
    for (const row of usStateRows()) {
      expect(row.kind).toBe('sales')
    }
  })

  it('every EU country row is kind=vat with shipping=true', () => {
    for (const row of euCountryRows()) {
      expect(row.kind).toBe('vat')
      expect(row.applies_to_shipping).toBe(true)
    }
  })

  it('zero-rate US states include AK, DE, MT, NH, OR', () => {
    const zeros = usStateRows().filter((r) => r.rate === 0).map((r) => r.jurisdiction_code)
    expect(zeros.sort()).toEqual(['US-AK', 'US-DE', 'US-MT', 'US-NH', 'US-OR'])
  })

  it('every jurisdiction_code is uppercase', () => {
    for (const row of TAX_RATE_SEED) {
      expect(row.jurisdiction_code).toBe(row.jurisdiction_code.toUpperCase())
    }
  })
})

describe('seedRowFor', () => {
  it('finds California by US-CA', () => {
    const ca = seedRowFor('US-CA')!
    expect(ca.name).toBe('California')
    expect(ca.rate).toBe(0.0725)
    expect(ca.kind).toBe('sales')
  })

  it('finds Germany by DE', () => {
    const de = seedRowFor('DE')!
    expect(de.rate).toBe(0.19)
    expect(de.kind).toBe('vat')
  })

  it('is case-insensitive', () => {
    expect(seedRowFor('us-ca')).toEqual(seedRowFor('US-CA'))
    expect(seedRowFor('de')).toEqual(seedRowFor('DE'))
  })

  it('returns null for unknown jurisdictions', () => {
    expect(seedRowFor('XX')).toBeNull()
    expect(seedRowFor('US-ZZ')).toBeNull()
  })
})

describe('EU membership', () => {
  it('EU_MEMBER_STATES has exactly 27 countries', () => {
    expect(EU_MEMBER_STATES.size).toBe(27)
  })

  it('includes Germany, France, Italy', () => {
    expect(isEuMember('DE')).toBe(true)
    expect(isEuMember('FR')).toBe(true)
    expect(isEuMember('IT')).toBe(true)
  })

  it('excludes UK (post-Brexit)', () => {
    expect(isEuMember('GB')).toBe(false)
  })

  it('excludes Norway, Switzerland', () => {
    expect(isEuMember('NO')).toBe(false)
    expect(isEuMember('CH')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(isEuMember('de')).toBe(true)
    expect(isEuMember('fr')).toBe(true)
  })

  it('returns false for US + rest-of-world', () => {
    expect(isEuMember('US')).toBe(false)
    expect(isEuMember('VN')).toBe(false)
    expect(isEuMember('AU')).toBe(false)
  })
})

describe('rowsByKind', () => {
  it('returns only us_state rows', () => {
    const rows = rowsByKind('us_state')
    expect(rows.length).toBe(51)
    for (const r of rows) {
      expect(r.jurisdiction_kind).toBe('us_state')
    }
  })

  it('returns only eu_country rows', () => {
    const rows = rowsByKind('eu_country')
    expect(rows.length).toBe(27)
    for (const r of rows) {
      expect(r.jurisdiction_kind).toBe('eu_country')
    }
  })

  it('returns the rest-of-world country rows', () => {
    const rows = rowsByKind('country')
    // UK + NO + CH + VN + AU + NZ + CA + JP + SG
    expect(rows.length).toBe(9)
  })
})

describe('resolveJurisdiction', () => {
  it('US + CA → US-CA', () => {
    expect(resolveJurisdiction({ country: 'US', province_code: 'CA' })).toBe('US-CA')
  })

  it('US + state field fallback', () => {
    expect(resolveJurisdiction({ country_code: 'US', state: 'NY' })).toBe('US-NY')
  })

  it('US + province fallback', () => {
    expect(resolveJurisdiction({ country: 'US', province: 'TX' })).toBe('US-TX')
  })

  it('returns null when US missing state', () => {
    expect(resolveJurisdiction({ country: 'US' })).toBeNull()
  })

  it('returns null when state is not 2 letters', () => {
    expect(resolveJurisdiction({ country: 'US', province_code: 'ZZZ' })).toBeNull()
  })

  it('DE + null → DE (non-US destinations don\'t need state)', () => {
    expect(resolveJurisdiction({ country: 'DE' })).toBe('DE')
  })

  it('VN → VN', () => {
    expect(resolveJurisdiction({ country_code: 'VN' })).toBe('VN')
  })

  it('is case-insensitive on country + state', () => {
    expect(resolveJurisdiction({ country: 'us', province_code: 'ca' })).toBe('US-CA')
    expect(resolveJurisdiction({ country_code: 'de' })).toBe('DE')
  })

  it('returns null with empty address', () => {
    expect(resolveJurisdiction({})).toBeNull()
  })
})
