/**
 * Gbox Platform — Cron / Background Job Service
 *
 * Schedule, manage, and execute recurring background tasks.
 * Uses the cron_tasks table defined in the schema.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { recomputeAllLifecycleStages } from '../customer-lifecycle/recompute.js'
import {
  rollupYesterdayAllShops,
  pruneOldMetrics,
} from '../analytics/daily-metrics.js'
import { dispatchCampaignsTick } from '../marketing/campaigns-cron.js'
import { dispatchAbandonedCartTick } from '../marketing/abandoned-cart-cron.js'
import { processPendingGiftCardEmails } from '../gift-cards/email.js'
import { tickSla } from '../support-sla/engine.ts'
import {
  runCsatPrompts,
  runRetentionCleanup,
  runAutoCloseTick,
} from '../support-notifications/index.ts'
// Phase 14 PR7 (BUG-E4) — soft-bounce rollup cron. The function has
// existed since PR5 but was never wired into the cron registry, so the
// 5-transient-in-30d → hard promotion never fired in production.
// Registered below with a once-daily schedule (3am UTC) matching the
// retention + analytics-rollup window.
import { runSoftBounceAggregator } from '../email/bounce-aggregator.js'
// Phase 14 PR8 (bug 9) — zombie-queued janitor. Reaps rows left in
// status='queued' past the grace period (process crash between INSERT
// and SMTP response). Registered below with a 5-minute schedule; the
// handler name lives in the `EMAIL_CRON_HANDLERS` constant so the
// smoke script can assert wiring without string-matching this file.
import { sweepZombieDeliveries } from '../email/zombie-janitor.js'
import { EMAIL_CRON_HANDLERS } from '../email/cron-seed.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CronStatus = 'active' | 'paused' | 'running'

export interface CronHandler {
  (db: Kysely<Database>): Promise<void>
}

export interface JobResult {
  taskId: string
  name: string
  status: 'success' | 'error'
  durationMs: number
  error?: string
}

// ---------------------------------------------------------------------------
// Built-in job registry
// ---------------------------------------------------------------------------

/**
 * Registry of built-in handlers keyed by their task name.
 * Callers can register custom handlers via registerHandler().
 */
const handlerRegistry = new Map<string, CronHandler>()

export function registerHandler(name: string, handler: CronHandler): void {
  handlerRegistry.set(name, handler)
}

/**
 * Test / smoke helper — returns true if a handler with the given name has
 * been registered via `registerHandler`. The registry itself remains
 * module-local so callers can't hot-swap handlers at runtime, but smoke
 * tests need a way to assert "the soft-bounce handler was wired on boot"
 * without running it. Exported under a `__` prefix to flag test-only use.
 */
export function __hasCronHandler(name: string): boolean {
  return handlerRegistry.has(name)
}

/**
 * Test / smoke helper — returns the current set of registered handler
 * names, sorted. Used to assert that our boot sequence registered every
 * handler the DB `cron_tasks` seed expects.
 */
export function __listCronHandlerNames(): string[] {
  return Array.from(handlerRegistry.keys()).sort()
}

// ---------------------------------------------------------------------------
// Built-in handlers
// ---------------------------------------------------------------------------

/**
 * Cleanup expired sessions (daily).
 * Deletes sessions whose expires_at is in the past.
 */
registerHandler('cleanup_expired_sessions', async (db) => {
  await db
    .deleteFrom('sessions')
    .where('expires_at', '<', new Date().toISOString())
    .execute()
})

/**
 * Cleanup old webhook deliveries (weekly).
 * Removes deliveries older than 30 days.
 */
registerHandler('cleanup_old_webhook_deliveries', async (db) => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  await db
    .deleteFrom('webhook_deliveries')
    .where('created_at', '<', thirtyDaysAgo)
    .execute()
})

/**
 * Update inventory alerts (hourly).
 * Creates notifications for products with low stock (below 5 units).
 */
registerHandler('update_inventory_alerts', async (db) => {
  const lowStockVariants = await db
    .selectFrom('product_variants')
    .innerJoin('products', 'products.id', 'product_variants.product_id')
    .select([
      'product_variants.id as variant_id',
      'product_variants.title as variant_title',
      'product_variants.inventory_quantity',
      'products.shop_id',
      'products.title as product_title',
    ])
    .where('product_variants.inventory_quantity', '<', 5)
    .where('product_variants.inventory_quantity', '>=', 0)
    .execute()

  for (const variant of lowStockVariants) {
    await db
      .insertInto('notifications')
      .values({
        shop_id: variant.shop_id,
        type: 'low_stock',
        title: `Low stock: ${variant.product_title} - ${variant.variant_title}`,
        message: `Only ${variant.inventory_quantity} units remaining.`,
        resource_type: 'product_variant',
        resource_id: variant.variant_id,
      })
      .execute()
  }
})

