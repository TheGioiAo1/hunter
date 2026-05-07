/**
 * Gbox Platform — AI cost tracker
 *
 * Two responsibilities:
 *
 *   1. Collect `CostRecord`s emitted by the router after every
 *      successful call.
 *   2. Answer roll-up questions ("how much has shop X spent this
 *      month?") for the budget gate and for admin dashboards.
 *
 * This module ships an in-memory implementation only. A Postgres
 * adapter lives in `cost-tracker-db.ts` (added later in Sprint B when
 * we wire clone-pro to actually consume it). The in-memory version is
 * useful for tests and for shops that opted out of persistence.
 *
 * All time calculations are UTC — the router writes `occurredAt` as
 * ISO strings in UTC, and roll-ups compare ISO prefixes (`2026-04-16`)
 * so no timezone math happens here.
 */

import type { AIProviderId, CostRecord } from './types.js'
import type { CostRecorder } from './router.js'

// ---------------------------------------------------------------------------
// Query types
// ---------------------------------------------------------------------------

export interface UsageRollup {
  readonly shopId: string
  readonly from: string // ISO timestamp (inclusive)
  readonly to: string // ISO timestamp (exclusive)
  readonly totalCostCents: number
  readonly totalTokens: number
  readonly callCount: number
  readonly byProvider: Readonly<Record<AIProviderId, { cents: number; tokens: number; calls: number }>>
  readonly byPurpose: Readonly<Record<string, { cents: number; tokens: number; calls: number }>>
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

/**
 * Keeps every record in RAM. Great for tests; fine for a single-node
 * server with modest traffic; NOT durable across restarts.
 *
 * The store is shop-scoped internally (Map<shopId, records[]>) so
 * lookups are O(records-for-this-shop) rather than O(all-records).
 */
export class InMemoryCostStore implements CostRecorder {
  private readonly byShop = new Map<string, CostRecord[]>()

  async record(entry: CostRecord): Promise<void> {
    const existing = this.byShop.get(entry.shopId)
    if (existing) {
      existing.push(entry)
    } else {
      this.byShop.set(entry.shopId, [entry])
    }
  }

  /**
   * Roll up every record for `shopId` whose `occurredAt` falls in
   * the half-open window `[from, to)`. `from` and `to` are ISO
   * strings; lexicographic comparison works because both sides are
   * UTC timestamps of the same shape.
   */
  async rollup(shopId: string, from: string, to: string): Promise<UsageRollup> {
    const records = this.byShop.get(shopId) ?? []
    const empty = emptyRollup(shopId, from, to)

    let totalCostCents = 0
    let totalTokens = 0
    let callCount = 0
    const byProvider: Record<string, { cents: number; tokens: number; calls: number }> = {}
    const byPurpose: Record<string, { cents: number; tokens: number; calls: number }> = {}

    for (const r of records) {
      if (r.occurredAt < from || r.occurredAt >= to) continue
      totalCostCents += r.costCents
      totalTokens += r.usage.totalTokens
      callCount += 1
      bump(byProvider, r.provider, r.costCents, r.usage.totalTokens)
      bump(byPurpose, r.purpose, r.costCents, r.usage.totalTokens)
    }

    return {
      ...empty,
      totalCostCents,
      totalTokens,
      callCount,
      byProvider: byProvider as UsageRollup['byProvider'],
      byPurpose,
    }
  }

  /** Remove everything. Tests only. */
  reset(): void {
    this.byShop.clear()
  }

  /** Raw access. Tests only. */
  all(shopId: string): readonly CostRecord[] {
    return this.byShop.get(shopId) ?? []
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bump(
  bucket: Record<string, { cents: number; tokens: number; calls: number }>,
  key: string,
  cents: number,
  tokens: number,
): void {
  const entry = bucket[key]
  if (entry) {
    entry.cents += cents
    entry.tokens += tokens
    entry.calls += 1
  } else {
    bucket[key] = { cents, tokens, calls: 1 }
  }
}

function emptyRollup(shopId: string, from: string, to: string): UsageRollup {
  return {
    shopId,
    from,
    to,
    totalCostCents: 0,
    totalTokens: 0,
    callCount: 0,
    byProvider: {} as UsageRollup['byProvider'],
    byPurpose: {},
  }
}

// ---------------------------------------------------------------------------
// Time-window helpers
// ---------------------------------------------------------------------------

/**
 * ISO timestamp for "start of current UTC day" relative to `now`.
 * Used by callers who want today's spend.
 */
export function startOfUtcDay(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  return d.toISOString()
}

/**
 * ISO timestamp for "start of current UTC month" relative to `now`.
 */
export function startOfUtcMonth(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  return d.toISOString()
}

/** ISO timestamp for "right now". Convenience so tests can inject clocks. */
export function isoNow(now: Date): string {
  return now.toISOString()
}
