/**
 * Gbox Platform — Customer privacy requests (Phase 14 PR5)
 *
 * State machine + helpers for `customer_privacy_requests`. Three
 * request types — `export`, `deletion`, `rectification` — share one
 * table + a seven-state status machine:
 *
 *    pending  (row inserted, worker hasn't picked it up)
 *       │
 *       ▼
 *    processing  (worker ACK'd; export: zipping; deletion: no-op here)
 *       │
 *       ├─ export ────► ready  (ZIP uploaded, download token minted)
 *       │                 │
 *       │                 ▼
 *       │              consumed  (customer clicked download link)
 *       │
 *       ├─ deletion ──► (wait for scheduled_deletion_at)
 *       │                 │
 *       │                 ▼
 *       │              completed  (finalizer cron ran; PII nulled)
 *       │
 *       └─ any ───────► cancelled | failed
 *
 * TOKENS
 * ------
 * Export download link + deletion cancel link both use single-use
 * tokens:
 *   - raw token = 48 hex chars (crypto.randomBytes(24))
 *   - stored column = sha256(raw) in 64 hex chars
 *   - constant-time compare via `crypto.timingSafeEqual` on the hash
 *
 * The raw token is returned ONCE by `requestDataExport` /
 * `requestAccountDeletion` and emailed to the customer. It's never
 * retrievable from the DB after that.
 *
 * CONCURRENCY
 * -----------
 * The partial UNIQUE `idx_cpr_unique_active_deletion` on
 * (shop_id, customer_id) WHERE request_type='deletion' AND status IN
 * ('pending','processing') prevents two deletions from the same
 * customer racing to the finalizer. A conflict on insert returns
 * `reason: 'deletion_already_pending'`.
 *
 * IRON RULE 5
 * -----------
 * No user-facing strings. Customer portal composes its own copy. All
 * error paths return structured `{ ok: false, reason: ... }` codes.
 */

import crypto from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PrivacyRequestType = 'export' | 'deletion' | 'rectification'

export type PrivacyRequestStatus =
  | 'pending'
  | 'processing'
  | 'ready'
  | 'completed'
  | 'consumed'
  | 'cancelled'
  | 'failed'

export interface PrivacyRequestRow {
  id: number
  shopId: string
  customerId: string | null
  customerEmailLower: string
  requestType: PrivacyRequestType
  status: PrivacyRequestStatus
  storageKey: string | null
  downloadExpiresAt: Date | string | null
  downloadConsumedAt: Date | string | null
  scheduledDeletionAt: Date | string | null
  rectificationPayload: Record<string, unknown> | null
  requestedAt: Date | string
  processedAt: Date | string | null
  completedAt: Date | string | null
  processorUserId: string | null
  notes: string | null
  lastError: string | null
}

export interface RequestDataExportInput {
  shopId: string
  customerId: string | null
  email: string
  notes?: string | null
}

export type RequestDataExportResult =
  | { ok: true; id: number; status: 'pending' }
  | { ok: false; reason: 'invalid_email' | 'db_error'; error: string }

export interface RequestAccountDeletionInput {
  shopId: string
  customerId: string
  email: string
  graceDays?: number                  // default from env / 30
  notes?: string | null
}

export type RequestAccountDeletionResult =
  | {
      ok: true
      id: number
      status: 'pending'
      scheduledDeletionAt: Date
      cancelTokenRaw: string           // emailed to customer once, never stored in raw
    }
  | { ok: false; reason: 'invalid_email' | 'deletion_already_pending' | 'db_error'; error: string }

export interface MarkExportReadyInput {
  requestId: number
  storageKey: string
  downloadExpiresAt: Date
}

export type MarkExportReadyResult =
  | { ok: true; downloadTokenRaw: string }
  | { ok: false; reason: 'not_found' | 'bad_status' | 'db_error'; error: string }

export interface ConsumeDownloadTokenInput {
  rawToken: string
}

export type ConsumeDownloadTokenResult =
  | { ok: true; requestId: number; storageKey: string; shopId: string }
  | { ok: false; reason: 'not_found' | 'expired' | 'already_consumed' | 'bad_status' | 'db_error'; error: string }

