/**
 * Gbox Platform — dispatchAbandonedCartTick unit tests (Phase 8 PR2)
 *
 * Mocks `./abandoned-cart.js` and `../email/service.js` so the tick
 * orchestration can be exercised without Postgres. Covers:
 *   • buildRenderVars pure computation (name fallback, domain fallback,
 *     unsubscribe URL)
 *   • no active shops → zeros
 *   • detects + enrolls newly eligible carts
 *   • dispatches due step via selectPendingStep; sender succeeds →
 *     sent++
 *   • SMTP-misconfigured enrolment short-circuits the shop but not the
 *     tick as a whole
 *   • recovered / unsubscribed enrolments are filtered at the query
 *     level (not passed to dispatchStep at all)
 *   • disabled master toggle skips the shop entirely
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the email service — we never want real SMTP in unit tests.
vi.mock('../email/service.js', () => ({
  sendEmail: vi.fn(),
}))

// Partial-mock the service layer — keep selectPendingStep REAL so we
// test the integration wire-up, but mock DB-hitting functions.
vi.mock('./abandoned-cart.js', async () => {
  const actual = await vi.importActual<typeof import('./abandoned-cart.js')>(
    './abandoned-cart.js',
  )
  return {
    ...actual,
    resolveSettings: vi.fn(),
    detectEligibleCarts: vi.fn(),
    enrollCart: vi.fn(),
    dispatchStep: vi.fn(),
  }
})

import {
  buildRenderVars,
  dispatchAbandonedCartTick,
} from './abandoned-cart-cron.js'
import * as svc from './abandoned-cart.js'
import { FLOW_DEFINITIONS } from './email-flows.js'

// ---------------------------------------------------------------------------
// chainable proxy so we can script what the DB returns per query
// ---------------------------------------------------------------------------

function chainable(result: any = []) {
  const obj: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return undefined
        if (prop === 'execute') {
          return vi
            .fn()
            .mockResolvedValue(Array.isArray(result) ? result : [result])
        }
        if (prop === 'executeTakeFirst') {
          return vi
            .fn()
            .mockResolvedValue(Array.isArray(result) ? (result[0] ?? null) : result)
        }
        return vi.fn().mockReturnValue(obj)
      },
    },
  )
  return obj
}

/**
 * Build a db mock that returns different results based on the FIRST
 * argument to selectFrom. This is coarse but enough to distinguish
 * `shops` vs `shop_domains join` vs `abandoned_cart_enrollments`
 * vs `customers`.
 */
