/**
 * Gbox Platform — Discount Service (Phase 5 / PR1).
 *
 * Extracted out of `checkout/service.ts` where it lived inline. The split
 * exists for three reasons:
 *
 *   1. Admins need discount validation outside the checkout flow (draft
 *      orders, email campaign previews, bulk coupon generation). Having
 *      the logic under a dedicated module lets those surfaces reuse it
 *      without pulling in Redis-backed checkout state.
 *   2. `once_per_customer` enforcement requires an orders-history query
 *      that has nothing to do with the Redis checkout session — putting
 *      it in a separate file keeps the checkout service focused on the
 *      session lifecycle.
 *   3. Phase 5 PR2 will add BOGO and automatic (codeless) discounts that
 *      want the same validation path without a CheckoutSession at hand.
 *
 * Callable API (both signatures preserved for drop-in compat with the
 * old `checkout/service.ts` exports):
 *
 *   applyDiscount(db, checkoutId, code)       — code-entry flow
 *   removeDiscount(checkoutId)                — "X" button on the pill
 *
 * New helpers:
 *
 *   validateDiscountForCart(db, discount, cart)
 *     Pure-ish validation you can call from the admin draft-order page
 *     without needing a CheckoutSession. Returns a Discriminated-union
 *     so callers can branch on the specific failure kind.
 *
 *   wasDiscountRedeemedByCustomer(db, shopId, discountId, customer)
 *     Looks up past redemptions via `orders.discount_id = ?`. Uses BOTH
 *     customer_id (authenticated) AND email (guest fallback) so the
 *     enforcement holds across mixed-flow buyers.
 *
 * Error messages are intentionally user-readable — they bubble up to the
 * buyer as inline toast text on the checkout page, so we don't stringify
 * SQL errors. Every failure returns an `Error` whose `.message` is safe
 * to show in the DOM.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { cacheGet, cacheSet } from '../cache/redis.js'
import {
  checkoutFallbackStore,
  type CheckoutSession,
} from '../checkout/service.js'

// ---------------------------------------------------------------------------
// Redis checkout accessors
//
// We reach into the checkout module's Redis prefix on purpose: the discount
// service needs to mutate the live session without a round-trip through the
// REST layer. Keeping the key shape in sync with checkout/service.ts is a
// known coupling — if that file ever changes CHECKOUT_PREFIX, this file must
// follow. A light-touch guard-rail is a compile-time assertion against the
// imported `CheckoutSession` type (so a field rename breaks this file first
// at build time rather than at runtime).
// ---------------------------------------------------------------------------

const CHECKOUT_PREFIX = 'checkout:'
const CHECKOUT_TTL = 3600 // mirror checkout/service.ts

// Share the checkout module's fallback store. A private duplicate map here
// would never see sessions created by `createCheckout`, so `applyDiscount`
// would fail with "Checkout not found" the moment Redis is degraded.
// `cacheSet` swallows its own errors, so wrapping it in try/catch never
// triggers a fallback branch — dual-write is the only reliable pattern.
async function loadCheckoutForDiscount(
  id: string,
): Promise<CheckoutSession | null> {
  const cached = await cacheGet<CheckoutSession>(`${CHECKOUT_PREFIX}${id}`)
  if (cached) return cached
  return checkoutFallbackStore.get(id) ?? null
}

async function storeCheckoutForDiscount(
  checkout: CheckoutSession,
): Promise<void> {
  checkoutFallbackStore.set(checkout.id, checkout)
  await cacheSet(`${CHECKOUT_PREFIX}${checkout.id}`, checkout, CHECKOUT_TTL)
}

// ---------------------------------------------------------------------------
// Validation result — discriminated union
// ---------------------------------------------------------------------------

/**
 * The outcome of `validateDiscountForCart`. Success carries the discount
 * row; failure carries a machine-readable `kind` plus a user-readable
 * `message`. The kinds align with the branches inside
 * `applyDiscount` so admin-side callers can localize per-kind.
 */
export type DiscountValidationResult =
  | { ok: true; discount: DiscountRow }
  | { ok: false; kind: DiscountFailureKind; message: string }

export type DiscountFailureKind =
  | 'not_found'
  | 'inactive'
  | 'not_started'
  | 'expired'
  | 'usage_cap_reached'
  | 'min_purchase_not_met'
  | 'min_items_not_met'
  | 'once_per_customer_reached'
  // Phase 5 PR2 — product/collection-scoped discount matched zero items in
  // the cart. The code is real and active, but buyer's cart contains
  // nothing the discount applies to. Shopify rejects application with a
  // generic "This discount code isn't valid" — we give a clearer message
  // so the buyer knows to add qualifying items.
  | 'no_eligible_items'
  // Phase 5 PR3 — buyer tried to enter an automatic discount by code.
  // Automatic discounts apply themselves when the cart qualifies; the
  // manual apply path must refuse them so we don't double-apply.
  | 'automatic_only'
  // Phase 5 PR5 — discount is scoped to customer segments (B2B tier,
  // VIPs, repeat buyers, etc.) but the checkout is either a guest or
  // the authenticated customer doesn't match any eligible segment.
  | 'customer_not_eligible'
  // Phase 5 PR5 — BOGO discount applied but the eligible cart doesn't
  // have enough items to complete even one buy+get cycle.
  | 'bogo_cycle_not_met'

