/**
 * Query helpers for the support module.
 *
 * The helpers fall into two camps:
 *
 *   - **Seller-scoped**: WHERE shop_id = $auth_shop_id is non-optional.
 *     Cross-shop leak prevention is the single highest-priority
 *     invariant for this module (Iron rule 2 + spec §8). Every
 *     seller-scoped helper takes `shopId` as a required, non-nullable
 *     argument and filters with it. A stray `null` or `''` would
 *     return zero rows, not every row — intentional.
 *
 *   - **Agent-scoped**: callers must already hold a support-staff
 *     permission (checked by middleware upstream). These return the
 *     full shape and do not filter by shop_id. They DO filter
 *     `archived_at IS NULL` unless `includeArchived=true`.
 *
 * Encrypted message bodies are decrypted inside `listMessagesForSeller`
 * and `listMessagesForAgent`. Crypto errors (tag mismatch,
 * misconfiguration) never leak to the caller — the row is rendered as
 * a sentinel `{ body: '[message unavailable]' }`.
 */

import type { Kysely } from 'kysely'
import type {
  Database,
  SupportMessageTable,
  SupportTicketTable,
} from '@gbox/db/schema/tables.js'
import {
  decryptMessage,
  resolveKeyForVersion,
  type EncryptedMessage,
} from './crypto.ts'
import type {
  AgentMessageView,
  AgentTicketView,
  SellerMessageView,
  SellerTicketView,
  SupportStatus,
} from './types.ts'

/** A subset of SupportMessageTable fields that's cheap to hand around. */
type MessageRow = {
  id: string
  ticket_id: string
  sender_type: string
  sender_user_id: string | null
  body_ciphertext: Buffer
  body_iv: Buffer
  body_tag: Buffer
  body_key_version: number
  edited_at: string | null
  edit_count: number
  deleted_at: string | null
  created_at: string
}

type TicketRow = {
  id: string
  shop_id: string
  opener_user_id: string
  category: string
  subject: string
  status: string
  priority: string
  assigned_agent_id: string | null
  last_message_at: string
  unread_by_seller_count: number
  unread_by_agent_count: number
  csat_score: number | null
  created_at: string
  updated_at: string
  archived_at: string | null
}

// ── Seller-scoped queries ─────────────────────────────────────────────

export async function listTicketsForSeller(
  db: Kysely<Database>,
  shopId: string,
  opts: {
    status?: SupportStatus | 'any'
    limit?: number
    offset?: number
  } = {},
): Promise<SellerTicketView[]> {
  if (!shopId) return []
  let query = db
    .selectFrom('support_tickets as t')
    .leftJoin('support_agent_profiles as ap', 'ap.user_id', 't.assigned_agent_id')
    .where('t.shop_id', '=', shopId)
    .where('t.archived_at', 'is', null)
    .select([
      't.id as id',
      't.shop_id as shopId',
      't.category as category',
      't.subject as subject',
      't.status as status',
      't.priority as priority',
      'ap.display_name as agentDisplayName',
      't.created_at as createdAt',
      't.updated_at as updatedAt',
      't.last_message_at as lastMessageAt',
      't.unread_by_seller_count as unreadCount',
      't.csat_score as csatScore',
    ])
  if (opts.status && opts.status !== 'any') {
    query = query.where('t.status', '=', opts.status)
  }
  query = query.orderBy('t.last_message_at', 'desc')
  if (opts.limit !== undefined) query = query.limit(opts.limit)
  if (opts.offset !== undefined) query = query.offset(opts.offset)
  const rows = await query.execute()
  return rows.map(rowToSellerTicketView)
}

