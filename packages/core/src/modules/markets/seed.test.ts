import { describe, it, expect } from 'vitest'
import {
  MARKET_TEMPLATES,
  EU_COUNTRIES,
  APAC_COUNTRIES,
  NORTH_AMERICA_USD,
  LATAM_COUNTRIES,
  templateByKey,
  normaliseCountry,
  normaliseCountryList,
  knownCountryCodes,
} from './seed.js'

describe('markets seed catalog', () => {
  it('includes the 7 core templates', () => {
    const keys = MARKET_TEMPLATES.map((t) => t.key).sort()
    expect(keys).toEqual([
      'apac',
      'canada',
      'eu',
      'rest_of_world',
      'uk',
      'us_only',
      'vietnam',
    ])
  })

  it('EU template contains all 27 member states and no UK', () => {
    expect(EU_COUNTRIES).toHaveLength(27)
    expect(EU_COUNTRIES).toContain('DE')
    expect(EU_COUNTRIES).toContain('FR')
    expect(EU_COUNTRIES).toContain('HR') // Croatia joined 2013
    expect(EU_COUNTRIES).not.toContain('GB') // post-Brexit
    expect(EU_COUNTRIES).not.toContain('UK')
  })

  it('APAC template covers Vietnam + core Asia-Pacific', () => {
    expect(APAC_COUNTRIES).toContain('VN')
    expect(APAC_COUNTRIES).toContain('SG')
    expect(APAC_COUNTRIES).toContain('JP')
    expect(APAC_COUNTRIES).toContain('AU')
  })

  it('NORTH_AMERICA_USD contains only US (CA gets CAD template)', () => {
    expect(NORTH_AMERICA_USD).toEqual(['US'])
  })

  it('LATAM template covers 6 launch countries', () => {
    expect(LATAM_COUNTRIES).toEqual(['MX', 'BR', 'AR', 'CL', 'CO', 'PE'])
  })

  it('each template has a non-empty name + description', () => {
    for (const t of MARKET_TEMPLATES) {
      expect(t.name.length).toBeGreaterThan(0)
      expect(t.description.length).toBeGreaterThan(0)
      expect(t.currency_code).toMatch(/^[A-Z]{3}$/)
      expect(t.language_code).toMatch(/^[a-z]{2}$/)
    }
  })

  it('rest_of_world has empty countries list (catch-all)', () => {
    const tmpl = templateByKey('rest_of_world')!
    expect(tmpl.countries).toEqual([])
    expect(tmpl.currency_code).toBe('USD')
  })

  it('vietnam template uses VND + vi language', () => {
    const tmpl = templateByKey('vietnam')!
    expect(tmpl.currency_code).toBe('VND')
    expect(tmpl.language_code).toBe('vi')
    expect(tmpl.countries).toEqual(['VN'])
  })

  it('uk template uses GBP (not EUR)', () => {
    const tmpl = templateByKey('uk')!
    expect(tmpl.currency_code).toBe('GBP')
    expect(tmpl.countries).toEqual(['GB'])
  })
})

describe('templateByKey', () => {
  it('returns undefined for unknown key', () => {
    expect(templateByKey('mars_colony')).toBeUndefined()
  })

  it('is case-sensitive (admin UI posts canonical slug)', () => {
    expect(templateByKey('US_ONLY')).toBeUndefined()
    expect(templateByKey('us_only')).toBeDefined()
  })
})

describe('normaliseCountry', () => {
  it('uppercases + trims valid 2-letter codes', () => {
    expect(normaliseCountry('us')).toBe('US')
    expect(normaliseCountry(' gb ')).toBe('GB')
    expect(normaliseCountry('VN')).toBe('VN')
  })

  it('returns empty string for invalid input', () => {
    expect(normaliseCountry('')).toBe('')
    expect(normaliseCountry('USA')).toBe('')
    expect(normaliseCountry('X')).toBe('')
    expect(normaliseCountry(null)).toBe('')
    expect(normaliseCountry(undefined)).toBe('')
  })
})

describe('normaliseCountryList', () => {
  it('deduplicates and sorts', () => {
    expect(normaliseCountryList(['us', 'US', 'gb', 'us', 'DE'])).toEqual([
      'DE',
      'GB',
      'US',
    ])
  })

  it('drops invalid rows silently', () => {
    expect(normaliseCountryList(['US', 'INVALID', '', 'de', ' '])).toEqual([
      'DE',
      'US',
    ])
  })

  it('returns empty array for empty input', () => {
    expect(normaliseCountryList([])).toEqual([])
  })
})

describe('knownCountryCodes', () => {
  it('includes every template country', () => {
    const known = new Set(knownCountryCodes())
    for (const t of MARKET_TEMPLATES) {
      for (const c of t.countries) {
        expect(known.has(c)).toBe(true)
      }
    }
  })

  it('includes common extras (CH, NO, AE, etc.)', () => {
    const known = new Set(knownCountryCodes())
    expect(known.has('CH')).toBe(true)
    expect(known.has('NO')).toBe(true)
    expect(known.has('AE')).toBe(true)
  })

  it('returns a sorted deduped list', () => {
    const list = knownCountryCodes()
    const sorted = [...list].sort()
    expect(list).toEqual(sorted)
    expect(new Set(list).size).toBe(list.length)
  })
})
