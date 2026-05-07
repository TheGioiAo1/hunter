/**
 * Unit tests for SELLER_STYLES + sellerLayout.
 *
 * 2026-04-26: Clone Pro re-scoped to god-admin-only concierge tooling.
 * Tests for the Clone Pro nav entry, live-count badge, and Phase G4
 * keyboard shortcuts have been removed because the corresponding UI
 * was scrubbed from the seller dashboard. Status / grade design tokens
 * stay pinned because other surfaces (order status, plan grade) still
 * consume them.
 */

import { describe, it, expect } from 'vitest'
import { SELLER_STYLES, sellerLayout } from './seller-layout.js'

/**
 * Helper that returns a sensible `sellerLayout` option bag for tests
 * so each test only has to override what it cares about.
 */
function layoutOpts(over: Partial<Parameters<typeof sellerLayout>[0]> = {}) {
  return {
    title: 'Test',
    storeName: 'Acme',
    storeSlug: 'acme',
    userName: 'Thai',
    userEmail: 'thai@example.com',
    userRole: 'owner',
    storeRole: 'owner',
    activePage: 'home',
    content: '<main></main>',
    ...over,
  }
}

describe('SELLER_STYLES — generic status + grade tokens', () => {
  it('is exported as a string', () => {
    expect(typeof SELLER_STYLES).toBe('string')
    expect(SELLER_STYLES.length).toBeGreaterThan(0)
  })

  it('defines all status tokens (queued, running, paused, failed, succeeded, published)', () => {
    for (const t of [
      '--status-queued',
      '--status-running',
      '--status-paused',
      '--status-failed',
      '--status-succeeded',
      '--status-published',
    ]) {
      expect(SELLER_STYLES, `missing token ${t}`).toContain(t)
    }
  })

  it('defines all grade tokens (a–f)', () => {
    for (const t of ['--grade-a', '--grade-b', '--grade-c', '--grade-d', '--grade-f']) {
      expect(SELLER_STYLES, `missing token ${t}`).toContain(t)
    }
  })

  it('does NOT leak the Clone Pro --phase-gradient / --clone-accent-gradient tokens', () => {
    // 2026-04-26 scrub: these gradient tokens were specific to the
    // retired Clone Pro dashboard. Removing them keeps the global token
    // surface tight and makes the regression visible if anything tries
    // to reintroduce them.
    expect(SELLER_STYLES).not.toContain('--phase-gradient')
    expect(SELLER_STYLES).not.toContain('--clone-accent-gradient')
  })
})

describe('sellerLayout — Clone Pro is fully retired from seller UI', () => {
  it('does NOT render a Clone Pro nav entry under Online Store', () => {
    const html = sellerLayout(layoutOpts({ activePage: 'online-store' }))
    expect(html).not.toContain('/admin/store/acme/clone-pro')
    expect(html).not.toContain('>Clone Pro<')
  })

  it('does NOT register the cp-nav-badge live-count pill anywhere', () => {
    // activeCloneJobs is the deprecated field; even when sellers pass it
    // we must not render anything. (Field kept for backwards-compat.)
    const html = sellerLayout(layoutOpts({ activeCloneJobs: 5 }))
    expect(html).not.toContain('cp-nav-badge')
  })

  it('does NOT register Phase G4 clone-pro keyboard chords', () => {
    const html = sellerLayout(layoutOpts())
    expect(html).not.toContain('"clone-pro:new"')
    expect(html).not.toContain('"clone-pro:copy-config"')
    expect(html).not.toContain('"clone-pro:download-report"')
  })

  it('does NOT register the g l → clone-pro Go binding', () => {
    const html = sellerLayout(layoutOpts())
    expect(html).not.toContain('/admin/store/acme/clone-pro')
  })
})

// ---------------------------------------------------------------------------
// Light-mode text token aliases (April 2026 fix)
// ---------------------------------------------------------------------------
//
// Thai hit a light-mode theme bug on Purchase Orders > action: numbers and
// titles lost all color because the page template uses --s-text-primary /
// --s-text-secondary, but the theme block only defined --s-text and
// --s-text-muted. Undefined custom property => `color` falls back to
// `initial` => invisible white-on-white text on the light card.
//
// The fix was a two-line alias inside :root,[data-theme="dark"] that
// delegates to the canonical tokens, so both themes stay in lockstep
// (var() resolves lazily, so the light-mode --s-text override flows
// through the alias automatically).
//
// We pin the alias names + target shape so a rename on either side blows
// up here instead of silently flipping 40+ pages to invisible text again.
describe('SELLER_STYLES — --s-text-primary / --s-text-secondary aliases', () => {
  it('declares --s-text-primary (consumed by purchase-orders, inventory, etc.)', () => {
    expect(SELLER_STYLES).toContain('--s-text-primary')
  })

  it('declares --s-text-secondary (the subdued-text counterpart)', () => {
    expect(SELLER_STYLES).toContain('--s-text-secondary')
  })

  it('aliases primary to var(--s-text) so light-mode overrides cascade through', () => {
    // Whitespace between the colon and the var() call is formatter-driven;
    // pin only the tokens and the var() indirection, not the spacing.
    expect(SELLER_STYLES).toMatch(/--s-text-primary\s*:\s*var\(--s-text\)/)
  })

  it('aliases secondary to var(--s-text-muted) (subdued hierarchy, not dim)', () => {
    expect(SELLER_STYLES).toMatch(/--s-text-secondary\s*:\s*var\(--s-text-muted\)/)
  })
})

// ---------------------------------------------------------------------------
// Keyboard scope still works (independent of clone-pro retirement)
// ---------------------------------------------------------------------------

describe('sellerLayout — keyboard scope plumbing', () => {
  it('stamps data-kbd-scope on <body> when kbdScope is provided', () => {
    const html = sellerLayout(layoutOpts({ kbdScope: 'theme-customize' }))
    expect(html).toContain('data-kbd-scope="theme-customize"')
  })

  it('omits data-kbd-scope when no scope is passed', () => {
    const html = sellerLayout(layoutOpts())
    expect(html).not.toContain('data-kbd-scope=')
  })
})