export async function getTicketForSeller(
  db: Kysely<Database>,
  shopId: string,
  ticketId: string,
): Promise<SellerTicketView | null> {
  if (!shopId || !ticketId) return null
  const row = await db
    .selectFrom('support_tickets as t')
    .leftJoin('support_agent_profiles as ap', 'ap.user_id', 't.assigned_agent_id')
    .where('t.shop_id', '=', shopId)
    .where('t.id', '=', ticketId)
    .where('t.archived_at', 'is', null)
    .select([
      't.id as id',
      't.shop_id as shopId',
      't.category as category',
      't.subject as subject',
      't.status as status',
      't.priority as priority',
      'ap.display_name as agentDisplayName',
      't.created_at as createdAt',
      't.updated_at as updatedAt',
      't.last_message_at as lastMessageAt',
      't.unread_by_seller_count as unreadCount',
      't.csat_score as csatScore',
    ])
    .executeTakeFirst()
  return row ? rowToSellerTicketView(row) : null
}

/**
 * List messages visible to the seller. Internal notes are filtered
 * out at the SQL layer (not just the UI) — §1 rule 9 defense in depth.
 */
export async function listMessagesForSeller(
  db: Kysely<Database>,
  shopId: string,
  ticketId: string,
  openerDisplayName: string,
): Promise<SellerMessageView[]> {
  if (!shopId || !ticketId) return []
  // First verify the ticket belongs to this shop.
  const ticket = await db
    .selectFrom('support_tickets')
    .where('id', '=', ticketId)
    .where('shop_id', '=', shopId)
    .where('archived_at', 'is', null)
    .select(['id', 'shop_id'])
    .executeTakeFirst()
  if (!ticket) return []

  const rows = await db
    .selectFrom('support_messages as m')
    .leftJoin('support_agent_profiles as ap', 'ap.user_id', 'm.sender_user_id')
    .where('m.ticket_id', '=', ticketId)
    .where('m.sender_type', '!=', 'agent_internal_note') // ← SQL-layer filter
    .where('m.deleted_at', 'is', null)
    .select([
      'm.id as id',
      'm.ticket_id as ticketId',
      'm.sender_type as senderType',
      'm.sender_user_id as senderUserId',
      'm.body_ciphertext as bodyCiphertext',
      'm.body_iv as bodyIv',
      'm.body_tag as bodyTag',
      'm.body_key_version as bodyKeyVersion',
      'm.created_at as createdAt',
      'ap.display_name as agentDisplayName',
    ])
    .orderBy('m.created_at', 'asc')
    .execute()

  return rows.map((r) => {
    const body = safelyDecrypt({
      ciphertext: r.bodyCiphertext,
      iv: r.bodyIv,
      tag: r.bodyTag,
      keyVersion: r.bodyKeyVersion,
    })
    const isSeller = r.senderType === 'seller'
    const isSystem = r.senderType === 'system'
    const senderDisplayName = isSeller
      ? openerDisplayName
      : isSystem
        ? 'Gbox System'
        : r.agentDisplayName
          ? `${r.agentDisplayName} (Gbox)`
          : 'Gbox Support'
    return {
      id: r.id as string,
      ticketId: r.ticketId as string,
      senderType: r.senderType as 'seller' | 'agent' | 'system',
      senderDisplayName,
      body,
      isOwn: isSeller,
      createdAt: r.createdAt as string,
    }
  })
}

// ── Agent-scoped queries ──────────────────────────────────────────────

