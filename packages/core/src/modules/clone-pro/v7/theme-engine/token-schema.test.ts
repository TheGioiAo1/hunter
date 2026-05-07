import { describe, it, expect } from 'vitest'
import { DesignTokensSchema, type DesignTokens } from './token-schema.js'

const validTokens: DesignTokens = {
  fonts: {
    primary: { family: 'Cormorant Garamond', google_font: 'Cormorant Garamond', weights: [400, 600] },
    secondary: { family: 'Inter', google_font: 'Inter', weights: [400, 500] },
  },
  colors: {
    primary: '#3b2f2f',
    secondary: '#f5ebe0',
    accent: '#c98a4b',
    background: '#fffaf3',
    foreground: '#241a1a',
    muted: '#a89f96',
  },
  spacing: { base_unit: 8, scale: [4, 8, 16, 24, 32, 48] },
  breakpoints: { mobile: 480, tablet: 768, desktop: 1024, wide: 1440 },
  components: {
    header: { height: 80, background: '#fffaf3', variant: 'editorial' },
    product_card: { aspect_ratio: '3/4', border_radius: 0, variant: 'editorial' },
    button: { border_radius: 2, padding_x: 24, padding_y: 12, variant: 'minimal' },
    navigation: { variant: 'horizontal', placement: 'top' },
  },
  layout: {
    container_max_width: 1240,
    grid_columns: 12,
    hero_pattern: 'split-text-image',
  },
  style_keywords: ['editorial', 'warm', 'serif-typography', 'literary'],
  aesthetic_score: 8.4,
}

describe('DesignTokensSchema', () => {
  it('accepts a fully-populated valid token set', () => {
    const r = DesignTokensSchema.safeParse(validTokens)
    expect(r.success).toBe(true)
  })

  it('accepts secondary font as null', () => {
    const r = DesignTokensSchema.safeParse({
      ...validTokens,
      fonts: { ...validTokens.fonts, secondary: null },
    })
    expect(r.success).toBe(true)
  })

  it('rejects 3-digit hex on primary color (must be 6-digit)', () => {
    const r = DesignTokensSchema.safeParse({
      ...validTokens,
      colors: { ...validTokens.colors, primary: '#abc' },
    })
    expect(r.success).toBe(false)
  })

  it('accepts uppercase hex codes', () => {
    const r = DesignTokensSchema.safeParse({
      ...validTokens,
      colors: { ...validTokens.colors, primary: '#3B2F2F' },
    })
    expect(r.success).toBe(true)
  })

  it('rejects non-hex primary color', () => {
    const r = DesignTokensSchema.safeParse({
      ...validTokens,
      colors: { ...validTokens.colors, primary: 'rgb(0,0,0)' },
    })
    expect(r.success).toBe(false)
  })

  it('rejects aesthetic_score above 10', () => {
    const r = DesignTokensSchema.safeParse({ ...validTokens, aesthetic_score: 11 })
    expect(r.success).toBe(false)
  })

  it('rejects aesthetic_score below 0', () => {
    const r = DesignTokensSchema.safeParse({ ...validTokens, aesthetic_score: -1 })
    expect(r.success).toBe(false)
  })

  it('accepts decimal aesthetic_score', () => {
    const r = DesignTokensSchema.safeParse({ ...validTokens, aesthetic_score: 7.3 })
    expect(r.success).toBe(true)
  })

  it('rejects accent color as undefined (must be string or null)', () => {
    const bad = JSON.parse(JSON.stringify(validTokens)) as any
    delete bad.colors.accent
    const r = DesignTokensSchema.safeParse(bad)
    expect(r.success).toBe(false)
  })

  it('rejects empty spacing.scale array', () => {
    const r = DesignTokensSchema.safeParse({
      ...validTokens,
      spacing: { base_unit: 8, scale: [] },
    })
    expect(r.success).toBe(false)
  })

  it('rejects when style_keywords is not an array', () => {
    const r = DesignTokensSchema.safeParse({ ...validTokens, style_keywords: 'editorial' })
    expect(r.success).toBe(false)
  })

  it('accepts breakpoint ordering at any numeric values', () => {
    const r = DesignTokensSchema.safeParse({
      ...validTokens,
      breakpoints: { mobile: 320, tablet: 600, desktop: 900, wide: 1200 },
    })
    expect(r.success).toBe(true)
  })

  it('rejects component header without variant field', () => {
    const bad = JSON.parse(JSON.stringify(validTokens)) as any
    delete bad.components.header.variant
    const r = DesignTokensSchema.safeParse(bad)
    expect(r.success).toBe(false)
  })

  it('rejects when fonts.primary.weights is empty', () => {
    const r = DesignTokensSchema.safeParse({
      ...validTokens,
      fonts: {
        ...validTokens.fonts,
        primary: { family: 'Inter', google_font: 'Inter', weights: [] },
      },
    })
    expect(r.success).toBe(false)
  })

  it('rejects when google_font is empty string (must be string-with-content or null)', () => {
    const r = DesignTokensSchema.safeParse({
      ...validTokens,
      fonts: {
        ...validTokens.fonts,
        primary: { family: 'Inter', google_font: '', weights: [400] },
      },
    })
    expect(r.success).toBe(false)
  })
})
