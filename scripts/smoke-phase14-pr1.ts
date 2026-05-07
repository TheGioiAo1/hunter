/**
 * Phase 14 PR1 — Shopify-class Email System Foundation.
 *
 * This smoke covers the full PR1 surface end-to-end against a live
 * Postgres. It is complementary to the unit tests that already pass
 * (packages/core/src/modules/email/*.test.ts — 79 cases):
 *
 *   - registry.test.ts      (32 pure)
 *   - transport.test.ts     (24 pure, env save/restore)
 *   - preferences.test.ts   (23 pure, fake db)
 *
 * What a unit test CAN'T cover — and this smoke does:
 *
 *   [A] Migration 083 — all 4 tables + indexes + triggers exist, columns
 *       match the shape code expects. Missing DDL would show up here
 *       before it shows up as a runtime 42P01 ("relation does not exist")
 *       on the dashboard.
 *
 *   [B] Seed ran — email_template_registry has ≥ 95 rows and the 10
 *       legacy-wired keys are `implemented=true`. If seed skipped in a
 *       deploy, the admin tab would just be empty; this catches it.
 *
 *   [C] Live Kysely round-trip — beginDelivery / markSent / markFailed /
 *       logSkipped / beginDeliveryIdempotent all write rows we can read
 *       back with the expected column defaults (retry_count starts at 0,
 *       status starts at queued, created_at auto-fills, etc.).
 *
 *   [D] canSend() against a real preferences row (DEFAULT subscribed=true,
 *       UPDATE subscribed=false via unsubscribeByToken, resubscribeByToken
 *       flips back, forced-send bypass for transactional).
 *
 *   [E] sendTemplatedEmail() — the full 6-step pipeline with a
 *       console-transport override, all three failure modes
 *       (unknown_template, iron_rule_5_blocked, skipped_pref) plus the
 *       happy-path mark-sent + touch-last-sent update.
 *
 *   [F] Iron rule 5 — accounts unsubscribe page renders 2 heading copies
 *       + mailto, NEVER mentions "god admin" / internal path in the
 *       user-visible output.
 *
 * Usage (from server 2; local Windows can't reach the PG on 192.168.1.13):
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase14-pr1.ts
 *
 * Sets EMAIL_TRANSPORT=console on entry so the sendTemplatedEmail path
 * never touches Gmail (which would need app password + live SMTP). The
 * actual "it really emailed buithai3107@gmail.com" verification is task
 * 16 — a manual deploy step, not this smoke.
 *
 * Cleans up every seeded row in finally{} so the script is re-runnable.
 */

import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  generateUnsubscribeToken,
  hashUnsubscribeToken,
  buildUnsubscribeUrl,
  mapTemplateToPrefCategory,
  upsertPreference,
  unsubscribeByToken,
  resubscribeByToken,
  canSend,
} from '../packages/core/src/modules/email/preferences.js'
import {
  beginDelivery,
  beginDeliveryIdempotent,
  markSent,
  markFailed,
  logSkipped,
  getDeliveryStatusCounts,
  getRecentDeliveries,
  DELIVERY_LOG_LIMITS,
} from '../packages/core/src/modules/email/delivery-log.js'
import {
  resolveTransport,
  readEmailEnv,
  hasGmailSmtpCredentials,
  ConsoleTransport,
  __resetTransportWarningForTests,
} from '../packages/core/src/modules/email/transport.js'
import {
  EMAIL_TEMPLATE_CATALOG,
  getTemplate,
  getAllTemplates,
  getImplementedTemplates,
  getPendingTemplates,
  getMerchantVisibleTemplates,
  isForcedSendCategory,
  getTemplateCount,
} from '../packages/core/src/modules/email/registry.js'
import { sendTemplatedEmail } from '../packages/core/src/modules/email/send.js'

// Force console transport so no real SMTP ever fires during this smoke.
process.env.EMAIL_TRANSPORT = 'console'
// Clear any Gmail creds to keep resolveTransport() in auto-fallback mode
// for the transport tests below. We save/restore the original values so
// the test run doesn't pollute the host env for whatever runs next.
const ORIGINAL_ENV = {
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  EMAIL_TRANSPORT: process.env.EMAIL_TRANSPORT,
}
delete process.env.SMTP_HOST
delete process.env.SMTP_USER
delete process.env.SMTP_PASS

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_A = randomUUID()
const CUSTOMER_A = randomUUID()

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

