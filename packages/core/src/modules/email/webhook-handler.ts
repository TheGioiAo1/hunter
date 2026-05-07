/**
 * Gbox Platform — Email webhook orchestrator (Phase 14 PR4.B)
 *
 * End-to-end pipeline for SES bounce/complaint webhooks:
 *
 *   1. Verify SNS X.509 signature (or HMAC for the generic path).
 *   2. Handle SubscriptionConfirmation (return SubscribeURL to caller).
 *   3. Idempotency: dedup by sns_message_id UNIQUE.
 *   4. Insert raw audit row into ses_webhook_events.
 *   5. Parse SES inner message → classifier → { kind, recipients, … }.
 *   6. Match delivery by email_deliveries.smtp_message_id.
 *   7. Insert email_events rows (one per recipient).
 *   8. For hard bounces + complaints: INSERT email_suppressions
 *      (ON CONFLICT DO NOTHING against the partial UNIQUE).
 *   9. UPDATE email_deliveries.bounced_at when a hard bounce matches.
 *  10. UPDATE ses_webhook_events.matched_* + processed_at.
 *  11. Return a structured result — the Express route translates to 200.
 *
 * NO TRANSACTION. The sns_message_id UNIQUE guarantees idempotency on
 * SNS retry. Partial writes (audit row inserted but events not yet
 * recorded) are detectable via `processed_at IS NULL AND processing_error
 * IS NULL`; ops can re-run. Transactions would hold locks across the
 * entire pipeline for zero safety gain.
 *
 * IRON RULE 5
 * -----------
 * No string output suitable for user display. Result objects carry
 * structured data; the route layer composes copy.
 */

import crypto from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

import {
  verifySnsSignature,
  shouldSkipSnsVerifyForTests,
  type SnsEnvelope,
  type CertFetcher,
} from './webhook-verify.js'
import { classifySesMessage, type ClassifiedEvent } from './bounce-classifier.js'
import { addSuppression } from './suppression.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HandleSnsWebhookInput {
  envelope: SnsEnvelope
  /** IP that posted the webhook (for ses_webhook_events.source_ip). */
  sourceIp?: string | null
  /** Injectable; defaults to the production fetcher. */
  certFetcher: CertFetcher
}

export type HandleSnsWebhookResult =
  | {
      ok: true
      outcome: 'processed'
      eventId: number
      matchedDeliveryId: number | null
      matchedShopId: string | null
      eventsCreated: number
      suppressionsCreated: number
      signatureVerified: boolean
    }
  | { ok: true; outcome: 'replayed'; eventId: number }
  | { ok: true; outcome: 'subscribe_confirm'; subscribeUrl: string }
  | {
      ok: false
      reason:
        | 'signature_invalid'
        | 'missing_field'
        | 'parse_failed'
        | 'db_error'
      error?: string
    }

export interface HandleGenericWebhookInput {
  /** JSON body matching the shape the classifier expects (SES inner Message). */
  rawBody: string
  signatureBase64: string
  secret: string
  shopIdHint: string | null
  sourceIp?: string | null
}

export type HandleGenericWebhookResult =
  | {
      ok: true
      outcome: 'processed'
      eventId: number
      matchedDeliveryId: number | null
      matchedShopId: string | null
      eventsCreated: number
      suppressionsCreated: number
    }
  | { ok: true; outcome: 'replayed'; eventId: number }
  | {
      ok: false
      reason:
        | 'signature_invalid'
        | 'missing_secret'
        | 'parse_failed'
        | 'db_error'
      error?: string
    }

// ---------------------------------------------------------------------------
// handleSnsWebhook — primary entry point
// ---------------------------------------------------------------------------

