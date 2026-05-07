/**
 * Gbox Platform — Gift Card Delivery Cron (Phase 10 PR2 follow-up)
 *
 * Phase 10 PR2 landed `processPendingGiftCardEmails` (the batch dispatcher)
 * but never wired a cron_tasks row for it, so scheduled gift-card delivery
 * silently never fired on prod. This module closes the loop:
 *
 *   - `GIFT_CARD_CRON_HANDLERS.PROCESS_PENDING` names the handler
 *     (`process_pending_gift_cards`).
 *   - Handler registration lives next to the other marketing handlers
 *     in `cron/service.ts` (import-time side effect); it calls
 *     `processPendingGiftCardEmails(db)`.
 *   - `seedGiftCardCronTasks(db)` is the idempotent boot-time seed that
 *     `server.ts` invokes alongside campaigns + abandoned-cart.
 *
 * Schedule: every 5 minutes. Gift cards with `send_at` in the past and
 * `email_sent_at IS NULL` get one delivery attempt; failures do not flip
 * the sent marker so the next tick retries. Tick budget bounded by
 * `listPendingEmailDeliveries`' own `limit` (default 100).
 *
 * Rationale for 5 min cadence (vs 30 min for abandoned-cart):
 *   - Gift-card emails are explicitly scheduled by the sender (birthday
 *     9am, anniversary noon). A 30-min slippage is visible. 5 min keeps
 *     the perceived delay tight without thrashing SMTP.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

export const GIFT_CARD_CRON_HANDLERS = {
  PROCESS_PENDING: 'process_pending_gift_cards',
} as const

/**
 * Idempotent seed for the cron_tasks row. Returns the count of inserted
 * vs already-existing rows so the server boot log can show whether the
 * seed actually did anything.
 */
export async function seedGiftCardCronTasks(
  db: Kysely<Database>,
): Promise<{ inserted: number; existing: number }> {
  const seeds: ReadonlyArray<{ name: string; schedule: string; handler: string }> = [
    {
      name: 'Process scheduled gift-card emails',
      schedule: '*/5 * * * *',
      handler: GIFT_CARD_CRON_HANDLERS.PROCESS_PENDING,
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
