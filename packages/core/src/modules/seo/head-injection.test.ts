/**
 * Head-injection — unit coverage (Phase 8 PR3b).
 *
 * Covers:
 *   • Empty settings → empty output (no stray tags)
 *   • Robots noindex placement (first line, exact string)
 *   • Google Site Verification: valid → rendered + escaped; invalid → dropped
 *   • GA4: valid ID → two <script> tags with correct src; invalid → dropped
 *   • GTM: valid ID → head + body noscript; invalid → dropped
 *   • Combined: all three enabled → predictable ordering
 *   • XSS defense: an attacker-controlled "ID" field is dropped by the regex
 *     even when JavaScript-looking characters are present
 *   • buildSeoHeadInjection bundler returns both fragments
 */

import { describe, it, expect } from 'vitest'
import {
  buildBodyOpenTags,
  buildHeadTags,
  buildSeoHeadInjection,
} from './head-injection.js'
import { DEFAULT_SEO_SETTINGS, type SeoSettings } from './seo-settings.js'

const BASE = DEFAULT_SEO_SETTINGS

function withOverrides(overrides: Partial<SeoSettings>): SeoSettings {
  return { ...BASE, ...overrides }
}

// ---------------------------------------------------------------------------
// Empty / default
// ---------------------------------------------------------------------------

describe('buildHeadTags — defaults', () => {
  it('empty SeoSettings → empty string', () => {
    expect(buildHeadTags(BASE)).toBe('')
  })

  it('empty SeoSettings → empty body-open string', () => {
    expect(buildBodyOpenTags(BASE)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// robots_noindex
// ---------------------------------------------------------------------------

describe('buildHeadTags — robots_noindex', () => {
  it('true → emits exact meta robots tag', () => {
    const html = buildHeadTags(withOverrides({ robots_noindex: true }))
    expect(html).toBe('<meta name="robots" content="noindex, nofollow">')
  })

  it('true → is the FIRST line so early-stopping crawlers see it', () => {
    const html = buildHeadTags(
      withOverrides({
        robots_noindex: true,
        google_analytics_id: 'G-ABCDEFGHIJ',
      }),
    )
    const lines = html.split('\n')
    expect(lines[0]).toBe('<meta name="robots" content="noindex, nofollow">')
  })
})

// ---------------------------------------------------------------------------
// Google Site Verification
// ---------------------------------------------------------------------------

describe('buildHeadTags — google_site_verification', () => {
  it('valid token → rendered with escaping', () => {
    const html = buildHeadTags(
      withOverrides({ google_site_verification: 'abc123_def-456789' }),
    )
    expect(html).toBe(
      '<meta name="google-site-verification" content="abc123_def-456789">',
    )
  })

  it('rejects tokens shorter than 10 chars', () => {
    const html = buildHeadTags(withOverrides({ google_site_verification: 'short' }))
    expect(html).toBe('')
  })

  it('rejects tokens with HTML characters (not allowed by regex)', () => {
    const html = buildHeadTags(
      withOverrides({ google_site_verification: '"><script>alert(1)</script>' }),
    )
    expect(html).toBe('')
  })
})

// ---------------------------------------------------------------------------
// GA4
// ---------------------------------------------------------------------------

describe('buildHeadTags — google_analytics_id', () => {
  it('valid ID → two <script> tags with the ID in both', () => {
    const html = buildHeadTags(
      withOverrides({ google_analytics_id: 'G-ABCDEFGHIJ' }),
    )
    expect(html).toContain(
      '<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABCDEFGHIJ"></script>',
    )
    expect(html).toContain("gtag('config','G-ABCDEFGHIJ')")
  })

  it('rejects malformed IDs (wrong prefix)', () => {
    const html = buildHeadTags(
      withOverrides({ google_analytics_id: 'UA-12345-1' }),
    )
    expect(html).toBe('')
  })

  it('rejects IDs with JS-like payloads', () => {
    const html = buildHeadTags(
      withOverrides({
        google_analytics_id: "G-A');alert(1);('" as unknown as string,
      }),
    )
    expect(html).toBe('')
  })

  it('rejects IDs with lowercase letters (Google uses uppercase only)', () => {
    const html = buildHeadTags(
      withOverrides({ google_analytics_id: 'G-abcdefghij' }),
    )
    expect(html).toBe('')
  })
})

// ---------------------------------------------------------------------------
// GTM
// ---------------------------------------------------------------------------

describe('buildHeadTags — google_tag_manager_id', () => {
  it('valid ID → inline GTM bootstrap script', () => {
    const html = buildHeadTags(
      withOverrides({ google_tag_manager_id: 'GTM-AABBCC' }),
    )
    expect(html).toContain("(window,document,'script','dataLayer','GTM-AABBCC')")
  })

  it('rejects malformed GTM IDs', () => {
    const html = buildHeadTags(
      withOverrides({ google_tag_manager_id: 'XYZ-AABBCC' }),
    )
    expect(html).toBe('')
  })
})

describe('buildBodyOpenTags — google_tag_manager_id', () => {
  it('valid ID → noscript iframe', () => {
    const html = buildBodyOpenTags(
      withOverrides({ google_tag_manager_id: 'GTM-AABBCC' }),
    )
    expect(html).toContain(
      '<iframe src="https://www.googletagmanager.com/ns.html?id=GTM-AABBCC"',
    )
    expect(html.startsWith('<noscript>')).toBe(true)
    expect(html.endsWith('</noscript>')).toBe(true)
  })

  it('invalid ID → empty string', () => {
    const html = buildBodyOpenTags(
      withOverrides({ google_tag_manager_id: 'GTM-"><script>' }),
    )
    expect(html).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Combined
// ---------------------------------------------------------------------------

describe('buildSeoHeadInjection', () => {
  it('bundles head + bodyOpen', () => {
    const out = buildSeoHeadInjection(
      withOverrides({
        robots_noindex: true,
        google_analytics_id: 'G-ABCDEFGHIJ',
        google_tag_manager_id: 'GTM-AABBCC',
        google_site_verification: 'verify-token-123_xyz',
      }),
    )
    expect(out.head).toContain('<meta name="robots"')
    expect(out.head).toContain('google-site-verification')
    expect(out.head).toContain('gtag')
    expect(out.head).toContain('dataLayer')
    expect(out.bodyOpen).toContain('GTM-AABBCC')
  })

  it('no valid providers → both fragments empty', () => {
    const out = buildSeoHeadInjection(BASE)
    expect(out.head).toBe('')
    expect(out.bodyOpen).toBe('')
  })
})
