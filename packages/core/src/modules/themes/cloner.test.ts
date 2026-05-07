/**
 * Gbox Platform — Theme cloner extractor tests (Stage 3G.3)
 *
 * The cloner is the offline / deterministic layer that sits
 * underneath Module G (Theme Cloner). The live crawl + Claude
 * API hop is entrypoint glue — THIS module is pure analysis of
 * an already-fetched HTML + CSS string, so it can run in CI
 * without the network.
 *
 * The tests here pin:
 *
 *   • `extractColorPalette` finds every canonical `#rrggbb` /
 *     `rgb()` / CSS custom property value in the CSS string.
 *   • Common semantic keys map predictably ("primary", "bg",
 *     "text", "border") even when the merchant's source uses a
 *     different naming convention.
 *   • `extractFontConfig` picks up `font-family` and `font-size`
 *     declarations, with a safe fallback when nothing is present.
 *   • `extractSectionHints` finds the obvious layout landmarks
 *     (`<header>`, `<nav>`, `<main>`, `<section class="hero">`,
 *     `<footer>`) and skips hidden / script content.
 *   • `buildCloneReport` composes the three extractors into a
 *     single report + similarity score that is deterministic.
 */

import { describe, it, expect } from 'vitest'
import {
  extractColorPalette,
  extractFontConfig,
  extractSectionHints,
  buildCloneReport,
  DEFAULT_FONT_CONFIG,
} from './cloner.js'

// ---------------------------------------------------------------------------
// extractColorPalette
// ---------------------------------------------------------------------------

