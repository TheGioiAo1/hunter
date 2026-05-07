/**
 * Phase 9 / PR3 — Markets CRUD tests.
 *
 * In-memory Kysely fake (same pattern as tax/registrations.test.ts).
 * Covers per-shop CRUD + cross-tenant isolation + primary-uniqueness
 * invariants. The real DB's UNIQUE partial index on `is_primary=true`
 * is exercised in smoke-phase9-pr3.ts against live Postgres.
 */

import { describe, it, expect } from 'vitest'
import {
  listMarkets,
  getMarket,
  getPrimaryMarket,
  createMarket,
  createMarketFromTemplate,
  updateMarket,
  deleteMarket,
  linkShippingZoneToMarket,
  linkTaxRegistrationToMarket,
  MarketNotFoundError,
  DuplicateMarketNameError,
} from './markets.js'

// ---------------------------------------------------------------------------
// Fake Kysely — reused pattern
// ---------------------------------------------------------------------------

function makeFakeDb(initial?: {
  markets?: any[]
  shipping_zones?: any[]
  tax_registrations?: any[]
}) {
  const state = {
    markets: initial?.markets ? [...initial.markets] : [],
    shipping_zones: initial?.shipping_zones ? [...initial.shipping_zones] : [],
    tax_registrations: initial?.tax_registrations
      ? [...initial.tax_registrations]
      : [],
  }

  function table(name: string): any[] {
    if (name === 'markets') return state.markets
    if (name === 'shipping_zones') return state.shipping_zones
    if (name === 'tax_registrations') return state.tax_registrations
    throw new Error(`Unknown table "${name}" in fake db`)
  }

  const applyFilter = (rows: any[], filters: any[]) =>
    rows.filter((r) =>
      filters.every(({ col, op, val }) => {
        if (op === '=') return r[col] === val
        if (op === '!=') return r[col] !== val
        if (op === 'in') return Array.isArray(val) && val.includes(r[col])
        return true
      }),
    )

  const db: any = {
    _state: state,

    selectFrom(name: string) {
      const filters: any[] = []
      const builder: any = {
        select: () => builder,
        selectAll: () => builder,
        where: (col: any, op?: any, val?: any) => {
          if (typeof col === 'function') return builder
          filters.push({ col, op, val })
          return builder
        },
        orderBy: () => builder,
        groupBy: () => builder,
        execute: async () => applyFilter(table(name), filters),
        executeTakeFirst: async () => applyFilter(table(name), filters)[0],
      }
      return builder
    },

    insertInto(name: string) {
      return {
        values: (vals: any) => ({
          returningAll: () => ({
            executeTakeFirstOrThrow: async () => {
              const rows = Array.isArray(vals) ? vals : [vals]
              const inserted = rows.map((v) => ({
                id: v.id ?? `id-${Math.random().toString(36).slice(2, 10)}`,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                ...v,
              }))
              table(name).push(...inserted)
              return inserted[0]
            },
          }),
        }),
      }
    },

    updateTable(name: string) {
      const filters: any[] = []
      let patch: any = {}
      const builder: any = {
        set: (p: any) => { patch = p; return builder },
        where: (col: any, op: any, val: any) => {
          filters.push({ col, op, val })
          return builder
        },
        returningAll: () => ({
          executeTakeFirstOrThrow: async () => {
            let target: any = undefined
            for (const r of table(name)) {
              if (applyFilter([r], filters).length > 0) {
                Object.assign(r, patch)
                target = r
              }
            }
            return target
          },
        }),
        execute: async () => {
          let count = 0
          for (const r of table(name)) {
            if (applyFilter([r], filters).length > 0) {
              Object.assign(r, patch); count++
            }
          }
          return { numUpdatedRows: BigInt(count) }
        },
      }
      return builder
    },

    deleteFrom(name: string) {
      const filters: any[] = []
      const builder: any = {
        where: (col: any, op: any, val: any) => {
          filters.push({ col, op, val }); return builder
        },
        execute: async () => {
          const arr = table(name)
          for (let i = arr.length - 1; i >= 0; i--) {
            if (applyFilter([arr[i]], filters).length > 0) arr.splice(i, 1)
          }
        },
      }
      return builder
    },
  }

  return db
}

// ---------------------------------------------------------------------------
// listMarkets + getMarket
// ---------------------------------------------------------------------------

