import { describe, it, expect, vi } from 'vitest'
import { visualVerifyWithRetry, type Stage16Input } from './stage16-visual-verify.js'
import type { DesignTokens } from '../theme-engine/token-schema.js'
import type { VisualVerifyResult } from '../theme-engine/visual-verify.js'
import { CloneProCostTracker, CostBudgetExceededError } from '../cost-budget.js'

const TOKENS: DesignTokens = {
  fonts: {
    primary: { family: 'Cormorant Garamond', google_font: 'Cormorant Garamond', weights: [400] },
    secondary: null,
  },
  colors: {
    primary: '#3b2f2f',
    secondary: '#f5ebe0',
    accent: null,
    background: '#fffaf3',
    foreground: '#241a1a',
    muted: null,
  },
  spacing: { base_unit: 8, scale: [4, 8, 16] },
  breakpoints: { mobile: 480, tablet: 768, desktop: 1024, wide: 1440 },
  components: {
    header: { height: 80, background: '#fff', variant: 'minimal' },
    product_card: { aspect_ratio: '3/4', border_radius: 0, variant: 'editorial' },
    button: { border_radius: 4, padding_x: 24, padding_y: 12, variant: 'pill' },
    navigation: { variant: 'horizontal', placement: 'top' },
  },
  layout: { container_max_width: 1240, grid_columns: 12, hero_pattern: 'editorial' },
  style_keywords: ['editorial'],
  aesthetic_score: 8.0,
}

const PASS_RESULT: VisualVerifyResult = {
  score: 8.5,
  passed: true,
  feedback: [],
  per_page: { 'home-desktop': { score: 8.5, issues: [] } },
  clone_screenshot_keys: { 'home-desktop': 'shop/clone/home-d.png' },
  warnings: [],
}

const FAIL_RESULT: VisualVerifyResult = {
  score: 5,
  passed: false,
  feedback: ['header too short', 'hero feels generic'],
  per_page: { 'home-desktop': { score: 5, issues: ['header too short'] } },
  clone_screenshot_keys: { 'home-desktop': 'shop/clone/home-d.png' },
  warnings: [],
}

function makeDeps(overrides: Partial<Stage16Input> = {}): Stage16Input {
  return {
    jobId: 'job-1',
    shopId: 'shop-1',
    shopSlug: 'shop-1',
    cloneUrl: 'https://shop-1.gbox.co',
    sourceScreenshotS3Keys: { 'home-desktop': 'src/h.png' },
    tokens: TOKENS,
    runVerify: vi.fn().mockResolvedValue(PASS_RESULT),
    runRegenerate: vi.fn().mockResolvedValue({ success: true, theme_id: 'tid', version: 2, theme_zip_key: 'shop/theme.zip', manifest: null, feedback_applied: [], warnings: [] }),
    ...overrides,
  }
}

