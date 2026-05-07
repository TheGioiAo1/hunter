/**
 * Gbox Platform — Automation runner (Phase 14 PR3)
 *
 * The runner is the glue between `emit(db, event)` (which persists the
 * event row) and `sendTemplatedEmail(db, …)` (which delivers the mail).
 *
 *   dispatch(db, { eventId, event })
 *     ↓
 *     for each flow in flowsForEventType(event.type):
 *       1. Load per-shop override from automation_flows (if any).
 *       2. Compute effective (enabled, delaySeconds, conditions).
 *       3. If disabled → write automation_runs(outcome=skipped_disabled).
 *       4. Load context (shop, customer, etc.) — narrow, only what
 *          conditions or variables() need.
 *       5. Evaluate conditions. If false →
 *          automation_runs(outcome=skipped_conditions).
 *       6. Compute idempotency key.
 *       7. If delaySeconds === 0 → dispatchNow:
 *          - loadRecipient()
 *          - sendTemplatedEmail(templateKey, to, shopId, variables,
 *            idempotencyKey)
 *          - record run with outcome=sent/failed + delivery_id.
 *       8. else → enqueueDelayed:
 *          - INSERT automation_scheduled (ON CONFLICT DO NOTHING — if
 *            the idempotency_key already exists, we don't double-queue;
 *            record outcome=skipped_dedup).
 *          - record run with outcome=sent-ish and scheduled_id linked.
 *            (Technically "queued" not "sent"; we reuse 'sent' with
 *            reason='queued_for_delayed_send' to keep the outcome
 *            enum narrow.)
 *
 * The scheduler (scheduler.ts) later eats the delayed queue and calls
 * `executeScheduled(db, row)` from this module to actually send.
 *
 * Iron rule 5: the runner NEVER selects god-admin templates. The
 * flow-catalog already excludes them (asserted in the catalog test),
 * and `sendTemplatedEmail` applies the same filter server-side — so
 * even a hostile `automation_flows.conditions` override pointing at a
 * god-admin-only recipient won't leak god-admin templates into seller
 * inboxes.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { AutomationEvent } from './events.js'
import {
  flowsForEventType,
  FLOW_CATALOG_BY_KEY,
  type FlowCatalogEntry,
} from './flow-catalog.js'
import {
  evaluateCondition,
  type ConditionContext,
  type ConditionNode,
} from './conditions.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DispatchInput {
  eventId: string
  event: AutomationEvent
}

export interface DispatchResult {
  /** Total flows considered for this event (matched by trigger type). */
  flowsConsidered: number
  /** Subset actually sent immediately (delaySeconds=0 + conditions met). */
  sentNow: number
  /** Subset enqueued to automation_scheduled (delaySeconds>0 + conditions met). */
  queued: number
  /** Subset skipped for any reason (disabled, conditions, dedup). */
  skipped: number
  /** Subset that threw during send or insert. */
  failed: number
}

/**
 * Main entry called by `emit()`. Fans out a single event to every
 * matching flow and records the outcome of each.
 */
