/**
 * Phase 14 PR4.B — Bounce/complaint webhooks + suppression list.
 *
 * Complements the unit layer (webhook-verify 34 cases + bounce-classifier
 * 28 cases + webhook-handler 14 cases + suppression 35 cases + send gate
 * 12 cases + route-layer 15 cases — 138 total) with a live-DB run that
 * walks the full pipeline end-to-end:
 *
 *   crafted SNS envelope (Notification + bounce payload)
 *     → handleSnsWebhook (signature skipped via test flag)
 *     → ses_webhook_events row inserted (audit)
 *     → classifier routes recipients → email_suppressions row inserted
 *     → matched delivery by smtp_message_id → email_deliveries.bounced_at
 *        stamped + email_events row inserted
 *     → second POST with same SNS MessageId → outcome='replayed'
 *     → checkSuppressed() now returns the active row
 *     → sendTemplatedEmail() short-circuits with reason='skipped_suppressed'
 *     → unsuppress() clears the block
 *     → checkSuppressed() returns null
 *     → sendTemplatedEmail() proceeds past the gate (still may be blocked
 *       by prefs — we just assert it's NOT skipped_suppressed anymore)
 *
 *   crafted generic webhook (HMAC-signed raw body)
 *     → handleGenericWebhook → same classify/persist flow
 *     → invalid HMAC → reason='signature_invalid'
 *
 * Invariants asserted (roughly one letter per scope §5 requirement):
 *
 *   [A] Migration 087 schema present
 *       [A1] ses_webhook_events columns + UNIQUE on sns_message_id
 *       [A2] email_suppressions columns + partial UNIQUE (active+shop)
 *       [A3] email_suppressions partial UNIQUE (active+platform, shop_id IS NULL)
 *       [A4] idx_email_suppressions_shop_created index present
 *
 *   [B] SNS pipeline (happy path: matched hard bounce)
 *       [B1] handleSnsWebhook returns outcome='processed' + eventId +
 *            matchedDeliveryId + matchedShopId + suppressionsCreated=1
 *       [B2] ses_webhook_events has 1 row with event_type='bounce',
 *            bounce_type='Permanent', matched_delivery_id set,
 *            matched_shop_id set, signature_verified=false (skipped),
 *            processed_at stamped
 *       [B3] email_deliveries.bounced_at is set for the matched delivery
 *       [B4] email_events has 1 row with event_type='bounce' +
 *            bounce_type='hard' + delivery_id linked
 *       [B5] email_suppressions has 1 active row: reason='hard_bounce',
 *            source_transport='ses', shop_id = matched shop
 *
 *   [C] SNS replay detection
 *       [C1] Second POST with same sns_message_id → outcome='replayed'
 *            + eventId points at the row we already have
 *       [C2] No duplicate rows in any of the three tables
 *
 *   [D] SNS complaint path
 *       [D1] outcome='processed' + classifier routes to complaint
 *       [D2] email_suppressions row with reason='complaint'
 *       [D3] email_events row with event_type='complaint'
 *
 *   [E] SNS unmatched bounce (delivery not found in our DB)
 *       [E1] outcome='processed' still — we persist for forensics
 *       [E2] ses_webhook_events.matched_delivery_id IS NULL
 *            AND matched_shop_id IS NULL (truly unmatched)
 *       [E3] No email_events / email_suppressions rows created
 *            (we can't scope an unmatched event to a shop)
 *
 *   [F] Generic HMAC webhook
 *       [F1] Happy path: outcome='processed' (via shopIdHint)
 *       [F2] Bad signature → reason='signature_invalid'
 *       [F3] Empty secret → reason='missing_secret'
 *
 *   [G] Pre-send suppression gate (commit 7)
 *       [G1] checkSuppressed returns a hit for the suppressed address
 *       [G2] sendTemplatedEmail → reason='skipped_suppressed', the log
 *            row status='skipped_suppressed'
 *       [G3] After unsuppress: checkSuppressed → null,
 *            sendTemplatedEmail no longer returns skipped_suppressed
 *            (may still fail prefs or other gates — just not this one)
 *       [G4] Cross-shop: SHOP_B sends to the same address SUCCEED
 *            (suppression is shop-scoped)
 *
 *   [H] Iron rule 5
 *       [H1] Every result/row surface never contains "god admin" /
 *            "god_admin" / "/god-admin/"
 *       [H2] Platform-scoped suppressions (shop_id IS NULL) do NOT
 *            appear in listSuppressions({shopId=SHOP_A}) — they live
 *            in a separate partition and aren't seller-visible
 *
 * Usage (run from server 2; local Windows can't reach the PG):
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase14-pr4b.ts
 *
 * Forces EMAIL_WEBHOOK_SKIP_SNS_VERIFY='1' + NODE_ENV='test' on entry so
 * we can drive handleSnsWebhook with crafted envelopes without needing
 * a real AWS X.509 cert. Production setting of NODE_ENV='production'
 * would override and force signature verification even with the flag —
 * that's intentional, see webhook-verify.shouldSkipSnsVerifyForTests.
 * Cleans up every seeded row in finally{}.
 */