describe('Stage 16 — visualVerifyWithRetry', () => {
  it('returns passed=true after a single successful verify (no retry)', async () => {
    const verify = vi.fn().mockResolvedValue(PASS_RESULT)
    const regen = vi.fn()
    const r = await visualVerifyWithRetry(makeDeps({ runVerify: verify, runRegenerate: regen }))
    expect(r.passed).toBe(true)
    expect(r.score).toBe(8.5)
    expect(r.attempts).toBe(1)
    expect(verify).toHaveBeenCalledTimes(1)
    // No regen needed when first pass scores >=7.
    expect(regen).not.toHaveBeenCalled()
  })

  it('retries up to 3 times when score < 7, succeeds on attempt 3', async () => {
    const verify = vi.fn()
      .mockResolvedValueOnce({ ...FAIL_RESULT, score: 5 })       // attempt 1
      .mockResolvedValueOnce({ ...FAIL_RESULT, score: 6 })       // attempt 2
      .mockResolvedValueOnce({ ...PASS_RESULT, score: 8 })       // attempt 3
    const regen = vi.fn().mockResolvedValue({ success: true, theme_id: 'tid', version: 2, theme_zip_key: 'k', manifest: null, feedback_applied: [], warnings: [] })

    const r = await visualVerifyWithRetry(makeDeps({ runVerify: verify, runRegenerate: regen }))

    expect(r.passed).toBe(true)
    expect(r.attempts).toBe(3)
    expect(verify).toHaveBeenCalledTimes(3)
    // Regenerate runs between iterations — not after the final pass.
    expect(regen).toHaveBeenCalledTimes(2)
  })

  it('caps at maxRetries=3 and returns passed=false with last attempt result', async () => {
    const verify = vi.fn().mockResolvedValue(FAIL_RESULT)
    const regen = vi.fn().mockResolvedValue({ success: true, theme_id: 'tid', version: 2, theme_zip_key: 'k', manifest: null, feedback_applied: [], warnings: [] })

    const r = await visualVerifyWithRetry(makeDeps({ runVerify: verify, runRegenerate: regen }))

    expect(r.passed).toBe(false)
    expect(r.attempts).toBe(3)
    expect(verify).toHaveBeenCalledTimes(3)
    // After the 3rd verify fails we DON'T regenerate again (no point).
    expect(regen).toHaveBeenCalledTimes(2)
    expect(r.score).toBe(5)
    expect(r.feedback).toEqual(['header too short', 'hero feels generic'])
  })

  it('honours custom maxRetries (e.g. 1 = no retry, fail-fast for cost-bounded runs)', async () => {
    const verify = vi.fn().mockResolvedValue(FAIL_RESULT)
    const regen = vi.fn()

    const r = await visualVerifyWithRetry({ ...makeDeps({ runVerify: verify, runRegenerate: regen }), maxRetries: 1 })

    expect(r.attempts).toBe(1)
    expect(verify).toHaveBeenCalledTimes(1)
    expect(regen).not.toHaveBeenCalled()
  })

  it('passes feedback from attempt N into attempt N+1 verify call', async () => {
    const verify = vi.fn()
      .mockResolvedValueOnce({ ...FAIL_RESULT, feedback: ['header too short'] })
      .mockResolvedValueOnce(PASS_RESULT)
    const regen = vi.fn().mockResolvedValue({ success: true, theme_id: 'tid', version: 2, theme_zip_key: 'k', manifest: null, feedback_applied: [], warnings: [] })

    await visualVerifyWithRetry(makeDeps({ runVerify: verify, runRegenerate: regen }))

    // Attempt 2 should have received previousFeedback = ['header too short'].
    const attempt2Args = (verify as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(attempt2Args.previousFeedback).toEqual(['header too short'])
    // And the regenerate call should have received the same feedback.
    const regenArgs = (regen as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(regenArgs.previousFeedback).toEqual(['header too short'])
  })

  it('aborts the loop and returns failure when runRegenerate fails (regen is critical)', async () => {
    const verify = vi.fn().mockResolvedValue(FAIL_RESULT)
    const regen = vi.fn().mockResolvedValue({ success: false, theme_id: '', version: 0, theme_zip_key: null, manifest: null, feedback_applied: [], warnings: ['Please contact Gbox support.'] })

    const r = await visualVerifyWithRetry(makeDeps({ runVerify: verify, runRegenerate: regen }))

    expect(r.passed).toBe(false)
    // Regen failed → can't continue retrying → bail out after attempt 1.
    expect(verify).toHaveBeenCalledTimes(1)
    expect(regen).toHaveBeenCalledTimes(1)
    expect(r.warnings.some((w) => w.includes('Please contact Gbox support'))).toBe(true)
  })

  it('exposes per-attempt history in result.attempts_history for debugging', async () => {
    const verify = vi.fn()
      .mockResolvedValueOnce({ ...FAIL_RESULT, score: 4 })
      .mockResolvedValueOnce({ ...FAIL_RESULT, score: 6 })
      .mockResolvedValueOnce({ ...PASS_RESULT, score: 8.5 })
    const regen = vi.fn().mockResolvedValue({ success: true, theme_id: 'tid', version: 2, theme_zip_key: 'k', manifest: null, feedback_applied: [], warnings: [] })

    const r = await visualVerifyWithRetry(makeDeps({ runVerify: verify, runRegenerate: regen }))

    expect(r.attempts_history).toHaveLength(3)
    expect(r.attempts_history[0].score).toBe(4)
    expect(r.attempts_history[1].score).toBe(6)
    expect(r.attempts_history[2].score).toBe(8.5)
  })

  it('mock retry test from plan: scores [5, 5, 8] → attempts=3, passed=true', async () => {
    // Acceptance criteria (from sprint plan): "mock Claude vision return
    // score=5 first 2 calls, score=8 third call → asserts retry happens,
    // attempt=3 success".
    const verify = vi.fn()
      .mockResolvedValueOnce({ ...FAIL_RESULT, score: 5 })
      .mockResolvedValueOnce({ ...FAIL_RESULT, score: 5 })
      .mockResolvedValueOnce({ ...PASS_RESULT, score: 8 })
    const regen = vi.fn().mockResolvedValue({ success: true, theme_id: 'tid', version: 2, theme_zip_key: 'k', manifest: null, feedback_applied: [], warnings: [] })

    const r = await visualVerifyWithRetry(makeDeps({ runVerify: verify, runRegenerate: regen }))

    expect(r.attempts).toBe(3)
    expect(r.passed).toBe(true)
    expect(r.score).toBe(8)
  })

  // -------------------------------------------------------------------
  // Sprint 5 follow-up Task B: cost tracker integration
  // -------------------------------------------------------------------
  describe('cost-tracker wiring', () => {
    it('checks tracker.assertWithinBudget BEFORE every retry verify call', async () => {
      const tracker = new CloneProCostTracker({ maxUsd: 10 })
      const assertSpy = vi.spyOn(tracker, 'assertWithinBudget')

      const verify = vi.fn()
        .mockResolvedValueOnce({ ...FAIL_RESULT, score: 4 })
        .mockResolvedValueOnce({ ...FAIL_RESULT, score: 5 })
        .mockResolvedValueOnce({ ...PASS_RESULT, score: 8 })
      const regen = vi.fn().mockResolvedValue({
        success: true, theme_id: 't', version: 2, theme_zip_key: 'k',
        manifest: null, feedback_applied: [], warnings: [],
      })

      const r = await visualVerifyWithRetry(
        makeDeps({ runVerify: verify, runRegenerate: regen, tracker } as any),
      )

      expect(r.passed).toBe(true)
      // 3 attempts → 3 pre-call asserts (no add — the verify mock
      // doesn't simulate token usage; tests for the cost flow itself
      // live in stage14-design-extract.test.ts).
      expect(assertSpy).toHaveBeenCalledTimes(3)
      expect(assertSpy).toHaveBeenCalledWith('stage16')
    })

    it('throws CostBudgetExceededError mid-loop when tracker hits the cap', async () => {
      // Pre-load tracker into over-budget state.
      const tracker = new CloneProCostTracker({ maxUsd: 0.01 })
      try {
        tracker.addCost('previous-stage', 0.005)
        tracker.addCost('previous-stage', 0.006)
      } catch {
        // Expected — tracker now over-budget.
      }

      const verify = vi.fn().mockResolvedValue(PASS_RESULT)
      const regen = vi.fn()

      await expect(
        visualVerifyWithRetry(
          makeDeps({ runVerify: verify, runRegenerate: regen, tracker } as any),
        ),
      ).rejects.toBeInstanceOf(CostBudgetExceededError)

      // The verify call must NEVER fire when the budget is already
      // exceeded — the gate is the FIRST thing checked on each attempt.
      expect(verify).not.toHaveBeenCalled()
    })
  })
})
