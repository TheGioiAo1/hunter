/**
 * Gbox Platform — Discount Service tests (Phase 5 / PR1).
 *
 * Covers the extracted discount validation chain + once-per-customer
 * enforcement that was previously absent. We mount the service against
 * in-memory shims:
 *
 *   - `vi.mock('../cache/redis.js')` swaps Redis for a Map so the
 *     apply/remove flow round-trips without a live cache.
 *   - A `fakeDb` factory returns a minimal Kysely-shaped object that
 *     answers `discounts` + `orders` queries inline.
 *
 * What the tests pin:
 *   1. Validation chain — each failure kind fires under its own
 *      conditions and doesn't trigger the others.
 *   2. once_per_customer — both customer_id and email paths hit the
 *      `orders.discount_id` history.
 *   3. Apply/remove round-trip — the Redis-backed session mutates and
 *      re-reads cleanly, and total math is kept in sync.
 *
 * What the tests deliberately skip:
 *   - The SQL shape of the `orders` query. That's exercised by the
 *     live smoke script on server 2 — here we only care that the
 *     service asks for the right customer identity.
 *   - Totals reconciliation on tax/shipping changes. Those totals are
 *     owned by checkout/service.ts; we only verify the discount-amount
 *     column lands correctly.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---------------------------------------------------------------------------
// 1. Swap Redis for a process-local Map.
// ---------------------------------------------------------------------------

const memCache = new Map<string, unknown>()

vi.mock('../cache/redis.js', () => ({
  cacheGet: vi.fn(async (key: string) => memCache.get(key) ?? null),
  cacheSet: vi.fn(async (key: string, value: unknown) => {
    memCache.set(key, value)
  }),
  cacheDel: vi.fn(async (key: string) => {
    memCache.delete(key)
  }),
}))

// ---------------------------------------------------------------------------
// 1b. Phase 5 PR5 — stub the customer-segments rule compiler.
//
// `customerMatchesAnySegment` dynamically imports `parseRules` + `buildRuleWhere`
// to avoid a cyclic import with customer-segments/service.js. Real `parseRules`
// runs strict schema validation which would throw on the synthetic
// `{__test_segment_id: X}` shape the fake DB emits. We bypass both:
//   - `parseRules` becomes a pass-through so the synthetic shape survives.
//   - `buildRuleWhere` captures the segment id via `globalThis.__lastTestSegmentId`
//     and returns an opaque object the fake DB chain just forwards. The fake
//     `customers` branch later reads that slot to decide membership.
// ---------------------------------------------------------------------------
vi.mock('../customer-segments/service.js', () => ({
  parseRules: (raw: any) => raw,
}))

vi.mock('../customer-segments/rules.js', () => ({
  buildRuleWhere: (_eb: any, ruleset: any) => {
    ;(globalThis as any).__lastTestSegmentId = ruleset?.__test_segment_id
    return {}
  },
}))

// Import AFTER the mocks so the module wiring picks the stubs.
import {
  applyDiscount,
  removeDiscount,
  validateDiscountForCart,
  wasDiscountRedeemedByCustomer,
  resolveDiscountScope,
  eligibleSubtotal,
  findActiveAutomaticDiscounts,
  evaluateAutomaticDiscount,
  normalizeTiers,
  pickTier,
  normalizeBogoConfig,
  computeBogoDiscount,
  normalizeEligibleSegments,
  getDiscountAnalytics,
  getDiscountAnalyticsBatch,
  type DiscountRow,
  type BogoConfig,
} from './service.js'
import type { CheckoutSession } from '../checkout/service.js'

// ---------------------------------------------------------------------------
// 2. Test fixtures
// ---------------------------------------------------------------------------

function makeDiscount(overrides: Partial<DiscountRow> = {}): DiscountRow {
  return {
    id: 'disc_1',
    shop_id: 'shop_1',
    code: 'SAVE10',
    type: 'percentage',
    value: '10',
    value_type: 'percentage',
    status: 'active',
    starts_at: '2020-01-01T00:00:00Z',
    ends_at: null,
    usage_limit: null,
    once_per_customer: false,
    usage_count: 0,
    minimum_requirement_type: 'none',
    minimum_requirement_value: null,
    // Phase 5 PR2 — defaults to storewide scope.
    applies_to: 'all',
    target_selection: null,
    // Phase 5 PR3 — defaults to buyer-entered code (existing behavior).
    method: 'code',
    ...overrides,
  }
}

function makeCheckout(overrides: Partial<CheckoutSession> = {}): CheckoutSession {
  return {
    id: 'chk_1',
    shop_id: 'shop_1',
    email: 'ada@example.com',
    customer_id: null,
    line_items: [
      {
        variant_id: 'v_1',
        product_id: 'p_1',
        title: 'Widget',
        variant_title: null,
        sku: 'W-1',
        price: '100.00',
        quantity: 2,
        requires_shipping: true,
        taxable: true,
        image_url: null,
        weight: null,
        weight_unit: 'kg',
      },
    ],
    shipping_address: null,
    billing_address: null,
    shipping_rate: null,
    discount: null,
    subtotal_price: '200.00',
    total_shipping: '0.00',
    total_tax: '0.00',
    total_discounts: '0.00',
    total_price: '200.00',
    currency: 'USD',
    completed_at: null,
    order_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

/**
 * Minimal Kysely-looking stub. Each test wires the `discount` row it
 * wants returned + any `orders` rows for the once-per-customer path.
 */
interface FakeDbState {
  discount: DiscountRow | null
  priorRedemptions: Array<{
    shop_id: string
    discount_id: string
    customer_id: string | null
    email: string | null
  }>
  // Phase 5 PR2 — collection_products join: maps collection_id → product_ids.
  collectionProducts?: Record<string, string[]>
  // Phase 5 PR3 — `findActiveAutomaticDiscounts` scans the discounts
  // table with a multi-where chain that ends in `.orderBy().execute()`.
  // Tests populate this list to control what the finder returns.
  automaticDiscounts?: DiscountRow[]
  // Phase 5 PR5 — customer-segment eligibility. We don't reimplement
  // the rule compiler; instead tests declare which customer matches
  // which segments via a direct map. The fake DB bypasses the
  // `buildRuleWhere` callback and looks up the map.
  segmentMembership?: Record<string, string[]> // segment_id → customer_ids
  // Analytics: redemption fixtures. Each entry mirrors an orders row.
  orderRedemptions?: Array<{
    shop_id: string
    discount_id: string
    total_discounts: string
    created_at: string
    cancelled_at: string | null
  }>
}

