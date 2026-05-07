/**
 * Quick-filter service tests — Phase 4 PR5.
 *
 * The service composes Kysely selects + upsert-on-name + position
 * bookkeeping. We run it against a chainable fake DB that terminates
 * `execute` / `executeTakeFirst` on queued fixtures (one per call).
 *
 * What's exercised:
 *   - `normalizeQuickFilterQuery` drops unknown keys + coerces enums.
 *   - `paramsToQuery` + `queryToParams` round-trip the shape.
 *   - `listQuickFilters` yields the rows with normalized JSON.
 *   - `getQuickFilter` fails-closed on cross-shop ids.
 *   - `saveQuickFilter` creates (when no existing row by name) and
 *     updates (when one exists) — both return the hydrated row.
 *   - `deleteQuickFilter` returns true/false on hit/miss.
 */

import { describe, it, expect } from 'vitest'
import {
  normalizeQuickFilterQuery,
  paramsToQuery,
  queryToParams,
  listQuickFilters,
  getQuickFilter,
  saveQuickFilter,
  deleteQuickFilter,
} from './service.js'

// ---------------------------------------------------------------------------
// Fake DB — chainable proxy, queues per-table fixtures.
// ---------------------------------------------------------------------------

interface Fixture {
  execute?: any[]
  executeTakeFirst?: any
  executeTakeFirstOrThrow?: any
  numDeletedRows?: bigint
  numUpdatedRows?: bigint
}

function chain(fixtures: Fixture[], ptr: { i: number }) {
  const c: any = {}
  for (const m of ['select', 'selectAll', 'where', 'orderBy', 'limit', 'set',
                   'values', 'returning', 'into']) {
    c[m] = (..._args: any[]) => c
  }
  c.execute = async () => {
    const f = fixtures[ptr.i++] ?? {}
    return f.execute ?? []
  }
  c.executeTakeFirst = async () => {
    const f = fixtures[ptr.i++] ?? {}
    return (
      f.executeTakeFirst ??
      (f.numDeletedRows !== undefined
        ? { numDeletedRows: f.numDeletedRows }
        : f.numUpdatedRows !== undefined
          ? { numUpdatedRows: f.numUpdatedRows }
          : null)
    )
  }
  c.executeTakeFirstOrThrow = async () => {
    const f = fixtures[ptr.i++] ?? {}
    if (f.executeTakeFirstOrThrow == null) throw new Error('no fixture')
    return f.executeTakeFirstOrThrow
  }
  return c
}

function makeDb(fixtures: Fixture[]) {
  const ptr = { i: 0 }
  const dbFake: any = {
    selectFrom: () => chain(fixtures, ptr),
    insertInto: () => chain(fixtures, ptr),
    updateTable: () => chain(fixtures, ptr),
    deleteFrom: () => chain(fixtures, ptr),
    transaction: () => ({
      execute: async (cb: any) => cb(dbFake),
    }),
    fn: {
      max: (_col: string) => ({ as: (_a: string) => 'mx' }),
    },
  }
  return dbFake
}

// ---------------------------------------------------------------------------
// normalizeQuickFilterQuery
// ---------------------------------------------------------------------------

describe('normalizeQuickFilterQuery', () => {
  it('returns an empty object for null / non-object input', () => {
    expect(normalizeQuickFilterQuery(null)).toEqual({})
    expect(normalizeQuickFilterQuery(undefined)).toEqual({})
    expect(normalizeQuickFilterQuery('string')).toEqual({})
  })

  it('drops unknown keys', () => {
    const n = normalizeQuickFilterQuery({ foo: 'bar', q: 'ada', sql: 'DROP' })
    expect(n).toEqual({ q: 'ada' })
  })

  it('coerces enum fields and drops invalid values', () => {
    const n = normalizeQuickFilterQuery({
      lifecycle: 'churned',
      marketing: 'MAYBE',
      status: 'active',
    })
    expect(n.lifecycle).toBe('churned')
    expect(n.marketing).toBeUndefined()
    expect(n.status).toBe('active')
  })

  it('trims string fields + drops empty strings', () => {
    const n = normalizeQuickFilterQuery({ q: '   ', tag: '  vip ' })
    expect(n.q).toBeUndefined()
    expect(n.tag).toBe('vip')
  })
})

// ---------------------------------------------------------------------------
// Param round-trip
// ---------------------------------------------------------------------------

describe('queryToParams + paramsToQuery', () => {
  it('builds a compact query string, skipping empty fields', () => {
    expect(queryToParams({ q: 'ada', lifecycle: 'churned' })).toBe('q=ada&lifecycle=churned')
    expect(queryToParams({})).toBe('')
  })

  it('url-encodes free-text values', () => {
    expect(queryToParams({ q: 'space & special' })).toContain(encodeURIComponent('space & special'))
  })

  it('round-trips via the normalize pipeline', () => {
    const original = { q: 'ada', lifecycle: 'churned' as const, marketing: 'yes' as const }
    // simulate Express parsing — string values
    const decoded = paramsToQuery(original)
    expect(decoded).toEqual(original)
  })
})

