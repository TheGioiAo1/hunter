/**
 * Gbox Platform — BullMQ workers
 *
 * Workers subscribe to a queue and execute jobs as they arrive. They
 * run inside the same Node process as the API server (no separate
 * worker process — yet). When traffic justifies it we can split this
 * file into a standalone PM2 entry without changing producer code.
 *
 * Concurrency: capped per queue. The webhook worker runs 10 concurrent
 * deliveries per process — enough to absorb bursts without saturating
 * upstream merchants.
 *
 * Retries: handled by BullMQ via `defaultJobOptions.attempts` in
 * queues.ts. The worker handler should THROW on failure; the queue
 * will reschedule with exponential backoff.
 */

import { Worker, type Job } from 'bullmq'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { getQueueConnection } from './connection.js'
import {
  QUEUE_NAMES,
  type AuditExportJob,
  type CollectionSyncJob,
  type OrderProcessingJob,
  type OrderProcessingKind,
  type WebhookDeliveryJob,
} from './queues.js'
import { deliverOneWebhook } from '../webhooks/service.js'
import { processAuditExportJob } from '../audit/background-export.js'
import { startCloneWorker } from './clone-worker.js'
import { syncSmartCollection } from '../collections/sync.js'

// ---------------------------------------------------------------------------
// Order-processing handler registry (Phase 3C)
// ---------------------------------------------------------------------------

/**
 * One handler per `OrderProcessingKind`. Every handler receives the
 * Kysely instance (so it can re-read the fresh order row) and the
 * full job payload. Handlers throw on failure — BullMQ will retry
 * via the `defaultJobOptions.attempts` policy in queues.ts.
 *
 * Handlers are INJECTED (not imported) so the email / receipt /
 * analytics services don't have to exist at the time this module
 * compiles. Boot code registers them via `registerOrderHandler`
 * before calling `startWorkers`.
 */
export type OrderProcessingHandler = (
  db: Kysely<Database>,
  job: OrderProcessingJob,
) => Promise<void>

const orderHandlers: Partial<Record<OrderProcessingKind, OrderProcessingHandler>> =
  {}

/**
 * Register (or override) the handler for a given
 * `OrderProcessingKind`. Call from boot before `startWorkers`.
 * Unregistered kinds cause the worker to throw, which in turn
 * triggers the BullMQ retry policy — so a missing handler WILL
 * surface as a `failed` log entry, not as silent data loss.
 */
export function registerOrderHandler(
  kind: OrderProcessingKind,
  handler: OrderProcessingHandler,
): void {
  orderHandlers[kind] = handler
}

/** Test helper — wipe the registry between cases. */
export function clearOrderHandlers(): void {
  for (const key of Object.keys(orderHandlers) as OrderProcessingKind[]) {
    delete orderHandlers[key]
  }
}

/**
 * Exported so tests can drive a single job through the exact same
 * dispatch logic the worker uses, without spinning up BullMQ.
 */
export async function dispatchOrderProcessingJob(
  db: Kysely<Database>,
  job: OrderProcessingJob,
): Promise<void> {
  const handler = orderHandlers[job.kind]
  if (!handler) {
    throw new Error(
      `[queue:order-processing] no handler registered for kind="${job.kind}"`,
    )
  }
  await handler(db, job)
}

let workersStarted = false
const activeWorkers: Worker[] = []

/**
 * Start every BullMQ worker. Idempotent — calling twice is a no-op.
 *
 * Pass the same Kysely instance the API server uses so the worker can
 * write to webhook_deliveries inside the same connection pool.
 */
