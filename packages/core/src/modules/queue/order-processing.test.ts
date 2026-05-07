/**
 * Gbox Platform — Order-Processing Dispatcher Tests (Phase 3C)
 *
 * The BullMQ worker itself needs a live ioredis + Redis instance to
 * exercise end-to-end, which we deliberately don't spin up in unit
 * tests. Instead we test the pieces that matter without Redis:
 *
 *   1. Handler registry — `registerOrderHandler` / `clearOrderHandlers`
 *   2. `dispatchOrderProcessingJob` — the same dispatch entry point
 *      the worker uses, driven by a fake Kysely instance.
 *   3. The `enqueueStandardOrderFanout` payload shape.
 *
 * If a caller forgets to register a handler for a kind, the dispatch
 * MUST throw so BullMQ's retry + alerting kicks in. Never silently
 * drop.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  registerOrderHandler,
  clearOrderHandlers,
  dispatchOrderProcessingJob,
  type OrderProcessingHandler,
} from './workers.js'
import type {
  OrderProcessingJob,
  OrderProcessingKind,
} from './queues.js'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// Fake db — the dispatcher just passes it through to the handler.
const fakeDb = { __marker: 'fake-db' } as unknown as Kysely<Database>

describe('order-processing dispatcher', () => {
  beforeEach(() => {
    clearOrderHandlers()
  })

  it('calls the registered handler for a kind', async () => {
    const handler = vi.fn<OrderProcessingHandler>(async () => {})
    registerOrderHandler('confirmation_email', handler)

    const job: OrderProcessingJob = {
      kind: 'confirmation_email',
      shop_id: 'shop_1',
      order_id: 'ord_1',
    }
    await dispatchOrderProcessingJob(fakeDb, job)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(fakeDb, job)
  })

  it('forwards hint data to the handler untouched', async () => {
    const handler = vi.fn<OrderProcessingHandler>(async () => {})
    registerOrderHandler('analytics', handler)

    const job: OrderProcessingJob = {
      kind: 'analytics',
      shop_id: 'shop_1',
      order_id: 'ord_1',
      hint: { gateway: 'stripe', amount: '99.00' },
    }
    await dispatchOrderProcessingJob(fakeDb, job)
    expect(handler.mock.calls[0]![1].hint).toEqual({
      gateway: 'stripe',
      amount: '99.00',
    })
  })

  it('throws when no handler is registered for a kind', async () => {
    const job: OrderProcessingJob = {
      kind: 'fulfillment_hold',
      shop_id: 'shop_1',
      order_id: 'ord_1',
    }
    await expect(dispatchOrderProcessingJob(fakeDb, job)).rejects.toThrow(
      /no handler registered.*fulfillment_hold/,
    )
  })

  it('bubbles handler errors (so BullMQ retries kick in)', async () => {
    registerOrderHandler('receipt', async () => {
      throw new Error('pdf service down')
    })
    const job: OrderProcessingJob = {
      kind: 'receipt',
      shop_id: 'shop_1',
      order_id: 'ord_1',
    }
    await expect(dispatchOrderProcessingJob(fakeDb, job)).rejects.toThrow(
      /pdf service down/,
    )
  })

  it('lets callers override a previously-registered handler', async () => {
    const first = vi.fn<OrderProcessingHandler>(async () => {})
    const second = vi.fn<OrderProcessingHandler>(async () => {})
    registerOrderHandler('merchant_notification', first)
    registerOrderHandler('merchant_notification', second)
    await dispatchOrderProcessingJob(fakeDb, {
      kind: 'merchant_notification',
      shop_id: 'shop_1',
      order_id: 'ord_1',
    })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('runs independent handlers per kind without cross-talk', async () => {
    const received: OrderProcessingKind[] = []
    const track = (k: OrderProcessingKind): OrderProcessingHandler =>
      async () => {
        received.push(k)
      }
    registerOrderHandler('confirmation_email', track('confirmation_email'))
    registerOrderHandler('merchant_notification', track('merchant_notification'))
    registerOrderHandler('receipt', track('receipt'))
    registerOrderHandler('analytics', track('analytics'))

    for (const kind of [
      'confirmation_email',
      'merchant_notification',
      'receipt',
      'analytics',
    ] as OrderProcessingKind[]) {
      await dispatchOrderProcessingJob(fakeDb, {
        kind,
        shop_id: 'shop_1',
        order_id: 'ord_1',
      })
    }

    expect(received).toEqual([
      'confirmation_email',
      'merchant_notification',
      'receipt',
      'analytics',
    ])
  })

  it('clearOrderHandlers resets the registry between test cases', async () => {
    registerOrderHandler('confirmation_email', async () => {})
    clearOrderHandlers()
    await expect(
      dispatchOrderProcessingJob(fakeDb, {
        kind: 'confirmation_email',
        shop_id: 'shop_1',
        order_id: 'ord_1',
      }),
    ).rejects.toThrow(/no handler registered/)
  })
})
