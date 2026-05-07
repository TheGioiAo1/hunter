/**
 * Gbox Platform — Queue registry
 *
 * One BullMQ Queue per logical job class. Producers `import { webhookDeliveryQueue }`
 * and call `.add(jobName, data, opts)`. Workers live in ./workers.ts and are
 * started exactly once at boot via `startWorkers()`.
 *
 * QUEUE NAMES are stable strings — never rename without a Redis flush, since
 * BullMQ persists all metadata under `bull:<queueName>:*`.
 *
 * Default job options:
 *   - attempts: 5 with exponential backoff (1s, 5s, 25s, ...)
 *   - removeOnComplete: keep 1000 most recent (for `bullboard` debugging)
 *   - removeOnFail:     keep 5000 most recent (so we can retry-from-dashboard)
 */

import { Queue, type JobsOptions } from 'bullmq'
import { getQueueConnection } from './connection.js'

export const QUEUE_NAMES = {
  webhookDelivery: 'webhook-delivery',
  emailSend: 'email-send',
  inventorySync: 'inventory-sync',
  imageResize: 'image-resize',
  searchIndex: 'search-index',
  websiteClone: 'website-clone',
  // Phase C2 — smart collection re-evaluation. One job per
  // (collectionId, shopId) re-runs the rule evaluator and syncs
  // `collection_products` for that ONE collection. Jobs are triggered
  // by collection save + product mutations (tags/price/inventory/etc).
  collectionSync: 'collection-sync',
  // Phase B — video transcode pipeline (spec §12). One job per
  // uploaded source video. Worker runs ffmpeg ladder (1080p/720p/480p/240p)
  // + poster + 10 scrub thumbs, writes outputs back to S3.
  // Triggered by S3 event (ObjectCreated) on `shops/*/videos/*/source.*`.
  transcode: 'transcode',
  // Phase B — image ingestion & pre-warm (spec §11.5 + §15.3). Worker:
  //   1. Strips EXIF, extracts blurhash + dominant_color,
  //   2. Writes `{image_id}.meta.json` beside the original,
  //   3. Issues HEAD requests to 5 pre-warm widths through Cloudflare.
  // Triggered by S3 event on `shops/*/products|collections|reviews/*`.
  mediaIngest: 'media-ingest',
  // Phase 3C — post-checkout async side effects. Decoupling these
  // from the synchronous checkout transaction lets a single API
  // worker sustain ~10x the orders/sec it could sustain if email
  // + receipt generation + analytics were inline. The order row
  // itself is STILL created synchronously inside completeCheckout
  // so the customer gets a real order id in the payment response.
  orderProcessing: 'order-processing',
  // Phase 2 Admin Polish §2.3 — background audit-log exports. The
  // synchronous `?export=csv` path on /god-admin/security caps at
  // 10k rows; compliance audits occasionally need 100k+ rows which
  // would lock a request worker for ~30s. This queue moves the big
  // exports to a background job that streams CSV to disk.
  auditExport: 'audit-export',
} as const

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES]

const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 1000, // first retry after 1s; doubles each attempt
  },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
}

const queues: Map<QueueName, Queue> = new Map()

function makeQueue(name: QueueName): Queue {
  const existing = queues.get(name)
  if (existing) return existing

  const q = new Queue(name, {
    connection: getQueueConnection(),
    defaultJobOptions,
  })
  queues.set(name, q)
  return q
}

// ---------------------------------------------------------------------------
// Public queue accessors — lazy so importing this file does not connect
// to Redis until something actually enqueues.
// ---------------------------------------------------------------------------

export function webhookDeliveryQueue(): Queue {
  return makeQueue(QUEUE_NAMES.webhookDelivery)
}

export function emailSendQueue(): Queue {
  return makeQueue(QUEUE_NAMES.emailSend)
}

export function inventorySyncQueue(): Queue {
  return makeQueue(QUEUE_NAMES.inventorySync)
}

export function imageResizeQueue(): Queue {
  return makeQueue(QUEUE_NAMES.imageResize)
}

export function searchIndexQueue(): Queue {
  return makeQueue(QUEUE_NAMES.searchIndex)
}

export function websiteCloneQueue(): Queue {
  return makeQueue(QUEUE_NAMES.websiteClone)
}

export function collectionSyncQueue(): Queue {
  return makeQueue(QUEUE_NAMES.collectionSync)
}

export function transcodeQueue(): Queue {
  return makeQueue(QUEUE_NAMES.transcode)
}

export function mediaIngestQueue(): Queue {
  return makeQueue(QUEUE_NAMES.mediaIngest)
}

export function orderProcessingQueue(): Queue {
  return makeQueue(QUEUE_NAMES.orderProcessing)
}

export function auditExportQueue(): Queue {
  return makeQueue(QUEUE_NAMES.auditExport)
}

// ---------------------------------------------------------------------------
// Job payload types — single source of truth so producers + workers stay in sync.
// ---------------------------------------------------------------------------

