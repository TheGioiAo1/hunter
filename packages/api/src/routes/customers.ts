/**
 * Gbox Platform — Customer API Routes
 *
 * Shopify-compatible REST endpoints for customer management.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import * as CustomerService from '@gbox/core/modules/customers/service.js'

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
// GET /api/2026-04/customers.json
// ---------------------------------------------------------------------------

export async function listCustomers(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
): Promise<Response> {
  try {
    const url = new URL(request.url)
    const pagination = parsePagination(url)

    const filters: CustomerService.CustomerFilters = {}
    const status = url.searchParams.get('status')
    if (status) filters.status = status
    const ids = url.searchParams.get('ids')
    if (ids) filters.ids = ids.split(',')
    const createdAtMin = url.searchParams.get('created_at_min')
    if (createdAtMin) filters.created_at_min = createdAtMin
    const createdAtMax = url.searchParams.get('created_at_max')
    if (createdAtMax) filters.created_at_max = createdAtMax
    const search = url.searchParams.get('query')
    if (search) filters.search = search

    const result = await CustomerService.listCustomers(db, shopId, filters, pagination)

    return json({ customers: result.customers })
  } catch (err) {
    return errorResponse('Failed to list customers', 500)
  }
}

// ---------------------------------------------------------------------------
// GET /api/2026-04/customers/:id.json
// ---------------------------------------------------------------------------

export async function getCustomer(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  customerId: string,
): Promise<Response> {
  try {
    const customer = await CustomerService.getCustomer(db, shopId, customerId)
    if (!customer) {
      return errorResponse('Customer not found', 404)
    }
    return json({ customer })
  } catch (err) {
    return errorResponse('Failed to get customer', 500)
  }
}

// ---------------------------------------------------------------------------
// POST /api/2026-04/customers.json
// ---------------------------------------------------------------------------

export async function createCustomer(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as { customer: CustomerService.CreateCustomerInput }
    if (!body.customer) {
      return errorResponse('Missing "customer" in request body', 422)
    }

    if (!body.customer.email && !body.customer.phone) {
      return errorResponse('Email or phone is required', 422)
    }

    const customer = await CustomerService.createCustomer(db, shopId, body.customer)
    return json({ customer }, 201)
  } catch (err) {
    return errorResponse('Failed to create customer', 500)
  }
}

// ---------------------------------------------------------------------------
// PUT /api/2026-04/customers/:id.json
// ---------------------------------------------------------------------------

export async function updateCustomer(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  customerId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as { customer: CustomerService.UpdateCustomerInput }
    if (!body.customer) {
      return errorResponse('Missing "customer" in request body', 422)
    }

    const customer = await CustomerService.updateCustomer(
      db,
      shopId,
      customerId,
      body.customer,
    )
    return json({ customer })
  } catch (err) {
    return errorResponse('Failed to update customer', 500)
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/2026-04/customers/:id.json
// ---------------------------------------------------------------------------

export async function deleteCustomer(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  customerId: string,
): Promise<Response> {
  try {
    await CustomerService.deleteCustomer(db, shopId, customerId)
    return new Response(null, { status: 200 })
  } catch (err) {
    return errorResponse('Failed to delete customer', 500)
  }
}
