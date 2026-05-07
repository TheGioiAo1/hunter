/**
 * Gbox Platform — support-notifications cron seed (Phase 12.5 PR5).
 *
 * Idempotent boot-time registration of the 4 support cron jobs:
 *
 *   - `support_sla_tick`          — every 5 min:  scan SLA breaches, notify.
 *   - `support_csat_prompt`       — every 15 min: nudge closed tickets for CSAT.
 *   - `support_auto_close`        — every 15 min: warn @ 6d, close @ 7d pending.
 *   - `support_retention_cleanup` — quarterly:    archive tickets >1yr.
 *
 * Schedule strings are the lowercased labels used by
 * `cron/service.ts::calculateNextRun` so the next_run_at math matches
 * the handler's intended cadence. Standard cron expressions (like
 * the 5-minute asterisk/slash form) pass through the default branch
 * and run hourly — avoid those until PR6 upgrades calculateNextRun
 * to a proper parser.
 *
 * Call this from the server boot path once, alongside the other seed
 * functions (seedGiftCardCronTasks, campaigns seed, etc.). Safe to run
 * on every boot — exists check guards against dup rows.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

export const SUPPORT_CRON_HANDLERS = {
  SLA_TICK: 'support_sla_tick',
  CSAT_PROMPT: 'support_csat_prompt',
  AUTO_CLOSE: 'support_auto_close',
  RETENTION_CLEANUP: 'support_retention_cleanup',
} as const

export async function seedSupportCronTasks(
  db: Kysely<Database>,
): Promise<{ inserted: number; existing: number }> {
  const seeds: ReadonlyArray<{
    name: string
    schedule: string
    handler: string
  }> = [
    {
      name: 'Support — SLA breach sweep',
      schedule: 'every_5_minutes',
      handler: SUPPORT_CRON_HANDLERS.SLA_TICK,
    },
    {
      name: 'Support — CSAT auto-prompt',
      schedule: 'every_15_minutes',
      handler: SUPPORT_CRON_HANDLERS.CSAT_PROMPT,
    },
    {
      name: 'Support — pending-seller auto-close',
      schedule: 'every_15_minutes',
      handler: SUPPORT_CRON_HANDLERS.AUTO_CLOSE,
    },
    {
      name: 'Support — retention cleanup',
      schedule: 'quarterly',
      handler: SUPPORT_CRON_HANDLERS.RETENTION_CLEANUP,
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
