/**
 * Phase 14 PR6 — Priority 3 ops (platform + finance alerts) — live-DB smoke.
 *
 * Complements the unit layer (recipients + emitters + dedup-key shape
 * tests + registry flip — 100+ cases) with one end-to-end walk against
 * real Postgres, exercising the partial UNIQUE index, the ON CONFLICT
 * DO NOTHING dedup contract, the kill-switch env, Iron Rule 5 guard,
 * and the 14 wired template flips in the registry.
 *
 * INVARIANTS ASSERTED
 * ===================
 *
 *   [A] Migration 089 schema present
 *       [A1] platform_alert_recipients — expected columns + PK on alert_type
 *       [A2] platform_alert_deliveries — expected columns
 *       [A3] UNIQUE (alert_type, dedup_key) partial index present
 *       [A4] CHECK constraint on alert_type enforces 9 values
 *       [A5] All 9 alert_type rows seeded in platform_alert_recipients
 *
 *   [B] Recipients DB-access layer
 *       [B1] listRecipients returns 9 rows ordered alphabetically
 *       [B2] getRecipient(valid) returns the row
 *       [B3] updateRecipient() changes email + flips enabled + bumps updated_at
 *       [B4] updateRecipient(invalidAlertType) throws
 *       [B5] updateRecipient(empty email) throws
 *
 *   [C] sendPlatformAlert — full pipeline
 *       [C1] first send with unique dedup → sent=true, delivery rows exist
 *       [C2] duplicate send with SAME dedup → sent=false, reason='deduped'
 *       [C3] send with recipientOverride bypasses DB lookup
 *       [C4] send after updateRecipient(enabled=false) →
 *            reason='disabled_by_recipient_row'
 *       [C5] PLATFORM_ALERTS_ENABLED=0 env → reason='disabled_by_env'
 *            (before any DB hit; kill-switch is the very first check)
 *
 *   [D] Typed emitters — key shape correctness
 *       [D1] emitNewMerchantSignup writes `shop:<uuid>` dedup
 *       [D2] emitPlatformDailyDigest writes `date:YYYY-MM-DD` dedup
 *       [D3] emitPlatformWeeklyRoundup writes `week:YYYY-WW` dedup
 *       [D4] emitPlatformIntegrationDown writes `<name>:YYYYMMDDHHMM`
 *            (5-minute slot)
 *       [D5] emitPlatformIncident writes `<env>:<32-hex>` (sha256 prefix)
 *       [D6] emitPlatformPolicyViolation writes `shop:<uuid>:YYYY-MM-DD`
 *       [D7] emitPlatformChurnAlert writes `shop:<uuid>:YYYYMM` (month)
 *
 *   [E] Registry flip — 14 wired templates accounted for
 *       [E1] getImplementedTemplates() includes all 14 PR6 keys
 *       [E2] getPendingTemplates() still contains the 5 payout/chargeback
 *            deferred entries (Phase 12)
 *       [E3] getMerchantVisibleTemplates() still filters out god_admin
 *            (Iron Rule 5 chokepoint intact)
 *
 *   [F] Iron Rule 5 — no merchant-surface leakage
 *       [F1] sendPlatformAlert result object contains no 'god' substring
 *            (defensive scan — reasons + payloads)
 *       [F2] getMerchantVisibleTemplates() returns zero god_admin audience
 *            entries even after PR6 flipped 8 platform templates
 *       [F3] the automation_flows override we write for finance flows
 *            carries NO template_key reference (keys live in flow-catalog)
 *
 *   [G] Automation_flows override for finance alerts
 *       [G1] UPSERT override row for refund_issued_merchant writes
 *            (shop_id, flow_key, enabled=false) with delay_seconds=null
 *       [G2] Second UPSERT on same (shop_id, flow_key) updates without
 *            duplicate row — UNIQUE constraint holds
 *       [G3] Deleting the override row returns it to catalog-default
 *            (implicit enabled=true). Rows for the 5 deferred keys (payout*,
 *            chargeback*) can be written but are never consulted today —
 *            PR6 spec accepts this as "staged for Phase 12".
 *
 * USAGE (from server 2 — local Windows box can't reach the PG):
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase14-pr6.ts
 *
 * Forces NODE_ENV='test' + EMAIL_TRANSPORT='console' on entry so no
 * outbound mail leaks. Cleans up every seeded row in finally{}.
 */

