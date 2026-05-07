/**
 * Orders Operations Service
 *
 * Shared business logic for day-to-day order management operations that
 * the store-admin UI, god-admin dashboard, and REST API all need:
 *
 *   - addOrderNote        — timeline note
 *   - bulkOrderAction     — tag / status updates across many orders
 *   - upsertPodFile       — Print-on-Demand design attach
 *
 * These were extracted from `apps/store-admin/pages/orders.ts` during the
 * Phase 9 schema-consistency audit so a single source of truth drives
 * both the UI and the REST API, and so future changes to the state
 * transitions don't have to be kept in sync across files.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export interface AddNoteParams {
  shopId: string
  orderId: string
  message: string
  actorId?: string | null
  actorType?: 'user' | 'system' | 'customer' | 'app' | 'webhook'
}

/**
 * Append a merchant note to the order timeline. Throws on DB error so the
 * caller can distinguish "nothing happened" from "write failed".
 */
export async function addOrderNote(
  db: Kysely<Database>,
  params: AddNoteParams,
): Promise<void> {
  const message = params.message.trim()
  if (!message) return

  await db
    .insertInto('order_events')
    .values({
      shop_id: params.shopId,
      order_id: params.orderId,
      event_type: 'note_added',
      actor_type: params.actorType ?? (params.actorId ? 'user' : 'system'),
      actor_id: params.actorId ?? null,
      message,
    })
    .execute()
}

// ---------------------------------------------------------------------------
// Bulk actions
// ---------------------------------------------------------------------------

export type BulkOrderAction =
  | 'archive'
  | 'cancel'
  | 'mark_paid'
  | 'mark_fulfilled'
  | 'add_tag'
  | 'remove_tag'

export interface BulkActionParams {
  shopId: string
  orderIds: string[]
  action: BulkOrderAction
  tag?: string
  actorId?: string | null
}

export interface BulkActionResult {
  action: BulkOrderAction
  affected: number
}

/**
 * Apply the same action to many orders in one go. All writes are scoped
 * to `shop_id` so cross-tenant IDs are no-ops (defensive against stale
 * checkbox state in the UI).
 */
export async function bulkOrderAction(
  db: Kysely<Database>,
  params: BulkActionParams,
): Promise<BulkActionResult> {
  const { shopId, orderIds, action, tag } = params
  if (!orderIds.length) return { action, affected: 0 }

  let affected = 0
  const now = new Date().toISOString()

  switch (action) {
    case 'archive': {
      const r = await db
        .updateTable('orders')
        .set({ closed_at: now as any })
        .where('shop_id', '=', shopId)
        .where('id', 'in', orderIds)
        .executeTakeFirst()
      affected = Number(r.numUpdatedRows || 0)
      break
    }

    case 'cancel': {
      const r = await db
        .updateTable('orders')
        .set({
          cancelled_at: now as any,
          cancel_reason: 'bulk_cancel',
          financial_status: 'voided',
        })
        .where('shop_id', '=', shopId)
        .where('id', 'in', orderIds)
        .executeTakeFirst()
      affected = Number(r.numUpdatedRows || 0)
      break
    }

    case 'mark_paid': {
      const r = await db
        .updateTable('orders')
        .set({ financial_status: 'paid' })
        .where('shop_id', '=', shopId)
        .where('id', 'in', orderIds)
        .executeTakeFirst()
      affected = Number(r.numUpdatedRows || 0)
      // -----------------------------------------------------------------
      // Lenful auto-push hook (Phase F7)
      //
      // If routing rules match any of the orders and the matching rule has
      // auto_push=true, push to Lenful right away instead of waiting on
      // the hourly sweep. Fire-and-forget so the UI response stays snappy
      // — any failure is captured in lenful_orders.last_error and shown
      // in the queue page. Gated via DISABLE_LENFUL_AUTOPUSH so tests
      // and replicas without credentials can opt out.
      // -----------------------------------------------------------------
      if (affected > 0 && process.env.DISABLE_LENFUL_AUTOPUSH !== '1') {
        const paidOrderIds = [...orderIds]
        const actorId = params.actorId ?? null
        void (async () => {
          try {
            const [{ checkAutoPush }, { pushOrderToLenful }] = await Promise.all([
              import('../fulfillment/lenful/routing-rules.ts'),
              import('../fulfillment/lenful/push-order.ts'),
            ])
            for (const orderId of paidOrderIds) {
              try {
                const check = await checkAutoPush(db, orderId)
                if (!check.shouldPush) continue
                await pushOrderToLenful(db, {
                  gboxOrderId: orderId,
                  triggeredBy: 'order.paid',
                  userId: actorId,
                })
              } catch {
                // swallow — lenful_orders row (if created) already carries
                // the error detail for ops review
              }
            }
          } catch {
            // lenful module not loadable (credentials missing, etc.) —
            // cron sweep will retry these later
          }
        })()
      }
      break
    }

    case 'mark_fulfilled': {
      const r = await db
        .updateTable('orders')
        .set({ fulfillment_status: 'fulfilled' })
        .where('shop_id', '=', shopId)
        .where('id', 'in', orderIds)
        .executeTakeFirst()
      affected = Number(r.numUpdatedRows || 0)
      break
    }

    case 'add_tag': {
      const trimmed = (tag || '').trim()
      if (!trimmed) break
      // Fetch current tags then append if missing — we can't express
      // array_append(distinct) cleanly with Kysely's typed builder.
      const rows = await db
        .selectFrom('orders')
        .select(['id', 'tags'])
        .where('shop_id', '=', shopId)
        .where('id', 'in', orderIds)
        .execute()
      for (const row of rows) {
        const existing = Array.isArray(row.tags) ? row.tags : []
        if (existing.includes(trimmed)) continue
        await db
          .updateTable('orders')
          .set({ tags: [...existing, trimmed] as any })
          .where('id', '=', row.id)
          .execute()
        affected++
      }
      break
    }

    case 'remove_tag': {
      const trimmed = (tag || '').trim()
      if (!trimmed) break
      const rows = await db
        .selectFrom('orders')
        .select(['id', 'tags'])
        .where('shop_id', '=', shopId)
        .where('id', 'in', orderIds)
        .execute()
      for (const row of rows) {
        const existing = Array.isArray(row.tags) ? row.tags : []
        const next = existing.filter((t: string) => t !== trimmed)
        if (next.length === existing.length) continue
        await db
          .updateTable('orders')
          .set({ tags: next as any })
          .where('id', '=', row.id)
          .execute()
        affected++
      }
      break
    }
  }

  // Audit log (best-effort — shouldn't block the action)
  if (affected > 0) {
    await db
      .insertInto('audit_logs')
      .values({
        shop_id: shopId,
        user_id: params.actorId ?? null,
        action: `bulk_${action}`,
        resource_type: 'order',
        resource_id: orderIds[0] ?? null,
        details: JSON.stringify({ action, count: orderIds.length, tag }) as any,
      })
      .execute()
      .catch(() => {})
  }

  return { action, affected }
}