export async function dispatch(
  db: Kysely<Database>,
  input: DispatchInput,
): Promise<DispatchResult> {
  const { event, eventId } = input
  const flows = flowsForEventType(event.type)
  const result: DispatchResult = {
    flowsConsidered: flows.length,
    sentNow: 0,
    queued: 0,
    skipped: 0,
    failed: 0,
  }

  if (flows.length === 0) return result

  // Load every shop override in one query — avoids N+1 on a busy event.
  const overridesByKey = await loadShopOverrides(db, event.shopId, flows.map((f) => f.key))

  for (const flow of flows) {
    try {
      const outcome = await runOneFlow(db, {
        flow,
        event,
        eventId,
        override: overridesByKey.get(flow.key),
      })
      if (outcome === 'sent_now') result.sentNow++
      else if (outcome === 'queued') result.queued++
      else if (outcome === 'failed') result.failed++
      else result.skipped++
    } catch (err) {
      // runOneFlow already writes automation_runs on caught paths;
      // this outer catch handles a programming error (e.g. variables()
      // threw synchronously). Record it and keep going so one broken
      // flow doesn't starve the others.
      result.failed++
      await recordRun(db, {
        shopId: event.shopId,
        flowKey: flow.key,
        eventId,
        outcome: 'failed',
        reason: `runner exception: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Per-flow execution
// ---------------------------------------------------------------------------

type FlowOutcome = 'sent_now' | 'queued' | 'skipped_disabled' | 'skipped_conditions' | 'skipped_dedup' | 'failed'

interface RunOneInput {
  flow: FlowCatalogEntry
  event: AutomationEvent
  eventId: string
  override: ShopFlowOverride | undefined
}

async function runOneFlow(
  db: Kysely<Database>,
  input: RunOneInput,
): Promise<FlowOutcome> {
  const { flow, event, eventId, override } = input

  // Step 1-2: resolve effective settings.
  const enabled = override?.enabled ?? true
  if (!enabled) {
    await recordRun(db, {
      shopId: event.shopId,
      flowKey: flow.key,
      eventId,
      outcome: 'skipped_disabled',
      reason: 'override.enabled=false',
    })
    return 'skipped_disabled'
  }

  const delaySeconds = override?.delay_seconds ?? flow.delaySeconds
  const conditions: ConditionNode | null =
    (override?.conditions as ConditionNode | null) ?? flow.defaultConditions ?? null

  // Step 4-5: conditions. Context = { event, …future narrow loads }.
  // We intentionally load NOTHING extra here yet — the PR3 conditions
  // are all event-scoped (totalPrice, campaignType, firstPublish, …).
  // A future PR can extend this to pull shop/customer rows when a
  // condition references them.
  const context: ConditionContext = { event: serialisableEvent(event) }
  if (!evaluateCondition(conditions, context)) {
    await recordRun(db, {
      shopId: event.shopId,
      flowKey: flow.key,
      eventId,
      outcome: 'skipped_conditions',
      reason: 'conditions evaluated false',
    })
    return 'skipped_conditions'
  }

  // Step 6: idempotency key.
  const idempotencyKey = flow.idempotency(event)

  // Step 7/8: dispatch or enqueue.
  if (delaySeconds <= 0) {
    return dispatchNow(db, { flow, event, eventId, idempotencyKey })
  } else {
    return enqueueDelayed(db, {
      flow,
      event,
      eventId,
      idempotencyKey,
      delaySeconds,
    })
  }
}

// ---------------------------------------------------------------------------
// Inline send (delay = 0)
// ---------------------------------------------------------------------------

interface DispatchNowInput {
  flow: FlowCatalogEntry
  event: AutomationEvent
  eventId: string
  idempotencyKey: string
}

async function dispatchNow(
  db: Kysely<Database>,
  input: DispatchNowInput,
): Promise<FlowOutcome> {
  const { flow, event, eventId, idempotencyKey } = input

  // Resolve recipient. If no deliverable address → skip (e.g. a
  // guest checkout with no email yet).
  const recipient = await loadRecipient(db, event)
  if (!recipient) {
    await recordRun(db, {
      shopId: event.shopId,
      flowKey: flow.key,
      eventId,
      outcome: 'skipped_conditions',
      reason: 'no deliverable recipient',
    })
    return 'skipped_conditions'
  }

  try {
    const { sendTemplatedEmail } = await import('../email/send.js')
    const res = await sendTemplatedEmail(db, {
      templateKey: flow.templateKey,
      to: recipient.email,
      shopId: event.shopId,
      variables: flow.variables(event),
      recipientCustomerId: recipient.customerId,
      idempotencyKey,
    })

    if (res.ok) {
      await recordRun(db, {
        shopId: event.shopId,
        flowKey: flow.key,
        eventId,
        outcome: 'sent',
        reason: null,
        deliveryId: res.deliveryId,
      })
      return 'sent_now'
    }

    // Send failed for a non-throw reason (transport_failed, skipped_pref,
    // etc.). Classify: skipped_pref is NOT a failure — the customer
    // opted out, which is success-as-designed.
    if (res.reason === 'skipped_pref') {
      await recordRun(db, {
        shopId: event.shopId,
        flowKey: flow.key,
        eventId,
        outcome: 'skipped_conditions',
        reason: 'recipient preference / frequency cap',
        deliveryId: res.deliveryId ?? null,
      })
      return 'skipped_conditions'
    }

    await recordRun(db, {
      shopId: event.shopId,
      flowKey: flow.key,
      eventId,
      outcome: 'failed',
      reason: res.reason + (res.error ? `: ${res.error}` : ''),
      deliveryId: res.deliveryId ?? null,
    })
    return 'failed'
  } catch (err) {
    await recordRun(db, {
      shopId: event.shopId,
      flowKey: flow.key,
      eventId,
      outcome: 'failed',
      reason: `send threw: ${err instanceof Error ? err.message : String(err)}`,
    })
    return 'failed'
  }
}

// ---------------------------------------------------------------------------
// Delayed enqueue
// ---------------------------------------------------------------------------

interface EnqueueInput {
  flow: FlowCatalogEntry
  event: AutomationEvent
  eventId: string
  idempotencyKey: string
  delaySeconds: number
}

async function enqueueDelayed(
  db: Kysely<Database>,
  input: EnqueueInput,
): Promise<FlowOutcome> {
  const { flow, event, eventId, idempotencyKey, delaySeconds } = input
  const fireAt = new Date(Date.now() + delaySeconds * 1000)

  // ON CONFLICT DO NOTHING on (shop_id, idempotency_key) — webhook
  // retries or re-dispatch of the same event produce the same key, and
  // we want exactly one scheduled row. If the conflict fires, we still
  // need to record the run (as skipped_dedup) so the admin can see
  // what happened.
  const inserted = await db
    .insertInto('automation_scheduled')
    .values({
      shop_id: event.shopId,
      flow_key: flow.key,
      event_id: eventId,
      // Timestamp column = Generated<string>; we must pass an ISO
      // string, not a Date. Postgres TIMESTAMPTZ accepts the ISO-8601
      // format unambiguously.
      fire_at: fireAt.toISOString(),
      idempotency_key: idempotencyKey,
      // status / attempts / last_error / created_at / updated_at
      // default via schema.
    })
    .onConflict((oc) => oc.columns(['shop_id', 'idempotency_key']).doNothing())
    .returning(['id'])
    .executeTakeFirst()

  if (!inserted) {
    await recordRun(db, {
      shopId: event.shopId,
      flowKey: flow.key,
      eventId,
      outcome: 'skipped_dedup',
      reason: `idempotency key ${idempotencyKey} already queued`,
    })
    return 'skipped_dedup'
  }

  await recordRun(db, {
    shopId: event.shopId,
    flowKey: flow.key,
    eventId,
    outcome: 'sent',
    reason: `queued for ${fireAt.toISOString()}`,
    scheduledId: String(inserted.id),
  })
  return 'queued'
}

// ---------------------------------------------------------------------------
// executeScheduled — called by scheduler.ts on cron tick
// ---------------------------------------------------------------------------

export interface ScheduledRow {
  id: string
  shop_id: string
  flow_key: string
  event_id: string
  idempotency_key: string
  attempts: number
}

/**
 * Dispatch a single row lifted from `automation_scheduled` by the
 * scheduler. Called with the row already locked FOR UPDATE (scheduler
 * owns the transaction).
 */
export async function executeScheduled(
  db: Kysely<Database>,
  row: ScheduledRow,
): Promise<'sent' | 'failed' | 'cancelled'> {
  // 1. Re-hydrate the event from automation_events.
  const ev = await db
    .selectFrom('automation_events')
    .select(['id', 'shop_id', 'type', 'payload'])
    .where('id', '=', row.event_id)
    .executeTakeFirst()

  if (!ev) {
    // Event row GONE (retention? manual delete?). Can't dispatch —
    // mark cancelled.
    await markScheduledCancelled(db, row.id, 'event row missing')
    return 'cancelled'
  }

  const flow = FLOW_CATALOG_BY_KEY[row.flow_key]
  if (!flow) {
    await markScheduledCancelled(db, row.id, 'flow key not in catalog')
    return 'cancelled'
  }

  // Reconstruct the AutomationEvent from the JSONB payload.
  const event = reconstructEvent(ev.shop_id, ev.type, ev.payload as Record<string, unknown>)

  // 2. Send.
  const recipient = await loadRecipient(db, event)
  if (!recipient) {
    await markScheduledFailed(db, row.id, row.attempts + 1, 'no deliverable recipient')
    await recordRun(db, {
      shopId: event.shopId,
      flowKey: flow.key,
      eventId: row.event_id,
      outcome: 'skipped_conditions',
      reason: 'no deliverable recipient (scheduled)',
      scheduledId: row.id,
    })
    return 'failed'
  }

  try {
    const { sendTemplatedEmail } = await import('../email/send.js')
    const res = await sendTemplatedEmail(db, {
      templateKey: flow.templateKey,
      to: recipient.email,
      shopId: event.shopId,
      variables: flow.variables(event),
      recipientCustomerId: recipient.customerId,
      idempotencyKey: row.idempotency_key,
    })

    if (res.ok) {
      await markScheduledSent(db, row.id)
      await recordRun(db, {
        shopId: event.shopId,
        flowKey: flow.key,
        eventId: row.event_id,
        outcome: 'sent',
        reason: null,
        deliveryId: res.deliveryId,
        scheduledId: row.id,
      })
      return 'sent'
    }

    if (res.reason === 'skipped_pref') {
      // Customer opted out since enqueue. Record as skipped — NOT a
      // retry-eligible failure.
      await markScheduledCancelled(db, row.id, 'recipient preference / frequency cap')
      await recordRun(db, {
        shopId: event.shopId,
        flowKey: flow.key,
        eventId: row.event_id,
        outcome: 'skipped_conditions',
        reason: 'recipient preference / frequency cap (scheduled)',
        deliveryId: res.deliveryId ?? null,
        scheduledId: row.id,
      })
      return 'cancelled'
    }

    await markScheduledFailed(
      db,
      row.id,
      row.attempts + 1,
      `${res.reason}${res.error ? `: ${res.error}` : ''}`,
    )
    await recordRun(db, {
      shopId: event.shopId,
      flowKey: flow.key,
      eventId: row.event_id,
      outcome: 'failed',
      reason: res.reason + (res.error ? `: ${res.error}` : ''),
      deliveryId: res.deliveryId ?? null,
      scheduledId: row.id,
    })
    return 'failed'
  } catch (err) {
    await markScheduledFailed(
      db,
      row.id,
      row.attempts + 1,
      `send threw: ${err instanceof Error ? err.message : String(err)}`,
    )
    await recordRun(db, {
      shopId: event.shopId,
      flowKey: flow.key,
      eventId: row.event_id,
      outcome: 'failed',
      reason: `send threw: ${err instanceof Error ? err.message : String(err)}`,
      scheduledId: row.id,
    })
    return 'failed'
  }
}

// ---------------------------------------------------------------------------
// Helpers — shop overrides + recipient loading
// ---------------------------------------------------------------------------

interface ShopFlowOverride {
  flow_key: string
  enabled: boolean
  delay_seconds: number | null
  conditions: unknown
}

async function loadShopOverrides(
  db: Kysely<Database>,
  shopId: string,
  flowKeys: readonly string[],
): Promise<Map<string, ShopFlowOverride>> {
  if (flowKeys.length === 0) return new Map()
  const rows = await db
    .selectFrom('automation_flows')
    .select(['flow_key', 'enabled', 'delay_seconds', 'conditions'])
    .where('shop_id', '=', shopId)
    .where('flow_key', 'in', flowKeys as unknown as string[])
    .execute()
  const out = new Map<string, ShopFlowOverride>()
  for (const r of rows) {
    out.set(r.flow_key, {
      flow_key: r.flow_key,
      enabled: r.enabled,
      delay_seconds: r.delay_seconds,
      conditions: r.conditions,
    })
  }
  return out
}

interface Recipient {
  email: string
  customerId: string | null
}

/**
 * Best-effort recipient lookup. Returns null if no deliverable email
 * is available (guest checkouts, anonymous events, etc.). We look at
 * the event shape first to avoid a DB round-trip when the email is
 * already on the payload (checkout.abandoned carries customerEmail).
 */
async function loadRecipient(
  db: Kysely<Database>,
  event: AutomationEvent,
): Promise<Recipient | null> {
  // Fast path: checkout.abandoned carries customerEmail directly.
  if (event.type === 'checkout.abandoned' && event.customerEmail) {
    return { email: event.customerEmail, customerId: event.customerId }
  }

  // Customer-scoped events → look up by customerId.
  const customerId =
    'customerId' in event && typeof event.customerId === 'string' && event.customerId
      ? event.customerId
      : null
  if (customerId) {
    const row = await db
      .selectFrom('customers')
      .select(['id', 'email'])
      .where('id', '=', customerId)
      .executeTakeFirst()
    if (row?.email) return { email: row.email, customerId: row.id }
  }

  // Order-scoped events (order.paid, order.fulfilled, order.delivered,
  // fulfillment.out_for_delivery, payment.failed). Fall back to the
  // order row's email if we have no customer link.
  if ('orderId' in event && typeof event.orderId === 'string') {
    const row = await db
      .selectFrom('orders')
      .select(['id', 'customer_id', 'email'])
      .where('id', '=', event.orderId)
      .executeTakeFirst()
    if (row?.email) {
      return { email: row.email, customerId: (row.customer_id as string | null) ?? null }
    }
  }

  // Merchant-ops flows (low_stock_alert — only pure-merchant event in
  // PR3 catalog) deliver to `shops.email` (the shop-level contact
  // address). We keep this path narrow: PR4+ can introduce per-event
  // audience routing when/if more merchant-ops events land.
  if (isMerchantOpsEvent(event)) {
    const shop = await db
      .selectFrom('shops')
      .select(['id', 'email'])
      .where('id', '=', event.shopId)
      .executeTakeFirst()
    if (shop?.email) {
      return { email: shop.email, customerId: null }
    }
  }

  return null
}

function isMerchantOpsEvent(event: AutomationEvent): boolean {
  // For PR3, `inventory.threshold_crossed` is the only pure-merchant
  // event in the flow catalog. `high_value_order` fires on `order.paid`
  // but its template is merchant-audience — we don't special-case it
  // here because order.paid carries a customer linkage that resolves
  // via the customer/order path above; for the merchant-side send we
  // rely on email_preferences audience routing (send.ts layer) to
  // flag the right recipient inbox. PR4 may revisit this by adding a
  // per-flow `audience` field on FlowCatalogEntry.
  return event.type === 'inventory.threshold_crossed'
}

// ---------------------------------------------------------------------------
// Helpers — automation_scheduled state transitions
// ---------------------------------------------------------------------------

async function markScheduledSent(db: Kysely<Database>, id: string): Promise<void> {
  await db
    .updateTable('automation_scheduled')
    .set({ status: 'sent', last_error: null })
    .where('id', '=', id)
    .execute()
}

async function markScheduledCancelled(
  db: Kysely<Database>,
  id: string,
  reason: string,
): Promise<void> {
  await db
    .updateTable('automation_scheduled')
    .set({ status: 'cancelled', last_error: reason })
    .where('id', '=', id)
    .execute()
}

async function markScheduledFailed(
  db: Kysely<Database>,
  id: string,
  attempts: number,
  reason: string,
): Promise<void> {
  const MAX_ATTEMPTS = 3
  const finalStatus = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'
  await db
    .updateTable('automation_scheduled')
    .set({
      status: finalStatus,
      attempts,
      last_error: reason,
    })
    .where('id', '=', id)
    .execute()
}

// ---------------------------------------------------------------------------
// Helpers — automation_runs write
// ---------------------------------------------------------------------------

interface RecordRunInput {
  shopId: string
  flowKey: string
  eventId: string
  outcome: 'sent' | 'skipped_conditions' | 'skipped_dedup' | 'skipped_disabled' | 'failed'
  reason: string | null
  deliveryId?: number | null
  scheduledId?: string | null
}

async function recordRun(
  db: Kysely<Database>,
  input: RecordRunInput,
): Promise<void> {
  // automation_runs.delivery_id is BIGINT, matching email_deliveries.id
  // (BIGSERIAL → number). We pass the raw number through; Postgres
  // accepts it as-is.
  await db
    .insertInto('automation_runs')
    .values({
      shop_id: input.shopId,
      flow_key: input.flowKey,
      event_id: input.eventId,
      outcome: input.outcome,
      reason: input.reason,
      delivery_id: input.deliveryId ?? null,
      scheduled_id: input.scheduledId ?? null,
    })
    .execute()
}

// ---------------------------------------------------------------------------
// Helpers — event serialisation
// ---------------------------------------------------------------------------

/**
 * Serialise an event for context evaluation. JSONB round-trips strip
 * Date objects to ISO strings; we normalise here so the conditions
 * evaluator sees consistent types whether called from `dispatch()`
 * (fresh event) or `executeScheduled()` (rehydrated from DB).
 */
function serialisableEvent(event: AutomationEvent): Record<string, unknown> {
  const copy: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(event)) {
    copy[k] = v instanceof Date ? v.toISOString() : v
  }
  return copy
}

/**
 * Reconstruct an AutomationEvent from a DB row. Inverse of
 * `normaliseEventForInsert`. The type union's shape is regular so we
 * can reconstruct without a per-type switch — the catalog's
 * variables()/idempotency() resolvers do their own narrowing.
 */
function reconstructEvent(
  shopId: string,
  type: string,
  payload: Record<string, unknown>,
): AutomationEvent {
  const out: Record<string, unknown> = { type, shopId, ...payload }
  // Revive Date fields where we care. Only occurredAt is guaranteed
  // ISO per events.ts normalisation; other Date-ish fields are the
  // catalog/condition consumer's problem.
  if (typeof out.occurredAt === 'string') {
    out.occurredAt = new Date(out.occurredAt)
  }
  if (typeof out.sendAt === 'string') out.sendAt = new Date(out.sendAt)
  if (typeof out.lastOrderAt === 'string') out.lastOrderAt = new Date(out.lastOrderAt)
  if (typeof out.abandonedAt === 'string') out.abandonedAt = new Date(out.abandonedAt)
  return out as AutomationEvent
}

// No lazy catalog import needed — flow-catalog.ts has no dependency on
// runner.ts, so we import FLOW_CATALOG_BY_KEY directly at the top of
// this file. The lazy pattern here (events.ts → runner.ts) only applies
// because events.ts IS imported by flow-catalog.ts for its type union.
