/**
 * Gbox Platform — Storefront event recorder tests (Stage 3E.1)
 *
 * Fast in-memory stub of Kysely's insertInto path. Every test
 * captures the rows the recorder would have inserted and asserts
 * on shape — we do NOT touch Postgres here. The storefront tests
 * do the end-to-end integration.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordPageView,
  recordAddToCart,
  recordCheckoutStart,
  recordPurchase,
  STOREFRONT_EVENT_VERBS,
} from './storefront-events.js'

// ---------------------------------------------------------------------------
// Tiny fake db: captures every .insertInto().values().execute() call.
// ---------------------------------------------------------------------------

interface CapturedInsert {
  table: string
  row: Record<string, unknown>
}

function makeFakeDb(): { db: any; inserts: CapturedInsert[] } {
  const inserts: CapturedInsert[] = []
  const db: any = {
    insertInto: (table: string) => ({
      values: (row: any) => ({
        execute: async () => {
          inserts.push({ table, row })
          return []
        },
      }),
    }),
  }
  return { db, inserts }
}

let fake: ReturnType<typeof makeFakeDb>
beforeEach(() => {
  fake = makeFakeDb()
})

// ---------------------------------------------------------------------------
// Shared invariants
// ---------------------------------------------------------------------------

describe('STOREFRONT_EVENT_VERBS', () => {
  it('is the same allowlist used by analytics.getConversionFunnel', () => {
    expect(STOREFRONT_EVENT_VERBS).toEqual([
      'page_view',
      'add_to_cart',
      'checkout_start',
      'purchase',
    ])
  })
})

// ---------------------------------------------------------------------------
// recordPageView
// ---------------------------------------------------------------------------

describe('recordPageView', () => {
  it('inserts a page_view event with the path as subject_id', async () => {
    await recordPageView(fake.db, 'shop_1', {
      path: '/products/cap',
      referrer: 'https://google.com/',
      userAgent: 'Mozilla/5.0',
      sessionId: 'sess_abc',
    })
    expect(fake.inserts).toHaveLength(1)
    const row = fake.inserts[0]!.row
    expect(fake.inserts[0]!.table).toBe('events')
    expect(row.shop_id).toBe('shop_1')
    expect(row.verb).toBe('page_view')
    expect(row.subject_type).toBe('page')
    expect(row.subject_id).toBe('/products/cap')
  })

  it('encodes the body as JSON string (matches Kysely JsonB column)', async () => {
    await recordPageView(fake.db, 'shop_1', {
      path: '/products/cap',
      referrer: 'https://google.com/',
      userAgent: 'Mozilla/5.0',
      sessionId: 'sess_abc',
    })
    const body = fake.inserts[0]!.row.body as string
    expect(typeof body).toBe('string')
    const parsed = JSON.parse(body)
    expect(parsed).toMatchObject({
      referrer: 'https://google.com/',
      user_agent: 'Mozilla/5.0',
      session_id: 'sess_abc',
    })
  })

  it('truncates monster user-agent strings to 512 chars', async () => {
    // Adversarial clients sometimes send 8kb user-agents just to blow
    // up downstream log pipelines. Cap defensively.
    const monster = 'x'.repeat(5000)
    await recordPageView(fake.db, 'shop_1', {
      path: '/',
      referrer: null,
      userAgent: monster,
      sessionId: 'sess_abc',
    })
    const parsed = JSON.parse(fake.inserts[0]!.row.body as string)
    expect(parsed.user_agent.length).toBe(512)
  })

  it('omits referrer when null', async () => {
    await recordPageView(fake.db, 'shop_1', {
      path: '/',
      referrer: null,
      userAgent: 'ua',
      sessionId: 'sess',
    })
    const parsed = JSON.parse(fake.inserts[0]!.row.body as string)
    expect('referrer' in parsed).toBe(false)
  })

  it('omits customer_id entirely when anonymous', async () => {
    await recordPageView(fake.db, 'shop_1', {
      path: '/',
      referrer: null,
      userAgent: 'ua',
      sessionId: 'sess',
    })
    const parsed = JSON.parse(fake.inserts[0]!.row.body as string)
    expect('customer_id' in parsed).toBe(false)
  })

  it('includes customer_id when provided', async () => {
    await recordPageView(fake.db, 'shop_1', {
      path: '/',
      referrer: null,
      userAgent: 'ua',
      sessionId: 'sess',
      customerId: 'cus_alice',
    })
    const parsed = JSON.parse(fake.inserts[0]!.row.body as string)
    expect(parsed.customer_id).toBe('cus_alice')
  })
})

// ---------------------------------------------------------------------------
// recordAddToCart
// ---------------------------------------------------------------------------

describe('recordAddToCart', () => {
  it('inserts an add_to_cart event with variant_id as subject_id', async () => {
    await recordAddToCart(fake.db, 'shop_1', {
      variantId: 'var_1',
      productId: 'prod_1',
      quantity: 2,
      price: '19.99',
      currency: 'USD',
      sessionId: 'sess',
    })
    const row = fake.inserts[0]!.row
    expect(row.verb).toBe('add_to_cart')
    expect(row.subject_type).toBe('variant')
    expect(row.subject_id).toBe('var_1')
    const parsed = JSON.parse(row.body as string)
    expect(parsed).toMatchObject({
      product_id: 'prod_1',
      quantity: 2,
      price: '19.99',
      currency: 'USD',
      session_id: 'sess',
    })
  })
})

// ---------------------------------------------------------------------------
// recordCheckoutStart
// ---------------------------------------------------------------------------

describe('recordCheckoutStart', () => {
  it('inserts a checkout_start event with checkout_id as subject_id', async () => {
    await recordCheckoutStart(fake.db, 'shop_1', {
      checkoutId: 'chk_1',
      total: '49.99',
      currency: 'USD',
      itemCount: 3,
      sessionId: 'sess',
    })
    const row = fake.inserts[0]!.row
    expect(row.verb).toBe('checkout_start')
    expect(row.subject_type).toBe('checkout')
    expect(row.subject_id).toBe('chk_1')
    const parsed = JSON.parse(row.body as string)
    expect(parsed).toMatchObject({
      total: '49.99',
      currency: 'USD',
      item_count: 3,
      session_id: 'sess',
    })
  })
})

// ---------------------------------------------------------------------------
// recordPurchase
// ---------------------------------------------------------------------------

describe('recordPurchase', () => {
  it('inserts a purchase event with order_id as subject_id', async () => {
    await recordPurchase(fake.db, 'shop_1', {
      orderId: 'ord_1',
      total: '49.99',
      currency: 'USD',
      itemCount: 3,
      customerId: 'cus_alice',
      sessionId: 'sess',
    })
    const row = fake.inserts[0]!.row
    expect(row.verb).toBe('purchase')
    expect(row.subject_type).toBe('order')
    expect(row.subject_id).toBe('ord_1')
    const parsed = JSON.parse(row.body as string)
    expect(parsed).toMatchObject({
      total: '49.99',
      currency: 'USD',
      item_count: 3,
      customer_id: 'cus_alice',
      session_id: 'sess',
    })
  })
})

// ---------------------------------------------------------------------------
// Defensive: recorders MUST swallow db errors
// ---------------------------------------------------------------------------

describe('fault tolerance', () => {
  it('swallows db errors so a broken analytics pipeline never 500s the storefront', async () => {
    const brokenDb: any = {
      insertInto: () => ({
        values: () => ({
          execute: async () => {
            throw new Error('db down')
          },
        }),
      }),
    }
    // None of these should throw.
    await expect(
      recordPageView(brokenDb, 'shop_1', {
        path: '/',
        referrer: null,
        userAgent: 'ua',
        sessionId: 'sess',
      }),
    ).resolves.toBeUndefined()
    await expect(
      recordAddToCart(brokenDb, 'shop_1', {
        variantId: 'v',
        productId: 'p',
        quantity: 1,
        price: '1',
        currency: 'USD',
        sessionId: 'sess',
      }),
    ).resolves.toBeUndefined()
    await expect(
      recordCheckoutStart(brokenDb, 'shop_1', {
        checkoutId: 'chk',
        total: '1',
        currency: 'USD',
        itemCount: 1,
        sessionId: 'sess',
      }),
    ).resolves.toBeUndefined()
    await expect(
      recordPurchase(brokenDb, 'shop_1', {
        orderId: 'o',
        total: '1',
        currency: 'USD',
        itemCount: 1,
        sessionId: 'sess',
      }),
    ).resolves.toBeUndefined()
  })
})
