/**
 * Clone Pro v7 — Visual verify
 *
 * Side-by-side compare of source vs clone screenshots via Claude
 * vision. Emits a single avg score (0-10) plus per-page breakdown
 * and human-readable feedback for the Stage 16 retry loop.
 *
 * The actual retry loop (max 3 iterations) lives in
 * `stages/stage16-visual-verify.ts`. This module is the building
 * block: one pass through "capture → diff → score" with no looping
 * itself.
 *
 * DI-based: caller supplies `captureClone` (Playwright wrapper),
 * `downloadS3`, `callVision` (Anthropic SDK wrapper). No top-level
 * imports of those packages so unit tests run without a browser /
 * AWS / Anthropic key.
 *
 * Iron rule 5: every error wraps via `safeMessage`. The seller-facing
 * surface (Stage 16 result) is leak-free; raw diagnostics flow to
 * `console.warn` server-side.
 */

import { safeMessage } from '../../../support/safe-message.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PerPageScore {
  score: number
  issues: string[]
}

export interface VisualVerifyResult {
  /** Average score across all pages (0-10). 0 when all pages failed. */
  score: number
  /** True when score >= 7 (Sprint 4 plan calls this the pass bar). */
  passed: boolean
  /** Concatenated issues — feeds the Stage 16 retry feedback loop. */
  feedback: string[]
  /** Per-page breakdown — useful for the seller-facing theme report. */
  per_page: Record<string, PerPageScore>
  /** S3 keys of clone screenshots so the caller can persist them. */
  clone_screenshot_keys: Record<string, string>
  /** Iron rule 5 — pre-scrubbed warnings only. */
  warnings: string[]
}

export type CaptureCloneFn = (input: { cloneUrl: string; shopSlug: string }) => Promise<Record<string, string>>
export type DownloadS3Fn = (key: string) => Promise<Buffer>
export interface VisionCallInput {
  pageLabel: string
  prompt: string
  sourceImageBase64: string
  cloneImageBase64: string
}
export type VisionCallFn = (input: VisionCallInput) => Promise<string>

export interface VisualVerifyDeps {
  captureClone: CaptureCloneFn
  downloadS3: DownloadS3Fn
  callVision: VisionCallFn
}

export interface VisualVerifyInput extends VisualVerifyDeps {
  /** Source screenshots from Stage 13 — `<label>-<viewport>` → S3 key. */
  sourceScreenshotS3Keys: Record<string, string>
  /** Storefront URL of the rendered clone (e.g. https://shop-x.gbox.co). */
  cloneUrl: string
  /** Shop slug used as the S3 prefix root for clone screenshots. */
  shopSlug: string
  /** Stage 16 retry passes prior issues here so Claude can grade vs feedback. */
  previousFeedback: string[]
}

// ---------------------------------------------------------------------------
// Pure helpers (testable in isolation)
// ---------------------------------------------------------------------------

export interface VerdictParseResult {
  score: number
  issues: string[]
}

/** Strip ```json ... ``` markdown fences if Claude ignores the discipline rule. */
function stripCodeFences(s: string): string {
  const trimmed = s.trim()
  const fenced = trimmed.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/)
  return fenced ? fenced[1].trim() : trimmed
}

function clamp01to10(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 10) return 10
  return n
}

export function parseClaudeVerdict(raw: string): VerdictParseResult {
  const stripped = stripCodeFences(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return { score: 0, issues: [`unparseable claude output: ${stripped.slice(0, 200)}`] }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { score: 0, issues: ['claude output was not an object'] }
  }
  const obj = parsed as Record<string, unknown>
  const rawScore = typeof obj.score === 'number' ? obj.score : 0
  const score = clamp01to10(rawScore)
  const issuesRaw = obj.issues
  const issues = Array.isArray(issuesRaw)
    ? issuesRaw.filter((x): x is string => typeof x === 'string')
    : []
  return { score, issues }
}

export interface PromptOpts {
  pageLabel: string
  previousFeedback: string[]
}