function makeFakeDb(state: FakeDbState): any {
  return {
    selectFrom(table: string) {
      if (table === 'discounts') {
        // Dual-mode chain: `.executeTakeFirst()` returns the single
        // `state.discount` (code lookup); `.orderBy().execute()`
        // returns `state.automaticDiscounts` (auto finder).
        const chain: any = {
          selectAll() { return chain },
          where() { return chain },
          orderBy() { return chain },
          async executeTakeFirst() { return state.discount },
          async execute() { return state.automaticDiscounts ?? [] },
        }
        return chain
      }
      if (table === 'orders') {
        // Dual-mode chain:
        //   (a) redemption lookup — `select('id')` → `.executeTakeFirst()`
        //       returns a hit when any prior redemption exists.
        //   (b) analytics aggregate — `select(eb => [...])` with fn.countAll
        //       / fn.sum / fn.min / fn.max. Supports both single-discount
        //       `.executeTakeFirst()` and batch `.groupBy().execute()`.
        //
        // Mode is inferred from the first `.select()` call: function arg
        // → analytics, string arg → redemption.
        let mode: 'redemption' | 'analytics' = 'redemption'
        let groupByDiscount = false
        const filters: {
          shopId?: string
          discountId?: string
          discountIds?: string[]
          requireCancelledNull?: boolean
        } = {}
        const chain: any = {
          select(arg?: any) {
            if (typeof arg === 'function') {
              mode = 'analytics'
              // Exercise the callback against a dummy eb so coverage
              // captures the selector without asserting on the returned
              // shape — tests care about the aggregate result only.
              try {
                const dummyEb = {
                  fn: {
                    countAll: () => ({ as: () => ({}) }),
                    sum: () => ({ as: () => ({}) }),
                    min: () => ({ as: () => ({}) }),
                    max: () => ({ as: () => ({}) }),
                  },
                }
                arg(dummyEb)
              } catch {
                // Ignore — selector shape is exercised by the live smoke.
              }
            }
            return chain
          },
          where(col: any, op?: any, val?: any) {
            if (typeof col === 'function') {
              // OR callback for redemption lookup — we just need to know
              // the test asked at all. Filtering is handled via the
              // already-set shop_id / discount_id filters above.
              return chain
            }
            if (col === 'shop_id') filters.shopId = val
            if (col === 'discount_id') {
              if (op === 'in') filters.discountIds = val
              else filters.discountId = val
            }
            if (col === 'cancelled_at' && op === 'is' && val === null) {
              filters.requireCancelledNull = true
            }
            return chain
          },
          groupBy(col: string) {
            if (col === 'discount_id') groupByDiscount = true
            return chain
          },
          limit() { return chain },
          async executeTakeFirst() {
            if (mode === 'analytics') {
              const matches = (state.orderRedemptions ?? []).filter(
                (r) =>
                  r.shop_id === filters.shopId &&
                  r.discount_id === filters.discountId &&
                  (!filters.requireCancelledNull || r.cancelled_at === null),
              )
              if (matches.length === 0) {
                return {
                  count: 0,
                  total: null,
                  first_at: null,
                  last_at: null,
                }
              }
              const sum = matches.reduce(
                (s, r) => s + parseFloat(r.total_discounts),
                0,
              )
              const times = matches.map((r) => r.created_at).sort()
              return {
                count: matches.length,
                total: sum.toFixed(2),
                first_at: times[0],
                last_at: times[times.length - 1],
              }
            }
            // Redemption lookup — match by (shop, discount).
            const hit = state.priorRedemptions.find(
              (r) =>
                r.shop_id === filters.shopId &&
                r.discount_id === filters.discountId,
            )
            return hit ? { id: 'ord_prior' } : undefined
          },
          async execute() {
            if (mode === 'analytics' && groupByDiscount && filters.discountIds) {
              const byId = new Map<string, Array<{
                total_discounts: string
                created_at: string
                cancelled_at: string | null
              }>>()
              for (const r of state.orderRedemptions ?? []) {
                if (r.shop_id !== filters.shopId) continue
                if (!filters.discountIds.includes(r.discount_id)) continue
                if (filters.requireCancelledNull && r.cancelled_at !== null) continue
                if (!byId.has(r.discount_id)) byId.set(r.discount_id, [])
                byId.get(r.discount_id)!.push(r)
              }
              return Array.from(byId.entries()).map(([discount_id, rows]) => {
                const sum = rows.reduce(
                  (s, r) => s + parseFloat(r.total_discounts),
                  0,
                )
                const times = rows.map((r) => r.created_at).sort()
                return {
                  discount_id,
                  count: rows.length,
                  total: sum.toFixed(2),
                  first_at: times[0],
                  last_at: times[times.length - 1],
                }
              })
            }
            return []
          },
        }
        return chain
      }
      if (table === 'customer_segments') {
        // customerMatchesAnySegment fetches id + rules_json for
        // in-list segments. We stamp the segment id into rules_json
        // as `__test_segment_id` so the mocked `parseRules` +
        // `buildRuleWhere` can route the subsequent customers lookup
        // without running real rule validation.
        let requestedIds: string[] = []
        const chain: any = {
          select() { return chain },
          where(col: any, op: any, val: any) {
            if (col === 'id' && op === 'in') {
              requestedIds = Array.isArray(val) ? val : []
            }
            return chain
          },
          async execute() {
            return requestedIds.map((id) => ({
              id,
              rules_json: { __test_segment_id: id },
            }))
          },
        }
        return chain
      }
      if (table === 'customers') {
        // Used by customerMatchesAnySegment AFTER fetching segments.
        // The mocked buildRuleWhere writes the segment id into a
        // captured slot (via `__lastTestSegmentId`) which we read
        // here to decide whether the customer is a member.
        let scopedCustomerId = ''
        const chain: any = {
          select() { return chain },
          where(col: any, _op?: any, val?: any) {
            if (col === 'id') scopedCustomerId = val
            if (typeof col === 'function') {
              // Invoke to trigger the mocked buildRuleWhere capture.
              try {
                col({} as any)
              } catch {}
            }
            return chain
          },
          async executeTakeFirst() {
            const segId = (globalThis as any).__lastTestSegmentId as
              | string
              | undefined
            if (!segId) return undefined
            const members = state.segmentMembership?.[segId] ?? []
            return members.includes(scopedCustomerId)
              ? { id: scopedCustomerId }
              : undefined
          },
        }
        return chain
      }
      if (table === 'collection_products') {
        // Simple single-query join: resolveDiscountScope does
        //   selectFrom('collection_products').select('product_id').where('collection_id', 'in', [...]).execute()
        let requestedCollections: string[] = []
        const chain: any = {
          select() { return chain },
          where(col: any, op: any, val: any) {
            if (col === 'collection_id' && op === 'in') {
              requestedCollections = Array.isArray(val) ? val : []
            }
            return chain
          },
          async execute() {
            const map = state.collectionProducts ?? {}
            const rows: Array<{ product_id: string }> = []
            for (const c of requestedCollections) {
              for (const p of map[c] ?? []) rows.push({ product_id: p })
            }
            return rows
          },
        }
        return chain
      }
      throw new Error(`Unexpected table in test: ${table}`)
    },
  }
}

// ---------------------------------------------------------------------------
// 3. validateDiscountForCart
// ---------------------------------------------------------------------------

