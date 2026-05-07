/**
 * Gbox Platform — Default Order Handlers Tests
 *
 * Keeps the stub module honest: every kind in the fan-out payload
 * type must have a registered default, the logger hook is respected,
 * and overriding a single kind after `registerDefaultOrderHandlers`
 * leaves the rest as stubs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import {
  DEFAULT_ORDER_KINDS,
  buildStubOrderHandler,
  registerDefaultOrderHandlers,
} from './default-order-handlers.js'
import {
  clearOrderHandlers,
  dispatchOrderProcessingJob,
  registerOrderHandler,
} from './workers.js'
import type { OrderProcessingJob } from './queues.js'

const fakeDb = { __marker: 'fake-db' } as unknown as Kysely<Database>

function job(kind: OrderProcessingJob['kind']): OrderProcessingJob {
  return {
    kind,
    shop_id: 'shop_1',
    order_id: 'order_1',
  }
}

beforeEach(() => {
  clearOrderHandlers()
})

describe('buildStubOrderHandler', () => {
  it('invokes the injected logger with kind + ids', async () => {
    const logs: string[] = []
    const handler = buildStubOrderHandler('receipt', (msg) => logs.push(msg))
    await handler(fakeDb, job('receipt'))
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('kind=receipt')
    expect(logs[0]).toContain('shop=shop_1')
    expect(logs[0]).toContain('order=order_1')
  })

  it('resolves without error even when logger is a no-op', async () => {
    const handler = buildStubOrderHandler('analytics', () => {})
    await expect(handler(fakeDb, job('analytics'))).resolves.toBeUndefined()
  })

  it('defaults to console.info when no logger is passed', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const handler = buildStubOrderHandler('merchant_notification')
      await handler(fakeDb, job('merchant_notification'))
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0]?.[0]).toContain('kind=merchant_notification')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('registerDefaultOrderHandlers', () => {
  it('registers a handler for every kind in DEFAULT_ORDER_KINDS', async () => {
    const logs: string[] = []
    registerDefaultOrderHandlers((msg) => logs.push(msg))
    for (const kind of DEFAULT_ORDER_KINDS) {
      await expect(
        dispatchOrderProcessingJob(fakeDb, job(kind)),
      ).resolves.toBeUndefined()
    }
    expect(logs).toHaveLength(DEFAULT_ORDER_KINDS.length)
  })

  it('is idempotent — calling twice does not double-dispatch', async () => {
    const logs: string[] = []
    registerDefaultOrderHandlers((msg) => logs.push(msg))
    registerDefaultOrderHandlers((msg) => logs.push(msg))
    await dispatchOrderProcessingJob(fakeDb, job('confirmation_email'))
    expect(logs).toHaveLength(1)
  })

  it('allows a real handler to override a specific kind afterwards', async () => {
    const stubLogs: string[] = []
    registerDefaultOrderHandlers((msg) => stubLogs.push(msg))

    const realConfirmation = vi.fn(async () => {})
    registerOrderHandler('confirmation_email', realConfirmation)

    // Override only confirmation_email; the rest stay as stubs.
    await dispatchOrderProcessingJob(fakeDb, job('confirmation_email'))
    await dispatchOrderProcessingJob(fakeDb, job('receipt'))

    expect(realConfirmation).toHaveBeenCalledTimes(1)
    // Stub fired for receipt but NOT for confirmation_email (overridden).
    expect(stubLogs).toHaveLength(1)
    expect(stubLogs[0]).toContain('kind=receipt')
  })

  it('covers every kind that the OrderProcessingJob type permits', () => {
    // Compile-time completeness — add any new kind to the exhaustiveness
    // switch below and this test forces the default list to catch up.
    const knownKinds: Record<OrderProcessingJob['kind'], true> = {
      confirmation_email: true,
      merchant_notification: true,
      receipt: true,
      analytics: true,
      fulfillment_hold: true,
      loyalty_points: true,
    }
    const defaults = new Set(DEFAULT_ORDER_KINDS)
    for (const k of Object.keys(knownKinds)) {
      expect(defaults.has(k as OrderProcessingJob['kind'])).toBe(true)
    }
  })
})
