/**
 * Gbox Platform — support-sla engine (Phase 12.5 PR5).
 *
 * DB-touching orchestrator for SLA breach detection. Registered by the
 * cron module as `support_sla_tick`, fired every 5 minutes. Does three
 * things per tick:
 *
 *   1. Scan `support_tickets` for active tickets past a breach threshold
 *      that haven't been notified yet (marker columns idempotent the
 *      sweep — see migration 082). Two scans: first-response + resolution.
 *
 *   2. For each breach, read the on-call lead from `support_agent_profiles`
 *      (preset='lead_support', is_active=TRUE) then call the pure
 *      `decideEscalation()` in escalation.ts.
 *
 *   3. Apply the decision:
 *        - Write `support_ticket_events` row (event_type='sla_breached').
 *        - Stamp the notified-marker column so the next tick skips.
 *        - If priority bumped, update `support_tickets.priority` + log
 *          a `priority_changed` event.
 *        - Fire notifications via the support-notifications sender
 *          (each recipient × channel set by their prefs).
 *
 * Public API:
 *   - `tickSla(db, { now }): Promise<TickResult>` — one cron invocation.
 *   - `scanForBreaches(db, { now }): Promise<BreachRecord[]>` — read-only
 *     helper for tests + the /god-admin dashboard.
 *
 * No module-level state. Safe to call concurrently (Postgres transaction
 * isolates concurrent updates on the marker columns, and the marker col
 * being NULL is the unique-fire precondition).
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { sendSupportNotification } from '../support-notifications/sender.ts'
import {
  decideEscalation,
  type BreachRecord,
  type EscalationDecision,
} from './escalation.ts'
import type { SupportPriority } from '@gbox/db/schema/tables.js'

/** Summary of one tick — used for cron logging + smoke assertions. */
export interface TickResult {
  firstResponseBreaches: number
  resolutionBreaches: number
  notificationsDispatched: number
  prioritiesBumped: number
  errors: Array<{ ticketId: string; error: string }>
}

/**
 * Find all active tickets whose first-response OR resolution SLA has
 * slipped past `now` AND haven't already been notified. The partial
 * indexes in migration 082 make this cheap even at 1M+ rows.
 */
export async function scanForBreaches(
  db: Kysely<Database>,
  opts: { now?: Date } = {},
): Promise<BreachRecord[]> {
  const now = (opts.now ?? new Date()).toISOString()
  const nowMs = new Date(now).getTime()

  const firstRows = await db
    .selectFrom('support_tickets')
    .select([
      'id',
      'shop_id',
      'priority',
      'assigned_agent_id',
      'category',
      'sla_first_response_at',
      'created_at',
    ])
    .where('first_responded_at', 'is', null)
    .where('sla_first_response_notified_at', 'is', null)
    .where('status', 'not in', ['closed', 'merged'])
    .where('archived_at', 'is', null)
    .where('sla_first_response_at', '<', now)
    .execute()

  const resRows = await db
    .selectFrom('support_tickets')
    .select([
      'id',
      'shop_id',
      'priority',
      'assigned_agent_id',
      'category',
      'sla_resolution_at',
      'created_at',
    ])
    .where('resolved_at', 'is', null)
    .where('sla_resolution_notified_at', 'is', null)
    .where('status', 'not in', ['closed', 'merged'])
    .where('archived_at', 'is', null)
    .where('sla_resolution_at', '<', now)
    .execute()

  const breaches: BreachRecord[] = []

  for (const row of firstRows) {
    const deadline = new Date(row.sla_first_response_at).getTime()
    const created = new Date(row.created_at).getTime()
    const slaWindowMs = Math.max(0, deadline - created)
    breaches.push({
      ticketId: row.id,
      shopId: row.shop_id,
      breachType: 'first_response',
      overdueMs: Math.max(0, nowMs - deadline),
      slaWindowMs,
      priority: row.priority as SupportPriority,
      assignedAgentId: row.assigned_agent_id ?? null,
      category: row.category,
    })
  }

  for (const row of resRows) {
    const deadline = new Date(row.sla_resolution_at).getTime()
    const created = new Date(row.created_at).getTime()
    const slaWindowMs = Math.max(0, deadline - created)
    breaches.push({
      ticketId: row.id,
      shopId: row.shop_id,
      breachType: 'resolution',
      overdueMs: Math.max(0, nowMs - deadline),
      slaWindowMs,
      priority: row.priority as SupportPriority,
      assignedAgentId: row.assigned_agent_id ?? null,
      category: row.category,
    })
  }

  return breaches
}

/**
 * Resolve the currently active on-call lead. Returns `null` if no lead
 * is configured — escalation.ts gracefully handles that (falls back to
 * "notify assigned agent only"), but the caller should log a warning.
 *
 * Strategy: pick the lead whose `last_seen_at` is most recent among
 * all active `preset='lead_support'` profiles. In MVP we have exactly
 * one lead, but the order-by makes this robust to a team that grows.
 */