describe('validateDiscountForCart', () => {
  beforeEach(() => {
    memCache.clear()
  })

  it('accepts an active, in-window, unlimited discount', async () => {
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const result = await validateDiscountForCart(db, makeDiscount(), {
      subtotal: '100.00',
      itemCount: 1,
    })
    expect(result.ok).toBe(true)
  })

  it('rejects force-expired discount (status="expired")', async () => {
    // Phase 5 PR3 — admins can force-expire a live discount even before
    // ends_at. The validator honours an explicit 'expired' status.
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const result = await validateDiscountForCart(
      db,
      makeDiscount({ status: 'expired' }),
      { subtotal: '100.00', itemCount: 1 },
    )
    expect(result).toEqual({
      ok: false,
      kind: 'inactive',
      message: 'This discount code is not active.',
    })
  })

  it('accepts status="scheduled" when starts_at has already passed (stale cron)', async () => {
    // Phase 5 PR3 — a scheduled discount whose start time has passed
    // but whose stored status hasn't been flipped yet is honoured. The
    // runtime computes effective state from (starts_at, ends_at) so a
    // missed cron job can never reject a valid-in-window discount.
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const result = await validateDiscountForCart(
      db,
      makeDiscount({ status: 'scheduled', starts_at: '2020-01-01T00:00:00Z' }),
      { subtotal: '100.00', itemCount: 1 },
    )
    expect(result.ok).toBe(true)
  })

  it('rejects discount whose starts_at is in the future', async () => {
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const future = new Date(Date.now() + 86400_000).toISOString()
    const result = await validateDiscountForCart(
      db,
      makeDiscount({ starts_at: future }),
      { subtotal: '100.00', itemCount: 1 },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('not_started')
  })

  it('rejects expired discount', async () => {
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const past = new Date(Date.now() - 86400_000).toISOString()
    const result = await validateDiscountForCart(
      db,
      makeDiscount({ ends_at: past }),
      { subtotal: '100.00', itemCount: 1 },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('expired')
  })

  it('rejects when usage_limit reached', async () => {
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const result = await validateDiscountForCart(
      db,
      makeDiscount({ usage_limit: 5, usage_count: 5 }),
      { subtotal: '100.00', itemCount: 1 },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('usage_cap_reached')
  })

  it('allows usage one below cap', async () => {
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const result = await validateDiscountForCart(
      db,
      makeDiscount({ usage_limit: 5, usage_count: 4 }),
      { subtotal: '100.00', itemCount: 1 },
    )
    expect(result.ok).toBe(true)
  })

  it('rejects when minimum purchase not met', async () => {
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const result = await validateDiscountForCart(
      db,
      makeDiscount({
        minimum_requirement_type: 'purchase_amount',
        minimum_requirement_value: '50.00',
      }),
      { subtotal: '20.00', itemCount: 1 },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('min_purchase_not_met')
  })

  it('rejects when minimum item count not met', async () => {
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const result = await validateDiscountForCart(
      db,
      makeDiscount({
        minimum_requirement_type: 'item_count',
        minimum_requirement_value: '3',
      }),
      { subtotal: '500.00', itemCount: 1 },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('min_items_not_met')
  })

  it('rejects once_per_customer when a prior redemption exists by customer_id', async () => {
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [
        {
          shop_id: 'shop_1',
          discount_id: 'disc_1',
          customer_id: 'cust_1',
          email: null,
        },
      ],
    })
    const result = await validateDiscountForCart(
      db,
      makeDiscount({ once_per_customer: true }),
      { subtotal: '100.00', itemCount: 1, customerId: 'cust_1' },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('once_per_customer_reached')
  })

  it('rejects once_per_customer when a prior redemption exists by email', async () => {
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [
        {
          shop_id: 'shop_1',
          discount_id: 'disc_1',
          customer_id: null,
          email: 'ada@example.com',
        },
      ],
    })
    const result = await validateDiscountForCart(
      db,
      makeDiscount({ once_per_customer: true }),
      { subtotal: '100.00', itemCount: 1, email: 'ada@example.com' },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('once_per_customer_reached')
  })

  it('accepts once_per_customer when no prior redemption', async () => {
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const result = await validateDiscountForCart(
      db,
      makeDiscount({ once_per_customer: true }),
      { subtotal: '100.00', itemCount: 1, customerId: 'cust_1' },
    )
    expect(result.ok).toBe(true)
  })

  it('accepts once_per_customer for a fully anonymous cart (no id, no email)', async () => {
    // v1 policy: we can't pin a redemption to nobody, so let them
    // apply. Usage_limit is the fallback guard.
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [
        {
          shop_id: 'shop_1',
          discount_id: 'disc_1',
          customer_id: 'cust_x',
          email: null,
        },
      ],
    })
    const result = await validateDiscountForCart(
      db,
      makeDiscount({ once_per_customer: true }),
      { subtotal: '100.00', itemCount: 1 },
    )
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. wasDiscountRedeemedByCustomer — direct path
// ---------------------------------------------------------------------------

describe('wasDiscountRedeemedByCustomer', () => {
  it('returns false for an anonymous buyer', async () => {
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [
        {
          shop_id: 'shop_1',
          discount_id: 'disc_1',
          customer_id: 'cust_1',
          email: null,
        },
      ],
    })
    const hit = await wasDiscountRedeemedByCustomer(db, 'shop_1', 'disc_1', {
      customerId: null,
      email: null,
    })
    expect(hit).toBe(false)
  })

  it('returns true when a prior order matches (fake db ignores OR but asserts lookup ran)', async () => {
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [
        {
          shop_id: 'shop_1',
          discount_id: 'disc_1',
          customer_id: 'cust_1',
          email: null,
        },
      ],
    })
    const hit = await wasDiscountRedeemedByCustomer(db, 'shop_1', 'disc_1', {
      customerId: 'cust_1',
      email: null,
    })
    expect(hit).toBe(true)
  })

  it('returns false when no prior order for that (shop, discount) pair', async () => {
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const hit = await wasDiscountRedeemedByCustomer(db, 'shop_1', 'disc_1', {
      customerId: 'cust_1',
      email: 'ada@example.com',
    })
    expect(hit).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. applyDiscount / removeDiscount — Redis round-trip
// ---------------------------------------------------------------------------

describe('applyDiscount', () => {
  beforeEach(() => {
    memCache.clear()
  })

  it('throws when the checkout is not in Redis', async () => {
    const db = makeFakeDb({ discount: makeDiscount(), priorRedemptions: [] })
    await expect(applyDiscount(db, 'chk_missing', 'SAVE10')).rejects.toThrow(
      /Checkout not found/,
    )
  })

  it('throws when the discount code does not match any row', async () => {
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const ck = makeCheckout()
    memCache.set(`checkout:${ck.id}`, ck)
    await expect(applyDiscount(db, ck.id, 'NOPE')).rejects.toThrow(
      /Discount code not found/,
    )
  })

  it('throws when code is empty', async () => {
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const ck = makeCheckout()
    memCache.set(`checkout:${ck.id}`, ck)
    await expect(applyDiscount(db, ck.id, '   ')).rejects.toThrow(
      /Discount code is required/,
    )
  })

  it('persists the applied discount and recalculates totals', async () => {
    const db = makeFakeDb({
      discount: makeDiscount({ value: '10', value_type: 'percentage' }),
      priorRedemptions: [],
    })
    const ck = makeCheckout()
    memCache.set(`checkout:${ck.id}`, ck)

    const updated = await applyDiscount(db, ck.id, 'SAVE10')

    expect(updated.discount).toMatchObject({
      code: 'SAVE10',
      discount_id: 'disc_1',
      value: '10',
      value_type: 'percentage',
    })
    // 10% off 200 = 20
    expect(updated.total_discounts).toBe('20.00')
    expect(updated.total_price).toBe('180.00')

    // Verify persistence: pull from mem cache directly.
    const stored = memCache.get(`checkout:${ck.id}`) as CheckoutSession
    expect(stored.discount?.code).toBe('SAVE10')
  })

  it('refuses to apply on a completed checkout', async () => {
    const db = makeFakeDb({ discount: makeDiscount(), priorRedemptions: [] })
    const ck = makeCheckout({ completed_at: new Date().toISOString() })
    memCache.set(`checkout:${ck.id}`, ck)
    await expect(applyDiscount(db, ck.id, 'SAVE10')).rejects.toThrow(
      /already completed/,
    )
  })

  it('applies fixed-amount discount with clamping at subtotal', async () => {
    const db = makeFakeDb({
      discount: makeDiscount({ value: '500', value_type: 'fixed' }),
      priorRedemptions: [],
    })
    const ck = makeCheckout() // subtotal 200
    memCache.set(`checkout:${ck.id}`, ck)

    const updated = await applyDiscount(db, ck.id, 'SAVE10')
    // 500 clamps down to 200 (can't discount more than the subtotal)
    expect(updated.total_discounts).toBe('200.00')
    expect(updated.total_price).toBe('0.00')
  })

  it('bubbles up once_per_customer rejection as a buyer-safe error', async () => {
    const db = makeFakeDb({
      discount: makeDiscount({ once_per_customer: true }),
      priorRedemptions: [
        {
          shop_id: 'shop_1',
          discount_id: 'disc_1',
          customer_id: 'cust_1',
          email: null,
        },
      ],
    })
    const ck = makeCheckout({ customer_id: 'cust_1' })
    memCache.set(`checkout:${ck.id}`, ck)
    await expect(applyDiscount(db, ck.id, 'SAVE10')).rejects.toThrow(
      /once per customer/,
    )
  })
})

describe('removeDiscount', () => {
  beforeEach(() => {
    memCache.clear()
  })

  it('clears the discount and zeroes total_discounts', async () => {
    const ck = makeCheckout({
      discount: {
        code: 'SAVE10',
        discount_id: 'disc_1',
        type: 'percentage',
        value: '10',
        value_type: 'percentage',
        amount: '20.00',
      },
      total_discounts: '20.00',
      total_price: '180.00',
    })
    memCache.set(`checkout:${ck.id}`, ck)
    const updated = await removeDiscount(ck.id)
    expect(updated.discount).toBeNull()
    expect(updated.total_discounts).toBe('0.00')
    expect(updated.total_price).toBe('200.00')
  })

  it('throws when checkout not found', async () => {
    await expect(removeDiscount('chk_missing')).rejects.toThrow(
      /Checkout not found/,
    )
  })

  it('throws when checkout already completed', async () => {
    const ck = makeCheckout({ completed_at: new Date().toISOString() })
    memCache.set(`checkout:${ck.id}`, ck)
    await expect(removeDiscount(ck.id)).rejects.toThrow(/already completed/)
  })
})

// ---------------------------------------------------------------------------
// Phase 5 PR2 — product / collection scope tests
// ---------------------------------------------------------------------------

describe('resolveDiscountScope', () => {
  it('returns {kind: all} for applies_to=all', async () => {
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const scope = await resolveDiscountScope(db, {
      applies_to: 'all',
      target_selection: null,
    })
    expect(scope).toEqual({ kind: 'all' })
  })

  it('resolves specific_products directly from target_selection array', async () => {
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const scope = await resolveDiscountScope(db, {
      applies_to: 'specific_products',
      target_selection: ['p_a', 'p_b'],
    })
    expect(scope.kind).toBe('products')
    if (scope.kind === 'products') {
      expect(Array.from(scope.ids).sort()).toEqual(['p_a', 'p_b'])
    }
  })

  it('resolves specific_collections by expanding via collection_products', async () => {
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [],
      collectionProducts: {
        col_sale: ['p_1', 'p_2'],
        col_new: ['p_3'],
      },
    })
    const scope = await resolveDiscountScope(db, {
      applies_to: 'specific_collections',
      target_selection: ['col_sale', 'col_new'],
    })
    expect(scope.kind).toBe('products')
    if (scope.kind === 'products') {
      expect(Array.from(scope.ids).sort()).toEqual(['p_1', 'p_2', 'p_3'])
    }
  })

  it('returns an empty product set for collections with no member products', async () => {
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [],
      collectionProducts: {},
    })
    const scope = await resolveDiscountScope(db, {
      applies_to: 'specific_collections',
      target_selection: ['col_empty'],
    })
    expect(scope.kind).toBe('products')
    if (scope.kind === 'products') {
      expect(scope.ids.size).toBe(0)
    }
  })

  it('normalises object-shaped target_selection ({ids: [...]}) defensively', async () => {
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const scope = await resolveDiscountScope(db, {
      applies_to: 'specific_products',
      target_selection: { ids: ['p_x', 'p_y'] },
    })
    expect(scope.kind).toBe('products')
    if (scope.kind === 'products') {
      expect(Array.from(scope.ids).sort()).toEqual(['p_x', 'p_y'])
    }
  })

  it('falls back to {kind: all} for unknown applies_to strings (schema drift safety)', async () => {
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const scope = await resolveDiscountScope(db, {
      applies_to: 'specific_customers', // not a real value
      target_selection: null,
    })
    expect(scope).toEqual({ kind: 'all' })
  })

  it('parses jsonb returned as raw JSON text by pg (no auto-parse)', async () => {
    // Some pg type parser configurations hand back jsonb as strings.
    // The normaliser must JSON.parse before splitting on commas.
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const scope = await resolveDiscountScope(db, {
      applies_to: 'specific_products',
      target_selection: '["p_a","p_b"]' as unknown,
    })
    expect(scope.kind).toBe('products')
    if (scope.kind === 'products') {
      expect(Array.from(scope.ids).sort()).toEqual(['p_a', 'p_b'])
    }
  })
})

describe('eligibleSubtotal', () => {
  const items = [
    { product_id: 'p_1', price: '100.00', quantity: 2 }, // 200
    { product_id: 'p_2', price: '50.00', quantity: 1 },  // 50
    { product_id: 'p_3', price: '25.00', quantity: 4 },  // 100
  ]

  it('sums every line for scope=all', () => {
    expect(eligibleSubtotal({ kind: 'all' }, items)).toBe(350)
  })

  it('sums only matching lines for product scope', () => {
    const scope = { kind: 'products' as const, ids: new Set(['p_1', 'p_3']) }
    expect(eligibleSubtotal(scope, items)).toBe(300)
  })

  it('returns 0 when nothing matches', () => {
    const scope = { kind: 'products' as const, ids: new Set(['p_none']) }
    expect(eligibleSubtotal(scope, items)).toBe(0)
  })
})

describe('validateDiscountForCart with scope', () => {
  const cartItems = [
    { product_id: 'p_1', price: '100.00', quantity: 2 }, // 200
    { product_id: 'p_2', price: '50.00', quantity: 1 },  //  50
  ]

  it('passes product scope when at least one line matches', async () => {
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const result = await validateDiscountForCart(
      db,
      makeDiscount({
        applies_to: 'specific_products',
        target_selection: ['p_1'],
      }),
      { subtotal: '250.00', itemCount: 3, lineItems: cartItems },
    )
    expect(result.ok).toBe(true)
  })

  it('rejects with no_eligible_items when product scope matches nothing', async () => {
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const result = await validateDiscountForCart(
      db,
      makeDiscount({
        applies_to: 'specific_products',
        target_selection: ['p_nothing'],
      }),
      { subtotal: '250.00', itemCount: 3, lineItems: cartItems },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('no_eligible_items')
  })

  it('passes collection scope when products resolve to at least one cart line', async () => {
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [],
      collectionProducts: { col_sale: ['p_1', 'p_other'] },
    })
    const result = await validateDiscountForCart(
      db,
      makeDiscount({
        applies_to: 'specific_collections',
        target_selection: ['col_sale'],
      }),
      { subtotal: '250.00', itemCount: 3, lineItems: cartItems },
    )
    expect(result.ok).toBe(true)
  })

  it('rejects with no_eligible_items when collection expands to non-matching products', async () => {
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [],
      collectionProducts: { col_sale: ['p_other_1', 'p_other_2'] },
    })
    const result = await validateDiscountForCart(
      db,
      makeDiscount({
        applies_to: 'specific_collections',
        target_selection: ['col_sale'],
      }),
      { subtotal: '250.00', itemCount: 3, lineItems: cartItems },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('no_eligible_items')
  })

  it('skips scope check (back-compat) when lineItems omitted', async () => {
    // Pre-PR2 callers that never pass lineItems should still work even
    // for scoped discounts — the scope check degrades to permissive.
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const result = await validateDiscountForCart(
      db,
      makeDiscount({
        applies_to: 'specific_products',
        target_selection: ['p_any'],
      }),
      { subtotal: '250.00', itemCount: 3 /* no lineItems */ },
    )
    expect(result.ok).toBe(true)
  })
})