// Mirror of the `discounts` row shape — picks just the fields the engine
// touches. Using a structural type (not Kysely's SelectType) keeps tests
// easy to stub.
export interface DiscountRow {
  id: string
  shop_id: string
  code: string | null
  type: string                // 'percentage' | 'fixed_amount' | 'free_shipping'
  value: string               // numeric(10,2)
  value_type: string          // 'percentage' | 'fixed'
  status: string              // 'active' | 'expired' | 'scheduled'
  starts_at: string
  ends_at: string | null
  usage_limit: number | null
  once_per_customer: boolean
  usage_count: number
  minimum_requirement_type: string  // 'none' | 'purchase_amount' | 'item_count'
  minimum_requirement_value: string | null
  // Phase 5 PR2 — product / collection scoping. `applies_to` is the
  // switch; `target_selection` is a JSONB array of product_ids (for
  // 'specific_products') or collection_ids (for 'specific_collections').
  // 'all' ignores `target_selection` entirely.
  applies_to: string          // 'all' | 'specific_products' | 'specific_collections'
  target_selection: unknown   // jsonb — string[] of product_ids or collection_ids
  // Phase 5 PR3 — 'code' means buyer enters the code at checkout;
  // 'automatic' means the system auto-applies when the cart qualifies.
  // Defaults to 'code' in the DB so every pre-PR3 row behaves as before.
  method?: string             // 'code' | 'automatic' (default 'code')
  // Phase 5 PR4 — tiered percentage. Non-null only when the merchant
  // configured tiers; then the runtime picks the highest tier whose
  // threshold <= eligible subtotal and IGNORES the flat `value`.
  tiers?: unknown             // jsonb — Array<{ threshold, percentage }>
  // Phase 5 PR5 — Buy-X-Get-Y allocator config. Only meaningful when
  // type='bogo'. Shape: { buy_quantity, get_quantity, get_discount_percentage }.
  bogo_config?: unknown       // jsonb
  // Phase 5 PR5 — array of customer_segments.id. When non-null and
  // non-empty, discount is restricted to customers matching at least
  // one listed segment's rules.
  eligible_segment_ids?: unknown  // jsonb — string[] of uuids
}

/**
 * Phase 5 PR4 — a single tier in a tiered percentage discount.
 */
export interface DiscountTier {
  threshold: number
  percentage: number
}

/**
 * Parse a raw `tiers` jsonb value into a sorted, validated tier list.
 * Returns [] for null/missing/malformed input so callers can treat
 * "no tiers" and "invalid tiers" identically (fall back to flat value).
 */
export function normalizeTiers(raw: unknown): DiscountTier[] {
  let list: unknown[] = []
  if (Array.isArray(raw)) list = raw
  else if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) list = parsed
    } catch {
      return []
    }
  } else if (raw && typeof raw === 'object') {
    // Accept a wrapper shape { tiers: [...] } for admin-side drafts.
    const inner = (raw as any).tiers
    if (Array.isArray(inner)) list = inner
  }
  const out: DiscountTier[] = []
  for (const t of list) {
    if (!t || typeof t !== 'object') continue
    const threshold = Number((t as any).threshold)
    const percentage = Number((t as any).percentage)
    if (!Number.isFinite(threshold) || threshold < 0) continue
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) continue
    out.push({ threshold, percentage })
  }
  // Stable ASC sort by threshold so pickTier can walk from the highest.
  out.sort((a, b) => a.threshold - b.threshold)
  return out
}

/**
 * Phase 5 PR4 — pick the highest-threshold tier whose threshold <=
 * `subtotal`. Returns `null` when no tier qualifies (caller falls back
 * to the flat `value` or to zero discount).
 */
export function pickTier(
  tiers: DiscountTier[],
  subtotal: number,
): DiscountTier | null {
  let winner: DiscountTier | null = null
  for (const t of tiers) {
    if (t.threshold <= subtotal) winner = t
    else break // tiers are ASC — first miss terminates
  }
  return winner
}

/**
 * Phase 5 PR5 — Buy-X-Get-Y config. Applied on top of the existing
 * applies_to / target_selection scope; `buy_quantity` + `get_quantity`
 * refer to ELIGIBLE line items (scoped by applies_to). The allocator
 * treats the cart as a unit-level sequence (quantity=3 of a $10 item
 * = three separate $10 units) so cycles span across lines correctly.
 */
export interface BogoConfig {
  buy_quantity: number
  get_quantity: number
  get_discount_percentage: number // 0..100 ; 100 = free
}

/**
 * Parse and validate a raw `bogo_config` jsonb value. Returns null for
 * missing / malformed input so callers can short-circuit to
 * `bogo_cycle_not_met`-style validation errors rather than crashing.
 */
export function normalizeBogoConfig(raw: unknown): BogoConfig | null {
  let obj: any = raw
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      obj = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!obj || typeof obj !== 'object') return null
  const buy = Number(obj.buy_quantity)
  const get = Number(obj.get_quantity)
  const pct = Number(obj.get_discount_percentage)
  if (!Number.isFinite(buy) || buy < 1 || !Number.isInteger(buy)) return null
  if (!Number.isFinite(get) || get < 1 || !Number.isInteger(get)) return null
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null
  return { buy_quantity: buy, get_quantity: get, get_discount_percentage: pct }
}

