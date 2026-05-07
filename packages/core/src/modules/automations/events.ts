/**
 * Gbox Platform — Automation events + domain event bus (Phase 14 PR3)
 *
 * The event bus is intentionally thin: call sites emit a typed event
 * via `emit(db, event)`, which
 *
 *   1. Inserts an append-only row into `automation_events` (durable
 *      audit — see migration 085).
 *   2. Synchronously calls `dispatch(db, event)` from runner.ts to
 *      evaluate the flow catalog and either send-now (delay=0) or
 *      enqueue into `automation_scheduled`.
 *
 * Why synchronous dispatch: PR3 ships with a single API process and a
 * 60s cron for delayed sends. Deferring dispatch to a queue would
 * double the latency of "order.paid → sent email" with no win.
 * Horizontal scale (multi-worker) is a Phase 15 concern; the
 * `automation_scheduled` queue + `FOR UPDATE SKIP LOCKED` semantics
 * in scheduler.ts are already safe for that, we just don't exercise
 * them yet.
 *
 * Why a discriminated union instead of a loose `{ type: string,
 * payload: any }`: the 12 emit sites are scattered across the
 * codebase. A union catches typos at compile time — if `orders/
 * service.ts::markOrderPaid` tries to emit `order.pad` instead of
 * `order.paid`, the TS build fails. Same rigour as a well-typed API
 * boundary.
 *
 * Iron rule 5: events are seller-scoped by `shopId`. The runner will
 * still filter templates through the existing iron-rule-5 gate in
 * send.ts, so a hostile consumer can't bypass it by emitting custom
 * events.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Event types — the authoritative spec for what can be emitted
// ---------------------------------------------------------------------------

/**
 * Every automation event carries `shopId` and is scoped to a single
 * merchant. Non-merchant-scoped events (e.g. platform-level billing
 * failure) do NOT go through this bus — they use direct
 * `sendTemplatedEmail({ shopId: null })` calls.
 *
 * `occurredAt` is optional on the input side — if omitted, the DB's
 * `now()` default fills it in. Tests can pass a fixed value for
 * determinism.
 */
export type AutomationEvent =
  // Order lifecycle
  | {
      type: 'order.paid'
      shopId: string
      orderId: string
      customerId: string | null
      totalPrice: number           // in minor currency units
      currency: string             // ISO-4217
      totalOrdersForCustomer: number  // so first_order_milestone doesn't reload
      occurredAt?: Date
    }
  | {
      type: 'order.fulfilled'
      shopId: string
      orderId: string
      customerId: string | null
      fulfillmentId: string
      occurredAt?: Date
    }
  | {
      type: 'order.delivered'
      shopId: string
      orderId: string
      customerId: string | null
      fulfillmentId: string
      occurredAt?: Date
    }

  // Fulfillment lifecycle
  | {
      type: 'fulfillment.out_for_delivery'
      shopId: string
      orderId: string
      customerId: string | null
      fulfillmentId: string
      trackingNumber: string | null
      carrier: string | null
      occurredAt?: Date
    }

  // Payment lifecycle
  | {
      type: 'payment.failed'
      shopId: string
      orderId: string
      customerId: string | null
      reason: string | null
      occurredAt?: Date
    }

  // Product lifecycle
  | {
      type: 'product.published'
      shopId: string
      productId: string
      firstPublish: boolean        // gate for product_launch
      occurredAt?: Date
    }

  // Inventory
  | {
      type: 'inventory.restocked'
      shopId: string
      variantId: string
      previousOnHand: number
      newOnHand: number
      occurredAt?: Date
    }
  | {
      type: 'inventory.threshold_crossed'
      shopId: string
      variantId: string
      onHand: number
      threshold: number
      occurredAt?: Date
    }

  // Customer lifecycle
  | {
      type: 'customer.created'
      shopId: string
      customerId: string
      hasOrdered: boolean          // usually false at create time
      occurredAt?: Date
    }
  | {
      type: 'customer.dormant_detected'
      shopId: string
      customerId: string
      lastOrderAt: Date
      occurredAt?: Date
    }

  // Campaigns
  | {
      type: 'campaign.scheduled'
      shopId: string
      campaignId: string
      campaignType: 'newsletter' | 'flash_sale' | 'seasonal' | 'promo'
      sendAt: Date
      occurredAt?: Date
    }

  // Abandoned-cart (Phase 8 migration)
  | {
      type: 'checkout.abandoned'
      shopId: string
      checkoutId: string
      customerEmail: string | null
      customerId: string | null
      abandonedAt: Date
      occurredAt?: Date
    }

  // ─── Phase 14 PR6 — finance / ops events ──────────────────────────
  //
  // All 8 events are merchant-scoped (shopId-required). The runner
  // fans them out to the flow catalog entries declared in
  // `flow-catalog.ts`. Naming follows the PR3 pattern:
  //   <domain>.<event>, present tense.
  //
  // The 5 payout/chargeback events are defined NOW so the types +
  // fan-out are ready when Phase 12 wires Stripe Connect + the
  // chargeback webhook — there is no emit site in PR6. Adding the
  // types now means that Phase 12 only needs to write `emit(db, { type:
  // 'payout.completed', … })` and the email goes out.
  //
  // The 3 refund/high-risk/out-of-stock events have emit sites in
  // PR6 commit 5.

  // Payments / payouts (Phase 12 wires)
  | {
      type: 'payout.scheduled'
      shopId: string
      payoutId: string
      amount: number       // minor currency units
      currency: string     // ISO-4217
      arrivalDate: Date    // when funds land in merchant's bank
      occurredAt?: Date
    }
  | {
      type: 'payout.completed'
      shopId: string
      payoutId: string
      amount: number
      currency: string
      occurredAt?: Date
    }
  | {
      type: 'payout.failed'
      shopId: string
      payoutId: string
      amount: number
      currency: string
      reason: string | null
      occurredAt?: Date
    }
  | {
      type: 'chargeback.opened'
      shopId: string
      chargebackId: string
      orderId: string
      amount: number       // minor currency units
      currency: string
      reason: string | null
      dueBy: Date          // evidence submission deadline
      occurredAt?: Date
    }
  | {
      type: 'chargeback.lost'
      shopId: string
      chargebackId: string
      orderId: string
      amount: number
      currency: string
      occurredAt?: Date
    }

  // Refund lifecycle (PR6 wires)
  | {
      type: 'refund.issued'
      shopId: string
      refundId: string
      orderId: string
      customerId: string | null
      amount: number       // minor currency units
      currency: string
      reason: string | null
      occurredAt?: Date
    }

  // Order risk (PR6 wires — merchant-audience flag, distinct from
  // the platform_fraud_review which is god-admin-audience)
  | {
      type: 'order.high_risk'
      shopId: string
      orderId: string
      customerId: string | null
      riskScore: number    // 0-100 — scope doc §2 default threshold is 75
      riskFactors: string[] // human-readable labels, e.g. ['billing_shipping_mismatch', 'cvv_mismatch']
      occurredAt?: Date
    }

  // Inventory zero (PR6 wires — mirrors PR3's inventory.threshold_crossed
  // but at on_hand=0 specifically, so the merchant sees "sold out"
  // instead of "low" separately)
  | {
      type: 'inventory.out_of_stock'
      shopId: string
      variantId: string
      productId: string
      occurredAt?: Date
    }

