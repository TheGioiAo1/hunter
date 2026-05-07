/**
 * Gbox Platform — support-ai model selector (Phase 12.5 PR4).
 *
 * The hybrid-tier contract from spec §10.6.1: use cheap, fast Sonnet
 * for the 90% of tickets where a competent junior agent could answer
 * from the shop's docs, and reach for the expensive, slower Opus only
 * when the blast radius of a wrong answer is high.
 *
 * Why a dedicated file and not a switch inside suggest-reply.ts?
 * --------------------------------------------------------------
 *   - The same decision fires on `suggest-reply`, `summarize-thread`,
 *     `auto-categorize`, and `sentiment-flag`. Factoring it out keeps
 *     the four surfaces cheap to audit for "did this path actually
 *     pick Opus?" when a billing spike hits.
 *   - Tests can enumerate all branches in one file instead of four.
 *   - Thai can tune the decision tree from one line when the first
 *     month's usage data tells us we're over-Opus'ing on low-value
 *     tickets.
 *
 * Returns null ONLY if AI is not configured at all (null-key or
 * AI_ENABLED=false). Call sites MUST handle null by rendering the
 * "chưa cấu hình" stub — NEVER by calling a provider anyway.
 *
 * Price-tier note: Sonnet 4.5 ≈ $3 / $15 per 1M tokens; Opus 4 ≈
 * $15 / $75. A single reply is ~500 input + 300 output tokens, so
 * Sonnet ≈ $0.006 and Opus ≈ $0.030 per call. Budget-wise we can
 * afford 33k Sonnet OR 6.6k Opus calls per $200/month.
 */

/**
 * The two concrete models this module selects between. Kept as a
 * narrow literal union so the type system catches typos at the
 * caller site (e.g. `picked === 'opus-4'` won't silently false).
 *
 * The literal values deliberately DO NOT include the Anthropic
 * date-suffixed IDs (`claude-sonnet-4-5-20241022`) — those are a
 * client.ts concern. This file stays in the semantic space
 * ("sonnet" vs "opus") so we can swap the underlying SKU without
 * touching every call site.
 */
export type SupportAiModel = 'sonnet-4-5' | 'opus-4'

/**
 * Minimal ticket snapshot the picker needs. Full `SupportTicketTable`
 * rows are >20 columns and we don't want to force callers to load
 * the whole thing when they only have a few fields in memory.
 *
 * Why just these four? They map one-to-one with the branches of the
 * decision tree. Adding a field here means adding a branch to
 * pickModel(); don't bloat the shape speculatively.
 */
export interface TicketSnapshot {
  /** Ticket category, drives the payment-tier branch. */
  readonly category: string
  /** Ticket priority, excludes low-priority payment tickets from Opus. */
  readonly priority: string
  /** Subject string, matched against the high-stakes keyword regex. */
  readonly subject: string
}

/**
 * High-stakes keyword regex. If ANY of these appears in the ticket
 * subject (case-insensitive), we unconditionally reach for Opus.
 *
 * Why a regex and not a string-contains loop? One compiled regex with
 * a single alternation is ~3× faster than N toLowerCase().includes()
 * calls, and fits on one line for reviewers. Order doesn't matter
 * (regex alternation tries all branches).
 *
 * Keywords chosen from support ticket triage patterns observed in
 * the v3 seller beta (chargeback notices, PayPal disputes, "I'm
 * going to sue", Facebook scam reports, refund disputes).
 */
export const HIGH_STAKES_KEYWORDS = /(chargeback|dispute|legal|lawyer|report|fraud)/i

/**
 * Confidence threshold above which we upgrade to Opus. 0.85 is the
 * tier used in Phase 10 PR1 (copywriter) and matches the spec
 * section 10.6.1.
 *
 * Exported so the smoke test can assert against the canonical value
 * and so a future heuristic rewrite can tune it in one place.
 */