/**
 * Phase 5 PR5 — compute the BOGO discount amount for a scoped cart.
 *
 * Algorithm (Shopify parity for single-scope BOGO):
 *   1. Expand eligible line items into a unit-price list — a line with
 *      quantity=3 at $10 becomes three $10 entries.
 *   2. Sort unit prices ASC (cheapest first).
 *   3. Compute complete cycles: floor(total / (buy + get)).
 *   4. For each cycle, discount the `get_quantity` cheapest units at
 *      `get_discount_percentage`. Summed across all cycles.
 *
 * Why cheapest-first? The buyer's total discount is maximized when the
 * cheapest qualifying units are the ones discounted — matches the
 * "Buy 2 get 1 free (lowest priced)" Shopify default and keeps the
 * calculation deterministic regardless of line ordering.
 */
export function computeBogoDiscount(
  config: BogoConfig,
  eligibleLineItems: DiscountLineItem[],
): number {
  const cycleSize = config.buy_quantity + config.get_quantity
  if (cycleSize <= 0) return 0
  const units: number[] = []
  for (const li of eligibleLineItems) {
    const price = parseFloat(li.price)
    if (!Number.isFinite(price) || li.quantity <= 0) continue
    for (let i = 0; i < li.quantity; i++) units.push(price)
  }
  if (units.length < cycleSize) return 0
  units.sort((a, b) => a - b)
  const cycles = Math.floor(units.length / cycleSize)
  if (cycles === 0) return 0
  const pctFraction = config.get_discount_percentage / 100
  let amount = 0
  for (let c = 0; c < cycles; c++) {
    for (let i = 0; i < config.get_quantity; i++) {
      // Indexing into the cheapest-first array: cycle 0 takes units 0..M-1,
      // cycle 1 takes units M..2M-1, etc. (each cycle claims its own
      // cheapest slice — no overlap).
      const idx = c * config.get_quantity + i
      if (idx < units.length) amount += units[idx] * pctFraction
    }
  }
  return amount
}

/**
 * Phase 5 PR5 — normalize a raw `eligible_segment_ids` jsonb into a
 * string[] of non-empty uuid-shaped tokens. Returns null for
 * "any customer" (null input OR empty array after filter).
 */
export function normalizeEligibleSegments(raw: unknown): string[] | null {
  let list: unknown[] = []
  if (Array.isArray(raw)) list = raw
  else if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) list = parsed
    } catch {
      return null
    }
  } else {
    return null
  }
  const out: string[] = []
  for (const v of list) {
    if (typeof v === 'string' && v.length > 0) out.push(v)
  }
  return out.length === 0 ? null : out
}

/**
 * Line-item shape the discount engine needs for scope enforcement.
 * Structural subset of `CheckoutLineItem` so tests + admin previews can
 * synthesize a cart without a full checkout session.
 */
export interface DiscountLineItem {
  product_id: string
  price: string               // per-unit, numeric(10,2) as string
  quantity: number
}

export interface CartForDiscount {
  subtotal: string                 // numeric string, matches checkout.subtotal_price
  itemCount: number                // sum of line-item quantities
  customerId?: string | null       // authenticated customer (nullable guest)
  email?: string | null            // falls back for guest once_per_customer
  // Phase 5 PR2 — required when the caller expects product/collection
  // scope enforcement. If omitted, scope check degrades to a permissive
  // "applies to all" path (matches pre-PR2 behavior for callers that
  // haven't been updated yet).
  lineItems?: DiscountLineItem[]
}

/**
 * Pre-resolved scope — 'all' means "discount every line", 'products'
 * carries the set of product_ids the discount applies to. Collections
 * are resolved to products via `collection_products` at lookup time.
 */
export type DiscountScope =
  | { kind: 'all' }
  | { kind: 'products'; ids: Set<string> }

// ---------------------------------------------------------------------------
// Core validation — pure function over a DiscountRow + cart snapshot
// ---------------------------------------------------------------------------

/**
 * Validate a discount against a cart snapshot + customer identity.
 *
 * Returns a DU that lets admin-side callers (draft orders, previews,
 * email unfurls) branch on the exact failure kind without reparsing
 * `.message` strings.
 *
 * Network boundary: we DO query `orders` for the once-per-customer
 * check, so this is async even though the rest of the logic is pure.
 */
