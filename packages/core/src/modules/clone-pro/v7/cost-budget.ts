/**
 * Clone Pro v7 — per-job AI cost budget guardrail.
 *
 * Sprint 5 Task 5.7. Caps per-job spend at `MAX_CLONE_PRO_V7_USD`
 * (default 5.00 USD). Stage 14 (vision-extract) + Stage 16
 * (visual-verify retry) accumulate cost via `addCost`; if the running
 * total exceeds the cap, `addCost` throws `CostBudgetExceededError`
 * which the orchestrator catches at the seam and the worker scrubs
 * via `safeMessage()` before any seller-facing channel sees it.
 *
 * Runaway-protection model:
 *   • Pre-call check at every Stage 14/16 entry — bail BEFORE making
 *     the expensive Anthropic API call rather than after.
 *   • Post-call accounting — `addCost(stage, usd)` is invoked with
 *     the actual usage cost reported by the SDK so the audit ledger
 *     reflects truth (the orchestrator passes the cost into
 *     clone_crawl_runs).
 *
 * Iron Rule 5: every error path goes through `CostBudgetExceededError.safeMessage`,
 * which returns the generic "Please contact Gbox support" string. The
 * `.diagnostic` field is for server logs only.
 */

import { SAFE_MESSAGE_EN } from '../../support/safe-message.js'

const DEFAULT_MAX_USD = 5

/**
 * Resolve the per-job AI budget from `MAX_CLONE_PRO_V7_USD`. Falls
 * back to 5.00 on missing / non-numeric / negative values.
 */
export function resolveMaxBudgetUsd(): number {
  const raw = process.env.MAX_CLONE_PRO_V7_USD
  if (!raw) return DEFAULT_MAX_USD
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_USD
  return parsed
}

export interface CostBudgetOpts {
  maxUsd?: number
}

export interface CostBudgetExceededInfo {
  spentUsd: number
  limitUsd: number
  /** Identifier for the stage that triggered the breach (server-only). */
  lastStage: string
}

/**
 * Thrown by `CloneProCostTracker.addCost()` when the per-job spend
 * exceeds the cap. Exposes a seller-safe `.safeMessage` (used by the
 * worker) and a `.diagnostic` (used by `console.warn` / audit logs).
 */
export class CostBudgetExceededError extends Error {
  readonly spentUsd: number
  readonly limitUsd: number
  readonly lastStage: string
  readonly safeMessage: string
  readonly diagnostic: string

  constructor(info: CostBudgetExceededInfo) {
    const safe = SAFE_MESSAGE_EN
    const diagnostic = `cost budget exceeded: spent=${info.spentUsd.toFixed(2)} USD limit=${info.limitUsd} lastStage=${info.lastStage}`
    super(diagnostic)
    this.name = 'CostBudgetExceededError'
    this.spentUsd = info.spentUsd
    this.limitUsd = info.limitUsd
    this.lastStage = info.lastStage
    this.safeMessage = safe
    this.diagnostic = diagnostic
  }
}

export interface CostBreakdown {
  /** USD spent in this stage. Sum of all addCost(stageId, …) calls. */
  [stageId: string]: number
}

/**
 * Per-model Claude pricing (USD per million tokens). Source: Anthropic
 * pricing page as of Sprint 5 lock. New models can be added here without
 * touching call sites — `addClaude(model, ...)` looks up by full model
 * id and falls back to Sonnet 4.5 pricing for unknown ids (cheaper than
 * leaking a NaN through to seller-facing surfaces).
 *
 * The lookup table is exported so god-admin tooling can render the same
 * cost-per-call figures the tracker uses internally; sellers never see
 * these numbers.
 */
export const CLAUDE_MODEL_PRICING: Record<
  string,
  { inputUsdPerMillion: number; outputUsdPerMillion: number }
