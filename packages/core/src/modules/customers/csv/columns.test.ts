import { describe, it, expect } from 'vitest'
import {
  CUSTOMER_CSV_COLUMNS,
  CUSTOMER_CSV_HEADERS,
  buildAliasMap,
  normalizeHeader,
  parseBooleanCell,
  encodeBooleanCell,
  parseTagsCell,
  encodeTagsCell,
} from './columns.js'

describe('customer csv columns spec', () => {
  it('exposes Shopify-parity canonical headers in Shopify export order', () => {
    // Not exhaustive — just pin the first few + the upsert key so a
    // reorder requires a deliberate test update.
    expect(CUSTOMER_CSV_HEADERS.slice(0, 3)).toEqual(['First Name', 'Last Name', 'Email'])
    expect(CUSTOMER_CSV_HEADERS).toContain('Tags')
    expect(CUSTOMER_CSV_HEADERS).toContain('Tax Exempt')
    expect(CUSTOMER_CSV_HEADERS).toContain('Accepts Email Marketing')
  })

  it('every column has a field + target + at least one alias', () => {
    for (const col of CUSTOMER_CSV_COLUMNS) {
      expect(col.field).toBeTruthy()
      expect(col.target).toMatch(/^(customer|address|readonly)$/)
      expect(col.aliases.length).toBeGreaterThan(0)
    }
  })

  it('alias map resolves case/whitespace/underscore variants to the same column', () => {
    const map = buildAliasMap()
    expect(map.get(normalizeHeader('Accepts Email Marketing'))?.field).toBe('accepts_marketing')
    expect(map.get(normalizeHeader('accepts_marketing'))?.field).toBe('accepts_marketing')
    expect(map.get(normalizeHeader('ACCEPTS MARKETING'))?.field).toBe('accepts_marketing')
    expect(map.get(normalizeHeader('  first name  '))?.field).toBe('first_name')
    // Unknown header → undefined. Importer treats it as an extra column.
    expect(map.get(normalizeHeader('Shopify Customer ID'))).toBeUndefined()
  })
})

describe('parseBooleanCell / encodeBooleanCell', () => {
  it.each(['yes', 'YES', 'true', 'TRUE', '1', 'y', 'Y'])('parses %s as true', (v) => {
    expect(parseBooleanCell(v)).toBe(true)
  })

  it.each(['no', 'false', '0', '', 'n', 'maybe', null, undefined])(
    'parses %j as false',
    (v) => {
      expect(parseBooleanCell(v as any)).toBe(false)
    },
  )

  it('encodes true → "yes", false/null → "no"', () => {
    expect(encodeBooleanCell(true)).toBe('yes')
    expect(encodeBooleanCell(false)).toBe('no')
    expect(encodeBooleanCell(null)).toBe('no')
    expect(encodeBooleanCell(undefined)).toBe('no')
  })
})

describe('parseTagsCell / encodeTagsCell', () => {
  it('splits on comma + trims whitespace + drops blanks', () => {
    expect(parseTagsCell('vip,wholesale,  early_access ')).toEqual([
      'vip',
      'wholesale',
      'early_access',
    ])
    expect(parseTagsCell('  , vip ,, ')).toEqual(['vip'])
  })

  it('round-trips through encode → parse', () => {
    const tags = ['vip', 'wholesale']
    expect(parseTagsCell(encodeTagsCell(tags))).toEqual(tags)
  })

  it('encodes empty/null as empty string', () => {
    expect(encodeTagsCell([])).toBe('')
    expect(encodeTagsCell(null)).toBe('')
    expect(encodeTagsCell(undefined)).toBe('')
  })

  it('empty/null cell parses to empty array', () => {
    expect(parseTagsCell('')).toEqual([])
    expect(parseTagsCell(null)).toEqual([])
    expect(parseTagsCell(undefined)).toEqual([])
  })
})
