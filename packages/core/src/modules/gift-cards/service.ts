/**
 * Gbox Platform — Gift Card Service
 *
 * Gift card lifecycle: create, redeem, check balance, disable.
 * Uses gift_cards and gift_card_transactions tables.
 *
 * ## Phase 10 PR2 additions
 *
 * Migration 070 added delivery + redemption metadata to `gift_cards`:
 *   recipient_email / recipient_name / sender_name / personal_message /
 *   send_at / email_sent_at / last_redeemed_at / redeemed_amount.
 *
 * This module was extended with:
 *
 *   - `createGiftCard`          — now persists recipient + delivery fields.
 *   - `redeemGiftCard`          — bumps last_redeemed_at + redeemed_amount.
 *   - `validateGiftCardForCheckout` — pre-flight check at cart apply-time.
 *                                     Returns a typed result so the storefront
 *                                     can show friendly errors without throw.
 *   - `markGiftCardEmailSent`   — called after email dispatcher succeeds.
 *   - `listPendingEmailDeliveries` — cron target (send_at passed, not sent).
 *   - `updateGiftCard`          — partial patch for admin edits.
 *   - `getGiftCardById`         — admin list pulls the full row, disabled
 *                                 or not.
 */

import { randomBytes } from 'crypto'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateGiftCardInput {
  initialValue: string
  code?: string
  currency?: string
  customer_id?: string | null
  note?: string | null
  expiresAt?: string | null
  // Phase 10 PR2 — delivery fields. All optional. Leave null for
  // "admin keeps the code internally" (no email).
  recipientEmail?: string | null
  recipientName?: string | null
  senderName?: string | null
  personalMessage?: string | null
  /** ISO timestamp. null/undefined = immediate send if recipientEmail set. */
  sendAt?: string | null
}

export interface UpdateGiftCardInput {
  recipientEmail?: string | null
  recipientName?: string | null
  senderName?: string | null
  personalMessage?: string | null
  sendAt?: string | null
  note?: string | null
  expiresAt?: string | null
}

export interface Pagination {
  limit?: number
  offset?: number
}

/**
 * Return value of `validateGiftCardForCheckout`.
 *
 * When `ok` is true, the caller has `giftCard` + `applicable` (the dollar
 * amount that will actually redeem given the cart total). When `ok` is
 * false, `reason` is a stable machine-readable code the storefront can
 * map to a localised string. `message` is a safe English fallback.
 */
export type CheckoutValidationResult =
  | {
      ok: true
      giftCard: {
        id: string
        code: string
        balance: string
        currency: string
        expires_at: string | null
      }
      /** Amount that will be redeemed (min of balance + cartTotal). */
      applicable: string
    }
  | {
      ok: false
      reason:
        | 'not_found'
        | 'disabled'
        | 'expired'
        | 'zero_balance'
        | 'currency_mismatch'
        | 'invalid_cart_total'
      message: string
    }

export interface PendingDeliveryRow {
  id: string
  shop_id: string
  code: string
  recipient_email: string
  recipient_name: string | null
  sender_name: string | null
  personal_message: string | null
  initial_value: string
  balance: string
  currency: string
  send_at: string | null
  expires_at: string | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a 16-character uppercase alphanumeric code.
 * Format: XXXX-XXXX-XXXX-XXXX (stored without dashes).
 */
function generateGiftCardCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const bytes = randomBytes(16)
  let code = ''
  for (let i = 0; i < 16; i++) {
    code += chars[bytes[i]! % chars.length]
  }
  return code
}

/** Normalise a merchant-supplied code: uppercase + strip dashes/spaces. */
export function normaliseGiftCardCode(raw: string): string {
  return raw.trim().replace(/[\s-]+/g, '').toUpperCase()
}