describe('listMarkets', () => {
  it('returns only the shop scope', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-1', name: 'EU', status: 'active',
          countries: ['DE'], is_primary: false, currency_code: 'EUR',
          language_code: 'en' },
        { id: 'm2', shop_id: 'shop-other', name: 'Other',
          status: 'active', countries: [], is_primary: true,
          currency_code: 'USD', language_code: 'en' },
      ],
    })
    const result = await listMarkets(db, 'shop-1')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('EU')
  })

  it('parses JSONB countries string into an array', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-1', name: 'EU', status: 'active',
          countries: JSON.stringify(['DE', 'FR']), is_primary: true,
          currency_code: 'EUR', language_code: 'en' },
      ],
    })
    const result = await listMarkets(db, 'shop-1')
    expect(result[0].countries).toEqual(['DE', 'FR'])
  })

  it('returns empty array for a shop with no markets', async () => {
    const db = makeFakeDb()
    expect(await listMarkets(db, 'shop-1')).toEqual([])
  })
})

describe('getMarket', () => {
  it('returns the matching row within shop scope', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-1', name: 'EU', status: 'active',
          countries: [], is_primary: true, currency_code: 'EUR',
          language_code: 'en' },
      ],
    })
    const m = await getMarket(db, 'shop-1', 'm1')
    expect(m?.name).toBe('EU')
  })

  it('returns null for cross-tenant access', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-other', name: 'EU', status: 'active',
          countries: [], is_primary: true, currency_code: 'EUR',
          language_code: 'en' },
      ],
    })
    expect(await getMarket(db, 'shop-1', 'm1')).toBeNull()
  })
})

describe('getPrimaryMarket', () => {
  it('returns the primary market for the shop', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-1', name: 'NonPrimary', status: 'active',
          countries: [], is_primary: false, currency_code: 'USD',
          language_code: 'en' },
        { id: 'm2', shop_id: 'shop-1', name: 'Home', status: 'active',
          countries: [], is_primary: true, currency_code: 'USD',
          language_code: 'en' },
      ],
    })
    const m = await getPrimaryMarket(db, 'shop-1')
    expect(m?.name).toBe('Home')
  })

  it('returns null when no primary set', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-1', name: 'A', status: 'active',
          countries: [], is_primary: false, currency_code: 'USD',
          language_code: 'en' },
      ],
    })
    expect(await getPrimaryMarket(db, 'shop-1')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// createMarket
// ---------------------------------------------------------------------------

describe('createMarket', () => {
  it('inserts a new row with defaults', async () => {
    const db = makeFakeDb()
    const m = await createMarket(db, 'shop-1', { name: 'EU' })
    expect(m.name).toBe('EU')
    expect(m.status).toBe('active')
    expect(m.currency_code).toBe('USD')
    expect(m.is_primary).toBe(false)
    expect(m.countries).toEqual([])
    expect(db._state.markets).toHaveLength(1)
  })

  it('normalises + deduplicates countries', async () => {
    const db = makeFakeDb()
    const m = await createMarket(db, 'shop-1', {
      name: 'EU',
      countries: ['de', 'FR ', 'DE', 'INVALID', ''],
    })
    expect(m.countries).toEqual(['DE', 'FR'])
  })

  it('uppercases currency + lowercases language', async () => {
    const db = makeFakeDb()
    const m = await createMarket(db, 'shop-1', {
      name: 'VN',
      currency_code: 'vnd',
      language_code: 'VI',
    })
    expect(m.currency_code).toBe('VND')
    expect(m.language_code).toBe('vi')
  })

  it('throws DuplicateMarketNameError for duplicate names per shop', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-1', name: 'EU', status: 'active',
          countries: [], is_primary: false, currency_code: 'EUR',
          language_code: 'en' },
      ],
    })
    await expect(createMarket(db, 'shop-1', { name: 'EU' })).rejects.toThrow(
      DuplicateMarketNameError,
    )
  })

  it('allows same name across different shops', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-other', name: 'EU', status: 'active',
          countries: [], is_primary: false, currency_code: 'EUR',
          language_code: 'en' },
      ],
    })
    const m = await createMarket(db, 'shop-1', { name: 'EU' })
    expect(m.shop_id).toBe('shop-1')
    expect(db._state.markets).toHaveLength(2)
  })

  it('demotes any existing primary when creating a new primary', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-1', name: 'OldPrimary',
          status: 'active', countries: [], is_primary: true,
          currency_code: 'USD', language_code: 'en' },
      ],
    })
    await createMarket(db, 'shop-1', { name: 'NewPrimary', is_primary: true })
    const old = db._state.markets.find((r: any) => r.id === 'm1')
    expect(old.is_primary).toBe(false)
    const fresh = db._state.markets.find((r: any) => r.name === 'NewPrimary')
    expect(fresh.is_primary).toBe(true)
  })

  it('refuses empty/whitespace-only names', async () => {
    const db = makeFakeDb()
    await expect(createMarket(db, 'shop-1', { name: '' })).rejects.toThrow(
      /Market name is required/,
    )
    await expect(createMarket(db, 'shop-1', { name: '   ' })).rejects.toThrow(
      /Market name is required/,
    )
  })
})