export async function validateDiscountForCart(
  db: Kysely<Database>,
  discount: DiscountRow,
  cart: CartForDiscount,
): Promise<DiscountValidationResult> {
  // 1. Active? Phase 5 PR3 — the `status` column is informational;
  //    starts_at + ends_at are the source of truth so a missed cron job
  //    never accidentally rejects a valid-in-time-window discount. We
  //    still respect an explicit 'expired' stored status (admins can
  //    force-expire a live discount).
  if (discount.status === 'expired') {
    return {
      ok: false,
      kind: 'inactive',
      message: 'This discount code is not active.',
    }
  }

  // 2. Date window (authoritative)
  const now = new Date()
  if (new Date(discount.starts_at) > now) {
    return {
      ok: false,
      kind: 'not_started',
      message: 'This discount has not started yet.',
    }
  }
  if (discount.ends_at && new Date(discount.ends_at) < now) {
    return {
      ok: false,
      kind: 'expired',
      message: 'This discount has expired.',
    }
  }

  // 3. Usage cap across all buyers
  if (
    discount.usage_limit !== null &&
    discount.usage_count >= discount.usage_limit
  ) {
    return {
      ok: false,
      kind: 'usage_cap_reached',
      message: 'This discount has reached its usage limit.',
    }
  }

  // 4. Minimum requirement
  if (discount.minimum_requirement_type === 'purchase_amount') {
    const min = parseFloat(discount.minimum_requirement_value ?? '0')
    if (parseFloat(cart.subtotal) < min) {
      return {
        ok: false,
        kind: 'min_purchase_not_met',
        message: `This discount requires a minimum purchase of ${min.toFixed(2)}.`,
      }
    }
  } else if (discount.minimum_requirement_type === 'item_count') {
    const min = parseInt(discount.minimum_requirement_value ?? '0', 10)
    if (cart.itemCount < min) {
      return {
        ok: false,
        kind: 'min_items_not_met',
        message: `This discount requires at least ${min} item${min === 1 ? '' : 's'}.`,
      }
    }
  }

  // 5. Phase 5 PR2 — product/collection scope. Only enforced when the
  //    caller supplied `lineItems`; back-compat: older callers that
  //    pass a cart without lineItems skip the check so they don't
  //    regress. `resolveDiscountScope` hits `collection_products` when
  //    the discount scopes to collections.
  if (discount.applies_to !== 'all' && cart.lineItems) {
    const scope = await resolveDiscountScope(db, discount)
    const eligible = eligibleSubtotal(scope, cart.lineItems)
    if (eligible === 0) {
      return {
        ok: false,
        kind: 'no_eligible_items',
        message: 'No items in your cart qualify for this discount.',
      }
    }
  }

  // 6. Phase 5 PR5 — customer-segment eligibility. Discounts scoped to
  //    a specific segment (VIPs, wholesale, returning buyers) require
  //    an authenticated customer_id AND that customer must match at
  //    least one listed segment's rules. Guests get bounced with
  //    `customer_not_eligible` — the buyer-side CTA is "log in to use
  //    this code" which the UI can map off the failure kind.
  const eligibleSegments = normalizeEligibleSegments(
    discount.eligible_segment_ids,
  )
  if (eligibleSegments) {
    if (!cart.customerId) {
      return {
        ok: false,
        kind: 'customer_not_eligible',
        message: 'Please sign in to use this discount.',
      }
    }
    const matches = await customerMatchesAnySegment(
      db,
      discount.shop_id,
      cart.customerId,
      eligibleSegments,
    )
    if (!matches) {
      return {
        ok: false,
        kind: 'customer_not_eligible',
        message: 'This discount is not available for your account.',
      }
    }
  }

  // 7. once_per_customer — strongest check, last because it's the only
  //    one that hits the DB for buyer-specific history.
  if (discount.once_per_customer) {
    const redeemed = await wasDiscountRedeemedByCustomer(
      db,
      discount.shop_id,
      discount.id,
      { customerId: cart.customerId ?? null, email: cart.email ?? null },
    )
    if (redeemed) {
      return {
        ok: false,
        kind: 'once_per_customer_reached',
        message: 'This discount can only be used once per customer.',
      }
    }
  }

  // 8. Phase 5 PR5 — BOGO cycle check. Even if scope + minimums pass, a
  //    BOGO with buy_quantity=2,get_quantity=1 needs 3 eligible units in
  //    the cart before it can discount anything. Shopify shows a
  //    "Add 2 more items" helper — we emit the reason so the UI can do
  //    the same.
  if (discount.type === 'bogo') {
    const config = normalizeBogoConfig(discount.bogo_config)
    if (!config) {
      // Malformed config — reject as if inactive. The admin UI should
      // have validated, but data may have been hand-edited.
      return {
        ok: false,
        kind: 'inactive',
        message: 'This discount is not active.',
      }
    }
    if (cart.lineItems) {
      const scope = await resolveDiscountScope(db, discount)
      const eligibleLines =
        scope.kind === 'all'
          ? cart.lineItems
          : cart.lineItems.filter((li) => scope.ids.has(li.product_id))
      const totalUnits = eligibleLines.reduce((s, li) => s + li.quantity, 0)
      const cycleSize = config.buy_quantity + config.get_quantity
      if (totalUnits < cycleSize) {
        const shortfall = cycleSize - totalUnits
        return {
          ok: false,
          kind: 'bogo_cycle_not_met',
          message: `Add ${shortfall} more item${shortfall === 1 ? '' : 's'} to unlock this discount.`,
        }
      }
    }
  }

  return { ok: true, discount }
}

/**
 * Phase 5 PR5 — does this customer match at least one of the given
 * segments? Uses a single SQL query with OR-combined subqueries so we
 * never pay the N+1 cost of evaluating each segment separately.
 *
 * Segments that reference an unknown/deleted ID are skipped — treating
 * them as hard failure would lock out legitimate customers every time
 * an admin deletes a segment.
 */
