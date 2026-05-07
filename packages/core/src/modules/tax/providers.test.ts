/**
 * Phase 9 / PR2 — Tax Provider Tests
 *
 * Exercises the stub provider path + reverse-charge classifier.
 * Live-rate adapters aren't implemented in PR2 — we assert the
 * error signalling is correct and that the checkout never silently
 * falls back to the stub when creds are missing.
 */

import { describe, it, expect } from 'vitest'
import {
  createStubProvider,
  buildTaxProviderForShop,
  shouldReverseCharge,
  MissingTaxCredentialsError,
} from './providers.js'

describe('shouldReverseCharge', () => {
  it('true for DE seller → FR buyer with VAT ID (cross-EU B2B)', () => {
    expect(
      shouldReverseCharge({
        origin: { country_code: 'DE' },
        destination: { country_code: 'FR', vat_id: 'FR12345678901' },
        subtotal: 100,
        shipping: 0,
        currency: 'EUR',
      }),
    ).toBe(true)
  })

  it('true when buyer_is_business flag is set without vat_id', () => {
    expect(
      shouldReverseCharge({
        origin: { country_code: 'DE' },
        destination: { country_code: 'IT' },
        subtotal: 100,
        shipping: 0,
        currency: 'EUR',
        buyer_is_business: true,
      }),
    ).toBe(true)
  })

  it('false for same-country B2B (DE → DE with VAT ID)', () => {
    expect(
      shouldReverseCharge({
        origin: { country_code: 'DE' },
        destination: { country_code: 'DE', vat_id: 'DE123456789' },
        subtotal: 100,
        shipping: 0,
        currency: 'EUR',
      }),
    ).toBe(false)
  })

  it('false for EU → non-EU (DE → CH)', () => {
    expect(
      shouldReverseCharge({
        origin: { country_code: 'DE' },
        destination: { country_code: 'CH', vat_id: 'CH1234' },
        subtotal: 100,
        shipping: 0,
        currency: 'EUR',
      }),
    ).toBe(false)
  })

  it('false for non-EU origin (US → DE)', () => {
    expect(
      shouldReverseCharge({
        origin: { country_code: 'US' },
        destination: { country_code: 'DE', vat_id: 'DE123456789' },
        subtotal: 100,
        shipping: 0,
        currency: 'EUR',
      }),
    ).toBe(false)
  })

  it('false for cross-EU B2C (no VAT ID, no business flag)', () => {
    expect(
      shouldReverseCharge({
        origin: { country_code: 'DE' },
        destination: { country_code: 'FR' },
        subtotal: 100,
        shipping: 0,
        currency: 'EUR',
      }),
    ).toBe(false)
  })

  it('false for empty VAT ID string', () => {
    expect(
      shouldReverseCharge({
        origin: { country_code: 'DE' },
        destination: { country_code: 'FR', vat_id: '   ' },
        subtotal: 100,
        shipping: 0,
        currency: 'EUR',
      }),
    ).toBe(false)
  })

  it('excludes UK from EU (post-Brexit)', () => {
    // GB → DE with VAT: not reverse-charge because GB is not EU
    expect(
      shouldReverseCharge({
        origin: { country_code: 'GB' },
        destination: { country_code: 'DE', vat_id: 'DE123' },
        subtotal: 100,
        shipping: 0,
        currency: 'EUR',
      }),
    ).toBe(false)
    // DE → GB with VAT: not reverse-charge either
    expect(
      shouldReverseCharge({
        origin: { country_code: 'DE' },
        destination: { country_code: 'GB', vat_id: 'GB123' },
        subtotal: 100,
        shipping: 0,
        currency: 'EUR',
      }),
    ).toBe(false)
  })

  it('case-insensitive on country codes', () => {
    expect(
      shouldReverseCharge({
        origin: { country_code: 'de' },
        destination: { country_code: 'fr', vat_id: 'FR123' },
        subtotal: 100,
        shipping: 0,
        currency: 'EUR',
      }),
    ).toBe(true)
  })
})

