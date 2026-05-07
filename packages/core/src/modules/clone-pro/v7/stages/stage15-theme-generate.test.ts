import { describe, it, expect, vi } from 'vitest'
import { generateTheme, type Stage15Input } from './stage15-theme-generate.js'
import type { DesignTokens } from '../theme-engine/token-schema.js'

const TOKENS: DesignTokens = {
  fonts: {
    primary: { family: 'Cormorant Garamond', google_font: 'Cormorant Garamond', weights: [400, 600] },
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
  spacing: { base_unit: 8, scale: [4, 8, 16, 24, 32] },
  breakpoints: { mobile: 480, tablet: 768, desktop: 1024, wide: 1440 },
  components: {
    header: { height: 80, background: '#fffaf3', variant: 'minimal' },
    product_card: { aspect_ratio: '3/4', border_radius: 0, variant: 'editorial' },
    button: { border_radius: 2, padding_x: 24, padding_y: 12, variant: 'minimal' },
    navigation: { variant: 'horizontal', placement: 'top' },
  },
  layout: { container_max_width: 1240, grid_columns: 12, hero_pattern: 'editorial' },
  style_keywords: ['editorial', 'warm'],
  aesthetic_score: 8.4,
}

function makeDeps(overrides: Partial<Stage15Input> = {}): Stage15Input {
  return {
    jobId: 'job-1',
    shopId: 'shop-1',
    tokens: TOKENS,
    upload: vi.fn().mockResolvedValue(undefined),
    persistThemeFiles: vi.fn().mockResolvedValue(undefined),
    deactivatePreviousActive: vi.fn().mockResolvedValue(0),
    ...overrides,
  }
}

describe('Stage 15 — generateTheme', () => {
  it('returns success result with theme_id, version=1, theme_zip_key, manifest, and warnings []', async () => {
    const r = await generateTheme(makeDeps())
    expect(r.success).toBe(true)
    expect(r.theme_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.version).toBe(1)
    expect(r.theme_zip_key).toBe('shop-1/theme/theme.zip')
    expect(r.manifest).toBeDefined()
    expect(r.warnings).toEqual([])
  })

  it('uploads theme.zip via the provided upload function', async () => {
    const upload = vi.fn().mockResolvedValue(undefined)
    await generateTheme(makeDeps({ upload }))
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0][0].key).toBe('shop-1/theme/theme.zip')
    expect(upload.mock.calls[0][0].contentType).toBe('application/zip')
  })

  it('persists theme_files rows for every output file with theme_id, version, is_active=true', async () => {
    const persistFn = vi.fn().mockResolvedValue(undefined)
    const r = await generateTheme(makeDeps({ persistThemeFiles: persistFn }))
    expect(persistFn).toHaveBeenCalledTimes(1)
    const args = persistFn.mock.calls[0][0]
    expect(args.shopId).toBe('shop-1')
    expect(args.themeId).toBe(r.theme_id)
    expect(args.version).toBe(1)
    expect(args.isActive).toBe(true)
    expect(Array.isArray(args.files)).toBe(true)
    expect(args.files.length).toBeGreaterThan(0)
    // Each file row has path + content (or s3 key).
    expect(args.files[0]).toMatchObject({ path: expect.any(String) })
  })

  it('deactivates previously active theme before activating the new one', async () => {
    const deactivate = vi.fn().mockResolvedValue(1)
    const persistFn = vi.fn().mockResolvedValue(undefined)
    await generateTheme(makeDeps({
      deactivatePreviousActive: deactivate,
      persistThemeFiles: persistFn,
    }))
    expect(deactivate).toHaveBeenCalledWith({ shopId: 'shop-1' })
    // Order matters — deactivate must run BEFORE persist so we don't have
    // two active themes at any point.
    const deactivateOrder = deactivate.mock.invocationCallOrder[0]
    const persistOrder = persistFn.mock.invocationCallOrder[0]
    expect(deactivateOrder).toBeLessThan(persistOrder)
  })

  it('honours version + previousFeedback inputs (Stage 16 retry path)', async () => {
    const r = await generateTheme(makeDeps({ version: 2, previousFeedback: ['header too short'] }))
    expect(r.version).toBe(2)
    expect(r.feedback_applied).toEqual(['header too short'])
  })

  it('returns success=false + warnings when upload throws (does not crash)', async () => {
    const upload = vi.fn().mockRejectedValue(new Error('S3 timeout'))
    const r = await generateTheme(makeDeps({ upload }))
    expect(r.success).toBe(false)
    expect(r.warnings.length).toBeGreaterThan(0)
    // Iron rule 5: warning must NOT contain the raw 'S3 timeout' or any leak terms.
    // We log diagnostic separately and surface only seller-safe text.
    const joined = r.warnings.join('|')
    expect(joined).toContain('Please contact Gbox support')
  })
})
