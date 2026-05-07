/**
 * Gbox Platform — Activity Service (Phase 2 Step 2.7)
 *
 * Generalized write + query layer for the `audit_logs` table. This is
 * a superset of the auth-only helper in modules/auth/audit.ts —
 * everything that module does, this one does, plus:
 *
 *   - recordActivity() with a richer typed input (typed action union,
 *     structured details, resource link)
 *   - listActivity() with cursor pagination, filters, and user join
 *   - listActivityForResource() — convenience wrapper for a
 *     per-entity timeline ("last 20 events on this order")
 *
 * All writes are fire-and-forget: failures are logged to stderr so
 * admin mutations continue uninterrupted. Reads throw on DB errors
 * because the caller (a page handler) needs to know to render an
 * error state.
 *
 * Storage-agnostic? No — unlike platform-config, this module talks to
 * Kysely directly. The audit_logs schema is stable and shared, so
 * there's no win from an abstraction layer here. Tests use a
 * lightweight MockActivityStore interface (below) instead of Kysely.
 *
 * Triết lý: "clone giống hệt Shopify" (per-entity timeline like the
 * Shopify admin order detail page) + "power-ful hơn Shopify nhờ
 * Claude" (one typed action taxonomy shared between god-admin,
 * seller-admin, webhooks, and future AI agents).
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../../../../db/src/schema/tables.js'
import {
  decodeCursor,
  encodeCursor,
  clampPageSize,
  DEFAULT_PAGE_SIZE,
  type PaginatedList,
} from '../ui/pagination.js'
import type {
  ActivityRecord,
  ListActivityOptions,
  RecordActivityInput,
} from './types.js'

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/**
 * Record an activity event. Never throws — failures are logged to
 * stderr and swallowed so the calling mutation proceeds.
 *
 * Returns true on success, false on logged failure. Callers that
 * need the row id can query separately (rare — usually we just
 * fire-and-forget for admin actions).
 */
export async function recordActivity(
  db: Kysely<Database>,
  input: RecordActivityInput,
): Promise<boolean> {
  try {
    await db
      .insertInto('audit_logs')
      .values({
        user_id: input.actorUserId ?? null,
        shop_id: input.shopId ?? null,
        action: input.action,
        resource_type: input.resourceType ?? null,
        resource_id: input.resourceId ?? null,
        details: input.details ? JSON.stringify(input.details) : null,
        ip_address: input.ip ?? null,
      })
      .execute()
    return true
  } catch (err) {
    console.error(
      `[Activity] Failed to record "${input.action}":`,
      err instanceof Error ? err.message : err,
    )
    return false
  }
}

// ---------------------------------------------------------------------------
// Read path — cursor-paginated list
// ---------------------------------------------------------------------------

interface RawActivityRow {
  id: string
  action: string
  user_id: string | null
  user_email: string | null
  shop_id: string | null
  resource_type: string | null
  resource_id: string | null
  details: string | null
  ip_address: string | null
  created_at: string
}

function toRecord(row: RawActivityRow): ActivityRecord {
  let details: Record<string, unknown> | null = null
  if (row.details) {
    try {
      details =
        typeof row.details === 'string'
          ? (JSON.parse(row.details) as Record<string, unknown>)
          : (row.details as Record<string, unknown>)
    } catch {
      details = null
    }
  }
  return {
    id: row.id,
    action: row.action,
    actorUserId: row.user_id,
    actorLabel: row.user_email ?? (row.user_id ? 'deleted user' : 'system'),
    shopId: row.shop_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    details,
    ipAddress: row.ip_address,
    createdAt:
      typeof row.created_at === 'string'
        ? row.created_at
        : new Date(row.created_at).toISOString(),
  }
}

/**
 * Fetch a cursor-paginated list of activity events, newest first by
 * default. The result plugs directly into the shared `paginate()`
 * helper and the `activityTimeline()` renderer.
 *
 * Cursor semantics: `{k: created_at_iso, i: id}`. For forward
 * pagination we fetch rows where `(created_at, id) < cursor` ORDER BY
 * created_at DESC, id DESC (tiebreak on id to guarantee stability).
 * For backward pagination we flip the comparator.
 */
