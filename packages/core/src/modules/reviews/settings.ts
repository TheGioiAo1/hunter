/**
 * Gbox Platform — Shop Review Settings Service (Phase 10 PR3)
 *
 * Per-shop toggles that drive review moderation + notification policy.
 * Backed by `shop_review_settings` (migration 071). The row is created
 * lazily on first read so the seller never has to explicitly "enable"
 * anything — the defaults in the migration are the right defaults.
 *
 * Shape:
 *
 *   profanity_filter_enabled     bool   default true
 *   profanity_extra_terms        jsonb  default []
 *   notify_customer_on_approve   bool   default true
 *   notify_customer_on_reply     bool   default true
 *
 * Contract:
 *
 *   getShopReviewSettings(db, shopId)       → resolved settings (never null)
 *   upsertShopReviewSettings(db, shopId, p) → resolved settings after patch
 *   resolveVoteSalt(shopId)                 → deterministic per-shop salt
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { createHash } from 'node:crypto'
import type { Database } from '@gbox/db/schema/tables.js'
import { normaliseExtraTerms } from './profanity.js'

export interface ShopReviewSettings {
  shopId: string
  profanityFilterEnabled: boolean
  profanityExtraTerms: string[]
  notifyCustomerOnApprove: boolean
  notifyCustomerOnReply: boolean
}

export interface UpsertShopReviewSettingsInput {
  profanityFilterEnabled?: boolean
  profanityExtraTerms?: unknown // accept raw JSON/array/comma-string
  notifyCustomerOnApprove?: boolean
  notifyCustomerOnReply?: boolean
}

const DEFAULTS = Object.freeze({
  profanityFilterEnabled: true,
  profanityExtraTerms: [] as string[],
  notifyCustomerOnApprove: true,
  notifyCustomerOnReply: true,
})

/**
 * Read the settings for a shop. Returns the migration defaults if no
 * row exists yet — callers can rely on this always returning a fully
 * populated object.
 */
export async function getShopReviewSettings(
  db: Kysely<Database>,
  shopId: string,
): Promise<ShopReviewSettings> {
  const row = await db
    .selectFrom('shop_review_settings')
    .selectAll()
    .where('shop_id', '=', shopId)
    .executeTakeFirst()

  if (!row) {
    return {
      shopId,
      profanityFilterEnabled: DEFAULTS.profanityFilterEnabled,
      profanityExtraTerms: [...DEFAULTS.profanityExtraTerms],
      notifyCustomerOnApprove: DEFAULTS.notifyCustomerOnApprove,
      notifyCustomerOnReply: DEFAULTS.notifyCustomerOnReply,
    }
  }

  return {
    shopId: row.shop_id,
    profanityFilterEnabled: Boolean(row.profanity_filter_enabled),
    profanityExtraTerms: normaliseExtraTerms(row.profanity_extra_terms),
    notifyCustomerOnApprove: Boolean(row.notify_customer_on_approve),
    notifyCustomerOnReply: Boolean(row.notify_customer_on_reply),
  }
}

/**
 * Upsert a patch onto the settings row. Any field omitted from `patch`
 * is preserved. Returns the resolved settings after the write.
 */
export async function upsertShopReviewSettings(
  db: Kysely<Database>,
  shopId: string,
  patch: UpsertShopReviewSettingsInput,
): Promise<ShopReviewSettings> {
  const current = await getShopReviewSettings(db, shopId)

  const next: ShopReviewSettings = {
    shopId,
    profanityFilterEnabled:
      patch.profanityFilterEnabled ?? current.profanityFilterEnabled,
    profanityExtraTerms:
      patch.profanityExtraTerms !== undefined
        ? normaliseExtraTerms(patch.profanityExtraTerms)
        : current.profanityExtraTerms,
    notifyCustomerOnApprove:
      patch.notifyCustomerOnApprove ?? current.notifyCustomerOnApprove,
    notifyCustomerOnReply:
      patch.notifyCustomerOnReply ?? current.notifyCustomerOnReply,
  }

  const existing = await db
    .selectFrom('shop_review_settings')
    .select('shop_id')
    .where('shop_id', '=', shopId)
    .executeTakeFirst()

  if (existing) {
    await db
      .updateTable('shop_review_settings')
      .set({
        profanity_filter_enabled: next.profanityFilterEnabled,
        profanity_extra_terms: JSON.stringify(next.profanityExtraTerms) as any,
        notify_customer_on_approve: next.notifyCustomerOnApprove,
        notify_customer_on_reply: next.notifyCustomerOnReply,
        updated_at: new Date().toISOString(),
      } as any)
      .where('shop_id', '=', shopId)
      .execute()
  } else {
    await db
      .insertInto('shop_review_settings')
      .values({
        shop_id: shopId,
        profanity_filter_enabled: next.profanityFilterEnabled,
        profanity_extra_terms: JSON.stringify(next.profanityExtraTerms) as any,
        notify_customer_on_approve: next.notifyCustomerOnApprove,
        notify_customer_on_reply: next.notifyCustomerOnReply,
      } as any)
      .execute()
  }

  return next
}

/**
 * Deterministic per-shop salt used by the vote ip_hash. We don't keep
 * a raw random per-shop secret — that would drift if the row is wiped.
 * Instead we hash the shop_id with a platform-level constant so:
 *   - the salt is stable for the shop's lifetime
 *   - it's opaque to storefront JS
 *   - two shops can never collide (different shop_id → different salt)
 */
export function resolveVoteSalt(shopId: string): string {
  return createHash('sha256')
    .update('gbox-review-vote-salt|')
    .update(shopId)
    .digest('hex')
}

export { DEFAULTS as _SHOP_REVIEW_SETTINGS_DEFAULTS }
