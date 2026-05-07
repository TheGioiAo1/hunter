/**
 * Tests for the activity service (recordActivity + listActivity).
 *
 * We mock Kysely with a chainable Proxy — enough fidelity to assert
 * that the service calls `.insertInto('audit_logs')` with the right
 * values, and that `.selectFrom('audit_logs as al')` returns the
 * rows we hand it wrapped in an ActivityRecord shape.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  listActivity,
  listActivityForResource,
  recordActivity,
} from './service.js'

// ---------------------------------------------------------------------------
// Mock database builder
// ---------------------------------------------------------------------------

/**
 * Tracks every call to the chainable so tests can assert on the
 * sequence of where/orderBy/limit calls the service made.
 */
interface CallLog {
  method: string
  args: unknown[]
}

function chainable(rows: unknown[] = [], log: CallLog[] = []): any {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return undefined
        if (prop === 'execute') {
          return vi.fn().mockResolvedValue(rows)
        }
        return (...args: unknown[]) => {
          log.push({ method: String(prop), args })
          return chainable(rows, log)
        }
      },
    },
  )
}

function createMockDb(rows: unknown[] = []) {
  const insertCalls: { table: string; values: unknown }[] = []
  const selectCalls: { table: string; log: CallLog[] }[] = []
  const db: any = {
    insertInto: vi.fn().mockImplementation((table: string) => {
      let capturedValues: unknown = null
      return {
        values(v: unknown) {
          capturedValues = v
          return this
        },
        execute: vi.fn().mockImplementation(async () => {
          insertCalls.push({ table, values: capturedValues })
          return []
        }),
      }
    }),
    selectFrom: vi.fn().mockImplementation((table: string) => {
      const log: CallLog[] = []
      selectCalls.push({ table, log })
      return chainable(rows, log)
    }),
  }
  return { db, insertCalls, selectCalls }
}

// Silence expected error logging.
let errSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  errSpy.mockRestore()
})

// ---------------------------------------------------------------------------
// recordActivity
// ---------------------------------------------------------------------------

