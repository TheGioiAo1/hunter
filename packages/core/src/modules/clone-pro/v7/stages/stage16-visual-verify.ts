/**
 * Clone Pro v7 — Stage 16: visual verify with retry loop
 *
 * Wraps `visualVerify` (single pass) in a retry loop, max 3 iterations:
 *
 *   attempt 1: verify → score < 7? → regenerate(feedback) → attempt 2
 *   attempt 2: verify → score < 7? → regenerate(feedback) → attempt 3
 *   attempt 3: verify → final score (whether <7 or >=7)
 *
 * If score >= 7 at any point: return passed=true with that attempt's
 * score + clone screenshot keys.
 *
 * If regenerate (Stage 15 invocation) fails: bail out immediately —
 * we can't usefully retry without a re-rendered theme.
 *
 * DI-based: caller injects `runVerify` (visual-verify wrapper that
 * already has Playwright + Anthropic + S3 deps wired) and
 * `runRegenerate` (Stage 15 wrapper). This module is pure orchestration
 * + the retry policy.
 *
 * Cost cap: hard cap at 3 visual-verify calls per job (≈ $0.30-0.50
 * Claude vision + 5 page captures). Sprint plan calls this out — if a
 * theme can't converge in 3 retries, we ship the best-attempt result
 * and surface a "manual override" prompt to the seller.
 */

import { safeMessage } from '../../../support/safe-message.js'
import type { DesignTokens } from '../theme-engine/token-schema.js'
import type { VisualVerifyResult, VisualVerifyInput } from '../theme-engine/visual-verify.js'
import {
  CloneProCostTracker,
  CostBudgetExceededError,
} from '../cost-budget.js'

export interface RegenerateInput {
  jobId: string
  shopId: string
  tokens: DesignTokens
  version: number
  previousFeedback: string[]
}

export interface RegenerateResult {
  success: boolean
  theme_id: string
  version: number
  theme_zip_key: string | null
  manifest: unknown
  feedback_applied: string[]
  warnings: string[]
}

export type RunVerifyFn = (
  input: Omit<VisualVerifyInput, 'captureClone' | 'downloadS3' | 'callVision'>,
) => Promise<VisualVerifyResult>

export type RunRegenerateFn = (input: RegenerateInput) => Promise<RegenerateResult>

export interface Stage16Input {
  jobId: string
  shopId: string
  shopSlug: string
  cloneUrl: string
  sourceScreenshotS3Keys: Record<string, string>
  tokens: DesignTokens
  /** Single-pass verify (visual-verify with deps pre-bound). */
  runVerify: RunVerifyFn
  /** Stage 15 invocation wrapper (theme regenerate with deps pre-bound). */
  runRegenerate: RunRegenerateFn
  /** Default 3 — sprint plan caps cost at 3 verify calls. */
  maxRetries?: number
  /**
   * Optional per-job cost tracker. When supplied, Stage 16 calls
   * `tracker.assertWithinBudget('stage16')` BEFORE every verify
   * attempt; if the running total is already over the cap, the
   * function throws `CostBudgetExceededError` (which the worker
   * scrubs via `safeMessage()` before reaching the seller). The
   * verify callback itself is responsible for calling
   * `tracker.addClaude(...)` with actual SDK usage tokens — the
   * worker wires that callback inside its `runVerify` impl.
   */
  tracker?: CloneProCostTracker
}

export interface Stage16AttemptHistory {
  attempt: number
  score: number
  passed: boolean
  feedback: string[]
}

export interface Stage16Result {
  passed: boolean
  /** Final attempt's score (best-effort if all attempts failed). */
  score: number
  /** Number of verify passes performed (1..maxRetries). */
  attempts: number
  /** Final attempt's feedback. */
  feedback: string[]
  /** Final attempt's clone screenshot S3 keys (for the theme report). */
  clone_screenshot_keys: Record<string, string>
  /** Per-attempt scores for debugging / cost analysis. */
  attempts_history: Stage16AttemptHistory[]
  /** Iron rule 5 — pre-scrubbed warnings only. */
  warnings: string[]
}

const DEFAULT_MAX_RETRIES = 3

