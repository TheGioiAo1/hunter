/**
 * Gbox Platform — i18n pure translate helper tests (Stage 5.4)
 *
 * The existing `I18nService` interface is async — it owns DB +
 * cache + preload. That's fine for the admin side, but the
 * storefront render path wants a SYNC call (no await per key) on
 * an already-loaded bundle. This module provides that pure
 * helper:
 *
 *   translateKey(bundles, locale, key, opts?) → string
 *
 * It walks a BCP-47 fallback chain (vi-VN → vi → en → default)
 * and substitutes `{{ var }}` tokens using the existing
 * `interpolate` helper.
 *
 *   buildLocaleFallbackChain('vi-VN', 'en') → ['vi-VN', 'vi', 'en']
 *
 * Tests pin every fallback branch, interpolation, and miss.
 */

import { describe, it, expect } from 'vitest'
import {
  translateKey,
  buildLocaleFallbackChain,
  type TranslationBundles,
} from './translate.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const bundles: TranslationBundles = {
  en: {
    'cart.title': 'Cart',
    'cart.empty': 'Your cart is empty',
    'cart.line_item_count': 'You have {{ count }} items',
    'common.hello': 'Hello {{ name }}',
  },
  vi: {
    'cart.title': 'Giỏ hàng',
    'cart.line_item_count': 'Bạn có {{ count }} sản phẩm',
    // "common.hello" intentionally omitted so we can test fallback
  },
  'vi-VN': {
    'cart.title': 'Giỏ hàng (VN)',
    // missing cart.line_item_count → falls back to 'vi'
  },
}

// ---------------------------------------------------------------------------
// buildLocaleFallbackChain
// ---------------------------------------------------------------------------

describe('buildLocaleFallbackChain', () => {
  it('returns [requested, base, default] for regional tag', () => {
    expect(buildLocaleFallbackChain('vi-VN', 'en')).toEqual(['vi-VN', 'vi', 'en'])
  })

  it('returns [requested, default] for simple tag', () => {
    expect(buildLocaleFallbackChain('fr', 'en')).toEqual(['fr', 'en'])
  })

  it('does not duplicate when requested equals default', () => {
    expect(buildLocaleFallbackChain('en', 'en')).toEqual(['en'])
  })

  it('handles three-segment tags like zh-Hant-TW', () => {
    expect(buildLocaleFallbackChain('zh-Hant-TW', 'en')).toEqual([
      'zh-Hant-TW',
      'zh-Hant',
      'zh',
      'en',
    ])
  })

  it('de-dupes when the base equals the default', () => {
    expect(buildLocaleFallbackChain('en-US', 'en')).toEqual(['en-US', 'en'])
  })

  it('normalises case — en-us → en-US', () => {
    expect(buildLocaleFallbackChain('en-us', 'en')).toEqual(['en-US', 'en'])
  })
})

// ---------------------------------------------------------------------------
// translateKey
// ---------------------------------------------------------------------------

describe('translateKey', () => {
  it('returns the requested locale value when present', () => {
    const out = translateKey(bundles, 'vi-VN', 'cart.title', { defaultLocale: 'en' })
    expect(out).toBe('Giỏ hàng (VN)')
  })

  it('falls back to the base locale when the regional tag is missing', () => {
    const out = translateKey(bundles, 'vi-VN', 'cart.line_item_count', {
      defaultLocale: 'en',
      vars: { count: 3 },
    })
    expect(out).toBe('Bạn có 3 sản phẩm')
  })

  it('falls back to the default locale when the base locale misses', () => {
    const out = translateKey(bundles, 'vi', 'common.hello', {
      defaultLocale: 'en',
      vars: { name: 'Alice' },
    })
    expect(out).toBe('Hello Alice')
  })

  it('returns the key itself when every locale misses (Shopify behaviour)', () => {
    const out = translateKey(bundles, 'vi', 'cart.nonexistent', { defaultLocale: 'en' })
    expect(out).toBe('cart.nonexistent')
  })

  it('uses the custom fallback when provided', () => {
    const out = translateKey(bundles, 'vi', 'cart.nonexistent', {
      defaultLocale: 'en',
      fallback: '(missing)',
    })
    expect(out).toBe('(missing)')
  })

  it('interpolates vars into the resolved value', () => {
    const out = translateKey(bundles, 'en', 'cart.line_item_count', {
      defaultLocale: 'en',
      vars: { count: 5 },
    })
    expect(out).toBe('You have 5 items')
  })

  it('returns a safe no-op when bundles is empty', () => {
    const out = translateKey({}, 'en', 'anything', { defaultLocale: 'en' })
    expect(out).toBe('anything')
  })

  it('honours an empty-string value in the resolved bundle', () => {
    const b: TranslationBundles = { en: { 'cart.empty': '' } }
    const out = translateKey(b, 'en', 'cart.empty', { defaultLocale: 'en' })
    // Shopify treats an empty string as a real value, not a miss.
    expect(out).toBe('')
  })

  it('defaults locale to defaultLocale when locale is omitted', () => {
    const out = translateKey(bundles, undefined, 'cart.title', {
      defaultLocale: 'en',
    })
    expect(out).toBe('Cart')
  })
})
