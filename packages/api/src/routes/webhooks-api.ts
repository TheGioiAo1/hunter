/**
 * Gbox Platform — Webhook API Routes
 *
 * Shopify-compatible REST endpoints for webhook subscriptions.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(message: string, status: number): Response {
  return json({ errors: [message] }, status)
}

// Valid webhook topics
const VALID_TOPICS = [
  'orders/create',
  'orders/updated',
  'orders/cancelled',
  'orders/fulfilled',
  'orders/paid',
  'products/create',
  'products/update',
  'products/delete',
  'collections/create',
  'collections/update',
  'collections/delete',
  'customers/create',
  'customers/update',
  'customers/delete',
  'checkouts/create',
  'checkouts/update',
  'refunds/create',
  'app/uninstalled',
  'shop/update',
] as const

// ---------------------------------------------------------------------------
// GET /api/2026-04/webhooks.json
// ---------------------------------------------------------------------------

export async function listWebhooks(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
): Promise<Response> {
  try {
    const url = new URL(request.url)
    const topic = url.searchParams.get('topic')

    let query = db
      .selectFrom('webhooks')
      .selectAll()
      .where('shop_id', '=', shopId)

    if (topic) {
      query = query.where('topic', '=', topic)
    }

    const webhooks = await query.orderBy('created_at', 'desc').execute()

    return json({ webhooks })
  } catch (err) {
    return errorResponse('Failed to list webhooks', 500)
  }
}

// ---------------------------------------------------------------------------
// GET /api/2026-04/webhooks/:id.json
// ---------------------------------------------------------------------------

export async function getWebhook(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  webhookId: string,
): Promise<Response> {
  try {
    const webhook = await db
      .selectFrom('webhooks')
      .selectAll()
      .where('id', '=', webhookId)
      .where('shop_id', '=', shopId)
      .executeTakeFirst()

    if (!webhook) {
      return errorResponse('Webhook not found', 404)
    }

    return json({ webhook })
  } catch (err) {
    return errorResponse('Failed to get webhook', 500)
  }
}

// ---------------------------------------------------------------------------
// POST /api/2026-04/webhooks.json
// ---------------------------------------------------------------------------

interface CreateWebhookInput {
  topic: string
  address: string
  format?: string
}

export async function createWebhook(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as { webhook: CreateWebhookInput }
    if (!body.webhook) {
      return errorResponse('Missing "webhook" in request body', 422)
    }

    const data = body.webhook

    if (!data.topic) {
      return errorResponse('Topic is required', 422)
    }
    if (!VALID_TOPICS.includes(data.topic as any)) {
      return errorResponse(
        `Invalid topic "${data.topic}". Valid topics: ${VALID_TOPICS.join(', ')}`,
        422,
      )
    }
    if (!data.address) {
      return errorResponse('Address (callback URL) is required', 422)
    }

    // Validate URL format
    try {
      new URL(data.address)
    } catch {
      return errorResponse('Address must be a valid URL', 422)
    }

    const webhook = await db
      .insertInto('webhooks')
      .values({
        shop_id: shopId,
        topic: data.topic,
        address: data.address,
        format: data.format ?? 'json',
        api_version: '2026-04',
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return json({ webhook }, 201)
  } catch (err) {
    return errorResponse('Failed to create webhook', 500)
  }
}

// ---------------------------------------------------------------------------
// PUT /api/2026-04/webhooks/:id.json
// ---------------------------------------------------------------------------

interface UpdateWebhookInput {
  address?: string
  topic?: string
  format?: string
}

export async function updateWebhook(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  webhookId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as { webhook: UpdateWebhookInput }
    if (!body.webhook) {
      return errorResponse('Missing "webhook" in request body', 422)
    }

    const data = body.webhook

    if (data.topic && !VALID_TOPICS.includes(data.topic as any)) {
      return errorResponse(
        `Invalid topic "${data.topic}". Valid topics: ${VALID_TOPICS.join(', ')}`,
        422,
      )
    }

    if (data.address) {
      try {
        new URL(data.address)
      } catch {
        return errorResponse('Address must be a valid URL', 422)
      }
    }

    const updateFields: Record<string, unknown> = {}
    if (data.address !== undefined) updateFields.address = data.address
    if (data.topic !== undefined) updateFields.topic = data.topic
    if (data.format !== undefined) updateFields.format = data.format

    if (Object.keys(updateFields).length === 0) {
      return errorResponse('No fields to update', 422)
    }

    const webhook = await db
      .updateTable('webhooks')
      .set(updateFields)
      .where('id', '=', webhookId)
      .where('shop_id', '=', shopId)
      .returningAll()
      .executeTakeFirst()

    if (!webhook) {
      return errorResponse('Webhook not found', 404)
    }

    return json({ webhook })
  } catch (err) {
    return errorResponse('Failed to update webhook', 500)
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/2026-04/webhooks/:id.json
// ---------------------------------------------------------------------------

export async function deleteWebhook(
  request: Request,
  db: Kysely<Database>,
  shopId: string,
  webhookId: string,
): Promise<Response> {
  try {
    const result = await db
      .deleteFrom('webhooks')
      .where('id', '=', webhookId)
      .where('shop_id', '=', shopId)
      .executeTakeFirst()

    if (!result.numDeletedRows || result.numDeletedRows === BigInt(0)) {
      return errorResponse('Webhook not found', 404)
    }

    return new Response(null, { status: 200 })
  } catch (err) {
    return errorResponse('Failed to delete webhook', 500)
  }
}
