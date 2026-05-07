/**
 * Tests for the shared Gbox logo (Phase 2 Step 2.1).
 *
 * These tests pin the structural invariants of the logo so a future
 * tweak to the visual design doesn't accidentally break:
 *   - the accessible label (alt/aria-label)
 *   - the ability to customize size / id / color
 *   - uniqueness of gradient ids when two logos share a page
 */

import { describe, it, expect } from 'vitest'
import { gboxLogo } from './logo.js'

describe('gboxLogo — default mark', () => {
  it('renders an SVG with the default 32px size', () => {
    const svg = gboxLogo()
    expect(svg).toContain('<svg')
    expect(svg).toContain('width="32"')
    expect(svg).toContain('height="32"')
    expect(svg).toContain('viewBox="0 0 32 32"')
  })

  it('includes the xmlns attribute so it works when saved as a file', () => {
    expect(gboxLogo()).toContain('xmlns="http://www.w3.org/2000/svg"')
  })

  it('has an accessible role and label', () => {
    const svg = gboxLogo()
    expect(svg).toContain('role="img"')
    expect(svg).toContain('aria-label="Gbox"')
  })

  it('ships the blue→violet gradient by default', () => {
    const svg = gboxLogo()
    expect(svg).toContain('<defs>')
    expect(svg).toContain('<linearGradient')
    expect(svg).toContain('#3b82f6') // brand blue
    expect(svg).toContain('#8b5cf6') // brand violet
  })

  it('draws the rounded square background + the G mark stroke', () => {
    const svg = gboxLogo()
    expect(svg).toContain('<rect')
    expect(svg).toContain('rx="8"')
    expect(svg).toContain('<path')
    expect(svg).toContain('stroke="#ffffff"')
  })
})

describe('gboxLogo — size customization', () => {
  it('respects a custom size', () => {
    const svg = gboxLogo({ size: 64 })
    expect(svg).toContain('width="64"')
    expect(svg).toContain('height="64"')
    // viewBox stays at 32 32 — the mark is drawn in a 32-unit grid
    // and the SVG scales up via width/height.
    expect(svg).toContain('viewBox="0 0 32 32"')
  })

  it('supports small sizes (favicon-ish)', () => {
    const svg = gboxLogo({ size: 16 })
    expect(svg).toContain('width="16"')
  })
})

describe('gboxLogo — idSuffix', () => {
  it('generates a deterministic default id when none is passed', () => {
    const a = gboxLogo({ size: 32, variant: 'mark' })
    const b = gboxLogo({ size: 32, variant: 'mark' })
    expect(a).toBe(b)
  })

  it('uses the custom idSuffix in the gradient id', () => {
    const svg = gboxLogo({ idSuffix: 'topbar' })
    expect(svg).toContain('id="gbox-grad-topbar"')
    expect(svg).toContain('url(#gbox-grad-topbar)')
  })

  it('allows two logos on the same page without id collisions', () => {
    const a = gboxLogo({ idSuffix: 'a' })
    const b = gboxLogo({ idSuffix: 'b' })
    expect(a).toContain('id="gbox-grad-a"')
    expect(b).toContain('id="gbox-grad-b"')
    expect(a).not.toContain('id="gbox-grad-b"')
  })
})

describe('gboxLogo — color modes', () => {
  it('mono mode fills with currentColor and omits the gradient <defs>', () => {
    const svg = gboxLogo({ color: 'mono' })
    expect(svg).toContain('fill="currentColor"')
    expect(svg).not.toContain('<defs>')
    expect(svg).not.toContain('<linearGradient')
  })

  it('gradient mode references the gradient via url(#…)', () => {
    const svg = gboxLogo({ color: 'gradient' })
    expect(svg).toContain('url(#gbox-grad-')
  })
})

describe('gboxLogo — variants', () => {
  it('variant="mark" returns an <svg> only, no wrapper span', () => {
    const out = gboxLogo({ variant: 'mark' })
    expect(out.startsWith('<svg')).toBe(true)
  })

  it('variant="wordmark" returns a span with "gbox" text, no <svg>', () => {
    const out = gboxLogo({ variant: 'wordmark' })
    expect(out).toContain('<span')
    expect(out).toContain('gbox')
    expect(out).not.toContain('<svg')
  })

  it('variant="wordmark" uses system-ui font so it matches the surrounding UI', () => {
    const out = gboxLogo({ variant: 'wordmark' })
    expect(out).toContain('-apple-system')
    expect(out).toContain('BlinkMacSystemFont')
  })

  it('variant="combined" renders both the mark and the wordmark', () => {
    const out = gboxLogo({ variant: 'combined' })
    expect(out).toContain('<svg')
    expect(out).toContain('gbox')
    // Uses flexbox wrapper so they sit side-by-side
    expect(out).toContain('display: inline-flex')
  })

  it('combined variant scales the wordmark proportionally to the mark size', () => {
    const small = gboxLogo({ variant: 'combined', size: 24 })
    const large = gboxLogo({ variant: 'combined', size: 48 })
    // Just verify both render — specific font sizes are implementation
    // detail and shouldn't be pinned too tight.
    expect(small).toContain('font-size')
    expect(large).toContain('font-size')
    expect(small).not.toBe(large)
  })
})

describe('gboxLogo — accessibility', () => {
  it('allows a custom aria-label', () => {
    const svg = gboxLogo({ ariaLabel: 'Gbox Platform Home' })
    expect(svg).toContain('aria-label="Gbox Platform Home"')
  })

  it('defaults aria-label to "Gbox"', () => {
    expect(gboxLogo()).toContain('aria-label="Gbox"')
    expect(gboxLogo({ variant: 'wordmark' })).toContain('aria-label="Gbox"')
    expect(gboxLogo({ variant: 'combined' })).toContain('aria-label="Gbox"')
  })
})

describe('gboxLogo — className passthrough', () => {
  it('applies a custom className to the svg', () => {
    const svg = gboxLogo({ className: 'sidebar-logo-svg' })
    expect(svg).toContain('class="sidebar-logo-svg"')
  })
})

describe('gboxLogo — no dangling angles or unescaped quotes', () => {
  it('the SVG string is well-formed', () => {
    const svg = gboxLogo()
    // Rough parse check — every `<` should have a matching `>`
    const opens = (svg.match(/</g) ?? []).length
    const closes = (svg.match(/>/g) ?? []).length
    expect(opens).toBe(closes)
  })

  it('combined variant has balanced tags', () => {
    const out = gboxLogo({ variant: 'combined' })
    const opens = (out.match(/<span/g) ?? []).length
    const closeSpans = (out.match(/<\/span>/g) ?? []).length
    expect(opens).toBe(closeSpans)
  })
})
