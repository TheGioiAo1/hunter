/**
 * Gbox Platform — DbI18nService unit tests
 *
 * Decision #1 Step 1.2b — Tests the production DB-backed I18nService
 * with a hand-rolled Kysely-shaped mock. The mock records the
 * `selectFrom` and `insertInto` calls plus their where clauses so we
 * can assert the service hit the right shop+locale.
 *
 * What we test here:
 *   - preload() issues a single SELECT scoped to (shop_id, locale)
 *     and turns the result into a TranslationDict
 *   - cache: a second preload() for the same key never re-queries
 *   - cache: concurrent preloads dedupe to one query (in-flight)
 *   - t() three-tier fallback issues at most ONE query per locale
 *     because each tier hits the cache after preload
 *   - set() issues an upsert and invalidates the (shop, locale) cache
 *   - setMany() issues a single bulk upsert
 *   - invalidate(shop) drops every cached locale for that shop
 *
 * What we don't test here:
 *   - SQL string correctness (kysely's job)
 *   - Live DB round-trip — that lives in the integration smoke test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DbI18nService } from './service.js'

const SHOP = 'shop_1'

// ---------------------------------------------------------------------------
// Kysely-shaped mock
// ---------------------------------------------------------------------------

interface MockState {
  /** Rows the next selectFrom('translations').execute() should resolve to. */
  selectResult: Array<{ key: string; value: string }>
  /** Total selectFrom('translations') calls observed. */
  selectCalls: number
  /** Captured `where('shop_id', '=', X)` and `where('locale', '=', Y)` pairs. */
  whereLog: Array<{ shopId?: string; locale?: string }>
  /** Total insertInto('translations') calls observed. */
  insertCalls: number
  /** Last `.values(...)` payload. */
  lastInsertValues: any
}

function createMockState(): MockState {
  return {
    selectResult: [],
    selectCalls: 0,
    whereLog: [],
    insertCalls: 0,
    lastInsertValues: null,
  }
}

function createMockDb(state: MockState) {
  // SELECT chain: selectFrom().select(['key','value']).where().where().execute()
  function buildSelectChain() {
    state.selectCalls++
    const captured: { shopId?: string; locale?: string } = {}
    state.whereLog.push(captured)
    const chain: any = {
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation((col: string, _op: string, val: string) => {
        if (col === 'shop_id') captured.shopId = val
        if (col === 'locale') captured.locale = val
        return chain
      }),
      execute: vi.fn().mockImplementation(async () => state.selectResult),
    }
    return chain
  }

  // INSERT chain: insertInto().values(...).onConflict(...).execute()
  function buildInsertChain() {
    state.insertCalls++
    const chain: any = {
      values: vi.fn().mockImplementation((v: any) => {
        state.lastInsertValues = v
        return chain
      }),
      onConflict: vi.fn().mockImplementation((cb: any) => {
        // Run the callback against a stub so test errors surface if the
        // production code calls something we don't recognise.
        const ocStub: any = {
          columns: vi.fn().mockReturnThis(),
          doUpdateSet: vi.fn().mockReturnThis(),
        }
        cb(ocStub)
        return chain
      }),
      execute: vi.fn().mockResolvedValue(undefined),
    }
    return chain
  }

  return {
    selectFrom: vi.fn().mockImplementation((_table: string) => buildSelectChain()),
    insertInto: vi.fn().mockImplementation((_table: string) => buildInsertChain()),
  } as any
}

// ---------------------------------------------------------------------------
// preload + cache
// ---------------------------------------------------------------------------

