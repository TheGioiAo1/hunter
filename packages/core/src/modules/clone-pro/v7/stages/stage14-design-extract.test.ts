import { describe, it, expect, vi } from 'vitest'
import { extractDesignTokens, type ExtractInput, type VisionCallFn } from './stage14-design-extract.js'
import type { DesignTokens } from '../theme-engine/token-schema.js'
import { CloneProCostTracker, CostBudgetExceededError } from '../cost-budget.js'

const FULL_TOKENS: DesignTokens = {
  fonts: {
    primary: { family: 'Cormorant Garamond', google_font: 'Cormorant Garamond', weights: [400, 600] },
    secondary: { family: 'Inter', google_font: 'Inter', weights: [400] },
  },
  colors: {
    primary: '#3b2f2f',
    secondary: '#f5ebe0',
    accent: '#c98a4b',
    background: '#fffaf3',
    foreground: '#241a1a',
    muted: '#a89f96',
  },
  spacing: { base_unit: 8, scale: [4, 8, 16, 24, 32] },
  breakpoints: { mobile: 480, tablet: 768, desktop: 1024, wide: 1440 },
  components: {
    header: { height: 80, background: '#fffaf3', variant: 'editorial' },
    product_card: { aspect_ratio: '3/4', border_radius: 0, variant: 'editorial' },
    button: { border_radius: 2, padding_x: 24, padding_y: 12, variant: 'minimal' },
    navigation: { variant: 'horizontal', placement: 'top' },
  },
  layout: { container_max_width: 1240, grid_columns: 12, hero_pattern: 'split-text-image' },
  style_keywords: ['editorial', 'warm'],
  aesthetic_score: 8.4,
}

const fakeS3Download = (responses: Record<string, Buffer>) => {
  return vi.fn().mockImplementation(async (key: string) => {
    if (responses[key]) return responses[key]
    throw new Error(`unknown key ${key}`)
  })
}

