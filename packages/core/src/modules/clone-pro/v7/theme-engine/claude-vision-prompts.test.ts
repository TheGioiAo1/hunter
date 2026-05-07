import { describe, it, expect } from 'vitest'
import {
  describeHomepagePrompt,
  describePdpPrompt,
  describePlpPrompt,
  describeGlobalPrompt,
  consolidateTokensPrompt,
  PROMPT_REGISTRY,
} from './claude-vision-prompts.js'

describe('claude-vision-prompts', () => {
  it('describeHomepage instructs against Inter/Poppins default', () => {
    const p = describeHomepagePrompt()
    expect(p.toLowerCase()).toContain('do not default')
    expect(p.toLowerCase()).toContain('inter')
    expect(p.toLowerCase()).toContain('poppins')
  })

  it('describeHomepage demands exact hex codes', () => {
    const p = describeHomepagePrompt()
    expect(p.toLowerCase()).toMatch(/exact hex/i)
    expect(p.toLowerCase()).toMatch(/sample multiple regions/i)
  })

  it('describeHomepage requests JSON output matching schema', () => {
    const p = describeHomepagePrompt()
    expect(p.toLowerCase()).toContain('json')
    expect(p).toMatch(/strict|valid/i)
  })

  it('describeHomepage covers hero_pattern + header + colors + fonts', () => {
    const p = describeHomepagePrompt()
    expect(p).toMatch(/hero/i)
    expect(p).toMatch(/header/i)
    expect(p).toMatch(/colors?/i)
    expect(p).toMatch(/fonts?/i)
  })

  it('describePdp focuses on product_card variant + buttons', () => {
    const p = describePdpPrompt()
    expect(p).toMatch(/product/i)
    expect(p).toMatch(/button/i)
    expect(p.toLowerCase()).toMatch(/variant/)
  })

  it('describePdp asks for aspect_ratio + border_radius', () => {
    const p = describePdpPrompt()
    expect(p.toLowerCase()).toContain('aspect')
    expect(p.toLowerCase()).toContain('border_radius')
  })

  it('describePlp focuses on grid_columns + product_card grid', () => {
    const p = describePlpPrompt()
    expect(p.toLowerCase()).toContain('grid')
    expect(p).toMatch(/listing|collection|plp/i)
  })

  it('describeGlobal focuses on navigation + spacing + breakpoints', () => {
    const p = describeGlobalPrompt()
    expect(p).toMatch(/navigation/i)
    expect(p).toMatch(/spacing/i)
    expect(p).toMatch(/breakpoints?/i)
  })

  it('consolidateTokens accepts partial-token JSON inputs', () => {
    const partials = [
      { source: 'home-desktop', json: { fonts: { primary: { family: 'Cormorant Garamond' } } } },
      { source: 'pdp-desktop', json: { components: { product_card: { variant: 'editorial' } } } },
    ]
    const p = consolidateTokensPrompt(partials)
    expect(p).toContain('Cormorant Garamond')
    expect(p).toContain('editorial')
    expect(p.toLowerCase()).toContain('consolidate')
  })

  it('consolidateTokens enumerates required output sections', () => {
    const p = consolidateTokensPrompt([])
    expect(p).toMatch(/fonts/i)
    expect(p).toMatch(/colors/i)
    expect(p).toMatch(/spacing/i)
    expect(p).toMatch(/components/i)
    expect(p).toMatch(/aesthetic_score/i)
  })

  it('consolidateTokens demands single JSON output (no preamble)', () => {
    const p = consolidateTokensPrompt([])
    expect(p.toLowerCase()).toMatch(/no (preamble|prose|commentary|markdown|explanation)/i)
  })

  it('PROMPT_REGISTRY exposes all 5 prompts by key', () => {
    expect(Object.keys(PROMPT_REGISTRY).sort()).toEqual([
      'describe_global',
      'describe_homepage',
      'describe_pdp',
      'describe_plp',
    ].sort())
    // consolidate is a function-of-input so it's not in the static registry,
    // but must be exported separately.
    expect(typeof consolidateTokensPrompt).toBe('function')
  })

  it('all describe-* prompts mention Google Font name prediction', () => {
    expect(describeHomepagePrompt().toLowerCase()).toContain('google font')
    expect(describePdpPrompt().toLowerCase()).toContain('google font')
    expect(describePlpPrompt().toLowerCase()).toContain('google font')
    expect(describeGlobalPrompt().toLowerCase()).toContain('google font')
  })
})
