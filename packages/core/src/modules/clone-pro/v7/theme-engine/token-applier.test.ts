import { describe, it, expect } from 'vitest'
import { applyTokens } from './token-applier.js'
import type { DesignTokens } from './token-schema.js'

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

describe('token-applier', () => {
  it('emits a :root block containing all required CSS variables for full tokens', () => {
    const r = applyTokens(FULL_TOKENS)
    expect(r.css).toMatch(/:root\s*\{/)
    expect(r.css).toMatch(/--font-primary:\s*'Cormorant Garamond'/)
    expect(r.css).toMatch(/--color-primary:\s*#3b2f2f/)
    expect(r.css).toMatch(/--color-background:\s*#fffaf3/)
    expect(r.css).toMatch(/--color-foreground:\s*#241a1a/)
    expect(r.css).toMatch(/--color-accent:\s*#c98a4b/)
    expect(r.css).toMatch(/--color-muted:\s*#a89f96/)
    expect(r.css).toMatch(/--space-base:\s*8px/)
    expect(r.css).toMatch(/--container-max:\s*1240px/)
    expect(r.css).toMatch(/--button-radius:\s*2px/)
    expect(r.css).toMatch(/--button-padding-x:\s*24px/)
    expect(r.css).toMatch(/--button-padding-y:\s*12px/)
    expect(r.css).toMatch(/--card-radius:\s*0/)
    expect(r.css).toMatch(/--header-height:\s*80px/)
  })

  it('falls back to font.family when google_font is null (system font case)', () => {
    const tokens: DesignTokens = {
      ...FULL_TOKENS,
      fonts: {
        primary: { family: 'Helvetica Neue', google_font: null, weights: [400] },
        secondary: null,
      },
    }
    const r = applyTokens(tokens)
    expect(r.css).toMatch(/--font-primary:\s*'Helvetica Neue'/)
    // No Google fonts URL when no google_font
    expect(r.liquid_vars.font_primary_url).toBe('')
  })

  it('emits a Google Fonts URL when google_font is present (single + multi family)', () => {
    const r = applyTokens(FULL_TOKENS)
    expect(r.liquid_vars.font_primary_url).toMatch(/^https:\/\/fonts\.googleapis\.com\/css2\?/)
    expect(r.liquid_vars.font_primary_url).toMatch(/family=Cormorant\+Garamond/)
    // Both primary + secondary should be in the URL when both have google_font.
    expect(r.liquid_vars.font_primary_url).toMatch(/family=Inter/)
    // Weights wired into URL.
    expect(r.liquid_vars.font_primary_url).toMatch(/wght@400/)
  })

  it('passes hex color through unchanged when valid 6-digit (preserves case)', () => {
    // Source has lowercase #3b2f2f → output must keep lowercase. Schema
    // accepts mixed case but applier should not normalise — that would
    // break Stage 16 visual diff if Claude sampled an exact uppercase hex.
    const r = applyTokens(FULL_TOKENS)
    expect(r.css).toMatch(/--color-primary:\s*#3b2f2f/)
    // Try with explicit uppercase input to confirm case is preserved both ways.
    const upper = applyTokens({ ...FULL_TOKENS, colors: { ...FULL_TOKENS.colors, primary: '#ABCDEF' } })
    expect(upper.css).toMatch(/--color-primary:\s*#ABCDEF/)
  })

  it('handles null accent + null muted (falls back to "transparent" / "currentColor" defaults)', () => {
    const tokens: DesignTokens = {
      ...FULL_TOKENS,
      colors: { ...FULL_TOKENS.colors, accent: null, muted: null },
    }
    const r = applyTokens(tokens)
    // Optional colors get explicit fallback strings so theme.css doesn't crash CSS parser.
    expect(r.css).toMatch(/--color-accent:\s*transparent/)
    expect(r.css).toMatch(/--color-muted:\s*currentColor/)
  })

  it('exports liquid_vars dict matching CSS values for downstream Liquid rendering', () => {
    const r = applyTokens(FULL_TOKENS)
    expect(r.liquid_vars.font_primary).toBe('Cormorant Garamond')
    expect(r.liquid_vars.color_primary).toBe('#3b2f2f')
    expect(r.liquid_vars.color_background).toBe('#fffaf3')
    expect(r.liquid_vars.layout_container_max_width).toBe('1240')
    expect(r.liquid_vars.layout_grid_columns).toBe('12')
    expect(r.liquid_vars.component_hero_variant).toBe('split-text-image')
  })

  it('passes component variants through as liquid_vars (header / product_card / nav / footer)', () => {
    const r = applyTokens(FULL_TOKENS)
    expect(r.liquid_vars.component_header_variant).toBe('editorial')
    expect(r.liquid_vars.component_product_card_variant).toBe('editorial')
    expect(r.liquid_vars.component_nav_variant).toBe('horizontal')
    // footer variant has no token field; falls back to 'classic'
    expect(r.liquid_vars.component_footer_variant).toBe('classic')
  })

  it('emits a media-query block for breakpoints', () => {
    const r = applyTokens(FULL_TOKENS)
    expect(r.css).toMatch(/--bp-mobile:\s*480px/)
    expect(r.css).toMatch(/--bp-tablet:\s*768px/)
    expect(r.css).toMatch(/--bp-desktop:\s*1024px/)
    expect(r.css).toMatch(/--bp-wide:\s*1440px/)
  })

  it('emits a spacing scale series (--space-1 .. --space-N) from tokens.spacing.scale', () => {
    const r = applyTokens(FULL_TOKENS)
    expect(r.css).toMatch(/--space-1:\s*4px/)
    expect(r.css).toMatch(/--space-2:\s*8px/)
    expect(r.css).toMatch(/--space-3:\s*16px/)
    expect(r.css).toMatch(/--space-4:\s*24px/)
    expect(r.css).toMatch(/--space-5:\s*32px/)
  })
})
