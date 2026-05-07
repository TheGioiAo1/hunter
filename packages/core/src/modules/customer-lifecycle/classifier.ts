/**
 * Customer lifecycle classifier.
 *
 * Phase 4 / PR3. A **pure** function that maps a customer snapshot onto
 * one of four lifecycle stages:
 *
 *   - `new`       — no orders yet, OR exactly one recent order. The
 *                   welcome-flow cohort. Default value on every new
 *                   customer row (migration 056).
 *   - `returning` — ≥ 2 orders AND last order within the at-risk
 *                   window (< 60 days ago). The repeat-buyer cohort.
 *   - `at_risk`   — last order 60–179 days ago. The win-back cohort.
 *   - `churned`   — last order ≥ 180 days ago. Stop spending on
 *                   campaigns here.
 *
 * This is deliberately simpler than `marketing/segments.ts` (which
 * emits six segments including `prospect` / `vip`). Segments are a
 * runtime classification used by the email engine; `lifecycle_stage`
 * is a persisted denormalisation on `customers` that powers list-page
 * facets and the segment-builder "is at risk" filter. We only need
 * four buckets for that.
 *
 * Thresholds are **imported** from marketing/segments.ts so both
 * systems flip customers in/out of at-risk on the same day — if the
 * marketing team widens the window, the lifecycle column follows.
 *
 * The function is intentionally allocation-free and branch-bounded
 * so the daily cron can run it a million times per shop without a
 * GC pause. No DB access, no logging, no external imports beyond the
 * shared thresholds.
 */

import {
  AT_RISK_DAYS_NO_ORDER,
  INACTIVE_DAYS_NO_ORDER,
} from '../marketing/segments.js'

// ---------------------------------------------------------------------------
// Public types + constants
// ---------------------------------------------------------------------------

/**
 * Days without an order before `at_risk` kicks in. Re-exported from
 * marketing/segments.ts so callers outside this module can read the
 * threshold without a second import.
 */
export const LIFECYCLE_AT_RISK_DAYS = AT_RISK_DAYS_NO_ORDER

/**
 * Days without an order before `churned` kicks in. Aliased from
 * marketing's "inactive" constant — same calendar threshold, seller-
 * friendly name.
 */
export const LIFECYCLE_CHURNED_DAYS = INACTIVE_DAYS_NO_ORDER

/** The four persisted lifecycle stages. */
export type LifecycleStage = 'new' | 'returning' | 'at_risk' | 'churned'

/**
 * Frozen enum for table-driven validation (segment builder, CHECK
 * constraints in future migrations). `as const` so TS narrows to
 * the literal union.
 */
export const LIFECYCLE_STAGES = ['new', 'returning', 'at_risk', 'churned'] as const

/**
 * Input snapshot — just enough to compute the stage. Accepts both
 * `Date` and ISO string for `last_order_at` because the DB returns
 * the latter via Kysely but the cron feeds us `Date` in tests.
 */
export interface LifecycleSnapshot {
  orders_count: number
  last_order_at: Date | string | null
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

function toDate(value: Date | string | null): Date | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

function daysBetween(past: Date, now: Date): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000
  return Math.floor((now.getTime() - past.getTime()) / MS_PER_DAY)
}

/**
 * Classify a customer snapshot into its lifecycle stage.
 *
 * Evaluation order matters — we check churned *before* at_risk because
 * ≥ 180 days obviously also satisfies ≥ 60 days. The order goes:
 *
 *   1. No orders / no last_order_at             → `new`
 *   2. last order ≥ 180 days ago                → `churned`
 *   3. last order ≥ 60 days ago (but < 180)     → `at_risk`
 *   4. orders_count ≥ 2 (and < 60 days ago)     → `returning`
 *   5. else (1 order within 60 days)            → `new`
 *
 * `now` is injected for deterministic tests — defaults to the wall
 * clock so production callers don't have to think about it.
 */
export function classifyLifecycle(
  snapshot: LifecycleSnapshot,
  now: Date = new Date(),
): LifecycleStage {
  const ordersCount = Number.isFinite(snapshot.orders_count) ? snapshot.orders_count : 0
  const lastOrderAt = toDate(snapshot.last_order_at)

  // 1. No orders → `new`. Also catches corrupt state where
  // orders_count > 0 but last_order_at is null (shouldn't happen
  // after PR3 but we fail-safe to new rather than mis-flag as churned).
  if (ordersCount <= 0 || lastOrderAt === null) return 'new'

  const daysSinceLastOrder = daysBetween(lastOrderAt, now)

  // 2. Churned check first — threshold is larger, so it wins
  // whenever both conditions fire.
  if (daysSinceLastOrder >= LIFECYCLE_CHURNED_DAYS) return 'churned'

  // 3. At-risk — strictly between the two thresholds.
  if (daysSinceLastOrder >= LIFECYCLE_AT_RISK_DAYS) return 'at_risk'

  // 4. Returning — ≥ 2 orders AND within the recency window.
  if (ordersCount >= 2) return 'returning'

  // 5. Fall-through — 1 order within the at-risk window. Still `new`
  // (welcome-flow cohort) until the 2nd order flips to `returning`.
  return 'new'
}

/**
 * Type guard for the persisted column value — use this on anything
 * read back from the DB or a request body before trusting it as a
 * LifecycleStage.
 */
export function isLifecycleStage(value: unknown): value is LifecycleStage {
  return typeof value === 'string' && (LIFECYCLE_STAGES as readonly string[]).includes(value)
}
