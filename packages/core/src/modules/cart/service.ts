/**
 * Gbox Platform — Cart Service (Stage 3B.1)
 *
 * Shopify-compatible cart state, Redis-backed, no Postgres table.
 *
 * ─── Why no database table? ──────────────────────────────────────
 * Carts are ephemeral by definition: the vast majority of carts are
 * abandoned, never completed, and exist for minutes at most. Writing
 * every `/cart/add.js` hit to Postgres would saturate the primary
 * with pointless churn and force every storefront read through the
 * connection pool. Shopify solves this the same way we do here —
 * the cart lives in Redis, keyed by an opaque client-stored token,
 * and only crystallises into durable rows inside
 * `checkout.completeCheckout` when the customer pays.
 *
 * The rest of the platform only needs to know two facts about a
 * cart: its token (so the storefront can attach it to the customer's
 * session cookie) and its `CartLine[]` (so the checkout service can
 * turn it into a priced, tax-aware `CheckoutSession`).
 *
 * ─── Storage abstraction ─────────────────────────────────────────
 * `CartService` takes a `CartStore` at construction time. Production
 * callers use `redisCartStore()`, which wraps `cacheGet/cacheSet/
 * cacheDel` with a process-local fallback Map — identical to the
 * pattern used by `checkout/service.ts` so a Redis blip degrades to
 * "cart survives on the current Node process" rather than "500 at
 * the cart endpoint". Tests can pass any `CartStore` they like.
 *
 * ─── Shopify Ajax semantics we deliberately copy ─────────────────
 *   • A line is identified by `variant_id`. Re-adding merges.
 *   • `updateLine(..., 0)` removes the line.
 *   • Updating / removing a variant that isn't on the cart is a
 *     noop, not an error. Merchant JavaScript depends on this.
 *   • `clearCart` empties the lines but preserves the token so
 *     bound session cookies still point at a live cart.
 *   • Attribute values are strings; setting one to `""` drops it.
 *
 * ─── What this file deliberately does NOT do ─────────────────────
 *   • Price the cart. Prices are derived from the product catalogue
 *     at render / checkout time so a cart that sat in Redis for 10
 *     days doesn't lock in yesterday's price.
 *   • Validate that `variant_id` actually exists. The storefront
 *     catches that on the render path (`DataSource.loadCart`), and
 *     `checkout.createCheckout` is the hard gate before payment.
 *   • Implement cart-level discounts. Discounts are a checkout
 *     concern — they can't price correctly until we know shipping
 *     country, customer, and tax regime, all of which only appear
 *     on the checkout session, not the cart.
 */

import { cacheGet, cacheSet, cacheDel } from '../cache/redis.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single cart line. Shopify's Ajax API accepts richer shapes
 * (selling_plan, line_properties) — we start with the minimum set
 * the storefront actually needs today and extend as later stages
 * surface the rest.
 */
export interface CartLine {
  variant_id: string
  quantity: number
  /**
   * Free-form per-line metadata (engraving text, gift messages,
   * …). Identical to Shopify's `properties` bag. Optional — the
   * common case is `undefined`, not an empty object.
   */
  properties?: Record<string, string> | undefined
}

/**
 * Immutable-from-outside cart snapshot. Mutating the returned object
 * does NOT change the stored cart — always go through the
 * `CartService` methods. `CartStore` implementations are expected to
 * clone on read and on write so a handler holding a stale reference
 * can never corrupt the next caller.
 */
export interface Cart {
  token: string
  shop_id: string
  lines: CartLine[]
  note: string | null
  attributes: Record<string, string>
  created_at: string
  updated_at: string
}

/**
 * Minimal persistence contract. Swappable so tests can run without
 * Redis. All methods are async because the production store talks
 * to Redis over a socket.
 */
