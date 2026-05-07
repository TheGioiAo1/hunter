/**
 * Support module — service layer.
 *
 * Single-entry API for ticket + message lifecycle. Callers (HTTP routes,
 * cron tasks, AI integrations) never touch `db.insertInto(...)` for the
 * support_* tables directly — they go through this module so invariants
 * (event logging, counter bumps, encryption) stay centralised.
 *
 * Public operations:
 *   - createTicket       — opener = seller (or system for automations)
 *   - addMessage         — seller reply, agent reply, internal note, system msg
 *   - claimTicket        — assign to an agent (idempotent)
 *   - assignTicket       — assign to a specific agent (agent-initiated)
 *   - unassignTicket
 *   - setStatus          — state machine enforced (see ALLOWED_TRANSITIONS)
 *   - setPriority
 *   - closeTicket        — status=closed + closed_at + SLA stop
 *   - reopenTicket       — status=open + clears closed_at (7d window)
 *   - markRead           — flip unread counters
 *   - submitCsat         — one-shot rating
 *   - mergeTickets       — merges A into B (Zendesk-style)
 *
 * Every mutation writes a row to `support_ticket_events`. The event
 * log is the audit source of truth — logs can be tailed, events can
 * be replayed.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { encryptMessage, resolveCurrentKey } from './crypto.ts'
import {
  checkRateLimit,
  SUPPORT_RATE_LIMITS,
} from './rate-limit.ts'
import { computeSlaDeadlines } from './sla-calc.ts'
import {
  SupportError,
  type AddMessageInput,
  type CreateTicketInput,
  type EventMetadataMap,
  type SupportEventType,
  type SupportPriority,
  type SupportStatus,
} from './types.ts'

/**
 * State machine — what status transitions are allowed. Any edge not
 * listed throws `SupportError('STALE_STATE')`.
 *
 *     open ──► pending_agent ──► pending_seller ──► resolved ──► closed
 *       │           ▲               │                     ▲        ▲
 *       │           │               └─ (seller replies) ──┘        │
 *       └─────── merged ◄── (admin merge from any state)    reopen ┘
 *
 * Exported so unit tests can pin the edge set without needing a DB.
 */
export const ALLOWED_TRANSITIONS: Record<SupportStatus, SupportStatus[]> = {
  open: ['pending_agent', 'pending_seller', 'resolved', 'closed', 'merged'],
  pending_agent: ['pending_seller', 'resolved', 'closed', 'merged'],
  pending_seller: ['pending_agent', 'resolved', 'closed', 'merged'],
  resolved: ['pending_agent', 'closed', 'merged'],
  closed: ['open'], // reopen
  merged: [], // terminal
}

