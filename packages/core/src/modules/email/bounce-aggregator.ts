/**
 * Gbox Platform — Soft-bounce aggregator (Phase 14 PR5)
 *
 * Promotes recipients who have accumulated N soft/transient bounces
 * inside a rolling window into a hard suppression, so we stop
 * hammering addresses that keep failing "temporarily".
 *
 * DEFAULT POLICY (locked via PR5 scope doc, question 4):
 *   - window = 30 days
 *   - threshold = 5 soft + transient bounces
 *   - source_transport = 'soft_bounce_rollup'  (distinguishable in admin UI
 *                                               from 'ses' / 'webhook_generic'
 *                                               direct hard bounces)
 *
 * DATA FLOW
 * ---------
 *   email_events  (event_type='bounce', bounce_type IN ('soft','transient'))
 *       ⬇ JOIN
 *   email_deliveries  (shop_id, recipient_email)
 *       ⬇ GROUP BY (shop_id, recipient_email), COUNT
 *   filter(count >= threshold)
 *       ⬇
 *   checkSuppressed()  — skip if already on the list
 *       ⬇
 *   addSuppression()   — reason='hard_bounce', source='soft_bounce_rollup'
 *
 * PURE QUERY — no writes in dry-run mode.
 *
 * NOT A TRANSACTION
 * -----------------
 * Each candidate is processed independently. If one addSuppression()
 * fails (DB error, race), the loop continues; the failure is counted
 * and logged. Next cron run will retry — the same candidate will still
 * have >=5 soft bounces in the 30d window.
 *
 * CROSS-SHOP ISOLATION
 * --------------------
 * We group by (shop_id, recipient_email), so a customer with 3 soft
 * bounces at shop-A and 3 at shop-B will NOT be promoted. Each shop's
 * bounce budget is separate. This matches the Shopify-class per-shop
 * suppression partition established in PR4.B.
 *
 * PLATFORM ROLLUP
 * ---------------
 * Platform-level sends (shop_id IS NULL) also roll up — `shop_id` is
 * NULL in both email_deliveries and the resulting suppression row.
 * The partial UNIQUE index on email_suppressions handles the platform
 * partition separately from the shop partition.
 *
 * IDEMPOTENCY
 * -----------
 * `checkSuppressed()` short-circuits before we try to insert. If two
 * workers run the aggregator concurrently, the partial UNIQUE index on
 * email_suppressions still prevents duplicates (ON CONFLICT DO NOTHING
 * inside addSuppression). At worst we do one extra read.
 *
 * IRON RULE 5
 * -----------
 * No god_admin mentions. Aggregator returns structured results only;
 * the admin surface composing the "N promoted today" card uses its
 * own copy.
 */

