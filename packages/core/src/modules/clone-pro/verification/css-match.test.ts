/**
 * Clone Pro v4 — CSS Class Match tests
 *
 * Behaviour we care about:
 *   - Full class preservation → 100%
 *   - Some classes lost → score == weighted ratio
 *   - Liquid-only classes are ignored (can't compare)
 *   - Missing Phase 2 template → skipped (no row added)
 *   - Score is weighted by source-class count across templates
 */

import { describe, it, expect } from 'vitest'
import { runCssMatchCheck } from './css-match.js'
import type { DetectedTemplate } from '../discovery/template-detector.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTemplate(
  pageType: string,
  templateName: string,
  html: string,
): DetectedTemplate {
  return {
    pageType,
    templateName,
    samplePage: {
      url: `https://example.com/${pageType}`,
      title: pageType,
      html,
      score: 100,
      reason: 'test',
    },
    allCandidates: [],
    count: 1,
    hasVariants: false,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runCssMatchCheck', () => {
  it('returns 100 when every source class appears in the output template', () => {
    const sourceHtml = '<div class="product-page"><h1 class="product-title hero-big">T</h1></div>'
    const outputHtml = '<div class="product-page"><h1 class="product-title hero-big">{{ product.title }}</h1></div>'

    const result = runCssMatchCheck({
      templates: [makeTemplate('product', 'templates/product.liquid', sourceHtml)],
      writtenTemplates: { 'templates/product.liquid': outputHtml },
    })
    expect(result.score).toBe(100)
    expect(result.passed).toBe(true)
  })

  it('scores proportional to the fraction of preserved classes', () => {
    // Source has 4 classes: a, b, c, d — output kept 2.
    const sourceHtml = `
      <div class="a b"><span class="c d">x</span></div>
    `
    const outputHtml = '<div class="a b">{{ x }}</div>'
    const result = runCssMatchCheck({
      templates: [makeTemplate('product', 'templates/product.liquid', sourceHtml)],
      writtenTemplates: { 'templates/product.liquid': outputHtml },
    })
    // 2/4 = 50%
    expect(result.score).toBe(50)
    expect(result.passed).toBe(false)
  })

  it('ignores Liquid-interpolated class values', () => {
    const sourceHtml = '<div class="product-page">x</div>'
    // Output contains a Liquid-interpolated class and the preserved literal.
    const outputHtml = '<div class="product-page {% if product.available %}in-stock{% endif %}">{{ product.title }}</div>'
    const result = runCssMatchCheck({
      templates: [makeTemplate('product', 'templates/product.liquid', sourceHtml)],
      writtenTemplates: { 'templates/product.liquid': outputHtml },
    })
    // The Liquid snippet gets ignored; `product-page` is kept → 100%.
    expect(result.score).toBe(100)
  })

  it('skips detected templates that were not written by Phase 2', () => {
    const result = runCssMatchCheck({
      templates: [
        makeTemplate('product', 'templates/product.liquid', '<div class="a">x</div>'),
        makeTemplate('collection', 'templates/collection.liquid', '<div class="b">x</div>'),
      ],
      writtenTemplates: {
        // Only product was written.
        'templates/product.liquid': '<div class="a">{{ product }}</div>',
      },
    })
    // Only the product template contributes — 1/1 = 100%.
    expect(result.score).toBe(100)
    // Only one finding (one row).
    const perTemplateFindings = result.findings.filter((f) => f.context?.templateName)
    expect(perTemplateFindings.length).toBe(1)
  })

  it('weights overall score by source-class count (big templates dominate)', () => {
    // Template A: 10 classes, kept all 10. Template B: 1 class, kept 0.
    // Per-template: A=100%, B=0%. Weighted: (10 + 0) / (10 + 1) ≈ 90.9%.
    const bigSource = Array.from({ length: 10 }, (_, i) => `class-${i}`).join(' ')
    const result = runCssMatchCheck({
      templates: [
        makeTemplate('product', 'templates/product.liquid', `<div class="${bigSource}">x</div>`),
        makeTemplate('page', 'templates/page.liquid', '<div class="only-class">x</div>'),
      ],
      writtenTemplates: {
        'templates/product.liquid': `<div class="${bigSource}">x</div>`,
        'templates/page.liquid': '<div>x</div>', // lost the class
      },
    })
    expect(result.score).toBe(Math.round((10 / 11) * 100)) // 91
    expect(result.passed).toBe(true)
  })

  it('emits error-severity finding when a template drops below 50%', () => {
    const sourceHtml = '<div class="a b c d">x</div>'
    const outputHtml = '<div class="a">{{ x }}</div>'
    const result = runCssMatchCheck({
      templates: [makeTemplate('product', 'templates/product.liquid', sourceHtml)],
      writtenTemplates: { 'templates/product.liquid': outputHtml },
    })
    expect(result.findings.some(
      (f) => f.severity === 'error' && f.message.includes('product.liquid'),
    )).toBe(true)
  })

  it('returns 100 with info finding when no templates intersect', () => {
    const result = runCssMatchCheck({
      templates: [],
      writtenTemplates: {},
    })
    expect(result.score).toBe(100)
    expect(result.findings[0].severity).toBe('info')
  })
})
