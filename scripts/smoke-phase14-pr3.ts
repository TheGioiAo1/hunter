/**
 * Phase 14 PR3 — Shopify Flow lite automation framework end-to-end smoke.
 *
 * Complements the per-module unit layer (packages/core/src/modules/
 * automations/*.test.ts) with a live-DB run that walks the whole
 * pipeline:
 *
 *   emit()
 *     → automation_events row  (always)
 *     → dispatch()
 *         → inline send for delay=0 flows
 *         → automation_scheduled row for delay>0 flows
 *     → scheduler.tick()
 *         → picks due automation_scheduled rows
 *         → calls executeScheduled()
 *         → email_deliveries row + automation_runs row
 *
 * Invariants asserted (roughly one letter per scope-doc requirement):
 *
 *   [A] Catalog sanity
 *       [A1] FLOW_CATALOG has 18 entries — matches scope doc §2.
 *       [A2] Every entry's templateKey resolves via
 *            `getTemplate()` in the email registry.
 *       [A3] Every entry's templateKey has audience != 'god_admin'
 *            — iron rule 5 at the catalog layer. A god_admin audience
 *            in a seller-triggered flow would mean a seller action can
 *            send the platform a platform-audience email. Disallowed.
 *       [A4] Every entry's trigger string is a valid AutomationEventType.
 *
 *   [B] Feature flag gate
 *       [B1] With AUTOMATION_FRAMEWORK_V2 off, emitIfEnabled returns
 *            false and writes NO automation_events row.
 *       [B2] With the flag on, emit writes exactly one event row.
 *
 *   [C] Inline dispatch (delay=0)
 *       [C1] emit(product.published, firstPublish=true) → product_launch
 *            fires inline → automation_runs row with outcome='sent'
 *            → email_deliveries row for template_key='product_launch'.
 *
 *   [D] Queued dispatch (delay>0)
 *       [D1] emit(order.paid, totalOrdersForCustomer=1) → one row in
 *            automation_scheduled (first_order_milestone) with
 *            status='pending' and fire_at in the future.
 *
 *   [E] Conditions skip
 *       [E1] emit(order.paid, totalOrdersForCustomer=2) → no new
 *            first_order_milestone row scheduled; an automation_runs
 *            row with outcome='skipped_conditions' is written for the
 *            flow that required totalOrdersForCustomer=1.
 *
 *   [F] Idempotency
 *       [F1] Re-emitting the same logical order.paid event writes a new
 *            automation_events row (append-only log) BUT does NOT
 *            insert a duplicate automation_scheduled row — the
 *            (shop_id, idempotency_key) UNIQUE constraint absorbs it.
 *
 *   [G] Scheduler tick drains the queue
 *       [G1] After backdating a pending row's fire_at into the past,
 *            tick() reports sent>=1 and the row's status flips to 'sent'.
 *       [G2] An automation_runs row gets written for the drained row
 *            with outcome='sent'.
 *
 *   [H] Phase 8 migration behavior
 *       [H1] With the flag on, abandoned-cart legacy `dispatchStep`
 *            short-circuits with error='skipped_framework_v2' so the
 *            same email can't send twice.
 *
 * Usage (run from server 2; local Windows can't reach the PG):
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase14-pr3.ts
 *
 * Forces EMAIL_TRANSPORT=console + AUTOMATION_FRAMEWORK_V2=1 on entry.
 * Restores prior env in finally{} so subsequent smokes see a clean
 * process env. Cleans up all seeded rows + every automation_* row it
 * created — script is re-runnable without side effects.
 */

import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  FLOW_CATALOG,
  emit,
  emitIfEnabled,
  isAutomationFrameworkEnabled,
  tick,
  type AutomationEventType,
} from '../packages/core/src/modules/automations/index.js'
import { getTemplate } from '../packages/core/src/modules/email/registry.js'

// ─── Env isolation ────────────────────────────────────────────────
const ORIGINAL_ENV = {
  EMAIL_TRANSPORT: process.env.EMAIL_TRANSPORT,
  AUTOMATION_FRAMEWORK_V2: process.env.AUTOMATION_FRAMEWORK_V2,
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
}
process.env.EMAIL_TRANSPORT = 'console'
process.env.AUTOMATION_FRAMEWORK_V2 = '1'
delete process.env.SMTP_HOST
delete process.env.SMTP_USER
delete process.env.SMTP_PASS

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_A = randomUUID()
const CUSTOMER_A = randomUUID()
const PRODUCT_A = randomUUID()