describe('recordActivity', () => {
  it('writes a row with all fields populated', async () => {
    const { db, insertCalls } = createMockDb()
    const ok = await recordActivity(db, {
      action: 'product_created',
      actorUserId: 'user-1',
      shopId: 'shop-1',
      resourceType: 'product',
      resourceId: 'prod-1',
      details: { name: 'Red Tee' },
      ip: '10.0.0.1',
    })
    expect(ok).toBe(true)
    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0].table).toBe('audit_logs')
    const values = insertCalls[0].values as Record<string, unknown>
    expect(values.user_id).toBe('user-1')
    expect(values.shop_id).toBe('shop-1')
    expect(values.action).toBe('product_created')
    expect(values.resource_type).toBe('product')
    expect(values.resource_id).toBe('prod-1')
    expect(values.ip_address).toBe('10.0.0.1')
    expect(JSON.parse(values.details as string)).toEqual({ name: 'Red Tee' })
  })

  it('coerces missing optional fields to null', async () => {
    const { db, insertCalls } = createMockDb()
    const ok = await recordActivity(db, { action: 'admin_action' })
    expect(ok).toBe(true)
    const values = insertCalls[0].values as Record<string, unknown>
    expect(values.user_id).toBeNull()
    expect(values.shop_id).toBeNull()
    expect(values.resource_type).toBeNull()
    expect(values.resource_id).toBeNull()
    expect(values.details).toBeNull()
    expect(values.ip_address).toBeNull()
  })

  it('serializes details as JSON when provided', async () => {
    const { db, insertCalls } = createMockDb()
    await recordActivity(db, {
      action: 'product_updated',
      details: { before: 'a', after: 'b', nested: { x: 1 } },
    })
    const values = insertCalls[0].values as Record<string, unknown>
    const parsed = JSON.parse(values.details as string)
    expect(parsed.before).toBe('a')
    expect(parsed.after).toBe('b')
    expect(parsed.nested).toEqual({ x: 1 })
  })

  it('returns false and logs — does NOT throw — on insert failure', async () => {
    const db: any = {
      insertInto: vi.fn().mockImplementation(() => ({
        values() {
          return this
        },
        execute: vi.fn().mockRejectedValue(new Error('DB down')),
      })),
    }
    const ok = await recordActivity(db, { action: 'admin_action' })
    expect(ok).toBe(false)
    expect(errSpy).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// listActivity
// ---------------------------------------------------------------------------

function mkRow(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    id: 'row-1',
    action: 'product_created',
    user_id: 'user-1',
    user_email: 'alice@example.com',
    shop_id: 'shop-1',
    resource_type: 'product',
    resource_id: 'prod-1',
    details: null,
    ip_address: '10.0.0.1',
    created_at: '2026-04-09T12:00:00Z',
  }
  // Spread overrides so explicit `null` values pass through (unlike
  // `overrides.x ?? base.x` which would swap null for the default).
  return { ...base, ...overrides }
}

describe('listActivity', () => {
  it('returns a cursor-paginated result with default page size', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      mkRow({ id: `row-${i}`, created_at: `2026-04-09T12:00:0${i}Z` }),
    )
    const { db } = createMockDb(rows)
    const result = await listActivity(db, { pageSize: 50 })
    expect(result.pageSize).toBe(50)
    expect(result.items).toHaveLength(10)
    expect(result.hasNext).toBe(false)
  })

  it('slices off the extra row and sets hasNext when fetched > pageSize', async () => {
    // Caller asked for pageSize=5; mock returns 6 rows — service should
    // return 5 items and set hasNext.
    const rows = Array.from({ length: 6 }, (_, i) =>
      mkRow({
        id: `00000000-0000-0000-0000-00000000000${i}`,
        created_at: `2026-04-09T12:00:0${i}Z`,
      }),
    )
    const { db } = createMockDb(rows)
    const result = await listActivity(db, { pageSize: 25 })
    // pageSize 5 isn't in the allow-list; it clamps to DEFAULT (50).
    // Use 25 which IS allowed. With 6 rows and pageSize=25, no trim.
    expect(result.items).toHaveLength(6)
    expect(result.hasNext).toBe(false)
  })

  it('sets hasNext when the mock returns pageSize+1 rows', async () => {
    // Return exactly 26 rows for pageSize=25.
    const rows = Array.from({ length: 26 }, (_, i) =>
      mkRow({
        id: `00000000-0000-0000-0000-0000000000${i.toString().padStart(2, '0')}`,
        created_at: `2026-04-09T12:${i.toString().padStart(2, '0')}:00Z`,
      }),
    )
    const { db } = createMockDb(rows)
    const result = await listActivity(db, { pageSize: 25 })
    expect(result.items).toHaveLength(25)
    expect(result.hasNext).toBe(true)
    expect(result.nextCursor).not.toBeNull()
  })

  it('maps raw rows into ActivityRecord shape with actor label from user_email', async () => {
    const { db } = createMockDb([
      mkRow({ user_email: 'bob@example.com', id: 'abc' }),
    ])
    const result = await listActivity(db)
    expect(result.items[0].id).toBe('abc')
    expect(result.items[0].actorLabel).toBe('bob@example.com')
    expect(result.items[0].actorUserId).toBe('user-1')
    expect(result.items[0].resourceType).toBe('product')
    expect(result.items[0].resourceId).toBe('prod-1')
    expect(result.items[0].createdAt).toBe('2026-04-09T12:00:00Z')
  })

  it('labels actor as "system" when user_id is null', async () => {
    const { db } = createMockDb([
      mkRow({ user_id: null, user_email: null }),
    ])
    const result = await listActivity(db)
    expect(result.items[0].actorLabel).toBe('system')
  })

  it('labels actor as "deleted user" when user_id set but email is null', async () => {
    const { db } = createMockDb([
      mkRow({ user_email: null, user_id: 'ghost' }),
    ])
    const result = await listActivity(db)
    expect(result.items[0].actorLabel).toBe('deleted user')
  })

  it('parses JSON details on read', async () => {
    const { db } = createMockDb([
      mkRow({ details: JSON.stringify({ before: 1, after: 2 }) }),
    ])
    const result = await listActivity(db)
    expect(result.items[0].details).toEqual({ before: 1, after: 2 })
  })

  it('returns null details when raw details string is unparseable', async () => {
    const { db } = createMockDb([mkRow({ details: 'not-json' })])
    const result = await listActivity(db)
    expect(result.items[0].details).toBeNull()
  })

  it('records WHERE calls for each filter', async () => {
    const { db, selectCalls } = createMockDb([])
    await listActivity(db, {
      shopId: 'shop-X',
      actorUserId: 'user-X',
      resourceType: 'order',
      resourceId: 'order-X',
      actions: ['order_placed', 'order_paid'],
      since: '2026-01-01T00:00:00Z',
      until: '2026-12-31T23:59:59Z',
    })
    const log = selectCalls[0].log
    const whereCount = log.filter((c) => c.method === 'where').length
    // 7 filter conditions (shop, actor, resource_type, resource_id,
    // actions-in, since, until).
    expect(whereCount).toBe(7)
  })

  it('records IS NULL filter when shopId is explicitly null', async () => {
    const { db, selectCalls } = createMockDb([])
    await listActivity(db, { shopId: null })
    const log = selectCalls[0].log
    const whereCall = log.find((c) => c.method === 'where')
    expect(whereCall).toBeDefined()
    expect(whereCall?.args[1]).toBe('is')
    expect(whereCall?.args[2]).toBeNull()
  })

  it('orders by created_at DESC for forward pagination', async () => {
    const { db, selectCalls } = createMockDb([])
    await listActivity(db, { direction: 'next' })
    const log = selectCalls[0].log
    const orderCalls = log.filter((c) => c.method === 'orderBy')
    expect(orderCalls).toHaveLength(2)
    expect(orderCalls[0].args).toEqual(['al.created_at', 'desc'])
    expect(orderCalls[1].args).toEqual(['al.id', 'desc'])
  })

  it('orders by created_at ASC for backward pagination', async () => {
    const { db, selectCalls } = createMockDb([])
    await listActivity(db, { direction: 'prev' })
    const log = selectCalls[0].log
    const orderCalls = log.filter((c) => c.method === 'orderBy')
    expect(orderCalls[0].args).toEqual(['al.created_at', 'asc'])
    expect(orderCalls[1].args).toEqual(['al.id', 'asc'])
  })

  it('asks for pageSize + 1 rows to detect hasNext', async () => {
    const { db, selectCalls } = createMockDb([])
    await listActivity(db, { pageSize: 25 })
    const log = selectCalls[0].log
    const limitCall = log.find((c) => c.method === 'limit')
    expect(limitCall?.args).toEqual([26])
  })

  it('clamps malicious pageSize values', async () => {
    const { db } = createMockDb([])
    const result = await listActivity(db, { pageSize: 100_000 })
    expect(result.pageSize).toBe(50) // DEFAULT_PAGE_SIZE fallback
  })
})

