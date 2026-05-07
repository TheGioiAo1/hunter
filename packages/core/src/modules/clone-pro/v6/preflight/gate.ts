/**
 * Clone Pro v6 — BYOK pre-flight gate
 *
 * Composes config-load + pingProvider + estimateCloneCost into a single
 * gate decision.  All three dependencies are injected (DI), making this
 * module pure (no DB import) and trivially unit-testable.
 *
 * Decision matrix:
 *   - config null OR provider === 'none'  → { ok: false, error: 'ai_required' }
 *   - pingProvider returns ok: false      → { ok: false, error: 'ai_key_invalid', detail }
 *   - ping ok                             → { ok: true,  estimate }
 *
 * No retries, no fallbacks — caller owns retry policy.
 */

import type { AIProvider, PingProviderResult } from './ping-provider.js'
import { estimateCloneCost, type EstimateResult } from './estimate-cost.js'

// ---------------------------------------------------------------------------
// Exported interfaces
// ---------------------------------------------------------------------------

export interface PreflightConfig {
  provider: AIProvider | 'none'
  model: string
  apiKey: string
}

export interface PreflightInput {
  db: unknown
  shopId: string
  sourceUrl: string
  loadConfig: (db: unknown, shopId: string) => Promise<PreflightConfig | null>
  pingProvider: (input: { provider: AIProvider; apiKey: string; model: string }) => Promise<PingProviderResult>
  estimateUrlCount: (sourceUrl: string) => Promise<number>
}

export type PreflightResult =
  | { ok: true; estimate: EstimateResult }
  | { ok: false; error: 'ai_required' | 'ai_key_invalid'; detail?: string }

// ---------------------------------------------------------------------------
// Gate implementation
// ---------------------------------------------------------------------------

export async function runPreflight(input: PreflightInput): Promise<PreflightResult> {
  const cfg = await input.loadConfig(input.db, input.shopId)

  // Gate 1: shop must have a configured AI provider
  if (!cfg || cfg.provider === 'none') {
    return { ok: false, error: 'ai_required' }
  }

  // Gate 2: API key must pass a live ping
  const ping = await input.pingProvider({
    provider: cfg.provider,
    apiKey: cfg.apiKey,
    model: cfg.model,
  })
  if (!ping.ok) {
    return { ok: false, error: 'ai_key_invalid', detail: ping.error }
  }

  // All gates passed — return cost estimate
  const urlCount = await input.estimateUrlCount(input.sourceUrl)
  const estimate = estimateCloneCost({
    urlCount,
    provider: cfg.provider,
    model: cfg.model,
  })
  return { ok: true, estimate }
}
