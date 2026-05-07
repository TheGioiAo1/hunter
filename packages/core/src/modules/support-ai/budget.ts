/**
 * Gbox Platform — support-ai monthly budget gate (Phase 12.5 PR4).
 *
 * Spec §10.6.2 defines a hard $200/month cap on Anthropic spend for
 * the support AI surfaces. Hitting the cap grays out every AI button
 * across the four surfaces (suggest, summarize, categorize, sentiment)
 * until the next UTC month. An 80% soft-warn threshold fires a pager
 * alert to Thai so we're not surprised by the shutoff.
 *
 * Everything here is pure — no DB, no SDK, no clock read. The caller
 * supplies:
 *   - current month's cents burned so far (from support_ai_usage
 *     roll-up, see usage-tracker.ts)
 *   - the configured cap (default $200 = 20_000 cents)
 *
 * and the module tells them what state the budget is in. This makes
 * the gate trivially mockable from unit tests + lets the god-admin
 * dashboard display the same verdict the runtime uses.
 *
 * Why not wire in a DB read here?
 * -------------------------------
 *   The same cap logic is called from cron (bulk sentiment flag,
 *   every 5 min), from synchronous agent clicks (suggest reply),
 *   and from the god-admin /settings/ai display. Forcing every
 *   caller to bring the rollup keeps the gate cache-friendly — the
 *   cron job reads the rollup once and reuses it for 200 tickets.
 */

/**
 * The configured monthly spend cap in USD cents.
 *
 * Default = $200. Stored in `platform_settings.ai_monthly_budget_cents`.
 * God admin can override via /god-admin/settings/ai; the runtime
 * reads this value through budget-store.ts on every gate check.
 */
export const DEFAULT_BUDGET_CAP_CENTS = 20_000

/**
 * Fraction of the cap at which we consider the budget "warn" state
 * and ping Thai. 0.80 matches spec §10.6.2 and gives us ~$40 of
 * headroom before shutoff in a $200 month.
 */
export const BUDGET_WARN_THRESHOLD = 0.8

/**
 * Three-state budget verdict. `ok` = plenty of runway, `warn` = 80%
 * burned (caller should emit an alert once per month), `exceeded` =
 * at or past cap, AI surfaces MUST be disabled.
 */
export type BudgetState = 'ok' | 'warn' | 'exceeded'

export interface BudgetStatus {
  /** Current classification. */
  readonly state: BudgetState
  /** Cents spent so far in the current month window. */
  readonly spentCents: number
  /** Configured cap in cents for this month. */
  readonly capCents: number
  /** Fraction of cap consumed (0..1+). */
  readonly percentUsed: number
  /** Cents remaining before shutoff. Floors at 0 when exceeded. */
  readonly remainingCents: number
}

/**
 * Classify a spend-so-far against the cap. Pure function; no I/O.
 *
 * Guards:
 *   - `cap <= 0` always returns `exceeded`. Config error — god admin
 *     set cap to 0 or forgot to save. We'd rather turn AI off than
 *     assume "unlimited".
 *   - `spent < 0` is clamped to 0. Negative spend is a DB bug, not
 *     a refund signal.
 */
export function evaluateBudget(
  spentCents: number,
  capCents: number = DEFAULT_BUDGET_CAP_CENTS,
): BudgetStatus {
  const cap = Math.max(0, Math.floor(capCents))
  const spent = Math.max(0, Math.floor(spentCents))

  if (cap <= 0) {
    return {
      state: 'exceeded',
      spentCents: spent,
      capCents: 0,
      percentUsed: 1,
      remainingCents: 0,
    }
  }

  const percent = spent / cap
  const remaining = Math.max(0, cap - spent)

  let state: BudgetState
  if (spent >= cap) {
    state = 'exceeded'
  } else if (percent >= BUDGET_WARN_THRESHOLD) {
    state = 'warn'
  } else {
    state = 'ok'
  }

  return {
    state,
    spentCents: spent,
    capCents: cap,
    percentUsed: percent,
    remainingCents: remaining,
  }
}

/**
 * Convenience: is AI allowed to fire right now? This is the hot
 * path — `suggestReply`, `summarizeThread`, etc. call it before
 * every invocation. Returns false in both `exceeded` and the
 * "apiKey missing" cases (the latter handled in null-key-fallback).
 *
 * Pure-compute version; consumers that need the full status
 * (for warning display etc.) should call evaluateBudget() directly.
 */
export function isWithinBudget(
  spentCents: number,
  capCents: number = DEFAULT_BUDGET_CAP_CENTS,
): boolean {
  return evaluateBudget(spentCents, capCents).state !== 'exceeded'
}

/**
 * UTC month key (YYYY-MM) used as the rollup bucket in support_ai_usage.
 * Exported so usage-tracker.ts and the smoke test agree on the
 * partition scheme.
 *
 * Why UTC and not platform timezone?
 *   - Anthropic bills in UTC. Matching their clock means our "month"
 *     rolls over at the same moment they do.
 *   - Daylight saving doesn't corrupt window edges.
 *   - A server timezone change doesn't silently shift the bucket.
 */
export function monthKey(date: Date = new Date()): string {
  const yyyy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${yyyy}-${mm}`
}
