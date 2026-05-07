/**
 * Gbox Platform — Email tracking IP salt rotation (Phase 14 PR5)
 *
 * Rotates the salt that hashes IP addresses in email_events and
 * consent_events. After rotation:
 *   - Old rows' ip_hash still prove "same IP" within the old epoch,
 *     but no longer correlate to the new epoch — attacker with DB read
 *     can't join IPs across rotations.
 *   - New rows from then on use the new salt.
 *   - Unique-open counting per reporting window still works as long
 *     as the window stays inside one rotation epoch (the admin UI
 *     already reports per-campaign / per-day windows that satisfy this).
 *
 * STORAGE MODEL
 * -------------
 * The salt itself lives in `EMAIL_TRACKING_IP_SALT` env var, NOT the
 * database. This module writes an AUDIT row (sha256 hashes of old +
 * new salt + who rotated + why) to `email_tracking_salt_rotations`,
 * and RETURNS the new raw salt exactly once. The caller (CLI or
 * Phase 15 admin UI) is responsible for pushing the new value into
 * the deployment's secret store. We never persist the raw salt.
 *
 * RATE LIMIT
 * ----------
 * Default 1 hour between rotations. Rotating too fast destroys the
 * unique-open counting window. `--force` bypasses for true emergencies
 * (salt leaked, incident response). Checked against the most recent
 * row in `email_tracking_salt_rotations` — no clock-skew tolerance
 * because we never rotate faster than every 30d in normal operation.
 *
 * FAIL-CLOSED
 * -----------
 * If `EMAIL_TRACKING_IP_SALT` is unset when rotate is called, we emit
 * a FIRST-ROTATION row (old_salt_hash = NULL) but still return the new
 * value. The caller is expected to then set the env var; the "old hash"
 * recorded is genuinely NULL because there was no old salt. This matches
 * the bootstrap scenario on a fresh install.
 *
 * IRON RULE 5
 * -----------
 * Structured results only. The CLI composes human copy. No god_admin
 * leak in any error path.
 */

import crypto from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Constants + types
// ---------------------------------------------------------------------------

/** Raw salt is 32 bytes → 64 hex chars. */
export const SALT_BYTES = 32

/** Default rate-limit gap between rotations (in ms). 1 hour. */
export const DEFAULT_RATE_LIMIT_MS = 60 * 60 * 1000

/**
 * Accepted `rotated_by` values. Enforced by the CLI; the DB column is
 * free-form text so future callers (Phase 15 admin UI) can pass
 * `admin:<user_uuid>` without another migration.
 */
export type RotatedByKind =
  | 'cli'
  | `cli:${string}`
  | `admin:${string}`
  | 'system'

export interface RotateTrackingSaltInput {
  rotatedBy: RotatedByKind | string
  reason?: string | null
  /** If true, skip the 1-hour rate limit. Emergency only. */
  force?: boolean
  /** Override for tests — defaults to `process.env.EMAIL_TRACKING_IP_SALT`. */
  currentSaltOverride?: string | null
  /** Override for tests — defaults to `new Date()`. */
  now?: Date
  /** Override the rate-limit window in ms (tests only). */
  rateLimitMs?: number
}

export type RotateTrackingSaltResult =
  | {
      ok: true
      rotationId: number
      rotatedAt: string                 // ISO
      newSalt: string                   // 64 hex chars — SHOW ONCE
      newSaltHash: string               // sha256 hex of newSalt
      oldSaltHash: string | null
      hadPrevious: boolean
    }
  | {
      ok: false
      reason: 'rate_limited' | 'db_error'
      error?: string
      /** Populated when reason === 'rate_limited'. */
      nextAllowedAt?: string
    }

