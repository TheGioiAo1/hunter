/**
 * Clone Pro v7 — Stage 14: design-token extraction (Claude vision)
 *
 * Pipeline:
 *   1. For each entry in `screenshotS3Keys`, download the PNG from S3
 *      and call Claude vision with the matching describe-* prompt.
 *      Per-call failures don't kill the run (warning + continue).
 *   2. Collect the partial JSON outputs from all describe calls.
 *   3. Call Claude one more time with `consolidateTokensPrompt(partials)`
 *      to merge the partial tokens into a single DesignTokens object.
 *   4. Strip markdown fences, JSON.parse, validate via DesignTokensSchema.
 *      Schema-validation failure → tokens=null + warning.
 *   5. If `persistTokens` callback provided AND tokens valid AND shopId
 *      provided → invoke it. Otherwise return tokens for the caller to
 *      handle persistence (keeps this orchestrator pure for unit tests).
 *
 * DI-based: caller provides `downloadS3`, `callVision`, optional
 * `persistTokens`. No top-level S3 / Anthropic imports — testable
 * without network or AWS creds.
 */

import { safeMessage } from '../../../support/safe-message.js'
import {
  DesignTokensSchema,
  type DesignTokens,
} from '../theme-engine/token-schema.js'
import {
  describeHomepagePrompt,
  describePdpPrompt,
  describePlpPrompt,
  describeGlobalPrompt,
  consolidateTokensPrompt,
  type PartialTokenInput,
} from '../theme-engine/claude-vision-prompts.js'
import {
  CloneProCostTracker,
  CostBudgetExceededError,
} from '../cost-budget.js'

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface VisionCallInput {
  source: string
  prompt: string
  imageBase64: string
}

export type VisionCallFn = (input: VisionCallInput) => Promise<string>

export type DownloadS3Fn = (key: string) => Promise<Buffer>

export interface PersistTokensInput {
  shopId: string
  tokens: DesignTokens
  s3Keys: Record<string, string>
}

export type PersistTokensFn = (input: PersistTokensInput) => Promise<unknown>

export interface ExtractInput {
  jobId: string
  shopId?: string
  /** Map of `<label>-<viewport>` → S3 key (output of Stage 13). */
  screenshotS3Keys: Record<string, string>
  downloadS3: DownloadS3Fn
  callVision: VisionCallFn
  /** Optional — when present, called with the validated tokens. */
  persistTokens?: PersistTokensFn
  /**
   * Optional per-job cost tracker. When supplied, Stage 14 calls
   * `tracker.assertWithinBudget('stage14')` BEFORE every vision call;
   * if the running total is already over the cap, the function throws
   * `CostBudgetExceededError` (which the worker scrubs via
   * `safeMessage()` before reaching the seller). The vision call
   * itself is responsible for invoking `tracker.addClaude(...)` with
   * actual SDK usage tokens — the worker wires that callback inside
   * its `callVision` impl.
   */
  tracker?: CloneProCostTracker
}

export interface ExtractResult {
  tokens: DesignTokens | null
  warnings: string[]
  /** Raw partial JSON from each describe-* call, kept for debugging / S3 manifest. */
  partials: PartialTokenInput[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pick the describe prompt by page-label. The spec covers home/pdp/plp;
 * cart/page/anything else falls back to the global prompt so we still
 * harvest some signal (navigation/spacing/breakpoints) from those pages.
 */
function promptFor(label: string): string {
  if (label === 'home') return describeHomepagePrompt()
  if (label === 'pdp') return describePdpPrompt()
  if (label === 'plp') return describePlpPrompt()
  return describeGlobalPrompt()
}

/**
 * Strip ```json ... ``` markdown fences if Claude ignores the
 * "no markdown" rule. Returns the inner content or original string.
 */
function stripCodeFences(s: string): string {
  const trimmed = s.trim()
  // Match ```...``` with optional language tag on the opening fence.
  const fenced = trimmed.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/)
  return fenced ? fenced[1].trim() : trimmed
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function extractDesignTokens(input: ExtractInput): Promise<ExtractResult> {
  const warnings: string[] = []
  const partials: PartialTokenInput[] = []
  const entries = Object.entries(input.screenshotS3Keys)

  if (entries.length === 0) {
    warnings.push('stage14: no screenshots to extract from')
    return { tokens: null, warnings, partials }
  }

  // ---- Phase 1: per-page describe-* calls -------------------------------
  for (const [labelViewport, s3Key] of entries) {
    // Pull the page-label off the front of '<label>-<viewport>'.
    const label = labelViewport.split('-')[0]

    let png: Buffer
    try {
      png = await input.downloadS3(s3Key)
    } catch (err) {
      const { diagnostic } = safeMessage(err)
      warnings.push(`stage14: S3 download failed for ${labelViewport}: ${diagnostic}`)
      continue
    }

    const imageBase64 = png.toString('base64')
    const prompt = promptFor(label)

    // Pre-call budget check. CostBudgetExceededError propagates so the
    // worker can mark the job failed without burning more spend; we do
    // NOT swallow into warnings (that's reserved for soft errors like
    // "rate limit, retry next time").
    if (input.tracker) {
      input.tracker.assertWithinBudget('stage14')
    }

    let raw: string
    try {
      raw = await input.callVision({ source: labelViewport, prompt, imageBase64 })
    } catch (err) {
      if (err instanceof CostBudgetExceededError) throw err
      const { diagnostic } = safeMessage(err)
      warnings.push(`stage14: vision call failed for ${labelViewport}: ${diagnostic}`)
      continue
    }

    const parsed = tryParseJson(stripCodeFences(raw))
    if (parsed === null) {
      warnings.push(`stage14: ${labelViewport} returned non-JSON output, skipping`)
      continue
    }
    partials.push({ source: labelViewport, json: parsed })
  }

  // ---- Phase 2: consolidate ---------------------------------------------
  // Pre-call budget check — same fail-fast policy as the loop above.
  if (input.tracker) {
    input.tracker.assertWithinBudget('stage14')
  }

  const consolidatePrompt = consolidateTokensPrompt(partials)
  let consolidatedRaw: string
  try {
    consolidatedRaw = await input.callVision({
      source: 'consolidate',
      prompt: consolidatePrompt,
      imageBase64: '',
    })
  } catch (err) {
    if (err instanceof CostBudgetExceededError) throw err
    const { diagnostic } = safeMessage(err)
    warnings.push(`stage14: consolidate call failed: ${diagnostic}`)
    return { tokens: null, warnings, partials }
  }

  const consolidatedParsed = tryParseJson(stripCodeFences(consolidatedRaw))
  if (consolidatedParsed === null) {
    warnings.push('stage14: consolidate returned non-JSON output')
    return { tokens: null, warnings, partials }
  }

  const validation = DesignTokensSchema.safeParse(consolidatedParsed)
  if (!validation.success) {
    warnings.push(
      `stage14: consolidated tokens failed schema validation: ${validation.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    )
    return { tokens: null, warnings, partials }
  }

  const tokens = validation.data

  // ---- Phase 3: optional persistence ------------------------------------
  if (input.persistTokens && input.shopId) {
    try {
      await input.persistTokens({
        shopId: input.shopId,
        tokens,
        s3Keys: input.screenshotS3Keys,
      })
    } catch (err) {
      const { diagnostic } = safeMessage(err)
      warnings.push(`stage14: persist failed: ${diagnostic}`)
    }
  }

  return { tokens, warnings, partials }
}