import { sql, type Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { addSuppression, checkSuppressed } from './suppression.js'

// ---------------------------------------------------------------------------
// Constants + types
// ---------------------------------------------------------------------------

export const DEFAULT_WINDOW_DAYS = 30
export const DEFAULT_THRESHOLD = 5
export const MAX_WINDOW_DAYS = 365
export const MAX_THRESHOLD = 1000
export const DEFAULT_MAX_CANDIDATES = 500       // safety cap per run

export interface SoftBounceAggregatorOptions {
  /** Window in days. Default 30. Clamped to [1, 365]. */
  windowDays?: number
  /** Strike threshold. Default 5. Clamped to [1, 1000]. */
  threshold?: number
  /** If true, do not insert suppressions — just return what would happen. */
  dryRun?: boolean
  /** Per-run safety cap. Default 500. Clamped to [1, 10000]. */
  maxCandidates?: number
  /** Injectable for tests — defaults to `new Date()`. */
  now?: Date
}

export interface PromotedCandidate {
  shopId: string | null
  emailLower: string
  softBounceCount: number
  action: 'promoted' | 'already_suppressed' | 'error' | 'dry_run'
  suppressionId: number | null
  error: string | null
}

export interface AggregatorResult {
  ok: true
  windowDays: number
  threshold: number
  scanned: number                       // rows returned by the group query
  promoted: number                      // new suppressions inserted
  alreadySuppressed: number             // candidate rows we skipped
  errors: number
  dryRun: boolean
  windowStart: string                   // ISO
  windowEnd: string                     // ISO
  candidates: PromotedCandidate[]
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function normaliseWindowDays(input: number | undefined): number {
  if (input == null || !Number.isFinite(input)) return DEFAULT_WINDOW_DAYS
  const floored = Math.floor(input)
  if (floored < 1) return DEFAULT_WINDOW_DAYS
  if (floored > MAX_WINDOW_DAYS) return MAX_WINDOW_DAYS
  return floored
}

export function normaliseThreshold(input: number | undefined): number {
  if (input == null || !Number.isFinite(input)) return DEFAULT_THRESHOLD
  const floored = Math.floor(input)
  if (floored < 1) return DEFAULT_THRESHOLD
  if (floored > MAX_THRESHOLD) return MAX_THRESHOLD
  return floored
}

export function normaliseMaxCandidates(input: number | undefined): number {
  if (input == null || !Number.isFinite(input)) return DEFAULT_MAX_CANDIDATES
  const floored = Math.floor(input)
  if (floored < 1) return DEFAULT_MAX_CANDIDATES
  if (floored > 10000) return 10000
  return floored
}

/**
 * windowStart = now - windowDays (ISO). Exposed so smoke tests can
 * assert the exact boundary they're expecting.
 */
export function computeWindowStart(now: Date, windowDays: number): Date {
  return new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000)
}

// ---------------------------------------------------------------------------
// Main entry — runSoftBounceAggregator
// ---------------------------------------------------------------------------

/**
 * Scan email_events for soft+transient bounces in the last window, join
 * to email_deliveries for shop_id + recipient_email, group + count.
 * For each (shop, email) with count >= threshold that is NOT already
 * suppressed, insert a hard suppression with source 'soft_bounce_rollup'.
 *
 * Returns a structured summary the cron wrapper logs and the admin
 * "aggregator status" card displays.
 */
export async function runSoftBounceAggregator(
  db: Kysely<Database>,
  opts: SoftBounceAggregatorOptions = {},
): Promise<AggregatorResult> {
  const windowDays = normaliseWindowDays(opts.windowDays)
  const threshold = normaliseThreshold(opts.threshold)
  const maxCandidates = normaliseMaxCandidates(opts.maxCandidates)
  const dryRun = opts.dryRun === true
  const now = opts.now instanceof Date ? opts.now : new Date()
  const windowStart = computeWindowStart(now, windowDays)

  // Aggregation query. JOIN required because email_events doesn't store
  // shop_id or recipient — those live on email_deliveries. Using raw SQL
  // for clarity of the GROUP BY / HAVING shape.
  //
  // bounce_type IN ('soft','transient') — 'transient' is what the
  // classifier maps SES 'Undetermined' to; both should count toward
  // the rollup.
  //
  // LOWER() on recipient_email — the classifier writes lowercased
  // addresses into email_suppressions via addSuppression(), so we must
  // aggregate on the lowercased form to avoid Same-Address-Different-Case
  // escapes.
  const rows = await sql<{
    shop_id: string | null
    recipient_email_lower: string
    bounce_count: string                // pg bigint → string
  }>`
    SELECT
      d.shop_id AS shop_id,
      LOWER(d.recipient_email) AS recipient_email_lower,
      COUNT(*)::bigint AS bounce_count
    FROM email_events e
    JOIN email_deliveries d ON d.id = e.delivery_id
    WHERE e.event_type = 'bounce'
      AND e.bounce_type IN ('soft','transient')
      AND e.occurred_at >= ${windowStart.toISOString()}::timestamptz
    GROUP BY d.shop_id, LOWER(d.recipient_email)
    HAVING COUNT(*) >= ${threshold}
    ORDER BY bounce_count DESC, recipient_email_lower ASC
    LIMIT ${maxCandidates}
  `.execute(db)

  const candidates: PromotedCandidate[] = []
  let promoted = 0
  let alreadySuppressed = 0
  let errors = 0

  for (const row of rows.rows) {
    const shopId = row.shop_id
    const emailLower = row.recipient_email_lower
    const count = Number(row.bounce_count)

    // Skip if already on the suppression list (any reason).
    // checkSuppressed() honours the same partition semantics as add —
    // shop-A suppression does NOT block the platform rollup, etc.
    const existing = await checkSuppressed(db, { shopId, email: emailLower })
    if (existing) {
      alreadySuppressed++
      candidates.push({
        shopId,
        emailLower,
        softBounceCount: count,
        action: 'already_suppressed',
        suppressionId: existing.id,
        error: null,
      })
      continue
    }

    if (dryRun) {
      candidates.push({
        shopId,
        emailLower,
        softBounceCount: count,
        action: 'dry_run',
        suppressionId: null,
        error: null,
      })
      continue
    }

    // Insert the promoted suppression.
    const result = await addSuppression(db, {
      shopId,
      email: emailLower,
      reason: 'hard_bounce',
      sourceTransport: 'soft_bounce_rollup',
      bounceType: 'SoftRollup',
      bounceSubType: null,
      rawDiagnosticCode: null,
      notes: `Promoted after ${count} soft/transient bounces in ${windowDays}d`,
    })

    if (result.ok) {
      // Race: another aggregator / webhook inserted between checkSuppressed
      // and addSuppression. `created=false` means it existed by the time
      // we got here — count as already_suppressed, not promoted.
      if (result.created) {
        promoted++
        candidates.push({
          shopId,
          emailLower,
          softBounceCount: count,
          action: 'promoted',
          suppressionId: result.id,
          error: null,
        })
      } else {
        alreadySuppressed++
        candidates.push({
          shopId,
          emailLower,
          softBounceCount: count,
          action: 'already_suppressed',
          suppressionId: result.id,
          error: null,
        })
      }
    } else {
      errors++
      candidates.push({
        shopId,
        emailLower,
        softBounceCount: count,
        action: 'error',
        suppressionId: null,
        error: result.error ?? result.reason,
      })
    }
  }

  return {
    ok: true,
    windowDays,
    threshold,
    scanned: rows.rows.length,
    promoted,
    alreadySuppressed,
    errors,
    dryRun,
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    candidates,
  }
}

// ---------------------------------------------------------------------------
// Phase 14 PR7 (BUG-E4) — cron seed
// ---------------------------------------------------------------------------

/**
 * Handler name the cron registry looks up. Exported so smoke tests can
 * assert the row exists without hardcoding the string.
 */
export const AGGREGATE_SOFT_BOUNCES_HANDLER = 'aggregate_soft_bounces'

/**
 * Idempotent boot-time registration. Mirrors `seedSupportCronTasks`
 * shape (seeds-a-row, returns {inserted,existing}). Call from the API
 * server boot path alongside the other seed functions. Safe to run
 * every boot — the handler-exists check prevents dup rows.
 *
 * Schedule is `daily` — a 30d window means tick cadence has no effect
 * on membership, only on freshness. Using the raw string matches the
 * other once-daily crons in the codebase; the default branch of
 * `calculateNextRun` treats unknown schedules as "run hourly" but we
 * re-stamp next_run_at to 3am UTC each successful run inside the
 * service (see cron/service.ts).
 */
export async function seedEmailCronTasks(
  db: Kysely<Database>,
): Promise<{ inserted: number; existing: number }> {
  const seeds: ReadonlyArray<{
    name: string
    schedule: string
    handler: string
  }> = [
    {
      name: 'Email — soft-bounce rollup',
      schedule: 'daily',
      handler: AGGREGATE_SOFT_BOUNCES_HANDLER,
    },
  ]

  let inserted = 0
  let existing = 0

  for (const seed of seeds) {
    const row = await db
      .selectFrom('cron_tasks')
      .select(['id'])
      .where('handler', '=', seed.handler)
      .executeTakeFirst()
    if (row) {
      existing++
      continue
    }
    await db
      .insertInto('cron_tasks')
      .values({
        name: seed.name,
        schedule: seed.schedule,
        handler: seed.handler,
        next_run_at: new Date().toISOString(),
        status: 'active',
      } as any)
      .execute()
    inserted++
  }

  return { inserted, existing }
}