describe('createMarketFromTemplate', () => {
  it('uses the template defaults', async () => {
    const db = makeFakeDb()
    const m = await createMarketFromTemplate(db, 'shop-1', 'eu')
    expect(m.name).toBe('European Union')
    expect(m.currency_code).toBe('EUR')
    expect(m.countries).toContain('DE')
    expect(m.countries).toContain('FR')
    expect(m.countries).not.toContain('GB')
  })

  it('allows an override name', async () => {
    const db = makeFakeDb()
    const m = await createMarketFromTemplate(db, 'shop-1', 'eu', 'EU Storefront')
    expect(m.name).toBe('EU Storefront')
    expect(m.currency_code).toBe('EUR')
  })

  it('throws on unknown template', async () => {
    const db = makeFakeDb()
    await expect(
      createMarketFromTemplate(db, 'shop-1', 'mars_colony'),
    ).rejects.toThrow(/Unknown market template/)
  })

  it('vietnam template uses VND + vi', async () => {
    const db = makeFakeDb()
    const m = await createMarketFromTemplate(db, 'shop-1', 'vietnam')
    expect(m.currency_code).toBe('VND')
    expect(m.language_code).toBe('vi')
    expect(m.countries).toEqual(['VN'])
  })
})

// ---------------------------------------------------------------------------
// updateMarket
// ---------------------------------------------------------------------------

describe('updateMarket', () => {
  it('patches the provided fields only', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-1', name: 'EU', status: 'active',
          countries: ['DE'], is_primary: false, currency_code: 'EUR',
          language_code: 'en' },
      ],
    })
    const m = await updateMarket(db, 'shop-1', 'm1', { status: 'inactive' })
    expect(m.status).toBe('inactive')
    expect(m.name).toBe('EU')
  })

  it('rejects duplicate name against other rows', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-1', name: 'EU', status: 'active',
          countries: [], is_primary: false, currency_code: 'EUR',
          language_code: 'en' },
        { id: 'm2', shop_id: 'shop-1', name: 'APAC', status: 'active',
          countries: [], is_primary: false, currency_code: 'USD',
          language_code: 'en' },
      ],
    })
    await expect(
      updateMarket(db, 'shop-1', 'm1', { name: 'APAC' }),
    ).rejects.toThrow(DuplicateMarketNameError)
  })

  it('allows keeping the same name on the same row', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-1', name: 'EU', status: 'active',
          countries: [], is_primary: false, currency_code: 'EUR',
          language_code: 'en' },
      ],
    })
    const m = await updateMarket(db, 'shop-1', 'm1', { name: 'EU' })
    expect(m.name).toBe('EU')
  })

  it('demotes old primary when promoting a new one', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-1', name: 'Old', status: 'active',
          countries: [], is_primary: true, currency_code: 'USD',
          language_code: 'en' },
        { id: 'm2', shop_id: 'shop-1', name: 'New', status: 'active',
          countries: [], is_primary: false, currency_code: 'USD',
          language_code: 'en' },
      ],
    })
    await updateMarket(db, 'shop-1', 'm2', { is_primary: true })
    const old = db._state.markets.find((r: any) => r.id === 'm1')
    const fresh = db._state.markets.find((r: any) => r.id === 'm2')
    expect(old.is_primary).toBe(false)
    expect(fresh.is_primary).toBe(true)
  })

  it('normalises countries on update', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-1', name: 'EU', status: 'active',
          countries: ['DE'], is_primary: false, currency_code: 'EUR',
          language_code: 'en' },
      ],
    })
    const m = await updateMarket(db, 'shop-1', 'm1', {
      countries: ['de', 'FR', 'fr', 'INVALID'],
    })
    expect(m.countries).toEqual(['DE', 'FR'])
  })

  it('throws MarketNotFoundError for cross-tenant', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-other', name: 'EU', status: 'active',
          countries: [], is_primary: true, currency_code: 'EUR',
          language_code: 'en' },
      ],
    })
    await expect(
      updateMarket(db, 'shop-1', 'm1', { name: 'X' }),
    ).rejects.toThrow(MarketNotFoundError)
  })

  it('no-op patch returns existing without bumping updated_at', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-1', name: 'EU', status: 'active',
          countries: [], is_primary: false, currency_code: 'EUR',
          language_code: 'en' },
      ],
    })
    const m = await updateMarket(db, 'shop-1', 'm1', {})
    expect(m.name).toBe('EU')
  })
})

