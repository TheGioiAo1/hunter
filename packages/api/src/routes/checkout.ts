/**
 * Gbox Platform — Checkout API Routes
 *
 * Shopify-compatible REST endpoints for the checkout flow:
 * create, read, update, complete, shipping rates, and discounts.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import * as CheckoutService from '@gbox/core/modules/checkout/service.js'

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
// POST /api/2026-04/checkouts.json
// ---------------------------------------------------------------------------

export async function createCheckout(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      checkout: {
        line_items: Array<{ variant_id: string; quantity: number }>
        email?: string
      }
    }

    if (!body.checkout) {
      return errorResponse('Missing "checkout" in request body', 422)
    }

    if (!body.checkout.line_items || body.checkout.line_items.length === 0) {
      return errorResponse('At least one line item is required', 422)
    }

    const checkout = await CheckoutService.createCheckout(
      db,
      shopId,
      body.checkout.line_items,
    )

    // Optionally set email if provided at creation
    if (body.checkout.email) {
      CheckoutService.updateCheckoutEmail(checkout.id, body.checkout.email)
    }

    return json({ checkout }, 201)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create checkout'
    return errorResponse(message, 422)
  }
}

// ---------------------------------------------------------------------------
// GET /api/2026-04/checkouts/:id.json
// ---------------------------------------------------------------------------

export async function getCheckout(
  _request: Request,
  _db: Kysely<Database>,
  _shopId: string,
  checkoutId: string,
): Promise<Response> {
  try {
    const checkout = CheckoutService.getCheckout(checkoutId)
    if (!checkout) {
      return errorResponse('Checkout not found', 404)
    }
    return json({ checkout })
  } catch (err) {
    return errorResponse('Failed to get checkout', 500)
  }
}

// ---------------------------------------------------------------------------
// PUT /api/2026-04/checkouts/:id.json
// ---------------------------------------------------------------------------

export async function updateCheckout(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  checkoutId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      checkout: {
        email?: string
        shipping_address?: CheckoutService.ShippingAddress
        billing_address?: CheckoutService.ShippingAddress
        shipping_rate?: CheckoutService.ShippingRate
      }
    }

    if (!body.checkout) {
      return errorResponse('Missing "checkout" in request body', 422)
    }

    let checkout = CheckoutService.getCheckout(checkoutId)
    if (!checkout) {
      return errorResponse('Checkout not found', 404)
    }

    // Apply updates in order: email, shipping address, billing address, rate
    if (body.checkout.email) {
      checkout = CheckoutService.updateCheckoutEmail(
        checkoutId,
        body.checkout.email,
      )
    }

    if (body.checkout.shipping_address) {
      checkout = CheckoutService.updateCheckoutShipping(
        checkoutId,
        body.checkout.shipping_address,
      )
    }

    if (body.checkout.billing_address) {
      checkout = CheckoutService.updateCheckoutBilling(
        checkoutId,
        body.checkout.billing_address,
      )
    }

    if (body.checkout.shipping_rate) {
      checkout = CheckoutService.selectShippingRate(
        checkoutId,
        body.checkout.shipping_rate,
      )
    }

    return json({ checkout })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update checkout'
    return errorResponse(message, 422)
  }
}

// ---------------------------------------------------------------------------
// POST /api/2026-04/checkouts/:id/complete.json
// ---------------------------------------------------------------------------

export async function completeCheckout(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  checkoutId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      payment: CheckoutService.PaymentData
    }

    if (!body.payment) {
      return errorResponse('Missing "payment" in request body', 422)
    }

    if (!body.payment.gateway) {
      return errorResponse('Payment gateway is required', 422)
    }

    const checkout = await CheckoutService.completeCheckout(
      db,
      checkoutId,
      body.payment,
    )

    return json({ checkout })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to complete checkout'
    const status =
      message.includes('not found') ? 404 :
      message.includes('already completed') ? 409 :
      422
    return errorResponse(message, status)
  }
}

// ---------------------------------------------------------------------------
// GET /api/2026-04/checkouts/:id/shipping_rates.json
// ---------------------------------------------------------------------------

export async function getShippingRates(
  _request: Request,
  db: Kysely<Database>,
  _shopId: string,
  checkoutId: string,
): Promise<Response> {
  try {
    const rates = await CheckoutService.getShippingRates(db, checkoutId)
    return json({ shipping_rates: rates })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to get shipping rates'
    const status = message.includes('not found') ? 404 : 422
    return errorResponse(message, status)
  }
}

// ---------------------------------------------------------------------------
// POST /api/2026-04/checkouts/:id/discount.json
// ---------------------------------------------------------------------------

export async function applyDiscount(
  request: Request,
  db: Kysely<Database>,
  _shopId: string,
  checkoutId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as { discount_code: string }

    if (!body.discount_code) {
      return errorResponse('Missing "discount_code" in request body', 422)
    }

    const checkout = await CheckoutService.applyDiscount(
      db,
      checkoutId,
      body.discount_code,
    )

    return json({ checkout })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to apply discount'
    const status = message.includes('not found') ? 404 : 422
    return errorResponse(message, status)
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/2026-04/checkouts/:id/discount.json
// ---------------------------------------------------------------------------

export async function removeDiscount(
  _request: Request,
  _db: Kysely<Database>,
  _shopId: string,
  checkoutId: string,
): Promise<Response> {
  try {
    const checkout = CheckoutService.removeDiscount(checkoutId)
    return json({ checkout })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to remove discount'
    return errorResponse(message, message.includes('not found') ? 404 : 422)
  }
}
