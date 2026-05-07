/**
 * Gbox Platform — SEO meta-tag builders tests (Stage 3D.4)
 *
 * Pure-function tests. Each helper returns a *string* containing
 * one `<meta>` / `<link>` tag per line (no indentation) so the
 * caller can drop the output straight into the `<head>` without
 * further formatting. Tests inspect the emitted string line by
 * line rather than doing brittle substring matches on the whole
 * blob.
 */

import { describe, it, expect } from 'vitest'
import {
  buildCanonicalUrl,
  buildCanonicalLinkTag,
  buildMetaTags,
  buildTwitterCardTags,
  buildOpenGraphTags,
  type MetaTagInput,
} from './meta-tags.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function lines(out: string): string[] {
  return out.split('\n').filter((l) => l.length > 0)
}

const BASE: MetaTagInput = {
  title: 'Cap — Demo Shop',
  description: 'A very nice cap',
  canonical: 'https://demo.gbox.test/products/cap',
  imageUrl: 'https://demo.gbox.test/cdn/cap.jpg',
  siteName: 'Demo Shop',
  type: 'product',
  locale: 'en_US',
  twitterHandle: '@demoshop',
}

// ---------------------------------------------------------------------------
// buildCanonicalUrl
// ---------------------------------------------------------------------------

describe('buildCanonicalUrl', () => {
  it('joins baseUrl + path into an absolute URL', () => {
    expect(
      buildCanonicalUrl('https://demo.gbox.test', '/products/cap'),
    ).toBe('https://demo.gbox.test/products/cap')
  })

  it('tolerates a trailing slash on baseUrl', () => {
    expect(
      buildCanonicalUrl('https://demo.gbox.test/', '/products/cap'),
    ).toBe('https://demo.gbox.test/products/cap')
  })

  it('tolerates a missing leading slash on path', () => {
    expect(
      buildCanonicalUrl('https://demo.gbox.test', 'products/cap'),
    ).toBe('https://demo.gbox.test/products/cap')
  })

  it('handles the shop root ("/")', () => {
    expect(buildCanonicalUrl('https://demo.gbox.test', '/')).toBe(
      'https://demo.gbox.test/',
    )
  })

  it('strips ?preview_theme_id and ?design_mode query params (theme preview leak)', () => {
    // These are internal Gbox params used by the theme editor; they
    // MUST NOT appear in a canonical URL or Google will index the
    // preview variant and push the real page out of the SERP.
    expect(
      buildCanonicalUrl(
        'https://demo.gbox.test',
        '/products/cap?preview_theme_id=123&design_mode=1',
      ),
    ).toBe('https://demo.gbox.test/products/cap')
  })

  it('preserves other query params (e.g. pagination)', () => {
    expect(
      buildCanonicalUrl(
        'https://demo.gbox.test',
        '/collections/hats?page=2',
      ),
    ).toBe('https://demo.gbox.test/collections/hats?page=2')
  })
})

// ---------------------------------------------------------------------------
// buildCanonicalLinkTag
// ---------------------------------------------------------------------------

describe('buildCanonicalLinkTag', () => {
  it('emits a <link rel="canonical"> tag', () => {
    expect(
      buildCanonicalLinkTag('https://demo.gbox.test/products/cap'),
    ).toBe('<link rel="canonical" href="https://demo.gbox.test/products/cap">')
  })

  it('escapes double quotes in the URL', () => {
    // Extremely paranoid — canonical URLs should never contain quotes,
    // but the helper must not create a quote injection if one slips in.
    const tag = buildCanonicalLinkTag('https://demo.gbox.test/"><script>')
    expect(tag).not.toContain('"><script>')
    expect(tag).toContain('&quot;')
  })
})

// ---------------------------------------------------------------------------
// buildOpenGraphTags
// ---------------------------------------------------------------------------

