import { describe, it, expect } from 'vitest'
import {
  CURRENCY_CATALOG,
  CURRENCY_CODES,
  _normaliseCurrencyList,
  _parseCurrencyList,
} from './currencies-settings.js'

describe('currencies-settings catalog', () => {
  it('has at least 30 currencies', () => {
    expect(CURRENCY_CATALOG.length).toBeGreaterThanOrEqual(30)
  })

  it('every code is a 3-letter uppercase ISO-4217 string', () => {
    for (const entry of CURRENCY_CATALOG) {
      expect(entry.code).toMatch(/^[A-Z]{3}$/)
      expect(entry.name.length).toBeGreaterThan(0)
      expect(entry.symbol.length).toBeGreaterThan(0)
    }
  })

  it('includes USD + EUR + GBP + VND + SGD (required for Gbox launch markets)', () => {
    for (const req of ['USD', 'EUR', 'GBP', 'VND', 'SGD', 'CAD', 'AUD', 'JPY']) {
      expect(CURRENCY_CODES).toContain(req)
    }
  })

  it('CURRENCY_CODES is derived from CURRENCY_CATALOG (same order)', () => {
    expect(CURRENCY_CODES).toEqual(CURRENCY_CATALOG.map((c) => c.code))
  })

  it('has no duplicates', () => {
    expect(new Set(CURRENCY_CODES).size).toBe(CURRENCY_CODES.length)
  })
})

describe('_normaliseCurrencyList', () => {
  it('uppercases + dedupes + sorts', () => {
    expect(_normaliseCurrencyList(['usd', 'EUR', 'USD', 'gbp'])).toEqual([
      'EUR',
      'GBP',
      'USD',
    ])
  })

  it('drops unknown codes silently', () => {
    expect(_normaliseCurrencyList(['USD', 'XYZ', '', 'EUR', 'HANDWAVE'])).toEqual([
      'EUR',
      'USD',
    ])
  })

  it('returns [] for empty input', () => {
    expect(_normaliseCurrencyList([])).toEqual([])
  })

  it('handles whitespace', () => {
    expect(_normaliseCurrencyList([' USD ', ' eur ', ' GBP'])).toEqual([
      'EUR',
      'GBP',
      'USD',
    ])
  })
})

describe('_parseCurrencyList', () => {
  it('parses an array straight through', () => {
    expect(_parseCurrencyList(['USD', 'EUR'])).toEqual(['USD', 'EUR'])
  })

  it('parses a JSON-string array', () => {
    expect(_parseCurrencyList('["USD","EUR"]')).toEqual(['USD', 'EUR'])
  })

  it('uppercases JSON-string entries', () => {
    expect(_parseCurrencyList('["usd","eur"]')).toEqual(['USD', 'EUR'])
  })

  it('returns [] for null / undefined / garbage', () => {
    expect(_parseCurrencyList(null)).toEqual([])
    expect(_parseCurrencyList(undefined)).toEqual([])
    expect(_parseCurrencyList('not-json')).toEqual([])
    expect(_parseCurrencyList(42)).toEqual([])
    expect(_parseCurrencyList({})).toEqual([])
  })

  it('returns [] for a JSON non-array', () => {
    expect(_parseCurrencyList('"USD"')).toEqual([])
    expect(_parseCurrencyList('{"x":1}')).toEqual([])
  })
})
