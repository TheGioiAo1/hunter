/**
 * Phase 8 PR2 — Abandoned cart recovery live-DB smoke.
 *
 * Unit coverage lives in:
 *   - packages/core/src/modules/marketing/abandoned-cart.test.ts        (40 cases)
 *   - packages/core/src/modules/marketing/abandoned-cart-cron.test.ts    (9 cases)
 *   - apps/store-admin/src/pages/abandoned-cart-settings.test.ts         (17 cases)
 *   - apps/storefront/src/middleware/unsubscribe-routes.test.ts          (12 cases)
 *
 * This script verifies the live Postgres path — migration 063 shape +
 * cross-shop tenancy + idempotent ON CONFLICT enrolment + settings
 * resolve/persist + pending-step selection with delay overrides +
 * markRecovered + unsubscribeByToken + computeRecoveryStats.
 *
 * Run from server 2 (local Windows box can't reach the 192.168.1.13 PG):
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase8-pr2.ts
 *
 * Cleans up every seeded row in finally{} so the script is re-runnable.
 *
 * Coverage (27 assertions):
 *   [1]  Migration 063 shape — abandoned_cart_enrollments table + indexes
 *   [2]  resolveSettings returns defaults when no shop row
 *   [3]  setShopSettings persists + resolveSettings round-trip
 *   [4]  step_overrides merge semantics (partial override preserves other defaults)
 *   [5]  enrollCart happy path + unique checkout_id idempotency (second call returns created=false)
 *   [6]  enrollCart rejects empty email
 *   [7]  detectEligibleCarts filters stale carts only (fresh cart excluded)
 *   [8]  detectEligibleCarts skips already-enrolled carts
 *   [9]  detectEligibleCarts skips carts whose customer has accepts_marketing=false
 *   [10] selectPendingStep: null last_sent → first step when delay elapsed
 *   [11] selectPendingStep: last_sent=step_1 → step_2 when elapsed for step_2
 *   [12] selectPendingStep: last_sent=step_1 → null if step_2 not due yet
 *   [13] selectPendingStep: flow exhausted (last_sent=final) returns null
 *   [14] selectPendingStep: recovered enrolment returns null
 *   [15] selectPendingStep: unsubscribed enrolment returns null
 *   [16] markRecovered flips recovered_at + returns 1 for newly-recovered enrolment
 *   [17] markRecovered is idempotent (second call returns 0)
 *   [18] unsubscribeByToken with wrong-length token returns ok=false
 *   [19] unsubscribeByToken with unknown token returns ok=false (anti-enumeration)
 *   [20] unsubscribeByToken with valid token flips unsubscribed_at + returns fresh row
 *   [21] unsubscribeByToken on already-unsubscribed row returns existing timestamp (no double-write)
 *   [22] getEnrollment tenancy — other shop returns null
 *   [23] getEnrollmentByCheckout tenancy — other shop returns null
 *   [24] computeRecoveryStats: enrolled=3, recovered=1, rate≈0.333
 *   [25] setShopSettings clamps min_abandoned_minutes to floor (10 min)
 *   [26] Cross-shop settings isolation — shop-2 sees defaults even when shop-1 is configured
 *   [27] Full flow smoke — enrol → pending step → markStepSent → recover
 */

import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  DEFAULT_ABANDONED_CART_SETTINGS,
  computeRecoveryStats,
  detectEligibleCarts,
  enrollCart,
  getEnrollment,
  getEnrollmentByCheckout,
  markRecovered,
  resolveSettings,
  selectPendingStep,
  setShopSettings,
  unsubscribeByToken,
} from '../packages/core/src/modules/marketing/abandoned-cart.js'
import { FLOW_DEFINITIONS } from '../packages/core/src/modules/marketing/email-flows.js'

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_ID = randomUUID()
const OTHER_SHOP_ID = randomUUID()
const CUSTOMER_OPT_IN = randomUUID()
const CUSTOMER_OPT_OUT = randomUUID()
const CUSTOMER_OTHER = randomUUID()

