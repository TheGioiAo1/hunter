/**
 * Gbox Platform — Notification Service
 *
 * Real-time notification management: create, read, mark as read, delete.
 * Uses the notifications table defined in the schema.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationType =
  | 'order_placed'
  | 'order_fulfilled'
  | 'low_stock'
  | 'new_customer'
  | 'payment_received'
  | 'refund_issued'
  | 'app_installed'
  // Bulk order operations — fired from orders-export / orders-import /
  // orders-import-tracking handlers so the merchant gets a bell-icon
  // confirmation for every export or import they run. Missing from the
  // original union caused "import CSV thành công cũng không có thông báo"
  // (April 2026 bug report — see CLAUDE.md iron-rule 4 comms log).
  | 'orders_exported'
  | 'orders_imported'
  | 'tracking_imported'
  // Phase 8 PR4 — review moderation lifecycle.
  | 'review_submitted'
  | 'review_approved'
  | 'review_rejected'
  | 'review_deleted'
  | 'review_replied'
  | 'review_spam_flagged'
  // Phase 9 PR1 — shipping carrier lifecycle. Bucketed under 'system'
  // because these are infrastructure/config changes rather than
  // customer-facing events (orders / reviews / etc). The migration
  // 065 NULL-category fallback reads `inferCategory(type)` so existing
  // pre-066 shipping rows also bucket correctly without a backfill.
  | 'shipping_zone_created'
  | 'shipping_zone_deleted'
  | 'shipping_rate_created'
  | 'shipping_carrier_enabled'
  | 'shipping_rates_seeded'

/**
 * High-level bucket used to group the notifications drawer. Stored on
 * the row in the `category` column (migration 065). Nullable in the DB
 * for back-compat with pre-065 rows; the service layer reads through
 * `inferCategory(type)` so every read has a non-null category even for
 * rows inserted before the column existed.
 */
export type NotificationCategory =
  | 'orders'
  | 'inventory'
  | 'customers'
  | 'billing'
  | 'reviews'
  | 'marketing'
  | 'system'
  | 'other'

export interface CreateNotificationInput {
  type: NotificationType
  title: string
  message?: string | null
  resourceType?: string | null
  resourceId?: string | null
  /**
   * Optional high-level bucket for the drawer filter. If omitted, the
   * service will `inferCategory(type)` at insert time so we never write
   * a null category for a freshly-created row.
   */
  category?: NotificationCategory | null
  /**
   * Optional click-through URL. When set, the drawer + full-page inbox
   * wrap the row in an anchor. Plain string — validated at the handler
   * layer, not here (keep the service storage-agnostic).
   */
  link?: string | null
}

/**
 * Map a NotificationType to its default category. Used as the fallback
 * when a caller omits `category` on create, and when reading rows
 * inserted before migration 065 stamped a category.
 *
 * Pure function, no DB access — safe for tests + hot paths.
 */
export function inferCategory(type: string): NotificationCategory {
  switch (type) {
    case 'order_placed':
    case 'order_fulfilled':
    case 'orders_exported':
    case 'orders_imported':
    case 'tracking_imported':
      return 'orders'
    case 'low_stock':
      return 'inventory'
    case 'new_customer':
      return 'customers'
    case 'payment_received':
    case 'refund_issued':
      return 'billing'
    case 'review_submitted':
    case 'review_approved':
    case 'review_rejected':
    case 'review_deleted':
    case 'review_replied':
    case 'review_spam_flagged':
      return 'reviews'
    case 'app_installed':
    case 'shipping_zone_created':
    case 'shipping_zone_deleted':
    case 'shipping_rate_created':
    case 'shipping_carrier_enabled':
    case 'shipping_rates_seeded':
      return 'system'
    default:
      return 'other'
  }
}

/**
 * Group a list of notification rows into category buckets for rendering
 * as tabs/sections in the inbox. Preserves the original order within
 * each bucket so the caller's "sorted by created_at DESC" stays intact.
 *
 * Rows with a null `category` column (pre-migration rows) are bucketed
 * via `inferCategory(type)` so the drawer never renders an "other" row
 * that really belongs under "orders".
 */
