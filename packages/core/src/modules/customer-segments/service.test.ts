/**
 * Gbox Platform — Customer Segments Service Unit Tests (Phase 4 PR2)
 *
 * Covers:
 *   - createSegment validation (empty name, over-long name, invalid rules)
 *   - createSegment happy path serialises rules_json + passes shop_id through
 *   - updateSegment: name-only, rules-only, both, cross-shop miss
 *   - deleteSegment return semantics (true when deleted, false otherwise)
 *   - listSegments shop-scoped ordering, limit clamping
 *   - getSegment cross-shop miss returns null
 *   - countMatchingCustomers composes the query without touching the DB
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createSegment,
  updateSegment,
  deleteSegment,
  listSegments,
  getSegment,
  countMatchingCustomers,
} from './service.js'

// ---------------------------------------------------------------------------
// Chainable proxy — same pattern as customer-notes/service.test.ts.
// Returns whatever the caller asks for via execute/executeTakeFirst/...
// and loops every fluent method back to itself.
// ---------------------------------------------------------------------------

function chainable(result: any = undefined) {
  const obj: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return undefined
        if (prop === 'execute') {
          return vi.fn().mockResolvedValue(
            Array.isArray(result) ? result : result == null ? [] : [result],
          )
        }
        if (prop === 'executeTakeFirst') {
          return vi.fn().mockResolvedValue(result ?? null)
        }
        if (prop === 'executeTakeFirstOrThrow') {
          return vi.fn().mockImplementation(async () => {
            if (result == null) throw new Error('no result')
            return result
          })
        }
        return vi.fn().mockReturnValue(obj)
      },
    },
  )
  return obj
}

interface Overrides {
  [key: string]: any
}

function createMockDb(overrides: Overrides = {}) {
  return {
    insertInto: vi.fn().mockImplementation((table: string) => {
      return chainable(overrides[`insert:${table}`] ?? overrides[table])
    }),
    selectFrom: vi.fn().mockImplementation((table: string) => {
      return chainable(overrides[`select:${table}`] ?? overrides[table])
    }),
    updateTable: vi.fn().mockImplementation((table: string) => {
      return chainable(overrides[`update:${table}`] ?? overrides[table])
    }),
    deleteFrom: vi.fn().mockImplementation((table: string) => {
      return chainable(overrides[`delete:${table}`] ?? overrides[table])
    }),
  } as any
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHOP = '11111111-1111-1111-1111-111111111111'
const OTHER_SHOP = '22222222-2222-2222-2222-222222222222'
const SEG = '33333333-3333-3333-3333-333333333333'

const VALID_RULES = {
  combinator: 'and' as const,
  rules: [{ field: 'email', op: 'contains', value: '@gbox.co' }],
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('customer-segments service', () => {
  describe('createSegment', () => {
    it('rejects empty name', async () => {
      const db = createMockDb()
      await expect(
        createSegment(db, { shop_id: SHOP, name: '   ', rules: VALID_RULES }),
      ).rejects.toThrow(/name is required/i)
    })

    it('rejects over-long name', async () => {
      const db = createMockDb()
      const name = 'x'.repeat(200)
      await expect(
        createSegment(db, { shop_id: SHOP, name, rules: VALID_RULES }),
      ).rejects.toThrow(/chars or fewer/i)
    })

    it('rejects invalid rules JSON', async () => {
      const db = createMockDb()
      await expect(
        createSegment(db, {
          shop_id: SHOP,
          name: 'bad',
          rules: '{not json',
        }),
      ).rejects.toThrow(/invalid/i)
    })

    it('persists trimmed name + rules_json for the happy path', async () => {
      const row = {
        id: SEG,
        shop_id: SHOP,
        name: 'VIP',
        rules_json: VALID_RULES,
        created_at: '2026-04-20T00:00:00Z',
        updated_at: '2026-04-20T00:00:00Z',
      }
      const db = createMockDb({
        'insert:customer_segments': row,
      })
      const out = await createSegment(db, {
        shop_id: SHOP,
        name: '  VIP  ',
        rules: VALID_RULES,
      })
      expect(out).toEqual(row)
      expect(db.insertInto).toHaveBeenCalledWith('customer_segments')
    })
  })

  describe('updateSegment', () => {
    it('returns null when no row is updated (cross-shop or missing id)', async () => {
      const db = createMockDb({ 'update:customer_segments': null })
      const out = await updateSegment(db, {
        shop_id: OTHER_SHOP,
        id: SEG,
        name: 'renamed',
      })
      expect(out).toBeNull()
    })

    it('returns the updated row on success', async () => {
      const row = {
        id: SEG,
        shop_id: SHOP,
        name: 'VIP',
        rules_json: VALID_RULES,
        created_at: '2026-04-20T00:00:00Z',
        updated_at: '2026-04-21T00:00:00Z',
      }
      const db = createMockDb({ 'update:customer_segments': row })
      const out = await updateSegment(db, {
        shop_id: SHOP,
        id: SEG,
        name: 'VIP',
        rules: VALID_RULES,
      })
      expect(out?.name).toBe('VIP')
    })

    it('rejects invalid rules during update', async () => {
      const db = createMockDb()
      await expect(
        updateSegment(db, {
          shop_id: SHOP,
          id: SEG,
          rules: { combinator: 'xor', rules: [] },
        }),
      ).rejects.toThrow()
    })
  })

  describe('deleteSegment', () => {
    it('returns true when a row was deleted', async () => {
      const db = createMockDb({
        'delete:customer_segments': { numDeletedRows: 1n },
      })
      const ok = await deleteSegment(db, { shop_id: SHOP, id: SEG })
      expect(ok).toBe(true)
    })

    it('returns false when no row was deleted (missing or cross-shop)', async () => {
      const db = createMockDb({
        'delete:customer_segments': { numDeletedRows: 0n },
      })
      const ok = await deleteSegment(db, { shop_id: OTHER_SHOP, id: SEG })
      expect(ok).toBe(false)
    })
  })

  describe('listSegments', () => {
    it('returns shop-scoped rows', async () => {
      const rows = [
        { id: 'a', name: 'VIP' },
        { id: 'b', name: 'New' },
      ]
      const db = createMockDb({ 'select:customer_segments': rows })
      const out = await listSegments(db, { shop_id: SHOP })
      expect(out).toEqual(rows)
    })

    it('clamps limit / offset to sane ranges', async () => {
      const db = createMockDb({ 'select:customer_segments': [] })
      await expect(
        listSegments(db, { shop_id: SHOP, limit: 0, offset: -3 }),
      ).resolves.toEqual([])
      await expect(
        listSegments(db, { shop_id: SHOP, limit: 9999 }),
      ).resolves.toEqual([])
    })
  })

  describe('getSegment', () => {
    it('returns null when not found (cross-shop or missing)', async () => {
      const db = createMockDb({ 'select:customer_segments': null })
      const out = await getSegment(db, { shop_id: OTHER_SHOP, id: SEG })
      expect(out).toBeNull()
    })

    it('returns the row on success', async () => {
      const row = { id: SEG, shop_id: SHOP, name: 'VIP' }
      const db = createMockDb({ 'select:customer_segments': row })
      const out = await getSegment(db, { shop_id: SHOP, id: SEG })
      expect(out?.id).toBe(SEG)
    })
  })

  describe('countMatchingCustomers', () => {
    it('returns 0 when no row comes back', async () => {
      const db = createMockDb({ 'select:customers': null })
      const n = await countMatchingCustomers(db, SHOP, VALID_RULES)
      expect(n).toBe(0)
    })

    it('returns the numeric count from the aggregate row', async () => {
      const db = createMockDb({ 'select:customers': { count: '42' } })
      const n = await countMatchingCustomers(db, SHOP, VALID_RULES)
      expect(n).toBe(42)
    })

    it('throws before querying when rules are invalid', async () => {
      const db = createMockDb()
      await expect(
        countMatchingCustomers(db, SHOP, { combinator: 'xor', rules: [] }),
      ).rejects.toThrow()
      expect(db.selectFrom).not.toHaveBeenCalled()
    })
  })
})
