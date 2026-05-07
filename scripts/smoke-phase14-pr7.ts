/**
 * Phase 14 PR7 — Email hardening + bug sweep — live-DB smoke.
 *
 * Covers the 6 bugs ("BUG-E1"…"BUG-E6") called out in the audit
 * attached to the PR7 branch kickoff. Unit tests live in their modules;
 * this script is the end-to-end walk that pushes every fix through a
 * real Postgres (same target as the PR6 smoke — server 2 `gbox_platform`).
 *
 * INVARIANTS ASSERTED
 * ===================
 *
 *   [A] Staff permission catalog — 5 email permissions wired (BUG-E2)
 *       [A1] PERMISSION_CATALOG carries email:view / manage_templates /
 *            manage_suppression / manage_alerts / send_test.
 *       [A2] STAFF_TEMPLATE includes email:view only (read-only by default).
 *       [A3] STAFF_TEMPLATE excludes the 4 write-class keys.
 *       [A4] ADMIN_TEMPLATE includes all 5 email keys.
 *       [A5] staffHasPermission('owner', …) bypasses any check.
 *       [A6] staffHasPermission('staff', ['email:view'], 'email:view') → true.
 *       [A7] staffHasPermission('staff', ['email:view'], 'email:manage_templates') → false.
 *
 *   [B] sendTemplatedEmail no-throw contract (BUG-E1)
 *       [B1] A throwing `db` short-circuits with ok=false,
 *            reason='db_write_failed'. The error string is preserved
 *            for ops forensics.
 *
 *   [C] recipientOverride guard-rails (BUG-E3)
 *       [C1] override without actorUserId → reason='override_missing_actor'.
 *       [C2] override with CRLF-injection address → reason='override_invalid_email'
 *            and audit_logs row with outcome='blocked', blockReason='invalid_email'.
 *       [C3] valid override + actor → sent=true plus audit_logs row
 *            with outcome='sent'.
 *       [C4] 10 subsequent accepts + 1 reject → 'override_rate_limited'
 *            and audit_logs row with outcome='blocked', blockReason='rate_limited'.
 *       [C5] __isValidOverrideEmail unit matrix: empty / no-@ / two-@ /
 *            CRLF / leading-ws / too-long / good.
 *
 *   [D] Cron wiring (BUG-E4)
 *       [D1] seedEmailCronTasks is idempotent — second call reports
 *            existing=1, inserted=0.
 *       [D2] cron_tasks row for handler='aggregate_soft_bounces' exists.
 *       [D3] __hasCronHandler('aggregate_soft_bounces') is true after
 *            importing cron/service.ts (proves the registerHandler
 *            side-effect is live).
 *
 *   [E] Emitter coverage gap closed (BUG-E5)
 *       [E1] emitPlatformFraudReview → dedup_key matches
 *            ^shop:<uuid>:YYYY-MM-DD$.
 *       [E2] emitPlatformBillingFailure → dedup_key matches
 *            ^shop:<uuid>:<invoice>$ and survives a duplicate with reason='deduped'.
 *
 *   [F] Send-test UI handler wired (BUG-E6)
 *       [F1] postEmailTemplateSendTest is exported from the email-templates
 *            store-admin page module (import must not throw + must be a function).
 *
 *   [G] Iron Rule 5 leak scan — defensive
 *       [G1] No 'god[\s_-]?admin' substring in any result body we produced.
 *
 * USAGE (from server 2 — local Windows box can't reach the PG):
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase14-pr7.ts
 *
 * Forces NODE_ENV='test' + EMAIL_TRANSPORT='console' on entry so no
 * outbound mail leaks. Cleans up every seeded row (audit_logs, deliveries,
 * override cron row left alone — it's platform config going forward).
 */

import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { createDb } from '../packages/db/src/index.js'

