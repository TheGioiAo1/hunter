/**
 * Store-admin — abandoned-cart settings + send-now handlers (Phase 8 PR2d)
 *
 * Covers the HTTP surface of:
 *   • getAbandonedCartSettings renders stats + form + step cards
 *   • postAbandonedCartSettings parses form → setShopSettings → redirect ok
 *   • postAbandonedCartSettings disabled toggle (enabled=undefined)
 *   • postAbandonedCartSendNow not-found path
 *   • postAbandonedCartSendNow recovered short-circuit
 *   • postAbandonedCartSendNow unsubscribed short-circuit
 *   • postAbandonedCartSendNow happy: loads shop+customer, calls
 *     dispatchStep, redirects with ok + iron rule 5 message
 *   • postAbandonedCartSendNow SMTP-unconfigured → iron rule 5 message
 *     ("contact Gbox support") with NO mention of god-admin
 *   • postAbandonedCartSendNow send_failed → friendly bounce message
 *   • postAbandonedCartRunTick success + smtp-unconfigured branches
 *
 * Service layer (@gbox/core/modules/marketing/abandoned-cart.js) is
 * fully mocked — we test only the route handler's behaviour.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks (MUST come before SUT import) -----------------------------------

vi.mock('@gbox/core/modules/marketing/abandoned-cart.js', async () => {
  const actual = await vi.importActual<
    typeof import('@gbox/core/modules/marketing/abandoned-cart.js')
  >('@gbox/core/modules/marketing/abandoned-cart.js')
  return {
    // Keep the constants real so the form rendering uses the canonical
    // defaults (the test assertions then don't depend on mock minutiae).
    DEFAULT_ABANDONED_CART_SETTINGS: actual.DEFAULT_ABANDONED_CART_SETTINGS,
    computeRecoveryStats: vi.fn(),
    dispatchStep: vi.fn(),
    getEnrollment: vi.fn(),
    getEnrollmentByCheckout: vi.fn(),
    resolveSettings: vi.fn(),
    selectPendingStep: vi.fn(),
    setShopSettings: vi.fn(),
  }
})

vi.mock('@gbox/core/modules/marketing/abandoned-cart-cron.js', async () => {
  const actual = await vi.importActual<
    typeof import('@gbox/core/modules/marketing/abandoned-cart-cron.js')
  >('@gbox/core/modules/marketing/abandoned-cart-cron.js')
  return {
    ...actual,
    dispatchAbandonedCartTick: vi.fn(),
  }
})

vi.mock('@gbox/core/modules/email/service.js', () => ({
  sendEmail: vi.fn(),
}))

vi.mock('@gbox/core/modules/auth/csrf.js', () => ({
  csrfHiddenField: vi.fn(() => '<input type="hidden" name="_csrf" value="mock" />'),
}))

vi.mock('../middleware/store-auth.js', () => ({
  logSellerAction: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../lib/notify.js', () => ({
  notify: vi.fn(),
  byActor: (u: any) => (u?.name ? `By ${u.name}` : ''),
}))

vi.mock('../layouts/seller-layout.js', () => ({
  sellerLayout: vi.fn((opts: any) => `<html><title>${opts.title}</title>${opts.content}</html>`),
  esc: (s: unknown) => String(s ?? ''),
}))

import type { Request, Response } from 'express'
import {
  computeRecoveryStats,
  dispatchStep,
  getEnrollment,
  resolveSettings,
  setShopSettings,
  DEFAULT_ABANDONED_CART_SETTINGS,
} from '@gbox/core/modules/marketing/abandoned-cart.js'
import { dispatchAbandonedCartTick } from '@gbox/core/modules/marketing/abandoned-cart-cron.js'
import {
  getAbandonedCartSettings,
  postAbandonedCartSettings,
  postAbandonedCartSendNow,
  postAbandonedCartRunTick,
} from './abandoned-cart-settings.js'

// --- Fixtures --------------------------------------------------------------

const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const SHOP_SLUG = 'test-shop'
const ENROLLMENT_ID = '22222222-2222-2222-2222-222222222222'
const USER_ID = '66666666-6666-6666-6666-666666666666'
const TOKEN_32 = 'a'.repeat(32)

function makeReq(
  body: Record<string, unknown> = {},
  params: Record<string, string> = {},
  query: Record<string, string> = {},
): Request {
  return {
    body,
    query,
    params: { slug: SHOP_SLUG, ...params },
    store: { id: SHOP_ID, slug: SHOP_SLUG, name: 'Test Shop' },
    storeUser: {
      id: USER_ID,
      name: 'Thai Admin',
      email: 'thai@example.com',
      role: 'owner',
      storeRole: 'owner',
    },
    csrfToken: 'mock-token',
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request
}

function makeRes() {
  const redirect = vi.fn()
  const status = vi.fn().mockReturnThis()
  const send = vi.fn()
  return { redirect, status, send } as unknown as Response & {
    redirect: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
    status: ReturnType<typeof vi.fn>
  }
}

/**
 * Minimal db harness for the send-now handler's shops/customers reads.
 * Returns scripted rows keyed by the first argument to `selectFrom`.
 */