describe('applyDiscount with scope', () => {
  beforeEach(() => {
    memCache.clear()
  })

  it('stamps eligible_product_ids onto checkout.discount when scoped', async () => {
    const db = makeFakeDb({
      discount: makeDiscount({
        value: '10',
        value_type: 'percentage',
        applies_to: 'specific_products',
        target_selection: ['p_1'],
      }),
      priorRedemptions: [],
    })
    const ck = makeCheckout()
    memCache.set(`checkout:${ck.id}`, ck)

    const updated = await applyDiscount(db, ck.id, 'SAVE10')

    expect(updated.discount?.eligible_product_ids).toEqual(['p_1'])
  })

  it('stamps eligible_product_ids=null for storewide discounts', async () => {
    const db = makeFakeDb({
      discount: makeDiscount({ value: '10', value_type: 'percentage' }),
      priorRedemptions: [],
    })
    const ck = makeCheckout()
    memCache.set(`checkout:${ck.id}`, ck)

    const updated = await applyDiscount(db, ck.id, 'SAVE10')

    expect(updated.discount?.eligible_product_ids).toBeNull()
  })

  it('computes percentage discount on eligible subtotal only', async () => {
    // Cart: p_1 ×2 @100 = 200; p_2 ×1 @50 = 50; total subtotal 250
    // Scope: only p_1 → eligible subtotal 200
    // 10% of 200 = 20.00 (NOT 25.00 which would be 10% of full cart)
    const db = makeFakeDb({
      discount: makeDiscount({
        value: '10',
        value_type: 'percentage',
        applies_to: 'specific_products',
        target_selection: ['p_1'],
      }),
      priorRedemptions: [],
    })
    const ck = makeCheckout({
      line_items: [
        {
          variant_id: 'v_1', product_id: 'p_1', title: 'Widget A',
          variant_title: null, sku: 'A-1', price: '100.00', quantity: 2,
          requires_shipping: true, taxable: true, image_url: null,
          weight: null, weight_unit: 'kg',
        },
        {
          variant_id: 'v_2', product_id: 'p_2', title: 'Widget B',
          variant_title: null, sku: 'B-1', price: '50.00', quantity: 1,
          requires_shipping: true, taxable: true, image_url: null,
          weight: null, weight_unit: 'kg',
        },
      ],
      subtotal_price: '250.00',
      total_price: '250.00',
    })
    memCache.set(`checkout:${ck.id}`, ck)

    const updated = await applyDiscount(db, ck.id, 'SAVE10')
    expect(updated.total_discounts).toBe('20.00')
    expect(updated.total_price).toBe('230.00') // 250 - 20
  })

  it('clamps fixed_amount discount to eligible subtotal, not full cart', async () => {
    // Scope: only p_2 → eligible subtotal 50
    // Fixed discount 999 → clamped to 50 (NOT 250, which would be full cart)
    const db = makeFakeDb({
      discount: makeDiscount({
        value: '999',
        value_type: 'fixed',
        applies_to: 'specific_products',
        target_selection: ['p_2'],
      }),
      priorRedemptions: [],
    })
    const ck = makeCheckout({
      line_items: [
        {
          variant_id: 'v_1', product_id: 'p_1', title: 'Widget A',
          variant_title: null, sku: 'A-1', price: '100.00', quantity: 2,
          requires_shipping: true, taxable: true, image_url: null,
          weight: null, weight_unit: 'kg',
        },
        {
          variant_id: 'v_2', product_id: 'p_2', title: 'Widget B',
          variant_title: null, sku: 'B-1', price: '50.00', quantity: 1,
          requires_shipping: true, taxable: true, image_url: null,
          weight: null, weight_unit: 'kg',
        },
      ],
      subtotal_price: '250.00',
      total_price: '250.00',
    })
    memCache.set(`checkout:${ck.id}`, ck)

    const updated = await applyDiscount(db, ck.id, 'SAVE10')
    expect(updated.total_discounts).toBe('50.00')
    expect(updated.total_price).toBe('200.00') // 250 - 50
  })

  it('rejects with no_eligible_items when scope matches zero cart lines', async () => {
    const db = makeFakeDb({
      discount: makeDiscount({
        value: '10',
        value_type: 'percentage',
        applies_to: 'specific_products',
        target_selection: ['p_no_match'],
      }),
      priorRedemptions: [],
    })
    const ck = makeCheckout()
    memCache.set(`checkout:${ck.id}`, ck)

    await expect(applyDiscount(db, ck.id, 'SAVE10')).rejects.toThrow(
      /No items in your cart qualify/,
    )
  })

  it('rejects automatic-method discounts at the code-entry path', async () => {
    // Phase 5 PR3 — a merchant can stamp both a `code` and method='automatic'
    // so the same discount auto-applies but also shows up in drafts. The
    // buyer-entered apply path must refuse it or we'd double-apply once
    // the automatic evaluator runs on the next cart change.
    const db = makeFakeDb({
      discount: makeDiscount({ method: 'automatic', code: 'AUTOCODE' }),
      priorRedemptions: [],
    })
    const ck = makeCheckout()
    memCache.set(`checkout:${ck.id}`, ck)
    await expect(applyDiscount(db, ck.id, 'AUTOCODE')).rejects.toThrow(
      /applied automatically/,
    )
  })
})