/**
 * Generate daily analytics (daily at midnight).
 * Aggregates order data into events table for dashboard summaries.
 */
registerHandler('generate_daily_analytics', async (db) => {
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const startOfDay = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate()).toISOString()
  const endOfDay = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate() + 1).toISOString()

  // Get all shops that had orders yesterday
  const shopOrders = await db
    .selectFrom('orders')
    .select([
      'shop_id',
      db.fn.countAll<number>().as('order_count'),
    ])
    .where('created_at', '>=', startOfDay)
    .where('created_at', '<', endOfDay)
    .groupBy('shop_id')
    .execute()

  for (const row of shopOrders) {
    await db
      .insertInto('events')
      .values({
        shop_id: row.shop_id,
        subject_type: 'analytics',
        subject_id: startOfDay,
        verb: 'daily_summary',
        body: JSON.stringify({
          date: startOfDay,
          order_count: Number(row.order_count),
        }),
      })
      .execute()
  }
})

/**
 * Recompute customer lifecycle stage (daily).
 *
 * Walks every customer and flips `lifecycle_stage` for rows whose
 * recency bucket has shifted since yesterday — notably
 * {new,returning} → at_risk as the 60-day window expires without a
 * new order. Also backfills `last_order_at` from `orders` for
 * historical customers where the column is still NULL (one-shot on
 * first cron run after migration 056).
 *
 * Idempotent and safe to re-run; the classifier is deterministic on
 * the current row state + current date.
 */
registerHandler('recompute_customer_lifecycle', async (db) => {
  await recomputeAllLifecycleStages(db)
})

/**
 * Roll up yesterday's daily_metrics for every active shop (Phase 6 PR1).
 *
 * Scheduled nightly — the handler calls `rollupYesterdayAllShops(db)`
 * which iterates active shops and computes orders_count, revenue,
 * refunds, visitors, conversions for the previous UTC day. Writes are
 * idempotent via ON CONFLICT (shop_id, date) so re-running the same
 * day is safe and simply refreshes the row.
 *
 * Dashboard reads (Phase 6+) hit `daily_metrics` directly instead of
 * scanning `orders`, turning per-tab O(orders) queries into O(days).
 *
 * Without this, the daily rollup table stays empty forever after
 * migration 006 shipped the schema — the write-path `incrementToday`
 * is the hot path only; the background backfill never fires.
 */
registerHandler('rollup_daily_metrics', async (db) => {
  await rollupYesterdayAllShops(db)
})

/**
 * Prune daily_metrics rows older than the retention window (Phase 6 PR4).
 *
 * Keeps the table bounded — at ~5 rows per shop per day (one per shop
 * per day), ten thousand shops over ten years is 18M rows which PG
 * handles fine, but indexes bloat and dashboard range scans slow down
 * the further back history stretches. Retention 400d keeps YoY
 * comparisons intact while trimming the tail.
 *
 * Override `ANALYTICS_METRICS_RETAIN_DAYS` env to tune per-environment
 * (e.g. dev gets 30d so test fixtures don't pile up).
 */
registerHandler('prune_old_metrics', async (db) => {
  const env = process.env.ANALYTICS_METRICS_RETAIN_DAYS
  const retainDays = env ? Math.max(1, Number(env) || 400) : 400
  const res = await pruneOldMetrics(db, { retainDays })
  if (res.deleted > 0) {
    console.log(
      `[cron] prune_old_metrics: deleted ${res.deleted} rows older than ${res.cutoff}`,
    )
  }
})

/**
 * Dispatch scheduled marketing campaigns (Phase 8 PR1).
 *
 * Every 5 min: pick campaigns whose `scheduled_at <= now()` OR stuck in
 * `sending` state (reboot recovery). Snapshot recipients once, drain up
 * to 200 sends/tick, stamp each recipient, finalise when empty. SMTP
 * misconfiguration surfaces as a clean "Email delivery is not configured"
 * campaign-level error — no seller-facing god-admin leak.
 */
