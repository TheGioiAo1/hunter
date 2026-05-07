/**
 * Gbox Platform — Order Service
 *
 * Shopify-equivalent order lifecycle: create, fulfill, transact, refund.
 */

import { sql, type Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { classifyLifecycle } from '../customer-lifecycle/classifier.js'
import { emitIfEnabled } from '../automations/feature-flag.js'
import { withSerializable } from '../db/transaction.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateOrderInput {
  customer_id?: string | null
  email?: string | null
  phone?: string | null
  currency?: string
  note?: string | null
  tags?: string[] | null
  billing_address?: Record<string, unknown> | null
  shipping_address?: Record<string, unknown> | null
  line_items: CreateLineItemInput[]
  financial_status?: string
  send_receipt?: boolean
  transactions?: CreateTransactionInput[]
}

export interface CreateLineItemInput {
  variant_id?: string | null
  product_id?: string | null
  title: string
  variant_title?: string | null
  sku?: string | null
  quantity: number
  price: string
  total_discount?: string
  requires_shipping?: boolean
  taxable?: boolean
  gift_card?: boolean
  properties?: Record<string, string>[] | null
}

export interface UpdateOrderInput {
  email?: string | null
  phone?: string | null
  note?: string | null
  tags?: string[] | null
  shipping_address?: Record<string, unknown> | null
  billing_address?: Record<string, unknown> | null
}

export interface CreateFulfillmentInput {
  location_id?: string | null
  tracking_company?: string | null
  tracking_number?: string | null
  tracking_url?: string | null
  line_items: { line_item_id: string; quantity: number }[]
}

export interface CreateTransactionInput {
  kind: string
  amount: string
  currency?: string
  gateway: string
  status?: string
  authorization?: string | null
  error_code?: string | null
  message?: string | null
  parent_id?: string | null
  test?: boolean
}

export interface CreateRefundInput {
  note?: string | null
  restock?: boolean
  refund_line_items: { line_item_id: string; quantity: number; restock_type?: string }[]
  transactions?: CreateTransactionInput[]
}

export interface OrderFilters {
  status?: string
  financial_status?: string
  fulfillment_status?: string
  customer_id?: string
  created_at_min?: string
  created_at_max?: string
  search?: string
  ids?: string[]
}

