/**
 * Gbox Platform — Email cron seed (Phase 14 PR8, bug 9).
 *
 * Idempotent boot-time registrar for email-system cron_tasks rows.
 *
 * Currently a single entry: the zombie-queued janitor. Scheduled every 5
 * minutes. A dedicated module (rather than jamming more seeds into
 * `gift-cards/cron.ts`) keeps email-domain cron concerns in one place —
 * future PRs can add the weekly salt-rotation sweep, monthly consent-
 * ledger archive, etc. here.
 *
 * The actual handler (what runs when the cron fires) is registered in
 * `cron/service.ts` at import time. This file just makes sure the
 * cron_tasks DB row exists; without that row `executeDueJobs()` never
 * calls the handler and zombies pile up forever.
 *
 * PR7 precedent: `aggregate_soft_bounces` had the same "handler exists,
 * cron_tasks row missing" bug for a full phase. We're not repeating it.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { ZOMBIE_FAILED_REASON } from './zombie-janitor.js'

/**
 * Handler names the cron service registers at import time. Exported so
 * the boot seed below + the smoke script can reference one source of
 * truth.
 */
export const EMAIL_CRON_HANDLERS = {
  SWEEP_ZOMBIE_DELIVERIES: 'sweep_zombie_email_deliveries',
} as const

/** Matches existing cron seeds — 5-min cadence (`*\/5 * * * *`). */
const ZOMBIE_SWEEP_SCHEDULE = '*/5 * * * *'

/**
 * Idempotent upsert for the zombie janitor cron_tasks row. Safe to call
 * on every boot; existing rows are left alone (we don't overwrite a
 * paused schedule because ops might have disabled the job intentionally
 * during an incident).
 *
 * Named `seedEmailZombieJanitorCron` (not `seedEmailCronTasks`) to avoid
 * a symbol clash with the existing `seedEmailCronTasks` in
 * `bounce-aggregator.ts` (Phase 14 PR7 soft-bounce seed). Both are
 * re-exported from the email barrel; a future PR can consolidate them
 * into a single seed function if we keep adding email-domain crons.
 *
 * Returns counts so `server.ts`'s boot log can report them.
 */
export async function seedEmailZombieJanitorCron(
  db: Kysely<Database>,
): Promise<{ inserted: number; existing: number }> {
  // Touch the exported ZOMBIE_FAILED_REASON so the import can't be
  // dropped by tree-shaking — the admin UI substring-matches on it and
  // we want the compile to fail fast if someone accidentally removes
  // the constant in a future refactor.
  void ZOMBIE_FAILED_REASON

  const seeds: ReadonlyArray<{ name: string; schedule: string; handler: string }> = [
    {
      name: 'Sweep zombie-queued email deliveries',
      schedule: ZOMBIE_SWEEP_SCHEDULE,
      handler: EMAIL_CRON_HANDLERS.SWEEP_ZOMBIE_DELIVERIES,
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
      })
      .execute()
    inserted++
  }

  return { inserted, existing }
}
