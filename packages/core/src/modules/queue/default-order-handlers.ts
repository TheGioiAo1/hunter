/**
 * Gbox Platform — Default Order-Processing Handlers (Phase 3 close-the-loop)
 *
 * Stub handlers that keep the order-processing queue from dead-lettering
 * every job until the real email / analytics / fulfilment services land.
 *
 * The problem: `completeCheckout()` in `checkout/service.ts` fans out to
 * four kinds after every successful checkout — `confirmation_email`,
 * `merchant_notification`, `receipt`, `analytics`. If the boot code
 * calls `startWorkers(db)` without registering a handler for each kind,
 * every job throws "no handler registered" and BullMQ retries it to
 * exhaustion, filling the DLQ.
 *
 * The fix: ship an opinionated default module that registers a no-op
 * observer for every known kind. It logs the job, optionally increments
 * a metric, and returns. Production deployments override specific kinds
 * by calling `registerOrderHandler(...)` AFTER this module runs:
 *
 *     registerDefaultOrderHandlers()                        // stubs first
 *     registerOrderHandler('confirmation_email', realEmailSender)  // override
 *     startWorkers(db)
 *
 * The override order matters because `registerOrderHandler` is a last-
 * writer-wins map: registering a real sender AFTER the stub replaces it.
 *
 * Side benefits of this approach:
 *
 *   1. End-to-end smoke tests can run `completeCheckout` without
 *      needing a SendGrid/SMTP stub — the stub handlers absorb the
 *      fan-out jobs and the test asserts on log output instead.
 *
 *   2. A merchant integrating with their own email provider replaces
 *      only the two kinds they care about (confirmation_email and
 *      receipt) and the rest stay as silent observers — no accidental
 *      double-send risk.
 *
 *   3. The stub logs are the single source of truth for "which fan-out
 *      kinds exist" — a developer skimming production logs can grep
 *      `[order-processing]` and see every kind that fired, which is
 *      faster than reading the queue dashboard.
 *
 * This module is intentionally tiny and dependency-free so it can be
 * imported from any boot path (storefront, API, worker, test) without
 * pulling in an email client.
 */

import type { OrderProcessingHandler } from './workers.js'
import type { OrderProcessingJob, OrderProcessingKind } from './queues.js'
import { registerOrderHandler } from './workers.js'

/**
 * Canonical list of kinds we ship a default for. Kept here rather
 * than in `queues.ts` so the fan-out payload type stays the only
 * source of truth for which kinds exist, but this list is what
 * `registerDefaultOrderHandlers` actually iterates over.
 */
export const DEFAULT_ORDER_KINDS: readonly OrderProcessingKind[] = [
  'confirmation_email',
  'merchant_notification',
  'receipt',
  'analytics',
  'fulfillment_hold',
  'loyalty_points',
] as const

/**
 * Factory that builds one no-op handler. Kept as a factory (not a
 * pre-built constant) so each handler closes over its `kind`, which
 * lets the log line identify which stub fired without reading
 * `job.kind` — useful when boot-time log prefixes are grepped.
 */
export function buildStubOrderHandler(
  kind: OrderProcessingKind,
  logger: (msg: string) => void = (msg) => console.info(msg),
): OrderProcessingHandler {
  return async (_db, job: OrderProcessingJob) => {
    logger(
      `[order-processing:stub] kind=${kind} shop=${job.shop_id} ` +
        `order=${job.order_id} (no real handler registered — job observed only)`,
    )
  }
}

/**
 * Register a stub handler for every known `OrderProcessingKind`.
 * Safe to call multiple times — later registrations silently win,
 * matching how `registerOrderHandler` already behaves.
 *
 * Pass a `logger` override when the host app wants the stub output
 * to flow through its structured logger instead of `console.info`.
 */
export function registerDefaultOrderHandlers(
  logger?: (msg: string) => void,
): void {
  for (const kind of DEFAULT_ORDER_KINDS) {
    registerOrderHandler(kind, buildStubOrderHandler(kind, logger))
  }
}