export const OPUS_CONFIDENCE_FLOOR = 0.85

/**
 * Pick a model for the given ticket + confidence pair.
 *
 * Decision tree (top-down, first-match-wins):
 *
 *   1. Payment category + not low priority → Opus.
 *      Rationale: wrong answer = seller contests a payment =
 *      possible chargeback = platform liability.
 *
 *   2. Subject matches HIGH_STAKES_KEYWORDS → Opus.
 *      Rationale: legal / fraud / dispute conversations need the
 *      stronger reasoning on tone and de-escalation.
 *
 *   3. confidence >= 0.85 → Opus.
 *      Rationale: caller has already done Sonnet triage and found
 *      the answer is going to be high-stakes (PayPal onboarding
 *      verification, tax compliance question).
 *
 *   4. Otherwise → Sonnet.
 *
 * All branches are pure — no I/O, no crypto, no DB. Unit-testable
 * by construction.
 *
 * @param ticket Snapshot with category / priority / subject
 * @param confidence A float in [0, 1] set by the caller's triage
 *                   heuristic. Pass 0 if you don't have a score yet.
 * @returns The model id to use for this invocation
 */
export function pickModel(
  ticket: TicketSnapshot,
  confidence: number,
): SupportAiModel {
  // Branch 1: payment + non-low priority
  if (ticket.category === 'payment' && ticket.priority !== 'low') {
    return 'opus-4'
  }
  // Branch 2: high-stakes subject keywords
  if (HIGH_STAKES_KEYWORDS.test(ticket.subject)) {
    return 'opus-4'
  }
  // Branch 3: high-confidence judgement needed
  if (confidence >= OPUS_CONFIDENCE_FLOOR) {
    return 'opus-4'
  }
  // Branch 4: everything else
  return 'sonnet-4-5'
}

/**
 * Anthropic SKU ids for each semantic model. Call sites MUST resolve
 * the semantic id through this map before handing it to the SDK —
 * keeping the pin in one place makes rotating to a newer snapshot a
 * one-line change.
 */
export const ANTHROPIC_SKU: Readonly<Record<SupportAiModel, string>> = {
  'sonnet-4-5': 'claude-sonnet-4-5-20241022',
  'opus-4': 'claude-opus-4-20250514',
}

/**
 * Current per-1M-token pricing in USD cents. Kept next to the SKU
 * map so pricing rotations (e.g. Anthropic drops Sonnet 4.5 price
 * 20%) stay one-file changes.
 *
 * Input / output split follows the Anthropic pricing page; numbers
 * pulled 2026-04-22.
 */
export interface ModelPrice {
  readonly inputCentsPerMillion: number
  readonly outputCentsPerMillion: number
}

export const SUPPORT_AI_PRICE_SHEET: Readonly<Record<SupportAiModel, ModelPrice>> = {
  'sonnet-4-5': { inputCentsPerMillion: 300, outputCentsPerMillion: 1500 },
  'opus-4': { inputCentsPerMillion: 1500, outputCentsPerMillion: 7500 },
}

/**
 * Compute the cost in USD cents for a single invocation. Kept here
 * so the cost math stays next to the price sheet — any future
 * pricing tweak regression-tests in pick-model.test.ts and nowhere
 * else needs to know.
 *
 * @returns cost in USD cents, ROUND-DOWN to whole cents. Rounding
 *          down is deliberate: we want the monthly tracker to never
 *          overshoot our internal budget, even if each individual
 *          call undercounts by 0.99 cent.
 */
export function computeCostCents(
  model: SupportAiModel,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = SUPPORT_AI_PRICE_SHEET[model]
  // USD cents per 1M tokens × tokens / 1M = cents.
  const inputCents = (price.inputCentsPerMillion * inputTokens) / 1_000_000
  const outputCents = (price.outputCentsPerMillion * outputTokens) / 1_000_000
  return Math.floor(inputCents + outputCents)
}
