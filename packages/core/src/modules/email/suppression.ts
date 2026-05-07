/**
 * Gbox Platform — Email suppression list (Phase 14 PR4.B)
 *
 * Do-not-send list consulted by send.ts before every outbound email.
 * Populated by:
 *   - Bounce/complaint webhooks (webhook-handler.ts)
 *   - Admin manual add (/settings/email-suppressions page)
 *   - Future PR5 soft-bounce aggregator
 *
 * SHAPE
 * -----
 * Two partitions:
 *   - shop-scoped:     shop_id = '<uuid>'  → blocks sends from that shop only
 *   - platform-scoped: shop_id = NULL      → blocks platform-admin / pre-onboard sends
 *
 * Per partition, at most ONE active suppression per email exists
 * (enforced by two partial UNIQUE indexes on
 * (shop_id, email_address_hash) / (email_address_hash)
 * WHERE unsuppressed_at IS NULL).
 *
 * Cross-scope behaviour: a shop-A suppression does NOT block shop-B
 * sends, and a platform suppression does NOT block shop sends. This
 * matches Shopify's per-shop isolation model.
 *
 * SOFT DELETE
 * -----------
 * `unsuppress()` does NOT delete the row — it sets unsuppressed_at +
 * unsuppressed_by. The admin UI's "history" tab can show every past
 * suppression with who lifted it. Re-suppression inserts a new row
 * (the partial UNIQUE leaves fully-unsuppressed rows out of the index).
 *
 * HASHING
 * -------
 * `email_address_hash` = SHA-256 of the lowercased email, 64 hex chars.
 * Stored separately from `email_address_lower` (plain text) so:
 *   - Lookups at send time use the hash (constant-time compare).
 *   - Admin display uses the plain text.
 *   - GDPR "erase my data" could null out email_address_lower while
 *     preserving the hash for suppression to keep working (PR5).
 *
 * IRON RULE 5
 * -----------
 * Functions return structured data — no user-facing strings. The
 * /settings/email-suppressions page composes its own copy and routes
 * errors through `safeMessage()`.
 */

import crypto from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SuppressionReason = 'hard_bounce' | 'complaint' | 'manual'

export type SuppressionSource =
  | 'ses'
  | 'gmail_smtp'
  | 'smtp_gbox'
  | 'resend'
  | 'manual'
  | 'webhook_generic'
  | 'console'
  | 'other'
  | 'soft_bounce_rollup'                 // PR5 — promoted from N soft bounces / 30d

export interface SuppressionHit {
  id: number
  shopId: string | null
  emailAddressLower: string
  reason: SuppressionReason
  bounceType: string | null
  bounceSubType: string | null
  sourceTransport: SuppressionSource
  sourceDeliveryId: number | null
  sourceEventId: number | null
  rawDiagnosticCode: string | null
  suppressedAt: string | Date
  notes: string | null
}

export interface AddSuppressionInput {
  shopId: string | null
  email: string                       // raw, will be lowercased + hashed
  reason: SuppressionReason
  sourceTransport: SuppressionSource
  bounceType?: string | null
  bounceSubType?: string | null
  sourceDeliveryId?: number | null
  sourceEventId?: number | null
  rawDiagnosticCode?: string | null
  notes?: string | null
}

export type AddSuppressionResult =
  | { ok: true; id: number; created: boolean }   // created=false if ON CONFLICT DO NOTHING hit
  | { ok: false; reason: 'db_error'; error: string }

export interface ListSuppressionsInput {
  shopId: string | null                // required — platform list uses null explicitly
  limit?: number                       // default 50
  offset?: number                      // default 0
  includeUnsuppressed?: boolean        // default false — active-only
  reason?: SuppressionReason           // optional filter
}

export interface SuppressionRow {
  id: number
  shopId: string | null
  emailAddressLower: string
  reason: SuppressionReason
  bounceType: string | null
  bounceSubType: string | null
  sourceTransport: SuppressionSource
  rawDiagnosticCode: string | null
  suppressedAt: string | Date
  unsuppressedAt: string | Date | null
  unsuppressedBy: string | null
  notes: string | null
}