describe('extractColorPalette', () => {
  it('finds hex colors in CSS custom properties', () => {
    const css = `
      :root {
        --color-primary: #ff6600;
        --color-bg: #ffffff;
        --color-text: #111111;
        --color-border: #e4e4e4;
      }
    `
    const palette = extractColorPalette(css)
    expect(palette.primary).toBe('#ff6600')
    expect(palette.background).toBe('#ffffff')
    expect(palette.text).toBe('#111111')
    expect(palette.border).toBe('#e4e4e4')
  })

  it('normalises hex shorthand (#f60) to #ff6600', () => {
    const css = `:root { --color-primary: #f60 }`
    const palette = extractColorPalette(css)
    expect(palette.primary).toBe('#ff6600')
  })

  it('parses rgb()/rgba() and returns canonical hex', () => {
    const css = `
      .btn { background: rgb(255, 102, 0) }
      body { color: rgba(17, 17, 17, 1) }
    `
    const palette = extractColorPalette(css)
    // At minimum the first color seen is surfaced as the primary
    // candidate when no :root tokens are available.
    expect(palette.primary).toBe('#ff6600')
    expect(palette.text).toBe('#111111')
  })

  it('returns a complete palette even when the CSS is empty', () => {
    const palette = extractColorPalette('')
    expect(palette.primary).toMatch(/^#[0-9a-f]{6}$/)
    expect(palette.background).toMatch(/^#[0-9a-f]{6}$/)
    expect(palette.text).toMatch(/^#[0-9a-f]{6}$/)
    expect(palette.border).toMatch(/^#[0-9a-f]{6}$/)
    expect(palette.success).toMatch(/^#[0-9a-f]{6}$/)
    expect(palette.error).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('prefers named tokens over body declarations when both exist', () => {
    const css = `
      body { color: #123456; background: #abcdef }
      :root {
        --color-primary: #ff0000;
        --color-text: #000000;
      }
    `
    const palette = extractColorPalette(css)
    expect(palette.primary).toBe('#ff0000')
    expect(palette.text).toBe('#000000')
  })

  it('ignores values that are not valid colors', () => {
    const css = `.x { color: notacolor }`
    const palette = extractColorPalette(css)
    // Fall back to the default — ignoring the invalid value.
    expect(palette.text).toMatch(/^#[0-9a-f]{6}$/)
  })
})

// ---------------------------------------------------------------------------
// extractFontConfig
// ---------------------------------------------------------------------------

describe('extractFontConfig', () => {
  it('picks up heading + body font families from CSS', () => {
    const css = `
      body { font-family: "Inter", system-ui, sans-serif; font-size: 16px; line-height: 1.6 }
      h1, h2, h3 { font-family: "Playfair Display", Georgia, serif; font-weight: 700 }
    `
    const cfg = extractFontConfig(css)
    expect(cfg.body_family).toContain('Inter')
    expect(cfg.heading_family).toContain('Playfair Display')
    expect(cfg.base_size).toBe('16px')
    expect(cfg.line_height).toBe('1.6')
    expect(cfg.heading_weight).toBe('700')
  })

  it('falls back to DEFAULT_FONT_CONFIG when nothing is declared', () => {
    const cfg = extractFontConfig('')
    expect(cfg).toEqual(DEFAULT_FONT_CONFIG)
  })

  it('uses the body family when no heading-specific selector exists', () => {
    const css = `body { font-family: "Roboto", sans-serif }`
    const cfg = extractFontConfig(css)
    expect(cfg.body_family).toContain('Roboto')
    expect(cfg.heading_family).toContain('Roboto')
  })
})

// ---------------------------------------------------------------------------
// extractSectionHints
// ---------------------------------------------------------------------------

describe('extractSectionHints', () => {
  it('finds header, nav, hero section, main, and footer landmarks', () => {
    const html = `
      <html><body>
        <header><nav>home</nav></header>
        <section class="hero">Big banner</section>
        <main>
          <section class="featured-grid">cards</section>
        </main>
        <footer>copyright</footer>
      </body></html>
    `
    const hints = extractSectionHints(html)
    const types = hints.map((h) => h.type)
    expect(types).toContain('header')
    expect(types).toContain('nav')
    expect(types).toContain('hero')
    expect(types).toContain('main')
    expect(types).toContain('footer')
  })

  it('returns an empty list for empty input', () => {
    expect(extractSectionHints('')).toEqual([])
  })

  it('skips <script> and <style> content when scanning for sections', () => {
    const html = `
      <script>const x = '<section class="hero">fake</section>'</script>
      <style>.hero { display: none }</style>
      <body></body>
    `
    const hints = extractSectionHints(html)
    expect(hints.every((h) => h.type !== 'hero')).toBe(true)
  })

  it('recognises section class names used in the masterplan', () => {
    const html = `
      <section class="featured-products">one</section>
      <section class="testimonials">two</section>
      <section class="newsletter">three</section>
    `
    const types = extractSectionHints(html).map((h) => h.type)
    expect(types).toContain('featured-products')
    expect(types).toContain('testimonials')
    expect(types).toContain('newsletter')
  })
})

// ---------------------------------------------------------------------------
// buildCloneReport
// ---------------------------------------------------------------------------

describe('buildCloneReport', () => {
  it('composes palette + fonts + sections into a single report', () => {
    const html = `
      <body>
        <header><nav>x</nav></header>
        <section class="hero">banner</section>
        <footer>bye</footer>
      </body>
    `
    const css = `
      :root { --color-primary: #00bfa5; --color-bg: #ffffff; --color-text: #222222 }
      body { font-family: Inter, sans-serif; font-size: 16px }
      h1 { font-family: Merriweather, serif; font-weight: 800 }
    `
    const report = buildCloneReport(html, css)
    expect(report.palette.primary).toBe('#00bfa5')
    expect(report.palette.background).toBe('#ffffff')
    expect(report.fonts.body_family).toContain('Inter')
    expect(report.fonts.heading_family).toContain('Merriweather')
    expect(report.sections.map((s) => s.type)).toEqual(
      expect.arrayContaining(['header', 'nav', 'hero', 'footer']),
    )
    expect(report.score).toBeGreaterThan(0)
    expect(report.score).toBeLessThanOrEqual(100)
  })

  it('flags warnings when HTML or CSS is empty', () => {
    const report = buildCloneReport('', '')
    expect(report.warnings.length).toBeGreaterThan(0)
    expect(report.score).toBeLessThan(50)
  })

  it('is deterministic — same input yields identical output', () => {
    const html = `<header><nav>x</nav></header><section class="hero">y</section>`
    const css = `:root { --color-primary: #f00 }`
    const a = buildCloneReport(html, css)
    const b = buildCloneReport(html, css)
    expect(b).toEqual(a)
  })
})