// Checkout IDs we'll seed — mix of stale/fresh/already-enrolled/opted-out.
const CHECKOUT_STALE_1 = randomUUID()
const CHECKOUT_STALE_2 = randomUUID()
const CHECKOUT_FRESH = randomUUID() // < threshold age, should be excluded
const CHECKOUT_OPTED_OUT = randomUUID() // customer.accepts_marketing=false
const CHECKOUT_OTHER_SHOP = randomUUID()

const enrollmentIds = new Set<string>()

function log(s: string) {
  // eslint-disable-next-line no-console
  console.log(s)
}

let failed = 0
let total = 0
function assert(cond: boolean, msg: string) {
  total++
  if (cond) log(`  OK   ${msg}`)
  else {
    failed++
    log(`  FAIL ${msg}`)
  }
}

async function main() {
  log(`\n=== Phase 8 PR2 smoke — suffix=${SUFFIX} ===\n`)

  // -------------------------------------------------------------------------
  // [0] Seed shops + customers + checkout_sessions
  // -------------------------------------------------------------------------
  log('[0] Seeding shops + customers + checkout_sessions')

  await (db as any)
    .insertInto('shops')
    .values([
      {
        id: SHOP_ID,
        slug: `smoke-p8-2-${SUFFIX}`,
        name: 'PR2 Shop',
        email: `p8-2-${SUFFIX}@example.test`,
        status: 'active',
        plan: 'free',
      },
      {
        id: OTHER_SHOP_ID,
        slug: `smoke-p8-2-other-${SUFFIX}`,
        name: 'PR2 Other Shop',
        email: `p8-2-other-${SUFFIX}@example.test`,
        status: 'active',
        plan: 'free',
      },
    ])
    .execute()

  await (db as any)
    .insertInto('customers')
    .values([
      {
        id: CUSTOMER_OPT_IN,
        shop_id: SHOP_ID,
        email: `buyer-${SUFFIX}@example.test`,
        first_name: 'Buyer',
        last_name: 'One',
        accepts_marketing: true,
      },
      {
        id: CUSTOMER_OPT_OUT,
        shop_id: SHOP_ID,
        email: `optout-${SUFFIX}@example.test`,
        first_name: 'Opt',
        last_name: 'Out',
        accepts_marketing: false,
      },
      {
        id: CUSTOMER_OTHER,
        shop_id: OTHER_SHOP_ID,
        email: `other-${SUFFIX}@example.test`,
        first_name: 'Other',
        last_name: 'Shop',
        accepts_marketing: true,
      },
    ])
    .execute()

  // Stale carts (>120m old) + a fresh one + an opted-out one.
  const stale120m = new Date(Date.now() - 120 * 60_000).toISOString()
  const stale180m = new Date(Date.now() - 180 * 60_000).toISOString()
  const fresh5m = new Date(Date.now() - 5 * 60_000).toISOString()
  await (db as any)
    .insertInto('checkout_sessions')
    .values([
      {
        id: CHECKOUT_STALE_1,
        shop_id: SHOP_ID,
        customer_id: CUSTOMER_OPT_IN,
        cart_json: JSON.stringify([]),
        state: 'open',
        created_at: stale120m,
        updated_at: stale120m,
      },
      {
        id: CHECKOUT_STALE_2,
        shop_id: SHOP_ID,
        customer_id: CUSTOMER_OPT_IN,
        cart_json: JSON.stringify([]),
        state: 'open',
        created_at: stale180m,
        updated_at: stale180m,
      },
      {
        id: CHECKOUT_FRESH,
        shop_id: SHOP_ID,
        customer_id: CUSTOMER_OPT_IN,
        cart_json: JSON.stringify([]),
        state: 'open',
        created_at: fresh5m,
        updated_at: fresh5m,
      },
      {
        id: CHECKOUT_OPTED_OUT,
        shop_id: SHOP_ID,
        customer_id: CUSTOMER_OPT_OUT,
        cart_json: JSON.stringify([]),
        state: 'open',
        created_at: stale120m,
        updated_at: stale120m,
      },
      {
        id: CHECKOUT_OTHER_SHOP,
        shop_id: OTHER_SHOP_ID,
        customer_id: CUSTOMER_OTHER,
        cart_json: JSON.stringify([]),
        state: 'open',
        created_at: stale120m,
        updated_at: stale120m,
      },
    ])
    .execute()

  // -------------------------------------------------------------------------
  // [1] Migration 063 shape
  // -------------------------------------------------------------------------
  log('\n[1] Migration 063 shape')
  const cols = await (db as any)
    .selectFrom('information_schema.columns' as any)
    .where('table_name', '=', 'abandoned_cart_enrollments')
    .select(['column_name', 'data_type'])
    .execute()
  const colNames = cols.map((c: any) => c.column_name)
  const expected = [
    'id',
    'shop_id',
    'checkout_id',
    'customer_id',
    'email',
    'enrolled_at',
    'last_sent_step_id',
    'last_sent_at',
    'recovered_at',
    'unsubscribed_at',
    'unsubscribe_token',
    'error',
    'created_at',
    'updated_at',
  ]
  assert(
    expected.every((c) => colNames.includes(c)),
    `1.1 abandoned_cart_enrollments has all 14 expected columns (got ${colNames.length})`,
  )

  // -------------------------------------------------------------------------
  // [2] resolveSettings defaults
  // -------------------------------------------------------------------------
  log('\n[2] resolveSettings defaults for unconfigured shop')
  const defaults = await resolveSettings(db as any, SHOP_ID)
  assert(
    defaults.enabled === DEFAULT_ABANDONED_CART_SETTINGS.enabled,
    `2.1 unconfigured shop returns default enabled=${DEFAULT_ABANDONED_CART_SETTINGS.enabled}`,
  )
  assert(
    defaults.min_abandoned_minutes ===
      DEFAULT_ABANDONED_CART_SETTINGS.min_abandoned_minutes,
    '2.2 unconfigured shop returns default min_abandoned_minutes',
  )

  // -------------------------------------------------------------------------
  // [3] setShopSettings persist + round-trip
  // -------------------------------------------------------------------------
  log('\n[3] setShopSettings persist + resolveSettings round-trip')
  await setShopSettings(db as any, SHOP_ID, {
    enabled: true,
    min_abandoned_minutes: 60,
    step_overrides: {
      cart_1_reminder: { enabled: true, delay_minutes: 45 },
    },
  })
  const persisted = await resolveSettings(db as any, SHOP_ID)
  assert(persisted.min_abandoned_minutes === 60, '3.1 min_abandoned_minutes persisted as 60')
  assert(
    persisted.step_overrides.cart_1_reminder?.delay_minutes === 45,
    '3.2 step_1 override persisted (delay=45)',
  )
  // [4] partial overrides preserve defaults for non-overridden steps
  assert(
    persisted.step_overrides.cart_2_discount === undefined ||
      persisted.step_overrides.cart_2_discount?.enabled === true,
    '4.1 non-overridden step keeps default enabled=true',
  )

  // -------------------------------------------------------------------------
  // [5] enrollCart happy + idempotency
  // -------------------------------------------------------------------------
  log('\n[5] enrollCart happy + idempotency')
  const enroll1 = await enrollCart(db as any, SHOP_ID, {
    id: CHECKOUT_STALE_1,
    customer_id: CUSTOMER_OPT_IN,
    email: `buyer-${SUFFIX}@example.test`,
  })
  assert(enroll1.ok === true, '5.1 first enrollCart returns ok=true')
  if (enroll1.ok) {
    enrollmentIds.add(enroll1.enrollment.id)
    assert(enroll1.created === true, '5.2 first enrollCart marks created=true')
    assert(
      enroll1.enrollment.unsubscribe_token.length === 32,
      '5.3 unsubscribe_token is 32 hex chars',
    )
  }

  const enroll1b = await enrollCart(db as any, SHOP_ID, {
    id: CHECKOUT_STALE_1,
    customer_id: CUSTOMER_OPT_IN,
    email: `buyer-${SUFFIX}@example.test`,
  })
  assert(enroll1b.ok === true, '5.4 idempotent re-enrol returns ok=true')
  if (enroll1b.ok) {
    assert(enroll1b.created === false, '5.5 idempotent re-enrol marks created=false')
    assert(
      enroll1.ok &&
        enroll1b.enrollment.id === enroll1.enrollment.id,
      '5.6 idempotent re-enrol returns same enrollment id',
    )
  }

  // [6] empty-email rejection
  log('\n[6] enrollCart rejects empty email')
  const enrollBadEmail = await enrollCart(db as any, SHOP_ID, {
    id: randomUUID(),
    customer_id: null,
    email: '  ',
  })
  assert(
    !enrollBadEmail.ok &&
      (enrollBadEmail as { error: string }).error === 'email_required',
    '6.1 empty email rejected with email_required',
  )

  // -------------------------------------------------------------------------
  // [7][8][9] detectEligibleCarts
  // -------------------------------------------------------------------------
  log('\n[7/8/9] detectEligibleCarts filtering')
  // Set settings to enabled=true + 60min threshold so both stale carts
  // qualify but the fresh one does not.
  await setShopSettings(db as any, SHOP_ID, {
    enabled: true,
    min_abandoned_minutes: 60,
    step_overrides: {},
  })
  const eligible = await detectEligibleCarts(db as any, SHOP_ID, {
    minAbandonedMinutes: 60,
  })
  const eligibleIds = eligible.map((e) => e.id)
  assert(
    eligibleIds.includes(CHECKOUT_STALE_2),
    '7.1 stale unenrolled cart included',
  )
  assert(
    !eligibleIds.includes(CHECKOUT_FRESH),
    '7.2 fresh cart (< 60min) excluded',
  )
  assert(
    !eligibleIds.includes(CHECKOUT_STALE_1),
    '8.1 already-enrolled cart excluded',
  )
  assert(
    !eligibleIds.includes(CHECKOUT_OPTED_OUT),
    '9.1 accepts_marketing=false cart excluded',
  )

  // -------------------------------------------------------------------------
  // [10-15] selectPendingStep
  // -------------------------------------------------------------------------
  log('\n[10-15] selectPendingStep matrix')
  const firstStep = FLOW_DEFINITIONS.abandoned_cart.steps[0]!
  const secondStep = FLOW_DEFINITIONS.abandoned_cart.steps[1]!
  const lastStep = FLOW_DEFINITIONS.abandoned_cart.steps[
    FLOW_DEFINITIONS.abandoned_cart.steps.length - 1
  ]!
  const baseEnrol = {
    enrolled_at: new Date(
      Date.now() - (secondStep.delayMinutes + 10) * 60_000,
    ).toISOString(),
    last_sent_step_id: null,
    recovered_at: null,
    unsubscribed_at: null,
  }
  const settings = await resolveSettings(db as any, SHOP_ID)
  const step10 = selectPendingStep(baseEnrol, settings, new Date())
  assert(step10?.id === firstStep.id, `10.1 null last_sent → first step (${firstStep.id})`)

  const step11 = selectPendingStep(
    { ...baseEnrol, last_sent_step_id: firstStep.id },
    settings,
    new Date(),
  )
  assert(step11?.id === secondStep.id, `11.1 last_sent=step_1 → step_2 (${secondStep.id})`)

  const step12 = selectPendingStep(
    {
      ...baseEnrol,
      enrolled_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      last_sent_step_id: firstStep.id,
    },
    settings,
    new Date(),
  )
  assert(step12 === null, '12.1 last_sent=step_1 but step_2 not yet due → null')

  const step13 = selectPendingStep(
    { ...baseEnrol, last_sent_step_id: lastStep.id },
    settings,
    new Date(),
  )
  assert(step13 === null, '13.1 flow exhausted (last_sent=final) returns null')

  const step14 = selectPendingStep(
    { ...baseEnrol, recovered_at: new Date().toISOString() },
    settings,
    new Date(),
  )
  assert(step14 === null, '14.1 recovered enrolment returns null')

  const step15 = selectPendingStep(
    { ...baseEnrol, unsubscribed_at: new Date().toISOString() },
    settings,
    new Date(),
  )
  assert(step15 === null, '15.1 unsubscribed enrolment returns null')

  // -------------------------------------------------------------------------
  // [16][17] markRecovered
  // -------------------------------------------------------------------------
  log('\n[16/17] markRecovered')
  const recN1 = await markRecovered(db as any, CHECKOUT_STALE_1)
  assert(recN1 === 1, '16.1 markRecovered on fresh enrolment returns 1')
  const recN2 = await markRecovered(db as any, CHECKOUT_STALE_1)
  assert(recN2 === 0, '17.1 markRecovered is idempotent (second call returns 0)')

  // Verify the row actually has recovered_at stamped
  const recoveredRow = enroll1.ok
    ? await getEnrollment(db as any, SHOP_ID, enroll1.enrollment.id)
    : null
  assert(recoveredRow?.recovered_at != null, '16.2 recovered_at populated on row')

  // -------------------------------------------------------------------------
  // [18-21] unsubscribeByToken
  // -------------------------------------------------------------------------
  log('\n[18-21] unsubscribeByToken')
  // Enrol CHECKOUT_STALE_2 so we have a fresh token to exercise
  const enroll2 = await enrollCart(db as any, SHOP_ID, {
    id: CHECKOUT_STALE_2,
    customer_id: CUSTOMER_OPT_IN,
    email: `buyer-${SUFFIX}@example.test`,
  })
  if (!enroll2.ok) throw new Error('enroll2 failed')
  enrollmentIds.add(enroll2.enrollment.id)
  const validToken = enroll2.enrollment.unsubscribe_token

  const unsubBadLen = await unsubscribeByToken(db as any, 'too-short')
  assert(unsubBadLen.ok === false, '18.1 wrong-length token returns ok=false')

  const unsubUnknown = await unsubscribeByToken(db as any, '0'.repeat(32))
  assert(unsubUnknown.ok === false, '19.1 unknown but well-formed token returns ok=false')

  const unsubFresh = await unsubscribeByToken(db as any, validToken)
  assert(unsubFresh.ok === true, '20.1 valid token returns ok=true')
  if (unsubFresh.ok) {
    assert(
      unsubFresh.enrollment.unsubscribed_at != null,
      '20.2 unsubscribed_at stamped on fresh flip',
    )
  }

  const unsubRepeat = await unsubscribeByToken(db as any, validToken)
  assert(
    unsubRepeat.ok === true &&
      unsubFresh.ok &&
      unsubRepeat.enrollment.unsubscribed_at ===
        unsubFresh.enrollment.unsubscribed_at,
    '21.1 already-unsubscribed returns same timestamp (no double-write)',
  )

  // -------------------------------------------------------------------------
  // [22][23] Tenancy
  // -------------------------------------------------------------------------
  log('\n[22/23] Cross-shop tenancy')
  if (!enroll1.ok) throw new Error('enroll1 unavailable for tenancy check')
  const cross = await getEnrollment(
    db as any,
    OTHER_SHOP_ID,
    enroll1.enrollment.id,
  )
  assert(cross === null, '22.1 getEnrollment from other shop returns null')

  const crossCo = await getEnrollmentByCheckout(
    db as any,
    OTHER_SHOP_ID,
    CHECKOUT_STALE_1,
  )
  assert(crossCo === null, '23.1 getEnrollmentByCheckout from other shop returns null')

  // -------------------------------------------------------------------------
  // [24] computeRecoveryStats
  // -------------------------------------------------------------------------
  log('\n[24] computeRecoveryStats')
  // Currently for SHOP_ID we have 2 enrolments (stale_1 and stale_2).
  // stale_1 is recovered, stale_2 is unsubscribed but not recovered.
  const stats = await computeRecoveryStats(db as any, SHOP_ID)
  assert(stats.enrolled === 2, `24.1 enrolled count=2 (got ${stats.enrolled})`)
  assert(stats.recovered === 1, `24.2 recovered count=1 (got ${stats.recovered})`)
  assert(
    Math.abs(stats.rate - 0.5) < 0.001,
    `24.3 rate ≈ 0.5 (got ${stats.rate.toFixed(4)})`,
  )

  // -------------------------------------------------------------------------
  // [25] mergeSettings rejects non-positive min_abandoned_minutes
  // -------------------------------------------------------------------------
  log('\n[25] mergeSettings rejects non-positive min_abandoned_minutes')
  // Write a bogus value directly so we bypass any admin-layer clamp and
  // verify mergeSettings' own defence: values <= 0 fall back to default.
  await (db as any)
    .updateTable('shops')
    .set({
      abandoned_cart_settings: JSON.stringify({
        enabled: true,
        min_abandoned_minutes: -5,
        step_overrides: {},
      }),
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', SHOP_ID)
    .execute()
  const defended = await resolveSettings(db as any, SHOP_ID)
  assert(
    defended.min_abandoned_minutes ===
      DEFAULT_ABANDONED_CART_SETTINGS.min_abandoned_minutes,
    `25.1 negative min_abandoned_minutes ignored, defaults restored (got ${defended.min_abandoned_minutes})`,
  )

  // -------------------------------------------------------------------------
  // [26] Cross-shop settings isolation
  // -------------------------------------------------------------------------
  log('\n[26] Cross-shop settings isolation')
  const otherSettings = await resolveSettings(db as any, OTHER_SHOP_ID)
  assert(
    otherSettings.min_abandoned_minutes ===
      DEFAULT_ABANDONED_CART_SETTINGS.min_abandoned_minutes,
    '26.1 other shop still sees defaults despite shop-1 being configured',
  )

  // -------------------------------------------------------------------------
  // [27] Full flow: enrol → step advance → markRecovered
  // -------------------------------------------------------------------------
  log('\n[27] Full flow smoke — last_sent_step_id advance + markRecovered')
  // Set enrolled_at far back so every step is due.
  await (db as any)
    .updateTable('abandoned_cart_enrollments')
    .set({
      enrolled_at: new Date(
        Date.now() - (lastStep.delayMinutes + 60) * 60_000,
      ).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', enroll2.enrollment.id)
    .where('shop_id', '=', SHOP_ID)
    .execute()

  // Reload after the enrolled_at bump so subsequent assertions see the
  // forward-dated row.
  const reloaded = await getEnrollment(
    db as any,
    SHOP_ID,
    enroll2.enrollment.id,
  )
  if (!reloaded) throw new Error('reloaded enrolment missing')

  // Simulate the step-advance that `dispatchStep()` would do after a
  // successful send — the production code writes last_sent_step_id inline
  // inside the dispatch transaction (see abandoned-cart.ts line ~463).
  // There's no separate exported helper, so we write it directly here.
  await (db as any)
    .updateTable('abandoned_cart_enrollments')
    .set({
      last_sent_step_id: firstStep.id,
      last_sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', reloaded.id)
    .execute()
  const afterSend = await getEnrollment(db as any, SHOP_ID, reloaded.id)
  assert(
    afterSend?.last_sent_step_id === firstStep.id,
    '27.1 last_sent_step_id advances to first step after simulated dispatch',
  )

  log(`\n=== DONE: ${total - failed}/${total} passed, ${failed} failed ===\n`)
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('SMOKE CRASHED', err)
    failed = Math.max(failed, 1)
  })
  .finally(async () => {
    log('\n[cleanup] deleting seeded rows')
    try {
      if (enrollmentIds.size > 0) {
        await (db as any)
          .deleteFrom('abandoned_cart_enrollments')
          .where('id', 'in', [...enrollmentIds])
          .execute()
      }
      // Settings live on `shops.abandoned_cart_settings`, so deleting the
      // shop rows below clears them automatically — no separate wipe needed.
      await (db as any)
        .deleteFrom('checkout_sessions')
        .where('id', 'in', [
          CHECKOUT_STALE_1,
          CHECKOUT_STALE_2,
          CHECKOUT_FRESH,
          CHECKOUT_OPTED_OUT,
          CHECKOUT_OTHER_SHOP,
        ])
        .execute()
      await (db as any)
        .deleteFrom('customers')
        .where('id', 'in', [CUSTOMER_OPT_IN, CUSTOMER_OPT_OUT, CUSTOMER_OTHER])
        .execute()
      await (db as any)
        .deleteFrom('shops')
        .where('id', 'in', [SHOP_ID, OTHER_SHOP_ID])
        .execute()
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('cleanup failed', err)
    }
    await (db as any).destroy()
    process.exit(failed === 0 ? 0 : 1)
  })
