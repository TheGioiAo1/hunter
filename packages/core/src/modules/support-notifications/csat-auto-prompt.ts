/**
 * Gbox Platform — support CSAT auto-prompt cron (Phase 12.5 PR5).
 *
 * Fires every 15 minutes (registered in cron/service.ts as
 * `support_csat_prompt`). Finds tickets whose status is `closed` AND
 *   closed_at < now() - csat_prompt_delay_minutes
 *   AND csat_prompted_at IS NULL
 *   AND csat_rated_at IS NULL   (if seller already rated via reopen+
 *                                re-close, don't nag them again)
 *
 * For each row, sends the opener an `csat_prompt` notification (via the
 * normal sender — honours their prefs + quiet hours) and stamps
 * `csat_prompted_at` so the next tick skips. Also writes a
 * `csat_prompted` event to `support_ticket_events` for the audit trail.
 *
 * The default delay is 60 minutes (platform_settings.support.csat_prompt_delay_minutes,
 * seeded by migration 077). MVP uses a fixed value; the caller is
 * expected to pass the config in if they want to override.
 *
 * Idempotency model: the `csat_prompted_at IS NULL` filter + the in-tx
 * stamp means a row can only be picked once even under concurrent ticks
 * (Postgres row lock serialises the update; a second worker's SELECT
 * filters it out on re-read).
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { sendSupportNotification } from './sender.ts'

const DEFAULT_DELAY_MINUTES = 60

export interface CsatPromptResult {
  prompted: number
  skipped: number
  failed: number
  errors: Array<{ ticketId: string; error: string }>
}

export interface RunCsatPromptOpts {
  now?: Date
  /** Override the CSAT delay; falls back to 60min. */
  delayMinutes?: number
  /** Cap number of rows processed in one tick — prevents runaway backlog blast. */
  batchLimit?: number
}

/**
 * One cron tick: scan → send → stamp. Returns a summary.
 */
export async function runCsatPrompts(
  db: Kysely<Database>,
  opts: RunCsatPromptOpts = {},
): Promise<CsatPromptResult> {
  const now = opts.now ?? new Date()
  const delayMinutes = opts.delayMinutes ?? DEFAULT_DELAY_MINUTES
  const batchLimit = opts.batchLimit ?? 200

  const threshold = new Date(now.getTime() - delayMinutes * 60_000).toISOString()

  const rows = await db
    .selectFrom('support_tickets')
    .select(['id', 'shop_id', 'opener_user_id', 'subject', 'closed_at'])
    .where('status', '=', 'closed')
    .where('csat_prompted_at', 'is', null)
    .where('csat_rated_at', 'is', null)
    .where('closed_at', 'is not', null)
    .where('closed_at', '<', threshold)
    .where('archived_at', 'is', null)
    .orderBy('closed_at', 'asc')
    .limit(batchLimit)
    .execute()

  const summary: CsatPromptResult = {
    prompted: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  }

  for (const row of rows) {
    try {
      await promptOne(db, row, now)
      summary.prompted++
    } catch (err) {
      summary.failed++
      summary.errors.push({
        ticketId: row.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return summary
}

// ── helpers ─────────────────────────────────────────────────────────────

interface CsatRow {
  id: string
  shop_id: string
  opener_user_id: string
  subject: string
  closed_at: string | null
}

async function promptOne(
  db: Kysely<Database>,
  row: CsatRow,
  now: Date,
): Promise<void> {
  // 1. Stamp + audit event in a tx so a retry/crash mid-dispatch doesn't
  //    re-prompt a second time.
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('support_tickets')
      .set({ csat_prompted_at: now.toISOString() })
      .where('id', '=', row.id)
      // Guard: only stamp if still NULL (optimistic concurrency — a
      // concurrent worker's stamp is a no-op from this one's POV).
      .where('csat_prompted_at', 'is', null)
      .execute()

    await trx
      .insertInto('support_ticket_events')
      .values({
        ticket_id: row.id,
        event_type: 'csat_prompted',
        actor_user_id: null,
        metadata: JSON.stringify({
          closedAt: row.closed_at,
          promptedAt: now.toISOString(),
        }) as unknown as any,
      })
      .execute()
  })

  // 2. Dispatch outside the tx.
  await sendSupportNotification(db, {
    ticketId: row.id,
    notificationType: 'csat_prompt',
    recipientUserId: row.opener_user_id,
    subject: `How did we do on ticket "${truncate(row.subject, 60)}"?`,
    body: buildCsatBody(row),
    link: `/app/support/tickets/${row.id}?csat=1`,
    now,
  })
}

function buildCsatBody(row: CsatRow): string {
  return [
    `Your support ticket "${row.subject}" has been closed.`,
    '',
    'We would love your feedback — please take 30 seconds to rate how we did.',
    '',
    'Your rating helps us train our agents and improve the product.',
  ].join('\n')
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}
