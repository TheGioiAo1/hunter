/**
 * Gbox Platform — Order Event Sourcing (Shopify Order Timeline pattern)
 *
 * Every meaningful change to an order emits an immutable event row.
 * The `orders` row is still the canonical "current state" for fast
 * reads, but `order_events` gives us:
 *
 *   - A human-readable timeline UI (Shopify's #1 support tool).
 *   - Dispute evidence: "when was the tracking number added?".
 *   - Webhook fan-out: events can be streamed to apps/subscribers.
 *   - Analytics: conversion funnel, fulfillment SLA, etc.
 *
 * Rule: if a handler mutates an order row, it MUST also emit an event
 * in the same transaction. Use `emitOrderEvent` inside a Kysely
 * `db.transaction().execute()` block so atomicity is preserved.
 */

import type { Kysely, Transaction } from 'kysely'
import type { Database, OrderEventTable } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Selectable<T> = {
  [K in keyof T]: T[K] extends import('kysely').ColumnType<infer S, any, any>
    ? S
    : T[K]
}

export type OrderEvent = Selectable<OrderEventTable>

/**
 * Canonical event types. Extend as new flows are added; do NOT repurpose
 * an existing type for a new meaning — that breaks downstream consumers.
 */
export type OrderEventType =
  // Lifecycle
  | 'order_placed'
  | 'order_cancelled'
  | 'order_closed'
  | 'order_reopened'
  // Payment
  | 'payment_pending'
  | 'payment_authorized'
  | 'payment_captured'
  | 'payment_failed'
  | 'payment_voided'
  // Fulfillment
  | 'fulfillment_created'
  | 'fulfillment_shipped'
  | 'fulfillment_delivered'
  | 'fulfillment_cancelled'
  // Refunds
  | 'refund_requested'
  | 'refund_approved'
  | 'refund_rejected'
  | 'refund_issued'
  // Notes & edits
  | 'note_added'
  | 'tag_added'
  | 'tag_removed'
  | 'address_updated'
  | 'customer_linked'
  // Risk
  | 'risk_flagged'
  | 'risk_cleared'

export type OrderEventActorType =
  | 'system'
  | 'user'
  | 'customer'
  | 'app'
  | 'webhook'

export interface EmitOrderEventInput {
  shop_id: string
  order_id: string
  event_type: OrderEventType
  actor_type?: OrderEventActorType
  actor_id?: string | null
  message?: string | null
  data?: Record<string, unknown> | null
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

/**
 * Emit an order event. Accepts either a plain Kysely instance or an
 * active transaction — prefer passing the transaction when mutating the
 * order row so the event + mutation land atomically.
 */
export async function emitOrderEvent(
  dbOrTrx: Kysely<Database> | Transaction<Database>,
  input: EmitOrderEventInput,
): Promise<OrderEvent> {
  const row = await dbOrTrx
    .insertInto('order_events')
    .values({
      shop_id: input.shop_id,
      order_id: input.order_id,
      event_type: input.event_type,
      actor_type: input.actor_type ?? 'system',
      actor_id: input.actor_id ?? null,
      message: input.message ?? null,
      data: input.data ? (JSON.stringify(input.data) as any) : null,
    } as any)
    .returningAll()
    .executeTakeFirstOrThrow()

  return row as OrderEvent
}

/**
 * Fetch the full timeline for an order, newest first.
 */
export async function getOrderTimeline(
  db: Kysely<Database>,
  shop_id: string,
  order_id: string,
  limit: number = 100,
): Promise<OrderEvent[]> {
  const rows = await db
    .selectFrom('order_events')
    .selectAll()
    .where('shop_id', '=', shop_id)
    .where('order_id', '=', order_id)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute()

  return rows as OrderEvent[]
}

/**
 * Convenience: list recent events of a given type across a shop (e.g.
 * "all payment_failed in the last hour" for the fraud dashboard).
 */
export async function listShopEvents(
  db: Kysely<Database>,
  shop_id: string,
  event_type: OrderEventType,
  since: string,
  limit: number = 100,
): Promise<OrderEvent[]> {
  const rows = await db
    .selectFrom('order_events')
    .selectAll()
    .where('shop_id', '=', shop_id)
    .where('event_type', '=', event_type)
    .where('created_at', '>=', since)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute()

  return rows as OrderEvent[]
}
