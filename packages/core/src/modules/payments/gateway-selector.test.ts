/**
 * Gbox Platform — Payment Gateway Selector Tests
 *
 * Unit tests for `selectPaymentGateway` — the deterministic rule engine
 * that decides which payment rails a given shop accepts. PayPal Partner
 * is always preferred when both shop connection + env are ready;
 * Stripe is the fallback (Decision #3 — owner "clone giống hệt Shopify"
 * rule means PayPal must always win when available).
 *
 * Strategy: fake the Kysely builder so each test can script the two
 * shop_settings reads (`paypal_partner.paypal_merchant_id` and
 * `paypal_partner.paypal_connected`) without touching PostgreSQL.
 *
 * Matrix:
 *   - no env, no connect -> preferred=null, available=[], usingFallback=false
 *   - stripe env only -> preferred=stripe, usingFallback=true
 *   - paypal env ready, shop NOT connected, stripe env -> stripe fallback
 *   - paypal env ready, shop NOT connected, NO stripe env -> null
 *   - paypal env + shop connected -> paypal primary, available=[paypal]
 *   - paypal env + shop connected + stripe env -> [paypal, stripe]
 *   - paypal env + merchant_id present but connected=false -> not ready
 *   - shop_settings JSON-encoded string value is decoded
 *
 * Run:
 *   npx vitest run packages/core/src/modules/payments/gateway-selector.test.ts
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'

import { selectPaymentGateway } from './gateway-selector.js'

// ---------------------------------------------------------------------------
// Fake Kysely — records each selectFrom chain and returns scripted rows
// ---------------------------------------------------------------------------

type SettingRow = { value: unknown } | undefined

function makeFakeDb(settings: Record<string, SettingRow>) {
  const calls: Array<{ shopId?: string; key?: string }> = []

  function chain() {
    const state: { shopId?: string; key?: string } = {}
    const api: any = {
      selectFrom: (_table: string) => api,
      select: (_cols: string | string[]) => api,
      where: (col: string, _op: string, val: any) => {
        if (col === 'shop_id') state.shopId = val
        if (col === 'key') state.key = val
        return api
      },
      executeTakeFirst: async () => {
        calls.push({ ...state })
        return state.key ? settings[state.key] ?? undefined : undefined
      },
    }
    return api
  }

  return {
    selectFrom: (table: string) => chain().selectFrom(table),
    __calls: calls,
  } as any
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  // Wipe any payment env so each test sets exactly what it wants.
  delete process.env.PAYPAL_PARTNER_CLIENT_ID
  delete process.env.PAYPAL_PARTNER_SECRET
  delete process.env.PAYPAL_PARTNER_ID
  delete process.env.STRIPE_SECRET_KEY
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

function enablePayPalEnv() {
  process.env.PAYPAL_PARTNER_CLIENT_ID = 'test_client'
  process.env.PAYPAL_PARTNER_SECRET = 'test_secret'
  process.env.PAYPAL_PARTNER_ID = 'test_partner'
}

function enableStripeEnv() {
  process.env.STRIPE_SECRET_KEY = 'sk_test_stripe'
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('selectPaymentGateway — empty state', () => {
  it('returns null/empty when no env is configured', async () => {
    const db = makeFakeDb({})
    const result = await selectPaymentGateway(db, 'shop_1')
    expect(result.preferred).toBeNull()
    expect(result.available).toEqual([])
    expect(result.usingFallback).toBe(false)
    expect(result.reason).toMatch(/No payment gateway/i)
  })

  it('returns null when only PayPal env is set but shop not connected', async () => {
    enablePayPalEnv()
    const db = makeFakeDb({
      'paypal_partner.paypal_merchant_id': undefined,
      'paypal_partner.paypal_connected': undefined,
    })
    const result = await selectPaymentGateway(db, 'shop_1')
    expect(result.preferred).toBeNull()
    expect(result.available).toEqual([])
    expect(result.usingFallback).toBe(false)
    expect(result.reason).toMatch(/has not connected PayPal/i)
  })
})

describe('selectPaymentGateway — Stripe fallback only', () => {
  it('selects Stripe when only stripe env is set', async () => {
    enableStripeEnv()
    const db = makeFakeDb({})
    const result = await selectPaymentGateway(db, 'shop_1')
    expect(result.preferred).toBe('stripe')
    expect(result.available).toEqual(['stripe'])
    expect(result.usingFallback).toBe(true)
    expect(result.reason).toMatch(/Stripe/i)
  })

  it('selects Stripe when PayPal env is set but merchant has not onboarded', async () => {
    enablePayPalEnv()
    enableStripeEnv()
    const db = makeFakeDb({
      'paypal_partner.paypal_merchant_id': undefined,
      'paypal_partner.paypal_connected': undefined,
    })
    const result = await selectPaymentGateway(db, 'shop_1')
    expect(result.preferred).toBe('stripe')
    expect(result.available).toEqual(['stripe'])
    expect(result.usingFallback).toBe(true)
    expect(result.reason).toMatch(/PayPal not yet connected/i)
  })

  it('treats connected=false as NOT ready even with a merchant id', async () => {
    enablePayPalEnv()
    enableStripeEnv()
    const db = makeFakeDb({
      'paypal_partner.paypal_merchant_id': { value: 'MERCH_123' },
      'paypal_partner.paypal_connected': { value: false },
    })
    const result = await selectPaymentGateway(db, 'shop_1')
    expect(result.preferred).toBe('stripe')
    expect(result.usingFallback).toBe(true)
  })
})

describe('selectPaymentGateway — PayPal primary', () => {
  it('prefers PayPal when env + merchant_id + connected=true', async () => {
    enablePayPalEnv()
    const db = makeFakeDb({
      'paypal_partner.paypal_merchant_id': { value: 'MERCH_ABC' },
      'paypal_partner.paypal_connected': { value: true },
    })
    const result = await selectPaymentGateway(db, 'shop_1')
    expect(result.preferred).toBe('paypal')
    expect(result.available).toEqual(['paypal'])
    expect(result.usingFallback).toBe(false)
    expect(result.reason).toMatch(/PayPal Partner account is connected/i)
  })

  it('offers both gateways with PayPal first when Stripe env is also set', async () => {
    enablePayPalEnv()
    enableStripeEnv()
    const db = makeFakeDb({
      'paypal_partner.paypal_merchant_id': { value: 'MERCH_ABC' },
      'paypal_partner.paypal_connected': { value: true },
    })
    const result = await selectPaymentGateway(db, 'shop_1')
    expect(result.preferred).toBe('paypal')
    expect(result.available).toEqual(['paypal', 'stripe'])
    expect(result.usingFallback).toBe(false)
  })

  it('requires BOTH merchant_id AND connected=true — missing merchant_id falls back', async () => {
    enablePayPalEnv()
    enableStripeEnv()
    const db = makeFakeDb({
      'paypal_partner.paypal_merchant_id': undefined,
      'paypal_partner.paypal_connected': { value: true },
    })
    const result = await selectPaymentGateway(db, 'shop_1')
    expect(result.preferred).toBe('stripe')
    expect(result.usingFallback).toBe(true)
  })
})

describe('selectPaymentGateway — jsonb string decoding', () => {
  it('parses a JSON-encoded boolean stored as a string', async () => {
    // Some callers JSON.stringify(true) before insert, which ends up as
    // the string "true" in the value column. Selector must unwrap it.
    enablePayPalEnv()
    const db = makeFakeDb({
      'paypal_partner.paypal_merchant_id': { value: '"MERCH_XYZ"' },
      'paypal_partner.paypal_connected': { value: 'true' },
    })
    const result = await selectPaymentGateway(db, 'shop_1')
    expect(result.preferred).toBe('paypal')
  })

  it('treats malformed JSON string as the raw string', async () => {
    enablePayPalEnv()
    const db = makeFakeDb({
      // Raw (non-JSON) string in the connected field — not truthy=true,
      // so PayPal is NOT ready.
      'paypal_partner.paypal_merchant_id': { value: 'MERCH_XYZ' },
      'paypal_partner.paypal_connected': { value: 'not-json-{' },
    })
    const result = await selectPaymentGateway(db, 'shop_1')
    // connected !== true after parse attempt, so PayPal isn't ready.
    expect(result.preferred).toBeNull()
  })
})

describe('selectPaymentGateway — DB access pattern', () => {
  it('queries shop_settings exactly twice (one per key)', async () => {
    enablePayPalEnv()
    enableStripeEnv()
    const db = makeFakeDb({
      'paypal_partner.paypal_merchant_id': { value: 'MERCH_ABC' },
      'paypal_partner.paypal_connected': { value: true },
    })
    await selectPaymentGateway(db, 'shop_1')
    const calls = (db as any).__calls as Array<{ shopId?: string; key?: string }>
    expect(calls.length).toBe(2)
    expect(calls.every((c) => c.shopId === 'shop_1')).toBe(true)
    const keys = calls.map((c) => c.key).sort()
    expect(keys).toEqual([
      'paypal_partner.paypal_connected',
      'paypal_partner.paypal_merchant_id',
    ])
  })

  it('short-circuits DB reads when PayPal env is missing entirely', async () => {
    enableStripeEnv()
    const db = makeFakeDb({})
    await selectPaymentGateway(db, 'shop_1')
    const calls = (db as any).__calls as Array<unknown>
    expect(calls.length).toBe(0)
  })
})