export async function handleSnsWebhook(
  db: Kysely<Database>,
  input: HandleSnsWebhookInput,
): Promise<HandleSnsWebhookResult> {
  const { envelope, sourceIp, certFetcher } = input

  // 1. Signature verification
  const skipVerify = shouldSkipSnsVerifyForTests()
  let signatureVerified = false
  if (skipVerify) {
    // Test-only shortcut. Never honored in production (NODE_ENV check
    // inside shouldSkipSnsVerifyForTests).
    signatureVerified = false
  } else {
    const verifyResult = await verifySnsSignature(envelope, certFetcher)
    if (!verifyResult.ok) {
      return {
        ok: false,
        reason: verifyResult.reason === 'missing_field' ? 'missing_field' : 'signature_invalid',
      }
    }
    signatureVerified = true
  }

  // 2. SubscriptionConfirmation — return the URL for the caller to GET
  if (envelope.Type === 'SubscriptionConfirmation' || envelope.Type === 'UnsubscribeConfirmation') {
    const subscribeUrl = envelope.SubscribeURL
    if (!subscribeUrl) {
      return { ok: false, reason: 'missing_field' }
    }
    return { ok: true, outcome: 'subscribe_confirm', subscribeUrl }
  }

  if (envelope.Type !== 'Notification') {
    return { ok: false, reason: 'parse_failed', error: 'unknown_envelope_type' }
  }

  // 3. Dedup via sns_message_id UNIQUE
  try {
    const existing = await db
      .selectFrom('ses_webhook_events')
      .select(['id'])
      .where('sns_message_id', '=', envelope.MessageId)
      .executeTakeFirst()
    if (existing) {
      return { ok: true, outcome: 'replayed', eventId: Number(existing.id) }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: 'db_error', error: msg }
  }

  // 4. Classify (may fail — still persist the audit row for forensics)
  const classified = classifySesMessage(envelope.Message ?? '')

  // 5. Insert audit row
  let eventId: number
  try {
    const insertResult = await sql<{ id: number }>`
      INSERT INTO ses_webhook_events (
        sns_message_id,
        sns_topic_arn,
        event_type,
        bounce_type,
        bounce_subtype,
        ses_message_id,
        recipients,
        raw_payload,
        signature_verified,
        source_ip
      )
      VALUES (
        ${envelope.MessageId},
        ${envelope.TopicArn ?? null},
        ${eventTypeForAudit(classified, envelope)},
        ${classified.bounceType},
        ${classified.bounceSubType},
        ${classified.sesMessageId},
        ${JSON.stringify(classified.recipients)}::jsonb,
        ${JSON.stringify({ envelope, inner: safeParse(envelope.Message) })}::jsonb,
        ${signatureVerified},
        ${sourceIp ?? null}
      )
      RETURNING id
    `.execute(db)
    eventId = Number((insertResult.rows[0] as { id: number }).id)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: 'db_error', error: msg }
  }

  // 6. Bail early if classifier couldn't understand the payload.
  if (classified.kind === 'unknown') {
    await markProcessed(db, eventId, 'classified_unknown')
    return {
      ok: true,
      outcome: 'processed',
      eventId,
      matchedDeliveryId: null,
      matchedShopId: null,
      eventsCreated: 0,
      suppressionsCreated: 0,
      signatureVerified,
    }
  }

  // 7. Match delivery by smtp_message_id
  const match = classified.sesMessageId
    ? await matchDelivery(db, classified.sesMessageId)
    : null

  // 8. Persist events + suppressions
  const eventsCreated = await persistEmailEvents(db, {
    classified,
    deliveryId: match?.id ?? null,
    rawPayload: safeParse(envelope.Message),
  })

  const suppressionsCreated = classified.suppress
    ? await persistSuppressions(db, {
        classified,
        shopId: match?.shop_id ?? null,
        sourceTransport: 'ses',
        sourceDeliveryId: match?.id ?? null,
        sourceEventId: eventId,
      })
    : 0

  // 9. Hard-bounce → bounced_at on email_deliveries
  if (classified.kind === 'hard' && match) {
    try {
      await db
        .updateTable('email_deliveries')
        .set({ bounced_at: new Date().toISOString() })
        .where('id', '=', match.id)
        .where('bounced_at', 'is', null) // idempotent
        .execute()
    } catch {
      // Non-fatal — continue and let ops catch via the audit row.
    }
  }

  // 10. Finalize audit row
  await finalizeAuditMatch(db, eventId, match?.id ?? null, match?.shop_id ?? null)

  return {
    ok: true,
    outcome: 'processed',
    eventId,
    matchedDeliveryId: match?.id ?? null,
    matchedShopId: match?.shop_id ?? null,
    eventsCreated,
    suppressionsCreated,
    signatureVerified,
  }
}

// ---------------------------------------------------------------------------
// handleGenericWebhook — HMAC escape hatch for non-SES providers
// ---------------------------------------------------------------------------

