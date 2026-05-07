/**
 * Gbox Platform — support auto-close cron (Phase 12.5 PR5).
 *
 * Fires every 15 minutes alongside CSAT (same cron cadence — both deal
 * with "stale-ticket" flows). Implements the 7-day auto-close rule:
 *
 *   - Day 0:   seller leaves, agent replies, status → `pending_seller`;
 *              the `setStatus()` wrapper stamps `pending_seller_since`.
 *   - Day 6:   THIS cron sees `pending_seller_since < now - 6d` +
 *              `auto_close_warned_at IS NULL` → fires an
 *              `auto_close_warning` notification to the seller (channels
 *              honoured via prefs) and stamps `auto_close_warned_at`.
 *   - Day 7:   THIS cron sees `pending_seller_since < now - 7d` +
 *              `auto_close_warned_at IS NOT NULL` → transitions the
 *              ticket to `closed`, stamps `closed_at`, writes
 *              `status_changed` + `auto_closed` audit events, and fires
 *              an `auto_close` notification to the seller.
 *
 * The seller can reopen the ticket within the reopen window (7 days;
 * Q4.23) if they come back — that path lives in support/service.ts and
 * clears pending_seller_since + auto_close_warned_at on transition.
 *
 * Defaults come from `platform_settings.support.auto_close_pending_seller_days`
 * (seeded as 7 by migration 077) but the cron reads a caller-supplied
 * value to stay config-pluggable (the admin /god-admin page can dry-run
 * with a different window).
 *
 * IRON RULE 5: every seller-facing subject/body here routes through
 * `safeMessage()` and NEVER leaks /god-admin or support staff paths.
 * We say "Please contact Gbox support" etc. if we need to reference a
 * fallback.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { sendSupportNotification } from './sender.ts'

const DEFAULT_AUTO_CLOSE_DAYS = 7

export interface AutoCloseResult {
  warned: number
  closed: number
  skipped: number
  failed: number
  errors: Array<{ ticketId: string; error: string }>
}

export interface RunAutoCloseOpts {
  now?: Date
  /** Override the 7-day default (e.g. platform_settings). */
  autoCloseDays?: number
  /** Warning fires at (autoCloseDays - warningLeadDays). Default 1. */
  warningLeadDays?: number
  /** Cap per tick. */
  batchLimit?: number
}

