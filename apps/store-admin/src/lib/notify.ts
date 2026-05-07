/**
 * Store Admin — Notification Emitter Helper
 *
 * Thin wrapper around the `notifications` table insert + the SSE
 * `pushNotification` broadcast. Every mutation handler in store-admin
 * (product create, order edit, settings save, theme deploy, …) calls
 * this helper at the end of its success path so the merchant sees a
 * bell-icon confirmation for every change that happened in their store.
 *
 * Design goals:
 *
 *   - **Fire and forget.** A failed notification insert must never
 *     break the underlying operation (a product save, an order refund,
 *     a file upload). Callers MUST NOT `await` this function and we
 *     catch every error internally.
 *
 *   - **Single source of truth.** Historically each handler had its
 *     own `db.insertInto('notifications').values({...}).execute()`
 *     copy-paste with slightly different field combinations. Centralising
 *     that here means future changes (e.g. switching to a message queue,
 *     or adding a per-user preference filter) touch one file.
 *
 *   - **SSE included.** Callers used to forget to call
 *     `pushNotification` after inserting, so the bell dot only appeared
 *     on the next page refresh. This helper always does both.
 *
 *   - **Safe defaults.** Missing user is allowed (some system events
 *     have no actor). Missing message is allowed. Missing resource is
 *     allowed.
 *
 * Usage example:
 *
 *     import { notify } from '../lib/notify.js'
 *
 *     // inside a POST handler, after the mutation succeeds:
 *     notify(db, {
 *       shopId: store.id,
 *       userId: user.id,
 *       type: 'product_created',
 *       title: `Product created: ${product.title}`,
 *       message: `SKU ${product.sku || '—'} • By ${user.name || user.email}`,
 *       resourceType: 'product',
 *       resourceId: product.id,
 *     })
 *
 *     // no `await`, no `.catch()` — the helper handles both.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { pushNotification } from '../server.js'

export interface NotifyInput {
  shopId: string
  /** Actor user id — null/undefined is fine for system-generated events. */
  userId?: string | null
  /** Notification type slug, e.g. `product_created`, `order_refunded`. */
  type: string
  /** Short headline shown in the drawer and topbar flash. */
  title: string
  /** Optional second line, usually the actor name or a short context blurb. */
  message?: string | null
  /** Optional resource type slug (e.g. `product`, `order`) for deep-linking later. */
  resourceType?: string | null
  /** Optional resource id (uuid string) for deep-linking later. */
  resourceId?: string | null
}

/**
 * Insert a notification row and broadcast it via SSE. Non-blocking —
 * errors are logged but swallowed so the caller's flow is never
 * interrupted by a notifications-table issue.
 *
 * This function is intentionally synchronous-from-the-caller's-POV
 * (returns void, not a Promise). Do NOT `await` it.
 */
export function notify(db: Kysely<Database>, input: NotifyInput): void {
  const { shopId, userId, type, title, message, resourceType, resourceId } = input

  db.insertInto('notifications')
    .values({
      shop_id: shopId,
      user_id: userId ?? null,
      type,
      title,
      message: message ?? null,
      resource_type: resourceType ?? null,
      resource_id: resourceId ?? null,
    } as any)
    .execute()
    .then(() => {
      // Best-effort real-time push. pushNotification is a no-op when
      // no clients are connected for this store, so this is always safe.
      try {
        pushNotification(shopId, { type, text: title })
      } catch { /* ignore */ }
    })
    .catch((e: any) => {
      // Intentionally log-only. The caller's operation already succeeded
      // by the time notify() is invoked, and losing a notification is
      // preferable to losing the underlying write.
      console.error(`[notify] insert failed for type=${type}:`, e?.message)
    })
}

/**
 * Compose a "By <actor>" suffix for notification messages.
 * Falls back gracefully when the user has no display name.
 */
export function byActor(user: { name?: string | null; email?: string | null } | null | undefined): string {
  if (!user) return ''
  return `By ${user.name || user.email || 'unknown'}`
}
