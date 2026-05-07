/**
 * Gbox Storefront — Events beacon routes (Stage 3E.3)
 *
 * Single endpoint: `POST /events`. Theme JavaScript (or merchant
 * custom JS) posts JSON events here to record things the server
 * can't observe on its own — carousel clicks, add-to-cart from
 * the product card without a page navigation, time-on-page
 * pings, etc.
 *
 * Why a dedicated endpoint and not Google Analytics?
 *
 *   Gbox owns the funnel. The same `events` table already powers
 *   the admin dashboard's conversion chart via
 *   `@gbox/core/modules/analytics.getConversionFunnel`, so every
 *   event logged through this endpoint shows up in the merchant's
 *   own numbers without a third-party hop.
 *
 * Shape: a JSON object with a mandatory `type` field. The rest of
 * the fields are type-specific. All snake_case in, camelCase in
 * the recorder input — this matches the JS theme convention
 * (snake_case over the wire, camelCase in TS).
 *
 *   page_view:        { type, path }
 *   add_to_cart:      { type, variant_id, product_id, quantity, price, currency }
 *   checkout_start:   { type, checkout_id, total, currency, item_count }
 *   purchase:         { type, order_id, total, currency, item_count }
 *
 * Session id: uses the cart cookie when present, otherwise falls
 * back to the request id. Customer id is lifted from
 * `req.gboxCustomerId` — never trusted from the POST body.
 */