export async function handleGenericWebhook(
  db: Kysely<Database>,
  input: HandleGenericWebhookInput,
): Promise<HandleGenericWebhookResult> {
  if (!input.secret) {
    return { ok: false, reason: 'missing_secret' }
  }

  // 1. HMAC verify
  const { verifyHmacSignature } = await import('./webhook-verify.js')
  if (!verifyHmacSignature(input.secret, input.rawBody, input.signatureBase64)) {
    return { ok: false, reason: 'signature_invalid' }
  }

  // 2. Synthetic message id = SHA-256(rawBody) truncated. Provides dedup
  //    without provider-specific message-id fields. If the same body
  //    arrives twice the second one replays.
  const syntheticMsgId = 'gen-' + crypto.createHash('sha256').update(input.rawBody).digest('hex').slice(0, 48)

  try {
    const existing = await db
      .selectFrom('ses_webhook_events')
      .select(['id'])
      .where('sns_message_id', '=', syntheticMsgId)
      .executeTakeFirst()
    if (existing) {
      return { ok: true, outcome: 'replayed', eventId: Number(existing.id) }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: 'db_error', error: msg }
  }

  // 3. Classify
  const classified = classifySesMessage(input.rawBody)

  // 4. Audit row
  let eventId: number
  try {
    const insertResult = await sql<{ id: number }>`
      INSERT INTO ses_webhook_events (
        sns_message_id,
        sns_topic_arn,
        event_type,
        bounce_type,
        bounce_subtype,
        ses_message_id,
        recipients,
        raw_payload,
        signature_verified,
        source_ip
      )
      VALUES (
        ${syntheticMsgId},
        ${null},
        ${'generic:' + (classified.eventType ?? 'unknown')},
        ${classified.bounceType},
        ${classified.bounceSubType},
        ${classified.sesMessageId},
        ${JSON.stringify(classified.recipients)}::jsonb,
        ${JSON.stringify({ generic: true, inner: safeParse(input.rawBody) })}::jsonb,
        ${true},
        ${input.sourceIp ?? null}
      )
      RETURNING id
    `.execute(db)
    eventId = Number((insertResult.rows[0] as { id: number }).id)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: 'db_error', error: msg }
  }

  if (classified.kind === 'unknown') {
    await markProcessed(db, eventId, 'classified_unknown')
    return {
      ok: true,
      outcome: 'processed',
      eventId,
      matchedDeliveryId: null,
      matchedShopId: null,
      eventsCreated: 0,
      suppressionsCreated: 0,
    }
  }

  const match = classified.sesMessageId
    ? await matchDelivery(db, classified.sesMessageId)
    : null

  const eventsCreated = await persistEmailEvents(db, {
    classified,
    deliveryId: match?.id ?? null,
    rawPayload: safeParse(input.rawBody),
  })

  // shop_id resolution priority: matched delivery > explicit hint > null
  const shopIdForSuppress = match?.shop_id ?? input.shopIdHint ?? null

  const suppressionsCreated = classified.suppress
    ? await persistSuppressions(db, {
        classified,
        shopId: shopIdForSuppress,
        sourceTransport: 'webhook_generic',
        sourceDeliveryId: match?.id ?? null,
        sourceEventId: eventId,
      })
    : 0

  if (classified.kind === 'hard' && match) {
    try {
      await db
        .updateTable('email_deliveries')
        .set({ bounced_at: new Date().toISOString() })
        .where('id', '=', match.id)
        .where('bounced_at', 'is', null)
        .execute()
    } catch {
      // non-fatal
    }
  }

  await finalizeAuditMatch(db, eventId, match?.id ?? null, match?.shop_id ?? null)

  return {
    ok: true,
    outcome: 'processed',
    eventId,
    matchedDeliveryId: match?.id ?? null,
    matchedShopId: match?.shop_id ?? null,
    eventsCreated,
    suppressionsCreated,
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function eventTypeForAudit(classified: ClassifiedEvent, env: SnsEnvelope): string {
  // Preserves the SES category label for forensics. `Type=Notification`
  // is the SNS wire type; the SES category lives inside `classified`.
  if (classified.kind === 'hard' || classified.kind === 'soft') return 'Bounce'
  if (classified.kind === 'complaint') return 'Complaint'
  if (classified.kind === 'delivery') return 'Delivery'
  return env.Type
}

function safeParse(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return { raw } }
  }
  return raw ?? null
}

async function matchDelivery(
  db: Kysely<Database>,
  sesMessageId: string,
): Promise<{ id: number; shop_id: string | null } | null> {
  const row = await db
    .selectFrom('email_deliveries')
    .select(['id', 'shop_id'])
    .where('smtp_message_id', '=', sesMessageId)
    .executeTakeFirst()
  if (!row) return null
  return { id: Number(row.id), shop_id: row.shop_id }
}

