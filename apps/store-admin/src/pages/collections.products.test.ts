/**
 * Store-admin — collection product management handlers (Phase C1).
 *
 * Until Phase C1, the only way for a merchant to add a product to a
 * collection was to open the product page, scroll to "Collections"
 * and pick from the list there. Shopify has the picker on BOTH sides:
 * product editor AND collection detail page. Phase C1 adds the
 * collection-side handlers:
 *
 *   1. `postCollectionProductsAdd`    — bulk-add N products to a collection
 *   2. `postCollectionProductsRemove` — bulk-remove N products
 *   3. `postCollectionProductsReorder`— set manual sort positions
 *
 * Each is guarded by the cross-tenant rules that already scope every
 * other collections/products handler:
 *   - Collection must belong to the caller's shop (else redirect 404).
 *   - Every candidate product must also belong to the same shop — we
 *     join on shop_id BEFORE any mutation runs, so passing another
 *     shop's product id through the form silently drops it rather
 *     than polluting memberships or leaking existence.
 *   - On no-op (all ids already in / none in) we still redirect +
 *     don't error — feels consistent with every other bulk handler.
 *
 * This suite is pure-unit: we mock `logSellerAction` + `notify` +
 * `byActor`, and proxy the db so every insert/update/delete is
 * captured by a simple recorder. No Postgres, no transactions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// --------------------------------------------------------------------
// Module mocks — MUST come before importing collections.ts
// --------------------------------------------------------------------

vi.mock('../middleware/store-auth.js', () => ({
  logSellerAction: vi.fn(),
}))
vi.mock('../lib/notify.js', () => ({
  notify: vi.fn(),
  byActor: vi.fn((u: any) => `By ${u?.name ?? u?.email ?? 'unknown'}`),
}))

import { logSellerAction } from '../middleware/store-auth.js'
import { notify } from '../lib/notify.js'

import {
  postCollectionProductsAdd,
  postCollectionProductsRemove,
  postCollectionProductsReorder,
} from './collections.js'

// --------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------

const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const COLLECTION_ID = '22222222-2222-2222-2222-222222222222'
const OTHER_SHOP_ID = '99999999-9999-9999-9999-999999999999'

const P1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const P2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const P3 = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
// P4 belongs to a DIFFERENT shop — the cross-tenant guard.
const P4_OTHER_SHOP = 'dddddddd-dddd-dddd-dddd-dddddddddddd'

// --------------------------------------------------------------------
// Fake Kysely — records every mutation. Select paths return
// state seeded by each test's setup.
// --------------------------------------------------------------------

interface DbState {
  collection: { id: string; title: string; shop_id: string } | null
  // Products the validation SELECT will see, per shop scope.
  productsInShop: Array<{ id: string; shop_id: string }>
  // Existing memberships (to drive idempotent add / remove).
  existingMemberships: Array<{ collection_id: string; product_id: string; position: number }>
}

interface DbOps {
  inserts: Array<{ table: string; values: unknown }>
  deletes: Array<{ table: string; filters: Array<[string, string, unknown]> }>
  updates: Array<{
    table: string
    set: Record<string, unknown>
    filters: Array<[string, string, unknown]>
  }>
  audits: Array<unknown>
}

function makeDb(state: DbState) {
  const ops: DbOps = { inserts: [], deletes: [], updates: [], audits: [] }

  function selectBuilder(table: string) {
    const filters: Array<[string, string, unknown]> = []
    const b: any = {
      select: () => b,
      selectAll: () => b,
      innerJoin: () => b,
      leftJoin: () => b,
      where: (col: string, op: string, val: unknown) => {
        filters.push([col, op, val])
        return b
      },
      orderBy: () => b,
      executeTakeFirst: async () => {
        if (table === 'collections') {
          // Respect shop_id scope.
          const idF = filters.find((f) => f[0] === 'id')
          const shopF = filters.find((f) => f[0] === 'shop_id')
          if (!state.collection) return undefined
          if (idF && idF[2] !== state.collection.id) return undefined
          if (shopF && shopF[2] !== state.collection.shop_id) return undefined
          return state.collection
        }
        return undefined
      },
      execute: async () => {
        if (table === 'products') {
          const shopF = filters.find((f) => f[0] === 'shop_id')
          const idsF = filters.find((f) => f[0] === 'id' && f[1] === 'in')
          const ids = Array.isArray(idsF?.[2]) ? (idsF![2] as string[]) : []
          return state.productsInShop.filter(
            (p) =>
              (!shopF || p.shop_id === shopF[2]) &&
              (ids.length === 0 || ids.includes(p.id)),
          )
        }
        if (table === 'collection_products') {
          const colF = filters.find((f) => f[0] === 'collection_id')
          return state.existingMemberships.filter(
            (m) => !colF || m.collection_id === colF[2],
          )
        }
        return []
      },
    }
    return b
  }

  function insertBuilder(table: string) {
    return {
      values: (v: unknown) => ({
        onConflict: () => ({
          doNothing: () => ({ execute: async () => {
            if (table === 'audit_logs') {
              ops.audits.push(v)
            } else {
              ops.inserts.push({ table, values: v })
            }
          } }),
          doUpdateSet: () => ({ execute: async () => {
            if (table === 'audit_logs') {
              ops.audits.push(v)
            } else {
              ops.inserts.push({ table, values: v })
            }
          } }),
        }),
        execute: async () => {
          if (table === 'audit_logs') {
            ops.audits.push(v)
          } else {
            ops.inserts.push({ table, values: v })
          }
        },
        returning: () => ({ execute: async () => [] }),
      }),
    }
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

// --------------------------------------------------------------------
// Request / Response stubs
// --------------------------------------------------------------------

function makeReq(opts: {
  collectionId?: string
  body?: Record<string, unknown>
} = {}) {
  return {
    store: { id: SHOP_ID, slug: 'test-shop', name: 'Test Shop' },
    storeUser: {
      id: 'user-1',
      name: 'Thai',
      email: 'thai@example.com',
      role: 'owner',
      storeRole: 'owner',
    },
    params: { collectionId: opts.collectionId ?? COLLECTION_ID },
    body: opts.body ?? {},
    csrfToken: 'csrf-test-token',
    headers: {},
  } as any
}

function makeRes() {
  const res: any = { statusCode: 200, redirectLocation: null }
  res.status = vi.fn().mockImplementation((n: number) => {
    res.statusCode = n
    return res
  })
  res.send = vi.fn()
  res.redirect = vi.fn().mockImplementation((loc: string) => {
    res.statusCode = 302
    res.redirectLocation = loc
  })
  return res
}

beforeEach(() => {
  vi.mocked(logSellerAction).mockReset()
  vi.mocked(notify).mockReset()
})

// ====================================================================
// postCollectionProductsAdd
// ====================================================================

describe('postCollectionProductsAdd', () => {
  it('inserts every provided product id that belongs to the shop', async () => {
    const { db, ops } = makeDb({
      collection: { id: COLLECTION_ID, title: 'Summer', shop_id: SHOP_ID },
      productsInShop: [
        { id: P1, shop_id: SHOP_ID },
        { id: P2, shop_id: SHOP_ID },
      ],
      existingMemberships: [],
    })
    const req = makeReq({ body: { product_ids: [P1, P2] } })
    const res = makeRes()
    await postCollectionProductsAdd(req, res, db)
    // 302 back to collection detail
    expect(res.statusCode).toBe(302)
    // Two memberships created — exact id list regardless of position.
    expect(ops.inserts).toHaveLength(1)
    const insertedRows = ops.inserts[0]!.values as Array<{ product_id: string; collection_id: string }>
    expect(insertedRows.map((r) => r.product_id).sort()).toEqual([P1, P2].sort())
    expect(insertedRows.every((r) => r.collection_id === COLLECTION_ID)).toBe(true)
  })

  it('drops any product id that does not belong to this shop (cross-tenant guard)', async () => {
    const { db, ops } = makeDb({
      collection: { id: COLLECTION_ID, title: 'Summer', shop_id: SHOP_ID },
      productsInShop: [
        { id: P1, shop_id: SHOP_ID },
        // P4 deliberately NOT in shop-scoped products.
      ],
      existingMemberships: [],
    })
    const req = makeReq({ body: { product_ids: [P1, P4_OTHER_SHOP] } })
    const res = makeRes()
    await postCollectionProductsAdd(req, res, db)
    expect(res.statusCode).toBe(302)
    // Only P1 should hit the insert — P4 silently dropped.
    const insertedRows = ops.inserts[0]!.values as Array<{ product_id: string }>
    expect(insertedRows.map((r) => r.product_id)).toEqual([P1])
  })

  it('skips product ids that are already in the collection (idempotent)', async () => {
    const { db, ops } = makeDb({
      collection: { id: COLLECTION_ID, title: 'Summer', shop_id: SHOP_ID },
      productsInShop: [
        { id: P1, shop_id: SHOP_ID },
        { id: P2, shop_id: SHOP_ID },
      ],
      existingMemberships: [
        { collection_id: COLLECTION_ID, product_id: P1, position: 0 },
      ],
    })
    const req = makeReq({ body: { product_ids: [P1, P2] } })
    const res = makeRes()
    await postCollectionProductsAdd(req, res, db)
    expect(res.statusCode).toBe(302)
    // Only P2 inserted; P1 already present.
    const insertedRows = ops.inserts[0]?.values as Array<{ product_id: string }> | undefined
    expect(insertedRows).toEqual([
      expect.objectContaining({ product_id: P2, collection_id: COLLECTION_ID }),
    ])
  })

  it('assigns each new membership a position AFTER the current max', async () => {
    // New rows should land at the end of the ordering. If the
    // existing max position is 4, new rows get 5, 6, 7... so manual
    // drag-reorder (which uses these positions) Just Works.
    const { db, ops } = makeDb({
      collection: { id: COLLECTION_ID, title: 'Summer', shop_id: SHOP_ID },
      productsInShop: [
        { id: P2, shop_id: SHOP_ID },
        { id: P3, shop_id: SHOP_ID },
      ],
      existingMemberships: [
        { collection_id: COLLECTION_ID, product_id: P1, position: 4 },
      ],
    })
    const req = makeReq({ body: { product_ids: [P2, P3] } })
    const res = makeRes()
    await postCollectionProductsAdd(req, res, db)
    const insertedRows = ops.inserts[0]!.values as Array<{ product_id: string; position: number }>
    // P2 → 5, P3 → 6 (order of the input array preserved).
    const byId = Object.fromEntries(insertedRows.map((r) => [r.product_id, r.position]))
    expect(byId[P2]).toBe(5)
    expect(byId[P3]).toBe(6)
  })

  it('redirects 404 when the collection does not belong to this shop', async () => {
    const { db, ops } = makeDb({
      collection: { id: COLLECTION_ID, title: 'Summer', shop_id: OTHER_SHOP_ID },
      productsInShop: [{ id: P1, shop_id: SHOP_ID }],
      existingMemberships: [],
    })
    const req = makeReq({ body: { product_ids: [P1] } })
    const res = makeRes()
    await postCollectionProductsAdd(req, res, db)
    expect(res.statusCode).toBe(302)
    expect(res.redirectLocation).toMatch(/error=/)
    // No insert should have fired — we bailed at the collection check.
    expect(ops.inserts).toHaveLength(0)
  })

  it('no-ops cleanly when product_ids is empty', async () => {
    const { db, ops } = makeDb({
      collection: { id: COLLECTION_ID, title: 'Summer', shop_id: SHOP_ID },
      productsInShop: [],
      existingMemberships: [],
    })
    const req = makeReq({ body: { product_ids: [] } })
    const res = makeRes()
    await postCollectionProductsAdd(req, res, db)
    expect(res.statusCode).toBe(302)
    expect(ops.inserts).toHaveLength(0)
  })

  it('accepts a single product_ids as a string (form-post single-value)', async () => {
    // Express form-encoded bodies deliver single-checkbox picks as a
    // string, not an array. The handler must tolerate both shapes.
    const { db, ops } = makeDb({
      collection: { id: COLLECTION_ID, title: 'Summer', shop_id: SHOP_ID },
      productsInShop: [{ id: P1, shop_id: SHOP_ID }],
      existingMemberships: [],
    })
    const req = makeReq({ body: { product_ids: P1 } })
    const res = makeRes()
    await postCollectionProductsAdd(req, res, db)
    expect(res.statusCode).toBe(302)
    const insertedRows = ops.inserts[0]!.values as Array<{ product_id: string }>
    expect(insertedRows.map((r) => r.product_id)).toEqual([P1])
  })
})

// ====================================================================
// postCollectionProductsRemove
// ====================================================================

describe('postCollectionProductsRemove', () => {
  it('deletes every supplied membership scoped to this collection', async () => {
    const { db, ops } = makeDb({
      collection: { id: COLLECTION_ID, title: 'Summer', shop_id: SHOP_ID },
      productsInShop: [
        { id: P1, shop_id: SHOP_ID },
        { id: P2, shop_id: SHOP_ID },
      ],
      existingMemberships: [
        { collection_id: COLLECTION_ID, product_id: P1, position: 0 },
        { collection_id: COLLECTION_ID, product_id: P2, position: 1 },
      ],
    })
    const req = makeReq({ body: { product_ids: [P1, P2] } })
    const res = makeRes()
    await postCollectionProductsRemove(req, res, db)
    expect(res.statusCode).toBe(302)
    // The handler issues ONE delete with `product_id IN (...)` scoped
    // by collection_id — cheaper than N queries.
    expect(ops.deletes).toHaveLength(1)
    const del = ops.deletes[0]!
    expect(del.table).toBe('collection_products')
    const colFilter = del.filters.find((f) => f[0] === 'collection_id')
    const idFilter = del.filters.find((f) => f[0] === 'product_id' && f[1] === 'in')
    expect(colFilter?.[2]).toBe(COLLECTION_ID)
    expect(idFilter?.[2]).toEqual(expect.arrayContaining([P1, P2]))
  })

  it('redirects 404 when the collection does not belong to the shop', async () => {
    const { db, ops } = makeDb({
      collection: { id: COLLECTION_ID, title: 'Summer', shop_id: OTHER_SHOP_ID },
      productsInShop: [],
      existingMemberships: [],
    })
    const req = makeReq({ body: { product_ids: [P1] } })
    const res = makeRes()
    await postCollectionProductsRemove(req, res, db)
    expect(res.statusCode).toBe(302)
    expect(res.redirectLocation).toMatch(/error=/)
    expect(ops.deletes).toHaveLength(0)
  })

  it('no-ops cleanly when product_ids is empty', async () => {
    const { db, ops } = makeDb({
      collection: { id: COLLECTION_ID, title: 'Summer', shop_id: SHOP_ID },
      productsInShop: [],
      existingMemberships: [],
    })
    const req = makeReq({ body: { product_ids: [] } })
    const res = makeRes()
    await postCollectionProductsRemove(req, res, db)
    expect(res.statusCode).toBe(302)
    expect(ops.deletes).toHaveLength(0)
  })

  it('accepts a single product_ids as a string', async () => {
    const { db, ops } = makeDb({
      collection: { id: COLLECTION_ID, title: 'Summer', shop_id: SHOP_ID },
      productsInShop: [{ id: P1, shop_id: SHOP_ID }],
      existingMemberships: [
        { collection_id: COLLECTION_ID, product_id: P1, position: 0 },
      ],
    })
    const req = makeReq({ body: { product_ids: P1 } })
    const res = makeRes()
    await postCollectionProductsRemove(req, res, db)
    expect(res.statusCode).toBe(302)
    expect(ops.deletes).toHaveLength(1)
    const idFilter = ops.deletes[0]!.filters.find(
      (f) => f[0] === 'product_id' && f[1] === 'in',
    )
    expect(idFilter?.[2]).toEqual([P1])
  })
})

// ====================================================================
// postCollectionProductsReorder
// ====================================================================

describe('postCollectionProductsReorder', () => {
  it('updates each product\'s position to match the supplied order', async () => {
    // Input: ordered_ids = [P2, P1, P3] → P2 gets position 0, P1 gets
    // 1, P3 gets 2. One UPDATE per row.
    const { db, ops } = makeDb({
      collection: { id: COLLECTION_ID, title: 'Summer', shop_id: SHOP_ID },
      productsInShop: [],
      existingMemberships: [
        { collection_id: COLLECTION_ID, product_id: P1, position: 0 },
        { collection_id: COLLECTION_ID, product_id: P2, position: 1 },
        { collection_id: COLLECTION_ID, product_id: P3, position: 2 },
      ],
    })
    const req = makeReq({ body: { ordered_ids: `${P2},${P1},${P3}` } })
    const res = makeRes()
    await postCollectionProductsReorder(req, res, db)
    expect(res.statusCode).toBe(302)
    // One UPDATE per row, with the new position.
    expect(ops.updates).toHaveLength(3)
    const byId: Record<string, number> = {}
    for (const u of ops.updates) {
      expect(u.table).toBe('collection_products')
      const prodF = u.filters.find((f) => f[0] === 'product_id')
      const colF = u.filters.find((f) => f[0] === 'collection_id')
      expect(colF?.[2]).toBe(COLLECTION_ID)
      byId[prodF![2] as string] = u.set.position as number
    }
    expect(byId[P2]).toBe(0)
    expect(byId[P1]).toBe(1)
    expect(byId[P3]).toBe(2)
  })

  it('accepts ordered_ids as an array (JSON / form repeat)', async () => {
    const { db, ops } = makeDb({
      collection: { id: COLLECTION_ID, title: 'Summer', shop_id: SHOP_ID },
      productsInShop: [],
      existingMemberships: [
        { collection_id: COLLECTION_ID, product_id: P1, position: 0 },
        { collection_id: COLLECTION_ID, product_id: P2, position: 1 },
      ],
    })
    const req = makeReq({ body: { ordered_ids: [P2, P1] } })
    const res = makeRes()
    await postCollectionProductsReorder(req, res, db)
    expect(ops.updates).toHaveLength(2)
  })

  it('redirects 404 when the collection does not belong to the shop', async () => {
    const { db, ops } = makeDb({
      collection: { id: COLLECTION_ID, title: 'Summer', shop_id: OTHER_SHOP_ID },
      productsInShop: [],
      existingMemberships: [],
    })
    const req = makeReq({ body: { ordered_ids: `${P1}` } })
    const res = makeRes()
    await postCollectionProductsReorder(req, res, db)
    expect(res.statusCode).toBe(302)
    expect(res.redirectLocation).toMatch(/error=/)
    expect(ops.updates).toHaveLength(0)
  })

  it('no-ops cleanly when ordered_ids is empty', async () => {
    const { db, ops } = makeDb({
      collection: { id: COLLECTION_ID, title: 'Summer', shop_id: SHOP_ID },
      productsInShop: [],
      existingMemberships: [],
    })
    const req = makeReq({ body: { ordered_ids: '' } })
    const res = makeRes()
    await postCollectionProductsReorder(req, res, db)
    expect(res.statusCode).toBe(302)
    expect(ops.updates).toHaveLength(0)
  })

  it('drops any id that is not currently a member (silent filter)', async () => {
    // If the UI sends a stale or bogus id we ignore it — don't
    // create phantom memberships through an UPDATE that targets a
    // row that isn't there (UPDATE matches 0 rows, harmless) but we
    // shouldn't count it in position assignment either.
    const { db, ops } = makeDb({
      collection: { id: COLLECTION_ID, title: 'Summer', shop_id: SHOP_ID },
      productsInShop: [],
      existingMemberships: [
        { collection_id: COLLECTION_ID, product_id: P1, position: 0 },
        { collection_id: COLLECTION_ID, product_id: P2, position: 1 },
      ],
    })
    const BOGUS = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
    const req = makeReq({ body: { ordered_ids: `${P1},${BOGUS},${P2}` } })
    const res = makeRes()
    await postCollectionProductsReorder(req, res, db)
    // Only the two real members hit UPDATE; positions 0 and 1
    // (contiguous — the bogus id is squeezed out, it doesn't shift
    // P2 to position 2).
    expect(ops.updates).toHaveLength(2)
    const byId: Record<string, number> = {}
    for (const u of ops.updates) {
      const prodF = u.filters.find((f) => f[0] === 'product_id')
      byId[prodF![2] as string] = u.set.position as number
    }
    expect(byId[P1]).toBe(0)
    expect(byId[P2]).toBe(1)
  })
})

// ====================================================================
// Shared: audit + notify wiring
// ====================================================================

describe('audit + notify wiring', () => {
  it('postCollectionProductsAdd logs the action with product count', async () => {
    const { db } = makeDb({
      collection: { id: COLLECTION_ID, title: 'Summer', shop_id: SHOP_ID },
      productsInShop: [{ id: P1, shop_id: SHOP_ID }],
      existingMemberships: [],
    })
    await postCollectionProductsAdd(makeReq({ body: { product_ids: [P1] } }), makeRes(), db)
    expect(vi.mocked(logSellerAction)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'collection.products_added',
      'collection',
      COLLECTION_ID,
      expect.objectContaining({ count: 1 }),
    )
  })

  it('postCollectionProductsRemove logs with the removed count', async () => {
    const { db } = makeDb({
      collection: { id: COLLECTION_ID, title: 'Summer', shop_id: SHOP_ID },
      productsInShop: [],
      existingMemberships: [
        { collection_id: COLLECTION_ID, product_id: P1, position: 0 },
      ],
    })
    await postCollectionProductsRemove(makeReq({ body: { product_ids: [P1] } }), makeRes(), db)
    expect(vi.mocked(logSellerAction)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'collection.products_removed',
      'collection',
      COLLECTION_ID,
      expect.objectContaining({ count: 1 }),
    )
  })

  it('postCollectionProductsReorder logs the new order length', async () => {
    const { db } = makeDb({
      collection: { id: COLLECTION_ID, title: 'Summer', shop_id: SHOP_ID },
      productsInShop: [],
      existingMemberships: [
        { collection_id: COLLECTION_ID, product_id: P1, position: 0 },
        { collection_id: COLLECTION_ID, product_id: P2, position: 1 },
      ],
    })
    await postCollectionProductsReorder(
      makeReq({ body: { ordered_ids: `${P2},${P1}` } }),
      makeRes(),
      db,
    )
    expect(vi.mocked(logSellerAction)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'collection.products_reordered',
      'collection',
      COLLECTION_ID,
      expect.objectContaining({ count: 2 }),
    )
  })
})