/** Narrow helper — extract the literal type string union. */
export type AutomationEventType = AutomationEvent['type']

// ---------------------------------------------------------------------------
// emit() — the single entry point for every call site
// ---------------------------------------------------------------------------

/**
 * Result handle from `emit()`. Callers rarely need it — the event row
 * is already persisted and dispatch has returned — but tests + audit
 * consumers may want the event id for linking back.
 */
export interface EmitResult {
  eventId: string
  dispatched: boolean  // true iff at least one flow was evaluated
}

/**
 * Persist + dispatch a domain event.
 *
 * IMPORTANT: `emit()` is NOT wrapped in a transaction. The event row
 * must commit even if dispatch fails — otherwise an SMTP blip loses
 * the audit trail. The runner handles its own per-flow rollback.
 *
 * Dispatch is loaded via dynamic import to avoid a circular dep
 * (runner imports from events for the type union; events imports
 * runner for dispatch). Same pattern as `send.ts` lazy-imports
 * `service.ts`.
 */
export async function emit(
  db: Kysely<Database>,
  event: AutomationEvent,
): Promise<EmitResult> {
  const { payload, shopId, type } = normaliseEventForInsert(event)

  const row = await db
    .insertInto('automation_events')
    .values({
      shop_id: shopId,
      type,
      // JsonB columns are ColumnType<T, string, string> — we must
      // JSON.stringify before insert. Kysely does NOT auto-serialise
      // object → JSON for JSONB columns (see tables.ts line 28).
      payload: JSON.stringify(payload),
      // created_at defaults to now() via the DB schema
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()

  // Lazy-import to break the runner↔events cycle. Dispatcher owns the
  // flow catalog lookup + conditions evaluation + send path. Any
  // throw from dispatch is caught here so the emit call site doesn't
  // see email-pipeline failures for an orthogonal concern (e.g. a
  // failed promo flow can't block the order.paid emit).
  let dispatched = false
  try {
    const { dispatch } = await import('./runner.js')
    await dispatch(db, {
      eventId: row.id,
      event,
    })
    dispatched = true
  } catch (err) {
    // Runner failures are recorded via automation_runs rows inside
    // the runner itself; this catch is belt-and-suspenders so a
    // crash in the TS import layer (missing file, transient FS
    // issue) still lets the caller proceed.
    // eslint-disable-next-line no-console
    console.error('[automations] dispatch failed', {
      eventId: row.id,
      type,
      err: err instanceof Error ? err.message : String(err),
    })
  }

  return { eventId: row.id, dispatched }
}

/**
 * Internal: shape the event for the DB insert. Strips transient fields
 * (`occurredAt`) and folds the rest into the JSONB payload column.
 * Keeping this pure makes it directly unit-testable.
 */
export function normaliseEventForInsert(event: AutomationEvent): {
  shopId: string
  type: AutomationEventType
  payload: Record<string, unknown>
} {
  const { type, shopId, ...rest } = event
  // We keep `occurredAt` in payload so the run ledger can reason
  // about "event time" vs "dispatch time" if they diverge.
  const payload: Record<string, unknown> = { ...rest }
  if (rest.occurredAt instanceof Date) {
    payload.occurredAt = rest.occurredAt.toISOString()
  }
  return { shopId, type, payload }
}

// ---------------------------------------------------------------------------
// Type guards for downstream consumers
// ---------------------------------------------------------------------------

/**
 * Runtime type guard. Lets consumers (flow-catalog condition
 * evaluators, runner context loaders) narrow an untyped `AutomationEvent`
 * coming back from a DB row without duplicating the discriminator
 * string everywhere.
 */
export function isEventOfType<T extends AutomationEventType>(
  event: AutomationEvent,
  type: T,
): event is Extract<AutomationEvent, { type: T }> {
  return event.type === type
}