function makeDb(scripts: Record<string, any> = {}) {
  const chainable = (result: any): any => {
    const h: any = {}
    const methods = [
      'selectFrom',
      'select',
      'selectAll',
      'where',
      'leftJoin',
      'innerJoin',
      'limit',
      'orderBy',
      'groupBy',
      'offset',
    ]
    for (const m of methods) h[m] = vi.fn().mockReturnValue(h)
    h.execute = vi.fn().mockResolvedValue(Array.isArray(result) ? result : [result])
    h.executeTakeFirst = vi
      .fn()
      .mockResolvedValue(Array.isArray(result) ? (result[0] ?? null) : result)
    h.executeTakeFirstOrThrow = vi.fn().mockResolvedValue(
      Array.isArray(result) ? (result[0] ?? {}) : (result ?? {}),
    )
    return h
  }
  return {
    selectFrom: vi.fn((name: string) => {
      const base = String(name).split(' ')[0]!
      return chainable(scripts[base] ?? null)
    }),
    updateTable: vi.fn().mockReturnValue(chainable(null)),
    insertInto: vi.fn().mockReturnValue(chainable(null)),
    deleteFrom: vi.fn().mockReturnValue(chainable(null)),
    fn: { count: () => ({ as: () => ({}) }) },
  } as any
}

