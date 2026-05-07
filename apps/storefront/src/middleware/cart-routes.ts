/**
 * Gbox Storefront — Cart Routes (Stage 3B.2)
 *
 * Shopify-compatible Ajax cart endpoints bolted onto the storefront
 * Express pipeline. Mounted between the cookie middleware (3A.5)
 * and the catch-all storefront handler (3A.8) so the cart cookie is
 * already parsed and the resolved shop is available on `req`.
 *
 * Endpoints (all return the full cart as JSON on success):
 *
 *   GET  /cart.js         → current cart (mints one on cookie miss)
 *   POST /cart/add.js     → append line(s)          — Shopify "add"
 *   POST /cart/change.js  → set line quantity       — Shopify "change"
 *   POST /cart/update.js  → bulk quantities + note  — Shopify "update"
 *   POST /cart/clear.js   → empty lines keep token  — Shopify "clear"
 *
 * Wire shape: the routes accept BOTH the legacy form-encoded payload
 * used by prehistoric Shopify themes (`id=var_1&quantity=2`) AND the
 * modern JSON payload emitted by Hydrogen-style Ajax helpers. The
 * response is ALWAYS `application/json` regardless of the input
 * because every merchant theme we'll ship talks JSON, and returning
 * form-encoded from one branch would be a foot-gun for future us.
 *
 * Error contract:
 *
 *   • 404 → cart cookie pointed at a token the service couldn't
 *          find AND the endpoint REQUIRES an existing cart (change,
 *          update keyed on existing lines). `/cart.js`, `/add.js`,
 *          `/update.js` (additive) and `/clear.js` happily mint a
 *          fresh cart on miss.
 *   • 409 → add-to-cart attempt crossing shop boundaries. Surface
 *          the error loudly so the browser can reload.
 *   • 422 → validation failure (missing id, bad quantity, malformed
 *          JSON). Response shape matches Shopify's error envelope.
 *   • 500 → genuine infra failure. Forwarded to `next(err)` so the
 *          Stage 3A.9 templated error middleware catches it.
 *
 * The cart cookie is refreshed on every mutating request — a 30-day
 * sliding window that matches the service-side TTL and Shopify's
 * cart persistence semantics. `HttpOnly` is intentionally NOT set
 * because theme JS needs to read the cart token for design-mode
 * requests; `SameSite=Lax` + `Secure` (in prod) give us the CSRF
 * surface we care about.
 */

import type { NextFunction, Request, Response, Router } from 'express'
import express from 'express'
import type {
  Cart,
  CartLine,
  CartService,
} from '@gbox/core/modules/cart/service.js'

// ---------------------------------------------------------------------------
// Public deps
// ---------------------------------------------------------------------------

