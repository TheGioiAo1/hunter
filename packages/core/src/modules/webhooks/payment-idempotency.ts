/**
 * Gbox Platform — Payment Webhook Idempotency Helper (Phase 15 PR2)
 *
 * Single chokepoint for EVERY inbound payment gateway webhook (PayPal,
 * Stripe, Airwallex, ...). Prevents double charge / double fulfilment
 * / double refund on gateway replay.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Why this exists
 * ────────────────────────────────────────────────────────────────────────
 *
 * Payment gateways WILL redeliver the same event:
 *   - Network blip → gateway gets no 2xx → retries
 *   - Multi-endpoint fan-out → same event hits 2 of our URLs
 *   - Gateway internal replay during incident recovery
 *   - Admin manually re-fires an event from the dashboard
 *
 * Every replay that doesn't short-circuit at the DB layer risks:
 *   - Double capture on `payment_intent.succeeded` / `CHECKOUT.ORDER.APPROVED`
 *   - Double fulfilment trigger on `charge.updated`
 *   - Double refund on `charge.refunded`
 *
 * ────────────────────────────────────────────────────────────────────────
 * Contract (stable API — do not break without bumping all 3 gateways)
 * ────────────────────────────────────────────────────────────────────────
 *
 * recordInboundWebhook({ gateway, eventId, eventType, payload, ... })
 *   ↳ INSERT ON CONFLICT (gateway, event_id) DO NOTHING
 *     returns { isNew: true, id }  when insert succeeded
 *     returns { isNew: false, id } when row already existed
 *
 * Caller pattern:
 *
 *   const { isNew, id } = await recordInboundWebhook(db, {...})
 *   if (!isNew) return res.status(200).send('ok')     // replay, no-op
 *   try {
 *     await doTheActualSideEffects(payload)
 *     await markWebhookProcessed(db, id, { result: 'ok' })
 *   } catch (err) {
 *     await markWebhookProcessed(db, id, { result: 'error', errorReason: ... })
 *     throw err
 *   }
 *
 * The caller MUST still return 200 to the gateway on replay, otherwise
 * the gateway keeps retrying and eventually alerts / disables the
 * endpoint. The `isNew:false` branch handles this explicitly.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Iron Rule 5 (seller-facing leak safety)
 * ────────────────────────────────────────────────────────────────────────
 *
 * This module:
 *   - NEVER logs raw_payload (may contain tokens)
 *   - NEVER includes gateway internals in any thrown Error that could
 *     surface to a seller — error_reason is stored on the row for
 *     platform-operator forensics only
 *   - NEVER mentions internal platform-admin routes in any message
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PaymentGateway = 'paypal' | 'stripe' | 'airwallex'

export type WebhookResult = 'pending' | 'ok' | 'error' | 'ignored' | 'duplicate'

export interface RecordInboundWebhookInput {
  /** 'paypal' | 'stripe' | 'airwallex'. Extend via PaymentGateway union. */
  gateway: PaymentGateway
  /** Gateway's own authoritative event id (evt_xxx, WH-xxx, ...). */
  eventId: string
  /** Gateway's event type (payment_intent.succeeded, CHECKOUT.ORDER.APPROVED, ...). */
  eventType: string
  /** Full webhook payload as received (parsed JSON). Kept forever for PCI DSS 10.5.5. */
  payload: unknown
  /** Shop the event belongs to. NULL for platform-scoped events. */
  shopId?: string | null
  /** Gateway-provided signature header, stored for forensic replay. */
  signature?: string | null
}

