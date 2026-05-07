/**
 * Gbox Platform — Search API Routes
 *
 * Shopify-compatible REST endpoint for full-text search.
 * GET /api/2026-04/search.json?q=query&type=product|order|customer|all
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import * as SearchService from '@gbox/core/modules/search/service.js'

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

// ---------------------------------------------------------------------------
// GET /api/2026-04/search.json
// ---------------------------------------------------------------------------

export async function search(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
): Promise<Response> {
  try {
    const url = new URL(request.url)
    const query = url.searchParams.get('q')?.trim()

    if (!query) {
      return errorResponse('Missing required "q" query parameter', 400)
    }

    const type = url.searchParams.get('type') ?? 'all'

    // Parse optional filters for product search
    const filters: SearchService.SearchFilters = {}
    const category = url.searchParams.get('category')
    if (category) filters.category = category
    const minPrice = url.searchParams.get('min_price')
    if (minPrice) filters.min_price = minPrice
    const maxPrice = url.searchParams.get('max_price')
    if (maxPrice) filters.max_price = maxPrice
    const inStock = url.searchParams.get('in_stock')
    if (inStock === 'true') filters.in_stock = true
    const tags = url.searchParams.get('tags')
    if (tags) filters.tags = tags.split(',')

    // Pagination
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 50)
    const page = Math.max(Number(url.searchParams.get('page') ?? 1), 1)
    const pagination = { limit, offset: (page - 1) * limit }

    switch (type) {
      case 'product': {
        const result = await SearchService.searchProducts(
          db,
          shopId,
          query,
          filters,
          pagination,
        )
        return json({ results: result.results, total: result.total, type: 'product' })
      }

      case 'order': {
        const orders = await SearchService.searchOrders(db, shopId, query)
        return json({ results: orders, total: orders.length, type: 'order' })
      }

      case 'customer': {
        const customers = await SearchService.searchCustomers(db, shopId, query)
        return json({ results: customers, total: customers.length, type: 'customer' })
      }

      case 'all': {
        const combined = await SearchService.searchAll(db, shopId, query)
        return json(combined)
      }

      default:
        return errorResponse(
          `Invalid type "${type}". Must be one of: product, order, customer, all`,
          400,
        )
    }
  } catch (err) {
    return errorResponse('Search failed', 500)
  }
}
