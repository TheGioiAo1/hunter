/**
 * Lenful tracking sync (Phase F3).
 *
 * Polls `/api/order/tracking_item` via LenfulClient.listTrackingItems and
 * mirrors any tracking updates back into the Gbox-side tables:
 *
 *   lenful_order_items     ← tracking_number / carrier / url / status / timestamps
 *   lenful_orders          ← status (in_production → shipped → delivered), last_sync_at
 *   orders                 ← fulfillment_status (partial / fulfilled)
 *
 * Invocation modes
 * ----------------
 * 1. Global poll — walks recent Lenful tracking items and tries to match
 *    each one to a `lenful_orders` row by `lenful_order_id` /
 *    `lenful_order_number` / `order_number_sent` (the GBOX-… tag).
 * 2. Targeted sync — given a set of `lenful_orders.id` values, call
 *    Lenful with their `lenful_order_id` as `order_short_ids`.
 *
 * Both modes write to the same update paths and return a SyncResult.
 *
 * This is a service module. A Phase F3 cron runner will call
 * `syncTrackingGlobal` periodically; the god-admin UI exposes a "Sync
 * now" button that calls `syncTrackingTargeted` for a single row (or
 * the whole page).
 */

import type { Kysely } from 'kysely'
import type { Database } from '../../../../../db/src/schema/tables.js'
import { LenfulClient } from './client.ts'
import { getActiveCredential } from './credentials.ts'
import type { LenfulTrackingItem } from './types.ts'

// ─── Result shape ─────────────────────────────────────────────────

export interface SyncResult {
  readonly ok: boolean
  readonly fetched: number
  readonly matched: number
  readonly updated: number
  readonly skipped: number
  readonly errors: ReadonlyArray<string>
}

function emptyResult(): SyncResult {
  return { ok: true, fetched: 0, matched: 0, updated: 0, skipped: 0, errors: [] }
}

// ─── Status helpers ───────────────────────────────────────────────

/**
 * Map Lenful-side tracking_status text to our canonical LenfulOrderStatus.
 * Lenful uses strings like "in_production", "shipped", "delivered", or
 * carrier-specific phrases ("In Transit"). We normalize generously.
 */
function mapStatus(raw: string | null | undefined): 'in_production' | 'shipped' | 'delivered' | null {
  if (!raw) return null
  const s = String(raw).toLowerCase()
  if (s.includes('deliver')) return 'delivered'
  if (
    s.includes('shipped') ||
    s.includes('in transit') ||
    s.includes('in_transit') ||
    s.includes('out for') ||
    s.includes('label')
  ) {
    return 'shipped'
  }
  if (s.includes('production') || s.includes('printed') || s.includes('printing')) {
    return 'in_production'
  }
  return null
}

/**
 * Pick the latest status across all tracking items tied to a lenful
 * order row. Delivered > shipped > in_production.
 */
function rankStatus(s: string | null): number {
  if (s === 'delivered') return 3
  if (s === 'shipped') return 2
  if (s === 'in_production') return 1
  return 0
}

// ─── Main entry points ────────────────────────────────────────────

export interface SyncTrackingInput {
  readonly triggeredBy?: string
  readonly userId?: string | null
  /** Max Lenful pages to fetch. Default 5 (250 items). */
  readonly maxPages?: number
  /** Optional targeted list — Lenful `order_short_ids`. */
  readonly orderShortIds?: ReadonlyArray<string>
}

/**
 * Global recent-items poll. Fetches up to `maxPages` × 50 of the most
 * recent Lenful tracking items and reconciles them against our tables.
 * Called by the Phase F3 cron AND by the "Sync all" button in the UI.
 */
