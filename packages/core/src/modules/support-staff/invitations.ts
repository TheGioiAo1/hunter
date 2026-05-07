/**
 * Gbox Platform — Support staff invitations.
 *
 * Pure helpers + DB mutations for the god-admin → new-agent invite
 * flow. Wire contract:
 *
 *   1. God admin POSTs `{ email, displayName, preset, message? }` to
 *      `/staff/invite`. The handler calls `createInvitation(db, {...})`:
 *
 *        a. Generates a 64-char hex token (crypto.randomBytes(32)).
 *        b. Stores only SHA-256(token) in `token_hash`.
 *        c. Sets `expires_at = now + 7d`.
 *        d. Returns `{ row, rawToken }` — the raw token is emailed to
 *           the invitee in a one-shot link. It's NEVER stored.
 *
 *   2. Invitee clicks `https://supporter.gbox.co/invite/<rawToken>`.
 *      The handler calls `findInvitationByToken(db, rawToken)` which
 *      re-hashes the token and looks it up. Returns the pending row
 *      or `null`.
 *
 *   3. Invitee submits `{ password, displayName?, totpSecret? }`. The
 *      handler calls `acceptInvitation(db, { invitationId, userId })`
 *      inside a transaction (user creation happens upstream; this
 *      function just flips the row to `accepted`).
 *
 *   4. God admin can also revoke a pending invite via
 *      `revokeInvitation(db, { invitationId, revokedBy })`. The row
 *      flips to `status='revoked'`; the link stops working.
 *
 *   5. The expiration cron (PR5) calls `expirePendingInvitations(db)`
 *      every 15 minutes. Any `pending` row past `expires_at` flips to
 *      `status='expired'`.
 *
 * Rate limit: 20 invites / god admin / hour. Enforced by the caller
 * via `@gbox/core/modules/support/rate-limit` — NOT in this module
 * (keeps it DB-only).
 */

import crypto from 'node:crypto'
import type { Kysely } from 'kysely'
import type {
  Database,
  SupportAgentPreset,
  SupportStaffInvitationTable,
} from '@gbox/db/schema/tables.js'

export const INVITE_TOKEN_BYTES = 32 // → 64 hex chars
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export interface CreateInvitationInput {
  email: string
  displayName: string
  preset: SupportAgentPreset
  invitedBy: string // god admin user id
  message?: string
}

export interface CreateInvitationResult {
  invitationId: string
  rawToken: string
  tokenHash: string
  expiresAt: string
}

/**
 * Generate a token pair. `rawToken` is hex (URL-safe, 64 chars) and is
 * NEVER persisted. `tokenHash` is what we write to the DB.
 */
export function generateInviteToken(): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(INVITE_TOKEN_BYTES).toString('hex')
  const tokenHash = hashToken(rawToken)
  return { rawToken, tokenHash }
}

/** SHA-256 of the token. Separated so tests can pin the canonical form. */
export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex')
}

/** Lowercase + trim for idempotent email comparisons. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export interface CreateInvitationError {
  code:
    | 'invalid_email'
    | 'invalid_display_name'
    | 'invalid_preset'
    | 'duplicate_pending'
    | 'invalid_message'
  message: string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const VALID_PRESETS: readonly SupportAgentPreset[] = [
  'l1_support',
  'l2_support_senior',
  'lead_support',
  'god_admin', // iron-rule-5-ok: role preset identifier, server-side only; never rendered in seller UI
]

/**
 * Validate + reject obviously-bad input BEFORE touching the DB.
 * Returns `null` on success; a `CreateInvitationError` otherwise.
 */
export function validateCreateInvitation(
  input: CreateInvitationInput,
): CreateInvitationError | null {
  const email = normalizeEmail(input.email)
  if (!EMAIL_RE.test(email) || email.length > 320) {
    return { code: 'invalid_email', message: 'Invalid email.' }
  }
  const name = (input.displayName ?? '').trim()
  if (name.length < 1 || name.length > 60) {
    return { code: 'invalid_display_name', message: 'Display name must be 1–60 chars.' }
  }
  if (!VALID_PRESETS.includes(input.preset)) {
    return { code: 'invalid_preset', message: 'Invalid preset.' }
  }
  if (input.message && input.message.length > 500) {
    return { code: 'invalid_message', message: 'Message must be ≤ 500 chars.' }
  }
  return null
}

/**
 * Write a pending invitation row and return the raw token + metadata.
 *
 * Caller is expected to `validateCreateInvitation` first. Duplicate-
 * pending-email collisions surface as a Postgres UNIQUE violation on
 * `idx_support_staff_invitations_pending_email`; we catch it and
 * translate to `duplicate_pending`.
 */
export async function createInvitation(
  db: Kysely<Database>,
  input: CreateInvitationInput,
): Promise<
  | { ok: true; data: CreateInvitationResult }
  | { ok: false; error: CreateInvitationError }