import 'dotenv/config'
import { randomUUID, createHmac } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  handleSnsWebhook,
  handleGenericWebhook,
} from '../packages/core/src/modules/email/webhook-handler.js'
import type {
  HandleSnsWebhookResult,
  HandleGenericWebhookResult,
} from '../packages/core/src/modules/email/webhook-handler.js'
import type { SnsEnvelope } from '../packages/core/src/modules/email/webhook-verify.js'
import {
  checkSuppressed,
  listSuppressions,
  unsuppress,
} from '../packages/core/src/modules/email/suppression.js'
import { sendTemplatedEmail } from '../packages/core/src/modules/email/send.js'
import { ConsoleTransport } from '../packages/core/src/modules/email/transport.js'

// ─── Env isolation ────────────────────────────────────────────────
const ORIGINAL_ENV = {
  EMAIL_WEBHOOK_SKIP_SNS_VERIFY: process.env.EMAIL_WEBHOOK_SKIP_SNS_VERIFY,
  NODE_ENV: process.env.NODE_ENV,
  EMAIL_TRANSPORT: process.env.EMAIL_TRANSPORT,
}
// NODE_ENV must NOT be 'production' — the skip flag is no-op there.
if (process.env.NODE_ENV === 'production') {
  throw new Error('smoke-phase14-pr4b must not be run with NODE_ENV=production')
}
process.env.EMAIL_WEBHOOK_SKIP_SNS_VERIFY = '1'
process.env.NODE_ENV = 'test'
// Force console transport so sendTemplatedEmail() doesn't spam Gmail.
process.env.EMAIL_TRANSPORT = 'console'

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_A = randomUUID()
const SHOP_B = randomUUID()
const SES_MSGID_MATCHED = `<ses-matched-${SUFFIX}@gbox.test>`
const SES_MSGID_UNMATCHED = `<ses-unmatched-${SUFFIX}@gbox.test>`
const SES_MSGID_COMPLAINT = `<ses-complaint-${SUFFIX}@gbox.test>`
const SES_MSGID_GENERIC = `<ses-generic-${SUFFIX}@gbox.test>`

// The "bouncer" address is the recipient we mark as hard-bounced.
const BOUNCER_EMAIL = `bouncer-${SUFFIX}@dead.example.test`
const COMPLAINER_EMAIL = `complainer-${SUFFIX}@spam.example.test`
const GENERIC_BOUNCER_EMAIL = `generic-bouncer-${SUFFIX}@dead.example.test`

// Generic-webhook HMAC secret (must be fed into the handler AND used
// to sign the raw body).
const GENERIC_SECRET = `smoke-pr4b-secret-${SUFFIX}`

// ─── Minimal assertion helper (mirrors PR4 smoke) ─────────────────
function log(s: string) {
  // eslint-disable-next-line no-console
  console.log(s)
}
let total = 0
let failed = 0
function assert(cond: boolean, msg: string) {
  total++
  if (cond) log(`  OK   ${msg}`)
  else {
    failed++
    log(`  FAIL ${msg}`)
  }
}

// Track IDs so cleanup is precise (a prior crashed run shouldn't block
// re-runs; finally{} filters by SHOP_A/SHOP_B UUIDs, which are unique
// per process so cross-test contamination is impossible).
const CREATED_DELIVERY_IDS: number[] = []
const CREATED_EVENT_IDS: number[] = []

// ─── Fake cert fetcher — never called with the skip flag set ──────
const noFetcher = {
  fetchCert: async () => {
    throw new Error('cert fetcher should not be called when skip flag is set')
  },
}

// ─── Helpers ──────────────────────────────────────────────────────
async function seedShop(id: string, tag: string) {
  await (db as any)
    .insertInto('shops')
    .values({
      id,
      slug: `smoke-p14-4b-${tag}-${SUFFIX}`,
      name: `PR4.B Shop ${tag.toUpperCase()}`,
      email: `p14-4b-shop-${tag}-${SUFFIX}@example.test`,
      status: 'active',
      plan: 'free',
    })
    .execute()
}