export interface SaltRotationRow {
  id: number
  rotatedAt: string | Date
  rotatedBy: string
  oldSaltHash: string | null
  newSaltHash: string
  reason: string | null
  createdAt: string | Date
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function mintSalt(): string {
  return crypto.randomBytes(SALT_BYTES).toString('hex')
}

export function hashSalt(salt: string): string {
  return crypto.createHash('sha256').update(salt).digest('hex')
}

/**
 * Validate `rotatedBy` shape. Accepted:
 *   - 'cli'
 *   - 'system'
 *   - 'cli:<anything>'
 *   - 'admin:<uuid>'
 */
export function isValidRotatedBy(rotatedBy: string): boolean {
  if (typeof rotatedBy !== 'string') return false
  if (rotatedBy === 'cli' || rotatedBy === 'system') return true
  if (rotatedBy.startsWith('cli:') && rotatedBy.length > 4) return true
  if (rotatedBy.startsWith('admin:') && rotatedBy.length > 6) return true
  return false
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (value == null) return null
  if (value.length <= max) return value
  return value.slice(0, max)
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

export async function getLastRotation(
  db: Kysely<Database>,
): Promise<SaltRotationRow | null> {
  const row = await db
    .selectFrom('email_tracking_salt_rotations')
    .select([
      'id',
      'rotated_at',
      'rotated_by',
      'old_salt_hash',
      'new_salt_hash',
      'reason',
      'created_at',
    ])
    .orderBy('rotated_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  if (!row) return null
  return {
    id: Number(row.id),
    rotatedAt: row.rotated_at,
    rotatedBy: row.rotated_by,
    oldSaltHash: row.old_salt_hash,
    newSaltHash: row.new_salt_hash,
    reason: row.reason,
    createdAt: row.created_at,
  }
}

export async function listRotations(
  db: Kysely<Database>,
  opts: { limit?: number } = {},
): Promise<SaltRotationRow[]> {
  const limit = opts.limit == null || !Number.isFinite(opts.limit) || opts.limit <= 0
    ? 50
    : Math.min(Math.floor(opts.limit), 500)

  const rows = await db
    .selectFrom('email_tracking_salt_rotations')
    .select([
      'id',
      'rotated_at',
      'rotated_by',
      'old_salt_hash',
      'new_salt_hash',
      'reason',
      'created_at',
    ])
    .orderBy('rotated_at', 'desc')
    .limit(limit)
    .execute()

  return rows.map((row) => ({
    id: Number(row.id),
    rotatedAt: row.rotated_at,
    rotatedBy: row.rotated_by,
    oldSaltHash: row.old_salt_hash,
    newSaltHash: row.new_salt_hash,
    reason: row.reason,
    createdAt: row.created_at,
  }))
}

// ---------------------------------------------------------------------------
// Write path — rotateTrackingSalt
// ---------------------------------------------------------------------------

export async function rotateTrackingSalt(
  db: Kysely<Database>,
  input: RotateTrackingSaltInput,
): Promise<RotateTrackingSaltResult> {
  if (!isValidRotatedBy(input.rotatedBy)) {
    return {
      ok: false,
      reason: 'db_error',
      error: `invalid rotatedBy shape: ${input.rotatedBy}`,
    }
  }

  const now = input.now instanceof Date ? input.now : new Date()
  const rateLimitMs = Number.isFinite(input.rateLimitMs) && (input.rateLimitMs ?? 0) >= 0
    ? (input.rateLimitMs as number)
    : DEFAULT_RATE_LIMIT_MS

  // Rate-limit check (unless --force).
  if (!input.force) {
    const last = await getLastRotation(db)
    if (last) {
      const lastAt = last.rotatedAt instanceof Date ? last.rotatedAt : new Date(String(last.rotatedAt))
      const gap = now.getTime() - lastAt.getTime()
      if (gap < rateLimitMs) {
        const nextAllowed = new Date(lastAt.getTime() + rateLimitMs)
        return {
          ok: false,
          reason: 'rate_limited',
          nextAllowedAt: nextAllowed.toISOString(),
        }
      }
    }
  }

  const currentSalt = input.currentSaltOverride !== undefined
    ? input.currentSaltOverride
    : process.env.EMAIL_TRACKING_IP_SALT ?? null

  const oldSaltHash = currentSalt != null && currentSalt.length > 0
    ? hashSalt(currentSalt)
    : null
  const newSalt = mintSalt()
  const newSaltHash = hashSalt(newSalt)

  try {
    const result = await sql<{ id: number; rotated_at: string }>`
      INSERT INTO email_tracking_salt_rotations (
        rotated_at,
        rotated_by,
        old_salt_hash,
        new_salt_hash,
        reason
      )
      VALUES (
        ${now.toISOString()}::timestamptz,
        ${input.rotatedBy},
        ${oldSaltHash},
        ${newSaltHash},
        ${truncate(input.reason ?? null, 1000)}
      )
      RETURNING id, rotated_at
    `.execute(db)

    const rows = result.rows as { id: number; rotated_at: string | Date }[]
    if (rows.length === 0) {
      return { ok: false, reason: 'db_error', error: 'insert returned no row' }
    }
    const rotatedAtIso = rows[0].rotated_at instanceof Date
      ? rows[0].rotated_at.toISOString()
      : String(rows[0].rotated_at)

    return {
      ok: true,
      rotationId: Number(rows[0].id),
      rotatedAt: rotatedAtIso,
      newSalt,
      newSaltHash,
      oldSaltHash,
      hadPrevious: oldSaltHash != null,
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'db_error',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
