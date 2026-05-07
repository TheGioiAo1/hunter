/**
 * Tests for the shared theme helper (Phase 2 Step 2.1).
 *
 * We focus on behavior that's easy to regress in the future:
 *   1. Cookie parsing is strict — only `dark`/`light` are honored,
 *      anything else falls back to `THEME_DEFAULT`.
 *   2. The flicker-prevent script is valid JS that would run under
 *      `try { … } catch {}` without ReferenceErrors.
 *   3. The toggle button + CSS use the exact same selectors so a
 *      renamed class in one doesn't silently break the other.
 */

import { describe, it, expect } from 'vitest'
import {
  THEME_COOKIE,
  THEME_DEFAULT,
  THEME_COOKIE_MAX_AGE_SECONDS,
  readThemeFromCookieHeader,
  readThemeFromRequest,
  buildThemeCookie,
  themeInitScript,
  themeToggleScriptBody,
  themeToggleButton,
  themeToggleButtonCss,
} from './theme.js'

describe('theme — constants', () => {
  it('exports the canonical cookie name', () => {
    expect(THEME_COOKIE).toBe('gbox_theme')
  })

  it('defaults to dark (matches god-admin baseline)', () => {
    expect(THEME_DEFAULT).toBe('dark')
  })

  it('persists the theme for 1 year', () => {
    expect(THEME_COOKIE_MAX_AGE_SECONDS).toBe(60 * 60 * 24 * 365)
  })
})

describe('theme — readThemeFromCookieHeader', () => {
  it('returns default when header is null/undefined/empty', () => {
    expect(readThemeFromCookieHeader(null)).toBe('dark')
    expect(readThemeFromCookieHeader(undefined)).toBe('dark')
    expect(readThemeFromCookieHeader('')).toBe('dark')
  })

  it('parses a single cookie', () => {
    expect(readThemeFromCookieHeader('gbox_theme=dark')).toBe('dark')
    expect(readThemeFromCookieHeader('gbox_theme=light')).toBe('light')
  })

  it('parses when the theme cookie is first of many', () => {
    expect(
      readThemeFromCookieHeader('gbox_theme=light; session=abc; foo=bar'),
    ).toBe('light')
  })

  it('parses when the theme cookie is in the middle', () => {
    expect(
      readThemeFromCookieHeader('session=abc; gbox_theme=light; foo=bar'),
    ).toBe('light')
  })

  it('parses when the theme cookie is last', () => {
    expect(
      readThemeFromCookieHeader('session=abc; foo=bar; gbox_theme=dark'),
    ).toBe('dark')
  })

  it('tolerates extra whitespace after the separator', () => {
    expect(
      readThemeFromCookieHeader('session=abc;   gbox_theme=light'),
    ).toBe('light')
  })

  it('falls back to default on unknown theme values', () => {
    // Someone could manually set `gbox_theme=solarized` — we don't
    // crash, we don't echo back the bogus value, we return the default.
    expect(readThemeFromCookieHeader('gbox_theme=solarized')).toBe('dark')
    expect(readThemeFromCookieHeader('gbox_theme=')).toBe('dark')
    expect(readThemeFromCookieHeader('gbox_theme=DARK')).toBe('dark') // case-sensitive on purpose
  })

  it('does not match a cookie whose name starts with gbox_theme', () => {
    // Prevent `gbox_theme_override=light` from being treated as `gbox_theme=light`
    expect(readThemeFromCookieHeader('gbox_theme_override=light')).toBe('dark')
  })

  it('does not match a cookie whose name ends with gbox_theme', () => {
    // Prevent `my_gbox_theme=light` from matching (requires boundary check)
    expect(readThemeFromCookieHeader('my_gbox_theme=light')).toBe('dark')
  })
})

describe('theme — readThemeFromRequest', () => {
  it('handles null/undefined request', () => {
    expect(readThemeFromRequest(null)).toBe('dark')
    expect(readThemeFromRequest(undefined)).toBe('dark')
  })

  it('handles request with no headers', () => {
    expect(readThemeFromRequest({})).toBe('dark')
  })

  it('handles request with empty headers', () => {
    expect(readThemeFromRequest({ headers: {} })).toBe('dark')
  })

  it('reads cookie header from Express-style req', () => {
    expect(
      readThemeFromRequest({ headers: { cookie: 'gbox_theme=light' } }),
    ).toBe('light')
  })
})

describe('theme — buildThemeCookie', () => {
  it('builds a standard Set-Cookie value', () => {
    const cookie = buildThemeCookie('light')
    expect(cookie).toContain('gbox_theme=light')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('Max-Age=31536000') // 1 year
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).not.toContain('Secure')
  })

  it('adds Secure flag when in production', () => {
    const cookie = buildThemeCookie('dark', { secure: true })
    expect(cookie).toContain('Secure')
  })
})

