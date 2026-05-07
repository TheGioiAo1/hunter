/**
 * Phase 9 / PR1 — Rate Provider Tests
 *
 * Exercises the stub provider path. Live-rate adapters aren't
 * implemented in PR1 — we assert the error signalling is correct.
 */

import { describe, it, expect } from 'vitest'
import {
  createStubProvider,
  buildProviderForShopCarrier,
  buildProvidersForShop,
  resolveRegion,
  MissingCarrierCredentialsError,
} from './providers.js'

describe('resolveRegion', () => {
  it('USPS + US → US domestic', () => {
    expect(resolveRegion('usps', 'US')).toBe('US')
  })
  it('USPS + CA → INT', () => {
    expect(resolveRegion('usps', 'CA')).toBe('INT')
  })
  it('DHL Express + DE → EU', () => {
    expect(resolveRegion('dhl_express', 'DE')).toBe('EU')
  })
  it('DHL Express + US → INT', () => {
    expect(resolveRegion('dhl_express', 'US')).toBe('INT')
  })
  it('DHL Paket + DE → EU-DE', () => {
    expect(resolveRegion('dhl_paket', 'DE')).toBe('EU-DE')
  })
  it('DHL Paket + US → null (not serviced)', () => {
    expect(resolveRegion('dhl_paket', 'US')).toBeNull()
  })
  it('Royal Mail + GB → UK', () => {
    expect(resolveRegion('royal_mail', 'GB')).toBe('UK')
  })
  it('Royal Mail + US → INT', () => {
    expect(resolveRegion('royal_mail', 'US')).toBe('INT')
  })
  it('La Poste + FR → EU-FR', () => {
    expect(resolveRegion('la_poste', 'FR')).toBe('EU-FR')
  })
  it('DPD + any EU → EU', () => {
    expect(resolveRegion('dpd', 'NL')).toBe('EU')
    expect(resolveRegion('dpd', 'BE')).toBe('EU')
    expect(resolveRegion('dpd', 'IT')).toBe('EU')
  })
  it('PostNL + NL → EU-NL', () => {
    expect(resolveRegion('postnl', 'NL')).toBe('EU-NL')
  })
  it('GLS + non-EU → null (not serviced)', () => {
    expect(resolveRegion('gls', 'US')).toBeNull()
  })
  it('Hermes + non-GB → null', () => {
    expect(resolveRegion('hermes', 'FR')).toBeNull()
  })
  it('Bpost + BE → EU-BE', () => {
    expect(resolveRegion('bpost', 'BE')).toBe('EU-BE')
  })
  it('case-insensitive country code', () => {
    expect(resolveRegion('usps', 'us')).toBe('US')
    expect(resolveRegion('royal_mail', 'gb')).toBe('UK')
  })
})

describe('createStubProvider', () => {
  it('USPS → multiple services for a 2lb domestic parcel', async () => {
    const provider = createStubProvider('usps')
    const quotes = await provider.getRates({
      origin: { country_code: 'US' },
      destination: { country_code: 'US' },
      weight_lb: 2,
      declared_value_usd: 50,
      currency: 'USD',
    })

    expect(quotes.length).toBeGreaterThanOrEqual(3)
    // Sorted cheap → expensive
    for (let i = 1; i < quotes.length; i++) {
      expect(quotes[i].rate).toBeGreaterThanOrEqual(quotes[i - 1].rate)
    }
    // Every quote is USPS
    for (const q of quotes) {
      expect(q.carrier_kind).toBe('usps')
    }
  })

  it('UPS → 6 services for a 5lb domestic parcel', async () => {
    const provider = createStubProvider('ups')
    const quotes = await provider.getRates({
      origin: { country_code: 'US' },
      destination: { country_code: 'US' },
      weight_lb: 5,
      declared_value_usd: 100,
      currency: 'USD',
    })
    expect(quotes.length).toBe(4) // ground + 3-day + 2nd-day + next-day
  })

  it('returns empty array when destination is unserviced', async () => {
    const provider = createStubProvider('hermes')
    const quotes = await provider.getRates({
      origin: { country_code: 'GB' },
      destination: { country_code: 'US' }, // Hermes doesn't ship US
      weight_lb: 1,
      declared_value_usd: 20,
      currency: 'USD',
    })
    expect(quotes).toEqual([])
  })

  it('FedEx international @ 10lb → INT quotes', async () => {
    const provider = createStubProvider('fedex')
    const quotes = await provider.getRates({
      origin: { country_code: 'US' },
      destination: { country_code: 'CA' },
      weight_lb: 10,
      declared_value_usd: 200,
      currency: 'USD',
    })
    // Only INT services match on non-US destination
    expect(quotes.length).toBeGreaterThan(0)
    for (const q of quotes) {
      expect(['international_economy', 'international_priority']).toContain(q.service_code)
    }
  })

  it('DHL Paket → only ships to DE', async () => {
    const provider = createStubProvider('dhl_paket')
    const de = await provider.getRates({
      origin: { country_code: 'DE' },
      destination: { country_code: 'DE' },
      weight_lb: 5,
      declared_value_usd: 50,
      currency: 'EUR',
    })
    const us = await provider.getRates({
      origin: { country_code: 'DE' },
      destination: { country_code: 'US' },
      weight_lb: 5,
      declared_value_usd: 50,
      currency: 'EUR',
    })
    expect(de.length).toBeGreaterThan(0)
    expect(us).toEqual([])
  })

  it('currency conversion applied to quote rate', async () => {
    const provider = createStubProvider('usps', {
      currency: 'EUR',
      usd_to_currency: 0.9,
    })
    const quotes = await provider.getRates({
      origin: { country_code: 'US' },
      destination: { country_code: 'US' },
      weight_lb: 2,
      declared_value_usd: 50,
      currency: 'EUR',
    })
    expect(quotes.length).toBeGreaterThan(0)
    for (const q of quotes) {
      expect(q.currency).toBe('EUR')
      // 11.85 * 0.9 = 10.665 → rounded to 10.67 (for Priority Mail @ 2lb)
    }
  })

  it('quote id-like fields carry bracket info', async () => {
    const provider = createStubProvider('usps')
    const quotes = await provider.getRates({
      origin: { country_code: 'US' },
      destination: { country_code: 'US' },
      weight_lb: 3,
      declared_value_usd: 50,
      currency: 'USD',
    })
    const priority = quotes.find((q) => q.service_code === 'priority_mail')
    expect(priority).toBeDefined()
    expect(priority!.matched_region).toBe('US')
    expect(priority!.matched_weight_lb_min).toBe(2)
    expect(priority!.matched_weight_lb_max).toBe(5)
  })

  it('throws on unknown carrier kind', () => {
    expect(() => createStubProvider('fake' as any)).toThrow(/Unknown carrier kind/)
  })
})