describe('buildOpenGraphTags', () => {
  it('emits og:title, og:description, og:url, og:image, og:site_name, og:type, og:locale', () => {
    const out = lines(buildOpenGraphTags(BASE))
    expect(out).toContain('<meta property="og:title" content="Cap — Demo Shop">')
    expect(out).toContain(
      '<meta property="og:description" content="A very nice cap">',
    )
    expect(out).toContain(
      '<meta property="og:url" content="https://demo.gbox.test/products/cap">',
    )
    expect(out).toContain(
      '<meta property="og:image" content="https://demo.gbox.test/cdn/cap.jpg">',
    )
    expect(out).toContain('<meta property="og:site_name" content="Demo Shop">')
    expect(out).toContain('<meta property="og:type" content="product">')
    expect(out).toContain('<meta property="og:locale" content="en_US">')
  })

  it('defaults og:type to "website" when not specified', () => {
    const out = lines(buildOpenGraphTags({ ...BASE, type: undefined }))
    expect(out).toContain('<meta property="og:type" content="website">')
  })

  it('omits og:image when no image is provided', () => {
    const out = buildOpenGraphTags({ ...BASE, imageUrl: null })
    expect(out).not.toContain('og:image')
  })

  it('escapes special characters in the title and description', () => {
    const out = buildOpenGraphTags({
      ...BASE,
      title: 'A & B "quoted" <tag>',
      description: "it's <ok>",
    })
    expect(out).toContain('&amp;')
    expect(out).toContain('&quot;')
    expect(out).toContain('&lt;')
    expect(out).toContain('&gt;')
    expect(out).toContain('&#39;')
  })
})

// ---------------------------------------------------------------------------
// buildTwitterCardTags
// ---------------------------------------------------------------------------

describe('buildTwitterCardTags', () => {
  it('emits summary_large_image when an image is present', () => {
    const out = lines(buildTwitterCardTags(BASE))
    expect(out).toContain(
      '<meta name="twitter:card" content="summary_large_image">',
    )
    expect(out).toContain('<meta name="twitter:site" content="@demoshop">')
    expect(out).toContain(
      '<meta name="twitter:title" content="Cap — Demo Shop">',
    )
    expect(out).toContain(
      '<meta name="twitter:description" content="A very nice cap">',
    )
    expect(out).toContain(
      '<meta name="twitter:image" content="https://demo.gbox.test/cdn/cap.jpg">',
    )
  })

  it('emits plain summary card when no image is provided', () => {
    const out = lines(buildTwitterCardTags({ ...BASE, imageUrl: null }))
    expect(out).toContain('<meta name="twitter:card" content="summary">')
    expect(out.find((l) => l.includes('twitter:image'))).toBeUndefined()
  })

  it('omits twitter:site when no handle is supplied', () => {
    const out = buildTwitterCardTags({ ...BASE, twitterHandle: null })
    expect(out).not.toContain('twitter:site')
  })
})

// ---------------------------------------------------------------------------
// buildMetaTags (the combined head-injection helper)
// ---------------------------------------------------------------------------

describe('buildMetaTags', () => {
  it('includes description, canonical, OG, and Twitter tags', () => {
    const out = buildMetaTags(BASE)
    expect(out).toContain(
      '<meta name="description" content="A very nice cap">',
    )
    expect(out).toContain('<link rel="canonical"')
    expect(out).toContain('property="og:title"')
    expect(out).toContain('name="twitter:card"')
  })

  it('emits one tag per line with no trailing newline', () => {
    const out = buildMetaTags(BASE)
    expect(out.endsWith('\n')).toBe(false)
    // Every non-empty line should start with `<` to confirm no junk
    // snuck in between tags.
    for (const line of lines(out)) {
      expect(line.startsWith('<')).toBe(true)
    }
  })

  it('adds a robots noindex tag when index=false is passed', () => {
    const out = buildMetaTags({ ...BASE, index: false })
    expect(out).toContain(
      '<meta name="robots" content="noindex, nofollow">',
    )
  })

  it('does NOT emit a robots tag when index is unset or true', () => {
    expect(buildMetaTags(BASE)).not.toContain('name="robots"')
    expect(buildMetaTags({ ...BASE, index: true })).not.toContain(
      'name="robots"',
    )
  })
})
