/**
 * Unit tests for the automation event bus (Phase 14 PR3 — commit 3).
 *
 * The DB-backed side of `emit()` (actual INSERT + runner.dispatch
 * round-trip) lives in the live-DB smoke (`scripts/smoke-phase14-pr3.ts`).
 * These tests cover the PURE helpers so CI can catch shape drift
 * without a Postgres.
 */

import { describe, it, expect } from 'vitest'
import {
  isEventOfType,
  normaliseEventForInsert,
  type AutomationEvent,
} from './events.js'

describe('normaliseEventForInsert', () => {
  it('moves shopId + type off the payload and keeps the rest', () => {
    const event: AutomationEvent = {
      type: 'order.paid',
      shopId: 'shop-1',
      orderId: 'o-1',
      customerId: 'c-1',
      totalPrice: 4995,
      currency: 'USD',
      totalOrdersForCustomer: 1,
    }
    const out = normaliseEventForInsert(event)
    expect(out.shopId).toBe('shop-1')
    expect(out.type).toBe('order.paid')
    // shopId + type should NOT appear in payload — they're first-class
    expect(out.payload).not.toHaveProperty('shopId')
    expect(out.payload).not.toHaveProperty('type')
    // Everything else is preserved
    expect(out.payload.orderId).toBe('o-1')
    expect(out.payload.totalPrice).toBe(4995)
    expect(out.payload.currency).toBe('USD')
    expect(out.payload.totalOrdersForCustomer).toBe(1)
  })

  it('serialises occurredAt as ISO string so JSONB round-trips cleanly', () => {
    const when = new Date('2026-04-22T12:00:00.000Z')
    const event: AutomationEvent = {
      type: 'customer.created',
      shopId: 's',
      customerId: 'c',
      hasOrdered: false,
      occurredAt: when,
    }
    const { payload } = normaliseEventForInsert(event)
    expect(payload.occurredAt).toBe('2026-04-22T12:00:00.000Z')
  })

  it('omits occurredAt from payload when not supplied (DB default fills in)', () => {
    const event: AutomationEvent = {
      type: 'checkout.abandoned',
      shopId: 's',
      checkoutId: 'ck-1',
      customerEmail: 'a@b.test',
      customerId: null,
      abandonedAt: new Date('2026-04-22T00:00:00.000Z'),
    }
    const { payload } = normaliseEventForInsert(event)
    // abandonedAt is not occurredAt — it stays as a Date (caller
    // responsibility to serialise as needed). This test locks the
    // behaviour: ONLY occurredAt gets the ISO treatment.
    expect(payload.occurredAt).toBeUndefined()
    expect(payload.abandonedAt).toBeInstanceOf(Date)
  })

  it('handles every event type without throwing (smoke on the union)', () => {
    const events: AutomationEvent[] = [
      { type: 'order.paid', shopId: 's', orderId: 'o', customerId: null, totalPrice: 0, currency: 'USD', totalOrdersForCustomer: 0 },
      { type: 'order.fulfilled', shopId: 's', orderId: 'o', customerId: null, fulfillmentId: 'f' },
      { type: 'order.delivered', shopId: 's', orderId: 'o', customerId: null, fulfillmentId: 'f' },
      { type: 'fulfillment.out_for_delivery', shopId: 's', orderId: 'o', customerId: null, fulfillmentId: 'f', trackingNumber: null, carrier: null },
      { type: 'payment.failed', shopId: 's', orderId: 'o', customerId: null, reason: null },
      { type: 'product.published', shopId: 's', productId: 'p', firstPublish: true },
      { type: 'inventory.restocked', shopId: 's', variantId: 'v', previousOnHand: 0, newOnHand: 5 },
      { type: 'inventory.threshold_crossed', shopId: 's', variantId: 'v', onHand: 2, threshold: 3 },
      { type: 'customer.created', shopId: 's', customerId: 'c', hasOrdered: false },
      { type: 'customer.dormant_detected', shopId: 's', customerId: 'c', lastOrderAt: new Date() },
      { type: 'campaign.scheduled', shopId: 's', campaignId: 'cmp', campaignType: 'newsletter', sendAt: new Date() },
      { type: 'checkout.abandoned', shopId: 's', checkoutId: 'ck', customerEmail: null, customerId: null, abandonedAt: new Date() },
    ]
    for (const ev of events) {
      const out = normaliseEventForInsert(ev)
      expect(out.shopId).toBe('s')
      expect(typeof out.type).toBe('string')
      expect(typeof out.payload).toBe('object')
    }
  })
})

describe('isEventOfType', () => {
  it('narrows a union to the expected variant', () => {
    const event: AutomationEvent = {
      type: 'order.paid',
      shopId: 's',
      orderId: 'o',
      customerId: null,
      totalPrice: 1000,
      currency: 'USD',
      totalOrdersForCustomer: 2,
    }
    if (isEventOfType(event, 'order.paid')) {
      // TypeScript narrows here — totalPrice is a number.
      expect(event.totalPrice).toBe(1000)
    } else {
      throw new Error('expected narrowing to succeed')
    }
  })

  it('returns false when the type does not match', () => {
    const event: AutomationEvent = {
      type: 'product.published',
      shopId: 's',
      productId: 'p',
      firstPublish: true,
    }
    expect(isEventOfType(event, 'order.paid')).toBe(false)
  })
})
