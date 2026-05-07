/**
 * Gbox Platform — Staff member service.
 *
 * Phase 9 / PR4. Reads + writes the `user_shops` table for a shop's
 * staff list. Invitation creation / acceptance lives in
 * `./invitations.ts`; once accepted, the resulting `user_shops` row
 * is what this module edits.
 */

import type { Kysely } from 'kysely'
import {
  isValidStaffRole,
  resolvePermissions,
  sanitisePermissionList,
  type StaffRole,
} from './permissions.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StaffMemberRow {
  user_id: string
  shop_id: string
  role: string
  permissions: string[]
  permissions_computed: string[]
  disabled_at: string | null
  invited_by: string | null
  invited_at: string | null
  last_active_at: string | null
  created_at: string
  // Joined fields from `users`:
  name: string | null
  email: string
  avatar_url: string | null
  user_status: string
}

export class StaffMemberNotFoundError extends Error {
  constructor() { super('Staff member not found.'); this.name = 'StaffMemberNotFoundError' }
}
export class InvalidStaffUpdateError extends Error {
  constructor(msg: string) { super(msg); this.name = 'InvalidStaffUpdateError' }
}
export class CannotRemoveOwnerError extends Error {
  constructor() { super('The shop owner cannot be removed or demoted.'); this.name = 'CannotRemoveOwnerError' }
}
export class CannotRemoveSelfError extends Error {
  constructor() { super('You cannot remove yourself from this shop.'); this.name = 'CannotRemoveSelfError' }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeJsonArray(s: unknown): string[] {
  if (Array.isArray(s)) return s.filter((x) => typeof x === 'string')
  if (typeof s === 'string') {
    try {
      const p = JSON.parse(s)
      return Array.isArray(p) ? p.filter((x) => typeof x === 'string') : []
    } catch {
      return []
    }
  }
  return []
}

function rowFromDb(r: any): StaffMemberRow {
  return {
    user_id: String(r.user_id),
    shop_id: String(r.shop_id),
    role: String(r.role),
    permissions: safeJsonArray(r.permissions),
    permissions_computed: safeJsonArray(r.permissions_computed),
    disabled_at: r.disabled_at ?? null,
    invited_by: r.invited_by ?? null,
    invited_at: r.invited_at ?? null,
    last_active_at: r.last_active_at ?? null,
    created_at: String(r.created_at),
    name: r.name ?? null,
    email: String(r.email),
    avatar_url: r.avatar_url ?? null,
    user_status: String(r.user_status ?? 'active'),
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listMembers(
  db: Kysely<any>,
  shopId: string,
): Promise<StaffMemberRow[]> {
  const rows = await (db as any)
    .selectFrom('user_shops as us')
    .innerJoin('users as u', 'u.id', 'us.user_id')
    .select([
      'us.user_id',
      'us.shop_id',
      'us.role',
      'us.permissions',
      'us.permissions_computed',
      'us.disabled_at',
      'us.invited_by',
      'us.invited_at',
      'us.last_active_at',
      'us.created_at',
      'u.name',
      'u.email',
      'u.avatar_url',
      'u.status as user_status',
    ])
    .where('us.shop_id', '=', shopId)
    .orderBy('us.role', 'asc')
    .orderBy('u.email', 'asc')
    .execute()
  return rows.map(rowFromDb)
}

export async function getMember(
  db: Kysely<any>,
  shopId: string,
  userId: string,
): Promise<StaffMemberRow | null> {
  const row = await (db as any)
    .selectFrom('user_shops as us')
    .innerJoin('users as u', 'u.id', 'us.user_id')
    .select([
      'us.user_id',
      'us.shop_id',
      'us.role',
      'us.permissions',
      'us.permissions_computed',
      'us.disabled_at',
      'us.invited_by',
      'us.invited_at',
      'us.last_active_at',
      'us.created_at',
      'u.name',
      'u.email',
      'u.avatar_url',
      'u.status as user_status',
    ])
    .where('us.shop_id', '=', shopId)
    .where('us.user_id', '=', userId)
    .executeTakeFirst()
  return row ? rowFromDb(row) : null
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface UpdateMemberInput {
  shop_id: string
  user_id: string
  role?: StaffRole
  permissions?: readonly string[]
  actor_user_id: string
}

/**
 * Update role and/or permissions for a staff member.
 *
 * Guard rules:
 * - Cannot change a `role='owner'` row (would violate the "one owner
 *   per shop" invariant). Ownership transfer is a separate workflow
 *   not covered by PR4.
 * - An admin cannot demote themselves out of the admin role (would
 *   lock them out of the staff page mid-request). The owner always can.
 * - `permissions_computed` is recomputed from the new role template +
 *   override list every time so middleware checks stay consistent.
 */
export async function updateMember(
  db: Kysely<any>,
  input: UpdateMemberInput,
): Promise<StaffMemberRow> {
  const current = await getMember(db, input.shop_id, input.user_id)
  if (!current) throw new StaffMemberNotFoundError()
  if (current.role === 'owner') throw new CannotRemoveOwnerError()

  const newRole = (input.role ?? current.role) as StaffRole
  if (!isValidStaffRole(newRole) || newRole === 'owner') {
    throw new InvalidStaffUpdateError('Role must be admin, staff, or limited.')
  }

  const newPerms = sanitisePermissionList(input.permissions ?? current.permissions)
  const resolved = resolvePermissions(newRole, newPerms)

  // Prevent the acting admin from demoting themselves.
  if (
    input.actor_user_id === input.user_id &&
    current.role === 'admin' &&
    newRole !== 'admin'
  ) {
    throw new InvalidStaffUpdateError('You cannot demote yourself out of the admin role.')
  }

  await (db as any)
    .updateTable('user_shops')
    .set({
      role: newRole,
      permissions: JSON.stringify(newPerms),
      permissions_computed: JSON.stringify(resolved),
    })
    .where('user_id', '=', input.user_id)
    .where('shop_id', '=', input.shop_id)
    .execute()

  const updated = await getMember(db, input.shop_id, input.user_id)
  if (!updated) throw new StaffMemberNotFoundError()
  return updated
}

export interface DisableMemberInput {
  shop_id: string
  user_id: string
  actor_user_id: string
}

export async function disableMember(
  db: Kysely<any>,
  input: DisableMemberInput,
): Promise<StaffMemberRow> {
  if (input.actor_user_id === input.user_id) {
    throw new CannotRemoveSelfError()
  }
  const current = await getMember(db, input.shop_id, input.user_id)
  if (!current) throw new StaffMemberNotFoundError()
  if (current.role === 'owner') throw new CannotRemoveOwnerError()
  await (db as any)
    .updateTable('user_shops')
    .set({ disabled_at: new Date() })
    .where('user_id', '=', input.user_id)
    .where('shop_id', '=', input.shop_id)
    .execute()
  const updated = await getMember(db, input.shop_id, input.user_id)
  if (!updated) throw new StaffMemberNotFoundError()
  return updated
}

export async function reenableMember(
  db: Kysely<any>,
  input: DisableMemberInput,
): Promise<StaffMemberRow> {
  const current = await getMember(db, input.shop_id, input.user_id)
  if (!current) throw new StaffMemberNotFoundError()
  await (db as any)
    .updateTable('user_shops')
    .set({ disabled_at: null })
    .where('user_id', '=', input.user_id)
    .where('shop_id', '=', input.shop_id)
    .execute()
  const updated = await getMember(db, input.shop_id, input.user_id)
  if (!updated) throw new StaffMemberNotFoundError()
  return updated
}

export async function removeMember(
  db: Kysely<any>,
  input: DisableMemberInput,
): Promise<void> {
  if (input.actor_user_id === input.user_id) {
    throw new CannotRemoveSelfError()
  }
  const current = await getMember(db, input.shop_id, input.user_id)
  if (!current) throw new StaffMemberNotFoundError()
  if (current.role === 'owner') throw new CannotRemoveOwnerError()
  await (db as any)
    .deleteFrom('user_shops')
    .where('user_id', '=', input.user_id)
    .where('shop_id', '=', input.shop_id)
    .execute()
}

/**
 * Touch `last_active_at` for a (user, shop). Cheap, fire-and-forget
 * from middleware; swallow errors to never block a request.
 */
export async function touchLastActive(
  db: Kysely<any>,
  shopId: string,
  userId: string,
): Promise<void> {
  try {
    await (db as any)
      .updateTable('user_shops')
      .set({ last_active_at: new Date() })
      .where('user_id', '=', userId)
      .where('shop_id', '=', shopId)
      .execute()
  } catch {
    // intentionally swallowed — this is a decoration, not correctness.
  }
}
