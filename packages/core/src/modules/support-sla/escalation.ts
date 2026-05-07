/**
 * Gbox Platform — support-sla escalation rules (Phase 12.5 PR5).
 *
 * Pure decision layer. Given an observed SLA breach (first-response or
 * resolution) on an active ticket, decide:
 *
 *   - Who should be notified? (the assigned agent, or the on-call lead
 *     if no assignment / severe overrun).
 *
 *   - Should the priority auto-bump to the next level?
 *
 *   - Do we page the shift-lead via a "severe" notification, or just
 *     the standard breach email?
 *
 * Rules (spec §10.6.2):
 *
 *   1. First-response breach, assigned agent:
 *        → notify assigned agent (email + in_app).
 *        → if overdueMs > 2 * slaWindowMs  (i.e. more than double the
 *           original budget), bump priority one step and page lead.
 *
 *   2. First-response breach, unassigned:
 *        → always page lead + in-app notify all online agents.
 *        → auto-bump priority one step (unassigned ticket past SLA is
 *           already a process failure; bump so the queue sorts it up).
 *
 *   3. Resolution breach:
 *        → notify assigned agent.
 *        → if overdueMs > 1 * slaResolutionWindowMs (100% over), page
 *           lead AND bump priority one step.
 *
 *   4. Priority bump ceiling: `urgent` is top. Never bump past it.
 *
 * Pure function — no DB writes here. Caller (engine.ts) applies the
 * decision: calls `setPriority` via the support service, fires
 * `sendSupportNotification`, logs to `support_audit_log`.
 */

import type { SupportPriority } from '@gbox/db/schema/tables.js'

export type BreachType = 'first_response' | 'resolution'

export interface BreachRecord {
  ticketId: string
  shopId: string
  breachType: BreachType
  overdueMs: number
  /** Original SLA window in ms — resolution or first-response window. */
  slaWindowMs: number
  /** Current priority on the ticket. */
  priority: SupportPriority
  /** `null` ⇒ unassigned. */
  assignedAgentId: string | null
  /** Ticket category, for routing (payment tickets page faster). */
  category: string
}

export interface EscalationDecision {
  /** Users we MUST notify. The agent if assigned, lead otherwise. */
  notifyUserIds: string[]
  /** If set, the engine will flip the ticket to this priority. */
  newPriority: SupportPriority | null
  /** Page the on-call lead in addition to the primary recipient. */
  pageLead: boolean
  /** Human-readable reason chip for the audit row + admin UI. */
  reason: string
}

export const PRIORITY_ORDER: SupportPriority[] = [
  'low',
  'normal',
  'high',
  'urgent',
]

/**
 * Step priority up by one. `urgent` is a no-op (returns itself).
 */
export function bumpPriority(p: SupportPriority): SupportPriority {
  const idx = PRIORITY_ORDER.indexOf(p)
  if (idx < 0) return p
  if (idx === PRIORITY_ORDER.length - 1) return p
  return PRIORITY_ORDER[idx + 1]!
}

/**
 * Decide what to do about a breach.
 *
 * The `leadUserId` lets the caller pass the current on-call lead (we
 * resolve that from `support_agent_profiles` where `preset='lead_support'`
 * AND `is_active=TRUE` in the engine layer).
 */
export function decideEscalation(
  breach: BreachRecord,
  ctx: { leadUserId: string | null },
): EscalationDecision {
  const ratio = breach.slaWindowMs > 0
    ? breach.overdueMs / breach.slaWindowMs
    : 0

  let newPriority: SupportPriority | null = null
  let pageLead = false
  const notifyUserIds: string[] = []
  let reason = ''

  // Decide based on the 4 rules above.
  if (breach.breachType === 'first_response') {
    if (breach.assignedAgentId) {
      notifyUserIds.push(breach.assignedAgentId)
      reason = 'first-response SLA breached'
      if (ratio > 2) {
        pageLead = true
        newPriority = bumpPriority(breach.priority)
        reason = 'first-response SLA breached (>2x over; priority bumped, lead paged)'
      }
    } else {
      // Unassigned: page lead + bump priority.
      pageLead = true
      newPriority = bumpPriority(breach.priority)
      reason = 'unassigned ticket breached SLA (priority bumped, lead paged)'
    }
  } else {
    // Resolution breach.
    if (breach.assignedAgentId) {
      notifyUserIds.push(breach.assignedAgentId)
      reason = 'resolution SLA breached'
    }
    if (ratio > 1 || !breach.assignedAgentId) {
      pageLead = true
      newPriority = bumpPriority(breach.priority)
      reason = breach.assignedAgentId
        ? 'resolution SLA breached (>2x over; priority bumped, lead paged)'
        : 'unassigned ticket breached resolution SLA (priority bumped, lead paged)'
    }
  }

  if (pageLead && ctx.leadUserId && !notifyUserIds.includes(ctx.leadUserId)) {
    notifyUserIds.push(ctx.leadUserId)
  }

  // No-op bump if we're already urgent (don't return a noop priority change).
  if (newPriority === breach.priority) newPriority = null

  return { notifyUserIds, newPriority, pageLead, reason }
}
