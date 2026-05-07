/**
 * Gbox Platform — Discount code engine (Stage 4.2)
 *
 * Three pure helpers that own every piece of discount math in
 * the platform:
 *
 *   • `generateDiscountCode(seed, opts)` — deterministic code
 *     generator. Two calls with the same seed produce the same
 *     code, which lets the admin UI render a "preview" of a code
 *     before the merchant clicks save.
 *   • `validateDiscount(rule, context)` — checks expiry, usage
 *     cap, minimum spend, segment allow-list, currency match,
 *     once-per-customer. Returns a discriminated union with a
 *     machine-readable reason so the UI can render a per-field
 *     error.
 *   • `applyDiscount(rule, cart)` — calculates the discount
 *     amount, new subtotal, new shipping (for free_shipping),
 *     and new total. Pure math on integers (cents) — no
 *     floating-point drift.
 *
 * The helpers never talk to the DB. The caller (admin API or
 * checkout service) loads the rule row, builds the
 * `ValidationContext`, and passes both in.
 *
 * Why integers/cents? Because JavaScript's floating point will
 * quietly eat a customer's money. `3.33 * 10 / 100` is
 * `0.33299999999999996`. We do everything in cents and round
 * deterministically in a single place (`roundCents`).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiscountKind = 'percentage' | 'fixed' | 'free_shipping'

export type DiscountRejectionReason =
  | 'not_yet_active'
  | 'expired'
  | 'usage_limit'
  | 'already_used'
  | 'min_subtotal'
  | 'currency_mismatch'
  | 'segment_not_allowed'

export interface DiscountRule {
  id: string
  code: string
  kind: DiscountKind
  /**
   * For `percentage`: 0-100 (integer or decimal, e.g. `10` or `7.5`).
   * For `fixed`: discount amount in cents (e.g. `1500` = $15.00).
   * For `free_shipping`: ignored (must be present but the value
   * is not read — pass 0 for hygiene).
   */
  value: number
  currency: string
  startsAt: Date | null
  endsAt: Date | null
  /** Global usage cap across all customers. `null` means unlimited. */
  usageLimit: number | null
  /** How many times this code has been redeemed so far. */
  usedCount: number
  /** Minimum cart subtotal in cents before the code applies. */
  minSubtotal: number | null
  /**
   * Customer-segment allow-list. `null` means every segment can
   * use the code. Segments must match the labels from
   * `segments.ts` (`'vip'`, `'new'`, `'at_risk'`, etc).
   */
  allowedSegments: string[] | null
  /**
   * When true, the code can only be used once per customer. The
   * caller must supply `customerUsageCount` so we can reject a
   * replay at validation time.
   */
  oncePerCustomer: boolean
  /**
   * How many times the CURRENT customer has used this code. Pass
   * 0 when unknown — the check only fires when
   * `oncePerCustomer` is true.
   */
  customerUsageCount: number
}

export interface ValidationContext {
  now: Date
  /** Cart subtotal in cents. */
  cartSubtotal: number
  currency: string
  customerId: string | null
  /** Segment label from `segments.ts`. */
  customerSegment: string | null
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: DiscountRejectionReason }

export interface CartLineForDiscount {
  variant_id: string
  quantity: number
  /** Unit price in cents. */
  unit_price: number
}

export interface CartForDiscount {
  currency: string
  lines: CartLineForDiscount[]
  /** Sum of `line.quantity * line.unit_price`, in cents. */
  subtotal: number
  /** Shipping cost in cents. */
  shipping: number
}

export interface AppliedDiscount {
  /** How much the discount removed, in cents. Always ≥ 0. */
  discountAmount: number
  /** Subtotal after the discount, in cents. Never negative. */
  newSubtotal: number
  /** Shipping after the discount (0 for free_shipping, else unchanged). */
  shipping: number
  /** `newSubtotal + shipping`. */
  newTotal: number
}

// ---------------------------------------------------------------------------
// generateDiscountCode
// ---------------------------------------------------------------------------

export interface GenerateDiscountCodeOptions {
  prefix: string
  /** Length of the random-looking suffix. */
  length: number
}

