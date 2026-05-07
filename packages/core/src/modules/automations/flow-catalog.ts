/**
 * Gbox Platform — Flow catalog (Phase 14 PR3)
 *
 * Declarative in-code catalog of every automation flow. Each entry
 * maps a `(trigger event type, flow_key)` pair to:
 *
 *   - a template_key (email to send when conditions match)
 *   - a delay (0 for inline, >0 for queue)
 *   - default conditions (narrow-by-default ConditionNode; merchants
 *     can override via `automation_flows.conditions` JSONB)
 *   - a variables() resolver (event → variable bag for the template)
 *   - an idempotency() resolver (event → dedup key, scoped per flow
 *     so the same event triggers multiple flows without collision)
 *
 * IMPORTANT: the catalog itself is in code, NOT in the DB. Merchants
 * can only OVERRIDE (enable/disable/tweak delay/tweak conditions) via
 * the `automation_flows` table — they can't invent new flow types.
 * This is the same shape as Shopify Flow's "templates you can turn
 * on" vs "custom workflows". PR3 keeps it simple — Phase 15 can add
 * a merchant-authored flow layer if anyone asks.
 *
 * Iron rule 5: every template_key referenced here is a seller-audience
 * or customer-audience template. The runner still filters through
 * send.ts's iron-rule-5 gate (which calls
 * `getMerchantVisibleTemplates()` for the seller UI — the runner
 * call path is different but the send.ts filter is the same). A
 * catalog entry pointing at a god_admin audience template would be
 * rejected at send time — but we don't add such entries here, so the
 * defensive path never fires.
 */

import type { AutomationEvent, AutomationEventType } from './events.js'
import type { ConditionNode } from './conditions.js'

// ---------------------------------------------------------------------------
// Catalog entry shape
// ---------------------------------------------------------------------------

export interface FlowCatalogEntry {
  /**
   * Stable machine-readable key. Used in `automation_flows.flow_key`,
   * `automation_scheduled.flow_key`, `automation_runs.flow_key` — the
   * same string everywhere. NEVER rename a key in-place; add a new one
   * and deprecate the old one through the catalog.
   */
  key: string

  /**
   * Which event type fires this flow. One flow = one event type
   * (simpler than Shopify's multi-trigger nodes; if we need "either
   * order.paid OR order.fulfilled", add two entries with the same
   * template_key).
   */
  trigger: AutomationEventType

  /**
   * Template to send. Must resolve via `@gbox/core/modules/email/
   * registry::getTemplate(key)` — the smoke test asserts this for
   * every catalog entry.
   */
  templateKey: string

  /**
   * Seconds between event and send. 0 = inline dispatch (no queue).
   * >0 = insert into `automation_scheduled` with
   * `fire_at = now() + delay`. The merchant can override via
   * `automation_flows.delay_seconds`.
   */
  delaySeconds: number

  /**
   * Default conditions. Applied AFTER any merchant override — if the
   * merchant sets `conditions = null` in their override, this
   * default still applies. Set to `undefined` for match-all.
   */
  defaultConditions?: ConditionNode

  /**
   * Resolve template variables from the event. The runner calls this
   * after loading context (shop, customer, etc.) and merges the
   * result into the final `variables` passed to `sendTemplatedEmail`.
   *
   * Pure function — no DB access. If a template needs richer data
   * than the event carries, the runner loads it separately and
   * injects it on the return of this function; see runner.ts
   * `buildVariables`.
   */
  variables(event: AutomationEvent): Record<string, unknown>

  /**
   * Produce the idempotency key for this (flow, event) pair. Must be
   * stable across retries of the same logical event — webhook
   * retries, scheduler re-dispatches, etc.
   *
   * Convention: `<flow_key>:<primary_id>[:<disambiguator>]`. The
   * runner prepends the shop id automatically when writing to the
   * `automation_scheduled` table, so we don't need to repeat it here.
   */
  idempotency(event: AutomationEvent): string

  /**
   * Human-readable label + description for the admin UI. Seller-safe
   * copy only — no internal paths, no "god admin" leaks.
   */
  label: string
  description: string
}

