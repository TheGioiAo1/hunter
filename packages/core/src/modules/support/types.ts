/**
 * Public types for the support module.
 *
 * These are the shapes that API routes + UI code should import.
 * Internal DB shapes live in `@gbox/db/schema/tables.ts`; this file
 * re-exports a subset and adds the DTO/view models callers need.
 */

import type {
  SupportAgentPreset,
  SupportCategory,
  SupportPriority,
  SupportSenderType,
  SupportStatus,
} from '@gbox/db/schema/tables.js'

export type {
  SupportAgentPreset,
  SupportCategory,
  SupportPriority,
  SupportSenderType,
  SupportStatus,
}

/**
 * Input payload for `createTicket()`. Mirrors the new-ticket form.
 */
export interface CreateTicketInput {
  shopId: string
  openerUserId: string
  category: SupportCategory
  subject: string
  body: string
  priority?: SupportPriority
  /** Arbitrary tags for later filtering. Strings only, max 10 per ticket. */
  tags?: string[]
}

/**
 * Input payload for `addMessage()`. The caller chooses `senderType`
 * based on the authenticated actor:
 *   - seller               → merchant session posting via storefront/store-admin
 *   - agent                → support-staff session posting via supporter.gbox.co
 *   - agent_internal_note  → same as above but marked invisible to seller
 *   - system               → SLA cron, auto-escalation, automation
 */
export interface AddMessageInput {
  ticketId: string
  senderType: SupportSenderType
  /** Null only for `senderType='system'`. */
  senderUserId: string | null
  body: string
  /** Optional, populated when agent @-mentions other agents in internal notes. */
  mentionedUserIds?: string[]
}

/**
 * Ticket view shape as served by merchant API. Stripped of fields that
 * would leak support-side state to a seller (agent email, internal
 * notes, event audit trail).
 */
export interface SellerTicketView {
  id: string
  shopId: string
  category: SupportCategory
  subject: string
  status: SupportStatus
  priority: SupportPriority
  /** Agent display name, e.g. "Minh (Gbox)". Never the email. */
  agentDisplayName: string | null
  createdAt: string
  updatedAt: string
  lastMessageAt: string
  unreadCount: number
  csatScore: number | null
}

/**
 * Message view shape as served by merchant API. `agent_internal_note`
 * rows MUST be filtered out before this view is produced — see
 * `queries.listMessagesForSeller()`.
 */
export interface SellerMessageView {
  id: string
  ticketId: string
  /** 'seller' or 'agent' or 'system' — NEVER 'agent_internal_note'. */
  senderType: Exclude<SupportSenderType, 'agent_internal_note'>
  /** Display name for the seller-facing side. */
  senderDisplayName: string
  body: string
  isOwn: boolean
  createdAt: string
}

/**
 * Ticket view shape for agent interfaces (supporter.gbox.co, god-admin).
 * Includes all fields except raw emails (still gated by permission).
 */
export interface AgentTicketView {
  id: string
  shopId: string
  shopName: string
  shopSlug: string
  openerUserId: string
  openerDisplayName: string
  category: SupportCategory
  subject: string
  status: SupportStatus
  priority: SupportPriority
  assignedAgentId: string | null
  assignedAgentDisplayName: string | null
  slaFirstResponseAt: string
  slaResolutionAt: string
  firstRespondedAt: string | null
  resolvedAt: string | null
  closedAt: string | null
  csatScore: number | null
  lastMessageAt: string
  unreadByAgentCount: number
  createdAt: string
  updatedAt: string
}

export interface AgentMessageView {
  id: string
  ticketId: string
  senderType: SupportSenderType
  senderUserId: string | null
  senderDisplayName: string
  body: string
  editedAt: string | null
  editCount: number
  deletedAt: string | null
  createdAt: string
  /** For internal notes: who was @mentioned (user IDs + display names). */
  mentions: Array<{ userId: string; displayName: string }>
}

/**
 * SLA configuration — loaded from `platform_settings.support.sla_defaults`.
 */
export interface SlaConfig {
  paymentFirstResponseMinutes: number
  paymentResolutionMinutes: number
  otherFirstResponseMinutes: number
  otherResolutionMinutes: number
  businessHoursApplyToNonPayment: boolean
}

export const DEFAULT_SLA_CONFIG: SlaConfig = {
  paymentFirstResponseMinutes: 120,
  paymentResolutionMinutes: 720,
  otherFirstResponseMinutes: 240,
  otherResolutionMinutes: 1440,
  businessHoursApplyToNonPayment: true,
}

/** Well-known event types recorded in `support_ticket_events`. */
export type SupportEventType =
  | 'ticket_opened'
  | 'ticket_assigned'
  | 'ticket_unassigned'
  | 'status_changed'
  | 'priority_changed'
  | 'category_changed'
  | 'agent_replied'
  | 'seller_replied'
  | 'internal_note_added'
  | 'sla_breached'
  | 'sla_paused'
  | 'sla_resumed'
  | 'csat_prompted'
  | 'csat_rated'
  | 'ticket_closed'
  | 'ticket_reopened'
  | 'ticket_merged'
  | 'ticket_archived'
  | 'message_edited'
  | 'message_deleted'

/** Typed metadata shapes for specific events (discriminated by event_type). */
export interface EventMetadataMap {
  ticket_opened: { openerUserId: string; category: SupportCategory; priority: SupportPriority }
  ticket_assigned: { fromAgentId: string | null; toAgentId: string }
  ticket_unassigned: { fromAgentId: string }
  status_changed: { from: SupportStatus; to: SupportStatus }
  priority_changed: { from: SupportPriority; to: SupportPriority }
  category_changed: { from: SupportCategory; to: SupportCategory }
  agent_replied: { messageId: string; internal: boolean }
  seller_replied: { messageId: string }
  internal_note_added: { messageId: string; mentions: string[] }
  sla_breached: { breachType: 'first_response' | 'resolution'; overdueMs: number }
  sla_paused: { reason: string }
  sla_resumed: { pausedMs: number }
  csat_prompted: { channel: string }
  csat_rated: { score: number; comment: string | null }
  ticket_closed: { closedBy: string; reason: string | null }
  ticket_reopened: { reopenedBy: string; reason: string | null }
  ticket_merged: { intoTicketId: string; mergedBy: string }
  ticket_archived: { location: string | null }
  message_edited: { messageId: string; editCount: number }
  message_deleted: { messageId: string; deletedBy: string }
}

/**
 * Errors the service layer can throw. Callers translate these into
 * HTTP status codes + `safeMessage()` for seller-facing responses.
 */
export class SupportError extends Error {
  constructor(
    message: string,
    public readonly code: SupportErrorCode,
  ) {
    super(message)
    this.name = 'SupportError'
  }
}

export type SupportErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'RATE_LIMIT_EXCEEDED'
  | 'ALREADY_CLOSED'
  | 'ALREADY_MERGED'
  | 'ENCRYPTION_MISCONFIGURED'
  | 'STALE_STATE'