export function startWorkers(db: Kysely<Database>): void {
  if (workersStarted) return
  workersStarted = true

  // -------------------------------------------------------------------------
  // webhook-delivery worker
  // -------------------------------------------------------------------------
  const webhookWorker = new Worker<WebhookDeliveryJob>(
    QUEUE_NAMES.webhookDelivery,
    async (job: Job<WebhookDeliveryJob>) => {
      const { shop_id, topic, payload, webhook_id } = job.data

      // Look up matching webhooks. If a single webhook_id was specified
      // (retry-from-dashboard case), only deliver to that one.
      let q = db
        .selectFrom('webhooks')
        .selectAll()
        .where('shop_id', '=', shop_id)
        .where('topic', '=', topic)
      if (webhook_id) q = q.where('id', '=', webhook_id)

      const webhooks = await q.execute()
      if (webhooks.length === 0) return { delivered: 0, skipped: true }

      // Deliver each in sequence — concurrency is at the JOB level,
      // not within a single job. This keeps per-shop ordering predictable.
      let delivered = 0
      const errors: string[] = []
      for (const w of webhooks) {
        try {
          await deliverOneWebhook(db, w as any, topic, payload)
          delivered += 1
        } catch (err) {
          errors.push(`${w.id}: ${(err as Error).message}`)
        }
      }

      // If ANY delivery failed, throw to trigger queue-level retry.
      // BullMQ will rerun the whole job; the deliverOneWebhook helper
      // already wrote a webhook_deliveries row for the failed attempt
      // so dashboards stay accurate.
      if (errors.length > 0) {
        throw new Error(
          `webhook delivery failed for ${errors.length}/${webhooks.length} subscribers: ${errors.join('; ')}`,
        )
      }

      return { delivered }
    },
    {
      connection: getQueueConnection(),
      concurrency: 10,
    },
  )

  webhookWorker.on('failed', (job, err) => {
    console.error(
      `[queue:webhook-delivery] job ${job?.id} failed (attempt ${job?.attemptsMade}/${job?.opts.attempts}): ${err.message}`,
    )
  })

  webhookWorker.on('error', (err) => {
    console.error('[queue:webhook-delivery] worker error:', err.message)
  })

  activeWorkers.push(webhookWorker)

  // -------------------------------------------------------------------------
  // order-processing worker (Phase 3C)
  // -------------------------------------------------------------------------
  const orderWorker = new Worker<OrderProcessingJob>(
    QUEUE_NAMES.orderProcessing,
    async (job: Job<OrderProcessingJob>) => {
      await dispatchOrderProcessingJob(db, job.data)
      return { kind: job.data.kind, order_id: job.data.order_id }
    },
    {
      connection: getQueueConnection(),
      // Concurrency here is higher than webhook-delivery because
      // each job is a local DB read + an outbound call, and we
      // already tolerate eventual-consistency semantics.
      concurrency: 25,
    },
  )

  orderWorker.on('failed', (job, err) => {
    console.error(
      `[queue:order-processing] job ${job?.id} kind=${job?.data?.kind} failed ` +
        `(attempt ${job?.attemptsMade}/${job?.opts.attempts}): ${err.message}`,
    )
  })

  orderWorker.on('error', (err) => {
    console.error('[queue:order-processing] worker error:', err.message)
  })

  activeWorkers.push(orderWorker)

  // -------------------------------------------------------------------------
  // audit-export worker (Phase 2 Admin Polish §2.3)
  // -------------------------------------------------------------------------
  //
  // Background audit-log exports. Each job streams up to 100k rows
  // to a CSV file under `AUDIT_EXPORT_DIR`. Concurrency is kept low
  // (2) because a single export runs a heavy COUNT-less paginated
  // query against audit_logs and we'd rather queue up than thrash
  // the primary.
  const auditExportWorker = new Worker<AuditExportJob>(
    QUEUE_NAMES.auditExport,
    async (job: Job<AuditExportJob>) => {
      await processAuditExportJob(db, job.data)
      return { export_id: job.data.export_id }
    },
    {
      connection: getQueueConnection(),
      concurrency: 2,
    },
  )

  auditExportWorker.on('failed', (job, err) => {
    console.error(
      `[queue:audit-export] job ${job?.id} export_id=${job?.data?.export_id} ` +
        `failed (attempt ${job?.attemptsMade}/${job?.opts.attempts}): ${err.message}`,
    )
  })

  auditExportWorker.on('error', (err) => {
    console.error('[queue:audit-export] worker error:', err.message)
  })

  activeWorkers.push(auditExportWorker)

  // -------------------------------------------------------------------------
  // website-clone worker — Phase 7 Step 7.1 wiring.
  //
  // The clone worker itself (concurrency / retry / stage tracking) lives
  // in `clone-worker.ts` and predates Phase 7; this call is the last
  // mile that actually boots it alongside the HTTP server. Without this
  // call, `enqueueWebsiteClone()` would park jobs in Redis with no
  // consumer and merchants would see eternal `pending` rows.
  //
  // `startCloneWorker()` is itself idempotent (it caches its Worker
  // instance in a module-level singleton), so even if some test harness
  // called it directly we still get exactly one BullMQ Worker per
  // Node process.
  // -------------------------------------------------------------------------
  const cloneWorker = startCloneWorker(db)
  activeWorkers.push(cloneWorker)

  // -------------------------------------------------------------------------
  // collection-sync worker — Phase C2
  //
  // Re-evaluates ONE smart collection's rules against its shop's
  // products and syncs the `collection_products` join table. Jobs are
  // idempotent by `collection:{id}` jobId, so a stampede of edits
  // collapses into one queued re-eval.
  //
  // Concurrency: 5. Each job issues ~3 queries (SELECT collection,
  // SELECT via evaluator, SELECT current members) plus at most one
  // INSERT and one DELETE — cheap. The cap is to protect us against
  // a pathological case where a merchant pushes a big CSV and we get
  // a burst of product-save triggers.
  // -------------------------------------------------------------------------
  const collectionSyncWorker = new Worker<CollectionSyncJob>(
    QUEUE_NAMES.collectionSync,
    async (job: Job<CollectionSyncJob>) => {
      const { collectionId, shopId } = job.data
      const result = await syncSmartCollection(db as unknown as Kysely<any>, {
        collectionId,
        shopId,
      })
      // Return the summary for bullmq-ui / bullboard — bullmq stores
      // return values with the completed job so operators can see
      // "3 added, 1 removed" without opening pg.
      return result
    },
    {
      connection: getQueueConnection(),
      concurrency: 5,
    },
  )

  collectionSyncWorker.on('failed', (job, err) => {
    console.error(
      `[queue:collection-sync] job ${job?.id} failed (attempt ${job?.attemptsMade}/${job?.opts.attempts}): ${err.message}`,
    )
  })

  collectionSyncWorker.on('error', (err) => {
    console.error('[queue:collection-sync] worker error:', err.message)
  })

  activeWorkers.push(collectionSyncWorker)
}

/**
 * Gracefully drain + close every worker. Call from SIGINT/SIGTERM.
 */
export async function stopWorkers(): Promise<void> {
  for (const w of activeWorkers) {
    await w.close().catch(() => {})
  }
  activeWorkers.length = 0
  workersStarted = false
}