// ---------------------------------------------------------------------------
// Catalog (18 entries — matches scope doc §2)
// ---------------------------------------------------------------------------

// Helper — TypeScript narrowing shortcuts for variables() / idempotency().
function asOrderPaid(ev: AutomationEvent): Extract<AutomationEvent, { type: 'order.paid' }> {
  if (ev.type !== 'order.paid') throw new Error(`expected order.paid, got ${ev.type}`)
  return ev
}
function asCampaignScheduled(ev: AutomationEvent): Extract<AutomationEvent, { type: 'campaign.scheduled' }> {
  if (ev.type !== 'campaign.scheduled') throw new Error(`expected campaign.scheduled, got ${ev.type}`)
  return ev
}

// Phase 14 PR6 — finance / ops narrowing helpers. Each one throws with
// an informative message on the wrong type so a misrouted event blows
// up loudly instead of silently rendering an empty template.
function asRefundIssued(ev: AutomationEvent): Extract<AutomationEvent, { type: 'refund.issued' }> {
  if (ev.type !== 'refund.issued') throw new Error(`expected refund.issued, got ${ev.type}`)
  return ev
}
function asPaymentFailed(ev: AutomationEvent): Extract<AutomationEvent, { type: 'payment.failed' }> {
  if (ev.type !== 'payment.failed') throw new Error(`expected payment.failed, got ${ev.type}`)
  return ev
}
function asOrderHighRisk(ev: AutomationEvent): Extract<AutomationEvent, { type: 'order.high_risk' }> {
  if (ev.type !== 'order.high_risk') throw new Error(`expected order.high_risk, got ${ev.type}`)
  return ev
}
function asInventoryOutOfStock(ev: AutomationEvent): Extract<AutomationEvent, { type: 'inventory.out_of_stock' }> {
  if (ev.type !== 'inventory.out_of_stock') throw new Error(`expected inventory.out_of_stock, got ${ev.type}`)
  return ev
}
function asPayout(ev: AutomationEvent): Extract<AutomationEvent, { type: 'payout.scheduled' | 'payout.completed' | 'payout.failed' }> {
  if (ev.type !== 'payout.scheduled' && ev.type !== 'payout.completed' && ev.type !== 'payout.failed') {
    throw new Error(`expected payout.*, got ${ev.type}`)
  }
  return ev
}
function asChargeback(ev: AutomationEvent): Extract<AutomationEvent, { type: 'chargeback.opened' | 'chargeback.lost' }> {
  if (ev.type !== 'chargeback.opened' && ev.type !== 'chargeback.lost') {
    throw new Error(`expected chargeback.*, got ${ev.type}`)
  }
  return ev
}