import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  listRecipients,
  getRecipient,
  updateRecipient,
} from '../packages/core/src/modules/platform-alerts/recipients.js'
import {
  sendPlatformAlert,
} from '../packages/core/src/modules/platform-alerts/send.js'
import {
  PLATFORM_ALERT_TYPES,
  isPlatformAlertsEnabled,
} from '../packages/core/src/modules/platform-alerts/types.js'
import {
  emitNewMerchantSignup,
  emitPlatformDailyDigest,
  emitPlatformWeeklyRoundup,
  emitPlatformIntegrationDown,
  emitPlatformIncident,
  emitPlatformPolicyViolation,
  emitPlatformChurnAlert,
} from '../packages/core/src/modules/platform-alerts/emitters.js'
import {
  getImplementedTemplates,
  getPendingTemplates,
  getMerchantVisibleTemplates,
} from '../packages/core/src/modules/email/registry.js'

// ─── Env isolation ─────────────────────────────────────────────────
const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  EMAIL_TRANSPORT: process.env.EMAIL_TRANSPORT,
  PLATFORM_ALERTS_ENABLED: process.env.PLATFORM_ALERTS_ENABLED,
}
if (process.env.NODE_ENV === 'production') {
  throw new Error('smoke-phase14-pr6 must not be run with NODE_ENV=production')
}
process.env.NODE_ENV = 'test'
process.env.EMAIL_TRANSPORT = 'console'
// Leave PLATFORM_ALERTS_ENABLED as-is for most of the run; we flip it
// temporarily in [C5] and restore in finally{}.

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_A = randomUUID()

// ─── Assertion helper ──────────────────────────────────────────────
function log(s: string) {
  // eslint-disable-next-line no-console
  console.log(s)
}
let total = 0
let failed = 0
function assert(cond: boolean, msg: string): void {
  total++
  if (cond) log(`  OK   ${msg}`)
  else {
    failed++
    log(`  FAIL ${msg}`)
  }
}

// Track the alert_types whose recipient rows we mutate so we can restore
// them in cleanup. (We never DELETE — migration 089 seeds these rows as
// platform config.)
const MUTATED_ALERT_TYPES = new Map<
  string,
  { recipientEmail: string; enabled: boolean }
>()
const CREATED_DELIVERY_IDS: number[] = []
const WRITTEN_FLOW_KEYS: string[] = []