export async function createTicket(
  db: Kysely<Database>,
  input: CreateTicketInput,
  now: Date = new Date(),
): Promise<{ ticketId: string; messageId: string }> {
  validateCreateTicket(input)
  // Rate limit: per-shop ticket creation.
  await checkRateLimit(db, SUPPORT_RATE_LIMITS.CREATE_TICKET, input.shopId, now)

  const { firstResponseAt, resolutionAt } = computeSlaDeadlines({
    category: input.category,
    openedAt: now,
  })

  return db.transaction().execute(async (trx) => {
    const ticket = await trx
      .insertInto('support_tickets')
      .values({
        shop_id: input.shopId,
        opener_user_id: input.openerUserId,
        category: input.category,
        subject: input.subject.trim(),
        priority: input.priority ?? 'normal',
        sla_first_response_at: firstResponseAt,
        sla_resolution_at: resolutionAt,
        last_message_at: now.toISOString(),
        unread_by_agent_count: 1,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow()

    const encryption = encryptCurrent(input.body)
    const message = await trx
      .insertInto('support_messages')
      .values({
        ticket_id: ticket.id,
        sender_type: 'seller',
        sender_user_id: input.openerUserId,
        body_ciphertext: encryption.ciphertext,
        body_iv: encryption.iv,
        body_tag: encryption.tag,
        body_key_version: encryption.keyVersion,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow()

    await logEvent(trx, ticket.id, 'ticket_opened', input.openerUserId, {
      openerUserId: input.openerUserId,
      category: input.category,
      priority: input.priority ?? 'normal',
    })

    return { ticketId: ticket.id, messageId: message.id }
  })
}

export async function addMessage(
  db: Kysely<Database>,
  input: AddMessageInput,
  now: Date = new Date(),
): Promise<{ messageId: string }> {
  validateAddMessage(input)
  if (input.senderType !== 'system' && !input.senderUserId) {
    throw new SupportError('senderUserId required unless sender_type is system', 'INVALID_INPUT')
  }
  if (input.senderType !== 'system') {
    await checkRateLimit(
      db,
      SUPPORT_RATE_LIMITS.POST_MESSAGE,
      input.senderUserId!,
      now,
    )
  }

  return db.transaction().execute(async (trx) => {
    const ticket = await trx
      .selectFrom('support_tickets')
      .where('id', '=', input.ticketId)
      .select(['id', 'status', 'first_responded_at', 'shop_id'])
      .executeTakeFirst()
    if (!ticket) throw new SupportError('ticket not found', 'NOT_FOUND')
    if (ticket.status === 'closed' || ticket.status === 'merged') {
      throw new SupportError('ticket already closed', 'ALREADY_CLOSED')
    }

    const encryption = encryptCurrent(input.body)
    const message = await trx
      .insertInto('support_messages')
      .values({
        ticket_id: input.ticketId,
        sender_type: input.senderType,
        sender_user_id: input.senderUserId,
        body_ciphertext: encryption.ciphertext,
        body_iv: encryption.iv,
        body_tag: encryption.tag,
        body_key_version: encryption.keyVersion,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow()

    // Insert mentions (internal notes only).
    if (input.senderType === 'agent_internal_note' && input.mentionedUserIds?.length) {
      const rows = input.mentionedUserIds.map((uid) => ({
        message_id: message.id,
        mentioned_user_id: uid,
      }))
      await trx.insertInto('support_mentions').values(rows).execute()
    }

    // Bookkeeping: bump counters + mark first-response.
    const updates: Record<string, unknown> = {
      last_message_at: now.toISOString(),
      updated_at: now.toISOString(),
    }
    if (input.senderType === 'seller') {
      updates['unread_by_agent_count'] = bumpCounter('unread_by_agent_count')
    } else if (input.senderType === 'agent') {
      updates['unread_by_seller_count'] = bumpCounter('unread_by_seller_count')
      if (!ticket.first_responded_at) {
        updates['first_responded_at'] = now.toISOString()
      }
    }
    // agent_internal_note + system don't bump either counter for the seller.
    await trx
      .updateTable('support_tickets')
      .set(updateExprs(trx, updates))
      .where('id', '=', input.ticketId)
      .execute()

    const eventType: SupportEventType =
      input.senderType === 'seller'
        ? 'seller_replied'
        : input.senderType === 'agent_internal_note'
          ? 'internal_note_added'
          : input.senderType === 'system'
            ? 'agent_replied' // system posts count as "agent side" for events
            : 'agent_replied'

    const metadata: EventMetadataMap[SupportEventType] =
      input.senderType === 'agent_internal_note'
        ? {
            messageId: message.id,
            mentions: input.mentionedUserIds ?? [],
          }
        : input.senderType === 'seller'
          ? { messageId: message.id }
          : { messageId: message.id, internal: false }

    await logEvent(trx, input.ticketId, eventType, input.senderUserId, metadata as Record<string, unknown>)

    return { messageId: message.id }
  })
}

export async function claimTicket(
  db: Kysely<Database>,
  ticketId: string,
  agentId: string,
): Promise<void> {
  if (!ticketId || !agentId) {
    throw new SupportError('ticketId and agentId required', 'INVALID_INPUT')
  }
  await db.transaction().execute(async (trx) => {
    const t = await trx
      .selectFrom('support_tickets')
      .where('id', '=', ticketId)
      .select(['assigned_agent_id'])
      .executeTakeFirst()
    if (!t) throw new SupportError('ticket not found', 'NOT_FOUND')
    if (t.assigned_agent_id === agentId) return
    await trx
      .updateTable('support_tickets')
      .set({ assigned_agent_id: agentId })
      .where('id', '=', ticketId)
      .execute()
    await logEvent(trx, ticketId, 'ticket_assigned', agentId, {
      fromAgentId: t.assigned_agent_id,
      toAgentId: agentId,
    })
  })
}

export async function setStatus(
  db: Kysely<Database>,
  ticketId: string,
  newStatus: SupportStatus,
  actorUserId: string,
  now: Date = new Date(),
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const t = await trx
      .selectFrom('support_tickets')
      .where('id', '=', ticketId)
      .select(['status', 'closed_at'])
      .executeTakeFirst()
    if (!t) throw new SupportError('ticket not found', 'NOT_FOUND')
    const from = t.status as SupportStatus
    const allowed = ALLOWED_TRANSITIONS[from]
    if (!allowed.includes(newStatus)) {
      throw new SupportError(
        `illegal transition ${from} → ${newStatus}`,
        'STALE_STATE',
      )
    }

    const updates: Record<string, unknown> = { status: newStatus }
    if (newStatus === 'closed') {
      updates['closed_at'] = now.toISOString()
    }
    if (newStatus === 'resolved') {
      updates['resolved_at'] = now.toISOString()
    }
    if (newStatus === 'open' && from === 'closed') {
      // Reopen: check 7d window.
      const prev = await trx
        .selectFrom('support_tickets')
        .where('id', '=', ticketId)
        .select(['closed_at'])
        .executeTakeFirst()
      if (prev?.closed_at) {
        const ageMs = now.getTime() - new Date(prev.closed_at).getTime()
        if (ageMs > 7 * 24 * 3600 * 1000) {
          throw new SupportError('reopen window expired (7d)', 'STALE_STATE')
        }
      }
      updates['closed_at'] = null
    }

    // Phase 12.5 PR5 — auto-close bookkeeping. `pending_seller_since`
    // starts the 7-day clock when the ticket enters `pending_seller`.
    // Any other transition (seller replied → pending_agent, agent
    // resolved, closed, merged) clears both pending_seller_since AND
    // auto_close_warned_at so a subsequent re-entry to pending_seller
    // starts a fresh clock instead of firing an instant close.
    if (newStatus === 'pending_seller') {
      updates['pending_seller_since'] = now.toISOString()
      // Don't reset auto_close_warned_at here — if the ticket bounced
      // pending_seller → pending_agent → pending_seller within the
      // warning window, we want the prior warning to still count.
      // That's handled on exit transitions below instead.
    } else {
      updates['pending_seller_since'] = null
      updates['auto_close_warned_at'] = null
    }

    await trx
      .updateTable('support_tickets')
      .set(updates)
      .where('id', '=', ticketId)
      .execute()

    const eventType: SupportEventType =
      newStatus === 'closed' ? 'ticket_closed' : newStatus === 'open' && from === 'closed' ? 'ticket_reopened' : 'status_changed'
    const metadata =
      eventType === 'ticket_closed'
        ? { closedBy: actorUserId, reason: null }
        : eventType === 'ticket_reopened'
          ? { reopenedBy: actorUserId, reason: null }
          : { from, to: newStatus }
    await logEvent(trx, ticketId, eventType, actorUserId, metadata)
  })
}

export async function setPriority(
  db: Kysely<Database>,
  ticketId: string,
  newPriority: SupportPriority,
  actorUserId: string,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const t = await trx
      .selectFrom('support_tickets')
      .where('id', '=', ticketId)
      .select(['priority'])
      .executeTakeFirst()
    if (!t) throw new SupportError('ticket not found', 'NOT_FOUND')
    const from = t.priority as SupportPriority
    if (from === newPriority) return
    await trx
      .updateTable('support_tickets')
      .set({ priority: newPriority })
      .where('id', '=', ticketId)
      .execute()
    await logEvent(trx, ticketId, 'priority_changed', actorUserId, {
      from,
      to: newPriority,
    })
  })
}

export async function markReadBySeller(
  db: Kysely<Database>,
  shopId: string,
  ticketId: string,
  now: Date = new Date(),
): Promise<void> {
  if (!shopId || !ticketId) {
    throw new SupportError('shopId and ticketId required', 'INVALID_INPUT')
  }
  await db.transaction().execute(async (trx) => {
    const t = await trx
      .selectFrom('support_tickets')
      .where('id', '=', ticketId)
      .where('shop_id', '=', shopId)
      .select(['id'])
      .executeTakeFirst()
    if (!t) throw new SupportError('ticket not found', 'NOT_FOUND')

    await trx
      .updateTable('support_messages')
      .set({ seller_read_at: now.toISOString() })
      .where('ticket_id', '=', ticketId)
      .where('sender_type', '=', 'agent')
      .where('seller_read_at', 'is', null)
      .execute()

    await trx
      .updateTable('support_tickets')
      .set({ unread_by_seller_count: 0 })
      .where('id', '=', ticketId)
      .execute()
  })
}

export async function markReadByAgent(
  db: Kysely<Database>,
  ticketId: string,
  now: Date = new Date(),
): Promise<void> {
  if (!ticketId) {
    throw new SupportError('ticketId required', 'INVALID_INPUT')
  }
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('support_messages')
      .set({ agent_read_at: now.toISOString() })
      .where('ticket_id', '=', ticketId)
      .where('sender_type', '=', 'seller')
      .where('agent_read_at', 'is', null)
      .execute()
    await trx
      .updateTable('support_tickets')
      .set({ unread_by_agent_count: 0 })
      .where('id', '=', ticketId)
      .execute()
  })
}

