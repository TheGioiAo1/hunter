/**
 * Store-admin — inventory page (Phase 2 PR5 multi-location).
 *
 * Covers the delta work in PR5:
 *   - postAdjustInventory: routes through updateInventory(variantId, locId, delta)
 *     so the bridge + denormalized column stay consistent.
 *   - postAdjustInventory: validates submitted locationId belongs to this shop,
 *     falls back to primary active location when missing/invalid.
 *   - getInventory: renders location pill-bar ONLY when shop has 2+ active
 *     locations — single-location shops see no UX change (the PR5 promise).
 *
 * Uses a minimal fake Kysely that answers the specific queries this
 * handler makes. Smoke testing on a real Postgres runs from server 2 per
 * memory/smoke_test_runbook.md — this local suite covers the logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock the downstream service + side-effects ─────────────────────────
vi.mock('@gbox/core/modules/products/service.js', () => ({
  updateInventory: vi.fn().mockResolvedValue({ id: 'lvl-1', available: 1 }),
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

import { updateInventory } from '@gbox/core/modules/products/service.js'
import { getInventory, postAdjustInventory } from './inventory.js'

// ── Fixture IDs ────────────────────────────────────────────────────────
const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const OTHER_SHOP_ID = '22222222-2222-2222-2222-222222222222'
const VARIANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01'
const VARIANT_OTHER_SHOP = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa99'
const PRODUCT_ID = 'pppppppp-pppp-pppp-pppp-pppppppppp01'

const LOC_A = 'lllllll1-aaaa-aaaa-aaaa-aaaaaaaaaa01' // primary
const LOC_B = 'lllllll1-bbbb-bbbb-bbbb-bbbbbbbbbb02'
const LOC_OTHER_SHOP = 'lllllll1-cccc-cccc-cccc-cccccccccc03'

// ── Minimal fake Kysely ────────────────────────────────────────────────

interface DbState {
  locations: Array<{
    id: string
    shop_id: string
    name: string
    is_primary: boolean
    active: boolean
    created_at: string
  }>
  variants: Array<{
    id: string
    product_id: string
    title: string | null
    sku: string | null
    inventory_quantity: number
    price: number
    shop_id: string // logical — joined via products
    product_title: string
    product_slug: string
  }>
  inventoryLevels: Array<{ variant_id: string; location_id: string; available: number }>
}

function makeDb(state: DbState) {
  /**
   * Each call to selectFrom returns a new builder that accumulates filters
   * and dispatches to an execute/executeTakeFirst implementation based on
   * the FROM table(s).
   */
  function selectBuilder(primaryTable: string, joins: string[] = []) {
    const filters: Array<[string, string, unknown]> = []
    const orderBys: Array<[string, 'asc' | 'desc']> = []
    let limit: number | null = null
    const b: any = {
      select: () => b,
      selectAll: () => b,
      innerJoin: (t: string) => {
        joins.push(t.split(' ')[0]!.trim())
        return b
      },
      where: (col: any, op: string, val: unknown) => {
        // Support the eb() inline form — we only test the simple (col,op,val) path.
        if (typeof col === 'string') {
          filters.push([col, op, val])
        }
        return b
      },
      orderBy: (col: string, dir: 'asc' | 'desc' = 'asc') => {
        orderBys.push([col, dir])
        return b
      },
      limit: (n: number) => {
        limit = n
        return b
      },
      offset: () => b,
      execute: async () => runExecute(),
      executeTakeFirst: async () => {
        const rows = runExecute()
        return rows[0]
      },
    }

    function runExecute(): any[] {
      const shopFilter = filters.find((f) => f[0] === 'shop_id')?.[2]
      const productShopFilter = filters.find((f) => f[0] === 'p.shop_id')?.[2]
      const pvIdFilter = filters.find((f) => f[0] === 'pv.id')?.[2]
      const activeFilter = filters.find((f) => f[0] === 'active')?.[2]
      const idFilter = filters.find((f) => f[0] === 'id')?.[2]
      const idInFilter = filters.find((f) => f[0] === 'id' && f[1] === 'in')?.[2]

      // Route based on primary table
      if (primaryTable === 'locations') {
        let rows = state.locations.slice()
        if (shopFilter) rows = rows.filter((l) => l.shop_id === shopFilter)
        if (typeof activeFilter === 'boolean') rows = rows.filter((l) => l.active === activeFilter)
        if (idFilter && !idInFilter) rows = rows.filter((l) => l.id === idFilter)
        // Apply orderBy (stable for the primary/created_at pair we care about)
        for (const [col, dir] of [...orderBys].reverse()) {
          const key = col as keyof (typeof rows)[number]
          rows.sort((a, b) => {
            const av = a[key] as any
            const bv = b[key] as any
            if (av === bv) return 0
            const cmp = av < bv ? -1 : 1
            return dir === 'asc' ? cmp : -cmp
          })
        }
        if (limit) rows = rows.slice(0, limit)
        return rows
      }

      if (primaryTable === 'product_variants') {
        let rows = state.variants.slice()
        if (productShopFilter) rows = rows.filter((v) => v.shop_id === productShopFilter)
        if (pvIdFilter) rows = rows.filter((v) => v.id === pvIdFilter)
        // Return the shape getInventory + postAdjustInventory expect
        return rows.map((v) => ({
          id: v.id,
          variant_id: v.id,
          product_id: v.product_id,
          product_title: v.product_title,
          product_slug: v.product_slug,
          variant_title: v.title,
          sku: v.sku,
          inventory_quantity: v.inventory_quantity,
          price: v.price,
          updated_at: new Date().toISOString(),
          count: rows.length, // for aggregate queries
          total: rows.reduce((s, r) => s + r.inventory_quantity, 0),
        }))
      }

      if (primaryTable === 'inventory_levels') {
        // Join chain: il → ii → pv → p, filtered by p.shop_id
        const variantIdInFilter = filters.find((f) => f[0] === 'ii.variant_id' && f[1] === 'in')?.[2]
        const locFilter = filters.find((f) => f[0] === 'il.location_id')?.[2]
        let rows = state.inventoryLevels.slice()
        if (Array.isArray(variantIdInFilter)) {
          rows = rows.filter((lvl) => (variantIdInFilter as string[]).includes(lvl.variant_id))
        }
        if (locFilter) rows = rows.filter((lvl) => lvl.location_id === locFilter)
        if (productShopFilter) {
          rows = rows.filter((lvl) => {
            const v = state.variants.find((x) => x.id === lvl.variant_id)
            return v && v.shop_id === productShopFilter
          })
        }
        return rows.map((lvl) => ({
          variant_id: lvl.variant_id,
          location_id: lvl.location_id,
          available: lvl.available,
        }))
      }

      return []
    }

    return b
  }

  return {
    db: {
      selectFrom: (t: string) => {
        const primary = t.split(' ')[0]!
        return selectBuilder(primary)
      },
      // updateInventory() is mocked, so writes never hit this fake DB; but
      // we stub updateTable for the no-op path in postProductVariantUpdate.
      updateTable: () => ({
        set: () => ({ where: () => ({ where: () => ({ execute: async () => {} }) }) }),
      }),
      insertInto: () => ({
        values: () => ({ execute: async () => {}, executeTakeFirstOrThrow: async () => ({}) }),
      }),
      fn: {
        count: () => ({ as: () => 'count' }),
        sum: () => ({ as: () => 'total' }),
      },
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
  const res: any = { redirectLocation: null, body: '' }
  res.redirect = vi.fn().mockImplementation((loc: string) => {
    res.redirectLocation = loc
  })
  res.send = vi.fn().mockImplementation((body: string) => {
    res.body = body
  })
  return res
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('postAdjustInventory — multi-location routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const baseState: DbState = {
    locations: [
      {
        id: LOC_A,
        shop_id: SHOP_ID,
        name: 'Main Warehouse',
        is_primary: true,
        active: true,
        created_at: '2024-01-01T00:00:00Z',
      },
      {
        id: LOC_B,
        shop_id: SHOP_ID,
        name: 'Store Front',
        is_primary: false,
        active: true,
        created_at: '2024-06-01T00:00:00Z',
      },
      {
        id: LOC_OTHER_SHOP,
        shop_id: OTHER_SHOP_ID,
        name: 'Competitor Warehouse',
        is_primary: true,
        active: true,
        created_at: '2024-01-01T00:00:00Z',
      },
    ],
    variants: [
      {
        id: VARIANT_ID,
        product_id: PRODUCT_ID,
        title: 'Default',
        sku: 'WIDGET-1',
        inventory_quantity: 10,
        price: 19.99,
        shop_id: SHOP_ID,
        product_title: 'Widget',
        product_slug: 'widget',
      },
      {
        id: VARIANT_OTHER_SHOP,
        product_id: 'other-product',
        title: 'Default',
        sku: 'COMP-1',
        inventory_quantity: 5,
        price: 9.99,
        shop_id: OTHER_SHOP_ID,
        product_title: 'Competitor Widget',
        product_slug: 'competitor-widget',
      },
    ],
    inventoryLevels: [
      { variant_id: VARIANT_ID, location_id: LOC_A, available: 7 },
      { variant_id: VARIANT_ID, location_id: LOC_B, available: 3 },
    ],
  }

  it('uses submitted locationId when it belongs to this shop', async () => {
    const { db } = makeDb(baseState)
    const req = makeReq({
      body: {
        variantId: VARIANT_ID,
        adjustment: '1',
        locationId: LOC_B,
        reason: 'manual_adjustment',
      },
    })
    const res = makeRes()
    await postAdjustInventory(req, res, db)

    expect(updateInventory).toHaveBeenCalledTimes(1)
    expect(updateInventory).toHaveBeenCalledWith(expect.anything(), VARIANT_ID, LOC_B, 1)
  })

  it('falls back to primary active location when locationId is missing', async () => {
    const { db } = makeDb(baseState)
    const req = makeReq({
      body: { variantId: VARIANT_ID, adjustment: '-2' },
    })
    const res = makeRes()
    await postAdjustInventory(req, res, db)

    expect(updateInventory).toHaveBeenCalledTimes(1)
    expect(updateInventory).toHaveBeenCalledWith(expect.anything(), VARIANT_ID, LOC_A, -2)
  })

  it('rejects a locationId that belongs to another shop (falls back to primary)', async () => {
    const { db } = makeDb(baseState)
    const req = makeReq({
      body: { variantId: VARIANT_ID, adjustment: '1', locationId: LOC_OTHER_SHOP },
    })
    const res = makeRes()
    await postAdjustInventory(req, res, db)

    // Must NOT pass the other shop's location; must fall back to primary.
    expect(updateInventory).toHaveBeenCalledTimes(1)
    expect(updateInventory).toHaveBeenCalledWith(expect.anything(), VARIANT_ID, LOC_A, 1)
  })

  it('refuses to adjust a variant owned by another shop', async () => {
    const { db } = makeDb(baseState)
    const req = makeReq({
      body: { variantId: VARIANT_OTHER_SHOP, adjustment: '1', locationId: LOC_A },
    })
    const res = makeRes()
    await postAdjustInventory(req, res, db)

    expect(updateInventory).not.toHaveBeenCalled()
    expect(res.redirectLocation).toBe('/admin/store/test-shop/products/inventory')
  })

  it('redirects silently (no service call) when the shop has no active locations', async () => {
    const { db } = makeDb({
      ...baseState,
      locations: [
        // Only the other-shop location — this shop has none.
        {
          id: LOC_OTHER_SHOP,
          shop_id: OTHER_SHOP_ID,
          name: 'Elsewhere',
          is_primary: true,
          active: true,
          created_at: '2024-01-01T00:00:00Z',
        },
      ],
    })
    const req = makeReq({ body: { variantId: VARIANT_ID, adjustment: '1' } })
    const res = makeRes()
    await postAdjustInventory(req, res, db)

    expect(updateInventory).not.toHaveBeenCalled()
    expect(res.redirectLocation).toBe('/admin/store/test-shop/products/inventory')
  })

  it('ignores zero-delta adjustments (no-op)', async () => {
    const { db } = makeDb(baseState)
    const req = makeReq({ body: { variantId: VARIANT_ID, adjustment: '0' } })
    const res = makeRes()
    await postAdjustInventory(req, res, db)
    expect(updateInventory).not.toHaveBeenCalled()
  })
})