// ─── Modules under test ───────────────────────────────────────────
import {
  PERMISSION_CATALOG,
  PERMISSION_KEYS,
  resolvePermissions,
  staffHasPermission,
} from '../packages/core/src/modules/staff/permissions.js'
import {
  sendPlatformAlert,
} from '../packages/core/src/modules/platform-alerts/send.js'
import {
  __checkAndRecordOverride,
  __resetOverrideBucketsForTests,
  __isValidOverrideEmail,
} from '../packages/core/src/modules/platform-alerts/send.js'
import {
  emitPlatformFraudReview,
  emitPlatformBillingFailure,
} from '../packages/core/src/modules/platform-alerts/emitters.js'
import {
  seedEmailCronTasks,
  AGGREGATE_SOFT_BOUNCES_HANDLER,
} from '../packages/core/src/modules/email/bounce-aggregator.js'
// IMPORTANT: importing cron/service.ts is what runs the
// `registerHandler('aggregate_soft_bounces', …)` side-effect. Without
// this import the __hasCronHandler assertion below would false-negative.
import { __hasCronHandler } from '../packages/core/src/modules/cron/service.js'
import { sendTemplatedEmail } from '../packages/core/src/modules/email/send.js'
// BUG-E6 — probe that the handler is exported + callable-shaped.
import { postEmailTemplateSendTest } from '../apps/store-admin/src/pages/email-templates.js'

// ─── Env isolation ─────────────────────────────────────────────────
const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  EMAIL_TRANSPORT: process.env.EMAIL_TRANSPORT,
  PLATFORM_ALERTS_ENABLED: process.env.PLATFORM_ALERTS_ENABLED,
}
if (process.env.NODE_ENV === 'production') {
  throw new Error('smoke-phase14-pr7 must not be run with NODE_ENV=production')
}
process.env.NODE_ENV = 'test'
process.env.EMAIL_TRANSPORT = 'console'
// PR7 smoke leaves PLATFORM_ALERTS_ENABLED as-is — the kill-switch path
// is already exercised in PR6.

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
// audit_logs.user_id is UUID with FK → users.id. We seed a throwaway user
// so the override audit rows written by [C2]/[C3]/[C4] satisfy the FK,
// then tear it down at cleanup. The UUID is randomised per run to stay
// idempotent across re-runs / interleaved smokes.
const ACTOR_ID = randomUUID()
const ACTOR_EMAIL = `pr7-smoke-actor-${SUFFIX}@smoke.test`

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

// Track rows created so cleanup stays honest.
const CREATED_DELIVERY_IDS: number[] = []
const AUDIT_LOG_DEDUP_KEYS: string[] = []

// Result surfaces collected for the Iron-Rule-5 leak scan at [G].
const COLLECTED_RESULTS: unknown[] = []
function collect<T>(result: T): T {
  COLLECTED_RESULTS.push(result)
  return result
}

