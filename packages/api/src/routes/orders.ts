/**
 * Gbox Platform — Order API Routes
 *
 * Shopify-compatible REST endpoints for orders, fulfillments,
 * transactions, and refunds.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import * as OrderService from '@gbox/core/modules/orders/service.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(message: string, status: number): Response {
  return json({ errors: [message] }, status)
}

function parsePagination(url: URL) {
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 250)
  const page = Math.max(Number(url.searchParams.get('page') ?? 1), 1)
  return { limit, offset: (page - 1) * limit }
}

// ---------------------------------------------------------------------------
// GET /api/2026-04/orders.json
// ---------------------------------------------------------------------------

export async function listOrders(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
): Promise<Response> {
  try {
    const url = new URL(request.url)
    const pagination = parsePagination(url)

    const filters: OrderService.OrderFilters = {}
    const financialStatus = url.searchParams.get('financial_status')
    if (financialStatus) filters.financial_status = financialStatus
    const fulfillmentStatus = url.searchParams.get('fulfillment_status')
    if (fulfillmentStatus) filters.fulfillment_status = fulfillmentStatus
    const customerId = url.searchParams.get('customer_id')
    if (customerId) filters.customer_id = customerId
    const createdAtMin = url.searchParams.get('created_at_min')
    if (createdAtMin) filters.created_at_min = createdAtMin
    const createdAtMax = url.searchParams.get('created_at_max')
    if (createdAtMax) filters.created_at_max = createdAtMax
    const ids = url.searchParams.get('ids')
    if (ids) filters.ids = ids.split(',')
    const status = url.searchParams.get('status')
    if (status) filters.status = status

    const result = await OrderService.listOrders(db, shopId, filters, pagination)

    return json({ orders: result.orders })
  } catch (err) {
    return errorResponse('Failed to list orders', 500)
  }
}

// ---------------------------------------------------------------------------
// GET /api/2026-04/orders/:id.json
// ---------------------------------------------------------------------------

export async function getOrder(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  orderId: string,
): Promise<Response> {
  try {
    const order = await OrderService.getOrder(db, shopId, orderId)
    if (!order) {
      return errorResponse('Order not found', 404)
    }
    return json({ order })
  } catch (err) {
    return errorResponse('Failed to get order', 500)
  }
}

// ---------------------------------------------------------------------------
// POST /api/2026-04/orders.json
// ---------------------------------------------------------------------------

export async function createOrder(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as { order: OrderService.CreateOrderInput }
    if (!body.order) {
      return errorResponse('Missing "order" in request body', 422)
    }

    if (!body.order.line_items || body.order.line_items.length === 0) {
      return errorResponse('At least one line item is required', 422)
    }

    const order = await OrderService.createOrder(db, shopId, body.order)
    return json({ order }, 201)
  } catch (err) {
    return errorResponse('Failed to create order', 500)
  }
}

// ---------------------------------------------------------------------------
// PUT /api/2026-04/orders/:id.json
// ---------------------------------------------------------------------------

export async function updateOrder(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  orderId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as { order: OrderService.UpdateOrderInput }
    if (!body.order) {
      return errorResponse('Missing "order" in request body', 422)
    }

    const order = await OrderService.updateOrder(db, shopId, orderId, body.order)
    return json({ order })
  } catch (err) {
    return errorResponse('Failed to update order', 500)
  }
}

// ---------------------------------------------------------------------------
// POST /api/2026-04/orders/:id/cancel.json
// ---------------------------------------------------------------------------

export async function cancelOrder(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  orderId: string,
): Promise<Response> {
  try {
    const body = (await request.json().catch(() => ({}))) as { reason?: string }
    const order = await OrderService.cancelOrder(db, shopId, orderId, body.reason)
    return json({ order })
  } catch (err) {
    return errorResponse('Failed to cancel order', 500)
  }
}

// ---------------------------------------------------------------------------
// POST /api/2026-04/orders/:id/fulfillments.json
// ---------------------------------------------------------------------------

export async function createFulfillment(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  orderId: string,
): Promise<Response> {
  try {
    // Verify order belongs to shop
    const existing = await OrderService.getOrder(db, shopId, orderId)
    if (!existing) {
      return errorResponse('Order not found', 404)
    }

    const body = (await request.json()) as { fulfillment: OrderService.CreateFulfillmentInput }
    if (!body.fulfillment) {
      return errorResponse('Missing "fulfillment" in request body', 422)
    }

    if (!body.fulfillment.line_items || body.fulfillment.line_items.length === 0) {
      return errorResponse('At least one line item is required', 422)
    }

    const fulfillment = await OrderService.createFulfillment(db, orderId, body.fulfillment)
    return json({ fulfillment }, 201)
  } catch (err) {
    return errorResponse('Failed to create fulfillment', 500)
  }
}

// ---------------------------------------------------------------------------
// POST /api/2026-04/orders/:id/transactions.json
// ---------------------------------------------------------------------------

export async function createTransaction(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  orderId: string,
): Promise<Response> {
  try {
    const existing = await OrderService.getOrder(db, shopId, orderId)
    if (!existing) {
      return errorResponse('Order not found', 404)
    }

    const body = (await request.json()) as { transaction: OrderService.CreateTransactionInput }
    if (!body.transaction) {
      return errorResponse('Missing "transaction" in request body', 422)
    }

    const transaction = await OrderService.createTransaction(db, orderId, body.transaction)
    return json({ transaction }, 201)
  } catch (err) {
    return errorResponse('Failed to create transaction', 500)
  }
}

// ---------------------------------------------------------------------------
// POST /api/2026-04/orders/:id/refunds.json
// ---------------------------------------------------------------------------

export async function createRefund(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  orderId: string,
): Promise<Response> {
  try {
    const existing = await OrderService.getOrder(db, shopId, orderId)
    if (!existing) {
      return errorResponse('Order not found', 404)
    }

    const body = (await request.json()) as { refund: OrderService.CreateRefundInput }
    if (!body.refund) {
      return errorResponse('Missing "refund" in request body', 422)
    }

    if (!body.refund.refund_line_items || body.refund.refund_line_items.length === 0) {
      return errorResponse('At least one refund line item is required', 422)
    }

    const refund = await OrderService.createRefund(db, orderId, body.refund)
    return json({ refund }, 201)
  } catch (err) {
    return errorResponse('Failed to create refund', 500)
  }
}