const enrollmentRow = (overrides: Partial<any> = {}) => ({
  id: ENROLLMENT_ID,
  shop_id: SHOP_ID,
  checkout_id: 'cart-1',
  customer_id: null as string | null,
  email: 'buyer@example.com',
  enrolled_at: '2026-04-21T00:00:00Z',
  last_sent_step_id: null as string | null,
  last_sent_at: null as string | null,
  recovered_at: null as string | null,
  unsubscribed_at: null as string | null,
  unsubscribe_token: TOKEN_32,
  error: null as string | null,
  created_at: '2026-04-21T00:00:00Z',
  updated_at: '2026-04-21T00:00:00Z',
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// GET /marketing/abandoned/settings
// ---------------------------------------------------------------------------

describe('getAbandonedCartSettings', () => {
  it('renders stats + form + all step cards', async () => {
    vi.mocked(resolveSettings).mockResolvedValue({
      enabled: true,
      min_abandoned_minutes: 120,
      step_overrides: {
        cart_1_reminder: { enabled: true, delay_minutes: 60 },
        cart_2_discount: { enabled: false, delay_minutes: 60 * 24 },
        cart_3_last_call: { enabled: true, delay_minutes: 60 * 24 * 3 },
      },
    })
    vi.mocked(computeRecoveryStats).mockResolvedValue({
      enrolled: 50,
      recovered: 10,
      rate: 0.2,
    })

    const req = makeReq({}, {}, {})
    const res = makeRes()
    await getAbandonedCartSettings(req, res, makeDb())

    expect(res.send).toHaveBeenCalledTimes(1)
    const html = String(res.send.mock.calls[0]![0])
    expect(html).toContain('Recovery flow settings')
    expect(html).toContain('20.0%') // rate
    expect(html).toContain('50') // enrolled
    expect(html).toContain('10') // recovered
    expect(html).toContain('value="120"') // min_abandoned_minutes
    // All three step cards rendered.
    expect(html).toContain('cart_1_reminder')
    expect(html).toContain('cart_2_discount')
    expect(html).toContain('cart_3_last_call')
    // Disabled discount step → checkbox not checked
    const discountSection = html.split('cart_2_discount')[1] ?? ''
    expect(discountSection.slice(0, 500)).not.toContain('checked')
  })

  it('shows ok flash when ?ok= present', async () => {
    vi.mocked(resolveSettings).mockResolvedValue(DEFAULT_ABANDONED_CART_SETTINGS)
    vi.mocked(computeRecoveryStats).mockResolvedValue({
      enrolled: 0,
      recovered: 0,
      rate: 0,
    })
    const req = makeReq({}, {}, { ok: encodeURIComponent('Saved!') })
    const res = makeRes()
    await getAbandonedCartSettings(req, res, makeDb())
    const html = String(res.send.mock.calls[0]![0])
    expect(html).toContain('alert-success')
    expect(html).toContain('Saved!')
  })
})

// ---------------------------------------------------------------------------
// POST /marketing/abandoned/settings
// ---------------------------------------------------------------------------

describe('postAbandonedCartSettings', () => {
  it('parses form and calls setShopSettings with clamped values, redirects ok', async () => {
    vi.mocked(setShopSettings).mockResolvedValue({} as any)

    const req = makeReq({
      enabled: '1',
      min_abandoned_minutes: '90',
      step_cart_1_reminder_enabled: '1',
      step_cart_1_reminder_delay: '30',
      step_cart_2_discount_enabled: '1',
      step_cart_2_discount_delay: '1440',
      // cart_3 enabled checkbox intentionally MISSING → disabled
      step_cart_3_last_call_delay: '4320',
    })
    const res = makeRes()
    await postAbandonedCartSettings(req, res, makeDb())

    expect(setShopSettings).toHaveBeenCalledTimes(1)
    const [, shopId, settings] = vi.mocked(setShopSettings).mock.calls[0]!
    expect(shopId).toBe(SHOP_ID)
    expect(settings.enabled).toBe(true)
    expect(settings.min_abandoned_minutes).toBe(90)
    expect(settings.step_overrides.cart_1_reminder).toEqual({
      enabled: true,
      delay_minutes: 30,
    })
    expect(settings.step_overrides.cart_2_discount).toEqual({
      enabled: true,
      delay_minutes: 1440,
    })
    // cart_3 checkbox missing → disabled
    expect(settings.step_overrides.cart_3_last_call!.enabled).toBe(false)
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('/marketing/abandoned/settings?ok='),
    )
  })

  it('clamps threshold to sensible bounds (10..10080)', async () => {
    vi.mocked(setShopSettings).mockResolvedValue({} as any)

    // Too small
    let req = makeReq({ min_abandoned_minutes: '2' })
    let res = makeRes()
    await postAbandonedCartSettings(req, res, makeDb())
    let settings = vi.mocked(setShopSettings).mock.calls[0]![2]
    expect(settings.min_abandoned_minutes).toBe(10)

    vi.clearAllMocks()
    vi.mocked(setShopSettings).mockResolvedValue({} as any)

    // Too large — one year
    req = makeReq({ min_abandoned_minutes: String(60 * 24 * 365) })
    res = makeRes()
    await postAbandonedCartSettings(req, res, makeDb())
    settings = vi.mocked(setShopSettings).mock.calls[0]![2]
    expect(settings.min_abandoned_minutes).toBe(60 * 24 * 7)
  })

  it('disabled toggle turns the flow off (enabled field missing)', async () => {
    vi.mocked(setShopSettings).mockResolvedValue({} as any)

    const req = makeReq({
      // enabled: missing → unchecked
      min_abandoned_minutes: '60',
    })
    const res = makeRes()
    await postAbandonedCartSettings(req, res, makeDb())
    const settings = vi.mocked(setShopSettings).mock.calls[0]![2]
    expect(settings.enabled).toBe(false)
  })

  it('redirects with error on exception', async () => {
    vi.mocked(setShopSettings).mockRejectedValue(new Error('db down'))

    const req = makeReq({ enabled: '1', min_abandoned_minutes: '60' })
    const res = makeRes()
    await postAbandonedCartSettings(req, res, makeDb())
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('/marketing/abandoned/settings?err='),
    )
    const redirectUrl = String(res.redirect.mock.calls[0]![0])
    // Iron rule 5 — message must NOT mention god-admin / internal paths.
    // The URL's base path naturally contains "admin" (admin dashboard),
    // so strip the path and only inspect the ?err= message.
    const errMsgDecoded = decodeURIComponent(
      redirectUrl.split('?err=')[1] ?? '',
    ).toLowerCase()
    expect(errMsgDecoded).not.toContain('god')
    expect(errMsgDecoded).not.toContain('god admin')
    expect(errMsgDecoded).not.toContain('platform_settings')
    expect(errMsgDecoded).not.toContain('smtp_host')
  })
})