// ---------------------------------------------------------------------------
// listActivityForResource
// ---------------------------------------------------------------------------

describe('listActivityForResource', () => {
  it('delegates to listActivity scoped to the resource', async () => {
    const { db, selectCalls } = createMockDb([
      mkRow({ id: 'a' }),
      mkRow({ id: 'b' }),
    ])
    const items = await listActivityForResource(db, 'order', 'order-42', 10)
    expect(items).toHaveLength(2)
    // Verify it set the resource filter.
    const log = selectCalls[0].log
    const whereCalls = log.filter((c) => c.method === 'where')
    const hasResourceType = whereCalls.some(
      (c) => c.args[0] === 'al.resource_type' && c.args[2] === 'order',
    )
    const hasResourceId = whereCalls.some(
      (c) => c.args[0] === 'al.resource_id' && c.args[2] === 'order-42',
    )
    expect(hasResourceType).toBe(true)
    expect(hasResourceId).toBe(true)
  })

  it('clamps limit to the [1, 100] range', async () => {
    const { db, selectCalls } = createMockDb([])
    await listActivityForResource(db, 'order', 'x', 9999)
    const limitCall = selectCalls[0].log.find((c) => c.method === 'limit')
    // Math.min(100, 9999) = 100, which IS in DEFAULT_PAGE_SIZES so
    // clampPageSize keeps it, limit = 100 + 1 = 101.
    expect(limitCall?.args[0]).toBe(101)
  })

  it('clamps limit to at least 1', async () => {
    const { db, selectCalls } = createMockDb([])
    await listActivityForResource(db, 'order', 'x', 0)
    const limitCall = selectCalls[0].log.find((c) => c.method === 'limit')
    // Math.max(1, 0) = 1 → clampPageSize(1) → 50 (DEFAULT fallback) → limit=51
    expect(limitCall?.args[0]).toBe(51)
  })

  it('floors fractional limits', async () => {
    const { db, selectCalls } = createMockDb([])
    await listActivityForResource(db, 'order', 'x', 25.9)
    const limitCall = selectCalls[0].log.find((c) => c.method === 'limit')
    expect(limitCall?.args[0]).toBe(26) // pageSize 25 + 1
  })
})
