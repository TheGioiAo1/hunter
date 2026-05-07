import { describe, it, expect } from 'vitest'
import { resolveMarketForCountryFromList } from './resolver.js'
import type { MarketRow } from './markets.js'

function mkMarket(overrides: Partial<MarketRow> & { name: string }): MarketRow {
  return {
    id: overrides.id ?? `m-${overrides.name}`,
    shop_id: overrides.shop_id ?? 'shop-1',
    name: overrides.name,
    status: overrides.status ?? 'active',
    countries: overrides.countries ?? [],
    is_primary: overrides.is_primary ?? false,
    currency_code: overrides.currency_code ?? 'USD',
    language_code: overrides.language_code ?? 'en',
    created_at: overrides.created_at ?? new Date(),
    updated_at: overrides.updated_at ?? new Date(),
  }
}

describe('resolveMarketForCountryFromList', () => {
  it('exact match wins over primary + rest-of-world', () => {
    const markets: MarketRow[] = [
      mkMarket({ name: 'US', countries: ['US'], currency_code: 'USD' }),
      mkMarket({ name: 'EU', countries: ['DE', 'FR', 'IT'], currency_code: 'EUR' }),
      mkMarket({ name: 'Primary', is_primary: true, countries: ['VN'] }),
      mkMarket({ name: 'Rest', countries: [] }),
    ]
    const res = resolveMarketForCountryFromList(markets, 'DE')
    expect(res.reason).toBe('exact')
    expect(res.market?.name).toBe('EU')
  })

  it('falls back to primary when no country match', () => {
    const markets: MarketRow[] = [
      mkMarket({ name: 'EU', countries: ['DE', 'FR'] }),
      mkMarket({ name: 'Home', is_primary: true, countries: ['US'] }),
      mkMarket({ name: 'Rest', countries: [] }),
    ]
    const res = resolveMarketForCountryFromList(markets, 'JP')
    expect(res.reason).toBe('primary')
    expect(res.market?.name).toBe('Home')
  })

  it('falls back to rest-of-world (empty countries) when no primary', () => {
    const markets: MarketRow[] = [
      mkMarket({ name: 'EU', countries: ['DE', 'FR'] }),
      mkMarket({ name: 'Rest', countries: [] }),
    ]
    const res = resolveMarketForCountryFromList(markets, 'ZA')
    expect(res.reason).toBe('rest_of_world')
    expect(res.market?.name).toBe('Rest')
  })

  it('returns null when nothing configured', () => {
    expect(resolveMarketForCountryFromList([], 'DE')).toEqual({
      market: null,
      reason: 'none',
    })
  })

  it('skips inactive markets even on exact match', () => {
    const markets: MarketRow[] = [
      mkMarket({ name: 'EU-inactive', status: 'inactive', countries: ['DE'] }),
      mkMarket({ name: 'Rest', countries: [] }),
    ]
    const res = resolveMarketForCountryFromList(markets, 'DE')
    expect(res.reason).toBe('rest_of_world')
    expect(res.market?.name).toBe('Rest')
  })

  it('skips draft markets', () => {
    const markets: MarketRow[] = [
      mkMarket({ name: 'EU-draft', status: 'draft', countries: ['DE'] }),
      mkMarket({ name: 'Primary', is_primary: true, countries: ['US'] }),
    ]
    const res = resolveMarketForCountryFromList(markets, 'DE')
    expect(res.reason).toBe('primary')
    expect(res.market?.name).toBe('Primary')
  })

  it('normalises country code (lowercase + whitespace)', () => {
    const markets: MarketRow[] = [
      mkMarket({ name: 'EU', countries: ['DE', 'FR'] }),
    ]
    expect(resolveMarketForCountryFromList(markets, 'de').market?.name).toBe('EU')
    expect(resolveMarketForCountryFromList(markets, ' FR ').market?.name).toBe('EU')
  })

  it('null/empty country falls through to primary', () => {
    const markets: MarketRow[] = [
      mkMarket({ name: 'Primary', is_primary: true, countries: ['US'] }),
    ]
    expect(resolveMarketForCountryFromList(markets, null).reason).toBe('primary')
    expect(resolveMarketForCountryFromList(markets, '').reason).toBe('primary')
    expect(resolveMarketForCountryFromList(markets, undefined).reason).toBe('primary')
  })

  it('invalid country code falls through (e.g. "USA" is 3-letter)', () => {
    const markets: MarketRow[] = [
      mkMarket({ name: 'US', countries: ['US'] }),
      mkMarket({ name: 'Rest', countries: [] }),
    ]
    // "USA" is not a valid ISO-2 → skip exact match step.
    const res = resolveMarketForCountryFromList(markets, 'USA')
    expect(res.reason).toBe('rest_of_world')
  })

  it('prefers first exact match when a country appears in two markets', () => {
    // Theoretically a misconfiguration — service layer should prevent it —
    // but the resolver is defensive: returns a deterministic first-wins.
    const markets: MarketRow[] = [
      mkMarket({ id: 'm-a', name: 'A', countries: ['DE'] }),
      mkMarket({ id: 'm-b', name: 'B', countries: ['DE'] }),
    ]
    const res = resolveMarketForCountryFromList(markets, 'DE')
    expect(res.reason).toBe('exact')
    expect(res.market?.id).toBe('m-a')
  })
})