export async function listActivity(
  db: Kysely<Database>,
  opts: ListActivityOptions = {},
): Promise<PaginatedList<ActivityRecord>> {
  const pageSize = clampPageSize(opts.pageSize ?? DEFAULT_PAGE_SIZE)
  const direction = opts.direction ?? 'next'
  const isBackward = direction === 'prev'
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null

  // Build a Kysely query. We select with LEFT JOIN users for the
  // actor email and pick the columns we need for the ActivityRecord
  // shape.
  let q = db
    .selectFrom('audit_logs as al')
    .leftJoin('users as u', 'u.id', 'al.user_id')
    .select([
      'al.id',
      'al.action',
      'al.user_id',
      'u.email as user_email',
      'al.shop_id',
      'al.resource_type',
      'al.resource_id',
      // Cast jsonb → text so it's comparable across drivers.
      sql<string | null>`al.details::text`.as('details'),
      'al.ip_address',
      sql<string>`al.created_at::text`.as('created_at'),
    ])

  // Filter: shop
  if (opts.shopId !== undefined) {
    if (opts.shopId === null) {
      q = q.where('al.shop_id', 'is', null)
    } else {
      q = q.where('al.shop_id', '=', opts.shopId)
    }
  }

  // Filter: actor
  if (opts.actorUserId !== undefined) {
    if (opts.actorUserId === null) {
      q = q.where('al.user_id', 'is', null)
    } else {
      q = q.where('al.user_id', '=', opts.actorUserId)
    }
  }

  // Filter: resource
  if (opts.resourceType) {
    q = q.where('al.resource_type', '=', opts.resourceType)
  }
  if (opts.resourceId) {
    q = q.where('al.resource_id', '=', opts.resourceId)
  }

  // Filter: actions
  if (opts.actions && opts.actions.length > 0) {
    q = q.where('al.action', 'in', opts.actions as readonly string[])
  }

  // Filter: time range — `since`/`until` are ISO timestamp strings,
  // and kysely's `created_at` column is also typed as `string | null`
  // (timestamptz serialized as ISO), so we pass them straight through.
  if (opts.since) {
    q = q.where('al.created_at', '>=', opts.since)
  }
  if (opts.until) {
    q = q.where('al.created_at', '<=', opts.until)
  }

  // Cursor comparator — (created_at, id) < (cursor.k, cursor.i) for
  // forward, or > for backward. We use a SQL tuple comparator so
  // Postgres can use the composite index.
  if (cursor) {
    if (isBackward) {
      q = q.where(
        sql`(al.created_at, al.id)`,
        '>',
        sql`(${cursor.k}::timestamptz, ${cursor.i}::uuid)`,
      )
    } else {
      q = q.where(
        sql`(al.created_at, al.id)`,
        '<',
        sql`(${cursor.k}::timestamptz, ${cursor.i}::uuid)`,
      )
    }
  }

  // Order — newest first for forward, oldest first for backward (so
  // the "extra row" trick for hasNext still works).
  if (isBackward) {
    q = q.orderBy('al.created_at', 'asc').orderBy('al.id', 'asc')
  } else {
    q = q.orderBy('al.created_at', 'desc').orderBy('al.id', 'desc')
  }

  // Fetch pageSize + 1 to detect hasNext.
  q = q.limit(pageSize + 1)

  const rows = (await q.execute()) as unknown as RawActivityRow[]
  const hasExtra = rows.length > pageSize
  let items = hasExtra ? rows.slice(0, pageSize) : rows.slice()

  // Un-reverse backward slice so callers always see newest→oldest.
  if (isBackward) items = items.reverse()

  const records = items.map(toRecord)

  // Compute cursors.
  let nextCursor: string | null = null
  let prevCursor: string | null = null
  if (records.length > 0) {
    const first = records[0]!
    const last = records[records.length - 1]!
    const firstPayload = { k: first.createdAt, i: first.id }
    const lastPayload = { k: last.createdAt, i: last.id }
    if (isBackward) {
      if (hasExtra) prevCursor = encodeCursor(firstPayload)
      nextCursor = encodeCursor(lastPayload)
    } else {
      if (hasExtra) nextCursor = encodeCursor(lastPayload)
      if (cursor) prevCursor = encodeCursor(firstPayload)
    }
  }

  return {
    items: records,
    nextCursor,
    prevCursor,
    hasNext: nextCursor !== null,
    hasPrev: prevCursor !== null,
    pageSize,
    currentCursor: opts.cursor ?? null,
    isBackward,
  }
}

// ---------------------------------------------------------------------------
// Read path — per-entity convenience wrapper
// ---------------------------------------------------------------------------

/**
 * Fetch the last N events for a specific resource (e.g. an order, a
 * product, a customer). Bounded — returns at most `limit` rows, no
 * cursor. Meant for a sidebar "recent activity" panel on an entity
 * detail page, where we just show the latest 10-20 entries.
 */
export async function listActivityForResource(
  db: Kysely<Database>,
  resourceType: string,
  resourceId: string,
  limit = 20,
): Promise<ActivityRecord[]> {
  const clampedLimit = Math.max(1, Math.min(100, Math.floor(limit)))
  const result = await listActivity(db, {
    resourceType,
    resourceId,
    pageSize: clampedLimit,
  })
  return result.items
}