export interface UnsuppressInput {
  suppressionId: number
  unsuppressedBy: string | null        // user id (NULL = system/automatic)
  notes?: string | null
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_NOTES_LEN = 1000
const MAX_DIAGNOSTIC_LEN = 1000
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function hashEmail(email: string): string {
  return crypto.createHash('sha256').update(email.toLowerCase()).digest('hex')
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (value == null) return null
  if (value.length <= max) return value
  return value.slice(0, max)
}

function normaliseLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(limit), MAX_LIMIT)
}

function normaliseOffset(offset: number | undefined): number {
  if (offset == null || !Number.isFinite(offset) || offset < 0) return 0
  return Math.floor(offset)
}

// ---------------------------------------------------------------------------
// checkSuppressed — read path (hot, called before every send)
// ---------------------------------------------------------------------------

/**
 * Returns the active suppression row if one exists for (shopId, email),
 * else null. Respects the two partial UNIQUE indexes:
 *   - shop-scoped:     WHERE shop_id = $1 AND email_address_hash = $2
 *                          AND unsuppressed_at IS NULL
 *   - platform-scoped: WHERE shop_id IS NULL AND email_address_hash = $1
 *                          AND unsuppressed_at IS NULL
 *
 * Does NOT check cross-scope (shop-A suppression does NOT block shop-B).
 */
export async function checkSuppressed(
  db: Kysely<Database>,
  params: { shopId: string | null; email: string },
): Promise<SuppressionHit | null> {
  const hash = hashEmail(params.email)

  let query = db
    .selectFrom('email_suppressions')
    .select([
      'id',
      'shop_id',
      'email_address_lower',
      'reason',
      'bounce_type',
      'bounce_subtype',
      'source_transport',
      'source_delivery_id',
      'source_event_id',
      'raw_diagnostic_code',
      'suppressed_at',
      'notes',
    ])
    .where('email_address_hash', '=', hash)
    .where('unsuppressed_at', 'is', null)
    .limit(1)

  if (params.shopId === null) {
    query = query.where('shop_id', 'is', null)
  } else {
    query = query.where('shop_id', '=', params.shopId)
  }

  const row = await query.executeTakeFirst()
  if (!row) return null

  return {
    id: Number(row.id),
    shopId: row.shop_id,
    emailAddressLower: row.email_address_lower,
    reason: row.reason as SuppressionReason,
    bounceType: row.bounce_type,
    bounceSubType: row.bounce_subtype,
    sourceTransport: row.source_transport as SuppressionSource,
    sourceDeliveryId: row.source_delivery_id == null ? null : Number(row.source_delivery_id),
    sourceEventId: row.source_event_id == null ? null : Number(row.source_event_id),
    rawDiagnosticCode: row.raw_diagnostic_code,
    suppressedAt: row.suppressed_at,
    notes: row.notes,
  }
}

// ---------------------------------------------------------------------------
// addSuppression — write path (webhook + admin + cron)
// ---------------------------------------------------------------------------

/**
 * Inserts (or no-ops if already suppressed). Uses ON CONFLICT DO NOTHING
 * against the two partial UNIQUE indexes so a duplicate write returns
 * `created: false` without raising.
 *
 * NOTE: ON CONFLICT DO NOTHING against a partial UNIQUE INDEX requires
 * the target to match exactly (Postgres 14+). We drive it via raw SQL
 * to name the index directly — Kysely's builder would emit a
 * column-list ON CONFLICT which Postgres rejects for partial indexes.
 */