// Each block below is one flow. Grouped by the scope doc §2 groups for
// readability. Exported as a flat array + a by-key index.
const ENTRIES: readonly FlowCatalogEntry[] = [
  // ─── 2a. Marketing (4 campaign-type + 2 event-driven) ──────────────
  {
    key: 'campaign_promo',
    trigger: 'campaign.scheduled',
    templateKey: 'campaign_promo',
    delaySeconds: 0,
    defaultConditions: { op: 'eq', field: 'event.campaignType', value: 'promo' },
    variables: (ev) => {
      const e = asCampaignScheduled(ev)
      return { campaign_id: e.campaignId }
    },
    idempotency: (ev) => `campaign_promo:${asCampaignScheduled(ev).campaignId}`,
    label: 'Promotional campaign',
    description: 'Sends a promo campaign email at its scheduled send time.',
  },
  {
    key: 'newsletter_broadcast',
    trigger: 'campaign.scheduled',
    templateKey: 'newsletter_broadcast',
    delaySeconds: 0,
    defaultConditions: { op: 'eq', field: 'event.campaignType', value: 'newsletter' },
    variables: (ev) => ({ campaign_id: asCampaignScheduled(ev).campaignId }),
    idempotency: (ev) => `newsletter_broadcast:${asCampaignScheduled(ev).campaignId}`,
    label: 'Newsletter broadcast',
    description: 'Sends a newsletter at its scheduled send time.',
  },
  {
    key: 'flash_sale',
    trigger: 'campaign.scheduled',
    templateKey: 'flash_sale',
    delaySeconds: 0,
    defaultConditions: { op: 'eq', field: 'event.campaignType', value: 'flash_sale' },
    variables: (ev) => ({ campaign_id: asCampaignScheduled(ev).campaignId }),
    idempotency: (ev) => `flash_sale:${asCampaignScheduled(ev).campaignId}`,
    label: 'Flash sale',
    description: 'Sends a flash-sale announcement with a countdown.',
  },
  {
    key: 'seasonal_promo',
    trigger: 'campaign.scheduled',
    templateKey: 'seasonal_promo',
    delaySeconds: 0,
    defaultConditions: { op: 'eq', field: 'event.campaignType', value: 'seasonal' },
    variables: (ev) => ({ campaign_id: asCampaignScheduled(ev).campaignId }),
    idempotency: (ev) => `seasonal_promo:${asCampaignScheduled(ev).campaignId}`,
    label: 'Seasonal promotion',
    description: 'Sends a seasonal campaign on its scheduled send time.',
  },
  {
    key: 'product_launch',
    trigger: 'product.published',
    templateKey: 'product_launch',
    delaySeconds: 0,
    defaultConditions: { op: 'truthy', field: 'event.firstPublish' },
    variables: (ev) => {
      if (ev.type !== 'product.published') throw new Error('bad event')
      return { product_id: ev.productId }
    },
    idempotency: (ev) => {
      if (ev.type !== 'product.published') throw new Error('bad event')
      return `product_launch:${ev.productId}`
    },
    label: 'Product launch announcement',
    description: 'Announces a new product the first time it is published.',
  },
  {
    key: 'back_in_stock',
    trigger: 'inventory.restocked',
    templateKey: 'back_in_stock',
    delaySeconds: 0,
    variables: (ev) => {
      if (ev.type !== 'inventory.restocked') throw new Error('bad event')
      return { variant_id: ev.variantId, new_on_hand: ev.newOnHand }
    },
    idempotency: (ev) => {
      if (ev.type !== 'inventory.restocked') throw new Error('bad event')
      return `back_in_stock:${ev.variantId}:${ev.newOnHand}`
    },
    label: 'Back in stock',
    description: 'Notifies customers subscribed to a restocked variant.',
  },

  // ─── 2b. Lifecycle (4) ─────────────────────────────────────────────
  {
    key: 'post_purchase_thank_you',
    trigger: 'order.fulfilled',
    templateKey: 'post_purchase_thank_you',
    delaySeconds: 24 * 60 * 60, // 24h
    variables: (ev) => {
      if (ev.type !== 'order.fulfilled') throw new Error('bad event')
      return { order_id: ev.orderId }
    },
    idempotency: (ev) => {
      if (ev.type !== 'order.fulfilled') throw new Error('bad event')
      return `post_purchase_thank_you:${ev.orderId}`
    },
    label: 'Post-purchase thank you',
    description: 'Sends a sentimental thank-you 24h after fulfilment.',
  },
  {
    key: 'customer_win_back',
    trigger: 'customer.dormant_detected',
    templateKey: 'customer_win_back',
    delaySeconds: 0,
    variables: (ev) => {
      if (ev.type !== 'customer.dormant_detected') throw new Error('bad event')
      return { customer_id: ev.customerId, last_order_at: ev.lastOrderAt.toISOString() }
    },
    idempotency: (ev) => {
      if (ev.type !== 'customer.dormant_detected') throw new Error('bad event')
      // One win-back per customer per 6-month window (scheduler
      // guarantees this by gating re-detection — not a catalog concern).
      return `customer_win_back:${ev.customerId}:${ev.lastOrderAt.toISOString().slice(0, 7)}`
    },
    label: 'Customer win-back',
    description: 'Re-engages a customer dormant for 90+ days.',
  },
  {
    key: 'first_order_milestone',
    trigger: 'order.paid',
    templateKey: 'first_order_milestone',
    delaySeconds: 2 * 60 * 60, // 2h
    defaultConditions: { op: 'eq', field: 'event.totalOrdersForCustomer', value: 1 },
    variables: (ev) => ({ order_id: asOrderPaid(ev).orderId }),
    idempotency: (ev) => `first_order_milestone:${asOrderPaid(ev).orderId}`,
    label: 'First order milestone',
    description: 'Celebrates a customer completing their first order.',
  },
  {
    key: 'onboarding_day_1',
    trigger: 'customer.created',
    templateKey: 'onboarding_day_1',
    delaySeconds: 24 * 60 * 60,
    defaultConditions: { op: 'falsy', field: 'event.hasOrdered' },
    variables: (ev) => {
      if (ev.type !== 'customer.created') throw new Error('bad event')
      return { customer_id: ev.customerId }
    },
    idempotency: (ev) => {
      if (ev.type !== 'customer.created') throw new Error('bad event')
      return `onboarding_day_1:${ev.customerId}`
    },
    label: 'Onboarding day 1',
    description: '24h after signup, nudges the customer toward a first order.',
  },

  // ─── 2c. Reviews (1) ───────────────────────────────────────────────
  {
    key: 'review_request',
    trigger: 'order.delivered',
    templateKey: 'review_request',
    delaySeconds: 7 * 24 * 60 * 60, // 7 days
    variables: (ev) => {
      if (ev.type !== 'order.delivered') throw new Error('bad event')
      return { order_id: ev.orderId }
    },
    idempotency: (ev) => {
      if (ev.type !== 'order.delivered') throw new Error('bad event')
      return `review_request:${ev.orderId}`
    },
    label: 'Review request',
    description: 'Asks for a review 7 days after delivery.',
  },

  // ─── 2d. Transactional growth-adjacent (3) ─────────────────────────
  {
    key: 'abandoned_cart_reminder_1',
    trigger: 'checkout.abandoned',
    templateKey: 'abandoned_cart_recovery',
    delaySeconds: 60 * 60, // 1h
    variables: (ev) => {
      if (ev.type !== 'checkout.abandoned') throw new Error('bad event')
      return { checkout_id: ev.checkoutId }
    },
    idempotency: (ev) => {
      if (ev.type !== 'checkout.abandoned') throw new Error('bad event')
      return `abandoned_cart_reminder_1:${ev.checkoutId}`
    },
    label: 'Abandoned cart — reminder 1',
    description: 'First abandoned-cart nudge, 1h after abandonment.',
  },
  {
    key: 'abandoned_cart_reminder_2',
    trigger: 'checkout.abandoned',
    templateKey: 'abandoned_cart_reminder_2',
    delaySeconds: 24 * 60 * 60,
    variables: (ev) => {
      if (ev.type !== 'checkout.abandoned') throw new Error('bad event')
      return { checkout_id: ev.checkoutId }
    },
    idempotency: (ev) => {
      if (ev.type !== 'checkout.abandoned') throw new Error('bad event')
      return `abandoned_cart_reminder_2:${ev.checkoutId}`
    },
    label: 'Abandoned cart — reminder 2',
    description: 'Second abandoned-cart nudge, 24h after abandonment.',
  },
  {
    key: 'abandoned_cart_reminder_3',
    trigger: 'checkout.abandoned',
    templateKey: 'abandoned_cart_reminder_3',
    delaySeconds: 72 * 60 * 60,
    variables: (ev) => {
      if (ev.type !== 'checkout.abandoned') throw new Error('bad event')
      return { checkout_id: ev.checkoutId }
    },
    idempotency: (ev) => {
      if (ev.type !== 'checkout.abandoned') throw new Error('bad event')
      return `abandoned_cart_reminder_3:${ev.checkoutId}`
    },
    label: 'Abandoned cart — reminder 3',
    description: 'Final abandoned-cart nudge with optional discount, 72h after abandonment.',
  },
  {
    key: 'post_purchase_upsell',
    trigger: 'order.paid',
    templateKey: 'post_purchase_upsell',
    delaySeconds: 30 * 60, // 30m
    variables: (ev) => ({ order_id: asOrderPaid(ev).orderId }),
    idempotency: (ev) => `post_purchase_upsell:${asOrderPaid(ev).orderId}`,
    label: 'Post-purchase upsell',
    description: 'Offers a curated upsell 30 minutes after an order is paid.',
  },

  // ─── 2e. Merchant ops (1) ──────────────────────────────────────────
  {
    key: 'low_stock_alert',
    trigger: 'inventory.threshold_crossed',
    templateKey: 'low_stock_alert',
    delaySeconds: 0,
    variables: (ev) => {
      if (ev.type !== 'inventory.threshold_crossed') throw new Error('bad event')
      return {
        variant_id: ev.variantId,
        on_hand: ev.onHand,
        threshold: ev.threshold,
      }
    },
    // 24h cooldown baked into the idempotency key (YYYYMMDD slice).
    idempotency: (ev) => {
      if (ev.type !== 'inventory.threshold_crossed') throw new Error('bad event')
      const day = new Date(ev.occurredAt ?? Date.now()).toISOString().slice(0, 10)
      return `low_stock_alert:${ev.variantId}:${day}`
    },
    label: 'Low stock alert',
    description: 'Alerts the merchant when a variant crosses its low-stock threshold.',
  },

  // ─── 2f. Add-ons (3) ───────────────────────────────────────────────
  {
    key: 'fulfillment_out_for_delivery',
    trigger: 'fulfillment.out_for_delivery',
    templateKey: 'fulfillment_out_for_delivery',
    delaySeconds: 0,
    variables: (ev) => {
      if (ev.type !== 'fulfillment.out_for_delivery') throw new Error('bad event')
      return {
        order_id: ev.orderId,
        tracking_number: ev.trackingNumber ?? '',
        carrier: ev.carrier ?? '',
      }
    },
    idempotency: (ev) => {
      if (ev.type !== 'fulfillment.out_for_delivery') throw new Error('bad event')
      return `fulfillment_out_for_delivery:${ev.fulfillmentId}`
    },
    label: 'Out-for-delivery notification',
    description: 'Tells the customer their order is out for delivery.',
  },
  {
    key: 'payment_failed_customer',
    trigger: 'payment.failed',
    templateKey: 'payment_failed_customer',
    delaySeconds: 0,
    variables: (ev) => {
      if (ev.type !== 'payment.failed') throw new Error('bad event')
      return { order_id: ev.orderId, reason: ev.reason ?? '' }
    },
    idempotency: (ev) => {
      if (ev.type !== 'payment.failed') throw new Error('bad event')
      return `payment_failed_customer:${ev.orderId}`
    },
    label: 'Payment failed (customer)',
    description: 'Notifies the customer of a failed payment attempt.',
  },
  {
    key: 'high_value_order',
    trigger: 'order.paid',
    templateKey: 'high_value_order',
    delaySeconds: 0,
    // Default threshold: 50000 minor units ($500). Merchants override
    // via the /settings/automations UI writing `automation_flows.
    // conditions = {op:'gte', field:'event.totalPrice', value: X}`.
    defaultConditions: { op: 'gte', field: 'event.totalPrice', value: 50000 },
    variables: (ev) => ({
      order_id: asOrderPaid(ev).orderId,
      total_price: asOrderPaid(ev).totalPrice,
      currency: asOrderPaid(ev).currency,
    }),
    idempotency: (ev) => `high_value_order:${asOrderPaid(ev).orderId}`,
    label: 'High-value order alert',
    description: 'Alerts the merchant when an order exceeds the high-value threshold.',
  },

  // ─── Phase 14 PR6 — Finance / ops (10) ─────────────────────────────
  //
  // The 10 merchant-audience finance emails. 5 wire in PR6 (refund /
  // payment-failed-merchant / high-risk / out-of-stock / first-time-
  // customer), 5 are catalog-only until Phase 12 ships payouts +
  // chargebacks substrate.
  //
  // Merchants toggle these via the existing `/settings/automations`
  // UI (same table `automation_flows` as PR3). That's why every
  // finance entry has a label + description — the UI renders them
  // verbatim. Seller-safe copy only (no "god admin" leak — these are
  // merchant-audience).

  {
    key: 'refund_issued_merchant',
    trigger: 'refund.issued',
    templateKey: 'refund_issued_merchant',
    delaySeconds: 0,
    variables: (ev) => {
      const e = asRefundIssued(ev)
      return {
        refund_id: e.refundId,
        order_id: e.orderId,
        amount: e.amount,
        currency: e.currency,
        reason: e.reason ?? '',
      }
    },
    idempotency: (ev) => `refund_issued_merchant:${asRefundIssued(ev).refundId}`,
    label: 'Refund issued (merchant)',
    description: 'Notifies the merchant when a refund is approved on their store.',
  },
  {
    key: 'payment_failed_merchant',
    trigger: 'payment.failed',
    templateKey: 'payment_failed_merchant',
    delaySeconds: 0,
    variables: (ev) => {
      const e = asPaymentFailed(ev)
      return { order_id: e.orderId, reason: e.reason ?? '' }
    },
    // Distinct idempotency key from payment_failed_customer so the
    // same event fires both flows exactly once.
    idempotency: (ev) => `payment_failed_merchant:${asPaymentFailed(ev).orderId}`,
    label: 'Payment failed (merchant alert)',
    description: 'Alerts the merchant when a customer payment fails on their store.',
  },
  {
    key: 'high_risk_order',
    trigger: 'order.high_risk',
    templateKey: 'high_risk_order',
    delaySeconds: 0,
    variables: (ev) => {
      const e = asOrderHighRisk(ev)
      return {
        order_id: e.orderId,
        risk_score: e.riskScore,
        risk_factors: e.riskFactors.join(', '),
      }
    },
    idempotency: (ev) => `high_risk_order:${asOrderHighRisk(ev).orderId}`,
    label: 'High-risk order flag',
    description: 'Alerts the merchant when an order is flagged as potential fraud.',
  },
  {
    key: 'out_of_stock_alert',
    trigger: 'inventory.out_of_stock',
    templateKey: 'out_of_stock_alert',
    delaySeconds: 0,
    variables: (ev) => {
      const e = asInventoryOutOfStock(ev)
      return { variant_id: e.variantId, product_id: e.productId }
    },
    // 24h cooldown baked in: same variant going to zero twice on the
    // same day (restock → sell-out → restock → sell-out) only emails
    // once. Same YYYY-MM-DD slot trick as `low_stock_alert`.
    idempotency: (ev) => {
      const e = asInventoryOutOfStock(ev)
      const day = new Date(e.occurredAt ?? Date.now()).toISOString().slice(0, 10)
      return `out_of_stock_alert:${e.variantId}:${day}`
    },
    label: 'Out-of-stock alert',
    description: 'Alerts the merchant the moment a variant drops to zero on-hand.',
  },
  {
    key: 'first_time_customer_order',
    trigger: 'order.paid',
    templateKey: 'first_time_customer_order',
    delaySeconds: 0,
    // Distinct from PR3's `first_order_milestone` which sends to the
    // CUSTOMER 2h after checkout. This one sends to the MERCHANT
    // immediately. Both share the same event but have different
    // template + audience.
    defaultConditions: {
      op: 'and',
      children: [
        { op: 'eq', field: 'event.totalOrdersForCustomer', value: 1 },
        { op: 'truthy', field: 'event.customerId' },
      ],
    },
    variables: (ev) => ({
      order_id: asOrderPaid(ev).orderId,
      customer_id: asOrderPaid(ev).customerId ?? '',
      total_price: asOrderPaid(ev).totalPrice,
      currency: asOrderPaid(ev).currency,
    }),
    idempotency: (ev) => `first_time_customer_order:${asOrderPaid(ev).orderId}`,
    label: 'First-time customer order (merchant)',
    description: 'Notifies the merchant when an identified customer places their first order.',
  },

  // ─── Catalog-only (Phase 12 wires — 5 entries) ─────────────────────
  //
  // These 5 have no emit site in PR6. The flow catalog entries exist
  // so that:
  //   (a) merchants see toggles in /settings/automations today, even
  //       though nothing fires — "coming soon" UX beats "the UI
  //       doesn't know this exists yet" UX.
  //   (b) when Phase 12 writes `emit(db, { type: 'payout.completed',… })`
  //       the fan-out is immediate — no catalog change needed.
  //
  // Each uses `delaySeconds: 0` by default. Phase 12 can override via
  // `automation_flows.delay_seconds` if merchants want payout emails
  // to wait for funds-landed-in-bank rather than schedule-confirmed.

  {
    key: 'payout_scheduled',
    trigger: 'payout.scheduled',
    templateKey: 'payout_scheduled',
    delaySeconds: 0,
    variables: (ev) => {
      const e = asPayout(ev)
      if (e.type !== 'payout.scheduled') throw new Error('bad event')
      return {
        payout_id: e.payoutId,
        amount: e.amount,
        currency: e.currency,
        arrival_date: e.arrivalDate.toISOString().slice(0, 10),
      }
    },
    idempotency: (ev) => `payout_scheduled:${asPayout(ev).payoutId}`,
    label: 'Payout scheduled',
    description: 'Notifies the merchant when a payout is scheduled to their bank.',
  },
  {
    key: 'payout_completed',
    trigger: 'payout.completed',
    templateKey: 'payout_completed',
    delaySeconds: 0,
    variables: (ev) => {
      const e = asPayout(ev)
      return { payout_id: e.payoutId, amount: e.amount, currency: e.currency }
    },
    idempotency: (ev) => `payout_completed:${asPayout(ev).payoutId}`,
    label: 'Payout completed',
    description: 'Confirms funds have landed in the merchant bank account.',
  },
  {
    key: 'payout_failed',
    trigger: 'payout.failed',
    templateKey: 'payout_failed',
    delaySeconds: 0,
    variables: (ev) => {
      const e = asPayout(ev)
      if (e.type !== 'payout.failed') throw new Error('bad event')
      return {
        payout_id: e.payoutId,
        amount: e.amount,
        currency: e.currency,
        reason: e.reason ?? '',
      }
    },
    idempotency: (ev) => `payout_failed:${asPayout(ev).payoutId}`,
    label: 'Payout failed',
    description: 'Alerts the merchant when a scheduled payout cannot be delivered.',
  },
  {
    key: 'chargeback_opened',
    trigger: 'chargeback.opened',
    templateKey: 'chargeback_opened',
    delaySeconds: 0,
    variables: (ev) => {
      const e = asChargeback(ev)
      if (e.type !== 'chargeback.opened') throw new Error('bad event')
      return {
        chargeback_id: e.chargebackId,
        order_id: e.orderId,
        amount: e.amount,
        currency: e.currency,
        reason: e.reason ?? '',
        due_by: e.dueBy.toISOString().slice(0, 10),
      }
    },
    idempotency: (ev) => `chargeback_opened:${asChargeback(ev).chargebackId}`,
    label: 'Chargeback opened',
    description: 'Alerts the merchant when a customer files a chargeback.',
  },
  {
    key: 'chargeback_lost',
    trigger: 'chargeback.lost',
    templateKey: 'chargeback_lost',
    delaySeconds: 0,
    variables: (ev) => {
      const e = asChargeback(ev)
      return {
        chargeback_id: e.chargebackId,
        order_id: e.orderId,
        amount: e.amount,
        currency: e.currency,
      }
    },
    idempotency: (ev) => `chargeback_lost:${asChargeback(ev).chargebackId}`,
    label: 'Chargeback lost',
    description: 'Notifies the merchant when a chargeback dispute is ruled against them.',
  },
] as const

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** All 18 entries in declaration order. */
export const FLOW_CATALOG: readonly FlowCatalogEntry[] = ENTRIES

/** By-key index for O(1) lookup by the runner. */
export const FLOW_CATALOG_BY_KEY: Readonly<Record<string, FlowCatalogEntry>> =
  Object.freeze(
    Object.fromEntries(ENTRIES.map((e) => [e.key, e])),
  )

/**
 * All flows that should run on a given event type. Used by
 * `runner.dispatch` to fan out one event to many flows.
 */
export function flowsForEventType(type: AutomationEventType): readonly FlowCatalogEntry[] {
  return ENTRIES.filter((e) => e.trigger === type)
}

/** Look up a flow by key. Returns null for unknown keys. */
export function getFlow(key: string): FlowCatalogEntry | null {
  return FLOW_CATALOG_BY_KEY[key] ?? null
}
