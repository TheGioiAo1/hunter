/**
 * Gbox Platform — Checkout Service
 *
 * Shopify-style checkout flow: create session, set shipping/email,
 * apply discounts, calculate totals, and complete checkout
 * (order + transaction + inventory reduction).
 */

import { sql, type Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { cacheGet, cacheSet, cacheDel } from '../cache/redis.js'
import {
  enqueueWebhookDelivery,
  enqueueStandardOrderFanout,
} from '../queue/queues.js'
// Phase 8 PR2f — mark abandoned-cart enrollments recovered when the
// underlying checkout completes, so the cron doesn't keep sending
// recovery emails to a buyer who's already paid.
import { markRecovered as markAbandonedCartRecovered } from '../marketing/abandoned-cart.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CartItem {
  variant_id: string
  quantity: number
}

export interface ShippingAddress {
  first_name?: string | null
  last_name?: string | null
  company?: string | null
  address1?: string | null
  address2?: string | null
  city?: string | null
  province?: string | null
  province_code?: string | null
  country?: string | null
  country_code?: string | null
  zip?: string | null
  phone?: string | null
}

export interface CheckoutLineItem {
  variant_id: string
  product_id: string
  title: string
  variant_title: string | null
  sku: string | null
  price: string
  quantity: number
  requires_shipping: boolean
  taxable: boolean
  image_url: string | null
  weight: string | null
  weight_unit: string
}

export interface ShippingRate {
  id: string
  name: string
  price: string
  type: string
}

export interface CheckoutDiscount {
  /**
   * Null only when this discount was automatic AND the merchant didn't
   * assign a code. Code-based discounts always have a string here.
   */
  code: string | null
  discount_id: string
  type: string
  value: string
  value_type: string
  amount: string // computed discount amount
  /**
   * Phase 5 PR2 — pre-resolved list of product_ids the discount applies
   * to, stamped by `applyDiscount` after scope resolution.
   *
   *   null / undefined → discount applies to every line item (scope='all')
   *   string[]         → only line items whose product_id is in this list
   *
   * Stamped once at apply time so subsequent checkout mutations
   * (shipping change, address change, etc.) can recalc without
   * re-querying `collection_products`.
   */
  eligible_product_ids?: string[] | null
  /**
   * Phase 5 PR3 — true when this discount was applied by the automatic
   * evaluator (`evaluateAutomaticDiscount`) rather than by the buyer
   * entering a code. Two behaviors hinge on this flag:
   *
   *   1. The "Remove" button on the summary hides for automatic
   *      discounts — buyers can't opt out of a store-wide automatic.
   *   2. Cart mutations re-run the evaluator; a code-based discount
   *      never gets clobbered but an automatic may swap for a better
   *      match or clear when the cart no longer qualifies.
   */
  is_automatic?: boolean
  /**
   * Phase 5 PR4 — parsed tier list stamped at apply time. When
   * present and non-empty, the recalc picks the highest-threshold
   * tier whose threshold <= eligible subtotal and uses its
   * `percentage` INSTEAD of the flat `value`. Stamping on the
   * checkout (rather than re-reading the discount row every recalc)
   * keeps the tax/shipping mutation hot path network-free.
   *
   * Shape: Array<{ threshold: number, percentage: number }> sorted
   * ASC by threshold. null/undefined means "not a tiered discount,
   * use flat `value`".
   */
  tiers?: Array<{ threshold: number; percentage: number }> | null
  /**
   * Phase 5 PR5 — BOGO allocator config. Only meaningful when
   * `type='bogo'`. Stamped at apply time so the hot-path recalc
   * doesn't re-parse jsonb. `buy_quantity` + `get_quantity` refer to
   * units of the eligible line-items (scope applies first); the
   * allocator walks unit-prices cheapest-first and discounts the
   * `get_quantity` cheapest units per cycle at
   * `get_discount_percentage`.
   */
  bogo_config?: {
    buy_quantity: number
    get_quantity: number
    get_discount_percentage: number
  } | null
}