export async function visualVerifyWithRetry(input: Stage16Input): Promise<Stage16Result> {
  const maxRetries = input.maxRetries ?? DEFAULT_MAX_RETRIES
  const history: Stage16AttemptHistory[] = []
  const allWarnings: string[] = []

  let lastResult: VisualVerifyResult | null = null
  let currentFeedback: string[] = []
  let currentVersion = 1

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Pre-call budget gate. CostBudgetExceededError propagates out
    // (NOT caught into warnings) so the worker can mark the job failed
    // without burning more spend on doomed retries.
    if (input.tracker) {
      input.tracker.assertWithinBudget('stage16')
    }

    let verifyResult: VisualVerifyResult
    try {
      verifyResult = await input.runVerify({
        sourceScreenshotS3Keys: input.sourceScreenshotS3Keys,
        cloneUrl: input.cloneUrl,
        shopSlug: input.shopSlug,
        previousFeedback: currentFeedback,
      })
    } catch (err) {
      if (err instanceof CostBudgetExceededError) throw err
      const { safe, diagnostic } = safeMessage(err)
      console.warn(`[v7-stage16] verify attempt ${attempt} failed for ${input.shopId}: ${diagnostic}`)
      allWarnings.push(safe)
      // Hard verify error — bail out with whatever we have.
      return {
        passed: false,
        score: lastResult?.score ?? 0,
        attempts: attempt,
        feedback: currentFeedback,
        clone_screenshot_keys: lastResult?.clone_screenshot_keys ?? {},
        attempts_history: history,
        warnings: allWarnings,
      }
    }

    history.push({
      attempt,
      score: verifyResult.score,
      passed: verifyResult.passed,
      feedback: verifyResult.feedback,
    })
    allWarnings.push(...verifyResult.warnings)
    lastResult = verifyResult

    if (verifyResult.passed) {
      return {
        passed: true,
        score: verifyResult.score,
        attempts: attempt,
        feedback: verifyResult.feedback,
        clone_screenshot_keys: verifyResult.clone_screenshot_keys,
        attempts_history: history,
        warnings: allWarnings,
      }
    }

    // Score < 7 — regenerate ONLY if we have retries left.
    if (attempt >= maxRetries) {
      // Hit the cap. Return the failing result without regenerating again.
      break
    }

    currentFeedback = verifyResult.feedback
    currentVersion += 1

    // Regenerate the theme using the feedback. If regen fails, abort
    // (the next verify would just measure the same theme again).
    let regenResult: RegenerateResult
    try {
      regenResult = await input.runRegenerate({
        jobId: input.jobId,
        shopId: input.shopId,
        tokens: input.tokens,
        version: currentVersion,
        previousFeedback: currentFeedback,
      })
    } catch (err) {
      if (err instanceof CostBudgetExceededError) throw err
      const { safe, diagnostic } = safeMessage(err)
      console.warn(`[v7-stage16] regenerate attempt ${attempt} failed for ${input.shopId}: ${diagnostic}`)
      allWarnings.push(safe)
      return {
        passed: false,
        score: verifyResult.score,
        attempts: attempt,
        feedback: currentFeedback,
        clone_screenshot_keys: verifyResult.clone_screenshot_keys,
        attempts_history: history,
        warnings: allWarnings,
      }
    }

    if (!regenResult.success) {
      // Stage 15 returned success=false (e.g. S3 upload failed). The
      // next verify pass would measure the previous theme — pointless
      // in cost. Bail out with the current attempt as the final.
      allWarnings.push(...regenResult.warnings)
      return {
        passed: false,
        score: verifyResult.score,
        attempts: attempt,
        feedback: currentFeedback,
        clone_screenshot_keys: verifyResult.clone_screenshot_keys,
        attempts_history: history,
        warnings: allWarnings,
      }
    }
  }

  // Loop exited via maxRetries cap (last attempt failed but we ran out
  // of retries). Return the most recent result as best-effort.
  if (!lastResult) {
    return {
      passed: false,
      score: 0,
      attempts: 0,
      feedback: [],
      clone_screenshot_keys: {},
      attempts_history: history,
      warnings: allWarnings,
    }
  }
  return {
    passed: lastResult.passed,
    score: lastResult.score,
    attempts: maxRetries,
    feedback: lastResult.feedback,
    clone_screenshot_keys: lastResult.clone_screenshot_keys,
    attempts_history: history,
    warnings: allWarnings,
  }
}
