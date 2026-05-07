/**
 * Phase 9 / PR2 — Tax Registrations + Rates Service Tests
 *
 * In-memory Kysely fake (same pattern as carriers.test.ts / service.test.ts
 * in the shipping module). Tests per-shop CRUD + cross-tenant isolation.
 * The real DB constraints (ON DELETE CASCADE, unique index) are exercised
 * in scripts/smoke-phase9-pr2.ts against live Postgres.
 */

import { describe, it, expect } from 'vitest'
import {
  listRegistrations,
  enableRegistration,
  updateRegistration,
  deleteRegistration,
  listRatesForShop,
  listRatesForJurisdiction,
  seedRatesFromJurisdiction,
  updateRate,
  deleteRate,
} from './registrations.js'

// ---------------------------------------------------------------------------
// Minimal fake Kysely — mirrors carriers.test.ts
// ---------------------------------------------------------------------------

function makeFakeDb(initial?: {
  registrations?: any[]
  rates?: any[]
}) {
  const state = {
    registrations: initial?.registrations ? [...initial.registrations] : [],
    rates: initial?.rates ? [...initial.rates] : [],
  }

  function table(name: string): any[] {
    return name === 'tax_registrations' ? state.registrations : state.rates
  }

  const fakeDb: any = {
    _state: state,

    selectFrom(name: any) {
      const filters: { col: string; op: string; val: any }[] = []
      const builder: any = {
        select: () => builder,
        selectAll: () => builder,
        where: (colOrFn: any, op?: any, val?: any) => {
          if (typeof colOrFn === 'function') return builder
          filters.push({ col: colOrFn, op, val })
          return builder
        },
        orderBy: () => builder,
        execute: async () =>
          table(name).filter((r) =>
            filters.every(({ col, op, val }) => {
              if (op === '=') return r[col] === val
              if (op === 'in') return val.includes(r[col])
              return true
            }),
          ),
        executeTakeFirst: async () => {
          const hits = table(name).filter((r) =>
            filters.every(({ col, op, val }) => {
              if (op === '=') return r[col] === val
              return true
            }),
          )
          return hits[0]
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
        }),
      }
    },

    updateTable(name: any) {
      let targetFilter: (r: any) => boolean = () => true
      const filters: any[] = []
      let patch: any = {}
      const builder: any = {
        set: (p: any) => { patch = p; return builder },
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
  }

  return fakeDb
}

// ---------------------------------------------------------------------------
// Registrations CRUD
// ---------------------------------------------------------------------------

describe('listRegistrations', () => {
  it('returns only rows for the specified shop', async () => {
    const db = makeFakeDb({
      registrations: [
        { id: 'r1', shop_id: 'shop-1', jurisdiction_code: 'US-CA',
          jurisdiction_kind: 'us_state', display_name: 'California',
          tax_number: null, collecting: true },
        { id: 'r2', shop_id: 'shop-other', jurisdiction_code: 'DE',
          jurisdiction_kind: 'eu_country', display_name: 'Germany',
          tax_number: null, collecting: true },
      ],
    })
    const rows = await listRegistrations(db, 'shop-1')
    expect(rows.length).toBe(1)
    expect(rows[0].jurisdiction_code).toBe('US-CA')
  })

  it('returns empty array when shop has no registrations', async () => {
    const db = makeFakeDb()
    const rows = await listRegistrations(db, 'shop-1')
    expect(rows).toEqual([])
  })
})

describe('enableRegistration', () => {
  it('inserts a new row when none exists for that jurisdiction', async () => {
    const db = makeFakeDb()
    const row = await enableRegistration(db, 'shop-1', {
      jurisdiction_kind: 'us_state',
      jurisdiction_code: 'US-CA',
    })
    expect(row.jurisdiction_code).toBe('US-CA')
    expect(row.display_name).toBe('California') // sourced from seed
    expect(row.collecting).toBe(true)
    expect(db._state.registrations.length).toBe(1)
  })

  it('flips collecting=true on re-enable (idempotent)', async () => {
    const db = makeFakeDb({
      registrations: [
        { id: 'r1', shop_id: 'shop-1', jurisdiction_code: 'US-CA',
          jurisdiction_kind: 'us_state', display_name: 'California',
          tax_number: null, collecting: false },
      ],
    })
    const row = await enableRegistration(db, 'shop-1', {
      jurisdiction_kind: 'us_state',
      jurisdiction_code: 'US-CA',
    })
    expect(row.id).toBe('r1') // same row
    expect(row.collecting).toBe(true)
    expect(db._state.registrations.length).toBe(1)
  })

  it('normalizes jurisdiction_code to uppercase', async () => {
    const db = makeFakeDb()
    const row = await enableRegistration(db, 'shop-1', {
      jurisdiction_kind: 'eu_country',
      jurisdiction_code: 'de',
    })
    expect(row.jurisdiction_code).toBe('DE')
    expect(row.display_name).toBe('Germany')
  })

  it('honors explicit display_name override', async () => {
    const db = makeFakeDb()
    const row = await enableRegistration(db, 'shop-1', {
      jurisdiction_kind: 'eu_country',
      jurisdiction_code: 'DE',
      display_name: 'Germany (primary)',
    })
    expect(row.display_name).toBe('Germany (primary)')
  })

  it('stores tax_number when provided', async () => {
    const db = makeFakeDb()
    const row = await enableRegistration(db, 'shop-1', {
      jurisdiction_kind: 'eu_country',
      jurisdiction_code: 'DE',
      tax_number: 'DE123456789',
    })
    expect(row.tax_number).toBe('DE123456789')
  })
})

describe('updateRegistration', () => {
  it('updates collecting flag', async () => {
    const db = makeFakeDb({
      registrations: [
        { id: 'r1', shop_id: 'shop-1', jurisdiction_code: 'US-CA',
          jurisdiction_kind: 'us_state', display_name: 'California',
          tax_number: null, collecting: true },
      ],
    })
    const row = await updateRegistration(db, 'shop-1', 'r1', { collecting: false })
    expect(row.collecting).toBe(false)
  })

  it('rejects cross-tenant IDs', async () => {
    const db = makeFakeDb({
      registrations: [
        { id: 'r1', shop_id: 'shop-other', jurisdiction_code: 'DE',
          jurisdiction_kind: 'eu_country', display_name: 'Germany',
          tax_number: null, collecting: true },
      ],
    })
    await expect(
      updateRegistration(db, 'shop-1', 'r1', { collecting: false }),
    ).rejects.toThrow(/not found/)
  })

  it('throws when ID does not exist', async () => {
    const db = makeFakeDb()
    await expect(
      updateRegistration(db, 'shop-1', 'nonexistent', { collecting: false }),
    ).rejects.toThrow(/not found/)
  })
})

describe('deleteRegistration', () => {
  it('removes the row', async () => {
    const db = makeFakeDb({
      registrations: [
        { id: 'r1', shop_id: 'shop-1', jurisdiction_code: 'US-CA',
          jurisdiction_kind: 'us_state', display_name: 'California',
          tax_number: null, collecting: true },
      ],
    })
    await deleteRegistration(db, 'shop-1', 'r1')
    expect(db._state.registrations.length).toBe(0)
  })

  it('rejects cross-tenant IDs', async () => {
    const db = makeFakeDb({
      registrations: [
        { id: 'r1', shop_id: 'shop-other', jurisdiction_code: 'DE',
          jurisdiction_kind: 'eu_country', display_name: 'Germany',
          tax_number: null, collecting: true },
      ],
    })
    await expect(
      deleteRegistration(db, 'shop-1', 'r1'),
    ).rejects.toThrow(/not found/)
    expect(db._state.registrations.length).toBe(1) // untouched
  })
})

// ---------------------------------------------------------------------------
// Rates CRUD
// ---------------------------------------------------------------------------

describe('listRatesForShop', () => {
  it('returns only rows for the specified shop', async () => {
    const db = makeFakeDb({
      rates: [
        { id: 'rate1', shop_id: 'shop-1', jurisdiction_code: 'US-CA',
          name: 'CA Sales', rate: '0.0725', kind: 'sales',
          applies_to_shipping: false, priority: 0, compounded: false,
          registration_id: null },
        { id: 'rate2', shop_id: 'shop-other', jurisdiction_code: 'DE',
          name: 'DE VAT', rate: '0.19', kind: 'vat',
          applies_to_shipping: true, priority: 0, compounded: false,
          registration_id: null },
      ],
    })
    const rows = await listRatesForShop(db, 'shop-1')
    expect(rows.length).toBe(1)
    expect(rows[0].jurisdiction_code).toBe('US-CA')
  })
})

describe('listRatesForJurisdiction', () => {
  it('filters by jurisdiction_code (uppercased)', async () => {
    const db = makeFakeDb({
      rates: [
        { id: 'r1', shop_id: 'shop-1', jurisdiction_code: 'US-CA',
          name: 'CA Sales', rate: '0.0725', kind: 'sales',
          applies_to_shipping: false, priority: 0, compounded: false,
          registration_id: null },
        { id: 'r2', shop_id: 'shop-1', jurisdiction_code: 'US-NY',
          name: 'NY Sales', rate: '0.04', kind: 'sales',
          applies_to_shipping: true, priority: 0, compounded: false,
          registration_id: null },
      ],
    })
    const rows = await listRatesForJurisdiction(db, 'shop-1', 'us-ca')
    expect(rows.length).toBe(1)
    expect(rows[0].jurisdiction_code).toBe('US-CA')
  })
})

describe('seedRatesFromJurisdiction', () => {
  it('creates a rate row from the seed catalog (CA)', async () => {
    const db = makeFakeDb()
    const row = await seedRatesFromJurisdiction(db, 'shop-1', {
      jurisdiction_code: 'US-CA',
    })
    expect(row.jurisdiction_code).toBe('US-CA')
    expect(row.kind).toBe('sales')
    // rate stored as string
    expect(row.rate).toBe('0.0725')
    expect(row.applies_to_shipping).toBe(false) // CA does not tax shipping
    expect(row.shop_id).toBe('shop-1')
  })

  it('defaults name from seed formatter', async () => {
    const db = makeFakeDb()
    const row = await seedRatesFromJurisdiction(db, 'shop-1', {
      jurisdiction_code: 'DE',
    })
    expect(row.name).toMatch(/Germany VAT/)
    expect(row.name).toMatch(/19%/)
  })

  it('honors applies_to_shipping override', async () => {
    const db = makeFakeDb()
    const row = await seedRatesFromJurisdiction(db, 'shop-1', {
      jurisdiction_code: 'US-CA',
      applies_to_shipping: true,
    })
    expect(row.applies_to_shipping).toBe(true)
  })

  it('links to existing registration automatically', async () => {
    const db = makeFakeDb({
      registrations: [
        { id: 'reg1', shop_id: 'shop-1', jurisdiction_code: 'US-CA',
          jurisdiction_kind: 'us_state', display_name: 'California',
          tax_number: null, collecting: true },
      ],
    })
    const row = await seedRatesFromJurisdiction(db, 'shop-1', {
      jurisdiction_code: 'US-CA',
    })
    expect(row.registration_id).toBe('reg1')
  })

  it('leaves registration_id null when no registration exists', async () => {
    const db = makeFakeDb()
    const row = await seedRatesFromJurisdiction(db, 'shop-1', {
      jurisdiction_code: 'US-CA',
    })
    expect(row.registration_id).toBeNull()
  })

  it('rejects unknown jurisdiction_code', async () => {
    const db = makeFakeDb()
    await expect(
      seedRatesFromJurisdiction(db, 'shop-1', { jurisdiction_code: 'XX' }),
    ).rejects.toThrow(/No seed rate/)
  })

  it('rejects registration_id from another shop', async () => {
    const db = makeFakeDb({
      registrations: [
        { id: 'reg1', shop_id: 'shop-other', jurisdiction_code: 'DE',
          jurisdiction_kind: 'eu_country', display_name: 'Germany',
          tax_number: null, collecting: true },
      ],
    })
    await expect(
      seedRatesFromJurisdiction(db, 'shop-1', {
        jurisdiction_code: 'DE',
        registration_id: 'reg1',
      }),
    ).rejects.toThrow(/not found/)
  })
})

describe('updateRate', () => {
  it('updates rate + name', async () => {
    const db = makeFakeDb({
      rates: [
        { id: 'r1', shop_id: 'shop-1', jurisdiction_code: 'US-CA',
          name: 'CA', rate: '0.0725', kind: 'sales',
          applies_to_shipping: false, priority: 0, compounded: false,
          registration_id: null },
      ],
    })
    const row = await updateRate(db, 'shop-1', 'r1', {
      rate: 0.08,
      name: 'CA + City',
    })
    expect(row.rate).toBe('0.08')
    expect(row.name).toBe('CA + City')
  })

  it('rejects cross-tenant IDs', async () => {
    const db = makeFakeDb({
      rates: [
        { id: 'r1', shop_id: 'shop-other', jurisdiction_code: 'DE',
          name: 'DE', rate: '0.19', kind: 'vat',
          applies_to_shipping: true, priority: 0, compounded: false,
          registration_id: null },
      ],
    })
    await expect(
      updateRate(db, 'shop-1', 'r1', { rate: 0.20 }),
    ).rejects.toThrow(/not found/)
  })
})

describe('deleteRate', () => {
  it('removes the row', async () => {
    const db = makeFakeDb({
      rates: [
        { id: 'r1', shop_id: 'shop-1', jurisdiction_code: 'US-CA',
          name: 'CA', rate: '0.0725', kind: 'sales',
          applies_to_shipping: false, priority: 0, compounded: false,
          registration_id: null },
      ],
    })
    await deleteRate(db, 'shop-1', 'r1')
    expect(db._state.rates.length).toBe(0)
  })

  it('rejects cross-tenant IDs', async () => {
    const db = makeFakeDb({
      rates: [
        { id: 'r1', shop_id: 'shop-other', jurisdiction_code: 'DE',
          name: 'DE', rate: '0.19', kind: 'vat',
          applies_to_shipping: true, priority: 0, compounded: false,
          registration_id: null },
      ],
    })
    await expect(
      deleteRate(db, 'shop-1', 'r1'),
    ).rejects.toThrow(/not found/)
  })
})
