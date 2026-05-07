/**
 * Integration smoke test — BullMQ webhook-delivery queue (Decision #8).
 *
 * Verifies the producer→queue→worker→deliverOneWebhook→webhook_deliveries
 * pipeline end-to-end. Spins up a tiny HTTP server to receive the webhook,
 * enqueues a job, starts the worker, and asserts that the receiver got
 * called with a valid HMAC signature within ~5 seconds.
 *
 * Per PRINCIPLES.md P22, hits real Postgres + Redis. Set DATABASE_URL +
 * REDIS_URL.
 *
 * Run:
 *   DATABASE_URL=... REDIS_URL=... npx tsx tests/queue-webhook-delivery.test.ts
 */

import http from 'node:http'
import crypto from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import { registerWebhook } from '../packages/core/src/modules/webhooks/service.js'
import { getShopWebhookSecret } from '../packages/core/src/modules/webhooks/hmac.js'
import {
  enqueueWebhookDelivery,
  startWorkers,
  stopWorkers,
  closeAllQueues,
  closeQueueConnection,
} from '../packages/core/src/modules/queue/index.js'
import { closeRedis } from '../packages/core/src/modules/cache/redis.js'

async function main() {
  const db = createDb()
  const suffix = Math.random().toString(36).slice(2, 10)
  let shopId: string | undefined
  let webhookId: string | undefined
  let receiverServer: http.Server | undefined

  // ---- Receiver: a one-shot HTTP server that captures the inbound request ----
  let received: { headers: http.IncomingHttpHeaders; body: string } | null = null
  const receivedPromise = new Promise<void>((resolve) => {
    receiverServer = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        received = { headers: req.headers, body }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
        resolve()
      })
    })
    receiverServer.listen(0) // random free port
  })

  try {
    const port = (receiverServer!.address() as any).port
    const receiverUrl = `http://127.0.0.1:${port}/hook`

    // ---- Seed: shop + webhook subscription ----
    const shop = await db
      .insertInto('shops')
      .values({
        name: `Queue Test ${suffix}`,
        slug: `queue-test-${suffix}`,
        email: `queue-test-${suffix}@test.local`,
        currency: 'USD',
        plan: 'basic',
        status: 'active',
      } as any)
      .returning('id')
      .executeTakeFirstOrThrow()
    shopId = shop.id

    const webhook = await registerWebhook(
      db,
      shopId,
      'orders/create',
      receiverUrl,
    )
    webhookId = webhook.id

    // ---- Start the worker (in this same process) ----
    startWorkers(db)

    // ---- Enqueue a job ----
    const payload = { order_id: `test-${suffix}`, foo: 'bar' }
    await enqueueWebhookDelivery({
      shop_id: shopId,
      topic: 'orders/create',
      payload,
    })

    // ---- Wait for the receiver to be hit (max 10s) ----
    await Promise.race([
      receivedPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timed out waiting for webhook')), 10_000),
      ),
    ])

    if (!received) throw new Error('receiver got nothing')

    // ---- Assert headers + body ----
    const r = received as { headers: http.IncomingHttpHeaders; body: string }
    if (r.headers['x-gbox-topic'] !== 'orders/create') {
      throw new Error(`wrong topic header: ${r.headers['x-gbox-topic']}`)
    }
    if (r.headers['x-gbox-shop-id'] !== shopId) {
      throw new Error(`wrong shop_id header: ${r.headers['x-gbox-shop-id']}`)
    }
    const sig = r.headers['x-gbox-hmac-sha256'] as string | undefined
    if (!sig) throw new Error('missing HMAC header')

    const parsed = JSON.parse(r.body)
    if (parsed.order_id !== `test-${suffix}`) {
      throw new Error(`wrong body: ${r.body}`)
    }

    // ---- Verify the HMAC signature against the shop secret ----
    const shopSecret = await getShopWebhookSecret(db, shopId)
    const expected = crypto
      .createHmac('sha256', shopSecret)
      .update(r.body)
      .digest('base64')
    if (expected !== sig) {
      throw new Error(`HMAC mismatch: expected ${expected}, got ${sig}`)
    }

    // ---- Verify a webhook_deliveries row was written ----
    // Poll briefly: the worker writes the row AFTER the receiver responds,
    // so there is a sub-second race between receivedPromise resolving and
    // the insert landing.
    let delivery: any = null
    for (let i = 0; i < 20; i++) {
      delivery = await db
        .selectFrom('webhook_deliveries')
        .selectAll()
        .where('webhook_id', '=', webhookId)
        .orderBy('created_at', 'desc')
        .executeTakeFirst()
      if (delivery) break
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!delivery) throw new Error('no webhook_deliveries row recorded')
    if (delivery.status !== 'success') {
      throw new Error(`delivery status was ${delivery.status}, expected success`)
    }

    console.log('PASS — webhook delivered via BullMQ worker, signature valid, row recorded')
  } finally {
    // ---- Tear down ----
    await stopWorkers().catch(() => {})
    await closeAllQueues().catch(() => {})

    if (webhookId) {
      await db.deleteFrom('webhook_deliveries').where('webhook_id', '=', webhookId).execute().catch(() => {})
      await db.deleteFrom('webhooks').where('id', '=', webhookId).execute().catch(() => {})
    }
    if (shopId) {
      await db.deleteFrom('shop_settings').where('shop_id', '=', shopId).execute().catch(() => {})
      await db.deleteFrom('shops').where('id', '=', shopId).execute().catch(() => {})
    }

    if (receiverServer) {
      await new Promise<void>((resolve) => receiverServer!.close(() => resolve()))
    }
    await db.destroy()
    await closeRedis().catch(() => {})
    await closeQueueConnection().catch(() => {})
  }
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  process.exit(1)
})
