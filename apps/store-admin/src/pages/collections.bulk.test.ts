/**
 * Store-admin — bulk collection ops handler (Phase C3b).
 *
 * Covers:
 *   - Unknown action → redirect with error flash.
 *   - Empty id list → redirect with error flash.
 *   - All ids cross-tenant → redirect with error flash, no mutation.
 *   - Mixed ids (some valid, some cross-tenant) → mutate only the valid
 *     set, flash summary counts skipped rows.
 *   - `publish` → UPDATE collections SET published=true, published_at=now.
 *   - `unpublish` → UPDATE collections SET published=false, published_at=null.
 *   - `delete` → DELETE collection_products THEN collections (FK order).
 *   - Each mutation emits one audit row per affected collection.
 *   - Notification is aggregated (one bell ping, not N).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../middleware/store-auth.js', () => ({
  logSellerAction: vi.fn(),
}))
vi.mock('../lib/notify.js', () => ({
  notify: vi.fn(),
  byActor: vi.fn((u: any) => `By ${u?.name ?? 'unknown'}`),
}))

import { logSellerAction } from '../middleware/store-auth.js'
import { notify } from '../lib/notify.js'
import { postCollectionsBulk } from './collections.js'

const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const C1 = 'cccccccc-cccc-cccc-cccc-cccccccccc01'
const C2 = 'cccccccc-cccc-cccc-cccc-cccccccccc02'
const C3 = 'cccccccc-cccc-cccc-cccc-cccccccccc03'
const C_OTHER_SHOP = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'

// --------------------------------------------------------------------
// Fake Kysely — records UPDATE/DELETE/SELECT against a simple state
// --------------------------------------------------------------------

interface DbState {
  collections: Array<{ id: string; title: string; shop_id: string }>
}

interface DbOps {
  updates: Array<{
    table: string
    set: Record<string, unknown>
    filters: Array<[string, string, unknown]>
  }>
  deletes: Array<{ table: string; filters: Array<[string, string, unknown]> }>
  audits: Array<unknown>
}

function makeDb(state: DbState) {
  const ops: DbOps = { updates: [], deletes: [], audits: [] }

  function selectBuilder(table: string) {
    const filters: Array<[string, string, unknown]> = []
    const b: any = {
      select: () => b,
      selectAll: () => b,
      where: (col: string, op: string, val: unknown) => {
        filters.push([col, op, val])
        return b
      },
      execute: async () => {
        if (table === 'collections') {
          const shopF = filters.find((f) => f[0] === 'shop_id')
          const idsF = filters.find((f) => f[0] === 'id' && f[1] === 'in')
          const ids = Array.isArray(idsF?.[2]) ? (idsF![2] as string[]) : []
          return state.collections.filter(
            (c) =>
              (!shopF || c.shop_id === shopF[2]) &&
              (ids.length === 0 || ids.includes(c.id)),
          )
        }
        return []
      },
      executeTakeFirst: async () => undefined,
    }
    return b
  }

  function deleteBuilder(table: string) {
    const filters: Array<[string, string, unknown]> = []
    const b: any = {
      where: (col: string, op: string, val: unknown) => {
        filters.push([col, op, val])
        return b
      },
      execute: async () => {
        ops.deletes.push({ table, filters })
      },
    }
    return b
  }

  function updateBuilder(table: string) {
    const filters: Array<[string, string, unknown]> = []
    let setVal: Record<string, unknown> = {}
    const b: any = {
      set: (v: Record<string, unknown>) => {
        setVal = v
        return b
      },
      where: (col: string, op: string, val: unknown) => {
        filters.push([col, op, val])
        return b
      },
      execute: async () => {
        ops.updates.push({ table, set: setVal, filters })
      },
    }
    return b
  }

  function insertBuilder(_table: string) {
    // audit_logs / any other inserts — record as audits.
    return {
      values: (v: unknown) => ({
        execute: async () => {
          ops.audits.push(v)
        },
        onConflict: () => ({
          doNothing: () => ({ execute: async () => { ops.audits.push(v) } }),
          doUpdateSet: () => ({ execute: async () => { ops.audits.push(v) } }),
        }),
        returning: () => ({ execute: async () => [] }),
      }),
    }
  }

  return {
    db: {
      selectFrom: (t: string) => selectBuilder(t.split(' ')[0] ?? t),
      insertInto: (t: string) => insertBuilder(t),
      deleteFrom: (t: string) => deleteBuilder(t),
      updateTable: (t: string) => updateBuilder(t),
    } as any,
    ops,
  }
}

function makeReq(body: Record<string, unknown>) {
  return {
    store: { id: SHOP_ID, slug: 'test-shop', name: 'Test Shop' },
    storeUser: { id: 'user-1', name: 'Thai', email: 't@x.com', role: 'owner' },
    params: {},
    body,
    csrfToken: 'csrf-test-token',
    headers: {},
  } as any
}

function makeRes() {
  const res: any = { redirectLocation: null }
  res.redirect = vi.fn().mockImplementation((loc: string) => {
    res.redirectLocation = loc
  })
  return res
}

// --------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------

describe('postCollectionsBulk', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const baseState: DbState = {
    collections: [
      { id: C1, title: 'Hats', shop_id: SHOP_ID },
      { id: C2, title: 'Scarves', shop_id: SHOP_ID },
      { id: C3, title: 'Gloves', shop_id: SHOP_ID },
      { id: C_OTHER_SHOP, title: 'Not Yours', shop_id: 'other-shop' },
    ],
  }

  it('redirects with error when action is unknown', async () => {
    const { db, ops } = makeDb(baseState)
    const req = makeReq({ action: 'nuke', ids: [C1] })
    const res = makeRes()
    await postCollectionsBulk(req, res, db)
    expect(res.redirectLocation).toContain('error=')
    expect(ops.updates).toHaveLength(0)
    expect(ops.deletes).toHaveLength(0)
  })

  it('redirects with error when no ids submitted', async () => {
    const { db, ops } = makeDb(baseState)
    const req = makeReq({ action: 'publish', ids: [] })
    const res = makeRes()
    await postCollectionsBulk(req, res, db)
    expect(res.redirectLocation).toContain('error=')
    expect(ops.updates).toHaveLength(0)
  })

  it('redirects with error when every id is cross-tenant', async () => {
    const { db, ops } = makeDb(baseState)
    const req = makeReq({ action: 'delete', ids: [C_OTHER_SHOP] })
    const res = makeRes()
    await postCollectionsBulk(req, res, db)
    expect(res.redirectLocation).toContain('error=')
    expect(ops.deletes).toHaveLength(0)
    expect(ops.updates).toHaveLength(0)
  })

  it('publish sets published=true + published_at=now and audits each row', async () => {
    const { db, ops } = makeDb(baseState)
    const req = makeReq({ action: 'publish', ids: [C1, C2] })
    const res = makeRes()
    await postCollectionsBulk(req, res, db)

    // One UPDATE with published=true, published_at=<iso string>
    const up = ops.updates.find((u) => u.table === 'collections')
    expect(up).toBeTruthy()
    expect(up!.set.published).toBe(true)
    expect(typeof up!.set.published_at).toBe('string')
    expect((up!.set.published_at as string).length).toBeGreaterThan(10)

    // Shop scoping
    expect(up!.filters.some((f) => f[0] === 'shop_id' && f[2] === SHOP_ID)).toBe(true)

    // Audit: one row per valid id
    expect(logSellerAction).toHaveBeenCalledTimes(2)

    // Notification: one aggregated
    expect(notify).toHaveBeenCalledTimes(1)

    expect(res.redirectLocation).toContain('success=')
  })

  it('unpublish sets published=false + published_at=null', async () => {
    const { db, ops } = makeDb(baseState)
    const req = makeReq({ action: 'unpublish', ids: [C1] })
    const res = makeRes()
    await postCollectionsBulk(req, res, db)

    const up = ops.updates.find((u) => u.table === 'collections')
    expect(up).toBeTruthy()
    expect(up!.set.published).toBe(false)
    expect(up!.set.published_at).toBeNull()
  })

  it('delete removes memberships first, then collections (FK order)', async () => {
    const { db, ops } = makeDb(baseState)
    const req = makeReq({ action: 'delete', ids: [C1, C2] })
    const res = makeRes()
    await postCollectionsBulk(req, res, db)

    // Two DELETEs: collection_products then collections.
    expect(ops.deletes).toHaveLength(2)
    expect(ops.deletes[0]!.table).toBe('collection_products')
    expect(ops.deletes[1]!.table).toBe('collections')

    // collections DELETE is shop-scoped.
    const colsDel = ops.deletes[1]!
    expect(colsDel.filters.some((f) => f[0] === 'shop_id' && f[2] === SHOP_ID)).toBe(true)

    // Audit one row per valid id.
    expect(logSellerAction).toHaveBeenCalledTimes(2)
  })

  it('drops cross-tenant ids silently — only mutates in-shop collections', async () => {
    const { db, ops } = makeDb(baseState)
    const req = makeReq({ action: 'delete', ids: [C1, C_OTHER_SHOP] })
    const res = makeRes()
    await postCollectionsBulk(req, res, db)

    // DELETEs happen (C1 is valid), but the filter IN-list should not
    // include C_OTHER_SHOP — we verify by checking the collections
    // DELETE filter. The fake records filters verbatim.
    const colsDel = ops.deletes.find((d) => d.table === 'collections')!
    const idsFilter = colsDel.filters.find((f) => f[0] === 'id' && f[1] === 'in')!
    expect(idsFilter[2]).toEqual([C1])

    // Summary flash mentions the one skipped.
    expect(res.redirectLocation).toContain('success=')
    expect(decodeURIComponent(res.redirectLocation)).toContain('skipped')
  })

  it('normalises a single string id into a list (Express form quirk)', async () => {
    const { db, ops } = makeDb(baseState)
    // When ONLY one checkbox is checked, Express passes `ids: "c1"`
    // (a bare string) instead of `ids: ["c1"]`. Handler must coerce.
    const req = makeReq({ action: 'publish', ids: C1 })
    const res = makeRes()
    await postCollectionsBulk(req, res, db)

    const up = ops.updates.find((u) => u.table === 'collections')
    expect(up).toBeTruthy()
    expect(logSellerAction).toHaveBeenCalledTimes(1)
  })
})
