/**
 * Store-admin — products bulk edit + SEO shortcut (Phase 2 PR6).
 *
 * Covers:
 *   - postProductBulkEdit: tag_add, tag_remove, price_adjust (with
 *     floor/round/ceil), collection_add, collection_remove, status_set,
 *     metafield_set
 *   - postProductBulkEdit: cross-shop ids silently dropped
 *   - postProductBulkEdit: empty editMode / selection redirects with error
 *   - postProductSeoShortcut: upserts 3 metafields in the 'seo' namespace
 *   - postProductSeoShortcut: refuses cross-shop product
 *
 * Fake Kysely is minimal — it tracks products, product_variants,
 * collection_products and forwards metafield writes to the mocked
 * setMetafield. No real PG involvement; live smoke testing runs from
 * server 2 per memory/smoke_test_runbook.md.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock setMetafield + side effects ──────────────────────────────────
vi.mock('@gbox/core/modules/metafields/service.js', () => ({
  setMetafield: vi.fn().mockResolvedValue({ id: 'mf-1' }),
}))
vi.mock('@gbox/core/modules/products/service.js', () => ({
  updateInventory: vi.fn().mockResolvedValue({ id: 'lvl-1', available: 1 }),
}))
vi.mock('@gbox/core/modules/collections/enqueue-triggers.js', () => ({
  enqueueSyncShopSmart: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../middleware/store-auth.js', () => ({
  logSellerAction: vi.fn(),
}))
vi.mock('../lib/notify.js', () => ({
  notify: vi.fn(),
  byActor: vi.fn((u: any) => `By ${u?.name ?? 'unknown'}`),
}))
vi.mock('@gbox/core/modules/auth/csrf.js', () => ({
  csrfHiddenField: vi.fn((t: string) => `<input type="hidden" name="_csrf" value="${t}">`),
}))

import { setMetafield } from '@gbox/core/modules/metafields/service.js'
import {
  postProductBulkEdit,
  postProductSeoShortcut,
} from './products.js'

// ── Fixtures ──────────────────────────────────────────────────────────
const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const OTHER_SHOP_ID = '22222222-2222-2222-2222-222222222222'

// Give us 10 product ids for the "bulk tag on 10 products" test
function pid(i: number): string {
  const h = i.toString().padStart(2, '0')
  return `ppppppp0-pppp-pppp-pppp-pppppppppp${h}`
}

// All fixture UUIDs must be valid hex to match PRODUCT_ID_UUID_RE in
// products.ts — any stray 'x' (etc.) fails the regex and triggers a
// slug-lookup fallback that our fake DB doesn't emulate.
const PROD_OTHER = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee01'
const COL_A = 'cccccccc-aaaa-aaaa-aaaa-aaaaaaaaaa01'
const COL_B = 'cccccccc-bbbb-bbbb-bbbb-bbbbbbbbbb02'
const COL_OTHER = 'cccccccc-cccc-cccc-cccc-cccccccccc03'

interface FakeProduct {
  id: string
  shop_id: string
  title: string
  tags: string[] | null
  status: string
  slug?: string
  seo_title?: string | null
  seo_description?: string | null
}
interface FakeVariant {
  id: string
  product_id: string
  price: string
  compare_at_price: string | null
}
interface FakeCollection {
  id: string
  shop_id: string
  title: string
}
interface FakeCollProd {
  product_id: string
  collection_id: string
}

interface State {
  products: FakeProduct[]
  variants: FakeVariant[]
  collections: FakeCollection[]
  collection_products: FakeCollProd[]
}

/**
 * Fake Kysely that accumulates filters per-query and dispatches by the
 * primary `from` table. Writes are applied in-memory to the state so
 * tests can assert on the post-mutation shape.
 */