registerHandler('dispatch_campaigns', async (db) => {
  const res = await dispatchCampaignsTick(db)
  if (res.picked > 0) {
    console.log(
      `[cron] dispatch_campaigns: picked=${res.picked} sent=${res.sent} ` +
        `bounced=${res.bounced} failed=${res.failedCampaigns.length}`,
    )
  }
})

/**
 * Dispatch abandoned-cart recovery steps (Phase 8 PR2).
 *
 * Every 30 min: for each active shop, detect eligible open checkouts
 * older than the shop's threshold + enroll them idempotently; then
 * walk pending enrolments, compute the next due step via the flow
 * engine, and send via SMTP. SMTP misconfiguration short-circuits the
 * shop for this tick but doesn't stop other shops from sending.
 */
registerHandler('dispatch_abandoned_cart_steps', async (db) => {
  const res = await dispatchAbandonedCartTick(db)
  if (res.shopsScanned > 0 && (res.enrolled > 0 || res.sent > 0 || res.bounced > 0)) {
    console.log(
      `[cron] dispatch_abandoned_cart_steps: shops=${res.shopsScanned} ` +
        `enrolled=${res.enrolled} sent=${res.sent} bounced=${res.bounced} ` +
        `smtp_broken=${res.smtpUnconfiguredShops.length}`,
    )
  }
})

/**
 * Process scheduled gift-card emails (Phase 10 PR2 follow-up).
 *
 * Every 5 min: find gift cards whose `send_at <= now()` with
 * `email_sent_at IS NULL`, render via `email_templates` (shop override
 * or fallback), send, and mark. Individual SMTP failures do NOT flip
 * the marker so the next tick retries.
 *
 * Without this handler the PR2 `send_at` column was write-only — the
 * admin could schedule delivery but the email would never fire. See
 * `gift-cards/cron.ts` for the seed that creates the cron_tasks row.
 */
registerHandler('process_pending_gift_cards', async (db) => {
  const res = await processPendingGiftCardEmails(db)
  if (res.processed > 0) {
    console.log(
      `[cron] process_pending_gift_cards: processed=${res.processed} ` +
        `sent=${res.sent} failed=${res.failed}`,
    )
  }
})

/**
 * Support SLA breach sweep (Phase 12.5 PR5). Every 5 minutes, scans
 * `support_tickets` for first-response + resolution breaches (partial
 * index makes this cheap), then for each breach calls the pure
 * `decideEscalation()` → notify on-call agent (+ lead if >2× overdue),
 * optionally bumps priority, logs `sla_breached` + `priority_changed`
 * events, and fires notifications via the support-notifications sender.
 *
 * Idempotent via `sla_first_response_notified_at` / `sla_resolution_notified_at`
 * marker columns — next tick's SELECT filters fired rows out.
 */
registerHandler('support_sla_tick', async (db) => {
  const res = await tickSla(db)
  if (
    res.firstResponseBreaches > 0 ||
    res.resolutionBreaches > 0 ||
    res.errors.length > 0
  ) {
    console.log(
      `[cron] support_sla_tick: firstResponse=${res.firstResponseBreaches} ` +
        `resolution=${res.resolutionBreaches} ` +
        `notified=${res.notificationsDispatched} bumped=${res.prioritiesBumped} ` +
        `errors=${res.errors.length}`,
    )
  }
})

/**
 * Support CSAT auto-prompt (Phase 12.5 PR5). Every 15 minutes, picks
 * tickets closed >60 minutes ago with `csat_prompted_at IS NULL` and
 * sends the seller a "rate this ticket" notification. Stamps
 * `csat_prompted_at` + writes a `csat_prompted` audit event.
 */
registerHandler('support_csat_prompt', async (db) => {
  const res = await runCsatPrompts(db)
  if (res.prompted > 0 || res.failed > 0) {
    console.log(
      `[cron] support_csat_prompt: prompted=${res.prompted} failed=${res.failed}`,
    )
  }
})

/**
 * Support auto-close tick (Phase 12.5 PR5). Every 15 minutes alongside
 * CSAT. Warns sellers at 6 days pending + closes tickets at 7 days
 * pending (configurable via `platform_settings.support.auto_close_pending_seller_days`).
 */
registerHandler('support_auto_close', async (db) => {
  const res = await runAutoCloseTick(db)
  if (res.warned > 0 || res.closed > 0 || res.failed > 0) {
    console.log(
      `[cron] support_auto_close: warned=${res.warned} closed=${res.closed} ` +
        `failed=${res.failed}`,
    )
  }
})