export interface CheckoutSession {
  id: string
  shop_id: string
  email: string | null
  /**
   * Phase 5 PR1 — optional logged-in customer id. Set when the buyer
   * arrived with a valid customer session cookie. Feeds two places:
   *
   *   1. `discounts.service.wasDiscountRedeemedByCustomer` for
   *      once_per_customer enforcement.
   *   2. `completeCheckout` stamps this into `orders.customer_id` so
   *      the order attribution is accurate (previously guest-only).
   *
   * Guest checkouts leave this null; the email field becomes the only
   * identifier and the once_per_customer check falls back to email.
   */
  customer_id?: string | null
  line_items: CheckoutLineItem[]
  shipping_address: ShippingAddress | null
  billing_address: ShippingAddress | null
  shipping_rate: ShippingRate | null
  discount: CheckoutDiscount | null
  subtotal_price: string
  total_shipping: string
  total_tax: string
  total_discounts: string
  total_price: string
  currency: string
  completed_at: string | null
  order_id: string | null
  created_at: string
  updated_at: string
  // Sprint 2b — UTM attribution captured at checkout creation time.
  // Storefront middleware stamps these from the `gbox_utm` cookie or
  // from query params on the landing page. Copied into `orders.utm_*`
  // when the checkout completes so the admin filter can slice orders
  // by campaign / source / medium.
  utm_source?: string | null
  utm_medium?: string | null
  utm_campaign?: string | null
  utm_content?: string | null
  utm_term?: string | null
}

/**
 * Subset of UTM attribution params accepted by createCheckout.
 * Every field is optional — missing values are stored as null.
 */
export interface CheckoutUtm {
  source?: string | null
  medium?: string | null
  campaign?: string | null
  content?: string | null
  term?: string | null
}

export interface PaymentData {
  gateway: 'stripe' | 'paypal' | 'manual'
  gateway_transaction_id?: string
  amount?: string
}

// ---------------------------------------------------------------------------
// Redis-backed checkout store (persists across restarts, shared across processes)
// Falls back to in-memory Map if Redis unavailable
// ---------------------------------------------------------------------------

const CHECKOUT_TTL = 3600 // 1 hour
const CHECKOUT_PREFIX = 'checkout:'

// In-memory fallback for when Redis is unavailable.
//
// Exported so sibling modules (discounts) share the same store. Without a
// shared reference, a checkout created here but read from the discounts
// module would miss even with a working fallback, because each module used
// to keep its own private Map.
//
// Dual-write is the only reliable pattern: `cacheSet` swallows its own
// errors, so the classic `try { cacheSet } catch { fallback.set }` branch
// never fires. We write to the fallback unconditionally, and attempt Redis
// best-effort for cross-process sharing.
export const checkoutFallbackStore = new Map<string, CheckoutSession>()

async function storeCheckout(checkout: CheckoutSession): Promise<void> {
  checkoutFallbackStore.set(checkout.id, checkout)
  await cacheSet(`${CHECKOUT_PREFIX}${checkout.id}`, checkout, CHECKOUT_TTL)
}

async function loadCheckout(id: string): Promise<CheckoutSession | null> {
  const cached = await cacheGet<CheckoutSession>(`${CHECKOUT_PREFIX}${id}`)
  if (cached) return cached
  return checkoutFallbackStore.get(id) ?? null
}

async function removeCheckout(id: string): Promise<void> {
  await cacheDel(`${CHECKOUT_PREFIX}${id}`)
  checkoutFallbackStore.delete(id)
}