function toMoney(value: string | number): string {
  const n = typeof value === 'number' ? value : parseFloat(value)
  if (!Number.isFinite(n)) return '0.00'
  return n.toFixed(2)
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Create a new gift card.
 * Auto-generates a 16-char alphanumeric code if not provided.
 *
 * When `recipientEmail` is set and `sendAt` is null/undefined, the card
 * is queued for immediate delivery — the admin scheduler / create
 * handler is responsible for calling the email dispatcher.
 */
export async function createGiftCard(
  db: Kysely<Database>,
  shopId: string,
  data: CreateGiftCardInput,
) {
  const code = data.code ? normaliseGiftCardCode(data.code) : generateGiftCardCode()
  const initialValue = toMoney(data.initialValue)

  return db.transaction().execute(async (trx) => {
    const giftCard = await trx
      .insertInto('gift_cards')
      .values({
        shop_id: shopId,
        code,
        initial_value: initialValue,
        balance: initialValue,
        currency: data.currency,
        customer_id: data.customer_id ?? null,
        note: data.note ?? null,
        expires_at: data.expiresAt ?? null,
        recipient_email: data.recipientEmail ?? null,
        recipient_name: data.recipientName ?? null,
        sender_name: data.senderName ?? null,
        personal_message: data.personalMessage ?? null,
        send_at: data.sendAt ?? null,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow()

    // Record the initial credit transaction
    await trx
      .insertInto('gift_card_transactions')
      .values({
        gift_card_id: giftCard.id,
        amount: initialValue,
        type: 'credit',
        note: 'Initial balance',
      })
      .execute()

    return giftCard
  })
}

/**
 * Get an active gift card by its code. Returns null for expired, disabled,
 * or unknown codes. `code` is normalised — callers can pass the raw form.
 */
export async function getGiftCard(
  db: Kysely<Database>,
  code: string,
) {
  const normalised = normaliseGiftCardCode(code)
  const giftCard = await db
    .selectFrom('gift_cards')
    .selectAll()
    .where('code', '=', normalised)
    .where('disabled_at', 'is', null)
    .executeTakeFirst()

  if (!giftCard) return null

  // Check expiration
  if (giftCard.expires_at && new Date(giftCard.expires_at) < new Date()) {
    return null
  }

  return giftCard
}

/**
 * Get a gift card by its database id — admin pages need this so they
 * can show disabled / expired cards too (no filter).
 */
export async function getGiftCardById(
  db: Kysely<Database>,
  id: string,
) {
  return db
    .selectFrom('gift_cards')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
}

/**
 * Redeem an amount from a gift card. Returns the updated gift card.
 * Throws if insufficient balance or card is invalid/expired/disabled.
 *
 * Bumps last_redeemed_at + redeemed_amount so the admin list can sort
 * by recent redemption without joining gift_card_transactions.
 */
export async function redeemGiftCard(
  db: Kysely<Database>,
  code: string,
  amount: string,
  orderId?: string | null,
) {
  const normalised = normaliseGiftCardCode(code)
  return db.transaction().execute(async (trx) => {
    const giftCard = await trx
      .selectFrom('gift_cards')
      .selectAll()
      .where('code', '=', normalised)
      .where('disabled_at', 'is', null)
      .forUpdate()
      .executeTakeFirst()

    if (!giftCard) {
      throw new Error('Gift card not found or disabled')
    }

    if (giftCard.expires_at && new Date(giftCard.expires_at) < new Date()) {
      throw new Error('Gift card has expired')
    }

    const currentBalance = parseFloat(giftCard.balance)
    const redeemAmount = parseFloat(amount)

    if (!Number.isFinite(redeemAmount) || redeemAmount <= 0) {
      throw new Error('Redemption amount must be positive')
    }

    if (redeemAmount > currentBalance + 0.0001) {
      throw new Error('Insufficient gift card balance')
    }

    const newBalance = (currentBalance - redeemAmount).toFixed(2)
    const previousRedeemed = parseFloat((giftCard as any).redeemed_amount ?? '0')
    const newRedeemed = (previousRedeemed + redeemAmount).toFixed(2)
    const nowIso = new Date().toISOString()

    // Update the balance + redemption markers
    const updated = await trx
      .updateTable('gift_cards')
      .set({
        balance: newBalance,
        redeemed_amount: newRedeemed,
        last_redeemed_at: nowIso,
        updated_at: nowIso,
      } as any)
      .where('id', '=', giftCard.id)
      .returningAll()
      .executeTakeFirstOrThrow()

    // Record the debit transaction
    await trx
      .insertInto('gift_card_transactions')
      .values({
        gift_card_id: giftCard.id,
        amount: `-${redeemAmount.toFixed(2)}`,
        type: 'debit',
        note: orderId ? `Redeemed for order ${orderId}` : 'Redeemed',
        order_id: orderId ?? null,
      })
      .execute()

    return updated
  })
}

/**
 * Get the remaining balance for a gift card by code.
 */
export async function getGiftCardBalance(
  db: Kysely<Database>,
  code: string,
): Promise<string | null> {
  const normalised = normaliseGiftCardCode(code)
  const giftCard = await db
    .selectFrom('gift_cards')
    .select(['balance', 'currency', 'expires_at', 'disabled_at'])
    .where('code', '=', normalised)
    .executeTakeFirst()

  if (!giftCard) return null
  if (giftCard.disabled_at) return null
  if (giftCard.expires_at && new Date(giftCard.expires_at) < new Date()) return null

  return giftCard.balance
}

/**
 * Pre-flight check used by checkout when a customer applies a gift
 * card code. Read-only — does NOT decrement the balance. The actual
 * redemption happens via `redeemGiftCard` once the order is placed.
 *
 * - Shop scope — blocks cross-shop redemption.
 * - Returns a typed result so the REST handler can `return res.json(r)`
 *   without a try/catch funnel.
 */
export async function validateGiftCardForCheckout(
  db: Kysely<Database>,
  shopId: string,
  rawCode: string,
  cartTotal: string | number,
  currency: string | null | undefined,
): Promise<CheckoutValidationResult> {
  const code = normaliseGiftCardCode(rawCode)
  const total = typeof cartTotal === 'number' ? cartTotal : parseFloat(cartTotal)
  if (!Number.isFinite(total) || total < 0) {
    return {
      ok: false,
      reason: 'invalid_cart_total',
      message: 'Cart total is missing or invalid.',
    }
  }

  const row = await db
    .selectFrom('gift_cards')
    .select([
      'id',
      'code',
      'balance',
      'currency',
      'expires_at',
      'disabled_at',
    ])
    .where('shop_id', '=', shopId)
    .where('code', '=', code)
    .executeTakeFirst()

  if (!row) {
    return { ok: false, reason: 'not_found', message: 'Gift card not found.' }
  }
  if (row.disabled_at) {
    return { ok: false, reason: 'disabled', message: 'Gift card has been disabled.' }
  }
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return { ok: false, reason: 'expired', message: 'Gift card has expired.' }
  }
  const balance = parseFloat(row.balance)
  if (!Number.isFinite(balance) || balance <= 0) {
    return { ok: false, reason: 'zero_balance', message: 'Gift card has no remaining balance.' }
  }
  if (currency && row.currency && currency.toUpperCase() !== row.currency.toUpperCase()) {
    return {
      ok: false,
      reason: 'currency_mismatch',
      message: `Gift card is in ${row.currency}, order is in ${currency}.`,
    }
  }

  const applicable = Math.min(balance, total).toFixed(2)
  return {
    ok: true,
    giftCard: {
      id: row.id,
      code: row.code,
      balance: row.balance,
      currency: row.currency,
      expires_at: row.expires_at,
    },
    applicable,
  }
}

/**
 * Disable a gift card so it can no longer be redeemed.
 */
export async function disableGiftCard(
  db: Kysely<Database>,
  giftCardId: string,
): Promise<void> {
  await db
    .updateTable('gift_cards')
    .set({
      disabled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as any)
    .where('id', '=', giftCardId)
    .execute()
}

/**
 * Mark a gift card as having had its delivery email dispatched.
 * Called by the email worker / admin "send now" path.
 */
export async function markGiftCardEmailSent(
  db: Kysely<Database>,
  giftCardId: string,
  sentAt: string = new Date().toISOString(),
): Promise<void> {
  await db
    .updateTable('gift_cards')
    .set({
      email_sent_at: sentAt,
      updated_at: sentAt,
    } as any)
    .where('id', '=', giftCardId)
    .execute()
}

/**
 * Partial update for admin edits. Only the delivery + note / expiry
 * fields are editable — core money fields (initial_value, balance,
 * redeemed_amount) are immutable from this path.
 */
export async function updateGiftCard(
  db: Kysely<Database>,
  giftCardId: string,
  patch: UpdateGiftCardInput,
): Promise<void> {
  const set: Record<string, any> = { updated_at: new Date().toISOString() }
  if (patch.recipientEmail !== undefined) set.recipient_email = patch.recipientEmail
  if (patch.recipientName !== undefined) set.recipient_name = patch.recipientName
  if (patch.senderName !== undefined) set.sender_name = patch.senderName
  if (patch.personalMessage !== undefined) set.personal_message = patch.personalMessage
  if (patch.sendAt !== undefined) set.send_at = patch.sendAt
  if (patch.note !== undefined) set.note = patch.note
  if (patch.expiresAt !== undefined) set.expires_at = patch.expiresAt

  // If there's nothing to update apart from updated_at, skip the round-trip.
  if (Object.keys(set).length <= 1) return

  await db
    .updateTable('gift_cards')
    .set(set as any)
    .where('id', '=', giftCardId)
    .execute()
}

/**
 * Cron target: gift cards that are ready to be emailed.
 *
 * Criteria (matches migration 070's partial index):
 *   - send_at IS NOT NULL                (scheduled)
 *   - send_at <= now()                   (it's time)
 *   - email_sent_at IS NULL              (not dispatched yet)
 *   - disabled_at IS NULL                (not disabled)
 *   - recipient_email IS NOT NULL        (an actual address to send to)
 *
 * Returns at most `limit` rows (default 100) to keep a cron tick bounded.
 * Optional shop scope for manual single-shop triggers.
 */
export async function listPendingEmailDeliveries(
  db: Kysely<Database>,
  opts: { shopId?: string; limit?: number; nowIso?: string } = {},
): Promise<PendingDeliveryRow[]> {
  const limit = opts.limit ?? 100
  const now = opts.nowIso ?? new Date().toISOString()

  let q = db
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
      'balance',
      'currency',
      'send_at',
      'expires_at',
    ])
    .where('disabled_at', 'is', null)
    .where('email_sent_at', 'is', null)
    .where('send_at', 'is not', null)
    .where('send_at', '<=', now)
    .where('recipient_email', 'is not', null)
    .orderBy('send_at', 'asc')
    .limit(limit)

  if (opts.shopId) {
    q = q.where('shop_id', '=', opts.shopId)
  }

  const rows = await q.execute()
  return rows.filter((r): r is PendingDeliveryRow => r.recipient_email !== null) as PendingDeliveryRow[]
}

/**
 * List gift cards for a shop with pagination.
 */
export async function listGiftCards(
  db: Kysely<Database>,
  shopId: string,
  pagination: Pagination = {},
) {
  const { limit = 50, offset = 0 } = pagination

  const countQuery = db
    .selectFrom('gift_cards')
    .select(db.fn.countAll<number>().as('count'))
    .where('shop_id', '=', shopId)

  const dataQuery = db
    .selectFrom('gift_cards')
    .selectAll()
    .where('shop_id', '=', shopId)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .offset(offset)

  const [rows, countRow] = await Promise.all([
    dataQuery.execute(),
    countQuery.executeTakeFirstOrThrow(),
  ])

  return { giftCards: rows, total: Number(countRow.count) }
}
