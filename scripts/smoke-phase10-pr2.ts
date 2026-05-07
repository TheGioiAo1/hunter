/**
 * Phase 10 PR2 — Gift Card Delivery + Redemption + Storefront Validation.
 *
 * Unit coverage lives in:
 *   - packages/core/src/modules/gift-cards/service.test.ts  (34 cases)
 *   - packages/core/src/modules/gift-cards/email.test.ts    ( 9 cases)
 *
 * This script verifies the live Postgres path — migration 070 shape,
 * recipient field persistence, the full set of checkout-validation
 * branches, the scheduled-email cron filter, deliverGiftCardNow guards,
 * redemption marker bookkeeping, and the Iron rule 5 audit against
 * store-admin's `safeFlashMessage` mapper.
 *
 * Run from server 2 (local Windows box can't reach the 192.168.1.13 PG):
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase10-pr2.ts
 *
 * Cleans up every seeded row in finally{} so the script is re-runnable.
 *
 * Coverage (assertions numbered below):
 *   [1]  Migration 070 — recipient_email column exists
 *   [2]  Migration 070 — recipient_name column exists
 *   [3]  Migration 070 — sender_name column exists
 *   [4]  Migration 070 — personal_message column exists
 *   [5]  Migration 070 — send_at column exists
 *   [6]  Migration 070 — email_sent_at column exists
 *   [7]  Migration 070 — last_redeemed_at column exists
 *   [8]  Migration 070 — redeemed_amount column exists with 0 default
 *   [9]  Migration 070 — idx_gift_cards_pending_email exists
 *   [10] Migration 070 — idx_gift_cards_shop_created exists
 *   [11] normaliseGiftCardCode strips dashes + spaces + uppercases
 *   [12] normaliseGiftCardCode idempotent on already-clean input
 *   [13] createGiftCard persists delivery + recipient fields
 *   [14] createGiftCard normalises a dashed merchant-supplied code
 *   [15] createGiftCard defaults redeemed_amount to 0.00
 *   [16] validateGiftCardForCheckout — happy path returns ok + applicable=min(balance,total)
 *   [17] validateGiftCardForCheckout — not_found for unknown code
 *   [18] validateGiftCardForCheckout — disabled card
 *   [19] validateGiftCardForCheckout — expired card
 *   [20] validateGiftCardForCheckout — zero balance
 *   [21] validateGiftCardForCheckout — currency_mismatch
 *   [22] validateGiftCardForCheckout — invalid_cart_total (negative)
 *   [23] validateGiftCardForCheckout — applicable capped at balance when total>balance
 *   [24] validateGiftCardForCheckout — cross-shop lookup blocked
 *   [25] markGiftCardEmailSent flips email_sent_at
 *   [26] listPendingEmailDeliveries finds scheduled + past + unsent + has-recipient
 *   [27] listPendingEmailDeliveries excludes already-sent rows
 *   [28] listPendingEmailDeliveries excludes disabled rows
 *   [29] listPendingEmailDeliveries excludes future-send_at rows
 *   [30] listPendingEmailDeliveries excludes null-recipient rows
 *   [31] deliverGiftCardNow throws when card is missing
 *   [32] deliverGiftCardNow throws when card is disabled
 *   [33] deliverGiftCardNow throws when recipient is null
 *   [34] redeemGiftCard bumps last_redeemed_at + redeemed_amount
 *   [35] updateGiftCard patches only the requested fields
 *   [36] updateGiftCard no-ops cleanly on empty patch (smoke returns immediately)
 *   [37] Iron rule 5 — safeFlashMessage never leaks "god admin"
 *   [38] Iron rule 5 — safeFlashMessage maps not-found to user copy
 *   [39] Iron rule 5 — safeFlashMessage maps disabled to user copy
 *   [40] Iron rule 5 — safeFlashMessage maps no-recipient to user copy
 *   [41] Iron rule 5 — safeFlashMessage maps SMTP failure to retry copy
 *   [42] Iron rule 5 — safeFlashMessage fallback mentions Gbox support
 */

import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  normaliseGiftCardCode,
  createGiftCard,
  disableGiftCard,
  redeemGiftCard,
  validateGiftCardForCheckout,
  markGiftCardEmailSent,
  listPendingEmailDeliveries,
  updateGiftCard,
  getGiftCardById,
} from '../packages/core/src/modules/gift-cards/service.js'
import { deliverGiftCardNow } from '../packages/core/src/modules/gift-cards/email.js'
import { safeFlashMessage as _safeFlashMessage } from '../apps/store-admin/src/lib/gift-cards-flash.js'

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_A = randomUUID()
const SHOP_B = randomUUID()

