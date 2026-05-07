/**
 * Unit tests for the flow catalog (Phase 14 PR3 — commit 4).
 *
 * Verifies:
 *   - exactly 18 entries (matches scope doc §2 — any drift = fail)
 *   - every key is unique
 *   - every template_key resolves in the email registry
 *   - every trigger matches an event in the AutomationEvent union
 *   - idempotency() + variables() handle at least one representative
 *     event per entry without throwing
 *   - merchant-safe copy (iron rule 5 smoke) — no "god admin" /
 *     "/god-admin" leaks in label or description
 */

import { describe, it, expect } from 'vitest'
import {
  FLOW_CATALOG,
  FLOW_CATALOG_BY_KEY,
  flowsForEventType,
  getFlow,
} from './flow-catalog.js'
import { getTemplate } from '@gbox/core/modules/email/registry.js'
import type { AutomationEvent, AutomationEventType } from './events.js'

describe('FLOW_CATALOG shape', () => {
  // 29 catalog entries = 18 PR3 entries (including the
  // `abandoned_cart_reminder_1` that routes to the PR2-wired
  // `abandoned_cart_recovery` template) + 1 redundant route ≈ 19 rows
  // from PR3 + 10 PR6 finance/ops entries. See
  // docs/email-system/phase-14-pr6-scope.md §2a for the full table.
  it('has 29 catalog entries (19 from PR3 + 10 new in PR6)', () => {
    expect(FLOW_CATALOG.length).toBe(29)
  })

  it('drives 29 unique templates (PR3 19 + PR6 10)', () => {
    const uniqueTemplates = new Set(FLOW_CATALOG.map((e) => e.templateKey))
    // PR3: 18 new + `abandoned_cart_recovery` (PR2). PR6: 10 new —
    // refund_issued_merchant / payment_failed_merchant / high_risk_order /
    // out_of_stock_alert / first_time_customer_order / payout_* (×3) /
    // chargeback_opened / chargeback_lost.
    expect(uniqueTemplates.size).toBe(29)
    // The PR2 template MUST still be present — otherwise the Phase 8
    // migration plan would have replaced it instead of reusing it.
    expect(uniqueTemplates.has('abandoned_cart_recovery')).toBe(true)
  })

  it('has unique keys', () => {
    const seen = new Set<string>()
    for (const e of FLOW_CATALOG) {
      expect(seen.has(e.key), `duplicate key ${e.key}`).toBe(false)
      seen.add(e.key)
    }
  })

  it('every template_key resolves in the email registry', () => {
    for (const e of FLOW_CATALOG) {
      const spec = getTemplate(e.templateKey)
      expect(spec, `template ${e.templateKey} missing for flow ${e.key}`).toBeDefined()
    }
  })

  it('never references a god_admin audience template (iron rule 5 smoke)', () => {
    for (const e of FLOW_CATALOG) {
      const spec = getTemplate(e.templateKey)
      expect(
        spec?.audience,
        `flow ${e.key} → template ${e.templateKey} has audience ${spec?.audience}`,
      ).not.toBe('god_admin')
    }
  })

  it('every delay is >= 0 and <= 30 days (safety bound)', () => {
    const MAX = 30 * 24 * 60 * 60
    for (const e of FLOW_CATALOG) {
      expect(e.delaySeconds).toBeGreaterThanOrEqual(0)
      expect(e.delaySeconds).toBeLessThanOrEqual(MAX)
    }
  })

  it('label + description are seller-safe copy (no god-admin leak)', () => {
    const FORBIDDEN = /god[- ]?admin|\/god-admin/i
    for (const e of FLOW_CATALOG) {
      expect(e.label).not.toMatch(FORBIDDEN)
      expect(e.description).not.toMatch(FORBIDDEN)
      expect(e.label.length).toBeGreaterThan(0)
      expect(e.description.length).toBeGreaterThan(0)
    }
  })
})