export async function addSuppression(
  db: Kysely<Database>,
  input: AddSuppressionInput,
): Promise<AddSuppressionResult> {
  const emailLower = input.email.toLowerCase()
  const hash = hashEmail(input.email)
  const notes = truncate(input.notes ?? null, MAX_NOTES_LEN)
  const diag = truncate(input.rawDiagnosticCode ?? null, MAX_DIAGNOSTIC_LEN)

  const conflictTarget = input.shopId === null
    ? sql`ON CONFLICT (email_address_hash) WHERE unsuppressed_at IS NULL AND shop_id IS NULL DO NOTHING`
    : sql`ON CONFLICT (shop_id, email_address_hash) WHERE unsuppressed_at IS NULL AND shop_id IS NOT NULL DO NOTHING`

  try {
    const result = await sql<{ id: number }>`
      INSERT INTO email_suppressions (
        shop_id,
        email_address_hash,
        email_address_lower,
        reason,
        bounce_type,
        bounce_subtype,
        source_transport,
        source_event_id,
        source_delivery_id,
        raw_diagnostic_code,
        notes
      )
      VALUES (
        ${input.shopId},
        ${hash},
        ${emailLower},
        ${input.reason},
        ${input.bounceType ?? null},
        ${input.bounceSubType ?? null},
        ${input.sourceTransport},
        ${input.sourceEventId ?? null},
        ${input.sourceDeliveryId ?? null},
        ${diag},
        ${notes}
      )
      ${conflictTarget}
      RETURNING id
    `.execute(db)

    const rows = result.rows as { id: number }[]
    if (rows.length === 0) {
      // Conflict hit — already suppressed. Look up the existing row to return its id.
      const existing = await checkSuppressed(db, { shopId: input.shopId, email: input.email })
      if (existing) {
        return { ok: true, id: existing.id, created: false }
      }
      // Race: row got unsuppressed between conflict and re-read.
      // Very rare — report as db_error so the caller can retry.
      return { ok: false, reason: 'db_error', error: 'conflict_but_not_found' }
    }
    return { ok: true, id: Number(rows[0].id), created: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: 'db_error', error: msg }
  }
}

// ---------------------------------------------------------------------------
// listSuppressions + countActiveSuppressions — admin page backers
// ---------------------------------------------------------------------------

export async function listSuppressions(
  db: Kysely<Database>,
  input: ListSuppressionsInput,
): Promise<SuppressionRow[]> {
  const limit = normaliseLimit(input.limit)
  const offset = normaliseOffset(input.offset)

  let query = db
    .selectFrom('email_suppressions')
    .select([
      'id',
      'shop_id',
      'email_address_lower',
      'reason',
      'bounce_type',
      'bounce_subtype',
      'source_transport',
      'raw_diagnostic_code',
      'suppressed_at',
      'unsuppressed_at',
      'unsuppressed_by',
      'notes',
    ])
    .orderBy('suppressed_at', 'desc')
    .limit(limit)
    .offset(offset)

  if (input.shopId === null) {
    query = query.where('shop_id', 'is', null)
  } else {
    query = query.where('shop_id', '=', input.shopId)
  }

  if (input.includeUnsuppressed !== true) {
    query = query.where('unsuppressed_at', 'is', null)
  }

  if (input.reason) {
    query = query.where('reason', '=', input.reason)
  }

  const rows = await query.execute()
  return rows.map((row) => ({
    id: Number(row.id),
    shopId: row.shop_id,
    emailAddressLower: row.email_address_lower,
    reason: row.reason as SuppressionReason,
    bounceType: row.bounce_type,
    bounceSubType: row.bounce_subtype,
    sourceTransport: row.source_transport as SuppressionSource,
    rawDiagnosticCode: row.raw_diagnostic_code,
    suppressedAt: row.suppressed_at,
    unsuppressedAt: row.unsuppressed_at,
    unsuppressedBy: row.unsuppressed_by,
    notes: row.notes,
  }))
}

export async function countActiveSuppressions(
  db: Kysely<Database>,
  params: { shopId: string | null; reason?: SuppressionReason },
): Promise<number> {
  let query = db
    .selectFrom('email_suppressions')
    .select((eb) => eb.fn.count<number>('id').as('n'))
    .where('unsuppressed_at', 'is', null)

  if (params.shopId === null) {
    query = query.where('shop_id', 'is', null)
  } else {
    query = query.where('shop_id', '=', params.shopId)
  }

  if (params.reason) {
    query = query.where('reason', '=', params.reason)
  }

  const row = await query.executeTakeFirst()
  return Number(row?.n ?? 0)
}