export interface Pagination {
  limit?: number
  offset?: number
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Create an order with line items and optional initial transactions.
 *
 * Phase 15 PR1: this path is wrapped in a `SERIALIZABLE` transaction with
 * automatic retry on serialization conflict. Under concurrent load, two
 * checkouts targeting the last unit of inventory (or the same customer
 * row) both see a consistent snapshot, and the loser aborts with SQLSTATE
 * `40001` instead of physically oversell­ing. `withSerializable` retries
 * up to 3 times with exponential backoff so transient conflicts don't
 * bubble up as user-facing failures.
 */
export async function createOrder(
  db: Kysely<Database>,
  shopId: string,
  data: CreateOrderInput,
) {
  return withSerializable(db, async (trx) => {
    // Compute totals from line items
    let subtotal = 0
    let totalDiscounts = 0
    for (const li of data.line_items) {
      subtotal += parseFloat(li.price) * li.quantity
      totalDiscounts += parseFloat(li.total_discount ?? '0') * li.quantity
    }
    const totalPrice = subtotal - totalDiscounts

    const order = await trx
      .insertInto('orders')
      .values({
        shop_id: shopId,
        customer_id: data.customer_id ?? null,
        email: data.email ?? null,
        phone: data.phone ?? null,
        currency: data.currency,
        note: data.note ?? null,
        tags: data.tags ?? null,
        billing_address: data.billing_address
          ? JSON.stringify(data.billing_address)
          : null,
        shipping_address: data.shipping_address
          ? JSON.stringify(data.shipping_address)
          : null,
        financial_status: data.financial_status,
        subtotal_price: subtotal.toFixed(2),
        total_discounts: totalDiscounts.toFixed(2),
        total_price: totalPrice.toFixed(2),
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow()

    // Insert line items
    const lineItems = await trx
      .insertInto('order_line_items')
      .values(
        data.line_items.map((li) => ({
          order_id: order.id,
          variant_id: li.variant_id ?? null,
          product_id: li.product_id ?? null,
          title: li.title,
          variant_title: li.variant_title ?? null,
          sku: li.sku ?? null,
          quantity: li.quantity,
          price: li.price,
          total_discount: li.total_discount ?? '0',
          requires_shipping: li.requires_shipping,
          taxable: li.taxable,
          gift_card: li.gift_card,
          properties: li.properties ? JSON.stringify(li.properties) : null,
        })),
      )
      .returningAll()
      .execute()

    // Insert initial transactions if provided
    let transactions: any[] = []
    if (data.transactions && data.transactions.length > 0) {
      transactions = await trx
        .insertInto('transactions')
        .values(
          data.transactions.map((t) => ({
            order_id: order.id,
            kind: t.kind,
            amount: t.amount,
            currency: t.currency ?? data.currency ?? 'USD',
            gateway: t.gateway,
            status: t.status,
            authorization: t.authorization ?? null,
            error_code: t.error_code ?? null,
            message: t.message ?? null,
            parent_id: t.parent_id ?? null,
            test: t.test ?? false,
          })),
        )
        .returningAll()
        .execute()
    }

    // Update customer order count if customer_id present.
    //
    // Phase 4 PR3 — also bump `last_order_at` and reclassify
    // `lifecycle_stage` atomically inside this transaction. We read
    // the current orders_count once so we can compute the post-write
    // value and feed the classifier; the actual write still uses
    // `orders_count + 1` so we don't race against concurrent
    // createOrder calls on the same customer.
    if (data.customer_id) {
      const now = new Date()
      const existing = await trx
        .selectFrom('customers')
        .select(['orders_count'])
        .where('id', '=', data.customer_id)
        .executeTakeFirst()
      const nextOrdersCount = Number(existing?.orders_count ?? 0) + 1
      const nextStage = classifyLifecycle(
        {
          orders_count: nextOrdersCount,
          last_order_at: now, // just placed — 0 days since last order
        },
        now,
      )

      await trx
        .updateTable('customers')
        .set({
          orders_count: sql`orders_count + 1` as any,
          total_spent: sql`total_spent + ${totalPrice}` as any,
          last_order_at: now.toISOString(),
          lifecycle_stage: nextStage,
          updated_at: now.toISOString(),
        })
        .where('id', '=', data.customer_id)
        .execute()
    }

    return { ...order, line_items: lineItems, transactions }
  })
}

/**
 * Get an order with line items, fulfillments, and transactions.
 */
export async function getOrder(
  db: Kysely<Database>,
  shopId: string,
  id: string,
) {
  const order = await db
    .selectFrom('orders')
    .selectAll()
    .where('id', '=', id)
    .where('shop_id', '=', shopId)
    .executeTakeFirst()

  if (!order) return null

  const [lineItems, fulfillments, transactions, refunds] = await Promise.all([
    db
      .selectFrom('order_line_items')
      .selectAll()
      .where('order_id', '=', id)
      .execute(),
    db
      .selectFrom('fulfillments')
      .selectAll()
      .where('order_id', '=', id)
      .orderBy('created_at', 'asc')
      .execute(),
    db
      .selectFrom('transactions')
      .selectAll()
      .where('order_id', '=', id)
      .orderBy('created_at', 'asc')
      .execute(),
    db
      .selectFrom('refunds')
      .selectAll()
      .where('order_id', '=', id)
      .orderBy('created_at', 'asc')
      .execute(),
  ])

  return {
    ...order,
    line_items: lineItems,
    fulfillments,
    transactions,
    refunds,
  }
}

/**
 * Update mutable order fields.
 */
export async function updateOrder(
  db: Kysely<Database>,
  shopId: string,
  id: string,
  data: UpdateOrderInput,
) {
  const updateData: Record<string, unknown> = {
    ...data,
    updated_at: new Date().toISOString(),
  }

  if (data.billing_address !== undefined) {
    updateData.billing_address = data.billing_address
      ? JSON.stringify(data.billing_address)
      : null
  }
  if (data.shipping_address !== undefined) {
    updateData.shipping_address = data.shipping_address
      ? JSON.stringify(data.shipping_address)
      : null
  }

  const row = await db
    .updateTable('orders')
    .set(updateData as any)
    .where('id', '=', id)
    .where('shop_id', '=', shopId)
    .returningAll()
    .executeTakeFirstOrThrow()

  return row
}

/**
 * Cancel an order.
 */
export async function cancelOrder(
  db: Kysely<Database>,
  shopId: string,
  id: string,
  reason?: string,
) {
  const now = new Date().toISOString()
  const row = await db
    .updateTable('orders')
    .set({
      cancel_reason: reason ?? null,
      cancelled_at: now,
      closed_at: now,
      financial_status: 'voided',
      updated_at: now,
    } as any)
    .where('id', '=', id)
    .where('shop_id', '=', shopId)
    .returningAll()
    .executeTakeFirstOrThrow()

  return row
}

/**
 * List orders with filters and pagination.
 */
export async function listOrders(
  db: Kysely<Database>,
  shopId: string,
  filters: OrderFilters = {},
  pagination: Pagination = {},
) {
  const { limit = 50, offset = 0 } = pagination

  let query = db
    .selectFrom('orders')
    .selectAll()
    .where('shop_id', '=', shopId)

  let countQuery = db
    .selectFrom('orders')
    .select(db.fn.countAll<number>().as('count'))
    .where('shop_id', '=', shopId)

  if (filters.financial_status) {
    query = query.where('financial_status', '=', filters.financial_status)
    countQuery = countQuery.where('financial_status', '=', filters.financial_status)
  }

  if (filters.fulfillment_status) {
    query = query.where('fulfillment_status', '=', filters.fulfillment_status)
    countQuery = countQuery.where('fulfillment_status', '=', filters.fulfillment_status)
  }

  if (filters.customer_id) {
    query = query.where('customer_id', '=', filters.customer_id)
    countQuery = countQuery.where('customer_id', '=', filters.customer_id)
  }

  if (filters.created_at_min) {
    query = query.where('created_at', '>=', filters.created_at_min)
    countQuery = countQuery.where('created_at', '>=', filters.created_at_min)
  }

  if (filters.created_at_max) {
    query = query.where('created_at', '<=', filters.created_at_max)
    countQuery = countQuery.where('created_at', '<=', filters.created_at_max)
  }

  if (filters.ids && filters.ids.length > 0) {
    query = query.where('id', 'in', filters.ids)
    countQuery = countQuery.where('id', 'in', filters.ids)
  }

  if (filters.search) {
    const pattern = `%${filters.search}%`
    query = query.where((eb) =>
      eb.or([
        eb('email', 'ilike', pattern),
        eb('note', 'ilike', pattern),
      ]),
    )
    countQuery = countQuery.where((eb) =>
      eb.or([
        eb('email', 'ilike', pattern),
        eb('note', 'ilike', pattern),
      ]),
    )
  }

  const [rows, countRow] = await Promise.all([
    query.orderBy('created_at', 'desc').limit(limit).offset(offset).execute(),
    countQuery.executeTakeFirstOrThrow(),
  ])

  return { orders: rows, total: Number(countRow.count) }
}

/**
 * Create a fulfillment for an order.
 */
export async function createFulfillment(
  db: Kysely<Database>,
  orderId: string,
  data: CreateFulfillmentInput,
) {
  const { fulfillment, newStatus, orderShopId, orderCustomerId } = await db
    .transaction()
    .execute(async (trx) => {
      const fulfillment = await trx
        .insertInto('fulfillments')
        .values({
          order_id: orderId,
          location_id: data.location_id ?? null,
          tracking_company: data.tracking_company ?? null,
          tracking_number: data.tracking_number ?? null,
          tracking_url: data.tracking_url ?? null,
          status: 'success',
        })
        .returningAll()
        .executeTakeFirstOrThrow()

      // Insert fulfillment line items
      if (data.line_items.length > 0) {
        await trx
          .insertInto('fulfillment_line_items')
          .values(
            data.line_items.map((li) => ({
              fulfillment_id: fulfillment.id,
              line_item_id: li.line_item_id,
              quantity: li.quantity,
            })),
          )
          .execute()

        // Update line item fulfillment_status
        for (const li of data.line_items) {
          await trx
            .updateTable('order_line_items')
            .set({ fulfillment_status: 'fulfilled' } as any)
            .where('id', '=', li.line_item_id)
            .execute()
        }
      }

      // Recompute order fulfillment_status
      const unfulfilled = await trx
        .selectFrom('order_line_items')
        .select(trx.fn.countAll<number>().as('count'))
        .where('order_id', '=', orderId)
        .where('fulfillment_status', '!=', 'fulfilled')
        .executeTakeFirstOrThrow()

      const newStatus = Number(unfulfilled.count) === 0 ? 'fulfilled' : 'partial'
      await trx
        .updateTable('orders')
        .set({ fulfillment_status: newStatus, updated_at: new Date().toISOString() } as any)
        .where('id', '=', orderId)
        .execute()

      // Pull shop_id + customer_id INSIDE the transaction (same snapshot
      // semantics) so the PR3 automation emit below has what it needs.
      const orderRow = await trx
        .selectFrom('orders')
        .select(['shop_id', 'customer_id'])
        .where('id', '=', orderId)
        .executeTakeFirst()

      return {
        fulfillment,
        newStatus,
        orderShopId: orderRow?.shop_id ?? null,
        orderCustomerId: orderRow?.customer_id ?? null,
      }
    })

  // --- PR3 automation emits --------------------------------------------
  // Emit OUTSIDE the transaction so an automation_events insert failure
  // can't roll back the fulfillment. Gate on AUTOMATION_FRAMEWORK_V2 so
  // flag-off is a zero-behavior-change rollback.
  //
  //   - fulfillment.out_for_delivery: every new fulfillment with a
  //     tracking number fires this (Shopify semantic — tracked =
  //     "package is on its way"). Idempotency key = fulfillmentId, so
  //     updates don't re-fire.
  //   - order.fulfilled: only on the rising-edge partial → fulfilled
  //     transition.
  if (orderShopId) {
    if (data.tracking_number) {
      await emitIfEnabled(db, {
        type: 'fulfillment.out_for_delivery',
        shopId: orderShopId,
        orderId,
        customerId: orderCustomerId,
        fulfillmentId: fulfillment.id,
        trackingNumber: data.tracking_number ?? null,
        carrier: data.tracking_company ?? null,
      })
    }
    if (newStatus === 'fulfilled') {
      await emitIfEnabled(db, {
        type: 'order.fulfilled',
        shopId: orderShopId,
        orderId,
        customerId: orderCustomerId,
        fulfillmentId: fulfillment.id,
      })
    }
  }

  return fulfillment
}

/**
 * Record a transaction against an order.
 */
export async function createTransaction(
  db: Kysely<Database>,
  orderId: string,
  data: CreateTransactionInput,
) {
  const transaction = await db
    .insertInto('transactions')
    .values({
      order_id: orderId,
      kind: data.kind,
      amount: data.amount,
      currency: data.currency ?? 'USD',
      gateway: data.gateway,
      status: data.status,
      authorization: data.authorization ?? null,
      error_code: data.error_code ?? null,
      message: data.message ?? null,
      // NOTE: `parent_id` and `test` are part of the input shape for
      // forward compatibility (a future migration adds these columns to
      // model refunds-of-refunds and sandbox traffic), but the current
      // schema does not declare them — so we don't pass them through.
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  // If this is a successful capture/sale, update financial_status to paid
  const isSuccessfulCapture =
    (data.kind === 'capture' || data.kind === 'sale') &&
    (data.status === 'success' || !data.status)
  if (isSuccessfulCapture) {
    await db
      .updateTable('orders')
      .set({ financial_status: 'paid', updated_at: new Date().toISOString() } as any)
      .where('id', '=', orderId)
      .execute()
  }

  // --- PR3 automation emits --------------------------------------------
  // Emit `order.paid` on successful capture/sale, `payment.failed` on
  // status=failed. Both behind AUTOMATION_FRAMEWORK_V2 so flag-off is
  // a zero-behavior-change rollback.
  //
  // We enrich with shop_id / customer_id / total_price / currency by
  // loading the order row once. For order.paid, we also count prior
  // orders to populate `totalOrdersForCustomer` — cheap enough for the
  // flow-catalog's `first_order_milestone` condition (= 1) to evaluate
  // without re-querying.
  const shouldEmitPaid = isSuccessfulCapture
  const shouldEmitFailed = data.status === 'failed'
  if (shouldEmitPaid || shouldEmitFailed) {
    const order = await db
      .selectFrom('orders')
      .select([
        'shop_id',
        'customer_id',
        'total_price',
        'currency',
        // Phase 14 PR6 — risk signals for order.high_risk emit
        'risk_level',
        'fraud_score',
        'risk_flags',
      ])
      .where('id', '=', orderId)
      .executeTakeFirst()
    if (order) {
      if (shouldEmitPaid) {
        // Count prior orders (inclusive of this one) for the customer.
        // null customer → treat as 1 (guest checkout = their first/only
        // order under this customer identity).
        let totalOrdersForCustomer = 1
        if (order.customer_id) {
          const countRow = await db
            .selectFrom('orders')
            .select(db.fn.countAll<string>().as('count'))
            .where('shop_id', '=', order.shop_id)
            .where('customer_id', '=', order.customer_id)
            .executeTakeFirst()
          if (countRow) totalOrdersForCustomer = Number(countRow.count) || 1
        }
        // total_price is stored as numeric (string); flow condition on
        // high_value_order gates at `>= 50000` (cents). Parse to a
        // minor-unit integer via cents-of-dollars × 100.
        const totalPriceCents = Math.round(
          Number(order.total_price ?? 0) * 100,
        )
        await emitIfEnabled(db, {
          type: 'order.paid',
          shopId: order.shop_id,
          orderId,
          customerId: order.customer_id ?? null,
          totalPrice: totalPriceCents,
          currency: order.currency ?? 'USD',
          totalOrdersForCustomer,
        })

        // Phase 14 PR6 commit 5d — fire `order.high_risk` when the
        // paid order is flagged high-risk by the fraud engine or the
        // risk_level shell. Two signal sources, checked in priority:
        //
        //   1. `fraud_score >= 75` — authoritative when the engine has
        //      scored the order (migration 027; null = unscored).
        //      Threshold 75 mirrors Shopify's "high" band and is hard
        //      coded for PR6 (per-shop override deferred to Phase 17's
        //      shop_risk_settings table).
        //   2. `risk_level === 'high'` — fallback when fraud_score is
        //      null (engine didn't run or this is a legacy order).
        //      risk_level is a varchar shell written by migration 024
        //      and is the only signal before the engine ships.
        //
        // Fire-and-forget. A failed high-risk email must not block the
        // order.paid emit or the transaction insert above. The event
        // bus itself logs dispatch errors, so we only catch TS-import
        // failures here.
        const fraudScore = order.fraud_score
        const riskLevel = (order.risk_level ?? 'low').toLowerCase()
        const isHighRisk =
          (typeof fraudScore === 'number' && fraudScore >= 75) ||
          (fraudScore == null && riskLevel === 'high')
        if (isHighRisk) {
          const flags = Array.isArray(order.risk_flags)
            ? (order.risk_flags as readonly string[])
            : []
          void (async () => {
            try {
              const { emit } = await import('../automations/events.js')
              await emit(db, {
                type: 'order.high_risk',
                shopId: order.shop_id,
                orderId,
                customerId: order.customer_id ?? null,
                riskScore:
                  typeof fraudScore === 'number'
                    ? fraudScore
                    : // No engine score — normalise risk_level to a
                      // synthetic score so downstream templates have a
                      // number to render. 'high' → 75 (threshold), to
                      // match the "just crossed the line" semantics.
                      75,
                riskFactors: [...flags],
              })
            } catch (err) {
              // eslint-disable-next-line no-console
              console.warn(
                '[orders] order.high_risk automation emit failed',
                err instanceof Error ? err.message : err,
              )
            }
          })()
        }
      }
      if (shouldEmitFailed) {
        await emitIfEnabled(db, {
          type: 'payment.failed',
          shopId: order.shop_id,
          orderId,
          customerId: order.customer_id ?? null,
          reason: data.error_code ?? data.message ?? null,
        })
      }
    }
  }

  return transaction
}

/**
 * Create a refund for an order.
 */
export async function createRefund(
  db: Kysely<Database>,
  orderId: string,
  data: CreateRefundInput,
) {
  const result = await db.transaction().execute(async (trx) => {
    const refund = await trx
      .insertInto('refunds')
      .values({
        order_id: orderId,
        note: data.note ?? null,
        restock: data.restock ?? false,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    // Insert refund line items
    if (data.refund_line_items.length > 0) {
      await trx
        .insertInto('refund_line_items')
        .values(
          data.refund_line_items.map((rli) => ({
            refund_id: refund.id,
            line_item_id: rli.line_item_id,
            quantity: rli.quantity,
            restock_type: rli.restock_type ?? 'no_restock',
          })),
        )
        .execute()
    }

    // Create refund transactions if supplied
    let transactions: any[] = []
    if (data.transactions && data.transactions.length > 0) {
      transactions = await trx
        .insertInto('transactions')
        .values(
          data.transactions.map((t) => ({
            order_id: orderId,
            kind: 'refund' as const,
            amount: t.amount,
            currency: t.currency ?? 'USD',
            gateway: t.gateway,
            status: t.status ?? 'success',
            authorization: t.authorization ?? null,
            error_code: t.error_code ?? null,
            message: t.message ?? null,
            parent_id: t.parent_id ?? null,
            test: t.test ?? false,
          })),
        )
        .returningAll()
        .execute()
    }

    // Update order financial_status
    await trx
      .updateTable('orders')
      .set({
        financial_status: 'partially_refunded',
        updated_at: new Date().toISOString(),
      } as any)
      .where('id', '=', orderId)
      .execute()

    return { ...refund, refund_line_items: data.refund_line_items, transactions }
  })

  // Phase 14 PR6 commit 5 — fire the `refund.issued` automation event
  // AFTER the transaction commits. Running this inside the trx would
  // emit even on rollback; running it outside means a rolled-back
  // refund never triggers an email. Fire-and-forget so a dead event
  // bus can't break the refund flow itself.
  //
  // The event fans out to 2 flows today:
  //   - refund_issued_merchant (PR6 — merchant inbox alert)
  //   - [Phase 15+] refund_issued_customer if we add one
  //
  // amount conversion: transactions.amount is stored as numeric(10,2)
  // string in the DB (e.g. "100.50"). The event contract asks for
  // minor currency units (cents), so we multiply by 100 and round.
  // Sum across all refund transactions so a multi-capture refund
  // reports the total.
  void (async () => {
    try {
      const order = await db
        .selectFrom('orders')
        .select(['shop_id', 'customer_id'])
        .where('id', '=', orderId)
        .executeTakeFirst()
      if (!order?.shop_id) return
      const totalCents = result.transactions.reduce((sum: number, t: any) => {
        const n = Number(t.amount)
        return Number.isFinite(n) ? sum + Math.round(n * 100) : sum
      }, 0)
      const currency = result.transactions[0]?.currency ?? 'USD'
      const { emit } = await import('../automations/events.js')
      await emit(db, {
        type: 'refund.issued',
        shopId: order.shop_id,
        refundId: String(result.id),
        orderId,
        customerId: order.customer_id ?? null,
        amount: totalCents,
        currency,
        reason: data.note ?? null,
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[orders] refund.issued automation emit failed',
        err instanceof Error ? err.message : err,
      )
    }
  })()

  return result
}