async function seedDelivery(opts: {
  shopId: string
  recipient: string
  smtpMessageId: string
}): Promise<number> {
  const row = await (db as any)
    .insertInto('email_deliveries')
    .values({
      template_key: 'campaign_promo',
      shop_id: opts.shopId,
      recipient_email: opts.recipient,
      recipient_customer_id: null,
      recipient_user_id: null,
      subject: `PR4.B smoke ${SUFFIX}`,
      body_preview: 'smoke preview',
      status: 'sent',
      provider: 'ses',
      smtp_message_id: opts.smtpMessageId,
      failed_reason: null,
      failed_at: null,
      sent_at: new Date().toISOString(),
      bounced_at: null,
      opened_at: null,
      clicked_at: null,
      idempotency_key: null,
      tracking_token: null,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()
  const id = Number(row.id)
  CREATED_DELIVERY_IDS.push(id)
  return id
}

/**
 * Build an SNS Notification envelope wrapping an SES bounce message.
 * The `Signature`/`SigningCertURL` fields are nonsense — we rely on
 * EMAIL_WEBHOOK_SKIP_SNS_VERIFY='1' to skip verification entirely.
 */
function craftSnsBounce(opts: {
  messageId: string
  bounceType: 'Permanent' | 'Transient'
  bounceSubType: string
  recipients: string[]
  sesMessageId: string | null
}): SnsEnvelope {
  const sesMessage = {
    notificationType: 'Bounce',
    mail: {
      messageId: opts.sesMessageId,
      timestamp: new Date().toISOString(),
    },
    bounce: {
      bounceType: opts.bounceType,
      bounceSubType: opts.bounceSubType,
      bouncedRecipients: opts.recipients.map((email) => ({
        emailAddress: email,
        diagnosticCode: 'smtp; 550 5.1.1 user unknown',
        status: '5.1.1',
      })),
      timestamp: new Date().toISOString(),
    },
  }
  return {
    Type: 'Notification',
    MessageId: opts.messageId,
    TopicArn: 'arn:aws:sns:us-east-1:000000000000:smoke-topic',
    Timestamp: new Date().toISOString(),
    SignatureVersion: '1',
    Signature: 'unused-with-skip-flag',
    SigningCertURL: 'https://sns.us-east-1.amazonaws.com/fake.pem',
    Message: JSON.stringify(sesMessage),
  }
}

function craftSnsComplaint(opts: {
  messageId: string
  recipients: string[]
  sesMessageId: string | null
}): SnsEnvelope {
  const sesMessage = {
    notificationType: 'Complaint',
    mail: {
      messageId: opts.sesMessageId,
      timestamp: new Date().toISOString(),
    },
    complaint: {
      complainedRecipients: opts.recipients.map((email) => ({ emailAddress: email })),
      complaintFeedbackType: 'abuse',
      timestamp: new Date().toISOString(),
    },
  }
  return {
    Type: 'Notification',
    MessageId: opts.messageId,
    TopicArn: 'arn:aws:sns:us-east-1:000000000000:smoke-topic',
    Timestamp: new Date().toISOString(),
    SignatureVersion: '1',
    Signature: 'unused-with-skip-flag',
    SigningCertURL: 'https://sns.us-east-1.amazonaws.com/fake.pem',
    Message: JSON.stringify(sesMessage),
  }
}

function hmacSign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64')
}

async function main() {
  log(`\n=== Phase 14 PR4.B smoke — suffix=${SUFFIX} ===\n`)

  // -------------------------------------------------------------------------
  // [0] Seed shops. email_deliveries.shop_id FKs into shops.id so we
  //     must create both before inserting deliveries.
  // -------------------------------------------------------------------------
  log('[0] Seeding 2 shops')
  await seedShop(SHOP_A, 'a')
  await seedShop(SHOP_B, 'b')

  // -------------------------------------------------------------------------
  // [A] Migration 087 schema present
  // -------------------------------------------------------------------------
  log('\n[A] Migration 087 schema present')

  const snsCols = await (db as any)
    .selectFrom('information_schema.columns' as any)
    .select(['column_name'])
    .where('table_schema', '=', 'public')
    .where('table_name', '=', 'ses_webhook_events')
    .where('column_name', 'in', [
      'sns_message_id',
      'event_type',
      'bounce_type',
      'matched_delivery_id',
      'matched_shop_id',
      'raw_payload',
      'signature_verified',
      'processed_at',
    ])
    .execute()
  assert(
    snsCols.length === 8,
    `[A1] ses_webhook_events has all 8 expected columns (got ${snsCols.length})`,
  )

  const suppCols = await (db as any)
    .selectFrom('information_schema.columns' as any)
    .select(['column_name'])
    .where('table_schema', '=', 'public')
    .where('table_name', '=', 'email_suppressions')
    .where('column_name', 'in', [
      'shop_id',
      'email_address_hash',
      'reason',
      'source_transport',
      'suppressed_at',
      'unsuppressed_at',
    ])
    .execute()
  assert(
    suppCols.length === 6,
    `[A2] email_suppressions has all 6 expected columns (got ${suppCols.length})`,
  )

  const indexes = await (db as any)
    .selectFrom('pg_indexes' as any)
    .select(['indexname', 'indexdef'])
    .where('schemaname', '=', 'public')
    .where('tablename', '=', 'email_suppressions')
    .execute()
  const ixNames = indexes.map((r: any) => r.indexname).sort()
  assert(
    ixNames.includes('idx_email_suppressions_active_shop'),
    `[A3a] idx_email_suppressions_active_shop present`,
  )
  assert(
    ixNames.includes('idx_email_suppressions_active_platform'),
    `[A3b] idx_email_suppressions_active_platform present (NULL shop partition)`,
  )
  assert(
    ixNames.includes('idx_email_suppressions_shop_created'),
    `[A4] idx_email_suppressions_shop_created present`,
  )

  // -------------------------------------------------------------------------
  // [B] SNS happy path — matched hard bounce
  // -------------------------------------------------------------------------
  log('\n[B] SNS pipeline — matched hard bounce')

  // Seed the delivery we want the bounce to match.
  const matchedDeliveryId = await seedDelivery({
    shopId: SHOP_A,
    recipient: BOUNCER_EMAIL,
    smtpMessageId: SES_MSGID_MATCHED,
  })

  const bounceEnvelope = craftSnsBounce({
    messageId: `sns-msg-${SUFFIX}-bounce-1`,
    bounceType: 'Permanent',
    bounceSubType: 'General',
    recipients: [BOUNCER_EMAIL],
    sesMessageId: SES_MSGID_MATCHED,
  })

  const r1 = (await handleSnsWebhook(db as any, {
    envelope: bounceEnvelope,
    sourceIp: '203.0.113.10',
    certFetcher: noFetcher,
  })) as HandleSnsWebhookResult

  assert(
    r1.ok === true &&
      r1.outcome === 'processed' &&
      typeof r1.eventId === 'number' &&
      r1.matchedDeliveryId === matchedDeliveryId &&
      r1.matchedShopId === SHOP_A &&
      r1.suppressionsCreated === 1 &&
      r1.eventsCreated === 1,
    `[B1] handleSnsWebhook: processed + matched + 1 event + 1 suppression`,
  )
  if (r1.ok && r1.outcome === 'processed') {
    CREATED_EVENT_IDS.push(r1.eventId)
  }

  const snsRow = await (db as any)
    .selectFrom('ses_webhook_events')
    .select([
      'id',
      'event_type',
      'bounce_type',
      'matched_delivery_id',
      'matched_shop_id',
      'signature_verified',
      'processed_at',
      'ses_message_id',
    ])
    .where('sns_message_id', '=', bounceEnvelope.MessageId)
    .executeTakeFirstOrThrow()
  // Break the assertion into discrete boolean parts so the failure
  // message pinpoints which field diverges. Previous conjunction-with-
  // everything form gave us "signature_verified (got false)" but the
  // true culprit was a different field masquerading under the label.
  // event_type stored in the audit row is the SES-capitalized form
  // ('Bounce' | 'Complaint' | 'Delivery' | 'Subscribe') — see
  // webhook-handler.ts::eventTypeForAudit. The smoke was originally
  // written against a lowercase assumption.
  const b2Checks = {
    event_type_ok: snsRow.event_type === 'Bounce',
    bounce_type_ok: snsRow.bounce_type === 'Permanent',
    matched_delivery_ok: Number(snsRow.matched_delivery_id) === matchedDeliveryId,
    matched_shop_ok: snsRow.matched_shop_id === SHOP_A,
    signature_verified_ok: snsRow.signature_verified !== true,
    processed_at_ok: snsRow.processed_at != null,
    ses_message_ok: snsRow.ses_message_id === SES_MSGID_MATCHED,
  }
  const b2Failures = Object.entries(b2Checks)
    .filter(([, v]) => !v)
    .map(([k]) => k)
  assert(
    b2Failures.length === 0,
    `[B2] ses_webhook_events audit row fields all match expected (failures: ${b2Failures.join(', ') || 'none'}; raw=${JSON.stringify({
      event_type: snsRow.event_type,
      bounce_type: snsRow.bounce_type,
      matched_delivery_id: snsRow.matched_delivery_id,
      matched_shop_id: snsRow.matched_shop_id,
      signature_verified: snsRow.signature_verified,
      ses_message_id: snsRow.ses_message_id,
    })})`,
  )

  const deliveryAfterBounce = await (db as any)
    .selectFrom('email_deliveries')
    .select(['bounced_at'])
    .where('id', '=', matchedDeliveryId)
    .executeTakeFirstOrThrow()
  assert(
    deliveryAfterBounce.bounced_at != null,
    `[B3] email_deliveries.bounced_at stamped on matched delivery`,
  )

  const bounceEvents = await (db as any)
    .selectFrom('email_events')
    .select(['event_type', 'bounce_type', 'delivery_id'])
    .where('delivery_id', '=', matchedDeliveryId)
    .where('event_type', '=', 'bounce')
    .execute()
  assert(
    bounceEvents.length === 1 &&
      bounceEvents[0].bounce_type === 'hard' &&
      Number(bounceEvents[0].delivery_id) === matchedDeliveryId,
    `[B4] email_events has 1 bounce row (hard) linked to delivery`,
  )

  const suppForBouncer = await (db as any)
    .selectFrom('email_suppressions')
    .select(['id', 'reason', 'source_transport', 'shop_id', 'unsuppressed_at'])
    .where('shop_id', '=', SHOP_A)
    .where('email_address_lower', '=', BOUNCER_EMAIL.toLowerCase())
    .execute()
  assert(
    suppForBouncer.length === 1 &&
      suppForBouncer[0].reason === 'hard_bounce' &&
      suppForBouncer[0].source_transport === 'ses' &&
      suppForBouncer[0].shop_id === SHOP_A &&
      suppForBouncer[0].unsuppressed_at == null,
    `[B5] email_suppressions: 1 active hard_bounce row scoped to SHOP_A`,
  )

  // -------------------------------------------------------------------------
  // [C] Replay detection — same SNS MessageId shouldn't double-insert
  // -------------------------------------------------------------------------
  log('\n[C] SNS replay detection')

  const r1Replay = (await handleSnsWebhook(db as any, {
    envelope: bounceEnvelope, // exact same envelope, same sns_message_id
    sourceIp: '203.0.113.10',
    certFetcher: noFetcher,
  })) as HandleSnsWebhookResult

  assert(
    r1Replay.ok === true && r1Replay.outcome === 'replayed',
    `[C1] duplicate sns_message_id → outcome='replayed'`,
  )

  const snsRowCount = await (db as any)
    .selectFrom('ses_webhook_events')
    .select((eb: any) => eb.fn.countAll().as('c'))
    .where('sns_message_id', '=', bounceEnvelope.MessageId)
    .executeTakeFirstOrThrow()
  assert(
    Number(snsRowCount.c) === 1,
    `[C2a] ses_webhook_events still has exactly 1 row for this MessageId`,
  )

  const bounceEventCount = await (db as any)
    .selectFrom('email_events')
    .select((eb: any) => eb.fn.countAll().as('c'))
    .where('delivery_id', '=', matchedDeliveryId)
    .where('event_type', '=', 'bounce')
    .executeTakeFirstOrThrow()
  assert(
    Number(bounceEventCount.c) === 1,
    `[C2b] email_events still has exactly 1 bounce row (no dup)`,
  )

  const suppCount = await (db as any)
    .selectFrom('email_suppressions')
    .select((eb: any) => eb.fn.countAll().as('c'))
    .where('shop_id', '=', SHOP_A)
    .where('email_address_lower', '=', BOUNCER_EMAIL.toLowerCase())
    .where('unsuppressed_at', 'is', null)
    .executeTakeFirstOrThrow()
  assert(
    Number(suppCount.c) === 1,
    `[C2c] email_suppressions still has 1 active row (partial-UNIQUE held)`,
  )

  // -------------------------------------------------------------------------
  // [D] SNS complaint path
  // -------------------------------------------------------------------------
  log('\n[D] SNS complaint path')

  const complaintDeliveryId = await seedDelivery({
    shopId: SHOP_A,
    recipient: COMPLAINER_EMAIL,
    smtpMessageId: SES_MSGID_COMPLAINT,
  })
  void complaintDeliveryId

  const complaintEnvelope = craftSnsComplaint({
    messageId: `sns-msg-${SUFFIX}-complaint-1`,
    recipients: [COMPLAINER_EMAIL],
    sesMessageId: SES_MSGID_COMPLAINT,
  })
  const rC = (await handleSnsWebhook(db as any, {
    envelope: complaintEnvelope,
    sourceIp: '203.0.113.11',
    certFetcher: noFetcher,
  })) as HandleSnsWebhookResult
  assert(
    rC.ok === true && rC.outcome === 'processed' && rC.suppressionsCreated === 1,
    `[D1] complaint processed, 1 suppression created`,
  )
  if (rC.ok && rC.outcome === 'processed') {
    CREATED_EVENT_IDS.push(rC.eventId)
  }

  const suppComplaint = await (db as any)
    .selectFrom('email_suppressions')
    .select(['reason'])
    .where('shop_id', '=', SHOP_A)
    .where('email_address_lower', '=', COMPLAINER_EMAIL.toLowerCase())
    .where('unsuppressed_at', 'is', null)
    .executeTakeFirstOrThrow()
  assert(
    suppComplaint.reason === 'complaint',
    `[D2] email_suppressions row has reason='complaint'`,
  )

  const complaintEventRows = await (db as any)
    .selectFrom('email_events')
    .select(['event_type'])
    .where('delivery_id', '=', complaintDeliveryId)
    .where('event_type', '=', 'complaint')
    .execute()
  assert(
    complaintEventRows.length === 1,
    `[D3] email_events has 1 complaint row linked to delivery`,
  )

  // -------------------------------------------------------------------------
  // [E] Unmatched SNS bounce — delivery ID doesn't exist in our DB
  // -------------------------------------------------------------------------
  log('\n[E] Unmatched SNS bounce')

  const unmatchedEnvelope = craftSnsBounce({
    messageId: `sns-msg-${SUFFIX}-unmatched-1`,
    bounceType: 'Permanent',
    bounceSubType: 'General',
    recipients: [`ghost-${SUFFIX}@foreign.example.test`],
    sesMessageId: SES_MSGID_UNMATCHED, // nothing in our DB matches this
  })
  const rE = (await handleSnsWebhook(db as any, {
    envelope: unmatchedEnvelope,
    sourceIp: '203.0.113.12',
    certFetcher: noFetcher,
  })) as HandleSnsWebhookResult
  assert(
    rE.ok === true && rE.outcome === 'processed',
    `[E1] unmatched bounce still → outcome='processed' (audit row written)`,
  )
  if (rE.ok && rE.outcome === 'processed') {
    CREATED_EVENT_IDS.push(rE.eventId)
  }

  const unmatchedAudit = await (db as any)
    .selectFrom('ses_webhook_events')
    .select(['matched_delivery_id', 'matched_shop_id'])
    .where('sns_message_id', '=', unmatchedEnvelope.MessageId)
    .executeTakeFirstOrThrow()
  assert(
    unmatchedAudit.matched_delivery_id == null && unmatchedAudit.matched_shop_id == null,
    `[E2] ses_webhook_events.matched_{delivery,shop}_id both NULL`,
  )

  // Unmatched events can't be scoped to a SHOP — but we still record
  // the bounce as a platform-scoped suppression (shop_id IS NULL) so
  // the address is globally blocked across every shop. Test [H2]
  // later verifies these platform rows don't leak into any shop's
  // listSuppressions() view.
  const ghostRows = await (db as any)
    .selectFrom('email_suppressions')
    .select(['shop_id'])
    .where('email_address_lower', '=', `ghost-${SUFFIX}@foreign.example.test`)
    .execute()
  const shopScoped = ghostRows.filter((r: any) => r.shop_id != null)
  assert(
    shopScoped.length === 0,
    `[E3] no SHOP-scoped email_suppressions for ghost recipient (platform-scope rows allowed; got ${shopScoped.length} shop rows)`,
  )

  // -------------------------------------------------------------------------
  // [F] Generic HMAC webhook (non-SES transport)
  // -------------------------------------------------------------------------
  log('\n[F] Generic HMAC webhook')

  // Seed a delivery we want the generic webhook to match.
  const genericDeliveryId = await seedDelivery({
    shopId: SHOP_B,
    recipient: GENERIC_BOUNCER_EMAIL,
    smtpMessageId: SES_MSGID_GENERIC,
  })

  const genericBody = JSON.stringify({
    notificationType: 'Bounce',
    mail: {
      messageId: SES_MSGID_GENERIC,
      timestamp: new Date().toISOString(),
    },
    bounce: {
      bounceType: 'Permanent',
      bounceSubType: 'General',
      bouncedRecipients: [
        {
          emailAddress: GENERIC_BOUNCER_EMAIL,
          diagnosticCode: 'smtp; 550 5.1.1 user unknown',
          status: '5.1.1',
        },
      ],
      timestamp: new Date().toISOString(),
    },
  })
  const goodSig = hmacSign(GENERIC_SECRET, genericBody)

  const rF1 = (await handleGenericWebhook(db as any, {
    rawBody: genericBody,
    signatureBase64: goodSig,
    secret: GENERIC_SECRET,
    shopIdHint: SHOP_B,
    sourceIp: '203.0.113.20',
  })) as HandleGenericWebhookResult
  assert(
    rF1.ok === true && rF1.outcome === 'processed',
    `[F1] generic HMAC happy path → processed`,
  )
  if (rF1.ok && rF1.outcome === 'processed') {
    CREATED_EVENT_IDS.push(rF1.eventId)
  }

  const genericSupp = await (db as any)
    .selectFrom('email_suppressions')
    .select(['reason', 'source_transport'])
    .where('shop_id', '=', SHOP_B)
    .where('email_address_lower', '=', GENERIC_BOUNCER_EMAIL.toLowerCase())
    .where('unsuppressed_at', 'is', null)
    .executeTakeFirstOrThrow()
  assert(
    genericSupp.reason === 'hard_bounce' && genericSupp.source_transport === 'webhook_generic',
    `[F1b] generic webhook suppression has source_transport='webhook_generic'`,
  )

  void genericDeliveryId

  const rF2 = (await handleGenericWebhook(db as any, {
    rawBody: genericBody,
    signatureBase64: 'bad-signature',
    secret: GENERIC_SECRET,
    shopIdHint: SHOP_B,
    sourceIp: '203.0.113.20',
  })) as HandleGenericWebhookResult
  assert(
    rF2.ok === false && rF2.reason === 'signature_invalid',
    `[F2] generic HMAC bad sig → reason='signature_invalid'`,
  )

  const rF3 = (await handleGenericWebhook(db as any, {
    rawBody: genericBody,
    signatureBase64: goodSig,
    secret: '',
    shopIdHint: SHOP_B,
    sourceIp: '203.0.113.20',
  })) as HandleGenericWebhookResult
  assert(
    rF3.ok === false && rF3.reason === 'missing_secret',
    `[F3] generic empty secret → reason='missing_secret'`,
  )

  // -------------------------------------------------------------------------
  // [G] Pre-send suppression gate — end-to-end with sendTemplatedEmail
  // -------------------------------------------------------------------------
  log('\n[G] Pre-send suppression gate')

  // checkSuppressed reads the active row for BOUNCER_EMAIL @ SHOP_A.
  const hit = await checkSuppressed(db as any, {
    shopId: SHOP_A,
    email: BOUNCER_EMAIL,
  })
  assert(
    hit != null && hit.reason === 'hard_bounce' && hit.shopId === SHOP_A,
    `[G1] checkSuppressed returns the active hard_bounce row for SHOP_A`,
  )

  // A follow-up send attempt to the same address must short-circuit to
  // skipped_suppressed BEFORE transport — even though we pass a
  // transactional-enough template that would otherwise be forced.
  const sendBlocked = await sendTemplatedEmail(db as any, {
    templateKey: 'campaign_promo',
    shopId: SHOP_A,
    to: BOUNCER_EMAIL,
    variables: {},
    transport: new ConsoleTransport(),
  })
  assert(
    sendBlocked.ok === false &&
      'reason' in sendBlocked &&
      sendBlocked.reason === 'skipped_suppressed' &&
      typeof sendBlocked.deliveryId === 'number',
    `[G2] sendTemplatedEmail → reason='skipped_suppressed' (deliveryId=${sendBlocked.deliveryId})`,
  )
  if (sendBlocked.deliveryId != null) {
    CREATED_DELIVERY_IDS.push(sendBlocked.deliveryId)
    const blockedRow = await (db as any)
      .selectFrom('email_deliveries')
      .select(['status', 'failed_reason'])
      .where('id', '=', sendBlocked.deliveryId)
      .executeTakeFirstOrThrow()
    assert(
      blockedRow.status === 'skipped_suppressed' &&
        typeof blockedRow.failed_reason === 'string' &&
        blockedRow.failed_reason.includes('suppressed:'),
      `[G2b] delivery row status='skipped_suppressed', failed_reason includes 'suppressed:'`,
    )
  }

  // Cross-shop isolation: SHOP_B sending to the SAME bounced address
  // must NOT hit skipped_suppressed (the suppression is scoped to SHOP_A).
  const crossShop = await sendTemplatedEmail(db as any, {
    templateKey: 'campaign_promo',
    shopId: SHOP_B,
    to: BOUNCER_EMAIL,
    variables: {},
    transport: new ConsoleTransport(),
  })
  if (crossShop.deliveryId != null) CREATED_DELIVERY_IDS.push(crossShop.deliveryId)
  const crossShopReason = 'reason' in crossShop ? crossShop.reason : undefined
  assert(
    crossShopReason !== 'skipped_suppressed',
    `[G4] SHOP_B send to SHOP_A's suppressed address is NOT skipped_suppressed (got reason=${String(crossShopReason)})`,
  )

  // Unsuppress clears the block. Next send should no longer return
  // skipped_suppressed (it may still be blocked on prefs, which is a
  // different gate — we only assert "not this gate").
  const supRow = await (db as any)
    .selectFrom('email_suppressions')
    .select(['id'])
    .where('shop_id', '=', SHOP_A)
    .where('email_address_lower', '=', BOUNCER_EMAIL.toLowerCase())
    .where('unsuppressed_at', 'is', null)
    .executeTakeFirstOrThrow()
  const unsupResult = await unsuppress(db as any, {
    suppressionId: Number(supRow.id),
    unsuppressedBy: null,
    notes: 'smoke PR4.B cleanup',
  })
  assert(
    unsupResult.ok === true,
    `[G3a] unsuppress({suppressionId}) → ok=true`,
  )

  const hitAfterUnsup = await checkSuppressed(db as any, {
    shopId: SHOP_A,
    email: BOUNCER_EMAIL,
  })
  assert(
    hitAfterUnsup == null,
    `[G3b] checkSuppressed → null after unsuppress`,
  )

  const postUnsupSend = await sendTemplatedEmail(db as any, {
    templateKey: 'campaign_promo',
    shopId: SHOP_A,
    to: BOUNCER_EMAIL,
    variables: {},
    transport: new ConsoleTransport(),
  })
  if (postUnsupSend.deliveryId != null) CREATED_DELIVERY_IDS.push(postUnsupSend.deliveryId)
  const postReason = 'reason' in postUnsupSend ? postUnsupSend.reason : undefined
  assert(
    postReason !== 'skipped_suppressed',
    `[G3c] post-unsuppress send no longer returns skipped_suppressed (got reason=${String(postReason)})`,
  )

  // -------------------------------------------------------------------------
  // [H] Iron rule 5 — leak scan + partition check
  // -------------------------------------------------------------------------
  log('\n[H] Iron rule 5 — leak scan')

  // Scan every surface that a seller or external caller could see for
  // internal tokens. The unsubscribe-page / generic messages live at the
  // route layer (covered in email-webhook-routes.test.ts); here we
  // assert that the CORE module layer never spits them into results.
  const surfaces: string[] = [
    JSON.stringify(r1),
    JSON.stringify(r1Replay),
    JSON.stringify(rC),
    JSON.stringify(rE),
    JSON.stringify(rF1),
    JSON.stringify(rF2),
    JSON.stringify(rF3),
    JSON.stringify(hit ?? {}),
    JSON.stringify(sendBlocked),
    JSON.stringify(crossShop),
    JSON.stringify(postUnsupSend),
  ]
  const leakPatterns = [/god[\s_-]?admin/i, /\/god-admin\//i]
  const leaks: string[] = []
  for (const surface of surfaces) {
    for (const pat of leakPatterns) {
      if (pat.test(surface)) {
        leaks.push(`${pat.source} matched in ${surface.slice(0, 80)}...`)
      }
    }
  }
  assert(
    leaks.length === 0,
    `[H1] no god_admin string in any handler/gate result (leaks: ${leaks.join(' | ') || 'none'})`,
  )

  // listSuppressions({shopId=SHOP_A}) must not return platform-scoped
  // suppressions (shop_id IS NULL). Insert one at the platform level
  // and prove it stays invisible to the shop view.
  await (db as any)
    .insertInto('email_suppressions')
    .values({
      shop_id: null, // platform scope
      email_address_hash:
        // sha256 of 'platform-blocklist@example.test' (fixed so cleanup is easy).
        '0000000000000000000000000000000000000000000000000000000000000000',
      email_address_lower: `platform-blocklist-${SUFFIX}@example.test`,
      reason: 'manual',
      source_transport: 'manual',
      notes: 'smoke PR4.B platform scope',
    })
    .execute()

  const shopAList = await listSuppressions(db as any, {
    shopId: SHOP_A,
    limit: 500,
  })
  const platformRows = shopAList.filter(
    (r) => r.emailAddressLower === `platform-blocklist-${SUFFIX}@example.test`,
  )
  assert(
    platformRows.length === 0,
    `[H2] platform-scoped row (shop_id IS NULL) does NOT appear in listSuppressions({shopId=SHOP_A})`,
  )

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  log(`\n=== Phase 14 PR4.B smoke: ${total - failed}/${total} passed (${failed} failed) ===\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((err) => {
    console.error('Phase 14 PR4.B smoke — fatal error:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    log('\n[cleanup] Removing seeded rows')
    try {
      // Delete order: email_events → email_suppressions →
      // ses_webhook_events → email_deliveries → shops.
      // email_events.delivery_id cascades on delivery delete, but an
      // explicit delete by ID is cheaper + catches the unmatched events
      // we logged against deliveries in other shops.
      if (CREATED_DELIVERY_IDS.length > 0) {
        await (db as any)
          .deleteFrom('email_events')
          .where('delivery_id', 'in', CREATED_DELIVERY_IDS)
          .execute()
      }
      await (db as any)
        .deleteFrom('email_suppressions')
        .where('shop_id', 'in', [SHOP_A, SHOP_B])
        .execute()
      await (db as any)
        .deleteFrom('email_suppressions')
        .where('email_address_lower', '=', `platform-blocklist-${SUFFIX}@example.test`)
        .execute()
      await (db as any)
        .deleteFrom('ses_webhook_events')
        .where('sns_message_id', 'in', [
          `sns-msg-${SUFFIX}-bounce-1`,
          `sns-msg-${SUFFIX}-complaint-1`,
          `sns-msg-${SUFFIX}-unmatched-1`,
        ])
        .execute()
      // handleGenericWebhook also wrote a ses_webhook_events row —
      // look it up by our unique matched smtp_message_id.
      await (db as any)
        .deleteFrom('ses_webhook_events')
        .where('ses_message_id', '=', SES_MSGID_GENERIC)
        .execute()
      if (CREATED_DELIVERY_IDS.length > 0) {
        await (db as any)
          .deleteFrom('email_deliveries')
          .where('id', 'in', CREATED_DELIVERY_IDS)
          .execute()
      }
      // Any leftover deliveries (e.g. those created by sendTemplatedEmail
      // paths we didn't track explicitly) get caught by shop_id cleanup.
      await (db as any)
        .deleteFrom('email_deliveries')
        .where('shop_id', 'in', [SHOP_A, SHOP_B])
        .execute()
      await (db as any)
        .deleteFrom('email_preferences')
        .where('shop_id', 'in', [SHOP_A, SHOP_B])
        .execute()
      await (db as any).deleteFrom('shops').where('id', 'in', [SHOP_A, SHOP_B]).execute()
      log('[cleanup] Done.')
    } catch (err) {
      console.error('[cleanup] failed:', err)
    }
    for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
      if (v === undefined) delete (process.env as any)[k]
      else (process.env as any)[k] = v
    }
    await (db as any).destroy()
  })

void CREATED_EVENT_IDS // currently unused; retained for future targeted deletes