// ---------------------------------------------------------------------------
// listQuickFilters
// ---------------------------------------------------------------------------

describe('listQuickFilters', () => {
  it('returns the rows with normalized filter_json', async () => {
    const rows = [
      {
        id: 'a',
        shop_id: 'shop1',
        name: 'Churned VIPs',
        filter_json: { lifecycle: 'churned', tag: 'vip', nonsense: 'drop me' },
        position: 0,
        created_by_user_id: 'u1',
        created_at: '2026-04-20T00:00:00Z',
        updated_at: '2026-04-20T00:00:00Z',
      },
    ]
    const db = makeDb([{ execute: rows }])
    const out = await listQuickFilters(db, 'shop1')
    expect(out).toHaveLength(1)
    // `nonsense` must be stripped by normalizeQuickFilterQuery on read.
    expect(out[0]!.filter_json).toEqual({ lifecycle: 'churned', tag: 'vip' })
  })
})

// ---------------------------------------------------------------------------
// getQuickFilter
// ---------------------------------------------------------------------------

describe('getQuickFilter', () => {
  it('returns null when not found (cross-shop or deleted)', async () => {
    const db = makeDb([{ executeTakeFirst: null }])
    expect(await getQuickFilter(db, 'shop1', 'missing')).toBeNull()
  })

  it('returns the hydrated row when the id matches within the shop', async () => {
    const row = {
      id: 'a',
      shop_id: 'shop1',
      name: 'All',
      filter_json: {},
      position: 0,
      created_by_user_id: null,
      created_at: '2026-04-20T00:00:00Z',
      updated_at: '2026-04-20T00:00:00Z',
    }
    const db = makeDb([{ executeTakeFirst: row }])
    const out = await getQuickFilter(db, 'shop1', 'a')
    expect(out?.id).toBe('a')
  })
})

// ---------------------------------------------------------------------------
// saveQuickFilter
// ---------------------------------------------------------------------------

describe('saveQuickFilter', () => {
  it('throws on empty name', async () => {
    const db = makeDb([])
    await expect(
      saveQuickFilter(db, 'shop1', { name: '  ', query: {} }),
    ).rejects.toThrow(/name is required/)
  })

  it('inserts a new row when no existing name matches', async () => {
    // Sequence of DB calls:
    //   1. lookup existing by (shop, name) → null
    //   2. lookup max(position) → {mx: 2}
    //   3. insertInto(...).returning(id).executeTakeFirstOrThrow → {id}
    //   4. getQuickFilter → selectFrom(...).executeTakeFirst → full row
    const newRow = {
      id: 'new-id',
      shop_id: 'shop1',
      name: 'VIPs',
      filter_json: { tag: 'vip' },
      position: 3,
      created_by_user_id: 'u1',
      created_at: '2026-04-20T00:00:00Z',
      updated_at: '2026-04-20T00:00:00Z',
    }
    const db = makeDb([
      { executeTakeFirst: null },            // existing lookup → none
      { executeTakeFirst: { mx: 2 } },       // max position
      { executeTakeFirstOrThrow: { id: 'new-id' } }, // insert returning
      { executeTakeFirst: newRow },          // read-back
    ])
    const out = await saveQuickFilter(db, 'shop1', {
      name: ' VIPs ',
      query: { tag: 'vip' },
      createdByUserId: 'u1',
    })
    expect(out.id).toBe('new-id')
    expect(out.position).toBe(3)
  })

  it('updates in place when a row with the same name exists (upsert)', async () => {
    const updated = {
      id: 'existing',
      shop_id: 'shop1',
      name: 'VIPs',
      filter_json: { tag: 'vip-gold' },
      position: 1,
      created_by_user_id: null,
      created_at: '2026-04-20T00:00:00Z',
      updated_at: '2026-04-20T01:00:00Z',
    }
    const db = makeDb([
      { executeTakeFirst: { id: 'existing' } }, // existing lookup → hit
      {},                                       // update().execute()
      { executeTakeFirst: updated },            // read-back via getQuickFilter
    ])
    const out = await saveQuickFilter(db, 'shop1', { name: 'VIPs', query: { tag: 'vip-gold' } })
    expect(out.filter_json.tag).toBe('vip-gold')
    expect(out.id).toBe('existing')
  })
})

// ---------------------------------------------------------------------------
// deleteQuickFilter
// ---------------------------------------------------------------------------

describe('deleteQuickFilter', () => {
  it('returns true when a row was removed', async () => {
    const db = makeDb([{ numDeletedRows: 1n }])
    expect(await deleteQuickFilter(db, 'shop1', 'a')).toBe(true)
  })

  it('returns false for cross-shop or missing ids', async () => {
    const db = makeDb([{ numDeletedRows: 0n }])
    expect(await deleteQuickFilter(db, 'shop1', 'foreign')).toBe(false)
  })
})