export interface CancelDeletionInput {
  rawToken: string
}

export type CancelDeletionResult =
  | { ok: true; requestId: number; shopId: string; customerId: string | null }
  | { ok: false; reason: 'not_found' | 'too_late' | 'already_cancelled' | 'db_error'; error: string }

export interface AdminCancelDeletionInput {
  requestId: number
  shopId: string
  processorUserId: string | null
  notes?: string | null
}

export type AdminCancelDeletionResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'bad_status' | 'db_error'; error: string }

export interface ListPrivacyRequestsInput {
  shopId: string
  requestType?: PrivacyRequestType
  status?: PrivacyRequestStatus
  limit?: number
  offset?: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RAW_TOKEN_BYTES = 24     // 48 hex chars
const DEFAULT_GRACE_DAYS = 30
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500
const MAX_NOTES_LEN = 2000

// ---------------------------------------------------------------------------
// Pure helpers (token minting + hashing)
// ---------------------------------------------------------------------------

export function mintRawToken(): string {
  return crypto.randomBytes(RAW_TOKEN_BYTES).toString('hex')
}

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex')
}

/**
 * Constant-time compare of two 64-char hex strings.
 */
export function constantTimeHashEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  if (a.length !== 64) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

export function resolveGraceDays(override?: number): number {
  if (override != null && Number.isFinite(override) && override > 0) {
    return Math.floor(override)
  }
  const fromEnv = process.env.PRIVACY_DELETION_GRACE_DAYS
  if (fromEnv) {
    const parsed = parseInt(fromEnv, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_GRACE_DAYS
}

function isValidEmail(email: string): boolean {
  if (typeof email !== 'string') return false
  const trimmed = email.trim()
  if (trimmed.length === 0 || trimmed.length > 320) return false
  return /@/.test(trimmed)
}

function truncateNotes(notes: string | null | undefined): string | null {
  if (notes == null) return null
  if (notes.length <= MAX_NOTES_LEN) return notes
  return notes.slice(0, MAX_NOTES_LEN)
}

function normaliseLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(limit), MAX_LIMIT)
}

function normaliseOffset(offset: number | undefined): number {
  if (offset == null || !Number.isFinite(offset) || offset < 0) return 0
  return Math.floor(offset)
}

function rowToPrivacyRequest(row: any): PrivacyRequestRow {
  return {
    id: Number(row.id),
    shopId: row.shop_id,
    customerId: row.customer_id,
    customerEmailLower: row.customer_email_lower,
    requestType: row.request_type as PrivacyRequestType,
    status: row.status as PrivacyRequestStatus,
    storageKey: row.storage_key,
    downloadExpiresAt: row.download_expires_at,
    downloadConsumedAt: row.download_consumed_at,
    scheduledDeletionAt: row.scheduled_deletion_at,
    rectificationPayload:
      row.rectification_payload == null
        ? null
        : (row.rectification_payload as Record<string, unknown>),
    requestedAt: row.requested_at,
    processedAt: row.processed_at,
    completedAt: row.completed_at,
    processorUserId: row.processor_user_id,
    notes: row.notes,
    lastError: row.last_error,
  }
}

// ---------------------------------------------------------------------------
// requestDataExport — customer POST /accounts/privacy/export
// ---------------------------------------------------------------------------