// ---------------------------------------------------------------------------
// POD file upsert
// ---------------------------------------------------------------------------

export interface UpsertPodFileParams {
  shopId: string
  orderId: string
  lineItemId: string
  fileKey: string
  fileUrl: string
  filename: string
  mimeType?: string | null
  size?: number | null
  uploadedBy?: string | null
  status?: 'pending' | 'generating' | 'generated' | 'failed'
}

/**
 * Upsert a POD (print-on-demand) design file for a given line item.
 * Each (order_id, line_item_id) may have at most one file — the unique
 * index in migration 021 enforces this. On conflict we update in place
 * rather than insert a duplicate.
 */
export async function upsertPodFile(
  db: Kysely<Database>,
  params: UpsertPodFileParams,
): Promise<{ upserted: boolean; id: string | null }> {
  const existing = await db
    .selectFrom('pod_files')
    .select('id')
    .where('order_id', '=', params.orderId)
    .where('line_item_id', '=', params.lineItemId)
    .executeTakeFirst()

  if (existing) {
    await db
      .updateTable('pod_files')
      .set({
        file_key: params.fileKey,
        file_url: params.fileUrl,
        filename: params.filename,
        mime_type: params.mimeType ?? null,
        size: params.size ?? null,
        uploaded_by: params.uploadedBy ?? null,
        status: params.status ?? 'pending',
      })
      .where('id', '=', existing.id)
      .execute()
    return { upserted: true, id: existing.id }
  }

  const inserted = await db
    .insertInto('pod_files')
    .values({
      shop_id: params.shopId,
      order_id: params.orderId,
      line_item_id: params.lineItemId,
      file_key: params.fileKey,
      file_url: params.fileUrl,
      filename: params.filename,
      mime_type: params.mimeType ?? null,
      size: params.size ?? null,
      uploaded_by: params.uploadedBy ?? null,
      status: params.status ?? 'pending',
    })
    .returning('id')
    .executeTakeFirst()

  // Timeline event
  await db
    .insertInto('order_events')
    .values({
      shop_id: params.shopId,
      order_id: params.orderId,
      event_type: 'pod_uploaded',
      actor_type: params.uploadedBy ? 'user' : 'system',
      actor_id: params.uploadedBy ?? null,
      message: `POD design uploaded: ${params.filename}`,
      data: JSON.stringify({
        line_item_id: params.lineItemId,
        file_url: params.fileUrl,
      }) as any,
    })
    .execute()
    .catch(() => {})

  return { upserted: true, id: inserted?.id ?? null }
}
