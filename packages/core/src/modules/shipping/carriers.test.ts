/**
 * Phase 9 / PR1 — Carriers Service Tests (in-memory Kysely stub)
 *
 * Tests the per-shop carrier CRUD + seed-into-zone helpers with a
 * minimal hand-rolled Kysely-compatible fake. The real DB integration
 * (insert/update with ON CONFLICT, shop-scope guard hitting the FK)
 * is exercised in scripts/smoke-phase9-pr1.ts against live Postgres.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  listCarriersMerged,
  enableCarrier,
  updateCarrier,
  disableCarrier,
  seedRatesIntoZone,
  removeCarrierRatesFromZone,
} from './carriers.js'

// ---------------------------------------------------------------------------
// Minimal fake Kysely that records inserts + selects from in-memory tables.
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

  function table(name: 'shipping_carriers' | 'shipping_zones' | 'shipping_rates') {
    return name === 'shipping_carriers' ? state.carriers
      : name === 'shipping_zones' ? state.zones
      : state.rates
  }

  const fakeDb: any = {
    _state: state,

    selectFrom(name: any) {
      let rows = [...table(name)]
      const filters: { col: string; op: string; val: any }[] = []
      const builder: any = {
        select: (_cols: any) => builder,
        selectAll: () => builder,
        where: (colOrFn: any, op?: any, val?: any) => {
          if (typeof colOrFn === 'function') {
            // Expression builder — not used in carriers.ts; return as-is.
            return builder
          }
          filters.push({ col: colOrFn, op, val })
          return builder
        },
        orderBy: () => builder,
        execute: async () => {
          return rows.filter((r) =>
            filters.every(({ col, op, val }) => {
              if (op === '=') return r[col] === val
              if (op === 'in') return val.includes(r[col])
              if (op === 'is' && val === null) return r[col] == null
              return true
            }),
          )
        },
        executeTakeFirst: async () => {
          const filtered = rows.filter((r) =>
            filters.every(({ col, op, val }) => {
              if (op === '=') return r[col] === val
              return true
            }),
          )
          return filtered[0]
        },
      }
      return builder
    },

    insertInto(name: any) {
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
          execute: async () => {
            const rows = Array.isArray(vals) ? vals : [vals]
            const inserted = rows.map((v) => ({
              id: v.id ?? `id-${Math.random().toString(36).slice(2, 10)}`,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              ...v,
            }))
            table(name).push(...inserted)
            return { numInsertedOrUpdatedRows: BigInt(inserted.length) }
          },
          returning: (_col: any) => ({
            executeTakeFirstOrThrow: async () => {
              const rows = Array.isArray(vals) ? vals : [vals]
              const inserted = rows.map((v) => ({
                id: v.id ?? `id-${Math.random().toString(36).slice(2, 10)}`,
                ...v,
              }))
              table(name).push(...inserted)
              return inserted[0]
            },
          }),
        }),
      }
    },

    updateTable(name: any) {
      let targetFilter: (r: any) => boolean = () => true
      const filters: any[] = []
      let patch: any = {}
      const builder: any = {
        set: (p: any) => {
          patch = p
          return builder
        },
        where: (col: any, op: any, val: any) => {
          filters.push({ col, op, val })
          targetFilter = (r) =>
            filters.every((f) => {
              if (f.op === '=') return r[f.col] === f.val
              return true
            })
          return builder
        },
        returningAll: () => ({
          executeTakeFirstOrThrow: async () => {
            for (const r of table(name)) {
              if (targetFilter(r)) Object.assign(r, patch)
            }
            return table(name).find(targetFilter)
          },
        }),
        executeTakeFirst: async () => {
          let count = 0
          for (const r of table(name)) {
            if (targetFilter(r)) { Object.assign(r, patch); count++ }
          }
          return { numUpdatedRows: BigInt(count) }
        },
        execute: async () => {
          let count = 0
          for (const r of table(name)) {
            if (targetFilter(r)) { Object.assign(r, patch); count++ }
          }
          return { numUpdatedRows: BigInt(count) }
        },
      }
      return builder
    },

    deleteFrom(name: any) {
      const filters: any[] = []
      const builder: any = {
        where: (col: any, op: any, val: any) => {
          filters.push({ col, op, val })
          return builder
        },
        executeTakeFirst: async () => {
          const arr = table(name)
          const before = arr.length
          for (let i = arr.length - 1; i >= 0; i--) {
            if (filters.every((f) => {
              if (f.op === '=') return arr[i][f.col] === f.val
              return true
            })) {
              arr.splice(i, 1)
            }
          }
          return { numDeletedRows: BigInt(before - arr.length) }
        },
        execute: async () => {
          const arr = table(name)
          for (let i = arr.length - 1; i >= 0; i--) {
            if (filters.every((f) => {
              if (f.op === '=') return arr[i][f.col] === f.val
              return true
            })) {
              arr.splice(i, 1)
            }
          }
        },
      }
      return builder
    },

    transaction: () => ({
      execute: async (fn: any) => fn(fakeDb),
    }),
  }

  return fakeDb
}

// ---------------------------------------------------------------------------
// listCarriersMerged
// ---------------------------------------------------------------------------

describe('listCarriersMerged', () => {
  it('returns all 12 catalog carriers even when none are configured', async () => {
    const db = makeFakeDb()
    const rows = await listCarriersMerged(db, 'shop-1')
    expect(rows.length).toBe(12)
    for (const r of rows) {
      expect(r.configured).toBe(false)
      expect(r.enabled).toBe(false)
    }
  })

  it('marks configured=true for shop carriers that exist', async () => {
    const db = makeFakeDb({
      carriers: [
        { id: 'c1', shop_id: 'shop-1', kind: 'usps',
          display_name: 'USPS', enabled: true, use_live_rates: false,
          credentials_json: null, created_at: 'now', updated_at: 'now' },
      ],
    })
    const rows = await listCarriersMerged(db, 'shop-1')
    const usps = rows.find((r) => r.kind === 'usps')!
    expect(usps.configured).toBe(true)
    expect(usps.enabled).toBe(true)
    expect(usps.id).toBe('c1')
  })

  it('does not expose other shops rows', async () => {
    const db = makeFakeDb({
      carriers: [
        { id: 'c1', shop_id: 'shop-other', kind: 'usps',
          display_name: 'USPS', enabled: true, use_live_rates: false,
          credentials_json: null, created_at: 'now', updated_at: 'now' },
      ],
    })
    const rows = await listCarriersMerged(db, 'shop-1')
    const usps = rows.find((r) => r.kind === 'usps')!
    expect(usps.configured).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// enableCarrier
// ---------------------------------------------------------------------------

describe('enableCarrier', () => {
  it('inserts a new row when none exists', async () => {
    const db = makeFakeDb()
    const row = await enableCarrier(db, 'shop-1', { kind: 'usps' })
    expect(row.kind).toBe('usps')
    expect(row.enabled).toBe(true)
    expect(db._state.carriers.length).toBe(1)
  })

  it('flips enabled=true on re-enable (idempotent)', async () => {
    const db = makeFakeDb({
      carriers: [
        { id: 'c1', shop_id: 'shop-1', kind: 'ups', display_name: 'UPS',
          enabled: false, use_live_rates: false, credentials_json: null,
          created_at: 'now', updated_at: 'now' },
      ],
    })
    const row = await enableCarrier(db, 'shop-1', { kind: 'ups' })
    expect(row.enabled).toBe(true)
    expect(row.id).toBe('c1')
    expect(db._state.carriers.length).toBe(1)
  })

  it('rejects unknown carrier kind', async () => {
    const db = makeFakeDb()
    await expect(
      enableCarrier(db, 'shop-1', { kind: 'bogus' as any }),
    ).rejects.toThrow(/Unknown carrier/)
  })

  it('honors use_live_rates on enable', async () => {
    const db = makeFakeDb()
    const row = await enableCarrier(db, 'shop-1', {
      kind: 'fedex',
      use_live_rates: true,
    })
    expect(row.use_live_rates).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// updateCarrier / disableCarrier
// ---------------------------------------------------------------------------

describe('updateCarrier', () => {
  it('rejects cross-tenant carrier IDs', async () => {
    const db = makeFakeDb({
      carriers: [
        { id: 'c1', shop_id: 'shop-other', kind: 'usps', display_name: 'USPS',
          enabled: true, use_live_rates: false, credentials_json: null,
          created_at: 'now', updated_at: 'now' },
      ],
    })
    await expect(
      updateCarrier(db, 'shop-1', 'c1', { enabled: false }),
    ).rejects.toThrow(/not found/)
  })

  it('updates display_name', async () => {
    const db = makeFakeDb({
      carriers: [
        { id: 'c1', shop_id: 'shop-1', kind: 'usps', display_name: 'USPS',
          enabled: true, use_live_rates: false, credentials_json: null,
          created_at: 'now', updated_at: 'now' },
      ],
    })
    const row = await updateCarrier(db, 'shop-1', 'c1', {
      display_name: 'USPS Priority',
    })
    expect(row.display_name).toBe('USPS Priority')
  })

  it('disableCarrier flips enabled to false', async () => {
    const db = makeFakeDb({
      carriers: [
        { id: 'c1', shop_id: 'shop-1', kind: 'usps', display_name: 'USPS',
          enabled: true, use_live_rates: false, credentials_json: null,
          created_at: 'now', updated_at: 'now' },
      ],
    })
    const row = await disableCarrier(db, 'shop-1', 'c1')
    expect(row.enabled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// seedRatesIntoZone
// ---------------------------------------------------------------------------

describe('seedRatesIntoZone', () => {
  it('copies USPS US-region seed rows into a zone', async () => {
    const db = makeFakeDb({
      zones: [
        { id: 'z1', shop_id: 'shop-1', name: 'US', countries: ['US'],
          kind: 'domestic', region_code: 'US',
          created_at: 'now', updated_at: 'now' },
      ],
    })
    const inserted = await seedRatesIntoZone(db, 'shop-1', {
      zone_id: 'z1',
      kind: 'usps',
    })
    expect(inserted).toBeGreaterThan(10) // multi-service catalog
    // Every row has carrier_kind = 'usps' and currency defaults to USD
    for (const r of db._state.rates) {
      expect(r.carrier_kind).toBe('usps')
      expect(r.currency).toBe('USD')
      expect(r.zone_id).toBe('z1')
    }
  })

  it('rejects cross-tenant zone IDs', async () => {
    const db = makeFakeDb({
      zones: [
        { id: 'z1', shop_id: 'shop-other', name: 'US', countries: ['US'],
          kind: 'domestic', region_code: 'US',
          created_at: 'now', updated_at: 'now' },
      ],
    })
    await expect(
      seedRatesIntoZone(db, 'shop-1', { zone_id: 'z1', kind: 'usps' }),
    ).rejects.toThrow(/not found/)
  })

  it('returns 0 when carrier has no rates for the region', async () => {
    const db = makeFakeDb({
      zones: [
        { id: 'z1', shop_id: 'shop-1', name: 'UK Zone', countries: ['GB'],
          kind: 'domestic', region_code: 'UK',
          created_at: 'now', updated_at: 'now' },
      ],
    })
    // USPS has no UK rates
    const inserted = await seedRatesIntoZone(db, 'shop-1', {
      zone_id: 'z1',
      kind: 'usps',
    })
    expect(inserted).toBe(0)
    expect(db._state.rates.length).toBe(0)
  })

  it('honours explicit region_code override', async () => {
    const db = makeFakeDb({
      zones: [
        { id: 'z1', shop_id: 'shop-1', name: 'Germany', countries: ['DE'],
          kind: 'international', region_code: null, // zone has no region
          created_at: 'now', updated_at: 'now' },
      ],
    })
    const inserted = await seedRatesIntoZone(db, 'shop-1', {
      zone_id: 'z1',
      kind: 'dhl_paket',
      region_code: 'EU-DE',
    })
    expect(inserted).toBeGreaterThan(0)
  })

  it('honours currency override', async () => {
    const db = makeFakeDb({
      zones: [
        { id: 'z1', shop_id: 'shop-1', name: 'UK', countries: ['GB'],
          kind: 'domestic', region_code: 'UK',
          created_at: 'now', updated_at: 'now' },
      ],
    })
    await seedRatesIntoZone(db, 'shop-1', {
      zone_id: 'z1',
      kind: 'royal_mail',
      currency: 'GBP',
    })
    for (const r of db._state.rates) {
      expect(r.currency).toBe('GBP')
    }
  })
})

// ---------------------------------------------------------------------------
// removeCarrierRatesFromZone
// ---------------------------------------------------------------------------

describe('removeCarrierRatesFromZone', () => {
  beforeEach(() => {
    // nothing — each test builds its own fake
  })

  it('removes only the specified carrier rows from the zone', async () => {
    const db = makeFakeDb({
      zones: [
        { id: 'z1', shop_id: 'shop-1', name: 'US', countries: ['US'],
          kind: 'domestic', region_code: 'US',
          created_at: 'now', updated_at: 'now' },
      ],
      rates: [
        { id: 'r1', zone_id: 'z1', carrier_kind: 'usps', name: 'A', price: '5' },
        { id: 'r2', zone_id: 'z1', carrier_kind: 'ups',  name: 'B', price: '7' },
        { id: 'r3', zone_id: 'z1', carrier_kind: 'usps', name: 'C', price: '9' },
      ],
    })
    const removed = await removeCarrierRatesFromZone(db, 'shop-1', 'z1', 'usps')
    expect(removed).toBe(2)
    expect(db._state.rates.length).toBe(1)
    expect(db._state.rates[0].carrier_kind).toBe('ups')
  })

  it('rejects cross-tenant zone IDs', async () => {
    const db = makeFakeDb({
      zones: [
        { id: 'z1', shop_id: 'shop-other', name: 'US', countries: ['US'],
          kind: 'domestic', region_code: 'US',
          created_at: 'now', updated_at: 'now' },
      ],
    })
    await expect(
      removeCarrierRatesFromZone(db, 'shop-1', 'z1', 'usps'),
    ).rejects.toThrow(/not found/)
  })
})
