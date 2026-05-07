import { describe, it, expect } from 'vitest'
import { selectComponents, AVAILABLE_VARIANTS, normalizeVariant } from './component-builder.js'
import type { DesignTokens } from './token-schema.js'

const baseTokens: DesignTokens = {
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
  spacing: { base_unit: 8, scale: [8, 16, 32] },
  breakpoints: { mobile: 480, tablet: 768, desktop: 1024, wide: 1440 },
  components: {
    header: { height: 80, background: '#fff', variant: 'editorial' },
    product_card: { aspect_ratio: '3/4', border_radius: 0, variant: 'editorial' },
    button: { border_radius: 4, padding_x: 24, padding_y: 12, variant: 'pill' },
    navigation: { variant: 'horizontal', placement: 'top' },
  },
  layout: { container_max_width: 1240, grid_columns: 12, hero_pattern: 'editorial' },
  style_keywords: ['editorial'],
  aesthetic_score: 8.0,
}

describe('component-builder', () => {
  it('maps tokens to a manifest with hero/header/product_card/nav/footer slots', () => {
    const m = selectComponents(baseTokens)
    expect(m).toMatchObject({
      hero: 'editorial',
      // Header has no 'editorial' variant in the catalog; it translates to 'minimal'
      // (table choice — editorial header look is best approximated by the minimal layout).
      header: 'minimal',
      product_card: 'editorial',
      navigation: 'horizontal',
      footer: expect.any(String),
    })
  })

  it('translates fullbleed-image hero_pattern to fullbleed', () => {
    const tokens: DesignTokens = {
      ...baseTokens,
      layout: { ...baseTokens.layout, hero_pattern: 'fullbleed-image' },
    }
    const m = selectComponents(tokens)
    expect(m.hero).toBe('fullbleed')
  })

  it('translates split-text-image hero_pattern to split', () => {
    const tokens: DesignTokens = {
      ...baseTokens,
      layout: { ...baseTokens.layout, hero_pattern: 'split-text-image' },
    }
    const m = selectComponents(tokens)
    expect(m.hero).toBe('split')
  })

  it('translates video-bg hero_pattern to video-bg', () => {
    const tokens: DesignTokens = {
      ...baseTokens,
      layout: { ...baseTokens.layout, hero_pattern: 'video-bg' },
    }
    const m = selectComponents(tokens)
    expect(m.hero).toBe('video-bg')
  })

  it('falls back to "minimal" when hero_pattern is unrecognised (e.g. product-grid)', () => {
    const tokens: DesignTokens = {
      ...baseTokens,
      layout: { ...baseTokens.layout, hero_pattern: 'this-is-not-a-real-variant' },
    }
    const m = selectComponents(tokens)
    expect(m.hero).toBe('minimal')
  })

  it('falls back to "classic" when product_card variant is unrecognised', () => {
    const tokens: DesignTokens = {
      ...baseTokens,
      components: {
        ...baseTokens.components,
        product_card: { ...baseTokens.components.product_card, variant: 'something-weird' },
      },
    }
    const m = selectComponents(tokens)
    expect(m.product_card).toBe('classic')
  })

  it('respects style_keywords hint when picking footer variant (editorial → editorial)', () => {
    const tokens: DesignTokens = {
      ...baseTokens,
      style_keywords: ['editorial', 'serif-typography'],
    }
    const m = selectComponents(tokens)
    expect(m.footer).toBe('editorial')
  })

  it('returns "minimal" footer for short style_keywords / non-editorial sites', () => {
    const tokens: DesignTokens = {
      ...baseTokens,
      style_keywords: ['minimal', 'sparse'],
    }
    const m = selectComponents(tokens)
    expect(m.footer).toBe('minimal')
  })

  it('exposes the AVAILABLE_VARIANTS catalog (used by Stage 15 to validate include paths)', () => {
    expect(AVAILABLE_VARIANTS.hero).toEqual(
      expect.arrayContaining(['fullbleed', 'split', 'editorial', 'minimal', 'video-bg']),
    )
    expect(AVAILABLE_VARIANTS.product_card).toEqual(
      expect.arrayContaining(['classic', 'editorial', 'minimal', 'overlay', 'list']),
    )
    expect(AVAILABLE_VARIANTS.header.length).toBeGreaterThanOrEqual(4)
    expect(AVAILABLE_VARIANTS.footer.length).toBeGreaterThanOrEqual(3)
    expect(AVAILABLE_VARIANTS.nav.length).toBeGreaterThanOrEqual(3)
  })

  it('normalizeVariant strips spaces and lowercases', () => {
    expect(normalizeVariant('Fullbleed-Image')).toBe('fullbleed-image')
    expect(normalizeVariant('  EDITORIAL  ')).toBe('editorial')
  })
})