export function groupByCategory<T extends { type: string; category?: string | null }>(
  rows: T[],
): Record<NotificationCategory, T[]> {
  const buckets: Record<NotificationCategory, T[]> = {
    orders: [],
    inventory: [],
    customers: [],
    billing: [],
    reviews: [],
    marketing: [],
    system: [],
    other: [],
  }
  for (const row of rows) {
    const c = (row.category as NotificationCategory | null | undefined) ?? inferCategory(row.type)
    // Guard against a bogus value in the DB (shouldn't happen but
    // defence in depth — never silently drop a row).
    if (buckets[c]) buckets[c].push(row)
    else buckets.other.push(row)
  }
  return buckets
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Create a notification for a shop (and optionally a specific user).
 */
export async function createNotification(
  db: Kysely<Database>,
  shopId: string,
  userId: string | null | undefined,
  data: CreateNotificationInput,
) {
  // Always stamp a non-null category on the row: if the caller passed
  // one, use it; otherwise infer from the type. Keeps the bucket
  // filter in the drawer reliable without a read-time fallback.
  const category = data.category ?? inferCategory(data.type)

  const notification = await db
    .insertInto('notifications')
    .values({
      shop_id: shopId,
      user_id: userId ?? null,
      type: data.type,
      title: data.title,
      message: data.message ?? null,
      resource_type: data.resourceType ?? null,
      resource_id: data.resourceId ?? null,
      category,
      link: data.link ?? null,
    } as any)
    .returningAll()
    .executeTakeFirstOrThrow()

  return notification
}

/**
 * Get notifications for a shop, optionally filtered by user and read status.
 */
export async function getNotifications(
  db: Kysely<Database>,
  shopId: string,
  userId?: string | null,
  unreadOnly: boolean = false,
  category?: NotificationCategory | null,
) {
  let query = db
    .selectFrom('notifications')
    .selectAll()
    .where('shop_id', '=', shopId)
    .orderBy('created_at', 'desc')

  if (userId) {
    query = query.where((eb) =>
      eb.or([
        eb('user_id', '=', userId),
        eb('user_id', 'is', null),
      ]),
    )
  }

  if (unreadOnly) {
    query = query.where('read', '=', false)
  }

  // Category filter. Read-through via inferCategory handles pre-065
  // rows outside the query, so we only filter at the DB when the
  // column was actually populated (migration 065 onwards). For rows
  // with NULL category, we fall back to matching on type — uglier but
  // keeps the tab filter honest across the upgrade boundary.
  if (category) {
    query = query.where((eb) => {
      const typeMatches = typesForCategory(category)
      if (typeMatches.length === 0) {
        return eb('category', '=', category)
      }
      return eb.or([
        eb('category', '=', category),
        eb.and([
          eb('category', 'is', null),
          eb('type', 'in', typeMatches),
        ]),
      ])
    })
  }

  return query.execute()
}

/**
 * Inverse of inferCategory — given a category, list the types that
 * legacy (pre-065) rows would belong to. Used by getNotifications'
 * category filter to correctly include rows inserted before the
 * `category` column existed.
 *
 * Exported so downstream admin pages that bypass the service and
 * query Kysely directly can reuse the same inverse mapping without
 * duplicating the types list.
 */
export function typesForCategory(category: NotificationCategory): string[] {
  const all: NotificationType[] = [
    'order_placed', 'order_fulfilled', 'orders_exported', 'orders_imported',
    'tracking_imported', 'low_stock', 'new_customer', 'payment_received',
    'refund_issued', 'app_installed', 'review_submitted', 'review_approved',
    'review_rejected', 'review_deleted', 'review_replied', 'review_spam_flagged',
    'shipping_zone_created', 'shipping_zone_deleted', 'shipping_rate_created',
    'shipping_carrier_enabled', 'shipping_rates_seeded',
  ]
  return all.filter((t) => inferCategory(t) === category)
}

/**
 * Mark a single notification as read.
 */
export async function markAsRead(
  db: Kysely<Database>,
  notificationId: string,
): Promise<void> {
  await db
    .updateTable('notifications')
    .set({ read: true } as any)
    .where('id', '=', notificationId)
    .execute()
}

/**
 * Mark all notifications as read for a user in a shop.
 * Returns the number of notifications updated.
 */
export async function markAllAsRead(
  db: Kysely<Database>,
  shopId: string,
  userId: string,
): Promise<number> {
  const result = await db
    .updateTable('notifications')
    .set({ read: true } as any)
    .where('shop_id', '=', shopId)
    .where((eb) =>
      eb.or([
        eb('user_id', '=', userId),
        eb('user_id', 'is', null),
      ]),
    )
    .where('read', '=', false)
    .executeTakeFirst()

  // Kysely returns numUpdatedRows from update operations
  return Number((result as any)?.numUpdatedRows ?? 0)
}

/**
 * Delete a notification by ID.
 */
export async function deleteNotification(
  db: Kysely<Database>,
  notificationId: string,
): Promise<void> {
  await db
    .deleteFrom('notifications')
    .where('id', '=', notificationId)
    .execute()
}

/**
 * Get the count of unread notifications for a user in a shop.
 */
export async function getUnreadCount(
  db: Kysely<Database>,
  shopId: string,
  userId: string,
): Promise<number> {
  const result = await db
    .selectFrom('notifications')
    .select(db.fn.countAll<number>().as('count'))
    .where('shop_id', '=', shopId)
    .where((eb) =>
      eb.or([
        eb('user_id', '=', userId),
        eb('user_id', 'is', null),
      ]),
    )
    .where('read', '=', false)
    .executeTakeFirstOrThrow()

  return Number(result.count)
}