function generateId(): string {
  return `chk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

// ---------------------------------------------------------------------------
// Tax rates by country code (simple percentage-based)
// ---------------------------------------------------------------------------

const TAX_RATES: Record<string, number> = {
  US: 0.0,       // varies by state — 0 federal
  CA: 0.05,      // GST 5%
  GB: 0.20,      // VAT 20%
  DE: 0.19,      // MwSt 19%
  FR: 0.20,      // TVA 20%
  AU: 0.10,      // GST 10%
  JP: 0.10,      // consumption tax 10%
  NL: 0.21,      // BTW 21%
  SE: 0.25,      // Moms 25%
  IT: 0.22,      // IVA 22%
  ES: 0.21,      // IVA 21%
  BR: 0.17,      // ICMS ~17%
  IN: 0.18,      // GST 18%
  KR: 0.10,      // VAT 10%
  SG: 0.09,      // GST 9%
  AE: 0.05,      // VAT 5%
}

function getTaxRate(countryCode: string | null | undefined): number {
  if (!countryCode) return 0
  return TAX_RATES[countryCode.toUpperCase()] ?? 0
}

// ---------------------------------------------------------------------------
// Helper: recalculate all totals on a checkout session
// ---------------------------------------------------------------------------

function recalculateTotals(checkout: CheckoutSession): void {
  // Subtotal from line items
  let subtotal = 0
  for (const item of checkout.line_items) {
    subtotal += parseFloat(item.price) * item.quantity
  }
  checkout.subtotal_price = subtotal.toFixed(2)

  // Shipping
  const shippingPrice = checkout.shipping_rate
    ? parseFloat(checkout.shipping_rate.price)
    : 0

  // Discount
  let discountAmount = 0
  if (checkout.discount) {
    if (checkout.discount.type === 'free_shipping') {
      // Free shipping discount — zero out shipping. Scope doesn't apply
      // here; free_shipping operates on the shipping rate, not line items.
      discountAmount = shippingPrice
    } else {
      // Phase 5 PR2 — percentage / fixed discounts respect
      // `eligible_product_ids` stamped by applyDiscount. If null/undefined
      // the discount applies to every line ("all"). If an array is set,
      // the discount's base is only the matching lines' subtotal.
      const eligibleIds = checkout.discount.eligible_product_ids
      const eligibleLines = Array.isArray(eligibleIds)
        ? checkout.line_items.filter((li) =>
            (eligibleIds as string[]).includes(li.product_id),
          )
        : checkout.line_items
      const eligibleSubtotal = eligibleLines.reduce(
        (s, li) => s + parseFloat(li.price) * li.quantity,
        0,
      )

      // Phase 5 PR5 — BOGO allocator runs BEFORE the percentage/fixed
      // branch. Expands eligible line-items into unit prices, sorts
      // cheapest-first, and discounts the get_quantity cheapest units
      // per complete buy+get cycle at get_discount_percentage. Keeps
      // the formula in lockstep with discounts/service.ts::computeBogoDiscount
      // — drift is pinned by the co-located unit tests.
      if (checkout.discount.type === 'bogo' && checkout.discount.bogo_config) {
        const cfg = checkout.discount.bogo_config
        const cycleSize = cfg.buy_quantity + cfg.get_quantity
        if (cycleSize > 0) {
          const units: number[] = []
          for (const li of eligibleLines) {
            const price = parseFloat(li.price)
            if (!Number.isFinite(price) || li.quantity <= 0) continue
            for (let i = 0; i < li.quantity; i++) units.push(price)
          }
          if (units.length >= cycleSize) {
            units.sort((a, b) => a - b)
            const cycles = Math.floor(units.length / cycleSize)
            const pct = cfg.get_discount_percentage / 100
            for (let c = 0; c < cycles; c++) {
              for (let i = 0; i < cfg.get_quantity; i++) {
                const idx = c * cfg.get_quantity + i
                if (idx < units.length) discountAmount += units[idx] * pct
              }
            }
          }
        }
      } else if (checkout.discount.value_type === 'percentage') {
        // Phase 5 PR4 — when `tiers` is stamped on the checkout, the
        // picker chooses the highest-threshold tier whose threshold
        // <= eligibleSubtotal and uses its percentage. If no tier
        // qualifies the discount amount is 0 (do NOT fall through to
        // the flat `value` — that would change tiered semantics).
        const tiers = checkout.discount.tiers
        if (Array.isArray(tiers) && tiers.length > 0) {
          let pct = 0
          for (const t of tiers) {
            if (t.threshold <= eligibleSubtotal) pct = t.percentage
            else break
          }
          discountAmount = eligibleSubtotal * (pct / 100)
        } else {
          discountAmount = eligibleSubtotal * (parseFloat(checkout.discount.value) / 100)
        }
      } else {
        // fixed_amount — clamp to the eligible subtotal, not the whole cart.
        discountAmount = Math.min(
          parseFloat(checkout.discount.value),
          eligibleSubtotal,
        )
      }
    }
    discountAmount = Math.min(discountAmount, subtotal + shippingPrice)
    checkout.discount.amount = discountAmount.toFixed(2)
  }
  checkout.total_discounts = discountAmount.toFixed(2)

  // Effective shipping after free_shipping discount
  const effectiveShipping =
    checkout.discount?.type === 'free_shipping' ? 0 : shippingPrice
  checkout.total_shipping = effectiveShipping.toFixed(2)

  // Tax (on taxable items only, after discounts)
  const countryCode =
    checkout.shipping_address?.country_code ??
    checkout.shipping_address?.country
  const taxRate = getTaxRate(countryCode)
  let taxableSubtotal = 0
  for (const item of checkout.line_items) {
    if (item.taxable) {
      taxableSubtotal += parseFloat(item.price) * item.quantity
    }
  }
  // Pro-rate discount across taxable portion
  const taxableAfterDiscount = Math.max(
    0,
    taxableSubtotal -
      (checkout.discount?.type !== 'free_shipping' ? discountAmount : 0),
  )
  const tax = taxableAfterDiscount * taxRate
  checkout.total_tax = tax.toFixed(2)

  // Total
  const total = subtotal - discountAmount + effectiveShipping + tax
  checkout.total_price = Math.max(0, total).toFixed(2)

  checkout.updated_at = new Date().toISOString()
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Create a new checkout session from cart items.
 * Resolves variant data from the database.
 */
export async function createCheckout(
  db: Kysely<Database>,
  shopId: string,
  cartItems: CartItem[],
  // Third-position legacy arg some callers already pass (see
  // server.ts line ~5319: `createCheckout(db, shop.id, items, email || null)`).
  // Kept as a loose fourth parameter so the existing call sites
  // don't need to change; `options.email` takes precedence.
  emailOrOptions?:
    | string
    | null
    | { email?: string | null; utm?: CheckoutUtm; customerId?: string | null },
  options?: {
    utm?: CheckoutUtm
    email?: string | null
    // Phase 5 PR1 — authenticated customer id, for once_per_customer
    // and proper `orders.customer_id` attribution. Null/undefined for
    // guest checkouts.
    customerId?: string | null
  },
): Promise<CheckoutSession> {
  if (!cartItems.length) {
    throw new Error('Cart must contain at least one item')
  }

  const variantIds = cartItems.map((ci) => ci.variant_id)

  // Load variant + product data
  const variants = await db
    .selectFrom('product_variants')
    .innerJoin('products', 'products.id', 'product_variants.product_id')
    .select([
      'product_variants.id as variant_id',
      'product_variants.product_id',
      'product_variants.title as variant_title',
      'product_variants.price',
      'product_variants.sku',
      'product_variants.requires_shipping',
      'product_variants.taxable',
      'product_variants.image_url',
      'product_variants.weight',
      'product_variants.weight_unit',
      'product_variants.inventory_quantity',
      'products.title as product_title',
      'products.shop_id',
    ])
    .where('product_variants.id', 'in', variantIds)
    .where('products.shop_id', '=', shopId)
    .execute()

  const variantMap = new Map(variants.map((v) => [v.variant_id, v]))

  // Validate all variants exist and belong to shop
  const lineItems: CheckoutLineItem[] = []
  for (const ci of cartItems) {
    const v = variantMap.get(ci.variant_id)
    if (!v) {
      throw new Error(`Variant ${ci.variant_id} not found in shop`)
    }
    if (ci.quantity < 1) {
      throw new Error(`Invalid quantity for variant ${ci.variant_id}`)
    }
    lineItems.push({
      variant_id: v.variant_id,
      product_id: v.product_id,
      title: v.product_title,
      variant_title: v.variant_title,
      sku: v.sku,
      price: v.price,
      quantity: ci.quantity,
      requires_shipping: v.requires_shipping,
      taxable: v.taxable,
      image_url: v.image_url,
      weight: v.weight,
      weight_unit: v.weight_unit,
    })
  }

  // Fetch shop currency
  const shop = await db
    .selectFrom('shops')
    .select('currency')
    .where('id', '=', shopId)
    .executeTakeFirstOrThrow()

  const id = generateId()
  const now = new Date().toISOString()

  // Normalise legacy + new call shapes into a single { email, utm } bag.
  const legacyEmail =
    typeof emailOrOptions === 'string' || emailOrOptions === null
      ? emailOrOptions
      : null
  const optsFromLegacy =
    emailOrOptions && typeof emailOrOptions === 'object' ? emailOrOptions : null
  const resolvedEmail: string | null =
    options?.email ?? optsFromLegacy?.email ?? legacyEmail ?? null
  const resolvedUtm: CheckoutUtm =
    options?.utm ?? optsFromLegacy?.utm ?? {}
  const resolvedCustomerId: string | null =
    options?.customerId ?? optsFromLegacy?.customerId ?? null

  const checkout: CheckoutSession = {
    id,
    shop_id: shopId,
    email: resolvedEmail,
    customer_id: resolvedCustomerId,
    line_items: lineItems,
    shipping_address: null,
    billing_address: null,
    shipping_rate: null,
    discount: null,
    subtotal_price: '0.00',
    total_shipping: '0.00',
    total_tax: '0.00',
    total_discounts: '0.00',
    total_price: '0.00',
    currency: shop.currency,
    completed_at: null,
    order_id: null,
    created_at: now,
    updated_at: now,
    utm_source: resolvedUtm.source ?? null,
    utm_medium: resolvedUtm.medium ?? null,
    utm_campaign: resolvedUtm.campaign ?? null,
    utm_content: resolvedUtm.content ?? null,
    utm_term: resolvedUtm.term ?? null,
  }

  recalculateTotals(checkout)
  await storeCheckout(checkout)

  return checkout
}

/**
 * Get a checkout session by ID.
 */
export async function getCheckout(checkoutId: string): Promise<CheckoutSession | null> {
  return loadCheckout(checkoutId)
}

/**
 * Cancel an in-flight checkout session.
 *
 * Used by payment gateways when the buyer abandons the approval flow
 * (e.g. closes the PayPal popup, hits the merchant-defined cancel_url).
 *
 * Idempotent: returns the snapshot of the checkout that was removed,
 * or `null` if the checkout did not exist (already expired / never created).
 *
 * Refuses to cancel a checkout that has already been completed —
 * a completed checkout has an `order_id` and money has changed hands;
 * cancellation at that point requires an explicit refund flow.
 */
export async function cancelCheckout(
  checkoutId: string,
  reason?: string,
): Promise<CheckoutSession | null> {
  const checkout = await loadCheckout(checkoutId)
  if (!checkout) return null
  if (checkout.completed_at) {
    throw new Error(
      'Cannot cancel a completed checkout — issue a refund instead',
    )
  }
  // Stamp updated_at so any consumer cached the snapshot can see the
  // cancellation event before we remove the Redis key.
  checkout.updated_at = new Date().toISOString()
  if (reason) {
    // Embed the reason on the snapshot for downstream observability.
    // Not part of the public CheckoutSession type — consumers that read
    // it should treat it as opaque metadata.
    ;(checkout as unknown as Record<string, unknown>).cancel_reason = reason
  }
  await removeCheckout(checkoutId)
  return checkout
}

/**
 * Update shipping address and recalculate totals.
 */
export async function updateCheckoutShipping(
  checkoutId: string,
  address: ShippingAddress,
): Promise<CheckoutSession> {
  const checkout = await loadCheckout(checkoutId)
  if (!checkout) throw new Error('Checkout not found')
  if (checkout.completed_at) throw new Error('Checkout already completed')

  checkout.shipping_address = address
  checkout.shipping_rate = null
  recalculateTotals(checkout)
  await storeCheckout(checkout)
  return checkout
}

/**
 * Update billing address on checkout.
 */
export async function updateCheckoutBilling(
  checkoutId: string,
  address: ShippingAddress,
): Promise<CheckoutSession> {
  const checkout = await loadCheckout(checkoutId)
  if (!checkout) throw new Error('Checkout not found')
  if (checkout.completed_at) throw new Error('Checkout already completed')

  checkout.billing_address = address
  checkout.updated_at = new Date().toISOString()
  await storeCheckout(checkout)
  return checkout
}

/**
 * Get available shipping rates for the checkout based on the shipping
 * address country and the shop's shipping zones.
 */
export async function getShippingRates(
  db: Kysely<Database>,
  checkoutId: string,
): Promise<ShippingRate[]> {
  const checkout = await loadCheckout(checkoutId)
  if (!checkout) throw new Error('Checkout not found')
  if (!checkout.shipping_address) {
    throw new Error('Shipping address must be set before fetching rates')
  }

  const country =
    checkout.shipping_address.country_code ??
    checkout.shipping_address.country

  if (!country) {
    throw new Error('Shipping address must include a country')
  }

  // Find zones that include this country
  const zones = await db
    .selectFrom('shipping_zones')
    .selectAll()
    .where('shop_id', '=', checkout.shop_id)
    .execute()

  const matchingZoneIds: string[] = []
  for (const zone of zones) {
    const countries = zone.countries as string[]
    if (
      countries &&
      countries.some(
        (c: string) => c.toUpperCase() === country.toUpperCase(),
      )
    ) {
      matchingZoneIds.push(zone.id)
    }
  }

  if (matchingZoneIds.length === 0) {
    return []
  }

  // Get all rates for matching zones
  const rates = await db
    .selectFrom('shipping_rates')
    .selectAll()
    .where('zone_id', 'in', matchingZoneIds)
    .execute()

  // Compute total cart weight and subtotal for rate filtering
  let totalWeight = 0
  let subtotal = 0
  for (const item of checkout.line_items) {
    if (item.requires_shipping) {
      totalWeight += parseFloat(item.weight ?? '0') * item.quantity
      subtotal += parseFloat(item.price) * item.quantity
    }
  }

  // Filter rates by type constraints
  const applicableRates: ShippingRate[] = []
  for (const rate of rates) {
    if (rate.type === 'flat') {
      applicableRates.push({
        id: rate.id,
        name: rate.name,
        price: rate.price,
        type: rate.type,
      })
    } else if (rate.type === 'price_based') {
      const min = parseFloat(rate.min_value ?? '0')
      const max = rate.max_value ? parseFloat(rate.max_value) : Infinity
      if (subtotal >= min && subtotal <= max) {
        applicableRates.push({
          id: rate.id,
          name: rate.name,
          price: rate.price,
          type: rate.type,
        })
      }
    } else if (rate.type === 'weight_based') {
      const min = parseFloat(rate.min_value ?? '0')
      const max = rate.max_value ? parseFloat(rate.max_value) : Infinity
      if (totalWeight >= min && totalWeight <= max) {
        applicableRates.push({
          id: rate.id,
          name: rate.name,
          price: rate.price,
          type: rate.type,
        })
      }
    }
  }

  return applicableRates
}

/**
 * Select a shipping rate for the checkout.
 */
export async function selectShippingRate(
  checkoutId: string,
  rate: ShippingRate,
): Promise<CheckoutSession> {
  const checkout = await loadCheckout(checkoutId)
  if (!checkout) throw new Error('Checkout not found')
  if (checkout.completed_at) throw new Error('Checkout already completed')

  checkout.shipping_rate = rate
  recalculateTotals(checkout)
  await storeCheckout(checkout)
  return checkout
}

/**
 * Apply / remove a discount code.
 *
 * Phase 5 PR1: the implementations moved into `../discounts/service.ts`
 * so admin-side flows (draft orders, email campaign previews, BOGO) can
 * reuse the validation chain without importing the checkout module. We
 * re-export here so every old caller still lands on the right function.
 *
 * Behavioural difference: the new path also enforces
 * `discounts.once_per_customer` via `orders.discount_id` history —
 * something the inline version silently skipped.
 */
export { applyDiscount, removeDiscount } from '../discounts/service.js'

/**
 * Set the customer email on the checkout.
 */
export async function updateCheckoutEmail(
  checkoutId: string,
  email: string,
): Promise<CheckoutSession> {
  const checkout = await loadCheckout(checkoutId)
  if (!checkout) throw new Error('Checkout not found')
  if (checkout.completed_at) throw new Error('Checkout already completed')

  if (!email || !email.includes('@')) {
    throw new Error('Invalid email address')
  }

  checkout.email = email
  checkout.updated_at = new Date().toISOString()
  await storeCheckout(checkout)
  return checkout
}

/**
 * Complete the checkout: validate inventory, create order + line items +
 * transaction, reduce inventory atomically, increment discount usage,
 * and trigger a webhook placeholder.
 */
export async function completeCheckout(
  db: Kysely<Database>,
  checkoutId: string,
  paymentData: PaymentData,
): Promise<CheckoutSession> {
  const checkout = await loadCheckout(checkoutId)
  if (!checkout) throw new Error('Checkout not found')
  if (checkout.completed_at) throw new Error('Checkout already completed')

  if (!checkout.email) {
    throw new Error('Email is required to complete checkout')
  }

  // Items requiring shipping must have a shipping address
  const hasShippableItems = checkout.line_items.some(
    (li) => li.requires_shipping,
  )
  if (hasShippableItems && !checkout.shipping_address) {
    throw new Error('Shipping address is required for physical items')
  }

  // Webhook jobs are collected inside the transaction and dispatched
  // AFTER commit, never inside it. Reason: BullMQ writes to Redis, which
  // is not part of the Postgres transaction. If we enqueue from inside
  // the trx and the trx then rolls back, the worker would deliver an
  // orders/create webhook for an order that doesn't exist.
  const pendingWebhooks: Array<{
    shop_id: string
    topic: string
    payload: Record<string, unknown>
  }> = []

  const result = await db.transaction().execute(async (trx) => {
    // 0. Acquire per-variant advisory locks (PRINCIPLES.md P15).
    //
    //    `pg_advisory_xact_lock(hashtext(variant_id))` serializes any two
    //    concurrent completeCheckout calls that touch the same variant.
    //    Transaction-scoped locks auto-release on COMMIT/ROLLBACK — no
    //    explicit unlock needed. This is ~10x faster than SELECT FOR UPDATE
    //    because it doesn't hit the row.
    //
    //    Locks MUST be acquired in a deterministic (sorted) order across
    //    all callers, otherwise two carts holding {A,B} and {B,A} can
    //    deadlock waiting on each other. Sorting the variant_ids gives a
    //    total order so Postgres can queue them safely.
    const lockTargets = Array.from(
      new Set(checkout.line_items.map((li) => li.variant_id)),
    ).sort()
    for (const variantId of lockTargets) {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${variantId}))`.execute(trx)
    }

    // 1. Validate inventory for each line item
    for (const li of checkout.line_items) {
      const variant = await trx
        .selectFrom('product_variants')
        .select(['id', 'inventory_quantity', 'title'])
        .where('id', '=', li.variant_id)
        .executeTakeFirstOrThrow()

      if (variant.inventory_quantity < li.quantity) {
        throw new Error(
          `Insufficient inventory for "${li.title} - ${li.variant_title ?? 'default'}": ` +
          `requested ${li.quantity}, available ${variant.inventory_quantity}`,
        )
      }
    }

    // 2. Create the order
    const order = await trx
      .insertInto('orders')
      .values({
        shop_id: checkout.shop_id,
        // Phase 5 PR1 — attribute the order to the authenticated
        // customer if present so the Orders dashboard and lifecycle
        // rollups don't treat every logged-in buyer as a guest.
        customer_id: checkout.customer_id ?? null,
        email: checkout.email,
        currency: checkout.currency,
        financial_status: 'paid',
        fulfillment_status: 'unfulfilled',
        subtotal_price: checkout.subtotal_price,
        total_discounts: checkout.total_discounts,
        total_shipping: checkout.total_shipping,
        total_tax: checkout.total_tax,
        total_price: checkout.total_price,
        shipping_address: checkout.shipping_address
          ? JSON.stringify(checkout.shipping_address)
          : null,
        billing_address: checkout.billing_address
          ? JSON.stringify(checkout.billing_address ?? checkout.shipping_address)
          : null,
        note: null,
        tags: null,
        // Sprint 2b — carry UTM attribution through to the order row so
        // the store-admin Orders dashboard filters can slice by source /
        // medium / campaign / content / term.
        utm_source: checkout.utm_source ?? null,
        utm_medium: checkout.utm_medium ?? null,
        utm_campaign: checkout.utm_campaign ?? null,
        utm_content: checkout.utm_content ?? null,
        utm_term: checkout.utm_term ?? null,
        // Phase 5 PR1 — stamp the redeemed code + discount id on the
        // order so `once_per_customer` enforcement has something to
        // query next time the same buyer tries the same code.
        discount_code: checkout.discount?.code ?? null,
        discount_id: checkout.discount?.discount_id ?? null,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow()

    // 3. Create order line items
    await trx
      .insertInto('order_line_items')
      .values(
        checkout.line_items.map((li) => ({
          order_id: order.id,
          product_id: li.product_id,
          variant_id: li.variant_id,
          title: li.title,
          variant_title: li.variant_title,
          sku: li.sku,
          quantity: li.quantity,
          price: li.price,
          total_discount: '0',
          requires_shipping: li.requires_shipping,
          taxable: li.taxable,
        })),
      )
      .execute()

    // 4. Create payment transaction
    await trx
      .insertInto('transactions')
      .values({
        order_id: order.id,
        kind: 'sale',
        gateway: paymentData.gateway,
        amount: paymentData.amount ?? checkout.total_price,
        currency: checkout.currency,
        status: 'success',
        gateway_transaction_id: paymentData.gateway_transaction_id ?? null,
        authorization: paymentData.gateway_transaction_id ?? null,
      })
      .execute()

    // 5. Reduce inventory atomically
    //    NOTE: previously used `eb.bxp(...)` which is not a real Kysely API
    //    and silently broke every checkout in this code path. Replaced with
    //    `sql` template arithmetic — concurrency safety is now provided by
    //    the per-variant advisory locks acquired in step 0.
    for (const li of checkout.line_items) {
      // Reduce denormalized quantity on variant
      await trx
        .updateTable('product_variants')
        .set({
          inventory_quantity: sql`inventory_quantity - ${li.quantity}` as any,
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', li.variant_id)
        .execute()

      // Reduce inventory_levels if tracked
      const inventoryItem = await trx
        .selectFrom('inventory_items')
        .select('id')
        .where('variant_id', '=', li.variant_id)
        .executeTakeFirst()

      if (inventoryItem) {
        await trx
          .updateTable('inventory_levels')
          .set({
            available: sql`available - ${li.quantity}` as any,
            updated_at: new Date().toISOString(),
          })
          .where('inventory_item_id', '=', inventoryItem.id)
          .execute()
      }
    }

    // 6. Increment discount usage if applicable
    if (checkout.discount) {
      await trx
        .updateTable('discounts')
        .set({
          usage_count: sql`usage_count + 1` as any,
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', checkout.discount.discount_id)
        .execute()
    }

    // 7. Enqueue webhook delivery (orders/create) on the BullMQ
    //    `webhook-delivery` queue. Decision #8: webhook fan-out happens
    //    in a background worker so the checkout response isn't blocked
    //    by slow merchant subscribers. The job is added INSIDE the
    //    transaction — if completeCheckout rolls back, BullMQ will
    //    still hold the job, so we instead schedule the enqueue from
    //    the after-commit caller below.
    pendingWebhooks.push({
      shop_id: checkout.shop_id,
      topic: 'orders/create',
      payload: { order_id: order.id, checkout_id: checkout.id },
    })

    // 8. Mark checkout complete
    checkout.completed_at = new Date().toISOString()
    checkout.order_id = order.id
    checkout.updated_at = checkout.completed_at

    // Persist completed state in Redis (keep for 24h for reference)
    await cacheSet(`${CHECKOUT_PREFIX}${checkout.id}`, checkout, 86400)

    return checkout
  })

  // -------------------------------------------------------------------------
  // After-commit side effects: enqueue webhooks + post-order fan-out.
  // Failures here are LOGGED but never thrown — the order is already
  // committed, so a Redis blip shouldn't surface as a failed checkout
  // to the customer. Phase 3C moved the post-order email / receipt /
  // analytics work off the checkout hot path and onto the
  // `order-processing` queue so completeCheckout returns in <50ms
  // even on flash-sale bursts.
  // -------------------------------------------------------------------------
  for (const job of pendingWebhooks) {
    try {
      await enqueueWebhookDelivery(job)
    } catch (err) {
      console.error(
        `[checkout] failed to enqueue webhook ${job.topic} for shop ${job.shop_id}:`,
        (err as Error).message,
      )
    }
  }

  if (result.order_id) {
    try {
      await enqueueStandardOrderFanout(checkout.shop_id, result.order_id)
    } catch (err) {
      console.error(
        `[checkout] failed to enqueue order-processing fan-out for order ${result.order_id}:`,
        (err as Error).message,
      )
    }
  }

  // -------------------------------------------------------------------------
  // Phase 8 PR2f — stamp `recovered_at` on any abandoned-cart enrolments
  // tied to this checkout. The cron's enrolment filter
  // (`recovered_at is null`) will then skip this row on every future
  // tick, so the buyer doesn't get another "you left something behind"
  // email after they've already paid.
  //
  // Fire-and-forget + swallow errors: the order is already committed,
  // and the worst case if this fails is one extra recovery email that
  // `selectPendingStep` will still gate on `recovered_at === null`.
  // Cross-package Kysely identity workaround via `(db as any)` — same
  // pattern used at every other cross-package callsite into the
  // abandoned-cart service.
  // -------------------------------------------------------------------------
  try {
    await markAbandonedCartRecovered(db as any, checkoutId)
  } catch (err) {
    console.error(
      `[checkout] failed to markAbandonedCartRecovered for checkout ${checkoutId}:`,
      (err as Error).message,
    )
  }

  return result
}

