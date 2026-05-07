/**
 * Event-ID idempotency: a client fires a pixel with event_id X and
 * simultaneously POSTs /api/track with the same event_id. Meta /
 * TikTok / GA4 each do their own dedup on event_id within a 7-day
 * window. Our server-side `claimEventId` is the guard so we don't
 * DOUBLE-dispatch from our own infra (e.g. retries, back-button
 * replays).
 *
 * Retention: a separate cron (out of scope for migration 034) is
 * expected to vacuum rows older than 7 days.
 */

import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { CanonicalEvent } from './types.ts'

/** UUIDv4. Use this when the storefront needs an event_id upfront. */
export function newEventId(): string {
  return randomUUID()
}

export interface ClaimResult {
  /** true = first sighting, dispatch. false = duplicate, skip. */
  fresh: boolean
}

/**
 * Atomically record an event_id. INSERT ... ON CONFLICT DO NOTHING
 * gives us a cheap one-round-trip claim: if nobody else inserted the
 * same event_id first, we get fresh=true.
 */
export async function claimEventId(
  db: Kysely<Database>,
  params: {
    eventId: string
    shopId: string
    eventName: CanonicalEvent
  },
): Promise<ClaimResult> {
  const res = await db
    .insertInto('tracking_event_dedupe')
    .values({
      event_id: params.eventId,
      shop_id: params.shopId,
      event_name: params.eventName,
    })
    .onConflict((oc) => oc.column('event_id').doNothing())
    .executeTakeFirst()

  return { fresh: (res.numInsertedOrUpdatedRows ?? 0n) > 0n }
}