describe('Stage 14 — design token extraction', () => {
  it('returns valid DesignTokens when all calls succeed and consolidate output is valid', async () => {
    const screenshots = {
      'home-desktop': Buffer.from('home-desktop-png'),
      'home-mobile': Buffer.from('home-mobile-png'),
      'pdp-desktop': Buffer.from('pdp-desktop-png'),
      'plp-desktop': Buffer.from('plp-desktop-png'),
    }
    const callVision: VisionCallFn = vi.fn().mockImplementation(async ({ source }) => {
      // describe-* prompts return partial JSON — consolidate returns full
      if (source === 'consolidate') return JSON.stringify(FULL_TOKENS)
      return JSON.stringify({ fonts: { primary: { family: 'Cormorant Garamond', google_font: 'Cormorant Garamond', weights: [400] } } })
    })

    const r = await extractDesignTokens({
      jobId: 'j1',
      screenshotS3Keys: {
        'home-desktop': 'k/h-d.png',
        'home-mobile': 'k/h-m.png',
        'pdp-desktop': 'k/pdp-d.png',
        'plp-desktop': 'k/plp-d.png',
      },
      downloadS3: fakeS3Download({
        'k/h-d.png': screenshots['home-desktop'],
        'k/h-m.png': screenshots['home-mobile'],
        'k/pdp-d.png': screenshots['pdp-desktop'],
        'k/plp-d.png': screenshots['plp-desktop'],
      }),
      callVision,
    })

    expect(r.tokens).not.toBeNull()
    expect(r.tokens!.fonts.primary.family).toBe('Cormorant Garamond')
    expect(r.tokens!.aesthetic_score).toBe(8.4)
  })

  it('returns null tokens + warning when consolidate returns invalid JSON', async () => {
    const callVision: VisionCallFn = vi.fn().mockImplementation(async () => 'not json')
    const r = await extractDesignTokens({
      jobId: 'j',
      screenshotS3Keys: { 'home-desktop': 'k1' },
      downloadS3: fakeS3Download({ k1: Buffer.from('x') }),
      callVision,
    })
    expect(r.tokens).toBeNull()
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('returns null tokens when consolidate output fails Zod validation', async () => {
    const callVision: VisionCallFn = vi.fn().mockImplementation(async ({ source }) => {
      if (source === 'consolidate') return JSON.stringify({ ...FULL_TOKENS, aesthetic_score: 99 })
      return JSON.stringify({})
    })
    const r = await extractDesignTokens({
      jobId: 'j',
      screenshotS3Keys: { 'home-desktop': 'k1' },
      downloadS3: fakeS3Download({ k1: Buffer.from('x') }),
      callVision,
    })
    expect(r.tokens).toBeNull()
    expect(r.warnings.some((w) => w.toLowerCase().includes('valid'))).toBe(true)
  })

  it('strips markdown code fences from Claude response', async () => {
    const callVision: VisionCallFn = vi.fn().mockImplementation(async ({ source }) => {
      if (source === 'consolidate') return '```json\n' + JSON.stringify(FULL_TOKENS) + '\n```'
      return JSON.stringify({})
    })
    const r = await extractDesignTokens({
      jobId: 'j',
      screenshotS3Keys: { 'home-desktop': 'k1' },
      downloadS3: fakeS3Download({ k1: Buffer.from('x') }),
      callVision,
    })
    expect(r.tokens).not.toBeNull()
    expect(r.tokens!.aesthetic_score).toBe(8.4)
  })

  it('continues consolidation even when one describe-* call fails', async () => {
    const callVision: VisionCallFn = vi.fn().mockImplementation(async ({ source }) => {
      if (source === 'consolidate') return JSON.stringify(FULL_TOKENS)
      if (source === 'pdp-desktop') throw new Error('rate limit')
      return JSON.stringify({})
    })
    const r = await extractDesignTokens({
      jobId: 'j',
      screenshotS3Keys: {
        'home-desktop': 'k/h.png',
        'pdp-desktop': 'k/p.png',
      },
      downloadS3: fakeS3Download({ 'k/h.png': Buffer.from('x'), 'k/p.png': Buffer.from('y') }),
      callVision,
    })
    expect(r.tokens).not.toBeNull()
    expect(r.warnings.some((w) => w.includes('pdp-desktop'))).toBe(true)
  })

  it('skips a screenshot key that fails to download but completes', async () => {
    const callVision: VisionCallFn = vi.fn().mockImplementation(async ({ source }) => {
      if (source === 'consolidate') return JSON.stringify(FULL_TOKENS)
      return JSON.stringify({})
    })
    const r = await extractDesignTokens({
      jobId: 'j',
      screenshotS3Keys: {
        'home-desktop': 'k/h.png',
        'pdp-desktop': 'k/missing.png',
      },
      downloadS3: vi.fn().mockImplementation(async (k: string) => {
        if (k === 'k/h.png') return Buffer.from('x')
        throw new Error('NoSuchKey')
      }),
      callVision,
    })
    expect(r.tokens).not.toBeNull()
    expect(r.warnings.some((w) => w.toLowerCase().includes('download'))).toBe(true)
  })

  it('selects the correct describe prompt per page label', async () => {
    const seen: string[] = []
    const callVision: VisionCallFn = vi.fn().mockImplementation(async ({ source, prompt }) => {
      seen.push(`${source}:${prompt.slice(0, 40)}`)
      if (source === 'consolidate') return JSON.stringify(FULL_TOKENS)
      return JSON.stringify({})
    })
    await extractDesignTokens({
      jobId: 'j',
      screenshotS3Keys: {
        'home-desktop': 'k/h.png',
        'pdp-desktop': 'k/p.png',
        'plp-desktop': 'k/l.png',
        'cart-desktop': 'k/c.png',
      },
      downloadS3: fakeS3Download({
        'k/h.png': Buffer.from('x'),
        'k/p.png': Buffer.from('x'),
        'k/l.png': Buffer.from('x'),
        'k/c.png': Buffer.from('x'),
      }),
      callVision,
    })
    // Each describe-* should have a distinct prompt fingerprint:
    const homePrompt = seen.find((s) => s.startsWith('home-desktop:'))
    const pdpPrompt = seen.find((s) => s.startsWith('pdp-desktop:'))
    const plpPrompt = seen.find((s) => s.startsWith('plp-desktop:'))
    const cartPrompt = seen.find((s) => s.startsWith('cart-desktop:'))
    expect(homePrompt).not.toBe(pdpPrompt)
    expect(pdpPrompt).not.toBe(plpPrompt)
    // 'cart' label falls back to global prompt (not described in spec; same for unknown)
    expect(cartPrompt).toBeDefined()
  })

  it('returns warnings when no screenshots provided', async () => {
    const r = await extractDesignTokens({
      jobId: 'j',
      screenshotS3Keys: {},
      downloadS3: vi.fn(),
      callVision: vi.fn(),
    })
    expect(r.tokens).toBeNull()
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('persistTokens returns false when called with no input', async () => {
    // Tokens-null path: orchestrator should not crash when persist is requested.
    const persistFn: ExtractInput['persistTokens'] = vi.fn()
    const r = await extractDesignTokens({
      jobId: 'j',
      screenshotS3Keys: {},
      downloadS3: vi.fn(),
      callVision: vi.fn(),
      persistTokens: persistFn,
    })
    expect(r.tokens).toBeNull()
    expect(persistFn).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------
  // Sprint 5 follow-up Task B: cost tracker integration
  // -------------------------------------------------------------------
  describe('cost-tracker wiring', () => {
    /** Vision call that reports its token usage on a sidecar callback. */
    const usageReportingVision = (
      model: string,
      inputTokens: number,
      outputTokens: number,
      consolidateBody: () => string,
      reportUsage: (m: string, i: number, o: number) => void,
    ): VisionCallFn => {
      return vi.fn().mockImplementation(async ({ source }) => {
        // Mimics what the worker does: after the SDK responds, report
        // usage to the tracker via the side channel `reportUsage`.
        reportUsage(model, inputTokens, outputTokens)
        if (source === 'consolidate') return consolidateBody()
        return JSON.stringify({})
      })
    }

    it('records cost via tracker.addClaude after each successful vision call', async () => {
      const tracker = new CloneProCostTracker({ maxUsd: 10 })
      const screenshotKeys = {
        'home-desktop': 'k/h.png',
        'pdp-desktop': 'k/p.png',
      }

      const callVision: VisionCallFn = vi.fn().mockImplementation(async ({ source }) => {
        // Simulate SDK reporting usage on every response (worker-side
        // wraps the SDK with this hook). Here we call the tracker
        // directly to model the worker behaviour.
        tracker.addClaude('claude-sonnet-4-5', 'stage14', 1000, 500)
        if (source === 'consolidate') return JSON.stringify(FULL_TOKENS)
        return JSON.stringify({})
      })

      const r = await extractDesignTokens({
        jobId: 'j',
        screenshotS3Keys: screenshotKeys,
        downloadS3: fakeS3Download({
          'k/h.png': Buffer.from('x'),
          'k/p.png': Buffer.from('y'),
        }),
        callVision,
        tracker,
      })

      expect(r.tokens).not.toBeNull()
      // 2 describe + 1 consolidate = 3 vision calls
      // 3 × $0.0105 = $0.0315
      expect(tracker.getSpentUsd()).toBeCloseTo(0.0315, 4)
      expect(tracker.getBreakdown().stage14).toBeCloseTo(0.0315, 4)
    })

    it('aborts extraction when tracker.assertWithinBudget throws BEFORE the vision call', async () => {
      // Pre-load tracker so the very first stage14 call is over-budget.
      // We "poison" the tracker by reaching past addCost's >max guard
      // through a sequence that lands on the boundary, then bumps it
      // over via a second add. The user-facing API doesn't expose a
      // setter — but addCost(...) up to 0.005 + addCost(0.006) crosses.
      const tracker = new CloneProCostTracker({ maxUsd: 0.01 })
      try {
        tracker.addCost('previous-stage', 0.005)
        tracker.addCost('previous-stage', 0.006) // 0.011 > 0.01 → throws.
      } catch {
        // Expected — we want the tracker in over-budget state.
      }

      const callVision: VisionCallFn = vi.fn()

      await expect(
        extractDesignTokens({
          jobId: 'j',
          screenshotS3Keys: { 'home-desktop': 'k/h.png' },
          downloadS3: fakeS3Download({ 'k/h.png': Buffer.from('x') }),
          callVision,
          tracker,
        }),
      ).rejects.toBeInstanceOf(CostBudgetExceededError)

      // The vision call must NEVER fire when we're already over budget.
      expect(callVision).not.toHaveBeenCalled()
    })

    it('throws CostBudgetExceededError mid-loop when accumulated tokens cross the cap', async () => {
      // Sonnet 4.5: 1000 input + 500 output = $0.0105/call.
      // 30 calls = $0.315. Cap at $0.05 → throws around call 5.
      const tracker = new CloneProCostTracker({ maxUsd: 0.05 })

      // 5 page screenshots × 5 prompts/page worst case ≈ 25 calls per
      // job. Stage 14 only has 5 describe calls (one per S3 key) +
      // 1 consolidate, so we synthesize 6 total for this run.
      const screenshots: Record<string, string> = {}
      const downloads: Record<string, Buffer> = {}
      for (let i = 0; i < 5; i++) {
        screenshots[`home-desktop-${i}`] = `k/${i}.png`
        downloads[`k/${i}.png`] = Buffer.from(String(i))
      }

      const callVision: VisionCallFn = vi.fn().mockImplementation(async () => {
        tracker.addClaude('claude-sonnet-4-5', 'stage14', 1000, 500)
        return JSON.stringify({})
      })

      await expect(
        extractDesignTokens({
          jobId: 'j',
          screenshotS3Keys: screenshots,
          downloadS3: fakeS3Download(downloads),
          callVision,
          tracker,
        }),
      ).rejects.toBeInstanceOf(CostBudgetExceededError)

      // We expect to hit the cap somewhere between calls 3-5 (5 describes
      // each at $0.0105 = $0.0525 total > $0.05 cap).
      const spent = tracker.getSpentUsd()
      expect(spent).toBeGreaterThan(0.05)
    })

    it('honours generous cap (under-budget pass): 30 sonnet 4.5 calls @ 1000+500 fits in $10', async () => {
      const tracker = new CloneProCostTracker({ maxUsd: 10 })
      // Synthesize 30 callable screenshots + 1 consolidate = 31 vision calls.
      const screenshots: Record<string, string> = {}
      const downloads: Record<string, Buffer> = {}
      for (let i = 0; i < 30; i++) {
        screenshots[`home-desktop-${i}`] = `k/${i}.png`
        downloads[`k/${i}.png`] = Buffer.from(String(i))
      }

      const callVision: VisionCallFn = vi.fn().mockImplementation(async ({ source }) => {
        tracker.addClaude('claude-sonnet-4-5', 'stage14', 1000, 500)
        if (source === 'consolidate') return JSON.stringify(FULL_TOKENS)
        return JSON.stringify({})
      })

      const r = await extractDesignTokens({
        jobId: 'j',
        screenshotS3Keys: screenshots,
        downloadS3: fakeS3Download(downloads),
        callVision,
        tracker,
      })

      expect(r.tokens).not.toBeNull()
      // 31 × $0.0105 = $0.3255 — well under $10.
      expect(tracker.getSpentUsd()).toBeCloseTo(0.3255, 3)
    })
  })

  it('persistTokens called with valid tokens when extraction succeeds', async () => {
    const persistFn = vi.fn().mockResolvedValue({ shopId: 'shop-1' })
    const callVision: VisionCallFn = vi.fn().mockImplementation(async ({ source }) => {
      if (source === 'consolidate') return JSON.stringify(FULL_TOKENS)
      return JSON.stringify({})
    })
    const r = await extractDesignTokens({
      jobId: 'j',
      shopId: 'shop-1',
      screenshotS3Keys: { 'home-desktop': 'k/h.png' },
      downloadS3: fakeS3Download({ 'k/h.png': Buffer.from('x') }),
      callVision,
      persistTokens: persistFn,
    })
    expect(r.tokens).not.toBeNull()
    expect(persistFn).toHaveBeenCalledTimes(1)
    const args = persistFn.mock.calls[0][0]
    expect(args.shopId).toBe('shop-1')
    expect(args.tokens.fonts.primary.family).toBe('Cormorant Garamond')
    expect(args.s3Keys).toEqual({ 'home-desktop': 'k/h.png' })
  })
})
