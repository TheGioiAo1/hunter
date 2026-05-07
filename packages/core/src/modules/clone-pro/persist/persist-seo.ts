/**
 * Clone Pro — SEO Metadata Persistence
 *
 * Persists extracted SEO metadata to shop_settings.
 * Uses the standard key-value JSONB pattern for shop settings.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CloneSEOData {
  readonly meta_title: string
  readonly meta_description: string
  readonly og_image: string | null
  readonly favicon_url: string | null
  readonly site_name: string | null
  readonly social_links: Record<string, string>
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist cloned SEO metadata to shop_settings.
 * Upserts the 'seo_settings' and 'social_links' keys.
 *
 * @param db - Kysely database instance
 * @param shopId - Target shop UUID
 * @param seoData - Extracted SEO data
 */
export async function persistCloneSEO(
  db: Kysely<Database>,
  shopId: string,
  seoData: CloneSEOData,
): Promise<void> {
  // Persist SEO settings
  await upsertShopSetting(db, shopId, 'seo_settings', {
    meta_title: seoData.meta_title,
    meta_description: seoData.meta_description,
    og_image: seoData.og_image,
    favicon_url: seoData.favicon_url,
    site_name: seoData.site_name,
  })

  // Persist social links (if any)
  if (Object.keys(seoData.social_links).length > 0) {
    await upsertShopSetting(db, shopId, 'social_links', seoData.social_links)
  }
}

// ---------------------------------------------------------------------------
// Shop settings upsert helper
// ---------------------------------------------------------------------------

async function upsertShopSetting(
  db: Kysely<Database>,
  shopId: string,
  key: string,
  value: Record<string, unknown>,
): Promise<void> {
  const existing = await db
    .selectFrom('shop_settings')
    .select('id')
    .where('shop_id', '=', shopId)
    .where('key', '=', key)
    .executeTakeFirst()

  if (existing) {
    await db
      .updateTable('shop_settings')
      .set({
        value: JSON.stringify(value),
        updated_at: new Date().toISOString(),
      } as any)
      .where('id', '=', existing.id)
      .execute()
  } else {
    await db
      .insertInto('shop_settings')
      .values({
        shop_id: shopId,
        key,
        value: JSON.stringify(value),
      } as any)
      .execute()
  }
}
