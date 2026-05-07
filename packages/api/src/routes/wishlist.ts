/**
 * Gbox Platform — Wishlist API Routes
 *
 * REST endpoints for customer wishlist management.
 *
 *   GET    /api/2026-04/wishlist.json          — get customer's wishlist
 *   POST   /api/2026-04/wishlist.json          — add product to wishlist
 *   DELETE /api/2026-04/wishlist/:product_id.json — remove from wishlist
 *   GET    /api/2026-04/wishlist/count.json    — wishlist count
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import * as WishlistService from '@gbox/core/modules/wishlist/service.js'

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
// GET /api/2026-04/wishlist.json
// ---------------------------------------------------------------------------

export async function getWishlist(
  request: Request,
  db: Kysely<Database>,
  _shopId: string,
  customerId: string,
): Promise<Response> {
  try {
    const url = new URL(request.url)
    const pagination = parsePagination(url)

    const result = await WishlistService.getWishlist(db, customerId, pagination)

    return json({
      wishlist_items: result.items,
      total: result.total,
    })
  } catch (err) {
    return errorResponse('Failed to get wishlist', 500)
  }
}

// ---------------------------------------------------------------------------
// POST /api/2026-04/wishlist.json
// ---------------------------------------------------------------------------

export async function addToWishlist(
  request: Request,
  db: Kysely<Database>,
  _shopId: string,
  customerId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as { product_id?: string }

    if (!body.product_id) {
      return errorResponse('Missing "product_id" in request body', 422)
    }

    const item = await WishlistService.addToWishlist(db, customerId, body.product_id)

    return json({ wishlist_item: item }, 201)
  } catch (err) {
    return errorResponse('Failed to add to wishlist', 500)
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/2026-04/wishlist/:product_id.json
// ---------------------------------------------------------------------------

export async function removeFromWishlist(
  _request: Request,
  db: Kysely<Database>,
  _shopId: string,
  customerId: string,
  productId: string,
): Promise<Response> {
  try {
    await WishlistService.removeFromWishlist(db, customerId, productId)
    return new Response(null, { status: 200 })
  } catch (err) {
    return errorResponse('Failed to remove from wishlist', 500)
  }
}

// ---------------------------------------------------------------------------
// GET /api/2026-04/wishlist/count.json
// ---------------------------------------------------------------------------

export async function getWishlistCount(
  _request: Request,
  db: Kysely<Database>,
  _shopId: string,
  customerId: string,
): Promise<Response> {
  try {
    const count = await WishlistService.getWishlistCount(db, customerId)
    return json({ count })
  } catch (err) {
    return errorResponse('Failed to get wishlist count', 500)
  }
}
