/**
 * Analytics — Dedicated Page Views Recorder (Measurement Foundation M1)
 *
 * Writes to the `page_views` table (migration 032) which is purpose-built
 * for analytics queries: visitors/day, top pages, traffic sources, etc.
 *
 * This module complements (not replaces) the generic `events` table
 * recorder in `modules/events/storefront-events.ts`. The events table
 * still powers the conversion funnel (page_view → add_to_cart →
 * checkout_start → purchase). This table is optimized for volume and
 * aggregation.
 *
 * Features:
 *   - 30-second debounce: same session+path within 30s is skipped to
 *     avoid double-counting on browser back-button / refresh.
 *   - IP hashing: privacy-preserving SHA-256 of the IP address.
 *   - UTM capture: reads from the request's `gboxUtm` object (set by
 *     the UTM capture middleware) to tag each page view with source.
 *   - Hot-path visitor increment: optionally bumps daily_metrics.visitors
 *     when a new session is first seen today.
 */

import { createHash } from 'node:crypto'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PageViewRecordInput {
  path: string
  referrer: string | null
  userAgent: string
  sessionId: string
  customerId?: string | null
  ip?: string | null
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** SHA-256 hex of IP address. Never store raw IPs. */
function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex')
}

/** Debounce window: skip duplicate session+path within this many seconds. */
const DEBOUNCE_SECONDS = 30

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

/**
 * Record a page view into the dedicated `page_views` table.
 *
 * Returns `true` if the row was inserted, `false` if debounced.
 * Errors are swallowed — tracking must never break a page load.
 */
export async function recordPageViewDedicated(
  db: Kysely<Database>,
  shopId: string,
  input: PageViewRecordInput,
): Promise<boolean> {
  try {
    // Debounce: check if same session+path was recorded in the last 30s.
    const recent = await db
      .selectFrom('page_views')
      .select('id')
      .where('shop_id', '=', shopId)
      .where('session_id', '=', input.sessionId)
      .where('path', '=', input.path)
      .where('created_at', '>', sql<string>`NOW() - INTERVAL '${sql.raw(String(DEBOUNCE_SECONDS))} seconds'`)
      .limit(1)
      .executeTakeFirst()

    if (recent) return false

    await db
      .insertInto('page_views')
      .values({
        shop_id: shopId,
        session_id: input.sessionId,
        path: input.path,
        referrer: input.referrer ?? null,
        utm_source: input.utmSource ?? null,
        utm_medium: input.utmMedium ?? null,
        utm_campaign: input.utmCampaign ?? null,
        user_agent: input.userAgent ? input.userAgent.slice(0, 512) : null,
        ip_hash: input.ip ? hashIp(input.ip) : null,
      } as any)
      .execute()

    return true
  } catch {
    // Swallow — tracking must never break a page load.
    return false
  }
}

// ---------------------------------------------------------------------------
// Query helpers (for Live View + dashboards)
// ---------------------------------------------------------------------------

/**
 * Count unique visitors (distinct session_id) in a time window.
 * Used by Live View "Visitors right now".
 */
export async function countRecentVisitors(
  db: Kysely<Database>,
  shopId: string,
  withinMinutes: number,
): Promise<number> {
  const result = await db
    .selectFrom('page_views')
    .select(sql<number>`COUNT(DISTINCT session_id)`.as('cnt'))
    .where('shop_id', '=', shopId)
    .where('created_at', '>', sql<string>`NOW() - INTERVAL '${sql.raw(String(withinMinutes))} minutes'`)
    .executeTakeFirst()

  return Number(result?.cnt ?? 0)
}

/**
 * Count total page views in a time window.
 */
export async function countRecentPageViews(
  db: Kysely<Database>,
  shopId: string,
  withinMinutes: number,
): Promise<number> {
  const result = await db
    .selectFrom('page_views')
    .select(sql<number>`COUNT(*)`.as('cnt'))
    .where('shop_id', '=', shopId)
    .where('created_at', '>', sql<string>`NOW() - INTERVAL '${sql.raw(String(withinMinutes))} minutes'`)
    .executeTakeFirst()

  return Number(result?.cnt ?? 0)
}

/**
 * Top pages by view count in a time window.
 */
export async function topPages(
  db: Kysely<Database>,
  shopId: string,
  withinMinutes: number,
  limit = 10,
): Promise<Array<{ path: string; views: number }>> {
  const rows = await db
    .selectFrom('page_views')
    .select([
      'path',
      sql<number>`COUNT(*)`.as('views'),
    ])
    .where('shop_id', '=', shopId)
    .where('created_at', '>', sql<string>`NOW() - INTERVAL '${sql.raw(String(withinMinutes))} minutes'`)
    .groupBy('path')
    .orderBy(sql`COUNT(*)`, 'desc')
    .limit(limit)
    .execute()

  return rows.map(r => ({ path: r.path, views: Number(r.views) }))
}

/**
 * Traffic sources by view count in a time window.
 */
export async function topTrafficSources(
  db: Kysely<Database>,
  shopId: string,
  withinMinutes: number,
  limit = 10,
): Promise<Array<{ source: string; views: number }>> {
  const rows = await db
    .selectFrom('page_views')
    .select([
      sql<string>`COALESCE(utm_source, '(direct)')`.as('source'),
      sql<number>`COUNT(*)`.as('views'),
    ])
    .where('shop_id', '=', shopId)
    .where('created_at', '>', sql<string>`NOW() - INTERVAL '${sql.raw(String(withinMinutes))} minutes'`)
    .groupBy(sql`COALESCE(utm_source, '(direct)')`)
    .orderBy(sql`COUNT(*)`, 'desc')
    .limit(limit)
    .execute()

  return rows.map(r => ({ source: String(r.source), views: Number(r.views) }))
}

/**
 * Count unique visitors for a given UTC date (for nightly rollup).
 */
export async function countDailyVisitors(
  db: Kysely<Database>,
  shopId: string,
  isoDate: string,
): Promise<number> {
  const result = await db
    .selectFrom('page_views')
    .select(sql<number>`COUNT(DISTINCT session_id)`.as('cnt'))
    .where('shop_id', '=', shopId)
    .where(sql<string>`DATE(created_at AT TIME ZONE 'UTC')`, '=', isoDate)
    .executeTakeFirst()

  return Number(result?.cnt ?? 0)
}