describe('createStubProvider', () => {
  const provider = createStubProvider()

  it('returns a single California sales-tax line for US + CA @ 100', async () => {
    const lines = await provider.getRates({
      origin: { country_code: 'US' },
      destination: { country_code: 'US', province_code: 'CA' },
      subtotal: 100,
      shipping: 0,
      currency: 'USD',
    })
    expect(lines.length).toBe(1)
    expect(lines[0].jurisdiction_code).toBe('US-CA')
    expect(lines[0].kind).toBe('sales')
    expect(lines[0].rate).toBe(0.0725)
    expect(lines[0].amount).toBeCloseTo(7.25, 2)
  })

  it('returns empty for zero-rate US states (OR, NH)', async () => {
    const or = await provider.getRates({
      origin: { country_code: 'US' },
      destination: { country_code: 'US', province_code: 'OR' },
      subtotal: 100, shipping: 0, currency: 'USD',
    })
    expect(or).toEqual([])

    const nh = await provider.getRates({
      origin: { country_code: 'US' },
      destination: { country_code: 'US', province_code: 'NH' },
      subtotal: 100, shipping: 0, currency: 'USD',
    })
    expect(nh).toEqual([])
  })

  it('returns a single German VAT line for DE @ 100', async () => {
    const lines = await provider.getRates({
      origin: { country_code: 'US' },
      destination: { country_code: 'DE' },
      subtotal: 100, shipping: 0, currency: 'EUR',
    })
    expect(lines.length).toBe(1)
    expect(lines[0].jurisdiction_code).toBe('DE')
    expect(lines[0].kind).toBe('vat')
    expect(lines[0].rate).toBe(0.19)
    expect(lines[0].amount).toBeCloseTo(19, 2)
  })

  it('returns Vietnam 10% VAT line', async () => {
    const lines = await provider.getRates({
      origin: { country_code: 'US' },
      destination: { country_code: 'VN' },
      subtotal: 100, shipping: 0, currency: 'USD',
    })
    expect(lines.length).toBe(1)
    expect(lines[0].rate).toBe(0.10)
    expect(lines[0].amount).toBeCloseTo(10, 2)
  })

  it('adds shipping to taxable amount when tax_shipping=true + seed allows', async () => {
    // NY taxes shipping per the seed
    const lines = await provider.getRates({
      origin: { country_code: 'US' },
      destination: { country_code: 'US', province_code: 'NY' },
      subtotal: 100, shipping: 10, currency: 'USD',
      tax_shipping: true,
    })
    expect(lines.length).toBe(1)
    // NY = 4% * (100 + 10) = 4.40
    expect(lines[0].amount).toBeCloseTo(4.40, 2)
    expect(lines[0].applies_to_shipping).toBe(true)
  })

  it('does not tax shipping when tax_shipping=false', async () => {
    const lines = await provider.getRates({
      origin: { country_code: 'US' },
      destination: { country_code: 'US', province_code: 'NY' },
      subtotal: 100, shipping: 10, currency: 'USD',
      tax_shipping: false,
    })
    // 4% * 100 = 4.00 (shipping not taxed)
    expect(lines[0].amount).toBeCloseTo(4.00, 2)
    expect(lines[0].applies_to_shipping).toBe(false)
  })

  it('returns reverse-charge zero-rated line for EU cross-border B2B', async () => {
    const lines = await provider.getRates({
      origin: { country_code: 'DE' },
      destination: { country_code: 'FR', vat_id: 'FR12345678901' },
      subtotal: 100, shipping: 0, currency: 'EUR',
    })
    expect(lines.length).toBe(1)
    expect(lines[0].kind).toBe('vat_reverse_charge')
    expect(lines[0].rate).toBe(0)
    expect(lines[0].amount).toBe(0)
    expect(lines[0].jurisdiction_code).toBe('FR')
  })

  it('returns empty when destination is unknown/unserviced', async () => {
    const lines = await provider.getRates({
      origin: { country_code: 'US' },
      destination: { country_code: 'XX' },
      subtotal: 100, shipping: 0, currency: 'USD',
    })
    expect(lines).toEqual([])
  })

  it('returns empty for US without a province code', async () => {
    const lines = await provider.getRates({
      origin: { country_code: 'US' },
      destination: { country_code: 'US' },
      subtotal: 100, shipping: 0, currency: 'USD',
    })
    expect(lines).toEqual([])
  })
})

describe('buildTaxProviderForShop', () => {
  it('defaults to stub when use_live_rates is false', () => {
    const p = buildTaxProviderForShop({
      use_live_rates: false,
      credentials_json: null,
    })
    expect(p.kind).toBe('stub')
  })

  it('defaults to stub when no options are passed', () => {
    const p = buildTaxProviderForShop()
    expect(p.kind).toBe('stub')
  })

  it('throws MissingTaxCredentialsError when live + null creds', () => {
    expect(() =>
      buildTaxProviderForShop({
        use_live_rates: true,
        credentials_json: null,
      }),
    ).toThrow(MissingTaxCredentialsError)
  })

  it('throws MissingTaxCredentialsError when live + empty creds object', () => {
    expect(() =>
      buildTaxProviderForShop({
        use_live_rates: true,
        credentials_json: {},
      }),
    ).toThrow(MissingTaxCredentialsError)
  })

  it('throws "not yet implemented" when live + creds present', () => {
    expect(() =>
      buildTaxProviderForShop({
        use_live_rates: true,
        credentials_json: { api_key: 'fake' },
      }),
    ).toThrow(/not yet implemented/i)
  })

  it('error message mentions Gbox support (iron-rule-5)', () => {
    try {
      buildTaxProviderForShop({
        use_live_rates: true,
        credentials_json: { api_key: 'x' },
      })
    } catch (err: any) {
      expect(err.message).toMatch(/Gbox support/i)
      // MUST NOT leak god-admin path
      expect(err.message.toLowerCase()).not.toMatch(/god.?admin/)
    }
  })
})