export interface WebhookDeliveryJob {
  shop_id: string
  topic: string
  payload: unknown
  /** Optional: target a single webhook (used by retry-delivery). */
  webhook_id?: string
  /** Marks the delivery as a retry of an existing failed delivery row. */
  retry_of_delivery_id?: string
}

export type { WebsiteCloneJob } from './clone-worker.js'

export interface EmailSendJob {
  shop_id: string
  to: string
  subject: string
  template: string
  data: Record<string, unknown>
}

/**
 * Phase C2 — smart collection sync job.
 *
 * `collectionId` is the only required id; `shopId` is denormalised
 * into the payload so the worker can skip a lookup and we can enforce
 * the shop scope at the worker level as a defence-in-depth check.
 *
 * `reason` is optional and informational — appears in BullMQ's job
 * name so dashboard operators can tell "re-eval because title changed"
 * from "re-eval because variant price changed".
 */
export interface CollectionSyncJob {
  collectionId: string
  shopId: string
  reason?: string
}

/**
 * Phase B — video transcode job (spec §12).
 *
 * Worker downloads the source from S3, runs ffmpeg HLS ladder, uploads
 * outputs back to the same video prefix. Schema is stable across retries:
 * a re-enqueue of the same `videoId` is idempotent on the output side
 * because keys are deterministic.
 */
export interface TranscodeJob {
  shopId: string
  videoId: string
  /** S3 key of the uploaded source, e.g. `shops/s/videos/v/source.mp4` */
  srcKey: string
  /** Bucket the source lives in — usually the public-media bucket. */
  bucket: string
  /**
   * Ladder override. Default `['1080p', '720p', '480p', '240p']`. Shorter
   * ladders are accepted for low-bandwidth shops or compliance regions.
   */
  ladder?: Array<'1080p' | '720p' | '480p' | '240p'>
}

/**
 * Phase B — image ingestion job.
 *
 * Worker:
 *   1. HeadObject on `srcKey` to confirm the upload completed,
 *   2. Downloads the original, runs sharp: strip EXIF, extract blurhash,
 *      compute dominant_color, write `{image_id}.meta.json`,
 *   3. Pre-warms Cloudflare edge by HEAD-fetching 5 bucketed widths
 *      (spec §11.5).
 *
 * Deduplication: jobId = `ingest:{shopId}:{image_id}` so rapid duplicate
 * events (S3 sometimes fires twice) collapse into a single run.
 */
export interface MediaIngestJob {
  shopId: string
  /** Database row id in `media_assets` */
  assetId: string
  /** S3 key of the uploaded original. */
  srcKey: string
  bucket: string
  /** Hint so the worker can skip unsupported types without downloading. */
  contentType?: string
}

/**
 * Post-checkout async side effects. Each job is a single KIND plus
 * a handful of scalar fields so the worker can dispatch by kind
 * without pulling the whole order drop at enqueue time. The worker
 * reads the fresh order row from the DB by id — important because
 * fulfillment state may change between enqueue and processing.
 *
 * KINDS:
 *   - `confirmation_email` — customer-facing order confirmation
 *   - `merchant_notification` — merchant "new order" email
 *   - `receipt` — PDF / HTML receipt generation + store on S3
 *   - `analytics` — push event to whatever analytics sink is wired
 *   - `fulfillment_hold` — reserve stock in WMS if external
 *   - `loyalty_points` — award customer loyalty on redemption apps
 */
export type OrderProcessingKind =
  | 'confirmation_email'
  | 'merchant_notification'
  | 'receipt'
  | 'analytics'
  | 'fulfillment_hold'
  | 'loyalty_points'

export interface OrderProcessingJob {
  kind: OrderProcessingKind
  shop_id: string
  order_id: string
  /** Optional extra context so the worker doesn't always re-query. */
  hint?: Record<string, unknown>
}

/**
 * Audit-log background export job (Phase 2 Admin Polish §2.3).
 *
 * One job per requested export. The worker streams rows out of
 * `audit_logs` (joined against users + shops for humanised output),
 * writes a CSV file to `AUDIT_EXPORT_DIR`, and updates the Redis
 * tracking meta so the god admin can poll + download the result.
 *
 * Fields:
 *   - `export_id`        — UUID, matches `gbox:audit_export:<id>`.
 *   - `actor_user_id`    — who queued the export (used for the
 *                          per-user index so one admin can't see
 *                          another admin's exports).
 *   - `actor_email`      — denormalised so the finished CSV row in
 *                          the activity log has a human handle.
 *   - `filters`          — identical shape to `ExportFilters` in
 *                          `packages/core/src/modules/audit/export.ts`.
 *                          Serialisable JSON.
 *   - `row_limit`        — worker-side hard cap. Defaults to 100,000.
 */
