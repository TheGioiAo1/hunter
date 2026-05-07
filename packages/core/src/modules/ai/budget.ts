/**
 * Gbox Platform — AI budget gate
 *
 * Enforces per-shop spending caps so a runaway prompt loop can't
 * drain the operator's wallet. The router calls `canSpend()` before
 * every attempt with an `estimatedCents` forecast; this module
 * compares that against the shop's configured cap minus whatever
 * they've already spent in the window.
 *
 * Design
 * ------
 *
 *   - Caps are per-shop + per-window. `daily` and `monthly` are the
 *     two shipped windows. Exhausting either raises the gate.
 *
 *   - The forecast is advisory. We subtract it from the remaining
 *     balance and say "do you have room?". A cost record that ends
 *     up larger than the forecast is still recorded — no retroactive
 *     refusal. The forecast just prevents wildly optimistic
 *     pre-authorisations.
 *
 *   - Reads go through `CostRollupReader` (implemented by the
 *     in-memory cost store and, later, the DB-backed one). No DB
 *     coupling here.
 */

import type { BudgetGate } from './router.js'
import type { UsageRollup } from './cost-tracker.js'
import { startOfUtcDay, startOfUtcMonth } from './cost-tracker.js'

// ---------------------------------------------------------------------------
// Collaborators
// ---------------------------------------------------------------------------

export interface CostRollupReader {
  rollup(shopId: string, from: string, to: string): Promise<UsageRollup>
}

export interface BudgetConfigResolver {
  /**
   * Return the daily/monthly caps for a shop in USD cents. `null`
   * means "no cap" — the gate never refuses on that window.
   */
  resolve(shopId: string): Promise<ShopBudgetConfig>
}

export interface ShopBudgetConfig {
  readonly dailyCapCents: number | null
  readonly monthlyCapCents: number | null
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface WindowBudgetGateDeps {
  readonly reader: CostRollupReader
  readonly config: BudgetConfigResolver
  /** Clock injection for tests. Defaults to real time. */
  readonly now?: () => Date
}

/**
 * Budget gate that checks both daily and monthly windows. If either
 * window is capped and would be exceeded by the forecast, it refuses.
 */
export class WindowBudgetGate implements BudgetGate {
  constructor(private readonly deps: WindowBudgetGateDeps) {}

  async canSpend(shopId: string, estimatedCents: number): Promise<boolean> {
    const config = await this.deps.config.resolve(shopId)
    const now = (this.deps.now ?? (() => new Date()))()

    if (config.dailyCapCents !== null) {
      const from = startOfUtcDay(now)
      const to = now.toISOString()
      const rollup = await this.deps.reader.rollup(shopId, from, to)
      if (rollup.totalCostCents + estimatedCents > config.dailyCapCents) return false
    }

    if (config.monthlyCapCents !== null) {
      const from = startOfUtcMonth(now)
      const to = now.toISOString()
      const rollup = await this.deps.reader.rollup(shopId, from, to)
      if (rollup.totalCostCents + estimatedCents > config.monthlyCapCents) return false
    }

    return true
  }
}

// ---------------------------------------------------------------------------
// Static config resolver (tests + simple shops)
// ---------------------------------------------------------------------------

/**
 * Returns the same caps for every shop. Useful for tests and for
 * single-tenant installations that don't differentiate per shop.
 */
export class StaticBudgetConfig implements BudgetConfigResolver {
  constructor(private readonly caps: ShopBudgetConfig) {}

  async resolve(): Promise<ShopBudgetConfig> {
    return this.caps
  }
}

/**
 * Returns per-shop caps from a Map. Missing shops fall back to
 * `defaults`, or uncapped if no defaults.
 */
export class MapBudgetConfig implements BudgetConfigResolver {
  constructor(
    private readonly byShop: Map<string, ShopBudgetConfig>,
    private readonly defaults: ShopBudgetConfig = {
      dailyCapCents: null,
      monthlyCapCents: null,
    },
  ) {}

  async resolve(shopId: string): Promise<ShopBudgetConfig> {
    return this.byShop.get(shopId) ?? this.defaults
  }
}