// ─── Minimal assertion helper (mirrors PR2 smoke) ─────────────────
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

// Valid event type set for catalog [A4]. Covers PR3 (12 original
// triggers) + PR6 (8 finance/ops triggers). If a later PR adds a
// new event, extend this list — keeping it explicit (rather than
// inferring from `FLOW_CATALOG`) means a typo in a catalog trigger
// still fails the smoke instead of silently passing.
const KNOWN_EVENT_TYPES: ReadonlySet<AutomationEventType> = new Set<AutomationEventType>([
  // PR3 — original lifecycle events
  'order.paid',
  'order.fulfilled',
  'order.delivered',
  'fulfillment.out_for_delivery',
  'payment.failed',
  'product.published',
  'inventory.restocked',
  'inventory.threshold_crossed',
  'customer.created',
  'customer.dormant_detected',
  'campaign.scheduled',
  'checkout.abandoned',
  // PR6 — finance / ops events
  'payout.scheduled',
  'payout.completed',
  'payout.failed',
  'chargeback.opened',
  'chargeback.lost',
  'refund.issued',
  'order.high_risk',
  'inventory.out_of_stock',
])

async function main() {
  log(`\n=== Phase 14 PR3 smoke — suffix=${SUFFIX} ===\n`)

  // -------------------------------------------------------------------------
  // [0] Seed shop + customer + product so FK-bound inserts don't fail.
  // -------------------------------------------------------------------------
  log('[0] Seeding shop + customer + product')
  await (db as any)
    .insertInto('shops')
    .values({
      id: SHOP_A,
      slug: `smoke-p14-3-${SUFFIX}`,
      name: 'PR3 Shop',
      email: `p14-3-shop-${SUFFIX}@example.test`,
      status: 'active',
      plan: 'free',
    })
    .execute()
  await (db as any)
    .insertInto('customers')
    .values({
      id: CUSTOMER_A,
      shop_id: SHOP_A,
      email: `p14-3-cust-${SUFFIX}@example.test`,
      first_name: 'Pat',
      last_name: 'Tester',
    })
    .execute()
  await (db as any)
    .insertInto('products')
    .values({
      id: PRODUCT_A,
      shop_id: SHOP_A,
      slug: `pr3-product-${SUFFIX}`,
      title: 'PR3 Test Product',
      status: 'active',
    })
    .execute()

  // -------------------------------------------------------------------------
  // [A] Catalog sanity
  // -------------------------------------------------------------------------
  log('\n[A] Catalog sanity')

  // Catalog started at 19 entries in PR3 (18 Priority 2 flows + 1
  // Phase 8 migration) and grew to 27 in PR6 (8 finance/ops flows).
  // We assert `>= 19` so this smoke stays valid as the catalog
  // continues to grow — regressions (entries removed) still fail.
  assert(
    FLOW_CATALOG.length >= 19,
    `[A1] FLOW_CATALOG has >=19 entries (got ${FLOW_CATALOG.length})`,
  )

  const unresolved: string[] = []
  const godAdmin: string[] = []
  const badTrigger: string[] = []
  for (const f of FLOW_CATALOG) {
    const tpl = getTemplate(f.templateKey)
    if (!tpl) unresolved.push(`${f.key}→${f.templateKey}`)
    else if (tpl.audience === 'god_admin') godAdmin.push(`${f.key}→${f.templateKey}`)
    if (!KNOWN_EVENT_TYPES.has(f.trigger)) badTrigger.push(`${f.key}→${f.trigger}`)
  }
  assert(
    unresolved.length === 0,
    `[A2] every catalog templateKey resolves via getTemplate (missing: ${unresolved.join(', ') || 'none'})`,
  )
  assert(
    godAdmin.length === 0,
    `[A3] no catalog entry points at a god_admin audience template (leaks: ${godAdmin.join(', ') || 'none'})`,
  )
  assert(
    badTrigger.length === 0,
    `[A4] every catalog trigger is a known AutomationEventType (unknown: ${badTrigger.join(', ') || 'none'})`,
  )

  // -------------------------------------------------------------------------
  // [B] Feature flag gate
  // -------------------------------------------------------------------------
  log('\n[B] Feature flag gate')

  // Flip off, verify emitIfEnabled is a no-op. We flip the env directly
  // because isAutomationFrameworkEnabled() reads at call time (not
  // import time) — that's the tested contract.
  process.env.AUTOMATION_FRAMEWORK_V2 = '0'
  assert(
    isAutomationFrameworkEnabled() === false,
    `[B0] isAutomationFrameworkEnabled() tracks env var at call time (off)`,
  )

  const eventCountBefore = await countAutomationEvents(SHOP_A)
  const offResult = await emitIfEnabled(db as any, {
    type: 'product.published',
    shopId: SHOP_A,
    productId: PRODUCT_A,
    firstPublish: true,
  })
  const eventCountAfterOff = await countAutomationEvents(SHOP_A)
  assert(
    offResult === false && eventCountAfterOff === eventCountBefore,
    `[B1] flag OFF: emitIfEnabled=false, no automation_events row (before=${eventCountBefore}, after=${eventCountAfterOff})`,
  )

  // Flip on for the remainder. All subsequent emits land.
  process.env.AUTOMATION_FRAMEWORK_V2 = '1'
  assert(
    isAutomationFrameworkEnabled() === true,
    `[B2a] isAutomationFrameworkEnabled() tracks env var at call time (on)`,
  )

  // -------------------------------------------------------------------------
  // [C] Inline dispatch (delay=0): customer.dormant_detected → customer_win_back
  //
  // We use customer_win_back here (not product_launch) because PR3's
  // recipient resolver is single-address: events with no customerId
  // / orderId / merchant-ops hook return null → skipped_conditions.
  // product_launch is catalog-ready but needs a subscriber-broadcast
  // layer (deferred past PR3) to have a recipient. customer_win_back:
  //   - delaySeconds=0 (inline path)
  //   - customerId on event (clean recipient resolve)
  //   - no conditions gate (default-enabled)
  // -------------------------------------------------------------------------
  log('\n[C] Inline dispatch — customer.dormant_detected → customer_win_back')

  const emitRes = await emit(db as any, {
    type: 'customer.dormant_detected',
    shopId: SHOP_A,
    customerId: CUSTOMER_A,
    lastOrderAt: new Date('2024-01-01T00:00:00Z'),
  })
  assert(
    !!emitRes.eventId && emitRes.dispatched === true,
    `[C1a] emit returns eventId + dispatched=true`,
  )

  const runsForWinBack = await (db as any)
    .selectFrom('automation_runs')
    .select(['outcome', 'reason', 'flow_key', 'delivery_id'])
    .where('shop_id', '=', SHOP_A)
    .where('flow_key', '=', 'customer_win_back')
    .execute()
  assert(
    runsForWinBack.length === 1 &&
      runsForWinBack[0].outcome === 'sent',
    `[C1b] automation_runs has 1 row for customer_win_back with outcome=sent (got ${runsForWinBack.length}, outcome=${runsForWinBack[0]?.outcome ?? 'n/a'}, reason=${runsForWinBack[0]?.reason ?? 'n/a'})`,
  )

  const winBackDeliveryId = runsForWinBack[0]?.delivery_id
  if (winBackDeliveryId) {
    const delivery = await (db as any)
      .selectFrom('email_deliveries')
      .select(['template_key', 'status', 'provider'])
      .where('id', '=', winBackDeliveryId)
      .executeTakeFirst()
    assert(
      delivery?.template_key === 'customer_win_back' &&
        delivery?.status === 'sent' &&
        delivery?.provider === 'console',
      `[C1c] email_deliveries row: template_key=customer_win_back, status=sent, provider=console (got template=${delivery?.template_key}, status=${delivery?.status}, provider=${delivery?.provider})`,
    )
  } else {
    assert(false, `[C1c] automation_runs row missing delivery_id — can't verify email_deliveries`)
  }

  // -------------------------------------------------------------------------
  // [D] Queued dispatch (delay>0): order.paid totalOrdersForCustomer=1
  //     → first_order_milestone, delay=2h
  // -------------------------------------------------------------------------
  log('\n[D] Queued dispatch — order.paid → first_order_milestone (delay=2h)')

  const orderIdFirst = randomUUID()
  await emit(db as any, {
    type: 'order.paid',
    shopId: SHOP_A,
    orderId: orderIdFirst,
    customerId: CUSTOMER_A,
    totalPrice: 1995,
    currency: 'USD',
    totalOrdersForCustomer: 1,
  })

  const scheduledFirstOrder = await (db as any)
    .selectFrom('automation_scheduled')
    .select(['status', 'fire_at', 'idempotency_key'])
    .where('shop_id', '=', SHOP_A)
    .where('flow_key', '=', 'first_order_milestone')
    .execute()
  assert(
    scheduledFirstOrder.length === 1 && scheduledFirstOrder[0].status === 'pending',
    `[D1a] automation_scheduled has exactly 1 first_order_milestone pending row (got ${scheduledFirstOrder.length})`,
  )
  const fireAtDate = scheduledFirstOrder[0]
    ? new Date(scheduledFirstOrder[0].fire_at as any)
    : null
  assert(
    !!fireAtDate && fireAtDate.getTime() > Date.now(),
    `[D1b] fire_at is in the future (catalog delay=2h)`,
  )

  // -------------------------------------------------------------------------
  // [E] Conditions skip — totalOrdersForCustomer=2 does NOT schedule
  //     first_order_milestone (default condition: =1)
  // -------------------------------------------------------------------------
  log('\n[E] Conditions skip — order.paid with totalOrdersForCustomer=2')

  const orderIdSecond = randomUUID()
  await emit(db as any, {
    type: 'order.paid',
    shopId: SHOP_A,
    orderId: orderIdSecond,
    customerId: CUSTOMER_A,
    totalPrice: 2500,
    currency: 'USD',
    totalOrdersForCustomer: 2,
  })

  const scheduledAfter = await (db as any)
    .selectFrom('automation_scheduled')
    .select(['id'])
    .where('shop_id', '=', SHOP_A)
    .where('flow_key', '=', 'first_order_milestone')
    .execute()
  assert(
    scheduledAfter.length === 1,
    `[E1a] second order.paid didn't add a new first_order_milestone schedule (still ${scheduledAfter.length})`,
  )

  const skippedRuns = await (db as any)
    .selectFrom('automation_runs')
    .select(['outcome', 'reason'])
    .where('shop_id', '=', SHOP_A)
    .where('flow_key', '=', 'first_order_milestone')
    .where('outcome', '=', 'skipped_conditions')
    .execute()
  assert(
    skippedRuns.length >= 1,
    `[E1b] ≥1 automation_runs row with outcome=skipped_conditions for first_order_milestone (got ${skippedRuns.length})`,
  )

  // -------------------------------------------------------------------------
  // [F] Idempotency — re-emit the SAME order's order.paid. A new event
  //     row is persisted (append-only), but scheduled row count doesn't
  //     climb because (shop_id, idempotency_key) is UNIQUE.
  // -------------------------------------------------------------------------
  log('\n[F] Idempotency — repeat order.paid for the first order')

  const eventsBefore = await countAutomationEvents(SHOP_A)
  await emit(db as any, {
    type: 'order.paid',
    shopId: SHOP_A,
    orderId: orderIdFirst,
    customerId: CUSTOMER_A,
    totalPrice: 1995,
    currency: 'USD',
    totalOrdersForCustomer: 1,
  })
  const eventsAfter = await countAutomationEvents(SHOP_A)
  assert(
    eventsAfter === eventsBefore + 1,
    `[F1a] automation_events row always appended on re-emit (${eventsBefore} → ${eventsAfter})`,
  )

  const scheduledFinal = await (db as any)
    .selectFrom('automation_scheduled')
    .select(['id'])
    .where('shop_id', '=', SHOP_A)
    .where('flow_key', '=', 'first_order_milestone')
    .execute()
  assert(
    scheduledFinal.length === 1,
    `[F1b] still exactly 1 first_order_milestone scheduled row (idempotency held; got ${scheduledFinal.length})`,
  )

  // -------------------------------------------------------------------------
  // [G] Scheduler tick — backdate fire_at, tick() drains the queue.
  // -------------------------------------------------------------------------
  log('\n[G] Scheduler tick drains the queue')

  // Backdate by 5 minutes so fire_at <= now().
  const pastIso = new Date(Date.now() - 5 * 60 * 1000).toISOString()
  await (db as any)
    .updateTable('automation_scheduled')
    .set({ fire_at: pastIso } as any)
    .where('shop_id', '=', SHOP_A)
    .where('flow_key', '=', 'first_order_milestone')
    .where('status', '=', 'pending')
    .execute()

  const tickResult = await tick(db as any)
  assert(
    tickResult.sent >= 1,
    `[G1a] tick() reports sent>=1 (got sent=${tickResult.sent}, picked=${tickResult.picked}, failed=${tickResult.failed})`,
  )

  const scheduledAfterTick = await (db as any)
    .selectFrom('automation_scheduled')
    .select(['status'])
    .where('shop_id', '=', SHOP_A)
    .where('flow_key', '=', 'first_order_milestone')
    .executeTakeFirst()
  assert(
    scheduledAfterTick?.status === 'sent',
    `[G1b] drained automation_scheduled row flipped to status=sent (got ${scheduledAfterTick?.status ?? 'n/a'})`,
  )

  const sentRun = await (db as any)
    .selectFrom('automation_runs')
    .select(['outcome'])
    .where('shop_id', '=', SHOP_A)
    .where('flow_key', '=', 'first_order_milestone')
    .where('outcome', '=', 'sent')
    .execute()
  assert(
    sentRun.length >= 1,
    `[G2] automation_runs now has a sent row for first_order_milestone (got ${sentRun.length})`,
  )

  // -------------------------------------------------------------------------
  // [H] Phase 8 migration — legacy dispatchStep short-circuits with
  //     skipped_framework_v2 when the flag is on.
  // -------------------------------------------------------------------------
  log('\n[H] Phase 8 migration — legacy dispatchStep short-circuits')

  const { dispatchStep } = await import('../packages/core/src/modules/marketing/abandoned-cart.js')
  const fakeEnrollmentId = randomUUID()
  const stepOutcome = await dispatchStep(
    db as any,
    SHOP_A,
    fakeEnrollmentId,
    {
      id: 'cart_1_reminder',
      templateSubject: 'ignored',
      templateBody: 'ignored',
      delayMinutes: 60,
    } as any,
    async () => 'unused',
    {} as any,
  )
  assert(
    stepOutcome.ok === false && (stepOutcome as any).error === 'skipped_framework_v2',
    `[H1] legacy dispatchStep returns {ok:false, error:'skipped_framework_v2'} when flag ON (got ok=${stepOutcome.ok}, error=${(stepOutcome as any).error ?? 'n/a'})`,
  )

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  log(`\n=== Phase 14 PR3 smoke: ${total - failed}/${total} passed (${failed} failed) ===\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

async function countAutomationEvents(shopId: string): Promise<number> {
  // `(db as any)` loses the Kysely fn helper typing, so we use a raw
  // count(*) via Kysely's untyped .select(sql`…`) path — simpler than
  // wrangling the ExpressionBuilder generics on an erased channel.
  const row = await (db as any)
    .selectFrom('automation_events')
    .select((eb: any) => eb.fn.countAll().as('c'))
    .where('shop_id', '=', shopId)
    .executeTakeFirst()
  return Number(row?.c ?? 0)
}

main()
  .catch((err) => {
    console.error('Phase 14 PR3 smoke — fatal error:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    log('\n[cleanup] Removing seeded rows')
    try {
      // automation_* cascade from shop deletion, but we wipe explicitly
      // so a partial-failure run doesn't leave orphaned rows if a later
      // migration ever drops the FK cascade.
      await (db as any).deleteFrom('automation_runs').where('shop_id', '=', SHOP_A).execute()
      await (db as any).deleteFrom('automation_scheduled').where('shop_id', '=', SHOP_A).execute()
      await (db as any).deleteFrom('automation_events').where('shop_id', '=', SHOP_A).execute()
      await (db as any).deleteFrom('automation_flows').where('shop_id', '=', SHOP_A).execute()
      await (db as any).deleteFrom('email_deliveries').where('shop_id', '=', SHOP_A).execute()
      await (db as any).deleteFrom('email_preferences').where('shop_id', '=', SHOP_A).execute()
      await (db as any).deleteFrom('products').where('id', '=', PRODUCT_A).execute()
      await (db as any).deleteFrom('customers').where('id', '=', CUSTOMER_A).execute()
      await (db as any).deleteFrom('shops').where('id', '=', SHOP_A).execute()
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