async function persistEmailEvents(
  db: Kysely<Database>,
  params: { classified: ClassifiedEvent; deliveryId: number | null; rawPayload: unknown },
): Promise<number> {
  const { classified, deliveryId, rawPayload } = params
  if (classified.eventType == null) return 0
  if (deliveryId == null) {
    // email_events requires a non-null delivery_id. Without a match
    // we skip the per-recipient rows; the ses_webhook_events audit row
    // already captures everything for unmatched bounces.
    return 0
  }
  let created = 0
  for (const recipient of classified.recipients) {
    try {
      await db
        .insertInto('email_events')
        .values({
          delivery_id: deliveryId,
          event_type: classified.eventType,
          user_agent: null,
          ip_hash: null,
          clicked_url: null,
          bounce_type: classified.eventBounceType,
          raw_payload: JSON.stringify({
            recipient: recipient.email,
            diagnosticCode: recipient.diagnosticCode,
            status: recipient.status,
            raw: rawPayload,
          }) as any,
        })
        .execute()
      created += 1
    } catch {
      // Non-fatal — skip this recipient row but keep going.
    }
  }
  return created
}

async function persistSuppressions(
  db: Kysely<Database>,
  params: {
    classified: ClassifiedEvent
    shopId: string | null
    sourceTransport: 'ses' | 'webhook_generic'
    sourceDeliveryId: number | null
    sourceEventId: number | null
  },
): Promise<number> {
  const { classified, shopId, sourceTransport, sourceDeliveryId, sourceEventId } = params
  if (!classified.suppress || classified.suppressionReason == null) return 0
  let created = 0
  for (const recipient of classified.recipients) {
    const result = await addSuppression(db, {
      shopId,
      email: recipient.emailLower,
      reason: classified.suppressionReason,
      sourceTransport,
      bounceType: classified.bounceType,
      bounceSubType: classified.bounceSubType,
      sourceDeliveryId,
      sourceEventId,
      rawDiagnosticCode: recipient.diagnosticCode,
      notes: null,
    })
    if (result.ok && result.created) created += 1
  }
  return created
}

async function finalizeAuditMatch(
  db: Kysely<Database>,
  eventId: number,
  matchedDeliveryId: number | null,
  matchedShopId: string | null,
): Promise<void> {
  try {
    await db
      .updateTable('ses_webhook_events')
      .set({
        matched_delivery_id: matchedDeliveryId,
        matched_shop_id: matchedShopId,
        processed_at: new Date().toISOString(),
      })
      .where('id', '=', eventId)
      .execute()
  } catch {
    // Audit row already exists. Leaving processed_at NULL is acceptable —
    // an ops ticket ("unprocessed audit rows") is noisier than dropping.
  }
}

async function markProcessed(
  db: Kysely<Database>,
  eventId: number,
  note: string,
): Promise<void> {
  try {
    await db
      .updateTable('ses_webhook_events')
      .set({ processed_at: new Date().toISOString(), processing_error: note })
      .where('id', '=', eventId)
      .execute()
  } catch {
    // non-fatal
  }
}

// ---------------------------------------------------------------------------
// confirmSubscriptionUrl — HTTPS GET for SNS subscription handshake
// ---------------------------------------------------------------------------

/**
 * The storefront route calls this after `handleSnsWebhook` returns
 * `outcome: 'subscribe_confirm'`. We don't parse the response — a 2xx
 * means AWS accepted our confirmation.
 *
 * Reuses the default cert-host allowlist for SSRF defense. Not
 * exported from handleSnsWebhook directly so route code can swallow
 * the confirm asynchronously without blocking the SNS ack.
 */
export async function confirmSnsSubscription(url: string, timeoutMs = 5_000): Promise<{ ok: boolean; status: number }> {
  const { default: https } = await import('node:https')
  const { URL } = await import('node:url')

  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return { ok: false, status: 0 }
    // Same allowlist pattern as CertFetcher — SNS cert URLs + subscribe URLs
    // share the same SSRF risk profile.
    const host = parsed.hostname.toLowerCase()
    const allowlist = (process.env.EMAIL_WEBHOOK_SNS_CERT_HOST_ALLOWLIST ?? '.amazonaws.com')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    if (!allowlist.some((suffix) => host.endsWith(suffix))) {
      return { ok: false, status: 0 }
    }

    return await new Promise((resolve) => {
      const req = https.get(url, { timeout: timeoutMs }, (res) => {
        res.resume() // discard body
        resolve({ ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300, status: res.statusCode ?? 0 })
      })
      req.on('timeout', () => {
        req.destroy()
        resolve({ ok: false, status: 0 })
      })
      req.on('error', () => resolve({ ok: false, status: 0 }))
    })
  } catch {
    return { ok: false, status: 0 }
  }
}