// ---------------------------------------------------------------------------
// 6. Phase 5 PR3 — automatic (codeless) discounts
// ---------------------------------------------------------------------------

describe('findActiveAutomaticDiscounts', () => {
  it('returns [] when no automatic discounts exist', async () => {
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [],
      automaticDiscounts: [],
    })
    const rows = await findActiveAutomaticDiscounts(db, 'shop_1')
    expect(rows).toEqual([])
  })

  it('returns the automatic rows the fake DB is seeded with', async () => {
    const auto = makeDiscount({
      id: 'disc_auto',
      code: null,
      method: 'automatic',
    })
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [],
      automaticDiscounts: [auto],
    })
    const rows = await findActiveAutomaticDiscounts(db, 'shop_1')
    expect(rows).toHaveLength(1)
    expect(rows[0].method).toBe('automatic')
  })
})

describe('evaluateAutomaticDiscount', () => {
  beforeEach(() => {
    memCache.clear()
  })

  it('no-ops on a checkout that has a code-based discount applied', async () => {
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [],
      automaticDiscounts: [
        makeDiscount({ id: 'auto_1', code: null, method: 'automatic' }),
      ],
    })
    const ck = makeCheckout({
      discount: {
        code: 'SAVE10',
        discount_id: 'disc_code',
        type: 'percentage',
        value: '10',
        value_type: 'percentage',
        amount: '20.00',
        eligible_product_ids: null,
        is_automatic: false,
      },
    })
    memCache.set(`checkout:${ck.id}`, ck)

    const updated = await evaluateAutomaticDiscount(db, ck.id)
    // Code-based discount must survive untouched.
    expect(updated.discount?.code).toBe('SAVE10')
    expect(updated.discount?.is_automatic).toBe(false)
  })

  it('applies the single matching automatic when none was applied before', async () => {
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [],
      automaticDiscounts: [
        makeDiscount({
          id: 'auto_1',
          code: null,
          method: 'automatic',
          value: '15',
          value_type: 'percentage',
        }),
      ],
    })
    const ck = makeCheckout({ discount: null })
    memCache.set(`checkout:${ck.id}`, ck)

    const updated = await evaluateAutomaticDiscount(db, ck.id)
    expect(updated.discount?.is_automatic).toBe(true)
    expect(updated.discount?.discount_id).toBe('auto_1')
    // 15% of 200 = 30
    expect(updated.total_discounts).toBe('30.00')
  })

  it('picks the automatic with the highest absolute amount on this cart', async () => {
    // Auto A: 10% off = 20
    // Auto B: 15% off = 30 ← winner
    // Auto C: $5 flat = 5
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [],
      automaticDiscounts: [
        makeDiscount({ id: 'auto_a', code: null, method: 'automatic', value: '10' }),
        makeDiscount({ id: 'auto_b', code: null, method: 'automatic', value: '15' }),
        makeDiscount({
          id: 'auto_c',
          code: null,
          method: 'automatic',
          value: '5',
          value_type: 'fixed',
          type: 'fixed_amount',
        }),
      ],
    })
    const ck = makeCheckout({ discount: null })
    memCache.set(`checkout:${ck.id}`, ck)

    const updated = await evaluateAutomaticDiscount(db, ck.id)
    expect(updated.discount?.discount_id).toBe('auto_b')
    expect(updated.total_discounts).toBe('30.00')
  })

  it('clears a stale automatic when the cart no longer qualifies', async () => {
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [],
      // No automatics eligible — cart subtotal is 200 but minimum is 500.
      automaticDiscounts: [
        makeDiscount({
          id: 'auto_a',
          code: null,
          method: 'automatic',
          minimum_requirement_type: 'purchase_amount',
          minimum_requirement_value: '500',
        }),
      ],
    })
    const ck = makeCheckout({
      discount: {
        code: null,
        discount_id: 'auto_a',
        type: 'percentage',
        value: '10',
        value_type: 'percentage',
        amount: '20.00',
        eligible_product_ids: null,
        is_automatic: true,
      },
    })
    memCache.set(`checkout:${ck.id}`, ck)

    const updated = await evaluateAutomaticDiscount(db, ck.id)
    expect(updated.discount).toBeNull()
    expect(updated.total_discounts).toBe('0.00')
  })

  it('does not apply any automatic when all candidates yield amount 0', async () => {
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [],
      automaticDiscounts: [
        makeDiscount({
          id: 'auto_a',
          code: null,
          method: 'automatic',
          value: '0',
        }),
      ],
    })
    const ck = makeCheckout({ discount: null })
    memCache.set(`checkout:${ck.id}`, ck)

    const updated = await evaluateAutomaticDiscount(db, ck.id)
    expect(updated.discount).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 7. Phase 5 PR4 — tiered percentage
// ---------------------------------------------------------------------------