function makeDb(state: State) {
  const calls: { table: string; kind: string; set?: any; where: any[] }[] = []

  /**
   * Create a single builder per query whose `execute()` behaviour depends
   * on the entry point that created it: selectFrom → read, updateTable →
   * apply state mutation, deleteFrom → remove matching rows, insertInto →
   * push rows. We thread the `mode` through a closure so chained `.where`
   * / `.set` / `.values` calls don't need separate builder objects.
   */
  function builder(table: string, mode: 'select' | 'update' | 'delete' | 'insert' = 'select') {
    const filters: Array<[string, string, any]> = []
    let pendingSet: any = null
    const b: any = {
      select: () => b,
      selectAll: () => b,
      where: (col: any, op: string, val: any) => {
        if (typeof col === 'string') filters.push([col, op, val])
        // eb callback form: we don't evaluate full expression trees; tests
        // here don't exercise the ilike-search path for ALL scope.
        return b
      },
      orderBy: () => b,
      limit: () => b,
      set: (patch: any) => {
        pendingSet = patch
        return b
      },
      values: (vals: any) => {
        pendingSet = vals
        return b
      },
      execute: async () => {
        if (mode === 'select') {
          return runSelect()
        }
        calls.push({ table, kind: mode, set: pendingSet, where: filters })
        runMutate()
        return []
      },
      executeTakeFirst: async () => {
        if (mode !== 'select') {
          calls.push({ table, kind: mode, set: pendingSet, where: filters })
          runMutate()
          return {}
        }
        const rows = runSelect()
        return rows[0]
      },
      executeTakeFirstOrThrow: async () => {
        if (mode !== 'select') {
          calls.push({ table, kind: mode, set: pendingSet, where: filters })
          runMutate()
          return {}
        }
        const rows = runSelect()
        if (!rows[0]) throw new Error(`no rows for ${table}`)
        return rows[0]
      },
    }

    function runSelect(): any[] {
      const shopF = filters.find((f) => f[0] === 'shop_id')?.[2]
      const idIn = filters.find((f) => f[0] === 'id' && f[1] === 'in')?.[2] as
        | string[]
        | undefined
      const idEq = filters.find((f) => f[0] === 'id' && f[1] === '=')?.[2]
      const pidIn = filters.find((f) => f[0] === 'product_id' && f[1] === 'in')?.[2] as
        | string[]
        | undefined
      const pidEq = filters.find((f) => f[0] === 'product_id' && f[1] === '=')?.[2]
      const cidIn = filters.find((f) => f[0] === 'collection_id' && f[1] === 'in')
        ?.[2] as string[] | undefined

      if (table === 'products') {
        let rows = state.products.slice()
        if (shopF) rows = rows.filter((r) => r.shop_id === shopF)
        if (idIn) rows = rows.filter((r) => idIn.includes(r.id))
        if (idEq) rows = rows.filter((r) => r.id === idEq)
        return rows
      }
      if (table === 'product_variants') {
        let rows = state.variants.slice()
        if (pidIn) rows = rows.filter((v) => pidIn.includes(v.product_id))
        if (pidEq) rows = rows.filter((v) => v.product_id === pidEq)
        if (idIn) rows = rows.filter((v) => idIn.includes(v.id))
        if (idEq) rows = rows.filter((v) => v.id === idEq)
        return rows
      }
      if (table === 'collections') {
        let rows = state.collections.slice()
        if (shopF) rows = rows.filter((r) => r.shop_id === shopF)
        if (idIn) rows = rows.filter((r) => idIn.includes(r.id))
        return rows
      }
      if (table === 'collection_products') {
        let rows = state.collection_products.slice()
        if (pidIn) rows = rows.filter((r) => pidIn.includes(r.product_id))
        if (cidIn) rows = rows.filter((r) => cidIn.includes(r.collection_id))
        return rows
      }
      return []
    }

    function runMutate() {
      const idIn = filters.find((f) => f[0] === 'id' && f[1] === 'in')?.[2] as
        | string[]
        | undefined
      const idEq = filters.find((f) => f[0] === 'id' && f[1] === '=')?.[2]
      const pidIn = filters.find((f) => f[0] === 'product_id' && f[1] === 'in')?.[2] as
        | string[]
        | undefined
      const cidIn = filters.find((f) => f[0] === 'collection_id' && f[1] === 'in')
        ?.[2] as string[] | undefined

      if (table === 'products' && mode === 'update') {
        for (const p of state.products) {
          if ((idIn && idIn.includes(p.id)) || p.id === idEq) {
            Object.assign(p, pendingSet)
          }
        }
      }
      if (table === 'product_variants' && mode === 'update') {
        for (const v of state.variants) {
          if (v.id === idEq || (idIn && idIn.includes(v.id))) {
            Object.assign(v, pendingSet)
          }
        }
      }
      if (table === 'collection_products') {
        if (mode === 'delete') {
          state.collection_products = state.collection_products.filter((r) => {
            const matchP = pidIn ? pidIn.includes(r.product_id) : true
            const matchC = cidIn ? cidIn.includes(r.collection_id) : true
            return !(matchP && matchC)
          })
        }
        if (mode === 'insert') {
          const rows: FakeCollProd[] = Array.isArray(pendingSet) ? pendingSet : [pendingSet]
          for (const r of rows) state.collection_products.push({ ...r })
        }
      }
    }

    return b
  }

  return {
    calls,
    db: {
      selectFrom: (t: string) => builder(t.split(' ')[0]!, 'select'),
      updateTable: (t: string) => builder(t.split(' ')[0]!, 'update'),
      deleteFrom: (t: string) => builder(t.split(' ')[0]!, 'delete'),
      insertInto: (t: string) => builder(t.split(' ')[0]!, 'insert'),
      fn: { count: () => ({ as: () => 'count' }), sum: () => ({ as: () => 'total' }) },
    } as any,
  }
}