describe('FLOW_CATALOG_BY_KEY index', () => {
  it('has an entry for every key in FLOW_CATALOG', () => {
    for (const e of FLOW_CATALOG) {
      expect(FLOW_CATALOG_BY_KEY[e.key]).toBe(e)
    }
  })

  it('getFlow returns null for unknown keys', () => {
    expect(getFlow('does_not_exist_xyz')).toBeNull()
  })

  it('getFlow returns the same object as FLOW_CATALOG_BY_KEY', () => {
    expect(getFlow('high_value_order')).toBe(FLOW_CATALOG_BY_KEY['high_value_order'])
  })
})

describe('flowsForEventType', () => {
  it('returns all flows triggered by a given event type', () => {
    // order.paid triggers four flows after PR6:
    //   - first_order_milestone (PR3 — customer-audience, 2h delay)
    //   - high_value_order (PR3 — merchant alert on $500+)
    //   - post_purchase_upsell (PR3 — customer upsell after 30m)
    //   - first_time_customer_order (PR6 — merchant alert, 0 delay,
    //     fires on same event as first_order_milestone but different
    //     audience + template).
    const flows = flowsForEventType('order.paid')
    const keys = flows.map((f) => f.key).sort()
    expect(keys).toEqual([
      'first_order_milestone',
      'first_time_customer_order',
      'high_value_order',
      'post_purchase_upsell',
    ])
  })

  it('returns four flows for campaign.scheduled', () => {
    const flows = flowsForEventType('campaign.scheduled')
    const keys = flows.map((f) => f.key).sort()
    expect(keys).toEqual(['campaign_promo', 'flash_sale', 'newsletter_broadcast', 'seasonal_promo'])
  })

  it('returns three flows for checkout.abandoned', () => {
    const flows = flowsForEventType('checkout.abandoned')
    const keys = flows.map((f) => f.key).sort()
    expect(keys).toEqual([
      'abandoned_cart_reminder_1',
      'abandoned_cart_reminder_2',
      'abandoned_cart_reminder_3',
    ])
  })

  it('returns empty array for event types with no flows', () => {
    // Every known event type has at least one flow in PR3 — just
    // verify the function doesn't throw on a bogus input.
    expect(flowsForEventType('some.unknown.event' as AutomationEventType)).toEqual([])
  })
})