describe('normalizeTiers', () => {
  it('returns [] for null / undefined / empty array', () => {
    expect(normalizeTiers(null)).toEqual([])
    expect(normalizeTiers(undefined)).toEqual([])
    expect(normalizeTiers([])).toEqual([])
  })

  it('sorts tiers ASC by threshold', () => {
    const out = normalizeTiers([
      { threshold: 300, percentage: 20 },
      { threshold: 100, percentage: 10 },
      { threshold: 200, percentage: 15 },
    ])
    expect(out).toEqual([
      { threshold: 100, percentage: 10 },
      { threshold: 200, percentage: 15 },
      { threshold: 300, percentage: 20 },
    ])
  })

  it('drops malformed tiers (negative / NaN / out-of-range percentage)', () => {
    const out = normalizeTiers([
      { threshold: -5, percentage: 10 },
      { threshold: 100, percentage: -1 },
      { threshold: 200, percentage: 150 },
      { threshold: 100, percentage: 10 }, // the only valid one
      { threshold: NaN, percentage: 5 },
    ])
    expect(out).toEqual([{ threshold: 100, percentage: 10 }])
  })

  it('parses jsonb returned as raw JSON text', () => {
    const out = normalizeTiers('[{"threshold":100,"percentage":10}]')
    expect(out).toEqual([{ threshold: 100, percentage: 10 }])
  })

  it('accepts wrapper object shape { tiers: [...] }', () => {
    const out = normalizeTiers({
      tiers: [{ threshold: 50, percentage: 5 }],
    })
    expect(out).toEqual([{ threshold: 50, percentage: 5 }])
  })
})

describe('pickTier', () => {
  const tiers = [
    { threshold: 100, percentage: 10 },
    { threshold: 200, percentage: 15 },
    { threshold: 300, percentage: 20 },
  ]

  it('returns null when subtotal is below the lowest threshold', () => {
    expect(pickTier(tiers, 50)).toBeNull()
  })

  it('returns the only tier that matches when subtotal is between tiers', () => {
    expect(pickTier(tiers, 150)).toEqual({ threshold: 100, percentage: 10 })
  })

  it('returns the highest qualifying tier when subtotal exceeds multiple', () => {
    expect(pickTier(tiers, 350)).toEqual({ threshold: 300, percentage: 20 })
  })

  it('returns the tier when subtotal exactly equals its threshold', () => {
    expect(pickTier(tiers, 200)).toEqual({ threshold: 200, percentage: 15 })
  })

  it('returns null for empty tier list', () => {
    expect(pickTier([], 500)).toBeNull()
  })
})

describe('applyDiscount with tiers', () => {
  beforeEach(() => {
    memCache.clear()
  })

  it('applies the qualifying tier instead of the flat value', async () => {
    // Flat value would be 10% of 200 = 20.
    // Tiers: 100→10%, 200→15%. Cart subtotal=200 → 15% tier → 30.
    const db = makeFakeDb({
      discount: makeDiscount({
        value: '10',
        value_type: 'percentage',
        tiers: [
          { threshold: 100, percentage: 10 },
          { threshold: 200, percentage: 15 },
        ],
      }),
      priorRedemptions: [],
    })
    const ck = makeCheckout()
    memCache.set(`checkout:${ck.id}`, ck)

    const updated = await applyDiscount(db, ck.id, 'SAVE10')
    expect(updated.total_discounts).toBe('30.00')
  })

  it('gives zero discount when cart subtotal is below the lowest tier', async () => {
    // Cart=200 but tiers start at 500.
    const db = makeFakeDb({
      discount: makeDiscount({
        value: '50', // flat value must NOT be used
        value_type: 'percentage',
        tiers: [{ threshold: 500, percentage: 20 }],
      }),
      priorRedemptions: [],
    })
    const ck = makeCheckout()
    memCache.set(`checkout:${ck.id}`, ck)

    const updated = await applyDiscount(db, ck.id, 'SAVE10')
    expect(updated.total_discounts).toBe('0.00')
  })

  it('stamps the parsed tiers onto the checkout session', async () => {
    const db = makeFakeDb({
      discount: makeDiscount({
        value_type: 'percentage',
        tiers: [{ threshold: 50, percentage: 5 }],
      }),
      priorRedemptions: [],
    })
    const ck = makeCheckout()
    memCache.set(`checkout:${ck.id}`, ck)

    const updated = await applyDiscount(db, ck.id, 'SAVE10')
    expect(updated.discount?.tiers).toEqual([{ threshold: 50, percentage: 5 }])
  })
})

describe('evaluateAutomaticDiscount with tiers', () => {
  beforeEach(() => {
    memCache.clear()
  })

  it('picks the automatic whose tier gives the biggest amount on this cart', async () => {
    // Cart=200.
    // Auto A: flat 10% → 20.
    // Auto B: tiers[{200,20}] → 40.  ← winner
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [],
      automaticDiscounts: [
        makeDiscount({
          id: 'auto_a',
          code: null,
          method: 'automatic',
          value: '10',
        }),
        makeDiscount({
          id: 'auto_b',
          code: null,
          method: 'automatic',
          value: '5', // flat value is ignored when tiers is set
          tiers: [{ threshold: 200, percentage: 20 }],
        }),
      ],
    })
    const ck = makeCheckout({ discount: null })
    memCache.set(`checkout:${ck.id}`, ck)

    const updated = await evaluateAutomaticDiscount(db, ck.id)
    expect(updated.discount?.discount_id).toBe('auto_b')
    expect(updated.total_discounts).toBe('40.00')
    expect(updated.discount?.tiers).toEqual([{ threshold: 200, percentage: 20 }])
  })
})

// ---------------------------------------------------------------------------
// 8. Phase 5 PR5 — BOGO + customer-segment eligibility + analytics
// ---------------------------------------------------------------------------

describe('normalizeBogoConfig', () => {
  it('accepts a well-formed object', () => {
    expect(
      normalizeBogoConfig({
        buy_quantity: 2,
        get_quantity: 1,
        get_discount_percentage: 100,
      }),
    ).toEqual({
      buy_quantity: 2,
      get_quantity: 1,
      get_discount_percentage: 100,
    })
  })

  it('parses jsonb returned as raw JSON text', () => {
    expect(
      normalizeBogoConfig(
        '{"buy_quantity":1,"get_quantity":1,"get_discount_percentage":50}',
      ),
    ).toEqual({ buy_quantity: 1, get_quantity: 1, get_discount_percentage: 50 })
  })

  it('rejects non-integer or zero quantities', () => {
    expect(
      normalizeBogoConfig({
        buy_quantity: 0,
        get_quantity: 1,
        get_discount_percentage: 100,
      }),
    ).toBeNull()
    expect(
      normalizeBogoConfig({
        buy_quantity: 1.5,
        get_quantity: 1,
        get_discount_percentage: 100,
      }),
    ).toBeNull()
    expect(
      normalizeBogoConfig({
        buy_quantity: 2,
        get_quantity: -1,
        get_discount_percentage: 100,
      }),
    ).toBeNull()
  })

  it('rejects out-of-range percentages', () => {
    expect(
      normalizeBogoConfig({
        buy_quantity: 1,
        get_quantity: 1,
        get_discount_percentage: 101,
      }),
    ).toBeNull()
    expect(
      normalizeBogoConfig({
        buy_quantity: 1,
        get_quantity: 1,
        get_discount_percentage: -1,
      }),
    ).toBeNull()
  })

  it('returns null for null / undefined / malformed string', () => {
    expect(normalizeBogoConfig(null)).toBeNull()
    expect(normalizeBogoConfig(undefined)).toBeNull()
    expect(normalizeBogoConfig('not-json')).toBeNull()
    expect(normalizeBogoConfig('{invalid')).toBeNull()
  })
})

