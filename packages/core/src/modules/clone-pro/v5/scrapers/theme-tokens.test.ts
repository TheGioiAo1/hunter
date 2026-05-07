import { describe, it, expect } from 'vitest'
import { extractThemeTokens } from './theme-tokens.js'

const htmlWithVars = `
<html>
  <head>
    <style>
      :root {
        --color-primary: #1a1a1a;
        --color-secondary: #ff6600;
        --color-background: #ffffff;
        --color-text: #222222;
        --font-heading: "Helvetica Neue", sans-serif;
        --font-body: Inter, sans-serif;
        --spacing-base: 8px;
        --radius-base: 4px;
      }
    </style>
  </head>
  <body><h1>Hi</h1></body>
</html>
`

describe('extractThemeTokens', () => {
  it('extracts color tokens from :root CSS vars', () => {
    const t = extractThemeTokens(htmlWithVars)
    expect(t.colors.primary).toBe('#1a1a1a')
    expect(t.colors.secondary).toBe('#ff6600')
    expect(t.colors.background).toBe('#ffffff')
    expect(t.colors.text).toBe('#222222')
  })

  it('extracts typography tokens', () => {
    const t = extractThemeTokens(htmlWithVars)
    expect(t.typography.heading_family).toContain('Helvetica Neue')
    expect(t.typography.body_family).toContain('Inter')
  })

  it('extracts spacing + radius as numbers', () => {
    const t = extractThemeTokens(htmlWithVars)
    expect(t.spacing.base_px).toBe(8)
    expect(t.radius_px).toBe(4)
  })

  it('preserves all raw css vars in raw_css_vars dict', () => {
    const t = extractThemeTokens(htmlWithVars)
    expect(t.raw_css_vars['--color-primary']).toBe('#1a1a1a')
    expect(t.raw_css_vars['--spacing-base']).toBe('8px')
  })

  it('returns nulls when no CSS vars present', () => {
    const t = extractThemeTokens('<html><body></body></html>')
    expect(t.colors.primary).toBeNull()
    expect(t.typography.heading_family).toBeNull()
    expect(Object.keys(t.raw_css_vars)).toHaveLength(0)
  })
})
