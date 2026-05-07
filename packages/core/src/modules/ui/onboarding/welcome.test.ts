/**
 * Welcome page component — unit tests.
 *
 * 2026-04-26: Clone Pro re-scoped to god-admin-only concierge tooling.
 * The welcome page used to ship a two-tab UI ("Clone from URL" + "Theme
 * Library"); after the scrub the wizard ships only the Theme Library
 * panel. These tests lock that simpler shape so a future regression
 * can't accidentally re-introduce the clone tab.
 */

import { describe, expect, it } from 'vitest'
import {
  renderWelcome,
  welcomeRuntimeScriptBody,
  welcomeCss,
} from './welcome.js'

function baseProps(overrides: Partial<Parameters<typeof renderWelcome>[0]> = {}) {
  return {
    storeSlug: 'lifeasy',
    welcome: false,
    activeTab: 'library' as const,
    csrfToken: 'csrf-token-1234567890',
    skipAction: '/admin/store/lifeasy/onboarding/skip',
    libraryFullHref: '/admin/store/lifeasy/online-store/library?from=onboarding',
    libraryCardsHtml: '',
    ...overrides,
  }
}

describe('renderWelcome', () => {
  it('renders only the library panel (no clone tab)', () => {
    const html = renderWelcome(baseProps())
    expect(html).toContain('panel-library')
    expect(html).not.toContain('panel-clone')
    expect(html).not.toContain('Clone from URL')
    expect(html).not.toContain('Start cloning')
  })

  it('omits the role=tablist element entirely (single panel = no tabs)', () => {
    const html = renderWelcome(baseProps())
    expect(html).not.toContain('role="tablist"')
    expect(html).not.toContain('aria-selected')
  })

  it('renders the welcome hero only when welcome=true', () => {
    const off = renderWelcome(baseProps({ welcome: false }))
    const on = renderWelcome(baseProps({ welcome: true }))
    expect(off).not.toContain('Welcome to Gbox')
    expect(on).toContain('Welcome to Gbox')
  })

  it('emits the skip form pointing at the supplied skipAction', () => {
    const html = renderWelcome(baseProps({ skipAction: '/x/y/skip' }))
    expect(html).toContain('action="/x/y/skip"')
    expect(html).toContain('name="_csrf"')
    expect(html).toMatch(/value="csrf-token-1234567890"/)
  })

  it('renders the empty state when libraryCardsHtml is empty', () => {
    const html = renderWelcome(baseProps({ libraryCardsHtml: '' }))
    expect(html).toContain('Theme Library coming soon')
  })

  it('embeds the supplied libraryCardsHtml when present', () => {
    const cards = '<article class="dl-featured-card">stylish</article>'
    const html = renderWelcome(baseProps({ libraryCardsHtml: cards }))
    expect(html).toContain(cards)
  })

  it('escapes hostile prop values', () => {
    const html = renderWelcome(
      baseProps({
        skipAction: '"><script>alert(1)</script>',
        libraryFullHref: '"><script>alert(2)</script>',
      }),
    )
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<script>alert(2)</script>')
  })

  it('uses Theme Library labels (no "Design Library" leak)', () => {
    const html = renderWelcome(baseProps())
    expect(html).toContain('Theme Library')
    expect(html).not.toContain('Design Library')
  })
})

describe('welcomeCss', () => {
  it('returns a non-empty string', () => {
    expect(welcomeCss().length).toBeGreaterThan(0)
  })
})

describe('welcomeRuntimeScriptBody', () => {
  it('returns a non-empty string', () => {
    expect(welcomeRuntimeScriptBody().length).toBeGreaterThan(0)
  })
})