export interface CartStore {
  get(token: string): Promise<Cart | null>
  set(token: string, cart: Cart, ttlSeconds: number): Promise<void>
  del(token: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

/**
 * Mint an opaque cart token. Prefixed with `ct_` so log scraping can
 * pick them out of URL paths / headers without a second lookup. The
 * random segment is 16 chars of base36 — ~83 bits of entropy, far
 * beyond the collision budget for a cart that lives for 30 days.
 */
function mintToken(): string {
  const rand = Math.random().toString(36).slice(2, 10)
  const rand2 = Math.random().toString(36).slice(2, 10)
  return `ct_${Date.now().toString(36)}_${rand}${rand2}`
}

// ---------------------------------------------------------------------------
// Redis-backed store (production)
// ---------------------------------------------------------------------------

const CART_KEY_PREFIX = 'cart:'
/**
 * Match Shopify's 30-day cart retention — long enough that a
 * legitimate returning visitor finds their cart, short enough that
 * abandoned carts don't accrete in Redis forever. Overridable via
 * the service constructor.
 */
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * In-process fallback Map used when Redis is unavailable. Mirrors
 * the pattern in `checkout/service.ts`. Shared across
 * `redisCartStore()` instances so all traffic on the same Node
 * process sees the same carts even during a Redis blip.
 */
const fallbackCarts = new Map<string, Cart>()

/**
 * Default production `CartStore`. Reads/writes through the central
 * cache helpers and degrades to an in-process Map on Redis failure.
 */
export function redisCartStore(): CartStore {
  return {
    async get(token) {
      const cached = await cacheGet<Cart>(`${CART_KEY_PREFIX}${token}`)
      if (cached) return cached
      const mem = fallbackCarts.get(token)
      return mem ? structuredClone(mem) : null
    },
    async set(token, cart, ttlSeconds) {
      await cacheSet(`${CART_KEY_PREFIX}${token}`, cart, ttlSeconds)
      // Always keep the fallback hot so a later Redis blip can still
      // serve reads for carts we wrote successfully.
      fallbackCarts.set(token, structuredClone(cart))
    },
    async del(token) {
      await cacheDel(`${CART_KEY_PREFIX}${token}`)
      fallbackCarts.delete(token)
    },
  }
}

// ---------------------------------------------------------------------------
// CartService
// ---------------------------------------------------------------------------

/**
 * Stateless façade over a `CartStore`. All methods read-modify-
 * write: fetch the cart (or mint a fresh one), mutate in memory,
 * and write it back. Atomicity between the read and the write is
 * NOT guaranteed — it doesn't need to be, because a cart has
 * exactly one writer (the visitor's browser) and concurrent
 * requests from the same session are already serialised by the
 * HTTP/2 stream + the session cookie round trip.
 */
export class CartService {
  constructor(
    private readonly store: CartStore,
    private readonly ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ) {}

  // ---------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------

  async getCart(token: string | null | undefined): Promise<Cart | null> {
    if (!token) return null
    return this.store.get(token)
  }

  async createCart(shopId: string): Promise<Cart> {
    const now = new Date().toISOString()
    const cart: Cart = {
      token: mintToken(),
      shop_id: shopId,
      lines: [],
      note: null,
      attributes: {},
      created_at: now,
      updated_at: now,
    }
    await this.store.set(cart.token, cart, this.ttlSeconds)
    return cart
  }

  // ---------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------

  /**
   * Add a line to the cart. If `token` is null / unknown, mints a
   * fresh cart for `shopId` and returns it — this is the code path
   * first-touch visitors hit when they click "Add to cart" before
   * any session cookie has been set.
   */
  async addItem(
    token: string | null | undefined,
    shopId: string,
    line: CartLine,
  ): Promise<Cart> {
    assertValidQuantity(line.quantity, { allowZero: false })

    let cart = token ? await this.store.get(token) : null
    if (!cart) {
      cart = await this.createCart(shopId)
    } else if (cart.shop_id !== shopId) {
      // Carts are shop-scoped. Mixing variants from two shops
      // would silently break pricing + taxation at checkout, so
      // we fail loudly here. The storefront route layer catches
      // this and mints a fresh cart for the new shop.
      throw new Error(
        `Cart ${cart.token} belongs to shop ${cart.shop_id}, ` +
          `refusing to add items from shop ${shopId}`,
      )
    }

    const existing = cart.lines.find((l) => l.variant_id === line.variant_id)
    if (existing) {
      existing.quantity += line.quantity
      // Merge properties — last write wins for identical keys,
      // mirroring Shopify's behaviour.
      if (line.properties) {
        existing.properties = { ...existing.properties, ...line.properties }
      }
    } else {
      cart.lines.push({
        variant_id: line.variant_id,
        quantity: line.quantity,
        ...(line.properties ? { properties: { ...line.properties } } : {}),
      })
    }

    touch(cart)
    await this.store.set(cart.token, cart, this.ttlSeconds)
    return cart
  }

  /**
   * Set the quantity of an existing line. A quantity of `0` removes
   * the line (Shopify-compatible). Updating a variant that isn't on
   * the cart is a deliberate noop — the storefront's cart JS sends
   * the same payload for every visible line on every "update cart"
   * click, including lines that were removed in a previous response.
   */
  async updateLine(
    token: string,
    variantId: string,
    quantity: number,
  ): Promise<Cart> {
    assertValidQuantity(quantity, { allowZero: true })

    const cart = await this.store.get(token)
    if (!cart) {
      throw new Error(`Cart ${token} not found`)
    }

    const idx = cart.lines.findIndex((l) => l.variant_id === variantId)
    if (idx === -1) return cart

    if (quantity === 0) {
      cart.lines.splice(idx, 1)
    } else {
      cart.lines[idx]!.quantity = quantity
    }

    touch(cart)
    await this.store.set(cart.token, cart, this.ttlSeconds)
    return cart
  }

  /**
   * Drop a line entirely. Equivalent to `updateLine(token, id, 0)`
   * but avoids the `assertValidQuantity` + the 0-branch.
   */
  async removeLine(token: string, variantId: string): Promise<Cart> {
    const cart = await this.store.get(token)
    if (!cart) {
      throw new Error(`Cart ${token} not found`)
    }

    const idx = cart.lines.findIndex((l) => l.variant_id === variantId)
    if (idx === -1) return cart
    cart.lines.splice(idx, 1)

    touch(cart)
    await this.store.set(cart.token, cart, this.ttlSeconds)
    return cart
  }

  /**
   * Empty the lines while preserving the token, note, and
   * attributes. A "clear" from the cart page shouldn't evict the
   * visitor's gift-wrap preference or the source=newsletter tag
   * sitting on the cart from a UTM handler.
   */
  async clearCart(token: string): Promise<Cart> {
    const cart = await this.store.get(token)
    if (!cart) {
      throw new Error(`Cart ${token} not found`)
    }
    cart.lines = []
    touch(cart)
    await this.store.set(cart.token, cart, this.ttlSeconds)
    return cart
  }

  /**
   * Write the cart note. The empty string clears it, again matching
   * the Shopify Ajax API (`note: ""` is the documented "remove"
   * payload).
   */
  async setNote(token: string, note: string): Promise<Cart> {
    const cart = await this.store.get(token)
    if (!cart) {
      throw new Error(`Cart ${token} not found`)
    }
    cart.note = note === '' ? null : note
    touch(cart)
    await this.store.set(cart.token, cart, this.ttlSeconds)
    return cart
  }

  /**
   * Merge attributes into the existing bag. Empty-string values
   * drop the key (Shopify behaviour — there's no separate "delete
   * attribute" Ajax endpoint).
   */
  async setAttributes(
    token: string,
    attrs: Record<string, string>,
  ): Promise<Cart> {
    const cart = await this.store.get(token)
    if (!cart) {
      throw new Error(`Cart ${token} not found`)
    }
    for (const [key, value] of Object.entries(attrs)) {
      if (value === '') {
        delete cart.attributes[key]
      } else {
        cart.attributes[key] = value
      }
    }
    touch(cart)
    await this.store.set(cart.token, cart, this.ttlSeconds)
    return cart
  }

  /**
   * Destroy the cart entirely. Used by the checkout completion
   * flow in Stage 3B.4 — once an order exists, the cart has served
   * its purpose and can be reaped. Idempotent: calling this on an
   * unknown token is a silent noop.
   */
  async destroyCart(token: string): Promise<void> {
    await this.store.del(token)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertValidQuantity(
  q: number,
  { allowZero }: { allowZero: boolean },
): void {
  if (!Number.isInteger(q)) {
    throw new Error(`Invalid quantity: ${q} (must be an integer)`)
  }
  if (q < 0) {
    throw new Error(`Invalid quantity: ${q} (must be >= 0)`)
  }
  if (!allowZero && q === 0) {
    throw new Error(`Invalid quantity: ${q} (must be >= 1)`)
  }
}

function touch(cart: Cart): void {
  cart.updated_at = new Date().toISOString()
}
