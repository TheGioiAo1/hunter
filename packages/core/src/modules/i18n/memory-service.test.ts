/**
 * Gbox Platform — MemoryI18nService unit tests
 *
 * Decision #1 Step 1.2b — Exercises the in-memory implementation
 * (which is the same fallback chain logic as the DB-backed one,
 * minus the cache layer + query). Covers every public method and
 * every branch of the three-tier fallback.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryI18nService } from './memory-service.js'

const SHOP = 'shop_1'

describe('MemoryI18nService — basic CRUD', () => {
  let i18n: MemoryI18nService

  beforeEach(() => {
    i18n = new MemoryI18nService()
  })

  it('returns the key as fallback when nothing is stored', async () => {
    expect(await i18n.t(SHOP, 'cart.title')).toBe('cart.title')
  })

  it('respects custom fallback string', async () => {
    expect(await i18n.t(SHOP, 'cart.title', { fallback: 'Cart' })).toBe('Cart')
  })

  it('round-trips set + t', async () => {
    await i18n.set(SHOP, 'en', 'cart.title', 'Cart')
    expect(await i18n.t(SHOP, 'cart.title', { locale: 'en' })).toBe('Cart')
  })

  it('preload returns the dict for a (shop, locale)', async () => {
    await i18n.set(SHOP, 'en', 'a', '1')
    await i18n.set(SHOP, 'en', 'b', '2')
    const dict = await i18n.preload(SHOP, 'en')
    expect(dict).toEqual({ a: '1', b: '2' })
  })

  it('preload returns empty object for missing (shop, locale)', async () => {
    expect(await i18n.preload(SHOP, 'fr')).toEqual({})
  })

  it('setMany inserts a batch and returns count', async () => {
    const n = await i18n.setMany(SHOP, 'en', {
      'cart.title': 'Cart',
      'cart.empty': 'Your cart is empty',
      'cart.checkout': 'Checkout',
    })
    expect(n).toBe(3)
    expect(await i18n.t(SHOP, 'cart.title', { locale: 'en' })).toBe('Cart')
    expect(await i18n.t(SHOP, 'cart.empty', { locale: 'en' })).toBe(
      'Your cart is empty',
    )
  })

  it('setMany on empty object returns 0', async () => {
    expect(await i18n.setMany(SHOP, 'en', {})).toBe(0)
  })
})

describe('MemoryI18nService — three-tier fallback chain', () => {
  // Seed: shop has Vietnamese for cart.title only, English for everything.
  const i18n = new MemoryI18nService({
    [SHOP]: {
      en: {
        'cart.title': 'Cart',
        'cart.empty': 'Your cart is empty',
        'cart.checkout': 'Checkout',
      },
      vi: {
        'cart.title': 'Giỏ hàng',
      },
      fr: {
        'cart.title': 'Panier',
      },
    },
  })

  it('Tier 1: requested locale wins when key exists', async () => {
    expect(
      await i18n.t(SHOP, 'cart.title', { locale: 'vi', shopDefaultLocale: 'en' }),
    ).toBe('Giỏ hàng')
  })

  it('Tier 2: shop default locale fills the gap when requested locale is missing the key', async () => {
    // 'cart.empty' only exists in 'en'; user requested 'vi'; shop default is 'en'
    expect(
      await i18n.t(SHOP, 'cart.empty', { locale: 'vi', shopDefaultLocale: 'en' }),
    ).toBe('Your cart is empty')
  })

  it('Tier 3: ULTIMATE_FALLBACK en fills when even shop default does not have the key', async () => {
    // shop default = 'fr' (only has cart.title); user wants 'cart.checkout'
    // → tier 3 = 'en' has it
    expect(
      await i18n.t(SHOP, 'cart.checkout', { locale: 'fr', shopDefaultLocale: 'fr' }),
    ).toBe('Checkout')
  })

  it('Tier 4 (sentinel): returns fallback when no tier resolves', async () => {
    expect(
      await i18n.t(SHOP, 'no.such.key', {
        locale: 'vi',
        shopDefaultLocale: 'en',
        fallback: 'NOPE',
      }),
    ).toBe('NOPE')
  })

  it('Tier 4 (sentinel): returns the key when no fallback supplied', async () => {
    expect(
      await i18n.t(SHOP, 'no.such.key', { locale: 'vi', shopDefaultLocale: 'en' }),
    ).toBe('no.such.key')
  })

  it('does not double-traverse when locale === shopDefaultLocale', async () => {
    // Just verify the result is correct; the no-double-walk is internal.
    expect(await i18n.t(SHOP, 'cart.title', { locale: 'en', shopDefaultLocale: 'en' }))
      .toBe('Cart')
  })

  it('with no locale opts, falls straight to ULTIMATE_FALLBACK en', async () => {
    expect(await i18n.t(SHOP, 'cart.title')).toBe('Cart')
  })
})

describe('MemoryI18nService — interpolation', () => {
  let i18n: MemoryI18nService
  beforeEach(() => {
    i18n = new MemoryI18nService()
  })

  it('substitutes vars in resolved value', async () => {
    await i18n.set(SHOP, 'en', 'cart.line_count', 'You have {{ count }} items')
    expect(
      await i18n.t(SHOP, 'cart.line_count', { locale: 'en', vars: { count: 3 } }),
    ).toBe('You have 3 items')
  })

  it('does not substitute in fallback string when no value resolves', async () => {
    // Fallback is the raw key; no vars applied to keys.
    expect(
      await i18n.t(SHOP, 'missing.key', { vars: { count: 3 } }),
    ).toBe('missing.key')
  })
})

describe('MemoryI18nService — invalidation', () => {
  let i18n: MemoryI18nService
  beforeEach(() => {
    i18n = new MemoryI18nService()
  })

  it('invalidate(shop, locale) drops only that locale', async () => {
    await i18n.set(SHOP, 'en', 'k', 'EN')
    await i18n.set(SHOP, 'vi', 'k', 'VI')
    i18n.invalidate(SHOP, 'en')
    expect(await i18n.t(SHOP, 'k', { locale: 'en' })).toBe('k') // gone
    expect(await i18n.t(SHOP, 'k', { locale: 'vi' })).toBe('VI') // intact
  })

  it('invalidate(shop) drops every locale', async () => {
    await i18n.set(SHOP, 'en', 'k', 'EN')
    await i18n.set(SHOP, 'vi', 'k', 'VI')
    i18n.invalidate(SHOP)
    expect(await i18n.t(SHOP, 'k', { locale: 'en' })).toBe('k')
    expect(await i18n.t(SHOP, 'k', { locale: 'vi' })).toBe('k')
  })
})
