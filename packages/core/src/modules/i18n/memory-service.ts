/**
 * Gbox Platform — In-Memory I18nService
 *
 * Decision #1 Step 1.2b — A pure-memory `I18nService` implementation
 * for tests and for environments where no database is wired (early
 * theme engine smoke tests, the LiquidJS filter unit tests).
 *
 * The fallback chain logic is identical to `DbI18nService` so tests
 * exercise the same path the production engine will run. Only the
 * storage backend differs.
 */

import { interpolate } from './interpolate.js'
import type {
  I18nService,
  TranslateOptions,
  TranslationDict,
} from './types.js'

const ULTIMATE_FALLBACK_LOCALE = 'en'

export class MemoryI18nService implements I18nService {
  /**
   * Storage shape: shopId → locale → key → value. Nested map keeps
   * `invalidate(shopId)` (no locale) to a single drop.
   */
  private readonly store = new Map<string, Map<string, TranslationDict>>()

  /**
   * Construct an empty store, or seed with fixture data:
   *
   *   new MemoryI18nService({
   *     'shop_1': {
   *       en: { 'cart.title': 'Cart' },
   *       vi: { 'cart.title': 'Giỏ hàng' },
   *     },
   *   })
   */
  constructor(seed?: Record<string, Record<string, TranslationDict>>) {
    if (seed) {
      for (const [shopId, locales] of Object.entries(seed)) {
        const shopMap = new Map<string, TranslationDict>()
        for (const [locale, dict] of Object.entries(locales)) {
          shopMap.set(locale, { ...dict })
        }
        this.store.set(shopId, shopMap)
      }
    }
  }

  async preload(shopId: string, locale: string): Promise<TranslationDict> {
    return this.store.get(shopId)?.get(locale) ?? {}
  }

  async t(shopId: string, key: string, opts: TranslateOptions = {}): Promise<string> {
    const tiers: string[] = []
    if (opts.locale) tiers.push(opts.locale)
    if (opts.shopDefaultLocale && opts.shopDefaultLocale !== opts.locale) {
      tiers.push(opts.shopDefaultLocale)
    }
    if (
      ULTIMATE_FALLBACK_LOCALE !== opts.locale &&
      ULTIMATE_FALLBACK_LOCALE !== opts.shopDefaultLocale
    ) {
      tiers.push(ULTIMATE_FALLBACK_LOCALE)
    }

    const shopMap = this.store.get(shopId)
    if (shopMap) {
      for (const locale of tiers) {
        const dict = shopMap.get(locale)
        if (dict && dict[key] !== undefined) {
          return interpolate(dict[key], opts.vars)
        }
      }
    }

    return opts.fallback ?? key
  }

  async set(shopId: string, locale: string, key: string, value: string): Promise<void> {
    let shopMap = this.store.get(shopId)
    if (!shopMap) {
      shopMap = new Map()
      this.store.set(shopId, shopMap)
    }
    let dict = shopMap.get(locale)
    if (!dict) {
      dict = {}
      shopMap.set(locale, dict)
    }
    dict[key] = value
  }

  async setMany(
    shopId: string,
    locale: string,
    entries: TranslationDict,
  ): Promise<number> {
    let count = 0
    for (const [key, value] of Object.entries(entries)) {
      await this.set(shopId, locale, key, value)
      count++
    }
    return count
  }

  invalidate(shopId: string, locale?: string): void {
    if (!locale) {
      this.store.delete(shopId)
      return
    }
    this.store.get(shopId)?.delete(locale)
  }
}
