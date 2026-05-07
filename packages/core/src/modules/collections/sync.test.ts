/**
 * Smart collection sync — unit tests (Phase C2)
 *
 * Tests the diff-then-apply behaviour against a fake Kysely backend
 * that records the INSERT/DELETE operations. We assert:
 *
 *   - Manual collections (no rules / legacy array) are a NO-OP.
 *   - Collection not found / wrong shop → 'not-found' mode.
 *   - Smart with empty conditions + no current members → no writes.
 *   - Smart with new desired ids → single INSERT with positions after max.
 *   - Smart with stale members → single DELETE with IN filter.
 *   - Shared members (in both desired and current) are NOT touched —
 *     the merchant's manual drag-order stays intact.
 *   - Position for new rows starts at max(existing.position) + 1.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { Kysely } from 'kysely'
import { syncSmartCollection } from './sync.js'
import type { SmartRules } from './smart-rules.js'

interface FakeState {
  // Collections lookup — keyed by id. value.shopId is checked.
  collection: { id: string; shop_id: string; rules: unknown } | null

  // Evaluator output — the test pre-computes which product ids the
  // rules would match and injects them here, so sync.test.ts doesn't
  // need to exercise the SQL (smart-rules.test.ts covers that).
  desiredIds: string[]

  // Current collection_products rows for the collection.
  current: Array<{ product_id: string; position: number }>
}

interface Ops {
  deletes: Array<{ collection_id: string; product_ids: string[] }>
  inserts: Array<{ collection_id: string; product_id: string; position: number }>
}

function makeDb(state: FakeState, ops: Ops) {
  // Builder factory — one fresh builder per select/delete/insert
  // root call, so chained `.where()`s don't bleed across queries.
  function newBuilder() {
    const b: any = {
      _table: null as string | null,
      _whereEq: [] as Array<[string, string, any]>,
      _whereIn: null as null | { col: string; vals: string[] },
      _op: 'select',
      _values: null as any,

      select(_cols: string | string[]) {
        return b
      },
      where(col: any, op?: any, val?: any) {
        if (typeof col === 'function') return b
        if (op === 'in') b._whereIn = { col, vals: val }
        else b._whereEq.push([col, op, val])
        return b
      },
      values(v: any) {
        b._values = v
        return b
      },
      async executeTakeFirst() {
        if (b._table === 'collections') {
          const id = b._whereEq.find((w: any) => w[0] === 'id')?.[2]
          const shop = b._whereEq.find((w: any) => w[0] === 'shop_id')?.[2]
          if (!state.collection) return undefined
          if (state.collection.id !== id) return undefined
          if (state.collection.shop_id !== shop) return undefined
          return state.collection
        }
        return undefined
      },
      async execute() {
        if (b._op === 'delete' && b._table === 'collection_products') {
          const col = b._whereEq.find((w: any) => w[0] === 'collection_id')?.[2]
          ops.deletes.push({
            collection_id: col,
            product_ids: b._whereIn?.vals ?? [],
          })
          return
        }
        if (b._op === 'insert' && b._table === 'collection_products') {
          for (const row of b._values ?? []) {
            ops.inserts.push({
              collection_id: row.collection_id,
              product_id: row.product_id,
              position: row.position,
            })
          }
          return
        }
        if (b._table === 'products') {
          return state.desiredIds.map((id) => ({ id }))
        }
        if (b._table === 'collection_products') {
          return state.current
        }
        return []
      },
    }
    return b
  }

  // Return typed as `Kysely<any>` so the test compiles against the
  // production signature. The fake only implements the handful of
  // builder methods the sync worker actually calls — anything else
  // would throw, but the sync path is covered end-to-end here.
  return {
    selectFrom(table: string) {
      const b = newBuilder()
      b._table = table
      b._op = 'select'
      return b
    },
    deleteFrom(table: string) {
      const b = newBuilder()
      b._table = table
      b._op = 'delete'
      return b
    },
    insertInto(table: string) {
      const b = newBuilder()
      b._table = table
      b._op = 'insert'
      return b
    },
  } as unknown as Kysely<any>
}

function smartRules(): SmartRules {
  return { match: 'all', conditions: [{ field: 'title', op: 'equals', value: 'x' }] }
}

let state: FakeState
let ops: Ops

beforeEach(() => {
  state = { collection: null, desiredIds: [], current: [] }
  ops = { deletes: [], inserts: [] }
})

describe('syncSmartCollection', () => {
  it('returns not-found when collection is missing', async () => {
    state.collection = null
    const result = await syncSmartCollection(makeDb(state, ops), {
      collectionId: 'c1',
      shopId: 's1',
    })
    expect(result.mode).toBe('not-found')
    expect(ops.inserts).toEqual([])
    expect(ops.deletes).toEqual([])
  })

  it('returns not-found when collection belongs to a different shop', async () => {
    state.collection = { id: 'c1', shop_id: 'other-shop', rules: smartRules() }
    const result = await syncSmartCollection(makeDb(state, ops), {
      collectionId: 'c1',
      shopId: 's1',
    })
    expect(result.mode).toBe('not-found')
    expect(ops.inserts).toEqual([])
    expect(ops.deletes).toEqual([])
  })

  it('no-ops on a manual collection (null rules)', async () => {
    state.collection = { id: 'c1', shop_id: 's1', rules: null }
    state.current = [{ product_id: 'p1', position: 0 }]
    const result = await syncSmartCollection(makeDb(state, ops), {
      collectionId: 'c1',
      shopId: 's1',
    })
    expect(result.mode).toBe('manual')
    expect(ops.inserts).toEqual([])
    expect(ops.deletes).toEqual([])
  })

  it('no-ops on a legacy-array rules shape (clone-pro import)', async () => {
    state.collection = { id: 'c1', shop_id: 's1', rules: [{ foo: 1 }] }
    const result = await syncSmartCollection(makeDb(state, ops), {
      collectionId: 'c1',
      shopId: 's1',
    })
    expect(result.mode).toBe('manual')
    expect(ops.inserts).toEqual([])
    expect(ops.deletes).toEqual([])
  })

  it('inserts new members with positions after current max', async () => {
    state.collection = { id: 'c1', shop_id: 's1', rules: smartRules() }
    state.current = [
      { product_id: 'p1', position: 0 },
      { product_id: 'p2', position: 1 },
    ]
    state.desiredIds = ['p1', 'p2', 'p3', 'p4'] // p3 + p4 are new

    const result = await syncSmartCollection(makeDb(state, ops), {
      collectionId: 'c1',
      shopId: 's1',
    })

    expect(result.mode).toBe('smart')
    expect(result.added).toBe(2)
    expect(result.removed).toBe(0)
    expect(result.kept).toBe(2)

    // p3 at position 2, p4 at position 3
    expect(ops.inserts).toEqual([
      { collection_id: 'c1', product_id: 'p3', position: 2 },
      { collection_id: 'c1', product_id: 'p4', position: 3 },
    ])
    expect(ops.deletes).toEqual([])
  })

  it('deletes stale members with a single IN query', async () => {
    state.collection = { id: 'c1', shop_id: 's1', rules: smartRules() }
    state.current = [
      { product_id: 'p1', position: 0 },
      { product_id: 'p2', position: 1 },
      { product_id: 'p3', position: 2 },
    ]
    state.desiredIds = ['p1'] // p2 + p3 are stale

    const result = await syncSmartCollection(makeDb(state, ops), {
      collectionId: 'c1',
      shopId: 's1',
    })

    expect(result.added).toBe(0)
    expect(result.removed).toBe(2)
    expect(result.kept).toBe(1)
    expect(ops.deletes).toEqual([
      { collection_id: 'c1', product_ids: ['p2', 'p3'] },
    ])
    expect(ops.inserts).toEqual([])
  })

  it('leaves shared members untouched (manual drag positions survive)', async () => {
    state.collection = { id: 'c1', shop_id: 's1', rules: smartRules() }
    state.current = [
      { product_id: 'p1', position: 5 }, // merchant dragged p1 to the end
      { product_id: 'p2', position: 0 },
    ]
    state.desiredIds = ['p1', 'p2'] // identical to current

    const result = await syncSmartCollection(makeDb(state, ops), {
      collectionId: 'c1',
      shopId: 's1',
    })
    expect(result.added).toBe(0)
    expect(result.removed).toBe(0)
    expect(result.kept).toBe(2)
    expect(ops.deletes).toEqual([])
    expect(ops.inserts).toEqual([])
  })

  it('handles empty conditions as a sweep to empty collection', async () => {
    state.collection = {
      id: 'c1',
      shop_id: 's1',
      rules: { match: 'all', conditions: [] },
    }
    state.current = [
      { product_id: 'p1', position: 0 },
      { product_id: 'p2', position: 1 },
    ]
    state.desiredIds = [] // evaluator short-circuits on empty conditions

    const result = await syncSmartCollection(makeDb(state, ops), {
      collectionId: 'c1',
      shopId: 's1',
    })

    expect(result.added).toBe(0)
    expect(result.removed).toBe(2)
    expect(ops.deletes).toEqual([
      { collection_id: 'c1', product_ids: ['p1', 'p2'] },
    ])
  })
})
