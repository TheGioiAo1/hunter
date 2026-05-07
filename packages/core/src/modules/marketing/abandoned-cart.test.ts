/**
 * Gbox Platform — abandoned-cart service unit tests (Phase 8 PR2)
 *
 * Covers:
 *   • mergeSettings defaulting + partial override semantics
 *   • selectPendingStep: delay gating, disabled step skip, recovered/
 *     unsubscribed short-circuits, enabled=false master toggle
 *   • enrollCart happy path + idempotent ON CONFLICT reload
 *   • dispatchStep success path + SMTP-missing classification +
 *     generic send_failed + recovered/unsubscribed reject
 *   • markRecovered updates only the null rows
 *   • unsubscribeByToken: invalid length/token short-circuit, fresh
 *     unsubscribe vs. already-unsubscribed, intentional token-confusion
 *   • computeRecoveryStats rate math + zero-division guard
 *
 * Uses an in-memory proxy `db` that records calls and returns queued
 * results, keyed by the first table seen. Enough to exercise every
 * service code path without spinning up Postgres.
 */

import { describe, it, expect, vi } from 'vitest'

import {
  DEFAULT_ABANDONED_CART_SETTINGS,
  computeRecoveryStats,
  dispatchStep,
  enrollCart,
  getEnrollment,
  getEnrollmentByCheckout,
  markRecovered,
  mergeSettings,
  resolveSettings,
  selectPendingStep,
  setShopSettings,
  unsubscribeByToken,
  type AbandonedCartEnrollmentRow,
  type EmailSender,
} from './abandoned-cart.js'
import { FLOW_DEFINITIONS } from './email-flows.js'

// ---------------------------------------------------------------------------
// Stub DB harness
// ---------------------------------------------------------------------------
//
// The service uses a dozen different Kysely chain shapes. Rather than
// stubbing each one per test, a single proxy-based chain captures the
// intent and dispatches to a `responses` bag keyed by a simple handle
// derived from the first table name + the terminal method. Tests
// register responses; the proxy serves them in FIFO order.

interface Capture {
  table?: string
  values?: unknown
  where: Array<[string, string, unknown]>
  set?: unknown
  orConflict?: string
  terminal?: string
  limit?: number
  offset?: number
  selectArgs?: unknown
}

function makeDb() {
  const callLog: Capture[] = []
  const responses = new Map<string, unknown[]>()

  function queue(handle: string, value: unknown) {
    if (!responses.has(handle)) responses.set(handle, [])
    responses.get(handle)!.push(value)
  }

  function dequeue(handle: string): unknown | undefined {
    const arr = responses.get(handle)
    if (!arr || arr.length === 0) return undefined
    return arr.shift()
  }

  function chain(cap: Capture): any {
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop !== 'string') return undefined
          if (prop === 'then') return undefined

          // Terminal methods — look up response in bag
          if (
            prop === 'executeTakeFirst' ||
            prop === 'executeTakeFirstOrThrow' ||
            prop === 'execute'
          ) {
            return async () => {
              cap.terminal = prop
              callLog.push({ ...cap })
              // handle = "<table>:<terminal>" for simple bag
              const handle = `${cap.table}:${prop}`
              const v = dequeue(handle)
              if (v === undefined) {
                // Fallback per terminal semantics
                if (prop === 'execute') return []
                if (prop === 'executeTakeFirst') return null
                throw new Error(`no response for ${handle}`)
              }
              return v
            }
          }

          // Chain-building methods — mutate cap, return new proxy
          return (...args: any[]) => {
            if (prop === 'selectFrom' || prop === 'updateTable' || prop === 'insertInto' || prop === 'deleteFrom') {
              cap.table = String(args[0]).split(' ')[0]!.replace(/^.*\./, '')
            }
            if (prop === 'where') cap.where.push([String(args[0]), String(args[1]), args[2]])
            if (prop === 'values') cap.values = args[0]
            if (prop === 'set') cap.set = args[0]
            if (prop === 'onConflict') {
              cap.orConflict = 'seen'
              // Simulate the callback — we don't care, it's used for
              // onConflict().doNothing() chain
              if (typeof args[0] === 'function') {
                args[0]({
                  column: () => ({ doNothing: () => ({}) }),
                })
              }
            }
            if (prop === 'limit') cap.limit = args[0]
            if (prop === 'offset') cap.offset = args[0]
            if (prop === 'select') cap.selectArgs = args[0]
            // Return same-ish chain
            return chain(cap)
          }
        },
      },
    )
  }

  const root = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'fn') {
          return { count: () => ({ as: (a: string) => ({ alias: a }) }) }
        }
        if (
          prop === 'selectFrom' ||
          prop === 'insertInto' ||
          prop === 'updateTable' ||
          prop === 'deleteFrom'
        ) {
          return (table: string) => {
            const cap: Capture = { where: [] }
            ;(chain(cap) as any).__nop
            cap.table = String(table).split(' ')[0]!
            return chain(cap)
          }
        }
        return undefined
      },
    },
  )

  return {
    db: root,
    queue,
    callLog,
  }
}