export async function customerMatchesAnySegment(
  db: Kysely<Database>,
  shopId: string,
  customerId: string,
  segmentIds: string[],
): Promise<boolean> {
  if (segmentIds.length === 0) return true
  const { parseRules } = await import('../customer-segments/service.js')
  const { buildRuleWhere } = await import('../customer-segments/rules.js')

  // Fetch all segments' rules in one round-trip.
  const rows = await db
    .selectFrom('customer_segments')
    .select(['id', 'rules_json'])
    .where('shop_id', '=', shopId)
    .where('id', 'in', segmentIds)
    .execute()
  if (rows.length === 0) return false

  // For each segment, run a scoped query: does THIS customer match
  // THIS segment's rules? We bail on the first match.
  for (const row of rows) {
    let ruleset
    try {
      ruleset = parseRules(row.rules_json)
    } catch {
      continue // malformed rules — skip, don't hard-fail
    }
    const result = await db
      .selectFrom('customers')
      .select('id')
      .where('shop_id', '=', shopId)
      .where('id', '=', customerId)
      .where((eb) => buildRuleWhere(eb, ruleset))
      .executeTakeFirst()
    if (result) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Phase 5 PR2 — scope resolution + eligible-subtotal math
// ---------------------------------------------------------------------------

/**
 * Resolve a discount's `applies_to` + `target_selection` into a concrete
 * set of product_ids the discount applies to. Collection scopes expand
 * via the `collection_products` join table.
 *
 * Callers cache the returned Set when they plan to reuse it inside a
 * recalc loop (we don't cache internally — PR2 scope is small and the
 * admin-side preview doesn't need the overhead).
 */
export async function resolveDiscountScope(
  db: Kysely<Database>,
  discount: Pick<DiscountRow, 'applies_to' | 'target_selection'>,
): Promise<DiscountScope> {
  if (discount.applies_to === 'all') return { kind: 'all' }

  // target_selection is jsonb; the admin form stores string arrays.
  // Defend against legacy rows that stored ",,a,b" style strings or
  // {"products":[...]}-shaped objects by normalising to an id list.
  const ids = normalizeTargetSelection(discount.target_selection)

  if (discount.applies_to === 'specific_products') {
    return { kind: 'products', ids: new Set(ids) }
  }

  if (discount.applies_to === 'specific_collections') {
    if (!ids.length) return { kind: 'products', ids: new Set() }
    const rows = await db
      .selectFrom('collection_products')
      .select('product_id')
      .where('collection_id', 'in', ids as any)
      .execute()
    return { kind: 'products', ids: new Set(rows.map((r: any) => r.product_id)) }
  }

  // Unknown `applies_to` — fail safe to "all" so the code still applies.
  // A corrupt applies_to value is a schema-integrity problem, not a
  // buyer-facing one.
  return { kind: 'all' }
}

/**
 * Given a pre-resolved scope + cart lines, compute the subtotal of the
 * matching lines. Matches 'all' returns the full cart subtotal; a
 * product-scoped discount sums only qualifying lines.
 */
export function eligibleSubtotal(
  scope: DiscountScope,
  lineItems: DiscountLineItem[],
): number {
  if (scope.kind === 'all') {
    return lineItems.reduce(
      (sum, li) => sum + parseFloat(li.price) * li.quantity,
      0,
    )
  }
  return lineItems
    .filter((li) => scope.ids.has(li.product_id))
    .reduce((sum, li) => sum + parseFloat(li.price) * li.quantity, 0)
}

/**
 * target_selection is declared `jsonb` in the schema. The admin create
 * form stores `["id1","id2"]`; but we've seen rogue rows stored as
 * objects, comma-joined strings, or null. Normalise to a clean string[].
 */
function normalizeTargetSelection(raw: unknown): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === 'string' && x.length > 0)
  }
  if (typeof raw === 'string') {
    // jsonb columns may come back as pre-parsed JS values OR as raw JSON
    // text depending on the pg type parser. Try JSON first so
    // '["uuid-a","uuid-b"]' doesn't get treated as a comma-split string.
    const trimmed = raw.trim()
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        return normalizeTargetSelection(JSON.parse(trimmed))
      } catch {
        // fall through to comma-split
      }
    }
    return trimmed
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
  if (typeof raw === 'object' && raw !== null) {
    // Shape { ids: [...] } or { products: [...] } — accept either.
    const maybe = (raw as any).ids ?? (raw as any).products ?? (raw as any).collections
    if (Array.isArray(maybe)) {
      return maybe.filter((x: unknown): x is string => typeof x === 'string' && x.length > 0)
    }
  }
  return []
}

// ---------------------------------------------------------------------------
// once_per_customer lookup
// ---------------------------------------------------------------------------

/**
 * Has this discount been redeemed by this customer before? Matches on
 * either `orders.customer_id` OR `orders.email` so the check holds
 * across guest→account transitions (buyer redeems as guest, creates an
 * account later with the same email, tries the same code again).
 *
 * Note: matching by email alone leaks a known-throwaway-email bypass.
 * That's accepted for v1 — operators who need rock-solid enforcement
 * should mark the discount with `usage_limit = 1` instead.
 */
export async function wasDiscountRedeemedByCustomer(
  db: Kysely<Database>,
  shopId: string,
  discountId: string,
  who: { customerId: string | null; email: string | null },
): Promise<boolean> {
  const hasIdentity = !!who.customerId || !!who.email
  if (!hasIdentity) {
    // Fully anonymous guest with no email yet — we can't tie them to
    // a past redemption. Let them apply; the other caps (usage_limit,
    // date window) still gate misuse.
    return false
  }

  let q = db
    .selectFrom('orders')
    .select('id')
    .where('shop_id', '=', shopId)
    .where('discount_id', '=', discountId)

  // OR match: customer_id = X OR email = Y. We wrap in an `eb.or` via
  // `where` callback.
  q = q.where((eb) => {
    const ors: ReturnType<typeof eb.and>[] = []
    if (who.customerId) ors.push(eb.and([eb('customer_id', '=', who.customerId)]))
    if (who.email) ors.push(eb.and([eb('email', '=', who.email)]))
    return eb.or(ors)
  })

  const hit = await q.limit(1).executeTakeFirst()
  return !!hit
}

// ---------------------------------------------------------------------------
// Runtime apply / remove
// ---------------------------------------------------------------------------