export interface RecordInboundWebhookResult {
  /** true = first time we've seen this event, proceed with side-effects. */
  isNew: boolean
  /** Row id in `payment_webhook_events`. Pass to `markWebhookProcessed`. */
  id: number
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Defensive JSON serializer. Gateways occasionally send non-JSON-
 * compatible shapes (cyclic refs in a test harness, BigInt in Stripe
 * amounts on some SDKs). We want the webhook handler to fail closed
 * with an auditable marker, not a cryptic JSON.stringify throw three
 * callers deep.
 */
function safeStringify(payload: unknown): string {
  try {
    return JSON.stringify(payload ?? {})
  } catch {
    return JSON.stringify({
      __serialization_failed: true,
      __type: typeof payload,
    })
  }
}

function toNumber(maybe: unknown): number {
  if (typeof maybe === 'number') return maybe
  if (typeof maybe === 'bigint') return Number(maybe)
  if (typeof maybe === 'string') return Number(maybe)
  return Number(maybe)
}

// ---------------------------------------------------------------------------
// recordInboundWebhook — the idempotency chokepoint
// ---------------------------------------------------------------------------

/**
 * Insert a new `payment_webhook_events` row under `ON CONFLICT (gateway,
 * event_id) DO NOTHING`. Returns `{isNew, id}`:
 *
 *   - isNew=true  → row was created; caller should run side-effects
 *                   and then call `markWebhookProcessed(db, id, { result: 'ok' })`
 *   - isNew=false → row already existed; caller should return 200 to
 *                   the gateway without any side-effects
 *
 * This is the ONLY API surface payment-module webhook handlers should
 * use for deduplication. Never bypass by writing your own INSERT.
 *
 * The row starts with `result='pending'` — any handler that crashes
 * before calling `markWebhookProcessed` leaves a forensic trail. A
 * sweeper cron (separate PR) can surface stale `pending` rows for
 * admin review.
 */
export async function recordInboundWebhook(
  db: Kysely<Database>,
  input: RecordInboundWebhookInput,
): Promise<RecordInboundWebhookResult> {
  const payloadJson = safeStringify(input.payload)

  // Kysely builder path: INSERT … ON CONFLICT (gateway, event_id) DO
  // NOTHING RETURNING id. If the RETURNING row comes back, we inserted.
  // Otherwise the row already existed (conflict) — look up the id via
  // SELECT.
  const inserted = await db
    .insertInto('payment_webhook_events')
    .values({
      gateway: input.gateway,
      event_id: input.eventId,
      event_type: input.eventType,
      shop_id: input.shopId ?? null,
      raw_payload: payloadJson as any,
      signature: input.signature ?? null,
      // `result` column has DEFAULT 'pending' in migration 090 — we
      // omit it from VALUES so the default applies. Kysely typings
      // treat `Generated<...>` columns as optional on insert which is
      // exactly what we want.
    } as any)
    .onConflict((oc) => oc.columns(['gateway', 'event_id']).doNothing())
    .returning('id')
    .executeTakeFirst()

  if (inserted && inserted.id !== undefined && inserted.id !== null) {
    return { isNew: true, id: toNumber(inserted.id) }
  }

  // Conflict path — row already exists. Look up its id so callers can
  // still reference it (e.g. for observability / logging).
  const existing = await db
    .selectFrom('payment_webhook_events')
    .select('id')
    .where('gateway', '=', input.gateway)
    .where('event_id', '=', input.eventId)
    .executeTakeFirst()

  if (!existing) {
    // Should not happen under normal circumstances — either we just
    // inserted, or the row exists. If neither, the table is out of
    // sync (maybe someone truncated mid-flight). Fail closed: the
    // caller will surface this as a 5xx and the gateway retries.
    throw new Error(
      'payment_webhook_events: insert returned 0 rows yet SELECT also empty ' +
        '(possible concurrent TRUNCATE or schema drift)',
    )
  }

  return { isNew: false, id: toNumber(existing.id) }
}

// ---------------------------------------------------------------------------
// markWebhookProcessed — finalize the ledger entry after side-effects
// ---------------------------------------------------------------------------

export interface MarkWebhookProcessedInput {
  result: Exclude<WebhookResult, 'pending'>
  /** Stringified error message — NEVER surface to sellers (Iron Rule 5). */
  errorReason?: string | null
}

/**
 * Flip the ledger row's `result` + stamp `processed_at`. Call exactly
 * once after the side-effects finish (success or failure).
 *
 * `errorReason` is platform-operator-only (Iron Rule 5). It is stored
 * verbatim so we can forensically inspect the failure; it must NEVER
 * reach a seller-facing UI / email / toast.
 */
export async function markWebhookProcessed(
  db: Kysely<Database>,
  id: number,
  input: MarkWebhookProcessedInput,
): Promise<void> {
  await db
    .updateTable('payment_webhook_events')
    .set({
      result: input.result,
      processed_at: new Date().toISOString(),
      error_reason: input.errorReason ?? null,
    } as any)
    .where('id', '=', id as any)
    .execute()
}

// ---------------------------------------------------------------------------
// markWebhookIgnored — convenience for handlers that choose not to act
// ---------------------------------------------------------------------------

/**
 * Flip a newly-inserted row to `result='ignored'`. Use this when a
 * handler recognizes an event type it has registered for but chooses
 * not to act on it (e.g. a future-phase event type). Keeps the ledger
 * explicit about "seen and deliberately no-op'd" vs "seen and errored".
 */
export async function markWebhookIgnored(
  db: Kysely<Database>,
  id: number,
  reason?: string,
): Promise<void> {
  await markWebhookProcessed(db, id, {
    result: 'ignored',
    errorReason: reason ?? null,
  })
}

// ---------------------------------------------------------------------------
// processInboundWebhook — convenience wrapper for the full pattern
// ---------------------------------------------------------------------------

export interface ProcessInboundWebhookOutcome<T> {
  /** true when side-effects ran (first seen event). */
  processed: boolean
  /** true when this was a replay and we short-circuited to 200 OK. */
  duplicate: boolean
  /** Side-effect return value (undefined for duplicates). */
  value?: T
  /** Ledger row id — useful for logging/observability. */
  id: number
}

/**
 * All-in-one helper: dedup + run side-effect + mark result.
 *
 *   const outcome = await processInboundWebhook(db, {
 *     gateway: 'stripe',
 *     eventId: event.id,
 *     eventType: event.type,
 *     payload: event,
 *     shopId: ourLookedUpShopId,
 *     signature: req.headers['stripe-signature'],
 *   }, async () => {
 *     await fulfilOrder(...)
 *   })
 *
 *   // In all cases return 200 so gateway stops retrying:
 *   return res.status(200).send(outcome.duplicate ? 'dup' : 'ok')
 *
 * On side-effect throw: the error is stored in `error_reason`, the row
 * flipped to result='error', then the original error is re-thrown so
 * Express's error handler / Sentry can see it.
 *
 * If the caller needs different on-error semantics (retry by returning
 * 5xx, for example), they should call recordInboundWebhook +
 * markWebhookProcessed manually instead of this wrapper.
 */
export async function processInboundWebhook<T>(
  db: Kysely<Database>,
  input: RecordInboundWebhookInput,
  handler: (id: number) => Promise<T>,
): Promise<ProcessInboundWebhookOutcome<T>> {
  const recorded = await recordInboundWebhook(db, input)

  if (!recorded.isNew) {
    // Replay — optionally flip the existing row to 'duplicate' IFF it's
    // still 'pending' (another handler may have already processed).
    // Currently we leave pending rows alone; they'll be reconciled by
    // the sweeper cron. This avoids fighting between concurrent
    // receivers of the same event.
    return { processed: false, duplicate: true, id: recorded.id }
  }

  try {
    const value = await handler(recorded.id)
    await markWebhookProcessed(db, recorded.id, { result: 'ok' })
    return { processed: true, duplicate: false, value, id: recorded.id }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Best effort — don't swallow the original error if mark fails.
    try {
      await markWebhookProcessed(db, recorded.id, {
        result: 'error',
        errorReason: message.slice(0, 2000),
      })
    } catch {
      // intentionally swallowed — original error is more important
    }
    throw err
  }
}
