/**
 * Import applier tests.
 *
 * The applier runs inside a transaction and has both create + update
 * branches. We use a recording proxy: every `db.xxx` call (insertInto,
 * updateTable, etc.) captures its arguments on a log array so tests
 * can assert what DML was issued, and terminal calls resolve to
 * fixture data queued by the test.
 */

import { describe, it, expect } from 'vitest'
import { applyImportPlan } from './import-apply.js'
import type { ImportPlan, ImportPlanItem } from './import-plan.js'
import type { ParsedCustomer } from './csv-parser.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DbCall {
  op: string
  args: any[]
}

function makeTrx(calls: DbCall[], returnId = 'new-cust-id') {
  const handler: ProxyHandler<object> = {
    get(_t, prop: string | symbol): any {
      if (prop === 'executeTakeFirstOrThrow' || prop === 'executeTakeFirst') {
        return async () => ({ id: returnId })
      }
      if (prop === 'execute') {
        return async () => []
      }
      if (prop === 'then' || typeof prop === 'symbol') return undefined
      return (...args: any[]) => {
        calls.push({ op: String(prop), args })
        return new Proxy({}, handler)
      }
    },
  }
  return new Proxy({}, handler)
}

function makeDb(calls: DbCall[], returnId?: string) {
  const handler: ProxyHandler<object> = {
    get(_t, prop: string | symbol): any {
      if (prop === 'transaction') {
        return () => ({
          execute: async (cb: any) => cb(makeTrx(calls, returnId)),
        })
      }
      if (typeof prop === 'symbol' || prop === 'then') return undefined
      return (..._args: any[]) => new Proxy({}, handler)
    },
  }
  return new Proxy({}, handler) as any
}

function makeParsed(overrides: Partial<ParsedCustomer> = {}): ParsedCustomer {
  return {
    sourceRow: 2,
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: 'ada@example.com',
    phone: null,
    accepts_marketing: false,
    note: null,
    tags: null,
    tax_exempt: false,
    address: null,
    extraColumns: {},
    ...overrides,
  }
}

function makeItem(
  action: ImportPlanItem['action'],
  overrides: Partial<ImportPlanItem> = {},
): ImportPlanItem {
  return {
    emailKey: action === 'blocked' ? null : 'ada@example.com',
    parsed: makeParsed(),
    action,
    existingCustomerId: action === 'update' ? 'cust-1' : null,
    existingDefaultAddressId: null,
    issues: [],
    ...overrides,
  }
}

function planOf(items: ImportPlanItem[]): ImportPlan {
  return {
    items,
    issues: [],
    stats: { creating: 0, updating: 0, blocked: 0, warnings: 0 },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyImportPlan', () => {
  it('skips blocked items without hitting the DB', async () => {
    const calls: DbCall[] = []
    const db = makeDb(calls)
    const res = await applyImportPlan(db, 'shop-1', planOf([makeItem('blocked')]))
    expect(calls).toHaveLength(0)
    expect(res.stats).toEqual({ created: 0, updated: 0, skipped: 1, errored: 0 })
    expect(res.items[0]!.action).toBe('skipped')
  })

  it('creates a new customer (no address) and reports created', async () => {
    const calls: DbCall[] = []
    const db = makeDb(calls, 'cust-new')
    const res = await applyImportPlan(db, 'shop-1', planOf([makeItem('create')]))
    // Should have issued insertInto('customers') at least once.
    const inserts = calls.filter((c) => c.op === 'insertInto')
    expect(inserts.some((c) => c.args[0] === 'customers')).toBe(true)
    // No address → no insertInto('customer_addresses').
    expect(inserts.some((c) => c.args[0] === 'customer_addresses')).toBe(false)
    expect(res.stats.created).toBe(1)
    expect(res.items[0]!.customerId).toBe('cust-new')
  })

  it('creates a new customer with address → inserts into both tables', async () => {
    const calls: DbCall[] = []
    const db = makeDb(calls, 'cust-new')
    const item = makeItem('create', {
      parsed: makeParsed({
        address: {
          first_name: null,
          last_name: null,
          company: 'Acme',
          address1: '1 Foo St',
          address2: null,
          city: 'NYC',
          province: 'NY',
          province_code: 'NY',
          country: 'United States',
          country_code: 'US',
          zip: '10001',
          phone: null,
        },
      }),
    })
    await applyImportPlan(db, 'shop-1', planOf([item]))
    const tables = calls.filter((c) => c.op === 'insertInto').map((c) => c.args[0])
    expect(tables).toContain('customers')
    expect(tables).toContain('customer_addresses')
  })

  it('updates existing customer and updates existing default address when present', async () => {
    const calls: DbCall[] = []
    const db = makeDb(calls, 'cust-1')
    const item = makeItem('update', {
      existingCustomerId: 'cust-1',
      existingDefaultAddressId: 'addr-1',
      parsed: makeParsed({
        address: {
          first_name: null,
          last_name: null,
          company: 'Acme',
          address1: '2 Bar St',
          address2: null,
          city: 'NYC',
          province: null,
          province_code: null,
          country: null,
          country_code: null,
          zip: null,
          phone: null,
        },
      }),
    })
    await applyImportPlan(db, 'shop-1', planOf([item]))
    const updates = calls.filter((c) => c.op === 'updateTable').map((c) => c.args[0])
    expect(updates).toContain('customers')
    expect(updates).toContain('customer_addresses')
    // And NO insertInto('customer_addresses') — we updated in place.
    const addrInserts = calls.filter(
      (c) => c.op === 'insertInto' && c.args[0] === 'customer_addresses',
    )
    expect(addrInserts).toHaveLength(0)
  })

  it('updates customer and INSERTS a new default address when existing customer has none', async () => {
    const calls: DbCall[] = []
    const db = makeDb(calls, 'cust-1')
    const item = makeItem('update', {
      existingCustomerId: 'cust-1',
      existingDefaultAddressId: null,
      parsed: makeParsed({
        address: {
          first_name: null,
          last_name: null,
          company: null,
          address1: '3 Baz Ave',
          address2: null,
          city: null,
          province: null,
          province_code: null,
          country: null,
          country_code: null,
          zip: null,
          phone: null,
        },
      }),
    })
    await applyImportPlan(db, 'shop-1', planOf([item]))
    const addrInserts = calls.filter(
      (c) => c.op === 'insertInto' && c.args[0] === 'customer_addresses',
    )
    expect(addrInserts).toHaveLength(1)
  })

  it('aggregates stats across a mixed plan', async () => {
    const calls: DbCall[] = []
    const db = makeDb(calls, 'x')
    const res = await applyImportPlan(
      db,
      'shop-1',
      planOf([
        makeItem('create'),
        makeItem('update'),
        makeItem('blocked'),
      ]),
    )
    expect(res.stats).toEqual({ created: 1, updated: 1, skipped: 1, errored: 0 })
  })
})