export async function listTicketsForAgent(
  db: Kysely<Database>,
  opts: {
    status?: SupportStatus | 'any'
    assignedTo?: string
    includeArchived?: boolean
    limit?: number
    offset?: number
  } = {},
): Promise<AgentTicketView[]> {
  let query = db
    .selectFrom('support_tickets as t')
    .innerJoin('shops as s', 's.id', 't.shop_id')
    .leftJoin('users as opener', 'opener.id', 't.opener_user_id')
    .leftJoin('support_agent_profiles as ap', 'ap.user_id', 't.assigned_agent_id')
    .select([
      't.id as id',
      't.shop_id as shopId',
      's.name as shopName',
      's.slug as shopSlug',
      't.opener_user_id as openerUserId',
      'opener.name as openerDisplayName',
      't.category as category',
      't.subject as subject',
      't.status as status',
      't.priority as priority',
      't.assigned_agent_id as assignedAgentId',
      'ap.display_name as assignedAgentDisplayName',
      't.sla_first_response_at as slaFirstResponseAt',
      't.sla_resolution_at as slaResolutionAt',
      't.first_responded_at as firstRespondedAt',
      't.resolved_at as resolvedAt',
      't.closed_at as closedAt',
      't.csat_score as csatScore',
      't.last_message_at as lastMessageAt',
      't.unread_by_agent_count as unreadByAgentCount',
      't.created_at as createdAt',
      't.updated_at as updatedAt',
    ])
  if (!opts.includeArchived) {
    query = query.where('t.archived_at', 'is', null)
  }
  if (opts.status && opts.status !== 'any') {
    query = query.where('t.status', '=', opts.status)
  }
  if (opts.assignedTo) {
    query = query.where('t.assigned_agent_id', '=', opts.assignedTo)
  }
  query = query.orderBy('t.last_message_at', 'desc')
  if (opts.limit !== undefined) query = query.limit(opts.limit)
  if (opts.offset !== undefined) query = query.offset(opts.offset)
  const rows = await query.execute()
  return rows.map((r) => ({
    id: r.id as string,
    shopId: r.shopId as string,
    shopName: r.shopName as string,
    shopSlug: r.shopSlug as string,
    openerUserId: r.openerUserId as string,
    openerDisplayName: (r.openerDisplayName as string | null) ?? 'Seller',
    category: r.category as AgentTicketView['category'],
    subject: r.subject as string,
    status: r.status as SupportStatus,
    priority: r.priority as AgentTicketView['priority'],
    assignedAgentId: r.assignedAgentId as string | null,
    assignedAgentDisplayName: r.assignedAgentDisplayName as string | null,
    slaFirstResponseAt: r.slaFirstResponseAt as string,
    slaResolutionAt: r.slaResolutionAt as string,
    firstRespondedAt: r.firstRespondedAt as string | null,
    resolvedAt: r.resolvedAt as string | null,
    closedAt: r.closedAt as string | null,
    csatScore: r.csatScore as number | null,
    lastMessageAt: r.lastMessageAt as string,
    unreadByAgentCount: r.unreadByAgentCount as number,
    createdAt: r.createdAt as string,
    updatedAt: r.updatedAt as string,
  }))
}

export async function listMessagesForAgent(
  db: Kysely<Database>,
  ticketId: string,
): Promise<AgentMessageView[]> {
  if (!ticketId) return []
  const rows = await db
    .selectFrom('support_messages as m')
    .leftJoin('support_agent_profiles as ap', 'ap.user_id', 'm.sender_user_id')
    .leftJoin('users as u', 'u.id', 'm.sender_user_id')
    .where('m.ticket_id', '=', ticketId)
    .select([
      'm.id as id',
      'm.ticket_id as ticketId',
      'm.sender_type as senderType',
      'm.sender_user_id as senderUserId',
      'm.body_ciphertext as bodyCiphertext',
      'm.body_iv as bodyIv',
      'm.body_tag as bodyTag',
      'm.body_key_version as bodyKeyVersion',
      'm.edited_at as editedAt',
      'm.edit_count as editCount',
      'm.deleted_at as deletedAt',
      'm.created_at as createdAt',
      'ap.display_name as agentDisplayName',
      'u.name as userName',
      'u.email as userEmail',
    ])
    .orderBy('m.created_at', 'asc')
    .execute()

  const mentionIndex = await loadMentions(
    db,
    rows.map((r) => r.id as string),
  )

  return rows.map((r) => {
    const body = safelyDecrypt({
      ciphertext: r.bodyCiphertext,
      iv: r.bodyIv,
      tag: r.bodyTag,
      keyVersion: r.bodyKeyVersion,
    })
    const senderDisplayName = senderDisplayForAgentView({
      senderType: r.senderType as string,
      agentDisplayName: r.agentDisplayName as string | null,
      userName: r.userName as string | null,
      userEmail: r.userEmail as string | null,
    })
    return {
      id: r.id as string,
      ticketId: r.ticketId as string,
      senderType: r.senderType as AgentMessageView['senderType'],
      senderUserId: r.senderUserId as string | null,
      senderDisplayName,
      body,
      editedAt: r.editedAt as string | null,
      editCount: r.editCount as number,
      deletedAt: r.deletedAt as string | null,
      createdAt: r.createdAt as string,
      mentions: mentionIndex.get(r.id as string) ?? [],
    }
  })
}

