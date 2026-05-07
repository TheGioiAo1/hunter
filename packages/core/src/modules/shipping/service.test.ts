/**
 * Phase 9 / PR1 — Shipping Service Tests (computeShippingRates)
 *
 * Drives the checkout-entry function with the same in-memory Kysely
 * fake used by carriers.test.ts. The goal is to prove the merge
 * logic (stored rates + provider quotes + sort + error bucketing).
 */

import { describe, it, expect } from 'vitest'
import { computeShippingRates } from './service.js'

// ---------------------------------------------------------------------------
// Minimal fake Kysely — reused pattern from carriers.test.ts.
// Keeps this test module self-contained.
// ---------------------------------------------------------------------------

function makeFakeDb(initial?: {
  carriers?: any[]
  zones?: any[]
  rates?: any[]
}) {
  const state = {
    carriers: initial?.carriers ? [...initial.carriers] : [],
    zones: initial?.zones ? [...initial.zones] : [],
    rates: initial?.rates ? [...initial.rates] : [],
  }

  function table(name: string): any[] {
    return (state as any)[
      name === 'shipping_carriers' ? 'carriers'
      : name === 'shipping_zones' ? 'zones'
      : 'rates'
    ]
  }

  const fakeDb: any = {
    _state: state,
    selectFrom(name: string) {
      const filters: any[] = []
      const builder: any = {
        select: () => builder,
        selectAll: () => builder,
        where: (colOrFn: any, op?: any, val?: any) => {
          if (typeof colOrFn === 'function') return builder
          filters.push({ col: colOrFn, op, val })
          return builder
        },
        orderBy: () => builder,
        execute: async () => {
          return table(name).filter((r) =>
            filters.every(({ col, op, val }) => {
              if (op === '=') return r[col] === val
              if (op === 'in') return val.includes(r[col])
              if (op === 'is' && val === null) return r[col] == null
              return true
            }),
          )
        },
      }
      return builder
    },
  }
  return fakeDb
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeShippingRates', () => {
  it('returns empty offers when nothing in the cart ships', async () => {
    const db = makeFakeDb()
    const result = await computeShippingRates(db, 'shop-1', { country: 'US' }, [
      { variant_id: 'v1', quantity: 1, price: '20', requires_shipping: false },
    ])
    expect(result.offers).toEqual([])
    expect(result.errors).toEqual([])
  })

  it('throws when address has no country', async () => {
    const db = makeFakeDb()
    await expect(
      computeShippingRates(db, 'shop-1', {}, [
        { variant_id: 'v1', quantity: 1, price: '20' },
      ]),
    ).rejects.toThrow(/country/)
  })

  it('returns stored rates from matching zones only', async () => {
    const db = makeFakeDb({
      zones: [
        { id: 'z-us', shop_id: 'shop-1', name: 'US',
          countries: ['US'], kind: 'domestic', region_code: 'US' },
        { id: 'z-uk', shop_id: 'shop-1', name: 'UK',
          countries: ['GB'], kind: 'domestic', region_code: 'UK' },
      ],
      rates: [
        { id: 'r1', zone_id: 'z-us', name: 'Flat US', price: '9.99',
          type: 'flat', min_value: null, max_value: null,
          carrier_kind: null, service_code: null,
          weight_min_lb: null, weight_max_lb: null,
          transit_days_min: null, transit_days_max: null, currency: 'USD' },
        { id: 'r2', zone_id: 'z-uk', name: 'Flat UK', price: '5.5',
          type: 'flat', min_value: null, max_value: null,
          carrier_kind: null, service_code: null,
          weight_min_lb: null, weight_max_lb: null,
          transit_days_min: null, transit_days_max: null, currency: 'GBP' },
      ],
    })
    const result = await computeShippingRates(db, 'shop-1', { country: 'US' }, [
      { variant_id: 'v1', quantity: 1, price: '20' },
    ])
    expect(result.offers.length).toBe(1)
    expect(result.offers[0].name).toBe('Flat US')
    expect(result.offers[0].source).toBe('stored')
  })

  it('matches weight brackets on migration-066 rows', async () => {
    const db = makeFakeDb({
      zones: [
        { id: 'z-us', shop_id: 'shop-1', name: 'US',
          countries: ['US'], kind: 'domestic', region_code: 'US' },
      ],
      rates: [
        { id: 'r1', zone_id: 'z-us', name: 'Priority 0-1lb', price: '9.95',
          type: 'weight_based', min_value: '0', max_value: '1',
          carrier_kind: 'usps', service_code: 'priority_mail',
          weight_min_lb: '0', weight_max_lb: '1',
          transit_days_min: 1, transit_days_max: 3, currency: 'USD' },
        { id: 'r2', zone_id: 'z-us', name: 'Priority 5-10lb', price: '24.5',
          type: 'weight_based', min_value: '5', max_value: '10',
          carrier_kind: 'usps', service_code: 'priority_mail',
          weight_min_lb: '5', weight_max_lb: '10',
          transit_days_min: 1, transit_days_max: 3, currency: 'USD' },
      ],
    })
    // Cart weight = 6lb → matches r2 only
    const result = await computeShippingRates(db, 'shop-1', { country: 'US' }, [
      { variant_id: 'v1', quantity: 2, price: '20', weight: '3' },
    ])
    expect(result.offers.length).toBe(1)
    expect(result.offers[0].id).toBe('r2')
    expect(result.offers[0].carrier_kind).toBe('usps')
    expect(result.offers[0].transit_days_min).toBe(1)
  })

  it('merges provider quotes with stored rates and sorts by price', async () => {
    const db = makeFakeDb({
      zones: [
        { id: 'z-us', shop_id: 'shop-1', name: 'US',
          countries: ['US'], kind: 'domestic', region_code: 'US' },
      ],
      rates: [
        { id: 'r1', zone_id: 'z-us', name: 'Flat $100 (luxury)', price: '100',
          type: 'flat', min_value: null, max_value: null,
          carrier_kind: null, service_code: null,
          weight_min_lb: null, weight_max_lb: null,
          transit_days_min: null, transit_days_max: null, currency: 'USD' },
      ],
      carriers: [
        { id: 'c1', shop_id: 'shop-1', kind: 'usps',
          display_name: 'USPS', enabled: true, use_live_rates: false,
          credentials_json: null },
      ],
    })
    const result = await computeShippingRates(db, 'shop-1', { country: 'US' }, [
      { variant_id: 'v1', quantity: 1, price: '30', weight: '2' },
    ])
    // Stored flat $100 + several USPS stub quotes. Sorted ascending.
    expect(result.offers.length).toBeGreaterThan(1)
    for (let i = 1; i < result.offers.length; i++) {
      expect(result.offers[i].price).toBeGreaterThanOrEqual(result.offers[i - 1].price)
    }
    // Stored source + provider source both present
    const sources = new Set(result.offers.map((o) => o.source))
    expect(sources.has('stored')).toBe(true)
    expect(sources.has('provider')).toBe(true)
  })

  it('swallows MissingCarrierCredentialsError and surfaces it in errors[]', async () => {
    const db = makeFakeDb({
      zones: [
        { id: 'z-us', shop_id: 'shop-1', name: 'US',
          countries: ['US'], kind: 'domestic', region_code: 'US' },
      ],
      rates: [],
      carriers: [
        { id: 'c1', shop_id: 'shop-1', kind: 'usps', display_name: 'USPS',
          enabled: true, use_live_rates: true, credentials_json: null },
      ],
    })
    const result = await computeShippingRates(db, 'shop-1', { country: 'US' }, [
      { variant_id: 'v1', quantity: 1, price: '30', weight: '2' },
    ])
    expect(result.offers).toEqual([])
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].carrier).toBe('usps')
    expect(result.errors[0].message.toLowerCase()).toMatch(/credentials|not implemented/)
  })

  it('filters stored rates to carrier-only when carriers_only=true', async () => {
    const db = makeFakeDb({
      zones: [
        { id: 'z-us', shop_id: 'shop-1', name: 'US',
          countries: ['US'], kind: 'domestic', region_code: 'US' },
      ],
      rates: [
        // Pre-066 row (no carrier)
        { id: 'r-legacy', zone_id: 'z-us', name: 'Custom',
          price: '12', type: 'flat', min_value: null, max_value: null,
          carrier_kind: null, service_code: null,
          weight_min_lb: null, weight_max_lb: null,
          transit_days_min: null, transit_days_max: null, currency: 'USD' },
        // Seeded row (carrier set)
        { id: 'r-carrier', zone_id: 'z-us', name: 'Ground',
          price: '15', type: 'weight_based', min_value: null, max_value: null,
          carrier_kind: 'ups', service_code: 'ground',
          weight_min_lb: '0', weight_max_lb: '70',
          transit_days_min: 1, transit_days_max: 5, currency: 'USD' },
      ],
    })

    const defaultRes = await computeShippingRates(db, 'shop-1', { country: 'US' }, [
      { variant_id: 'v1', quantity: 1, price: '30', weight: '2' },
    ])
    expect(defaultRes.offers.length).toBe(2)

    const carriersOnly = await computeShippingRates(
      db, 'shop-1', { country: 'US' },
      [{ variant_id: 'v1', quantity: 1, price: '30', weight: '2' }],
      { carriers_only: true },
    )
    expect(carriersOnly.offers.length).toBe(1)
    expect(carriersOnly.offers[0].id).toBe('r-carrier')
  })

  it('sums cart weight across items', async () => {
    const db = makeFakeDb({
      zones: [
        { id: 'z-us', shop_id: 'shop-1', name: 'US',
          countries: ['US'], kind: 'domestic', region_code: 'US' },
      ],
      rates: [
        { id: 'r-light', zone_id: 'z-us', name: 'Light',
          price: '5', type: 'weight_based', min_value: '0', max_value: '5',
          carrier_kind: null, service_code: null,
          weight_min_lb: '0', weight_max_lb: '5',
          transit_days_min: null, transit_days_max: null, currency: 'USD' },
        { id: 'r-heavy', zone_id: 'z-us', name: 'Heavy',
          price: '20', type: 'weight_based', min_value: '5', max_value: '50',
          carrier_kind: null, service_code: null,
          weight_min_lb: '5', weight_max_lb: '50',
          transit_days_min: null, transit_days_max: null, currency: 'USD' },
      ],
    })

    // 2 items of 3lb = 6lb total → matches r-heavy, NOT r-light
    const result = await computeShippingRates(db, 'shop-1', { country: 'US' }, [
      { variant_id: 'v1', quantity: 2, price: '30', weight: '3' },
    ])
    expect(result.offers.length).toBe(1)
    expect(result.offers[0].id).toBe('r-heavy')
  })

  it('returns empty when no zones match destination country', async () => {
    const db = makeFakeDb({
      zones: [
        { id: 'z-us', shop_id: 'shop-1', name: 'US',
          countries: ['US'], kind: 'domestic', region_code: 'US' },
      ],
    })
    const result = await computeShippingRates(db, 'shop-1', { country: 'FR' }, [
      { variant_id: 'v1', quantity: 1, price: '20' },
    ])
    expect(result.offers).toEqual([])
  })

  it('case-insensitive country code matching', async () => {
    const db = makeFakeDb({
      zones: [
        { id: 'z-us', shop_id: 'shop-1', name: 'US',
          countries: ['US'], kind: 'domestic', region_code: 'US' },
      ],
      rates: [
        { id: 'r1', zone_id: 'z-us', name: 'Flat', price: '7.5',
          type: 'flat', min_value: null, max_value: null,
          carrier_kind: null, service_code: null,
          weight_min_lb: null, weight_max_lb: null,
          transit_days_min: null, transit_days_max: null, currency: 'USD' },
      ],
    })
    const result = await computeShippingRates(db, 'shop-1', { country_code: 'us' }, [
      { variant_id: 'v1', quantity: 1, price: '20' },
    ])
    expect(result.offers.length).toBe(1)
  })
})