describe('computeBogoDiscount', () => {
  const cfg: BogoConfig = {
    buy_quantity: 2,
    get_quantity: 1,
    get_discount_percentage: 100, // free
  }

  it('returns 0 when eligible units are fewer than one cycle', () => {
    // cycleSize = 3, but only 2 units → no complete cycle.
    const out = computeBogoDiscount(cfg, [
      { product_id: 'p_1', price: '50.00', quantity: 2 },
    ])
    expect(out).toBe(0)
  })

  it('applies one cycle when cart has exactly cycleSize units', () => {
    // 3 units @ $50 = 150 total; discount the cheapest 1 at 100% → 50.
    const out = computeBogoDiscount(cfg, [
      { product_id: 'p_1', price: '50.00', quantity: 3 },
    ])
    expect(out).toBe(50)
  })

  it('discounts the CHEAPEST unit first across mixed-price lines', () => {
    // Units: [10, 10, 10, 100, 100, 100] (sorted: [10,10,10,100,100,100])
    // cycleSize=3, 2 cycles. Cycle 0 discounts cheapest idx [0] = 10.
    // Cycle 1 discounts idx [1] = 10. Total free value = 20, not 200.
    const out = computeBogoDiscount(cfg, [
      { product_id: 'p_cheap', price: '10.00', quantity: 3 },
      { product_id: 'p_lux', price: '100.00', quantity: 3 },
    ])
    expect(out).toBe(20)
  })

  it('applies multiple cycles when cart has enough units', () => {
    // 9 units @ $30 → 3 cycles × 1 free = 3 × 30 = 90.
    const out = computeBogoDiscount(cfg, [
      { product_id: 'p_1', price: '30.00', quantity: 9 },
    ])
    expect(out).toBe(90)
  })

  it('honours partial get_discount_percentage (50% off the get)', () => {
    const half: BogoConfig = {
      buy_quantity: 1,
      get_quantity: 1,
      get_discount_percentage: 50,
    }
    // 4 units @ $20 → cycleSize=2, 2 cycles. Each cycle discounts 1 unit
    // at 50% → 10. Total = 20.
    const out = computeBogoDiscount(half, [
      { product_id: 'p_1', price: '20.00', quantity: 4 },
    ])
    expect(out).toBe(20)
  })

  it('handles get_quantity > 1 (buy 1 get 2 half-off)', () => {
    const b1g2: BogoConfig = {
      buy_quantity: 1,
      get_quantity: 2,
      get_discount_percentage: 50,
    }
    // cycleSize=3. 6 units @ $10 → 2 cycles. Per cycle, discount 2 units
    // at 50% → 10/cycle. Total = 20.
    const out = computeBogoDiscount(b1g2, [
      { product_id: 'p_1', price: '10.00', quantity: 6 },
    ])
    expect(out).toBe(20)
  })

  it('skips lines with non-finite price or zero quantity', () => {
    // The one valid line has 3 units @ $30 → 1 cycle × 1 free unit = 30.
    const out = computeBogoDiscount(cfg, [
      { product_id: 'p_bad', price: 'NaN', quantity: 5 },
      { product_id: 'p_zero', price: '100.00', quantity: 0 },
      { product_id: 'p_good', price: '30.00', quantity: 3 },
    ])
    expect(out).toBe(30)
  })
})

describe('normalizeEligibleSegments', () => {
  it('returns null for null / undefined', () => {
    expect(normalizeEligibleSegments(null)).toBeNull()
    expect(normalizeEligibleSegments(undefined)).toBeNull()
  })

  it('returns the array for a valid string array', () => {
    expect(normalizeEligibleSegments(['seg_a', 'seg_b'])).toEqual([
      'seg_a',
      'seg_b',
    ])
  })

  it('parses jsonb returned as raw JSON text', () => {
    expect(normalizeEligibleSegments('["seg_a","seg_b"]')).toEqual([
      'seg_a',
      'seg_b',
    ])
  })

  it('returns null for empty array (treated as "any customer")', () => {
    expect(normalizeEligibleSegments([])).toBeNull()
  })

  it('filters non-string entries out', () => {
    expect(
      normalizeEligibleSegments(['seg_a', '', 42 as any, null, 'seg_b']),
    ).toEqual(['seg_a', 'seg_b'])
  })

  it('returns null for malformed JSON string', () => {
    expect(normalizeEligibleSegments('[not-json')).toBeNull()
  })
})

describe('validateDiscountForCart with customer segment eligibility', () => {
  beforeEach(() => {
    ;(globalThis as any).__lastTestSegmentId = undefined
  })

  it('rejects guest buyer when discount requires a segment', async () => {
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [],
      segmentMembership: { seg_vip: ['cust_ok'] },
    })
    const result = await validateDiscountForCart(
      db,
      makeDiscount({ eligible_segment_ids: ['seg_vip'] }),
      { subtotal: '100.00', itemCount: 1, customerId: null, email: null },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('customer_not_eligible')
  })

  it('accepts customer who matches a listed segment', async () => {
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [],
      segmentMembership: { seg_vip: ['cust_ok'] },
    })
    const result = await validateDiscountForCart(
      db,
      makeDiscount({ eligible_segment_ids: ['seg_vip'] }),
      { subtotal: '100.00', itemCount: 1, customerId: 'cust_ok' },
    )
    expect(result.ok).toBe(true)
  })

  it('rejects authenticated customer who matches none of the listed segments', async () => {
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [],
      segmentMembership: { seg_vip: ['cust_ok'] },
    })
    const result = await validateDiscountForCart(
      db,
      makeDiscount({ eligible_segment_ids: ['seg_vip'] }),
      { subtotal: '100.00', itemCount: 1, customerId: 'cust_other' },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('customer_not_eligible')
  })

  it('skips segment check when eligible_segment_ids is null / empty', async () => {
    // Storewide discount (no segment restriction) should accept anyone.
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const result = await validateDiscountForCart(
      db,
      makeDiscount({ eligible_segment_ids: null }),
      { subtotal: '100.00', itemCount: 1 },
    )
    expect(result.ok).toBe(true)
  })
})

