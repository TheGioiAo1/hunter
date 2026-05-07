/**
 * Gbox Platform — Error Tracking Service
 *
 * Built-in error tracking without external dependencies.
 * Stores errors in the audit_logs table with action='error'.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ErrorContext {
  shopId?: string | null
  userId?: string | null
  requestUrl?: string | null
  userAgent?: string | null
}

export interface ErrorLog {
  id: string
  shop_id: string | null
  user_id: string | null
  action: string
  resource_type: string | null
  resource_id: string | null
  details: {
    error_name: string
    error_message: string
    stack?: string
    request_url?: string
    user_agent?: string
  }
  ip_address: string | null
  created_at: string
}

export interface ErrorStats {
  total: number
  byType: Record<string, number>
}

export type ErrorPeriod = '1h' | '24h' | '7d'

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Capture an error and store it in the audit_logs table.
 */
export async function captureError(
  db: Kysely<Database>,
  error: Error,
  context: ErrorContext = {},
): Promise<void> {
  const details: Record<string, unknown> = {
    error_name: error.name,
    error_message: error.message,
    stack: error.stack ?? null,
  }

  if (context.requestUrl) {
    details.request_url = context.requestUrl
  }
  if (context.userAgent) {
    details.user_agent = context.userAgent
  }

  await db
    .insertInto('audit_logs')
    .values({
      shop_id: context.shopId ?? null,
      user_id: context.userId ?? null,
      action: 'error',
      resource_type: error.name,
      resource_id: null,
      details: JSON.stringify(details),
      ip_address: null,
    })
    .execute()
}

/**
 * Get recent error logs, optionally filtered by shop.
 */
export async function getRecentErrors(
  db: Kysely<Database>,
  shopId?: string | null,
  limit: number = 50,
): Promise<ErrorLog[]> {
  let query = db
    .selectFrom('audit_logs')
    .selectAll()
    .where('action', '=', 'error')
    .orderBy('created_at', 'desc')
    .limit(limit)

  if (shopId) {
    query = query.where('shop_id', '=', shopId)
  }

  const rows = await query.execute()
  return rows as unknown as ErrorLog[]
}

/**
 * Get error statistics for a given time period.
 * Returns total count and breakdown by error type (resource_type).
 */
export async function getErrorStats(
  db: Kysely<Database>,
  period: ErrorPeriod,
): Promise<ErrorStats> {
  const periodMs = {
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
  }

  const since = new Date(Date.now() - periodMs[period]).toISOString()

  // Get total count
  const totalResult = await db
    .selectFrom('audit_logs')
    .select(db.fn.countAll<number>().as('count'))
    .where('action', '=', 'error')
    .where('created_at', '>=', since)
    .executeTakeFirstOrThrow()

  // Get breakdown by error type
  const typeBreakdown = await db
    .selectFrom('audit_logs')
    .select([
      'resource_type',
      db.fn.countAll<number>().as('count'),
    ])
    .where('action', '=', 'error')
    .where('created_at', '>=', since)
    .groupBy('resource_type')
    .execute()

  const byType: Record<string, number> = {}
  for (const row of typeBreakdown) {
    const key = row.resource_type ?? 'unknown'
    byType[key] = Number(row.count)
  }

  return {
    total: Number(totalResult.count),
    byType,
  }
}

/**
 * Clear old error logs older than N days.
 * Returns the number of deleted records.
 */
export async function clearOldErrors(
  db: Kysely<Database>,
  olderThanDays: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString()

  const result = await db
    .deleteFrom('audit_logs')
    .where('action', '=', 'error')
    .where('created_at', '<', cutoff)
    .executeTakeFirst()

  return Number((result as any)?.numDeletedRows ?? 0)
}
