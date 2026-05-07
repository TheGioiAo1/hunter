/**
 * Analytics cron task seeding (Phase 6 PR1).
 *
 * The handler `rollup_daily_metrics` is registered at module-load time
 * in `modules/cron/service.ts` — there's no side-effect-only register
 * function to call. This file owns the *data-side* of the wiring: it
 * seeds a row in `cron_tasks` so the driver's `executeDueJobs()` tick
 * picks the handler up.
 *
 * Shape matches the Lenful cron seeder (`fulfillment/lenful/cron-register.ts`):
 * idempotent on `handler`, returns inserted/existing counters.
 *
 * Call `seedAnalyticsCronTasks(db)` once at process start, after the
 * cron handler registry is loaded. The driver polls every ~60s and
 * runs any overdue task whose handler name matches a registered entry.
 *
 * Schedule is `daily` so the driver's `calculateNextRun()` sets
 * `next_run_at` to 00:00 local-TZ the day after `last_run_at`. For
 * single-region deployments that is close enough to the 00:05 UTC
 * target documented in `daily-metrics.ts` (±8h worst case for servers
 * pinned to Asia/Ho_Chi_Minh) — if stricter timing is needed later,
 * swap to a dedicated UTC-midnight scheduler.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

export const ANALYTICS_CRON_HANDLERS = {
  ROLLUP_DAILY_METRICS: 'rollup_daily_metrics',
  PRUNE_OLD_METRICS: 'prune_old_metrics',
} as const

export async function seedAnalyticsCronTasks(
  db: Kysely<Database>,
): Promise<{ inserted: number; existing: number }> {
  const seeds: ReadonlyArray<{ name: string; schedule: string; handler: string }> = [
    {
      name: 'Daily metrics rollup',
      schedule: 'daily',
      handler: ANALYTICS_CRON_HANDLERS.ROLLUP_DAILY_METRICS,
    },
    {
      name: 'Prune old daily metrics',
      schedule: 'weekly',
      handler: ANALYTICS_CRON_HANDLERS.PRUNE_OLD_METRICS,
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