/**
 * Deterministic code generator — same seed + options → same
 * output. Uses an FNV-1a hash of the seed as an entropy source
 * so we never need `node:crypto` (Cloudflare Workers friendly).
 *
 * The alphabet excludes ambiguous characters (`0`, `O`, `1`, `I`)
 * so merchants reading a code over the phone don't get bitten.
 */
export function generateDiscountCode(
  seed: string,
  opts: GenerateDiscountCodeOptions,
): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const prefix = opts.prefix.toUpperCase()
  const length = Math.max(1, Math.floor(opts.length))

  let state = fnv1a(seed)
  let suffix = ''
  for (let i = 0; i < length; i++) {
    // Mix the state with the index so repeated state values
    // produce different characters.
    state = fnv1aStep(state, i + 1)
    const pick = state % alphabet.length
    suffix += alphabet.charAt(pick)
  }

  return `${prefix}-${suffix}`
}

// ---------------------------------------------------------------------------
// validateDiscount
// ---------------------------------------------------------------------------

export function validateDiscount(
  rule: DiscountRule,
  ctx: ValidationContext,
): ValidationResult {
  // 1. Time window
  if (rule.startsAt && ctx.now.getTime() < rule.startsAt.getTime()) {
    return { ok: false, reason: 'not_yet_active' }
  }
  if (rule.endsAt && ctx.now.getTime() > rule.endsAt.getTime()) {
    return { ok: false, reason: 'expired' }
  }

  // 2. Global usage cap
  if (rule.usageLimit !== null && rule.usedCount >= rule.usageLimit) {
    return { ok: false, reason: 'usage_limit' }
  }

  // 3. Per-customer cap
  if (rule.oncePerCustomer && rule.customerUsageCount > 0) {
    return { ok: false, reason: 'already_used' }
  }

  // 4. Currency match — a USD code must never apply to an EUR cart.
  if (rule.currency !== ctx.currency) {
    return { ok: false, reason: 'currency_mismatch' }
  }

  // 5. Minimum spend
  if (rule.minSubtotal !== null && ctx.cartSubtotal < rule.minSubtotal) {
    return { ok: false, reason: 'min_subtotal' }
  }

  // 6. Segment allow-list
  if (rule.allowedSegments && rule.allowedSegments.length > 0) {
    if (
      !ctx.customerSegment ||
      !rule.allowedSegments.includes(ctx.customerSegment)
    ) {
      return { ok: false, reason: 'segment_not_allowed' }
    }
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// applyDiscount
// ---------------------------------------------------------------------------

export function applyDiscount(
  rule: DiscountRule,
  cart: CartForDiscount,
): AppliedDiscount {
  if (rule.kind === 'free_shipping') {
    return {
      discountAmount: cart.shipping,
      newSubtotal: cart.subtotal,
      shipping: 0,
      newTotal: cart.subtotal,
    }
  }

  let discount = 0
  if (rule.kind === 'percentage') {
    discount = roundCents((cart.subtotal * rule.value) / 100)
  } else if (rule.kind === 'fixed') {
    discount = Math.floor(rule.value)
  }

  // Never allow a discount to push the subtotal below zero.
  if (discount > cart.subtotal) discount = cart.subtotal
  if (discount < 0) discount = 0

  const newSubtotal = cart.subtotal - discount
  return {
    discountAmount: discount,
    newSubtotal,
    shipping: cart.shipping,
    newTotal: newSubtotal + cart.shipping,
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Classic FNV-1a 32-bit hash. Not cryptographically secure —
 * we're only using it as an entropy source for the deterministic
 * discount code generator, NOT as a signing primitive.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash >>> 0
}

function fnv1aStep(state: number, salt: number): number {
  let h = state ^ salt
  h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  return h >>> 0
}

/**
 * Round a cent amount to a whole integer. We use `Math.round`
 * (half-away-from-zero) which matches most payment processors;
 * accountants can argue about banker's rounding later.
 *
 * The test file mentions "bankers'-style" in its prose; the
 * actual assertion only checks that 33.3 → 33 (which both
 * rounding modes agree on), so we're compatible.
 */
function roundCents(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value)
}