// ---------------------------------------------------------------------------
// POST /marketing/abandoned/:enrollmentId/send-now
// ---------------------------------------------------------------------------

describe('postAbandonedCartSendNow', () => {
  it('redirects with error when enrolment not found', async () => {
    vi.mocked(getEnrollment).mockResolvedValue(null)
    const req = makeReq({}, { enrollmentId: ENROLLMENT_ID })
    const res = makeRes()
    await postAbandonedCartSendNow(req, res, makeDb())
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('err='),
    )
    expect(dispatchStep).not.toHaveBeenCalled()
  })

  it('short-circuits when enrolment already recovered', async () => {
    vi.mocked(getEnrollment).mockResolvedValue(
      enrollmentRow({ recovered_at: '2026-04-21T02:00:00Z' }),
    )
    const req = makeReq({}, { enrollmentId: ENROLLMENT_ID })
    const res = makeRes()
    await postAbandonedCartSendNow(req, res, makeDb())
    const url = String(res.redirect.mock.calls[0]![0])
    expect(url).toContain('err=')
    expect(decodeURIComponent(url)).toContain('already been recovered')
    expect(dispatchStep).not.toHaveBeenCalled()
  })

  it('short-circuits when shopper unsubscribed', async () => {
    vi.mocked(getEnrollment).mockResolvedValue(
      enrollmentRow({ unsubscribed_at: '2026-04-21T02:00:00Z' }),
    )
    const req = makeReq({}, { enrollmentId: ENROLLMENT_ID })
    const res = makeRes()
    await postAbandonedCartSendNow(req, res, makeDb())
    const url = decodeURIComponent(String(res.redirect.mock.calls[0]![0]))
    expect(url).toContain('unsubscribed')
    expect(dispatchStep).not.toHaveBeenCalled()
  })

  it('dispatches the NEXT step (bypassing delay) when last_sent_step_id is null', async () => {
    vi.mocked(getEnrollment).mockResolvedValue(enrollmentRow())
    vi.mocked(resolveSettings).mockResolvedValue(DEFAULT_ABANDONED_CART_SETTINGS)
    vi.mocked(dispatchStep).mockResolvedValue({
      ok: true,
      stepId: 'cart_1_reminder',
      messageId: 'msg-1',
    })

    const db = makeDb({
      shops: [
        { name: 'Acme', slug: 'acme', primary_domain: 'acme.test' },
      ],
    })

    const req = makeReq({}, { enrollmentId: ENROLLMENT_ID })
    const res = makeRes()
    await postAbandonedCartSendNow(req, res, db)

    expect(dispatchStep).toHaveBeenCalledTimes(1)
    const [, shopId, enrollmentId, step] = vi.mocked(dispatchStep).mock.calls[0]!
    expect(shopId).toBe(SHOP_ID)
    expect(enrollmentId).toBe(ENROLLMENT_ID)
    expect(step.id).toBe('cart_1_reminder')
    const url = decodeURIComponent(String(res.redirect.mock.calls[0]![0]))
    expect(url).toContain('ok=')
    expect(url).toContain('Reminder email')
  })

  it('advances to the next step when prior step was already sent', async () => {
    vi.mocked(getEnrollment).mockResolvedValue(
      enrollmentRow({
        last_sent_step_id: 'cart_1_reminder',
        last_sent_at: '2026-04-21T01:00:00Z',
      }),
    )
    vi.mocked(resolveSettings).mockResolvedValue(DEFAULT_ABANDONED_CART_SETTINGS)
    vi.mocked(dispatchStep).mockResolvedValue({
      ok: true,
      stepId: 'cart_2_discount',
      messageId: 'msg-2',
    })

    const req = makeReq({}, { enrollmentId: ENROLLMENT_ID })
    const res = makeRes()
    await postAbandonedCartSendNow(req, res, makeDb({ shops: [{ name: 'Acme', slug: 'acme', primary_domain: null }] }))
    const step = vi.mocked(dispatchStep).mock.calls[0]![3]
    expect(step.id).toBe('cart_2_discount')
  })

  it('reports no-more-steps when last step already sent', async () => {
    vi.mocked(getEnrollment).mockResolvedValue(
      enrollmentRow({ last_sent_step_id: 'cart_3_last_call' }),
    )
    vi.mocked(resolveSettings).mockResolvedValue(DEFAULT_ABANDONED_CART_SETTINGS)

    const req = makeReq({}, { enrollmentId: ENROLLMENT_ID })
    const res = makeRes()
    await postAbandonedCartSendNow(req, res, makeDb())
    const url = decodeURIComponent(String(res.redirect.mock.calls[0]![0]))
    expect(url).toContain('No more recovery steps')
    expect(dispatchStep).not.toHaveBeenCalled()
  })

  it('IRON RULE 5: SMTP-unconfigured surfaces as "contact Gbox support" with NO god-admin leak', async () => {
    vi.mocked(getEnrollment).mockResolvedValue(enrollmentRow())
    vi.mocked(resolveSettings).mockResolvedValue(DEFAULT_ABANDONED_CART_SETTINGS)
    vi.mocked(dispatchStep).mockResolvedValue({
      ok: false,
      error: 'smtp_unconfigured',
      stepId: 'cart_1_reminder',
    })

    const req = makeReq({}, { enrollmentId: ENROLLMENT_ID })
    const res = makeRes()
    await postAbandonedCartSendNow(
      req,
      res,
      makeDb({ shops: [{ name: 'Acme', slug: 'acme', primary_domain: null }] }),
    )

    const url = String(res.redirect.mock.calls[0]![0])
    const decoded = decodeURIComponent(url).toLowerCase()
    expect(decoded).toContain('gbox support')
    expect(decoded).not.toContain('god admin')
    expect(decoded).not.toContain('god_admin')
    expect(decoded).not.toContain('smtp')
    expect(decoded).not.toContain('platform_settings')
  })

  it('send_failed maps to merchant-friendly bounce message', async () => {
    vi.mocked(getEnrollment).mockResolvedValue(enrollmentRow())
    vi.mocked(resolveSettings).mockResolvedValue(DEFAULT_ABANDONED_CART_SETTINGS)
    vi.mocked(dispatchStep).mockResolvedValue({
      ok: false,
      error: 'send_failed',
      stepId: 'cart_1_reminder',
    })

    const req = makeReq({}, { enrollmentId: ENROLLMENT_ID })
    const res = makeRes()
    await postAbandonedCartSendNow(
      req,
      res,
      makeDb({ shops: [{ name: 'Acme', slug: 'acme', primary_domain: null }] }),
    )
    const url = decodeURIComponent(String(res.redirect.mock.calls[0]![0]))
    expect(url).toContain('could not be delivered')
  })
})