export interface CartRoutesDeps {
  /**
   * CartService instance, typically wired to `redisCartStore()` in
   * production and a memory store in tests.
   */
  service: CartService
  /**
   * Override the cart cookie name. Defaults to `cart`, matching the
   * cookie middleware's default and the storefront engine's
   * hard-coded read.
   */
  cookieName?: string
  /**
   * TTL (in seconds) used on the response Set-Cookie header. The
   * service TTL is the authoritative source of truth for expiry;
   * this only controls how long the browser remembers the token.
   * Defaults to 30 days.
   */
  cookieMaxAgeSeconds?: number
  /**
   * Set the `Secure` flag on the cart cookie. Defaults to
   * `NODE_ENV === 'production'`. Tests leave this false so cookies
   * round-trip over plain HTTP.
   */
  secureCookie?: boolean
  /**
   * Optional analytics hook fired AFTER a successful
   * `/cart/add.js`. Receives one call per line added. Errors from
   * this hook are caught and dropped — analytics must never fail
   * the cart mutation. Tests use a `vi.fn()`; production binds to
   * `@gbox/core/modules/events.recordAddToCart` via the storefront
   * entrypoint.
   */
  onLineAdded?: (input: {
    shopId: string
    cart: Cart
    line: CartLine
    sessionId: string
    customerId: string | null
  }) => void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a sub-router containing the five cart endpoints. Returns a
 * regular Express middleware so callers can pass it straight to
 * `app.use(...)` — no `.mount()` required.
 */
export function buildCartRoutes(
  deps: CartRoutesDeps,
): (req: Request, res: Response, next: NextFunction) => void {
  const {
    service,
    cookieName = 'cart',
    cookieMaxAgeSeconds = 30 * 24 * 60 * 60,
    secureCookie = process.env.NODE_ENV === 'production',
  } = deps

  const router: Router = express.Router()

  // Parse JSON + urlencoded bodies for the POST endpoints. We scope
  // these parsers to the router (NOT the parent app) so the rest of
  // the storefront pipeline keeps its zero-allocation hot path.
  router.use(express.json({ limit: '32kb' }))
  router.use(express.urlencoded({ extended: false, limit: '32kb' }))

  // -----------------------------------------------------------------
  // Helpers (captured inside the factory so they can reach `service`
  // and the cookie settings without a separate deps bag).
  // -----------------------------------------------------------------

  function writeCartCookie(res: Response, token: string): void {
    const parts = [
      `${cookieName}=${encodeURIComponent(token)}`,
      'Path=/',
      `Max-Age=${cookieMaxAgeSeconds}`,
      'SameSite=Lax',
    ]
    if (secureCookie) parts.push('Secure')
    res.append('Set-Cookie', parts.join('; '))
  }

  function jsonError(res: Response, status: number, description: string): void {
    res.status(status)
    res.set('Content-Type', 'application/json; charset=utf-8')
    // Shape lifted from Shopify's cart error envelope so merchant
    // JS that checks `errorJson.description` keeps working.
    res.send(
      JSON.stringify({
        status,
        message: description,
        description,
      }),
    )
  }

  function sendCart(res: Response, cart: Cart): void {
    writeCartCookie(res, cart.token)
    res.status(200)
    res.set('Content-Type', 'application/json; charset=utf-8')
    res.send(JSON.stringify(serializeCart(cart)))
  }

  function resolveShopId(req: Request): string | null {
    // `req.gboxShopId` is stamped by the resolve-shop middleware; if
    // the cart routes are mounted without that middleware (which
    // should never happen in prod), we fall back to null and the
    // caller emits a 500.
    return typeof req.gboxShopId === 'string' ? req.gboxShopId : null
  }

  // -----------------------------------------------------------------
  // GET /cart.js
  // -----------------------------------------------------------------

  router.get('/cart.js', async (req, res, next) => {
    try {
      const shopId = resolveShopId(req)
      if (!shopId) return next(new Error('Cart route reached without a resolved shop'))

      const existing = await service.getCart(req.gboxCookies?.cart ?? null)
      if (existing && existing.shop_id === shopId) {
        sendCart(res, existing)
        return
      }
      const fresh = await service.createCart(shopId)
      sendCart(res, fresh)
    } catch (err) {
      next(err)
    }
  })

  // -----------------------------------------------------------------
  // POST /cart/add.js
  // -----------------------------------------------------------------

  router.post('/cart/add.js', async (req, res, next) => {
    try {
      const shopId = resolveShopId(req)
      if (!shopId) return next(new Error('Cart route reached without a resolved shop'))

      const body = req.body as unknown
      const lines = parseAddBody(body)
      if (lines.length === 0) {
        return jsonError(res, 422, 'No items to add')
      }

      let token = req.gboxCookies?.cart ?? null
      let cart: Cart | null = null
      for (const line of lines) {
        try {
          cart = await service.addItem(token, shopId, line)
        } catch (err) {
          const msg = (err as Error).message
          if (/shop/i.test(msg)) {
            return jsonError(res, 409, 'Cart belongs to a different shop')
          }
          if (/quantity/i.test(msg) || /variant/i.test(msg)) {
            return jsonError(res, 422, msg)
          }
          throw err
        }
        token = cart.token
        // Fire analytics AFTER the line lands so a tracking bug
        // can't make the cart look out of sync. Wrapped in
        // try/catch: a throwing hook must not break the mutation.
        if (deps.onLineAdded) {
          try {
            const customerId =
              typeof req.gboxCustomerId === 'string' && req.gboxCustomerId.length > 0
                ? req.gboxCustomerId
                : null
            deps.onLineAdded({
              shopId,
              cart,
              line,
              sessionId: cart.token,
              customerId,
            })
          } catch {
            // Intentionally swallowed.
          }
        }
      }
      sendCart(res, cart!)
    } catch (err) {
      next(err)
    }
  })

  // -----------------------------------------------------------------
  // POST /cart/change.js
  // -----------------------------------------------------------------

  router.post('/cart/change.js', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as {
        id?: unknown
        quantity?: unknown
      }
      const variantId = typeof body.id === 'string' ? body.id : null
      const quantity = toInt(body.quantity)
      if (!variantId) return jsonError(res, 422, 'Missing variant id')
      if (quantity === null || quantity < 0) {
        return jsonError(res, 422, 'Invalid quantity')
      }

      const token = req.gboxCookies?.cart ?? null
      if (!token) return jsonError(res, 404, 'Cart not found')

      const existing = await service.getCart(token)
      if (!existing) return jsonError(res, 404, 'Cart not found')

      const updated = await service.updateLine(token, variantId, quantity)
      sendCart(res, updated)
    } catch (err) {
      const msg = (err as Error).message
      if (/cart/i.test(msg)) {
        return jsonError(res, 404, 'Cart not found')
      }
      next(err)
    }
  })

  // -----------------------------------------------------------------
  // POST /cart/update.js
  // -----------------------------------------------------------------

  router.post('/cart/update.js', async (req, res, next) => {
    try {
      const shopId = resolveShopId(req)
      if (!shopId) return next(new Error('Cart route reached without a resolved shop'))

      const body = (req.body ?? {}) as {
        updates?: unknown
        note?: unknown
        attributes?: unknown
      }

      // Mint on miss — Shopify behaviour: /cart/update.js never
      // 404s, it always returns a live cart.
      let token = req.gboxCookies?.cart ?? null
      let cart = token ? await service.getCart(token) : null
      if (!cart || cart.shop_id !== shopId) {
        cart = await service.createCart(shopId)
        token = cart.token
      }

      // Bulk quantity updates. Accepts either the modern
      // `{ updates: { var_1: 3 } }` object or the legacy positional
      // `updates: [3, 1, 0]` array (not tested here but documented
      // upstream — we skip the array form until a merchant needs it).
      if (body.updates && typeof body.updates === 'object' && !Array.isArray(body.updates)) {
        for (const [variantId, rawQty] of Object.entries(
          body.updates as Record<string, unknown>,
        )) {
          const qty = toInt(rawQty)
          if (qty === null || qty < 0) {
            return jsonError(res, 422, `Invalid quantity for ${variantId}`)
          }
          cart = await service.updateLine(cart.token, variantId, qty)
        }
      }

      if (typeof body.note === 'string') {
        cart = await service.setNote(cart.token, body.note)
      }

      if (body.attributes && typeof body.attributes === 'object' && !Array.isArray(body.attributes)) {
        const attrs: Record<string, string> = {}
        for (const [k, v] of Object.entries(
          body.attributes as Record<string, unknown>,
        )) {
          attrs[k] = typeof v === 'string' ? v : String(v ?? '')
        }
        cart = await service.setAttributes(cart.token, attrs)
      }

      sendCart(res, cart)
    } catch (err) {
      next(err)
    }
  })

  // -----------------------------------------------------------------
  // POST /cart/clear.js
  // -----------------------------------------------------------------

  router.post('/cart/clear.js', async (req, res, next) => {
    try {
      const shopId = resolveShopId(req)
      if (!shopId) return next(new Error('Cart route reached without a resolved shop'))

      let token = req.gboxCookies?.cart ?? null
      let cart = token ? await service.getCart(token) : null
      if (!cart || cart.shop_id !== shopId) {
        cart = await service.createCart(shopId)
      } else {
        cart = await service.clearCart(cart.token)
      }
      sendCart(res, cart)
    } catch (err) {
      next(err)
    }
  })

  return router as unknown as (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => void
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Shopify-compatible-ish cart JSON. We omit the pricing fields that
 * Shopify exposes because the cart service deliberately doesn't
 * price itself — prices come from the datasource at render time
 * (Stage 3B.3) and from the checkout service at completion time.
 * Themes that depend on `items_subtotal_price` will see `null` here
 * until Stage 3B.3 wires real drops.
 */
function serializeCart(cart: Cart): {
  token: string
  item_count: number
  items: Array<{
    variant_id: string
    quantity: number
    properties: Record<string, string> | null
  }>
  note: string | null
  attributes: Record<string, string>
  created_at: string
  updated_at: string
} {
  return {
    token: cart.token,
    item_count: cart.lines.reduce((n, l) => n + l.quantity, 0),
    items: cart.lines.map((l) => ({
      variant_id: l.variant_id,
      quantity: l.quantity,
      properties: l.properties ?? null,
    })),
    note: cart.note,
    attributes: cart.attributes,
    created_at: cart.created_at,
    updated_at: cart.updated_at,
  }
}

// ---------------------------------------------------------------------------
// Body parsing helpers
// ---------------------------------------------------------------------------

/**
 * Normalize `/cart/add.js` payloads into a list of `CartLine` values.
 *
 * Shopify's Ajax API accepts three shapes:
 *
 *   { id, quantity }                                — single line
 *   { id, quantity, properties }                    — single line + props
 *   { items: [{ id, quantity, properties }, ...] }  — bulk add
 *
 * We also accept `variant_id` as an alias for `id` because our
 * server-side types (CartLine.variant_id) use the explicit name and
 * callers writing fetch() by hand sometimes pass that form.
 */
function parseAddBody(body: unknown): CartLine[] {
  if (!body || typeof body !== 'object') return []
  const bag = body as Record<string, unknown>

  if (Array.isArray(bag.items)) {
    const out: CartLine[] = []
    for (const raw of bag.items) {
      const line = toLine(raw)
      if (line) out.push(line)
    }
    return out
  }

  const single = toLine(bag)
  return single ? [single] : []
}

function toLine(raw: unknown): CartLine | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id =
    typeof r.id === 'string'
      ? r.id
      : typeof r.variant_id === 'string'
        ? r.variant_id
        : null
  if (!id) return null
  const quantity = toInt(r.quantity ?? 1)
  if (quantity === null) return null
  const properties =
    r.properties && typeof r.properties === 'object' && !Array.isArray(r.properties)
      ? (Object.fromEntries(
          Object.entries(r.properties as Record<string, unknown>).map(
            ([k, v]) => [k, typeof v === 'string' ? v : String(v ?? '')],
          ),
        ) as Record<string, string>)
      : undefined
  const line: CartLine = { variant_id: id, quantity }
  if (properties) line.properties = properties
  return line
}

function toInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return Math.trunc(n)
  }
  return null
}