/**
 * Apply a discount code to a live checkout. Walks the validation chain,
 * mutates the session in Redis, and returns the updated checkout.
 *
 * Throws on any failure with a buyer-safe `.message`. The checkout page
 * catches and renders the message inline.
 */
export async function applyDiscount(
  db: Kysely<Database>,
  checkoutId: string,
  code: string,
): Promise<CheckoutSession> {
  const checkout = await loadCheckoutForDiscount(checkoutId)
  if (!checkout) throw new Error('Checkout not found')
  if (checkout.completed_at) throw new Error('Checkout already completed')

  const trimmed = String(code ?? '').trim()
  if (!trimmed) throw new Error('Discount code is required')

  // Look up by (shop_id, code). Case-sensitive — matches storage. If
  // admins want case-insensitive codes they should normalize at write
  // time (not decode/encode here).
  const discount = await db
    .selectFrom('discounts')
    .selectAll()
    .where('shop_id', '=', checkout.shop_id)
    .where('code', '=', trimmed)
    .executeTakeFirst()

  if (!discount) {
    throw new Error('Discount code not found')
  }

  // Phase 5 PR3 — automatic-method discounts can never be applied
  // through the code-entry path. Even if a merchant sets BOTH a code
  // AND method='automatic' (rare but legal), the buyer entering that
  // code manually must be rejected — otherwise we'd double-apply once
  // the automatic evaluator runs on the next cart mutation.
  if ((discount as DiscountRow).method === 'automatic') {
    throw new Error(
      'This discount is applied automatically — no code needed.',
    )
  }

  const itemCount = checkout.line_items.reduce((s, li) => s + li.quantity, 0)
  // Phase 5 PR2 — pass line items so validateDiscountForCart can enforce
  // product/collection scope (no_eligible_items rejection).
  const result = await validateDiscountForCart(db, discount as DiscountRow, {
    subtotal: checkout.subtotal_price,
    itemCount,
    customerId: (checkout as any).customer_id ?? null,
    email: checkout.email,
    lineItems: checkout.line_items.map((li) => ({
      product_id: li.product_id,
      price: li.price,
      quantity: li.quantity,
    })),
  })
  if (!result.ok) {
    throw new Error(result.message)
  }

  // Resolve scope ONCE and stamp eligible_product_ids so downstream
  // recalcs (shipping change, tax recompute on address change) don't
  // re-query `collection_products`. `null` means "applies to all".
  const scope = await resolveDiscountScope(db, result.discount)
  const eligibleProductIds: string[] | null =
    scope.kind === 'all' ? null : Array.from(scope.ids)

  // Phase 5 PR4 — parse + stamp tiers once so every subsequent recalc
  // reads the sorted list without re-parsing jsonb.
  const tiers = normalizeTiers((result.discount as DiscountRow).tiers)
  // Phase 5 PR5 — parse + stamp BOGO config so the recalc path doesn't
  // re-parse jsonb on every cart mutation.
  const bogoConfig = normalizeBogoConfig(
    (result.discount as DiscountRow).bogo_config,
  )

  checkout.discount = {
    code: result.discount.code!,
    discount_id: result.discount.id,
    type: result.discount.type,
    value: result.discount.value,
    value_type: result.discount.value_type,
    amount: '0.00',
    eligible_product_ids: eligibleProductIds,
    is_automatic: false,
    tiers: tiers.length > 0 ? tiers : null,
    bogo_config: bogoConfig,
  }
  await recalculateAndStore(checkout)
  return checkout
}

/** Remove whatever discount is currently on the checkout. No-op safe. */
export async function removeDiscount(
  checkoutId: string,
): Promise<CheckoutSession> {
  const checkout = await loadCheckoutForDiscount(checkoutId)
  if (!checkout) throw new Error('Checkout not found')
  if (checkout.completed_at) throw new Error('Checkout already completed')

  checkout.discount = null
  await recalculateAndStore(checkout)
  return checkout
}

// ---------------------------------------------------------------------------
// Phase 5 PR3 — automatic (codeless) discounts
// ---------------------------------------------------------------------------

/**
 * Fetch every active automatic discount for a shop, ordered by
 * created_at DESC (newest first — deterministic tie-break when two
 * automatics yield identical value on the same cart).
 *
 * "Active" is a SQL-level filter (method='automatic', stored status
 * is not explicitly 'expired', within starts_at/ends_at window) —
 * the buyer-facing validator re-runs the full chain because SQL can't
 * evaluate scope + minimums without the cart.
 */
export async function findActiveAutomaticDiscounts(
  db: Kysely<Database>,
  shopId: string,
  nowIso?: string,
): Promise<DiscountRow[]> {
  const now = nowIso ?? new Date().toISOString()
  const rows = await db
    .selectFrom('discounts')
    .selectAll()
    .where('shop_id', '=', shopId)
    .where('method', '=', 'automatic')
    .where('status', '!=', 'expired')
    .where('starts_at', '<=', now)
    .where((eb) =>
      eb.or([
        eb('ends_at', 'is', null),
        eb('ends_at', '>', now),
      ]),
    )
    .orderBy('created_at', 'desc')
    .execute()
  return rows as unknown as DiscountRow[]
}