> = {
  // Claude 4.x family
  'claude-opus-4': { inputUsdPerMillion: 15, outputUsdPerMillion: 75 },
  'claude-opus-4-1': { inputUsdPerMillion: 15, outputUsdPerMillion: 75 },
  'claude-sonnet-4': { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
  'claude-sonnet-4-5': { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
  'claude-haiku-4-5': { inputUsdPerMillion: 1, outputUsdPerMillion: 5 },
}

/** Canonical fallback when a model id isn't in the lookup table. */
const DEFAULT_CLAUDE_PRICING = CLAUDE_MODEL_PRICING['claude-sonnet-4-5']

/**
 * Compute USD cost for a Claude vision/text call given input + output
 * token counts. Pure function so it can be reused in audit log shaping
 * without instantiating a tracker.
 */
export function claudeCallCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  if (inputTokens < 0 || outputTokens < 0) {
    throw new RangeError('claudeCallCostUsd: token counts must be >= 0')
  }
  const pricing = CLAUDE_MODEL_PRICING[model] ?? DEFAULT_CLAUDE_PRICING
  return (
    (inputTokens * pricing.inputUsdPerMillion) / 1_000_000 +
    (outputTokens * pricing.outputUsdPerMillion) / 1_000_000
  )
}

/**
 * Per-job cost accumulator. One instance per `runCloneProV7` call;
 * the orchestrator threads it into Stage 14 + Stage 16 deps so they
 * can report actual Anthropic usage costs after each call.
 */
export class CloneProCostTracker {
  private readonly maxUsd: number
  private spentUsd = 0
  private readonly breakdown: Record<string, number> = {}

  constructor(opts: CostBudgetOpts = {}) {
    this.maxUsd = opts.maxUsd ?? resolveMaxBudgetUsd()
  }

  /**
   * Record `usd` spent at `stageId`. If the running total exceeds the
   * cap STRICTLY (>, not >=), throws `CostBudgetExceededError`. Equal
   * is allowed — a job that spends exactly `maxUsd` ships clean.
   */
  addCost(stageId: string, usd: number): void {
    if (usd < 0) throw new RangeError('addCost: usd must be >= 0')
    this.spentUsd += usd
    this.breakdown[stageId] = (this.breakdown[stageId] ?? 0) + usd
    if (this.spentUsd > this.maxUsd) {
      throw new CostBudgetExceededError({
        spentUsd: this.spentUsd,
        limitUsd: this.maxUsd,
        lastStage: stageId,
      })
    }
  }

  /**
   * Token-based accounting for a single Claude call. Looks up
   * per-model pricing in `CLAUDE_MODEL_PRICING`, computes USD, then
   * delegates to `addCost(stageId, usd)`. Throws
   * `CostBudgetExceededError` when the running total crosses the cap
   * (same semantics as `addCost`).
   *
   * Stage 14 + Stage 16 should call this AFTER each Anthropic SDK
   * response so the cost reflects actual token usage (response.usage).
   * For pre-call defensive checks, use `assertWithinBudget(stageId)`.
   */
  addClaude(
    model: string,
    stageId: string,
    inputTokens: number,
    outputTokens: number,
  ): void {
    const usd = claudeCallCostUsd(model, inputTokens, outputTokens)
    this.addCost(stageId, usd)
  }

  getSpentUsd(): number {
    return this.spentUsd
  }

  getMaxUsd(): number {
    return this.maxUsd
  }

  getBreakdown(): CostBreakdown {
    // Return a defensive copy so the orchestrator can't mutate
    // accumulator state.
    return { ...this.breakdown }
  }

  /**
   * Pre-call check — call BEFORE issuing an Anthropic request. Returns
   * the headroom in USD, or throws `CostBudgetExceededError` if we're
   * already over (which would mean a previous `addCost` failed to
   * propagate — defensive belt-and-braces).
   */
  assertWithinBudget(stageId: string): number {
    if (this.spentUsd > this.maxUsd) {
      throw new CostBudgetExceededError({
        spentUsd: this.spentUsd,
        limitUsd: this.maxUsd,
        lastStage: stageId,
      })
    }
    return Math.max(0, this.maxUsd - this.spentUsd)
  }
}
