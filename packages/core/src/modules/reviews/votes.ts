/**
 * Gbox Platform — Review Votes Service (Phase 10 PR3)
 *
 * Helpful / unhelpful voting on `product_reviews`, stored in
 * `review_votes` and denormalised onto `product_reviews.helpful_count`
 * / `unhelpful_count` so the admin list + storefront render cheaply.
 *
 * Ballot-stuffing protection:
 *   - We never store the raw IP. The caller hashes (ip + UA + shop_salt)
 *     with SHA-256 via `hashVoterFingerprint` and hands us the hex digest.
 *   - UNIQUE (review_id, ip_hash) lets us run an ON CONFLICT-shaped
 *     upsert: the same fingerprint can FLIP their vote but can't stack
 *     two +1s. Flipping decrements the old counter and increments the new
 *     one inside the same txn.
 *
 * Scope:
 *
 *   - `hashVoterFingerprint(ip, ua, shopSalt)`                → hex
 *   - `submitReviewVote(db, reviewId, shopId, input)`         → result
 *   - `getReviewVotes(db, reviewId)`                          → {helpful, unhelpful}
 *   - `removeReviewVote(db, reviewId, ipHash)`                → void
 */

import { createHash } from 'node:crypto'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

export type VoteValue = 1 | -1

export interface SubmitReviewVoteInput {
  customerId?: string | null
  ipHash: string
  value: VoteValue
}

export interface SubmitReviewVoteResult {
  /** null if the voter hadn't voted before. */
  previousValue: VoteValue | null
  newValue: VoteValue
  /** true if this call actually wrote to the database. */
  changed: boolean
}

/**
 * Derive a stable, privacy-safe fingerprint for a voter. `shopSalt`
 * comes from the shop's settings row and makes cross-shop correlation
 * impossible even if two shops share an IP. User-agent is optional —
 * some CLI-style callers won't have one. The output is always a 64-char
 * lowercase hex string so it fits `ip_hash varchar(64)`.
 */
export function hashVoterFingerprint(
  ip: string,
  userAgent: string | null | undefined,
  shopSalt: string,
): string {
  const h = createHash('sha256')
  h.update(String(ip ?? ''))
  h.update('|')
  h.update(String(userAgent ?? ''))
  h.update('|')
  h.update(String(shopSalt ?? ''))
  return h.digest('hex')
}

/**
 * Submit a helpful/unhelpful vote. If the same fingerprint already
 * voted, flipping the value is allowed; re-submitting the same value
 * is a no-op. Counters on `product_reviews` are kept in sync inside
 * the same transaction.
 */
export async function submitReviewVote(
  db: Kysely<Database>,
  reviewId: string,
  shopId: string,
  input: SubmitReviewVoteInput,
): Promise<SubmitReviewVoteResult> {
  if (input.value !== 1 && input.value !== -1) {
    throw new Error(`Invalid vote value: ${String(input.value)} (expected 1 or -1)`)
  }
  return db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('review_votes')
      .select(['id', 'value'])
      .where('review_id', '=', reviewId)
      .where('ip_hash', '=', input.ipHash)
      .executeTakeFirst()

    if (!existing) {
      // Fresh vote — INSERT + bump the relevant counter.
      await trx
        .insertInto('review_votes')
        .values({
          review_id: reviewId,
          shop_id: shopId,
          customer_id: input.customerId ?? null,
          ip_hash: input.ipHash,
          value: input.value,
        } as any)
        .execute()

      await trx
        .updateTable('product_reviews')
        .set({
          helpful_count:
            input.value === 1 ? sql`helpful_count + 1` : sql`helpful_count`,
          unhelpful_count:
            input.value === -1 ? sql`unhelpful_count + 1` : sql`unhelpful_count`,
          updated_at: new Date().toISOString(),
        } as any)
        .where('id', '=', reviewId)
        .execute()

      return { previousValue: null, newValue: input.value, changed: true }
    }

    const prev = existing.value as VoteValue
    if (prev === input.value) {
      return { previousValue: prev, newValue: input.value, changed: false }
    }

    // Flip: decrement old counter, increment new counter, rewrite the row.
    await trx
      .updateTable('review_votes')
      .set({
        value: input.value,
        customer_id: input.customerId ?? null,
        updated_at: new Date().toISOString(),
      } as any)
      .where('id', '=', existing.id)
      .execute()

    await trx
      .updateTable('product_reviews')
      .set({
        helpful_count:
          input.value === 1
            ? sql`helpful_count + 1`
            : sql`GREATEST(helpful_count - 1, 0)`,
        unhelpful_count:
          input.value === -1
            ? sql`unhelpful_count + 1`
            : sql`GREATEST(unhelpful_count - 1, 0)`,
        updated_at: new Date().toISOString(),
      } as any)
      .where('id', '=', reviewId)
      .execute()

    return { previousValue: prev, newValue: input.value, changed: true }
  })
}

/** Return the current helpful/unhelpful counts for a review. */
export async function getReviewVotes(
  db: Kysely<Database>,
  reviewId: string,
): Promise<{ helpful: number; unhelpful: number }> {
  const row = await db
    .selectFrom('product_reviews')
    .select(['helpful_count', 'unhelpful_count'])
    .where('id', '=', reviewId)
    .executeTakeFirst()
  if (!row) return { helpful: 0, unhelpful: 0 }
  return {
    helpful: Number(row.helpful_count ?? 0),
    unhelpful: Number(row.unhelpful_count ?? 0),
  }
}

/**
 * Withdraw a vote for a given fingerprint. Useful from the storefront
 * "undo" affordance. No-op if the voter hadn't voted.
 */
export async function removeReviewVote(
  db: Kysely<Database>,
  reviewId: string,
  ipHash: string,
): Promise<{ removed: boolean }> {
  return db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('review_votes')
      .select(['id', 'value'])
      .where('review_id', '=', reviewId)
      .where('ip_hash', '=', ipHash)
      .executeTakeFirst()
    if (!existing) return { removed: false }

    await trx
      .deleteFrom('review_votes')
      .where('id', '=', existing.id)
      .execute()

    await trx
      .updateTable('product_reviews')
      .set({
        helpful_count:
          existing.value === 1
            ? sql`GREATEST(helpful_count - 1, 0)`
            : sql`helpful_count`,
        unhelpful_count:
          existing.value === -1
            ? sql`GREATEST(unhelpful_count - 1, 0)`
            : sql`unhelpful_count`,
        updated_at: new Date().toISOString(),
      } as any)
      .where('id', '=', reviewId)
      .execute()

    return { removed: true }
  })
}