describe('DbI18nService — preload + cache', () => {
  let state: MockState
  let i18n: DbI18nService

  beforeEach(() => {
    state = createMockState()
    state.selectResult = [
      { key: 'cart.title', value: 'Cart' },
      { key: 'cart.empty', value: 'Your cart is empty' },
    ]
    i18n = new DbI18nService(createMockDb(state))
  })

  it('preload() issues one SELECT and returns a dict', async () => {
    const dict = await i18n.preload(SHOP, 'en')
    expect(dict).toEqual({
      'cart.title': 'Cart',
      'cart.empty': 'Your cart is empty',
    })
    expect(state.selectCalls).toBe(1)
    expect(state.whereLog[0]).toEqual({ shopId: SHOP, locale: 'en' })
  })

  it('preload() second call hits cache, no extra SELECT', async () => {
    await i18n.preload(SHOP, 'en')
    await i18n.preload(SHOP, 'en')
    await i18n.preload(SHOP, 'en')
    expect(state.selectCalls).toBe(1)
  })

  it('preload() concurrent calls dedupe to one in-flight query', async () => {
    const [a, b, c] = await Promise.all([
      i18n.preload(SHOP, 'en'),
      i18n.preload(SHOP, 'en'),
      i18n.preload(SHOP, 'en'),
    ])
    expect(a).toEqual(b)
    expect(b).toEqual(c)
    expect(state.selectCalls).toBe(1)
  })

  it('preload() different locale issues a fresh SELECT', async () => {
    state.selectResult = [{ key: 'x', value: 'EN' }]
    await i18n.preload(SHOP, 'en')

    state.selectResult = [{ key: 'x', value: 'VI' }]
    await i18n.preload(SHOP, 'vi')

    expect(state.selectCalls).toBe(2)
    expect(i18n._peekCache(SHOP, 'en')).toEqual({ x: 'EN' })
    expect(i18n._peekCache(SHOP, 'vi')).toEqual({ x: 'VI' })
  })
})

// ---------------------------------------------------------------------------
// t() three-tier fallback
// ---------------------------------------------------------------------------

describe('DbI18nService — t() fallback chain', () => {
  it('Tier 1 hit: requested locale resolves the key', async () => {
    const state = createMockState()
    state.selectResult = [{ key: 'cart.title', value: 'Giỏ hàng' }]
    const i18n = new DbI18nService(createMockDb(state))

    const out = await i18n.t(SHOP, 'cart.title', {
      locale: 'vi',
      shopDefaultLocale: 'en',
    })
    expect(out).toBe('Giỏ hàng')
    // Only the 'vi' tier was queried.
    expect(state.selectCalls).toBe(1)
    expect(state.whereLog[0].locale).toBe('vi')
  })

  it('Tier 2 hit: shop default locale fills the gap', async () => {
    // Mock returns different rows depending on the locale we last asked for.
    const enRows = [{ key: 'cart.title', value: 'Cart' }]
    const viRows: Array<{ key: string; value: string }> = [] // empty
    const state = createMockState()
    const db = createMockDb(state)
    // Override selectFrom to vary result by where-clause.
    let nextLocale: string | undefined
    db.selectFrom = vi.fn().mockImplementation(() => {
      const captured: { shopId?: string; locale?: string } = {}
      state.selectCalls++
      state.whereLog.push(captured)
      const chain: any = {
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockImplementation((col: string, _op: string, val: string) => {
          if (col === 'shop_id') captured.shopId = val
          if (col === 'locale') {
            captured.locale = val
            nextLocale = val
          }
          return chain
        }),
        execute: vi.fn().mockImplementation(async () =>
          nextLocale === 'vi' ? viRows : enRows,
        ),
      }
      return chain
    })

    const i18n = new DbI18nService(db)
    const out = await i18n.t(SHOP, 'cart.title', {
      locale: 'vi',
      shopDefaultLocale: 'en',
    })
    expect(out).toBe('Cart')
    // Two queries: vi (empty) → en (hit)
    expect(state.selectCalls).toBe(2)
  })

  it('Tier 4 sentinel: returns key when nothing resolves', async () => {
    const state = createMockState()
    state.selectResult = [] // every locale empty
    const i18n = new DbI18nService(createMockDb(state))
    const out = await i18n.t(SHOP, 'no.such.key', {
      locale: 'vi',
      shopDefaultLocale: 'en',
    })
    expect(out).toBe('no.such.key')
  })

  it('Tier 4 sentinel: respects custom fallback', async () => {
    const state = createMockState()
    state.selectResult = []
    const i18n = new DbI18nService(createMockDb(state))
    const out = await i18n.t(SHOP, 'no.such.key', {
      locale: 'vi',
      shopDefaultLocale: 'en',
      fallback: 'NOPE',
    })
    expect(out).toBe('NOPE')
  })

  it('interpolates vars on a hit', async () => {
    const state = createMockState()
    state.selectResult = [{ key: 'cart.line_count', value: 'You have {{ count }} items' }]
    const i18n = new DbI18nService(createMockDb(state))
    const out = await i18n.t(SHOP, 'cart.line_count', {
      locale: 'en',
      vars: { count: 5 },
    })
    expect(out).toBe('You have 5 items')
  })
})

