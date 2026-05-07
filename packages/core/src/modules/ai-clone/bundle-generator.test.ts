/**
 * Gbox Platform — AI Clone bundle generator tests
 * (Landing Page System Phase 2.3)
 */

import { describe, expect, it } from 'vitest'
import { GBOX_DAWN_BUNDLE } from '../themes/seed/gbox-dawn-bundle.js'
import {
  generateBundleFromSpec,
  __testApplyCssPaletteOverride,
  __testPatchSettingsData,
  __testRewriteIndexTemplate,
  __testBuildCssTokens,
} from './bundle-generator.js'
import type { ThemeSpec } from './theme-spec.js'

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeSpec(overrides: Partial<ThemeSpec> = {}): ThemeSpec {
  return {
    brand: {
      name: 'Velocity',
      tagline: 'Go farther.',
      voice: 'Athletic, bold.',
    },
    palette: {
      primary: '#ff6600',
      secondary: '#0ea5e9',
      background: '#ffffff',
      surface: '#f4f4f5',
      text: '#111111',
      text_muted: '#6b7280',
      border: '#e5e7eb',
      success: '#16a34a',
      error: '#dc2626',
    },
    fonts: {
      heading_family: "'Playfair Display', serif",
      body_family: "'Inter', system-ui, sans-serif",
      heading_weight: '800',
      body_weight: '400',
      base_size: '16px',
      line_height: '1.5',
    },
    sections: [
      { type: 'header', heading: '', subheading: '', ctaLabel: '', imageHint: '' },
      {
        type: 'hero',
        heading: 'Run faster',
        subheading: 'Race-tested.',
        ctaLabel: 'Shop',
        imageHint: 'Studio shot',
      },
      {
        type: 'featured-products',
        heading: 'Best sellers',
        subheading: '',
        ctaLabel: 'View all',
        imageHint: '',
      },
      { type: 'footer', heading: '', subheading: '', ctaLabel: '', imageHint: '' },
    ],
    tags: ['athletic'],
    description: 'Bold athletic storefront.',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// generateBundleFromSpec — happy path
// ---------------------------------------------------------------------------

describe('generateBundleFromSpec', () => {
  it('clones every seed file into the output bundle', () => {
    const res = generateBundleFromSpec({
      spec: makeSpec(),
      sourceUrl: 'https://velocity.example/',
    })
    expect(Object.keys(res.files).length).toBe(GBOX_DAWN_BUNDLE.size)
    // Spot-check a few specific seed files survive
    expect(res.files['layout/theme.liquid']).toBeDefined()
    expect(res.files['sections/header.liquid']).toBeDefined()
  })

  it('emits a meta block with brand name + source url', () => {
    const res = generateBundleFromSpec({
      spec: makeSpec({ brand: { name: 'Velocity', tagline: '', voice: '' } }),
      sourceUrl: 'https://velocity.example/',
    })
    expect(res.meta.name).toContain('Velocity')
    expect(res.meta.description).toContain('https://velocity.example/')
    expect(res.meta.version.endsWith('-clone.1')).toBe(true)
    expect(res.meta.author).toBe('Gbox Theme Cloner')
  })

  it('applies CSS palette override to theme.css', () => {
    const res = generateBundleFromSpec({
      spec: makeSpec(),
      sourceUrl: 'https://x.io/',
    })
    const css = res.files['assets/theme.css']!
    expect(css).toContain('--color-accent: #ff6600;')
    expect(css).toContain('--color-bg: #ffffff;')
    expect(css).toContain('--color-fg: #111111;')
    expect(css).toContain('Gbox Theme Cloner override')
    // Seed content is preserved in full
    expect(css).toContain('Gbox Dawn — base theme stylesheet')
  })

  it('patches settings_data.json with the cloned palette', () => {
    const res = generateBundleFromSpec({
      spec: makeSpec(),
      sourceUrl: 'https://x.io/',
    })
    const settings = JSON.parse(res.files['config/settings_data.json']!)
    expect(settings.current.color_background).toBe('#ffffff')
    expect(settings.current.color_accent).toBe('#ff6600')
    expect(settings.presets.Cloned.color_accent).toBe('#ff6600')
    // Original Default preset must still exist
    expect(settings.presets.Default).toBeDefined()
  })

  it('rewrites templates/index.json from spec sections', () => {
    const res = generateBundleFromSpec({
      spec: makeSpec(),
      sourceUrl: 'https://x.io/',
    })
    const doc = JSON.parse(res.files['templates/index.json']!)
    expect(doc.order).toEqual(['header', 'hero', 'featured-products', 'footer'])
    expect(doc.sections.hero.type).toBe('hero')
    expect(doc.sections.hero.settings.heading).toBe('Run faster')
    expect(doc.sections.hero.settings.cta_label).toBe('Shop')
    expect(doc.sections['featured-products'].settings.heading).toBe('Best sellers')
  })

  it('disambiguates repeated section types with -N suffix', () => {
    const res = generateBundleFromSpec({
      spec: makeSpec({
        sections: [
          { type: 'header', heading: '', subheading: '', ctaLabel: '', imageHint: '' },
          { type: 'image-with-text', heading: 'A', subheading: '', ctaLabel: '', imageHint: '' },
          { type: 'image-with-text', heading: 'B', subheading: '', ctaLabel: '', imageHint: '' },
          { type: 'footer', heading: '', subheading: '', ctaLabel: '', imageHint: '' },
        ],
      }),
      sourceUrl: 'https://x.io/',
    })
    const doc = JSON.parse(res.files['templates/index.json']!)
    expect(doc.order).toEqual([
      'header',
      'image-with-text',
      'image-with-text-2',
      'footer',
    ])
    expect(doc.sections['image-with-text'].settings.heading).toBe('A')
    expect(doc.sections['image-with-text-2'].settings.heading).toBe('B')
  })

  it('is deterministic — same input → same output', () => {
    const a = generateBundleFromSpec({ spec: makeSpec(), sourceUrl: 'https://x/' })
    const b = generateBundleFromSpec({ spec: makeSpec(), sourceUrl: 'https://x/' })
    expect(JSON.stringify(a.files)).toBe(JSON.stringify(b.files))
    expect(a.meta).toEqual(b.meta)
  })

  it('supports custom version + author', () => {
    const res = generateBundleFromSpec({
      spec: makeSpec(),
      sourceUrl: 'https://x.io/',
      version: '2.3.1',
      author: 'QA Bot',
    })
    expect(res.meta.version).toBe('2.3.1')
    expect(res.meta.author).toBe('QA Bot')
  })
})

// ---------------------------------------------------------------------------
// CSS transform
// ---------------------------------------------------------------------------

describe('applyCssPaletteOverride', () => {
  it('appends a :root block after the original CSS', () => {
    const warnings: string[] = []
    const out = __testApplyCssPaletteOverride(
      ':root { --color-bg: #000; }',
      makeSpec(),
      warnings,
    )
    expect(warnings).toEqual([])
    expect(out.indexOf('Gbox Theme Cloner override')).toBeGreaterThan(
      out.indexOf('--color-bg: #000'),
    )
  })
})

describe('buildCssTokens', () => {
  it('maps spec palette + fonts to CSS custom properties', () => {
    const tokens = __testBuildCssTokens(makeSpec())
    expect(tokens['--color-accent']).toBe('#ff6600')
    expect(tokens['--color-primary']).toBe('#ff6600')
    expect(tokens['--color-fg']).toBe('#111111')
    expect(tokens['--font-body']).toBe("'Inter', system-ui, sans-serif")
    expect(tokens['--font-heading']).toBe("'Playfair Display', serif")
  })
})

// ---------------------------------------------------------------------------
// settings_data transform
// ---------------------------------------------------------------------------

describe('patchSettingsData', () => {
  it('preserves original keys it does not touch', () => {
    const warnings: string[] = []
    const input = JSON.stringify({
      current: {
        page_width: 1200,
        social_facebook: 'https://fb.com/x',
      },
      presets: { Default: {} },
    })
    const out = JSON.parse(
      __testPatchSettingsData(input, makeSpec(), warnings),
    )
    expect(out.current.page_width).toBe(1200)
    expect(out.current.social_facebook).toBe('https://fb.com/x')
    expect(out.current.color_accent).toBe('#ff6600')
  })

  it('falls back to a fresh scaffold on invalid JSON', () => {
    const warnings: string[] = []
    const out = JSON.parse(
      __testPatchSettingsData('not json', makeSpec(), warnings),
    )
    expect(warnings.some((w) => w.startsWith('settings_data_parse_failed'))).toBe(true)
    expect(out.current.color_accent).toBe('#ff6600')
    expect(out.presets.Default).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// index template transform
// ---------------------------------------------------------------------------

describe('rewriteIndexTemplate', () => {
  it('produces empty sections + order when spec has no sections', () => {
    const out = JSON.parse(
      __testRewriteIndexTemplate({
        ...makeSpec(),
        sections: [],
      }),
    )
    expect(out.sections).toEqual({})
    expect(out.order).toEqual([])
  })
})