import type { NextFunction, Request, Response, Router } from 'express'
import express from 'express'
import { STOREFRONT_EVENT_VERBS } from '@gbox/core/modules/events/index.js'
import type {
  PageViewInput,
  AddToCartInput,
  CheckoutStartInput,
  PurchaseInput,
} from '@gbox/core/modules/events/index.js'

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface EventsRoutesDeps {
  recordPageView: (shopId: string, input: PageViewInput) => Promise<void>
  recordAddToCart: (shopId: string, input: AddToCartInput) => Promise<void>
  recordCheckoutStart: (
    shopId: string,
    input: CheckoutStartInput,
  ) => Promise<void>
  recordPurchase: (shopId: string, input: PurchaseInput) => Promise<void>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildEventsRoutes(
  deps: EventsRoutesDeps,
): (req: Request, res: Response, next: NextFunction) => void {
  const router: Router = express.Router()

  // 4 KiB is plenty for a beacon payload. Anything larger is abuse.
  router.use('/events', express.json({ limit: '4kb' }))

  router.post('/events', async (req, res) => {
    try {
      const shopId =
        typeof req.gboxShopId === 'string' ? req.gboxShopId : null
      if (!shopId) {
        res.status(404).type('text/plain').send('Not Found')
        return
      }

      const body = req.body as Record<string, unknown> | undefined
      if (!body || typeof body !== 'object') {
        jsonError(res, 400, 'invalid body')
        return
      }

      const verb = typeof body.type === 'string' ? body.type : null
      if (!verb) {
        jsonError(res, 400, 'type is required')
        return
      }
      if (!(STOREFRONT_EVENT_VERBS as readonly string[]).includes(verb)) {
        jsonError(res, 400, `unknown event type: ${verb}`)
        return
      }

      const cartCookie = req.gboxCookies?.cart ?? null
      const sessionId = cartCookie || req.gboxCtx?.id || ''
      if (!sessionId) {
        jsonError(res, 400, 'no session')
        return
      }

      const customerId =
        typeof req.gboxCustomerId === 'string' && req.gboxCustomerId.length > 0
          ? req.gboxCustomerId
          : null

      const ua = req.headers['user-agent']
      const userAgent = typeof ua === 'string' ? ua : ''
      const referrerHeader = req.headers.referer
      const referrer =
        typeof referrerHeader === 'string' && referrerHeader.length > 0
          ? referrerHeader
          : null

      // Dispatch per verb with verb-specific validation.
      switch (verb) {
        case 'page_view': {
          const path = typeof body.path === 'string' ? body.path : null
          if (!path) {
            jsonError(res, 400, 'path is required for page_view')
            return
          }
          await safe(() =>
            deps.recordPageView(shopId, {
              path,
              referrer,
              userAgent,
              sessionId,
              customerId,
            }),
          )
          break
        }
        case 'add_to_cart': {
          const variantId =
            typeof body.variant_id === 'string' ? body.variant_id : null
          const productId =
            typeof body.product_id === 'string' ? body.product_id : null
          const quantity = Number(body.quantity)
          const price = typeof body.price === 'string' ? body.price : null
          const currency =
            typeof body.currency === 'string' ? body.currency : null
          if (
            !variantId ||
            !productId ||
            !Number.isFinite(quantity) ||
            !price ||
            !currency
          ) {
            jsonError(res, 400, 'add_to_cart requires variant_id, product_id, quantity, price, currency')
            return
          }
          await safe(() =>
            deps.recordAddToCart(shopId, {
              variantId,
              productId,
              quantity,
              price,
              currency,
              sessionId,
              customerId,
            }),
          )
          break
        }
        case 'checkout_start': {
          const checkoutId =
            typeof body.checkout_id === 'string' ? body.checkout_id : null
          const total = typeof body.total === 'string' ? body.total : null
          const currency =
            typeof body.currency === 'string' ? body.currency : null
          const itemCount = Number(body.item_count)
          if (!checkoutId || !total || !currency || !Number.isFinite(itemCount)) {
            jsonError(res, 400, 'checkout_start requires checkout_id, total, currency, item_count')
            return
          }
          await safe(() =>
            deps.recordCheckoutStart(shopId, {
              checkoutId,
              total,
              currency,
              itemCount,
              sessionId,
              customerId,
            }),
          )
          break
        }
        case 'purchase': {
          const orderId =
            typeof body.order_id === 'string' ? body.order_id : null
          const total = typeof body.total === 'string' ? body.total : null
          const currency =
            typeof body.currency === 'string' ? body.currency : null
          const itemCount = Number(body.item_count)
          if (!orderId || !total || !currency || !Number.isFinite(itemCount)) {
            jsonError(res, 400, 'purchase requires order_id, total, currency, item_count')
            return
          }
          await safe(() =>
            deps.recordPurchase(shopId, {
              orderId,
              total,
              currency,
              itemCount,
              sessionId,
              customerId,
            }),
          )
          break
        }
        default: {
          // Shouldn't hit — the allowlist check above catches it.
          jsonError(res, 400, `unknown event type: ${verb as string}`)
          return
        }
      }

      res.status(204).end()
    } catch (err) {
      // The route should never 500 the buyer — but if something
      // deeply unexpected happens, log via the request context
      // logger and respond with 204 so the beacon is idempotent.
      try {
        req.gboxCtx?.logger?.warn({ err }, 'events beacon route threw')
      } catch {
        // ignore
      }
      res.status(204).end()
    }
  })

  // Reject malformed JSON with 400 rather than Express default 500.
  router.use(
    '/events',
    (
      err: unknown,
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      if (
        err &&
        typeof err === 'object' &&
        'type' in err &&
        typeof (err as { type: unknown }).type === 'string' &&
        ((err as { type: string }).type.startsWith('entity.') ||
          (err as { type: string }).type === 'charset.unsupported')
      ) {
        res
          .status(400)
          .type('application/json')
          .send(JSON.stringify({ error: 'invalid body' }))
        return
      }
      // Non-body-parser errors: still reply 400 to keep the beacon
      // endpoint well-behaved.
      res.status(400).type('application/json').send(JSON.stringify({ error: 'bad request' }))
    },
  )

  return router as unknown as (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(res: Response, status: number, message: string): void {
  res.status(status).type('application/json').send(JSON.stringify({ error: message }))
}

/** Run the recorder; swallow exceptions so the response stays 204. */
async function safe(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch {
    // Recorders are already fire-and-forget; this is defence in depth.
  }
}