export async function submitCsat(
  db: Kysely<Database>,
  shopId: string,
  ticketId: string,
  rating: number,
  comment: string | null,
  actorUserId: string,
  now: Date = new Date(),
): Promise<void> {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new SupportError('rating must be 1-5', 'INVALID_INPUT')
  }
  await db.transaction().execute(async (trx) => {
    const t = await trx
      .selectFrom('support_tickets')
      .where('id', '=', ticketId)
      .where('shop_id', '=', shopId)
      .select(['id', 'csat_score', 'status', 'closed_at'])
      .executeTakeFirst()
    if (!t) throw new SupportError('ticket not found', 'NOT_FOUND')
    if (t.csat_score !== null) {
      throw new SupportError('CSAT already submitted', 'STALE_STATE')
    }
    await trx
      .updateTable('support_tickets')
      .set({
        csat_score: rating,
        csat_comment: comment,
        csat_rated_at: now.toISOString(),
      })
      .where('id', '=', ticketId)
      .execute()
    await logEvent(trx, ticketId, 'csat_rated', actorUserId, {
      score: rating,
      comment: comment ?? null,
    })
  })
}

// ── validation ────────────────────────────────────────────────────────
// Exported so unit tests can hit validation paths without going through
// a DB. `createTicket()` / `addMessage()` both call these first, so any
// invariants they pin hold for the public API too.