/**
 * Support retention cleanup (Phase 12.5 PR5). Fires quarterly.
 * Soft-archives tickets closed >1 year ago (stamps `archived_at` +
 * `archive_location`) and records the run in `support_retention_runs`.
 * A future PR wires actual S3/Glacier upload; MVP is local_soft only.
 */
registerHandler('support_retention_cleanup', async (db) => {
  const res = await runRetentionCleanup(db)
  console.log(
    `[cron] support_retention_cleanup: mode=${res.mode} ` +
      `candidates=${res.candidatesFound} archived=${res.ticketsArchived} ` +
      `durationMs=${res.durationMs}` +
      (res.error ? ` error=${res.error}` : ''),
  )
})

/**
 * Phase 14 PR7 (BUG-E4) — Soft-bounce rollup.
 *
 * Promotes recipients with 5+ soft/transient bounces in the last 30d to
 * a hard suppression (source='soft_bounce_rollup'). Without this,
 * addresses that "temporarily" fail keep getting retried indefinitely
 * and silently damage sender reputation.
 *
 * Runs once daily — the policy window is 30d so tick cadence has no
 * effect on membership, only on freshness. Per-run cap is 500
 * candidates (see bounce-aggregator.DEFAULT_MAX_CANDIDATES) which keeps
 * each tick < 2s on realistic volume.
 *
 * Seed the cron_tasks row with schedule `0 3 * * *` (3am UTC) to match
 * the other nightly rollups (analytics, metrics prune, retention).
 */
registerHandler('aggregate_soft_bounces', async (db) => {
  const res = await runSoftBounceAggregator(db)
  if (res.promoted > 0 || res.alreadySuppressed > 0 || res.errors > 0) {
    console.log(
      `[cron] aggregate_soft_bounces: scanned=${res.scanned} ` +
        `promoted=${res.promoted} alreadySuppressed=${res.alreadySuppressed} ` +
        `errors=${res.errors} window=${res.windowStart}..${res.windowEnd}`,
    )
  }
})

/**
 * Phase 14 PR8 (bug 9) — Zombie-queued delivery janitor.
 *
 * `beginDelivery` inserts `status='queued'` before the SMTP call. If the
 * process dies between that INSERT and the resulting `markSent` /
 * `markFailed`, the row stays at 'queued' forever. Pre-PR8 that:
 *   1. polluted the admin UI's "queued" counter indefinitely, and
 *   2. made the bug-8 idempotency fast-path misreport subsequent retries.
 *
 * Every 5 minutes we sweep rows older than the grace period
 * (`DEFAULT_ZOMBIE_GRACE_MINUTES`, 10 min) and flip them to
 * status='failed' with `ZOMBIE_FAILED_REASON` so the admin UI can render
 * a distinctive icon.
 *
 * Only touches rows with status='queued' — there is no way this handler
 * can corrupt a 'sent' or legitimately-failed row. The UPDATE uses
 * `FOR UPDATE SKIP LOCKED` so concurrent sweeps on different pods
 * (future scale-out) stay race-free without grabbing a blocking lock.
 */
registerHandler(EMAIL_CRON_HANDLERS.SWEEP_ZOMBIE_DELIVERIES, async (db) => {
  const res = await sweepZombieDeliveries(db)
  if (res.swept > 0) {
    console.log(
      `[cron] sweep_zombie_email_deliveries: swept=${res.swept} ` +
        `cutoff=${res.cutoffIso}`,
    )
  }
})

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Schedule a new cron task.
 */
