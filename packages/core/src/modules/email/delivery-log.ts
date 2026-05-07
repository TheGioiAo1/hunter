/**
 * Gbox Platform — Email Delivery Log (Phase 14 PR1)
 *
 * Append-only audit trail for every email send attempt. Every row has
 * status = one of `queued` / `sent` / `bounced` / `failed` / `skipped_*`.
 *
 * LIFECYCLE
 * ---------
 *   1. Caller calls `beginDelivery()` BEFORE the SMTP call. This writes
 *      a row with status='queued' and returns the row id. If the process
 *      crashes between here and the SMTP call the row stays at 'queued'
 *      and a janitor cron (PR2) can surface the zombie for investigation.
 *
 *   2. Caller calls `markSent()` on success — sets status='sent',
 *      smtp_message_id, sent_at. Or `markFailed()` on SMTP error —
 *      sets status='failed', failed_reason (truncated to 500 chars),
 *      failed_at.
 *
 *   3. For `canSend()` denials, caller calls `logSkipped()` which
 *      writes a terminal row directly (status='skipped_pref' /
 *      'skipped_suppressed' / 'skipped_invalid'). No SMTP call happens
 *      — this just records that we refused to send, with the reason.
 *
 * IDEMPOTENCY
 * -----------
 *   Optional `idempotency_key` lets callers dedupe automatic retries
 *   (cron fan-outs, webhook replays). The UNIQUE partial index in
 *   migration 083 lets us INSERT … ON CONFLICT DO NOTHING and detect
 *   the dedupe — we expose that via `beginDeliveryIdempotent()`.
 *
 * SAFETY
 * ------
 *   - failed_reason truncated to 500 chars in code (DB has no limit),
 *     so a verbose gmail SMTP error can't fill a row or leak PII from
 *     a long stack trace.
 *   - body_preview is the first 500 chars of rendered HTML. We don't
 *     store the full body — the registry + variables (future PR) are
 *     sufficient to replay.
 */

import { sql, type Kysely } from 'kysely'
import type {
  Database,
  EmailDeliveryStatus,
  EmailDeliveryProvider,
} from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FAILED_REASON_LEN = 500
const MAX_BODY_PREVIEW_LEN = 500
const MAX_SUBJECT_LEN = 998 // RFC 5322 upper bound

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BeginDeliveryInput {
  templateKey: string
  shopId: string | null
  recipientEmail: string
  recipientCustomerId?: string | null
  recipientUserId?: string | null
  subject: string
  bodyHtml: string
  provider?: EmailDeliveryProvider | null
  idempotencyKey?: string | null
}

export interface SkippedDeliveryInput extends Omit<BeginDeliveryInput, 'provider'> {
  status: Extract<
    EmailDeliveryStatus,
    'skipped_pref' | 'skipped_suppressed' | 'skipped_invalid'
  >
  reason: string
}