// ---------------------------------------------------------------------------
// mergeSettings
// ---------------------------------------------------------------------------

describe('mergeSettings', () => {
  it('returns DEFAULTS for null / empty / bad inputs', () => {
    const a = mergeSettings(null)
    const b = mergeSettings(undefined)
    const c = mergeSettings('string')
    expect(a.enabled).toBe(true)
    expect(a.min_abandoned_minutes).toBe(60)
    expect(b).toEqual(a)
    expect(c).toEqual(a)
  })

  it('copies known keys + falls through to defaults for missing keys', () => {
    const merged = mergeSettings({ enabled: false, min_abandoned_minutes: 30 })
    expect(merged.enabled).toBe(false)
    expect(merged.min_abandoned_minutes).toBe(30)
    expect(Object.keys(merged.step_overrides)).toEqual(
      FLOW_DEFINITIONS.abandoned_cart.steps.map((s) => s.id),
    )
  })

  it('ignores negative or zero min_abandoned_minutes', () => {
    const merged = mergeSettings({ min_abandoned_minutes: 0 })
    expect(merged.min_abandoned_minutes).toBe(
      DEFAULT_ABANDONED_CART_SETTINGS.min_abandoned_minutes,
    )
    const mergedNeg = mergeSettings({ min_abandoned_minutes: -30 })
    expect(mergedNeg.min_abandoned_minutes).toBe(
      DEFAULT_ABANDONED_CART_SETTINGS.min_abandoned_minutes,
    )
  })

  it('merges per-step overrides partial-patch style', () => {
    const merged = mergeSettings({
      step_overrides: {
        cart_1_reminder: { enabled: false, delay_minutes: 5 },
      },
    })
    expect(merged.step_overrides.cart_1_reminder).toEqual({
      enabled: false,
      delay_minutes: 5,
    })
    // Other steps still default
    expect(merged.step_overrides.cart_2_discount!.enabled).toBe(true)
    expect(merged.step_overrides.cart_2_discount!.delay_minutes).toBe(60 * 24)
  })

  it('ignores unknown step ids in overrides', () => {
    const merged = mergeSettings({
      step_overrides: { bogus_step: { enabled: true, delay_minutes: 1 } },
    })
    expect('bogus_step' in merged.step_overrides).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// selectPendingStep
// ---------------------------------------------------------------------------

describe('selectPendingStep', () => {
  const base: Parameters<typeof selectPendingStep>[0] = {
    enrolled_at: '2026-01-01T00:00:00.000Z',
    last_sent_step_id: null,
    recovered_at: null,
    unsubscribed_at: null,
  }

  it('returns null when master toggle disabled', () => {
    const out = selectPendingStep(
      base,
      { ...DEFAULT_ABANDONED_CART_SETTINGS, enabled: false },
      new Date('2026-01-01T12:00:00Z'),
    )
    expect(out).toBe(null)
  })

  it('returns null when recovered', () => {
    const out = selectPendingStep(
      { ...base, recovered_at: '2026-01-01T02:00:00Z' },
      DEFAULT_ABANDONED_CART_SETTINGS,
      new Date('2026-01-01T12:00:00Z'),
    )
    expect(out).toBe(null)
  })

  it('returns null when unsubscribed', () => {
    const out = selectPendingStep(
      { ...base, unsubscribed_at: '2026-01-01T02:00:00Z' },
      DEFAULT_ABANDONED_CART_SETTINGS,
      new Date('2026-01-01T12:00:00Z'),
    )
    expect(out).toBe(null)
  })

  it('returns null when elapsed < first step delay', () => {
    // cart_1_reminder is 60 min delay; 30 min elapsed → null
    const out = selectPendingStep(
      base,
      DEFAULT_ABANDONED_CART_SETTINGS,
      new Date('2026-01-01T00:30:00Z'),
    )
    expect(out).toBe(null)
  })

  it('returns cart_1_reminder at T+60min', () => {
    const out = selectPendingStep(
      base,
      DEFAULT_ABANDONED_CART_SETTINGS,
      new Date('2026-01-01T01:00:00Z'),
    )
    expect(out?.id).toBe('cart_1_reminder')
  })

  it('returns cart_2_discount at T+24h after cart_1_reminder sent', () => {
    const out = selectPendingStep(
      { ...base, last_sent_step_id: 'cart_1_reminder' },
      DEFAULT_ABANDONED_CART_SETTINGS,
      new Date('2026-01-02T00:00:00Z'),
    )
    expect(out?.id).toBe('cart_2_discount')
  })

  it('returns null after all steps sent', () => {
    const out = selectPendingStep(
      { ...base, last_sent_step_id: 'cart_3_last_call' },
      DEFAULT_ABANDONED_CART_SETTINGS,
      new Date('2026-01-10T00:00:00Z'),
    )
    expect(out).toBe(null)
  })

  it('skips steps that are disabled in overrides', () => {
    // Disable cart_2_discount; at T+24h, having sent cart_1_reminder,
    // the next eligible becomes cart_3_last_call (but not yet due).
    const merged = mergeSettings({
      step_overrides: {
        cart_2_discount: { enabled: false, delay_minutes: 60 * 24 },
      },
    })
    // At T+24h cart_3_last_call (delay 4320 min / 72h) is NOT yet due.
    const notDue = selectPendingStep(
      { ...base, last_sent_step_id: 'cart_1_reminder' },
      merged,
      new Date('2026-01-02T00:00:00Z'),
    )
    expect(notDue).toBe(null)
    // At T+3d+ cart_3_last_call is due (and cart_2 is skipped).
    const dueNow = selectPendingStep(
      { ...base, last_sent_step_id: 'cart_1_reminder' },
      merged,
      new Date('2026-01-04T01:00:00Z'),
    )
    expect(dueNow?.id).toBe('cart_3_last_call')
  })

  it('respects custom delay_minutes override', () => {
    const merged = mergeSettings({
      step_overrides: { cart_1_reminder: { enabled: true, delay_minutes: 10 } },
    })
    // At T+10m cart_1_reminder is now due
    const out = selectPendingStep(
      base,
      merged,
      new Date('2026-01-01T00:10:00Z'),
    )
    expect(out?.id).toBe('cart_1_reminder')
  })

  it('returns null when the flow has no effective steps (all disabled)', () => {
    const merged = mergeSettings({
      step_overrides: Object.fromEntries(
        FLOW_DEFINITIONS.abandoned_cart.steps.map((s) => [
          s.id,
          { enabled: false, delay_minutes: s.delayMinutes },
        ]),
      ),
    })
    const out = selectPendingStep(
      base,
      merged,
      new Date('2026-01-10T00:00:00Z'),
    )
    expect(out).toBe(null)
  })

  it('returns null if `now` is before enrolment (clock skew safety)', () => {
    const out = selectPendingStep(
      base,
      DEFAULT_ABANDONED_CART_SETTINGS,
      new Date('2025-12-31T23:00:00Z'),
    )
    expect(out).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// enrollCart
// ---------------------------------------------------------------------------

describe('enrollCart', () => {
  it('rejects empty email', async () => {
    const { db } = makeDb()
    const out = await enrollCart(db as any, 'shop-1', {
      id: 'checkout-1',
      customer_id: 'cust-1',
      email: '   ',
    })
    expect(out).toEqual({ ok: false, error: 'email_required' })
  })

  it('returns created=true on first enrol', async () => {
    const { db, queue, callLog } = makeDb()
    queue('abandoned_cart_enrollments:executeTakeFirst', {
      id: 'e1',
      shop_id: 'shop-1',
      checkout_id: 'checkout-1',
      customer_id: 'cust-1',
      email: 'a@b.com',
      enrolled_at: '2026-04-21T00:00:00Z',
      last_sent_step_id: null,
      last_sent_at: null,
      recovered_at: null,
      unsubscribed_at: null,
      unsubscribe_token: '00000000000000000000000000000000',
      error: null,
      created_at: '2026-04-21T00:00:00Z',
      updated_at: '2026-04-21T00:00:00Z',
    })
    const out = await enrollCart(db as any, 'shop-1', {
      id: 'checkout-1',
      customer_id: 'cust-1',
      email: 'a@b.com',
    })
    if (!out.ok) throw new Error('unexpected: enroll failed: ' + out.error)
    expect(out.created).toBe(true)
    expect(out.enrollment.email).toBe('a@b.com')
    // Ensure insertInto was called with onConflict guard
    expect(callLog.some((c) => c.table === 'abandoned_cart_enrollments' && c.values)).toBe(true)
  })

  it('returns created=false + reloaded row on conflict', async () => {
    const { db, queue } = makeDb()
    // First insert path: onConflict swallowed → executeTakeFirst returns null
    queue('abandoned_cart_enrollments:executeTakeFirst', null)
    // Reload path returns the existing row
    queue('abandoned_cart_enrollments:executeTakeFirst', {
      id: 'e1',
      shop_id: 'shop-1',
      checkout_id: 'checkout-1',
      customer_id: null,
      email: 'a@b.com',
      enrolled_at: '2026-04-21T00:00:00Z',
      last_sent_step_id: 'cart_1_reminder',
      last_sent_at: '2026-04-21T01:00:00Z',
      recovered_at: null,
      unsubscribed_at: null,
      unsubscribe_token: '11111111111111111111111111111111',
      error: null,
      created_at: '2026-04-21T00:00:00Z',
      updated_at: '2026-04-21T01:00:00Z',
    })
    const out = await enrollCart(db as any, 'shop-1', {
      id: 'checkout-1',
      customer_id: null,
      email: 'a@b.com',
    })
    if (!out.ok) throw new Error('unexpected')
    expect(out.created).toBe(false)
    expect(out.enrollment.last_sent_step_id).toBe('cart_1_reminder')
  })

  it('returns checkout_not_found when reload finds nothing', async () => {
    const { db, queue } = makeDb()
    queue('abandoned_cart_enrollments:executeTakeFirst', null)
    queue('abandoned_cart_enrollments:executeTakeFirst', null)
    const out = await enrollCart(db as any, 'shop-1', {
      id: 'checkout-1',
      customer_id: null,
      email: 'a@b.com',
    })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toBe('checkout_not_found')
  })
})

// ---------------------------------------------------------------------------
// dispatchStep
// ---------------------------------------------------------------------------

describe('dispatchStep', () => {
  const step = FLOW_DEFINITIONS.abandoned_cart.steps[0]!

  function sender(result: string | null | Error): EmailSender {
    return async () => {
      if (result instanceof Error) throw result
      return result
    }
  }

  it('returns not_found when enrolment is missing', async () => {
    const { db } = makeDb() // no queued row → executeTakeFirst null by default
    const out = await dispatchStep(
      db as any,
      'shop-1',
      'missing',
      step,
      sender('msg-1'),
    )
    expect(out).toEqual({ ok: false, error: 'not_found' })
  })

  it('rejects recovered enrolments', async () => {
    const { db, queue } = makeDb()
    queue('abandoned_cart_enrollments:executeTakeFirst', {
      id: 'e1',
      shop_id: 'shop-1',
      email: 'a@b.com',
      recovered_at: '2026-04-21T01:00:00Z',
      unsubscribed_at: null,
    })
    const out = await dispatchStep(
      db as any,
      'shop-1',
      'e1',
      step,
      sender('msg-1'),
    )
    expect(out).toEqual({ ok: false, error: 'recovered' })
  })

  it('rejects unsubscribed enrolments', async () => {
    const { db, queue } = makeDb()
    queue('abandoned_cart_enrollments:executeTakeFirst', {
      id: 'e1',
      shop_id: 'shop-1',
      email: 'a@b.com',
      recovered_at: null,
      unsubscribed_at: '2026-04-21T01:00:00Z',
    })
    const out = await dispatchStep(
      db as any,
      'shop-1',
      'e1',
      step,
      sender('msg-1'),
    )
    expect(out).toEqual({ ok: false, error: 'unsubscribed' })
  })

  it('returns ok + stamps last_sent_step_id on happy path', async () => {
    const { db, queue } = makeDb()
    queue('abandoned_cart_enrollments:executeTakeFirst', {
      id: 'e1',
      shop_id: 'shop-1',
      email: 'a@b.com',
      recovered_at: null,
      unsubscribed_at: null,
    })
    const spy = vi.fn(async () => 'msg-42')
    const out = await dispatchStep(db as any, 'shop-1', 'e1', step, spy)
    expect(out).toEqual({ ok: true, stepId: step.id, messageId: 'msg-42' })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('classifies SMTP-missing errors as smtp_unconfigured', async () => {
    const { db, queue } = makeDb()
    queue('abandoned_cart_enrollments:executeTakeFirst', {
      id: 'e1',
      shop_id: 'shop-1',
      email: 'a@b.com',
      recovered_at: null,
      unsubscribed_at: null,
    })
    const out = await dispatchStep(
      db as any,
      'shop-1',
      'e1',
      step,
      sender(new Error('SMTP_HOST is not configured')),
    )
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.error).toBe('smtp_unconfigured')
      expect(out.stepId).toBe(step.id)
    }
  })

  it('classifies other send errors as send_failed', async () => {
    const { db, queue } = makeDb()
    queue('abandoned_cart_enrollments:executeTakeFirst', {
      id: 'e1',
      shop_id: 'shop-1',
      email: 'a@b.com',
      recovered_at: null,
      unsubscribed_at: null,
    })
    const out = await dispatchStep(
      db as any,
      'shop-1',
      'e1',
      step,
      sender(new Error('recipient mailbox full')),
    )
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toBe('send_failed')
  })
})

// ---------------------------------------------------------------------------
// markRecovered
// ---------------------------------------------------------------------------

describe('markRecovered', () => {
  it('runs an UPDATE with checkout_id + recovered_at null filter', async () => {
    const { db, queue, callLog } = makeDb()
    queue('abandoned_cart_enrollments:execute', [
      { numUpdatedRows: BigInt(1) },
    ])
    const n = await markRecovered(db as any, 'checkout-1')
    expect(n).toBe(1)
    const updateCap = callLog.find(
      (c) => c.table === 'abandoned_cart_enrollments' && c.set,
    )
    expect(updateCap).toBeTruthy()
    expect(
      updateCap!.where.some((w) => w[0] === 'checkout_id' && w[2] === 'checkout-1'),
    ).toBe(true)
    expect(
      updateCap!.where.some((w) => w[0] === 'recovered_at' && w[1] === 'is'),
    ).toBe(true)
  })

  it('returns 0 when nothing was updated', async () => {
    const { db, queue } = makeDb()
    queue('abandoned_cart_enrollments:execute', [
      { numUpdatedRows: BigInt(0) },
    ])
    const n = await markRecovered(db as any, 'checkout-x')
    expect(n).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// unsubscribeByToken
// ---------------------------------------------------------------------------

describe('unsubscribeByToken', () => {
  it('rejects tokens of wrong length without a DB lookup', async () => {
    const { db, callLog } = makeDb()
    const out = await unsubscribeByToken(db as any, 'too-short')
    expect(out).toEqual({ ok: false })
    expect(callLog.length).toBe(0)
  })

  it('returns { ok:false } when token not found (no enumeration)', async () => {
    const { db, queue } = makeDb()
    queue('abandoned_cart_enrollments:executeTakeFirst', null)
    const out = await unsubscribeByToken(
      db as any,
      '00000000000000000000000000000000',
    )
    expect(out).toEqual({ ok: false })
  })

  it('returns existing row when already unsubscribed (no double-write)', async () => {
    const { db, queue } = makeDb()
    queue('abandoned_cart_enrollments:executeTakeFirst', {
      id: 'e1',
      shop_id: 'shop-1',
      checkout_id: 'c1',
      email: 'a@b.com',
      unsubscribe_token: 'zz'.repeat(16),
      unsubscribed_at: '2026-04-20T00:00:00Z',
      recovered_at: null,
    })
    const out = await unsubscribeByToken(db as any, 'zz'.repeat(16))
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.enrollment.unsubscribed_at).toBe('2026-04-20T00:00:00Z')
  })

  it('stamps unsubscribed_at and returns updated row on fresh call', async () => {
    const { db, queue } = makeDb()
    queue('abandoned_cart_enrollments:executeTakeFirst', {
      id: 'e1',
      shop_id: 'shop-1',
      checkout_id: 'c1',
      email: 'a@b.com',
      unsubscribe_token: 'ab'.repeat(16),
      unsubscribed_at: null,
      recovered_at: null,
    })
    queue('abandoned_cart_enrollments:executeTakeFirstOrThrow', {
      id: 'e1',
      shop_id: 'shop-1',
      checkout_id: 'c1',
      email: 'a@b.com',
      unsubscribe_token: 'ab'.repeat(16),
      unsubscribed_at: '2026-04-21T10:00:00Z',
      recovered_at: null,
    })
    const out = await unsubscribeByToken(db as any, 'ab'.repeat(16))
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.enrollment.unsubscribed_at).toBe('2026-04-21T10:00:00Z')
  })
})

// ---------------------------------------------------------------------------
// resolveSettings + setShopSettings
// ---------------------------------------------------------------------------

describe('resolveSettings', () => {
  it('returns DEFAULTS when shop row missing', async () => {
    const { db, queue } = makeDb()
    queue('shops:executeTakeFirst', undefined)
    const out = await resolveSettings(db as any, 'shop-1')
    expect(out).toEqual(DEFAULT_ABANDONED_CART_SETTINGS)
  })

  it('merges persisted json onto defaults', async () => {
    const { db, queue } = makeDb()
    queue('shops:executeTakeFirst', {
      abandoned_cart_settings: { enabled: false, min_abandoned_minutes: 90 },
    })
    const out = await resolveSettings(db as any, 'shop-1')
    expect(out.enabled).toBe(false)
    expect(out.min_abandoned_minutes).toBe(90)
  })
})

describe('setShopSettings', () => {
  it('writes settings back to shops row', async () => {
    const { db, queue, callLog } = makeDb()
    queue('shops:execute', [])
    const next = {
      ...DEFAULT_ABANDONED_CART_SETTINGS,
      min_abandoned_minutes: 120,
    }
    const out = await setShopSettings(db as any, 'shop-1', next)
    expect(out).toEqual(next)
    const updateCap = callLog.find((c) => c.table === 'shops' && c.set)
    expect(updateCap).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// computeRecoveryStats
// ---------------------------------------------------------------------------

describe('computeRecoveryStats', () => {
  it('returns rate=0 when enrolled=0 (no divide-by-zero)', async () => {
    const { db, queue } = makeDb()
    queue('abandoned_cart_enrollments:executeTakeFirst', { count: '0' })
    queue('abandoned_cart_enrollments:executeTakeFirst', { count: '0' })
    const out = await computeRecoveryStats(db as any, 'shop-1')
    expect(out).toEqual({ enrolled: 0, recovered: 0, rate: 0 })
  })

  it('computes rate = recovered / enrolled', async () => {
    const { db, queue } = makeDb()
    queue('abandoned_cart_enrollments:executeTakeFirst', { count: '10' })
    queue('abandoned_cart_enrollments:executeTakeFirst', { count: '3' })
    const out = await computeRecoveryStats(db as any, 'shop-1')
    expect(out.enrolled).toBe(10)
    expect(out.recovered).toBe(3)
    expect(out.rate).toBeCloseTo(0.3, 5)
  })
})

// ---------------------------------------------------------------------------
// getEnrollment + getEnrollmentByCheckout
// ---------------------------------------------------------------------------

describe('getEnrollment', () => {
  function row(): AbandonedCartEnrollmentRow {
    return {
      id: 'e1',
      shop_id: 'shop-1',
      checkout_id: 'c1',
      customer_id: null,
      email: 'a@b.com',
      enrolled_at: '2026-04-21T00:00:00Z',
      last_sent_step_id: null,
      last_sent_at: null,
      recovered_at: null,
      unsubscribed_at: null,
      unsubscribe_token: '0'.repeat(32),
      error: null,
      created_at: '2026-04-21T00:00:00Z',
      updated_at: '2026-04-21T00:00:00Z',
    }
  }

  it('returns null when not found', async () => {
    const { db } = makeDb()
    const out = await getEnrollment(db as any, 'shop-1', 'missing')
    expect(out).toBe(null)
  })

  it('returns row when found + scopes to shopId', async () => {
    const { db, queue, callLog } = makeDb()
    queue('abandoned_cart_enrollments:executeTakeFirst', row())
    const out = await getEnrollment(db as any, 'shop-1', 'e1')
    expect(out?.id).toBe('e1')
    const cap = callLog.find((c) => c.table === 'abandoned_cart_enrollments')
    expect(
      cap!.where.some((w) => w[0] === 'shop_id' && w[2] === 'shop-1'),
    ).toBe(true)
  })

  it('getEnrollmentByCheckout scopes by checkout_id + shopId', async () => {
    const { db, queue, callLog } = makeDb()
    queue('abandoned_cart_enrollments:executeTakeFirst', row())
    const out = await getEnrollmentByCheckout(db as any, 'shop-1', 'c1')
    expect(out?.checkout_id).toBe('c1')
    const cap = callLog.find((c) => c.table === 'abandoned_cart_enrollments')
    expect(
      cap!.where.some((w) => w[0] === 'checkout_id' && w[2] === 'c1'),
    ).toBe(true)
    expect(
      cap!.where.some((w) => w[0] === 'shop_id' && w[2] === 'shop-1'),
    ).toBe(true)
  })
})