export async function scheduleCronTask(
  db: Kysely<Database>,
  name: string,
  schedule: string,
  handler: string,
) {
  // Calculate next_run_at based on schedule (simplified: set to now for immediate first run)
  const now = new Date().toISOString()

  const task = await db
    .insertInto('cron_tasks')
    .values({
      name,
      schedule,
      handler,
      next_run_at: now,
      status: 'active',
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return task
}

/**
 * Get a cron task by ID.
 */
export async function getCronTask(
  db: Kysely<Database>,
  taskId: string,
) {
  const task = await db
    .selectFrom('cron_tasks')
    .selectAll()
    .where('id', '=', taskId)
    .executeTakeFirst()

  return task ?? null
}

/**
 * List all cron tasks.
 */
export async function listCronTasks(
  db: Kysely<Database>,
) {
  return db
    .selectFrom('cron_tasks')
    .selectAll()
    .orderBy('name', 'asc')
    .execute()
}

/**
 * Update a cron task's status and optionally its last_run_at timestamp.
 */
export async function updateCronStatus(
  db: Kysely<Database>,
  taskId: string,
  status: CronStatus,
  lastRunAt?: string,
) {
  const updateData: Record<string, any> = { status }
  if (lastRunAt) {
    updateData.last_run_at = lastRunAt
  }

  await db
    .updateTable('cron_tasks')
    .set(updateData as any)
    .where('id', '=', taskId)
    .execute()
}

/**
 * Delete a cron task.
 */
export async function deleteCronTask(
  db: Kysely<Database>,
  taskId: string,
): Promise<void> {
  await db
    .deleteFrom('cron_tasks')
    .where('id', '=', taskId)
    .execute()
}

/**
 * Get all overdue tasks where next_run_at < now().
 */
export async function getOverdueTasks(
  db: Kysely<Database>,
) {
  return db
    .selectFrom('cron_tasks')
    .selectAll()
    .where('status', '=', 'active')
    .where('next_run_at', '<', new Date().toISOString())
    .execute()
}

/**
 * Calculate the next run time from a cron schedule string.
 * Supports simple patterns: "daily", "hourly", "weekly", or cron-like intervals.
 */
function calculateNextRun(schedule: string, fromDate: Date = new Date()): string {
  const next = new Date(fromDate)

  switch (schedule.toLowerCase()) {
    case 'every_5_minutes':
      next.setMinutes(next.getMinutes() + 5, 0, 0)
      break
    case 'every_15_minutes':
      next.setMinutes(next.getMinutes() + 15, 0, 0)
      break
    case 'every_30_minutes':
      next.setMinutes(next.getMinutes() + 30, 0, 0)
      break
    case 'hourly':
      next.setHours(next.getHours() + 1, 0, 0, 0)
      break
    case 'daily':
      next.setDate(next.getDate() + 1)
      next.setHours(0, 0, 0, 0)
      break
    case 'weekly':
      next.setDate(next.getDate() + 7)
      next.setHours(0, 0, 0, 0)
      break
    case 'daily_midnight':
      next.setDate(next.getDate() + 1)
      next.setHours(0, 0, 0, 0)
      break
    case 'quarterly':
      // ~90 days from now, midnight UTC.
      next.setDate(next.getDate() + 90)
      next.setHours(0, 0, 0, 0)
      break
    default:
      // Default: 1 hour from now
      next.setHours(next.getHours() + 1)
      break
  }

  return next.toISOString()
}

/**
 * Execute all due jobs. Finds overdue tasks, runs their handlers,
 * and updates status/timestamps.
 */
export async function executeDueJobs(
  db: Kysely<Database>,
): Promise<JobResult[]> {
  const overdueTasks = await getOverdueTasks(db)
  const results: JobResult[] = []

  for (const task of overdueTasks) {
    const startTime = Date.now()

    // Mark as running
    await updateCronStatus(db, task.id, 'running')

    const handler = handlerRegistry.get(task.handler)

    if (!handler) {
      // No handler registered for this task
      await updateCronStatus(db, task.id, 'active', new Date().toISOString())

      // Update next_run_at
      await db
        .updateTable('cron_tasks')
        .set({
          next_run_at: calculateNextRun(task.schedule),
        } as any)
        .where('id', '=', task.id)
        .execute()

      results.push({
        taskId: task.id,
        name: task.name,
        status: 'error',
        durationMs: Date.now() - startTime,
        error: `No handler registered for "${task.handler}"`,
      })
      continue
    }

    try {
      await handler(db)

      const now = new Date()
      await db
        .updateTable('cron_tasks')
        .set({
          status: 'active',
          last_run_at: now.toISOString(),
          next_run_at: calculateNextRun(task.schedule, now),
        } as any)
        .where('id', '=', task.id)
        .execute()

      results.push({
        taskId: task.id,
        name: task.name,
        status: 'success',
        durationMs: Date.now() - startTime,
      })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)

      // Reset to active so it can be retried
      await db
        .updateTable('cron_tasks')
        .set({
          status: 'active',
          last_run_at: new Date().toISOString(),
          next_run_at: calculateNextRun(task.schedule),
        } as any)
        .where('id', '=', task.id)
        .execute()

      results.push({
        taskId: task.id,
        name: task.name,
        status: 'error',
        durationMs: Date.now() - startTime,
        error: errorMessage,
      })
    }
  }

  return results
}