export function buildVisualDiffPrompt(opts: PromptOpts): string {
  const feedbackBlock = opts.previousFeedback.length > 0
    ? `\n\nPREVIOUS FEEDBACK (this clone is on retry — confirm whether these issues are now resolved):\n- ${opts.previousFeedback.join('\n- ')}`
    : ''

  return `You are evaluating how visually similar two screenshots are: a SOURCE (the original site we're cloning) and a CLONE (our rendered theme).

Page: ${opts.pageLabel}

Score the clone on a 0-10 scale where:
  10 = pixel-perfect match (identical typography, colors, spacing, component variants)
  7-9 = strong match (same overall composition, minor tweaks needed)
  4-6 = recognisable but generic (right pattern but proportions/colors off)
  0-3 = different design entirely

Look at:
  1. Typography — does the font family + weight match? Heading hierarchy?
  2. Colors — do primary/background/foreground hex values match?
  3. Spacing + composition — is the hero pattern (fullbleed/split/editorial) the same?
  4. Component variants — header style, product card layout, footer columns, nav placement
  5. Imagery — same aspect ratios for product cards / hero?${feedbackBlock}

Return ONLY a single valid JSON object:
{
  "score": <number 0-10>,
  "issues": [<short actionable strings — what to fix in the next iteration>]
}

No preamble, no markdown fences, no explanation. The "issues" array drives our retry loop — write each issue as a short imperative ("Increase header height token", "Switch product card to editorial variant", "Replace primary color with #3b2f2f").`
}

// ---------------------------------------------------------------------------
// Orchestrator (single pass — no retry; Stage 16 wraps this in a loop)
// ---------------------------------------------------------------------------

export async function visualVerify(input: VisualVerifyInput): Promise<VisualVerifyResult> {
  const warnings: string[] = []
  const perPage: Record<string, PerPageScore> = {}
  const feedback: string[] = []

  // 1. Capture the clone (Playwright via DI). On hard failure, we abort.
  let cloneKeys: Record<string, string>
  try {
    cloneKeys = await input.captureClone({ cloneUrl: input.cloneUrl, shopSlug: input.shopSlug })
  } catch (err) {
    const { safe, diagnostic } = safeMessage(err)
    console.warn(`[v7-visual-verify] clone capture failed for ${input.shopSlug}: ${diagnostic}`)
    return {
      score: 0,
      passed: false,
      feedback: [],
      per_page: {},
      clone_screenshot_keys: {},
      warnings: [safe],
    }
  }

  // 2. For each (label-viewport) in source: download both images, call Claude.
  const labels = Object.keys(input.sourceScreenshotS3Keys)
  for (const label of labels) {
    const sourceKey = input.sourceScreenshotS3Keys[label]
    const cloneKey = cloneKeys[label]

    if (!cloneKey) {
      warnings.push(`Page ${label}: clone screenshot was not captured (skipped)`)
      continue
    }

    let sourceBuf: Buffer
    let cloneBuf: Buffer
    try {
      sourceBuf = await input.downloadS3(sourceKey)
    } catch (err) {
      const { diagnostic } = safeMessage(err)
      console.warn(`[v7-visual-verify] source download failed for ${label}: ${diagnostic}`)
      warnings.push(`Page ${label}: source screenshot download failed`)
      continue
    }
    try {
      cloneBuf = await input.downloadS3(cloneKey)
    } catch (err) {
      const { diagnostic } = safeMessage(err)
      console.warn(`[v7-visual-verify] clone download failed for ${label}: ${diagnostic}`)
      warnings.push(`Page ${label}: clone screenshot download failed`)
      continue
    }

    const prompt = buildVisualDiffPrompt({
      pageLabel: label,
      previousFeedback: input.previousFeedback,
    })

    let raw: string
    try {
      raw = await input.callVision({
        pageLabel: label,
        prompt,
        sourceImageBase64: sourceBuf.toString('base64'),
        cloneImageBase64: cloneBuf.toString('base64'),
      })
    } catch (err) {
      const { diagnostic } = safeMessage(err)
      console.warn(`[v7-visual-verify] vision call failed for ${label}: ${diagnostic}`)
      warnings.push(`Page ${label}: visual diff call failed`)
      continue
    }

    const verdict = parseClaudeVerdict(raw)
    perPage[label] = verdict
    feedback.push(...verdict.issues)
  }

  // 3. Average score across pages that succeeded. Empty → 0.
  const successfulPages = Object.values(perPage)
  const score = successfulPages.length > 0
    ? successfulPages.reduce((sum, p) => sum + p.score, 0) / successfulPages.length
    : 0

  return {
    score,
    passed: score >= 7,
    feedback,
    per_page: perPage,
    clone_screenshot_keys: cloneKeys,
    warnings,
  }
}
