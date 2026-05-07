import { describe, it, expect } from 'vitest'
import { exportDesignMd } from './design-md-export.js'
import type { ThemeTokens } from './types.js'

describe('exportDesignMd', () => {
  it('produces awesome-claude-design-compatible DESIGN.md structure', () => {
    const tokens: ThemeTokens = {
      colors: { primary: '#111', secondary: '#f60', background: '#fff', text: '#222' },
      typography: { heading_family: 'Helvetica Neue', body_family: 'Inter', base_size_px: 16 },
      spacing: { base_px: 8 },
      radius_px: 4,
      raw_css_vars: { '--color-primary': '#111' },
    }
    const md = exportDesignMd({ shopName: 'Allbirds Clone', tokens })
    expect(md).toMatch(/^# Allbirds Clone Design System/)
    expect(md).toContain('## Brand voice')
    expect(md).toContain('## Tokens')
    expect(md).toContain('### Color')
    expect(md).toContain('primary: #111')
    expect(md).toContain('### Typography')
    expect(md).toContain('heading: Helvetica Neue')
    expect(md).toContain('base: 8')
    expect(md).toContain('## Components')
    expect(md).toContain('### Button')
    expect(md).toContain('radius: 4')
  })

  it('does not leak source-host identifiers (Iron Rule 5)', () => {
    const tokens: ThemeTokens = {
      colors: { primary: '#111', secondary: null, background: null, text: null },
      typography: { heading_family: null, body_family: null, base_size_px: null },
      spacing: { base_px: null }, radius_px: null, raw_css_vars: {},
    }
    const md = exportDesignMd({
      shopName: 'Shop',
      tokens,
      sourceHost: 'allbirds.com',   // should NOT appear in output
    })
    expect(md).not.toMatch(/allbirds\.com/i)
  })
})