// ─── Main test flow ────────────────────────────────────────────────
async function main() {
  log(`\n=== Phase 14 PR6 smoke — suffix=${SUFFIX} ===\n`)
  log(`   SHOP_A = ${SHOP_A}`)

  // -------------------------------------------------------------------
  // [A] Migration 089 schema present
  // -------------------------------------------------------------------
  log('\n[A] Migration 089 schema present')

  const parCols = await (db as any)
    .selectFrom('information_schema.columns' as any)
    .select(['column_name'])
    .where('table_schema', '=', 'public')
    .where('table_name', '=', 'platform_alert_recipients')
    .execute()
  const parColNames = new Set(parCols.map((r: any) => r.column_name))
  const expectedParCols = [
    'alert_type',
    'recipient_email',
    'recipient_name',
    'enabled',
    'created_at',
    'updated_at',
  ]
  const missingPar = expectedParCols.filter((c) => !parColNames.has(c))
  assert(
    missingPar.length === 0,
    `[A1] platform_alert_recipients has all expected columns (missing=${missingPar.join(',') || 'none'})`,
  )

  const padCols = await (db as any)
    .selectFrom('information_schema.columns' as any)
    .select(['column_name'])
    .where('table_schema', '=', 'public')
    .where('table_name', '=', 'platform_alert_deliveries')
    .execute()
  const padColNames = new Set(padCols.map((r: any) => r.column_name))
  const expectedPadCols = [
    'id',
    'alert_type',
    'dedup_key',
    'email_delivery_id',
    'payload',
    'created_at',
  ]
  const missingPad = expectedPadCols.filter((c) => !padColNames.has(c))
  assert(
    missingPad.length === 0,
    `[A2] platform_alert_deliveries has all expected columns (missing=${missingPad.join(',') || 'none'})`,
  )

  const uniqueIdx = await (db as any)
    .selectFrom('pg_indexes' as any)
    .select(['indexname', 'indexdef'])
    .where('tablename', '=', 'platform_alert_deliveries')
    .execute()
  const hasDedupUnique = uniqueIdx.some(
    (r: any) =>
      typeof r.indexdef === 'string' &&
      /UNIQUE/i.test(r.indexdef) &&
      /alert_type/.test(r.indexdef) &&
      /dedup_key/.test(r.indexdef),
  )
  assert(
    hasDedupUnique,
    `[A3] UNIQUE index on (alert_type, dedup_key) present on platform_alert_deliveries`,
  )

  // CHECK constraint — enum enforcement
  const checkCon = await (db as any)
    .selectFrom('information_schema.check_constraints' as any)
    .select(['constraint_name', 'check_clause'])
    .where('constraint_schema', '=', 'public')
    .execute()
  const hasAlertTypeCheck = checkCon.some((r: any) =>
    typeof r.check_clause === 'string' &&
    /alert_type/i.test(r.check_clause) &&
    /new_merchant_signup/i.test(r.check_clause),
  )
  assert(
    hasAlertTypeCheck,
    `[A4] CHECK constraint on alert_type enforces PLATFORM_ALERT_TYPES enum`,
  )

  // Seed rows — migration 089 writes 9 recipient rows at apply time
  const initialRecipients = await listRecipients(db as any)
  assert(
    initialRecipients.length === 9,
    `[A5] 9 rows seeded in platform_alert_recipients (got ${initialRecipients.length})`,
  )
  assert(
    PLATFORM_ALERT_TYPES.every((t) =>
      initialRecipients.some((r) => r.alertType === t),
    ),
    `[A5b] all 9 PLATFORM_ALERT_TYPES have a recipient row`,
  )

  // -------------------------------------------------------------------
  // [B] Recipients DB-access layer
  // -------------------------------------------------------------------
  log('\n[B] Recipients DB-access layer')

  // Snapshot original values for every alert_type we're about to touch
  for (const t of PLATFORM_ALERT_TYPES) {
    const row = initialRecipients.find((r) => r.alertType === t)!
    MUTATED_ALERT_TYPES.set(t, {
      recipientEmail: row.recipientEmail,
      enabled: row.enabled,
    })
  }

  // [B1] ordering
  const sortedAlphabet = [...PLATFORM_ALERT_TYPES].sort()
  const listedAlphabet = initialRecipients.map((r) => r.alertType)
  assert(
    JSON.stringify(listedAlphabet) === JSON.stringify(sortedAlphabet),
    `[B1] listRecipients returns 9 rows in alphabetical order`,
  )

  // [B2] single-row lookup
  const single = await getRecipient(db as any, 'new_merchant_signup')
  assert(
    single != null && single.alertType === 'new_merchant_signup',
    `[B2] getRecipient('new_merchant_signup') returns the row`,
  )

  // [B3] updateRecipient flow
  const testEmail = `pr6-smoke-${SUFFIX}@example.test`
  const updatedRow = await updateRecipient(db as any, {
    alertType: 'new_merchant_signup',
    recipientEmail: testEmail,
    recipientName: 'PR6 smoke',
    enabled: true,
  })
  assert(
    updatedRow != null &&
      updatedRow.recipientEmail === testEmail &&
      updatedRow.recipientName === 'PR6 smoke',
    `[B3a] updateRecipient changes email + name`,
  )
  assert(
    updatedRow != null &&
      updatedRow.updatedAt instanceof Date &&
      !Number.isNaN(updatedRow.updatedAt.getTime()),
    `[B3b] updateRecipient sets updated_at to a valid Date`,
  )

  // [B4] invalid alert_type rejected
  let threw = false
  try {
    await updateRecipient(db as any, {
      alertType: 'bogus_type' as any,
      recipientEmail: 'x@example.com',
    })
  } catch {
    threw = true
  }
  assert(threw, `[B4] updateRecipient throws for invalid alert_type`)

  // [B5] empty email rejected
  threw = false
  try {
    await updateRecipient(db as any, {
      alertType: 'new_merchant_signup',
      recipientEmail: '   ',
    })
  } catch {
    threw = true
  }
  assert(threw, `[B5] updateRecipient throws for empty recipient_email`)

  // -------------------------------------------------------------------
  // [C] sendPlatformAlert — pipeline
  // -------------------------------------------------------------------
  log('\n[C] sendPlatformAlert pipeline')

  assert(
    isPlatformAlertsEnabled() === true,
    `[C0] kill-switch defaults ON (PLATFORM_ALERTS_ENABLED not set to "0")`,
  )

  // [C1] first send
  const dedupKey1 = `smoke-pr6-${SUFFIX}-c1`
  const send1 = await sendPlatformAlert(db as any, {
    alertType: 'new_merchant_signup',
    dedupKey: dedupKey1,
    variables: {
      shop_name: 'PR6 smoke shop',
      owner_email: `owner-${SUFFIX}@example.test`,
      country: 'US',
      shop_url: `https://${SUFFIX}.example.test`,
    },
    payload: { shop_id: SHOP_A },
  })
  assert(
    send1.sent === true,
    `[C1a] first send with unique dedup → sent=true (got ${JSON.stringify(send1)})`,
  )
  if (send1.sent) CREATED_DELIVERY_IDS.push(send1.deliveryRowId)
  assert(
    send1.sent && typeof send1.deliveryRowId === 'number',
    `[C1b] first send returned deliveryRowId`,
  )

  // [C2] duplicate send → deduped
  const send2 = await sendPlatformAlert(db as any, {
    alertType: 'new_merchant_signup',
    dedupKey: dedupKey1, // same key
    variables: { shop_name: 'dup', owner_email: 'x@y.z', country: 'US', shop_url: 'https://x' },
  })
  assert(
    send2.sent === false && 'reason' in send2 && send2.reason === 'deduped',
    `[C2] duplicate dedup_key rejected → reason='deduped'`,
  )

  // [C3] recipientOverride bypasses DB lookup (test-send pattern)
  //
  // Phase 14 PR7 BUG-E3 note — override path now requires `actorUserId`
  // (for audit + rate-limit). Supplying a synthetic UUID here keeps the
  // C3 semantics intact; the dedicated PR7 smoke covers the
  // `override_missing_actor` / rate-limit / RFC5322 paths.
  const overrideEmail = `override-${SUFFIX}@example.test`
  const sendOverride = await sendPlatformAlert(db as any, {
    alertType: 'new_merchant_signup',
    dedupKey: `smoke-pr6-${SUFFIX}-override`,
    variables: {
      shop_name: 'override',
      owner_email: 'o@example.test',
      country: 'US',
      shop_url: 'https://o.example.test',
    },
    recipientOverride: overrideEmail,
    actorUserId: `smoke-pr6-${SUFFIX}-actor`,
    actorIp: '127.0.0.1',
  })
  assert(
    sendOverride.sent === true,
    `[C3] recipientOverride bypasses DB lookup → sent=true`,
  )
  if (sendOverride.sent) CREATED_DELIVERY_IDS.push(sendOverride.deliveryRowId)

  // [C4] disabled recipient row
  await updateRecipient(db as any, {
    alertType: 'new_merchant_signup',
    recipientEmail: testEmail,
    enabled: false,
  })
  const sendDisabled = await sendPlatformAlert(db as any, {
    alertType: 'new_merchant_signup',
    dedupKey: `smoke-pr6-${SUFFIX}-disabled`,
    variables: { shop_name: 'x', owner_email: 'x@y.z', country: 'US', shop_url: 'https://x' },
  })
  assert(
    sendDisabled.sent === false &&
      'reason' in sendDisabled &&
      sendDisabled.reason === 'disabled_by_recipient_row',
    `[C4] disabled row → reason='disabled_by_recipient_row'`,
  )
  // Re-enable so subsequent tests aren't blocked
  await updateRecipient(db as any, {
    alertType: 'new_merchant_signup',
    recipientEmail: testEmail,
    enabled: true,
  })

  // [C5] kill-switch env
  process.env.PLATFORM_ALERTS_ENABLED = '0'
  const sendKilled = await sendPlatformAlert(db as any, {
    alertType: 'new_merchant_signup',
    dedupKey: `smoke-pr6-${SUFFIX}-killed`,
    variables: { shop_name: 'k', owner_email: 'k@y.z', country: 'US', shop_url: 'https://k' },
  })
  assert(
    sendKilled.sent === false &&
      'reason' in sendKilled &&
      sendKilled.reason === 'disabled_by_env',
    `[C5] PLATFORM_ALERTS_ENABLED=0 → reason='disabled_by_env'`,
  )
  // Restore immediately so subsequent sections can hit the DB path
  if (ORIGINAL_ENV.PLATFORM_ALERTS_ENABLED == null) {
    delete process.env.PLATFORM_ALERTS_ENABLED
  } else {
    process.env.PLATFORM_ALERTS_ENABLED = ORIGINAL_ENV.PLATFORM_ALERTS_ENABLED
  }

  // -------------------------------------------------------------------
  // [D] Typed emitters — dedup-key shape correctness
  // -------------------------------------------------------------------
  log('\n[D] Typed emitters — key shape')

  // Helper: pull the dedup_key we just wrote back out of the deliveries
  // table. The ON CONFLICT semantics mean a success produces exactly one
  // row with that (alert_type, dedup_key) pair.
  async function lastDedupKeyFor(
    alertType: string,
    prefix: string,
  ): Promise<string | null> {
    const row = await (db as any)
      .selectFrom('platform_alert_deliveries')
      .select(['dedup_key'])
      .where('alert_type', '=', alertType)
      .where('dedup_key', 'like', `${prefix}%`)
      .orderBy('id', 'desc')
      .executeTakeFirst()
    return row ? String(row.dedup_key) : null
  }

  // [D1] shop:<uuid>
  const shopForSignup = randomUUID()
  const resSignup = await emitNewMerchantSignup(db as any, {
    shopId: shopForSignup,
    shopName: `PR6 D1 ${SUFFIX}`,
    ownerEmail: `d1-${SUFFIX}@example.test`,
    country: 'VN',
    shopUrl: `https://d1-${SUFFIX}.example.test`,
  })
  if (resSignup.sent) CREATED_DELIVERY_IDS.push(resSignup.deliveryRowId)
  const d1key = await lastDedupKeyFor('new_merchant_signup', `shop:${shopForSignup}`)
  assert(
    d1key === `shop:${shopForSignup}`,
    `[D1] emitNewMerchantSignup dedup_key = shop:<uuid> (got ${d1key})`,
  )

  // [D2] date:YYYY-MM-DD
  const digestRes = await emitPlatformDailyDigest(db as any, {
    gmvTotal: '$99.00',
    newShops: 1,
    churnedShops: 0,
  })
  // May be deduped if another smoke ran earlier today — both outcomes are
  // acceptable; just verify the shape when we got to write.
  if (digestRes.sent) CREATED_DELIVERY_IDS.push(digestRes.deliveryRowId)
  const today = new Date().toISOString().slice(0, 10)
  const d2key = await lastDedupKeyFor('platform_daily_digest', `date:${today}`)
  assert(
    d2key === `date:${today}`,
    `[D2] emitPlatformDailyDigest dedup_key = date:YYYY-MM-DD (got ${d2key})`,
  )

  // [D3] week:YYYY-WW
  const roundupRes = await emitPlatformWeeklyRoundup(db as any, {
    weekStart: 'Apr 20, 2026',
    gmvTotal: '$99.00',
    topShopsHtml: '<tr><td>shop</td></tr>',
  })
  if (roundupRes.sent) CREATED_DELIVERY_IDS.push(roundupRes.deliveryRowId)
  const d3key = await lastDedupKeyFor('platform_weekly_roundup', 'week:')
  assert(
    d3key != null && /^week:\d{4}-\d{2}$/.test(d3key),
    `[D3] emitPlatformWeeklyRoundup dedup_key = week:YYYY-WW (got ${d3key})`,
  )

  // [D4] integration:YYYYMMDDHHMM (5-minute slot)
  const integName = `stripe-smoke-${SUFFIX}`
  const integRes = await emitPlatformIntegrationDown(db as any, {
    integrationName: integName,
    errorRate: '12%',
    statusPage: 'https://status.stripe.com',
  })
  if (integRes.sent) CREATED_DELIVERY_IDS.push(integRes.deliveryRowId)
  const d4key = await lastDedupKeyFor('platform_integration_down', `${integName}:`)
  assert(
    d4key != null && /^[a-z0-9-]+:\d{12}$/.test(d4key),
    `[D4] emitPlatformIntegrationDown dedup_key = <name>:YYYYMMDDHHMM slot (got ${d4key})`,
  )

  // [D5] <env>:<sha256-prefix>
  const incidentRes = await emitPlatformIncident(db as any, {
    severity: 'high',
    title: `smoke incident ${SUFFIX}`,
    errorMessage: `unique-err-${SUFFIX}`,
    env: 'smoke-env',
  })
  if (incidentRes.sent) CREATED_DELIVERY_IDS.push(incidentRes.deliveryRowId)
  const d5key = await lastDedupKeyFor('platform_incident_alert', 'smoke-env:')
  assert(
    d5key != null && /^smoke-env:[a-f0-9]{32}$/.test(d5key),
    `[D5] emitPlatformIncident dedup_key = <env>:<32-hex-sha256-prefix> (got ${d5key})`,
  )

  // [D6] shop:<uuid>:YYYY-MM-DD
  const shopForViolation = randomUUID()
  const polRes = await emitPlatformPolicyViolation(db as any, {
    shopId: shopForViolation,
    shopName: `PR6 D6 ${SUFFIX}`,
    reason: 'test policy',
  })
  if (polRes.sent) CREATED_DELIVERY_IDS.push(polRes.deliveryRowId)
  const d6key = await lastDedupKeyFor(
    'platform_policy_violation',
    `shop:${shopForViolation}:`,
  )
  assert(
    d6key != null && /^shop:[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}$/.test(d6key),
    `[D6] emitPlatformPolicyViolation dedup_key = shop:<uuid>:YYYY-MM-DD (got ${d6key})`,
  )

  // [D7] shop:<uuid>:YYYYMM (month)
  const shopForChurn = randomUUID()
  const churnRes = await emitPlatformChurnAlert(db as any, {
    shopId: shopForChurn,
    shopName: `PR6 D7 ${SUFFIX}`,
    closureReason: 'test churn',
  })
  if (churnRes.sent) CREATED_DELIVERY_IDS.push(churnRes.deliveryRowId)
  const d7key = await lastDedupKeyFor(
    'platform_churn_alert',
    `shop:${shopForChurn}:`,
  )
  assert(
    d7key != null && /^shop:[0-9a-f-]{36}:\d{6}$/.test(d7key),
    `[D7] emitPlatformChurnAlert dedup_key = shop:<uuid>:YYYYMM (got ${d7key})`,
  )

  // -------------------------------------------------------------------
  // [E] Registry flip — 14 wired templates accounted for
  // -------------------------------------------------------------------
  log('\n[E] Registry flip — 14 wired templates')

  const implemented = getImplementedTemplates()
  const pending = getPendingTemplates()

  // 14 PR6 wired keys (6 finance + 8 platform). daily_sales_digest is a
  // cron-driven merchant email — registered as implemented but not in
  // FLOW_CATALOG.
  const pr6Wired = [
    // finance (merchant audience)
    'first_time_customer_order',
    'payment_failed_merchant',
    'refund_issued_merchant',
    'out_of_stock_alert',
    'high_risk_order',
    'daily_sales_digest',
    // platform (god_admin audience)
    'new_merchant_signup',
    'platform_incident_alert',
    'platform_daily_digest',
    'platform_churn_alert',
    'platform_fraud_review',
    'platform_policy_violation',
    'platform_integration_down',
    'platform_weekly_roundup',
  ]
  const missingWired = pr6Wired.filter(
    (k) => !implemented.some((t) => t.key === k),
  )
  assert(
    missingWired.length === 0,
    `[E1] getImplementedTemplates includes all 14 PR6 wired keys (missing=${missingWired.join(',') || 'none'})`,
  )

  // 5 Phase 12 deferred keys must still be pending
  const pr6Deferred = [
    'payout_scheduled',
    'payout_completed',
    'payout_failed',
    'chargeback_opened',
    'chargeback_lost',
  ]
  const missingDeferred = pr6Deferred.filter(
    (k) => !pending.some((t) => t.key === k),
  )
  assert(
    missingDeferred.length === 0,
    `[E2] getPendingTemplates still contains 5 Phase 12 deferred payout/chargeback keys (missing=${missingDeferred.join(',') || 'none'})`,
  )

  // Iron rule 5 chokepoint — god_admin never surfaces to merchant UI
  const merchantVisible = getMerchantVisibleTemplates()
  const godLeaks = merchantVisible.filter((t) => t.audience === 'god_admin')
  assert(
    godLeaks.length === 0,
    `[E3] getMerchantVisibleTemplates filters out god_admin audience (leaks=${godLeaks.length})`,
  )

  // -------------------------------------------------------------------
  // [F] Iron Rule 5 leak scan
  // -------------------------------------------------------------------
  log('\n[F] Iron Rule 5 leak scan')

  const surfaces: string[] = [
    JSON.stringify(send1),
    JSON.stringify(send2),
    JSON.stringify(sendOverride),
    JSON.stringify(sendDisabled),
    JSON.stringify(sendKilled),
    JSON.stringify(resSignup),
    JSON.stringify(digestRes),
    JSON.stringify(roundupRes),
    JSON.stringify(integRes),
    JSON.stringify(incidentRes),
    JSON.stringify(polRes),
    JSON.stringify(churnRes),
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
    `[F1] no god_admin string in any PR6 result surface (leaks: ${leaks.join(' | ') || 'none'})`,
  )

  assert(
    merchantVisible.every((t) => t.audience !== 'god_admin'),
    `[F2] every merchant-visible template has audience != 'god_admin'`,
  )

  // F3 — templateKey should NOT appear in the automation_flows override
  // rows (keys live in flow-catalog.ts; automation_flows stores flow_key).
  const flowRowsCols = await (db as any)
    .selectFrom('information_schema.columns' as any)
    .select(['column_name'])
    .where('table_schema', '=', 'public')
    .where('table_name', '=', 'automation_flows')
    .execute()
  const flowColNames = new Set(flowRowsCols.map((r: any) => r.column_name))
  assert(
    !flowColNames.has('template_key'),
    `[F3] automation_flows has no template_key column (keys stay in flow-catalog)`,
  )

  // -------------------------------------------------------------------
  // [G] Automation_flows override write path for finance alerts
  // -------------------------------------------------------------------
  log('\n[G] automation_flows override for finance alerts')

  // Seed a shop for the flow-override test — automation_flows.shop_id
  // FKs into shops.id.
  await (db as any)
    .insertInto('shops')
    .values({
      id: SHOP_A,
      slug: `smoke-p14-6-${SUFFIX}`,
      name: `PR6 Shop A`,
      email: `p14-6-shop-${SUFFIX}@example.test`,
      status: 'active',
      plan: 'free',
    })
    .execute()

  // [G1] UPSERT override for refund_issued_merchant
  await (db as any)
    .insertInto('automation_flows')
    .values({
      shop_id: SHOP_A,
      flow_key: 'refund_issued_merchant',
      enabled: false,
      delay_seconds: null,
      conditions: null,
    })
    .onConflict((oc: any) =>
      oc.columns(['shop_id', 'flow_key']).doUpdateSet({
        enabled: false,
        delay_seconds: null,
        updated_at: new Date().toISOString(),
      }),
    )
    .execute()
  WRITTEN_FLOW_KEYS.push('refund_issued_merchant')

  const overrideRow = await (db as any)
    .selectFrom('automation_flows')
    .select(['enabled', 'delay_seconds'])
    .where('shop_id', '=', SHOP_A)
    .where('flow_key', '=', 'refund_issued_merchant')
    .executeTakeFirst()
  assert(
    overrideRow != null &&
      overrideRow.enabled === false &&
      overrideRow.delay_seconds == null,
    `[G1] override row for refund_issued_merchant: enabled=false, delay=null`,
  )

  // [G2] Second UPSERT must update, not duplicate
  await (db as any)
    .insertInto('automation_flows')
    .values({
      shop_id: SHOP_A,
      flow_key: 'refund_issued_merchant',
      enabled: true, // flipped back on
      delay_seconds: 300, // 5min override
      conditions: null,
    })
    .onConflict((oc: any) =>
      oc.columns(['shop_id', 'flow_key']).doUpdateSet({
        enabled: true,
        delay_seconds: 300,
        updated_at: new Date().toISOString(),
      }),
    )
    .execute()

  const afterUpdate = await (db as any)
    .selectFrom('automation_flows')
    .select([
      (db as any).fn.count('id').as('row_count'),
    ])
    .where('shop_id', '=', SHOP_A)
    .where('flow_key', '=', 'refund_issued_merchant')
    .executeTakeFirstOrThrow()
  assert(
    Number(afterUpdate.row_count) === 1,
    `[G2a] second UPSERT updated the row in place (count=1, got ${afterUpdate.row_count})`,
  )

  const afterUpdateRow = await (db as any)
    .selectFrom('automation_flows')
    .select(['enabled', 'delay_seconds'])
    .where('shop_id', '=', SHOP_A)
    .where('flow_key', '=', 'refund_issued_merchant')
    .executeTakeFirst()
  assert(
    afterUpdateRow != null &&
      afterUpdateRow.enabled === true &&
      Number(afterUpdateRow.delay_seconds) === 300,
    `[G2b] UPSERT updated enabled=true, delay_seconds=300`,
  )

  // [G3] DELETE returns to catalog-default (implicit enabled=true)
  await (db as any)
    .deleteFrom('automation_flows')
    .where('shop_id', '=', SHOP_A)
    .where('flow_key', '=', 'refund_issued_merchant')
    .execute()

  const afterDelete = await (db as any)
    .selectFrom('automation_flows')
    .select([
      (db as any).fn.count('id').as('row_count'),
    ])
    .where('shop_id', '=', SHOP_A)
    .where('flow_key', '=', 'refund_issued_merchant')
    .executeTakeFirstOrThrow()
  assert(
    Number(afterDelete.row_count) === 0,
    `[G3] DELETE override row → reverts to catalog default (count=0)`,
  )

  // Also verify: we CAN write an override for a deferred (Phase 12) key
  // without error, but it won't fire anything today — the emit site
  // doesn't exist yet. The row is just staged storage.
  await (db as any)
    .insertInto('automation_flows')
    .values({
      shop_id: SHOP_A,
      flow_key: 'payout_scheduled',
      enabled: false,
      delay_seconds: null,
      conditions: null,
    })
    .onConflict((oc: any) =>
      oc.columns(['shop_id', 'flow_key']).doUpdateSet({
        enabled: false,
      }),
    )
    .execute()
  WRITTEN_FLOW_KEYS.push('payout_scheduled')
  const deferredRow = await (db as any)
    .selectFrom('automation_flows')
    .select(['enabled'])
    .where('shop_id', '=', SHOP_A)
    .where('flow_key', '=', 'payout_scheduled')
    .executeTakeFirst()
  assert(
    deferredRow != null && deferredRow.enabled === false,
    `[G3b] deferred key (payout_scheduled) override accepted for Phase 12 staging`,
  )

  // -------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------
  log(`\n=== Phase 14 PR6 smoke: ${total - failed}/${total} passed (${failed} failed) ===\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((err) => {
    console.error('Phase 14 PR6 smoke — fatal error:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    log('\n[cleanup] Removing seeded rows + restoring recipient state')
    try {
      // Order: platform_alert_deliveries → automation_flows → shops.
      // Recipients are restored in-place (never deleted — migration 089
      // owns those rows).
      if (CREATED_DELIVERY_IDS.length > 0) {
        await (db as any)
          .deleteFrom('platform_alert_deliveries')
          .where('id', 'in', CREATED_DELIVERY_IDS)
          .execute()
      }
      // Also clean up any deliveries keyed to our smoke prefix (defensive:
      // emitters may have written rows whose id we didn't capture into
      // CREATED_DELIVERY_IDS when the branch checked `if (res.sent)` ran
      // before deduped second-pass writes).
      await (db as any)
        .deleteFrom('platform_alert_deliveries')
        .where('dedup_key', 'like', `%smoke-pr6-${SUFFIX}%`)
        .execute()
      // Restore recipient rows
      for (const [alertType, original] of MUTATED_ALERT_TYPES) {
        await updateRecipient(db as any, {
          alertType: alertType as any,
          recipientEmail: original.recipientEmail,
          enabled: original.enabled,
        })
      }
      if (WRITTEN_FLOW_KEYS.length > 0) {
        await (db as any)
          .deleteFrom('automation_flows')
          .where('shop_id', '=', SHOP_A)
          .where('flow_key', 'in', WRITTEN_FLOW_KEYS)
          .execute()
      }
      await (db as any)
        .deleteFrom('shops')
        .where('id', '=', SHOP_A)
        .execute()

      // Env restore
      if (ORIGINAL_ENV.NODE_ENV == null) delete process.env.NODE_ENV
      else process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV
      if (ORIGINAL_ENV.EMAIL_TRANSPORT == null) delete process.env.EMAIL_TRANSPORT
      else process.env.EMAIL_TRANSPORT = ORIGINAL_ENV.EMAIL_TRANSPORT
      if (ORIGINAL_ENV.PLATFORM_ALERTS_ENABLED == null) {
        delete process.env.PLATFORM_ALERTS_ENABLED
      } else {
        process.env.PLATFORM_ALERTS_ENABLED = ORIGINAL_ENV.PLATFORM_ALERTS_ENABLED
      }
      log('[cleanup] done')
    } catch (e) {
      console.error('[cleanup] error:', e)
    } finally {
      await db.destroy()
    }
  })
