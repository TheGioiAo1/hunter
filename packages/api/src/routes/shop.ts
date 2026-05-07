/**
 * Gbox Platform — Shop API Routes
 *
 * Shopify-compatible REST endpoint for the current shop.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import * as ShopService from '@gbox/core/modules/shops/service.js'

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
// GET /api/2026-04/shop.json
// ---------------------------------------------------------------------------

export async function getShop(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
): Promise<Response> {
  try {
    const shop = await ShopService.getShop(db, shopId)
    if (!shop) {
      return errorResponse('Shop not found', 404)
    }

    // Return in Shopify-compatible format
    return json({
      shop: {
        id: shop.id,
        name: shop.name,
        email: shop.email,
        domain: shop.domain,
        province: shop.province,
        country: shop.country,
        address1: shop.address,
        zip: shop.zip,
        city: shop.city,
        phone: shop.phone,
        currency: shop.currency,
        timezone: shop.timezone,
        plan_name: shop.plan,
        plan_display_name: shop.plan,
        myshopify_domain: shop.domain,
        shop_owner: shop.name,
        created_at: shop.created_at,
        updated_at: shop.updated_at,
      },
    })
  } catch (err) {
    return errorResponse('Failed to get shop', 500)
  }
}
