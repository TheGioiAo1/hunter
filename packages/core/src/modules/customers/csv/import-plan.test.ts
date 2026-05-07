/**
 * Import plan builder tests.
 *
 * Kysely is mocked via a chainable proxy (same pattern as
 * customer-lifecycle/recompute.test.ts and customer-notes/service.test.ts):
 * every method returns the proxy, terminal calls (`execute`) return
 * the fixture the test set up via the queue. This avoids needing a
 * real Postgres on the Windows dev host.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildImportPlan } from './import-plan.js'
import type { ParsedCustomer } from './csv-parser.js'

// ---------------------------------------------------------------------------
// Kysely mock — queue of { execute: <result> } entries consumed in order.
// ---------------------------------------------------------------------------

interface FakeExecuteResult {
  rows?: any[]
}

function makeFakeDb(queue: FakeExecuteResult[]) {
  let i = 0
  const handler = {
    get(_t: object, prop: string | symbol): any {
      if (prop === 'execute') {
        return async () => {
          const next = queue[i++] ?? { rows: [] }
          return next.rows ?? []
        }
      }
      if (prop === 'executeTakeFirst') {
        return async () => {
          const next = queue[i++] ?? { rows: [] }
          return (next.rows ?? [])[0] ?? null
        }
      }
      if (prop === 'fn') {
        // Returns a function that ignores args and returns itself, so
        // eb.fn('lower', ['email']) doesn't blow up in the callback.
        return () => new Proxy({}, handler)
      }
      if (prop === 'then' || prop === Symbol.iterator || prop === Symbol.asyncIterator) {
        return undefined
      }
      // Any method returns the proxy so chains work.
      return (..._args: any[]) => new Proxy({}, handler)
    },
  }
  // Expose a callable eb for the `where(eb => ...)` callback path.
  const ebProxy = new Proxy(() => new Proxy({}, handler), handler)
  const db = new Proxy(() => ebProxy, handler)
  return db as any
}

function makeRow(overrides: Partial<ParsedCustomer> = {}): ParsedCustomer {
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

describe('buildImportPlan', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('returns empty plan for empty input', async () => {
    const db = makeFakeDb([])
    const plan = await buildImportPlan(db, 'shop-1', [])
    expect(plan.items).toEqual([])
    expect(plan.issues).toEqual([])
    expect(plan.stats).toEqual({ creating: 0, updating: 0, blocked: 0, warnings: 0 })
  })

  it('marks a row with no email as blocked with missing_email issue', async () => {
    const db = makeFakeDb([{ rows: [] }, { rows: [] }])
    const plan = await buildImportPlan(db, 'shop-1', [
      makeRow({ sourceRow: 2, email: null }),
    ])
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0]!.action).toBe('blocked')
    expect(plan.items[0]!.emailKey).toBeNull()
    const errs = plan.issues.filter((i) => i.severity === 'error')
    expect(errs).toHaveLength(1)
    expect(errs[0]!.code).toBe('missing_email')
    expect(errs[0]!.line).toBe(2)
    expect(plan.stats.blocked).toBe(1)
  })

  it('marks a syntactically bad email as blocked with bad_email issue', async () => {
    // First execute = fetch existing customers (empty), second = addresses (empty).
    const db = makeFakeDb([{ rows: [] }, { rows: [] }])
    const plan = await buildImportPlan(db, 'shop-1', [
      makeRow({ sourceRow: 2, email: 'not-an-email' }),
    ])
    expect(plan.items[0]!.action).toBe('blocked')
    const errs = plan.issues.filter((i) => i.severity === 'error')
    expect(errs).toHaveLength(1)
    expect(errs[0]!.code).toBe('bad_email')
    expect(plan.stats.blocked).toBe(1)
  })

  it('marks a never-before-seen email as create', async () => {
    const db = makeFakeDb([
      { rows: [] }, // existing customers → none
      { rows: [] }, // default addresses → none
    ])
    const plan = await buildImportPlan(db, 'shop-1', [
      makeRow({ sourceRow: 2, email: 'new@example.com' }),
    ])
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0]!.action).toBe('create')
    expect(plan.items[0]!.emailKey).toBe('new@example.com')
    expect(plan.items[0]!.existingCustomerId).toBeNull()
    expect(plan.stats.creating).toBe(1)
    expect(plan.stats.updating).toBe(0)
  })

  it('marks an existing customer as update and attaches existingDefaultAddressId', async () => {
    const db = makeFakeDb([
      { rows: [{ id: 'cust-99', email: 'ada@example.com' }] },
      { rows: [{ id: 'addr-1', customer_id: 'cust-99', is_default: true }] },
    ])
    const plan = await buildImportPlan(db, 'shop-1', [
      makeRow({ sourceRow: 2, email: 'ada@example.com' }),
    ])
    expect(plan.items[0]!.action).toBe('update')
    expect(plan.items[0]!.existingCustomerId).toBe('cust-99')
    expect(plan.items[0]!.existingDefaultAddressId).toBe('addr-1')
    expect(plan.stats.updating).toBe(1)
    expect(plan.stats.creating).toBe(0)
  })

  it('matches existing customer case-insensitively', async () => {
    // CSV has Ada@Example.COM; DB stored ada@example.com (or any mix).
    // The planner lowercases both sides before lookup.
    const db = makeFakeDb([
      { rows: [{ id: 'cust-42', email: 'ADA@example.com' }] },
      { rows: [] }, // no address
    ])
    const plan = await buildImportPlan(db, 'shop-1', [
      makeRow({ sourceRow: 2, email: 'Ada@Example.COM' }),
    ])
    expect(plan.items[0]!.action).toBe('update')
    expect(plan.items[0]!.existingCustomerId).toBe('cust-42')
  })

  it('collapses duplicate CSV rows to a single upsert (last wins)', async () => {
    const db = makeFakeDb([
      { rows: [] }, // no existing
      { rows: [] }, // no addresses
    ])
    const plan = await buildImportPlan(db, 'shop-1', [
      makeRow({ sourceRow: 2, email: 'a@example.com', first_name: 'First' }),
      makeRow({ sourceRow: 3, email: 'a@example.com', first_name: 'Second' }),
    ])
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0]!.parsed.first_name).toBe('Second')
    expect(plan.items[0]!.parsed.sourceRow).toBe(3)
  })

  it('warns (non-blocking) when importing blank Note over an existing customer', async () => {
    const db = makeFakeDb([
      { rows: [{ id: 'cust-1', email: 'a@example.com' }] },
      { rows: [] },
    ])
    const plan = await buildImportPlan(db, 'shop-1', [
      makeRow({ sourceRow: 2, email: 'a@example.com', note: null }),
    ])
    expect(plan.items[0]!.action).toBe('update')
    const warn = plan.items[0]!.issues.find((i) => i.severity === 'warning')
    expect(warn?.code).toBe('note_cleared')
    expect(plan.stats.warnings).toBe(1)
    // A warning does NOT block the row.
    expect(plan.stats.blocked).toBe(0)
  })

  it('accumulates stats across a mixed batch', async () => {
    const db = makeFakeDb([
      { rows: [{ id: 'cust-1', email: 'existing@example.com' }] },
      { rows: [] },
    ])
    const plan = await buildImportPlan(db, 'shop-1', [
      makeRow({ sourceRow: 2, email: 'existing@example.com' }), // update
      makeRow({ sourceRow: 3, email: 'new@example.com' }),       // create
      makeRow({ sourceRow: 4, email: null }),                    // blocked (missing)
      makeRow({ sourceRow: 5, email: 'no-at-sign' }),            // blocked (bad)
    ])
    expect(plan.stats.creating).toBe(1)
    expect(plan.stats.updating).toBe(1)
    expect(plan.stats.blocked).toBe(2)
  })
})