// ─── Main test flow ────────────────────────────────────────────────
async function main() {
  log(`\n=== Phase 14 PR7 smoke — suffix=${SUFFIX} actor=${ACTOR_ID} ===\n`)

  // Seed throwaway actor user so audit_logs FK on user_id passes for
  // the [C2]/[C3]/[C4] override-audit assertions. Teardown removes it.
  await (db as any)
    .insertInto('users')
    .values({
      id: ACTOR_ID,
      email: ACTOR_EMAIL,
      role: 'admin',
      status: 'active',
    })
    .execute()

  // -------------------------------------------------------------------
  // [A] Staff permission catalog — BUG-E2
  // -------------------------------------------------------------------
  log('\n[A] Staff permission catalog — 5 email permissions wired')

  const catalogKeys = new Set(PERMISSION_CATALOG.map((p) => p.key))
  const expectedEmailKeys = [
    'email:view',
    'email:manage_templates',
    'email:manage_suppression',
    'email:manage_alerts',
    'email:send_test',
  ]
  const missingCatalog = expectedEmailKeys.filter((k) => !catalogKeys.has(k))
  assert(
    missingCatalog.length === 0,
    `[A1] PERMISSION_CATALOG carries all 5 email keys (missing=${missingCatalog.join(',') || 'none'})`,
  )

  // STAFF_TEMPLATE + ADMIN_TEMPLATE are module-private. resolvePermissions
  // with an empty override list returns the raw template for the role
  // (the `owner` branch returns all catalog keys so it's not useful here).
  const staffTemplate = new Set(resolvePermissions('staff', []))
  const adminTemplate = new Set(resolvePermissions('admin', []))

  assert(
    staffTemplate.has('email:view'),
    `[A2] STAFF_TEMPLATE includes email:view (read-only default)`,
  )
  const staffLeakKeys = [
    'email:manage_templates',
    'email:manage_suppression',
    'email:manage_alerts',
    'email:send_test',
  ].filter((k) => staffTemplate.has(k))
  assert(
    staffLeakKeys.length === 0,
    `[A3] STAFF_TEMPLATE excludes write-class email keys (leaked=${staffLeakKeys.join(',') || 'none'})`,
  )

  const adminMissing = expectedEmailKeys.filter((k) => !adminTemplate.has(k))
  assert(
    adminMissing.length === 0,
    `[A4] ADMIN_TEMPLATE includes all 5 email keys (missing=${adminMissing.join(',') || 'none'})`,
  )

  assert(
    staffHasPermission('owner', [], 'email:manage_templates') === true,
    `[A5] staffHasPermission('owner', …) bypass honoured`,
  )
  assert(
    staffHasPermission('staff', ['email:view'], 'email:view') === true,
    `[A6] staffHasPermission('staff', ['email:view'], 'email:view') === true`,
  )
  assert(
    staffHasPermission('staff', ['email:view'], 'email:manage_templates') === false,
    `[A7] staffHasPermission('staff', [only email:view], 'email:manage_templates') === false`,
  )

  // Defensive: the catalog holds at least 26 keys (20 pre-PR7 + the 5
  // new email + 1 `home:view`). A regression that dropped one of our
  // new keys would fail here too.
  assert(
    PERMISSION_KEYS.length >= 26,
    `[A8] PERMISSION_KEYS has >=26 keys (has ${PERMISSION_KEYS.length})`,
  )

  // -------------------------------------------------------------------
  // [B] sendTemplatedEmail no-throw contract — BUG-E1
  // -------------------------------------------------------------------
  log('\n[B] sendTemplatedEmail no-throw contract')

  // A deliberately-broken "db" whose first op throws. If the outer
  // try/catch is missing this bubbles out; with the fix in send.ts the
  // public wrapper catches + returns the ok=false shape.
  const throwingDb = {
    selectFrom: () => {
      throw new Error('SIMULATED DB CRASH — BUG-E1 probe')
    },
    insertInto: () => {
      throw new Error('SIMULATED DB CRASH — BUG-E1 probe')
    },
  } as any

  const throwResult = await sendTemplatedEmail(throwingDb, {
    templateKey: 'new_merchant_signup' as any,
    to: 'probe@example.test',
    shopId: null,
    variables: {},
  })
  COLLECTED_RESULTS.push(throwResult)
  assert(
    throwResult.ok === false,
    `[B1a] throwing db yields ok=false`,
  )
  assert(
    throwResult.ok === false && throwResult.reason === 'db_write_failed',
    `[B1b] reason='db_write_failed' (got ${'ok' in throwResult && !throwResult.ok ? throwResult.reason : '<ok>'})`,
  )
  assert(
    throwResult.ok === false &&
      typeof (throwResult as any).error === 'string' &&
      (throwResult as any).error.includes('SIMULATED DB CRASH'),
    `[B1c] error string preserved for ops forensics`,
  )

  // -------------------------------------------------------------------
  // [C] recipientOverride guard-rails — BUG-E3
  // -------------------------------------------------------------------
  log('\n[C] recipientOverride guard-rails (rate-limit + RFC5322 + audit)')

  __resetOverrideBucketsForTests()

  // [C1] override without actorUserId
  const c1 = collect(
    await sendPlatformAlert(db as any, {
      alertType: 'new_merchant_signup',
      dedupKey: `pr7-c1-${SUFFIX}`,
      variables: {
        shop_name: 'c1',
        owner_email: 'x@y.z',
        country: 'US',
        shop_url: 'https://x',
      },
      recipientOverride: 'override-c1@example.test',
      // actorUserId deliberately omitted
    }),
  )
  assert(
    c1.sent === false && 'reason' in c1 && c1.reason === 'override_missing_actor',
    `[C1] override without actorUserId → override_missing_actor (got ${'reason' in c1 ? c1.reason : '<sent>'})`,
  )

  // [C2] CRLF injection — must reject + audit
  const crlfAddr = 'attacker@example.test\r\nBcc: spam@evil.test'
  const c2 = collect(
    await sendPlatformAlert(db as any, {
      alertType: 'new_merchant_signup',
      dedupKey: `pr7-c2-${SUFFIX}`,
      variables: {
        shop_name: 'c2',
        owner_email: 'x@y.z',
        country: 'US',
        shop_url: 'https://x',
      },
      recipientOverride: crlfAddr,
      actorUserId: ACTOR_ID,
      actorIp: '10.0.0.2',
    }),
  )
  assert(
    c2.sent === false && 'reason' in c2 && c2.reason === 'override_invalid_email',
    `[C2a] override with CRLF payload → override_invalid_email (got ${'reason' in c2 ? c2.reason : '<sent>'})`,
  )
  AUDIT_LOG_DEDUP_KEYS.push(`pr7-c2-${SUFFIX}`)

  const c2Audit = await (db as any)
    .selectFrom('audit_logs')
    .select(['id', 'details'])
    .where('user_id', '=', ACTOR_ID)
    .where('action', '=', 'platform_alert_override')
    .where(sql`details::text LIKE ${'%pr7-c2-' + SUFFIX + '%'}`)
    .executeTakeFirst()
  assert(
    c2Audit != null,
    `[C2b] audit_logs row written for blocked CRLF override`,
  )
  if (c2Audit) {
    const details =
      typeof c2Audit.details === 'string'
        ? JSON.parse(c2Audit.details)
        : c2Audit.details
    assert(
      details?.outcome === 'blocked' && details?.blockReason === 'invalid_email',
      `[C2c] audit row details outcome=blocked, blockReason=invalid_email (got outcome=${details?.outcome}, blockReason=${details?.blockReason})`,
    )
  }

  // [C3] valid override + actor → sent + audit
  const c3Addr = `override-c3-${SUFFIX}@example.test`
  const c3 = collect(
    await sendPlatformAlert(db as any, {
      alertType: 'new_merchant_signup',
      dedupKey: `pr7-c3-${SUFFIX}`,
      variables: {
        shop_name: 'c3',
        owner_email: 'x@y.z',
        country: 'US',
        shop_url: 'https://x',
      },
      recipientOverride: c3Addr,
      actorUserId: ACTOR_ID,
      actorIp: '10.0.0.3',
    }),
  )
  assert(
    c3.sent === true,
    `[C3a] valid override + actor → sent=true (got ${c3.sent ? 'sent' : ('reason' in c3 ? c3.reason : '<?>')})`,
  )
  if (c3.sent) CREATED_DELIVERY_IDS.push(c3.deliveryRowId)
  AUDIT_LOG_DEDUP_KEYS.push(`pr7-c3-${SUFFIX}`)

  const c3Audit = await (db as any)
    .selectFrom('audit_logs')
    .select(['details'])
    .where('user_id', '=', ACTOR_ID)
    .where('action', '=', 'platform_alert_override')
    .where(sql`details::text LIKE ${'%pr7-c3-' + SUFFIX + '%'}`)
    .executeTakeFirst()
  assert(
    c3Audit != null,
    `[C3b] audit_logs row written for accepted override`,
  )
  if (c3Audit) {
    const details =
      typeof c3Audit.details === 'string'
        ? JSON.parse(c3Audit.details)
        : c3Audit.details
    assert(
      details?.outcome === 'sent' && details?.recipientOverride === c3Addr,
      `[C3c] audit row details outcome=sent, recipientOverride=${c3Addr} (got outcome=${details?.outcome}, recipient=${details?.recipientOverride})`,
    )
  }

  // [C4] rate-limit — 10/min per actor. The C2 reject path does NOT
  // consume a slot (RFC5322 rejection happens before the bucket
  // increment). C3 consumed 1 slot; we burn 9 more + assert 11th fails.
  __resetOverrideBucketsForTests() // isolate from the C3 slot
  for (let i = 0; i < 10; i++) {
    const ok = __checkAndRecordOverride(ACTOR_ID)
    assert(ok === true, `[C4a.${i + 1}] slot ${i + 1}/10 accepted`)
  }
  assert(
    __checkAndRecordOverride(ACTOR_ID) === false,
    `[C4b] 11th slot in 60s window rejected by rate-limit`,
  )

  // Full-pipeline rate-limit probe: with the bucket already at 10,
  // the next sendPlatformAlert override must short-circuit and write
  // an audit row with blockReason='rate_limited'.
  const c4Addr = `override-c4-${SUFFIX}@example.test`
  const c4 = collect(
    await sendPlatformAlert(db as any, {
      alertType: 'new_merchant_signup',
      dedupKey: `pr7-c4-${SUFFIX}`,
      variables: {
        shop_name: 'c4',
        owner_email: 'x@y.z',
        country: 'US',
        shop_url: 'https://x',
      },
      recipientOverride: c4Addr,
      actorUserId: ACTOR_ID,
      actorIp: '10.0.0.4',
    }),
  )
  assert(
    c4.sent === false && 'reason' in c4 && c4.reason === 'override_rate_limited',
    `[C4c] end-to-end override over-limit → override_rate_limited (got ${'reason' in c4 ? c4.reason : '<sent>'})`,
  )
  AUDIT_LOG_DEDUP_KEYS.push(`pr7-c4-${SUFFIX}`)

  const c4Audit = await (db as any)
    .selectFrom('audit_logs')
    .select(['details'])
    .where('user_id', '=', ACTOR_ID)
    .where('action', '=', 'platform_alert_override')
    .where(sql`details::text LIKE ${'%pr7-c4-' + SUFFIX + '%'}`)
    .executeTakeFirst()
  if (c4Audit) {
    const details =
      typeof c4Audit.details === 'string'
        ? JSON.parse(c4Audit.details)
        : c4Audit.details
    assert(
      details?.outcome === 'blocked' && details?.blockReason === 'rate_limited',
      `[C4d] audit row details outcome=blocked, blockReason=rate_limited (got outcome=${details?.outcome}, blockReason=${details?.blockReason})`,
    )
  } else {
    assert(false, `[C4d] audit_logs row missing for rate-limited override`)
  }

  // [C5] __isValidOverrideEmail unit matrix
  assert(
    __isValidOverrideEmail('') === false,
    `[C5.1] empty → invalid`,
  )
  assert(
    __isValidOverrideEmail('no-at-sign') === false,
    `[C5.2] no '@' → invalid`,
  )
  assert(
    __isValidOverrideEmail('a@b@c.test') === false,
    `[C5.3] two '@' → invalid`,
  )
  assert(
    __isValidOverrideEmail('a@b.test\r\nBcc: spam@x.test') === false,
    `[C5.4] CRLF → invalid`,
  )
  assert(
    __isValidOverrideEmail(' leading@space.test') === false,
    `[C5.5] leading whitespace → invalid`,
  )
  assert(
    __isValidOverrideEmail('a@' + 'b'.repeat(260) + '.test') === false,
    `[C5.6] over 254 chars → invalid`,
  )
  assert(
    __isValidOverrideEmail('valid@example.test') === true,
    `[C5.7] valid RFC5322-ish → valid`,
  )

  // Restart the bucket so emitter tests in [E] don't inherit over-limit.
  __resetOverrideBucketsForTests()

  // -------------------------------------------------------------------
  // [D] Cron wiring — BUG-E4
  // -------------------------------------------------------------------
  log('\n[D] aggregate_soft_bounces cron wiring')

  // [D1] seedEmailCronTasks is idempotent
  const seed1 = await seedEmailCronTasks(db as any)
  const seed2 = await seedEmailCronTasks(db as any)
  assert(
    seed2.inserted === 0 && seed2.existing === 1,
    `[D1] second seed reports inserted=0 existing=1 (got inserted=${seed2.inserted} existing=${seed2.existing})`,
  )
  // first seed may be 0 or 1 depending on prior boot on this DB — just
  // log it rather than assert; the idempotent second call is the real
  // contract.
  log(
    `       seed1 (first call) → inserted=${seed1.inserted} existing=${seed1.existing}`,
  )

  // [D2] row in cron_tasks exists
  const cronRow = await (db as any)
    .selectFrom('cron_tasks')
    .select(['handler', 'schedule', 'status'])
    .where('handler', '=', AGGREGATE_SOFT_BOUNCES_HANDLER)
    .executeTakeFirst()
  assert(
    cronRow != null && cronRow.handler === AGGREGATE_SOFT_BOUNCES_HANDLER,
    `[D2] cron_tasks row for handler='${AGGREGATE_SOFT_BOUNCES_HANDLER}' present`,
  )

  // [D3] handler registered via service.ts import side-effect
  assert(
    __hasCronHandler(AGGREGATE_SOFT_BOUNCES_HANDLER) === true,
    `[D3] __hasCronHandler('${AGGREGATE_SOFT_BOUNCES_HANDLER}') === true`,
  )

  // -------------------------------------------------------------------
  // [E] Emitter coverage gap — BUG-E5
  // -------------------------------------------------------------------
  log('\n[E] emitPlatformFraudReview + emitPlatformBillingFailure')

  // [E1] fraud review
  const shopForFraud = randomUUID()
  const fraudRes = collect(
    await emitPlatformFraudReview(db as any, {
      shopId: shopForFraud,
      shopName: `PR7 E1 ${SUFFIX}`,
      heuristic: 'velocity',
      evidenceUrl: 'https://admin.example.test/orders/xxx',
    }),
  )
  if (fraudRes.sent) CREATED_DELIVERY_IDS.push(fraudRes.deliveryRowId)

  const fraudRow = await (db as any)
    .selectFrom('platform_alert_deliveries')
    .select(['dedup_key'])
    .where('alert_type', '=', 'platform_fraud_review')
    .where('dedup_key', 'like', `shop:${shopForFraud}:%`)
    .orderBy('id', 'desc')
    .executeTakeFirst()
  const e1key = fraudRow ? String(fraudRow.dedup_key) : null
  assert(
    e1key != null && /^shop:[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}$/.test(e1key),
    `[E1] emitPlatformFraudReview dedup_key = shop:<uuid>:YYYY-MM-DD (got ${e1key})`,
  )

  // [E2] billing failure — 1/invoice dedup
  const shopForBilling = randomUUID()
  const invoiceId = `inv-pr7-${SUFFIX}`
  const billRes1 = collect(
    await emitPlatformBillingFailure(db as any, {
      shopId: shopForBilling,
      shopName: `PR7 E2 ${SUFFIX}`,
      invoiceId,
      amount: '$49.00',
      failureReason: 'card_declined',
    }),
  )
  if (billRes1.sent) CREATED_DELIVERY_IDS.push(billRes1.deliveryRowId)

  const billRow = await (db as any)
    .selectFrom('platform_alert_deliveries')
    .select(['dedup_key'])
    .where('alert_type', '=', 'platform_billing_failure')
    .where('dedup_key', 'like', `shop:${shopForBilling}:%`)
    .orderBy('id', 'desc')
    .executeTakeFirst()
  const e2key = billRow ? String(billRow.dedup_key) : null
  assert(
    e2key != null && e2key === `shop:${shopForBilling}:${invoiceId}`,
    `[E2a] emitPlatformBillingFailure dedup_key = shop:<uuid>:<invoice> (got ${e2key})`,
  )

  // Second call with same shop+invoice → deduped
  const billRes2 = collect(
    await emitPlatformBillingFailure(db as any, {
      shopId: shopForBilling,
      shopName: `PR7 E2 ${SUFFIX}`,
      invoiceId,
      amount: '$49.00',
      failureReason: 'card_declined',
    }),
  )
  assert(
    billRes2.sent === false && 'reason' in billRes2 && billRes2.reason === 'deduped',
    `[E2b] duplicate billing failure for same invoice → reason='deduped' (got ${'reason' in billRes2 ? billRes2.reason : '<sent>'})`,
  )

  // -------------------------------------------------------------------
  // [F] Send-test handler wired — BUG-E6
  // -------------------------------------------------------------------
  log('\n[F] postEmailTemplateSendTest exported from store-admin')

  assert(
    typeof postEmailTemplateSendTest === 'function',
    `[F1] postEmailTemplateSendTest is a function (typeof = ${typeof postEmailTemplateSendTest})`,
  )
  // We can also assert arity — the handler is (req, res, db) → 3.
  assert(
    postEmailTemplateSendTest.length === 3,
    `[F2] postEmailTemplateSendTest has arity 3 (req, res, db) — got ${postEmailTemplateSendTest.length}`,
  )

  // -------------------------------------------------------------------
  // [G] Iron Rule 5 leak scan
  // -------------------------------------------------------------------
  log('\n[G] Iron Rule 5 leak scan')

  const leakPatterns = [/god[\s_-]?admin/i, /\/god-admin\//i]
  const leaks: string[] = []
  for (const r of COLLECTED_RESULTS) {
    const s = JSON.stringify(r)
    for (const pat of leakPatterns) {
      if (pat.test(s)) leaks.push(`${pat.source} matched in ${s.slice(0, 80)}...`)
    }
  }
  assert(
    leaks.length === 0,
    `[G1] no god_admin/god-admin substring in any PR7 result body (leaks=${leaks.join(' | ') || 'none'})`,
  )

  // -------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------
  log(`\n=== Phase 14 PR7 smoke: ${total - failed}/${total} passed (${failed} failed) ===\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((err) => {
    console.error('Phase 14 PR7 smoke — fatal error:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    log('\n[cleanup] Removing seeded rows')
    try {
      if (CREATED_DELIVERY_IDS.length > 0) {
        await (db as any)
          .deleteFrom('platform_alert_deliveries')
          .where('id', 'in', CREATED_DELIVERY_IDS)
          .execute()
      }
      // Belt-and-braces cleanup for any delivery row we missed capturing
      await (db as any)
        .deleteFrom('platform_alert_deliveries')
        .where('dedup_key', 'like', `%pr7-${SUFFIX}%`)
        .execute()
      await (db as any)
        .deleteFrom('platform_alert_deliveries')
        .where('dedup_key', 'like', `%pr7-c1-${SUFFIX}%`)
        .execute()
      await (db as any)
        .deleteFrom('platform_alert_deliveries')
        .where('dedup_key', 'like', `%pr7-c2-${SUFFIX}%`)
        .execute()
      await (db as any)
        .deleteFrom('platform_alert_deliveries')
        .where('dedup_key', 'like', `%pr7-c3-${SUFFIX}%`)
        .execute()
      await (db as any)
        .deleteFrom('platform_alert_deliveries')
        .where('dedup_key', 'like', `%pr7-c4-${SUFFIX}%`)
        .execute()
      // Audit rows — delete BEFORE the user row because FK is SET NULL
      // (so tearing down the user would leave orphan rows pointing to a
      // now-non-existent actor; we want a clean slate).
      await (db as any)
        .deleteFrom('audit_logs')
        .where('user_id', '=', ACTOR_ID)
        .execute()

      // Throwaway actor user (seeded at top of main() so override audit
      // inserts satisfy the users.id FK).
      await (db as any)
        .deleteFrom('users')
        .where('id', '=', ACTOR_ID)
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