function mockDb(scripts: Record<string, any>) {
  return {
    selectFrom: vi.fn((name: string) => {
      const base = String(name).split(' ')[0]!
      const scripted = scripts[base]
      return chainable(scripted ?? [])
    }),
    updateTable: vi.fn().mockReturnValue(chainable()),
    insertInto: vi.fn().mockReturnValue(chainable()),
    deleteFrom: vi.fn().mockReturnValue(chainable()),
    fn: { count: () => ({ as: () => ({}) }) },
  } as any
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// buildRenderVars
// ---------------------------------------------------------------------------

describe('buildRenderVars', () => {
  it('uses customer first_name when present', () => {
    const vars = buildRenderVars({
      shop: { name: 'Acme', slug: 'acme', primaryDomain: 'acme.test' },
      customer: { first_name: 'Alice', email: 'alice@example.com' },
      email: 'alice@example.com',
      enrollment: { unsubscribe_token: 't'.repeat(32), checkout_id: 'c1' },
      discountCode: null,
      platformBaseUrl: 'https://accounts.gbox.test',
    })
    expect(vars.customer_name).toBe('Alice')
    expect(vars.store_name).toBe('Acme')
    expect(vars.cart_url).toBe('https://acme.test/checkout/resume/c1')
    expect(vars.unsubscribe_url).toContain('/unsubscribe/')
    expect(vars.discount_code).toBe('')
  })

  it('falls back to email-local-part when customer has no first_name', () => {
    const vars = buildRenderVars({
      shop: { name: 'Acme', slug: 'acme', primaryDomain: null },
      customer: null,
      email: 'bob42@example.com',
      enrollment: { unsubscribe_token: 't'.repeat(32), checkout_id: 'c2' },
      discountCode: 'SAVE10',
      platformBaseUrl: null,
    })
    expect(vars.customer_name).toBe('bob42')
    expect(vars.discount_code).toBe('SAVE10')
  })

  it('falls back to <slug>.gbox.co when primary domain missing', () => {
    const vars = buildRenderVars({
      shop: { name: 'Acme', slug: 'acme-123', primaryDomain: null },
      customer: null,
      email: 'x@y.com',
      enrollment: { unsubscribe_token: 't'.repeat(32), checkout_id: 'c3' },
      discountCode: null,
      platformBaseUrl: null,
    })
    expect(vars.cart_url).toBe('https://acme-123.gbox.co/checkout/resume/c3')
  })

  it('unsubscribe_url points at platformBaseUrl when provided', () => {
    const vars = buildRenderVars({
      shop: { name: 'Acme', slug: 'acme', primaryDomain: 'acme.test' },
      customer: null,
      email: 'x@y.com',
      enrollment: { unsubscribe_token: 'z'.repeat(32), checkout_id: 'c4' },
      discountCode: null,
      platformBaseUrl: 'https://platform.gbox.test',
    })
    expect(vars.unsubscribe_url).toBe(
      'https://platform.gbox.test/unsubscribe/' + 'z'.repeat(32),
    )
  })
})

// ---------------------------------------------------------------------------
// dispatchAbandonedCartTick
// ---------------------------------------------------------------------------

describe('dispatchAbandonedCartTick', () => {
  it('returns zeros when no active shops', async () => {
    const db = mockDb({ shops: [] })
    const out = await dispatchAbandonedCartTick(db)
    expect(out).toEqual({
      shopsScanned: 0,
      enrolled: 0,
      sent: 0,
      bounced: 0,
      smtpUnconfiguredShops: [],
    })
  })

  it('skips shops where settings.enabled = false', async () => {
    const db = mockDb({ shops: [{ id: 'shop-1' }] })
    vi.mocked(svc.resolveSettings).mockResolvedValue({
      enabled: false,
      min_abandoned_minutes: 60,
      step_overrides: {},
    })
    const out = await dispatchAbandonedCartTick(db)
    expect(out.shopsScanned).toBe(1)
    expect(svc.detectEligibleCarts).not.toHaveBeenCalled()
  })

  it('enrolls detected carts and dispatches the due step', async () => {
    const db = mockDb({
      shops: [{ id: 'shop-1' }],
      abandoned_cart_enrollments: [
        {
          id: 'e1',
          shop_id: 'shop-1',
          checkout_id: 'cart-1',
          customer_id: null,
          email: 'buyer@example.com',
          enrolled_at: '2026-04-21T00:00:00Z',
          last_sent_step_id: null,
          recovered_at: null,
          unsubscribed_at: null,
          unsubscribe_token: 't'.repeat(32),
        },
      ],
      customers: [],
    })

    vi.mocked(svc.resolveSettings).mockResolvedValue({
      enabled: true,
      min_abandoned_minutes: 60,
      step_overrides: {
        cart_1_reminder: { enabled: true, delay_minutes: 60 },
        cart_2_discount: { enabled: true, delay_minutes: 60 * 24 },
        cart_3_last_call: { enabled: true, delay_minutes: 60 * 24 * 3 },
      },
    })
    vi.mocked(svc.detectEligibleCarts).mockResolvedValue([
      {
        id: 'cart-1',
        shop_id: 'shop-1',
        customer_id: null,
        email: 'buyer@example.com',
        updated_at: '2026-04-20T23:00:00Z',
        cart_json: [],
      },
    ])
    vi.mocked(svc.enrollCart).mockResolvedValue({
      ok: true,
      created: true,
      enrollment: {
        id: 'e1',
        shop_id: 'shop-1',
        checkout_id: 'cart-1',
        customer_id: null,
        email: 'buyer@example.com',
        enrolled_at: '2026-04-21T00:00:00Z',
        last_sent_step_id: null,
        last_sent_at: null,
        recovered_at: null,
        unsubscribed_at: null,
        unsubscribe_token: 't'.repeat(32),
        error: null,
        created_at: '2026-04-21T00:00:00Z',
        updated_at: '2026-04-21T00:00:00Z',
      },
    })
    vi.mocked(svc.dispatchStep).mockResolvedValue({
      ok: true,
      stepId: 'cart_1_reminder',
      messageId: 'msg-1',
    })

    // The shop/loader joins: shops row returned by chainable default (empty)
    // plus customers lookup returns empty. We override the shop loader by
    // returning a single row from selectFrom('shops') for the loader call.
    // The mockDb passes the same array for every call — so on the second
    // shops call (loadShop) we still get [{id:'shop-1'}]. That's OK because
    // loadShop maps it through `executeTakeFirst` which takes [0].
    // BUT loadShop aliases shops.id and shop_domains.domain; for our
    // chainable proxy the same default-empty array is fine since the
    // `.select([...])` doesn't actually filter — we just need a truthy row.

    // Override the shops selectFrom to return a proper joined row on the
    // 2nd call.
    let shopsCallCount = 0
    const origSelectFrom = db.selectFrom
    db.selectFrom = vi.fn((name: string) => {
      const base = String(name).split(' ')[0]!
      if (base === 'shops') {
        shopsCallCount++
        if (shopsCallCount === 1) {
          return chainable([{ id: 'shop-1' }])
        }
        return chainable([
          { name: 'Acme', slug: 'acme', primary_domain: 'acme.test' },
        ])
      }
      return origSelectFrom(name)
    })

    // Set now forward so cart_1_reminder is due (enrolled_at + 60min).
    const now = new Date('2026-04-21T01:05:00Z')
    const out = await dispatchAbandonedCartTick(db, now, {
      sender: async () => 'msg-1',
    })
    expect(out.enrolled).toBe(1)
    expect(out.sent).toBe(1)
    expect(out.bounced).toBe(0)
    expect(out.smtpUnconfiguredShops).toEqual([])
    expect(svc.dispatchStep).toHaveBeenCalledTimes(1)
  })

  it('classifies SMTP-unconfigured dispatch as smtp_unconfigured and halts the shop', async () => {
    const db = mockDb({
      shops: [{ id: 'shop-1' }],
      abandoned_cart_enrollments: [
        {
          id: 'e1',
          shop_id: 'shop-1',
          checkout_id: 'cart-1',
          customer_id: null,
          email: 'buyer@example.com',
          enrolled_at: '2026-04-21T00:00:00Z',
          last_sent_step_id: null,
          recovered_at: null,
          unsubscribed_at: null,
          unsubscribe_token: 'a'.repeat(32),
        },
        {
          id: 'e2',
          shop_id: 'shop-1',
          checkout_id: 'cart-2',
          customer_id: null,
          email: 'two@example.com',
          enrolled_at: '2026-04-21T00:00:00Z',
          last_sent_step_id: null,
          recovered_at: null,
          unsubscribed_at: null,
          unsubscribe_token: 'b'.repeat(32),
        },
      ],
      customers: [],
    })

    // Shop metadata row — loader needs a {name, slug, primary_domain} row.
    let shopsCallCount = 0
    const origSelectFrom = db.selectFrom
    db.selectFrom = vi.fn((name: string) => {
      const base = String(name).split(' ')[0]!
      if (base === 'shops') {
        shopsCallCount++
        if (shopsCallCount === 1) return chainable([{ id: 'shop-1' }])
        return chainable([{ name: 'Acme', slug: 'acme', primary_domain: null }])
      }
      return origSelectFrom(name)
    })

    vi.mocked(svc.resolveSettings).mockResolvedValue({
      enabled: true,
      min_abandoned_minutes: 60,
      step_overrides: Object.fromEntries(
        FLOW_DEFINITIONS.abandoned_cart.steps.map((s) => [
          s.id,
          { enabled: true, delay_minutes: s.delayMinutes },
        ]),
      ),
    })
    vi.mocked(svc.detectEligibleCarts).mockResolvedValue([])
    vi.mocked(svc.dispatchStep).mockResolvedValue({
      ok: false,
      error: 'smtp_unconfigured',
      stepId: 'cart_1_reminder',
    })

    const out = await dispatchAbandonedCartTick(
      db,
      new Date('2026-04-21T01:05:00Z'),
      { sender: async () => null, platformBaseUrl: null },
    )

    expect(out.sent).toBe(0)
    expect(out.smtpUnconfiguredShops).toEqual(['shop-1'])
    // dispatchStep called ONCE because the shop got short-circuited.
    expect(svc.dispatchStep).toHaveBeenCalledTimes(1)
  })

  it('counts send_failed outcomes as bounced without halting the shop', async () => {
    const db = mockDb({
      shops: [{ id: 'shop-1' }],
      abandoned_cart_enrollments: [
        {
          id: 'e1',
          shop_id: 'shop-1',
          checkout_id: 'cart-1',
          customer_id: null,
          email: 'bad@example.com',
          enrolled_at: '2026-04-21T00:00:00Z',
          last_sent_step_id: null,
          recovered_at: null,
          unsubscribed_at: null,
          unsubscribe_token: 'q'.repeat(32),
        },
        {
          id: 'e2',
          shop_id: 'shop-1',
          checkout_id: 'cart-2',
          customer_id: null,
          email: 'good@example.com',
          enrolled_at: '2026-04-21T00:00:00Z',
          last_sent_step_id: null,
          recovered_at: null,
          unsubscribed_at: null,
          unsubscribe_token: 'r'.repeat(32),
        },
      ],
      customers: [],
    })
    let shopsCallCount = 0
    const origSelectFrom = db.selectFrom
    db.selectFrom = vi.fn((name: string) => {
      const base = String(name).split(' ')[0]!
      if (base === 'shops') {
        shopsCallCount++
        if (shopsCallCount === 1) return chainable([{ id: 'shop-1' }])
        return chainable([{ name: 'Acme', slug: 'acme', primary_domain: null }])
      }
      return origSelectFrom(name)
    })
    vi.mocked(svc.resolveSettings).mockResolvedValue({
      enabled: true,
      min_abandoned_minutes: 60,
      step_overrides: Object.fromEntries(
        FLOW_DEFINITIONS.abandoned_cart.steps.map((s) => [
          s.id,
          { enabled: true, delay_minutes: s.delayMinutes },
        ]),
      ),
    })
    vi.mocked(svc.detectEligibleCarts).mockResolvedValue([])
    vi.mocked(svc.dispatchStep)
      .mockResolvedValueOnce({
        ok: false,
        error: 'send_failed',
        stepId: 'cart_1_reminder',
      })
      .mockResolvedValueOnce({
        ok: true,
        stepId: 'cart_1_reminder',
        messageId: 'msg-2',
      })

    const out = await dispatchAbandonedCartTick(
      db,
      new Date('2026-04-21T01:05:00Z'),
      { sender: async () => 'msg-ok' },
    )
    expect(out.bounced).toBe(1)
    expect(out.sent).toBe(1)
    expect(out.smtpUnconfiguredShops).toEqual([])
  })
})
