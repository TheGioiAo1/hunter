/**
 * Tests for the shared toast module (Phase 2 Step 2.3).
 */

import { describe, it, expect } from 'vitest'
import {
  FLASH_COOKIE,
  buildFlashCookie,
  clearFlashCookie,
  flashContainerHtml,
  toastRuntimeScriptBody,
  toastCss,
} from './toast.js'

describe('toast — constants', () => {
  it('exports the canonical flash cookie name', () => {
    expect(FLASH_COOKIE).toBe('gbox_flash')
  })
})

describe('toast — buildFlashCookie', () => {
  it('encodes a basic info toast', () => {
    const cookie = buildFlashCookie({ kind: 'info', message: 'Hello' })
    expect(cookie).toContain('gbox_flash=')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('Max-Age=10')
    expect(cookie).toContain('SameSite=Lax')
  })

  it('URL-encodes the payload so special chars survive transport', () => {
    const cookie = buildFlashCookie({
      kind: 'success',
      message: 'Saved & done',
    })
    // Should have encoded '&' as '%26' somewhere in the cookie value
    expect(cookie).toContain('%26')
  })

  it('round-trips through JSON.parse(decodeURIComponent(...))', () => {
    const cookie = buildFlashCookie({
      kind: 'error',
      title: 'Oops',
      message: 'Something bad',
      duration: 6000,
    })
    const valueMatch = cookie.match(/gbox_flash=([^;]+)/)
    expect(valueMatch).not.toBeNull()
    const parsed = JSON.parse(decodeURIComponent(valueMatch![1]))
    expect(parsed).toEqual({
      k: 'error',
      t: 'Oops',
      m: 'Something bad',
      d: 6000,
    })
  })

  it('defaults kind to info and duration to 4000', () => {
    const cookie = buildFlashCookie({ message: 'Hi' })
    const parsed = JSON.parse(
      decodeURIComponent(cookie.match(/gbox_flash=([^;]+)/)![1]),
    )
    expect(parsed.k).toBe('info')
    expect(parsed.d).toBe(4000)
    expect(parsed.t).toBe('')
  })

  it('adds Secure flag when secure option is true', () => {
    expect(buildFlashCookie({ message: 'Hi' }, { secure: true })).toContain(
      'Secure',
    )
    expect(buildFlashCookie({ message: 'Hi' })).not.toContain('Secure')
  })
})

describe('toast — clearFlashCookie', () => {
  it('builds a Max-Age=0 cookie string', () => {
    const cookie = clearFlashCookie()
    expect(cookie).toContain('gbox_flash=')
    expect(cookie).toContain('Max-Age=0')
    expect(cookie).toContain('Path=/')
  })
})

describe('toast — flashContainerHtml', () => {
  it('renders a container with the expected id and role', () => {
    const html = flashContainerHtml()
    expect(html).toContain('id="gboxToastContainer"')
    expect(html).toContain('class="gbox-toast-container"')
    expect(html).toContain('aria-live="polite"')
  })
})

describe('toast — toastRuntimeScriptBody', () => {
  it('defines window.gboxToast as the global entrypoint', () => {
    const js = toastRuntimeScriptBody()
    expect(js).toContain('window.gboxToast')
  })

  it('consumes gbox_flash cookie on load', () => {
    const js = toastRuntimeScriptBody()
    expect(js).toContain('gbox_flash')
    expect(js).toContain('DOMContentLoaded')
  })

  it('clears the cookie after reading it to prevent replay', () => {
    const js = toastRuntimeScriptBody()
    expect(js).toContain('Max-Age=0')
  })

  it('uses textContent (not innerHTML) for user-supplied strings', () => {
    // XSS-safety check: the message/title should be assigned via
    // .textContent, never via .innerHTML. If a future edit changes
    // this we want the test to catch it.
    const js = toastRuntimeScriptBody()
    expect(js).toContain('.textContent = opts.title')
    expect(js).toContain('.textContent = message')
    // Only the close button (&times;) may use innerHTML — verify the
    // only innerHTML mention is the close glyph.
    const innerHtmlMatches = js.match(/\.innerHTML\s*=/g) ?? []
    expect(innerHtmlMatches.length).toBe(1)
  })

  it('caps the number of visible toasts to prevent runaway', () => {
    const js = toastRuntimeScriptBody()
    expect(js).toContain('MAX_VISIBLE')
  })

  it('pauses auto-dismiss on hover', () => {
    const js = toastRuntimeScriptBody()
    expect(js).toContain('mouseenter')
    expect(js).toContain('mouseleave')
  })

  it('uses role=alert for errors, role=status for others', () => {
    const js = toastRuntimeScriptBody()
    expect(js).toContain("kind === 'error' ? 'alert' : 'status'")
  })
})

describe('toast — toastCss', () => {
  it('positions the container fixed top-right', () => {
    const css = toastCss()
    expect(css).toContain('.gbox-toast-container')
    expect(css).toContain('position: fixed')
    expect(css).toContain('top:')
    expect(css).toContain('right:')
  })

  it('defines visual states for enter/exit animations', () => {
    const css = toastCss()
    expect(css).toContain('.gbox-toast-in')
    expect(css).toContain('.gbox-toast-out')
  })

  it('defines kind-specific accent colors', () => {
    const css = toastCss()
    expect(css).toContain('.gbox-toast-success')
    expect(css).toContain('.gbox-toast-error')
    expect(css).toContain('.gbox-toast-warning')
    expect(css).toContain('.gbox-toast-info')
  })

  it('honors prefers-reduced-motion', () => {
    expect(toastCss()).toContain('prefers-reduced-motion')
  })

  it('uses theme CSS vars so it adapts to dark/light', () => {
    const css = toastCss()
    expect(css).toContain('var(--god-surface')
    expect(css).toContain('var(--god-text')
  })

  it('has focus-visible outline on the close button', () => {
    const css = toastCss()
    expect(css).toContain('.gbox-toast-close:focus-visible')
    expect(css).toContain('outline')
  })
})