describe('validateDiscountForCart with BOGO cycle', () => {
  const lineItems = [
    { product_id: 'p_1', price: '25.00', quantity: 2 }, // 50 total
  ]

  it('rejects with bogo_cycle_not_met when cart has fewer units than cycleSize', async () => {
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const result = await validateDiscountForCart(
      db,
      makeDiscount({
        type: 'bogo',
        bogo_config: {
          buy_quantity: 2,
          get_quantity: 1,
          get_discount_percentage: 100,
        },
      }),
      { subtotal: '50.00', itemCount: 2, lineItems },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('bogo_cycle_not_met')
      expect(result.message).toMatch(/Add 1 more item/)
    }
  })

  it('accepts when cart meets the cycle requirement', async () => {
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const result = await validateDiscountForCart(
      db,
      makeDiscount({
        type: 'bogo',
        bogo_config: {
          buy_quantity: 2,
          get_quantity: 1,
          get_discount_percentage: 100,
        },
      }),
      {
        subtotal: '75.00',
        itemCount: 3,
        lineItems: [{ product_id: 'p_1', price: '25.00', quantity: 3 }],
      },
    )
    expect(result.ok).toBe(true)
  })

  it('rejects BOGO with inactive when bogo_config is malformed', async () => {
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const result = await validateDiscountForCart(
      db,
      makeDiscount({
        type: 'bogo',
        bogo_config: { buy_quantity: 0 }, // invalid
      }),
      {
        subtotal: '100.00',
        itemCount: 5,
        lineItems: [{ product_id: 'p_1', price: '20.00', quantity: 5 }],
      },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('inactive')
  })

  it('only counts eligible (scoped) units toward cycle qualification', async () => {
    // BOGO scoped to p_eligible only. Cart has 3 units of p_other plus
    // 1 unit of p_eligible → only 1 eligible unit, cycleSize=3 → reject.
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const result = await validateDiscountForCart(
      db,
      makeDiscount({
        type: 'bogo',
        applies_to: 'specific_products',
        target_selection: ['p_eligible'],
        bogo_config: {
          buy_quantity: 2,
          get_quantity: 1,
          get_discount_percentage: 100,
        },
      }),
      {
        subtotal: '80.00',
        itemCount: 4,
        lineItems: [
          { product_id: 'p_other', price: '20.00', quantity: 3 },
          { product_id: 'p_eligible', price: '20.00', quantity: 1 },
        ],
      },
    )
    // Scope check happens first (step 5) and passes because there's 1
    // eligible line; BOGO cycle check (step 8) then rejects.
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('bogo_cycle_not_met')
  })
})

describe('applyDiscount with BOGO', () => {
  beforeEach(() => {
    memCache.clear()
  })

  it('stamps bogo_config onto checkout.discount and computes cheapest-first discount', async () => {
    const db = makeFakeDb({
      discount: makeDiscount({
        type: 'bogo',
        value: '0', // flat value ignored for BOGO
        value_type: 'percentage',
        bogo_config: {
          buy_quantity: 2,
          get_quantity: 1,
          get_discount_percentage: 100,
        },
      }),
      priorRedemptions: [],
    })
    // Cart: 3 units @ $25 → 1 cycle → free cheapest unit = 25.
    const ck = makeCheckout({
      line_items: [
        {
          variant_id: 'v_1',
          product_id: 'p_1',
          title: 'Widget',
          variant_title: null,
          sku: 'W-1',
          price: '25.00',
          quantity: 3,
          requires_shipping: true,
          taxable: true,
          image_url: null,
          weight: null,
          weight_unit: 'kg',
        },
      ],
      subtotal_price: '75.00',
      total_price: '75.00',
    })
    memCache.set(`checkout:${ck.id}`, ck)

    const updated = await applyDiscount(db, ck.id, 'SAVE10')
    expect(updated.discount?.bogo_config).toEqual({
      buy_quantity: 2,
      get_quantity: 1,
      get_discount_percentage: 100,
    })
    expect(updated.total_discounts).toBe('25.00')
    expect(updated.total_price).toBe('50.00') // 75 - 25
  })
})

describe('evaluateAutomaticDiscount with BOGO', () => {
  beforeEach(() => {
    memCache.clear()
  })

  it('picks a BOGO over a percentage when BOGO yields more discount', async () => {
    // Cart: 3 units @ $100 = $300.
    // Auto A: flat 10% → 30.
    // Auto B: BOGO 2+1 @ 100% → 100 (cheapest unit = 100). ← winner.
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [],
      automaticDiscounts: [
        makeDiscount({
          id: 'auto_pct',
          code: null,
          method: 'automatic',
          value: '10',
        }),
        makeDiscount({
          id: 'auto_bogo',
          code: null,
          method: 'automatic',
          type: 'bogo',
          value: '0',
          bogo_config: {
            buy_quantity: 2,
            get_quantity: 1,
            get_discount_percentage: 100,
          },
        }),
      ],
    })
    const ck = makeCheckout({
      discount: null,
      line_items: [
        {
          variant_id: 'v_1',
          product_id: 'p_1',
          title: 'Widget',
          variant_title: null,
          sku: 'W-1',
          price: '100.00',
          quantity: 3,
          requires_shipping: true,
          taxable: true,
          image_url: null,
          weight: null,
          weight_unit: 'kg',
        },
      ],
      subtotal_price: '300.00',
      total_price: '300.00',
    })
    memCache.set(`checkout:${ck.id}`, ck)

    const updated = await evaluateAutomaticDiscount(db, ck.id)
    expect(updated.discount?.discount_id).toBe('auto_bogo')
    expect(updated.total_discounts).toBe('100.00')
    expect(updated.discount?.bogo_config).toEqual({
      buy_quantity: 2,
      get_quantity: 1,
      get_discount_percentage: 100,
    })
  })
})

describe('getDiscountAnalytics', () => {
  it('returns zeros for a discount that was never redeemed', async () => {
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [],
      orderRedemptions: [],
    })
    const out = await getDiscountAnalytics(db, 'shop_1', 'disc_1')
    expect(out).toEqual({
      discount_id: 'disc_1',
      redemption_count: 0,
      total_discount_amount: '0',
      first_redeemed_at: null,
      last_redeemed_at: null,
    })
  })

  it('aggregates redemption count + sum + first / last timestamps', async () => {
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [],
      orderRedemptions: [
        {
          shop_id: 'shop_1',
          discount_id: 'disc_1',
          total_discounts: '10.00',
          created_at: '2026-01-01T00:00:00.000Z',
          cancelled_at: null,
        },
        {
          shop_id: 'shop_1',
          discount_id: 'disc_1',
          total_discounts: '15.00',
          created_at: '2026-02-15T00:00:00.000Z',
          cancelled_at: null,
        },
        {
          shop_id: 'shop_1',
          discount_id: 'disc_1',
          total_discounts: '5.00',
          created_at: '2026-03-10T00:00:00.000Z',
          cancelled_at: null,
        },
      ],
    })
    const out = await getDiscountAnalytics(db, 'shop_1', 'disc_1')
    expect(out.redemption_count).toBe(3)
    expect(out.total_discount_amount).toBe('30.00')
    expect(out.first_redeemed_at).toBe('2026-01-01T00:00:00.000Z')
    expect(out.last_redeemed_at).toBe('2026-03-10T00:00:00.000Z')
  })

  it('excludes cancelled orders from the aggregate', async () => {
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [],
      orderRedemptions: [
        {
          shop_id: 'shop_1',
          discount_id: 'disc_1',
          total_discounts: '10.00',
          created_at: '2026-01-01T00:00:00.000Z',
          cancelled_at: null,
        },
        {
          shop_id: 'shop_1',
          discount_id: 'disc_1',
          total_discounts: '99.00',
          created_at: '2026-02-01T00:00:00.000Z',
          cancelled_at: '2026-02-02T00:00:00.000Z',
        },
      ],
    })
    const out = await getDiscountAnalytics(db, 'shop_1', 'disc_1')
    expect(out.redemption_count).toBe(1)
    expect(out.total_discount_amount).toBe('10.00')
  })

  it('scopes by shop_id (no cross-shop leakage)', async () => {
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [],
      orderRedemptions: [
        {
          shop_id: 'shop_other',
          discount_id: 'disc_1',
          total_discounts: '99.00',
          created_at: '2026-01-01T00:00:00.000Z',
          cancelled_at: null,
        },
      ],
    })
    const out = await getDiscountAnalytics(db, 'shop_1', 'disc_1')
    expect(out.redemption_count).toBe(0)
  })
})

describe('getDiscountAnalyticsBatch', () => {
  it('returns [] for empty input', async () => {
    const db = makeFakeDb({ discount: null, priorRedemptions: [] })
    const out = await getDiscountAnalyticsBatch(db, 'shop_1', [])
    expect(out).toEqual([])
  })

  it('returns one entry per requested id (zeros for non-redeemed ids)', async () => {
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [],
      orderRedemptions: [
        {
          shop_id: 'shop_1',
          discount_id: 'disc_a',
          total_discounts: '20.00',
          created_at: '2026-01-01T00:00:00.000Z',
          cancelled_at: null,
        },
      ],
    })
    const out = await getDiscountAnalyticsBatch(db, 'shop_1', [
      'disc_a',
      'disc_b', // never redeemed
    ])
    expect(out).toHaveLength(2)
    const byId = new Map(out.map((r) => [r.discount_id, r]))
    expect(byId.get('disc_a')?.redemption_count).toBe(1)
    expect(byId.get('disc_a')?.total_discount_amount).toBe('20.00')
    expect(byId.get('disc_b')?.redemption_count).toBe(0)
    expect(byId.get('disc_b')?.total_discount_amount).toBe('0')
  })

  it('excludes cancelled orders from batched aggregates', async () => {
    const db = makeFakeDb({
      discount: null,
      priorRedemptions: [],
      orderRedemptions: [
        {
          shop_id: 'shop_1',
          discount_id: 'disc_a',
          total_discounts: '50.00',
          created_at: '2026-01-01T00:00:00.000Z',
          cancelled_at: null,
        },
        {
          shop_id: 'shop_1',
          discount_id: 'disc_a',
          total_discounts: '999.00',
          created_at: '2026-01-05T00:00:00.000Z',
          cancelled_at: '2026-01-06T00:00:00.000Z',
        },
      ],
    })
    const out = await getDiscountAnalyticsBatch(db, 'shop_1', ['disc_a'])
    expect(out[0].redemption_count).toBe(1)
    expect(out[0].total_discount_amount).toBe('50.00')
  })
})