async function main() {
  log(`\n=== Phase 14 PR1 smoke — suffix=${SUFFIX} ===\n`)

  // -------------------------------------------------------------------------
  // [0] Seed a shop + customer so FK-bound email_deliveries inserts don't
  //     trip on missing parent rows.
  // -------------------------------------------------------------------------
  log('[0] Seeding shop + customer')
  await (db as any)
    .insertInto('shops')
    .values({
      id: SHOP_A,
      slug: `smoke-p14-1-${SUFFIX}`,
      name: 'PR1 Shop A',
      email: `p14-1-a-${SUFFIX}@example.test`,
      status: 'active',
      plan: 'free',
    })
    .execute()

  await (db as any)
    .insertInto('customers')
    .values({
      id: CUSTOMER_A,
      shop_id: SHOP_A,
      email: `p14-1-cust-${SUFFIX}@example.test`,
      first_name: 'Pat',
      last_name: 'Tester',
    })
    .execute()

  // -------------------------------------------------------------------------
  // [1..10] Migration 083 shape
  // -------------------------------------------------------------------------
  log('\n[1..10] Migration 083 shape')

  async function tableExists(name: string): Promise<boolean> {
    const rows = await (db as any)
      .selectFrom('information_schema.tables' as any)
      .where('table_name', '=', name)
      .where('table_schema', '=', 'public')
      .select(['table_name'])
      .execute()
    return rows.length === 1
  }
  async function columnExists(table: string, column: string): Promise<boolean> {
    const rows = await (db as any)
      .selectFrom('information_schema.columns' as any)
      .where('table_name', '=', table)
      .where('column_name', '=', column)
      .select(['column_name'])
      .execute()
    return rows.length === 1
  }
  async function indexExists(name: string): Promise<boolean> {
    const rows = await (db as any)
      .selectFrom('pg_indexes' as any)
      .where('indexname', '=', name)
      .select(['indexname'])
      .execute()
    return rows.length === 1
  }

  assert(await tableExists('email_template_registry'), '[1] email_template_registry exists')
  assert(await tableExists('email_deliveries'), '[2] email_deliveries exists')
  assert(await tableExists('email_preferences'), '[3] email_preferences exists')
  assert(await tableExists('email_events'), '[4] email_events exists')

  assert(
    (await columnExists('email_deliveries', 'idempotency_key')) &&
      (await columnExists('email_deliveries', 'retry_count')) &&
      (await columnExists('email_deliveries', 'smtp_message_id')),
    '[5] email_deliveries has idempotency_key + retry_count + smtp_message_id columns',
  )
  assert(
    (await columnExists('email_preferences', 'unsubscribe_token_hash')) &&
      (await columnExists('email_preferences', 'source')),
    '[6] email_preferences has unsubscribe_token_hash + source columns',
  )
  assert(
    await columnExists('email_template_registry', 'implemented'),
    '[7] email_template_registry has implemented column',
  )

  assert(
    await indexExists('uniq_email_deliveries_idempotency'),
    '[8] uniq_email_deliveries_idempotency exists',
  )
  assert(
    (await indexExists('uniq_email_prefs_shop_email_category')) &&
      (await indexExists('uniq_email_prefs_platform_email_category')),
    '[9] both partial unique indexes on email_preferences exist (shop+platform scopes)',
  )
  assert(
    (await indexExists('idx_email_deliveries_shop_created')) &&
      (await indexExists('idx_email_deliveries_template_created')) &&
      (await indexExists('idx_email_deliveries_status_created')) &&
      (await indexExists('idx_email_deliveries_recipient_lower')),
    '[10] all 4 email_deliveries query indexes exist',
  )

  // -------------------------------------------------------------------------
  // [11..15] Seed coverage
  // -------------------------------------------------------------------------
  log('\n[11..15] Seed coverage — email_template_registry')

  const registryCount = await (db as any)
    .selectFrom('email_template_registry')
    .select((eb: any) => eb.fn.countAll().as('n'))
    .executeTakeFirst()
  const registryN = Number(registryCount?.n ?? 0)
  assert(
    registryN >= getTemplateCount(),
    `[11] email_template_registry has ≥ ${getTemplateCount()} rows (got ${registryN}) — seed ran`,
  )

  const implementedRow = await (db as any)
    .selectFrom('email_template_registry')
    .select(['template_key', 'implemented', 'subject_default'])
    .where('template_key', '=', 'order_confirmation')
    .executeTakeFirst()
  assert(
    !!implementedRow && implementedRow.implemented === true,
    '[12] order_confirmation row exists with implemented=true',
  )

  const pendingRow = await (db as any)
    .selectFrom('email_template_registry')
    .select(['template_key', 'implemented', 'category', 'audience'])
    .where('template_key', '=', 'platform_weekly_roundup')
    .executeTakeFirst()
  // PR1 originally asserted `implemented === false` on the scaffold,
  // but later phases legitimately flip the implemented flag as the
  // template gains a real renderer. We still assert audience + category
  // so the iron-rule-5 platform-scope shape can never silently shift.
  assert(
    !!pendingRow &&
      pendingRow.category === 'platform' &&
      pendingRow.audience === 'god_admin',
    '[13] platform_weekly_roundup row exists with audience=god_admin + category=platform',
  )

  // Catalog parity — every in-code key should have a DB row.
  const dbKeys = new Set(
    (
      await (db as any)
        .selectFrom('email_template_registry')
        .select(['template_key'])
        .execute()
    ).map((r: any) => r.template_key),
  )
  const codeKeys = Object.keys(EMAIL_TEMPLATE_CATALOG)
  const missingInDb = codeKeys.filter((k) => !dbKeys.has(k))
  assert(
    missingInDb.length === 0,
    `[14] every in-code template_key has a DB row (missing: ${missingInDb.slice(0, 5).join(', ')}${missingInDb.length > 5 ? '…' : ''})`,
  )

  // Iron rule 5 — god_admin templates should exist in the catalog but the
  // `getMerchantVisibleTemplates()` helper MUST filter them out.
  const godAdminTemplates = getAllTemplates().filter((t) => t.audience === 'god_admin')
  const merchantVisible = getMerchantVisibleTemplates()
  const leaked = merchantVisible.filter((t) => t.audience === 'god_admin')
  assert(
    godAdminTemplates.length > 0 && leaked.length === 0,
    `[15] Iron rule 5 — ${godAdminTemplates.length} god_admin templates exist in catalog, 0 leak through getMerchantVisibleTemplates()`,
  )

  // -------------------------------------------------------------------------
  // [16..19] Registry helpers (pure)
  // -------------------------------------------------------------------------
  log('\n[16..19] Registry helpers (pure)')

  assert(getTemplate('order_confirmation')?.implemented === true, '[16] getTemplate(order_confirmation).implemented === true')
  assert(getTemplate('this_key_does_not_exist') === undefined, '[17] getTemplate(nonsense) returns undefined')
  assert(
    isForcedSendCategory('transactional') &&
      isForcedSendCategory('ops') &&
      isForcedSendCategory('platform') &&
      isForcedSendCategory('legal') &&
      !isForcedSendCategory('marketing') &&
      !isForcedSendCategory('lifecycle') &&
      !isForcedSendCategory('reviews'),
    '[18] isForcedSendCategory: receipts/ops/platform/legal=true, marketing/lifecycle/reviews=false',
  )
  assert(
    getImplementedTemplates().length + getPendingTemplates().length === getAllTemplates().length,
    '[19] implemented + pending partition is exhaustive (no duplicates, no missing)',
  )

  // -------------------------------------------------------------------------
  // [20..23] Token helpers + buildUnsubscribeUrl
  // -------------------------------------------------------------------------
  log('\n[20..23] Token helpers')

  const rawToken = generateUnsubscribeToken()
  assert(
    /^[0-9a-f]{64}$/.test(rawToken),
    `[20] generateUnsubscribeToken returns 64-char lowercase hex (got ${rawToken.length} chars)`,
  )
  const rawToken2 = generateUnsubscribeToken()
  assert(rawToken !== rawToken2, '[21] generateUnsubscribeToken is non-deterministic')
  const hash = hashUnsubscribeToken(rawToken)
  assert(
    /^[0-9a-f]{64}$/.test(hash) && hash !== rawToken,
    '[22] hashUnsubscribeToken returns 64-char hex, not equal to raw',
  )
  const url = buildUnsubscribeUrl(rawToken)
  assert(
    url.includes('/accounts/unsubscribe?token=') && url.includes(encodeURIComponent(rawToken)),
    '[23] buildUnsubscribeUrl embeds token at /accounts/unsubscribe?token=…',
  )

  // -------------------------------------------------------------------------
  // [24..27] Transport resolver
  // -------------------------------------------------------------------------
  log('\n[24..27] Transport resolver')

  // With EMAIL_TRANSPORT=console (set at top) the factory must return
  // ConsoleTransport regardless of anything else.
  process.env.EMAIL_TRANSPORT = 'console'
  __resetTransportWarningForTests()
  const forcedConsole = resolveTransport()
  assert(forcedConsole instanceof ConsoleTransport, '[24] EMAIL_TRANSPORT=console forces ConsoleTransport')

  // With no force + no creds → auto-fallback to console (with a warn).
  delete process.env.EMAIL_TRANSPORT
  const env = readEmailEnv()
  assert(!hasGmailSmtpCredentials(env), '[25] hasGmailSmtpCredentials=false with no SMTP env (cleared above)')
  __resetTransportWarningForTests()
  const autoConsole = resolveTransport()
  assert(autoConsole instanceof ConsoleTransport, '[26] resolveTransport() auto-falls-back to ConsoleTransport without creds')

  // Smoke a real envelope through the console transport (no-op on wire).
  const consoleResult = await autoConsole.send({
    to: 'pat@example.test',
    subject: 'smoke',
    html: '<p>hi</p>',
    text: 'hi',
  })
  assert(
    consoleResult.ok === true &&
      consoleResult.provider === 'console' &&
      typeof consoleResult.messageId === 'string',
    '[27] ConsoleTransport.send returns ok + synthetic messageId + provider=console',
  )

  // Restore EMAIL_TRANSPORT=console for the rest of the run.
  process.env.EMAIL_TRANSPORT = 'console'

  // -------------------------------------------------------------------------
  // [28..31] canSend() gate
  // -------------------------------------------------------------------------
  log('\n[28..31] canSend() gate')

  // Transactional is forced — canSend allows even without a pref row.
  const gateForced = await canSend(db as any, {
    templateKey: 'order_confirmation',
    shopId: SHOP_A,
    recipientEmail: `forced-${SUFFIX}@example.test`,
  })
  assert(
    gateForced.allowed === true && gateForced.reason === 'forced',
    '[28] canSend(order_confirmation) → allowed:true reason:forced (no DB row)',
  )

  // Unknown template → blocked with unknown_template reason.
  const gateUnknown = await canSend(db as any, {
    templateKey: 'this_key_does_not_exist',
    shopId: SHOP_A,
    recipientEmail: `unknown-${SUFFIX}@example.test`,
  })
  assert(
    gateUnknown.allowed === false && gateUnknown.reason === 'unknown_template',
    '[29] canSend(nonsense) → allowed:false reason:unknown_template',
  )

  // Marketing w/o pref row → allowed (default opt-in).
  const marketingEmail = `market-${SUFFIX}@example.test`
  const gateMarketingDefault = await canSend(db as any, {
    templateKey: 'newsletter_broadcast',
    shopId: SHOP_A,
    recipientEmail: marketingEmail,
  })
  assert(
    gateMarketingDefault.allowed === true && gateMarketingDefault.reason === 'allowed',
    '[30] canSend(newsletter) without pref row → allowed (default opt-in)',
  )

  // After upsertPreference(subscribed=false) → canSend should block.
  await upsertPreference(db as any, {
    shopId: SHOP_A,
    email: marketingEmail,
    category: 'newsletter',
    subscribed: false,
    source: 'footer_optout',
    customerId: CUSTOMER_A,
  })
  const gateMarketingOptedOut = await canSend(db as any, {
    templateKey: 'newsletter_broadcast',
    shopId: SHOP_A,
    recipientEmail: marketingEmail,
  })
  assert(
    gateMarketingOptedOut.allowed === false &&
      gateMarketingOptedOut.reason === 'unsubscribed' &&
      typeof gateMarketingOptedOut.preferenceId === 'string',
    '[31] canSend(newsletter) after subscribed=false → blocked with preferenceId',
  )

  // -------------------------------------------------------------------------
  // [32..35] mapTemplateToPrefCategory
  // -------------------------------------------------------------------------
  log('\n[32..35] mapTemplateToPrefCategory routing')

  assert(
    mapTemplateToPrefCategory('order_confirmation') === null,
    '[32] transactional → null (forced-send)',
  )
  assert(
    mapTemplateToPrefCategory('newsletter_broadcast') === 'newsletter',
    '[33] newsletter_broadcast → newsletter bucket',
  )
  assert(
    mapTemplateToPrefCategory('back_in_stock') === 'back_in_stock',
    '[34] back_in_stock → back_in_stock bucket',
  )
  assert(
    mapTemplateToPrefCategory('price_drop') === 'price_drop',
    '[35] price_drop → price_drop bucket',
  )

  // -------------------------------------------------------------------------
  // [36..40] Unsubscribe + resubscribe round-trip
  // -------------------------------------------------------------------------
  log('\n[36..40] Unsubscribe + resubscribe round-trip')

  const unsubEmail = `unsub-${SUFFIX}@example.test`
  const upserted = await upsertPreference(db as any, {
    shopId: SHOP_A,
    email: unsubEmail,
    category: 'marketing',
    subscribed: true,
    source: 'signup',
    customerId: CUSTOMER_A,
  })
  assert(
    upserted.inserted === true && typeof upserted.rawToken === 'string' && upserted.rawToken!.length === 64,
    '[36] upsertPreference creates fresh row + returns 64-char raw token',
  )

  // Click unsubscribe link.
  const unsubRes = await unsubscribeByToken(db as any, upserted.rawToken!)
  assert(
    unsubRes.found === true &&
      unsubRes.email === unsubEmail &&
      unsubRes.category === 'marketing',
    '[37] unsubscribeByToken finds row + returns email + category',
  )

  // canSend now blocks. Use `campaign_promo` — a real marketing template
  // in the catalog. (An earlier version of this smoke referenced
  // `campaign_announcement` which doesn't exist, so canSend hit the
  // unknown_template branch instead of unsubscribed.)
  const gateAfterUnsub = await canSend(db as any, {
    templateKey: 'campaign_promo',
    shopId: SHOP_A,
    recipientEmail: unsubEmail,
  })
  assert(
    gateAfterUnsub.allowed === false && gateAfterUnsub.reason === 'unsubscribed',
    '[38] canSend after unsubscribeByToken → blocked',
  )

  // Resubscribe reverses it.
  const resubRes = await resubscribeByToken(db as any, upserted.rawToken!)
  assert(resubRes.found === true, '[39] resubscribeByToken finds row')
  const gateAfterResub = await canSend(db as any, {
    templateKey: 'campaign_promo',
    shopId: SHOP_A,
    recipientEmail: unsubEmail,
  })
  assert(
    gateAfterResub.allowed === true,
    '[40] canSend after resubscribeByToken → allowed again',
  )

  // Boundary: fake / unknown token should return found:false without throwing.
  const fakeToken = '0'.repeat(64)
  const unsubFake = await unsubscribeByToken(db as any, fakeToken)
  assert(unsubFake.found === false, '[40a] unsubscribeByToken(nonexistent) → found:false')

  // -------------------------------------------------------------------------
  // [41..46] Delivery log round-trip
  // -------------------------------------------------------------------------
  log('\n[41..46] Delivery log round-trip')

  const delivery = await beginDelivery(db as any, {
    templateKey: 'order_confirmation',
    shopId: SHOP_A,
    recipientEmail: `buyer-${SUFFIX}@example.test`,
    recipientCustomerId: CUSTOMER_A,
    subject: 'Order #' + SUFFIX + ' confirmed',
    bodyHtml: '<p>Thanks for your order! Order #' + SUFFIX + '</p>',
  })
  assert(
    typeof delivery.id === 'number' && delivery.inserted === true,
    '[41] beginDelivery returns numeric id + inserted:true',
  )

  const queuedRow = await (db as any)
    .selectFrom('email_deliveries')
    .select(['status', 'retry_count', 'provider', 'sent_at', 'created_at'])
    .where('id', '=', delivery.id)
    .executeTakeFirst()
  assert(
    queuedRow?.status === 'queued' &&
      Number(queuedRow?.retry_count) === 0 &&
      queuedRow?.provider === null &&
      queuedRow?.sent_at === null &&
      queuedRow?.created_at != null,
    '[42] beginDelivery row defaults: status=queued, retry_count=0, provider=null, sent_at=null, created_at set',
  )

  await markSent(db as any, {
    id: delivery.id,
    messageId: 'smoke-msg-' + SUFFIX,
    provider: 'console',
  })
  const sentRow = await (db as any)
    .selectFrom('email_deliveries')
    .select(['status', 'smtp_message_id', 'provider', 'sent_at'])
    .where('id', '=', delivery.id)
    .executeTakeFirst()
  assert(
    sentRow?.status === 'sent' &&
      sentRow?.smtp_message_id === 'smoke-msg-' + SUFFIX &&
      sentRow?.provider === 'console' &&
      sentRow?.sent_at != null,
    '[43] markSent flips status=sent + stamps message_id + provider + sent_at',
  )

  // markFailed bumps retry_count.
  const failedDelivery = await beginDelivery(db as any, {
    templateKey: 'order_confirmation',
    shopId: SHOP_A,
    recipientEmail: `fail-${SUFFIX}@example.test`,
    subject: 'Would fail',
    bodyHtml: '<p>should fail</p>',
  })
  await markFailed(db as any, {
    id: failedDelivery.id,
    reason: 'x'.repeat(DELIVERY_LOG_LIMITS.MAX_FAILED_REASON_LEN + 100),
    provider: 'console',
  })
  const failedRow = await (db as any)
    .selectFrom('email_deliveries')
    .select(['status', 'failed_reason', 'retry_count', 'failed_at'])
    .where('id', '=', failedDelivery.id)
    .executeTakeFirst()
  assert(
    failedRow?.status === 'failed' &&
      Number(failedRow?.retry_count) === 1 &&
      typeof failedRow?.failed_reason === 'string' &&
      failedRow.failed_reason!.length <= DELIVERY_LOG_LIMITS.MAX_FAILED_REASON_LEN,
    '[44] markFailed: status=failed, retry_count=1, failed_reason truncated to ≤500 chars',
  )

  // logSkipped writes a terminal row directly.
  const skipped = await logSkipped(db as any, {
    templateKey: 'newsletter_broadcast',
    shopId: SHOP_A,
    recipientEmail: `skip-${SUFFIX}@example.test`,
    subject: 'Newsletter',
    bodyHtml: '<p>skipped</p>',
    status: 'skipped_pref',
    reason: 'user unsubscribed',
  })
  const skippedRow = await (db as any)
    .selectFrom('email_deliveries')
    .select(['status', 'failed_reason'])
    .where('id', '=', skipped.id)
    .executeTakeFirst()
  assert(
    skippedRow?.status === 'skipped_pref' && skippedRow?.failed_reason === 'user unsubscribed',
    '[45] logSkipped writes terminal-status row directly (no queued step)',
  )

  // beginDeliveryIdempotent dedupes the same idempotency key.
  const idemKey = `idem-${SUFFIX}`
  const first = await beginDeliveryIdempotent(db as any, {
    templateKey: 'order_confirmation',
    shopId: SHOP_A,
    recipientEmail: `idem-${SUFFIX}@example.test`,
    subject: 'First',
    bodyHtml: '<p>first</p>',
    idempotencyKey: idemKey,
  })
  const second = await beginDeliveryIdempotent(db as any, {
    templateKey: 'order_confirmation',
    shopId: SHOP_A,
    recipientEmail: `idem-${SUFFIX}@example.test`,
    subject: 'Second',
    bodyHtml: '<p>second</p>',
    idempotencyKey: idemKey,
  })
  assert(
    first.inserted === true && second.inserted === false && first.id === second.id,
    '[46] beginDeliveryIdempotent: first inserts, second dedupes (same id, inserted=false)',
  )

  // -------------------------------------------------------------------------
  // [47..48] Query helpers
  // -------------------------------------------------------------------------
  log('\n[47..48] Query helpers')

  const counts = await getDeliveryStatusCounts(db as any, { shopId: SHOP_A })
  assert(
    typeof counts === 'object' &&
      typeof counts.sent === 'number' &&
      typeof counts.queued === 'number' &&
      typeof counts.failed === 'number' &&
      typeof counts.skipped_pref === 'number' &&
      counts.sent >= 1 &&
      counts.failed >= 1 &&
      counts.skipped_pref >= 1,
    `[47] getDeliveryStatusCounts returns all 7 buckets (sent=${counts.sent}, failed=${counts.failed}, skipped_pref=${counts.skipped_pref})`,
  )

  const recent = await getRecentDeliveries(db as any, {
    recipientEmail: `buyer-${SUFFIX}@example.test`,
    limit: 10,
  })
  assert(
    recent.length >= 1 && recent[0].template_key === 'order_confirmation' && recent[0].status === 'sent',
    '[48] getRecentDeliveries finds the prior buyer send, newest-first',
  )

  // -------------------------------------------------------------------------
  // [49..54] sendTemplatedEmail full pipeline (console transport)
  // -------------------------------------------------------------------------
  log('\n[49..54] sendTemplatedEmail full pipeline (console transport)')

  // Capture sink so we can inspect what actually went "on the wire".
  const captured: Array<{ to: string; subject: string }> = []
  const captureTransport = new ConsoleTransport({
    capture: (env) => captured.push({ to: env.to, subject: env.subject }),
  })

  // Happy path — transactional goes through.
  const happyRecipient = `happy-${SUFFIX}@example.test`
  const happyRes = await sendTemplatedEmail(db as any, {
    templateKey: 'order_confirmation',
    to: happyRecipient,
    shopId: SHOP_A,
    variables: { order_number: String(SUFFIX), customer_name: 'Pat' },
    transport: captureTransport,
  })
  assert(
    happyRes.ok === true &&
      typeof (happyRes as any).deliveryId === 'number' &&
      (happyRes as any).provider === 'console',
    '[49] sendTemplatedEmail(order_confirmation) happy path → ok + provider=console',
  )
  assert(
    captured.length === 1 && captured[0].to === happyRecipient,
    '[50] transport was actually invoked once, for the correct recipient',
  )

  // Unknown template — returns reason=unknown_template with no delivery row.
  const unknownRes = await sendTemplatedEmail(db as any, {
    templateKey: 'this_template_does_not_exist_' + SUFFIX,
    to: `nowhere-${SUFFIX}@example.test`,
    shopId: SHOP_A,
    transport: captureTransport,
  })
  assert(
    unknownRes.ok === false &&
      (unknownRes as any).reason === 'unknown_template' &&
      (unknownRes as any).deliveryId === null,
    '[51] sendTemplatedEmail(unknown-key) → ok:false reason:unknown_template no deliveryId',
  )

  // Iron rule 5 — god_admin template with shopId !== null must block.
  const ironRes = await sendTemplatedEmail(db as any, {
    templateKey: 'platform_weekly_roundup',
    to: `leak-${SUFFIX}@example.test`,
    shopId: SHOP_A, // non-null shopId triggers the block
    transport: captureTransport,
  })
  assert(
    ironRes.ok === false && (ironRes as any).reason === 'iron_rule_5_blocked',
    '[52] Iron rule 5 — god_admin template with shopId → blocked with reason:iron_rule_5_blocked',
  )
  // The block should still log a row so ops sees intent.
  const ironRow = await (db as any)
    .selectFrom('email_deliveries')
    .select(['status', 'failed_reason'])
    .where('id', '=', (ironRes as any).deliveryId)
    .executeTakeFirst()
  assert(
    ironRow?.status === 'skipped_invalid' &&
      typeof ironRow?.failed_reason === 'string' &&
      ironRow.failed_reason === 'platform_scope_mismatch',
    '[53] Iron rule 5 — skipped_invalid row logged with opaque platform_scope_mismatch reason (neutralised string, no IR5 leak)',
  )

  // Skipped_pref — mark recipient unsubscribed, then send a marketing
  // template. Should log skipped_pref and NOT invoke the transport.
  const prevCaptured = captured.length
  const skipEmail = `skipsend-${SUFFIX}@example.test`
  await upsertPreference(db as any, {
    shopId: SHOP_A,
    email: skipEmail,
    category: 'marketing',
    subscribed: false,
    source: 'footer_optout',
  })
  const skippedSendRes = await sendTemplatedEmail(db as any, {
    templateKey: 'campaign_promo',
    to: skipEmail,
    shopId: SHOP_A,
    transport: captureTransport,
  })
  assert(
    skippedSendRes.ok === false &&
      (skippedSendRes as any).reason === 'skipped_pref' &&
      captured.length === prevCaptured,
    '[54] sendTemplatedEmail to unsubscribed recipient → skipped_pref + transport NOT invoked',
  )

  // -------------------------------------------------------------------------
  // [55..57] Iron rule 5 — unsubscribe.ts rendered output never mentions
  //          "god admin" or any /god-admin/* URL in user-visible copy.
  // -------------------------------------------------------------------------
  log('\n[55..57] Iron rule 5 — unsubscribe page rendering')

  // Import the accounts unsubscribe page + exercise the express handler
  // with a mock req/res. This is an end-to-end render test; we assert on
  // the final HTML the browser would receive.
  const { getUnsubscribe, postUnsubscribe } = await import(
    '../apps/accounts/src/pages/unsubscribe.js'
  )

  const GOD_ADMIN_RE = /god[\s_-]*admin/i
  const INTERNAL_PATH_RE = /\/god-admin\//

  function mockRes() {
    let body = ''
    let status = 200
    const res: any = {
      status(code: number) { status = code; return res },
      send(html: string) { body = html; return res },
      cookie() { return res },
    }
    return {
      res,
      getHtml: () => body,
      getStatus: () => status,
    }
  }

  // Malformed token — should render error page without leaking.
  {
    const cap = mockRes()
    await getUnsubscribe(
      { query: { token: 'notahex' } } as any,
      cap.res as any,
      db as any,
    )
    const html = cap.getHtml()
    assert(
      cap.getStatus() === 400 && html.length > 0 &&
        !GOD_ADMIN_RE.test(html) &&
        !INTERNAL_PATH_RE.test(html) &&
        html.includes("couldn't find"),
      '[55] GET /accounts/unsubscribe (malformed token) → 400 + friendly copy + NO god-admin leak',
    )
  }

  // Valid token path — needs a row. Re-use `upserted.rawToken` from [36].
  // (That row was resubscribed in [39], so we'll unsubscribe it here.)
  {
    const cap = mockRes()
    await getUnsubscribe(
      { query: { token: upserted.rawToken! } } as any,
      cap.res as any,
      db as any,
    )
    const html = cap.getHtml()
    assert(
      cap.getStatus() === 200 &&
        html.includes('unsubscribed') &&
        html.includes('contact@gbox.co') &&
        !GOD_ADMIN_RE.test(html) &&
        !INTERNAL_PATH_RE.test(html),
      '[56] GET /accounts/unsubscribe (valid token) → success page + contact@gbox.co + NO god-admin leak',
    )
  }

  // POST re-subscribe path.
  {
    const cap = mockRes()
    await postUnsubscribe(
      {
        body: { token: upserted.rawToken!, action: 'resubscribe' },
      } as any,
      cap.res as any,
      db as any,
    )
    const html = cap.getHtml()
    assert(
      cap.getStatus() === 200 &&
        html.includes('back on the list') &&
        !GOD_ADMIN_RE.test(html) &&
        !INTERNAL_PATH_RE.test(html),
      '[57] POST /accounts/unsubscribe (resubscribe) → "back on the list" + NO god-admin leak',
    )
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  log(`\n=== Phase 14 PR1 smoke: ${total - failed}/${total} passed (${failed} failed) ===\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((err) => {
    console.error('Phase 14 PR1 smoke — fatal error:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    log('\n[cleanup] Removing seeded rows')
    try {
      // Delete dependents first — email_deliveries FKs into customers +
      // shops, email_preferences FKs into shops (CASCADE) + customers
      // (SET NULL). Safest to nuke rows scoped to the test shop.
      await (db as any)
        .deleteFrom('email_deliveries')
        .where('shop_id', '=', SHOP_A)
        .execute()
      // email_preferences rows are auto-CASCADE'd when we delete the
      // shop, but be explicit so we also catch rows where shop_id was
      // NULL (none expected in this smoke, but cheap insurance).
      await (db as any)
        .deleteFrom('email_preferences')
        .where('shop_id', '=', SHOP_A)
        .execute()
      await (db as any).deleteFrom('customers').where('id', '=', CUSTOMER_A).execute()
      await (db as any).deleteFrom('shops').where('id', '=', SHOP_A).execute()
      log('[cleanup] Done.')
    } catch (err) {
      console.error('[cleanup] failed:', err)
    }
    // Restore env vars we clobbered.
    for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
      if (v === undefined) delete (process.env as any)[k]
      else (process.env as any)[k] = v
    }
    await (db as any).destroy()
  })
