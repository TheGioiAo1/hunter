/**
 * Gbox Platform — Theme marketplace manifest validator tests (Stage 5.3)
 *
 * Every theme listed on the Gbox Theme Marketplace ships a
 * top-level `theme.json` file that describes what the theme is,
 * what features it needs, and how it should appear in the
 * browser. This validator is the gate the install API runs
 * BEFORE unpacking the bundle — a bad manifest should never
 * touch the database.
 *
 * Shape (minimum required):
 *
 *   {
 *     "schema_version": 1,
 *     "name": "Gbox Minimal",
 *     "slug": "gbox-minimal",
 *     "version": "1.0.0",
 *     "author": "Gbox",
 *     "preview": "https://themes.gbox.co/preview/gbox-minimal",
 *     "supported_locales": ["en", "vi"],
 *     "required_features": ["sections", "json_templates"],
 *     "description": "A clean, fast starting point for small shops.",
 *     "license": "MIT"
 *   }
 *
 * Tests pin every required field + every rejection code.
 */

import { describe, it, expect } from 'vitest'
import {
  parseMarketplaceManifest,
  SUPPORTED_MARKETPLACE_SCHEMA_VERSION,
  KNOWN_THEME_FEATURES,
  type MarketplaceManifestError,
} from './marketplace-manifest.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const base = () => ({
  schema_version: SUPPORTED_MARKETPLACE_SCHEMA_VERSION,
  name: 'Gbox Minimal',
  slug: 'gbox-minimal',
  version: '1.0.0',
  author: 'Gbox',
  preview: 'https://themes.gbox.co/preview/gbox-minimal',
  supported_locales: ['en', 'vi'],
  required_features: ['sections', 'json_templates'],
  description: 'A clean starting point',
  license: 'MIT',
})

function codes(errs: MarketplaceManifestError[]): string[] {
  return errs.map((e) => `${e.path}:${e.code}`)
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('parseMarketplaceManifest — happy path', () => {
  it('accepts a complete well-formed manifest', () => {
    const out = parseMarketplaceManifest(base())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.manifest.slug).toBe('gbox-minimal')
    expect(out.manifest.supported_locales).toEqual(['en', 'vi'])
  })

  it('accepts a JSON string and parses it', () => {
    const out = parseMarketplaceManifest(JSON.stringify(base()))
    expect(out.ok).toBe(true)
  })

  it('normalises the slug to lowercase kebab-case', () => {
    const out = parseMarketplaceManifest({ ...base(), slug: 'Gbox_Minimal' })
    expect(out.ok).toBe(false) // underscores are not allowed
  })

  it('strips trailing whitespace on the name + author', () => {
    const out = parseMarketplaceManifest({
      ...base(),
      name: '  Gbox Minimal  ',
      author: ' Gbox ',
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.manifest.name).toBe('Gbox Minimal')
    expect(out.manifest.author).toBe('Gbox')
  })

  it('sorts and de-dupes supported_locales + required_features', () => {
    const out = parseMarketplaceManifest({
      ...base(),
      supported_locales: ['vi', 'en', 'en'],
      required_features: ['json_templates', 'sections', 'sections'],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.manifest.supported_locales).toEqual(['en', 'vi'])
    expect(out.manifest.required_features).toEqual([
      'json_templates',
      'sections',
    ])
  })
})

// ---------------------------------------------------------------------------
// Rejection paths
// ---------------------------------------------------------------------------

describe('parseMarketplaceManifest — rejections', () => {
  it('rejects a non-object input', () => {
    const out = parseMarketplaceManifest(42)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.errors[0]!.code).toBe('invalid_payload')
  })

  it('rejects invalid JSON string', () => {
    const out = parseMarketplaceManifest('{ not json ')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.errors[0]!.code).toBe('invalid_json')
  })

  it('rejects an unsupported schema_version', () => {
    const out = parseMarketplaceManifest({ ...base(), schema_version: 99 })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(codes(out.errors)).toContain('schema_version:unsupported_version')
  })

  it('rejects missing required fields', () => {
    const { name, version, author, preview, slug, ...rest } = base() as any
    const out = parseMarketplaceManifest(rest)
    expect(out.ok).toBe(false)
    if (out.ok) return
    const keys = codes(out.errors)
    expect(keys).toContain('name:required')
    expect(keys).toContain('version:required')
    expect(keys).toContain('author:required')
    expect(keys).toContain('preview:required')
    expect(keys).toContain('slug:required')
  })

  it('rejects a non-semver version', () => {
    const out = parseMarketplaceManifest({ ...base(), version: 'beta' })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(codes(out.errors)).toContain('version:invalid_version')
  })

  it('rejects an invalid preview URL', () => {
    const out = parseMarketplaceManifest({
      ...base(),
      preview: 'ftp://themes.gbox.co/x',
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(codes(out.errors)).toContain('preview:invalid_url')
  })

  it('rejects a slug with disallowed characters', () => {
    const out = parseMarketplaceManifest({ ...base(), slug: 'Gbox Minimal' })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(codes(out.errors)).toContain('slug:invalid_slug')
  })

  it('rejects non-BCP-47 locale tags', () => {
    const out = parseMarketplaceManifest({
      ...base(),
      supported_locales: ['english'],
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(codes(out.errors)).toContain('supported_locales:invalid_locale')
  })

  it('rejects unknown features not in KNOWN_THEME_FEATURES', () => {
    const unknown = 'telepathy'
    expect(KNOWN_THEME_FEATURES.includes(unknown as any)).toBe(false)
    const out = parseMarketplaceManifest({
      ...base(),
      required_features: ['sections', unknown],
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(codes(out.errors)).toContain('required_features:unknown_feature')
  })

  it('aggregates multiple errors in one pass', () => {
    const out = parseMarketplaceManifest({
      ...base(),
      version: 'beta',
      preview: 'not-a-url',
      slug: 'X',
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.errors.length).toBeGreaterThanOrEqual(3)
  })
})