let total = 0
let failed = 0
function log(s: string) {
  // eslint-disable-next-line no-console
  console.log(s)
}
function assert(cond: boolean, msg: string) {
  total++
  if (cond) log(`  OK   ${msg}`)
  else {
    failed++
    log(`  FAIL ${msg}`)
  }
}

async function main() {
  log(`\n=== Phase 10 PR2 smoke — suffix=${SUFFIX} ===\n`)

  // -------------------------------------------------------------------------
  // [0] Seed two shops (one target + one for cross-shop scope tests)
  // -------------------------------------------------------------------------
  log('[0] Seeding two shops')
  await (db as any)
    .insertInto('shops')
    .values([
      {
        id: SHOP_A,
        slug: `smoke-p10-2-a-${SUFFIX}`,
        name: 'PR2 Shop A',
        email: `p10-2-a-${SUFFIX}@example.test`,
        status: 'active',
        plan: 'free',
      },
      {
        id: SHOP_B,
        slug: `smoke-p10-2-b-${SUFFIX}`,
        name: 'PR2 Shop B',
        email: `p10-2-b-${SUFFIX}@example.test`,
        status: 'active',
        plan: 'free',
      },
    ])
    .execute()

  // -------------------------------------------------------------------------
  // [1..10] Migration 070 shape
  // -------------------------------------------------------------------------
  log('\n[1..10] Migration 070 shape')

  const cols = await (db as any)
    .selectFrom('information_schema.columns' as any)
    .where('table_name', '=', 'gift_cards')
    .select(['column_name', 'column_default', 'data_type', 'is_nullable'])
    .execute()
  const byCol = new Map<string, any>(cols.map((c: any) => [c.column_name, c]))

  assert(byCol.has('recipient_email'), '[1] gift_cards.recipient_email exists')
  assert(byCol.has('recipient_name'), '[2] gift_cards.recipient_name exists')
  assert(byCol.has('sender_name'), '[3] gift_cards.sender_name exists')
  assert(byCol.has('personal_message'), '[4] gift_cards.personal_message exists')
  assert(byCol.has('send_at'), '[5] gift_cards.send_at exists')
  assert(byCol.has('email_sent_at'), '[6] gift_cards.email_sent_at exists')
  assert(byCol.has('last_redeemed_at'), '[7] gift_cards.last_redeemed_at exists')
  const redeemedCol = byCol.get('redeemed_amount')
  assert(
    !!redeemedCol &&
      String(redeemedCol.column_default ?? '').replace(/[^\d]/g, '').startsWith('0') &&
      redeemedCol.is_nullable === 'NO',
    '[8] gift_cards.redeemed_amount NOT NULL DEFAULT 0',
  )

  async function indexExists(name: string): Promise<boolean> {
    const rows = await (db as any)
      .selectFrom('pg_indexes' as any)
      .where('indexname', '=', name)
      .select(['indexname'])
      .execute()
    return rows.length === 1
  }
  assert(await indexExists('idx_gift_cards_pending_email'), '[9] idx_gift_cards_pending_email exists')
  assert(await indexExists('idx_gift_cards_shop_created'), '[10] idx_gift_cards_shop_created exists')

  // -------------------------------------------------------------------------
  // [11..12] normaliseGiftCardCode
  // -------------------------------------------------------------------------
  log('\n[11..12] normaliseGiftCardCode')
  assert(
    normaliseGiftCardCode('  abcd-1234-efgh ') === 'ABCD1234EFGH',
    '[11] normaliseGiftCardCode strips dashes + spaces + uppercases',
  )
  assert(
    normaliseGiftCardCode('PLAIN') === 'PLAIN',
    '[12] normaliseGiftCardCode idempotent',
  )

  // -------------------------------------------------------------------------
  // [13..15] createGiftCard persistence
  // -------------------------------------------------------------------------
  log('\n[13..15] createGiftCard persistence')

  const happyCard = await createGiftCard(db as any, SHOP_A, {
    initialValue: '50',
    currency: 'USD',
    recipientEmail: 'recipient@example.test',
    recipientName: 'Alice',
    senderName: 'Bob',
    personalMessage: 'Happy birthday!',
    sendAt: new Date(Date.now() - 60_000).toISOString(), // past = eligible for pending
  })
  assert(
    (happyCard as any).recipient_email === 'recipient@example.test' &&
      (happyCard as any).recipient_name === 'Alice' &&
      (happyCard as any).sender_name === 'Bob' &&
      (happyCard as any).personal_message === 'Happy birthday!' &&
      (happyCard as any).send_at !== null,
    '[13] createGiftCard persists recipient + delivery fields',
  )

  const normalisedCard = await createGiftCard(db as any, SHOP_A, {
    initialValue: '10',
    currency: 'USD',
    code: 'abcd-1234',
  })
  assert(
    (normalisedCard as any).code === 'ABCD1234',
    `[14] createGiftCard normalises dashed code (got ${(normalisedCard as any).code})`,
  )

  assert(
    parseFloat((happyCard as any).redeemed_amount) === 0,
    '[15] createGiftCard defaults redeemed_amount to 0.00',
  )

  // -------------------------------------------------------------------------
  // [16..24] validateGiftCardForCheckout
  // -------------------------------------------------------------------------
  log('\n[16..24] validateGiftCardForCheckout')

  // Seed extra cards for each branch.
  const disabledCard = await createGiftCard(db as any, SHOP_A, {
    initialValue: '20',
    currency: 'USD',
  })
  await disableGiftCard(db as any, disabledCard.id)

  const expiredCard = await createGiftCard(db as any, SHOP_A, {
    initialValue: '30',
    currency: 'USD',
    expiresAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
  })

  const zeroBalanceCard = await createGiftCard(db as any, SHOP_A, {
    initialValue: '0.00',
    currency: 'USD',
  })

  const eurCard = await createGiftCard(db as any, SHOP_A, {
    initialValue: '40',
    currency: 'EUR',
  })

  // Happy path: cart $100, balance $50 → applicable $50
  const happyValidation = await validateGiftCardForCheckout(
    db as any,
    SHOP_A,
    (happyCard as any).code,
    100,
    'USD',
  )
  assert(
    happyValidation.ok === true &&
      (happyValidation as any).applicable === '50.00' &&
      (happyValidation as any).giftCard.id === happyCard.id,
    '[16] validateGiftCardForCheckout happy path → applicable=50.00',
  )

  const notFound = await validateGiftCardForCheckout(db as any, SHOP_A, 'NOPE-NOPE-NOPE', 20, 'USD')
  assert(
    notFound.ok === false && (notFound as any).reason === 'not_found',
    '[17] validateGiftCardForCheckout → not_found',
  )

  const disabledRes = await validateGiftCardForCheckout(
    db as any,
    SHOP_A,
    (disabledCard as any).code,
    20,
    'USD',
  )
  assert(
    disabledRes.ok === false && (disabledRes as any).reason === 'disabled',
    '[18] validateGiftCardForCheckout → disabled',
  )

  const expiredRes = await validateGiftCardForCheckout(
    db as any,
    SHOP_A,
    (expiredCard as any).code,
    20,
    'USD',
  )
  assert(
    expiredRes.ok === false && (expiredRes as any).reason === 'expired',
    '[19] validateGiftCardForCheckout → expired',
  )

  const zeroRes = await validateGiftCardForCheckout(
    db as any,
    SHOP_A,
    (zeroBalanceCard as any).code,
    20,
    'USD',
  )
  assert(
    zeroRes.ok === false && (zeroRes as any).reason === 'zero_balance',
    '[20] validateGiftCardForCheckout → zero_balance',
  )

  const currencyRes = await validateGiftCardForCheckout(
    db as any,
    SHOP_A,
    (eurCard as any).code,
    20,
    'USD',
  )
  assert(
    currencyRes.ok === false && (currencyRes as any).reason === 'currency_mismatch',
    '[21] validateGiftCardForCheckout → currency_mismatch',
  )

  const negativeRes = await validateGiftCardForCheckout(
    db as any,
    SHOP_A,
    (happyCard as any).code,
    -5,
    'USD',
  )
  assert(
    negativeRes.ok === false && (negativeRes as any).reason === 'invalid_cart_total',
    '[22] validateGiftCardForCheckout → invalid_cart_total (negative)',
  )

  // Cart $10, balance $50 → applicable $10 (capped at cart total)
  const cappedRes = await validateGiftCardForCheckout(
    db as any,
    SHOP_A,
    (happyCard as any).code,
    10,
    'USD',
  )
  assert(
    cappedRes.ok === true && (cappedRes as any).applicable === '10.00',
    '[23] validateGiftCardForCheckout caps applicable at cart total',
  )

  const crossShopRes = await validateGiftCardForCheckout(
    db as any,
    SHOP_B,
    (happyCard as any).code, // belongs to SHOP_A
    20,
    'USD',
  )
  assert(
    crossShopRes.ok === false && (crossShopRes as any).reason === 'not_found',
    '[24] validateGiftCardForCheckout blocks cross-shop lookup',
  )

  // -------------------------------------------------------------------------
  // [25] markGiftCardEmailSent
  // -------------------------------------------------------------------------
  log('\n[25] markGiftCardEmailSent')

  await markGiftCardEmailSent(db as any, happyCard.id)
  const afterMark = await getGiftCardById(db as any, happyCard.id)
  assert(
    !!(afterMark as any)?.email_sent_at,
    '[25] markGiftCardEmailSent flips email_sent_at to a timestamp',
  )

  // -------------------------------------------------------------------------
  // [26..30] listPendingEmailDeliveries
  // -------------------------------------------------------------------------
  log('\n[26..30] listPendingEmailDeliveries')

  // Build 4 rows covering each filter boundary.
  const pendingReady = await createGiftCard(db as any, SHOP_A, {
    initialValue: '5',
    currency: 'USD',
    recipientEmail: 'ready@example.test',
    sendAt: new Date(Date.now() - 60_000).toISOString(),
  })
  const pendingFuture = await createGiftCard(db as any, SHOP_A, {
    initialValue: '5',
    currency: 'USD',
    recipientEmail: 'future@example.test',
    sendAt: new Date(Date.now() + 86_400_000).toISOString(),
  })
  const pendingDisabled = await createGiftCard(db as any, SHOP_A, {
    initialValue: '5',
    currency: 'USD',
    recipientEmail: 'disabled@example.test',
    sendAt: new Date(Date.now() - 60_000).toISOString(),
  })
  await disableGiftCard(db as any, pendingDisabled.id)
  const pendingNoRecipient = await createGiftCard(db as any, SHOP_A, {
    initialValue: '5',
    currency: 'USD',
    sendAt: new Date(Date.now() - 60_000).toISOString(),
  })
  const alreadySent = await createGiftCard(db as any, SHOP_A, {
    initialValue: '5',
    currency: 'USD',
    recipientEmail: 'sent@example.test',
    sendAt: new Date(Date.now() - 60_000).toISOString(),
  })
  await markGiftCardEmailSent(db as any, alreadySent.id)

  const queue = await listPendingEmailDeliveries(db as any, { shopId: SHOP_A })
  const queueIds = new Set(queue.map((r) => r.id))
  assert(queueIds.has(pendingReady.id), '[26] listPendingEmailDeliveries picks up ready row')
  assert(!queueIds.has(alreadySent.id), '[27] listPendingEmailDeliveries excludes already-sent')
  assert(!queueIds.has(pendingDisabled.id), '[28] listPendingEmailDeliveries excludes disabled')
  assert(!queueIds.has(pendingFuture.id), '[29] listPendingEmailDeliveries excludes future send_at')
  assert(!queueIds.has(pendingNoRecipient.id), '[30] listPendingEmailDeliveries excludes null recipient')

  // -------------------------------------------------------------------------
  // [31..33] deliverGiftCardNow guards
  // -------------------------------------------------------------------------
  log('\n[31..33] deliverGiftCardNow guards')

  let missingThrew = false
  try {
    await deliverGiftCardNow(db as any, randomUUID())
  } catch (err: any) {
    missingThrew = /not found/i.test(err?.message ?? '')
  }
  assert(missingThrew, '[31] deliverGiftCardNow throws on missing card')

  let disabledThrew = false
  try {
    await deliverGiftCardNow(db as any, disabledCard.id)
  } catch (err: any) {
    disabledThrew = /disabled/i.test(err?.message ?? '')
  }
  assert(disabledThrew, '[32] deliverGiftCardNow throws on disabled card')

  let noRecipientThrew = false
  try {
    await deliverGiftCardNow(db as any, pendingNoRecipient.id)
  } catch (err: any) {
    noRecipientThrew = /no recipient/i.test(err?.message ?? '')
  }
  assert(noRecipientThrew, '[33] deliverGiftCardNow throws on null recipient')

  // -------------------------------------------------------------------------
  // [34] redeemGiftCard bumps markers
  // -------------------------------------------------------------------------
  log('\n[34] redeemGiftCard bumps markers')

  const redeemSource = await createGiftCard(db as any, SHOP_A, {
    initialValue: '25',
    currency: 'USD',
  })
  await redeemGiftCard(db as any, redeemSource.code, '10')
  const afterRedeem = await getGiftCardById(db as any, redeemSource.id)
  assert(
    parseFloat((afterRedeem as any).balance) === 15 &&
      parseFloat((afterRedeem as any).redeemed_amount) === 10 &&
      !!(afterRedeem as any).last_redeemed_at,
    '[34] redeemGiftCard bumps balance + redeemed_amount + last_redeemed_at',
  )

  // -------------------------------------------------------------------------
  // [35..36] updateGiftCard partial patch
  // -------------------------------------------------------------------------
  log('\n[35..36] updateGiftCard partial patch')

  await updateGiftCard(db as any, redeemSource.id, {
    recipientEmail: 'late-add@example.test',
    personalMessage: 'Here it is!',
  })
  const afterPatch = await getGiftCardById(db as any, redeemSource.id)
  assert(
    (afterPatch as any).recipient_email === 'late-add@example.test' &&
      (afterPatch as any).personal_message === 'Here it is!' &&
      // fields we didn't patch stay untouched
      parseFloat((afterPatch as any).balance) === 15,
    '[35] updateGiftCard patches only requested fields',
  )

  const beforeEmpty = await getGiftCardById(db as any, redeemSource.id)
  await updateGiftCard(db as any, redeemSource.id, {})
  const afterEmpty = await getGiftCardById(db as any, redeemSource.id)
  assert(
    String((beforeEmpty as any).updated_at) === String((afterEmpty as any).updated_at),
    '[36] updateGiftCard no-ops (no UPDATE issued) on empty patch',
  )

  // -------------------------------------------------------------------------
  // [37..42] Iron rule 5 — safeFlashMessage mapper
  // -------------------------------------------------------------------------
  log('\n[37..42] Iron rule 5 audit — safeFlashMessage')

  const godAdmin = /god[\s-]*admin/i

  const m1 = _safeFlashMessage(new Error('internal god-admin path leaked'))
  assert(!godAdmin.test(m1) && /gbox support/i.test(m1), '[37] safeFlashMessage scrubs god-admin, falls back to support copy')

  const m2 = _safeFlashMessage(new Error('Gift card not found in DB'))
  assert(/not found/i.test(m2) && !godAdmin.test(m2), '[38] safeFlashMessage maps "not found" to user copy')

  const m3 = _safeFlashMessage(new Error('This gift card has been disabled for policy reasons'))
  assert(/disabled/i.test(m3) && !godAdmin.test(m3), '[39] safeFlashMessage maps "disabled" to user copy')

  const m4 = _safeFlashMessage(new Error('Gift card has no recipient email on the row'))
  assert(/recipient/i.test(m4) && !godAdmin.test(m4), '[40] safeFlashMessage maps "no recipient" to user copy')

  const m5 = _safeFlashMessage(new Error('SMTP connection refused'))
  assert(/try again|email/i.test(m5) && !godAdmin.test(m5), '[41] safeFlashMessage maps SMTP failures to retry copy')

  const m6 = _safeFlashMessage(new Error('random unexpected blob'))
  assert(/gbox support/i.test(m6), '[42] safeFlashMessage fallback mentions Gbox support')

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  log(`\n=== Phase 10 PR2 smoke: ${total - failed}/${total} passed (${failed} failed) ===\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((err) => {
    console.error('Phase 10 PR2 smoke — fatal error:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    log('\n[cleanup] Removing seeded rows')
    try {
      await (db as any)
        .deleteFrom('gift_card_transactions')
        .where('gift_card_id', 'in',
          (db as any).selectFrom('gift_cards').select('id').where('shop_id', 'in', [SHOP_A, SHOP_B]),
        )
        .execute()
      await (db as any).deleteFrom('gift_cards').where('shop_id', 'in', [SHOP_A, SHOP_B]).execute()
      await (db as any).deleteFrom('shops').where('id', 'in', [SHOP_A, SHOP_B]).execute()
      log('[cleanup] Done.')
    } catch (err) {
      console.error('[cleanup] failed:', err)
    }
    await (db as any).destroy()
  })
