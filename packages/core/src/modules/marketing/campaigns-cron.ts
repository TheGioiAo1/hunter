/**
 * Gbox Platform — Campaigns Cron Handler (Phase 8 PR1)
 *
 * Every 5 min the driver ticks `dispatch_campaigns`:
 *
 *   1. Find campaigns WHERE status='scheduled' AND scheduled_at <= now().
 *   2. For each: snapshotRecipients (idempotent), markCampaignSending.
 *   3. Pull pending recipients one at a time, call sendEmail, stamp
 *      sent_at or bounced_at.
 *   4. When no more pending rows → markCampaignSent (or markCampaignFailed
 *      if every recipient bounced).
 *
 * Also drains any campaign stuck in `sending` from a previous tick (e.g.
 * the process was restarted mid-send). That way a reboot never leaves
 * half-sent campaigns in limbo.
 *
 * Rate: sends up to MAX_SENDS_PER_TICK emails per tick, to keep one bad
 * shop from hogging the worker. Remaining recipients are picked up on
 * the next tick.
 *
 * SMTP disabled? `sendEmail` throws on missing SMTP_HOST. We catch the
 * first throw and fail the campaign with a clean error string — cleaner
 * than spinning forever. Seller sees: "Please contact Gbox support".
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { sendEmail } from '../email/service.js'
import {
  getCampaign,
  snapshotRecipients,
  markCampaignSending,
  markCampaignSent,
  markCampaignFailed,
  getNextPendingRecipient,
  recordRecipientSent,
  markRecipientBounced,
} from './campaigns.js'

const MAX_SENDS_PER_TICK = 200

export const CAMPAIGNS_CRON_HANDLERS = {
  DISPATCH_CAMPAIGNS: 'dispatch_campaigns',
} as const

export async function dispatchCampaignsTick(
  db: Kysely<Database>,
  now: Date = new Date(),
): Promise<{
  picked: number
  sent: number
  bounced: number
  failedCampaigns: string[]
}> {
  // 1. Find due-scheduled + in-flight campaigns.
  const scheduled = await (db as any)
    .selectFrom('campaigns')
    .select(['id', 'shop_id', 'status'])
    .where((eb: any) =>
      eb.or([
        eb.and([
          eb('status', '=', 'scheduled'),
          eb('scheduled_at', '<=', now.toISOString()),
        ]),
        eb('status', '=', 'sending'),
      ]),
    )
    .orderBy('scheduled_at', 'asc')
    .limit(50)
    .execute()

  let sent = 0
  let bounced = 0
  const failedCampaigns: string[] = []

  for (const campaign of scheduled) {
    if (sent + bounced >= MAX_SENDS_PER_TICK) break

    // Snapshot recipients if still scheduled; no-op (idempotent) if sending.
    if (campaign.status === 'scheduled') {
      try {
        await snapshotRecipients(db, campaign.shop_id, campaign.id)
      } catch (err: any) {
        await markCampaignFailed(
          db,
          campaign.id,
          `snapshot failed: ${err?.message ?? String(err)}`,
        )
        failedCampaigns.push(campaign.id)
        continue
      }
      const transitioned = await markCampaignSending(db, campaign.id)
      if (!transitioned) continue
    }

    // Drain recipients up to the tick budget.
    while (sent + bounced < MAX_SENDS_PER_TICK) {
      const next = await getNextPendingRecipient(db, campaign.id)
      if (!next) break

      const row = await getCampaign(db, campaign.shop_id, campaign.id)
      if (!row) break

      try {
        await sendEmail({
          to: next.email,
          subject: row.subject,
          html: row.body_html,
        })
        await recordRecipientSent(db, next.id)
        sent++
      } catch (err: any) {
        const msg = err?.message ?? String(err)
        await markRecipientBounced(db, next.id, msg)
        bounced++
        // If SMTP isn't configured at all, bail out of the campaign
        // cleanly rather than marking every recipient bounced on an
        // identical error.
        if (/SMTP_HOST is not configured/i.test(msg)) {
          await markCampaignFailed(
            db,
            campaign.id,
            'Email delivery is not configured.',
          )
          failedCampaigns.push(campaign.id)
          break
        }
      }
    }

    // Finalise: if nothing pending remains, mark sent.
    const still = await getNextPendingRecipient(db, campaign.id)
    if (!still && !failedCampaigns.includes(campaign.id)) {
      await markCampaignSent(db, campaign.id)
    }
  }

  return {
    picked: scheduled.length,
    sent,
    bounced,
    failedCampaigns,
  }
}

/**
 * Idempotent seed for the `cron_tasks` row. Called at boot alongside
 * `seedAnalyticsCronTasks`.
 */
export async function seedCampaignsCronTasks(
  db: Kysely<Database>,
): Promise<{ inserted: number; existing: number }> {
  const seeds: ReadonlyArray<{ name: string; schedule: string; handler: string }> = [
    {
      name: 'Dispatch scheduled campaigns',
      schedule: '*/5 * * * *',
      handler: CAMPAIGNS_CRON_HANDLERS.DISPATCH_CAMPAIGNS,
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