export async function syncTrackingGlobal(
  db: Kysely<Database>,
  input: SyncTrackingInput = {},
): Promise<SyncResult> {
  const cred = await getActiveCredential(db)
  if (!cred) {
    return {
      ok: false,
      fetched: 0,
      matched: 0,
      updated: 0,
      skipped: 0,
      errors: ['No active Lenful credential'],
    }
  }
  const client = new LenfulClient({
    db,
    credentialId: cred.id,
    triggeredBy: input.triggeredBy ?? 'cron-tracking-sync',
    userId: input.userId ?? null,
  })

  const result = {
    ok: true,
    fetched: 0,
    matched: 0,
    updated: 0,
    skipped: 0,
    errors: [] as string[],
  }
  const maxPages = Math.max(1, Math.min(50, input.maxPages ?? 5))

  for (let page = 1; page <= maxPages; page++) {
    let batch: ReadonlyArray<LenfulTrackingItem>
    try {
      const r = await client.listTrackingItems({
        page,
        limit: 50,
        orderShortIds: input.orderShortIds,
      })
      batch = r.items
    } catch (e: any) {
      result.ok = false
      result.errors.push(`page ${page}: ${e?.message ?? String(e)}`)
      break
    }
    if (batch.length === 0) break
    result.fetched += batch.length
    for (const item of batch) {
      try {
        const outcome = await applyTrackingItem(db, item)
        if (outcome === 'updated') result.updated++
        else if (outcome === 'matched') result.matched++
        else result.skipped++
      } catch (e: any) {
        result.errors.push(`item ${String(item.id ?? '-')}: ${e?.message ?? String(e)}`)
      }
    }
    if (batch.length < 50) break
  }

  return result
}

/**
 * Targeted sync for a single Gbox lenful_orders row. Used by the
 * "Sync now" button on the queue detail view.
 */
export async function syncTrackingForRow(
  db: Kysely<Database>,
  lenfulOrderRowId: string,
  input: SyncTrackingInput = {},
): Promise<SyncResult> {
  const row = await db
    .selectFrom('lenful_orders')
    .select(['id', 'lenful_order_id', 'lenful_order_number', 'order_number_sent'])
    .where('id', '=', lenfulOrderRowId)
    .executeTakeFirst()
  if (!row) {
    return {
      ok: false,
      fetched: 0,
      matched: 0,
      updated: 0,
      skipped: 0,
      errors: ['row not found'],
    }
  }
  const shortIds: string[] = []
  if (row.lenful_order_id) shortIds.push(String(row.lenful_order_id))
  if (row.lenful_order_number) shortIds.push(String(row.lenful_order_number))
  if (shortIds.length === 0) {
    return {
      ok: false,
      fetched: 0,
      matched: 0,
      updated: 0,
      skipped: 0,
      errors: ['row has no lenful_order_id — push it first'],
    }
  }
  return await syncTrackingGlobal(db, {
    ...input,
    orderShortIds: shortIds,
  })
}

// ─── Per-item reconcile ───────────────────────────────────────────

