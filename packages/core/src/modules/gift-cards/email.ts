/**
 * Gbox Platform — Gift Card Email Delivery (Phase 10 PR2)
 *
 * Thin glue between the `gift_cards` service and the transactional email
 * service. Keeps concerns split:
 *
 *   - `email/service.ts#sendGiftCardDelivery`   — renders + sends the message.
 *   - `gift-cards/service.ts#listPendingEmailDeliveries` — cron lookup.
 *   - `gift-cards/service.ts#markGiftCardEmailSent`      — idempotency marker.
 *
 * This file composes them: resolve the shop name, call send, mark as sent.
 * Exposed as `deliverGiftCardNow` (single card) and
 * `processPendingGiftCardEmails` (cron batch).
 *
 * Failures do NOT flip `email_sent_at` — the next cron tick retries.
 * The `email_templates` row in the DB lets sellers override subject/body.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { sendGiftCardDelivery, type GiftCardDeliveryData } from '../email/service.js'
import {
  listPendingEmailDeliveries,
  markGiftCardEmailSent,
  type PendingDeliveryRow,
} from './service.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeliveryOutcome {
  giftCardId: string
  recipient: string
  ok: boolean
  /** Present only when `ok` is false. */
  error?: string
}

export interface ProcessPendingResult {
  processed: number
  sent: number
  failed: number
  outcomes: DeliveryOutcome[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveShopName(
  db: Kysely<Database>,
  shopId: string,
): Promise<string> {
  const row = await db
    .selectFrom('shops')
    .select('name')
    .where('id', '=', shopId)
    .executeTakeFirst()
  return row?.name ?? 'Your shop'
}

function rowToDeliveryData(
  row: PendingDeliveryRow,
  shopName: string,
  expiresAt: string | null,
): GiftCardDeliveryData {
  return {
    code: row.code,
    currency: row.currency,
    initial_value: row.initial_value,
    recipient_email: row.recipient_email,
    recipient_name: row.recipient_name,
    sender_name: row.sender_name,
    personal_message: row.personal_message,
    shop_name: shopName,
    expires_at: expiresAt,
  }
}

// ---------------------------------------------------------------------------
// Single card — admin "send now" path
// ---------------------------------------------------------------------------

/**
 * Deliver a specific gift card (by id) immediately.
 *
 * - Looks up the card, validates it has a recipient + is not disabled.
 * - Sends the email via the transactional service.
 * - Marks `email_sent_at` on success.
 *
 * Throws on missing recipient / disabled / not-found. Email-send errors
 * bubble up too — the admin route should catch + report via safeMessage.
 */
export async function deliverGiftCardNow(
  db: Kysely<Database>,
  giftCardId: string,
): Promise<DeliveryOutcome> {
  const row = await db
    .selectFrom('gift_cards')
    .select([
      'id',
      'shop_id',
      'code',
      'recipient_email',
      'recipient_name',
      'sender_name',
      'personal_message',
      'initial_value',
      'currency',
      'expires_at',
      'disabled_at',
      'email_sent_at',
    ])
    .where('id', '=', giftCardId)
    .executeTakeFirst()

  if (!row) throw new Error('Gift card not found')
  if (row.disabled_at) throw new Error('Gift card is disabled')
  if (!row.recipient_email) {
    throw new Error('Gift card has no recipient email')
  }

  const shopName = await resolveShopName(db, row.shop_id)
  const data = rowToDeliveryData(
    {
      id: row.id,
      shop_id: row.shop_id,
      code: row.code,
      recipient_email: row.recipient_email,
      recipient_name: row.recipient_name,
      sender_name: row.sender_name,
      personal_message: row.personal_message,
      initial_value: row.initial_value,
      balance: row.initial_value,
      currency: row.currency,
      send_at: null,
      expires_at: row.expires_at,
    },
    shopName,
    row.expires_at,
  )

  try {
    await sendGiftCardDelivery(db, row.shop_id, data)
    await markGiftCardEmailSent(db, row.id)
    return { giftCardId: row.id, recipient: row.recipient_email, ok: true }
  } catch (err: any) {
    return {
      giftCardId: row.id,
      recipient: row.recipient_email,
      ok: false,
      error: err?.message ?? String(err),
    }
  }
}

// ---------------------------------------------------------------------------
// Cron batch — "send everything that's due"
// ---------------------------------------------------------------------------

/**
 * Walk the pending-email queue and dispatch each row.
 *
 * - Scoped optionally to a single shop (`shopId`) and bounded by
 *   `limit` (default 100) to keep each tick cheap.
 * - Individual failures are captured — they do NOT flip the marker,
 *   so the next tick will retry.
 *
 * Shop-name resolution is cached per shop to avoid N queries when the
 * same shop has many pending cards.
 */
export async function processPendingGiftCardEmails(
  db: Kysely<Database>,
  opts: { shopId?: string; limit?: number; nowIso?: string } = {},
): Promise<ProcessPendingResult> {
  const pending = await listPendingEmailDeliveries(db, opts)

  const shopNameCache = new Map<string, string>()
  const outcomes: DeliveryOutcome[] = []
  let sent = 0
  let failed = 0

  for (const row of pending) {
    let shopName = shopNameCache.get(row.shop_id)
    if (!shopName) {
      shopName = await resolveShopName(db, row.shop_id)
      shopNameCache.set(row.shop_id, shopName)
    }

    const data = rowToDeliveryData(row, shopName, row.expires_at)
    try {
      await sendGiftCardDelivery(db, row.shop_id, data)
      await markGiftCardEmailSent(db, row.id)
      sent++
      outcomes.push({ giftCardId: row.id, recipient: row.recipient_email, ok: true })
    } catch (err: any) {
      failed++
      outcomes.push({
        giftCardId: row.id,
        recipient: row.recipient_email,
        ok: false,
        error: err?.message ?? String(err),
      })
    }
  }

  return {
    processed: pending.length,
    sent,
    failed,
    outcomes,
  }
}
