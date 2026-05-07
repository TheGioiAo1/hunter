import { describe, it, expect } from 'vitest'
import { parseCustomersCsv, ParseError } from './csv-parser.js'

function buildCsv(...lines: string[]): string {
  return lines.join('\n') + '\n'
}

describe('parseCustomersCsv', () => {
  it('parses a minimal Shopify-shape file with just Email', () => {
    const csv = buildCsv('Email', 'first@example.com', 'second@example.com')
    const result = parseCustomersCsv(csv)
    expect(result.customers).toHaveLength(2)
    expect(result.customers[0]!.email).toBe('first@example.com')
    expect(result.customers[0]!.sourceRow).toBe(2)
    expect(result.customers[1]!.email).toBe('second@example.com')
    expect(result.customers[1]!.sourceRow).toBe(3)
  })

  it('throws ParseError when Email column is missing', () => {
    const csv = buildCsv('First Name,Last Name', 'Ada,Lovelace')
    expect(() => parseCustomersCsv(csv)).toThrow(ParseError)
  })

  it('throws ParseError when file is empty', () => {
    expect(() => parseCustomersCsv('')).toThrow(ParseError)
  })

  it('maps full Shopify column set to customer + address', () => {
    const csv = buildCsv(
      'First Name,Last Name,Email,Company,Address1,Address2,City,Province,Province Code,Country,Country Code,Zip,Phone,Accepts Email Marketing,Total Spent,Total Orders,Note,Tags,Tax Exempt',
      'Ada,Lovelace,ada@example.com,Analytical Engines,1 Byron St,,London,England,ENG,United Kingdom,GB,WC1,+44123,yes,42.50,3,VIP loves us,"vip, wholesale",no',
    )
    const [c] = parseCustomersCsv(csv).customers
    expect(c).toBeDefined()
    expect(c!.first_name).toBe('Ada')
    expect(c!.last_name).toBe('Lovelace')
    expect(c!.email).toBe('ada@example.com')
    expect(c!.phone).toBe('+44123')
    expect(c!.accepts_marketing).toBe(true)
    expect(c!.note).toBe('VIP loves us')
    expect(c!.tags).toEqual(['vip', 'wholesale'])
    expect(c!.tax_exempt).toBe(false)
    expect(c!.address).not.toBeNull()
    expect(c!.address?.company).toBe('Analytical Engines')
    expect(c!.address?.address1).toBe('1 Byron St')
    expect(c!.address?.city).toBe('London')
    expect(c!.address?.province).toBe('England')
    expect(c!.address?.province_code).toBe('ENG')
    expect(c!.address?.country).toBe('United Kingdom')
    expect(c!.address?.country_code).toBe('GB')
    expect(c!.address?.zip).toBe('WC1')
  })

  it('address is null when all address columns are blank', () => {
    const csv = buildCsv(
      'First Name,Last Name,Email,Address1,City',
      'Ada,Lovelace,ada@example.com,,',
    )
    const [c] = parseCustomersCsv(csv).customers
    expect(c!.address).toBeNull()
  })

  it('accepts alias headers (accepts_marketing / Accepts Marketing)', () => {
    const csv = buildCsv(
      'email,first_name,accepts_marketing,tags,tax_exempt',
      'grace@example.com,Grace,true,"vip, senior",yes',
    )
    const [c] = parseCustomersCsv(csv).customers
    expect(c!.first_name).toBe('Grace')
    expect(c!.accepts_marketing).toBe(true)
    expect(c!.tags).toEqual(['vip', 'senior'])
    expect(c!.tax_exempt).toBe(true)
  })

  it('skips blank rows without producing phantom customers', () => {
    const csv = buildCsv(
      'Email,First Name',
      'a@example.com,A',
      ',',
      '',
      'b@example.com,B',
    )
    const result = parseCustomersCsv(csv)
    expect(result.customers).toHaveLength(2)
    expect(result.customers.map((c) => c.email)).toEqual(['a@example.com', 'b@example.com'])
  })

  it('captures unknown columns on extraColumns', () => {
    const csv = buildCsv(
      'Email,Shopify Customer ID,Metafield: custom.vip',
      'a@example.com,gid://shopify/Customer/42,true',
    )
    const result = parseCustomersCsv(csv)
    expect(result.extraColumns).toContain('Shopify Customer ID')
    expect(result.extraColumns).toContain('Metafield: custom.vip')
    expect(result.customers[0]!.extraColumns).toEqual({
      'Shopify Customer ID': 'gid://shopify/Customer/42',
      'Metafield: custom.vip': 'true',
    })
  })

  it('notes duplicate emails and keeps both rows (later wins)', () => {
    const csv = buildCsv(
      'Email,First Name',
      'a@example.com,First',
      'a@example.com,Second',
    )
    const result = parseCustomersCsv(csv)
    expect(result.customers).toHaveLength(2)
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]!.line).toBe(3)
    expect(result.notes[0]!.message).toMatch(/duplicate email/i)
  })

  it('treats email case-insensitively for duplicate detection', () => {
    const csv = buildCsv(
      'Email',
      'Ada@Example.com',
      'ADA@example.com',
    )
    const result = parseCustomersCsv(csv)
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]!.line).toBe(3)
  })

  it('handles quoted cells with commas and newlines', () => {
    const csv =
      'Email,Note\n' +
      '"a@example.com","multi-line\nnote, with comma"\n'
    const [c] = parseCustomersCsv(csv).customers
    expect(c!.email).toBe('a@example.com')
    expect(c!.note).toBe('multi-line\nnote, with comma')
  })

  it('strips UTF-8 BOM from first cell', () => {
    const csv = '\uFEFFEmail\nada@example.com\n'
    const result = parseCustomersCsv(csv)
    expect(result.customers[0]!.email).toBe('ada@example.com')
  })
})