async function applyTrackingItem(
  db: Kysely<Database>,
  item: LenfulTrackingItem,
): Promise<'updated' | 'matched' | 'skipped'> {
  // Lenful tracking items carry an order identifier — exact field varies:
  //   order_id, order_short_id, id, lenful_order_id
  const orderRef =
    (item.order_id as string | undefined) ||
    (item.order_short_id as string | undefined) ||
    ((item as any).lenful_order_id as string | undefined) ||
    ''

  if (!orderRef) return 'skipped'

  const row = await db
    .selectFrom('lenful_orders')
    .select(['id', 'gbox_order_id', 'status'])
    .where((eb) =>
      eb.or([
        eb('lenful_order_id', '=', orderRef),
        eb('lenful_order_number', '=', orderRef),
        eb('order_number_sent', '=', orderRef),
      ]),
    )
    .executeTakeFirst()

  if (!row) return 'skipped'

  // Find matching line item row — Lenful's tracking_item has item-level
  // details. We match by lenful_item_id if present, else by design_sku,
  // else update *all* items on the lenful_order row (graceful fallback).
  const lenfulItemId = (item as any).item_id || (item as any).lenful_item_id || null
  const designSku = (item as any).design_sku || null

  const tracking = {
    tracking_number: item.tracking_number ?? null,
    tracking_carrier: item.tracking_carrier ?? item.tracking_company ?? null,
    tracking_url: item.tracking_url ?? null,
    tracking_status: item.tracking_status ?? null,
    shipped_at: item.shipped_at ?? null,
    delivered_at: item.delivered_at ?? null,
    last_synced_at: new Date().toISOString(),
    raw_payload: JSON.stringify(item) as any,
  }

  let updateQ = db
    .updateTable('lenful_order_items')
    .set(tracking)
    .where('lenful_order_id_fk', '=', row.id)
  if (lenfulItemId) {
    updateQ = updateQ.where('lenful_item_id', '=', String(lenfulItemId))
  } else if (designSku) {
    updateQ = updateQ.where('lenful_design_sku', '=', String(designSku))
  }
  const updateResult = await updateQ.execute()
  const affected = Number((updateResult as any[])?.reduce((a, r: any) => a + Number(r.numUpdatedRows ?? 0), 0) ?? 0)

  // Roll up a new status for the lenful_orders row
  const nextStatus = mapStatus(item.tracking_status)
  const currentRank = rankStatus(row.status as any)
  const nextRank = rankStatus(nextStatus)

  const patch: Record<string, unknown> = {
    last_sync_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  if (nextStatus && nextRank > currentRank) {
    patch['status'] = nextStatus
  }
  await db
    .updateTable('lenful_orders')
    .set(patch as any)
    .where('id', '=', row.id)
    .execute()

  // Mirror into the Gbox order's fulfillment_status
  if (nextStatus === 'shipped' || nextStatus === 'delivered') {
    await db
      .updateTable('orders')
      .set({
        fulfillment_status: (nextStatus === 'delivered' ? 'fulfilled' : 'partial') as any,
        updated_at: new Date().toISOString(),
      } as any)
      .where('id', '=', row.gbox_order_id)
      .execute()
  }

  // PR2 commit 15 — fulfillment_delivered email on the rising-edge
  // shipped → delivered transition. Gated on `nextRank > currentRank`
  // so repeated "still delivered" pings from the carrier (USPS does
  // this a lot after after-hours rescans) don't re-fan. The shim's
  // idempotency key is orderId-based so even if this check somehow
  // double-fires, delivery_log dedupes at the DB layer.
  //
  // Fire-and-forget with void: the worker must NOT fail the sync
  // because SMTP is down or the email template broke.
  if (nextStatus === 'delivered' && nextRank > currentRank && row.gbox_order_id) {
    const { sendFulfillmentDelivered } = await import('../../email/service.js')
    void sendFulfillmentDelivered(db, row.gbox_order_id).catch(() => {})

    // PR3 automation emit: `order.delivered` fires the review_request +
    // thank_you_delivery flows (delay = 0 and +7d respectively). Gated
    // on AUTOMATION_FRAMEWORK_V2 so flag-off keeps legacy-only behavior.
    // We need shop_id + customer_id + most recent fulfillment id; load
    // them here rather than threading through the sync path.
    const gboxOrder = await db
      .selectFrom('orders')
      .select(['shop_id', 'customer_id'])
      .where('id', '=', row.gbox_order_id)
      .executeTakeFirst()
    const latestFulfillment = await db
      .selectFrom('fulfillments')
      .select(['id'])
      .where('order_id', '=', row.gbox_order_id)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst()
    if (gboxOrder) {
      const { emitIfEnabled } = await import(
        '../../automations/feature-flag.js'
      )
      await emitIfEnabled(db, {
        type: 'order.delivered',
        shopId: gboxOrder.shop_id,
        orderId: row.gbox_order_id,
        customerId: (gboxOrder.customer_id as string | null) ?? null,
        fulfillmentId: latestFulfillment?.id ?? row.gbox_order_id,
      })
    }
  }

  return affected > 0 || nextRank > currentRank ? 'updated' : 'matched'
}