function makeReq(overrides: Partial<any> = {}) {
  return {
    store: { id: SHOP_ID, slug: 'test-shop', name: 'Test Shop' },
    storeUser: {
      id: 'user-1',
      name: 'Thai',
      email: 't@x.com',
      role: 'owner',
      storeRole: 'owner',
    },
    params: {},
    body: {},
    query: {},
    csrfToken: 'csrf-test-token',
    headers: {},
    ...overrides,
  } as any
}

function makeRes() {
  const res: any = { redirectLocation: null }
  res.redirect = vi.fn().mockImplementation((loc: string) => {
    res.redirectLocation = loc
  })
  return res
}

function seedTenProducts(): State {
  const products: FakeProduct[] = []
  const variants: FakeVariant[] = []
  for (let i = 1; i <= 10; i++) {
    const id = pid(i)
    products.push({
      id,
      shop_id: SHOP_ID,
      title: `Product ${i}`,
      tags: i === 1 ? ['existing'] : null,
      status: 'active',
    })
    variants.push({
      id: `vvvvvvv0-vvvv-vvvv-vvvv-${i.toString().padStart(12, 'v')}`,
      product_id: id,
      price: '10.00',
      compare_at_price: null,
    })
  }
  return {
    products,
    variants,
    collections: [
      { id: COL_A, shop_id: SHOP_ID, title: 'Summer' },
      { id: COL_B, shop_id: SHOP_ID, title: 'Clearance' },
      { id: COL_OTHER, shop_id: OTHER_SHOP_ID, title: "Not ours" },
    ],
    collection_products: [],
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('postProductBulkEdit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('tag_add: adds tag to 10 products (Shopify-parity dedupe)', async () => {
    const state = seedTenProducts()
    const { db } = makeDb(state)
    const ids = Array.from({ length: 10 }, (_, i) => pid(i + 1)).join(',')
    const req = makeReq({
      body: { ids, editMode: 'tag_add', tags: 'bulk-test, existing' },
    })
    const res = makeRes()
    await postProductBulkEdit(req, res, db)
    // All 10 should have 'bulk-test'
    expect(state.products.every((p) => (p.tags ?? []).includes('bulk-test'))).toBe(true)
    // Product 1 already had 'existing' — no duplicate
    const p1 = state.products.find((p) => p.id === pid(1))!
    expect(p1.tags!.filter((t) => t === 'existing').length).toBe(1)
    expect(res.redirectLocation).toContain('success=Updated+10+products')
  })

  it('tag_remove: strips only the requested tags', async () => {
    const state = seedTenProducts()
    // Pre-populate tags on every product
    for (const p of state.products) p.tags = ['keep', 'bulk-test']
    const { db } = makeDb(state)
    const ids = state.products.map((p) => p.id).join(',')
    const req = makeReq({
      body: { ids, editMode: 'tag_remove', tags: 'bulk-test' },
    })
    const res = makeRes()
    await postProductBulkEdit(req, res, db)
    for (const p of state.products) {
      expect(p.tags).toEqual(['keep'])
    }
  })

  it('price_adjust: +10% with floor rounding (Shopify convention)', async () => {
    const state = seedTenProducts()
    // Make prices interesting — one variant at 19.99 to exercise floor
    state.variants[0]!.price = '19.99'
    const { db } = makeDb(state)
    const ids = state.products.map((p) => p.id).join(',')
    const req = makeReq({
      body: {
        ids,
        editMode: 'price_adjust',
        adjustType: 'percent',
        adjustValue: '10',
        rounding: 'floor',
      },
    })
    const res = makeRes()
    await postProductBulkEdit(req, res, db)
    // 10.00 * 1.10 = 11.00 → floor-cents = 11.00
    // 19.99 * 1.10 = 21.989 → floor-cents = 21.98
    const v0 = state.variants.find((v) => v.price === '21.98')
    expect(v0).toBeDefined()
    // All other variants (started at 10.00) become 11.00
    const elevens = state.variants.filter((v) => v.price === '11.00')
    expect(elevens.length).toBe(9)
  })

  it('price_adjust: -50% clamps to $0 floor (no negative prices)', async () => {
    const state = seedTenProducts()
    // Inject a variant at $0.01 → 0.01 * 0.5 = 0.005 → floor = 0.00
    state.variants[0]!.price = '0.01'
    const { db } = makeDb(state)
    const req = makeReq({
      body: {
        ids: state.products[0]!.id,
        editMode: 'price_adjust',
        adjustType: 'percent',
        adjustValue: '-50',
      },
    })
    const res = makeRes()
    await postProductBulkEdit(req, res, db)
    expect(state.variants[0]!.price).toBe('0.00')
  })

  it('collection_add: inserts junction rows once, skips existing', async () => {
    const state = seedTenProducts()
    // Product 1 already in COL_A
    state.collection_products.push({ product_id: pid(1), collection_id: COL_A })
    const { db } = makeDb(state)
    const ids = state.products.map((p) => p.id).join(',')
    const req = makeReq({
      body: { ids, editMode: 'collection_add', collectionIds: `${COL_A},${COL_B}` },
    })
    const res = makeRes()
    await postProductBulkEdit(req, res, db)
    // Expect 10 * 2 = 20 rows total, with product 1 / COL_A deduped → 19 new + 1 existing = 20
    expect(state.collection_products.length).toBe(20)
  })

  it('collection_add: cross-shop collection id is silently dropped', async () => {
    const state = seedTenProducts()
    const { db } = makeDb(state)
    const req = makeReq({
      body: {
        ids: state.products.map((p) => p.id).join(','),
        editMode: 'collection_add',
        collectionIds: COL_OTHER, // belongs to OTHER_SHOP_ID
      },
    })
    const res = makeRes()
    await postProductBulkEdit(req, res, db)
    // No junction rows created — the cross-shop id was scoped out
    expect(state.collection_products.length).toBe(0)
    expect(res.redirectLocation).toContain('error=')
  })

  it('status_set: flips every selected product to draft', async () => {
    const state = seedTenProducts()
    const { db } = makeDb(state)
    const req = makeReq({
      body: {
        ids: state.products.map((p) => p.id).join(','),
        editMode: 'status_set',
        status: 'draft',
      },
    })
    const res = makeRes()
    await postProductBulkEdit(req, res, db)
    expect(state.products.every((p) => p.status === 'draft')).toBe(true)
  })

  it('metafield_set: upserts the same (ns,key,value) on every product', async () => {
    const state = seedTenProducts()
    const { db } = makeDb(state)
    const req = makeReq({
      body: {
        ids: state.products.map((p) => p.id).join(','),
        editMode: 'metafield_set',
        mfNamespace: 'custom',
        mfKey: 'badge',
        mfValue: 'Summer',
        mfValueType: 'single_line_text_field',
      },
    })
    const res = makeRes()
    await postProductBulkEdit(req, res, db)
    expect(setMetafield).toHaveBeenCalledTimes(10)
    expect(setMetafield).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        shop_id: SHOP_ID,
        owner_type: 'product',
        namespace: 'custom',
        key: 'badge',
        value: 'Summer',
      }),
    )
  })

  it('rejects cross-shop product ids silently (scope-widening defence)', async () => {
    const state = seedTenProducts()
    state.products.push({
      id: PROD_OTHER,
      shop_id: OTHER_SHOP_ID,
      title: 'Not ours',
      tags: null,
      status: 'active',
    })
    const { db } = makeDb(state)
    const req = makeReq({
      body: {
        ids: `${pid(1)},${PROD_OTHER}`,
        editMode: 'tag_add',
        tags: 'bulk-test',
      },
    })
    const res = makeRes()
    await postProductBulkEdit(req, res, db)
    // Only our product gains the tag; the foreign product is untouched
    const ours = state.products.find((p) => p.id === pid(1))!
    const theirs = state.products.find((p) => p.id === PROD_OTHER)!
    expect((ours.tags ?? []).includes('bulk-test')).toBe(true)
    expect(theirs.tags).toBeNull()
  })

  it('empty editMode redirects with error (no mutation)', async () => {
    const state = seedTenProducts()
    const { db, calls } = makeDb(state)
    const req = makeReq({ body: { ids: pid(1), editMode: '' } })
    const res = makeRes()
    await postProductBulkEdit(req, res, db)
    expect(res.redirectLocation).toContain('error=')
    // No update/delete/insert calls
    expect(calls.filter((c) => c.kind !== 'execute').length).toBe(0)
  })

  it('metafield_set with invalid JSON returns error (value never written)', async () => {
    const state = seedTenProducts()
    const { db } = makeDb(state)
    const req = makeReq({
      body: {
        ids: pid(1),
        editMode: 'metafield_set',
        mfNamespace: 'custom',
        mfKey: 'data',
        mfValue: '{bad json',
        mfValueType: 'json',
      },
    })
    const res = makeRes()
    await postProductBulkEdit(req, res, db)
    expect(setMetafield).not.toHaveBeenCalled()
    expect(res.redirectLocation).toContain('error=')
  })
})