export async function runAutoCloseTick(
  db: Kysely<Database>,
  opts: RunAutoCloseOpts = {},
): Promise<AutoCloseResult> {
  const now = opts.now ?? new Date()
  const autoCloseDays = opts.autoCloseDays ?? DEFAULT_AUTO_CLOSE_DAYS
  const warningLeadDays = opts.warningLeadDays ?? 1
  const batchLimit = opts.batchLimit ?? 200

  const warnThreshold = new Date(
    now.getTime() - (autoCloseDays - warningLeadDays) * 24 * 60 * 60 * 1000,
  ).toISOString()
  const closeThreshold = new Date(
    now.getTime() - autoCloseDays * 24 * 60 * 60 * 1000,
  ).toISOString()
  // A ticket only closes when the warning itself has had at least
  // `warningLeadDays` to land. This prevents the "warn + close in the
  // same tick" anti-pattern: if a ticket hits 7+ days old with
  // auto_close_warned_at STILL null, phase 1 stamps the warning and
  // phase 2 MUST NOT immediately close — the seller gets their 1-day
  // grace period starting from when they were actually warned.
  const warningStaleThreshold = new Date(
    now.getTime() - warningLeadDays * 24 * 60 * 60 * 1000,
  ).toISOString()

  const summary: AutoCloseResult = {
    warned: 0,
    closed: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  }

  // ── 1. Send warnings ────────────────────────────────────────────────
  const warnRows = await db
    .selectFrom('support_tickets')
    .select(['id', 'shop_id', 'opener_user_id', 'subject', 'pending_seller_since'])
    .where('status', '=', 'pending_seller')
    .where('pending_seller_since', 'is not', null)
    .where('pending_seller_since', '<', warnThreshold)
    .where('auto_close_warned_at', 'is', null)
    .where('archived_at', 'is', null)
    .orderBy('pending_seller_since', 'asc')
    .limit(batchLimit)
    .execute()

  for (const row of warnRows) {
    try {
      await sendWarning(db, row, now, autoCloseDays, warningLeadDays)
      summary.warned++
    } catch (err) {
      summary.failed++
      summary.errors.push({
        ticketId: row.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ── 2. Close warned tickets that still haven't replied ─────────────
  const closeRows = await db
    .selectFrom('support_tickets')
    .select(['id', 'shop_id', 'opener_user_id', 'subject'])
    .where('status', '=', 'pending_seller')
    .where('pending_seller_since', 'is not', null)
    .where('pending_seller_since', '<', closeThreshold)
    .where('auto_close_warned_at', 'is not', null)
    .where('auto_close_warned_at', '<', warningStaleThreshold)
    .where('archived_at', 'is', null)
    .orderBy('pending_seller_since', 'asc')
    .limit(batchLimit)
    .execute()

  for (const row of closeRows) {
    try {
      await closeOne(db, row, now)
      summary.closed++
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

interface PendingRow {
  id: string
  shop_id: string
  opener_user_id: string
  subject: string
  pending_seller_since?: string | null
}

async function sendWarning(
  db: Kysely<Database>,
  row: PendingRow,
  now: Date,
  autoCloseDays: number,
  warningLeadDays: number,
): Promise<void> {
  // Guarded stamp — if two workers pick the same row, only the first
  // write lands (second gets 0 rows affected because
  // auto_close_warned_at already set).
  await db
    .updateTable('support_tickets')
    .set({ auto_close_warned_at: now.toISOString() })
    .where('id', '=', row.id)
    .where('auto_close_warned_at', 'is', null)
    .execute()

  await db
    .insertInto('support_ticket_events')
    .values({
      ticket_id: row.id,
      event_type: 'auto_close_warned',
      actor_user_id: null,
      metadata: JSON.stringify({
        warnedAt: now.toISOString(),
        autoCloseDays,
        warningLeadDays,
      }) as unknown as any,
    })
    .execute()

  await sendSupportNotification(db, {
    ticketId: row.id,
    notificationType: 'auto_close_warning',
    recipientUserId: row.opener_user_id,
    subject: `Your ticket "${truncate(row.subject, 60)}" will auto-close soon`,
    body: [
      `We haven't heard from you on this ticket in a while.`,
      ``,
      `If we don't hear back within ${warningLeadDays} day${warningLeadDays === 1 ? '' : 's'},`,
      `the ticket will be automatically closed. Just reply to keep it open.`,
      ``,
      `You can always reopen a closed ticket by visiting your support dashboard.`,
    ].join('\n'),
    link: `/app/support/tickets/${row.id}`,
    now,
  })
}

async function closeOne(
  db: Kysely<Database>,
  row: PendingRow,
  now: Date,
): Promise<void> {
  // Transition atomic: status + closed_at + resolved_at clear pending
  // markers. We guard on status='pending_seller' so a concurrent manual
  // status change (seller replied, agent closed, whatever) wins.
  const nowIso = now.toISOString()
  await db
    .updateTable('support_tickets')
    .set({
      status: 'closed',
      closed_at: nowIso,
      pending_seller_since: null,
    })
    .where('id', '=', row.id)
    .where('status', '=', 'pending_seller')
    .execute()

  await db
    .insertInto('support_ticket_events')
    .values({
      ticket_id: row.id,
      event_type: 'auto_closed',
      actor_user_id: null,
      metadata: JSON.stringify({
        closedAt: nowIso,
        reason: 'no_seller_response_7d',
      }) as unknown as any,
    })
    .execute()

  await db
    .insertInto('support_ticket_events')
    .values({
      ticket_id: row.id,
      event_type: 'status_changed',
      actor_user_id: null,
      metadata: JSON.stringify({
        from: 'pending_seller',
        to: 'closed',
        reason: 'auto_close',
      }) as unknown as any,
    })
    .execute()

  await sendSupportNotification(db, {
    ticketId: row.id,
    notificationType: 'auto_close',
    recipientUserId: row.opener_user_id,
    subject: `Your ticket "${truncate(row.subject, 60)}" has been closed`,
    body: [
      `We haven't heard back from you, so we've closed this ticket.`,
      ``,
      `If you still need help, just reply on the ticket page and we'll reopen it.`,
      ``,
      `Thanks for using Gbox support.`,
    ].join('\n'),
    link: `/app/support/tickets/${row.id}`,
    now,
  })
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}