describe('entry resolvers (variables + idempotency)', () => {
  // One representative event per entry (enough to catch throws).
  const samples: Partial<Record<string, AutomationEvent>> = {
    'campaign.scheduled': {
      type: 'campaign.scheduled',
      shopId: 's',
      campaignId: 'cmp-1',
      campaignType: 'promo',
      sendAt: new Date('2026-04-22T10:00:00.000Z'),
    },
    'product.published': {
      type: 'product.published',
      shopId: 's',
      productId: 'p-1',
      firstPublish: true,
    },
    'inventory.restocked': {
      type: 'inventory.restocked',
      shopId: 's',
      variantId: 'v-1',
      previousOnHand: 0,
      newOnHand: 10,
    },
    'order.fulfilled': {
      type: 'order.fulfilled',
      shopId: 's',
      orderId: 'o-1',
      customerId: 'c-1',
      fulfillmentId: 'f-1',
    },
    'customer.dormant_detected': {
      type: 'customer.dormant_detected',
      shopId: 's',
      customerId: 'c-1',
      lastOrderAt: new Date('2025-12-01T00:00:00.000Z'),
    },
    'order.paid': {
      type: 'order.paid',
      shopId: 's',
      orderId: 'o-1',
      customerId: 'c-1',
      totalPrice: 60000,
      currency: 'USD',
      totalOrdersForCustomer: 1,
    },
    'customer.created': {
      type: 'customer.created',
      shopId: 's',
      customerId: 'c-1',
      hasOrdered: false,
    },
    'order.delivered': {
      type: 'order.delivered',
      shopId: 's',
      orderId: 'o-1',
      customerId: 'c-1',
      fulfillmentId: 'f-1',
    },
    'checkout.abandoned': {
      type: 'checkout.abandoned',
      shopId: 's',
      checkoutId: 'ck-1',
      customerEmail: 'p@t.test',
      customerId: null,
      abandonedAt: new Date('2026-04-22T00:00:00.000Z'),
    },
    'inventory.threshold_crossed': {
      type: 'inventory.threshold_crossed',
      shopId: 's',
      variantId: 'v-1',
      onHand: 2,
      threshold: 3,
      occurredAt: new Date('2026-04-22T10:00:00.000Z'),
    },
    'fulfillment.out_for_delivery': {
      type: 'fulfillment.out_for_delivery',
      shopId: 's',
      orderId: 'o-1',
      customerId: 'c-1',
      fulfillmentId: 'f-1',
      trackingNumber: '1Z999',
      carrier: 'UPS',
    },
    'payment.failed': {
      type: 'payment.failed',
      shopId: 's',
      orderId: 'o-1',
      customerId: 'c-1',
      reason: 'card declined',
    },
    // PR6 — finance / ops events. Same test pattern: one rep event
    // per new trigger type so the for-loop below doesn't hit an
    // undefined sample.
    'refund.issued': {
      type: 'refund.issued',
      shopId: 's',
      refundId: 'ref-1',
      orderId: 'o-1',
      customerId: 'c-1',
      amount: 1000,
      currency: 'USD',
      reason: 'customer request',
    },
    'order.high_risk': {
      type: 'order.high_risk',
      shopId: 's',
      orderId: 'o-1',
      customerId: 'c-1',
      riskScore: 85,
      riskFactors: ['billing_shipping_mismatch', 'cvv_mismatch'],
    },
    'inventory.out_of_stock': {
      type: 'inventory.out_of_stock',
      shopId: 's',
      variantId: 'v-1',
      productId: 'p-1',
      occurredAt: new Date('2026-04-22T10:00:00.000Z'),
    },
    'payout.scheduled': {
      type: 'payout.scheduled',
      shopId: 's',
      payoutId: 'po-1',
      amount: 100000,
      currency: 'USD',
      arrivalDate: new Date('2026-04-24T00:00:00.000Z'),
    },
    'payout.completed': {
      type: 'payout.completed',
      shopId: 's',
      payoutId: 'po-1',
      amount: 100000,
      currency: 'USD',
    },
    'payout.failed': {
      type: 'payout.failed',
      shopId: 's',
      payoutId: 'po-1',
      amount: 100000,
      currency: 'USD',
      reason: 'bank_account_closed',
    },
    'chargeback.opened': {
      type: 'chargeback.opened',
      shopId: 's',
      chargebackId: 'cb-1',
      orderId: 'o-1',
      amount: 5000,
      currency: 'USD',
      reason: 'unauthorised',
      dueBy: new Date('2026-05-06T00:00:00.000Z'),
    },
    'chargeback.lost': {
      type: 'chargeback.lost',
      shopId: 's',
      chargebackId: 'cb-1',
      orderId: 'o-1',
      amount: 5000,
      currency: 'USD',
    },
  }

  it('every entry runs variables() + idempotency() on a matching event without throwing', () => {
    for (const entry of FLOW_CATALOG) {
      const sample = samples[entry.trigger]
      expect(sample, `no sample event for trigger ${entry.trigger}`).toBeDefined()
      const vars = entry.variables(sample!)
      expect(typeof vars).toBe('object')
      const key = entry.idempotency(sample!)
      expect(typeof key).toBe('string')
      expect(key.length).toBeGreaterThan(0)
    }
  })

  it('idempotency keys start with the flow key for grepability', () => {
    for (const entry of FLOW_CATALOG) {
      const sample = samples[entry.trigger]!
      const key = entry.idempotency(sample)
      expect(key.startsWith(`${entry.key}:`)).toBe(true)
    }
  })

  it('high_value_order condition gates on totalPrice >= 50000', () => {
    const entry = getFlow('high_value_order')!
    expect(entry.defaultConditions).toEqual({
      op: 'gte',
      field: 'event.totalPrice',
      value: 50000,
    })
  })
})