describe('postProductSeoShortcut', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('upserts seo.title + seo.description + seo.handle metafields', async () => {
    const state = seedTenProducts()
    const { db } = makeDb(state)
    const productId = pid(1)
    const req = makeReq({
      params: { productId },
      body: {
        seoTitle: 'Red Widget — Best 2026',
        seoDescription: 'Durable red widget with lifetime warranty.',
        seoHandle: 'red-widget-2026',
      },
    })
    const res = makeRes()
    await postProductSeoShortcut(req, res, db)
    expect(setMetafield).toHaveBeenCalledTimes(3)
    const calls = (setMetafield as any).mock.calls.map((c: any[]) => c[1])
    const keys = calls.map((c: any) => c.key).sort()
    expect(keys).toEqual(['description', 'handle', 'title'])
    // Every call uses namespace='seo' and owner_type='product'
    for (const c of calls) {
      expect(c.namespace).toBe('seo')
      expect(c.owner_type).toBe('product')
      expect(c.owner_id).toBe(productId)
    }
    expect(res.redirectLocation).toContain('success=')
  })

  it('refuses cross-shop product (no metafield writes)', async () => {
    const state = seedTenProducts()
    state.products.push({
      id: PROD_OTHER,
      shop_id: OTHER_SHOP_ID,
      title: 'Not ours',
      tags: null,
      status: 'active',
    })
    const { db } = makeDb(state)
    const req = makeReq({
      params: { productId: PROD_OTHER },
      body: { seoTitle: 'Hijacked' },
    })
    const res = makeRes()
    await postProductSeoShortcut(req, res, db)
    expect(setMetafield).not.toHaveBeenCalled()
    expect(res.redirectLocation).toBe('/admin/store/test-shop/products')
  })

  it('skips empty fields — writes only the ones provided', async () => {
    const state = seedTenProducts()
    const { db } = makeDb(state)
    const req = makeReq({
      params: { productId: pid(1) },
      body: { seoTitle: 'Only title set', seoDescription: '', seoHandle: '  ' },
    })
    const res = makeRes()
    await postProductSeoShortcut(req, res, db)
    expect(setMetafield).toHaveBeenCalledTimes(1)
    const args = (setMetafield as any).mock.calls[0][1]
    expect(args.key).toBe('title')
    expect(args.value).toBe('Only title set')
  })

  it('rejects when every field is blank', async () => {
    const state = seedTenProducts()
    const { db } = makeDb(state)
    const req = makeReq({
      params: { productId: pid(1) },
      body: { seoTitle: '', seoDescription: '', seoHandle: '' },
    })
    const res = makeRes()
    await postProductSeoShortcut(req, res, db)
    expect(setMetafield).not.toHaveBeenCalled()
    expect(res.redirectLocation).toContain('error=')
  })
})