/**
 * Evaluate every automatic discount against a live checkout and apply
 * the best-matching one — or clear a now-stale automatic if the cart
 * no longer qualifies for anything.
 *
 * Rules (Shopify parity):
 *   - A code-based discount already on the checkout wins; automatics
 *     don't stack on top.
 *   - "Best" = largest absolute discount amount on the current cart,
 *     evaluated after scope + minimums. Ties go to the newest discount
 *     (findActiveAutomaticDiscounts orders DESC).
 *   - If the current auto is no longer eligible, it's cleared even if
 *     nothing else qualifies — the buyer should never see a phantom
 *     "Saved $X" pill that isn't actually being applied.
 *
 * Returns the mutated checkout (also persisted to Redis).
 */
export async function evaluateAutomaticDiscount(
  db: Kysely<Database>,
  checkoutId: string,
): Promise<CheckoutSession> {
  const checkout = await loadCheckoutForDiscount(checkoutId)
  if (!checkout) throw new Error('Checkout not found')
  if (checkout.completed_at) return checkout

  // Code-based discount applied → automatics never override.
  const current = checkout.discount
  if (current && !current.is_automatic) {
    return checkout
  }

  const automatics = await findActiveAutomaticDiscounts(db, checkout.shop_id)
  const itemCount = checkout.line_items.reduce((s, li) => s + li.quantity, 0)
  const lineItems = checkout.line_items.map((li) => ({
    product_id: li.product_id,
    price: li.price,
    quantity: li.quantity,
  }))

  type Candidate = {
    discount: DiscountRow
    amount: number
    eligibleProductIds: string[] | null
    tiers: DiscountTier[]
    bogoConfig: BogoConfig | null
  }
  const candidates: Candidate[] = []

  for (const discount of automatics) {
    const result = await validateDiscountForCart(db, discount, {
      subtotal: checkout.subtotal_price,
      itemCount,
      customerId: (checkout as any).customer_id ?? null,
      email: checkout.email,
      lineItems,
    })
    if (!result.ok) continue

    const scope = await resolveDiscountScope(db, result.discount)
    const eligibleProductIds: string[] | null =
      scope.kind === 'all' ? null : Array.from(scope.ids)
    const eligibleLines =
      scope.kind === 'all'
        ? lineItems
        : lineItems.filter((li) => scope.ids.has(li.product_id))
    const eligible = eligibleLines.reduce(
      (s, li) => s + parseFloat(li.price) * li.quantity,
      0,
    )

    // Phase 5 PR4 — tiers override flat value for comparison.
    const tiers = normalizeTiers(result.discount.tiers)
    // Phase 5 PR5 — BOGO config drives allocator-based comparison.
    const bogoConfig = normalizeBogoConfig(result.discount.bogo_config)

    let amount: number
    const v = parseFloat(result.discount.value)
    if (result.discount.type === 'bogo' && bogoConfig) {
      amount = computeBogoDiscount(bogoConfig, eligibleLines)
    } else if (result.discount.value_type === 'percentage') {
      if (tiers.length > 0) {
        const t = pickTier(tiers, eligible)
        amount = t ? eligible * (t.percentage / 100) : 0
      } else {
        amount = eligible * (v / 100)
      }
    } else {
      amount = Math.min(v, eligible)
    }
    if (amount <= 0) continue

    candidates.push({
      discount: result.discount,
      amount,
      eligibleProductIds,
      tiers,
      bogoConfig,
    })
  }

  if (candidates.length === 0) {
    // Nothing qualifies — clear a stale automatic if there is one.
    if (current && current.is_automatic) {
      checkout.discount = null
      await recalculateAndStore(checkout)
    }
    return checkout
  }

  // Highest amount wins; findActiveAutomaticDiscounts already ordered
  // DESC by created_at so equal-amount ties pick the newest.
  candidates.sort((a, b) => b.amount - a.amount)
  const winner = candidates[0]

  checkout.discount = {
    code: winner.discount.code, // null is fine — automatic without a code
    discount_id: winner.discount.id,
    type: winner.discount.type,
    value: winner.discount.value,
    value_type: winner.discount.value_type,
    amount: '0.00',
    eligible_product_ids: winner.eligibleProductIds,
    is_automatic: true,
    tiers: winner.tiers.length > 0 ? winner.tiers : null,
    bogo_config: winner.bogoConfig,
  }
  await recalculateAndStore(checkout)
  return checkout
}

// ---------------------------------------------------------------------------
// Internal: recalc + persist
// ---------------------------------------------------------------------------

/**
 * Recalculate totals + persist the checkout in one go.
 *
 * We duplicate the formulas from checkout/service.ts on purpose:
 * importing `recalculateTotals` at the top would form a module cycle
 * (checkout re-exports discounts, discounts imports checkout). Both
 * modules are small and the math is a 10-line subtotal→discount→total
 * chain — the DRY hit is worth the clean acyclic graph.
 *
 * If checkout/service.ts ever changes its tax/shipping math, keep this
 * in lockstep. The co-located unit test in `service.test.ts` pins the
 * numeric expectations so drift fails CI.
 */
