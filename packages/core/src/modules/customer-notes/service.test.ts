/**
 * Gbox Platform — Customer Notes Service Unit Tests (Phase 4 PR1)
 *
 * Covers:
 *   - addNote validation (empty, over-long)
 *   - addNote cross-shop rejection (customer belongs to other shop)
 *   - addNote happy path (shop-scope check then insert)
 *   - listNotes shop-scoped ordering
 *   - deleteNote return semantics (true if deleted, false otherwise)
 *   - countNotes
 */

import { describe, it, expect, vi } from 'vitest'
import {
  addNote,
  listNotes,
  deleteNote,
  countNotes,
  MAX_NOTE_LENGTH,
} from './service.js'

// ---------------------------------------------------------------------------
// Chainable proxy — returns whatever the caller asked for via terminal
// methods (execute / executeTakeFirst / executeTakeFirstOrThrow) and loops
// every other method back to itself so kysely's fluent builder shape works
// without us having to enumerate every .select / .where / .limit call.
// ---------------------------------------------------------------------------

function chainable(result: any = undefined) {
  const obj: any = new Proxy(
    {},
    {
      get(_target, prop) {
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
const CUSTOMER = '33333333-3333-3333-3333-333333333333'
const CUSTOMER_OTHER_SHOP = '44444444-4444-4444-4444-444444444444'
const NOTE = '55555555-5555-5555-5555-555555555555'
const AUTHOR = '66666666-6666-6666-6666-666666666666'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('customer-notes service', () => {
  describe('addNote — validation', () => {
    it('rejects an empty body', async () => {
      const db = createMockDb()
      await expect(
        addNote(db, {
          shop_id: SHOP,
          customer_id: CUSTOMER,
          body: '   ',
        }),
      ).rejects.toThrow(/empty/i)
    })

    it('rejects a body longer than MAX_NOTE_LENGTH', async () => {
      const db = createMockDb()
      const tooLong = 'x'.repeat(MAX_NOTE_LENGTH + 1)
      await expect(
        addNote(db, {
          shop_id: SHOP,
          customer_id: CUSTOMER,
          body: tooLong,
        }),
      ).rejects.toThrow(/characters or fewer/i)
    })

    it('trims whitespace before persisting', async () => {
      const insertedRow = {
        id: NOTE,
        shop_id: SHOP,
        customer_id: CUSTOMER,
        body: 'hello world',
        author_user_id: AUTHOR,
        author_name_snapshot: 'Thai',
        created_at: '2026-04-20T00:00:00Z',
      }
      const db = createMockDb({
        'select:customers': { id: CUSTOMER },
        'insert:customer_notes': insertedRow,
      })

      const out = await addNote(db, {
        shop_id: SHOP,
        customer_id: CUSTOMER,
        body: '   hello world   ',
        author_user_id: AUTHOR,
        author_name_snapshot: 'Thai',
      })

      expect(out.body).toBe('hello world')
    })
  })

  describe('addNote — cross-shop defence', () => {
    it('rejects when customer does not belong to the shop', async () => {
      // select:customers returns null (no match for given shop_id + id).
      const db = createMockDb({
        'select:customers': null,
      })

      await expect(
        addNote(db, {
          shop_id: OTHER_SHOP,
          customer_id: CUSTOMER_OTHER_SHOP,
          body: 'malicious',
        }),
      ).rejects.toThrow(/not found in this shop/i)

      // Insert must NEVER be reached once the scope check fails.
      expect(db.insertInto).not.toHaveBeenCalled()
    })

    it('proceeds to insert when customer is in the shop', async () => {
      const insertedRow = {
        id: NOTE,
        shop_id: SHOP,
        customer_id: CUSTOMER,
        body: 'legit',
        author_user_id: AUTHOR,
        author_name_snapshot: 'Thai',
        created_at: '2026-04-20T00:00:00Z',
      }
      const db = createMockDb({
        'select:customers': { id: CUSTOMER },
        'insert:customer_notes': insertedRow,
      })

      const out = await addNote(db, {
        shop_id: SHOP,
        customer_id: CUSTOMER,
        body: 'legit',
        author_user_id: AUTHOR,
        author_name_snapshot: 'Thai',
      })

      expect(out).toEqual(insertedRow)
      expect(db.insertInto).toHaveBeenCalledWith('customer_notes')
    })

    it('defaults nullable author columns when not supplied', async () => {
      const insertedRow = {
        id: NOTE,
        shop_id: SHOP,
        customer_id: CUSTOMER,
        body: 'system note',
        author_user_id: null,
        author_name_snapshot: null,
        created_at: '2026-04-20T00:00:00Z',
      }
      const db = createMockDb({
        'select:customers': { id: CUSTOMER },
        'insert:customer_notes': insertedRow,
      })

      const out = await addNote(db, {
        shop_id: SHOP,
        customer_id: CUSTOMER,
        body: 'system note',
      })

      expect(out.author_user_id).toBeNull()
      expect(out.author_name_snapshot).toBeNull()
    })
  })

  describe('listNotes', () => {
    it('returns shop-scoped rows', async () => {
      const rows = [
        { id: '1', body: 'note a' },
        { id: '2', body: 'note b' },
      ]
      const db = createMockDb({
        'select:customer_notes': rows,
      })

      const out = await listNotes(db, {
        shop_id: SHOP,
        customer_id: CUSTOMER,
      })

      expect(out).toEqual(rows)
      expect(db.selectFrom).toHaveBeenCalledWith('customer_notes')
    })

    it('clamps limit to a sane range', async () => {
      const db = createMockDb({ 'select:customer_notes': [] })

      // These should not throw despite being out of range.
      await expect(
        listNotes(db, { shop_id: SHOP, customer_id: CUSTOMER, limit: 0 }),
      ).resolves.toEqual([])
      await expect(
        listNotes(db, { shop_id: SHOP, customer_id: CUSTOMER, limit: 9999 }),
      ).resolves.toEqual([])
      await expect(
        listNotes(db, { shop_id: SHOP, customer_id: CUSTOMER, offset: -5 }),
      ).resolves.toEqual([])
    })
  })

  describe('deleteNote', () => {
    it('returns true when a row was deleted', async () => {
      const db = createMockDb({
        'delete:customer_notes': { numDeletedRows: 1n },
      })

      const ok = await deleteNote(db, {
        shop_id: SHOP,
        note_id: NOTE,
      })

      expect(ok).toBe(true)
    })

    it('returns false when no row was deleted (missing or cross-shop)', async () => {
      const db = createMockDb({
        'delete:customer_notes': { numDeletedRows: 0n },
      })

      const ok = await deleteNote(db, {
        shop_id: OTHER_SHOP,
        note_id: NOTE,
      })

      expect(ok).toBe(false)
    })
  })

  describe('countNotes', () => {
    it('returns the numeric count', async () => {
      const db = createMockDb({
        'select:customer_notes': { count: '7' },
      })

      const n = await countNotes(db, SHOP, CUSTOMER)
      expect(n).toBe(7)
    })

    it('returns 0 when no row comes back', async () => {
      const db = createMockDb({
        'select:customer_notes': null,
      })

      const n = await countNotes(db, SHOP, CUSTOMER)
      expect(n).toBe(0)
    })
  })
})