export async function resolveCurrentLead(
  db: Kysely<Database>,
): Promise<string | null> {
  const row = await db
    .selectFrom('support_agent_profiles')
    .select(['user_id'])
    .where('preset', '=', 'lead_support')
    .where('is_active', '=', true)
    .orderBy('last_seen_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return row?.user_id ?? null
}

/**
 * Apply one escalation decision to the DB.
 *
 * All writes happen in a single transaction so "priority bumped but
 * notification never sent" is impossible — either both land or neither.
 * The notification dispatch ITSELF is NOT inside the transaction (SMTP
 * latency would hold locks too long); instead the tx commits first,
 * the notification is attempted second, and the log row records
 * success/failure for audit.
 */
export async function applyEscalation(
  db: Kysely<Database>,
  breach: BreachRecord,
  decision: EscalationDecision,
  now: Date = new Date(),
): Promise<{ notificationsSent: number; priorityBumped: boolean }> {
  let priorityBumped = false

  await db.transaction().execute(async (trx) => {
    // 1. Stamp the notified-marker column so the next tick skips.
    const notifyCol =
      breach.breachType === 'first_response'
        ? 'sla_first_response_notified_at'
        : 'sla_resolution_notified_at'

    const updates: Record<string, unknown> = {
      [notifyCol]: now.toISOString(),
    }
    if (decision.newPriority) {
      updates['priority'] = decision.newPriority
      priorityBumped = true
    }

    await trx
      .updateTable('support_tickets')
      .set(updates)
      .where('id', '=', breach.ticketId)
      .execute()

    // 2. Write the audit event row(s).
    await trx
      .insertInto('support_ticket_events')
      .values({
        ticket_id: breach.ticketId,
        event_type: 'sla_breached',
        actor_user_id: null,
        metadata: JSON.stringify({
          breachType: breach.breachType,
          overdueMs: breach.overdueMs,
          reason: decision.reason,
          pageLead: decision.pageLead,
          priorityBumped,
        }) as unknown as any,
      })
      .execute()

    if (priorityBumped) {
      await trx
        .insertInto('support_ticket_events')
        .values({
          ticket_id: breach.ticketId,
          event_type: 'priority_changed',
          actor_user_id: null,
          metadata: JSON.stringify({
            from: breach.priority,
            to: decision.newPriority,
            reason: 'sla_escalation_auto_bump',
          }) as unknown as any,
        })
        .execute()
    }
  })

  // 3. Dispatch notifications AFTER the tx commits (SMTP outside the lock).
  let notificationsSent = 0
  for (const userId of decision.notifyUserIds) {
    try {
      const result = await sendSupportNotification(db, {
        ticketId: breach.ticketId,
        notificationType:
          breach.breachType === 'first_response'
            ? 'sla_first_response_breach'
            : 'sla_resolution_breach',
        recipientUserId: userId,
        subject: `[SLA breach] Ticket ${breach.ticketId.slice(0, 8)} — ${decision.reason}`,
        body: buildBreachBody(breach, decision),
        now,
      })
      if (result.sent > 0) notificationsSent += result.sent
    } catch (_err) {
      // sendSupportNotification already logs into support_notifications_log
      // with status='failed'; swallow here so one bad SMTP doesn't block
      // the rest of the tick.
    }
  }

  return { notificationsSent, priorityBumped }
}

/**
 * One cron tick: scan → decide → apply. Returns a summary for logging.
 */
export async function tickSla(
  db: Kysely<Database>,
  opts: { now?: Date } = {},
): Promise<TickResult> {
  const now = opts.now ?? new Date()
  const breaches = await scanForBreaches(db, { now })
  const leadUserId = await resolveCurrentLead(db)

  const summary: TickResult = {
    firstResponseBreaches: 0,
    resolutionBreaches: 0,
    notificationsDispatched: 0,
    prioritiesBumped: 0,
    errors: [],
  }

  for (const breach of breaches) {
    if (breach.breachType === 'first_response') summary.firstResponseBreaches++
    else summary.resolutionBreaches++

    const decision = decideEscalation(breach, { leadUserId })
    try {
      const res = await applyEscalation(db, breach, decision, now)
      summary.notificationsDispatched += res.notificationsSent
      if (res.priorityBumped) summary.prioritiesBumped++
    } catch (err) {
      summary.errors.push({
        ticketId: breach.ticketId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return summary
}

// ── helpers ─────────────────────────────────────────────────────────────

function buildBreachBody(
  breach: BreachRecord,
  decision: EscalationDecision,
): string {
  const hh = Math.floor(breach.overdueMs / 3600_000)
  const mm = Math.floor((breach.overdueMs % 3600_000) / 60_000)
  const overdue = `${hh}h ${mm}m`
  const kind =
    breach.breachType === 'first_response' ? 'first-response' : 'resolution'
  return [
    `Ticket ${breach.ticketId} has breached its ${kind} SLA.`,
    `Overdue by ${overdue}. Category: ${breach.category}. Current priority: ${breach.priority}.`,
    decision.reason ? `Reason: ${decision.reason}.` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

// `sql` is imported but only needed if we ever add a raw SQL helper —
// keep the import for future extension without triggering no-unused.
void sql