export interface DeliveryId {
  id: number
  /** False when an idempotent INSERT hit an existing key (no new row). */
  inserted: boolean
  /**
   * Phase 14 PR8 — Cluster C bug 8. When the idempotent fast-path sees
   * an existing row (`inserted: false`), the caller needs the prior
   * row's terminal state to decide whether to return ok:true (genuinely
   * a dup that already sent) or ok:false (prior attempt failed, was
   * skipped, or left zombie-queued).
   *
   * Populated ONLY when `inserted: false`. On fresh inserts this stays
   * undefined — the caller already has everything it needs.
   */
  prior?: {
    status: EmailDeliveryStatus
    smtp_message_id: string | null
    provider: EmailDeliveryProvider | null
    failed_reason: string | null
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

function preview(html: string): string {
  // Strip tags quickly so the preview is readable, then trim.
  const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return truncate(plain, MAX_BODY_PREVIEW_LEN)
}

// ---------------------------------------------------------------------------
// Begin / mark / skip
// ---------------------------------------------------------------------------

/**
 * INSERT a row at status='queued' and return its id. Caller must
 * follow up with `markSent()` or `markFailed()` once the SMTP result
 * is known.
 */
export async function beginDelivery(
  db: Kysely<Database>,
  input: BeginDeliveryInput,
): Promise<DeliveryId> {
  const row = await db
    .insertInto('email_deliveries')
    .values({
      template_key: input.templateKey,
      shop_id: input.shopId,
      recipient_email: input.recipientEmail.trim(),
      recipient_customer_id: input.recipientCustomerId ?? null,
      recipient_user_id: input.recipientUserId ?? null,
      subject: truncate(input.subject, MAX_SUBJECT_LEN),
      body_preview: preview(input.bodyHtml),
      status: 'queued',
      provider: input.provider ?? null,
      idempotency_key: input.idempotencyKey ?? null,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()
  return { id: Number(row.id), inserted: true }
}

/**
 * Idempotent variant. If `idempotencyKey` matches an existing row,
 * returns that row's id + terminal state without inserting. Otherwise
 * inserts fresh.
 *
 * Phase 14 PR8 — Cluster C bug 8. Previously this only SELECTed `id` on
 * the fast-path, so callers treated any existing row as "already sent
 * successfully". That was a lie for rows left at `queued` (zombie),
 * `failed` (SMTP error), or `skipped_*` (preference / suppression
 * gates). We now return enough state for the caller's
 * `resolveIdempotentPriorRow()` classifier to branch correctly.
 */
const IDEMPOTENT_FASTPATH_COLS = [
  'id',
  'status',
  'smtp_message_id',
  'provider',
  'failed_reason',
] as const
export async function beginDeliveryIdempotent(
  db: Kysely<Database>,
  input: BeginDeliveryInput & { idempotencyKey: string },
): Promise<DeliveryId> {
  // Fast-path check — now widened to include terminal-state columns so
  // the caller can distinguish "already sent" from "already tried and
  // failed / was skipped / left zombie-queued".
  const existing = await db
    .selectFrom('email_deliveries')
    .select([...IDEMPOTENT_FASTPATH_COLS])
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst()
  if (existing) {
    return {
      id: Number(existing.id),
      inserted: false,
      prior: {
        status: existing.status as EmailDeliveryStatus,
        smtp_message_id: existing.smtp_message_id,
        provider: existing.provider as EmailDeliveryProvider | null,
        failed_reason: existing.failed_reason,
      },
    }
  }

  // Race condition: two concurrent callers with the same idem key hit
  // the partial UNIQUE index. We catch the UniqueViolation and re-read.
  try {
    return await beginDelivery(db, input)
  } catch (err) {
    // PostgreSQL duplicate-key error code is 23505.
    const code = (err as { code?: string }).code
    if (code === '23505') {
      const row = await db
        .selectFrom('email_deliveries')
        .select([...IDEMPOTENT_FASTPATH_COLS])
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirstOrThrow()
      return {
        id: Number(row.id),
        inserted: false,
        prior: {
          status: row.status as EmailDeliveryStatus,
          smtp_message_id: row.smtp_message_id,
          provider: row.provider as EmailDeliveryProvider | null,
          failed_reason: row.failed_reason,
        },
      }
    }
    throw err
  }
}

export interface MarkSentInput {
  id: number
  messageId: string | null
  provider: EmailDeliveryProvider
}

/** Flip status='queued' → 'sent', stamp sent_at + smtp_message_id. */
export async function markSent(
  db: Kysely<Database>,
  input: MarkSentInput,
): Promise<void> {
  await db
    .updateTable('email_deliveries')
    .set({
      status: 'sent',
      sent_at: new Date().toISOString(),
      smtp_message_id: input.messageId,
      provider: input.provider,
    })
    .where('id', '=', input.id)
    .execute()
}

export interface MarkFailedInput {
  id: number
  reason: string
  provider: EmailDeliveryProvider
}

/**
 * Mark a queued row as failed. Increments retry_count so the cron
 * retrier knows how many attempts have happened. Caller decides whether
 * to insert a fresh delivery row on retry or update this one.
 */
export async function markFailed(
  db: Kysely<Database>,
  input: MarkFailedInput,
): Promise<void> {
  await db
    .updateTable('email_deliveries')
    .set({
      status: 'failed',
      failed_at: new Date().toISOString(),
      failed_reason: truncate(input.reason ?? '', MAX_FAILED_REASON_LEN),
      provider: input.provider,
      // retry_count is typed as Generated<number> (default 0); bump via raw
      // SQL because Kysely's `.set()` doesn't have a first-class column+1
      // operator and the expression-builder path fights our dual-Kysely
      // nominal type (platform-wide TS quirk). sql.raw is still injection-
      // safe here — zero user input in the fragment.
      retry_count: sql<number>`retry_count + 1`,
    })
    .where('id', '=', input.id)
    .execute()
}

/**
 * Single-statement "we chose not to send" log. Used when canSend()
 * returns allowed=false. Writes a terminal-status row (no queued step).
 */
export async function logSkipped(
  db: Kysely<Database>,
  input: SkippedDeliveryInput,
): Promise<DeliveryId> {
  const row = await db
    .insertInto('email_deliveries')
    .values({
      template_key: input.templateKey,
      shop_id: input.shopId,
      recipient_email: input.recipientEmail.trim(),
      recipient_customer_id: input.recipientCustomerId ?? null,
      recipient_user_id: input.recipientUserId ?? null,
      subject: truncate(input.subject, MAX_SUBJECT_LEN),
      body_preview: preview(input.bodyHtml),
      status: input.status,
      provider: null,
      failed_reason: truncate(input.reason, MAX_FAILED_REASON_LEN),
      // failed_at is fine here — the "we decided at this time" point.
      failed_at: new Date().toISOString(),
      idempotency_key: input.idempotencyKey ?? null,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()
  return { id: Number(row.id), inserted: true }
}

// ---------------------------------------------------------------------------
// Query helpers (for admin UI + cron)
// ---------------------------------------------------------------------------

/**
 * "What did we send to this recipient recently?" — used by the frequency
 * cap cron + suppression check. Returns last N rows sorted newest first.
 */
export async function getRecentDeliveries(
  db: Kysely<Database>,
  opts: { recipientEmail: string; limit?: number },
): Promise<
  Array<{
    id: number
    template_key: string
    status: EmailDeliveryStatus
    created_at: string
  }>
> {
  const limit = opts.limit ?? 20
  const rows = await db
    .selectFrom('email_deliveries')
    .select(['id', 'template_key', 'status', 'created_at'])
    .where((eb) => eb.fn<string>('lower', ['recipient_email']), '=', opts.recipientEmail.trim().toLowerCase())
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute()
  return rows.map((r) => ({
    id: Number(r.id),
    template_key: r.template_key,
    status: r.status as EmailDeliveryStatus,
    created_at: r.created_at,
  }))
}

/**
 * "What happened today on this shop?" — powers the admin deliveries tab.
 * Defaults to last 24h. Order is newest first.
 */
export async function getShopDeliveries(
  db: Kysely<Database>,
  opts: {
    shopId: string
    sinceIso?: string
    limit?: number
    status?: EmailDeliveryStatus
  },
): Promise<
  Array<{
    id: number
    template_key: string
    recipient_email: string
    subject: string
    status: EmailDeliveryStatus
    created_at: string
    sent_at: string | null
    failed_reason: string | null
  }>
> {
  const since = opts.sinceIso ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const limit = opts.limit ?? 100
  let q = db
    .selectFrom('email_deliveries')
    .select([
      'id',
      'template_key',
      'recipient_email',
      'subject',
      'status',
      'created_at',
      'sent_at',
      'failed_reason',
    ])
    .where('shop_id', '=', opts.shopId)
    .where('created_at', '>=', since)
  if (opts.status) q = q.where('status', '=', opts.status)
  const rows = await q.orderBy('created_at', 'desc').limit(limit).execute()
  return rows.map((r) => ({
    id: Number(r.id),
    template_key: r.template_key,
    recipient_email: r.recipient_email,
    subject: r.subject,
    status: r.status as EmailDeliveryStatus,
    created_at: r.created_at,
    sent_at: r.sent_at,
    failed_reason: r.failed_reason,
  }))
}

/**
 * "How are we doing overall?" — god-admin dashboard counter widget.
 * Returns counts by status for a rolling window (default 24h).
 */
export async function getDeliveryStatusCounts(
  db: Kysely<Database>,
  opts?: { sinceIso?: string; shopId?: string | null },
): Promise<Record<EmailDeliveryStatus, number>> {
  const since =
    opts?.sinceIso ??
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  let q = db
    .selectFrom('email_deliveries')
    .select(['status', (eb) => eb.fn.countAll<string>().as('n')])
    .where('created_at', '>=', since)
    .groupBy('status')
  if (opts?.shopId !== undefined) {
    q = opts.shopId === null
      ? q.where('shop_id', 'is', null)
      : q.where('shop_id', '=', opts.shopId)
  }
  const rows = await q.execute()

  const base: Record<EmailDeliveryStatus, number> = {
    queued: 0,
    sent: 0,
    bounced: 0,
    failed: 0,
    skipped_pref: 0,
    skipped_suppressed: 0,
    skipped_invalid: 0,
  }
  for (const r of rows) {
    base[r.status as EmailDeliveryStatus] = Number(r.n) || 0
  }
  return base
}

// ---------------------------------------------------------------------------
// Constants re-exports
// ---------------------------------------------------------------------------
//
// Tests import the truncation constants so they can exercise the
// boundary behaviour without magic numbers.
export const DELIVERY_LOG_LIMITS = {
  MAX_FAILED_REASON_LEN,
  MAX_BODY_PREVIEW_LEN,
  MAX_SUBJECT_LEN,
} as const