describe('theme — themeInitScript', () => {
  it('wraps the snippet in a script tag', () => {
    const html = themeInitScript()
    expect(html.startsWith('<script>')).toBe(true)
    expect(html.endsWith('</script>')).toBe(true)
  })

  it('wraps the body in try/catch so a missing document does not break the page', () => {
    const html = themeInitScript()
    expect(html).toContain('try{')
    expect(html).toContain('catch(e)')
  })

  it('reads the gbox_theme cookie and sets data-theme', () => {
    const html = themeInitScript()
    expect(html).toContain('gbox_theme=')
    expect(html).toContain("setAttribute('data-theme'")
  })

  it('defaults to dark when no cookie is present', () => {
    const html = themeInitScript()
    // The snippet has `m ? m[1] : 'dark'` — look for the default arm
    expect(html).toContain("'dark'")
  })

  it('emits a valid regex that the browser can compile + match', () => {
    // Pin the invariant: the cookie-matching regex inside the init
    // script must survive the round-trip from TS source → HTML string →
    // `<script>` parse → `new RegExp`. We reconstruct the regex from
    // the output and run it against sample cookie strings. If someone
    // double-escapes or un-escapes the `\s` in theme.ts this test
    // catches it.
    const html = themeInitScript()
    // Extract the regex literal from the source — it's the only /…/
    // that references gbox_theme.
    const match = html.match(/\/(\(\?:\^\|;[^/]+gbox_theme=\(dark\|light\))\//)
    expect(match).not.toBeNull()
    const pattern = match![1]
    // The browser will see `\s*` here — build a real RegExp with the
    // SAME source and verify it matches realistic cookie strings.
    // Note: we replace `\\s` (what appears in the HTML script source)
    // with `\s` (what the browser's JS parser sees after string
    // unescape) via `new RegExp` taking the actual string the browser
    // would construct. The match above already contains `\s` because
    // the HTML source writes it literally.
    const rx = new RegExp(pattern)
    expect(rx.test('gbox_theme=dark')).toBe(true)
    expect(rx.test('session=abc; gbox_theme=light')).toBe(true)
    expect(rx.test('session=abc; my_gbox_theme=light')).toBe(false)
    expect(rx.test('gbox_theme=solarized')).toBe(false)
  })
})

describe('theme — themeToggleScriptBody', () => {
  it('defines the global toggle function', () => {
    const js = themeToggleScriptBody()
    expect(js).toContain('window.gboxToggleTheme')
  })

  it('cycles dark ↔ light', () => {
    const js = themeToggleScriptBody()
    expect(js).toContain("'dark'")
    expect(js).toContain("'light'")
  })

  it('persists the choice in a cookie', () => {
    const js = themeToggleScriptBody()
    expect(js).toContain('document.cookie')
    expect(js).toContain('gbox_theme')
    expect(js).toContain('max-age=31536000')
  })

  it('uses SameSite=Lax to match the session cookie policy', () => {
    const js = themeToggleScriptBody()
    expect(js).toContain('SameSite=Lax')
  })

  it('updates the button data-current attribute for CSS feedback', () => {
    const js = themeToggleScriptBody()
    expect(js).toContain("getElementById('themeToggleBtn')")
    expect(js).toContain("setAttribute('data-current'")
  })
})

describe('theme — themeToggleButton', () => {
  it('renders a button with the expected id and class', () => {
    const html = themeToggleButton()
    expect(html).toContain('id="themeToggleBtn"')
    expect(html).toContain('class="theme-toggle"')
    expect(html).toContain('type="button"')
  })

  it('wires the onclick to the global toggle fn', () => {
    const html = themeToggleButton()
    expect(html).toContain('onclick="gboxToggleTheme()"')
  })

  it('sets data-current from the theme option', () => {
    expect(themeToggleButton({ theme: 'light' })).toContain(
      'data-current="light"',
    )
    expect(themeToggleButton({ theme: 'dark' })).toContain(
      'data-current="dark"',
    )
  })

  it('defaults data-current to dark', () => {
    expect(themeToggleButton()).toContain('data-current="dark"')
  })

  it('includes both icons so CSS can swap them without re-rendering', () => {
    const html = themeToggleButton()
    expect(html).toContain('theme-toggle-sun')
    expect(html).toContain('theme-toggle-moon')
  })

  it('uses custom aria-label when provided', () => {
    const html = themeToggleButton({ ariaLabel: 'Switch theme' })
    expect(html).toContain('aria-label="Switch theme"')
  })

  it('uses custom className when provided', () => {
    const html = themeToggleButton({ className: 'topbar-btn' })
    expect(html).toContain('class="topbar-btn"')
  })

  it('icons are aria-hidden so screen readers only read the button label', () => {
    const html = themeToggleButton()
    // Two svg icons, both aria-hidden
    const hidden = html.match(/aria-hidden="true"/g) ?? []
    expect(hidden.length).toBe(2)
  })
})

describe('theme — themeToggleButtonCss', () => {
  it('scopes sun/moon visibility by data-theme', () => {
    const css = themeToggleButtonCss()
    expect(css).toContain('[data-theme="dark"]')
    expect(css).toContain('[data-theme="light"]')
    expect(css).toContain('.theme-toggle-sun')
    expect(css).toContain('.theme-toggle-moon')
  })

  it('provides a fallback for when data-theme is not set yet', () => {
    const css = themeToggleButtonCss()
    expect(css).toContain('html:not([data-theme])')
  })

  it('uses the same class names as themeToggleButton output', () => {
    // Cross-check the two functions stay in sync — if one is renamed
    // the other should fail this test.
    const html = themeToggleButton()
    const css = themeToggleButtonCss()
    for (const cls of [
      'theme-toggle',
      'theme-toggle-sun',
      'theme-toggle-moon',
      'theme-toggle-icon',
    ]) {
      expect(html).toContain(cls)
      expect(css).toContain(cls)
    }
  })

  it('has focus-visible outline for keyboard users (a11y)', () => {
    const css = themeToggleButtonCss()
    expect(css).toContain(':focus-visible')
    expect(css).toContain('outline')
  })
})
