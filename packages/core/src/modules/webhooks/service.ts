/**
 * Gbox Platform — Webhook Delivery Service
 *
 * Registration, delivery, retry, and cleanup for Shopify-style webhook topics.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import {
  signBody,
  getShopWebhookSecretBundle,
} from './hmac.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Selectable<T> = { [K in keyof T]: T[K] extends import('kysely').ColumnType<infer S, any, any> ? S : T[K] }

export type Webhook = Selectable<Database['webhooks']>
export type WebhookDelivery = Selectable<Database['webhook_deliveries']>

/**
 * Supported webhook topics (Shopify-compatible).
 */
export const SUPPORTED_TOPICS = [
  'orders/create',
  'orders/update',
  'orders/cancel',
  'orders/fulfilled',
  'products/create',
  'products/update',
  'products/delete',
  'customers/create',
  'customers/update',
  'customers/delete',
  'checkouts/create',
  'checkouts/update',
  'app/uninstalled',
  'shop/update',
] as const

export type WebhookTopic = (typeof SUPPORTED_TOPICS)[number]

export interface WebhookWithDeliveries extends Webhook {
  recentDeliveries: WebhookDelivery[]
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Register a new webhook for a shop.
 */
export async function registerWebhook(
  db: Kysely<Database>,
  shopId: string,
  topic: string,
  address: string,
  format: string = 'json',
): Promise<Webhook> {
  // Validate topic
  if (!SUPPORTED_TOPICS.includes(topic as WebhookTopic)) {
    throw new Error(
      `Unsupported webhook topic: "${topic}". Supported: ${SUPPORTED_TOPICS.join(', ')}`,
    )
  }

  // Check for duplicate
  const existing = await db
    .selectFrom('webhooks')
    .select('id')
    .where('shop_id', '=', shopId)
    .where('topic', '=', topic)
    .where('address', '=', address)
    .executeTakeFirst()

  if (existing) {
    throw new Error(`Webhook already registered for topic "${topic}" at address "${address}"`)
  }

  const row = await db
    .insertInto('webhooks')
    .values({
      shop_id: shopId,
      topic,
      address,
      format,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return row as Webhook
}

/**
 * Delete a webhook by ID.
 */
export async function deleteWebhook(
  db: Kysely<Database>,
  webhookId: string,
): Promise<void> {
  // Delete deliveries first
  await db.deleteFrom('webhook_deliveries').where('webhook_id', '=', webhookId).execute()
  await db.deleteFrom('webhooks').where('id', '=', webhookId).execute()
}

/**
 * List all webhooks for a shop.
 */
export async function listWebhooks(
  db: Kysely<Database>,
  shopId: string,
): Promise<Webhook[]> {
  const rows = await db
    .selectFrom('webhooks')
    .selectAll()
    .where('shop_id', '=', shopId)
    .orderBy('created_at', 'desc')
    .execute()

  return rows as Webhook[]
}

/**
 * Get a single webhook with its recent deliveries (last 20).
 */
export async function getWebhook(
  db: Kysely<Database>,
  webhookId: string,
): Promise<WebhookWithDeliveries | null> {
  const webhook = await db
    .selectFrom('webhooks')
    .selectAll()
    .where('id', '=', webhookId)
    .executeTakeFirst()

  if (!webhook) return null

  const deliveries = await db
    .selectFrom('webhook_deliveries')
    .selectAll()
    .where('webhook_id', '=', webhookId)
    .orderBy('created_at', 'desc')
    .limit(20)
    .execute()

  return {
    ...(webhook as Webhook),
    recentDeliveries: deliveries as WebhookDelivery[],
  }
}

/**
 * Deliver a single webhook (POST + record). Used by both the legacy
 * synchronous path and the BullMQ background worker.
 *
 * Throws on transport-level failure so BullMQ can retry the job. The
 * delivery row is recorded BEFORE throwing so failed attempts are still
 * visible in the merchant dashboard.
 */
export async function deliverOneWebhook(
  db: Kysely<Database>,
  webhook: Webhook,
  topic: string,
  payload: unknown,
): Promise<{ status: 'success' | 'failure'; responseCode: number | null }> {
  // Phase 0 §8 Item #2 — fetch the full signing bundle so we include
  // both the current and (if still in the grace window) the previous
  // signature. Merchants flip their verifier at their own pace; the
  // previous header disappears automatically when the grace window
  // expires (see `getRotationGraceDays`).
  const bundle = await getShopWebhookSecretBundle(db, webhook.shop_id)

  // IMPORTANT: sign the exact serialized bytes we send — never
  // re-serialize on the receiving side before verification.
  const serialized = JSON.stringify(payload)
  const signature = signBody(bundle.current, serialized)
  const previousSignature = bundle.previous
    ? signBody(bundle.previous, serialized)
    : null

  const startTime = Date.now()
  let status: 'success' | 'failure' = 'failure'
  let responseCode: number | null = null
  let responseBody: string | null = null
  let transportError: Error | null = null

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Gbox-Topic': topic,
      'X-Gbox-Shop-Id': webhook.shop_id,
      'X-Gbox-Webhook-Id': webhook.id,
      'X-Gbox-Hmac-SHA256': signature,
    }
    if (previousSignature) {
      headers['X-Gbox-Hmac-SHA256-Previous'] = previousSignature
    }
    if (bundle.rotatedAt) {
      headers['X-Gbox-Secret-Rotated-At'] = bundle.rotatedAt
    }

    const response = await fetch(webhook.address, {
      method: 'POST',
      headers,
      body: serialized,
      signal: AbortSignal.timeout(30_000),
    })

    responseCode = response.status
    responseBody = await response.text().catch(() => null)
    status = response.ok ? 'success' : 'failure'
  } catch (err) {
    transportError = err instanceof Error ? err : new Error(String(err))
    responseBody = transportError.message
  }

  const durationMs = Date.now() - startTime

  await db
    .insertInto('webhook_deliveries')
    .values({
      webhook_id: webhook.id,
      status,
      response_code: responseCode,
      request_body: serialized,
      response_body: responseBody,
      duration_ms: durationMs,
    })
    .execute()

  // Throw AFTER persisting so the queue retry sees the failure but the
  // delivery row already exists for the dashboard.
  if (transportError) throw transportError
  if (status === 'failure') {
    throw new Error(`webhook returned ${responseCode}: ${responseBody?.slice(0, 200) ?? ''}`)
  }

  return { status, responseCode }
}

/**
 * Trigger all webhooks matching a shop + topic.
 *
 * NOTE: this is the SYNCHRONOUS in-process path. New code should
 * prefer `enqueueWebhookDelivery` from the queue module so the HTTP
 * fetch happens in a background worker and doesn't block the request.
 * Kept here for backwards compat + the BullMQ worker itself.
 */
export async function triggerWebhook(
  db: Kysely<Database>,
  shopId: string,
  topic: string,
  payload: unknown,
): Promise<void> {
  const webhooks = await db
    .selectFrom('webhooks')
    .selectAll()
    .where('shop_id', '=', shopId)
    .where('topic', '=', topic)
    .execute()

  for (const webhook of webhooks) {
    // Swallow per-webhook errors so one bad subscriber doesn't take
    // down the others. The error is already recorded in webhook_deliveries.
    await deliverOneWebhook(db, webhook as Webhook, topic, payload).catch(
      () => undefined,
    )
  }
}

/**
 * Retry a failed delivery by re-sending its original request body.
 */
export async function retryDelivery(
  db: Kysely<Database>,
  deliveryId: string,
): Promise<void> {
  const delivery = await db
    .selectFrom('webhook_deliveries')
    .selectAll()
    .where('id', '=', deliveryId)
    .executeTakeFirst()

  if (!delivery) {
    throw new Error(`Webhook delivery ${deliveryId} not found`)
  }

  const webhook = await db
    .selectFrom('webhooks')
    .selectAll()
    .where('id', '=', delivery.webhook_id)
    .executeTakeFirst()

  if (!webhook) {
    throw new Error(`Webhook ${delivery.webhook_id} no longer exists`)
  }

  const startTime = Date.now()
  let status: 'success' | 'failure' = 'failure'
  let responseCode: number | null = null
  let responseBody: string | null = null

  try {
    const body =
      typeof delivery.request_body === 'string'
        ? delivery.request_body
        : JSON.stringify(delivery.request_body)

    // Phase 0 §8 Item #2 — same rotation-aware signing as the primary
    // delivery path. A retry may span a rotation, so we always re-read
    // the bundle here instead of caching.
    const bundle = await getShopWebhookSecretBundle(db, webhook.shop_id)
    const signature = signBody(bundle.current, body)
    const previousSignature = bundle.previous
      ? signBody(bundle.previous, body)
      : null

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Gbox-Topic': webhook.topic,
      'X-Gbox-Shop-Id': webhook.shop_id,
      'X-Gbox-Webhook-Id': webhook.id,
      'X-Gbox-Retry': 'true',
      'X-Gbox-Hmac-SHA256': signature,
    }
    if (previousSignature) {
      headers['X-Gbox-Hmac-SHA256-Previous'] = previousSignature
    }
    if (bundle.rotatedAt) {
      headers['X-Gbox-Secret-Rotated-At'] = bundle.rotatedAt
    }

    const response = await fetch(webhook.address, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(30_000),
    })

    responseCode = response.status
    responseBody = await response.text().catch(() => null)
    status = response.ok ? 'success' : 'failure'
  } catch (err) {
    responseBody = err instanceof Error ? err.message : String(err)
  }

  const durationMs = Date.now() - startTime

  await db
    .insertInto('webhook_deliveries')
    .values({
      webhook_id: webhook.id,
      status,
      response_code: responseCode,
      request_body: delivery.request_body as any,
      response_body: responseBody,
      duration_ms: durationMs,
    })
    .execute()
}

/**
 * Delete webhook deliveries older than a given number of days.
 * Returns the count of deleted rows.
 */
export async function cleanOldDeliveries(
  db: Kysely<Database>,
  olderThanDays: number,
): Promise<number> {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - olderThanDays)

  const result = await db
    .deleteFrom('webhook_deliveries')
    .where('created_at', '<', cutoff.toISOString())
    .executeTakeFirst()

  return Number(result.numDeletedRows)
}