describe('buildProviderForShopCarrier', () => {
  it('returns a stub for enabled + published', () => {
    const p = buildProviderForShopCarrier({
      kind: 'usps',
      enabled: true,
      use_live_rates: false,
      credentials_json: null,
    })
    expect(p).not.toBeNull()
    expect(p!.kind).toBe('usps')
  })

  it('returns null for disabled carriers', () => {
    const p = buildProviderForShopCarrier({
      kind: 'usps',
      enabled: false,
      use_live_rates: false,
      credentials_json: null,
    })
    expect(p).toBeNull()
  })

  it('throws MissingCarrierCredentialsError when live + no creds', () => {
    expect(() =>
      buildProviderForShopCarrier({
        kind: 'usps',
        enabled: true,
        use_live_rates: true,
        credentials_json: null,
      }),
    ).toThrow(MissingCarrierCredentialsError)
  })

  it('throws MissingCarrierCredentialsError when live + empty creds', () => {
    expect(() =>
      buildProviderForShopCarrier({
        kind: 'usps',
        enabled: true,
        use_live_rates: true,
        credentials_json: {},
      }),
    ).toThrow(MissingCarrierCredentialsError)
  })

  it('throws generic error when live + creds exist (not yet implemented)', () => {
    expect(() =>
      buildProviderForShopCarrier({
        kind: 'usps',
        enabled: true,
        use_live_rates: true,
        credentials_json: { api_key: 'fake' },
      }),
    ).toThrow(/not implemented/)
  })

  it('returns null for unknown carrier kind (soft-fail)', () => {
    const p = buildProviderForShopCarrier({
      kind: 'nonexistent',
      enabled: true,
      use_live_rates: false,
      credentials_json: null,
    })
    expect(p).toBeNull()
  })
})

describe('buildProvidersForShop', () => {
  it('builds providers for every enabled row', () => {
    const { providers, errors } = buildProvidersForShop([
      { kind: 'usps', enabled: true, use_live_rates: false, credentials_json: null },
      { kind: 'ups', enabled: true, use_live_rates: false, credentials_json: null },
      { kind: 'fedex', enabled: false, use_live_rates: false, credentials_json: null },
    ])
    expect(providers.length).toBe(2)
    expect(providers.map((p) => p.kind).sort()).toEqual(['ups', 'usps'])
    expect(errors).toEqual([])
  })

  it('reports errors without throwing for missing-creds carriers', () => {
    const { providers, errors } = buildProvidersForShop([
      { kind: 'usps', enabled: true, use_live_rates: false, credentials_json: null },
      { kind: 'ups', enabled: true, use_live_rates: true, credentials_json: null },
    ])
    expect(providers.length).toBe(1)
    expect(providers[0].kind).toBe('usps')
    expect(errors.length).toBe(1)
    expect(errors[0].kind).toBe('ups')
    expect(errors[0].message).toMatch(/credentials/i)
  })

  it('skips disabled rows silently', () => {
    const { providers, errors } = buildProvidersForShop([
      { kind: 'usps', enabled: false, use_live_rates: false, credentials_json: null },
    ])
    expect(providers).toEqual([])
    expect(errors).toEqual([])
  })
})