export async function requestDataExport(
  db: Kysely<Database>,
  input: RequestDataExportInput,
): Promise<RequestDataExportResult> {
  if (!isValidEmail(input.email)) {
    return { ok: false, reason: 'invalid_email', error: 'email must contain "@"' }
  }

  try {
    const row = await db
      .insertInto('customer_privacy_requests')
      .values({
        shop_id: input.shopId,
        customer_id: input.customerId,
        customer_email_lower: input.email.trim().toLowerCase(),
        request_type: 'export',
        status: 'pending',
        notes: truncateNotes(input.notes),
      } as any)
      .returning(['id'])
      .executeTakeFirst()

    if (!row) return { ok: false, reason: 'db_error', error: 'insert returned no row' }
    return { ok: true, id: Number(row.id), status: 'pending' }
  } catch (err) {
    return { ok: false, reason: 'db_error', error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// requestAccountDeletion — customer POST /accounts/privacy/delete
// ---------------------------------------------------------------------------

export async function requestAccountDeletion(
  db: Kysely<Database>,
  input: RequestAccountDeletionInput,
): Promise<RequestAccountDeletionResult> {
  if (!isValidEmail(input.email)) {
    return { ok: false, reason: 'invalid_email', error: 'email must contain "@"' }
  }

  const graceDays = resolveGraceDays(input.graceDays)
  const scheduledAt = new Date(Date.now() + graceDays * 24 * 60 * 60 * 1000)
  const rawCancel = mintRawToken()
  const cancelHash = hashToken(rawCancel)

  try {
    const row = await db
      .insertInto('customer_privacy_requests')
      .values({
        shop_id: input.shopId,
        customer_id: input.customerId,
        customer_email_lower: input.email.trim().toLowerCase(),
        request_type: 'deletion',
        status: 'pending',
        scheduled_deletion_at: scheduledAt,
        cancel_token_hash: cancelHash,
        notes: truncateNotes(input.notes),
      } as any)
      .returning(['id', 'scheduled_deletion_at'])
      .executeTakeFirst()

    if (!row) return { ok: false, reason: 'db_error', error: 'insert returned no row' }

    const scheduled =
      (row.scheduled_deletion_at as unknown) instanceof Date
        ? (row.scheduled_deletion_at as unknown as Date)
        : row.scheduled_deletion_at
        ? new Date(String(row.scheduled_deletion_at))
        : scheduledAt

    return {
      ok: true,
      id: Number(row.id),
      status: 'pending',
      scheduledDeletionAt: scheduled,
      cancelTokenRaw: rawCancel,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Partial UNIQUE conflict on idx_cpr_unique_active_deletion
    if (/unique|duplicate/i.test(msg) && /cpr_unique_active_deletion/i.test(msg)) {
      return {
        ok: false,
        reason: 'deletion_already_pending',
        error: 'a deletion is already in progress for this customer',
      }
    }
    return { ok: false, reason: 'db_error', error: msg }
  }
}

// ---------------------------------------------------------------------------
// markExportReady — worker finalizer after ZIP is uploaded
// ---------------------------------------------------------------------------

export async function markExportReady(
  db: Kysely<Database>,
  input: MarkExportReadyInput,
): Promise<MarkExportReadyResult> {
  const rawToken = mintRawToken()
  const tokenHash = hashToken(rawToken)

  try {
    const existing = await db
      .selectFrom('customer_privacy_requests')
      .select(['status', 'request_type'])
      .where('id', '=', input.requestId)
      .executeTakeFirst()

    if (!existing) return { ok: false, reason: 'not_found', error: 'request not found' }
    if (existing.request_type !== 'export') {
      return { ok: false, reason: 'bad_status', error: `request is type ${existing.request_type}, not export` }
    }
    if (existing.status !== 'pending' && existing.status !== 'processing') {
      return { ok: false, reason: 'bad_status', error: `cannot mark ready from status=${existing.status}` }
    }

    await db
      .updateTable('customer_privacy_requests')
      .set({
        status: 'ready',
        storage_key: input.storageKey,
        download_token_hash: tokenHash,
        download_expires_at: input.downloadExpiresAt,
        processed_at: new Date(),
      } as any)
      .where('id', '=', input.requestId)
      .execute()

    return { ok: true, downloadTokenRaw: rawToken }
  } catch (err) {
    return { ok: false, reason: 'db_error', error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// consumeDownloadToken — customer GET /accounts/privacy/download/:token
// ---------------------------------------------------------------------------

export async function consumeDownloadToken(
  db: Kysely<Database>,
  input: ConsumeDownloadTokenInput,
): Promise<ConsumeDownloadTokenResult> {
  if (typeof input.rawToken !== 'string' || input.rawToken.length === 0) {
    return { ok: false, reason: 'not_found', error: 'missing token' }
  }

  const tokenHash = hashToken(input.rawToken)

  try {
    // Atomic consume: UPDATE ... RETURNING id only flips status on the
    // exact ready-and-not-expired-and-not-consumed row. Subsequent
    // hits on the same token miss the WHERE clause.
    const row = await db
      .updateTable('customer_privacy_requests')
      .set({
        status: 'consumed',
        download_consumed_at: new Date(),
        completed_at: new Date(),
      } as any)
      .where('download_token_hash', '=', tokenHash)
      .where('status', '=', 'ready')
      .where('download_consumed_at', 'is', null)
      .where('download_expires_at', '>', new Date().toISOString())
      .returning(['id', 'storage_key', 'shop_id'])
      .executeTakeFirst()

    if (row) {
      return {
        ok: true,
        requestId: Number(row.id),
        storageKey: String(row.storage_key ?? ''),
        shopId: row.shop_id,
      }
    }

    // Miss — was it not found, expired, or already consumed?
    const diagnostic = await db
      .selectFrom('customer_privacy_requests')
      .select(['status', 'download_expires_at', 'download_consumed_at'])
      .where('download_token_hash', '=', tokenHash)
      .executeTakeFirst()

    if (!diagnostic) return { ok: false, reason: 'not_found', error: 'token not found' }
    if (diagnostic.download_consumed_at != null) {
      return { ok: false, reason: 'already_consumed', error: 'token already used' }
    }
    if (
      diagnostic.download_expires_at != null &&
      new Date(String(diagnostic.download_expires_at)) <= new Date()
    ) {
      return { ok: false, reason: 'expired', error: 'token expired' }
    }
    return { ok: false, reason: 'bad_status', error: `status=${diagnostic.status}` }
  } catch (err) {
    return { ok: false, reason: 'db_error', error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// cancelDeletion — customer GET /accounts/privacy/cancel-deletion/:token
// ---------------------------------------------------------------------------

export async function cancelDeletion(
  db: Kysely<Database>,
  input: CancelDeletionInput,
): Promise<CancelDeletionResult> {
  if (typeof input.rawToken !== 'string' || input.rawToken.length === 0) {
    return { ok: false, reason: 'not_found', error: 'missing token' }
  }

  const tokenHash = hashToken(input.rawToken)

  try {
    const row = await db
      .updateTable('customer_privacy_requests')
      .set({
        status: 'cancelled',
        completed_at: new Date(),
      } as any)
      .where('cancel_token_hash', '=', tokenHash)
      .where('request_type', '=', 'deletion')
      .where('status', '=', 'pending')
      .where('scheduled_deletion_at', '>', new Date().toISOString())
      .returning(['id', 'shop_id', 'customer_id'])
      .executeTakeFirst()

    if (row) {
      return {
        ok: true,
        requestId: Number(row.id),
        shopId: row.shop_id,
        customerId: row.customer_id,
      }
    }

    // Diagnostic
    const diag = await db
      .selectFrom('customer_privacy_requests')
      .select(['status', 'scheduled_deletion_at', 'request_type'])
      .where('cancel_token_hash', '=', tokenHash)
      .executeTakeFirst()

    if (!diag) return { ok: false, reason: 'not_found', error: 'token not found' }
    if (diag.status === 'cancelled') return { ok: false, reason: 'already_cancelled', error: 'already cancelled' }
    if (diag.status !== 'pending') {
      return { ok: false, reason: 'too_late', error: `status=${diag.status}; finalized` }
    }
    if (
      diag.scheduled_deletion_at != null &&
      new Date(String(diag.scheduled_deletion_at)) <= new Date()
    ) {
      return { ok: false, reason: 'too_late', error: 'grace window expired' }
    }
    return { ok: false, reason: 'not_found', error: 'diagnostic could not classify' }
  } catch (err) {
    return { ok: false, reason: 'db_error', error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// adminCancelDeletion — merchant staff cancels on behalf of customer
// ---------------------------------------------------------------------------

export async function adminCancelDeletion(
  db: Kysely<Database>,
  input: AdminCancelDeletionInput,
): Promise<AdminCancelDeletionResult> {
  try {
    const existing = await db
      .selectFrom('customer_privacy_requests')
      .select(['status', 'request_type', 'shop_id'])
      .where('id', '=', input.requestId)
      .executeTakeFirst()

    if (!existing) return { ok: false, reason: 'not_found', error: 'request not found' }
    if (existing.shop_id !== input.shopId) {
      return { ok: false, reason: 'not_found', error: 'cross-shop access denied' }
    }
    if (existing.request_type !== 'deletion') {
      return {
        ok: false,
        reason: 'bad_status',
        error: `request is type ${existing.request_type}, not deletion`,
      }
    }
    if (existing.status !== 'pending') {
      return { ok: false, reason: 'bad_status', error: `cannot cancel from status=${existing.status}` }
    }

    await db
      .updateTable('customer_privacy_requests')
      .set({
        status: 'cancelled',
        completed_at: new Date(),
        processor_user_id: input.processorUserId,
        notes: truncateNotes(input.notes),
      } as any)
      .where('id', '=', input.requestId)
      .execute()

    return { ok: true }
  } catch (err) {
    return { ok: false, reason: 'db_error', error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// listPrivacyRequests — admin list + pagination
// ---------------------------------------------------------------------------

export async function listPrivacyRequests(
  db: Kysely<Database>,
  input: ListPrivacyRequestsInput,
): Promise<PrivacyRequestRow[]> {
  const limit = normaliseLimit(input.limit)
  const offset = normaliseOffset(input.offset)

  let query = db
    .selectFrom('customer_privacy_requests')
    .selectAll()
    .where('shop_id', '=', input.shopId)
    .orderBy('requested_at', 'desc')
    .limit(limit)
    .offset(offset)

  if (input.requestType) {
    query = query.where('request_type', '=', input.requestType)
  }
  if (input.status) {
    query = query.where('status', '=', input.status)
  }

  const rows = await query.execute()
  return rows.map(rowToPrivacyRequest)
}

// ---------------------------------------------------------------------------
// getPrivacyRequestById — admin drill-in + cross-shop guard
// ---------------------------------------------------------------------------

export async function getPrivacyRequestById(
  db: Kysely<Database>,
  params: { requestId: number; shopId: string },
): Promise<PrivacyRequestRow | null> {
  const row = await db
    .selectFrom('customer_privacy_requests')
    .selectAll()
    .where('id', '=', params.requestId)
    .where('shop_id', '=', params.shopId)
    .executeTakeFirst()

  return row ? rowToPrivacyRequest(row) : null
}

// ---------------------------------------------------------------------------
// listDeletionsDueForFinalization — cron hot-path
// ---------------------------------------------------------------------------

export async function listDeletionsDueForFinalization(
  db: Kysely<Database>,
  params: { now?: Date; limit?: number } = {},
): Promise<PrivacyRequestRow[]> {
  const now = params.now ?? new Date()
  const limit = Math.min(Math.max(1, params.limit ?? 200), 500)

  const rows = await db
    .selectFrom('customer_privacy_requests')
    .selectAll()
    .where('request_type', '=', 'deletion')
    .where('status', '=', 'pending')
    .where('scheduled_deletion_at', '<=', now.toISOString())
    .orderBy('scheduled_deletion_at', 'asc')
    .limit(limit)
    .execute()

  return rows.map(rowToPrivacyRequest)
}

// ---------------------------------------------------------------------------
// markFailed — worker reports terminal error
// ---------------------------------------------------------------------------

export async function markFailed(
  db: Kysely<Database>,
  params: { requestId: number; error: string },
): Promise<{ ok: true } | { ok: false; reason: 'db_error'; error: string }> {
  try {
    await db
      .updateTable('customer_privacy_requests')
      .set({
        status: 'failed',
        last_error: params.error.slice(0, 2000),
        completed_at: new Date(),
      } as any)
      .where('id', '=', params.requestId)
      .execute()
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: 'db_error', error: err instanceof Error ? err.message : String(err) }
  }
}
