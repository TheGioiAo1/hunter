/**
 * Gbox Platform — i18n Service (Database-backed)
 *
 * Decision #1 Step 1.2b — Production implementation of `I18nService`
 * that reads from the `translations` table (migration 008).
 *
 * Three-tier fallback chain (Shopify-compatible):
 *
 *     1. requested locale            (TranslateOptions.locale)
 *     2. shop default locale         (TranslateOptions.shopDefaultLocale or 'en')
 *     3. ULTIMATE_FALLBACK = 'en'
 *     4. opts.fallback ?? key        (sentinel — never throws)
 *
 * The chain is short-circuit: as soon as a tier returns a value, we
 * stop. Tiers 1 and 2 may resolve to the same locale (no double work
 * because the cache key is by locale, not by tier).
 *
 * Cache strategy:
 *   - In-process Map<`${shopId}:${locale}`, TranslationDict>
 *   - Lazy load: first lookup for a (shop, locale) issues one
 *     `SELECT key, value FROM translations WHERE shop_id=? AND locale=?`
 *     and stuffs the entire result set into the cache.
 *   - Manual `invalidate(shopId, locale?)` from the admin UI after
 *     an edit. Without `locale` argument, drops every locale for
 *     that shop (covers bulk import/import-export flows).
 *   - No TTL: theme assets are ~immutable and the admin UI explicitly
 *     calls invalidate(). A TTL would create cache stampedes during
 *     traffic spikes for zero benefit.
 *   - Per-process: each Node worker has its own cache. Acceptable
 *     because translations are tiny (~80KB per locale per shop) and
 *     reads are O(1) memory hits after the first request warms it.
 *     If a future deploy needs cross-process invalidation we can
 *     subscribe to a Redis channel without changing the public API.
 *
 * The DB dependency is injected (kysely instance) so unit tests can
 * pass a stub. The production wiring lives in the engine factory.
 */

import type { Kysely } from 'kysely'
import { interpolate } from './interpolate.js'
import type {
  I18nService,
  TranslateOptions,
  TranslationDict,
} from './types.js'

const ULTIMATE_FALLBACK_LOCALE = 'en'

interface I18nDb {
  // Subset of the Kysely Database type — only the bits we use. Defined
  // as a structural interface so we can mock it in tests without
  // importing the full @gbox/db schema.
  selectFrom(table: 'translations'): any
  insertInto(table: 'translations'): any
}

export class DbI18nService implements I18nService {
  private readonly db: Kysely<any> | I18nDb
  private readonly cache = new Map<string, TranslationDict>()
  // Track in-flight loads so concurrent requests for the same key
  // share one DB round-trip instead of dog-piling.
  private readonly inflight = new Map<string, Promise<TranslationDict>>()

  constructor(db: Kysely<any>) {
    this.db = db
  }

  // -------------------------------------------------------------------------
  // Cache key helper
  // -------------------------------------------------------------------------

  private cacheKey(shopId: string, locale: string): string {
    return `${shopId}:${locale}`
  }

  // -------------------------------------------------------------------------
  // preload — bulk fetch + cache
  // -------------------------------------------------------------------------

  async preload(shopId: string, locale: string): Promise<TranslationDict> {
    const ck = this.cacheKey(shopId, locale)
    const hit = this.cache.get(ck)
    if (hit) return hit

    const inflight = this.inflight.get(ck)
    if (inflight) return inflight

    const promise = (async () => {
      const rows = await (this.db as Kysely<any>)
        .selectFrom('translations')
        .select(['key', 'value'])
        .where('shop_id', '=', shopId)
        .where('locale', '=', locale)
        .execute()

      const dict: TranslationDict = {}
      for (const row of rows as Array<{ key: string; value: string }>) {
        dict[row.key] = row.value
      }
      this.cache.set(ck, dict)
      this.inflight.delete(ck)
      return dict
    })()

    this.inflight.set(ck, promise)
    try {
      return await promise
    } catch (err) {
      // On error, clear the inflight slot so a retry can re-issue.
      this.inflight.delete(ck)
      throw err
    }
  }

  // -------------------------------------------------------------------------
  // t — three-tier fallback lookup
  // -------------------------------------------------------------------------

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

    for (const locale of tiers) {
      const dict = await this.preload(shopId, locale)
      const raw = dict[key]
      if (raw !== undefined) {
        return interpolate(raw, opts.vars)
      }
    }

    // Sentinel fallback: opts.fallback if supplied, else the key itself.
    return opts.fallback ?? key
  }

  // -------------------------------------------------------------------------
  // set — single upsert
  // -------------------------------------------------------------------------

  async set(shopId: string, locale: string, key: string, value: string): Promise<void> {
    await (this.db as Kysely<any>)
      .insertInto('translations')
      .values({ shop_id: shopId, locale, key, value })
      .onConflict((oc: any) =>
        oc
          .columns(['shop_id', 'locale', 'key'])
          .doUpdateSet({ value, updated_at: new Date() }),
      )
      .execute()

    // Invalidate just the (shop, locale) — keeps other locales warm.
    this.cache.delete(this.cacheKey(shopId, locale))
  }

  // -------------------------------------------------------------------------
  // setMany — bulk upsert
  // -------------------------------------------------------------------------

  async setMany(
    shopId: string,
    locale: string,
    entries: TranslationDict,
  ): Promise<number> {
    const rows = Object.entries(entries).map(([key, value]) => ({
      shop_id: shopId,
      locale,
      key,
      value,
    }))
    if (rows.length === 0) return 0

    await (this.db as Kysely<any>)
      .insertInto('translations')
      .values(rows)
      .onConflict((oc: any) =>
        oc
          .columns(['shop_id', 'locale', 'key'])
          .doUpdateSet({
            value: (eb: any) => eb.ref('excluded.value'),
            updated_at: new Date(),
          }),
      )
      .execute()

    this.cache.delete(this.cacheKey(shopId, locale))
    return rows.length
  }

  // -------------------------------------------------------------------------
  // invalidate
  // -------------------------------------------------------------------------

  invalidate(shopId: string, locale?: string): void {
    if (locale) {
      this.cache.delete(this.cacheKey(shopId, locale))
      return
    }
    // Drop every locale for this shop.
    const prefix = `${shopId}:`
    for (const k of this.cache.keys()) {
      if (k.startsWith(prefix)) this.cache.delete(k)
    }
  }

  // -------------------------------------------------------------------------
  // Test-only helpers
  // -------------------------------------------------------------------------

  /** Test helper: number of cached (shop, locale) pairs. */
  _cacheSize(): number {
    return this.cache.size
  }

  /** Test helper: read raw cache for assertions. */
  _peekCache(shopId: string, locale: string): TranslationDict | undefined {
    return this.cache.get(this.cacheKey(shopId, locale))
  }

  /** Test helper: clear everything. */
  _clearCache(): void {
    this.cache.clear()
    this.inflight.clear()
  }
}
