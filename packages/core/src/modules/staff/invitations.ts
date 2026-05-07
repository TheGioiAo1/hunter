/**
 * Gbox Platform — Staff invitation service.
 *
 * Phase 9 / PR4. Lifecycle:
 *
 *   1. `createInvitation` — owner/admin posts {email, role, permissions};
 *      service stores a SHA-256 hash of a fresh 64-char hex token in
 *      `staff_invitations.token_hash` and returns the raw token to the
 *      caller so the store-admin can email it.
 *   2. `findInvitationByToken` — invitee opens the email link
 *      (`/staff/accept?token=<raw>`); handler calls this to fetch the
 *      row. Expired / revoked / accepted rows are filtered out.
 *   3. `acceptInvitation` — invitee signs in (or creates an account)
 *      and posts accept; service creates the `user_shops` row with the
 *      requested role + resolved permissions, flips the invitation to
 *      `accepted`, and returns the created row.
 *   4. `revokeInvitation` — owner/admin revokes a pending invitation
 *      (the emailed link stops working immediately).
 *   5. `expireInvitations` — background task flips stale `pending`
 *      rows past `expires_at` to `expired`. Optional (the
 *      `findInvitationByToken` query already filters by `expires_at`).
 */

import { createHash, randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import {
  isValidStaffRole,
  resolvePermissions,
  sanitisePermissionList,
  type StaffRole,
} from './permissions.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InvitationStatus = 'pending' | 'accepted' | 'expired' | 'revoked'

export interface InvitationRow {
  id: string
  shop_id: string
  email: string
  role: string
  permissions: string[]
  status: InvitationStatus
  invited_by: string | null
  expires_at: string
  accepted_at: string | null
  accepted_by_user_id: string | null
  revoked_at: string | null
  revoked_by: string | null
  created_at: string
  updated_at: string
}

export interface CreateInvitationInput {
  shop_id: string
  email: string
  role: StaffRole
  permissions?: readonly string[]
  invited_by: string
  /**
   * Default: 7 days. Capped at 90 days server-side as a sanity guard.
   */
  ttl_days?: number
}

export interface CreateInvitationResult {
  invitation: InvitationRow
  /** Raw token — email this, never store or log it. */
  token: string
}

export class InvalidInvitationInputError extends Error {
  constructor(msg: string) { super(msg); this.name = 'InvalidInvitationInputError' }
}
export class DuplicateInvitationError extends Error {
  constructor() { super('A pending invitation already exists for this email on this shop.'); this.name = 'DuplicateInvitationError' }
}
export class InvitationNotFoundError extends Error {
  constructor() { super('Invitation not found or no longer valid.'); this.name = 'InvitationNotFoundError' }
}
export class InvitationExpiredError extends Error {
  constructor() { super('This invitation has expired. Please contact Gbox support or request a new one.'); this.name = 'InvitationExpiredError' }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DEFAULT_TTL_DAYS = 7
const MAX_TTL_DAYS = 90

export function _hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function _generateToken(): string {
  // 32 bytes = 64 hex chars, sufficient entropy (128 bits post-hash).
  return randomBytes(32).toString('hex')
}

function toIso(v: any): string {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString()
  // PG driver often returns Date objects already; guard against raw strings
  // that still need normalising (e.g. '2026-04-21 10:51:14.123+00').
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString()
}

function toIsoOrNull(v: any): string | null {
  if (v == null) return null
  return toIso(v)
}

function rowFromDb(r: any): InvitationRow {
  return {
    id: String(r.id),
    shop_id: String(r.shop_id),
    email: String(r.email),
    role: String(r.role),
    permissions: Array.isArray(r.permissions)
      ? r.permissions
      : typeof r.permissions === 'string'
        ? safeJsonArray(r.permissions)
        : [],
    status: r.status as InvitationStatus,
    invited_by: r.invited_by ?? null,
    expires_at: toIso(r.expires_at),
    accepted_at: toIsoOrNull(r.accepted_at),
    accepted_by_user_id: r.accepted_by_user_id ?? null,
    revoked_at: toIsoOrNull(r.revoked_at),
    revoked_by: r.revoked_by ?? null,
    created_at: toIso(r.created_at),
    updated_at: toIso(r.updated_at),
  }
}

function safeJsonArray(s: string): string[] {
  try {
    const parsed = JSON.parse(s)
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export async function createInvitation(
  db: Kysely<any>,
  input: CreateInvitationInput,
): Promise<CreateInvitationResult> {
  const email = (input.email ?? '').trim().toLowerCase()
  if (!EMAIL_REGEX.test(email)) {
    throw new InvalidInvitationInputError('A valid email is required.')
  }
  if (!isValidStaffRole(input.role) || input.role === 'owner') {
    throw new InvalidInvitationInputError('Role must be admin, staff, or limited.')
  }
  const perms = sanitisePermissionList(input.permissions ?? [])
  const ttl = Math.min(
    Math.max(1, Math.floor(input.ttl_days ?? DEFAULT_TTL_DAYS)),
    MAX_TTL_DAYS,
  )

  // Block duplicate outstanding invitations (the UNIQUE partial index
  // will also catch this at the DB layer — we return a friendlier
  // message here).
  const existing = await (db as any)
    .selectFrom('staff_invitations')
    .select('id')
    .where('shop_id', '=', input.shop_id)
    .where('email', '=', email)
    .where('status', '=', 'pending')
    .executeTakeFirst()
  if (existing) throw new DuplicateInvitationError()

  const token = _generateToken()
  const token_hash = _hashToken(token)
  const expiresAt = new Date(Date.now() + ttl * 24 * 60 * 60 * 1000)

  const [row] = await (db as any)
    .insertInto('staff_invitations')
    .values({
      shop_id: input.shop_id,
      email,
      role: input.role,
      permissions: JSON.stringify(perms),
      token_hash,
      invited_by: input.invited_by,
      status: 'pending',
      expires_at: expiresAt,
    })
    .returningAll()
    .execute()

  return { invitation: rowFromDb(row), token }
}

/**
 * Fetch an invitation by raw token, filtering out accepted / revoked /
 * expired rows. Returns `null` when nothing matches.
 */
export async function findInvitationByToken(
  db: Kysely<any>,
  token: string,
): Promise<InvitationRow | null> {
  const hash = _hashToken(token)
  const row = await (db as any)
    .selectFrom('staff_invitations')
    .selectAll()
    .where('token_hash', '=', hash)
    .where('status', '=', 'pending')
    .where('expires_at', '>', sql`NOW()`)
    .executeTakeFirst()
  return row ? rowFromDb(row) : null
}

export interface AcceptInvitationInput {
  token: string
  accepting_user_id: string
}

export interface AcceptInvitationResult {
  invitation: InvitationRow
  user_shop: {
    user_id: string
    shop_id: string
    role: string
    permissions: string[]
    permissions_computed: string[]
  }
}

export async function acceptInvitation(
  db: Kysely<any>,
  input: AcceptInvitationInput,
): Promise<AcceptInvitationResult> {
  const existing = await findInvitationByToken(db, input.token)
  if (!existing) throw new InvitationNotFoundError()

  // Don't allow re-joining a shop the user is already a member of.
  const alreadyMember = await (db as any)
    .selectFrom('user_shops')
    .select('user_id')
    .where('user_id', '=', input.accepting_user_id)
    .where('shop_id', '=', existing.shop_id)
    .executeTakeFirst()

  const role = existing.role as StaffRole
  const resolved = resolvePermissions(role, existing.permissions)

  if (!alreadyMember) {
    await (db as any)
      .insertInto('user_shops')
      .values({
        user_id: input.accepting_user_id,
        shop_id: existing.shop_id,
        role,
        permissions: JSON.stringify(existing.permissions),
        permissions_computed: JSON.stringify(resolved),
        invited_by: existing.invited_by,
        invited_at: existing.created_at,
      })
      .execute()
  } else {
    // Upgrade the existing membership to the invitation's role +
    // permissions; this is the case where an owner re-invites a
    // former staffer who was later removed (their users row survived
    // but user_shops was deleted) or where a platform admin manually
    // inserted a user_shops row before the invite.
    await (db as any)
      .updateTable('user_shops')
      .set({
        role,
        permissions: JSON.stringify(existing.permissions),
        permissions_computed: JSON.stringify(resolved),
        disabled_at: null,
      })
      .where('user_id', '=', input.accepting_user_id)
      .where('shop_id', '=', existing.shop_id)
      .execute()
  }

  const [accepted] = await (db as any)
    .updateTable('staff_invitations')
    .set({
      status: 'accepted',
      accepted_at: new Date(),
      accepted_by_user_id: input.accepting_user_id,
      updated_at: new Date(),
    })
    .where('id', '=', existing.id)
    .returningAll()
    .execute()

  return {
    invitation: rowFromDb(accepted),
    user_shop: {
      user_id: input.accepting_user_id,
      shop_id: existing.shop_id,
      role,
      permissions: existing.permissions,
      permissions_computed: resolved,
    },
  }
}

export async function revokeInvitation(
  db: Kysely<any>,
  params: { id: string; shop_id: string; revoked_by: string },
): Promise<InvitationRow> {
  const [row] = await (db as any)
    .updateTable('staff_invitations')
    .set({
      status: 'revoked',
      revoked_at: new Date(),
      revoked_by: params.revoked_by,
      updated_at: new Date(),
    })
    .where('id', '=', params.id)
    .where('shop_id', '=', params.shop_id)
    .where('status', '=', 'pending')
    .returningAll()
    .execute()
  if (!row) throw new InvitationNotFoundError()
  return rowFromDb(row)
}

/**
 * Mark all `pending` rows past their `expires_at` as `expired`. Safe
 * to call on a cron cadence; returns the count flipped.
 */
export async function expireInvitations(db: Kysely<any>): Promise<number> {
  const result: any = await (db as any)
    .updateTable('staff_invitations')
    .set({ status: 'expired', updated_at: new Date() })
    .where('status', '=', 'pending')
    .where('expires_at', '<=', sql`NOW()`)
    .executeTakeFirst()
  return Number(result?.numUpdatedRows ?? 0)
}

export interface ListInvitationsFilter {
  shop_id: string
  /** Filter to one status; omit for all statuses. */
  status?: InvitationStatus
  limit?: number
}

export async function listInvitations(
  db: Kysely<any>,
  filter: ListInvitationsFilter,
): Promise<InvitationRow[]> {
  let q = (db as any)
    .selectFrom('staff_invitations')
    .selectAll()
    .where('shop_id', '=', filter.shop_id)
  if (filter.status) q = q.where('status', '=', filter.status)
  q = q.orderBy('created_at', 'desc')
  if (filter.limit) q = q.limit(filter.limit)
  const rows = await q.execute()
  return rows.map(rowFromDb)
}