/**
 * Count suppressions created in the last N days. Used by the
 * admin page's stats cards.
 */
export async function countRecentByReason(
  db: Kysely<Database>,
  params: { shopId: string | null; reason: SuppressionReason; sinceDays: number },
): Promise<number> {
  const since = new Date(Date.now() - params.sinceDays * 24 * 60 * 60 * 1000)
  let query = db
    .selectFrom('email_suppressions')
    .select((eb) => eb.fn.count<number>('id').as('n'))
    .where('reason', '=', params.reason)
    .where('suppressed_at', '>=', since.toISOString())

  if (params.shopId === null) {
    query = query.where('shop_id', 'is', null)
  } else {
    query = query.where('shop_id', '=', params.shopId)
  }

  const row = await query.executeTakeFirst()
  return Number(row?.n ?? 0)
}

// ---------------------------------------------------------------------------
// unsuppress — admin soft-delete
// ---------------------------------------------------------------------------

/**
 * Soft-delete the suppression: set unsuppressed_at + unsuppressed_by.
 * The row stays for audit. New sends to the same address will succeed.
 *
 * If the row is already unsuppressed, returns { ok: true, changed: false }.
 */
export async function unsuppress(
  db: Kysely<Database>,
  input: UnsuppressInput,
): Promise<{ ok: true; changed: boolean } | { ok: false; reason: 'not_found' | 'db_error'; error?: string }> {
  try {
    const result = await db
      .updateTable('email_suppressions')
      .set({
        unsuppressed_at: new Date().toISOString(),
        unsuppressed_by: input.unsuppressedBy,
        notes: input.notes ? truncate(input.notes, MAX_NOTES_LEN) : undefined,
      })
      .where('id', '=', input.suppressionId)
      .where('unsuppressed_at', 'is', null)
      .executeTakeFirst()

    const changed = Number(result.numUpdatedRows ?? 0) > 0
    if (!changed) {
      // Row either doesn't exist or was already unsuppressed.
      const existing = await db
        .selectFrom('email_suppressions')
        .select(['id'])
        .where('id', '=', input.suppressionId)
        .executeTakeFirst()
      if (!existing) {
        return { ok: false, reason: 'not_found' }
      }
      // Exists but already unsuppressed → no-op success
      return { ok: true, changed: false }
    }
    return { ok: true, changed: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: 'db_error', error: msg }
  }
}

// ---------------------------------------------------------------------------
// getSuppressionById — admin detail page
// ---------------------------------------------------------------------------

export async function getSuppressionById(
  db: Kysely<Database>,
  params: { suppressionId: number; shopId: string | null },
): Promise<SuppressionRow | null> {
  let query = db
    .selectFrom('email_suppressions')
    .select([
      'id',
      'shop_id',
      'email_address_lower',
      'reason',
      'bounce_type',
      'bounce_subtype',
      'source_transport',
      'raw_diagnostic_code',
      'suppressed_at',
      'unsuppressed_at',
      'unsuppressed_by',
      'notes',
    ])
    .where('id', '=', params.suppressionId)

  // Shop scoping — enforce here so the admin page can't accidentally
  // peek at another shop's suppression by id manipulation.
  if (params.shopId === null) {
    query = query.where('shop_id', 'is', null)
  } else {
    query = query.where('shop_id', '=', params.shopId)
  }

  const row = await query.executeTakeFirst()
  if (!row) return null

  return {
    id: Number(row.id),
    shopId: row.shop_id,
    emailAddressLower: row.email_address_lower,
    reason: row.reason as SuppressionReason,
    bounceType: row.bounce_type,
    bounceSubType: row.bounce_subtype,
    sourceTransport: row.source_transport as SuppressionSource,
    rawDiagnosticCode: row.raw_diagnostic_code,
    suppressedAt: row.suppressed_at,
    unsuppressedAt: row.unsuppressed_at,
    unsuppressedBy: row.unsuppressed_by,
    notes: row.notes,
  }
}
