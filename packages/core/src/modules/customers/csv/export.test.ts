import { describe, it, expect } from 'vitest'
import {
  customerToRow,
  exportCustomersCsv,
  exportCustomersCsvStream,
  type ExportCustomer,
} from './export.js'
import { CUSTOMER_CSV_HEADERS } from './columns.js'
import { parseCustomersCsv } from './csv-parser.js'

function makeCustomer(overrides: Partial<ExportCustomer> = {}): ExportCustomer {
  return {
    id: 'cust-1',
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: 'ada@example.com',
    phone: '+44123',
    accepts_marketing: true,
    note: null,
    tags: ['vip'],
    tax_exempt: false,
    total_spent: '42.50',
    orders_count: 3,
    lifecycle_stage: 'returning',
    default_address: {
      first_name: 'Ada',
      last_name: 'Lovelace',
      company: 'Analytical Engines',
      address1: '1 Byron St',
      address2: null,
      city: 'London',
      province: 'England',
      province_code: 'ENG',
      country: 'United Kingdom',
      country_code: 'GB',
      zip: 'WC1',
      phone: '+44000',
    },
    ...overrides,
  }
}

describe('customerToRow', () => {
  it('emits cells in Shopify canonical header order', () => {
    const row = customerToRow(makeCustomer())
    expect(row).toHaveLength(CUSTOMER_CSV_HEADERS.length)
    // First Name, Last Name, Email are first three by spec.
    expect(row[0]).toBe('Ada')
    expect(row[1]).toBe('Lovelace')
    expect(row[2]).toBe('ada@example.com')
  })

  it('encodes booleans as yes/no for Shopify parity', () => {
    const row = customerToRow(makeCustomer({ accepts_marketing: true, tax_exempt: false }))
    const headerRow = [...CUSTOMER_CSV_HEADERS]
    const acceptsIdx = headerRow.indexOf('Accepts Email Marketing')
    const taxIdx = headerRow.indexOf('Tax Exempt')
    expect(row[acceptsIdx]).toBe('yes')
    expect(row[taxIdx]).toBe('no')
  })

  it('joins tags with comma+space', () => {
    const row = customerToRow(makeCustomer({ tags: ['vip', 'wholesale'] }))
    const tagIdx = [...CUSTOMER_CSV_HEADERS].indexOf('Tags')
    expect(row[tagIdx]).toBe('vip, wholesale')
  })

  it('handles no-address customers — address cells become blank', () => {
    const row = customerToRow(makeCustomer({ default_address: null }))
    const headerRow = [...CUSTOMER_CSV_HEADERS]
    expect(row[headerRow.indexOf('Company')]).toBe('')
    expect(row[headerRow.indexOf('Address1')]).toBe('')
    expect(row[headerRow.indexOf('City')]).toBe('')
  })

  it('falls back to address phone when customer phone is null', () => {
    const c = makeCustomer({ phone: null })
    c.default_address!.phone = '+44999'
    const row = customerToRow(c)
    const headerRow = [...CUSTOMER_CSV_HEADERS]
    expect(row[headerRow.indexOf('Phone')]).toBe('+44999')
  })

  it('defaults total_spent to 0.00 and orders_count to 0 when null', () => {
    const row = customerToRow(
      makeCustomer({ total_spent: null, orders_count: null }),
    )
    const headerRow = [...CUSTOMER_CSV_HEADERS]
    expect(row[headerRow.indexOf('Total Spent')]).toBe('0.00')
    expect(row[headerRow.indexOf('Total Orders')]).toBe('0')
  })
})

describe('exportCustomersCsv', () => {
  it('first line is the canonical header row', () => {
    const csv = exportCustomersCsv([makeCustomer()])
    const firstLine = csv.split('\n')[0]!
    expect(firstLine.split(',').slice(0, 3)).toEqual(['First Name', 'Last Name', 'Email'])
  })

  it('CSV-escapes cells containing commas, quotes, or newlines', () => {
    const csv = exportCustomersCsv([
      makeCustomer({ note: 'quote "inside", and comma, here' }),
    ])
    // The raw escaped token should contain doubled quotes around the
    // embedded ones and the whole cell wrapped in quotes.
    expect(csv).toContain('"quote ""inside"", and comma, here"')
  })

  it('round-trips through parseCustomersCsv (export → parse) with equal fields', () => {
    const original = makeCustomer()
    const csv = exportCustomersCsv([original])
    const parsed = parseCustomersCsv(csv)
    const [back] = parsed.customers
    expect(back).toBeDefined()
    expect(back!.email).toBe(original.email)
    expect(back!.first_name).toBe(original.first_name)
    expect(back!.last_name).toBe(original.last_name)
    expect(back!.phone).toBe(original.phone)
    expect(back!.accepts_marketing).toBe(original.accepts_marketing)
    expect(back!.tax_exempt).toBe(original.tax_exempt)
    expect(back!.tags).toEqual(original.tags)
    expect(back!.address?.address1).toBe(original.default_address?.address1)
    expect(back!.address?.city).toBe(original.default_address?.city)
    expect(back!.address?.country_code).toBe(original.default_address?.country_code)
  })

  it('emits only header row when given an empty customer list', () => {
    const csv = exportCustomersCsv([])
    const lines = csv.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.split(',').slice(0, 3)).toEqual(['First Name', 'Last Name', 'Email'])
  })
})

describe('exportCustomersCsvStream', () => {
  it('yields header + one chunk per customer', async () => {
    const chunks: string[] = []
    const stream = exportCustomersCsvStream([makeCustomer(), makeCustomer({ id: 'c2', email: 'b@x.com' })])
    for await (const chunk of stream) {
      chunks.push(chunk)
    }
    expect(chunks).toHaveLength(3)
    expect(chunks[0]!.startsWith('First Name,Last Name,Email')).toBe(true)
    expect(chunks[0]!.endsWith('\n')).toBe(true)
    expect(chunks[1]!.endsWith('\n')).toBe(true)
  })
})
