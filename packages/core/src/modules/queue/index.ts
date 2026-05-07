/**
 * Gbox Platform — Queue module barrel.
 *
 * Producers: import from '@gbox/core/modules/queue' (or relative
 * './queue/index.js') and call `enqueueWebhookDelivery(...)`.
 *
 * Workers: server boot calls `startWorkers(db)` once. PM2 graceful
 * shutdown calls `stopWorkers()` then `closeAllQueues()` then
 * `closeQueueConnection()`.
 */

export {
  getQueueConnection,
  closeQueueConnection,
} from './connection.js'

export {
  QUEUE_NAMES,
  webhookDeliveryQueue,
  emailSendQueue,
  inventorySyncQueue,
  imageResizeQueue,
  searchIndexQueue,
  // Phase 3C — post-checkout async side effects.
  orderProcessingQueue,
  // Phase 2 Admin Polish §2.3 — background audit-log exports.
  auditExportQueue,
  enqueueWebhookDelivery,
  enqueueOrderProcessing,
  enqueueStandardOrderFanout,
  enqueueWebsiteClone,
  websiteCloneQueue,
  // Phase C2 — smart collection re-evaluation.
  collectionSyncQueue,
  enqueueCollectionSync,
  // Phase B — video transcode + image ingestion (spec §11.5, §12).
  transcodeQueue,
  mediaIngestQueue,
  enqueueTranscode,
  enqueueMediaIngest,
  closeAllQueues,
  type QueueName,
  type WebhookDeliveryJob,
  type EmailSendJob,
  type OrderProcessingJob,
  type OrderProcessingKind,
  type AuditExportJob,
  type WebsiteCloneJob,
  type CollectionSyncJob,
  type TranscodeJob,
  type MediaIngestJob,
} from './queues.js'

export {
  startWorkers,
  stopWorkers,
  registerOrderHandler,
  clearOrderHandlers,
  dispatchOrderProcessingJob,
  type OrderProcessingHandler,
} from './workers.js'

export {
  DEFAULT_ORDER_KINDS,
  buildStubOrderHandler,
  registerDefaultOrderHandlers,
} from './default-order-handlers.js'

export { startCloneWorker, stopCloneWorker } from './clone-worker.js'