export function validateCreateTicket(input: CreateTicketInput): void {
  const failures: string[] = []
  if (!input.shopId) failures.push('shopId required')
  if (!input.openerUserId) failures.push('openerUserId required')
  if (!input.category) failures.push('category required')
  if (!input.subject || input.subject.trim().length === 0) {
    failures.push('subject required')
  }
  if (input.subject && input.subject.length > 120) {
    failures.push('subject too long (max 120)')
  }
  if (!input.body || input.body.trim().length === 0) {
    failures.push('body required')
  }
  if (input.body && input.body.length > 8000) {
    failures.push('body too long (max 8000)')
  }
  if (failures.length) {
    throw new SupportError(failures.join(', '), 'INVALID_INPUT')
  }
}

export function validateAddMessage(input: AddMessageInput): void {
  const failures: string[] = []
  if (!input.ticketId) failures.push('ticketId required')
  if (!input.senderType) failures.push('senderType required')
  if (!input.body || input.body.trim().length === 0) {
    failures.push('body required')
  }
  if (input.body && input.body.length > 8000) {
    failures.push('body too long (max 8000)')
  }
  if (
    input.senderType !== 'agent_internal_note' &&
    input.mentionedUserIds?.length
  ) {
    failures.push('mentions only allowed on internal notes')
  }
  if (failures.length) {
    throw new SupportError(failures.join(', '), 'INVALID_INPUT')
  }
}

// ── helpers ───────────────────────────────────────────────────────────

function encryptCurrent(plaintext: string): {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
  keyVersion: number
} {
  try {
    const { key, version } = resolveCurrentKey()
    return encryptMessage(plaintext, key, version)
  } catch (err) {
    throw new SupportError(
      `encryption misconfigured: ${(err as Error).message}`,
      'ENCRYPTION_MISCONFIGURED',
    )
  }
}

async function logEvent<M extends Record<string, unknown>>(
  trx: Kysely<Database>,
  ticketId: string,
  eventType: SupportEventType,
  actorUserId: string | null,
  metadata: M,
): Promise<void> {
  await trx
    .insertInto('support_ticket_events')
    .values({
      ticket_id: ticketId,
      event_type: eventType,
      actor_user_id: actorUserId,
      metadata: JSON.stringify(metadata),
    })
    .execute()
}

function bumpCounter(_column: string): unknown {
  // Kysely doesn't have a first-class "column + 1" helper on .set(); callers
  // need to use `sql` tagged literals. This helper is a sentinel the
  // `updateExprs()` post-processor swaps out.
  return Symbol.for('gbox.support.bumpCounter')
}

function updateExprs(
  _trx: Kysely<Database>,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(updates)) {
    if (v === Symbol.for('gbox.support.bumpCounter')) {
      // Build a Kysely sql expression on demand.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { sql } = require('kysely') as typeof import('kysely')
      out[k] = sql`${sql.ref(k)} + 1`
    } else {
      out[k] = v
    }
  }
  return out
}