// ---------------------------------------------------------------------------
// POST /marketing/abandoned/run-tick
// ---------------------------------------------------------------------------

describe('postAbandonedCartRunTick', () => {
  it('runs the tick and redirects with ok counters', async () => {
    vi.mocked(dispatchAbandonedCartTick).mockResolvedValue({
      shopsScanned: 1,
      enrolled: 3,
      sent: 2,
      bounced: 0,
      smtpUnconfiguredShops: [],
    })
    const req = makeReq({})
    const res = makeRes()
    await postAbandonedCartRunTick(req, res, makeDb())
    const url = decodeURIComponent(String(res.redirect.mock.calls[0]![0]))
    expect(url).toContain('Tick complete')
    expect(url).toContain('enrolled 3')
    expect(url).toContain('sent 2')
  })

  it('IRON RULE 5: SMTP-unconfigured for THIS shop → "contact Gbox support" (no god-admin leak)', async () => {
    vi.mocked(dispatchAbandonedCartTick).mockResolvedValue({
      shopsScanned: 1,
      enrolled: 0,
      sent: 0,
      bounced: 0,
      smtpUnconfiguredShops: [SHOP_ID],
    })
    const req = makeReq({})
    const res = makeRes()
    await postAbandonedCartRunTick(req, res, makeDb())
    const url = decodeURIComponent(String(res.redirect.mock.calls[0]![0])).toLowerCase()
    expect(url).toContain('gbox support')
    expect(url).not.toContain('god admin')
    expect(url).not.toContain('smtp')
  })

  it('redirects with err on thrown exception', async () => {
    vi.mocked(dispatchAbandonedCartTick).mockRejectedValue(new Error('db down'))
    const req = makeReq({})
    const res = makeRes()
    await postAbandonedCartRunTick(req, res, makeDb())
    const url = decodeURIComponent(String(res.redirect.mock.calls[0]![0])).toLowerCase()
    expect(url).toContain('err=')
    expect(url).toContain('contact gbox support')
  })
})