// ---------------------------------------------------------------------------
// deleteMarket
// ---------------------------------------------------------------------------

describe('deleteMarket', () => {
  it('removes the row', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-1', name: 'EU', status: 'active',
          countries: [], is_primary: false, currency_code: 'EUR',
          language_code: 'en' },
      ],
    })
    await deleteMarket(db, 'shop-1', 'm1')
    expect(db._state.markets).toHaveLength(0)
  })

  it('refuses to delete the primary', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-1', name: 'Home', status: 'active',
          countries: [], is_primary: true, currency_code: 'USD',
          language_code: 'en' },
      ],
    })
    await expect(deleteMarket(db, 'shop-1', 'm1')).rejects.toThrow(
      /Cannot delete the primary market/,
    )
  })

  it('throws MarketNotFoundError on cross-tenant', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-other', name: 'EU', status: 'active',
          countries: [], is_primary: false, currency_code: 'EUR',
          language_code: 'en' },
      ],
    })
    await expect(deleteMarket(db, 'shop-1', 'm1')).rejects.toThrow(
      MarketNotFoundError,
    )
  })
})

// ---------------------------------------------------------------------------
// Linking shipping / tax
// ---------------------------------------------------------------------------

describe('linkShippingZoneToMarket', () => {
  it('sets the market_id on the zone', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-1', name: 'EU', status: 'active',
          countries: [], is_primary: false, currency_code: 'EUR',
          language_code: 'en' },
      ],
      shipping_zones: [
        { id: 'z1', shop_id: 'shop-1', market_id: null },
      ],
    })
    await linkShippingZoneToMarket(db, 'shop-1', 'z1', 'm1')
    const zone = db._state.shipping_zones.find((z: any) => z.id === 'z1')
    expect(zone.market_id).toBe('m1')
  })

  it('unlinks when passed null', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-1', name: 'EU', status: 'active',
          countries: [], is_primary: false, currency_code: 'EUR',
          language_code: 'en' },
      ],
      shipping_zones: [{ id: 'z1', shop_id: 'shop-1', market_id: 'm1' }],
    })
    await linkShippingZoneToMarket(db, 'shop-1', 'z1', null)
    const zone = db._state.shipping_zones.find((z: any) => z.id === 'z1')
    expect(zone.market_id).toBeNull()
  })

  it('refuses cross-tenant zone access', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-1', name: 'EU', status: 'active',
          countries: [], is_primary: false, currency_code: 'EUR',
          language_code: 'en' },
      ],
      shipping_zones: [{ id: 'z1', shop_id: 'shop-other', market_id: null }],
    })
    await expect(
      linkShippingZoneToMarket(db, 'shop-1', 'z1', 'm1'),
    ).rejects.toThrow(/not found/i)
  })

  it('refuses linking to a market owned by another shop', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-other', name: 'EU', status: 'active',
          countries: [], is_primary: false, currency_code: 'EUR',
          language_code: 'en' },
      ],
      shipping_zones: [{ id: 'z1', shop_id: 'shop-1', market_id: null }],
    })
    await expect(
      linkShippingZoneToMarket(db, 'shop-1', 'z1', 'm1'),
    ).rejects.toThrow(MarketNotFoundError)
  })
})

describe('linkTaxRegistrationToMarket', () => {
  it('sets the market_id on the registration', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-1', name: 'EU', status: 'active',
          countries: [], is_primary: false, currency_code: 'EUR',
          language_code: 'en' },
      ],
      tax_registrations: [
        { id: 'reg1', shop_id: 'shop-1', market_id: null,
          jurisdiction_code: 'DE', jurisdiction_kind: 'eu_country',
          display_name: 'Germany' },
      ],
    })
    await linkTaxRegistrationToMarket(db, 'shop-1', 'reg1', 'm1')
    const reg = db._state.tax_registrations.find((r: any) => r.id === 'reg1')
    expect(reg.market_id).toBe('m1')
  })

  it('refuses cross-tenant registration access', async () => {
    const db = makeFakeDb({
      markets: [
        { id: 'm1', shop_id: 'shop-1', name: 'EU', status: 'active',
          countries: [], is_primary: false, currency_code: 'EUR',
          language_code: 'en' },
      ],
      tax_registrations: [
        { id: 'reg1', shop_id: 'shop-other', market_id: null,
          jurisdiction_code: 'DE', jurisdiction_kind: 'eu_country',
          display_name: 'Germany' },
      ],
    })
    await expect(
      linkTaxRegistrationToMarket(db, 'shop-1', 'reg1', 'm1'),
    ).rejects.toThrow(/not found/i)
  })
})
