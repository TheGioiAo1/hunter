/**
 * Tests for the a11y primitives (Phase 2 Step 2.8).
 */

import { describe, it, expect } from 'vitest'
import {
  skipToMainLink,
  visuallyHidden,
  liveRegionHtml,
  ariaCurrent,
  srOnlyCss,
  skipLinkCss,
  focusRingCss,
  reducedMotionCss,
  a11yCss,
} from './a11y.js'

// ---------------------------------------------------------------------------
// skipToMainLink
// ---------------------------------------------------------------------------

describe('skipToMainLink', () => {
  it('renders a link with default id and label', () => {
    const html = skipToMainLink()
    expect(html).toContain('href="#main-content"')
    expect(html).toContain('Skip to main content')
    expect(html).toContain('class="gbox-skip-link"')
  })

  it('honors a custom target id', () => {
    const html = skipToMainLink('checkout')
    expect(html).toContain('href="#checkout"')
  })

  it('honors a custom label', () => {
    const html = skipToMainLink('main-content', 'Jump to main')
    expect(html).toContain('Jump to main')
  })

  it('escapes HTML in the target id', () => {
    const html = skipToMainLink('"><script>alert(1)</script>')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes HTML in the label', () => {
    const html = skipToMainLink('main-content', '<img src=x onerror=1>')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
  })
})

// ---------------------------------------------------------------------------
// visuallyHidden
// ---------------------------------------------------------------------------

describe('visuallyHidden', () => {
  it('wraps text in a sr-only span', () => {
    const html = visuallyHidden('Delete product')
    expect(html).toBe('<span class="gbox-sr-only">Delete product</span>')
  })

  it('escapes HTML in the text', () => {
    const html = visuallyHidden('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

// ---------------------------------------------------------------------------
// liveRegionHtml
// ---------------------------------------------------------------------------

describe('liveRegionHtml', () => {
  it('defaults to polite level', () => {
    const html = liveRegionHtml('toast-live')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('id="toast-live"')
    expect(html).toContain('aria-atomic="true"')
    expect(html).toContain('class="gbox-sr-only"')
  })

  it('honors assertive level', () => {
    const html = liveRegionHtml('errors', 'assertive')
    expect(html).toContain('aria-live="assertive"')
  })

  it('renders an empty element', () => {
    const html = liveRegionHtml('x')
    expect(html).toMatch(/><\/div>$/)
  })

  it('escapes the id attribute', () => {
    const html = liveRegionHtml('"><script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

// ---------------------------------------------------------------------------
// ariaCurrent
// ---------------------------------------------------------------------------

describe('ariaCurrent', () => {
  it('returns the aria-current attribute when active', () => {
    expect(ariaCurrent(true)).toBe(' aria-current="page"')
  })

  it('returns an empty string when not active', () => {
    expect(ariaCurrent(false)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// srOnlyCss
// ---------------------------------------------------------------------------

describe('srOnlyCss', () => {
  it('defines the .gbox-sr-only class', () => {
    const css = srOnlyCss()
    expect(css).toContain('.gbox-sr-only')
  })

  it('uses position:absolute not display:none', () => {
    const css = srOnlyCss()
    expect(css).toContain('position: absolute')
    expect(css).not.toContain('display: none')
  })

  it('uses clip-rect for the canonical pattern', () => {
    const css = srOnlyCss()
    expect(css).toContain('clip: rect(0, 0, 0, 0)')
  })

  it('uses 1px dimensions', () => {
    const css = srOnlyCss()
    expect(css).toContain('width: 1px')
    expect(css).toContain('height: 1px')
  })
})

// ---------------------------------------------------------------------------
// skipLinkCss
// ---------------------------------------------------------------------------

describe('skipLinkCss', () => {
  it('defines the .gbox-skip-link class', () => {
    const css = skipLinkCss()
    expect(css).toContain('.gbox-skip-link')
  })

  it('hides the link off-screen by default', () => {
    const css = skipLinkCss()
    expect(css).toContain('top: -40px')
  })

  it('pulls the link back on focus', () => {
    const css = skipLinkCss()
    expect(css).toContain(':focus')
    expect(css).toContain('top: 0')
  })

  it('covers :focus-visible too', () => {
    const css = skipLinkCss()
    expect(css).toContain(':focus-visible')
  })

  it('uses the god-accent CSS variable with a fallback', () => {
    const css = skipLinkCss()
    expect(css).toContain('var(--god-accent')
  })
})

// ---------------------------------------------------------------------------
// focusRingCss
// ---------------------------------------------------------------------------

describe('focusRingCss', () => {
  it('targets all interactive elements with :focus-visible', () => {
    const css = focusRingCss()
    expect(css).toContain('a:focus-visible')
    expect(css).toContain('button:focus-visible')
    expect(css).toContain('input:focus-visible')
    expect(css).toContain('select:focus-visible')
    expect(css).toContain('textarea:focus-visible')
    expect(css).toContain('[tabindex]:focus-visible')
    expect(css).toContain('summary:focus-visible')
  })

  it('applies an outline rather than a border', () => {
    const css = focusRingCss()
    expect(css).toContain('outline:')
    expect(css).toContain('outline-offset:')
  })

  it('uses the shared accent variable', () => {
    const css = focusRingCss()
    expect(css).toContain('var(--god-accent')
  })

  it('removes the Firefox dotted inner focus ring', () => {
    const css = focusRingCss()
    expect(css).toContain('::-moz-focus-inner')
  })

  it('suppresses the ring on [role="main"]/main', () => {
    const css = focusRingCss()
    expect(css).toContain('[role="main"]:focus')
    expect(css).toContain('main:focus')
  })
})

// ---------------------------------------------------------------------------
// reducedMotionCss
// ---------------------------------------------------------------------------

describe('reducedMotionCss', () => {
  it('wraps rules in prefers-reduced-motion media query', () => {
    const css = reducedMotionCss()
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('shortens animation and transition durations', () => {
    const css = reducedMotionCss()
    expect(css).toContain('animation-duration: 0.01ms')
    expect(css).toContain('transition-duration: 0.01ms')
  })

  it('disables smooth scroll behavior', () => {
    const css = reducedMotionCss()
    expect(css).toContain('scroll-behavior: auto')
  })

  it('targets pseudo-elements too', () => {
    const css = reducedMotionCss()
    expect(css).toContain('*::before')
    expect(css).toContain('*::after')
  })
})

// ---------------------------------------------------------------------------
// a11yCss bundle
// ---------------------------------------------------------------------------

describe('a11yCss', () => {
  it('bundles all four CSS helpers', () => {
    const css = a11yCss()
    expect(css).toContain('.gbox-sr-only')
    expect(css).toContain('.gbox-skip-link')
    expect(css).toContain(':focus-visible')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })
})