async function recalculateAndStore(checkout: CheckoutSession): Promise<void> {
  let subtotal = 0
  for (const li of checkout.line_items) {
    subtotal += parseFloat(li.price) * li.quantity
  }
  checkout.subtotal_price = subtotal.toFixed(2)

  let discountAmount = 0
  if (checkout.discount) {
    const v = parseFloat(checkout.discount.value)

    // Phase 5 PR2 — discounts scoped to specific products/collections
    // only apply to matching line items. `eligible_product_ids = null`
    // means "applies to all" (back-compat with the old pre-scope shape).
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

    // Phase 5 PR5 — BOGO allocator takes precedence when the discount
    // type is 'bogo' and a stamped config is present. Uses the same
    // `eligibleLines` slice as above so scope + BOGO compose cleanly.
    if (checkout.discount.type === 'bogo' && checkout.discount.bogo_config) {
      const cfg = checkout.discount.bogo_config
      discountAmount = computeBogoDiscount(
        {
          buy_quantity: cfg.buy_quantity,
          get_quantity: cfg.get_quantity,
          get_discount_percentage: cfg.get_discount_percentage,
        },
        eligibleLines.map((li) => ({
          product_id: li.product_id,
          price: li.price,
          quantity: li.quantity,
        })),
      )
    } else if (checkout.discount.value_type === 'percentage') {
      // Phase 5 PR4 — tiered percentage stamped on the checkout
      // overrides the flat `value`. Walk the sorted tiers and pick
      // the highest threshold <= eligibleSubtotal. No tier qualifies
      // → zero discount (do NOT fall through to flat value).
      const tiers = checkout.discount.tiers
      if (Array.isArray(tiers) && tiers.length > 0) {
        let pct = 0
        for (const t of tiers) {
          if (t.threshold <= eligibleSubtotal) pct = t.percentage
          else break
        }
        discountAmount = eligibleSubtotal * (pct / 100)
      } else {
        discountAmount = eligibleSubtotal * (v / 100)
      }
    } else {
      // fixed_amount — clamp to eligible subtotal, not the full cart.
      discountAmount = Math.min(v, eligibleSubtotal)
    }
    checkout.discount.amount = discountAmount.toFixed(2)
  }
  checkout.total_discounts = discountAmount.toFixed(2)

  const shipping = parseFloat(checkout.total_shipping ?? '0')
  const tax = parseFloat(checkout.total_tax ?? '0')
  const total = Math.max(0, subtotal - discountAmount + shipping + tax)
  checkout.total_price = total.toFixed(2)
  checkout.updated_at = new Date().toISOString()

  await storeCheckoutForDiscount(checkout)
}

// ---------------------------------------------------------------------------
// Phase 5 PR5 — discount analytics aggregate
// ---------------------------------------------------------------------------

/**
 * Per-discount redemption snapshot. Driven off `orders.discount_id` +
 * `orders.total_discounts` — no separate redemption table is needed
 * because the PR1 migration already FK's `orders.discount_id` → `discounts.id`
 * and stores the amount discounted on the order row.
 */
export interface DiscountAnalytics {
  discount_id: string
  redemption_count: number
  total_discount_amount: string     // numeric string (matches orders.total_discounts)
  first_redeemed_at: string | null  // ISO; null when never redeemed
  last_redeemed_at: string | null
}

/**
 * Aggregate redemptions for a single discount. Cancelled orders are
 * EXCLUDED — a cancelled order shouldn't count toward the merchant's
 * promotion performance dashboard.
 *
 * Returns zeros (never null) so admin UIs can render "0 redemptions"
 * cleanly without null-checks.
 */
export async function getDiscountAnalytics(
  db: Kysely<Database>,
  shopId: string,
  discountId: string,
): Promise<DiscountAnalytics> {
  const row = await db
    .selectFrom('orders')
    .select((eb) => [
      eb.fn.countAll<number>().as('count'),
      eb.fn.sum<string>('total_discounts').as('total'),
      eb.fn.min('created_at').as('first_at'),
      eb.fn.max('created_at').as('last_at'),
    ])
    .where('shop_id', '=', shopId)
    .where('discount_id', '=', discountId)
    .where('cancelled_at', 'is', null)
    .executeTakeFirst()

  return {
    discount_id: discountId,
    redemption_count: Number(row?.count ?? 0),
    total_discount_amount: row?.total ? String(row.total) : '0',
    first_redeemed_at:
      row?.first_at != null ? new Date(row.first_at as any).toISOString() : null,
    last_redeemed_at:
      row?.last_at != null ? new Date(row.last_at as any).toISOString() : null,
  }
}

/**
 * Batch variant — one query for many discounts. Falls back to a plain
 * `IN` list (small cardinality expected; merchants have dozens, not
 * thousands, of discounts). Cancelled orders are still excluded.
 */
export async function getDiscountAnalyticsBatch(
  db: Kysely<Database>,
  shopId: string,
  discountIds: string[],
): Promise<DiscountAnalytics[]> {
  if (discountIds.length === 0) return []
  const rows = await db
    .selectFrom('orders')
    .select((eb) => [
      'discount_id',
      eb.fn.countAll<number>().as('count'),
      eb.fn.sum<string>('total_discounts').as('total'),
      eb.fn.min('created_at').as('first_at'),
      eb.fn.max('created_at').as('last_at'),
    ])
    .where('shop_id', '=', shopId)
    .where('discount_id', 'in', discountIds)
    .where('cancelled_at', 'is', null)
    .groupBy('discount_id')
    .execute()

  const byId = new Map<string, any>()
  for (const r of rows) byId.set(r.discount_id as string, r)

  return discountIds.map((id) => {
    const r = byId.get(id)
    return {
      discount_id: id,
      redemption_count: Number(r?.count ?? 0),
      total_discount_amount: r?.total ? String(r.total) : '0',
      first_redeemed_at:
        r?.first_at != null ? new Date(r.first_at).toISOString() : null,
      last_redeemed_at:
        r?.last_at != null ? new Date(r.last_at).toISOString() : null,
    }
  })
}
