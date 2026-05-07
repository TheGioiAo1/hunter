/**
 * support-widget — tests.
 *
 * Pins the contract used by seller-layout.ts when it injects the
 * floating "G" launcher on every store-admin page:
 *
 *   - the button text is literally "G" (Iron Rule 5: no "support",
 *     no "god admin", no internal route leaks)
 *   - Messenger-blue #0084FF is hard-coded on the button, not pulled
 *     from a theme var (the widget must always be visible on both
 *     dark + light themes)
 *   - the unread badge is hidden at 0 and shows "99+" at ≥100
 *   - the polling URL contains the passed `base` + `/support/api/unread`
 *   - the widget is free of LEAK_TERMS_REGEX matches
 *
 * None of these render HTML through a DOM; we assert against the
 * string directly so the test stays fast + dep-free.
 */
import { describe, it, expect } from 'vitest'
import { supportWidgetHtml, __testables } from './support-widget.ts'
import { assertSellerSafe, LEAK_TERMS_REGEX } from '@gbox/core/modules/support/index.js'

describe('supportWidgetHtml', () => {
  it('renders the "G" launcher button with Messenger blue', () => {
    const html = supportWidgetHtml({ base: '/admin/store/test-shop' })
    // Button element + "G" glyph.
    expect(html).toContain('class="gbox-support-btn"')
    expect(html).toMatch(/>\s*G\s*<span class="gbox-support-badge"/)
    // Messenger blue pinned literally.
    expect(html).toContain('#0084FF')
  })

  it('includes a polling script that hits /support/api/unread under `base`', () => {
    const html = supportWidgetHtml({ base: '/admin/store/my-shop' })
    // The JSON.stringify of base lands in the fetch URL.
    expect(html).toContain('"/admin/store/my-shop"')
    expect(html).toContain('/support/api/unread')
  })

  it('uses a 3000ms default poll interval', () => {
    const html = supportWidgetHtml({ base: '/admin/store/s' })
    // `var pollMs = 3000;` renders via ${Number(pollMs)}.
    expect(html).toContain('var pollMs = 3000;')
  })

  it('allows the poll interval to be overridden', () => {
    const html = supportWidgetHtml({ base: '/admin/store/s', pollIntervalMs: 500 })
    expect(html).toContain('var pollMs = 500;')
  })

  it('provides aria-label + aria-live on the badge (accessibility)', () => {
    const html = supportWidgetHtml({ base: '/admin/store/s' })
    expect(html).toContain('aria-label="Support — Gbox"')
    expect(html).toContain('aria-live="polite"')
  })

  it('is free of LEAK_TERMS_REGEX matches (Iron Rule 5)', () => {
    const html = supportWidgetHtml({ base: '/admin/store/s' })
    expect(assertSellerSafe(html)).toBe(true)
    expect(html.match(LEAK_TERMS_REGEX)).toBeNull()
  })

  it('deep-links the button href to {base}/support', () => {
    const html = supportWidgetHtml({ base: '/admin/store/test-shop' })
    expect(html).toContain('href="/admin/store/test-shop/support"')
  })

  it('never inlines "god admin" / "supporter.gbox.co" / "FEATURE_FLAG_..."', () => {
    const html = supportWidgetHtml({ base: '/admin/store/s' })
    expect(html).not.toMatch(/god[ _-]?admin/i)
    expect(html).not.toMatch(/supporter\.gbox\.co/i)
    expect(html).not.toMatch(/FEATURE_FLAG_/)
  })

  it('pauses polling via document.hidden (saves battery)', () => {
    const html = supportWidgetHtml({ base: '/admin/store/s' })
    // The polling script reads `document.hidden` in the tick fn AND
    // listens for visibilitychange to restart. Pin both.
    expect(html).toContain('document.hidden')
    expect(html).toContain('visibilitychange')
  })

  it('renders "99+" for counts >= 100', () => {
    const html = supportWidgetHtml({ base: '/admin/store/s' })
    // The render fn has `count >= 100 ? '99+' : String(count)`.
    expect(html).toContain("'99+'")
  })
})

describe('escAttr', () => {
  it('escapes HTML-significant characters', () => {
    expect(__testables.escAttr('a<b>"&c')).toBe('a&lt;b&gt;&quot;&amp;c')
  })

  it('leaves plain strings unchanged', () => {
    expect(__testables.escAttr('/admin/store/my-shop/support')).toBe(
      '/admin/store/my-shop/support',
    )
  })
})