// ---------------------------------------------------------------------------
// set / setMany / invalidate
// ---------------------------------------------------------------------------

describe('DbI18nService — set + setMany + invalidate', () => {
  it('set() issues an upsert and clears the (shop, locale) cache', async () => {
    const state = createMockState()
    state.selectResult = [{ key: 'cart.title', value: 'Old' }]
    const i18n = new DbI18nService(createMockDb(state))

    // Warm cache
    await i18n.preload(SHOP, 'en')
    expect(i18n._peekCache(SHOP, 'en')).toEqual({ 'cart.title': 'Old' })

    // Update
    await i18n.set(SHOP, 'en', 'cart.title', 'New')
    expect(state.insertCalls).toBe(1)
    expect(state.lastInsertValues).toEqual({
      shop_id: SHOP,
      locale: 'en',
      key: 'cart.title',
      value: 'New',
    })
    expect(i18n._peekCache(SHOP, 'en')).toBeUndefined()
  })

  it('setMany() issues one bulk upsert and returns the count', async () => {
    const state = createMockState()
    const i18n = new DbI18nService(createMockDb(state))

    const n = await i18n.setMany(SHOP, 'en', {
      'cart.title': 'Cart',
      'cart.empty': 'Empty',
      'cart.checkout': 'Checkout',
    })
    expect(n).toBe(3)
    expect(state.insertCalls).toBe(1)
    expect(Array.isArray(state.lastInsertValues)).toBe(true)
    expect(state.lastInsertValues.length).toBe(3)
  })

  it('setMany() with empty object does NOT touch the DB', async () => {
    const state = createMockState()
    const i18n = new DbI18nService(createMockDb(state))
    const n = await i18n.setMany(SHOP, 'en', {})
    expect(n).toBe(0)
    expect(state.insertCalls).toBe(0)
  })

  it('invalidate(shop, locale) drops only that locale', async () => {
    const state = createMockState()
    state.selectResult = [{ key: 'k', value: 'v' }]
    const i18n = new DbI18nService(createMockDb(state))

    await i18n.preload(SHOP, 'en')
    await i18n.preload(SHOP, 'vi')
    expect(i18n._cacheSize()).toBe(2)

    i18n.invalidate(SHOP, 'en')
    expect(i18n._peekCache(SHOP, 'en')).toBeUndefined()
    expect(i18n._peekCache(SHOP, 'vi')).toBeDefined()
  })

  it('invalidate(shop) drops every locale for that shop', async () => {
    const state = createMockState()
    state.selectResult = [{ key: 'k', value: 'v' }]
    const i18n = new DbI18nService(createMockDb(state))

    await i18n.preload(SHOP, 'en')
    await i18n.preload(SHOP, 'vi')
    await i18n.preload('shop_2', 'en')

    i18n.invalidate(SHOP)
    expect(i18n._peekCache(SHOP, 'en')).toBeUndefined()
    expect(i18n._peekCache(SHOP, 'vi')).toBeUndefined()
    expect(i18n._peekCache('shop_2', 'en')).toBeDefined() // other shop intact
  })
})
