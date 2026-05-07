/**
 * Orders Returns Service
 *
 * Return workflow state machine:
 *
 *   requested → approved → received → refunded → closed
 *                    ↘ rejected (terminal)
 *                    ↘ cancelled (terminal)
 *
 * The status CHECK constraint installed by migration 026 pins the
 * allowed set at the DB level; this module centralizes the transition
 * logic (side effects: refund row creation, inventory restock, order
 * return_status sync) so the store-admin UI, god-admin dashboard, and
 * REST API all agree on behavior.
 *
 * Extracted from `apps/store-admin/pages/orders-returns.ts` during the
 * Phase 9 schema-consistency audit.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReturnStatus =
  | 'requested'
  | 'approved'
  | 'received'
  | 'refunded'
  | 'closed'
  | 'rejected'
  | 'cancelled'

export interface CreateReturnParams {
  shopId: string
  orderId: string
  requestedBy?: string | null
  note?: string | null
  trackingNumber?: string | null
  trackingCompany?: string | null
  refundShipping?: boolean
  restock?: boolean
  lineItems: {
    lineItemId: string
    quantity: number
    reason?: string | null
  }[]
}

export interface CreatedReturn {
  id: string
  rma_number: string
  refund_amount: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate an RMA number — pattern: RMA-YYMMDD-RANDOM */
export function generateRmaNumber(): string {
  const now = new Date()
  const y = String(now.getFullYear()).slice(-2)
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase()
  return `RMA-${y}${m}${d}-${rand}`
}

// ---------------------------------------------------------------------------
// Create a new return
// ---------------------------------------------------------------------------

