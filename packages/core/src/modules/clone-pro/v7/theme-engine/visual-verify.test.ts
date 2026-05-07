import { describe, it, expect, vi } from 'vitest'
import {
  visualVerify,
  buildVisualDiffPrompt,
  parseClaudeVerdict,
  type VisualVerifyDeps,
} from './visual-verify.js'

describe('parseClaudeVerdict', () => {
  it('extracts score from a JSON object response', () => {
    const out = parseClaudeVerdict('{"score": 8.4, "issues": ["nothing"]}')
    expect(out.score).toBe(8.4)
    expect(out.issues).toEqual(['nothing'])
  })

  it('strips markdown fences before parsing', () => {
    const fenced = '```json\n{"score": 5.5, "issues": ["header too short"]}\n```'
    const out = parseClaudeVerdict(fenced)
    expect(out.score).toBe(5.5)
    expect(out.issues).toContain('header too short')
  })

  it('returns score=0 + the raw text as a single issue when JSON parse fails', () => {
    const out = parseClaudeVerdict('not json — total mess')
    expect(out.score).toBe(0)
    expect(out.issues.length).toBeGreaterThan(0)
  })

  it('clamps score to [0,10] range when Claude returns a wonky value', () => {
    expect(parseClaudeVerdict('{"score": 99}').score).toBe(10)
    expect(parseClaudeVerdict('{"score": -5}').score).toBe(0)
  })

  it('issues defaults to [] when missing', () => {
    expect(parseClaudeVerdict('{"score": 7}').issues).toEqual([])
  })
})

describe('buildVisualDiffPrompt', () => {
  it('builds a prompt that mentions both source + clone screenshots and a 0-10 score scale', () => {
    const p = buildVisualDiffPrompt({ pageLabel: 'home-desktop', previousFeedback: [] })
    expect(p).toMatch(/source/i)
    expect(p).toMatch(/clone/i)
    expect(p).toMatch(/0[-–]10/)
    expect(p).toMatch(/JSON/)
  })

  it('includes previous feedback when provided (retry path)', () => {
    const p = buildVisualDiffPrompt({
      pageLabel: 'home-desktop',
      previousFeedback: ['Header is too short — increase header.height token'],
    })
    expect(p).toContain('Header is too short')
  })

  it('omits the feedback block when previousFeedback is empty', () => {
    const p = buildVisualDiffPrompt({ pageLabel: 'home-desktop', previousFeedback: [] })
    expect(p).not.toMatch(/PREVIOUS\s+FEEDBACK/i)
  })
})

describe('visualVerify', () => {
  const deps = (overrides: Partial<VisualVerifyDeps> = {}): VisualVerifyDeps => ({
    captureClone: vi.fn().mockResolvedValue({
      'home-desktop': 'clone-key/home-d.png',
      'pdp-desktop': 'clone-key/pdp-d.png',
    }),
    downloadS3: vi.fn().mockImplementation(async (k: string) => Buffer.from(`png-${k}`)),
    callVision: vi.fn().mockResolvedValue('{"score": 8.5, "issues": []}'),
    ...overrides,
  })

  it('captures clone screenshots, calls Claude per page, returns avg score and per-page breakdown', async () => {
    const r = await visualVerify({
      sourceScreenshotS3Keys: {
        'home-desktop': 'src-key/home-d.png',
        'pdp-desktop': 'src-key/pdp-d.png',
      },
      cloneUrl: 'https://shop-1.gbox.co',
      shopSlug: 'shop-1',
      previousFeedback: [],
      ...deps(),
    })

    expect(r.score).toBeCloseTo(8.5)
    expect(r.passed).toBe(true)
    expect(r.feedback).toEqual([])
    expect(r.per_page['home-desktop'].score).toBe(8.5)
    expect(r.per_page['pdp-desktop'].score).toBe(8.5)
    expect(r.clone_screenshot_keys).toEqual({
      'home-desktop': 'clone-key/home-d.png',
      'pdp-desktop': 'clone-key/pdp-d.png',
    })
  })

  it('marks passed=false + collects feedback when avg score < 7', async () => {
    const callVision = vi.fn()
      .mockResolvedValueOnce('{"score": 6.0, "issues": ["header too short"]}')
      .mockResolvedValueOnce('{"score": 5.0, "issues": ["product card looks generic"]}')

    const r = await visualVerify({
      sourceScreenshotS3Keys: {
        'home-desktop': 'src/h.png',
        'pdp-desktop': 'src/p.png',
      },
      cloneUrl: 'https://shop-2.gbox.co',
      shopSlug: 'shop-2',
      previousFeedback: [],
      ...deps({ callVision }),
    })

    expect(r.score).toBe(5.5)
    expect(r.passed).toBe(false)
    expect(r.feedback).toEqual(expect.arrayContaining([
      'header too short',
      'product card looks generic',
    ]))
  })

  it('skips a page (warning) when source screenshot S3 download fails', async () => {
    const downloadS3 = vi.fn()
      .mockImplementationOnce(async () => { throw new Error('NoSuchKey') })
      .mockResolvedValue(Buffer.from('ok'))

    const r = await visualVerify({
      sourceScreenshotS3Keys: {
        'home-desktop': 'src/missing.png',
        'pdp-desktop': 'src/p.png',
      },
      cloneUrl: 'https://shop-3.gbox.co',
      shopSlug: 'shop-3',
      previousFeedback: [],
      ...deps({ downloadS3 }),
    })

    expect(r.warnings.some((w) => w.includes('home-desktop'))).toBe(true)
    // The other page should still be scored.
    expect(r.per_page['pdp-desktop']).toBeDefined()
  })

  it('returns score=0 + passed=false when ALL pages fail capture (graceful degradation)', async () => {
    const downloadS3 = vi.fn().mockRejectedValue(new Error('S3 down'))

    const r = await visualVerify({
      sourceScreenshotS3Keys: { 'home-desktop': 'src/h.png' },
      cloneUrl: 'https://shop-4.gbox.co',
      shopSlug: 'shop-4',
      previousFeedback: [],
      ...deps({ downloadS3 }),
    })

    expect(r.score).toBe(0)
    expect(r.passed).toBe(false)
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('passes previousFeedback into the prompt builder for follow-up iterations', async () => {
    const callVision = vi.fn().mockResolvedValue('{"score": 8, "issues": []}')

    await visualVerify({
      sourceScreenshotS3Keys: { 'home-desktop': 'src/h.png' },
      cloneUrl: 'https://shop-5.gbox.co',
      shopSlug: 'shop-5',
      previousFeedback: ['header was too short last time'],
      ...deps({ callVision }),
    })

    // The prompt sent to Claude should include the feedback string.
    const promptArg = (callVision as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt as string
    expect(promptArg).toContain('header was too short last time')
  })
})