export interface AuditExportJob {
  export_id: string
  actor_user_id: string
  actor_email: string | null
  filters: {
    action?: string
    userEmail?: string
    shopId?: string
    fromIso?: string
    toIso?: string
  }
  row_limit: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Enqueue a webhook delivery job. Producers should call this instead of
 * doing the fetch synchronously inside the request handler.
 */
export async function enqueueWebhookDelivery(
  data: WebhookDeliveryJob,
  opts?: JobsOptions,
): Promise<void> {
  const jobName = `webhook:${data.topic}`
  await webhookDeliveryQueue().add(jobName, data, opts)
}

/**
 * Enqueue a website clone job.
 *
 * Phase 7 Step 7.1 — returns `{ id }` so callers can stamp
 * `storefront_clone_jobs.bullmq_job_id` (migration 046) inside the
 * same HTTP handler. String-coerced because BullMQ's typings widen to
 * `string | number | undefined`; in practice v5 always produces a
 * UUID string.
 */
export async function enqueueWebsiteClone(
  data: import('./clone-worker.js').WebsiteCloneJob,
  opts?: JobsOptions,
): Promise<{ id: string }> {
  const jobName = `clone:${data.sourceUrl}`
  const job = await websiteCloneQueue().add(jobName, data, {
    ...opts,
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  })
  return { id: String(job.id ?? '') }
}

/**
 * Enqueue a smart-collection re-evaluation. Idempotent-by-key — we
 * use `collection:{id}` as the BullMQ jobId so rapid-fire triggers
 * (e.g. a merchant typing in the product editor) collapse into one
 * pending job instead of a stampede.
 *
 * Phase C2 returns void because producers don't need the job id —
 * the sync is eventually-consistent and the UI doesn't wait on it.
 */
export async function enqueueCollectionSync(
  data: CollectionSyncJob,
  opts?: JobsOptions,
): Promise<void> {
  const jobName = data.reason ? `sync:${data.reason}` : 'sync:generic'
  await collectionSyncQueue().add(jobName, data, {
    // Idempotency: if a job with this id is already waiting, BullMQ
    // silently drops the duplicate. Delayed jobs still accept new
    // data (rare — we don't schedule future-dated re-evals).
    jobId: `collection:${data.collectionId}`,
    ...opts,
  })
}

/**
 * Phase B — enqueue a video transcode job. Idempotent-by-videoId so
 * S3 event duplicates don't stack up duplicate ffmpeg runs.
 *
 * Retry policy override: transcode is expensive. 2 attempts total
 * (original + 1 retry) with a 5-minute backoff — if the second attempt
 * still fails, DLQ it for Thai to inspect instead of burning GPU time.
 */
export async function enqueueTranscode(
  data: TranscodeJob,
  opts?: JobsOptions,
): Promise<{ id: string }> {
  const jobName = `transcode:${data.shopId}:${data.videoId}`
  const job = await transcodeQueue().add(jobName, data, {
    jobId: `video:${data.shopId}:${data.videoId}`,
    attempts: 2,
    backoff: { type: 'fixed', delay: 300_000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1000 },
    ...opts,
  })
  return { id: String(job.id ?? '') }
}

/**
 * Phase B — enqueue an image ingestion + pre-warm job. Cheap per job
 * (~2s of sharp work) so we use the default 5-attempt retry policy.
 */
export async function enqueueMediaIngest(
  data: MediaIngestJob,
  opts?: JobsOptions,
): Promise<void> {
  const jobName = `ingest:${data.shopId}:${data.assetId}`
  await mediaIngestQueue().add(jobName, data, {
    jobId: `ingest:${data.shopId}:${data.assetId}`,
    ...opts,
  })
}

/**
 * Enqueue a single post-checkout async side effect. Call this once
 * per KIND you want the worker to run — the checkout caller
 * typically enqueues `confirmation_email`, `merchant_notification`,
 * `receipt`, and `analytics` in a fan-out right after the order
 * transaction commits.
 */
export async function enqueueOrderProcessing(
  data: OrderProcessingJob,
  opts?: JobsOptions,
): Promise<void> {
  const jobName = `order:${data.kind}`
  await orderProcessingQueue().add(jobName, data, opts)
}

/**
 * Fan out ALL standard post-order jobs in a single call. Used by
 * `completeCheckout` so the call site stays a one-liner.
 *
 * Failures are swallowed by BullMQ's own retry — callers should
 * still wrap the call in a try/catch so a Redis outage doesn't
 * turn a successful order into a failed checkout response.
 */
export async function enqueueStandardOrderFanout(
  shop_id: string,
  order_id: string,
  opts?: JobsOptions,
): Promise<void> {
  const q = orderProcessingQueue()
  const kinds: OrderProcessingKind[] = [
    'confirmation_email',
    'merchant_notification',
    'receipt',
    'analytics',
  ]
  await Promise.all(
    kinds.map((kind) =>
      q.add(`order:${kind}`, { kind, shop_id, order_id }, opts),
    ),
  )
}

/**
 * Close every initialized queue. Call from SIGINT/SIGTERM before
 * closing the underlying ioredis connection.
 */
export async function closeAllQueues(): Promise<void> {
  for (const q of queues.values()) {
    await q.close().catch(() => {})
  }
  queues.clear()
}