describe('getInventory — single-location fallback (zero UX regression)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does NOT render the location pill-bar when the shop has exactly 1 active location', async () => {
    const { db } = makeDb({
      locations: [
        {
          id: LOC_A,
          shop_id: SHOP_ID,
          name: 'Default',
          is_primary: true,
          active: true,
          created_at: '2024-01-01T00:00:00Z',
        },
      ],
      variants: [],
      inventoryLevels: [],
    })
    const req = makeReq()
    const res = makeRes()
    await getInventory(req, res, db)

    // The pill-bar element is keyed on class="inv-loc-bar" — the class
    // name also appears in the <style> block below the markup, so match on
    // the class attribute (present only when the bar renders).
    expect(res.body).not.toContain('class="inv-loc-bar"')
    // The "Manage locations" chip only appears for multi-loc shops.
    expect(res.body).not.toContain('Manage locations')
  })

  it('renders the location pill-bar when the shop has 2+ active locations', async () => {
    const { db } = makeDb({
      locations: [
        {
          id: LOC_A,
          shop_id: SHOP_ID,
          name: 'Main Warehouse',
          is_primary: true,
          active: true,
          created_at: '2024-01-01T00:00:00Z',
        },
        {
          id: LOC_B,
          shop_id: SHOP_ID,
          name: 'Store Front',
          is_primary: false,
          active: true,
          created_at: '2024-06-01T00:00:00Z',
        },
      ],
      variants: [],
      inventoryLevels: [],
    })
    const req = makeReq()
    const res = makeRes()
    await getInventory(req, res, db)

    expect(res.body).toContain('inv-loc-bar')
    expect(res.body).toContain('All locations')
    expect(res.body).toContain('Main Warehouse')
    expect(res.body).toContain('Store Front')
    expect(res.body).toContain('Manage locations')
  })
})