// ── helpers ───────────────────────────────────────────────────────────

function rowToSellerTicketView(r: {
  id: string
  shopId: string
  category: string
  subject: string
  status: string
  priority: string
  agentDisplayName: string | null
  createdAt: string
  updatedAt: string
  lastMessageAt: string
  unreadCount: number
  csatScore: number | null
}): SellerTicketView {
  return {
    id: r.id,
    shopId: r.shopId,
    category: r.category as SellerTicketView['category'],
    subject: r.subject,
    status: r.status as SupportStatus,
    priority: r.priority as SellerTicketView['priority'],
    agentDisplayName: r.agentDisplayName ? `${r.agentDisplayName} (Gbox)` : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastMessageAt: r.lastMessageAt,
    unreadCount: r.unreadCount,
    csatScore: r.csatScore,
  }
}

function safelyDecrypt(enc: EncryptedMessage): string {
  try {
    const key = resolveKeyForVersion(enc.keyVersion)
    return decryptMessage(enc, key)
  } catch {
    return '[message unavailable]'
  }
}

function senderDisplayForAgentView(args: {
  senderType: string
  agentDisplayName: string | null
  userName: string | null
  userEmail: string | null
}): string {
  if (args.senderType === 'seller') {
    return args.userName ?? args.userEmail ?? 'Seller'
  }
  if (args.senderType === 'system') return 'Gbox System'
  return args.agentDisplayName ?? args.userName ?? 'Agent'
}

async function loadMentions(
  db: Kysely<Database>,
  messageIds: string[],
): Promise<Map<string, Array<{ userId: string; displayName: string }>>> {
  const map = new Map<string, Array<{ userId: string; displayName: string }>>()
  if (messageIds.length === 0) return map
  const rows = await db
    .selectFrom('support_mentions as sm')
    .leftJoin('support_agent_profiles as ap', 'ap.user_id', 'sm.mentioned_user_id')
    .leftJoin('users as u', 'u.id', 'sm.mentioned_user_id')
    .where('sm.message_id', 'in', messageIds)
    .select([
      'sm.message_id as messageId',
      'sm.mentioned_user_id as userId',
      'ap.display_name as displayName',
      'u.name as userName',
    ])
    .execute()
  for (const r of rows) {
    const arr = map.get(r.messageId as string) ?? []
    arr.push({
      userId: r.userId as string,
      displayName: (r.displayName as string | null) ?? (r.userName as string | null) ?? 'Agent',
    })
    map.set(r.messageId as string, arr)
  }
  return map
}

/**
 * Compose a "cheap summary row" for a ticket — used by dashboards that
 * want the hot fields without paying for joins. Exported primarily so
 * the seller widget's polling endpoint can render unread counts
 * without touching support_messages.
 */
export async function getTicketUnreadCountsForSeller(
  db: Kysely<Database>,
  shopId: string,
): Promise<{ total: number; perTicket: Array<{ ticketId: string; unread: number }> }> {
  if (!shopId) return { total: 0, perTicket: [] }
  const rows = await db
    .selectFrom('support_tickets')
    .where('shop_id', '=', shopId)
    .where('archived_at', 'is', null)
    .where('unread_by_seller_count', '>', 0)
    .select(['id as ticketId', 'unread_by_seller_count as unread'])
    .execute()
  const total = rows.reduce((a, r) => a + (r.unread as number), 0)
  return {
    total,
    perTicket: rows.map((r) => ({
      ticketId: r.ticketId as string,
      unread: r.unread as number,
    })),
  }
}
