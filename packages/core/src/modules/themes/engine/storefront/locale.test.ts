/**
 * Gbox Platform — Locale negotiation tests
 *
 * Decision #1 Step 1.14. Cover URL-prefix stripping, Accept-Language
 * parsing + ranking, base-language fallback, and the top-level
 * cascade order.
 */

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_LOCALE_CONFIG,
  negotiateLocale,
  parseAcceptLanguage,
  pickFromAcceptLanguage,
  stripLocalePrefix,
  type LocaleConfig,
} from './locale.js'

const MULTI: LocaleConfig = {
  supported: ['en', 'vi', 'fr'],
  default: 'en',
}

// ---------------------------------------------------------------------------
// stripLocalePrefix
// ---------------------------------------------------------------------------

describe('stripLocalePrefix', () => {
  it('strips a known prefix from a nested path', () => {
    expect(stripLocalePrefix('/vi/products/foo', MULTI)).toEqual({
      locale: 'vi',
      strippedPath: '/products/foo',
    })
  })

  it('returns root for `/locale` with no trailing slash', () => {
    expect(stripLocalePrefix('/vi', MULTI)).toEqual({
      locale: 'vi',
      strippedPath: '/',
    })
  })

  it('returns root for `/locale/`', () => {
    expect(stripLocalePrefix('/vi/', MULTI)).toEqual({
      locale: 'vi',
      strippedPath: '/',
    })
  })

  it('matches case-insensitively', () => {
    expect(stripLocalePrefix('/VI/products', MULTI)).toEqual({
      locale: 'vi',
      strippedPath: '/products',
    })
  })

  it('does not strip a prefix that is only a substring of a segment', () => {
    expect(stripLocalePrefix('/violet/products', MULTI)).toBeNull()
  })

  it('returns null when the first segment is not supported', () => {
    expect(stripLocalePrefix('/de/products', MULTI)).toBeNull()
  })

  it('returns null on the root path', () => {
    expect(stripLocalePrefix('/', MULTI)).toBeNull()
  })

  it('returns null on a path missing leading slash', () => {
    expect(stripLocalePrefix('vi/products', MULTI)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// parseAcceptLanguage
// ---------------------------------------------------------------------------

describe('parseAcceptLanguage', () => {
  it('parses a simple list and lowercases tags', () => {
    expect(parseAcceptLanguage('en-US,vi,fr')).toEqual([
      'en-us',
      'vi',
      'fr',
    ])
  })

  it('orders by quality factor desc', () => {
    expect(parseAcceptLanguage('en;q=0.5,vi;q=0.9,fr;q=0.7')).toEqual([
      'vi',
      'fr',
      'en',
    ])
  })

  it('treats missing q as 1', () => {
    expect(parseAcceptLanguage('en;q=0.4,vi')).toEqual(['vi', 'en'])
  })

  it('drops the wildcard `*` entry', () => {
    expect(parseAcceptLanguage('*;q=0.1,en')).toEqual(['en'])
  })

  it('returns empty array for empty header', () => {
    expect(parseAcceptLanguage('')).toEqual([])
  })

  it('is stable on equal quality (preserves order)', () => {
    expect(parseAcceptLanguage('en;q=0.8,vi;q=0.8,fr;q=0.8')).toEqual([
      'en',
      'vi',
      'fr',
    ])
  })
})

// ---------------------------------------------------------------------------
// pickFromAcceptLanguage
// ---------------------------------------------------------------------------

describe('pickFromAcceptLanguage', () => {
  it('matches exactly when present', () => {
    expect(pickFromAcceptLanguage(['vi', 'en'], MULTI)).toBe('vi')
  })

  it('falls back to base-language match', () => {
    expect(pickFromAcceptLanguage(['en-us'], MULTI)).toBe('en')
  })

  it('returns null when nothing matches', () => {
    expect(pickFromAcceptLanguage(['de', 'ja'], MULTI)).toBeNull()
  })

  it('returns null on empty input', () => {
    expect(pickFromAcceptLanguage([], MULTI)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// negotiateLocale (top-level cascade)
// ---------------------------------------------------------------------------

describe('negotiateLocale', () => {
  it('URL prefix wins over Accept-Language', () => {
    const result = negotiateLocale(
      '/vi/products/foo',
      'fr,en;q=0.8',
      MULTI,
    )
    expect(result.locale).toBe('vi')
    expect(result.strippedPath).toBe('/products/foo')
  })

  it('falls back to Accept-Language when URL has no prefix', () => {
    const result = negotiateLocale(
      '/products/foo',
      'fr-CA,en;q=0.5',
      MULTI,
    )
    expect(result.locale).toBe('fr')
    expect(result.strippedPath).toBe('/products/foo')
  })

  it('falls back to default when nothing else matches', () => {
    const result = negotiateLocale(
      '/products/foo',
      'de,ja;q=0.5',
      MULTI,
    )
    expect(result.locale).toBe('en')
    expect(result.strippedPath).toBe('/products/foo')
  })

  it('returns default when Accept-Language is missing', () => {
    const result = negotiateLocale('/cart', undefined, MULTI)
    expect(result.locale).toBe('en')
    expect(result.strippedPath).toBe('/cart')
  })

  it('uses DEFAULT_LOCALE_CONFIG out of the box', () => {
    const result = negotiateLocale('/', 'en', DEFAULT_LOCALE_CONFIG)
    expect(result.locale).toBe('en')
    expect(result.strippedPath).toBe('/')
  })
})
