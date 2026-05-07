/**
 * Design Library DESIGN.md parser tests (Phase D1).
 *
 * Locks the heuristic so a refactor doesn't silently drop titles or
 * start returning markdown-as-summary text. Same parser is used by
 * the sync-seed CLI (scripts/seed-design-library.ts) and by the D2
 * clone-pro extractor.
 */

import { describe, expect, it } from 'vitest'
import { extractTitleAndSummary, prettifySlug } from './parse-design-md.js'

describe('extractTitleAndSummary', () => {
  it('pulls the H1 line as the title', () => {
    const md = '# Airbnb\n\nBelong anywhere.'
    const { title } = extractTitleAndSummary(md, 'airbnb')
    expect(title).toBe('Airbnb')
  })

  it('strips the "— Design System" suffix upstream often appends', () => {
    const md = '# Stripe — Design System\n\nPayments infrastructure.'
    const { title } = extractTitleAndSummary(md, 'stripe')
    expect(title).toBe('Stripe')
  })

  it('handles an em-dash, en-dash, or plain hyphen variant', () => {
    expect(extractTitleAndSummary('# X — Design System', 'x').title).toBe('X')
    expect(extractTitleAndSummary('# X – Design System', 'x').title).toBe('X')
    expect(extractTitleAndSummary('# X - Design System', 'x').title).toBe('X')
  })

  it('also strips "Design Guide" (rare upstream variant)', () => {
    const { title } = extractTitleAndSummary(
      '# Notion — Design Guide\n\nThe connected workspace.',
      'notion',
    )
    expect(title).toBe('Notion')
  })

  it('strips the "Design System Inspiration of <Brand>" prefix upstream uses', () => {
    // This is the shape awesome-design-md ships at 80bbbc2 — every
    // DESIGN.md starts "# Design System Inspiration of <Brand>".
    expect(
      extractTitleAndSummary(
        '# Design System Inspiration of Airbnb\n\n## 1. Visual Theme',
        'airbnb',
      ).title,
    ).toBe('Airbnb')
    expect(
      extractTitleAndSummary(
        '# Design System Inspiration for Claude',
        'claude',
      ).title,
    ).toBe('Claude')
  })

  it('falls back to a prettified slug when no H1 exists', () => {
    const { title } = extractTitleAndSummary('no heading here', 'mistral.ai')
    expect(title).toBe('Mistral.ai')
  })

  it('extracts the first paragraph after the H1 as the summary', () => {
    const md = [
      '# Figma',
      '',
      'The collaborative interface design tool.',
      '',
      '## Visual Theme',
      'Body of section 1',
    ].join('\n')
    const { summary } = extractTitleAndSummary(md, 'figma')
    expect(summary).toBe('The collaborative interface design tool.')
  })

  it('falls through an immediate section heading to the section body', () => {
    // Upstream's shape at 80bbbc2: `# Title \n ## 1. Visual Theme \n
    // <paragraph>`. Parser must dig past the section heading so the
    // gallery card has something readable — otherwise every seed row
    // would render with a null summary.
    const md = '# Tesla\n\n## Visual Theme\n\nMinimalist performance.'
    const { summary } = extractTitleAndSummary(md, 'tesla')
    expect(summary).toBe('Minimalist performance.')
  })

  it('returns null summary when the body has no paragraph text', () => {
    const md = '# Tesla\n\n## Visual Theme\n\n![diagram](x.png)'
    const { summary } = extractTitleAndSummary(md, 'tesla')
    expect(summary).toBeNull()
  })

  it('strips inline markdown (code ticks, links, bold) from the summary', () => {
    const md = [
      '# Clay',
      '',
      '## 1. Visual Theme',
      '',
      'Clay uses `#faf9f7` cream with [Rausch Red](https://x) and **Matcha** green.',
    ].join('\n')
    const { summary } = extractTitleAndSummary(md, 'clay')
    expect(summary).toBe(
      'Clay uses #faf9f7 cream with Rausch Red and Matcha green.',
    )
  })

  it('skips markdown metadata lines when looking for the summary', () => {
    const md = [
      '# Claude',
      '',
      '![logo](claude.png)',
      '> A quote',
      '---',
      '',
      'The assistant with a thoughtful voice.',
      '',
      '## Visual Theme',
    ].join('\n')
    const { summary } = extractTitleAndSummary(md, 'claude')
    expect(summary).toBe('The assistant with a thoughtful voice.')
  })

  it('caps the summary at 280 chars with an ellipsis', () => {
    const longPara = 'lorem '.repeat(80) // ~480 chars
    const md = `# Test\n\n${longPara}`
    const { summary } = extractTitleAndSummary(md, 'test')
    expect(summary?.length).toBeLessThanOrEqual(280)
    expect(summary?.endsWith('…')).toBe(true)
  })

  it('handles BOM and CRLF line endings without breaking the regex', () => {
    const md = '\uFEFF# Apple\r\n\r\nThink different.'
    const { title, summary } = extractTitleAndSummary(md, 'apple')
    expect(title).toBe('Apple')
    expect(summary).toBe('Think different.')
  })
})

describe('prettifySlug', () => {
  it('title-cases only the first letter so TLD suffixes stay natural', () => {
    // Keep '.ai' / '.app' lowercase — that's how brands actually
    // capitalise themselves ("Mistral.ai", not "Mistral.Ai").
    expect(prettifySlug('mistral.ai')).toBe('Mistral.ai')
    expect(prettifySlug('linear.app')).toBe('Linear.app')
  })

  it('leaves a plain slug title-cased', () => {
    expect(prettifySlug('stripe')).toBe('Stripe')
    expect(prettifySlug('airbnb')).toBe('Airbnb')
  })

  it('no-ops on empty input', () => {
    expect(prettifySlug('')).toBe('')
  })
})
