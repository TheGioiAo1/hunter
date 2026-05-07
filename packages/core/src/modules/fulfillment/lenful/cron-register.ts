/**
 * Lenful cron handler registration (Phase F7).
 *
 * Three recurring jobs wire the Lenful fulfillment pipeline into the
 * platform's existing `cron_tasks` driver (see `modules/cron/service.ts`).
 * The driver polls `cron_tasks WHERE next_run_at < now()` once a minute
 * and invokes the handler registered by name:
 *
 *   lenful_auto_push_sweep  — hourly — scan paid+unpushed orders, evaluate
 *                                      routing rules, push matches to Lenful
 *                                      (safety net for the inline hook that
 *                                      fires on mark_paid)
 *
 *   lenful_sync_tracking    — hourly — fetch /api/order/tracking_item pages,
 *                                      update lenful_order_items + roll up
 *                                      orders.fulfillment_status
 *
 *   lenful_capture_wallet   — daily  — snapshot Lenful wallet balance and
 *                                      raise the alert banner when below the
 *                                      configured threshold
 *
 * Call `registerLenfulCronHandlers()` exactly once at process start — it is
 * side-effect-only (no DB). Then call `seedLenfulCronTasks(db)` so the
 * cron_tasks rows exist and executeDueJobs() can pick them up.
 *
 * Disable in a given replica with `DISABLE_LENFUL_CRON=1` so only one API
 * process runs the jobs in a multi-replica deployment.
 */

import type { Kysely } from 'kysely'
import type { Database } from '../../../../../db/src/schema/tables.js'
import { registerHandler } from '../../cron/service.ts'
import { runAutoPushSweep } from './routing-rules.ts'
import { syncTrackingGlobal } from './tracking-sync.ts'
import { captureWalletSnapshot } from './wallet-sync.ts'

export const LENFUL_CRON_HANDLERS = {
  AUTO_PUSH_SWEEP: 'lenful_auto_push_sweep',
  SYNC_TRACKING: 'lenful_sync_tracking',
  CAPTURE_WALLET: 'lenful_capture_wallet',
} as const

let registered = false

/**
 * Register the three Lenful handlers with the global cron handler registry.
 * Safe to call multiple times — second+ calls are no-ops.
 */
export function registerLenfulCronHandlers(): void {
  if (registered) return
  registered = true

  registerHandler(LENFUL_CRON_HANDLERS.AUTO_PUSH_SWEEP, async (db) => {
    const result = await runAutoPushSweep(db, {
      triggeredBy: 'cron',
      userId: null,
      limit: 100,
    })
    if (result.errors.length > 0) {
      // Surface in the process log; individual errors are already captured in
      // lenful_orders.status + last_error for the queue UI.
      console.warn(
        `[lenful-cron] auto_push_sweep: ${result.failed} failed`,
        result.errors.slice(0, 5),
      )
    }
  })

  registerHandler(LENFUL_CRON_HANDLERS.SYNC_TRACKING, async (db) => {
    const result = await syncTrackingGlobal(db, {
      triggeredBy: 'cron',
      userId: null,
      maxPages: 5,
    })
    if (result.errors.length > 0) {
      console.warn(
        `[lenful-cron] sync_tracking: ${result.errors.length} errors`,
        result.errors.slice(0, 5),
      )
    }
  })

  registerHandler(LENFUL_CRON_HANDLERS.CAPTURE_WALLET, async (db) => {
    const result = await captureWalletSnapshot(db, {
      triggeredBy: 'cron',
      userId: null,
    })
    if (!result.ok) {
      console.warn(`[lenful-cron] capture_wallet failed: ${result.error}`)
    } else if (result.alert) {
      console.warn(
        `[lenful-cron] capture_wallet: balance ${result.snapshot?.balance} ${result.snapshot?.currency} BELOW threshold ${result.threshold}`,
      )
    }
  })
}

/**
 * Seed cron_tasks rows for Lenful jobs if they don't already exist.
 * Idempotent — uses WHERE NOT EXISTS so restart won't duplicate rows.
 *
 * After seeding, executeDueJobs() will pick them up on the next tick.
 */
export async function seedLenfulCronTasks(
  db: Kysely<Database>,
): Promise<{ inserted: number; existing: number }> {
  const seeds: ReadonlyArray<{ name: string; schedule: string; handler: string }> = [
    {
      name: 'Lenful auto-push sweep',
      schedule: 'hourly',
      handler: LENFUL_CRON_HANDLERS.AUTO_PUSH_SWEEP,
    },
    {
      name: 'Lenful tracking sync',
      schedule: 'hourly',
      handler: LENFUL_CRON_HANDLERS.SYNC_TRACKING,
    },
    {
      name: 'Lenful wallet snapshot',
      schedule: 'daily',
      handler: LENFUL_CRON_HANDLERS.CAPTURE_WALLET,
    },
  ]

  let inserted = 0
  let existing = 0

  for (const seed of seeds) {
    const row = await db
      .selectFrom('cron_tasks')
      .select(['id'])
      .where('handler', '=', seed.handler)
      .executeTakeFirst()
    if (row) {
      existing++
      continue
    }
    await db
      .insertInto('cron_tasks')
      .values({
        name: seed.name,
        schedule: seed.schedule,
        handler: seed.handler,
        next_run_at: new Date().toISOString(),
        status: 'active',
      } as any)
      .execute()
    inserted++
  }

  return { inserted, existing }
}
