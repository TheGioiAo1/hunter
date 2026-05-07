/**
 * Rolling-window rate limit for support endpoints.
 *
 * MVP design (deliberate constraint per spec §6.9):
 *
 *   - Persistent store: `support_rate_limits` table (migration 077).
 *     Using Postgres instead of Redis avoids adding a new runtime
 *     dependency for Phase 12.5. 5K-10K sellers generate at most ~10
 *     ticket creates per minute peak across the whole platform — well
 *     within Postgres comfort range.
 *
 *   - Fixed windows, not sliding: window_start is floored to the
 *     bucket boundary; the limit is checked + incremented with an
 *     UPSERT. This allows up to 2× limit at window boundaries in
 *     worst case, which is fine — we're not trying to prevent precise
 *     DoS, just to stop a bad actor from opening 10K tickets.
 *
 *   - TTL = 2 × window: rows are cleaned up by the retention cron
 *     (PR5 `support-retention-cleanup.ts`).
 *
 * Limits from spec §4.3:
 *   - `shop:support:create_ticket` → 10/hour
 *   - `user:support:post_message`  → 60/hour
 *   - `user:support:csat_submit`   → 1/ticket (enforced via UNIQUE at
 *     the column level; this module not involved)
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { SupportError } from './types.ts'

export interface RateLimitSpec {
  /** Identifier like 'shop:support:create_ticket'. Opaque to the caller. */
  endpoint: string
  /** 'shop' | 'user' | 'ip'. Must match a value in the CHECK constraint. */
  scopeType: 'shop' | 'user' | 'ip'
  /** Window size in milliseconds. */
  windowMs: number
  /** Max hits allowed in the window. */
  maxHits: number
}

export const SUPPORT_RATE_LIMITS = {
  CREATE_TICKET: {
    endpoint: 'support:create_ticket',
    scopeType: 'shop',
    windowMs: 60 * 60 * 1000,
    maxHits: 10,
  } satisfies RateLimitSpec,
  POST_MESSAGE: {
    endpoint: 'support:post_message',
    scopeType: 'user',
    windowMs: 60 * 60 * 1000,
    maxHits: 60,
  } satisfies RateLimitSpec,
} as const

/**
 * Check-and-increment. Throws `SupportError('RATE_LIMIT_EXCEEDED')`
 * when the bucket is full. The throw happens BEFORE the increment on
 * the overflow row, so a caller that catches + retries won't walk the
 * counter further up.
 */
export async function checkRateLimit(
  db: Kysely<Database>,
  spec: RateLimitSpec,
  scopeId: string,
  now: Date = new Date(),
): Promise<{ hitCount: number; windowStart: Date; resetsAt: Date }> {
  const windowStart = new Date(
    Math.floor(now.getTime() / spec.windowMs) * spec.windowMs,
  )
  const ttlAt = new Date(windowStart.getTime() + spec.windowMs * 2)
  const resetsAt = new Date(windowStart.getTime() + spec.windowMs)

  // Read current count.
  const existing = await db
    .selectFrom('support_rate_limits')
    .selectAll()
    .where('scope_type', '=', spec.scopeType)
    .where('scope_id', '=', scopeId)
    .where('endpoint', '=', spec.endpoint)
    .where('window_start', '=', windowStart.toISOString())
    .executeTakeFirst()

  const currentCount = existing?.hit_count ?? 0
  if (currentCount >= spec.maxHits) {
    throw new SupportError(
      `Rate limit exceeded for ${spec.endpoint}: ${currentCount}/${spec.maxHits} in window`,
      'RATE_LIMIT_EXCEEDED',
    )
  }

  // Upsert + increment.
  await db
    .insertInto('support_rate_limits')
    .values({
      scope_type: spec.scopeType,
      scope_id: scopeId,
      endpoint: spec.endpoint,
      window_start: windowStart.toISOString(),
      hit_count: 1,
      ttl_at: ttlAt.toISOString(),
    })
    .onConflict((oc) =>
      oc
        .columns(['scope_type', 'scope_id', 'endpoint', 'window_start'])
        .doUpdateSet((eb) => ({
          hit_count: eb('support_rate_limits.hit_count', '+', 1),
          ttl_at: ttlAt.toISOString(),
        })),
    )
    .execute()

  return { hitCount: currentCount + 1, windowStart, resetsAt }
}

/**
 * Non-DB helper used by pure unit tests to exercise the window math
 * without needing a live Postgres. Returns what `windowStart` +
 * `resetsAt` would be for the given inputs. Production code never
 * calls this directly — but the algebra it encodes is the same the
 * DB path relies on, so tests pin the contract.
 */
export function computeWindow(
  spec: Pick<RateLimitSpec, 'windowMs'>,
  now: Date,
): { windowStart: Date; resetsAt: Date } {
  const windowStart = new Date(
    Math.floor(now.getTime() / spec.windowMs) * spec.windowMs,
  )
  const resetsAt = new Date(windowStart.getTime() + spec.windowMs)
  return { windowStart, resetsAt }
}