export async function createReturn(
  db: Kysely<Database>,
  params: CreateReturnParams,
): Promise<CreatedReturn> {
  if (params.lineItems.length === 0) {
    throw new Error('At least one line item is required for a return')
  }

  // Load the order + line items to compute refund amount
  const order = await db
    .selectFrom('orders')
    .selectAll()
    .where('id', '=', params.orderId)
    .where('shop_id', '=', params.shopId)
    .executeTakeFirst()
  if (!order) throw new Error('Order not found')

  const lineItems = await db
    .selectFrom('order_line_items')
    .selectAll()
    .where('order_id', '=', params.orderId)
    .execute()

  // Compute refund amount from selected items
  let refundAmount = 0
  for (const sel of params.lineItems) {
    const li = lineItems.find((l) => l.id === sel.lineItemId)
    if (!li) continue
    const qty = Math.max(
      1,
      Math.min(sel.quantity || li.quantity, Number(li.quantity)),
    )
    refundAmount += Number(li.price) * qty
  }
  if (params.refundShipping) {
    refundAmount += Number(order.total_shipping || 0)
  }

  const rmaNumber = generateRmaNumber()

  const inserted = await db
    .insertInto('returns')
    .values({
      order_id: params.orderId,
      shop_id: params.shopId,
      rma_number: rmaNumber,
      status: 'requested',
      reason: params.lineItems[0]?.reason ?? null,
      note: params.note ?? null,
      tracking_number: params.trackingNumber ?? null,
      tracking_company: params.trackingCompany ?? null,
      refund_amount: refundAmount.toFixed(2),
      refund_shipping: params.refundShipping === true,
      restock: params.restock !== false,
      requested_by: params.requestedBy ?? null,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()

  for (const rli of params.lineItems) {
    await db
      .insertInto('return_line_items')
      .values({
        return_id: inserted.id,
        line_item_id: rli.lineItemId,
        quantity: rli.quantity,
        reason: rli.reason ?? null,
        restock: params.restock !== false,
      })
      .execute()
  }

  // Update order-level return_status
  await db
    .updateTable('orders')
    .set({ return_status: 'return_in_progress' })
    .where('id', '=', params.orderId)
    .execute()

  // Timeline event
  await db
    .insertInto('order_events')
    .values({
      shop_id: params.shopId,
      order_id: params.orderId,
      event_type: 'return_requested',
      actor_type: params.requestedBy ? 'user' : 'system',
      actor_id: params.requestedBy ?? null,
      message: `Return requested (RMA: ${rmaNumber}) — ${params.lineItems.length} item(s), refund ${refundAmount.toFixed(2)}`,
      data: JSON.stringify({
        return_id: inserted.id,
        rma_number: rmaNumber,
        refund_amount: refundAmount,
      }) as any,
    })
    .execute()
    .catch(() => {})

  return {
    id: inserted.id,
    rma_number: rmaNumber,
    refund_amount: refundAmount.toFixed(2),
  }
}

// ---------------------------------------------------------------------------
// State transition
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<ReturnStatus, ReturnStatus[]> = {
  requested: ['approved', 'rejected', 'cancelled'],
  approved: ['received', 'cancelled'],
  received: ['refunded', 'closed'],
  refunded: ['closed'],
  closed: [],
  rejected: [],
  cancelled: [],
}

export interface TransitionReturnParams {
  shopId: string
  returnId: string
  newStatus: ReturnStatus
  actorId?: string | null
}

export async function transitionReturn(
  db: Kysely<Database>,
  params: TransitionReturnParams,
): Promise<{ previousStatus: ReturnStatus; newStatus: ReturnStatus }> {
  const row = await db
    .selectFrom('returns')
    .selectAll()
    .where('id', '=', params.returnId)
    .where('shop_id', '=', params.shopId)
    .executeTakeFirst()
  if (!row) throw new Error('Return not found')

  const current = row.status as ReturnStatus
  const allowed = VALID_TRANSITIONS[current] ?? []
  if (!allowed.includes(params.newStatus)) {
    throw new Error(
      `Invalid return state transition: ${current} → ${params.newStatus}`,
    )
  }

  // Apply base status change
  await db
    .updateTable('returns')
    .set({
      status: params.newStatus,
      updated_at: new Date().toISOString(),
      ...(params.newStatus === 'approved'
        ? { approved_by: params.actorId ?? null }
        : {}),
    } as any)
    .where('id', '=', params.returnId)
    .execute()

  // Side effects: refunded → create refund row + update order financial
  // status + restock if flagged
  if (params.newStatus === 'refunded') {
    const refundAmount = Number(row.refund_amount || 0)

    await db
      .insertInto('refunds')
      .values({
        order_id: row.order_id,
        note: `Refund for return ${row.rma_number}`,
        restock: row.restock,
      } as any)
      .execute()
      .catch(() => {})

    const order = await db
      .selectFrom('orders')
      .select(['total_price', 'financial_status'])
      .where('id', '=', row.order_id)
      .executeTakeFirst()
    if (order) {
      const isFullRefund = refundAmount >= Number(order.total_price)
      await db
        .updateTable('orders')
        .set({
          financial_status: isFullRefund ? 'refunded' : 'partially_refunded',
          return_status: 'returned',
        })
        .where('id', '=', row.order_id)
        .execute()
    }

    if (row.restock) {
      const rlis = await db
        .selectFrom('return_line_items')
        .selectAll()
        .where('return_id', '=', params.returnId)
        .execute()
      for (const rli of rlis) {
        const li = await db
          .selectFrom('order_line_items')
          .select(['product_id', 'variant_id'])
          .where('id', '=', rli.line_item_id)
          .executeTakeFirst()
        if (li?.variant_id) {
          await db
            .updateTable('product_variants')
            .set((eb: any) => ({
              inventory_quantity: eb('inventory_quantity', '+', rli.quantity),
            }))
            .where('id', '=', li.variant_id)
            .execute()
            .catch(() => {})
        }
      }
    }
  }

  // Side effect: cancelled → clear order.return_status if no other active
  if (params.newStatus === 'cancelled' || params.newStatus === 'rejected') {
    const other = await db
      .selectFrom('returns')
      .select('id')
      .where('order_id', '=', row.order_id)
      .where('id', '!=', params.returnId)
      .where('status', 'not in', ['cancelled', 'rejected', 'closed'])
      .execute()
    if (other.length === 0) {
      await db
        .updateTable('orders')
        .set({ return_status: null })
        .where('id', '=', row.order_id)
        .execute()
    }
  }

  // Timeline event for the transition
  await db
    .insertInto('order_events')
    .values({
      shop_id: params.shopId,
      order_id: row.order_id,
      event_type: `return_${params.newStatus}`,
      actor_type: params.actorId ? 'user' : 'system',
      actor_id: params.actorId ?? null,
      message: `Return ${row.rma_number ?? params.returnId} ${params.newStatus}`,
      data: JSON.stringify({
        return_id: params.returnId,
        previous: current,
        new: params.newStatus,
      }) as any,
    })
    .execute()
    .catch(() => {})

  return { previousStatus: current, newStatus: params.newStatus }
}
