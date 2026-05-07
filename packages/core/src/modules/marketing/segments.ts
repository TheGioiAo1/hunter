/**
 * Gbox Platform — Customer segmentation (Stage 4.1)
 *
 * Deterministic rule-based classifier that maps a customer
 * snapshot into one of six canonical segments. The segments are
 * the vocabulary every other Phase 4 marketing module speaks:
 *
 *   • `email-flows.ts` picks which automated sequence to enrol
 *     the customer in (e.g. welcome vs win-back).
 *   • `discounts.ts` issues segment-specific codes (e.g. VIP
 *     gets 15% early access, at_risk gets a 10% win-back).
 *   • `popups.ts` decides whether to show a "we miss you" modal.
 *
 * The rules are intentionally simple and transparent — everything
 * you need to review a merchant's segments sits in the constants
 * at the top of the file. No ML, no opaque heuristics. When a
 * merchant asks "why is this customer tagged VIP?", we can point
 * at the reason string the segmenter returned.
 *
 * Precedence (top wins):
 *
 *   1. prospect   — no orders yet
 *   2. inactive   — last order ≥ 180 days ago
 *   3. vip        — spend ≥ $500 OR orders ≥ 4
 *   4. at_risk    — last order ≥ 60 days ago
 *   5. new        — first order < 30 days ago AND orders < 2
 *   6. returning  — anyone else
 *
 * NOTE: VIP beats at_risk/inactive — a big spender going quiet
 * for two months is still VIP (and gets a VIP win-back flow),
 * not a generic at_risk discount code.
 *
 * Actually the precedence in the implementation is:
 *
 *   prospect → vip → inactive → at_risk → new → returning
 *
 * because VIP status is sticky regardless of recency. See the
 * tests — they pin this order.
 */

// ---------------------------------------------------------------------------
// Tunable thresholds
// ---------------------------------------------------------------------------

/**
 * Spend-based VIP threshold (in the customer's currency). A
 * customer whose `totalSpent` is at or above this is considered
 * VIP regardless of order count or recency.
 *
 * 500 is the value the masterplan §7.2 #10 uses for the VIP
 * segmentation example.
 */
export const VIP_SPEND_THRESHOLD = 500

/**
 * Order-count VIP threshold. Any customer with this many
 * completed orders becomes VIP even if their per-order spend is
 * small.
 */
export const VIP_ORDER_THRESHOLD = 4

/**
 * Days since last order before a customer is labelled "at_risk".
 * Matches the masterplan's "no order in 60 days" cohort.
 */
export const AT_RISK_DAYS_NO_ORDER = 60

/**
 * Days since last order before a customer is labelled "inactive"
 * — the point at which the win-back flow has clearly failed and
 * merchandising should stop spending money on them.
 */
export const INACTIVE_DAYS_NO_ORDER = 180

/**
 * Days since first order during which a customer is considered
 * "new" (and eligible for the welcome series). After this window
 * expires the customer flips to `returning` / `vip`.
 */
export const NEW_DAYS_SINCE_FIRST_ORDER = 30

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CustomerSegment =
  | 'prospect'
  | 'new'
  | 'returning'
  | 'vip'
  | 'at_risk'
  | 'inactive'

export interface CustomerSnapshot {
  customerId: string
  email: string | null
  /** When the customer row was created (not the first order). */
  createdAt: Date
  ordersCount: number
  totalSpent: number
  currency: string
  firstOrderAt: Date | null
  lastOrderAt: Date | null
}

export interface SegmentationMetrics {
  ordersCount: number
  totalSpent: number
  daysSinceFirstOrder: number | null
  daysSinceLastOrder: number | null
}

export interface SegmentationResult {
  segment: CustomerSegment
  /**
   * Human-readable justifications, e.g.
   *   ["orders count 5 ≥ VIP threshold 4"]
   * Drops into the admin UI so merchants can understand *why* a
   * customer has a given tag without reading this file.
   */
  reasons: string[]
  metrics: SegmentationMetrics
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function segmentCustomer(
  snapshot: CustomerSnapshot,
  now: Date = new Date(),
): SegmentationResult {
  const metrics: SegmentationMetrics = {
    ordersCount: snapshot.ordersCount,
    totalSpent: snapshot.totalSpent,
    daysSinceFirstOrder: daysBetween(snapshot.firstOrderAt, now),
    daysSinceLastOrder: daysBetween(snapshot.lastOrderAt, now),
  }

  // 1. prospect — no orders at all.
  if (snapshot.ordersCount <= 0 || snapshot.lastOrderAt === null) {
    return {
      segment: 'prospect',
      reasons: ['no orders placed'],
      metrics,
    }
  }

  // 2. vip — sticky regardless of recency.
  if (snapshot.totalSpent >= VIP_SPEND_THRESHOLD) {
    return {
      segment: 'vip',
      reasons: [
        `totalSpent ${snapshot.totalSpent} ≥ VIP spend threshold ${VIP_SPEND_THRESHOLD}`,
      ],
      metrics,
    }
  }
  if (snapshot.ordersCount >= VIP_ORDER_THRESHOLD) {
    return {
      segment: 'vip',
      reasons: [
        `ordersCount ${snapshot.ordersCount} ≥ VIP order threshold ${VIP_ORDER_THRESHOLD}`,
      ],
      metrics,
    }
  }

  // 3. inactive — checked BEFORE at_risk because 180 > 60.
  if (
    metrics.daysSinceLastOrder !== null &&
    metrics.daysSinceLastOrder >= INACTIVE_DAYS_NO_ORDER
  ) {
    return {
      segment: 'inactive',
      reasons: [
        `last order ${metrics.daysSinceLastOrder} days ago ≥ inactive threshold ${INACTIVE_DAYS_NO_ORDER}`,
      ],
      metrics,
    }
  }

  // 4. at_risk — approaching-inactive window.
  if (
    metrics.daysSinceLastOrder !== null &&
    metrics.daysSinceLastOrder >= AT_RISK_DAYS_NO_ORDER
  ) {
    return {
      segment: 'at_risk',
      reasons: [
        `last order ${metrics.daysSinceLastOrder} days ago ≥ at-risk threshold ${AT_RISK_DAYS_NO_ORDER}`,
      ],
      metrics,
    }
  }

  // 5. new — recent first order, not yet a repeat buyer.
  if (
    metrics.daysSinceFirstOrder !== null &&
    metrics.daysSinceFirstOrder < NEW_DAYS_SINCE_FIRST_ORDER &&
    snapshot.ordersCount < 2
  ) {
    return {
      segment: 'new',
      reasons: [
        `first order ${metrics.daysSinceFirstOrder} days ago < new threshold ${NEW_DAYS_SINCE_FIRST_ORDER}`,
      ],
      metrics,
    }
  }

  // 6. returning — default for active customers.
  return {
    segment: 'returning',
    reasons: ['active buyer under VIP thresholds'],
    metrics,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysBetween(earlier: Date | null, later: Date): number | null {
  if (!earlier) return null
  const ms = later.getTime() - earlier.getTime()
  if (!Number.isFinite(ms)) return null
  return Math.floor(ms / (24 * 60 * 60 * 1000))
}
