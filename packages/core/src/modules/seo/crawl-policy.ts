/**
 * Gbox Platform — Shop Crawl Policy (Phase 8 PR3)
 *
 * Centralised "should search engines index this shop?" decision. Consumed
 * by the storefront's sitemap.xml / robots.txt factory
 * (see apps/storefront/src/middleware/seo-routes.ts) and by the
 * head-injection helper that renders `<meta name="robots">`.
 *
 * Inputs:
 *   - shops.status  — suspended / closed shops are never crawlable.
 *   - shops.seo_settings.robots_noindex — merchant kill switch from the
 *     SEO admin page. When true, we serve the same "shut the door"
 *     variants as a password-protected shop.
 *
 * Future:
 *   - `password_enabled` column on `shops` (not yet migrated) will
 *     flip `passwordProtected` to true without going via the SEO page.
 *     The resolver has an `_or` branch ready for that day.
 *
 * This module does NOT compose meta tags itself — it just exposes the
 * resolved policy. Rendering is the caller's job (sitemap vs robots
 * vs head meta each pick different outputs from the same boolean).
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { mergeSettings, type SeoSettings } from './seo-settings.js'

export interface ShopCrawlPolicy {
  /** True when the shop should be crawled + indexed. */
  crawlable: boolean
  /** True when the shop has the password wall enabled. */
  passwordProtected: boolean
  /** True when the merchant flipped the noindex switch themselves. */
  merchantNoindex: boolean
}

/**
 * Pure policy computation. Takes the raw shop row + merged SEO settings
 * and decides what the crawlers see. Split from the DB-bound resolver
 * below so tests don't need a Kysely fake.
 */
export function computeCrawlPolicy(shop: {
  status: string | null
}, settings: SeoSettings): ShopCrawlPolicy {
  const active = shop.status === 'active'
  const merchantNoindex = settings.robots_noindex
  const passwordProtected = false // reserved for the future password wall

  return {
    crawlable: active && !merchantNoindex && !passwordProtected,
    passwordProtected,
    merchantNoindex,
  }
}

/**
 * DB-bound helper. Reads `shops.status` + `shops.seo_settings` in a
 * single SELECT and hands the result to `computeCrawlPolicy`.
 *
 * Returns the `closed` variant for unknown shop ids so that a bad
 * `req.gboxShopId` never accidentally serves a real sitemap.
 */
export async function getShopCrawlPolicy(
  db: Kysely<Database>,
  shopId: string,
): Promise<ShopCrawlPolicy> {
  const row = await (db as any)
    .selectFrom('shops')
    .where('id', '=', shopId)
    .select(['status', 'seo_settings'])
    .executeTakeFirst()

  if (!row) {
    return {
      crawlable: false,
      passwordProtected: false,
      merchantNoindex: false,
    }
  }

  const settings = mergeSettings(row.seo_settings)
  return computeCrawlPolicy({ status: row.status }, settings)
}