> {
  const validationError = validateCreateInvitation(input)
  if (validationError) return { ok: false, error: validationError }

  const email = normalizeEmail(input.email)
  const { rawToken, tokenHash } = generateInviteToken()
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString()

  try {
    const row = await (db as any)
      .insertInto('support_staff_invitations')
      .values({
        email,
        display_name: input.displayName.trim(),
        preset: input.preset,
        token_hash: tokenHash,
        invited_by: input.invitedBy,
        status: 'pending',
        expires_at: expiresAt,
        message: input.message ?? null,
      })
      .returning(['id', 'expires_at'])
      .executeTakeFirstOrThrow()

    return {
      ok: true,
      data: {
        invitationId: row.id as string,
        rawToken,
        tokenHash,
        expiresAt: row.expires_at as string,
      },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/duplicate key|idx_support_staff_invitations_pending_email/i.test(msg)) {
      return {
        ok: false,
        error: {
          code: 'duplicate_pending',
          message: 'A pending invitation already exists for this email.',
        },
      }
    }
    throw err
  }
}

export interface InvitationRow {
  id: string
  email: string
  displayName: string
  preset: SupportAgentPreset
  status: 'pending' | 'accepted' | 'expired' | 'revoked'
  expiresAt: string
  invitedBy: string | null
  message: string | null
  createdAt: string
}

function mapRow(r: SupportStaffInvitationTable & { created_at: string; updated_at: string }): InvitationRow {
  return {
    id: r.id as unknown as string,
    email: r.email,
    displayName: r.display_name,
    preset: r.preset as SupportAgentPreset,
    status: r.status as InvitationRow['status'],
    expiresAt: r.expires_at as unknown as string,
    invitedBy: r.invited_by,
    message: r.message,
    createdAt: r.created_at,
  }
}

/**
 * Look up the invite row by raw token. Returns the row only if:
 *   - token hash matches
 *   - status = 'pending'
 *   - expires_at > now
 *
 * Returns `null` otherwise — INCLUDING for expired / revoked / wrong
 * token. Callers must not differentiate the three — revealing "your
 * link expired" vs "your link never existed" leaks timing data.
 */
export async function findValidInvitation(
  db: Kysely<Database>,
  rawToken: string,
): Promise<InvitationRow | null> {
  if (typeof rawToken !== 'string' || rawToken.length !== INVITE_TOKEN_BYTES * 2) {
    return null
  }
  const tokenHash = hashToken(rawToken)
  const row = await (db as any)
    .selectFrom('support_staff_invitations')
    .selectAll()
    .where('token_hash', '=', tokenHash)
    .where('status', '=', 'pending')
    .where('expires_at', '>', new Date().toISOString())
    .executeTakeFirst()
  return row ? mapRow(row) : null
}

/**
 * Mark an invitation as accepted. Caller is responsible for creating
 * the `users` row + `support_agent_profiles` row in the same
 * transaction. Pass the resulting `userId` so we can link back.
 */
export async function acceptInvitation(
  db: Kysely<Database>,
  params: { invitationId: string; userId: string },
): Promise<boolean> {
  const result = await (db as any)
    .updateTable('support_staff_invitations')
    .set({
      status: 'accepted',
      accepted_at: new Date().toISOString(),
      accepted_by_user_id: params.userId,
    })
    .where('id', '=', params.invitationId)
    .where('status', '=', 'pending')
    .where('expires_at', '>', new Date().toISOString())
    .executeTakeFirst()
  return Number((result as { numUpdatedRows?: bigint }).numUpdatedRows ?? 0n) > 0
}

/**
 * Revoke a pending invitation. Returns `true` if a row was actually
 * flipped (false if the invite was already accepted / expired /
 * revoked / not found).
 */
export async function revokeInvitation(
  db: Kysely<Database>,
  params: { invitationId: string; revokedBy: string },
): Promise<boolean> {
  const result = await (db as any)
    .updateTable('support_staff_invitations')
    .set({
      status: 'revoked',
      revoked_at: new Date().toISOString(),
      revoked_by: params.revokedBy,
    })
    .where('id', '=', params.invitationId)
    .where('status', '=', 'pending')
    .executeTakeFirst()
  return Number((result as { numUpdatedRows?: bigint }).numUpdatedRows ?? 0n) > 0
}

/**
 * Background-cron entry point: flip every `pending` invitation past
 * its `expires_at` to `expired`. Returns the count flipped.
 *
 * Safe to call concurrently (Postgres UPDATE is atomic per row).
 */
export async function expirePendingInvitations(db: Kysely<Database>): Promise<number> {
  const result = await (db as any)
    .updateTable('support_staff_invitations')
    .set({
      status: 'expired',
    })
    .where('status', '=', 'pending')
    .where('expires_at', '<=', new Date().toISOString())
    .executeTakeFirst()
  return Number((result as { numUpdatedRows?: bigint }).numUpdatedRows ?? 0n)
}

/**
 * List recent invitations for the god-admin inbox. Newest first.
 * Scoped by optional `status` filter.
 */
export async function listInvitations(
  db: Kysely<Database>,
  params: { status?: InvitationRow['status']; limit?: number } = {},
): Promise<InvitationRow[]> {
  const limit = Math.max(1, Math.min(200, params.limit ?? 50))
  let q = (db as any)
    .selectFrom('support_staff_invitations')
    .selectAll()
    .orderBy('created_at', 'desc')
    .limit(limit)
  if (params.status) q = q.where('status', '=', params.status)
  const rows = (await q.execute()) as Array<
    SupportStaffInvitationTable & { created_at: string; updated_at: string }
  >
  return rows.map(mapRow)
}
